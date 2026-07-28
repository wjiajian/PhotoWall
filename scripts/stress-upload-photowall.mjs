import fs from 'node:fs/promises';
import { openAsBlob } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { imageSizeFromFile } from 'image-size/fromFile';

const execFileAsync = promisify(execFile);
const REQUIRED_CONFIRMATION = 'UPLOAD_100_TEST_PHOTOS';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function positiveNumber(name, fallback) {
  const parsed = Number(process.env[name] || fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(delayMs) {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

async function readJsonResponse(response) {
  const raw = await response.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { error: raw || `HTTP ${response.status}` };
  }
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.retryAfter = response.headers.get('retry-after');
    throw error;
  }
  return data;
}

async function login(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await readJsonResponse(response);
  if (!data.token) throw new Error('Login succeeded without a token');
  return data.token;
}

async function listAndValidateFiles(inputDirectory, count, minBytes, minPixels) {
  const entries = await fs.readdir(inputDirectory, { withFileTypes: true });
  const filenames = entries
    .filter(entry => entry.isFile() && /\.jpe?g$/i.test(entry.name))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  if (filenames.length < count) {
    throw new Error(`Expected at least ${count} JPEG files in ${inputDirectory}, found ${filenames.length}`);
  }

  const files = [];
  for (const filename of filenames.slice(0, count)) {
    const filePath = path.join(inputDirectory, filename);
    const [stat, dimensions] = await Promise.all([
      fs.stat(filePath),
      imageSizeFromFile(filePath),
    ]);
    const pixels = dimensions.width * dimensions.height;
    if (dimensions.type !== 'jpg') throw new Error(`${filename} is not an actual JPEG`);
    if (stat.size < minBytes || stat.size > 20 * 1024 * 1024) {
      throw new Error(`${filename} must be between ${Math.round(minBytes / 1024 / 1024)}MB and 20MB`);
    }
    if (pixels < minPixels || pixels > 60_000_000) {
      throw new Error(`${filename} must be between ${Math.round(minPixels / 1_000_000)}MP and 60MP`);
    }
    if (dimensions.width > 20_000 || dimensions.height > 20_000) {
      throw new Error(`${filename} exceeds the 20000px side limit`);
    }
    files.push({ filePath, filename, size: stat.size, width: dimensions.width, height: dimensions.height });
  }
  return files;
}

async function submitUpload(baseUrl, token, file, uploadName) {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const formData = new FormData();
    formData.append('photos', await openAsBlob(file.filePath, { type: 'image/jpeg' }), uploadName);
    const response = await fetch(`${baseUrl}/api/photos/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    if (response.status === 429) {
      const retrySeconds = Math.max(1, Number(response.headers.get('retry-after') || 5));
      await response.body?.cancel();
      await sleep(retrySeconds * 1000);
      continue;
    }
    const data = await readJsonResponse(response);
    if (!data.jobId) throw new Error(`Upload response for ${uploadName} did not contain jobId`);
    return data.jobId;
  }
  throw new Error(`Upload queue stayed busy for too long: ${uploadName}`);
}

async function waitForJob(baseUrl, token, jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/photos/upload-jobs/${encodeURIComponent(jobId)}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    const data = await readJsonResponse(response);
    const job = data.job;
    if (job?.status === 'completed') return job;
    if (job?.status === 'failed') {
      throw new Error(job.message || `Upload job failed: ${jobId}`);
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for upload job ${jobId}`);
}

async function checkHttpUrls(urls) {
  for (const url of urls) {
    const response = await fetch(url, { method: 'GET', redirect: 'follow', cache: 'no-store' });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Health URL returned HTTP ${response.status}: ${url}`);
  }
}

async function checkTcp(host, port, timeoutMs = 5000) {
  if (!host) return;
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`TCP health check timed out: ${host}:${port}`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.once('error', error => {
      clearTimeout(timer);
      reject(new Error(`TCP health check failed for ${host}:${port}: ${error.message}`));
    });
  });
}

function parseMemoryToMb(value) {
  const match = value.trim().match(/^([\d.]+)\s*(B|KiB|MiB|GiB|KB|MB|GB)$/i);
  if (!match) throw new Error(`Cannot parse Docker memory value: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === 'b') return amount / 1024 / 1024;
  if (unit === 'kib' || unit === 'kb') return amount / 1024;
  if (unit === 'gib' || unit === 'gb') return amount * 1024;
  return amount;
}

async function sampleContainerMemory(containerName) {
  if (!containerName) return null;
  const { stdout } = await execFileAsync('docker', [
    'stats',
    '--no-stream',
    '--format',
    '{{.MemUsage}}',
    containerName,
  ]);
  const used = stdout.trim().split('/')[0]?.trim();
  return used ? parseMemoryToMb(used) : null;
}

async function readContainerState(containerName) {
  if (!containerName) return null;
  const { stdout } = await execFileAsync('docker', [
    'inspect',
    '--format',
    '{{.RestartCount}} {{.State.OOMKilled}}',
    containerName,
  ]);
  const [restartCountRaw, oomKilledRaw] = stdout.trim().split(/\s+/);
  return {
    restartCount: Number(restartCountRaw),
    oomKilled: oomKilledRaw === 'true',
  };
}

async function assertContainerHealthy(containerName, baselineRestartCount) {
  const state = await readContainerState(containerName);
  if (!state) return;
  if (state.oomKilled) throw new Error(`Container ${containerName} was OOM-killed`);
  if (state.restartCount > baselineRestartCount) {
    throw new Error(`Container ${containerName} restarted during the stress test`);
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function assertMemoryTrend(samples, maxGrowthMb) {
  if (samples.length < 30) return null;
  const early = median(samples.slice(10, 20));
  const late = median(samples.slice(-10));
  const growth = late - early;
  if (growth > maxGrowthMb) {
    throw new Error(`Container memory grew ${growth.toFixed(1)}MB from warm baseline; limit is ${maxGrowthMb}MB`);
  }
  return { earlyMedianMb: early, lateMedianMb: late, growthMb: growth, peakMb: Math.max(...samples) };
}

async function deleteUploadedPhoto(baseUrl, token, filename) {
  const response = await fetch(`${baseUrl}/api/photos/${encodeURIComponent(filename)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  await readJsonResponse(response);
}

async function main() {
  if (process.env.PHOTO_STRESS_CONFIRM !== REQUIRED_CONFIRMATION) {
    throw new Error(`Set PHOTO_STRESS_CONFIRM=${REQUIRED_CONFIRMATION} to authorize the stress upload`);
  }
  const baseUrl = required('PHOTO_STRESS_BASE_URL').replace(/\/+$/, '');
  const inputDirectory = path.resolve(required('PHOTO_STRESS_INPUT_DIR'));
  const username = required('ADMIN_USERNAME');
  const password = required('ADMIN_PASSWORD');
  const count = Math.floor(positiveNumber('PHOTO_STRESS_COUNT', 100));
  const minBytes = positiveNumber('PHOTO_STRESS_MIN_MB', 18) * 1024 * 1024;
  const minPixels = positiveNumber('PHOTO_STRESS_MIN_MEGAPIXELS', 45) * 1_000_000;
  const jobTimeoutMs = positiveNumber('PHOTO_STRESS_JOB_TIMEOUT_MS', 10 * 60_000);
  const maxGrowthMb = positiveNumber('PHOTO_STRESS_MAX_GROWTH_MB', 96);
  const containerName = process.env.PHOTO_STRESS_CONTAINER?.trim() || '';
  const sshHost = process.env.PHOTO_STRESS_SSH_HOST?.trim() || '';
  const sshPort = Math.floor(positiveNumber('PHOTO_STRESS_SSH_PORT', 22));
  const healthUrls = (process.env.PHOTO_STRESS_HEALTH_URLS || `${baseUrl}/,${baseUrl}/api/photos/metadata`)
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const keepUploads = process.env.PHOTO_STRESS_KEEP_UPLOADS === '1';

  const files = await listAndValidateFiles(inputDirectory, count, minBytes, minPixels);
  const token = await login(baseUrl, username, password);
  const runId = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const uploadedNames = [];
  const memorySamples = [];
  const startedAt = Date.now();
  const initialContainerState = await readContainerState(containerName);
  const baselineRestartCount = initialContainerState?.restartCount ?? 0;

  try {
    await checkHttpUrls(healthUrls);
    await checkTcp(sshHost, sshPort);
    await assertContainerHealthy(containerName, baselineRestartCount);

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const extension = path.extname(file.filename).toLowerCase();
      const stem = path.basename(file.filename, extension).replace(/[^a-zA-Z0-9._-]+/g, '-');
      const uploadName = `stress-${runId}-${String(index + 1).padStart(3, '0')}-${stem}${extension}`;
      const jobId = await submitUpload(baseUrl, token, file, uploadName);
      await waitForJob(baseUrl, token, jobId, jobTimeoutMs);
      uploadedNames.push(uploadName);

      await checkHttpUrls(healthUrls);
      await checkTcp(sshHost, sshPort);
      await assertContainerHealthy(containerName, baselineRestartCount);
      const memoryMb = await sampleContainerMemory(containerName);
      if (memoryMb !== null) memorySamples.push(memoryMb);

      console.log(JSON.stringify({
        progress: `${index + 1}/${files.length}`,
        uploadName,
        source: `${file.width}x${file.height}, ${(file.size / 1024 / 1024).toFixed(1)}MB`,
        memoryMb: memoryMb === null ? undefined : Number(memoryMb.toFixed(1)),
      }));
    }

    await assertContainerHealthy(containerName, baselineRestartCount);
    const memoryTrend = assertMemoryTrend(memorySamples, maxGrowthMb);
    console.log(JSON.stringify({
      success: true,
      uploaded: uploadedNames.length,
      elapsedMinutes: Number(((Date.now() - startedAt) / 60_000).toFixed(2)),
      healthUrls,
      sshEndpoint: sshHost ? `${sshHost}:${sshPort}` : undefined,
      containerRestartCount: initialContainerState?.restartCount,
      memoryTrend,
      cleanupPending: !keepUploads,
    }, null, 2));
  } finally {
    if (!keepUploads && uploadedNames.length > 0) {
      console.log(`Cleaning up ${uploadedNames.length} stress-test photos...`);
      for (const filename of uploadedNames.reverse()) {
        await deleteUploadedPhoto(baseUrl, token, filename).catch(error => {
          console.error(`Cleanup failed for ${filename}: ${error.message}`);
        });
      }
    }
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
