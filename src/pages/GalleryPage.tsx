import React, { useState, useMemo, useEffect } from 'react';
import { motion } from 'framer-motion';
import { PhotoWall } from '../components/PhotoWall';
import type { PhotoItem } from '../components/PhotoWall';
import { ArrowLeft, Grid3X3, LayoutGrid, Rows3, Film, Sun, Moon, Filter, X } from 'lucide-react';

import type { ImageMetadata } from '../types';

import { resolvePhotoAssetPaths } from '../utils/photoUrl';

import { getGalleryTheme } from '../utils/theme';

import { useDebouncedCallback } from '../hooks/useDebounce';
import { useIsMobile } from '../hooks/useIsMobile';
import { useThemeMode } from '../hooks/useThemeMode';
import { usePageTitle } from '../hooks/usePageTitle';
import { GallerySkeleton } from '../components/Skeleton';

const PHOTO_ASSET_BASE_URL = import.meta.env.VITE_OSS_PHOTOWALL_BASE_URL as string | undefined;
const ALL_YEARS = 'all';
const ALL_MONTHS = 'all';

function getPhotoDateParts(date?: string): { year: string; month: string; monthKey: string } | null {
  if (!date) return null;

  const colonMatch = date.match(/^(\d{4}):(\d{2})/);
  if (colonMatch) {
    return {
      year: colonMatch[1],
      month: colonMatch[2],
      monthKey: `${colonMatch[1]}-${colonMatch[2]}`,
    };
  }

  const isoMatch = date.match(/^(\d{4})-(\d{2})/);
  if (isoMatch) {
    return {
      year: isoMatch[1],
      month: isoMatch[2],
      monthKey: `${isoMatch[1]}-${isoMatch[2]}`,
    };
  }

  return null;
}

function formatMonthLabel(monthKey: string): string {
  const [year, month] = monthKey.split('-');
  return `${year}年${month}月`;
}

