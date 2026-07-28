import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PHOTO_UPLOAD_MAX_BYTES,
  PhotoUploadValidationError,
  validateJpegUpload,
} from '../src/services/photoUploadValidation.js';
import { createJpegHeader, createTestDirectory } from './helpers.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function writeFixture(name: string, contents: Buffer): Promise<string> {
  const directory = await createTestDirectory('photowall-validation-');
  directories.push(directory);
  const filePath = path.join(directory, name);
  await fs.writeFile(filePath, contents);
  return filePath;
}

async function expectValidationStatus(
  operation: Promise<unknown>,
  statusCode: number,
): Promise<void> {
  await expect(operation).rejects.toMatchObject<Partial<PhotoUploadValidationError>>({ statusCode });
}

describe('validateJpegUpload', () => {
  it('reads JPEG dimensions from the file header without decoding the image', async () => {
    const tempPath = await writeFixture('photo.jpg', createJpegHeader(6000, 4000));
    await expect(validateJpegUpload({
      tempPath,
      filename: 'photo.jpg',
      size: 1024,
    })).resolves.toEqual({ width: 6000, height: 4000 });
  });

  it('returns 415 for a non-JPEG extension', async () => {
    const tempPath = await writeFixture('photo.png', createJpegHeader(100, 100));
    await expectValidationStatus(validateJpegUpload({ tempPath, filename: 'photo.png', size: 100 }), 415);
  });

  it('returns 415 when a PNG is disguised with a .jpg filename', async () => {
    const pngHeader = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(pngHeader, 0);
    pngHeader.writeUInt32BE(13, 8);
    pngHeader.write('IHDR', 12, 'ascii');
    pngHeader.writeUInt32BE(100, 16);
    pngHeader.writeUInt32BE(100, 20);
    const tempPath = await writeFixture('fake.jpg', pngHeader);
    await expectValidationStatus(validateJpegUpload({ tempPath, filename: 'fake.jpg', size: 100 }), 415);
  });

  it('returns 413 above the 20MB hard limit', async () => {
    const tempPath = await writeFixture('large.jpg', createJpegHeader(100, 100));
    await expectValidationStatus(validateJpegUpload({
      tempPath,
      filename: 'large.jpg',
      size: PHOTO_UPLOAD_MAX_BYTES + 1,
    }), 413);
  });

  it('returns 422 for excessive pixels or side length', async () => {
    const pixelsPath = await writeFixture('pixels.jpg', createJpegHeader(10_000, 10_000));
    await expectValidationStatus(validateJpegUpload({
      tempPath: pixelsPath,
      filename: 'pixels.jpg',
      size: 100,
    }), 422);

    const sidePath = await writeFixture('side.jpg', createJpegHeader(20_001, 100));
    await expectValidationStatus(validateJpegUpload({
      tempPath: sidePath,
      filename: 'side.jpg',
      size: 100,
    }), 422);
  });

  it('returns 422 for a damaged JPEG', async () => {
    const tempPath = await writeFixture('broken.jpg', Buffer.from([0xff, 0xd8, 0xff]));
    await expectValidationStatus(validateJpegUpload({ tempPath, filename: 'broken.jpg', size: 3 }), 422);
  });
});
