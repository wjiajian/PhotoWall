# PhotoWall

独立照片墙，用于个人网站的公开照片展示和照片管理后台。
公开展示、年月筛选、实况照片、Lightbox、照片信息侧栏、后台登录、上传、显隐管理和删除。
## 功能

- `/`：公开照片墙
- `/admin/login`：后台登录
- `/admin/photos`：照片上传、任务进度、显隐管理、删除照片
- `/admin/settings`：网站标题、页面标题、favicon 设置
- `/api/auth/*`：后台登录和 token 校验
- `/api/photos/*`：照片 metadata、上传任务、显隐和删除
- `/api/settings/*`：站点设置读取和保存

照片文件保存在 OSS，照片列表和显隐状态保存在 `src/data/images-metadata.json`，站点标题和图标配置保存在 `src/data/site-settings.json`。

## 目录说明

```text
PhotoWall/
├─ src/
│  ├─ components/PhotoWall/     # 照片墙展示组件
│  ├─ pages/admin/              # 管理后台页面
│  ├─ routes/                   # Express API 路由
│  ├─ services/                 # OSS 上传、图片处理、上传队列
│  └─ data/                     # images-metadata.json 所在目录
├─ scripts/
│  └─ rebuild-oss-photowall-metadata.mjs
├─ server.ts                    # Express 入口
├─ Dockerfile
└─ docker-compose.yml
```

## 环境变量

复制示例文件：

```bash
cp .env.example .env
```

生产环境至少填写：

```env
NODE_ENV=production
PORT=3000
CORS_ORIGIN=https://photowall.example.domain

ADMIN_USERNAME=
ADMIN_PASSWORD=
JWT_SECRET=

OSS_REGION=
OSS_BUCKET=
OSS_ACCESS_KEY_ID=
OSS_ACCESS_KEY_SECRET=
OSS_PHOTOWALL_BASE_URL=
VITE_OSS_PHOTOWALL_BASE_URL=

PHOTO_UPLOAD_MAX_MB=25
PHOTO_UPLOAD_MAX_FILES_PER_BATCH=1
PHOTO_UPLOAD_MAX_BATCH_MB=25
PHOTO_PROCESS_SHARP_CONCURRENCY=1
PHOTO_PROCESS_MAX_PIXELS=30000000
PHOTO_HEIC_MAX_MB=15
PHOTO_THUMBNAIL_FULL_MAX_PX=0
PHOTO_THUMBNAIL_MEDIUM_MAX_PX=800
PHOTO_THUMBNAIL_TINY_MAX_PX=50
PHOTO_THUMBNAIL_FULL_QUALITY=92
PHOTO_THUMBNAIL_MEDIUM_QUALITY=80
PHOTO_THUMBNAIL_TINY_QUALITY=60
VITE_PHOTO_UPLOAD_MAX_FILES_PER_BATCH=1
VITE_PHOTO_UPLOAD_BATCH_MB=25
```

说明：

- `ADMIN_PASSWORD` 可以先用明文，正式部署更建议使用 `ADMIN_PASSWORD_HASH`。
- `JWT_SECRET` 请使用足够长的随机字符串。
- `OSS_PHOTOWALL_BASE_URL` 是服务端返回图片时使用的 OSS 公开访问地址。
- `VITE_OSS_PHOTOWALL_BASE_URL` 是前端构建时使用的 OSS 公开访问地址，通常和 `OSS_PHOTOWALL_BASE_URL` 相同。
- `PHOTO_OSS_OPERATION_TIMEOUT_MS` OSS 单次操作的超时时间（毫秒），默认 `60000`（60 秒）。超过此限制的 OSS 网络请求会被中断。
- `PHOTO_UPLOAD_FILE_TIMEOUT_MS` 单张照片处理的总超时时间（毫秒），默认 `300000`（5 分钟）。超过此限制的照片会被标记为失败，队列继续处理下一张。
- 修改任何 `VITE_` 开头的变量后，需要重新构建前端或重新构建 Docker 镜像。

## 本地开发

安装依赖：

```bash
npm install
```

启动前端开发服务：

