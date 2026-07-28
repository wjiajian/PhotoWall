import { describe, expect, it } from 'vitest';
import {
  PHOTO_CACHE_CONTROL,
  ensurePersistentJpegVariant,
} from '../src/services/photoMedia.js';
import { FakePhotoOss } from './helpers.js';

describe('ensurePersistentJpegVariant', () => {
  it('retries a temporary OSS failure up to three requests and replaces headers', async () => {
    const fake = new FakePhotoOss();
    fake.objects.set('source.jpg', { body: Buffer.from('source'), headers: {} });
    fake.failProcessAttempts = 2;

    await ensurePersistentJpegVariant(
      fake.client(),
      'source.jpg',
      'target.jpg',
      'image/resize,m_lfit,w_800,h_800,limit_1/quality,q_80/format,jpg',
      1000,
      { pollIntervalMs: 1, pollTimeoutMs: 50, sleep: async () => {} },
    );

    expect(fake.processCalls).toHaveLength(3);
    expect(fake.copyCalls).toHaveLength(1);
    expect(fake.objects.get('target.jpg')?.headers).toEqual({
      'Content-Type': 'image/jpeg',
      'Cache-Control': PHOTO_CACHE_CONTROL,
    });
  });

  it('does not request processing again when the persisted object already exists', async () => {
    const fake = new FakePhotoOss();
    fake.objects.set('target.jpg', { body: Buffer.from('target'), headers: {} });
    await ensurePersistentJpegVariant(fake.client(), 'source.jpg', 'target.jpg', 'process', 1000);
    expect(fake.processCalls).toHaveLength(0);
    expect(fake.copyCalls).toHaveLength(1);
  });
});
