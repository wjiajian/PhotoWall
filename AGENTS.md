# Repository Guidelines

## Project Overview

PhotoWall is a personal photo gallery and admin console. The frontend is React 19 + Vite + TypeScript + Tailwind, and the backend is an Express 5 server in `server.ts`. Media is stored in Aliyun OSS; mutable app state is kept in JSON files under `src/data`.

Key routes:

- `/`: public photo wall.
- `/admin/login`: admin login.
- `/admin/photos`: upload, queue progress, visibility management, deletion.
- `/admin/settings`: site title, gallery title, favicon.
- `/api/auth/*`, `/api/photos/*`, `/api/settings/*`: Express APIs.

## Setup and Commands

- Install dependencies: `npm install`
- Frontend dev server: `npm run dev`
- Backend dev server: `npm run start`
- Frontend build/typecheck: `npm run build`
- Backend build: `npm run build:server`
- Lint: `npm run lint`
- Preview built frontend: `npm run preview`
- Rebuild metadata from OSS: `npm run rebuild-oss-metadata`

During local development, Vite runs on port `5173` and proxies `/api` to the Express server on port `3000`, so both `npm run dev` and `npm run start` are usually needed for full app behavior.

## Architecture Notes

- Frontend entry: `src/main.tsx`.
- Public gallery components live in `src/components/PhotoWall`.
- Admin pages live in `src/pages/admin`.
- Express routes live in `src/routes`; shared backend auth/rate-limit logic lives in `src/middleware` and `src/config`.
- OSS upload, image conversion, thumbnail generation, and upload queue logic live in `src/services/photoMedia.ts` and `src/services/photoUploadQueue.ts`.
- Shared URL/path helpers live in `src/utils/photoUrl.ts` and `src/utils/siteSettings.ts`.
- Supported photo extensions are defined in `shared/photo-extensions.cjs` and consumed from ESM with `createRequire`.

The backend is compiled with `moduleResolution: "NodeNext"`, so TypeScript source imports server-side local modules with `.js` extensions. Preserve that pattern.

## Data and Environment

- Do not commit `.env`; use `.env.example` as the template.
- `src/data/images-metadata.json` is generated runtime state and is ignored by git.
- `src/data/site-settings.json` may be created or updated at runtime in deployments.
- OSS public URL variables usually need both server and frontend forms: `OSS_PHOTOWALL_BASE_URL` and `VITE_OSS_PHOTOWALL_BASE_URL`.
- Upload limits have matching frontend/backend variables. Keep `PHOTO_UPLOAD_MAX_FILES_PER_BATCH`, `PHOTO_UPLOAD_MAX_BATCH_MB`, `VITE_PHOTO_UPLOAD_MAX_FILES_PER_BATCH`, and `VITE_PHOTO_UPLOAD_BATCH_MB` aligned when changing batching behavior.

## Code Style

- Keep TypeScript strict-clean; the app config enables `strict`, `noUnusedLocals`, and `noUnusedParameters`.
- Prefer existing small helpers and local patterns over broad refactors.
- Use `authFetch` for admin API calls that require authentication.
- Admin UI text is primarily Chinese; keep user-facing copy consistent with surrounding pages.
- Use Tailwind utility classes and the existing lucide-react icon style for UI controls.
- Avoid introducing secrets, sample credentials beyond `.env.example`, or generated metadata into source control.

## Validation

For code changes, run the smallest useful checks:

- Frontend or shared TypeScript changes: `npm run build`
- Server-only changes: `npm run build:server`
- Style/lint-sensitive changes: `npm run lint`

There is no test script configured in `package.json` at the moment.
