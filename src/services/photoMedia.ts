import fs from 'node:fs';
import path from 'node:path';
import OSS from 'ali-oss';

export const PHOTO_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const MEDIUM_IMAGE_PROCESS = 'image/resize,m_lfit,w_800,h_800,limit_1/quality,q_80/format,jpg';
export const TINY_IMAGE_PROCESS = 'image/resize,m_lfit,w_50,h_50,limit_1/quality,q_60/format,jpg';

export interface PhotoOssConfig {
  region: string;
  bucket: string;
  accessKeyId: string;
  accessKeySecret: string;
  endpoint: string;
  timeoutMs: number;
}

export interface PhotoOssClient extends OSS {
  processObjectSave(
    sourceObject: string,
    targetObject: string,
    process: string,
    targetBucket?: string,
  ): Promise<{ status: number; res: { status?: number } }>;
}

export interface PersistentVariantOptions {
  attempts?: number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

type OssPutBody = Parameters<OSS['put']>[1];

function isNotFoundError(error: unknown): boolean {
  const candidate = error as { status?: number; statusCode?: number; code?: string };
  return candidate.status === 404
    || candidate.statusCode === 404
    || candidate.code === 'NoSuchKey'
    || candidate.code === 'NoSuchObject';
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, delayMs);
  });
}

export function assertPhotoOssRuntimeSupport(): void {
  const prototype = OSS.prototype as Partial<PhotoOssClient>;
  if (typeof prototype.processObjectSave !== 'function') {
    throw new Error('当前 ali-oss 运行时不支持 processObjectSave，无法生成持久化缩略图');
  }
}

export function createPhotoOssClient(config: PhotoOssConfig): PhotoOssClient {
  assertPhotoOssRuntimeSupport();
  return new OSS({
    region: config.region,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    endpoint: config.endpoint || undefined,
    secure: true,
    timeout: config.timeoutMs,
  }) as PhotoOssClient;
}

export function buildOriginalObjectKey(filename: string): string {
  return `photowall/origin/${filename}`;
}

export function buildUploadThumbnailObjectKeys(filename: string): {
  fullKey: string;
  mediumKey: string;
  tinyKey: string;
} {
  return {
    fullKey: `photowall/thumbnails/full/${filename}.jpg`,
    mediumKey: `photowall/thumbnails/medium/${filename}.jpg`,
    tinyKey: `photowall/thumbnails/tiny/${filename}.jpg`,
  };
}

export function getPhotoObjectKeys(baseName: string): {
  fullKey: string;
  mediumKey: string;
  tinyKey: string;
} {
  return {
    fullKey: `photowall/thumbnails/full/${baseName}.jpg`,
    mediumKey: `photowall/thumbnails/medium/${baseName}.jpg`,
    tinyKey: `photowall/thumbnails/tiny/${baseName}.jpg`,
  };
}

export function getContentTypeFromExtension(extension: string): string {
  const normalized = extension.toLowerCase();
  if (normalized === '.jpg' || normalized === '.jpeg') return 'image/jpeg';
  if (normalized === '.png') return 'image/png';
  if (normalized === '.webp') return 'image/webp';
  if (normalized === '.gif') return 'image/gif';
  if (normalized === '.heic') return 'image/heic';
  if (normalized === '.heif') return 'image/heif';
  return 'application/octet-stream';
}

export function getFormatLabelFromExtension(extension: string): string {
  const normalized = extension.toLowerCase();
  if (normalized === '.jpg' || normalized === '.jpeg') return 'JPEG';
  if (normalized === '.heic') return 'HEIC';
  if (normalized === '.heif') return 'HEIF';
  return normalized.replace('.', '').toUpperCase();
}

export async function putObject(
  client: PhotoOssClient,
  key: string,
  body: OssPutBody,
  contentType: string,
  timeoutMs?: number,
): Promise<void> {
  await client.put(key, body, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': PHOTO_CACHE_CONTROL,
    },
    ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
  });
}

export async function putOriginalJpeg(
  client: PhotoOssClient,
  key: string,
  filePath: string,
  timeoutMs?: number,
): Promise<void> {
  await putObject(client, key, fs.createReadStream(filePath), 'image/jpeg', timeoutMs);
}

