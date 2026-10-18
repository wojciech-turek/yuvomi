#!/usr/bin/env bash
# Setup for an Ubuntu Hetzner server, run as root. Works on a server that already
# runs other things: it never enables a firewall, never takes ports that are in
# use, and only installs Docker when it is missing.
#
#   curl -fsSL https://raw.githubusercontent.com/wojciech-turek/yuvomi/main/deploy/hetzner/bootstrap.sh | bash
#
# Safe to re-run: it keeps an existing .env (and with it the encryption key).
set -euo pipefail

DOMAIN="${DOMAIN:-home.wojciechturek.com}"
REPO_URL="${REPO_URL:-https://github.com/wojciech-turek/yuvomi.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/yuvomi}"
DEPLOY_DIR="$APP_DIR/deploy/hetzner"

[[ $EUID -eq 0 ]] || { echo "Run as root." >&2; exit 1; }

port_in_use() { ss -ltnH "( sport = :$1 )" | grep -q .; }

echo "==> Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq ca-certificates curl git openssl unattended-upgrades

echo "==> Docker"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
else
  docker compose version >/dev/null || { echo "Docker is installed but the compose plugin is missing (apt install docker-compose-plugin)." >&2; exit 1; }
fi

echo "==> Code"
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

cd "$DEPLOY_DIR"
mkdir -p data backups modules documents

if [[ ! -f .env ]]; then
  echo "==> Creating .env"
  # A running Yuvomi holds its own ports, so this check only matters on first setup.
  if port_in_use 80 || port_in_use 443; then
    PROFILES=""
    echo "    Ports 80/443 are taken by another web server - it will proxy to Yuvomi."
  else
    PROFILES="caddy"
  fi
  LOCAL_PORT=3080
  while port_in_use "$LOCAL_PORT"; do LOCAL_PORT=$((LOCAL_PORT + 1)); done
  cp .env.example .env
  sed -i \
    -e "s|^DOMAIN=.*|DOMAIN=${DOMAIN}|" \
    -e "s|^BASE_URL=.*|BASE_URL=https://${DOMAIN}|" \
    -e "s|^COMPOSE_PROFILES=.*|COMPOSE_PROFILES=${PROFILES}|" \
    -e "s|^YUVOMI_LOCAL_PORT=.*|YUVOMI_LOCAL_PORT=${LOCAL_PORT}|" \
    -e "s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -hex 32)|" \
    -e "s|^DB_ENCRYPTION_KEY=.*|DB_ENCRYPTION_KEY=$(openssl rand -hex 32)|" \
    .env
  chmod 600 .env
  NEW_ENV=1
fi

if ufw status 2>/dev/null | grep -q "Status: active" && grep -q '^COMPOSE_PROFILES=caddy' .env; then
  echo "==> ufw is active: allowing 80/443"
  ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp
fi

echo "==> Starting Yuvomi"
docker compose pull --ignore-pull-failures
docker compose up -d

LOCAL_PORT=$(grep '^YUVOMI_LOCAL_PORT=' .env | cut -d= -f2)
echo
if grep -q '^COMPOSE_PROFILES=caddy' .env; then
  echo "Done. Open https://${DOMAIN}/ to create the admin account."
else
  echo "Done. Yuvomi listens on 127.0.0.1:${LOCAL_PORT}. Point your existing web server at it,"
  echo "for ${DOMAIN}, with HTTPS - see README.md, 'Existing web server'."
fi
if [[ -n "${NEW_ENV:-}" ]]; then
  echo
  echo "!! Save this database encryption key in your password manager NOW."
  echo "!! Without it the database and all backups are unreadable:"
  grep '^DB_ENCRYPTION_KEY=' .env
fi
echo
echo "Later updates are deployed from your Mac: deploy/hetzner/deploy.sh (see README.md)."
