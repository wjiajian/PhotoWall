import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDirectory } from './helpers.js';

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe('migrate-oss-medium-tiny-metadata', () => {
  it('moves only JPEG src to originalSrc, preserves a backup, and is idempotent', async () => {
    const directory = await createTestDirectory('photowall-migration-');
    directories.push(directory);
    const metadataFile = path.join(directory, 'images-metadata.json');
    const records = [
      {
        filename: 'photo.jpg',
        originalSrc: '/photowall/origin/photo.jpg',
        src: '/photowall/thumbnails/full/photo.jpg.jpg',
      },
      {
        filename: 'legacy.HEIC',
        originalSrc: '/photowall/origin/legacy.HEIC',
        src: '/photowall/thumbnails/full/legacy.HEIC.jpg',
      },
    ];
    await fs.writeFile(metadataFile, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
    const script = path.resolve('scripts/migrate-oss-medium-tiny-metadata.mjs');

    await execFileAsync(process.execPath, [script], {
      env: { ...process.env, PHOTO_METADATA_FILE: metadataFile },
    });
    const migrated = JSON.parse(await fs.readFile(metadataFile, 'utf8')) as typeof records;
    expect(migrated[0].src).toBe(migrated[0].originalSrc);
    expect(migrated[1].src).toBe('/photowall/thumbnails/full/legacy.HEIC.jpg');

    const firstBackups = (await fs.readdir(directory)).filter(name => name.endsWith('.bak'));
    expect(firstBackups).toHaveLength(1);
    expect(JSON.parse(await fs.readFile(path.join(directory, firstBackups[0]), 'utf8'))).toEqual(records);

    await execFileAsync(process.execPath, [script], {
      env: { ...process.env, PHOTO_METADATA_FILE: metadataFile },
    });
    const secondBackups = (await fs.readdir(directory)).filter(name => name.endsWith('.bak'));
    expect(secondBackups).toEqual(firstBackups);
  });
});
