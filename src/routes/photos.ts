import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import { createRequire } from 'node:module';
import { authMiddleware } from '../middleware/auth.js';
import { resolvePhotoAssetPaths } from '../utils/photoUrl.js';
import {
  assertPhotoOssRuntimeSupport,
  buildOriginalObjectKey,
  buildUploadThumbnailObjectKeys,
  createPhotoOssClient,
  deleteObjectIgnoreNotFound,
  getPhotoObjectKeys,
  type PhotoOssConfig,
} from '../services/photoMedia.js';
import {
  PhotoDataFileError,
  PhotoMetadataStore,
  type PhotoMetadataRecord,
} from '../services/photoMetadataStore.js';
import {
  PhotoUploadConflictError,
  PhotoUploadQueue,
  type PhotoUploadTempFile,
} from '../services/photoUploadQueue.js';
import {
  PHOTO_UPLOAD_MAX_BYTES,
  PHOTO_UPLOAD_MAX_MB,
  PhotoUploadValidationError,
  isJpegFilename,
  validateJpegUpload,
} from '../services/photoUploadValidation.js';

const router = Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = (() => {
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, 'package.json'))) return cwd;
  const isDistServer = __dirname.split(path.sep).includes('dist-server');
  return isDistServer
    ? path.resolve(__dirname, '..', '..', '..')
    : path.resolve(__dirname, '..', '..');
})();
const PHOTOWALL_ROOT = path.join(PROJECT_ROOT, 'public', 'photowall');
const ORIGIN_DIR = path.join(PHOTOWALL_ROOT, 'origin');
const METADATA_FILE = path.join(PROJECT_ROOT, 'src', 'data', 'images-metadata.json');
const UPLOAD_JOBS_FILE = path.join(PROJECT_ROOT, 'src', 'data', 'photo-upload-jobs.json');
const UPLOAD_TMP_DIR = process.env.PHOTO_UPLOAD_TMP_DIR
  ? path.resolve(process.env.PHOTO_UPLOAD_TMP_DIR)
  : path.join(os.tmpdir(), 'myblog-photo-uploads');
const PHOTO_ASSET_BASE_URL = process.env.OSS_PHOTOWALL_BASE_URL
  || process.env.VITE_OSS_PHOTOWALL_BASE_URL
  || '';
const requireFromEsm = createRequire(import.meta.url);
const { isSupportedPhotoExtension } = requireFromEsm(
  path.join(PROJECT_ROOT, 'shared', 'photo-extensions.cjs'),
) as {
  isSupportedPhotoExtension: (extension: string) => boolean;
};

const metadataStore = new PhotoMetadataStore(METADATA_FILE);

function getOssConfig(): PhotoOssConfig {
  const parsedOpsTimeout = Number.parseInt(process.env.PHOTO_OSS_OPERATION_TIMEOUT_MS || '60000', 10);
  return {
    region: process.env.OSS_REGION || '',
    bucket: process.env.OSS_BUCKET || '',
    accessKeyId: process.env.OSS_ACCESS_KEY_ID || '',
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET || '',
    endpoint: process.env.OSS_ENDPOINT || '',
    timeoutMs: Number.isFinite(parsedOpsTimeout) && parsedOpsTimeout > 0 ? parsedOpsTimeout : 60_000,
  };
}

function getMissingOssConfig(config: PhotoOssConfig): string[] {
  const missing: string[] = [];
  if (!config.region) missing.push('OSS_REGION');
  if (!config.bucket) missing.push('OSS_BUCKET');
  if (!config.accessKeyId) missing.push('OSS_ACCESS_KEY_ID');
  if (!config.accessKeySecret) missing.push('OSS_ACCESS_KEY_SECRET');
  return missing;
}

function isOssConfigured(config: PhotoOssConfig): boolean {
  return getMissingOssConfig(config).length === 0;
}

const uploadQueue = new PhotoUploadQueue({
  jobsFile: UPLOAD_JOBS_FILE,
  tempDir: UPLOAD_TMP_DIR,
  metadataStore,
  getOssConfig,
});

export async function initializePhotosService(): Promise<void> {
  assertPhotoOssRuntimeSupport();
  await fs.promises.mkdir(UPLOAD_TMP_DIR, { recursive: true });
  await uploadQueue.initialize();
}

function normalizePhotoFilename(filename: string): string | null {
  if (!filename || filename.includes('\0')) return null;
  if (filename.includes('/') || filename.includes('\\')) return null;
  if (path.basename(filename) !== filename) return null;
  const extension = path.extname(filename).toLowerCase();
  if (!isSupportedPhotoExtension(extension)) return null;
  return filename;
}

