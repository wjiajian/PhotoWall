import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MEDIUM_IMAGE_PROCESS,
  TINY_IMAGE_PROCESS,
  buildOriginalObjectKey,
  buildUploadThumbnailObjectKeys,
  type PhotoOssConfig,
} from '../src/services/photoMedia.js';
import {
  PhotoDataFileError,
  PhotoMetadataStore,
  type PhotoMetadataRecord,
} from '../src/services/photoMetadataStore.js';
import {
  PhotoUploadConflictError,
  PhotoUploadQueue,
  type PersistedPhotoUploadJob,
  type PhotoUploadJobStage,
  type PhotoUploadTempFile,
} from '../src/services/photoUploadQueue.js';
import { createJpegHeader, createTestDirectory, FakePhotoOss } from './helpers.js';

const directories: string[] = [];
const ossConfig: PhotoOssConfig = {
  region: 'oss-test',
  bucket: 'photowall-test',
  accessKeyId: 'test-id',
  accessKeySecret: 'test-secret',
  endpoint: '',
  timeoutMs: 1000,
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const directory = await createTestDirectory('photowall-queue-');
  directories.push(directory);
  const tempDir = path.join(directory, 'uploads');
  const metadataFile = path.join(directory, 'images-metadata.json');
  const jobsFile = path.join(directory, 'photo-upload-jobs.json');
  await fs.mkdir(tempDir, { recursive: true });
  await fs.writeFile(metadataFile, '[]\n', 'utf8');
  const fake = new FakePhotoOss();
  const metadataStore = new PhotoMetadataStore(metadataFile);
  const queue = new PhotoUploadQueue({
    jobsFile,
    tempDir,
    metadataStore,
    getOssConfig: () => ossConfig,
    createClient: () => fake.client(),
    sleep: delay => new Promise(resolve => setTimeout(resolve, Math.min(delay, 1))),
    variantPollIntervalMs: 1,
    variantPollTimeoutMs: 20,
  });
  return { directory, tempDir, metadataFile, jobsFile, fake, metadataStore, queue };
}

async function createTempFile(tempDir: string, filename = 'photo.jpg'): Promise<PhotoUploadTempFile> {
  const tempPath = path.join(tempDir, `${filename}.upload`);
  const contents = createJpegHeader(6000, 4000);
  await fs.writeFile(tempPath, contents);
  return {
    tempPath,
    filename,
    originalName: filename,
    mimetype: 'image/jpeg',
    size: contents.length,
    width: 6000,
    height: 4000,
  };
}

async function enqueue(queue: PhotoUploadQueue, file: PhotoUploadTempFile) {
  await queue.initialize();
  await queue.assertAvailable();
  const reservation = queue.reserveUpload();
  expect(reservation).not.toBeNull();
  return queue.enqueue(file, reservation as string);
}

function matchingMetadata(filename: string): PhotoMetadataRecord {
  const originKey = buildOriginalObjectKey(filename);
  const thumbnails = buildUploadThumbnailObjectKeys(filename);
  return {
    filename,
    originalSrc: `/${originKey}`,
    src: `/${originKey}`,
    srcMedium: `/${thumbnails.mediumKey}`,
    srcTiny: `/${thumbnails.tinyKey}`,
    width: 6000,
    height: 4000,
    size: 100,
    format: 'JPEG',
  };
}

