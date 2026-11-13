# Build for host arch: docker build -f Containerfile -t mehfil-fm .
# Build for ARM64 on an x86_64 host: docker build --platform linux/arm64 -f Containerfile -t mehfil-fm .
FROM node:20-bookworm-slim AS frontend-builder
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm ci --ignore-scripts
COPY frontend/ ./
RUN npm run build

FROM node:20-bookworm-slim AS backend-builder
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:20-bookworm-slim AS runtime
# Upgrade all OS packages to pull in security patches, then install only what
# the healthcheck needs (curl) and clean up in a single layer.
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Strip the global npm/corepack/yarn tooling — the container runs
# `node server.js` directly and never needs a package manager at runtime.
RUN rm -rf \
      /usr/local/lib/node_modules/npm \
      /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /usr/local/bin/corepack \
      /opt/yarn-v1.22.22

WORKDIR /app
COPY --from=backend-builder /app/node_modules ./node_modules
COPY package*.json ./
COPY server.js db.js jiosaavn.js themes.js subsonic.js ./
COPY --from=frontend-builder /frontend/dist ./public
COPY public/admin.html public/manifest.json public/sw.js ./public/
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV NODE_ENV=production PORT=3000 DB_PATH=/app/data/app.db
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD curl -f http://localhost:3000/health || exit 1
CMD ["node", "server.js"]
