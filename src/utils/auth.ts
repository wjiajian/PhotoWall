/**
 * 前端认证工具函数
 */

const TOKEN_KEY = 'admin_token';
const USERNAME_KEY = 'admin_username';

/**
 * 获取存储的 token
 */
export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * 保存 token
 */
export function setToken(token: string, username?: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    if (username) {
      localStorage.setItem(USERNAME_KEY, username);
    }
  } catch {
    console.error('Failed to save token');
  }
}

/**
 * 清除 token（退出登录）
 */
export function removeToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USERNAME_KEY);
  } catch {
    console.error('Failed to remove token');
  }
}

/**
 * 获取存储的用户名
 */
export function getUsername(): string | null {
  try {
    return localStorage.getItem(USERNAME_KEY);
  } catch {
    return null;
  }
}

/**
 * 检查是否已登录
 */
export function isAuthenticated(): boolean {
  return !!getToken();
}

/**
 * 创建带认证头的 fetch 请求
 */
export async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = getToken();
  
  const headers = new Headers(options.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  
  return fetch(url, {
    ...options,
    headers,
  });
}

/**
 * 验证 token 是否有效
 */
export async function verifyToken(): Promise<boolean> {
  const token = getToken();
  if (!token) return false;

  try {
    const response = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const data = await response.json();
    return data.valid === true;
  } catch {
    return false;
  }
}

/**
 * 登录
 */
export async function login(username: string, password: string): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    const data = await response.json();

    if (data.success && data.token) {
      setToken(data.token, username);
      return { success: true };
    }

    return { success: false, error: data.error || '登录失败' };
  } catch {
    return { success: false, error: '网络错误，请稍后重试' };
  }
}

/**
 * 退出登录
 */
export function logout(): void {
  removeToken();
}
