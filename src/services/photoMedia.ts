import { createRequire } from 'module';
import { promises as fsPromises } from 'fs';
import sharp from 'sharp';
import exifr from 'exifr';
import OSS from 'ali-oss';

const requireFromEsm = createRequire(import.meta.url);
const heicConvert = requireFromEsm('heic-convert') as (params: {
  buffer: Buffer;
  format: 'JPEG';
  quality: number;
}) => Promise<Uint8Array>;

const parsedSharpConcurrency = Number.parseInt(process.env.PHOTO_PROCESS_SHARP_CONCURRENCY || '1', 10);
const sharpConcurrency = Number.isFinite(parsedSharpConcurrency) && parsedSharpConcurrency > 0
  ? parsedSharpConcurrency
  : 1;

sharp.concurrency(sharpConcurrency);

// Minimal cache: on 2GB servers, every MB counts. Sharp's internal libvips
// already buffers decoded pixels; this cache only holds intermediate pipeline
// results. 8 MB is enough for repeated metadata reads while staying lean.
sharp.cache({ memory: 8, files: 0, items: 8 });

const parsedMaxInputPixels = Number.parseInt(process.env.PHOTO_PROCESS_MAX_PIXELS || '30000000', 10);
const maxInputPixels = Number.isFinite(parsedMaxInputPixels) && parsedMaxInputPixels > 0
  ? parsedMaxInputPixels
  : 30000000;
const parsedHeicMaxMb = Number.parseInt(process.env.PHOTO_HEIC_MAX_MB || '15', 10);
const maxHeicBytes = (Number.isFinite(parsedHeicMaxMb) && parsedHeicMaxMb > 0 ? parsedHeicMaxMb : 15) * 1024 * 1024;

function parsePositiveIntEnv(name: string, fallback: number, max?: number): number {
  const parsed = Number.parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return max !== undefined ? Math.min(parsed, max) : parsed;
}

const fullMaxPx = parsePositiveIntEnv('PHOTO_THUMBNAIL_FULL_MAX_PX', 0);
const mediumMaxPx = parsePositiveIntEnv('PHOTO_THUMBNAIL_MEDIUM_MAX_PX', 800);
const tinyMaxPx = parsePositiveIntEnv('PHOTO_THUMBNAIL_TINY_MAX_PX', 50);

const fullQuality = parsePositiveIntEnv('PHOTO_THUMBNAIL_FULL_QUALITY', 92, 100);
const mediumQuality = parsePositiveIntEnv('PHOTO_THUMBNAIL_MEDIUM_QUALITY', 80, 100);
const tinyQuality = parsePositiveIntEnv('PHOTO_THUMBNAIL_TINY_QUALITY', 60, 100);

export type PhotoInput = Buffer | string;
type OssPutBody = Parameters<OSS['put']>[1];

export function createSharpInput(input: PhotoInput): sharp.Sharp {
  return sharp(input, { limitInputPixels: maxInputPixels });
}

export interface PhotoOssConfig {
  region: string;
  bucket: string;
  accessKeyId: string;
  accessKeySecret: string;
  endpoint: string;
  timeoutMs: number;
}
export function createPhotoOssClient(config: PhotoOssConfig): OSS {
  return new OSS({
    region: config.region,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    endpoint: config.endpoint || undefined,
    secure: true,
    timeout: config.timeoutMs,
  });
}

export function buildOriginalObjectKey(filename: string): string {
  return `photowall/origin/${filename}`;
}

export function buildUploadThumbnailObjectKeys(filename: string): { fullKey: string; mediumKey: string; tinyKey: string } {
  return {
    fullKey: `photowall/thumbnails/full/${filename}.jpg`,
    mediumKey: `photowall/thumbnails/medium/${filename}.jpg`,
    tinyKey: `photowall/thumbnails/tiny/${filename}.jpg`,
  };
}

export function getPhotoObjectKeys(baseName: string): { fullKey: string; mediumKey: string; tinyKey: string } {
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
  client: OSS,
  key: string,
  body: OssPutBody,
  contentType: string,
  timeoutMs?: number,
): Promise<void> {
  await client.put(key, body, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
    ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
  });
}

