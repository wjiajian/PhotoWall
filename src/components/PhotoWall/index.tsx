import React, { useState, useEffect, useCallback, useRef } from 'react';
import { AnimatePresence } from 'framer-motion';
import type { PhotoItem } from './types';
import { PhotoGrid } from './PhotoGrid';
import { Lightbox } from './Lightbox';
import { useIsMobile } from '../../hooks/useIsMobile';

// 重新导出类型供外部使用
export type { PhotoItem };

export interface PhotoWallProps {
  images: PhotoItem[];
  columns?: number;
}

export const PhotoWall: React.FC<PhotoWallProps> = ({ 
  images, 
  columns = 4 
}) => {
  const isMobile = useIsMobile();
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  
  // 触摸滑动相关状态
  const touchStartX = useRef<number>(0);
  const touchEndX = useRef<number>(0);

  // 处理键盘导航
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (selectedIndex === null) return;
      
      switch (e.key) {
        case 'Escape':
          setSelectedIndex(null);
          break;
        case 'ArrowLeft':
          setSelectedIndex(prev => 
            prev !== null ? (prev > 0 ? prev - 1 : images.length - 1) : null
          );
          break;
        case 'ArrowRight':
          setSelectedIndex(prev => 
            prev !== null ? (prev < images.length - 1 ? prev + 1 : 0) : null
          );
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedIndex, images.length]);

  // 锁定背景滚动
  useEffect(() => {
    if (selectedIndex !== null) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [selectedIndex]);

  const navigatePrev = useCallback(() => {
    setSelectedIndex(prev => 
      prev !== null ? (prev > 0 ? prev - 1 : images.length - 1) : null
    );
  }, [images.length]);

  const navigateNext = useCallback(() => {
    setSelectedIndex(prev => 
      prev !== null ? (prev < images.length - 1 ? prev + 1 : 0) : null
    );
  }, [images.length]);

  // 移动端触摸滑动处理
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    touchEndX.current = e.touches[0].clientX;
  }, []);

  const handleTouchEnd = useCallback(() => {
    const diff = touchStartX.current - touchEndX.current;
    const threshold = 50; // 滑动阈值
    
    if (Math.abs(diff) > threshold) {
      if (diff > 0) {
        // 左滑 -> 下一张
        navigateNext();
      } else {
        // 右滑 -> 上一张
        navigatePrev();
      }
    }
    
    // 重置
    touchStartX.current = 0;
    touchEndX.current = 0;
  }, [navigateNext, navigatePrev]);

  return (
    <>
      <PhotoGrid 
        images={images} 
        columns={columns} 
        onImageClick={setSelectedIndex} 
      />

      <AnimatePresence>
        {selectedIndex !== null && (
          <div
            onTouchStart={isMobile ? handleTouchStart : undefined}
            onTouchMove={isMobile ? handleTouchMove : undefined}
            onTouchEnd={isMobile ? handleTouchEnd : undefined}
          >
            <Lightbox
              images={images}
              selectedIndex={selectedIndex}
              onClose={() => setSelectedIndex(null)}
              onPrev={navigatePrev}
              onNext={navigateNext}
              onNavigate={setSelectedIndex}
            />
          </div>
        )}
      </AnimatePresence>
    </>
  );
};
