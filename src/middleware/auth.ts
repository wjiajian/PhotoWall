import type { Request, Response, NextFunction } from 'express';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { getAuthConfig } from '../config/auth.js';

interface AuthRequest extends Request {
  user?: { username: string };
}

const getJwtSecret = (): string => {
  return getAuthConfig().jwtSecret;
};

/**
 * JWT 认证中间件
 * 验证请求头中的 Bearer token
 */
export const authMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const authReq = req as AuthRequest;
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: '未提供认证令牌' });
    return;
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token, getJwtSecret());
    if (typeof decoded !== 'object' || decoded === null) {
      res.status(401).json({ error: '无效或过期的令牌' });
      return;
    }

    const username = (decoded as JwtPayload).username;
    if (typeof username !== 'string') {
      res.status(401).json({ error: '无效或过期的令牌' });
      return;
    }

    authReq.user = { username };
    next();
  } catch {
    res.status(401).json({ error: '无效或过期的令牌' });
  }
};

/**
 * 生成 JWT token
 */
export const generateToken = (username: string): string => {
  return jwt.sign({ username }, getJwtSecret(), { expiresIn: '7d' });
};
