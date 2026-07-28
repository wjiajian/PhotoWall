import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OSS from 'ali-oss';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUTPUT_FILE = path.join(PROJECT_ROOT, 'src', 'data', 'images-metadata.json');
const PHOTO_EXTENSION_REGEX = /\.(jpe?g|png|webp|heic|heif)$/i;
const JPEG_EXTENSION_REGEX = /\.jpe?g$/i;
const ORIGIN_PREFIX = 'photowall/origin/';
const THUMB_FULL_PREFIX = 'photowall/thumbnails/full/';
const THUMB_MEDIUM_PREFIX = 'photowall/thumbnails/medium/';
const THUMB_TINY_PREFIX = 'photowall/thumbnails/tiny/';
const PAGE_SIZE = 1000;

function getRequiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function getOptionalEnv(name) {
  return process.env[name]?.trim() || undefined;
}

function getOperationTimeout() {
  const parsed = Number.parseInt(process.env.PHOTO_OSS_OPERATION_TIMEOUT_MS || '60000', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
}

function createClient() {
  return new OSS({
    region: getRequiredEnv('OSS_REGION'),
    bucket: getRequiredEnv('OSS_BUCKET'),
    accessKeyId: getRequiredEnv('OSS_ACCESS_KEY_ID'),
    accessKeySecret: getRequiredEnv('OSS_ACCESS_KEY_SECRET'),
    endpoint: getOptionalEnv('OSS_ENDPOINT'),
    secure: true,
    timeout: getOperationTimeout(),
  });
}

async function listAllObjects(client, prefix) {
  const objects = [];
  let continuationToken;
  do {
    const result = await client.listV2({
      prefix,
      'max-keys': PAGE_SIZE,
      continuationToken,
    });
    if (Array.isArray(result.objects)) objects.push(...result.objects.filter(Boolean));
    continuationToken = result.isTruncated ? result.nextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

function stripPrefix(key, prefix) {
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

function getFormatLabelFromFilename(filename) {
  const extension = path.extname(filename).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'JPEG';
  if (extension === '.heic') return 'HEIC';
  if (extension === '.heif') return 'HEIF';
  return extension.replace('.', '').toUpperCase();
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatDate(input) {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return undefined;
  return `${date.getFullYear()}:${pad(date.getMonth() + 1)}:${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function unwrapImageValue(value) {
  if (value && typeof value === 'object' && 'value' in value) return value.value;
  return value;
}

function parseNumber(value) {
  const number = Number(unwrapImageValue(value));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function parseExifDate(data) {
  const raw = unwrapImageValue(
    data?.DateTimeOriginal
    ?? data?.DateTimeDigitized
    ?? data?.CreateDate
    ?? data?.ModifyDate,
  );
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)) return trimmed;
  return formatDate(trimmed);
}

async function loadExistingMetadata() {
  try {
    const raw = await fs.readFile(OUTPUT_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new TypeError('metadata root must be an array');
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw new Error(`Existing metadata is invalid; refusing to overwrite ${OUTPUT_FILE}`, { cause: error });
  }
}

async function getImageProcessJson(client, key, processName) {
  const result = await client.get(key, {
    process: processName,
    timeout: getOperationTimeout(),
  });
  const raw = Buffer.isBuffer(result.content)
    ? result.content.toString('utf8')
    : String(result.content ?? '');
  return JSON.parse(raw);
}

async function resolveDate(client, originKey, fallbackDate) {
  try {
    return parseExifDate(await getImageProcessJson(client, originKey, 'image/exif')) || fallbackDate;
  } catch (error) {
    console.warn(`[warn] OSS image/exif failed for ${originKey}: ${error instanceof Error ? error.message : String(error)}`);
    return fallbackDate;
  }
}

async function resolveDimensions(client, originKey, existing) {
  try {
    const info = await getImageProcessJson(client, originKey, 'image/info');
    return {
      width: parseNumber(info.ImageWidth ?? info.Width) || existing?.width || 0,
      height: parseNumber(info.ImageHeight ?? info.Height) || existing?.height || 0,
    };
  } catch (error) {
    console.warn(`[warn] OSS image/info failed for ${originKey}: ${error instanceof Error ? error.message : String(error)}`);
    return { width: existing?.width || 0, height: existing?.height || 0 };
  }
}

async function atomicWriteMetadata(records) {
  const tempFile = `${OUTPUT_FILE}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  try {
    await fs.writeFile(tempFile, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
    await fs.rename(tempFile, OUTPUT_FILE);
  } catch (error) {
    await fs.rm(tempFile, { force: true }).catch(() => {});
    throw error;
  }
}

async function main() {
  const client = createClient();
  const existingMetadata = await loadExistingMetadata();
  const existingByFilename = new Map(existingMetadata.map(item => [item.filename, item]));

  console.log('Listing OSS objects...');
  const [originObjects, fullObjects, mediumObjects, tinyObjects] = await Promise.all([
    listAllObjects(client, ORIGIN_PREFIX),
    listAllObjects(client, THUMB_FULL_PREFIX),
    listAllObjects(client, THUMB_MEDIUM_PREFIX),
    listAllObjects(client, THUMB_TINY_PREFIX),
  ]);
  console.log(`Found objects -> origin: ${originObjects.length}, historical full: ${fullObjects.length}, medium: ${mediumObjects.length}, tiny: ${tinyObjects.length}`);

  const originByFilename = new Map();
  for (const object of originObjects) {
    if (!object.name || !PHOTO_EXTENSION_REGEX.test(object.name)) continue;
    originByFilename.set(stripPrefix(object.name, ORIGIN_PREFIX), object);
  }

  const fullByFilename = new Map();
  for (const object of fullObjects) {
    if (!object.name?.toLowerCase().endsWith('.jpg')) continue;
    const thumbnailFilename = stripPrefix(object.name, THUMB_FULL_PREFIX);
    fullByFilename.set(thumbnailFilename.slice(0, -4), object);
  }
  const mediumKeySet = new Set(
    mediumObjects.filter(object => object.name?.toLowerCase().endsWith('.jpg'))
      .map(object => stripPrefix(object.name, THUMB_MEDIUM_PREFIX)),
  );
  const tinyKeySet = new Set(
    tinyObjects.filter(object => object.name?.toLowerCase().endsWith('.jpg'))
      .map(object => stripPrefix(object.name, THUMB_TINY_PREFIX)),
  );

  if (originByFilename.size === 0) {
    throw new Error(`No photo origins found under ${ORIGIN_PREFIX}`);
  }

  const records = [];
  for (const filename of Array.from(originByFilename.keys()).sort((a, b) => a.localeCompare(b, 'zh-CN'))) {
    const originObject = originByFilename.get(filename);
    if (!originObject?.name) continue;
    const existing = existingByFilename.get(filename);
    const isJpeg = JPEG_EXTENSION_REGEX.test(filename);
    const historicalFull = fullByFilename.get(filename);
    if (!isJpeg && !historicalFull?.name) {
      console.warn(`[warn] skip historical non-JPEG without full JPEG: ${filename}`);
      continue;
    }

    const fallbackDate = formatDate(originObject.lastModified) || existing?.date;
    const [date, dimensions] = await Promise.all([
      resolveDate(client, originObject.name, fallbackDate),
      resolveDimensions(client, originObject.name, existing),
    ]);
    const thumbnailFilename = `${filename}.jpg`;
    records.push({
      filename,
      originalSrc: `/${originObject.name}`,
      src: isJpeg ? `/${originObject.name}` : `/${historicalFull.name}`,
      srcMedium: mediumKeySet.has(thumbnailFilename)
        ? `/${THUMB_MEDIUM_PREFIX}${thumbnailFilename}`
        : undefined,
      srcTiny: tinyKeySet.has(thumbnailFilename)
        ? `/${THUMB_TINY_PREFIX}${thumbnailFilename}`
        : undefined,
      width: dimensions.width,
      height: dimensions.height,
      size: Number(originObject.size ?? existing?.size ?? 0),
      format: existing?.format || getFormatLabelFromFilename(filename),
      date: date || existing?.date,
      videoSrc: existing?.videoSrc,
      driveItemId: existing?.driveItemId,
      isVisible: existing?.isVisible,
      visibilityUpdatedAt: existing?.visibilityUpdatedAt,
    });
  }

  records.sort((a, b) => {
    if (a.date && b.date) return b.date.localeCompare(a.date);
    return a.filename.localeCompare(b.filename, 'zh-CN');
  });
  await atomicWriteMetadata(records);
  console.log(`Rebuilt ${records.length} metadata records -> ${OUTPUT_FILE}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