export async function deleteObjectIgnoreNotFound(
  client: OSS,
  key: string,
  timeoutMs?: number,
): Promise<void> {
  try {
    await client.delete(key, {
      ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
    });
  } catch (error) {
    const status = (error as { status?: number }).status;
    const code = (error as { code?: string }).code;
    if (status === 404 || code === 'NoSuchKey') {
      return;
    }
    throw error;
  }
}

export type PhotoVariantKind = 'full' | 'medium' | 'tiny';

export interface PhotoVariantSource {
  input: PhotoInput;
  width: number;
  height: number;
}

/**
 * Prepare the source buffer used for thumbnail generation.
 *
 * HEIC/HEIF still needs a JPEG staging buffer because heic-convert is the
 * decoder in this project. Sharp-supported formats are passed through directly
 * to avoid an extra full-size JPEG allocation.
 */
export async function preparePhotoVariantSource(
  input: PhotoInput,
  extension: string,
  inputSizeBytes?: number,
): Promise<PhotoVariantSource> {
  const isHeic = extension === '.heic' || extension === '.heif';
  let sourceInput = input;

  if (isHeic) {
    if (inputSizeBytes !== undefined && inputSizeBytes > maxHeicBytes) {
      throw new Error(`HEIC/HEIF 文件不能超过 ${Math.round(maxHeicBytes / 1024 / 1024)}MB`);
    }
    const inputBuffer = typeof input === 'string'
      ? await fsPromises.readFile(input)
      : input;
    const converted = await heicConvert({
      buffer: inputBuffer,
      format: 'JPEG',
      quality: 0.9,
    });
    // Share the underlying ArrayBuffer rather than copying — saves a ~20 MB
    // duplicate allocation for high-resolution HEIC photos.
    sourceInput = Buffer.from(converted.buffer, converted.byteOffset, converted.byteLength);
  }

  const { width, height } = await createSharpInput(sourceInput).metadata();

  return {
    input: sourceInput,
    width: width || 0,
    height: height || 0,
  };
}

export async function buildPhotoVariantBuffer(
  sourceInput: PhotoInput,
  kind: PhotoVariantKind,
): Promise<Buffer> {
  const base = createSharpInput(sourceInput);
  return buildPhotoVariantBufferFromSharp(base, kind);
}

/**
 * Build a photo variant from a pre-existing sharp instance.
 *
 * Prefer this over {@link buildPhotoVariantBuffer} when generating multiple
 * variants from the same source: the base instance decodes the image once,
 * and each variant clones the pipeline so the decode work is shared.
 */
export async function buildPhotoVariantBufferFromSharp(
  base: sharp.Sharp,
  kind: PhotoVariantKind,
): Promise<Buffer> {
  if (kind === 'full') {
    const pipeline = base.clone();
    if (fullMaxPx > 0) {
      pipeline.resize(fullMaxPx, fullMaxPx, { fit: 'inside', withoutEnlargement: true });
    }
    return await pipeline.jpeg({ quality: fullQuality, mozjpeg: true }).toBuffer();
  }

  if (kind === 'medium') {
    return await base
      .clone()
      .resize(mediumMaxPx, mediumMaxPx, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: mediumQuality, mozjpeg: true })
      .toBuffer();
  }

  return await base
    .clone()
    .resize(tinyMaxPx, tinyMaxPx, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: tinyQuality })
    .toBuffer();
}

function formatDate(input: string | Date | undefined | null): string | null {
  if (!input) return null;
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (value: number) => value.toString().padStart(2, '0');
  return `${date.getFullYear()}:${pad(date.getMonth() + 1)}:${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export async function extractPhotoDate(sourceInput: PhotoInput, fallbackIsoDate?: string): Promise<string | null> {
  try {
    const meta = await exifr.parse(sourceInput);
    const candidate = meta?.DateTimeOriginal || meta?.CreateDate || meta?.ModifyDate;
    const parsed = formatDate(candidate);
    if (parsed) return parsed;
  } catch {
    // ignore EXIF parse errors
  }

  return formatDate(fallbackIsoDate || null);
}
