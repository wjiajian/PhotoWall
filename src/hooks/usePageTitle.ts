import { useEffect } from 'react';

export const SITE_TITLE = 'Jiajian PhotoWall';

export function formatPageTitle(pageName?: string): string {
  const normalized = pageName?.trim();
  return normalized ? `${normalized} | ${SITE_TITLE}` : SITE_TITLE;
}

export function usePageTitle(pageName?: string): void {
  useEffect(() => {
    document.title = formatPageTitle(pageName);
  }, [pageName]);
}
