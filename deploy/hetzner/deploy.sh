#!/usr/bin/env bash
# Deploy from this machine, so no deploy key or secret lives on GitHub: wait until
# GitHub's main has the commit and "Home Image" has built it, then run update.sh on
# the server over SSH and check that the site answers.
#
#   deploy/hetzner/deploy.sh            # deploy what is on GitHub's main now
#   deploy/hetzner/deploy.sh <commit>   # first wait until GitHub's main contains <commit>
#
# The hooks in deploy/hetzner/git-hooks run this in the background after pushing or
# pulling main. Enable them once per clone:
#   git config core.hooksPath deploy/hetzner/git-hooks
# Needs ssh access to the server and `gh` logged into any GitHub account.
set -euo pipefail

SERVER="${DEPLOY_SERVER:-root@2.28.142.180}"
SSH_KEY="${DEPLOY_SSH_KEY_FILE:-$HOME/.ssh/id_ed25519_lush}"
SITE_URL="${DEPLOY_SITE_URL:-https://home.wojciechturek.com}"
GH_REPO=wojciech-turek/yuvomi
REMOTE_DIR=/opt/yuvomi
# Hooks started from GUI git clients often lack Homebrew in PATH (gh).
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"

cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

log() { echo "$(date '+%F %T') $*"; }
notify() {
  if [[ -n "${DEPLOY_NOTIFY:-}" ]] && command -v osascript >/dev/null; then
    osascript -e "display notification \"$1\" with title \"Yuvomi deploy\"" || true
  fi
}
fail() { log "FAILED: $*"; notify "Failed: $*"; exit 1; }
ssh_server() { ssh -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=15 -i "$SSH_KEY" "$SERVER" "$@"; }

# One deploy at a time: a second one (e.g. a quick second push) waits, then deploys
# whatever main is by then.
LOCK="$(git rev-parse --absolute-git-dir)/yuvomi-deploy.lock"
until mkdir "$LOCK" 2>/dev/null; do
  pid=$(cat "$LOCK/pid" 2>/dev/null || true)
  if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then rm -rf "$LOCK"; continue; fi
  sleep 5
done
echo $$ >"$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

if [[ -n "${1:-}" ]]; then
  target=$(git rev-parse --verify "$1^{commit}")
  log "Waiting for GitHub's main to contain ${target:0:7}"
  for ((i = 0; ; i++)); do
    git fetch -q origin main
    git merge-base --is-ancestor "$target" origin/main && break
    ((i < 60)) || fail "GitHub's main still lacks ${target:0:7} after 10 minutes (push rejected?)"
    sleep 10
  done
fi

# "status conclusion" of the image build for a commit, or nothing when there is none
# (yet). Home Image skips pushes that only touch docs or deploy/.
image_run() {
  gh api "repos/$GH_REPO/actions/workflows/home-image.yml/runs?branch=main&head_sha=$1&per_page=1" \
    -q '.workflow_runs[0] | select(. != null) | "\(.status) \(.conclusion)"'
}

deadline=$((SECONDS + 40 * 60))
while :; do
  git fetch -q origin main
  head=$(git rev-parse origin/main)
  # A run shows up a few seconds after the push; a minute without one means none.
  run=""
  for ((i = 0; i < 6; i++)); do
    run=$(image_run "$head") || fail "cannot read the image build status (is gh logged in?)"
    [[ -n "$run" ]] && break
    sleep 10
  done
  case "$run" in
    "") log "No image build for ${head:0:7} (docs/deploy-only change): the image stays as it is"; break ;;
    "completed success") log "Image for ${head:0:7} is built"; break ;;
    "completed cancelled")
      # A newer push replaces a running build (cancel-in-progress); follow the new head.
      git fetch -q origin main
      [[ "$(git rev-parse origin/main)" != "$head" ]] || fail "the image build for ${head:0:7} was cancelled"
      ;;
    completed*) fail "the image build for ${head:0:7} ended with: ${run#completed }" ;;
    *)
      ((SECONDS < deadline)) || fail "the image build for ${head:0:7} is still not done"
      log "Waiting for the image build of ${head:0:7} ($run)"
      sleep 20
      ;;
  esac
done

log "Running update.sh on $SERVER"
ssh_server "$REMOTE_DIR/deploy/hetzner/update.sh"

healthy=""
for ((i = 0; i < 30; i++)); do
  if curl -fsS -o /dev/null --max-time 10 "$SITE_URL/health"; then healthy=1; break; fi
  sleep 3
done
[[ -n "$healthy" ]] || fail "$SITE_URL/health does not answer after the update"

deployed=$(ssh_server git -C "$REMOTE_DIR" rev-parse HEAD)
image_rev=$(ssh_server "docker inspect yuvomi --format '{{index .Config.Labels \"org.opencontainers.image.revision\"}}'" || true)
log "Deployed ${deployed:0:7} (image built from ${image_rev:0:7}); $SITE_URL is up"
notify "Deployed ${deployed:0:7}, site is up"
