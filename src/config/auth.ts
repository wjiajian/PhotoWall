export interface AuthConfig {
  adminUsername: string;
  adminPasswordHash: string;
  adminPassword: string;
  jwtSecret: string;
  isProduction: boolean;
}

const DEFAULT_ADMIN_USERNAME = 'admin';
const DEFAULT_ADMIN_PASSWORD = 'admin123';
const DEFAULT_JWT_SECRET = 'fallback-secret-change-in-production';

function isProductionEnv(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === 'production';
}

export function getAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const isProduction = isProductionEnv(env);
  const adminPasswordHash = env.ADMIN_PASSWORD_HASH || '';
  const jwtSecret = env.JWT_SECRET || (isProduction ? '' : DEFAULT_JWT_SECRET);

  return {
    adminUsername: env.ADMIN_USERNAME || DEFAULT_ADMIN_USERNAME,
    adminPasswordHash,
    adminPassword: isProduction ? '' : env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD,
    jwtSecret,
    isProduction,
  };
}

export function assertAuthConfig(env: NodeJS.ProcessEnv = process.env): void {
  const config = getAuthConfig(env);
  const missing: string[] = [];

  if (config.isProduction && !config.jwtSecret) {
    missing.push('JWT_SECRET');
  }
  if (config.isProduction && !config.adminPasswordHash) {
    missing.push('ADMIN_PASSWORD_HASH');
  }

  if (missing.length > 0) {
    throw new Error(`Missing required production auth config: ${missing.join(', ')}`);
  }
}
