import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  MEDIUM_IMAGE_PROCESS,
  TINY_IMAGE_PROCESS,
  buildOriginalObjectKey,
  buildUploadThumbnailObjectKeys,
  createPhotoOssClient,
  deleteObjectIgnoreNotFound,
  ensurePersistentJpegVariant,
  objectExists,
  putOriginalJpeg,
  readOssPhotoDate,
  type PhotoOssClient,
  type PhotoOssConfig,
} from './photoMedia.js';
import {
  AtomicVersionedJsonStore,
  PhotoDataFileError,
  PhotoMetadataStore,
  type PhotoMetadataRecord,
} from './photoMetadataStore.js';

export interface PhotoUploadTempFile {
  tempPath: string;
  filename: string;
  originalName: string;
  mimetype: string;
  size: number;
  width: number;
  height: number;
}

export type PhotoUploadJobStatus = 'queued' | 'processing' | 'completed' | 'failed';
export type PhotoUploadJobStage =
  | 'queued'
  | 'original-uploaded'
  | 'medium-completed'
  | 'tiny-completed'
  | 'metadata-committed';

export interface PhotoUploadResultItem {
  filename: string;
  size?: number;
  src?: string;
  error?: string;
}

export interface PhotoUploadJobSnapshot {
  jobId: string;
  status: PhotoUploadJobStatus;
  total: number;
  processed: number;
  uploaded: PhotoUploadResultItem[];
  failed: PhotoUploadResultItem[];
  currentFilename: string | null;
  partial: boolean;
  message: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface PersistedPhotoUploadJob {
  jobId: string;
  status: PhotoUploadJobStatus;
  stage: PhotoUploadJobStage;
  file: PhotoUploadTempFile;
  total: 1;
  processed: number;
  uploaded: PhotoUploadResultItem[];
  failed: PhotoUploadResultItem[];
  currentFilename: string | null;
  message: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export class PhotoUploadConflictError extends Error {
  readonly statusCode = 409;

  constructor(message = '同名照片已存在，请改名后重新上传') {
    super(message);
    this.name = 'PhotoUploadConflictError';
  }
}

export interface PhotoUploadQueueOptions {
  jobsFile: string;
  tempDir: string;
  metadataStore: PhotoMetadataStore;
  getOssConfig: () => PhotoOssConfig;
  createClient?: (config: PhotoOssConfig) => PhotoOssClient;
  now?: () => Date;
  sleep?: (delayMs: number) => Promise<void>;
  variantPollIntervalMs?: number;
  variantPollTimeoutMs?: number;
}

const JOB_TTL_MS = 24 * 60 * 60 * 1000;
const TEMP_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const VALID_STATUSES = new Set<PhotoUploadJobStatus>(['queued', 'processing', 'completed', 'failed']);
const VALID_STAGES = new Set<PhotoUploadJobStage>([
  'queued',
  'original-uploaded',
  'medium-completed',
  'tiny-completed',
  'metadata-committed',
]);

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, delayMs);
  });
}

function snapshot(job: PersistedPhotoUploadJob): PhotoUploadJobSnapshot {
  return {
    jobId: job.jobId,
    status: job.status,
    total: job.total,
    processed: job.processed,
    uploaded: job.uploaded,
    failed: job.failed,
    currentFilename: job.currentFilename,
    partial: job.uploaded.length > 0 && job.failed.length > 0,
    message: job.message,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
  };
}

function isFinished(job: PersistedPhotoUploadJob): boolean {
  return job.status === 'completed' || job.status === 'failed';
}

