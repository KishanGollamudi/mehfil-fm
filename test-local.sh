#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

podman build -t yt-audio-app .

mkdir -p ./podman-data
chmod 755 ./podman-data
podman stop yt-audio-app 2>/dev/null || true
podman rm yt-audio-app 2>/dev/null || true
podman run -d --name yt-audio-app --userns=keep-id -p 3000:3000 -v "$(pwd)/podman-data:/app/data:Z" yt-audio-app
sleep 4
curl -f http://localhost:3000/health
echo ""
echo "Open http://localhost:3000"
echo "View logs: podman logs -f yt-audio-app"
echo "Stop: podman stop yt-audio-app"
