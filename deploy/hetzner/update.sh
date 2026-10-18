#!/usr/bin/env bash
# Pull the latest fork and image, then restart. Run on the server as root:
#   /opt/yuvomi/deploy/hetzner/update.sh
# GitHub Actions (deploy.yml) runs this too, through a key that can run nothing else.
set -euo pipefail
cd "$(dirname "$0")"
git -C ../.. pull --ff-only
if ! docker compose pull; then
  echo "Image pull failed - building on the server instead."
  docker compose build yuvomi
fi
docker compose up -d --remove-orphans
# Only this fork's old images, never another project's.
docker image prune -f --filter "label=org.opencontainers.image.source=https://github.com/wojciech-turek/yuvomi"
docker compose ps