function getUploadFilenameCandidates(originalName: string): string[] {
  const candidates = [originalName];
  try {
    const decoded = Buffer.from(originalName, 'latin1').toString('utf8');
    if (decoded && decoded !== originalName) candidates.push(decoded);
  } catch {
    // Keep the original filename as the fallback.
  }
  return candidates;
}

function sanitizeUploadFilename(originalName: string): string | null {
  for (const candidate of getUploadFilenameCandidates(originalName)) {
    const baseName = path.basename(candidate);
    const normalized = normalizePhotoFilename(baseName);
    if (normalized && isJpegFilename(normalized)) return normalized;
  }
  return null;
}

function parseIncludeHiddenQuery(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function buildVisibilityKeyFromInput(driveItemId: unknown, filename: unknown): string | null {
  if (typeof driveItemId === 'string' && driveItemId.trim()) return `drive:${driveItemId.trim()}`;
  if (typeof filename === 'string') {
    const normalizedFilename = normalizePhotoFilename(filename);
    if (normalizedFilename) return `file:${normalizedFilename}`;
  }
  return null;
}

function findPhotoMetadataRecordIndex(
  records: PhotoMetadataRecord[],
  filename: string | undefined,
  driveItemId: string | undefined,
): number {
  const normalizedDriveItemId = driveItemId?.trim();
  if (normalizedDriveItemId) {
    const driveMatchIndex = records.findIndex(photo => photo.driveItemId?.trim() === normalizedDriveItemId);
    if (driveMatchIndex >= 0) return driveMatchIndex;
  }
  return filename ? records.findIndex(photo => photo.filename === filename) : -1;
}

function extractObjectKeyFromUrl(urlValue: string | undefined): string | null {
  if (!urlValue?.trim()) return null;
  const trimmed = urlValue.trim();
  let pathname = trimmed;
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('//')) {
    try {
      pathname = (trimmed.startsWith('//') ? new URL(`https:${trimmed}`) : new URL(trimmed)).pathname;
    } catch {
      return null;
    }
  }
  const normalizedPath = pathname.split('?')[0].split('#')[0].replace(/^\/+/, '');
  return normalizedPath.startsWith('photowall/') ? normalizedPath : null;
}

async function removeTempFile(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') {
      console.error(`Failed to remove temp upload file ${filePath}:`, error);
    }
  }
}

async function cleanupMulterFiles(files: Express.Multer.File[] | undefined): Promise<void> {
  if (!files) return;
  await Promise.all(files.map(file => removeTempFile(file.path)));
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, UPLOAD_TMP_DIR),
    filename: (_req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase();
      callback(null, `${Date.now()}-${crypto.randomUUID()}${extension || '.upload'}`);
    },
  }),
  limits: {
    fileSize: PHOTO_UPLOAD_MAX_BYTES,
    files: 1,
  },
  fileFilter: (_req, file, callback) => {
    const allowed = getUploadFilenameCandidates(file.originalname).some(isJpegFilename);
    if (allowed) {
      callback(null, true);
      return;
    }
    callback(new PhotoUploadValidationError('仅支持上传 JPG/JPEG 图片', 415));
  },
});

function uploadPhotosMiddleware(req: Request, res: Response, next: NextFunction): void {
  upload.array('photos', 1)(req, res, (error?: unknown) => {
    if (!error) {
      next();
      return;
    }

    void cleanupMulterFiles(req.files as Express.Multer.File[] | undefined);
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: `单个文件不能超过 ${PHOTO_UPLOAD_MAX_MB}MB` });
        return;
      }
      res.status(400).json({ error: error.message || '文件上传失败' });
      return;
    }
    if (error instanceof PhotoUploadValidationError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: '文件上传失败' });
  });
}

async function reserveUploadSlot(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await uploadQueue.assertAvailable();
    const missing = getMissingOssConfig(getOssConfig());
    if (missing.length > 0) {
      res.status(500).json({ error: `OSS 配置缺失: ${missing.join(', ')}` });
      return;
    }
    const reservation = uploadQueue.reserveUpload();
    if (!reservation) {
      res.setHeader('Retry-After', '5');
      res.status(429).json({ error: '当前已有照片上传任务，请稍后重试' });
      return;
    }
    res.locals.photoUploadReservation = reservation;
    const releaseReservation = (): void => uploadQueue.releaseUploadReservation(reservation);
    res.once('finish', releaseReservation);
    res.once('close', releaseReservation);
    next();
  } catch (error) {
    const message = error instanceof Error ? error.message : '上传服务暂不可用';
    res.status(error instanceof PhotoDataFileError ? 503 : 500).json({ error: message });
  }
}

