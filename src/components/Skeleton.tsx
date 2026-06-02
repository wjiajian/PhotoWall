import React from 'react';

interface PhotoSkeletonProps {
  className?: string;
}

/**
 * 照片墙加载时的骨架屏组件。
 * 
 * @param className 可选的 CSS 类名
 */
export const PhotoSkeleton: React.FC<PhotoSkeletonProps> = ({ className = '' }) => {
  return (
    <div className={`break-inside-avoid mb-4 rounded-lg overflow-hidden ${className}`}>
      {/* 模拟图片占位，使用 pulsating 动画 */}
      <div className="w-full h-64 bg-gray-200 dark:bg-white/5 animate-pulse rounded-lg relative overflow-hidden">
         {/* 模拟底部元信息条 */}
         <div className="absolute bottom-0 left-0 right-0 h-8 bg-gray-300 dark:bg-white/10 opacity-50"></div>
      </div>
    </div>
  );
};

export const GallerySkeleton: React.FC<{ columns: number; count?: number }> = ({ columns, count = 12 }) => {
  // 根据列数计算 CSS
  const columnClass = {
    2: 'columns-2',
    3: 'columns-3',
    4: 'columns-4',
    5: 'columns-5',
  }[columns] || 'columns-4';

  return (
    <div className={`${columnClass} gap-4 space-y-4`}>
       {Array.from({ length: count }).map((_, i) => (
         <PhotoSkeleton key={i} />
       ))}
    </div>
  );
};
