import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJpegHeader } from './helpers.js';

const mocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  assertAvailable: vi.fn(),
  reserveUpload: vi.fn(),
  releaseUploadReservation: vi.fn(),
  assertFilenameAvailable: vi.fn(),
  enqueue: vi.fn(),
  getJob: vi.fn(),
  isFilenameActive: vi.fn(),
  metadataRead: vi.fn(),
  metadataUpdate: vi.fn(),
  deleteObjectIgnoreNotFound: vi.fn(),
}));

vi.mock('../src/middleware/auth.js', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../src/services/photoMetadataStore.js', () => {
  class PhotoDataFileError extends Error {
    readonly statusCode = 503;
  }

  class PhotoMetadataStore {
    read = mocks.metadataRead;
    update = mocks.metadataUpdate;
  }

  return { PhotoDataFileError, PhotoMetadataStore };
});

vi.mock('../src/services/photoUploadQueue.js', () => {
  class PhotoUploadConflictError extends Error {
    readonly statusCode = 409;

    constructor(message = '同名照片已存在，请改名后重新上传') {
      super(message);
    }
  }

  class PhotoUploadQueue {
    initialize = mocks.initialize;
    assertAvailable = mocks.assertAvailable;
    reserveUpload = mocks.reserveUpload;
    releaseUploadReservation = mocks.releaseUploadReservation;
    assertFilenameAvailable = mocks.assertFilenameAvailable;
    enqueue = mocks.enqueue;
    getJob = mocks.getJob;
    isFilenameActive = mocks.isFilenameActive;
  }

  return { PhotoUploadConflictError, PhotoUploadQueue };
});

vi.mock('../src/services/photoMedia.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/photoMedia.js')>();
  return {
    ...actual,
    assertPhotoOssRuntimeSupport: vi.fn(),
    createPhotoOssClient: vi.fn(() => ({})),
    deleteObjectIgnoreNotFound: mocks.deleteObjectIgnoreNotFound,
  };
});

import photosRouter from '../src/routes/photos.js';
import { PhotoDataFileError } from '../src/services/photoMetadataStore.js';
import { PhotoUploadConflictError } from '../src/services/photoUploadQueue.js';

const app = express();
app.use(express.json());
app.use('/api/photos', photosRouter);

const completedJob = {
  jobId: 'job-1',
  status: 'completed' as const,
  total: 1,
  processed: 1,
  uploaded: [{ filename: 'photo.jpg', size: 100, src: '/photowall/origin/photo.jpg' }],
  failed: [],
  currentFilename: null,
  partial: false,
  message: '完成',
  createdAt: '2026-07-28T00:00:00.000Z',
  updatedAt: '2026-07-28T00:00:01.000Z',
  finishedAt: '2026-07-28T00:00:01.000Z',
};

beforeEach(() => {
  process.env.OSS_REGION = 'oss-test';
  process.env.OSS_BUCKET = 'photowall-test';
  process.env.OSS_ACCESS_KEY_ID = 'test-id';
  process.env.OSS_ACCESS_KEY_SECRET = 'test-secret';
  vi.clearAllMocks();
  mocks.assertAvailable.mockResolvedValue(undefined);
  mocks.reserveUpload.mockReturnValue('reservation-1');
  mocks.assertFilenameAvailable.mockResolvedValue(undefined);
  mocks.enqueue.mockImplementation(async file => {
    await fs.rm(file.tempPath, { force: true });
    return { ...completedJob, status: 'queued', processed: 0, uploaded: [], finishedAt: null };
  });
  mocks.getJob.mockReturnValue(completedJob);
  mocks.isFilenameActive.mockReturnValue(false);
  mocks.metadataRead.mockResolvedValue([]);
  mocks.deleteObjectIgnoreNotFound.mockResolvedValue(undefined);
});