```bash
npm run dev
```

启动 Express 服务：

```bash
npm run start
```

构建：

```bash
npm run build
npm run build:server
```

生产方式启动：

```bash
npm run serve
```

## 从 OSS 同步 Metadata

如果 OSS 中已经存在照片，可以用脚本生成 `src/data/images-metadata.json`。

需要 OSS 中的对象满足这些前缀：

```text
photowall/origin/
photowall/thumbnails/full/
photowall/thumbnails/medium/
photowall/thumbnails/tiny/
```

示例：

```text
photowall/origin/IMG_001.HEIC
photowall/thumbnails/full/IMG_001.HEIC.jpg
photowall/thumbnails/medium/IMG_001.HEIC.jpg
photowall/thumbnails/tiny/IMG_001.HEIC.jpg
```

本地同步：

```bash
npm install
npm run rebuild-oss-metadata
```

脚本会读取 OSS 对象、解析 EXIF 拍摄时间、读取图片宽高，并生成：

```text
src/data/images-metadata.json
```

如果 metadata 已经存在，脚本会尽量保留旧记录中的 `isVisible` 和 `visibilityUpdatedAt`。

## Docker 部署

第一次构建并启动：

```bash
docker compose up -d --build
```

查看日志：

```bash
docker compose logs -f photowall
```

停止服务：

```bash
docker compose down
```

`docker-compose.yml` 默认：

- 监听宿主机 `3000` 端口
- 读取 `.env`
- 挂载 `./src/data:/app/src/data`
- 使用 `/tmp/photowall-uploads` 作为上传临时目录

`src/data` 挂载很重要。后台上传、显隐切换、删除照片都会更新 `images-metadata.json`，站点设置会更新 `site-settings.json`，挂载后容器重建不会丢状态。

## GitHub Actions 部署

推荐生产环境使用 GitHub Actions 构建镜像，服务器只负责拉取镜像和启动容器，避免在低配服务器上执行 `docker compose build`。

工作流文件：

```text
.github/workflows/deploy.yml
```

生产 Compose 文件：

```text
docker-compose.prod.yml
```

部署流程：

1. GitHub Actions 构建 Docker 镜像。
2. 镜像推送到 GHCR。
3. Action 通过 SSH 登录服务器。
4. 上传 `docker-compose.prod.yml` 到服务器部署目录。
5. 服务器执行 `docker compose pull`。
6. 如果服务器上没有 `src/data/site-settings.json`，就生成一份默认站点设置。
7. 如果服务器上没有 `src/data/images-metadata.json`，就执行一次 OSS metadata 同步。
8. 执行 `docker compose up -d` 启动服务。

需要在 GitHub 仓库中配置 Secrets：

```text
SSH_HOST           服务器 IP 或域名
SSH_USER           SSH 用户名
SSH_PASSWORD       SSH 登录密码
SSH_PORT           SSH 端口，默认 22，可不填
DEPLOY_PATH        服务器部署目录，默认 ~/photowall，可不填
GHCR_USERNAME      GHCR 用户名；如果镜像公开，可不填
GHCR_TOKEN         GHCR 访问 Token；如果镜像公开，可不填
```

需要在 GitHub 仓库中配置 Variables：

```text
VITE_OSS_PHOTOWALL_BASE_URL
VITE_PHOTO_UPLOAD_MAX_FILES_PER_BATCH
VITE_PHOTO_UPLOAD_BATCH_MB
```

其中 `VITE_PHOTO_UPLOAD_MAX_FILES_PER_BATCH` 默认 `1`，`VITE_PHOTO_UPLOAD_BATCH_MB` 默认 `25`，低配服务器建议保持默认值。

服务器部署目录需要提前准备 `.env`：

```bash
mkdir -p ~/photowall/src/data
cd ~/photowall
vim .env
```

如果你用 root 部署，Action 会自动把 `src/data` 调整为容器内 `node` 用户可写，用于生成和更新 `images-metadata.json`。

`.env` 至少包含：

