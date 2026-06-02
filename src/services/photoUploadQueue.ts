import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type OSS from 'ali-oss';
import {
  buildOriginalObjectKey,
  buildPhotoVariants,
  buildUploadThumbnailObjectKeys,
  convertToJpegBuffer,
  createPhotoOssClient,
  deleteObjectIgnoreNotFound,
  extractPhotoDate,
  getContentTypeFromExtension,
  getFormatLabelFromExtension,
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

function nowIso(): string {
  return new Date().toISOString();
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
): Promise<PhotoUploadResultItem> {
  try {
    const extension = path.extname(file.filename).toLowerCase();
    const metadataRecords = readMetadataRecords(metadataFile);
    const existingRecord = metadataRecords.find(record => record.filename === file.filename);
    const inputBuffer = await fs.promises.readFile(file.tempPath);
    const objectKey = buildOriginalObjectKey(file.filename);
    const photoDate = await extractPhotoDate(inputBuffer, new Date().toISOString());
    const contentType = file.mimetype?.startsWith('image/')
      ? file.mimetype
      : getContentTypeFromExtension(extension);

    await putObject(client, objectKey, inputBuffer, contentType);

    const thumbnailKeys = buildUploadThumbnailObjectKeys(file.filename);
    const jpegBuffer = await convertToJpegBuffer(inputBuffer, extension);
    const variants = await buildPhotoVariants(jpegBuffer);

    await putObject(client, thumbnailKeys.fullKey, variants.fullBuffer, 'image/jpeg');
    await putObject(client, thumbnailKeys.mediumKey, variants.mediumBuffer, 'image/jpeg');
    await putObject(client, thumbnailKeys.tinyKey, variants.tinyBuffer, 'image/jpeg');

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
      await deleteObjectIgnoreNotFound(client, key);
    }

    upsertMetadataRecordByFilename(metadataRecords, {
      filename: file.filename,
      originalSrc: `/${objectKey}`,
      src: srcFull,
      srcMedium,
      srcTiny,
      width: variants.width || existingRecord?.width,
      height: variants.height || existingRecord?.height,
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
  } finally {
    await removeTempFile(file.tempPath);
  }
}

async function processJob(job: PhotoUploadJob): Promise<void> {
  const client = createPhotoOssClient(job.ossConfig);
  job.status = 'processing';
  job.updatedAt = nowIso();
  job.message = '正在处理照片';

  for (const file of job.files) {
    job.currentFilename = file.filename;
    job.updatedAt = nowIso();

    try {
      const result = await processOneFile(file, client, job.metadataFile);
      job.uploaded.push(result);
    } catch (error) {
      await removeTempFile(file.tempPath);
      job.failed.push({
        filename: file.filename,
        error: error instanceof Error ? error.message : '上传到 OSS 失败',
      });
    } finally {
      job.processed += 1;
      job.updatedAt = nowIso();
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
