import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import OSS from 'ali-oss';
import exifr from 'exifr';
import sharp from 'sharp';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUTPUT_FILE = path.join(PROJECT_ROOT, 'src', 'data', 'images-metadata.json');
const PHOTO_EXTENSION_REGEX = /\.(jpe?g|png|webp|heic|heif)$/i;
const ORIGIN_PREFIX = 'photowall/origin/';
const THUMB_FULL_PREFIX = 'photowall/thumbnails/full/';
const THUMB_MEDIUM_PREFIX = 'photowall/thumbnails/medium/';
const THUMB_TINY_PREFIX = 'photowall/thumbnails/tiny/';
const PAGE_SIZE = 1000;

function getRequiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getOptionalEnv(name) {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function createClient() {
  return new OSS({
    region: getRequiredEnv('OSS_REGION'),
    bucket: getRequiredEnv('OSS_BUCKET'),
    accessKeyId: getRequiredEnv('OSS_ACCESS_KEY_ID'),
    accessKeySecret: getRequiredEnv('OSS_ACCESS_KEY_SECRET'),
    endpoint: getOptionalEnv('OSS_ENDPOINT'),
    secure: true,
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

    if (Array.isArray(result.objects)) {
      objects.push(...result.objects.filter(Boolean));
    }

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
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return `${date.getFullYear()}:${pad(date.getMonth() + 1)}:${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function coerceExifDate(parsed) {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const candidate = parsed.DateTimeOriginal ?? parsed.CreateDate ?? parsed.ModifyDate ?? parsed.DateTimeDigitized;
  if (!candidate) return undefined;
  const date = candidate instanceof Date ? candidate : new Date(candidate);
  if (Number.isNaN(date.getTime())) return undefined;
  return date;
}

async function loadExistingMetadata() {
  try {
    const raw = await fs.readFile(OUTPUT_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function getObjectBuffer(client, key) {
  const result = await client.get(key);
  return result.content;
}

async function resolveDate(client, originKey, fallbackDate) {
  try {
    const buffer = await getObjectBuffer(client, originKey);
    const parsed = await exifr.parse(buffer, {
      pick: ['DateTimeOriginal', 'CreateDate', 'ModifyDate', 'DateTimeDigitized'],
    });
    const exifDate = coerceExifDate(parsed);
    if (exifDate) {
      return formatDate(exifDate);
    }
  } catch (error) {
    console.warn(`[warn] failed to read EXIF from ${originKey}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return fallbackDate;
}

async function resolveDimensions(client, fullKey) {
  const buffer = await getObjectBuffer(client, fullKey);
  const metadata = await sharp(buffer).metadata();
  return {
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    size: Buffer.isBuffer(buffer) ? buffer.length : 0,
  };
}

async function main() {
  const client = createClient();
  const existingMetadata = await loadExistingMetadata();
  const existingByFilename = new Map(existingMetadata.map((item) => [item.filename, item]));

  console.log('Listing OSS objects...');
  const [originObjects, fullObjects, mediumObjects, tinyObjects] = await Promise.all([
    listAllObjects(client, ORIGIN_PREFIX),
    listAllObjects(client, THUMB_FULL_PREFIX),
    listAllObjects(client, THUMB_MEDIUM_PREFIX),
    listAllObjects(client, THUMB_TINY_PREFIX),
  ]);

  console.log(`Found objects -> origin: ${originObjects.length}, full: ${fullObjects.length}, medium: ${mediumObjects.length}, tiny: ${tinyObjects.length}`);

  const originByFilename = new Map();
  for (const object of originObjects) {
    if (!object.name || !PHOTO_EXTENSION_REGEX.test(object.name)) continue;
    const filename = stripPrefix(object.name, ORIGIN_PREFIX);
    originByFilename.set(filename, object);
  }

  const fullByFilename = new Map();
  for (const object of fullObjects) {
    if (!object.name || !object.name.toLowerCase().endsWith('.jpg')) continue;
    const filename = stripPrefix(object.name, THUMB_FULL_PREFIX);
    if (!filename.toLowerCase().endsWith('.jpg')) continue;
    const originFilename = filename.slice(0, -4);
    fullByFilename.set(originFilename, object);
  }

  const mediumKeySet = new Set(
    mediumObjects
      .filter((object) => object.name && object.name.toLowerCase().endsWith('.jpg'))
      .map((object) => stripPrefix(object.name, THUMB_MEDIUM_PREFIX)),
  );
  const tinyKeySet = new Set(
    tinyObjects
      .filter((object) => object.name && object.name.toLowerCase().endsWith('.jpg'))
      .map((object) => stripPrefix(object.name, THUMB_TINY_PREFIX)),
  );

  const filenames = Array.from(originByFilename.keys()).filter((filename) => fullByFilename.has(filename));

  if (filenames.length === 0) {
    throw new Error('No matching origin/full thumbnail objects found under OSS photowall prefixes. Expected thumbnails named as <origin filename>.jpg.');
  }

  const records = [];

  for (const filename of filenames.sort((a, b) => a.localeCompare(b, 'zh-CN'))) {
    const originObject = originByFilename.get(filename);
    const fullObject = fullByFilename.get(filename);
    if (!originObject?.name || !fullObject?.name) continue;

    const existing = existingByFilename.get(filename);
    const fallbackDate = formatDate(originObject.lastModified || fullObject.lastModified);
    const date = await resolveDate(client, originObject.name, fallbackDate);
    const dimensions = await resolveDimensions(client, fullObject.name);
    const mediumFilename = `${filename}.jpg`;
    const tinyFilename = `${filename}.jpg`;

    records.push({
      filename,
      originalSrc: `/${originObject.name}`,
      src: `/${fullObject.name}`,
      srcMedium: mediumKeySet.has(mediumFilename) ? `/${THUMB_MEDIUM_PREFIX}${mediumFilename}` : undefined,
      srcTiny: tinyKeySet.has(tinyFilename) ? `/${THUMB_TINY_PREFIX}${tinyFilename}` : undefined,
      width: dimensions.width || existing?.width || 0,
      height: dimensions.height || existing?.height || 0,
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
    if (a.date && b.date) {
      return b.date.localeCompare(a.date);
    }
    return a.filename.localeCompare(b.filename, 'zh-CN');
  });

  await fs.writeFile(OUTPUT_FILE, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  console.log(`Rebuilt ${records.length} metadata records -> ${OUTPUT_FILE}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});