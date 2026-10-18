# Yuvomi at home: Hetzner deployment

`https://home.wojciechturek.com` on its own Hetzner Cloud server `2.28.142.180`
(IPv6 `2a01:4f8:c012:2993::1`, Ubuntu 24.04). Containers:

- **yuvomi**: this fork, image `ghcr.io/wojciech-turek/yuvomi:main` (public), built by
  `.github/workflows/home-image.yml` on every push to `main`. Listens on `127.0.0.1` only.
- **yuvomi-caddy** (only when ports 80/443 are free): HTTPS with automatic Let's Encrypt
  certificates. If another web server already owns 80/443, that one proxies to Yuvomi instead.

Data lives in `/opt/yuvomi/deploy/hetzner/{data,backups,documents}` on the server.

## 1. DNS

Create an `A` record `home.wojciechturek.com → 2.28.142.180` and an `AAAA` record
`→ 2a01:4f8:c012:2993::1`. Wait until `dig +short home.wojciechturek.com` returns the IP.

If the server has a Hetzner Cloud Firewall, it must allow 80 and 443 (TCP; 443 UDP too for HTTP/3).

## 2. Install (once)

```bash
ssh root@2.28.142.180
curl -fsSL https://raw.githubusercontent.com/wojciech-turek/yuvomi/main/deploy/hetzner/bootstrap.sh | bash
```

The script does not enable a firewall or take ports that are already in use, and it only installs
Docker if it is missing. At the end it prints:

- `DB_ENCRYPTION_KEY`: **store it in your password manager.** The database and every backup
  are encrypted with it. To read it again later:
  `ssh root@2.28.142.180 grep DB_ENCRYPTION_KEY /opt/yuvomi/deploy/hetzner/.env`
- If 80/443 were taken: the local port Yuvomi listens on (see "Existing web server" below).

## 3. Deploys from your Mac

GitHub only builds the image; no deploy key or secret lives there. Deploys run from your Mac
over SSH with `~/.ssh/id_ed25519_lush`. Turn on the git hooks once per clone:

```bash
git config core.hooksPath deploy/hetzner/git-hooks
```

From then on, pushing `main` (`pre-push` hook), or pulling it after merging a PR on GitHub
(`post-merge` hook), starts `deploy/hetzner/deploy.sh` in the background. It waits until GitHub
has the commit and "Home Image" has built it, runs `update.sh` on the server, checks `/health`
and shows a macOS notification. The log is in `.git/yuvomi-deploy.log`. To deploy by hand, run
`deploy/hetzner/deploy.sh`. It reads the build status with `gh` (any logged-in GitHub account).

If the server cannot pull the image, `update.sh` builds it on the server instead, which is
slower. The package is public, so this should not happen.

## Existing web server

If something else already serves 80/443, add a site for `home.wojciechturek.com` there with
HTTPS, proxying to `http://127.0.0.1:3080` (or the port the script printed). Examples:

```nginx
# nginx (certificate e.g. via: certbot --nginx -d home.wojciechturek.com)
server {
    server_name home.wojciechturek.com;
    client_max_body_size 10m;
    location / {
        proxy_pass http://127.0.0.1:3080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

```
# Caddy
home.wojciechturek.com {
    reverse_proxy 127.0.0.1:3080
}
```

## 4. First start

1. Open `https://home.wojciechturek.com`. The setup page creates the admin account. The
   username may only use letters, digits, `.`, `-` and `_` (e.g. `wojciech`), so add the email
   `accounts@wojciechturek.com` to your profile afterwards. Until this account exists, anyone
   who finds the site can create it, so do this right after the first start.
2. Switch the language to **Polski** in your account settings, and check the household
   region/time zone is Europe/Warsaw.
3. Invite your wife: Settings → Household → Family → create an invitation link and send it to her.
4. iCloud calendar: Settings → Calendar sync → CalDAV Calendars → Add CalDAV Account, with
   server URL `https://caldav.icloud.com`, your Apple ID and an **app-specific password** from
   account.apple.com → Sign-In and Security. Then tick the calendars to sync. (The
   "Apple Calendar" entry under "More providers" is upstream's legacy option.)
   iCloud Reminders lists created on iOS 13 or later are not reachable over CalDAV, so
   Settings → Reminder sync only sees older lists there.

## 5. iPhones

Open the site in **Safari** → Share → **Add to Home Screen** → open it from the
home screen icon and allow notifications. On iOS, push notifications only work in the
home-screen app.

## 6. Kitchen iPad (wall mode)

1. On a phone or computer as admin: Settings → **Wall tablets** → create a tablet → you get a
   pairing code (valid 15 minutes, works once).
2. On the iPad in Safari: open `https://home.wojciechturek.com/pair`, enter the code.
3. Share → **Add to Home Screen**, then open it from that icon (full screen, no Safari bars).
4. iPad Settings → Display & Brightness → Auto-Lock → **Never** (keep it on the charger).
5. iPad Settings → Accessibility → **Guided Access** → on. Open the app and triple-click
   the top button to lock the iPad to it.

## Updating

After each push or pull of `main` (step 3), or `deploy/hetzner/deploy.sh`. Directly on the
server, without waiting for the image build:

```bash
ssh root@2.28.142.180 /opt/yuvomi/deploy/hetzner/update.sh
```

## Backups

Daily at 03:00 (Warsaw time), 14 kept on the server. For an off-site copy, order a Hetzner
Storage Box, enable WebDAV on it and fill in the `WEBDAV_BACKUP_*` lines in `.env`, then
`docker compose up -d`. Backups can also be configured under Settings → Household → Backup and restore.

## Useful commands (in `/opt/yuvomi/deploy/hetzner`)

```bash
docker compose ps              # status
docker compose logs -f yuvomi  # app logs
docker compose logs caddy      # certificate problems show up here
docker compose restart yuvomi  # after editing .env
```
