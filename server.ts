import express, { type Express, type Request, type Response } from 'express';
import cors, { type CorsOptions } from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';

import authRoutes from './src/routes/auth.js';
import photosRoutes from './src/routes/photos.js';
import { assertAuthConfig } from './src/config/auth.js';

dotenv.config();
assertAuthConfig();

const app: Express = express();
const port = Number.parseInt(process.env.PORT || '3000', 10);

function getAllowedCorsOrigins(): Set<string> {
  const configured = (process.env.CORS_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (configured.length > 0) return new Set(configured);
  if (process.env.NODE_ENV === 'production') return new Set<string>();

  return new Set([
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ]);
}

const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    if (!origin) {
      callback(null, true);
      return;
    }

    callback(null, getAllowedCorsOrigins().has(origin));
  },
};

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = (() => {
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, 'package.json'))) return cwd;
  return path.resolve(__dirname, '..');
})();
const publicPath = path.join(PROJECT_ROOT, 'public');
const distPath = path.join(PROJECT_ROOT, 'dist');

if (fs.existsSync(publicPath)) {
  app.use(express.static(publicPath));
}
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
}

app.use('/api/auth', authRoutes);
app.use('/api/photos', photosRoutes);

app.use((req: Request, res: Response) => {
  if (req.path.startsWith('/api')) {
    res.status(404).json({ error: 'API not found' });
    return;
  }

  if (req.method === 'GET') {
    const indexPath = path.join(distPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
      return;
    }
    res.status(404).json({ error: 'Frontend build not found' });
    return;
  }

  res.status(404).json({ error: 'Not found' });
});

function startServer(): void {
  app.listen(port, () => {
    console.log(`[server]: PhotoWall is running at http://localhost:${port}`);
  });
}

startServer();
