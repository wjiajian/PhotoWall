import { Router } from 'express';
import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { generateToken } from '../middleware/auth.js';
import { getAuthConfig } from '../config/auth.js';
import { createRateLimit } from '../middleware/rateLimit.js';

const router = Router();
const loginRateLimit = createRateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

/**
 * POST /api/auth/login
 * 管理员登录
 */
router.post('/login', loginRateLimit, async (req: Request, res: Response): Promise<void> => {
  const { username, password } = req.body;

  if (!username || !password) {
    res.status(400).json({ error: '用户名和密码不能为空' });
    return;
  }

  const authConfig = getAuthConfig();

  // 验证用户名
  if (username !== authConfig.adminUsername) {
    res.status(401).json({ error: '用户名或密码错误' });
    return;
  }

  // 验证密码
  // 如果未设置密码哈希，使用明文密码（仅供开发测试）
  let isValidPassword = false;
  
  if (authConfig.adminPasswordHash) {
    isValidPassword = await bcrypt.compare(password, authConfig.adminPasswordHash);
  } else if (!authConfig.isProduction) {
    // 开发模式：允许使用默认密码 "admin123"
    isValidPassword = password === authConfig.adminPassword;
  }

  if (!isValidPassword) {
    res.status(401).json({ error: '用户名或密码错误' });
    return;
  }

  // 生成 token
  const token = generateToken(username);
  res.json({ success: true, token });
});

/**
 * POST /api/auth/verify
 * 验证 token 有效性
 */
router.post('/verify', (req: Request, res: Response): void => {
  const { token } = req.body;

  if (!token) {
    res.status(400).json({ valid: false, error: '未提供令牌' });
    return;
  }

  try {
    const decoded = jwt.verify(token, getAuthConfig().jwtSecret);
    if (typeof decoded !== 'object' || decoded === null || !('username' in decoded)) {
      res.json({ valid: false, error: '令牌无效或已过期' });
      return;
    }
    const username = (decoded as JwtPayload).username;
    if (typeof username !== 'string') {
      res.json({ valid: false, error: '令牌无效或已过期' });
      return;
    }
    res.json({ valid: true, username });
  } catch {
    res.json({ valid: false, error: '令牌无效或已过期' });
  }
});

export default router;
