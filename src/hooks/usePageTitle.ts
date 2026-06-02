import { useEffect } from 'react';
import { useSiteSettings } from './useSiteSettings';
import { applyFavicon, formatPageTitle } from '../utils/siteSettings';

export function usePageTitle(pageName?: string): void {
  const settings = useSiteSettings();

  useEffect(() => {
    document.title = formatPageTitle(pageName, settings.siteTitle);
    applyFavicon(settings.favicon);
  }, [pageName, settings.favicon, settings.siteTitle]);
}
