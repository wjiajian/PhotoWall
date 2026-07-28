import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const METADATA_FILE = process.env.PHOTO_METADATA_FILE
  ? path.resolve(process.env.PHOTO_METADATA_FILE)
  : path.join(PROJECT_ROOT, 'src', 'data', 'images-metadata.json');

async function atomicWrite(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function main() {
  let raw;
  try {
    raw = await fs.readFile(METADATA_FILE, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      console.log(`Metadata file does not exist, skip migration: ${METADATA_FILE}`);
      return;
    }
    throw error;
  }

  const records = JSON.parse(raw);
  if (!Array.isArray(records)) throw new TypeError('images-metadata.json root must be an array');

  let changed = 0;
  const migrated = records.map(record => {
    if (!record || typeof record !== 'object' || !/\.jpe?g$/i.test(record.filename || '')) return record;
    const originalSrc = typeof record.originalSrc === 'string' && record.originalSrc.trim()
      ? record.originalSrc
      : `/photowall/origin/${record.filename}`;
    if (record.src === originalSrc && record.originalSrc === originalSrc) return record;
    changed += 1;
    return { ...record, originalSrc, src: originalSrc };
  });

  if (changed === 0) {
    console.log('Metadata migration already applied; no changes needed.');
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = `${METADATA_FILE}.pre-medium-tiny-${timestamp}.bak`;
  await fs.copyFile(METADATA_FILE, backupFile);
  await atomicWrite(METADATA_FILE, migrated);
  console.log(`Migrated ${changed} JPEG metadata records.`);
  console.log(`Backup preserved at ${backupFile}`);
  console.log('Historical full objects were not deleted.');
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
