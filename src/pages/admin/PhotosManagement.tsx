import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  AlertCircle,
  CalendarDays,
  CheckCircle,
  Eye,
  EyeOff,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  Upload,
  X,
} from 'lucide-react';
import { authFetch } from '../../utils/auth';
import { resolvePhotoAssetPaths } from '../../utils/photoUrl';
import { usePageTitle } from '../../hooks/usePageTitle';

interface Photo {
  driveItemId?: string;
  filename: string;
  src: string;
  srcMedium?: string;
  srcTiny?: string;
  width?: number;
  height?: number;
  size?: number;
  date?: string;
  format?: string;
  isVisible?: boolean;
  visibilityUpdatedAt?: string | null;
}

interface ApiResult {
  success?: boolean;
  error?: string;
  message?: string;
  partial?: boolean;
  jobId?: string;
  status?: string;
  total?: number;
  job?: UploadJob;
  uploaded?: Array<{ filename: string; size: number; src: string }>;
  failed?: Array<{ filename: string; error: string }>;
}

interface UploadJob {
  jobId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  total: number;
  processed: number;
  uploaded: Array<{ filename: string; size?: number; src?: string }>;
  failed: Array<{ filename: string; error?: string }>;
  currentFilename: string | null;
  partial: boolean;
  message: string;
}

interface MonthGroup {
  monthKey: string;
  monthLabel: string;
  photos: Photo[];
  visibleCount: number;
}

const PHOTO_ASSET_BASE_URL = import.meta.env.VITE_OSS_PHOTOWALL_BASE_URL as string | undefined;
const UNKNOWN_MONTH_KEY = 'unknown';
const parsedMaxFilesPerBatch = Number.parseInt(import.meta.env.VITE_PHOTO_UPLOAD_MAX_FILES_PER_BATCH || '3', 10);
const MAX_FILES_PER_UPLOAD_BATCH = Number.isFinite(parsedMaxFilesPerBatch) && parsedMaxFilesPerBatch > 0
  ? parsedMaxFilesPerBatch
  : 3;
const RECOMMENDED_SINGLE_FILE_SIZE_MB = 5;
const parsedUploadBatchLimitMb = Number.parseInt(import.meta.env.VITE_PHOTO_UPLOAD_BATCH_MB || '30', 10);
const UPLOAD_BATCH_LIMIT_MB = Number.isFinite(parsedUploadBatchLimitMb) && parsedUploadBatchLimitMb > 0
  ? parsedUploadBatchLimitMb
  : 30;
const MAX_BATCH_BYTES = UPLOAD_BATCH_LIMIT_MB * 1024 * 1024;

function getPhotoKey(photo: Pick<Photo, 'filename' | 'driveItemId'>): string {
  if (photo.driveItemId) return `drive:${photo.driveItemId}`;
  return `file:${photo.filename}`;
}

function getMonthKey(date?: string): string {
  if (!date) return UNKNOWN_MONTH_KEY;
  const match = date.match(/^(\d{4}):(\d{2})/);
  if (!match) return UNKNOWN_MONTH_KEY;
  return `${match[1]}-${match[2]}`;
}

function getMonthLabel(monthKey: string): string {
  if (monthKey === UNKNOWN_MONTH_KEY) return '未知时间';
  const [year, month] = monthKey.split('-');
  return `${year}年${month}月`;
}

function compareMonthKeyDesc(a: string, b: string): number {
  if (a === UNKNOWN_MONTH_KEY && b === UNKNOWN_MONTH_KEY) return 0;
  if (a === UNKNOWN_MONTH_KEY) return 1;
  if (b === UNKNOWN_MONTH_KEY) return -1;
  return b.localeCompare(a);
}

function splitFilesIntoBatches(files: File[]): File[][] {
  const batches: File[][] = [];
  let currentBatch: File[] = [];
  let currentBytes = 0;

  for (const file of files) {
    const exceedsBatchFileCount = currentBatch.length >= MAX_FILES_PER_UPLOAD_BATCH;
    const exceedsBatchBytes = currentBatch.length > 0 && currentBytes + file.size > MAX_BATCH_BYTES;

    if (exceedsBatchFileCount || exceedsBatchBytes) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBytes = 0;
    }

    currentBatch.push(file);
    currentBytes += file.size;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    window.setTimeout(resolve, ms);
  });
}

