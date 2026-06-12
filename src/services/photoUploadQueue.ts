import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type OSS from 'ali-oss';
import {
  buildPhotoVariantBuffer,
  buildOriginalObjectKey,
  buildUploadThumbnailObjectKeys,
  createPhotoOssClient,
  deleteObjectIgnoreNotFound,
  extractPhotoDate,
  getContentTypeFromExtension,
  getFormatLabelFromExtension,
  preparePhotoVariantSource,
  putObject,
  type PhotoOssConfig,
} from './photoMedia.js';

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

export interface PhotoUploadTempFile {
  tempPath: string;
  filename: string;
  originalName: string;
  mimetype: string;
  size: number;
}

export type PhotoUploadJobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface PhotoUploadResultItem {
  filename: string;
  size?: number;
  src?: string;
  error?: string;
}

export interface PhotoUploadJobSnapshot {
  jobId: string;
  status: PhotoUploadJobStatus;
  total: number;
  processed: number;
  uploaded: PhotoUploadResultItem[];
  failed: PhotoUploadResultItem[];
  currentFilename: string | null;
  partial: boolean;
  message: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

interface PhotoUploadJob {
  jobId: string;
  status: PhotoUploadJobStatus;
  files: PhotoUploadTempFile[];
  total: number;
  processed: number;
  uploaded: PhotoUploadResultItem[];
  failed: PhotoUploadResultItem[];
  currentFilename: string | null;
  message: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  ossConfig: PhotoOssConfig;
  metadataFile: string;
}

const jobs = new Map<string, PhotoUploadJob>();
const queue: string[] = [];
let isProcessing = false;
const JOB_TTL_MS = 24 * 60 * 60 * 1000;

// Throttle GC hints so we don't hurt throughput/latency under load.
const GC_MIN_INTERVAL_MS = 10_000; // at most one GC hint every 10s
let lastGcAt = 0;
let hasWarnedAboutMissingGc = false;

// Safe GC hint: only calls global.gc when Node was started with --expose-gc.
// On 2 GB servers this helps V8 reclaim large Buffer allocations between
// consecutive photo uploads before memory pressure triggers OOM.
function maybeGC(): void {
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;

  if (typeof gc !== 'function') {
    if (!hasWarnedAboutMissingGc && process.env.NODE_ENV !== 'test') {
      hasWarnedAboutMissingGc = true;
      console.warn(
        '[photoUploadQueue] global.gc is not available; start Node with --expose-gc to enable manual GC hints.',
      );
    }
    return;
  }

  const now = Date.now();
  if (now - lastGcAt < GC_MIN_INTERVAL_MS) {
    return;
  }

  lastGcAt = now;
  gc();
}
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Returns a promise that rejects with an Error after timeoutMs.
 * If the original promise settles first, the timeout is cleared.
 *
 * **Cancellation note:** This wrapper does **not** cancel the underlying work
 * (sharp/heic-convert/OSS I/O) when the timeout fires — it only rejects the
 * raced promise. The original operation may continue consuming CPU/memory
 * until it completes on its own. A worker-based isolation design is planned
 * for a future iteration to provide true abort capability for stuck native
 * tasks.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (timeoutMs <= 0) return promise;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  // Attach a noop catch to the original promise so that if it rejects after
  // the timeout has already won the race, it does not become an unhandled rejection.
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function snapshot(job: PhotoUploadJob): PhotoUploadJobSnapshot {
  return {
    jobId: job.jobId,
    status: job.status,
    total: job.total,
    processed: job.processed,
    uploaded: job.uploaded,
    failed: job.failed,
    currentFilename: job.currentFilename,
    partial: job.uploaded.length > 0 && job.failed.length > 0,
    message: job.message,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
  };
}

function cleanupOldJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [jobId, job] of jobs.entries()) {
    if (!job.finishedAt) continue;
    if (new Date(job.finishedAt).getTime() < cutoff) {
      jobs.delete(jobId);
    }
  }
}

function readMetadataRecords(metadataFile: string): PhotoMetadataRecord[] {
  if (!fs.existsSync(metadataFile)) {
    return [];
  }
  try {
    const content = fs.readFileSync(metadataFile, 'utf8');
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? (parsed as PhotoMetadataRecord[]) : [];
  } catch (error) {
    console.error('Failed to parse metadata file:', error);
    return [];
  }
}