describe('photos upload HTTP semantics', () => {
  it('keeps the successful upload response structure compatible', async () => {
    const response = await request(app)
      .post('/api/photos/upload')
      .attach('photos', createJpegHeader(6000, 4000), 'photo.jpg');

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      success: true,
      jobId: 'job-1',
      status: 'queued',
      total: 1,
      message: '完成',
    });
    expect(mocks.enqueue).toHaveBeenCalledOnce();
  });

  it('returns 415 for a non-JPEG filename', async () => {
    const response = await request(app)
      .post('/api/photos/upload')
      .attach('photos', Buffer.from('not-a-jpeg'), 'photo.png');
    expect(response.status).toBe(415);
  });

  it('returns 415 when the actual format is not JPEG', async () => {
    const pngHeader = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(pngHeader);
    pngHeader.writeUInt32BE(13, 8);
    pngHeader.write('IHDR', 12, 'ascii');
    pngHeader.writeUInt32BE(100, 16);
    pngHeader.writeUInt32BE(100, 20);
    const response = await request(app)
      .post('/api/photos/upload')
      .attach('photos', pngHeader, 'disguised.jpg');
    expect(response.status).toBe(415);
  });

  it('returns 413 above the configured 20MB limit', async () => {
    const response = await request(app)
      .post('/api/photos/upload')
      .attach('photos', Buffer.alloc(20 * 1024 * 1024 + 1), 'large.jpg');
    expect(response.status).toBe(413);
  });

  it('returns 422 for damaged or oversized-dimension JPEG files', async () => {
    const damaged = await request(app)
      .post('/api/photos/upload')
      .attach('photos', Buffer.from([0xff, 0xd8, 0xff]), 'damaged.jpg');
    expect(damaged.status).toBe(422);

    const oversized = await request(app)
      .post('/api/photos/upload')
      .attach('photos', createJpegHeader(10_000, 10_000), 'pixels.jpg');
    expect(oversized.status).toBe(422);
  });

  it('returns 409 for a duplicate filename', async () => {
    mocks.assertFilenameAvailable.mockRejectedValueOnce(new PhotoUploadConflictError());
    const response = await request(app)
      .post('/api/photos/upload')
      .attach('photos', createJpegHeader(100, 100), 'duplicate.jpg');
    expect(response.status).toBe(409);
  });

  it('returns 429 with Retry-After while another task is unfinished', async () => {
    mocks.reserveUpload.mockReturnValueOnce(null);
    const response = await request(app).post('/api/photos/upload');
    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('5');
  });

  it('returns 503 without consuming a body when metadata or job parsing is unavailable', async () => {
    mocks.assertAvailable.mockRejectedValueOnce(new PhotoDataFileError('数据损坏'));
    const response = await request(app).post('/api/photos/upload');
    expect(response.status).toBe(503);
    expect(response.body.error).toBe('数据损坏');
  });

  it('keeps the upload job success response compatible', async () => {
    const response = await request(app).get('/api/photos/upload-jobs/job-1');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, job: completedJob });
  });

  it('keeps historical full objects in the deletion cleanup set', async () => {
    const historical = {
      filename: 'legacy.HEIC',
      originalSrc: '/photowall/origin/legacy.HEIC',
      src: '/photowall/thumbnails/full/legacy.HEIC.jpg',
      srcMedium: '/photowall/thumbnails/medium/legacy.HEIC.jpg',
      srcTiny: '/photowall/thumbnails/tiny/legacy.HEIC.jpg',
    };
    mocks.metadataUpdate.mockImplementationOnce(async operation => {
      const result = await operation([historical]);
      return result.result;
    });

    const response = await request(app).delete('/api/photos/legacy.HEIC');
    expect(response.status).toBe(200);
    const deletedKeys = mocks.deleteObjectIgnoreNotFound.mock.calls.map(call => call[1]);
    expect(deletedKeys).toContain('photowall/thumbnails/full/legacy.HEIC.jpg');
    expect(deletedKeys).toContain('photowall/thumbnails/full/legacy.jpg');
    expect(deletedKeys).toContain('photowall/origin/legacy.HEIC');
  });
});
