import { Router } from 'express';
import type { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { authMiddleware } from '../middleware/auth.js';
import {
  DEFAULT_SITE_SETTINGS,
  normalizeSiteSettings,
  type SiteSettings,
} from '../utils/siteSettings.js';

const router = Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = (() => {
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, 'package.json'))) return cwd;
  const isDistServer = __dirname.split(path.sep).includes('dist-server');
  return isDistServer
    ? path.resolve(__dirname, '..', '..', '..')
    : path.resolve(__dirname, '..', '..');
})();
const SETTINGS_FILE = path.join(PROJECT_ROOT, 'src', 'data', 'site-settings.json');

function readSiteSettings(): SiteSettings {
  if (!fs.existsSync(SETTINGS_FILE)) {
    return DEFAULT_SITE_SETTINGS;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) as Partial<SiteSettings>;
    return normalizeSiteSettings(parsed);
  } catch (error) {
    console.error('Failed to parse site settings:', error);
    return DEFAULT_SITE_SETTINGS;
  }
}

function writeSiteSettings(settings: SiteSettings): void {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function isValidAssetUrl(value: string): boolean {
  if (!value) return true;
  if (value.startsWith('/')) return true;
  if (value.startsWith('data:image/')) return true;

  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function parseSettingsBody(body: unknown): SiteSettings | null {
  if (!body || typeof body !== 'object') return null;
  const source = body as Record<string, unknown>;
  const siteTitle = typeof source.siteTitle === 'string' ? source.siteTitle.trim() : '';
  const galleryTitle = typeof source.galleryTitle === 'string' ? source.galleryTitle.trim() : '';
  const favicon = typeof source.favicon === 'string' ? source.favicon.trim() : '';

  if (!siteTitle || siteTitle.length > 80) return null;
  if (!galleryTitle || galleryTitle.length > 80) return null;
  if (favicon.length > 600 || !isValidAssetUrl(favicon)) return null;

  return normalizeSiteSettings({ siteTitle, galleryTitle, favicon });
}

router.get('/site', (_req: Request, res: Response): void => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.json({ settings: readSiteSettings() });
});

router.patch('/site', authMiddleware, (req: Request, res: Response): void => {
  const settings = parseSettingsBody(req.body);
  if (!settings) {
    res.status(400).json({ error: '站点设置格式无效' });
    return;
  }

  try {
    writeSiteSettings(settings);
    res.json({ success: true, settings });
  } catch (error) {
    console.error('Failed to write site settings:', error);
    res.status(500).json({ error: '保存站点设置失败' });
  }
});

export default router;