```env
NODE_ENV=production
PORT=3000
CORS_ORIGIN=https://photowall.example.domain

ADMIN_USERNAME=
ADMIN_PASSWORD=
JWT_SECRET=

OSS_REGION=
OSS_BUCKET=
OSS_ACCESS_KEY_ID=
OSS_ACCESS_KEY_SECRET=
OSS_PHOTOWALL_BASE_URL=
VITE_OSS_PHOTOWALL_BASE_URL=
```

首次部署时，如果服务器上不存在：

```text
src/data/site-settings.json
```

Action 会自动生成一份默认配置：

```json
{
  "siteTitle": "PhotoWall",
  "galleryTitle": "Photo Wall",
  "favicon": "/resources/fangnai.jpg"
}
```

如果服务器上不存在：

```text
src/data/images-metadata.json
```

Action 会自动在服务器上执行：

```bash
docker compose -f docker-compose.prod.yml run --rm photowall npm run rebuild-oss-metadata
```

这一步会读取服务器 `.env` 里的 OSS 配置，从 OSS 同步已有照片到 metadata。之后 metadata 文件存在时，Action 会跳过同步，避免每次部署都重新扫描 OSS。

## Docker 下同步 OSS Metadata

如果你使用 Docker 部署，并且 OSS 里已经有照片，推荐这样同步：

```bash
docker compose build
docker compose run --rm photowall npm run rebuild-oss-metadata
docker compose up -d
```

这个命令会读取 `.env` 中的 OSS 配置，并把生成的 `images-metadata.json` 写入宿主机的 `./src/data`。

服务已经运行时，也可以执行：

```bash
docker compose exec photowall npm run rebuild-oss-metadata
```

同步完成后，刷新页面即可。照片 metadata 接口会动态读取文件。

## Nginx 反代

如果使用 `photowall.example.domain`，可以让 Nginx 反代到容器暴露的 `3000` 端口：

```nginx
upstream photowall_app {
  server 127.0.0.1:3000;
}

server {
  listen 80;
  server_name photowall.example.domain;
  return 301 https://photowall.example.domain$request_uri;
}

server {
  listen 443 ssl http2;
  server_name photowall.example.domain;

  ssl_certificate /etc/letsencrypt/live/photowall.example.domain/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/photowall.example.domain/privkey.pem;

  client_max_body_size 80m;

  location / {
    proxy_pass http://photowall_app;
    proxy_http_version 1.1;
    include /etc/nginx/proxy_params;
  }
}
```

## 常用命令

```bash
# 构建镜像并启动
docker compose up -d --build

# 只重启服务
docker compose restart photowall

# 查看日志
docker compose logs -f photowall

# 进入容器
docker compose exec photowall sh

# 从 OSS 重建 metadata
docker compose run --rm photowall npm run rebuild-oss-metadata
```

## 常见问题

### 页面没有照片

检查 `src/data/images-metadata.json` 是否存在，并确认 OSS 公开访问地址是否正确：

```bash
ls -lh src/data/images-metadata.json
```

同时确认 `.env` 中的：

```env
OSS_PHOTOWALL_BASE_URL=
VITE_OSS_PHOTOWALL_BASE_URL=
```

### 后台无法上传

检查 OSS 写入配置：

```env
OSS_REGION=
OSS_BUCKET=
OSS_ACCESS_KEY_ID=
OSS_ACCESS_KEY_SECRET=
```

还需要确认 OSS AccessKey 有上传、删除对象的权限。

### 修改 VITE 配置后没有生效

`VITE_` 开头的变量会在前端构建时写入产物。修改后需要重新构建：

```bash
docker compose up -d --build
```

### 容器重建后显隐状态丢失

确认 `docker-compose.yml` 中保留了这个挂载：

```yaml
volumes:
  - ./src/data:/app/src/data
```

这个目录同时保存 `images-metadata.json` 和 `site-settings.json`。

### Certbot 提示证书文件不存在

通常是 Nginx 配置已经引用了还没申请到的证书。先临时移除该域名的 443 配置，只保留 80 配置，确认：

```bash
nginx -t
systemctl reload nginx
```

然后再申请证书，最后恢复 HTTPS 配置。
