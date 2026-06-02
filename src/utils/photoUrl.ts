interface PhotoAssetRecord {
  src: string;
  srcMedium?: string;
  srcTiny?: string;
  originalSrc?: string;
  videoSrc?: string;
}

const PHOTOWALL_PREFIX = '/photowall/';
const HTTP_URL_REGEX = /^https?:\/\//i;

function normalizeBaseUrl(baseUrl?: string): string {
  if (!baseUrl) return '';
  const trimmed = baseUrl.trim();
  if (!trimmed) return '';
  return trimmed.replace(/\/+$/, '');
}

function resolvePhotoAssetUrl(url: string | undefined, baseUrl: string): string | undefined {
  if (!url) return url;
  if (!baseUrl) return url;
  if (HTTP_URL_REGEX.test(url) || url.startsWith('//')) return url;
  if (!url.startsWith(PHOTOWALL_PREFIX)) return url;
  return `${baseUrl}${url}`;
}

export function resolvePhotoAssetPaths<T extends PhotoAssetRecord>(photo: T, baseUrl?: string): T {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) return photo;

  return {
    ...photo,
    src: resolvePhotoAssetUrl(photo.src, normalizedBaseUrl) || photo.src,
    srcMedium: resolvePhotoAssetUrl(photo.srcMedium, normalizedBaseUrl),
    srcTiny: resolvePhotoAssetUrl(photo.srcTiny, normalizedBaseUrl),
    originalSrc: resolvePhotoAssetUrl(photo.originalSrc, normalizedBaseUrl),
    videoSrc: resolvePhotoAssetUrl(photo.videoSrc, normalizedBaseUrl),
  };
}
