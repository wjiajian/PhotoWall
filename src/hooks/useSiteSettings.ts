import { useEffect, useState } from 'react';
import {
  DEFAULT_SITE_SETTINGS,
  applyFavicon,
  normalizeSiteSettings,
  type SiteSettings,
} from '../utils/siteSettings';

export function useSiteSettings(): SiteSettings {
  const [settings, setSettings] = useState<SiteSettings>(DEFAULT_SITE_SETTINGS);

  useEffect(() => {
    let cancelled = false;

    const loadSettings = async () => {
      try {
        const response = await fetch('/api/settings/site', { cache: 'no-store' });
        if (!response.ok) return;
        const data = await response.json() as { settings?: Partial<SiteSettings> };
        if (cancelled) return;
        const nextSettings = normalizeSiteSettings(data.settings);
        setSettings(nextSettings);
        applyFavicon(nextSettings.favicon);
      } catch {
        // Keep defaults when the settings endpoint is unavailable.
      }
    };

    void loadSettings();

    return () => {
      cancelled = true;
    };
  }, []);

  return settings;
}
