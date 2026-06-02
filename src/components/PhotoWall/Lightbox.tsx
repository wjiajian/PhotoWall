import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import { X, ChevronLeft, ChevronRight, ZoomIn, RotateCcw } from 'lucide-react';
import type { PhotoItem } from './types';
import { LightboxSidebar } from './LightboxSidebar';
import { MobileDrawer } from './MobileDrawer';
import { useIsMobile } from '../../hooks/useIsMobile';
import { formatFileSize } from '../../utils/format';

interface LightboxProps {
  images: PhotoItem[];
  selectedIndex: number;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  onNavigate: (index: number) => void;
}

// 缩放配置常量
const MIN_SCALE = 1;
const MAX_SCALE = 5;
const WHEEL_ZOOM_STEP = 0.15;

export const Lightbox: React.FC<LightboxProps> = ({
  images,
  selectedIndex,
  onClose,
  onPrev,
  onNext,
  onNavigate
}) => {
  const isMobile = useIsMobile();
  const [imageLoadProgress, setImageLoadProgress] = useState(0);
  const [imageLoadedBytes, setImageLoadedBytes] = useState(0);
  const [isFullImageLoaded, setIsFullImageLoaded] = useState(false);
  const [fullImageDimensions, setFullImageDimensions] = useState<{w: number, h: number} | null>(null);
  const [fullImageUrl, setFullImageUrl] = useState<string | null>(null);

  // 缩放和平移状态
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, posX: 0, posY: 0 });
  const imageContainerRef = useRef<HTMLDivElement>(null);
  
  // 移动端双指缩放
  const lastPinchDistance = useRef<number | null>(null);
  const pinchCenter = useRef({ x: 0, y: 0 });
  
  // 双击检测
  const lastTap = useRef<number>(0);

  // 重置缩放状态
  const resetZoom = useCallback(() => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  }, []);

  // 图片切换时重置缩放
  useEffect(() => {
    resetZoom();
  }, [selectedIndex, resetZoom]);

  const selectedImage = images[selectedIndex];

  // 使用单次 fetch + blob 加载原图并跟踪进度
  useEffect(() => {
    if (!selectedImage) return;

    const totalSize = selectedImage.size || 0;
    
    // 重置状态
    setImageLoadProgress(0);
    setImageLoadedBytes(0);
    setIsFullImageLoaded(false);
    setFullImageDimensions(null);
    
    // 释放上一次的 blob URL，避免内存泄漏
    if (fullImageUrl) {
      URL.revokeObjectURL(fullImageUrl);
      setFullImageUrl(null);
    }

    // 拉取图片并跟踪进度
    const controller = new AbortController();
    
    fetch(selectedImage.src, { signal: controller.signal })
      .then(response => {
        const reader = response.body?.getReader();
        const contentLength = parseInt(response.headers.get('Content-Length') || '0') || totalSize;
        
        if (!reader) {
          // 若 reader 不可用，则直接使用 src
          setFullImageUrl(selectedImage.src);
          setIsFullImageLoaded(true);
          setImageLoadProgress(100);
          return;
        }

        let receivedLength = 0;
        const chunks: Uint8Array[] = [];

        const read = (): Promise<void> => {
          return reader.read().then(({ done, value }) => {
            if (done) {
              // 使用已收集的分片创建 blob
              const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
              const merged = new Uint8Array(totalLength);
              let offset = 0;
              for (const chunk of chunks) {
                merged.set(chunk, offset);
                offset += chunk.byteLength;
              }
              const blob = new Blob([merged.buffer]);
              const blobUrl = URL.createObjectURL(blob);
              setFullImageUrl(blobUrl);
              
              // 从 blob 获取图片尺寸
              const img = new Image();
              img.src = blobUrl;
              img.onload = () => {
                setFullImageDimensions({ w: img.naturalWidth, h: img.naturalHeight });
                setIsFullImageLoaded(true);
                setImageLoadProgress(100);
              };
              img.onerror = () => {
                // 即使尺寸获取失败也标记为已加载
                setIsFullImageLoaded(true);
                setImageLoadProgress(100);
              };
              return;
            }
            
            chunks.push(value);
            receivedLength += value.length;
            
            const progress = contentLength > 0 ? Math.round((receivedLength / contentLength) * 100) : 0;
            setImageLoadProgress(progress);
            setImageLoadedBytes(receivedLength);
            
            return read();
          });
        };

        return read();
      })
      .catch(() => {
        // 出错时回退为直接使用 src
        setFullImageUrl(selectedImage.src);
        setIsFullImageLoaded(true);
        setImageLoadProgress(100);
      });

    return () => {
      controller.abort();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedImage]);

  // 卸载时清理 blob URL
  useEffect(() => {
    return () => {
      if (fullImageUrl && fullImageUrl.startsWith('blob:')) {
        URL.revokeObjectURL(fullImageUrl);
      }
    };
  }, [fullImageUrl]);

  // ========== 缩放交互处理 ==========

  // 桌面端滚轮缩放
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    const delta = e.deltaY > 0 ? -WHEEL_ZOOM_STEP : WHEEL_ZOOM_STEP;
    setScale(prev => {
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev + delta));
      // 当缩放回到 1x 时重置位置
      if (newScale === 1) {
        setPosition({ x: 0, y: 0 });
      }
      return newScale;
    });
  }, []);

  // 移动端触摸事件处理
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    e.stopPropagation();
    
    if (e.touches.length === 2) {
      // 双指 - 准备缩放
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      lastPinchDistance.current = Math.sqrt(dx * dx + dy * dy);
      pinchCenter.current = {
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
      };
    } else if (e.touches.length === 1 && scale > 1) {
      // 单指且已缩放 - 准备拖动
      setIsDragging(true);
      dragStart.current = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY,
        posX: position.x,
        posY: position.y,
      };
    }
  }, [scale, position]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    e.stopPropagation();
    
    if (e.touches.length === 2 && lastPinchDistance.current !== null) {
      // 双指缩放
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const delta = (distance - lastPinchDistance.current) * 0.01;
      
      setScale(prev => {
        const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev + delta));
        if (newScale === 1) {
          setPosition({ x: 0, y: 0 });
        }
        return newScale;
      });
      
      lastPinchDistance.current = distance;
    } else if (e.touches.length === 1 && isDragging && scale > 1) {
      // 单指拖动
      const deltaX = e.touches[0].clientX - dragStart.current.x;
      const deltaY = e.touches[0].clientY - dragStart.current.y;
      setPosition({
        x: dragStart.current.posX + deltaX,
        y: dragStart.current.posY + deltaY,
      });
    }
  }, [isDragging, scale]);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    e.stopPropagation();
    lastPinchDistance.current = null;
    setIsDragging(false);
    
    // 双击检测 - 重置缩放
    const now = Date.now();
    if (now - lastTap.current < 300) {
      resetZoom();
    }
    lastTap.current = now;
  }, [resetZoom]);

  // 桌面端鼠标拖动
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (scale > 1) {
      e.preventDefault();
      setIsDragging(true);
      dragStart.current = {
        x: e.clientX,
        y: e.clientY,
        posX: position.x,
        posY: position.y,
      };
    }
  }, [scale, position]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isDragging && scale > 1) {
      const deltaX = e.clientX - dragStart.current.x;
      const deltaY = e.clientY - dragStart.current.y;
      setPosition({
        x: dragStart.current.posX + deltaX,
        y: dragStart.current.posY + deltaY,
      });
    }
  }, [isDragging, scale]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // 双击重置（桌面端）
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (scale > 1) {
      resetZoom();
    } else {
      // 放大到 2x
      setScale(2);
    }
  }, [scale, resetZoom]);

  // 检查是否处于缩放状态（用于禁用父组件滑动）
  const isZoomed = scale > 1;

  if (!selectedImage) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
      className="fixed inset-0 z-50 flex"
      style={{ touchAction: 'none' }}
      onClick={onClose}
    >
      {/* 当前图片的模糊背景 */}
      <div 
        className="absolute inset-0 bg-cover bg-center"
        style={{ 
          backgroundImage: `url(${selectedImage.srcMedium || selectedImage.srcTiny || selectedImage.src})`,
          filter: 'blur(50px) brightness(0.6)',
          transform: 'scale(1.2)',
        }}
      />
      {/* 深色遮罩 */}
      <div className="absolute inset-0 bg-black/60" />

      {/* 左箭头 - 移动端隐藏 */}
      {!isMobile && (
        <button
          onClick={(e) => { e.stopPropagation(); onPrev(); }}
          className="absolute left-4 top-1/2 -translate-y-1/2 z-50 p-3 rounded-full bg-white/10 hover:bg-white/20 transition-colors cursor-pointer"
        >
          <ChevronLeft size={28} className="text-white" />
        </button>
      )}

      {/* 主内容区 - 图片 + EXIF面板 */}
      <div className="flex-1 flex relative z-10" onClick={(e) => e.stopPropagation()}>
        {/* 图片区域 - 添加缩放和拖动支持 */}
        <div 
          ref={imageContainerRef}
          className={`flex-1 flex items-center justify-center p-0 relative h-full overflow-hidden ${isDragging ? 'cursor-grabbing' : (isZoomed ? 'cursor-grab' : 'cursor-default')}`}
          onWheel={!isMobile ? handleWheel : undefined}
          onMouseDown={!isMobile ? handleMouseDown : undefined}
          onMouseMove={!isMobile ? handleMouseMove : undefined}
          onMouseUp={!isMobile ? handleMouseUp : undefined}
          onMouseLeave={!isMobile ? handleMouseUp : undefined}
          onDoubleClick={!isMobile ? handleDoubleClick : undefined}
          onTouchStart={isMobile ? handleTouchStart : undefined}
          onTouchMove={isMobile ? handleTouchMove : undefined}
          onTouchEnd={isMobile ? handleTouchEnd : undefined}
        >
          {/* 关闭按钮 - 移动端更大的触摸目标 */}
          <button
            onClick={onClose}
            className={`absolute top-4 right-4 z-50 rounded-full bg-black/50 hover:bg-black/70 transition-colors cursor-pointer ${isMobile ? 'p-3' : 'p-2'}`}
          >
            <X size={isMobile ? 28 : 24} className="text-white" />
          </button>

          {/* 缩放指示器和重置按钮 - 仅在缩放时显示 */}
          {isZoomed && (
            <div className="absolute top-4 left-4 z-50 flex items-center gap-2">
              <div className="bg-black/60 backdrop-blur-sm px-3 py-1.5 rounded-full flex items-center gap-2">
                <ZoomIn size={16} className="text-white" />
                <span className="text-white text-sm font-medium">{Math.round(scale * 100)}%</span>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); resetZoom(); }}
                className="p-2 rounded-full bg-black/60 hover:bg-black/70 transition-colors cursor-pointer backdrop-blur-sm"
                title="重置缩放"
              >
                <RotateCcw size={16} className="text-white" />
              </button>
            </div>
          )}

          {/* 中等缩略图占位 */}
          {!isFullImageLoaded && (
            <img
              src={selectedImage.srcMedium || selectedImage.srcTiny || selectedImage.src}
              alt={selectedImage.alt}
              className="absolute max-w-full max-h-screen object-contain"
              style={{
                transform: `scale(${scale}) translate(${position.x / scale}px, ${position.y / scale}px)`,
                transition: isDragging ? 'none' : 'transform 0.1s ease-out',
              }}
            />
          )}

          {/* 主图 - 应用缩放和平移变换 */}
          <motion.img
            key={selectedIndex}
            initial={{ opacity: 0 }}
            animate={{ opacity: isFullImageLoaded ? 1 : 0 }}
            transition={{ duration: 0.3 }}
            src={fullImageUrl || selectedImage.src}
            alt={selectedImage.alt}
            onLoad={() => setIsFullImageLoaded(true)}
            className="relative max-w-full max-h-screen object-contain shadow-2xl z-10 select-none"
            style={{
              transform: `scale(${scale}) translate(${position.x / scale}px, ${position.y / scale}px)`,
              transition: isDragging ? 'none' : 'transform 0.1s ease-out',
            }}
            draggable={false}
          />

          {/* 加载进度指示 */}
          {!isFullImageLoaded && imageLoadProgress < 100 && (
            <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-black/70 backdrop-blur-sm px-4 py-2 rounded-full z-20">
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              <span className="text-white text-sm font-medium">
                {imageLoadProgress}%
              </span>
              <span className="text-white/60 text-sm">
                {formatFileSize(imageLoadedBytes)} / {formatFileSize(selectedImage.size)}
              </span>
            </div>
          )}

          {/* 移动端缩放提示 */}
          {isMobile && !isZoomed && isFullImageLoaded && (
            <div className="absolute bottom-24 left-1/2 -translate-x-1/2 bg-black/50 backdrop-blur-sm px-3 py-1.5 rounded-full text-white/70 text-xs pointer-events-none">
              双指捏合缩放
            </div>
          )}
        </div>

        {/* 侧栏/抽屉 - 根据设备类型条件渲染 */}
        {isMobile ? (
          <MobileDrawer
            selectedImage={selectedImage}
            fullDimensions={fullImageDimensions}
            images={images}
            currentIndex={selectedIndex}
            onNavigate={onNavigate}
          />
        ) : (
          <LightboxSidebar 
            selectedImage={selectedImage}
            fullDimensions={fullImageDimensions}
            images={images}
            currentIndex={selectedIndex}
            onNavigate={onNavigate}
          />
        )}
      </div>

      {/* 右箭头 - 移动端隐藏 */}
      {!isMobile && (
        <button
          onClick={(e) => { e.stopPropagation(); onNext(); }}
          className="absolute right-[336px] top-1/2 -translate-y-1/2 z-50 p-3 rounded-full bg-white/10 hover:bg-white/20 transition-colors cursor-pointer"
        >
          <ChevronRight size={28} className="text-white" />
        </button>
      )}
    </motion.div>
  );
};
