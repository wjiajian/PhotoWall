/**
 * 通用格式化工具函数
 *
 * 用于图片、文件等数据的格式化显示
 */

/**
 * 格式化文件大小
 * @param bytes 文件大小（字节）
 * @returns 格式化后的字符串，如 "1.5 MB"
 */
export const formatFileSize = (bytes?: number): string => {
  if (!bytes) return '未知';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * 格式化分辨率
 * @param width 宽度（像素）
 * @param height 高度（像素）
 * @returns 格式化后的字符串，如 "1920 × 1080"
 */
export const formatResolution = (width?: number, height?: number): string => {
  if (!width || !height) return '未知';
  return `${width} × ${height}`;
};

/**
 * 计算并格式化像素数
 * @param width 宽度（像素）
 * @param height 高度（像素）
 * @returns 格式化后的字符串，如 "2.1 MP"
 */
export const formatMegapixels = (width?: number, height?: number): string => {
  if (!width || !height) return '未知';
  const mp = (width * height) / 1000000;
  return `${mp.toFixed(1)} MP`;
};
