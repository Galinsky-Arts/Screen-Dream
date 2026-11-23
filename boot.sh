#!/bin/sh
# Start script for the Render image service (no GitHub connection):
# the app source arrives as a secret file, this installs deps + ffmpeg and starts the server.
set -e
cd "$(dirname "$0")"
echo "[boot] installing dependencies"
npm ci --omit=dev --no-audit --no-fund --loglevel=error
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "[boot] installing ffmpeg"
  npm install --no-save --no-audit --no-fund --loglevel=error ffmpeg-static@5.2.0 ffprobe-static@3.1.0
  FFMPEG_PATH="$(node -p "require('ffmpeg-static')")"
  FFPROBE_PATH="$(node -p "require('ffprobe-static').path")"
  chmod +x "$FFMPEG_PATH" "$FFPROBE_PATH" || true
  export FFMPEG_PATH FFPROBE_PATH
fi
echo "[boot] starting server"
exec node server/index.js