export async function objectExists(
  client: PhotoOssClient,
  key: string,
  timeoutMs?: number,
): Promise<boolean> {
  try {
    await client.head(key, timeoutMs === undefined ? undefined : { timeout: timeoutMs });
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

export async function deleteObjectIgnoreNotFound(
  client: PhotoOssClient,
  key: string,
  timeoutMs?: number,
): Promise<void> {
  try {
    await client.delete(key, timeoutMs === undefined ? undefined : { timeout: timeoutMs });
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }
}

async function replaceThumbnailHeaders(
  client: PhotoOssClient,
  key: string,
  timeoutMs?: number,
): Promise<void> {
  await client.copy(key, key, {
    headers: {
      'Content-Type': 'image/jpeg',
      'Cache-Control': PHOTO_CACHE_CONTROL,
    },
    ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
  });
}

async function waitForObject(
  client: PhotoOssClient,
  key: string,
  timeoutMs: number,
  pollIntervalMs: number,
  operationTimeoutMs: number | undefined,
  sleep: (delayMs: number) => Promise<void>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  do {
    if (await objectExists(client, key, operationTimeoutMs)) return true;
    if (Date.now() >= deadline) break;
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  } while (Date.now() <= deadline);

  return false;
}

export async function ensurePersistentJpegVariant(
  client: PhotoOssClient,
  sourceKey: string,
  targetKey: string,
  process: string,
  operationTimeoutMs?: number,
  options: PersistentVariantOptions = {},
): Promise<void> {
  const attempts = Math.max(1, Math.min(options.attempts ?? 3, 3));
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 1000);
  const pollTimeoutMs = Math.max(1, Math.min(options.pollTimeoutMs ?? 60_000, 60_000));
  const sleep = options.sleep ?? defaultSleep;
  const pollDeadline = Date.now() + pollTimeoutMs;

  if (await objectExists(client, targetKey, operationTimeoutMs)) {
    await replaceThumbnailHeaders(client, targetKey, operationTimeoutMs);
    return;
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let requestSucceeded = false;
    try {
      await client.processObjectSave(sourceKey, targetKey, process);
      requestSucceeded = true;
    } catch (error) {
      lastError = error;
    }

    try {
      const remainingPollMs = Math.max(0, pollDeadline - Date.now());
      const exists = requestSucceeded && remainingPollMs > 0
        ? await waitForObject(
          client,
          targetKey,
          remainingPollMs,
          pollIntervalMs,
          operationTimeoutMs,
          sleep,
        )
        : await objectExists(client, targetKey, operationTimeoutMs);
      if (exists) {
        await replaceThumbnailHeaders(client, targetKey, operationTimeoutMs);
        return;
      }
      if (requestSucceeded) {
        lastError = new Error(`OSS 持久化对象在 ${Math.round(pollTimeoutMs / 1000)} 秒内未就绪: ${targetKey}`);
      }
    } catch (error) {
      lastError = error;
    }

    if (attempt < attempts && Date.now() < pollDeadline) {
      await sleep(Math.min(1000 * attempt, 3000));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`OSS 持久化处理失败: ${path.basename(targetKey)}`);
}

function unwrapOssImageValue(value: unknown): unknown {
  if (value && typeof value === 'object' && 'value' in value) {
    return (value as { value?: unknown }).value;
  }
  return value;
}

function formatExifDate(value: unknown): string | null {
  const unwrapped = unwrapOssImageValue(value);
  if (typeof unwrapped !== 'string') return null;
  const trimmed = unwrapped.trim();
  if (/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)) return trimmed;

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  const pad = (part: number): string => String(part).padStart(2, '0');
  return `${parsed.getFullYear()}:${pad(parsed.getMonth() + 1)}:${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}:${pad(parsed.getSeconds())}`;
}

export async function readOssPhotoDate(
  client: PhotoOssClient,
  key: string,
  timeoutMs?: number,
): Promise<string | null> {
  try {
    const result = await client.get(key, {
      process: 'image/exif',
      ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
    });
    const raw = Buffer.isBuffer(result.content)
      ? result.content.toString('utf8')
      : String(result.content ?? '');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return formatExifDate(
      parsed.DateTimeOriginal
      ?? parsed.DateTimeDigitized
      ?? parsed.CreateDate
      ?? parsed.ModifyDate,
    );
  } catch {
    return null;
  }
}
