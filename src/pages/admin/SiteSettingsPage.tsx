import React, { useEffect, useState } from 'react';
import { CheckCircle, Globe, Image as ImageIcon, Loader2, Save, Type, XCircle } from 'lucide-react';
import { usePageTitle } from '../../hooks/usePageTitle';
import { authFetch } from '../../utils/auth';
import {
  DEFAULT_SITE_SETTINGS,
  applyFavicon,
  normalizeSiteSettings,
  type SiteSettings,
} from '../../utils/siteSettings';

interface SiteSettingsApiResult {
  success?: boolean;
  error?: string;
  settings?: Partial<SiteSettings>;
}

export const SiteSettingsPage: React.FC = () => {
  usePageTitle('站点设置');
  const [settings, setSettings] = useState<SiteSettings>(DEFAULT_SITE_SETTINGS);
  const [initialSettings, setInitialSettings] = useState<SiteSettings>(DEFAULT_SITE_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const hasChanges = JSON.stringify(settings) !== JSON.stringify(initialSettings);

  useEffect(() => {
    let cancelled = false;

    const loadSettings = async () => {
      setIsLoading(true);
      setError('');

      try {
        const response = await fetch('/api/settings/site', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as SiteSettingsApiResult;
        if (cancelled) return;
        const nextSettings = normalizeSiteSettings(data.settings);
        setSettings(nextSettings);
        setInitialSettings(nextSettings);
        applyFavicon(nextSettings.favicon);
      } catch {
        if (!cancelled) {
          setError('加载站点设置失败');
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void loadSettings();

    return () => {
      cancelled = true;
    };
  }, []);

  const updateField = (field: keyof SiteSettings, value: string) => {
    setSettings(prev => ({ ...prev, [field]: value }));
    setSuccess('');
    setError('');
  };

  const handleSave = async () => {
    setIsSaving(true);
    setError('');
    setSuccess('');

    try {
      const response = await authFetch('/api/settings/site', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const data = await response.json() as SiteSettingsApiResult;

      if (!response.ok || !data.success) {
        throw new Error(data.error || '保存失败');
      }

      const nextSettings = normalizeSiteSettings(data.settings);
      setSettings(nextSettings);
      setInitialSettings(nextSettings);
      document.title = `站点设置 | ${nextSettings.siteTitle}`;
      applyFavicon(nextSettings.favicon);
      setSuccess('站点设置已保存');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存站点设置失败');
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = () => {
    setSettings(initialSettings);
    setSuccess('');
    setError('');
  };

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <p className="text-sm text-gray-500">Site Settings</p>
        <h1 className="text-3xl font-bold text-gray-900 mt-1">站点设置</h1>
        <p className="mt-2 text-gray-500">设置照片墙的浏览器标题、页面标题和网站图标。</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="rounded-2xl border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-100 px-6 py-4">
            <h2 className="text-lg font-semibold text-gray-900">基础信息</h2>
          </div>

          {isLoading ? (
            <div className="flex min-h-[280px] items-center justify-center text-gray-400">
              <Loader2 size={22} className="animate-spin mr-2" />
              正在加载设置
            </div>
          ) : (
            <div className="space-y-5 p-6">
              <label className="block">
                <span className="mb-2 flex items-center gap-2 text-sm font-medium text-gray-700">
                  <Globe size={16} />
                  浏览器标题
                </span>
                <input
                  value={settings.siteTitle}
                  maxLength={80}
                  onChange={(event) => updateField('siteTitle', event.target.value)}
                  className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-gray-900 outline-none transition focus:border-blue-400 focus:ring-4 focus:ring-blue-50"
                  placeholder="PhotoWall"
                />
                <span className="mt-1 block text-xs text-gray-400">会用于浏览器标签页标题，例如「照片墙 | 你的标题」。</span>
              </label>

              <label className="block">
                <span className="mb-2 flex items-center gap-2 text-sm font-medium text-gray-700">
                  <Type size={16} />
                  页面标题
                </span>
                <input
                  value={settings.galleryTitle}
                  maxLength={80}
                  onChange={(event) => updateField('galleryTitle', event.target.value)}
                  className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-gray-900 outline-none transition focus:border-blue-400 focus:ring-4 focus:ring-blue-50"
                  placeholder="Photo Wall"
                />
                <span className="mt-1 block text-xs text-gray-400">会显示在照片墙页面顶部。</span>
              </label>

              <label className="block">
                <span className="mb-2 flex items-center gap-2 text-sm font-medium text-gray-700">
                  <ImageIcon size={16} />
                  网站图标 URL
                </span>
                <input
                  value={settings.favicon}
                  maxLength={600}
                  onChange={(event) => updateField('favicon', event.target.value)}
                  className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-gray-900 outline-none transition focus:border-blue-400 focus:ring-4 focus:ring-blue-50"
                  placeholder="https://example.domain/favicon.png"
                />
                <span className="mt-1 block text-xs text-gray-400">支持 https 链接、以 / 开头的站内路径，或 data:image。</span>
              </label>

              {error && (
                <div className="flex items-center gap-2 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
                  <XCircle size={17} />
                  {error}
                </div>
              )}

              {success && (
                <div className="flex items-center gap-2 rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                  <CheckCircle size={17} />
                  {success}
                </div>
              )}

              <div className="flex flex-wrap justify-end gap-3 pt-2">
                <button
                  onClick={handleReset}
                  disabled={!hasChanges || isSaving}
                  className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  撤销更改
                </button>
                <button
                  onClick={handleSave}
                  disabled={!hasChanges || isSaving}
                  className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isSaving ? <Loader2 size={17} className="animate-spin" /> : <Save size={17} />}
                  保存设置
                </button>
              </div>
            </div>
          )}
        </section>

        <aside className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-gray-900">预览</h2>
          <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-4">
            <div className="flex items-center gap-3">
              <div className="flex size-11 items-center justify-center overflow-hidden rounded-xl border border-gray-200 bg-white">
                {settings.favicon ? (
                  <img
                    src={settings.favicon}
                    alt=""
                    className="size-full object-cover"
                    onError={(event) => {
                      event.currentTarget.style.display = 'none';
                    }}
                  />
                ) : (
                  <ImageIcon size={20} className="text-gray-400" />
                )}
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-gray-900">{settings.galleryTitle || 'Photo Wall'}</p>
                <p className="truncate text-xs text-gray-500">{settings.siteTitle || 'PhotoWall'}</p>
              </div>
            </div>
          </div>
          <p className="mt-4 text-xs leading-6 text-gray-500">
            保存后前台刷新即可看到新标题和图标。Docker 部署下设置会写入挂载目录里的 `site-settings.json`。
          </p>
        </aside>
      </div>
    </div>
  );
};
