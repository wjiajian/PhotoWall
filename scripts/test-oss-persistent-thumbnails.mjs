import 'dotenv/config';
import crypto from 'node:crypto';
import OSS from 'ali-oss';

const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const MEDIUM_PROCESS = 'image/resize,m_lfit,w_800,h_800,limit_1/quality,q_80/format,jpg';
const TINY_PROCESS = 'image/resize,m_lfit,w_50,h_50,limit_1/quality,q_60/format,jpg';
const TEST_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q==',
  'base64',
);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function unwrap(value) {
  return value && typeof value === 'object' && 'value' in value ? value.value : value;
}

function readNumber(info, ...keys) {
  for (const key of keys) {
    const value = Number(unwrap(info[key]));
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

async function objectExists(client, key) {
  try {
    await client.head(key);
    return true;
  } catch (error) {
    if (error?.status === 404 || error?.code === 'NoSuchKey') return false;
    throw error;
  }
}

async function persist(client, source, target, process) {
  let lastError;
  const deadline = Date.now() + 60_000;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let requestSucceeded = false;
    try {
      await client.processObjectSave(source, target, process);
      requestSucceeded = true;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }

    do {
      if (await objectExists(client, target)) {
        await client.copy(target, target, {
          headers: {
            'Content-Type': 'image/jpeg',
            'Cache-Control': CACHE_CONTROL,
          },
        });
        return;
      }
      if (!requestSucceeded || Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    } while (Date.now() <= deadline);

    if (attempt < 3 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError || new Error(`Persistent process did not create ${target}`);
}

async function imageInfo(client, key) {
  const result = await client.get(key, { process: 'image/info' });
  return JSON.parse(Buffer.from(result.content).toString('utf8'));
}

async function main() {
  const prefix = required('PHOTO_TEST_OSS_PREFIX').replace(/^\/+|\/+$/g, '');
  if (!prefix.toLowerCase().includes('test')) {
    throw new Error('PHOTO_TEST_OSS_PREFIX must contain "test" to prevent writes to production photo keys');
  }
  const publicBaseUrl = required('OSS_PHOTOWALL_BASE_URL').replace(/\/+$/, '');
  const client = new OSS({
    region: required('OSS_REGION'),
    bucket: required('OSS_BUCKET'),
    accessKeyId: required('OSS_ACCESS_KEY_ID'),
    accessKeySecret: required('OSS_ACCESS_KEY_SECRET'),
    endpoint: process.env.OSS_ENDPOINT?.trim() || undefined,
    secure: true,
    timeout: 60_000,
  });
  if (typeof client.processObjectSave !== 'function') {
    throw new Error('ali-oss runtime does not expose processObjectSave');
  }

  const runPrefix = `${prefix}/${crypto.randomUUID()}`;
  const originKey = `${runPrefix}/origin.jpg`;
  const mediumKey = `${runPrefix}/medium.jpg`;
  const tinyKey = `${runPrefix}/tiny.jpg`;
  const keys = [originKey, mediumKey, tinyKey];

  try {
    await client.put(originKey, TEST_JPEG, {
      headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': CACHE_CONTROL },
    });
    await persist(client, originKey, mediumKey, MEDIUM_PROCESS);
    await persist(client, originKey, tinyKey, TINY_PROCESS);

    const [mediumInfo, tinyInfo, mediumHead, tinyHead] = await Promise.all([
      imageInfo(client, mediumKey),
      imageInfo(client, tinyKey),
      client.head(mediumKey),
      client.head(tinyKey),
    ]);
    const mediumWidth = readNumber(mediumInfo, 'ImageWidth', 'Width');
    const mediumHeight = readNumber(mediumInfo, 'ImageHeight', 'Height');
    const tinyWidth = readNumber(tinyInfo, 'ImageWidth', 'Width');
    const tinyHeight = readNumber(tinyInfo, 'ImageHeight', 'Height');
    if (Math.max(mediumWidth, mediumHeight) > 800 || Math.max(tinyWidth, tinyHeight) > 50) {
      throw new Error(`Unexpected thumbnail sizes: medium=${mediumWidth}x${mediumHeight}, tiny=${tinyWidth}x${tinyHeight}`);
    }
    const mediumFormat = String(unwrap(mediumInfo.Format) || '').toLowerCase();
    const tinyFormat = String(unwrap(tinyInfo.Format) || '').toLowerCase();
    if (!['jpg', 'jpeg'].includes(mediumFormat) || !['jpg', 'jpeg'].includes(tinyFormat)) {
      throw new Error(`Unexpected thumbnail formats: medium=${mediumFormat}, tiny=${tinyFormat}`);
    }

    for (const [label, head] of [['medium', mediumHead], ['tiny', tinyHead]]) {
      const headers = head.res?.headers || {};
      if (headers['content-type'] !== 'image/jpeg') throw new Error(`${label} Content-Type is not image/jpeg`);
      if (headers['cache-control'] !== CACHE_CONTROL) throw new Error(`${label} Cache-Control is not immutable for one year`);
    }

    const publicUrls = keys.map(key => `${publicBaseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`);
    for (const publicUrl of publicUrls) {
      const publicResponse = await fetch(publicUrl, { method: 'HEAD' });
      if (!publicResponse.ok) throw new Error(`Public URL returned HTTP ${publicResponse.status}: ${publicUrl}`);
    }
    console.log(JSON.stringify({
      success: true,
      originKey,
      medium: `${mediumWidth}x${mediumHeight}`,
      tiny: `${tinyWidth}x${tinyHeight}`,
      publicUrls,
    }, null, 2));
  } finally {
    for (const key of keys.reverse()) {
      await client.delete(key).catch(() => {});
    }
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
