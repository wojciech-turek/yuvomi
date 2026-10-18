#!/usr/bin/env bash
# One-shot setup for a fresh Hetzner Cloud server (Ubuntu 24.04), run as root:
#
#   curl -fsSL https://raw.githubusercontent.com/wojciech-turek/yuvomi/main/deploy/hetzner/bootstrap.sh \
#     | DOMAIN=home.example.com bash
#
# Safe to re-run: it keeps an existing .env (and with it the encryption key).
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/wojciech-turek/yuvomi.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/yuvomi}"
DEPLOY_DIR="$APP_DIR/deploy/hetzner"

[[ $EUID -eq 0 ]] || { echo "Run as root." >&2; exit 1; }

echo "==> System packages and automatic security updates"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq ca-certificates curl git openssl ufw fail2ban unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades

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
fi
systemctl enable --now docker

echo "==> Firewall (SSH, HTTP, HTTPS)"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

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
  [[ -n "${DOMAIN:-}" ]] || { echo "Set DOMAIN, e.g. DOMAIN=home.example.com" >&2; exit 1; }
  cp .env.example .env
  sed -i \
    -e "s|^DOMAIN=.*|DOMAIN=${DOMAIN}|" \
    -e "s|^BASE_URL=.*|BASE_URL=https://${DOMAIN}|" \
    -e "s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -hex 32)|" \
    -e "s|^DB_ENCRYPTION_KEY=.*|DB_ENCRYPTION_KEY=$(openssl rand -hex 32)|" \
    .env
  chmod 600 .env
  NEW_ENV=1
fi

echo "==> Starting Yuvomi"
docker compose pull --ignore-pull-failures
docker compose up -d

echo
echo "Done. Open https://$(grep '^DOMAIN=' .env | cut -d= -f2)/ to create the admin account."
if [[ -n "${NEW_ENV:-}" ]]; then
  echo
  echo "!! Save this database encryption key in your password manager NOW."
  echo "!! Without it the database and all backups are unreadable:"
  grep '^DB_ENCRYPTION_KEY=' .env
fi
