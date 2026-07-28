import path from 'node:path';
import { imageSizeFromFile } from 'image-size/fromFile';

const configuredMaxUploadMb = Number.parseInt(process.env.PHOTO_UPLOAD_MAX_MB || '20', 10);
const configuredMaxBatchMb = Number.parseInt(process.env.PHOTO_UPLOAD_MAX_BATCH_MB || '20', 10);
const validMaxUploadMb = Number.isFinite(configuredMaxUploadMb) && configuredMaxUploadMb > 0
  ? configuredMaxUploadMb
  : 20;
const validMaxBatchMb = Number.isFinite(configuredMaxBatchMb) && configuredMaxBatchMb > 0
  ? configuredMaxBatchMb
  : 20;
export const PHOTO_UPLOAD_MAX_MB = Math.min(validMaxUploadMb, validMaxBatchMb, 20);
export const PHOTO_UPLOAD_MAX_BYTES = PHOTO_UPLOAD_MAX_MB * 1024 * 1024;
export const PHOTO_UPLOAD_MAX_PIXELS = 60_000_000;
export const PHOTO_UPLOAD_MAX_SIDE_PX = 20_000;

export class PhotoUploadValidationError extends Error {
  readonly statusCode: 413 | 415 | 422;

  constructor(message: string, statusCode: 413 | 415 | 422) {
    super(message);
    this.name = 'PhotoUploadValidationError';
    this.statusCode = statusCode;
  }
}

export interface UploadFileForValidation {
  tempPath: string;
  filename: string;
  size: number;
}

export interface ValidatedJpegDimensions {
  width: number;
  height: number;
}

export function isJpegFilename(filename: string): boolean {
  const extension = path.extname(filename).toLowerCase();
  return extension === '.jpg' || extension === '.jpeg';
}

export async function validateJpegUpload(
  file: UploadFileForValidation,
): Promise<ValidatedJpegDimensions> {
  if (file.size > PHOTO_UPLOAD_MAX_BYTES) {
    throw new PhotoUploadValidationError(`单个文件不能超过 ${PHOTO_UPLOAD_MAX_MB}MB`, 413);
  }

  if (!isJpegFilename(file.filename)) {
    throw new PhotoUploadValidationError('仅支持上传 JPG/JPEG 图片', 415);
  }

  let dimensions: Awaited<ReturnType<typeof imageSizeFromFile>>;
  try {
    dimensions = await imageSizeFromFile(file.tempPath);
  } catch (error) {
    throw new PhotoUploadValidationError(
      `JPEG 文件已损坏或无法读取${error instanceof Error && error.message ? `：${error.message}` : ''}`,
      422,
    );
  }

  if (dimensions.type !== 'jpg') {
    throw new PhotoUploadValidationError('文件实际格式不是 JPEG', 415);
  }

  const { width, height } = dimensions;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new PhotoUploadValidationError('JPEG 尺寸信息无效', 422);
  }

  if (width > PHOTO_UPLOAD_MAX_SIDE_PX || height > PHOTO_UPLOAD_MAX_SIDE_PX) {
    throw new PhotoUploadValidationError(`JPEG 单边尺寸不能超过 ${PHOTO_UPLOAD_MAX_SIDE_PX}px`, 422);
  }

  if (width * height > PHOTO_UPLOAD_MAX_PIXELS) {
    throw new PhotoUploadValidationError('JPEG 总像素不能超过 6000 万', 422);
  }

  return { width, height };
}