async function handlePhotoMetadataRequest(res: Response, includeHidden: boolean): Promise<void> {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    const metadataPhotos = await metadataStore.read();
    const resolvedPhotos = metadataPhotos.map(photo => ({
      ...resolvePhotoAssetPaths(photo, PHOTO_ASSET_BASE_URL),
      isVisible: photo.isVisible !== false,
      visibilityUpdatedAt: photo.visibilityUpdatedAt ?? null,
    }));
    const photos = includeHidden
      ? resolvedPhotos
      : resolvedPhotos.filter(photo => photo.isVisible !== false);
    res.json({
      photos,
      total: photos.length,
      allTotal: includeHidden ? resolvedPhotos.length : photos.length,
    });
  } catch (error) {
    console.error('Photos API error:', error);
    res.status(error instanceof PhotoDataFileError ? 503 : 500).json({ error: '读取照片元数据失败' });
  }
}

router.get('/metadata', async (req: Request, res: Response): Promise<void> => {
  const includeHidden = parseIncludeHiddenQuery(req.query.includeHidden);
  if (!includeHidden) {
    await handlePhotoMetadataRequest(res, false);
    return;
  }
  authMiddleware(req, res, () => {
    void handlePhotoMetadataRequest(res, true);
  });
});

router.post(
  '/upload',
  authMiddleware,
  (req, res, next) => void reserveUploadSlot(req, res, next),
  uploadPhotosMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const files = req.files as Express.Multer.File[] | undefined;
    const reservation = res.locals.photoUploadReservation as string | undefined;
    if (!files || files.length !== 1 || !reservation) {
      await cleanupMulterFiles(files);
      res.status(400).json({ error: '每次只能上传 1 张照片' });
      return;
    }

    const file = files[0];
    const safeName = sanitizeUploadFilename(file.originalname);
    if (!safeName) {
      await cleanupMulterFiles(files);
      res.status(415).json({ error: '仅支持上传 JPG/JPEG 图片' });
      return;
    }

    try {
      const dimensions = await validateJpegUpload({
        tempPath: file.path,
        filename: safeName,
        size: file.size,
      });
      await uploadQueue.assertFilenameAvailable(safeName);

      const tempFile: PhotoUploadTempFile = {
        tempPath: file.path,
        filename: safeName,
        originalName: file.originalname,
        mimetype: 'image/jpeg',
        size: file.size,
        width: dimensions.width,
        height: dimensions.height,
      };
      const job = await uploadQueue.enqueue(tempFile, reservation);
      res.status(202).json({
        success: true,
        jobId: job.jobId,
        status: job.status,
        total: job.total,
        message: job.message,
      });
    } catch (error) {
      await cleanupMulterFiles(files);
      if (error instanceof PhotoUploadValidationError || error instanceof PhotoUploadConflictError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      if (error instanceof PhotoDataFileError) {
        res.status(503).json({ error: error.message });
        return;
      }
      console.error('Photo upload API error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : '上传照片失败' });
    }
  },
);

router.get('/upload-jobs/:jobId', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    await uploadQueue.assertAvailable();
    const { jobId } = req.params as { jobId: string };
    const job = uploadQueue.getJob(jobId);
    if (!job) {
      res.status(404).json({ error: '上传任务不存在或已过期' });
      return;
    }
    res.json({ success: true, job });
  } catch (error) {
    res.status(error instanceof PhotoDataFileError ? 503 : 500).json({
      error: error instanceof Error ? error.message : '读取上传任务失败',
    });
  }
});

router.post('/process', authMiddleware, (_req: Request, res: Response): void => {
  res.json({
    success: true,
    message: '新上传会由 OSS 持久化生成 medium/tiny 缩略图，无需服务器本地处理',
  });
});

