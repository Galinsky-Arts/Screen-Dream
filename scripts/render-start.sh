#!/bin/sh
# Render start script for the ScreenDream service (same deployment pattern as Instrument Omega).
#
# This is the in-repo copy of the secret file /etc/secrets/start.sh. The service runs the public
# node:22-bookworm-slim image with the start command `sh /etc/secrets/start.sh`, and the app
# arrives as the secret file /etc/secrets/app.b64 (a base64 tar.gz made by scripts/deploy-render.sh).
# It unpacks the app into /srv/app and hands over to boot.sh (npm ci, ffmpeg-static, start).
# It contains no secrets; configuration comes from the service's env vars.
set -e
rm -rf /srv/app && mkdir -p /srv/app
base64 -d /etc/secrets/app.b64 | tar xz -C /srv/app
exec sh /srv/app/boot.sh
