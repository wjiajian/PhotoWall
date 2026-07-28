import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), '..');
const outputDirectory = path.join(projectRoot, 'dist-server');

if (path.basename(outputDirectory) !== 'dist-server' || path.dirname(outputDirectory) !== projectRoot) {
  throw new Error(`Refusing to clean unexpected server output path: ${outputDirectory}`);
}

await fs.rm(outputDirectory, { recursive: true, force: true });
