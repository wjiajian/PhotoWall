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
sharp.cache({ memory: 64, files: 0, items: 32 });

export interface PhotoOssConfig {
  region: string;
  bucket: string;
  accessKeyId: string;
  accessKeySecret: string;
  endpoint: string;
}

export function createPhotoOssClient(config: PhotoOssConfig): OSS {
  return new OSS({
    region: config.region,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    endpoint: config.endpoint || undefined,
    secure: true,
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

export async function putObject(client: OSS, key: string, body: Buffer, contentType: string): Promise<void> {
  await client.put(key, body, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}

export async function deleteObjectIgnoreNotFound(client: OSS, key: string): Promise<void> {
  try {
    await client.delete(key);
  } catch (error) {
    const status = (error as { status?: number }).status;
    const code = (error as { code?: string }).code;
    if (status === 404 || code === 'NoSuchKey') {
      return;
    }
    throw error;
  }
}

export async function convertToJpegBuffer(inputBuffer: Buffer, extension: string): Promise<Buffer> {
  const isHeic = extension === '.heic' || extension === '.heif';
  if (isHeic) {
    const converted = await heicConvert({
      buffer: inputBuffer,
      format: 'JPEG',
      quality: 0.9,
    });
    return Buffer.from(converted);
  }

  if (extension === '.jpg' || extension === '.jpeg') {
    return inputBuffer;
  }

  return await sharp(inputBuffer)
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer();
}

export async function buildPhotoVariants(fullSourceBuffer: Buffer): Promise<{
  fullBuffer: Buffer;
  mediumBuffer: Buffer;
  tinyBuffer: Buffer;
  width: number;
  height: number;
}> {
  const fullBuffer = await sharp(fullSourceBuffer)
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer();

  const fullSharp = sharp(fullBuffer);
  const info = await fullSharp.metadata();

  const mediumBuffer = await fullSharp
    .clone()
    .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80, mozjpeg: true })
    .toBuffer();

  const tinyBuffer = await fullSharp
    .clone()
    .resize(50, 50, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 60 })
    .toBuffer();

  return {
    fullBuffer,
    mediumBuffer,
    tinyBuffer,
    width: info.width || 0,
    height: info.height || 0,
  };
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
