# Build for host arch: podman build -t yt-audio-app .
# Build for ARM64 on an x86_64 host (requires qemu-user-static): podman build --platform linux/arm64 -t yt-audio-app .
FROM node:20-slim AS frontend-builder
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:20-slim AS backend-builder
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-slim AS runtime
RUN apt-get update && apt-get install -y python3 ffmpeg curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp
WORKDIR /app
COPY --from=backend-builder /app/node_modules ./node_modules
COPY package*.json ./
COPY server.js db.js ytdlp.js themes.js ./
COPY --from=frontend-builder /frontend/dist ./public
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV NODE_ENV=production PORT=3000 DB_PATH=/app/data/app.db
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD curl -f http://localhost:3000/health || exit 1
CMD ["node", "server.js"]
