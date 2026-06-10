import { createRequire } from 'module';
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
// results. 16 MB is enough for repeated metadata reads while staying lean.
sharp.cache({ memory: 16, files: 0, items: 16 });

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
  body: Buffer,
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
  buffer: Buffer;
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
  inputBuffer: Buffer,
  extension: string,
): Promise<PhotoVariantSource> {
  const isHeic = extension === '.heic' || extension === '.heif';
  let sourceBuffer = inputBuffer;

  if (isHeic) {
    const converted = await heicConvert({
      buffer: inputBuffer,
      format: 'JPEG',
      quality: 0.9,
    });
    // Share the underlying ArrayBuffer rather than copying — saves a ~20 MB
    // duplicate allocation for high-resolution HEIC photos.
    sourceBuffer = Buffer.from(converted.buffer, converted.byteOffset, converted.byteLength);
  }

  const { width, height } = await sharp(sourceBuffer).metadata();

  return {
    buffer: sourceBuffer,
    width: width || 0,
    height: height || 0,
  };
}

export async function buildPhotoVariantBuffer(
  sourceBuffer: Buffer,
  kind: PhotoVariantKind,
): Promise<Buffer> {
  if (kind === 'full') {
    return await sharp(sourceBuffer)
      .jpeg({ quality: 92, mozjpeg: true })
      .toBuffer();
  }

  if (kind === 'medium') {
    return await sharp(sourceBuffer)
      .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();
  }

  return await sharp(sourceBuffer)
    .resize(50, 50, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 60 })
    .toBuffer();
}

function formatDate(input: string | Date | undefined | null): string | null {
  if (!input) return null;
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (value: number) => value.toString().padStart(2, '0');
  return `${date.getFullYear()}:${pad(date.getMonth() + 1)}:${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export async function extractPhotoDate(sourceBuffer: Buffer, fallbackIsoDate?: string): Promise<string | null> {
  try {
    const meta = await exifr.parse(sourceBuffer);
    const candidate = meta?.DateTimeOriginal || meta?.CreateDate || meta?.ModifyDate;
    const parsed = formatDate(candidate);
    if (parsed) return parsed;
  } catch {
    // ignore EXIF parse errors
  }

  return formatDate(fallbackIsoDate || null);
}
