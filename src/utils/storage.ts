/**
 * 安全地从 localStorage 获取数据。
 * 如果 localStorage 不可用或该项不存在，则返回默认值。
 * 
 * @param key要 获取的键名。
 * @param defaultValue 获取失败时返回的默认值。
 */
export function safeGetItem(key: string, defaultValue: string = ''): string {
  try {
    if (typeof window === 'undefined') return defaultValue;
    return localStorage.getItem(key) || defaultValue;
  } catch (error) {
    console.warn(`读取 localStorage 键 "${key}" 时出错:`, error);
    return defaultValue;
  }
}

/**
 * 安全地将数据设置到 localStorage。
 * 如果 localStorage 不可用，则静默失败。
 * 
 * @param key 要设置的键名。
 * @param value 要设置的值。
 */
export function safeSetItem(key: string, value: string): void {
  try {
    if (typeof window === 'undefined') return;
    localStorage.setItem(key, value);
  } catch (error) {
    console.warn(`设置 localStorage 键 "${key}" 时出错:`, error);
  }
}