function writeMetadataRecords(metadataFile: string, records: PhotoMetadataRecord[]): void {
  const sorted = [...records].sort((a, b) => {
    if (a.date && b.date) return b.date.localeCompare(a.date);
    return a.filename.localeCompare(b.filename, 'zh-CN');
  });
  fs.writeFileSync(metadataFile, JSON.stringify(sorted, null, 2), 'utf8');
}

function upsertMetadataRecordByFilename(records: PhotoMetadataRecord[], entry: PhotoMetadataRecord): void {
  const index = records.findIndex(record => record.filename === entry.filename);
  if (index >= 0) {
    records[index] = entry;
    return;
  }
  records.push(entry);
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

async function removeTempFile(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== 'ENOENT') {
      console.error(`Failed to remove temp upload file ${filePath}:`, error);
    }
  }
}


async function processOneFile(
  file: PhotoUploadTempFile,
  client: OSS,
  metadataFile: string,
  ossTimeoutMs: number,
): Promise<PhotoUploadResultItem> {
  const uploadedKeys = new Set<string>();

  try {
    const extension = path.extname(file.filename).toLowerCase();
    const metadataRecords = readMetadataRecords(metadataFile);
    const existingRecord = metadataRecords.find(record => record.filename === file.filename);

    const objectKey = buildOriginalObjectKey(file.filename);
    const photoDate = await extractPhotoDate(file.tempPath, new Date().toISOString());

    const contentType = file.mimetype?.startsWith('image/')
      ? file.mimetype
      : getContentTypeFromExtension(extension);

    await putObject(client, objectKey, fs.createReadStream(file.tempPath), contentType, ossTimeoutMs);
    uploadedKeys.add(objectKey);

    const thumbnailKeys = buildUploadThumbnailObjectKeys(file.filename);
    let photoWidth = existingRecord?.width;
    let photoHeight = existingRecord?.height;

    {
      const variantSource = await preparePhotoVariantSource(file.tempPath, extension, file.size);
      photoWidth = variantSource.width || photoWidth;
      photoHeight = variantSource.height || photoHeight;

      for (const variant of [
        { kind: 'full' as const, key: thumbnailKeys.fullKey },
        { kind: 'medium' as const, key: thumbnailKeys.mediumKey },
        { kind: 'tiny' as const, key: thumbnailKeys.tinyKey },
      ]) {
        const variantBuffer = await buildPhotoVariantBuffer(variantSource.input, variant.kind);
        await putObject(client, variant.key, variantBuffer, 'image/jpeg', ossTimeoutMs);
        uploadedKeys.add(variant.key);
        maybeGC();
      }
    }
    maybeGC();

    const srcFull = `/${thumbnailKeys.fullKey}`;
    const srcMedium = `/${thumbnailKeys.mediumKey}`;
    const srcTiny = `/${thumbnailKeys.tinyKey}`;
    const keepKeys = new Set<string>([objectKey, thumbnailKeys.fullKey, thumbnailKeys.mediumKey, thumbnailKeys.tinyKey]);
    const previousKeys = new Set<string>();

    for (const candidate of [
      existingRecord?.src,
      existingRecord?.srcMedium,
      existingRecord?.srcTiny,
      existingRecord?.originalSrc,
    ]) {
      const key = extractObjectKeyFromUrl(candidate);
      if (key && !keepKeys.has(key)) {
        previousKeys.add(key);
      }
    }

    for (const key of previousKeys) {
      await deleteObjectIgnoreNotFound(client, key, ossTimeoutMs);
    }

    upsertMetadataRecordByFilename(metadataRecords, {
      filename: file.filename,
      originalSrc: `/${objectKey}`,
      src: srcFull,
      srcMedium,
      srcTiny,
      width: photoWidth,
      height: photoHeight,
      size: file.size,
      format: getFormatLabelFromExtension(extension),
      date: photoDate || undefined,
      videoSrc: existingRecord?.videoSrc,
      isVisible: existingRecord?.isVisible,
      visibilityUpdatedAt: existingRecord?.visibilityUpdatedAt ?? null,
    });
    writeMetadataRecords(metadataFile, metadataRecords);

    return {
      filename: file.filename,
      size: file.size,
      src: srcFull,
    };
  } catch (error) {
    for (const key of uploadedKeys) {
      try {
        await deleteObjectIgnoreNotFound(client, key, ossTimeoutMs);
      } catch (cleanupError) {
        console.error(`Failed to rollback uploaded OSS object ${key}:`, cleanupError);
      }
    }
    throw error;
  } finally {
    await removeTempFile(file.tempPath);
  }
}

