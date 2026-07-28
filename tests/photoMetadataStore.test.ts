import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AtomicVersionedJsonStore,
  PhotoDataFileError,
  PhotoMetadataStore,
  type PhotoMetadataRecord,
} from '../src/services/photoMetadataStore.js';
import { createTestDirectory } from './helpers.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

function record(filename: string): PhotoMetadataRecord {
  return { filename, src: `/photowall/origin/${filename}` };
}

describe('PhotoMetadataStore', () => {
  it('serializes upload, visibility and deletion updates without losing metadata', async () => {
    const directory = await createTestDirectory('photowall-metadata-');
    directories.push(directory);
    const filePath = path.join(directory, 'images-metadata.json');
    await fs.writeFile(filePath, JSON.stringify([record('a.jpg'), record('b.jpg')]), 'utf8');
    const store = new PhotoMetadataStore(filePath);

    await Promise.all([
      store.update(async records => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return { records: [...records, record('c.jpg')], result: undefined };
      }),
      store.update(records => ({
        records: records.map(item => item.filename === 'a.jpg' ? { ...item, isVisible: false } : item),
        result: undefined,
      })),
      store.update(records => ({
        records: records.filter(item => item.filename !== 'b.jpg'),
        result: undefined,
      })),
    ]);

    const finalRecords = await store.read();
    expect(finalRecords.map(item => item.filename).sort()).toEqual(['a.jpg', 'c.jpg']);
    expect(finalRecords.find(item => item.filename === 'a.jpg')?.isVisible).toBe(false);
  });

  it('refuses to overwrite invalid metadata', async () => {
    const directory = await createTestDirectory('photowall-metadata-corrupt-');
    directories.push(directory);
    const filePath = path.join(directory, 'images-metadata.json');
    const invalid = '{not-json';
    await fs.writeFile(filePath, invalid, 'utf8');
    const store = new PhotoMetadataStore(filePath);

    await expect(store.update(records => ({ records, result: undefined })))
      .rejects.toBeInstanceOf(PhotoDataFileError);
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(invalid);
  });

  it('refuses to overwrite an invalid upload job file', async () => {
    const directory = await createTestDirectory('photowall-jobs-corrupt-');
    directories.push(directory);
    const filePath = path.join(directory, 'photo-upload-jobs.json');
    const invalid = '[]';
    await fs.writeFile(filePath, invalid, 'utf8');
    const store = new AtomicVersionedJsonStore<unknown>(filePath, '照片上传任务文件');

    await expect(store.write([])).rejects.toBeInstanceOf(PhotoDataFileError);
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(invalid);
  });
});
