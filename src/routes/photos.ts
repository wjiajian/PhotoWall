import { Router } from 'express';
import type { Request, Response } from 'express';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { createRequire } from 'module';
import { authMiddleware } from '../middleware/auth.js';
import { resolvePhotoAssetPaths } from '../utils/photoUrl.js';
import {
  buildOriginalObjectKey,
  buildUploadThumbnailObjectKeys,
  createPhotoOssClient,
  deleteObjectIgnoreNotFound,
  getPhotoObjectKeys,
  type PhotoOssConfig,
} from '../services/photoMedia.js';
import {
  cleanupPhotoUploadTempDir,
  enqueuePhotoUploadJob,
  getPhotoUploadJob,
  type PhotoUploadTempFile,
} from '../services/photoUploadQueue.js';
const router = Router();

// 获取项目根目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// 优先使用 cwd（通常是项目根目录），否则根据运行位置回退
const PROJECT_ROOT = (() => {
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, 'package.json'))) {
    return cwd;
  }
  const isDistServer = __dirname.split(path.sep).includes('dist-server');
  return isDistServer
    ? path.resolve(__dirname, '..', '..', '..')
    : path.resolve(__dirname, '..', '..');
})();
const PHOTOWALL_ROOT = path.join(PROJECT_ROOT, 'public', 'photowall');
const ORIGIN_DIR = path.join(PHOTOWALL_ROOT, 'origin');
const METADATA_FILE = path.join(PROJECT_ROOT, 'src', 'data', 'images-metadata.json');
const requireFromEsm = createRequire(import.meta.url);
const {
  SUPPORTED_FORMAT_TEXT,
  PHOTO_EXTENSION_REGEX,
  isSupportedPhotoExtension,
} = requireFromEsm(path.join(PROJECT_ROOT, 'shared', 'photo-extensions.cjs')) as {
  SUPPORTED_FORMAT_TEXT: string;
  PHOTO_EXTENSION_REGEX: RegExp;
  isSupportedPhotoExtension: (ext: string) => boolean;
};
const parsedUploadLimitMb = Number.parseInt(process.env.PHOTO_UPLOAD_MAX_MB || '25', 10);
const MAX_UPLOAD_MB = Number.isFinite(parsedUploadLimitMb) && parsedUploadLimitMb > 0 ? parsedUploadLimitMb : 25;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const parsedMaxFilesPerBatch = Number.parseInt(process.env.PHOTO_UPLOAD_MAX_FILES_PER_BATCH || '1', 10);
const MAX_FILES_PER_UPLOAD_BATCH = Number.isFinite(parsedMaxFilesPerBatch) && parsedMaxFilesPerBatch > 0
  ? parsedMaxFilesPerBatch
  : 1;
const parsedMaxBatchMb = Number.parseInt(process.env.PHOTO_UPLOAD_MAX_BATCH_MB || '25', 10);
const MAX_UPLOAD_BATCH_MB = Number.isFinite(parsedMaxBatchMb) && parsedMaxBatchMb > 0 ? parsedMaxBatchMb : 25;
const MAX_UPLOAD_BATCH_BYTES = MAX_UPLOAD_BATCH_MB * 1024 * 1024;
const UPLOAD_TMP_DIR = process.env.PHOTO_UPLOAD_TMP_DIR
  ? path.resolve(process.env.PHOTO_UPLOAD_TMP_DIR)
  : path.join(os.tmpdir(), 'myblog-photo-uploads');
const PHOTO_ASSET_BASE_URL = process.env.OSS_PHOTOWALL_BASE_URL || process.env.VITE_OSS_PHOTOWALL_BASE_URL || '';

fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true });
cleanupPhotoUploadTempDir(UPLOAD_TMP_DIR);

interface PhotoMetadataRecord {
  driveItemId?: string;
  filename: string;
  originalSrc?: string;
  src: string;
  srcMedium?: string;
  srcTiny?: string;
  width?: number;
  height?: number;
  size?: number;
  format?: string;
  date?: string;
  videoSrc?: string;
  isVisible?: boolean;
  visibilityUpdatedAt?: string | null;
}

function normalizePhotoFilename(filename: string): string | null {
  if (!filename || filename.includes('\0')) return null;
  if (filename.includes('/') || filename.includes('\\')) return null;
  if (path.basename(filename) !== filename) return null;
  const ext = path.extname(filename).toLowerCase();
  if (!isSupportedPhotoExtension(ext)) return null;
  return filename;
}

