import React, { useState, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { Film } from 'lucide-react';
import type { PhotoItem } from './types';
import { formatFileSize, formatResolution } from '../../utils/format';

interface PhotoGridProps {
  images: PhotoItem[];
  columns: number;
  onImageClick: (index: number) => void;
}

export const PhotoGrid: React.FC<PhotoGridProps> = ({ images, columns, onImageClick }) => {
  const [loadedImages, setLoadedImages] = useState<Set<number>>(new Set());
  const [imageDimensions, setImageDimensions] = useState<Map<number, {w: number, h: number}>>(new Map());
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const videoRefs = useRef<Map<number, HTMLVideoElement>>(new Map());

  const handleImageLoad = useCallback((index: number, e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setLoadedImages(prev => new Set([...prev, index]));
    setImageDimensions(prev => new Map(prev).set(index, { w: img.naturalWidth, h: img.naturalHeight }));
  }, []);

  // 实况照片悬停播放
  const handleMouseEnter = useCallback((index: number) => {
    setHoveredIndex(index);
    const video = videoRefs.current.get(index);
    if (video) {
      video.currentTime = 0;
      video.play().catch(() => {});
    }
  }, []);

  const handleMouseLeave = useCallback((index: number) => {
    // 原本考虑延迟清除悬停以防止鼠标快速移动导致闪烁，但立即停止更合适
    // 原始逻辑：
    const video = videoRefs.current.get(index);
    if (video) {
      video.pause();
      video.currentTime = 0;
    }
    setHoveredIndex(null);
  }, []);

  return (
    <div 
      className="photowall-grid"
      style={{
        columnCount: columns,
        columnGap: '6px',
      }}
    >
      {images.map((image, index) => {
        const dims = imageDimensions.get(index);
        const isLivePhoto = !!image.videoSrc;
        
        return (
          <motion.div
            key={image.src}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: index * 0.03 }}
            className="photowall-item group relative mb-1.5 break-inside-avoid cursor-pointer overflow-hidden rounded-lg" // 添加 rounded-lg 让外观更干净
            onClick={() => onImageClick(index)}
            onMouseEnter={() => handleMouseEnter(index)}
            onMouseLeave={() => handleMouseLeave(index)}
          >
            {/* 图片 - 使用中等质量缩略图 */}
            <img
              src={image.srcMedium || image.src}
              alt={image.alt}
              loading="lazy"
              onLoad={(e) => handleImageLoad(index, e)}
              className={`
                w-full h-auto block transition-all duration-500 ease-out
                group-hover:scale-105
                ${loadedImages.has(index) ? 'opacity-100' : 'opacity-0'}
                ${hoveredIndex === index && isLivePhoto ? 'opacity-0' : ''}
              `}
            />

            {/* 实况照片视频 */}
            {isLivePhoto && (
              <video
                ref={el => { if (el) videoRefs.current.set(index, el); }}
                src={image.videoSrc}
                muted
                loop
                playsInline
                className={`
                  absolute inset-0 w-full h-full object-cover
                  transition-opacity duration-300
                  ${hoveredIndex === index ? 'opacity-100' : 'opacity-0'}
                `}
              />
            )}

            {/* 加载占位 */}
            {!loadedImages.has(index) && (
              <div className="absolute inset-0 bg-gray-200 dark:bg-gray-800 animate-pulse" />
            )}

            {/* 实况照片标识 */}
            {isLivePhoto && loadedImages.has(index) && (
              <div className="absolute top-3 left-3 z-10 transition-opacity duration-300 group-hover:opacity-0">
                <div className="bg-black/60 backdrop-blur-sm px-2 py-1 rounded-full flex items-center gap-1">
                  <Film size={12} className="text-white" />
                  <span className="text-white text-xs font-medium">LIVE</span>
                </div>
              </div>
            )}

            {/* 悬停遮罩 */}
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300">
              {/* 底部信息 - 文件名 + 格式 + 分辨率 + 大小 */}
              <div className="absolute bottom-0 left-0 right-0 p-3 transform translate-y-2 group-hover:translate-y-0 transition-transform duration-300">
                {/* 文件名 (不含扩展名) */}
                <p className="text-white text-base font-semibold truncate mb-1">
                  {image.alt || image.filename.replace(/\.(jpg|jpeg|png|webp|heic)$/i, '')}
                </p>
                {/* 格式 + 分辨率 + 大小 */}
                <div className="flex items-center gap-2 text-white/70 text-xs">
                  <span className="uppercase">{image.format || image.filename.split('.').pop()}</span>
                  <span className="text-white/40">·</span>
                  <span>{formatResolution(image.width || dims?.w, image.height || dims?.h)}</span>
                  <span className="text-white/40">·</span>
                  <span>{formatFileSize(image.size)}</span>
                </div>
              </div>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
};
