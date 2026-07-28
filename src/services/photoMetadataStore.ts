import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export interface PhotoMetadataRecord {
  driveItemId?: string;
  filename: string;
  originalSrc?: string;
  src: string;
  srcMedium?: string;
  srcTiny?: string;
  width?: number;
  height?: number;
  size?: number;
  format?: string;
  date?: string;
  videoSrc?: string;
  isVisible?: boolean;
  visibilityUpdatedAt?: string | null;
}

export class PhotoDataFileError extends Error {
  readonly statusCode = 503;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PhotoDataFileError';
  }
}

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    let release: (() => void) | undefined;
    const previous = this.tail;
    this.tail = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;

    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  await fs.mkdir(directory, { recursive: true });

  try {
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function sortMetadata(records: PhotoMetadataRecord[]): PhotoMetadataRecord[] {
  return [...records].sort((a, b) => {
    if (a.date && b.date) return b.date.localeCompare(a.date);
    return a.filename.localeCompare(b.filename, 'zh-CN');
  });
}

export class PhotoMetadataStore {
  private readonly mutex = new AsyncMutex();
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private async readUnlocked(): Promise<PhotoMetadataRecord[]> {
    let content: string;
    try {
      content = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return [];
      throw new PhotoDataFileError('读取照片元数据失败，上传服务已暂停', { cause: error });
    }

    try {
      const parsed = JSON.parse(content) as unknown;
      if (!Array.isArray(parsed)) {
        throw new TypeError('metadata root must be an array');
      }
      return parsed as PhotoMetadataRecord[];
    } catch (error) {
      throw new PhotoDataFileError('照片元数据文件损坏，上传服务已暂停', { cause: error });
    }
  }

  async read(): Promise<PhotoMetadataRecord[]> {
    return this.mutex.runExclusive(async () => this.readUnlocked());
  }

  async update<T>(
    operation: (records: PhotoMetadataRecord[]) => Promise<{ records: PhotoMetadataRecord[]; result: T }> | { records: PhotoMetadataRecord[]; result: T },
  ): Promise<T> {
    return this.mutex.runExclusive(async () => {
      const current = await this.readUnlocked();
      const { records, result } = await operation([...current]);
      await atomicWriteJson(this.filePath, sortMetadata(records));
      return result;
    });
  }
}

export interface VersionedJsonFile<T> {
  version: number;
  items: T[];
}

export class AtomicVersionedJsonStore<T> {
  private readonly mutex = new AsyncMutex();
  readonly filePath: string;
  private readonly label: string;
  private readonly validateItem: (value: unknown) => T;

  constructor(filePath: string, label: string, validateItem?: (value: unknown) => T) {
    this.filePath = filePath;
    this.label = label;
    this.validateItem = validateItem ?? ((value: unknown) => value as T);
  }

  private async readUnlocked(): Promise<VersionedJsonFile<T>> {
    let content: string;
    try {
      content = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        return { version: 1, items: [] };
      }
      throw new PhotoDataFileError(`读取${this.label}失败，上传服务已暂停`, { cause: error });
    }

    try {
      const parsed = JSON.parse(content) as Partial<VersionedJsonFile<T>>;
      if (parsed.version !== 1 || !Array.isArray(parsed.items)) {
        throw new TypeError('unsupported or invalid versioned JSON file');
      }
      return { version: 1, items: parsed.items.map(item => this.validateItem(item)) };
    } catch (error) {
      throw new PhotoDataFileError(`${this.label}损坏，上传服务已暂停`, { cause: error });
    }
  }

  async read(): Promise<VersionedJsonFile<T>> {
    return this.mutex.runExclusive(async () => this.readUnlocked());
  }

  async write(items: T[]): Promise<void> {
    await this.mutex.runExclusive(async () => {
      // Validate the current on-disk file before replacing it. If an operator or
      // partial external write corrupted the file, preserve it for recovery.
      await this.readUnlocked();
      const validatedItems = items.map(item => this.validateItem(item));
      await atomicWriteJson(this.filePath, { version: 1, items: validatedItems });
    });
  }
}
