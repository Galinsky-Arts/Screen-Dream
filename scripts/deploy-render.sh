#!/bin/sh
# Redeploy to Render without a GitHub connection.
# Packs a committed revision with `git archive` (never uncommitted or untracked files),
# uploads it as the service's secret file "app.b64", and triggers a deploy.
# The service runs the public node:22-bookworm-slim image with start command
# `sh /etc/secrets/start.sh`; the committed copy of that file is scripts/render-start.sh.
#
# Usage: [RENDER_API_KEY=...] scripts/deploy-render.sh [--start-script] [service-id] [git-ref]
#   git-ref         revision to ship (default HEAD); pass an older commit to roll back
#   --start-script  also upload scripts/render-start.sh as the secret file start.sh
# RENDER_API_KEY may be omitted when an authenticating proxy adds the header.
set -e
UPLOAD_START=""
if [ "$1" = "--start-script" ]; then UPLOAD_START=1; shift; fi
SVC="${1:-${SCREENDREAM_SERVICE_ID:?pass the Render service id or set SCREENDREAM_SERVICE_ID}}"
REF="${2:-HEAD}"
API=https://api.render.com/v1
cd "$(dirname "$0")/.."

if [ -n "$RENDER_API_KEY" ]; then
  set -- -H "Authorization: Bearer $RENDER_API_KEY"
else
  set --
fi

SHA="$(git rev-parse --verify "$REF^{commit}")"
if [ "$REF" = "HEAD" ] && [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Note: uncommitted changes are NOT deployed; shipping commit $SHA" >&2
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git archive --format=tar.gz -o "$TMP/app.tgz" "$SHA" -- . ':(exclude)test' ':(exclude)scripts' ':(exclude).github'

node -e "const fs=require('fs');fs.writeFileSync(process.argv[2],JSON.stringify({content:fs.readFileSync(process.argv[1]).toString('base64')}))" "$TMP/app.tgz" "$TMP/body.json"
curl -fsS -X PUT "$API/services/$SVC/secret-files/app.b64" -H "Content-Type: application/json" "$@" -d @"$TMP/body.json" >/dev/null
if [ -n "$UPLOAD_START" ]; then
  node -e "const fs=require('fs');fs.writeFileSync(process.argv[2],JSON.stringify({content:fs.readFileSync(process.argv[1],'utf8')}))" scripts/render-start.sh "$TMP/body.json"
  curl -fsS -X PUT "$API/services/$SVC/secret-files/start.sh" -H "Content-Type: application/json" "$@" -d @"$TMP/body.json" >/dev/null
fi
curl -fsS -X POST "$API/services/$SVC/deploys" -H "Content-Type: application/json" "$@" -d '{}'
echo
echo "Deploy started for $SVC at commit $SHA"