router.patch('/visibility', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { filename, driveItemId, isVisible } = req.body as {
    filename?: unknown;
    driveItemId?: unknown;
    isVisible?: unknown;
  };
  if (typeof isVisible !== 'boolean') {
    res.status(400).json({ error: 'isVisible 必须为布尔值' });
    return;
  }
  const visibilityKey = buildVisibilityKeyFromInput(driveItemId, filename);
  if (!visibilityKey) {
    res.status(400).json({ error: '无效的照片标识' });
    return;
  }

  const normalizedDriveItemId = typeof driveItemId === 'string' && driveItemId.trim()
    ? driveItemId.trim()
    : undefined;
  const normalizedFilename = typeof filename === 'string' ? normalizePhotoFilename(filename) : null;
  const visibilityUpdatedAt = new Date().toISOString();

  try {
    await metadataStore.update(records => {
      const index = findPhotoMetadataRecordIndex(
        records,
        normalizedFilename ?? undefined,
        normalizedDriveItemId,
      );
      if (index < 0) {
        return { records, result: false };
      }
      const next = [...records];
      next[index] = { ...next[index], isVisible, visibilityUpdatedAt };
      return { records: next, result: true };
    }).then(found => {
      if (!found) throw new PhotoUploadConflictError('照片不存在');
    });
    res.json({ success: true, photoKey: visibilityKey, isVisible, visibilityUpdatedAt });
  } catch (error) {
    if (error instanceof PhotoUploadConflictError && error.message === '照片不存在') {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error('Photos API error:', error);
    res.status(error instanceof PhotoDataFileError ? 503 : 500).json({ error: '更新照片展示状态失败' });
  }
});

router.delete('/:filename', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { filename } = req.params as { filename: string };
  let decodedFilename: string;
  try {
    decodedFilename = decodeURIComponent(filename);
  } catch {
    res.status(400).json({ error: '无效的文件名' });
    return;
  }
  const normalizedFilename = normalizePhotoFilename(decodedFilename);
  if (!normalizedFilename) {
    res.status(400).json({ error: '无效的文件名' });
    return;
  }
  if (uploadQueue.isFilenameActive(normalizedFilename)) {
    res.status(409).json({ error: '该照片正在上传处理中，暂时不能删除' });
    return;
  }

  try {
    const result = await metadataStore.update(async records => {
      const matchedRecord = records.find(photo => photo.filename === normalizedFilename);
      const fallbackBaseName = path.basename(normalizedFilename, path.extname(normalizedFilename));
      const uploadKeys = buildUploadThumbnailObjectKeys(normalizedFilename);
      const legacyKeys = getPhotoObjectKeys(fallbackBaseName);
      const ossKeys = new Set<string>([
        buildOriginalObjectKey(normalizedFilename),
        uploadKeys.fullKey,
        uploadKeys.mediumKey,
        uploadKeys.tinyKey,
        legacyKeys.fullKey,
        legacyKeys.mediumKey,
        legacyKeys.tinyKey,
      ]);
      for (const candidate of [
        matchedRecord?.src,
        matchedRecord?.srcMedium,
        matchedRecord?.srcTiny,
        matchedRecord?.originalSrc,
      ]) {
        const key = extractObjectKeyFromUrl(candidate);
        if (key) ossKeys.add(key);
      }

      let deletedOssCount = 0;
      const ossConfig = getOssConfig();
      if (isOssConfigured(ossConfig)) {
        const client = createPhotoOssClient(ossConfig);
        for (const key of ossKeys) {
          try {
            await deleteObjectIgnoreNotFound(client, key, ossConfig.timeoutMs);
            deletedOssCount += 1;
          } catch (error) {
            console.error(`Failed to delete OSS object ${key}:`, error);
          }
        }
      }

      const filesToDelete = [
        path.join(ORIGIN_DIR, normalizedFilename),
        path.join(PHOTOWALL_ROOT, 'thumbnails', 'full', `${fallbackBaseName}.jpg`),
        path.join(PHOTOWALL_ROOT, 'thumbnails', 'medium', `${fallbackBaseName}.jpg`),
        path.join(PHOTOWALL_ROOT, 'thumbnails', 'tiny', `${fallbackBaseName}.jpg`),
      ];
      let deletedLocalCount = 0;
      for (const filePath of filesToDelete) {
        try {
          await fs.promises.unlink(filePath);
          deletedLocalCount += 1;
        } catch (error) {
          if ((error as { code?: string }).code !== 'ENOENT') {
            console.error(`Failed to delete ${filePath}:`, error);
          }
        }
      }

      return {
        records: records.filter(photo => photo.filename !== normalizedFilename),
        result: { deletedOssCount, deletedLocalCount },
      };
    });

    res.json({
      success: true,
      message: `已删除 ${result.deletedOssCount} 个 OSS 对象，清理 ${result.deletedLocalCount} 个本地文件`,
      deletedOssFiles: result.deletedOssCount,
      deletedLocalFiles: result.deletedLocalCount,
    });
  } catch (error) {
    console.error('Photos delete API error:', error);
    res.status(error instanceof PhotoDataFileError ? 503 : 500).json({ error: '删除照片失败' });
  }
});

export default router;
