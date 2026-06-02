import React from 'react';
import { Film } from 'lucide-react';
import type { PhotoItem } from './types';
import { formatFileSize, formatResolution, formatMegapixels } from '../../utils/format';

interface LightboxSidebarProps {
  selectedImage: PhotoItem;
  fullDimensions: { w: number, h: number } | null;
  images: PhotoItem[];
  currentIndex: number;
  onNavigate: (index: number) => void;
}

export const LightboxSidebar: React.FC<LightboxSidebarProps> = ({
  selectedImage,
  fullDimensions,
  images,
  currentIndex,
  onNavigate
}) => {
  return (
    <div className="w-80 bg-[#1a1a1a] border-l border-white/10 flex flex-col h-screen shrink-0 relative z-50">
      <div className="p-4 flex flex-col flex-1 min-h-0 overflow-hidden">
        {/* 基本信息 */}
        <div className="mb-6">
          <h3 className="text-white/50 text-xs uppercase tracking-wider mb-3">基本信息</h3>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-white/60 text-sm">文件名</span>
              <span className="text-white text-sm font-medium truncate max-w-[150px]" title={selectedImage.filename}>
                {selectedImage.filename.replace(/\.(jpg|jpeg|png|webp|heic)$/i, '')}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-white/60 text-sm">格式</span>
              <span className="text-white text-sm uppercase">{selectedImage.format || selectedImage.filename.split('.').pop()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-white/60 text-sm">尺寸</span>
              <span className="text-white text-sm">
                {formatResolution(fullDimensions?.w || selectedImage.width, fullDimensions?.h || selectedImage.height)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-white/60 text-sm">文件大小</span>
              <span className="text-white text-sm">{formatFileSize(selectedImage.size)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-white/60 text-sm">像素</span>
              <span className="text-white text-sm">
                {formatMegapixels(fullDimensions?.w || selectedImage.width, fullDimensions?.h || selectedImage.height)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-white/60 text-sm">拍摄日期</span>
              <span className="text-white text-sm tabular-nums">
                {selectedImage.date 
                  ? selectedImage.date.split(' ')[0].replace(/:/g, '-')
                  : '-'}
              </span>
            </div>
          </div>
        </div>

        <div className="text-white/40 text-xs text-center pt-4 border-t border-white/10 mt-4">
          {currentIndex + 1} / {images.length}
        </div>

        <div className="mt-4 pt-4 border-t border-white/10 flex flex-col flex-1 min-h-0">
          <h3 className="text-white/50 text-xs uppercase tracking-wider mb-3">快速预览</h3>
          <div className="flex flex-col gap-2 flex-1 overflow-y-auto scrollbar-hide">
            {images.map((image, i) => {
              if (Math.abs(i - currentIndex) > 15) return null;

              const isActive = i === currentIndex;
              return (
                <div
                  key={image.src}
                  onClick={(e) => {
                    e.stopPropagation();
                    onNavigate(i);
                  }}
                  className={`
                    relative flex items-center gap-3 py-2 pl-2 pr-0 rounded-lg cursor-pointer
                    transition-all duration-200
                    ${isActive ? 'bg-white/15' : 'hover:bg-white/10'}
                  `}
                >
                  <div className="relative w-12 h-12 flex-shrink-0 rounded-md overflow-hidden">
                    <img
                      src={image.srcMedium || image.srcTiny || image.src}
                      alt={image.alt}
                      loading="lazy"
                      className="w-full h-full object-cover"
                    />
                    {image.videoSrc && (
                      <div className="absolute top-1 left-1">
                        <Film size={10} className="text-white drop-shadow-lg" />
                      </div>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className={`text-sm truncate ${isActive ? 'text-white font-medium' : 'text-white/70'}`}>
                      {image.alt || image.filename.replace(/\.(jpg|jpeg|png|webp|heic)$/i, '')}
                    </p>
                    <p className="text-white/40 text-xs">
                      {i + 1} / {images.length}
                    </p>
                  </div>

                  {isActive && (
                    <div className="w-1.5 h-1.5 rounded-full bg-white flex-shrink-0 mr-2" />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
