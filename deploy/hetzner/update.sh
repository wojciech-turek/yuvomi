#!/usr/bin/env bash
# Pull the latest fork and image, then restart. Run on the server as root:
#   /opt/yuvomi/deploy/hetzner/update.sh
set -euo pipefail
cd "$(dirname "$0")"
git -C ../.. pull --ff-only
docker compose pull --ignore-pull-failures
docker compose up -d --remove-orphans
docker image prune -f
docker compose ps