function getUploadFilenameCandidates(originalName: string): string[] {
  const candidates = [originalName];
  try {
    const decoded = Buffer.from(originalName, 'latin1').toString('utf8');
    if (decoded && decoded !== originalName) {
      candidates.push(decoded);
    }
  } catch {
    // ignore decode errors and fallback to original filename
  }
  return candidates;
}

function sanitizeUploadFilename(originalName: string): string | null {
  for (const candidate of getUploadFilenameCandidates(originalName)) {
    const baseName = path.basename(candidate);
    const normalized = normalizePhotoFilename(baseName);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function parseIncludeHiddenQuery(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function buildVisibilityKeyFromInput(driveItemId: unknown, filename: unknown): string | null {
  if (typeof driveItemId === 'string' && driveItemId.trim().length > 0) {
    return `drive:${driveItemId.trim()}`;
  }
  if (typeof filename === 'string') {
    const normalizedFilename = normalizePhotoFilename(filename);
    if (normalizedFilename) {
      return `file:${normalizedFilename}`;
    }
  }
  return null;
}

function getOssConfig(): PhotoOssConfig {
  const parsedOpsTimeout = Number.parseInt(process.env.PHOTO_OSS_OPERATION_TIMEOUT_MS || '60000', 10);
  return {
    region: process.env.OSS_REGION || '',
    bucket: process.env.OSS_BUCKET || '',
    accessKeyId: process.env.OSS_ACCESS_KEY_ID || '',
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET || '',
    endpoint: process.env.OSS_ENDPOINT || '',
    timeoutMs: Number.isFinite(parsedOpsTimeout) && parsedOpsTimeout > 0 ? parsedOpsTimeout : 60000,
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

function readMetadataRecords(): PhotoMetadataRecord[] {
  if (!fs.existsSync(METADATA_FILE)) {
    return [];
  }
  try {
    const content = fs.readFileSync(METADATA_FILE, 'utf8');
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? (parsed as PhotoMetadataRecord[]) : [];
  } catch (error) {
    console.error('Failed to parse metadata file:', error);
    return [];
  }
}

function writeMetadataRecords(records: PhotoMetadataRecord[]): void {
  const sorted = [...records].sort((a, b) => {
    if (a.date && b.date) return b.date.localeCompare(a.date);
    return a.filename.localeCompare(b.filename, 'zh-CN');
  });
  fs.writeFileSync(METADATA_FILE, JSON.stringify(sorted, null, 2), 'utf8');
}

function findPhotoMetadataRecordIndex(
  records: PhotoMetadataRecord[],
  filename: string | undefined,
  driveItemId: string | undefined,
): number {
  const normalizedDriveItemId = driveItemId?.trim();
  if (normalizedDriveItemId) {
    const driveMatchIndex = records.findIndex(photo => photo.driveItemId?.trim() === normalizedDriveItemId);
    if (driveMatchIndex >= 0) {
      return driveMatchIndex;
    }
  }

  if (filename) {
    return records.findIndex(photo => photo.filename === filename);
  }

  return -1;
}

function extractObjectKeyFromUrl(urlValue: string | undefined): string | null {
  if (!urlValue) return null;
  const trimmed = urlValue.trim();
  if (!trimmed) return null;

  let pathname = trimmed;
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('//')) {
    try {
      const url = trimmed.startsWith('//') ? new URL(`https:${trimmed}`) : new URL(trimmed);
      pathname = url.pathname;
    } catch {
      return null;
    }
  }

  const normalizedPath = pathname.split('?')[0].split('#')[0].replace(/^\/+/, '');
  if (!normalizedPath.startsWith('photowall/')) return null;
  return normalizedPath;
}

// 配置 multer 文件上传
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      cb(null, UPLOAD_TMP_DIR);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${crypto.randomUUID()}${ext || '.upload'}`);
    },
  }),
  limits: {
    fileSize: MAX_UPLOAD_BYTES, // 单文件大小限制
    files: MAX_FILES_PER_UPLOAD_BATCH,
  },
  fileFilter: (_req, file, cb) => {
    const isAllowed = getUploadFilenameCandidates(file.originalname).some(name => PHOTO_EXTENSION_REGEX.test(name));
    if (isAllowed) {
      cb(null, true);
    } else {
      cb(new Error(`不支持的文件格式，仅支持 ${SUPPORTED_FORMAT_TEXT}`));
    }
  },
});

function uploadPhotosMiddleware(req: Request, res: Response, next: (error?: unknown) => void): void {
  upload.array('photos', MAX_FILES_PER_UPLOAD_BATCH)(req, res, (err?: unknown) => {
    if (!err) {
      next();
      return;
    }

    cleanupMulterFiles(req.files as Express.Multer.File[] | undefined);

    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: `单个文件不能超过 ${MAX_UPLOAD_MB}MB` });
        return;
      }
      res.status(400).json({ error: err.message || '文件上传失败' });
      return;
    }

    if (err instanceof Error) {
      res.status(400).json({ error: err.message || '文件上传失败' });
      return;
    }

    res.status(500).json({ error: '文件上传失败' });
  });
}

function cleanupMulterFiles(files: Express.Multer.File[] | undefined): void {
  if (!files) return;
  for (const file of files) {
    if (!file.path) continue;
    try {
      fs.unlinkSync(file.path);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'ENOENT') {
        console.error(`Failed to cleanup uploaded temp file ${file.path}:`, error);
      }
    }
  }
}

async function handlePhotoMetadataRequest(
  res: Response,
  includeHidden: boolean,
): Promise<void> {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    if (!fs.existsSync(METADATA_FILE)) {
      res.json({ photos: [], total: 0, allTotal: 0 });
      return;
    }

    const content = fs.readFileSync(METADATA_FILE, 'utf8');
    const parsedPhotos = JSON.parse(content);
    const metadataPhotos = Array.isArray(parsedPhotos) ? (parsedPhotos as PhotoMetadataRecord[]) : [];
    const resolvedPhotos = metadataPhotos.map((photo) => {
      const resolved = resolvePhotoAssetPaths(photo, PHOTO_ASSET_BASE_URL);

      return {
        ...resolved,
        isVisible: photo.isVisible !== false,
        visibilityUpdatedAt: photo.visibilityUpdatedAt ?? null,
      };
    });

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
    res.status(500).json({ error: '读取照片元数据失败' });
  }
}

/**
 * GET /api/photos/metadata
 * 获取照片元数据（动态读取）
 */
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

/**
 * POST /api/photos/upload
 * 上传照片（需要认证）
 */
router.post('/upload', authMiddleware, uploadPhotosMiddleware, async (req: Request, res: Response): Promise<void> => {
  const files = req.files as Express.Multer.File[] | undefined;

  if (!files || files.length === 0) {
    res.status(400).json({ error: '未上传任何文件' });
    return;
  }

  const ossConfig = getOssConfig();
  const missingOssConfig = getMissingOssConfig(ossConfig);
  if (missingOssConfig.length > 0) {
    cleanupMulterFiles(files);
    res.status(500).json({ error: `OSS 配置缺失: ${missingOssConfig.join(', ')}` });
    return;
  }

  const totalUploadBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalUploadBytes > MAX_UPLOAD_BATCH_BYTES) {
    cleanupMulterFiles(files);
    res.status(413).json({ error: `单批文件总大小不能超过 ${MAX_UPLOAD_BATCH_MB}MB` });
    return;
  }

  const tempFiles: PhotoUploadTempFile[] = [];

  for (const file of files) {
    const safeName = sanitizeUploadFilename(file.originalname);
    if (!safeName) {
      cleanupMulterFiles(files);
      res.status(400).json({ error: '无效的文件名' });
      return;
    }

    tempFiles.push({
      tempPath: file.path,
      filename: safeName,
      originalName: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
    });
  }

  const job = enqueuePhotoUploadJob({
    files: tempFiles,
    ossConfig,
    metadataFile: METADATA_FILE,
  });

  res.status(202).json({
    success: true,
    jobId: job.jobId,
    status: job.status,
    total: job.total,
    message: job.message,
  });
});

router.get('/upload-jobs/:jobId', authMiddleware, (req: Request, res: Response): void => {
  const { jobId } = req.params as { jobId: string };
  const job = getPhotoUploadJob(jobId);
  if (!job) {
    res.status(404).json({ error: '上传任务不存在或已过期' });
    return;
  }
  res.json({ success: true, job });
});

/**
 * POST /api/photos/process
 * 手动触发照片处理（需要认证）
 */
router.post('/process', authMiddleware, async (_req: Request, res: Response): Promise<void> => {
  res.json({
    success: true,
    message: 'OSS 模式下上传时已保留原图，并统一生成 JPEG 全尺寸与缩略图，无需手动处理',
  });
});

/**
 * PATCH /api/photos/visibility
 * 设置照片是否展示在照片墙（需要认证）
 */
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

  const normalizedDriveItemId = typeof driveItemId === 'string' && driveItemId.trim().length > 0
    ? driveItemId.trim()
    : undefined;
  const normalizedFilename = typeof filename === 'string' ? normalizePhotoFilename(filename) : null;
  const metadataRecords = readMetadataRecords();
  const matchedRecordIndex = findPhotoMetadataRecordIndex(metadataRecords, normalizedFilename ?? undefined, normalizedDriveItemId);
  if (matchedRecordIndex < 0) {
    res.status(404).json({ error: '照片不存在' });
    return;
  }

  const visibilityUpdatedAt = new Date().toISOString();

  try {
    const nextMetadataRecords = [...metadataRecords];
    nextMetadataRecords[matchedRecordIndex] = {
      ...nextMetadataRecords[matchedRecordIndex],
      isVisible,
      visibilityUpdatedAt,
    };
    writeMetadataRecords(nextMetadataRecords);

    res.json({
      success: true,
      photoKey: visibilityKey,
      isVisible,
      visibilityUpdatedAt,
    });
  } catch (error) {
    console.error('Photos API error:', error);
    res.status(500).json({ error: '更新照片展示状态失败' });
  }
});

/**
 * DELETE /api/photos/:filename
 * 删除照片（需要认证）
 */
router.delete('/:filename', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { filename } = req.params as { filename: string };
  let decodedFilename = '';
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

  const metadataRecords = readMetadataRecords();
  const matchedRecord = metadataRecords.find(photo => photo.filename === normalizedFilename);
  const fallbackBaseName = path.basename(normalizedFilename, path.extname(normalizedFilename));
  const fallbackKeys = getPhotoObjectKeys(fallbackBaseName);
  const ossKeys = new Set<string>();
  for (const candidate of [
    matchedRecord?.src,
    matchedRecord?.srcMedium,
    matchedRecord?.srcTiny,
    matchedRecord?.originalSrc,
  ]) {
    const key = extractObjectKeyFromUrl(candidate);
    if (key) {
      ossKeys.add(key);
    }
  }
  if (ossKeys.size === 0) {
    const thumbnailKeys = buildUploadThumbnailObjectKeys(normalizedFilename);
    ossKeys.add(buildOriginalObjectKey(normalizedFilename));
    ossKeys.add(thumbnailKeys.fullKey);
    ossKeys.add(thumbnailKeys.mediumKey);
    ossKeys.add(thumbnailKeys.tinyKey);
    ossKeys.add(fallbackKeys.fullKey);
    ossKeys.add(fallbackKeys.mediumKey);
    ossKeys.add(fallbackKeys.tinyKey);
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
  } else {
    console.warn('Skip OSS delete: OSS config is incomplete');
  }

  const filesToDelete = [
    path.join(ORIGIN_DIR, normalizedFilename),
    path.join(PHOTOWALL_ROOT, 'thumbnails', 'full', `${fallbackBaseName}.jpg`),
    path.join(PHOTOWALL_ROOT, 'thumbnails', 'medium', `${fallbackBaseName}.jpg`),
    path.join(PHOTOWALL_ROOT, 'thumbnails', 'tiny', `${fallbackBaseName}.jpg`),
  ];

  let deletedLocalCount = 0;

  for (const filePath of filesToDelete) {
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        deletedLocalCount++;
      } catch (err) {
        console.error(`Failed to delete ${filePath}:`, err);
      }
    }
  }

  // 更新元数据文件 + 清理可见性配置
  try {
    const filtered = metadataRecords.filter(photo => photo.filename !== normalizedFilename);
    if (filtered.length !== metadataRecords.length) {
      writeMetadataRecords(filtered);
    }
  } catch (err) {
    console.error('Failed to update metadata:', err);
  }

  res.json({
    success: true,
    message: `已删除 ${deletedOssCount} 个 OSS 对象，清理 ${deletedLocalCount} 个本地文件`,
    deletedOssFiles: deletedOssCount,
    deletedLocalFiles: deletedLocalCount,
  });
});

export default router;