describe('PhotoUploadQueue', () => {
  it('streams the original, generates medium then tiny, and never creates full', async () => {
    const { tempDir, fake, metadataStore, queue } = await setup();
    const file = await createTempFile(tempDir);
    const submitted = await enqueue(queue, file);
    await queue.waitForIdle();

    const finished = queue.getJob(submitted.jobId);
    expect(finished?.status).toBe('completed');
    expect(fake.processCalls.map(call => call.process)).toEqual([
      MEDIUM_IMAGE_PROCESS,
      TINY_IMAGE_PROCESS,
    ]);

    const originKey = buildOriginalObjectKey(file.filename);
    const thumbnails = buildUploadThumbnailObjectKeys(file.filename);
    expect(fake.objects.has(originKey)).toBe(true);
    expect(fake.objects.has(thumbnails.mediumKey)).toBe(true);
    expect(fake.objects.has(thumbnails.tinyKey)).toBe(true);
    expect(fake.objects.has(thumbnails.fullKey)).toBe(false);
    await expect(fs.access(file.tempPath)).rejects.toMatchObject({ code: 'ENOENT' });

    const records = await metadataStore.read();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      filename: file.filename,
      src: `/${originKey}`,
      originalSrc: `/${originKey}`,
      srcMedium: `/${thumbnails.mediumKey}`,
      srcTiny: `/${thumbnails.tinyKey}`,
      width: 6000,
      height: 4000,
    });
  });

  it('allows only one unfinished task and rejects duplicate metadata or OSS keys', async () => {
    const { tempDir, fake, queue } = await setup();
    let releaseGate: (() => void) | undefined;
    fake.processGate = new Promise(resolve => {
      releaseGate = resolve;
    });
    const file = await createTempFile(tempDir, 'same.jpg');
    const submitted = await enqueue(queue, file);

    expect(queue.reserveUpload()).toBeNull();
    releaseGate?.();
    await queue.waitForIdle();
    expect(queue.getJob(submitted.jobId)?.status).toBe('completed');
    await expect(queue.assertFilenameAvailable('same.jpg'))
      .rejects.toBeInstanceOf(PhotoUploadConflictError);

    fake.objects.set(buildOriginalObjectKey('oss-only.jpg'), { body: Buffer.from('exists'), headers: {} });
    await expect(queue.assertFilenameAvailable('oss-only.jpg'))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('retries temporary OSS processing errors and succeeds', async () => {
    const { tempDir, fake, queue } = await setup();
    fake.failProcessAttempts = 2;
    const file = await createTempFile(tempDir, 'retry.jpg');
    const submitted = await enqueue(queue, file);
    await queue.waitForIdle();

    expect(queue.getJob(submitted.jobId)?.status).toBe('completed');
    expect(fake.processCalls.filter(call => call.target.endsWith('/retry.jpg.jpg'))).toHaveLength(4);
  });

  it('cleans only the failed task objects and preserves existing metadata', async () => {
    const { tempDir, metadataFile, fake, metadataStore, queue } = await setup();
    const existing = matchingMetadata('existing.jpg');
    await fs.writeFile(metadataFile, `${JSON.stringify([existing])}\n`, 'utf8');
    const file = await createTempFile(tempDir, 'failure.jpg');
    const thumbnails = buildUploadThumbnailObjectKeys(file.filename);
    fake.alwaysFailTarget = thumbnails.tinyKey;

    const submitted = await enqueue(queue, file);
    await queue.waitForIdle();

    expect(queue.getJob(submitted.jobId)?.status).toBe('failed');
    expect(fake.objects.has(buildOriginalObjectKey(file.filename))).toBe(false);
    expect(fake.objects.has(thumbnails.mediumKey)).toBe(false);
    expect(fake.objects.has(thumbnails.tinyKey)).toBe(false);
    expect(await metadataStore.read()).toEqual([existing]);
    await expect(fs.access(file.tempPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('disables uploads without deleting temp files when the job file is invalid', async () => {
    const { tempDir, jobsFile, queue } = await setup();
    const tempPath = path.join(tempDir, 'possibly-referenced.upload');
    await fs.writeFile(tempPath, 'keep', 'utf8');
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fs.utimes(tempPath, old, old);
    await fs.writeFile(jobsFile, '[]', 'utf8');

    await queue.initialize();
    await expect(queue.assertAvailable()).rejects.toBeInstanceOf(PhotoDataFileError);
    await expect(fs.access(tempPath)).resolves.toBeUndefined();
  });

  it('disables uploads when metadata parsing fails', async () => {
    const { metadataFile, queue } = await setup();
    await fs.writeFile(metadataFile, '{broken-json', 'utf8');
    await queue.initialize();
    await expect(queue.assertAvailable()).rejects.toBeInstanceOf(PhotoDataFileError);
  });

  it('does not delete objects belonging to conflicting metadata during recovery', async () => {
    const { tempDir, metadataFile, jobsFile, fake, metadataStore, queue } = await setup();
    const file = await createTempFile(tempDir, 'conflict.jpg');
    const originKey = buildOriginalObjectKey(file.filename);
    fake.objects.set(originKey, { body: Buffer.from('external'), headers: {} });
    const conflicting = {
      filename: file.filename,
      originalSrc: `/${originKey}`,
      src: '/photowall/thumbnails/full/conflict.jpg.jpg',
    };
    await fs.writeFile(metadataFile, `${JSON.stringify([conflicting])}\n`, 'utf8');
    const timestamp = '2026-07-28T02:30:00.000Z';
    const job: PersistedPhotoUploadJob = {
      jobId: 'job-conflict',
      status: 'processing',
      stage: 'queued',
      file,
      total: 1,
      processed: 0,
      uploaded: [],
      failed: [],
      currentFilename: file.filename,
      message: 'interrupted',
      createdAt: timestamp,
      updatedAt: timestamp,
      finishedAt: null,
    };
    await fs.writeFile(jobsFile, `${JSON.stringify({ version: 1, items: [job] }, null, 2)}\n`, 'utf8');

    await queue.initialize();
    await queue.waitForIdle();
    expect(queue.getJob(job.jobId)?.status).toBe('failed');
    expect(fake.objects.has(originKey)).toBe(true);
    expect(await metadataStore.read()).toEqual([conflicting]);
  });

  it('cleans only unreferenced temp files older than 24 hours at startup', async () => {
    const { tempDir, jobsFile, fake, queue } = await setup();
    const referencedFile = await createTempFile(tempDir, 'referenced.jpg');
    const oldOrphan = path.join(tempDir, 'old-orphan.upload');
    const freshOrphan = path.join(tempDir, 'fresh-orphan.upload');
    await fs.writeFile(oldOrphan, 'old', 'utf8');
    await fs.writeFile(freshOrphan, 'fresh', 'utf8');
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await Promise.all([
      fs.utimes(referencedFile.tempPath, old, old),
      fs.utimes(oldOrphan, old, old),
    ]);
    const timestamp = '2026-07-28T02:30:00.000Z';
    const job: PersistedPhotoUploadJob = {
      jobId: 'job-temp-cleanup',
      status: 'queued',
      stage: 'queued',
      file: referencedFile,
      total: 1,
      processed: 0,
      uploaded: [],
      failed: [],
      currentFilename: null,
      message: 'queued',
      createdAt: timestamp,
      updatedAt: timestamp,
      finishedAt: null,
    };
    await fs.writeFile(jobsFile, `${JSON.stringify({ version: 1, items: [job] }, null, 2)}\n`, 'utf8');
    let releaseGate: (() => void) | undefined;
    fake.processGate = new Promise(resolve => {
      releaseGate = resolve;
    });

    await queue.initialize();
    await expect(fs.access(oldOrphan)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(freshOrphan)).resolves.toBeUndefined();
    await expect(fs.access(referencedFile.tempPath)).resolves.toBeUndefined();

    releaseGate?.();
    await queue.waitForIdle();
    await expect(fs.access(referencedFile.tempPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

const recoveryStages: Array<{
  stage: PhotoUploadJobStage;
  expectedProcessCalls: number;
}> = [
  { stage: 'queued', expectedProcessCalls: 2 },
  { stage: 'original-uploaded', expectedProcessCalls: 2 },
  { stage: 'medium-completed', expectedProcessCalls: 1 },
  { stage: 'tiny-completed', expectedProcessCalls: 0 },
  { stage: 'metadata-committed', expectedProcessCalls: 0 },
];

describe.each(recoveryStages)('restart recovery at $stage', ({ stage, expectedProcessCalls }) => {
  it('continues idempotently and publishes metadata exactly once', async () => {
    const { tempDir, metadataFile, jobsFile, fake, metadataStore, queue } = await setup();
    const file = await createTempFile(tempDir, `recover-${stage}.jpg`);
    const originKey = buildOriginalObjectKey(file.filename);
    const thumbnails = buildUploadThumbnailObjectKeys(file.filename);
    const rank = recoveryStages.findIndex(item => item.stage === stage);

    if (rank >= 1) fake.objects.set(originKey, { body: Buffer.from('origin'), headers: {} });
    if (rank >= 2) fake.objects.set(thumbnails.mediumKey, { body: Buffer.from('medium'), headers: {} });
    if (rank >= 3) fake.objects.set(thumbnails.tinyKey, { body: Buffer.from('tiny'), headers: {} });
    if (stage === 'metadata-committed') {
      await fs.writeFile(metadataFile, `${JSON.stringify([matchingMetadata(file.filename)])}\n`, 'utf8');
    }

    const timestamp = '2026-07-28T02:30:00.000Z';
    const persistedJob: PersistedPhotoUploadJob = {
      jobId: `job-${stage}`,
      status: 'processing',
      stage,
      file,
      total: 1,
      processed: 0,
      uploaded: [],
      failed: [],
      currentFilename: file.filename,
      message: 'interrupted',
      createdAt: timestamp,
      updatedAt: timestamp,
      finishedAt: null,
    };
    await fs.writeFile(jobsFile, `${JSON.stringify({ version: 1, items: [persistedJob] }, null, 2)}\n`, 'utf8');

    await queue.initialize();
    await queue.waitForIdle();

    expect(queue.getJob(persistedJob.jobId)?.status).toBe('completed');
    expect(fake.processCalls).toHaveLength(expectedProcessCalls);
    const records = await metadataStore.read();
    expect(records.filter(record => record.filename === file.filename)).toHaveLength(1);
    expect(fake.objects.has(originKey)).toBe(true);
    expect(fake.objects.has(thumbnails.mediumKey)).toBe(true);
    expect(fake.objects.has(thumbnails.tinyKey)).toBe(true);
    await expect(fs.access(file.tempPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
