export interface PhotoItem {
  src: string;           // 原图（高分辨率）
  srcMedium?: string;    // 中等缩略图（400px）用于网格
  srcTiny?: string;      // 微型缩略图（50px）用于列表
  alt: string;
  filename: string;
  format?: string;
  width?: number;
  height?: number;
  size?: number; // 字节数
  videoSrc?: string; // 实况照片视频源
  date?: string; // EXIF 拍摄日期
}
