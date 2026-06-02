import React, { useState, useRef, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Film, ChevronUp, ChevronDown } from 'lucide-react';
import type { PhotoItem } from './types';
import {
  formatFileSize,
  formatResolution,
  formatMegapixels,
} from '../../utils/format';

interface MobileDrawerProps {
  selectedImage: PhotoItem;
  fullDimensions: { w: number; h: number } | null;
  images: PhotoItem[];
  currentIndex: number;
  onNavigate: (index: number) => void;
}

const COLLAPSED_HEIGHT = 100;

export const MobileDrawer: React.FC<MobileDrawerProps> = ({
  selectedImage,
  fullDimensions,
  images,
  currentIndex,
  onNavigate,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const expandedHeight =
    typeof window !== 'undefined' ? window.innerHeight * 0.6 : 400;

  const handleToggle = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    setIsExpanded((prev) => !prev);
  }, []);

  const handleTouchEvent = useCallback((e: React.TouchEvent) => {
    e.stopPropagation();
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        drawerRef.current &&
        !drawerRef.current.contains(event.target as Node)
      ) {
        setIsExpanded(false);
      }
    };

    if (isExpanded) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isExpanded]);

  return (
    <motion.div
      ref={drawerRef}
      initial={{ y: 0 }}
      animate={{ height: isExpanded ? expandedHeight : COLLAPSED_HEIGHT }}
      transition={{ type: 'spring', damping: 25, stiffness: 300 }}
      className="fixed bottom-0 left-0 right-0 z-50 bg-[#1a1a1a] rounded-t-2xl border-t border-white/10 overflow-hidden flex flex-col"
      onTouchStart={handleTouchEvent}
      onTouchMove={handleTouchEvent}
      onTouchEnd={handleTouchEvent}
    >
      <div className="flex justify-center py-2 cursor-pointer" onClick={handleToggle}>
        {isExpanded ? (
          <ChevronDown size={24} className="text-white/50" />
        ) : (
          <ChevronUp size={24} className="text-white/50" />
        )}
      </div>

      <div className="px-4 flex-1 overflow-hidden flex flex-col">
        <AnimatePresence mode="wait">
          {!isExpanded ? (
            <motion.div
              key="collapsed"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex items-center justify-between"
            >
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <div className="relative w-12 h-12 rounded-lg overflow-hidden flex-shrink-0">
                  <img
                    src={selectedImage.srcMedium || selectedImage.srcTiny || selectedImage.src}
                    alt={selectedImage.alt}
                    className="w-full h-full object-cover"
                  />
                  {selectedImage.videoSrc && (
                    <div className="absolute top-1 left-1">
                      <Film size={10} className="text-white drop-shadow-lg" />
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-white font-medium truncate text-sm">
                    {selectedImage.filename.replace(/\.(jpg|jpeg|png|webp|heic)$/i, '')}
                  </p>
                  <p className="text-white/50 text-xs">
                    {(selectedImage.format || selectedImage.filename.split('.').pop())?.toUpperCase()}
                    {' · '}
                    {formatResolution(
                      fullDimensions?.w || selectedImage.width,
                      fullDimensions?.h || selectedImage.height,
                    )}
                  </p>
                </div>
              </div>
              <div className="text-white/40 text-xs flex-shrink-0 ml-2">
                {currentIndex + 1} / {images.length}
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="expanded"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col flex-1 min-h-0"
            >
              <div className="flex-1 flex flex-col min-h-0">
                <div className="flex-1 overflow-y-auto min-h-0">
                  <h3 className="text-white/50 text-xs uppercase tracking-wider mb-3">
                    基本信息
                  </h3>
                  <div className="space-y-2">
                    <InfoRow label="文件名" value={selectedImage.filename.replace(/\.(jpg|jpeg|png|webp|heic)$/i, '')} />
                    <InfoRow label="格式" value={selectedImage.format || selectedImage.filename.split('.').pop() || '-'} uppercase />
                    <InfoRow
                      label="尺寸"
                      value={formatResolution(
                        fullDimensions?.w || selectedImage.width,
                        fullDimensions?.h || selectedImage.height,
                      )}
                    />
                    <InfoRow label="文件大小" value={formatFileSize(selectedImage.size)} />
                    <InfoRow
                      label="像素"
                      value={formatMegapixels(
                        fullDimensions?.w || selectedImage.width,
                        fullDimensions?.h || selectedImage.height,
                      )}
                    />
                    <InfoRow
                      label="拍摄日期"
                      value={selectedImage.date ? selectedImage.date.split(' ')[0].replace(/:/g, '-') : '-'}
                    />
                  </div>
                </div>

                <div className="flex-shrink-0 pt-3 border-t border-white/10">
                  <h3 className="text-white/50 text-xs uppercase tracking-wider mb-2">
                    快速预览
                  </h3>
                  <div className="flex gap-2 overflow-x-auto scrollbar-hide">
                    {images.map((image, i) => {
                      if (Math.abs(i - currentIndex) > 10) return null;

                      const isActive = i === currentIndex;
                      return (
                        <div
                          key={image.src}
                          onClick={(e) => {
                            e.stopPropagation();
                            onNavigate(i);
                          }}
                          className={`
                            relative flex-shrink-0 w-14 h-14 rounded-lg overflow-hidden cursor-pointer
                            transition-all duration-200 border-2
                            ${isActive ? 'border-white' : 'border-transparent opacity-60 hover:opacity-100'}
                          `}
                        >
                          <img
                            src={image.srcMedium || image.srcTiny || image.src}
                            alt={image.alt}
                            loading="lazy"
                            className="w-full h-full object-cover"
                          />
                          {image.videoSrc && (
                            <div className="absolute top-1 left-1">
                              <Film size={8} className="text-white drop-shadow-lg" />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
};

const InfoRow = ({
  label,
  value,
  uppercase = false,
}: {
  label: string;
  value: string;
  uppercase?: boolean;
}) => (
  <div className="flex justify-between gap-4">
    <span className="text-white/60 text-sm">{label}</span>
    <span className={`text-white text-sm truncate ${uppercase ? 'uppercase' : ''}`}>
      {value}
    </span>
  </div>
);
