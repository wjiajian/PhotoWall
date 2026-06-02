const SUPPORTED_PHOTO_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'];

const SUPPORTED_FORMAT_TEXT = SUPPORTED_PHOTO_EXTENSIONS
  .map((ext) => ext.slice(1).toUpperCase())
  .join('、');

const PHOTO_EXTENSION_REGEX = new RegExp(
  `\\.(${SUPPORTED_PHOTO_EXTENSIONS.map((ext) => ext.slice(1)).join('|')})$`,
  'i'
);

function isSupportedPhotoExtension(extension) {
  if (typeof extension !== 'string') return false;
  return SUPPORTED_PHOTO_EXTENSIONS.includes(extension.toLowerCase());
}

module.exports = {
  SUPPORTED_PHOTO_EXTENSIONS,
  SUPPORTED_FORMAT_TEXT,
  PHOTO_EXTENSION_REGEX,
  isSupportedPhotoExtension,
};