async function processJob(job: PhotoUploadJob): Promise<void> {
  const client = createPhotoOssClient(job.ossConfig);
  const ossTimeoutMs = job.ossConfig.timeoutMs;
  const parsedFileTimeout = Number.parseInt(process.env.PHOTO_UPLOAD_FILE_TIMEOUT_MS || '300000', 10);
  const fileTimeoutMs = Number.isFinite(parsedFileTimeout) && parsedFileTimeout > 0 ? parsedFileTimeout : 300000;
  const fileTimeoutSec = Math.round(fileTimeoutMs / 1000);

  job.status = 'processing';
  job.updatedAt = nowIso();
  job.message = '正在处理照片';

  for (const file of job.files) {
    job.currentFilename = file.filename;
    job.updatedAt = nowIso();

    try {
      const promise = processOneFile(file, client, job.metadataFile, ossTimeoutMs);
      const result = await withTimeout(
        promise,
        fileTimeoutMs,
        `照片处理超时（超过 ${fileTimeoutSec} 秒）`,
      );
      job.uploaded.push(result);
    } catch (error) {
      await removeTempFile(file.tempPath);
      job.failed.push({
        filename: file.filename,
        error: error instanceof Error ? error.message : '上传照片失败',
      });
    } finally {
      job.processed += 1;
      job.updatedAt = nowIso();
      // Hint V8 to reclaim large buffers before the next file
      maybeGC();
    }
  }

  job.currentFilename = null;
  job.finishedAt = nowIso();
  job.updatedAt = job.finishedAt;

  if (job.uploaded.length === 0) {
    job.status = 'failed';
    job.message = job.failed[0]?.error || '照片上传失败';
    return;
  }

  job.status = 'completed';
  job.message = job.failed.length > 0
    ? `成功上传 ${job.uploaded.length} 张，失败 ${job.failed.length} 张`
    : `成功上传并处理 ${job.uploaded.length} 张照片`;
}

async function processQueue(): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;

  try {
    while (queue.length > 0) {
      const jobId = queue.shift();
      if (!jobId) continue;
      const job = jobs.get(jobId);
      if (!job) continue;
      await processJob(job);
    }
  } finally {
    isProcessing = false;
  }
}

export function enqueuePhotoUploadJob(input: {
  files: PhotoUploadTempFile[];
  ossConfig: PhotoOssConfig;
  metadataFile: string;
}): PhotoUploadJobSnapshot {
  cleanupOldJobs();
  const timestamp = nowIso();
  const job: PhotoUploadJob = {
    jobId: crypto.randomUUID(),
    status: 'queued',
    files: input.files,
    total: input.files.length,
    processed: 0,
    uploaded: [],
    failed: [],
    currentFilename: null,
    message: '等待处理',
    createdAt: timestamp,
    updatedAt: timestamp,
    finishedAt: null,
    ossConfig: input.ossConfig,
    metadataFile: input.metadataFile,
  };

  jobs.set(job.jobId, job);
  queue.push(job.jobId);
  void processQueue();
  return snapshot(job);
}

export function getPhotoUploadJob(jobId: string): PhotoUploadJobSnapshot | null {
  const job = jobs.get(jobId);
  return job ? snapshot(job) : null;
}

export function cleanupPhotoUploadTempDir(tempDir: string): void {
  if (!fs.existsSync(tempDir)) return;

  for (const entry of fs.readdirSync(tempDir)) {
    const filePath = path.join(tempDir, entry);
    const stat = fs.statSync(filePath);
    if (stat.isFile()) {
      fs.unlinkSync(filePath);
    }
  }
}
