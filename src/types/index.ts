export interface ImageMetadata {
  driveItemId?: string;
  filename: string;
  format?: string;
  width: number;
  height: number;
  size: number;
  originalSrc?: string;
  src: string;
  srcMedium?: string;
  srcTiny?: string;
  videoSrc?: string;
  date?: string;
  isVisible?: boolean;
  visibilityUpdatedAt?: string;
}
