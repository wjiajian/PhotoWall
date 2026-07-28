FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app
ARG VITE_OSS_PHOTOWALL_BASE_URL=
ARG VITE_PHOTO_UPLOAD_MAX_FILES_PER_BATCH=1
ARG VITE_PHOTO_UPLOAD_BATCH_MB=20
ENV VITE_OSS_PHOTOWALL_BASE_URL=$VITE_OSS_PHOTOWALL_BASE_URL
ENV VITE_PHOTO_UPLOAD_MAX_FILES_PER_BATCH=$VITE_PHOTO_UPLOAD_MAX_FILES_PER_BATCH
ENV VITE_PHOTO_UPLOAD_BATCH_MB=$VITE_PHOTO_UPLOAD_BATCH_MB
COPY . .
RUN mkdir -p public src/data
RUN npm run build
RUN npm run build:server

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV PHOTO_UPLOAD_TMP_DIR=/tmp/photowall-uploads

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/public ./public
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/shared ./shared
COPY --from=build /app/src/data ./src/data

RUN mkdir -p /app/src/data /tmp/photowall-uploads \
  && chown -R node:node /app /tmp/photowall-uploads

USER node
EXPOSE 3000
CMD ["node", "--max-old-space-size=256", "dist-server/server.js"]
