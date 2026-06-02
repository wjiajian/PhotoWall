import type { Request, Response, NextFunction } from 'express';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface RateLimitOptions {
  windowMs: number;
  max: number;
  message?: string;
}

const buckets = new Map<string, RateLimitEntry>();

function getClientIp(req: Request): string {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

export function createRateLimit(options: RateLimitOptions) {
  const message = options.message || '请求过于频繁，请稍后再试';

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const key = `${req.method}:${req.path}:${getClientIp(req)}`;
    const existing = buckets.get(key);

    if (!existing || existing.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }

    if (existing.count >= options.max) {
      res.status(429).json({ error: message });
      return;
    }

    existing.count += 1;
    next();
  };
}