function validatePersistedJob(value: unknown): PersistedPhotoUploadJob {
  const job = value as Partial<PersistedPhotoUploadJob>;
  const file = job.file as Partial<PhotoUploadTempFile> | undefined;
  const valid = typeof job.jobId === 'string'
    && VALID_STATUSES.has(job.status as PhotoUploadJobStatus)
    && VALID_STAGES.has(job.stage as PhotoUploadJobStage)
    && job.total === 1
    && Number.isInteger(job.processed)
    && Array.isArray(job.uploaded)
    && Array.isArray(job.failed)
    && (typeof job.currentFilename === 'string' || job.currentFilename === null)
    && typeof job.message === 'string'
    && typeof job.createdAt === 'string'
    && typeof job.updatedAt === 'string'
    && (typeof job.finishedAt === 'string' || job.finishedAt === null)
    && file !== undefined
    && typeof file.tempPath === 'string'
    && typeof file.filename === 'string'
    && typeof file.originalName === 'string'
    && typeof file.mimetype === 'string'
    && typeof file.size === 'number'
    && typeof file.width === 'number'
    && typeof file.height === 'number';

  if (!valid) {
    throw new PhotoDataFileError('上传任务文件包含无效记录，上传服务已暂停');
  }
  return value as PersistedPhotoUploadJob;
}

function formatDate(input: string): string {
  const date = new Date(input);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}:${pad(date.getMonth() + 1)}:${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function metadataMatchesJob(record: PhotoMetadataRecord, job: PersistedPhotoUploadJob): boolean {
  const originKey = buildOriginalObjectKey(job.file.filename);
  const thumbnails = buildUploadThumbnailObjectKeys(job.file.filename);
  return record.filename === job.file.filename
    && record.src === `/${originKey}`
    && record.originalSrc === `/${originKey}`
    && record.srcMedium === `/${thumbnails.mediumKey}`
    && record.srcTiny === `/${thumbnails.tinyKey}`;
}

async function removeFileIgnoreNotFound(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }
}

export class PhotoUploadQueue {
  private readonly options: PhotoUploadQueueOptions;
  private readonly jobStore: AtomicVersionedJsonStore<PersistedPhotoUploadJob>;
  private readonly jobs = new Map<string, PersistedPhotoUploadJob>();
  private readonly queue: string[] = [];
  private readonly createClient: (config: PhotoOssConfig) => PhotoOssClient;
  private readonly now: () => Date;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private initialized = false;
  private processing = false;
  private reservation: string | null = null;
  private unavailableError: PhotoDataFileError | null = null;