export const GalleryPage: React.FC = () => {
  const isMobile = useIsMobile();
  const [columns, setColumns] = useState(4);
  const [isLoading, setIsLoading] = useState(true);
  const [metadata, setMetadata] = useState<ImageMetadata[]>([]);
  const [selectedYear, setSelectedYear] = useState(ALL_YEARS);
  const [selectedMonth, setSelectedMonth] = useState(ALL_MONTHS);
  const [liveOnly, setLiveOnly] = useState(false);
  const { darkMode, toggleDarkMode } = useThemeMode();
  usePageTitle('照片墙');

  // 解析图片列表
  const images = useMemo<PhotoItem[]>(() => {
    const result = metadata
      .filter(meta => meta.isVisible !== false)
      .map((meta) => {
      const resolved = resolvePhotoAssetPaths(meta, PHOTO_ASSET_BASE_URL);
      const filename = meta.filename;
      const baseName = filename.replace(/\.(jpg|jpeg|png|webp|heic|heif)$/i, '');
      
      return {
        src: resolved.src,
        srcMedium: resolved.srcMedium,
        srcTiny: resolved.srcTiny,
        alt: baseName.replace(/[-_]/g, ' '),
        filename,
        format: meta.format,
        width: meta.width,
        height: meta.height,
        size: meta.size,
        videoSrc: resolved.videoSrc,
        date: meta.date,
      };
      });
    
    // 按日期降序排序（最新优先）
    return result.sort((a, b) => {
      if (a.date && b.date) {
        return b.date.localeCompare(a.date);
      }
      return a.filename.localeCompare(b.filename, 'zh-CN');
    });
  }, [metadata]);

  // 统计实况照片数量
  const livePhotoCount = useMemo(() => {
    return images.filter(img => img.videoSrc).length;
  }, [images]);

  const yearOptions = useMemo(() => {
    return Array.from(new Set(
      images
        .map((image) => getPhotoDateParts(image.date)?.year)
        .filter((year): year is string => Boolean(year))
    )).sort((a, b) => b.localeCompare(a));
  }, [images]);

  const monthOptions = useMemo(() => {
    return Array.from(new Set(
      images
        .filter((image) => {
          const parts = getPhotoDateParts(image.date);
          return parts && (selectedYear === ALL_YEARS || parts.year === selectedYear);
        })
        .map((image) => getPhotoDateParts(image.date)?.monthKey)
        .filter((monthKey): monthKey is string => Boolean(monthKey))
    )).sort((a, b) => b.localeCompare(a));
  }, [images, selectedYear]);

  useEffect(() => {
    if (selectedMonth !== ALL_MONTHS && !monthOptions.includes(selectedMonth)) {
      setSelectedMonth(ALL_MONTHS);
    }
  }, [monthOptions, selectedMonth]);

  const filteredImages = useMemo(() => {
    return images.filter((image) => {
      const parts = getPhotoDateParts(image.date);
      const matchesYear = selectedYear === ALL_YEARS || parts?.year === selectedYear;
      const matchesMonth = selectedMonth === ALL_MONTHS || parts?.monthKey === selectedMonth;
      const matchesLive = !liveOnly || Boolean(image.videoSrc);
      return matchesYear && matchesMonth && matchesLive;
    });
  }, [images, liveOnly, selectedMonth, selectedYear]);

  const hasActiveFilters = selectedYear !== ALL_YEARS || selectedMonth !== ALL_MONTHS || liveOnly;
  const filteredLivePhotoCount = useMemo(() => {
    return filteredImages.filter((image) => image.videoSrc).length;
  }, [filteredImages]);

  const clearFilters = () => {
    setSelectedYear(ALL_YEARS);
    setSelectedMonth(ALL_MONTHS);
    setLiveOnly(false);
  };

  useEffect(() => {
    let cancelled = false;

    const loadMetadata = async () => {
      setIsLoading(true);
      try {
        const response = await fetch('/api/photos/metadata', { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = await response.json();
        if (!cancelled && Array.isArray(data.photos)) {
          setMetadata(data.photos as ImageMetadata[]);
        }
      } catch {
        // API 不可用时保持空列表，避免依赖未纳入 git 的运行时 metadata 文件
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    loadMetadata();

    return () => {
      cancelled = true;
    };
  }, []);

  // 响应式列数 - 使用防抖
  // 移动端强制 1 列布局，平板和桌面端需要更多列数
  const handleResize = useDebouncedCallback(() => {
    const width = window.innerWidth;
    if (width < 768) setColumns(1);  // 移动端：1 列
    else if (width < 1024) setColumns(2); // 平板：2 列
    else if (width < 1536) setColumns(4); // 桌面：4 列
    else setColumns(5); // 大屏：5 列
  }, 200);

  useEffect(() => {
    // 初始化列数
    handleResize(); 
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [handleResize]);

  // 主题样式
  const theme = getGalleryTheme(darkMode);

  return (
    <div className={`min-h-screen ${theme.page}`}>
      {/* 头部 */}
      <header className={`sticky top-0 z-40 backdrop-blur-xl border-b ${theme.header}`}>
        <div className="max-w-[1800px] mx-auto px-4 sm:px-6 py-4">
          <div className="flex items-center justify-between">
            {/* 返回按钮 */}
            <a 
              href="/"
              className={`flex items-center gap-2 transition-colors group ${theme.backLink}`}
            >
              <ArrowLeft size={20} className="group-hover:-translate-x-1 transition-transform" />
              <span className="font-medium">返回首页</span>
            </a>

            {/* 标题 - 移动端居中显示 */}
            <h1 className={`text-xl font-bold tracking-tight ${isMobile ? 'absolute left-1/2 -translate-x-1/2' : ''}`}>
              Photo Wall
            </h1>

            {/* 右侧控制区 */}
            <div className="flex items-center gap-3">
              {/* 主题切换按钮 */}
              <button
                onClick={toggleDarkMode}
                className={`p-2 rounded-lg transition-colors cursor-pointer ${theme.controlBg} hover:opacity-80`}
                title={darkMode ? '切换到亮色主题' : '切换到暗色主题'}
              >
                {darkMode ? (
                  <Sun size={18} className="text-yellow-400" />
                ) : (
                  <Moon size={18} className="text-gray-600" />
                )}
              </button>

              {/* 列数控制 - 移动端隐藏（固定 1 列） */}
              {!isMobile && (
                <div className={`flex items-center gap-2 rounded-lg p-1 ${theme.controlBg}`}>
                  <button
                    onClick={() => setColumns(2)}
                    className={`p-2 rounded transition-colors cursor-pointer ${theme.controlBtn(columns === 2)}`}
                    title="2 列"
                  >
                    <Rows3 size={18} />
                  </button>
                  <button
                    onClick={() => setColumns(4)}
                    className={`p-2 rounded transition-colors cursor-pointer ${theme.controlBtn(columns === 4)}`}
                    title="4 列"
                  >
                    <LayoutGrid size={18} />
                  </button>
                  <button
                    onClick={() => setColumns(5)}
                    className={`p-2 rounded transition-colors cursor-pointer ${theme.controlBtn(columns === 5)}`}
                    title="5 列"
                  >
                    <Grid3X3 size={18} />
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* 主内容 */}
      <main className="max-w-[1800px] mx-auto px-4 sm:px-6 py-8">
        {/* 统计信息 */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-5 flex flex-wrap items-center gap-4"
        >
          <p className={`text-sm ${theme.stats}`}>
            {hasActiveFilters ? '筛选出' : '共'} <span className={`font-medium ${theme.statsHighlight}`}>{filteredImages.length}</span>
            {hasActiveFilters && <span> / {images.length}</span>} 张照片
          </p>
          {(hasActiveFilters ? filteredLivePhotoCount : livePhotoCount) > 0 && (
            <div className={`flex items-center gap-1 text-sm ${theme.stats}`}>
              <Film size={14} />
              <span><span className={`font-medium ${theme.statsHighlight}`}>{hasActiveFilters ? filteredLivePhotoCount : livePhotoCount}</span> 张实况照片</span>
            </div>
          )}
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className={`mb-8 rounded-2xl border p-4 backdrop-blur-xl ${
            darkMode ? 'border-white/10 bg-white/5' : 'border-gray-200 bg-white/80'
          }`}
        >
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className={`flex items-center gap-2 text-sm font-medium ${darkMode ? 'text-white/75' : 'text-gray-700'}`}>
              <Filter size={16} />
              筛选
            </div>

            <div className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-3">
              <select
                value={selectedYear}
                onChange={(event) => {
                  setSelectedYear(event.target.value);
                  setSelectedMonth(ALL_MONTHS);
                }}
                className={`rounded-xl border px-3 py-2 text-sm outline-none ${
                  darkMode ? 'border-white/10 bg-black/20 text-white' : 'border-gray-200 bg-white text-gray-700'
                }`}
              >
                <option value={ALL_YEARS}>全部年份</option>
                {yearOptions.map((year) => (
                  <option key={year} value={year}>{year}年</option>
                ))}
              </select>

              <select
                value={selectedMonth}
                onChange={(event) => setSelectedMonth(event.target.value)}
                className={`rounded-xl border px-3 py-2 text-sm outline-none ${
                  darkMode ? 'border-white/10 bg-black/20 text-white' : 'border-gray-200 bg-white text-gray-700'
                }`}
              >
                <option value={ALL_MONTHS}>全部月份</option>
                {monthOptions.map((monthKey) => (
                  <option key={monthKey} value={monthKey}>{formatMonthLabel(monthKey)}</option>
                ))}
              </select>

              <button
                onClick={() => setLiveOnly((prev) => !prev)}
                className={`inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition-colors ${
                  liveOnly
                    ? darkMode
                      ? 'border-cyan-300/40 bg-cyan-300/15 text-cyan-200'
                      : 'border-cyan-700/30 bg-cyan-50 text-cyan-800'
                    : darkMode
                      ? 'border-white/10 bg-black/20 text-white/65 hover:text-white'
                      : 'border-gray-200 bg-white text-gray-600 hover:text-gray-900'
                }`}
              >
                <Film size={15} />
                只看实况
              </button>
            </div>

            {hasActiveFilters && (
              <button
                onClick={clearFilters}
                className={`inline-flex items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-sm transition-colors ${
                  darkMode ? 'text-white/55 hover:bg-white/10 hover:text-white' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900'
                }`}
              >
                <X size={15} />
                清除
              </button>
            )}
          </div>
        </motion.div>

        {/* 照片墙 */}
        {isLoading ? (
          <GallerySkeleton columns={columns} />
        ) : filteredImages.length === 0 ? (
          <div className={`flex min-h-[320px] flex-col items-center justify-center rounded-2xl border ${
            darkMode ? 'border-white/10 bg-white/5 text-white/45' : 'border-gray-200 bg-white/70 text-gray-400'
          }`}>
            <Filter size={34} className="mb-3" />
            <p>当前筛选下暂无照片</p>
          </div>
        ) : (
          <PhotoWall images={filteredImages} columns={columns} />
        )}

      </main>

      {/* 页脚 */}
      <footer className={`border-t py-8 mt-16 ${theme.footer}`}>
        <div className="max-w-[1800px] mx-auto px-4 sm:px-6 text-center">
          <p className={`text-sm ${theme.footerText}`}>
            按 <kbd className={`px-2 py-1 rounded text-xs ${theme.kbd}`}>Esc</kbd> 关闭预览，
            使用 <kbd className={`px-2 py-1 rounded text-xs ${theme.kbd}`}>←</kbd> <kbd className={`px-2 py-1 rounded text-xs ${theme.kbd}`}>→</kbd> 切换图片
          </p>
          <p className={`text-xs mt-3 ${theme.footerText}`}>
            <a
              href="https://icp.gov.moe/?keyword=20260255"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
            >
              萌ICP备20260255号
            </a>
          </p>
          {livePhotoCount > 0 && (
            <p className={`text-xs mt-2 ${darkMode ? 'text-white/30' : 'text-gray-400'}`}>
              悬停在 <span className="inline-flex items-center gap-1"><Film size={10} /> LIVE</span> 标记的图片上可预览实况照片
            </p>
          )}
        </div>
      </footer>
    </div>
  );
};
