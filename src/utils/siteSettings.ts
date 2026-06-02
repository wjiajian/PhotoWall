export interface SiteSettings {
  siteTitle: string;
  galleryTitle: string;
  favicon: string;
}

export const DEFAULT_SITE_SETTINGS: SiteSettings = {
  siteTitle: 'PhotoWall',
  galleryTitle: 'Photo Wall',
  favicon: '/resources/fangnai.jpg',
};

export function normalizeSiteSettings(input: Partial<SiteSettings> | null | undefined): SiteSettings {
  return {
    siteTitle: input?.siteTitle?.trim() || DEFAULT_SITE_SETTINGS.siteTitle,
    galleryTitle: input?.galleryTitle?.trim() || DEFAULT_SITE_SETTINGS.galleryTitle,
    favicon: input?.favicon?.trim() || DEFAULT_SITE_SETTINGS.favicon,
  };
}

export function formatPageTitle(pageName: string | undefined, siteTitle: string): string {
  const normalized = pageName?.trim();
  return normalized ? `${normalized} | ${siteTitle}` : siteTitle;
}

export function applyFavicon(favicon: string): void {
  const normalized = favicon.trim();
  if (!normalized) return;

  const existing = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  const link = existing || document.createElement('link');
  link.rel = 'icon';
  link.href = normalized;

  if (!existing) {
    document.head.appendChild(link);
  }
}