  constructor(options: PhotoUploadQueueOptions) {
    this.options = options;
    this.jobStore = new AtomicVersionedJsonStore<PersistedPhotoUploadJob>(
      options.jobsFile,
      '照片上传任务文件',
      value => {
        const job = validatePersistedJob(value);
        const relativePath = path.relative(
          path.resolve(options.tempDir),
          path.resolve(job.file.tempPath),
        );
        if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
          throw new PhotoDataFileError('上传任务引用了临时目录外的文件，上传服务已暂停');
        }
        return job;
      },
    );
    this.createClient = options.createClient ?? createPhotoOssClient;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? defaultSleep;
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private sortedJobs(): PersistedPhotoUploadJob[] {
    return Array.from(this.jobs.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private async persistJobs(): Promise<void> {
    try {
      await this.jobStore.write(this.sortedJobs());
    } catch (error) {
      const wrapped = error instanceof PhotoDataFileError
        ? error
        : new PhotoDataFileError('写入照片上传任务文件失败，上传服务已暂停', { cause: error });
      this.unavailableError = wrapped;
      throw wrapped;
    }
  }

  private async persistStage(
    job: PersistedPhotoUploadJob,
    stage: PhotoUploadJobStage,
    message: string,
  ): Promise<void> {
    job.stage = stage;
    job.message = message;
    job.updatedAt = this.nowIso();
    await this.persistJobs();
  }

  private hasUnfinishedJob(): boolean {
    return Array.from(this.jobs.values()).some(job => !isFinished(job));
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    try {
      const persisted = await this.jobStore.read();
      await this.options.metadataStore.read();

      for (const rawJob of persisted.items) {
        const job = rawJob;
        this.jobs.set(job.jobId, job);
      }
      if (Array.from(this.jobs.values()).filter(job => !isFinished(job)).length > 1) {
        throw new PhotoDataFileError('上传任务文件包含多个未完成任务，上传服务已暂停');
      }

      const cutoff = this.now().getTime() - JOB_TTL_MS;
      let changed = false;
      for (const [jobId, job] of this.jobs.entries()) {
        if (isFinished(job) && job.finishedAt && new Date(job.finishedAt).getTime() < cutoff) {
          this.jobs.delete(jobId);
          changed = true;
          continue;
        }
        if (!isFinished(job)) {
          job.status = 'queued';
          job.processed = 0;
          job.currentFilename = null;
          job.message = '服务重启，等待恢复上传任务';
          job.updatedAt = this.nowIso();
          this.queue.push(job.jobId);
          changed = true;
        }
      }

      if (changed) await this.persistJobs();
      await this.cleanupUnreferencedTempFiles();
      void this.processQueue();
    } catch (error) {
      this.unavailableError = error instanceof PhotoDataFileError
        ? error
        : new PhotoDataFileError('初始化照片上传任务失败，上传服务已暂停', { cause: error });
      console.error('[photoUploadQueue]', this.unavailableError.message, error);
    }
  }

  async assertAvailable(): Promise<void> {
    if (!this.initialized) await this.initialize();
    if (this.unavailableError) throw this.unavailableError;

    try {
      await Promise.all([
        this.options.metadataStore.read(),
        this.jobStore.read(),
      ]);
    } catch (error) {
      this.unavailableError = error instanceof PhotoDataFileError
        ? error
        : new PhotoDataFileError('照片数据文件不可用，上传服务已暂停', { cause: error });
      throw this.unavailableError;
    }
  }

  reserveUpload(): string | null {
    if (!this.initialized || this.unavailableError) {
      throw this.unavailableError ?? new PhotoDataFileError('照片上传服务尚未初始化');
    }
    if (this.reservation || this.hasUnfinishedJob()) return null;
    this.reservation = crypto.randomUUID();
    return this.reservation;
  }

  releaseUploadReservation(reservation: string): void {
    if (this.reservation === reservation) this.reservation = null;
  }

  async assertFilenameAvailable(filename: string): Promise<void> {
    const records = await this.options.metadataStore.read();
    if (records.some(record => record.filename === filename)) {
      throw new PhotoUploadConflictError();
    }

    const config = this.options.getOssConfig();
    const client = this.createClient(config);
    const originalKey = buildOriginalObjectKey(filename);
    const thumbnails = buildUploadThumbnailObjectKeys(filename);
    const exists = await Promise.all([
      objectExists(client, originalKey, config.timeoutMs),
      objectExists(client, thumbnails.mediumKey, config.timeoutMs),
      objectExists(client, thumbnails.tinyKey, config.timeoutMs),
    ]);
    if (exists.some(Boolean)) throw new PhotoUploadConflictError();
  }

  async enqueue(
    file: PhotoUploadTempFile,
    reservation: string,
  ): Promise<PhotoUploadJobSnapshot> {
    if (this.reservation !== reservation) {
      throw new Error('上传名额已失效，请重新提交');
    }

    const timestamp = this.nowIso();
    const job: PersistedPhotoUploadJob = {
      jobId: crypto.randomUUID(),
      status: 'queued',
      stage: 'queued',
      file,
      total: 1,
      processed: 0,
      uploaded: [],
      failed: [],
      currentFilename: null,
      message: '等待上传原图',
      createdAt: timestamp,
      updatedAt: timestamp,
      finishedAt: null,
    };

    this.reservation = null;
    this.jobs.set(job.jobId, job);
    try {
      await this.persistJobs();
    } catch (error) {
      this.jobs.delete(job.jobId);
      throw error;
    }
    this.queue.push(job.jobId);
    void this.processQueue();
    return snapshot(job);
  }

  getJob(jobId: string): PhotoUploadJobSnapshot | null {
    const job = this.jobs.get(jobId);
    return job ? snapshot(job) : null;
  }

  isFilenameActive(filename: string): boolean {
    return Array.from(this.jobs.values()).some(job => !isFinished(job) && job.file.filename === filename);
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.unavailableError) return;
    this.processing = true;

    try {
      while (this.queue.length > 0 && !this.unavailableError) {
        const jobId = this.queue.shift();
        if (!jobId) continue;
        const job = this.jobs.get(jobId);
        if (!job || isFinished(job)) continue;
        try {
          await this.processJob(job);
        } catch (error) {
          console.error(`[photoUploadQueue] job ${job.jobId} stopped unexpectedly:`, error);
          if (error instanceof PhotoDataFileError) this.unavailableError = error;
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private async processJob(job: PersistedPhotoUploadJob): Promise<void> {
    const config = this.options.getOssConfig();
    const missingConfig = [
      ['OSS_REGION', config.region],
      ['OSS_BUCKET', config.bucket],
      ['OSS_ACCESS_KEY_ID', config.accessKeyId],
      ['OSS_ACCESS_KEY_SECRET', config.accessKeySecret],
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missingConfig.length > 0) {
      this.unavailableError = new PhotoDataFileError(
        `OSS 配置缺失，无法恢复上传任务: ${missingConfig.join(', ')}`,
      );
      return;
    }
    const client = this.createClient(config);

    job.status = 'processing';
    job.currentFilename = job.file.filename;
    job.message = '正在检查 OSS 处理进度';
    job.updatedAt = this.nowIso();
    await this.persistJobs();

    try {
      const existingMetadata = (await this.options.metadataStore.read())
        .find(record => record.filename === job.file.filename);
      if (existingMetadata) {
        if (!metadataMatchesJob(existingMetadata, job)) {
          await this.failJob(job, new PhotoUploadConflictError(), client, config.timeoutMs, false);
          return;
        }
        job.stage = 'metadata-committed';
        await this.completeJob(job);
        return;
      }

      const originalKey = buildOriginalObjectKey(job.file.filename);
      const thumbnails = buildUploadThumbnailObjectKeys(job.file.filename);

      if (!await objectExists(client, originalKey, config.timeoutMs)) {
        await fs.access(job.file.tempPath);
        job.message = '正在流式上传 JPEG 原图';
        job.updatedAt = this.nowIso();
        await this.persistJobs();
        await putOriginalJpeg(client, originalKey, job.file.tempPath, config.timeoutMs);
      }
      await this.persistStage(job, 'original-uploaded', '原图已上传，正在生成 medium 缩略图');

      await ensurePersistentJpegVariant(
        client,
        originalKey,
        thumbnails.mediumKey,
        MEDIUM_IMAGE_PROCESS,
        config.timeoutMs,
        {
          attempts: 3,
          pollIntervalMs: this.options.variantPollIntervalMs,
          pollTimeoutMs: this.options.variantPollTimeoutMs,
          sleep: this.sleep,
        },
      );
      await this.persistStage(job, 'medium-completed', 'medium 已完成，正在生成 tiny 缩略图');

      await ensurePersistentJpegVariant(
        client,
        originalKey,
        thumbnails.tinyKey,
        TINY_IMAGE_PROCESS,
        config.timeoutMs,
        {
          attempts: 3,
          pollIntervalMs: this.options.variantPollIntervalMs,
          pollTimeoutMs: this.options.variantPollTimeoutMs,
          sleep: this.sleep,
        },
      );
      await this.persistStage(job, 'tiny-completed', '缩略图已完成，正在提交照片元数据');

      const photoDate = await readOssPhotoDate(client, originalKey, config.timeoutMs)
        ?? formatDate(job.createdAt);
      const entry: PhotoMetadataRecord = {
        filename: job.file.filename,
        originalSrc: `/${originalKey}`,
        src: `/${originalKey}`,
        srcMedium: `/${thumbnails.mediumKey}`,
        srcTiny: `/${thumbnails.tinyKey}`,
        width: job.file.width,
        height: job.file.height,
        size: job.file.size,
        format: 'JPEG',
        date: photoDate,
        visibilityUpdatedAt: null,
      };

      await this.options.metadataStore.update(records => {
        const existing = records.find(record => record.filename === job.file.filename);
        if (existing) {
          if (!metadataMatchesJob(existing, job)) throw new PhotoUploadConflictError();
          return { records, result: undefined };
        }
        return { records: [...records, entry], result: undefined };
      });

      job.stage = 'metadata-committed';
      job.message = '照片元数据已提交';
      job.updatedAt = this.nowIso();
      await this.persistJobs();
      await this.completeJob(job);
    } catch (error) {
      if (job.stage === 'metadata-committed') {
        await this.completeJob(job).catch(completionError => {
          console.error('[photoUploadQueue] failed to finalize committed job:', completionError);
        });
        return;
      }
      await this.failJob(job, error, client, config.timeoutMs);
    }
  }

  private async completeJob(job: PersistedPhotoUploadJob): Promise<void> {
    const originalKey = buildOriginalObjectKey(job.file.filename);
    job.status = 'completed';
    job.processed = 1;
    job.currentFilename = null;
    job.uploaded = [{
      filename: job.file.filename,
      size: job.file.size,
      src: `/${originalKey}`,
    }];
    job.failed = [];
    job.message = '原图与 OSS 持久化缩略图均已就绪';
    job.finishedAt = this.nowIso();
    job.updatedAt = job.finishedAt;
    await this.persistJobs();
    await removeFileIgnoreNotFound(job.file.tempPath);
  }

  private async cleanupJobObjects(
    job: PersistedPhotoUploadJob,
    client: PhotoOssClient,
    timeoutMs: number,
  ): Promise<void> {
    const thumbnails = buildUploadThumbnailObjectKeys(job.file.filename);
    const keys = [
      buildOriginalObjectKey(job.file.filename),
      thumbnails.mediumKey,
      thumbnails.tinyKey,
    ];

    for (const key of keys) {
      let lastError: unknown;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await deleteObjectIgnoreNotFound(client, key, timeoutMs);
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < 3) await this.sleep(attempt * 250);
        }
      }
      if (lastError) {
        console.error(`[photoUploadQueue] failed to rollback OSS object ${key}:`, lastError);
      }
    }
  }

  private async failJob(
    job: PersistedPhotoUploadJob,
    error: unknown,
    client: PhotoOssClient,
    timeoutMs: number,
    cleanupObjects = true,
  ): Promise<void> {
    if (cleanupObjects) await this.cleanupJobObjects(job, client, timeoutMs);
    const errorMessage = error instanceof Error ? error.message : '上传照片失败';
    job.status = 'failed';
    job.processed = 1;
    job.currentFilename = null;
    job.uploaded = [];
    job.failed = [{ filename: job.file.filename, error: errorMessage }];
    job.message = errorMessage;
    job.finishedAt = this.nowIso();
    job.updatedAt = job.finishedAt;

    try {
      await this.persistJobs();
    } finally {
      await removeFileIgnoreNotFound(job.file.tempPath).catch(cleanupError => {
        console.error(`[photoUploadQueue] failed to remove temp file ${job.file.tempPath}:`, cleanupError);
      });
    }
  }

  private async cleanupUnreferencedTempFiles(): Promise<void> {
    const referenced = new Set(
      Array.from(this.jobs.values())
        .filter(job => !isFinished(job))
        .map(job => path.resolve(job.file.tempPath)),
    );
    const cutoff = this.now().getTime() - TEMP_FILE_MAX_AGE_MS;

    let entries: string[];
    try {
      entries = await fs.readdir(this.options.tempDir);
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries) {
      const filePath = path.resolve(this.options.tempDir, entry);
      if (referenced.has(filePath)) continue;
      const stat = await fs.stat(filePath);
      if (stat.isFile() && stat.mtimeMs < cutoff) {
        await removeFileIgnoreNotFound(filePath);
      }
    }
  }

  async waitForIdle(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.processing || this.queue.length > 0 || this.hasUnfinishedJob()) {
      if (Date.now() >= deadline) throw new Error('等待照片上传队列空闲超时');
      await this.sleep(5);
    }
  }
}