/**
 * 照片管理页面（OSS 模式）
 * 按年月列出照片，并支持单张照片展示开关。
 */
export const PhotosManagement: React.FC = () => {
  usePageTitle('照片管理');
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [toggling, setToggling] = useState<Record<string, boolean>>({});
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const parseApiResponse = async (response: Response): Promise<ApiResult> => {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return response.json();
    }
    if (response.status === 413) {
      return { error: '上传请求过大（HTTP 413）。请减少单批上传数量，或在 Nginx 中调大 client_max_body_size。' };
    }
    const text = await response.text();
    if (text.includes('413 Request Entity Too Large')) {
      return { error: '上传请求过大（HTTP 413）。请减少单批上传数量，或在 Nginx 中调大 client_max_body_size。' };
    }
    return { error: text || `请求失败（HTTP ${response.status}）` };
  };

  const loadPhotos = async (silent = false) => {
    if (!silent) setIsLoading(true);
    setIsRefreshing(true);
    setError('');

    try {
      const response = await authFetch('/api/photos/metadata?includeHidden=1', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json() as { photos?: Photo[] };
      const resolvedPhotos = Array.isArray(data.photos)
        ? data.photos.map(photo => {
          const resolved = resolvePhotoAssetPaths(photo, PHOTO_ASSET_BASE_URL);
          return {
            ...resolved,
            isVisible: photo.isVisible !== false,
          };
        })
        : [];
      setPhotos(resolvedPhotos);
    } catch {
      setError('加载照片列表失败');
    } finally {
      if (!silent) setIsLoading(false);
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    void loadPhotos(false);
  }, []);

  const monthGroups = useMemo<MonthGroup[]>(() => {
    const groupMap = new Map<string, Photo[]>();

    for (const photo of photos) {
      const monthKey = getMonthKey(photo.date);
      if (!groupMap.has(monthKey)) {
        groupMap.set(monthKey, []);
      }
      groupMap.get(monthKey)?.push(photo);
    }

    const groups = Array.from(groupMap.entries())
      .sort(([a], [b]) => compareMonthKeyDesc(a, b))
      .map(([monthKey, groupPhotos]) => {
        const sortedPhotos = [...groupPhotos].sort((a, b) => {
          if (a.date && b.date) return b.date.localeCompare(a.date);
          return a.filename.localeCompare(b.filename, 'zh-CN');
        });
        return {
          monthKey,
          monthLabel: getMonthLabel(monthKey),
          photos: sortedPhotos,
          visibleCount: sortedPhotos.filter(photo => photo.isVisible !== false).length,
        };
      });

    return groups;
  }, [photos]);

  const totalCount = photos.length;
  const visibleCount = photos.filter(photo => photo.isVisible !== false).length;
  const hiddenCount = totalCount - visibleCount;

  const handleUpload = async () => {
    if (selectedFiles.length === 0) {
      setError('请先选择要上传的图片');
      return;
    }

    setIsUploading(true);
    setError('');
    setSuccess('');

    try {
      const batches = splitFilesIntoBatches(selectedFiles);
      let uploadedCount = 0;
      const failedItems: Array<{ filename: string; error: string }> = [];

      const waitForUploadJob = async (jobId: string, batchIndex: number, batchTotal: number): Promise<UploadJob> => {
        for (;;) {
          const response = await authFetch(`/api/photos/upload-jobs/${encodeURIComponent(jobId)}`, {
            cache: 'no-store',
          });
          const data = await parseApiResponse(response);

          if (!response.ok || !data.success || !data.job) {
            throw new Error(data.error || `第 ${batchIndex + 1} 批状态查询失败`);
          }

          const job = data.job;
          const current = job.currentFilename ? `：${job.currentFilename}` : '';
          setSuccess(`正在处理第 ${batchIndex + 1}/${batchTotal} 批，进度 ${job.processed}/${job.total}${current}`);

          if (job.status === 'completed' || job.status === 'failed') {
            return job;
          }

          await sleep(1500);
        }
      };

      for (let index = 0; index < batches.length; index += 1) {
        const batch = batches[index];
        setSuccess(`正在提交第 ${index + 1}/${batches.length} 批（${batch.length} 张）...`);

        const formData = new FormData();
        for (const file of batch) {
          formData.append('photos', file);
        }

        const response = await authFetch('/api/photos/upload', {
          method: 'POST',
          body: formData,
        });
        const data = await parseApiResponse(response);

        if (response.status === 413) {
          setError(`第 ${index + 1} 批上传失败：请求体过大（HTTP 413）。请在 Nginx 中调大 client_max_body_size。`);
          return;
        }
        if (!response.ok || !data.success) {
          setError(data.error || `第 ${index + 1} 批上传失败`);
          return;
        }

        if (!data.jobId) {
          setError(`第 ${index + 1} 批上传失败：未返回任务编号`);
          return;
        }

        const job = await waitForUploadJob(data.jobId, index, batches.length);
        uploadedCount += job.uploaded.length;
        if (job.failed.length > 0) {
          failedItems.push(...job.failed.map(item => ({
            filename: item.filename,
            error: item.error || '上传失败',
          })));
        }

        if (job.status === 'failed' && job.uploaded.length === 0) {
          setError(job.message || `第 ${index + 1} 批上传失败`);
          return;
        }
      }

      if (uploadedCount === 0) {
        setError('上传照片失败');
        return;
      }

      const failedCount = failedItems.length;
      if (failedCount > 0) {
        setSuccess(`上传完成：成功 ${uploadedCount} 张，失败 ${failedCount} 张`);
        setError(`部分文件上传失败：${failedItems[0].filename}（${failedItems[0].error}）`);
      } else {
        setSuccess(`上传完成：成功 ${uploadedCount} 张`);
      }

      setSelectedFiles([]);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      await loadPhotos(true);
    } catch {
      setError('上传照片失败');
    } finally {
      setIsUploading(false);
    }
  };

  const handleProcess = async () => {
    setIsProcessing(true);
    setError('');
    setSuccess('');

    try {
      const response = await authFetch('/api/photos/process', {
        method: 'POST',
      });
      const data = await parseApiResponse(response);
      if (!response.ok || !data.success) {
        setError(data.error || '处理照片失败');
        return;
      }

      setSuccess(data.message || '照片处理已完成');
      await loadPhotos(true);
    } catch {
      setError('处理照片失败');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleToggleVisibility = async (photo: Photo, nextVisible: boolean) => {
    const photoKey = getPhotoKey(photo);
    setToggling(prev => ({ ...prev, [photoKey]: true }));
    setError('');
    setSuccess('');

    try {
      const response = await authFetch('/api/photos/visibility', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: photo.filename,
          driveItemId: photo.driveItemId,
          isVisible: nextVisible,
        }),
      });

      const data = await parseApiResponse(response);
      if (!response.ok || !data.success) {
        setError(data.error || '更新展示状态失败');
        return;
      }

      setPhotos(prev => prev.map(item => {
        if (getPhotoKey(item) !== photoKey) return item;
        return {
          ...item,
          isVisible: nextVisible,
          visibilityUpdatedAt: new Date().toISOString(),
        };
      }));
      setSuccess(nextVisible ? '已设置为展示' : '已设置为隐藏');
    } catch {
      setError('更新展示状态失败');
    } finally {
      setToggling(prev => ({ ...prev, [photoKey]: false }));
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">照片墙展示管理</h1>
          <p className="text-gray-500 mt-1">OSS 上传模式：支持上传图片并管理展示状态</p>
        </div>
        <button
          onClick={() => void loadPhotos(true)}
          disabled={isRefreshing || isUploading || isProcessing}
          className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 rounded-xl transition-colors disabled:opacity-50 shadow-sm"
        >
          {isRefreshing ? <Loader2 size={18} className="animate-spin" /> : <RefreshCw size={18} />}
          刷新列表
        </button>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 p-4 shadow-sm mb-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex-1">
            <p className="text-sm text-gray-700 mb-2">上传照片到 OSS（支持批量）</p>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,.heic,.heif"
              onChange={event => {
                const files = event.target.files ? Array.from(event.target.files) : [];
                setSelectedFiles(files);
              }}
              className="block w-full text-sm text-gray-500 file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border-0 file:bg-gray-100 file:text-gray-700 hover:file:bg-gray-200"
            />
            <p className="text-xs text-gray-400 mt-2">
              已选择 {selectedFiles.length} 张，系统会自动分批上传（每批最多 {MAX_FILES_PER_UPLOAD_BATCH} 张，总计最多 {UPLOAD_BATCH_LIMIT_MB}MB）
            </p>
            <p className="text-xs text-gray-400 mt-1">
              自动分批规则：每批最多 {MAX_FILES_PER_UPLOAD_BATCH} 张、总计最多 {UPLOAD_BATCH_LIMIT_MB}MB；单张图片建议尽量控制在 {RECOMMENDED_SINGLE_FILE_SIZE_MB}MB 内，体验更好。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void handleUpload()}
              disabled={selectedFiles.length === 0 || isUploading || isProcessing}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {isUploading ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
              上传照片
            </button>
            <button
              onClick={() => void handleProcess()}
              disabled={isUploading || isProcessing}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              {isProcessing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
              处理照片
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <p className="text-sm text-gray-500">总照片数</p>
          <p className="text-2xl font-bold text-gray-800 mt-1">{totalCount}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <p className="text-sm text-gray-500">展示中</p>
          <p className="text-2xl font-bold text-emerald-600 mt-1">{visibleCount}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <p className="text-sm text-gray-500">已隐藏</p>
          <p className="text-2xl font-bold text-gray-600 mt-1">{hiddenCount}</p>
        </div>
      </div>

      {error && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl flex items-center justify-between"
        >
          <div className="flex items-center gap-3">
            <AlertCircle size={20} className="text-red-500" />
            <span className="text-red-600">{error}</span>
          </div>
          <button onClick={() => setError('')} className="text-red-400 hover:text-red-600">
            <X size={18} />
          </button>
        </motion.div>
      )}

      {success && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-6 p-4 bg-green-50 border border-green-200 rounded-xl flex items-center justify-between"
        >
          <div className="flex items-center gap-3">
            <CheckCircle size={20} className="text-green-500" />
            <span className="text-green-600">{success}</span>
          </div>
          <button onClick={() => setSuccess('')} className="text-green-400 hover:text-green-600">
            <X size={18} />
          </button>
        </motion.div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 size={32} className="animate-spin text-blue-500" />
        </div>
      ) : monthGroups.length === 0 ? (
        <div className="text-center py-16 text-gray-400 bg-white rounded-2xl border border-gray-200">
          <ImageIcon size={48} className="mx-auto mb-4 opacity-50" />
          <p>暂无照片</p>
        </div>
      ) : (
        <div className="space-y-8">
          {monthGroups.map(group => (
            <section key={group.monthKey} className="bg-white rounded-2xl border border-gray-200 p-4 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                <div className="flex items-center gap-2 text-gray-800">
                  <CalendarDays size={18} />
                  <h2 className="text-lg font-semibold">{group.monthLabel}</h2>
                </div>
                <p className="text-sm text-gray-500">
                  共 {group.photos.length} 张，展示 {group.visibleCount} 张
                </p>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                {group.photos.map(photo => {
                  const photoKey = getPhotoKey(photo);
                  const isVisible = photo.isVisible !== false;
                  const isToggling = toggling[photoKey] === true;
                  return (
                    <article
                      key={photoKey}
                      className={`rounded-xl overflow-hidden border shadow-sm ${
                        isVisible ? 'border-emerald-200 bg-white' : 'border-gray-200 bg-gray-50'
                      }`}
                    >
                      <img
                        src={photo.srcMedium || photo.srcTiny || photo.src}
                        alt={photo.filename}
                        className="w-full aspect-square object-cover"
                        loading="lazy"
                      />
                      <div className="p-3">
                        <p className="text-xs text-gray-600 truncate" title={photo.filename}>
                          {photo.filename}
                        </p>
                        <p className="text-[11px] text-gray-400 mt-1 truncate">
                          {photo.date || '未知拍摄时间'}
                        </p>
                        <button
                          onClick={() => void handleToggleVisibility(photo, !isVisible)}
                          disabled={isToggling}
                          className={`mt-3 w-full inline-flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs rounded-lg transition-colors disabled:opacity-50 ${
                            isVisible
                              ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                              : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                          }`}
                        >
                          {isToggling ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : isVisible ? (
                            <Eye size={14} />
                          ) : (
                            <EyeOff size={14} />
                          )}
                          {isVisible ? '展示中（点击隐藏）' : '已隐藏（点击展示）'}
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
};
