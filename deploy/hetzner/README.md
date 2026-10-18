# Yuvomi at home: Hetzner deployment

A single Hetzner Cloud server runs two containers:

- **yuvomi**: this fork, image `ghcr.io/wojciech-turek/yuvomi:main`, built by
  `.github/workflows/home-image.yml` on every push to `main`
- **caddy**: HTTPS with automatic Let's Encrypt certificates, the only thing
  reachable from the internet

Data lives in `/opt/yuvomi/deploy/hetzner/{data,backups,documents}` on the server.

## 1. Server

- Hetzner Cloud: **CPX22** recommended (CPX12 is enough for the app alone), Ubuntu 24.04,
  location Falkenstein or Nuremberg (closest to Kraków), add your SSH key.
- Optional: a Hetzner Cloud Firewall allowing only 22, 80, 443 (the script also sets up `ufw`).

## 2. DNS

Create an `A` record (and `AAAA` for IPv6) for the host name you want, e.g.
`dom.yourdomain.com`, pointing at the server's IP. Wait until
`dig +short dom.yourdomain.com` returns that IP. Caddy needs this to get the certificate.

## 3. Install

```bash
ssh root@<server-ip>
curl -fsSL https://raw.githubusercontent.com/wojciech-turek/yuvomi/main/deploy/hetzner/bootstrap.sh \
  | DOMAIN=dom.yourdomain.com bash
```

At the end it prints `DB_ENCRYPTION_KEY`. **Store it in your password manager.**
The database and every backup are encrypted with it.

If the image pull fails (a new GHCR package can start out private), either make the package
public under GitHub → your profile → Packages → yuvomi → Package settings, or run
`docker compose up -d --build` in `/opt/yuvomi/deploy/hetzner` to build on the server.

## 4. First start

1. Open `https://dom.yourdomain.com`. The setup page creates the admin account:
   use `accounts@wojciechturek.com`.
2. Switch the language to **Polski** in your account settings, and check the household
   region/time zone is Europe/Warsaw.
3. Invite your wife: Settings → Household → Family → create an invitation link and send it to her.
4. iCloud calendar: Settings → Calendar sync → Apple Calendar. Use an
   **app-specific password** from account.apple.com → Sign-In and Security.
   Settings → Reminder sync can also connect iCloud Reminders lists to tasks.

## 5. iPhones

Open the site in **Safari** → Share → **Add to Home Screen** → open it from the
home screen icon and allow notifications. On iOS, push notifications only work in the
home-screen app.

## 6. Kitchen iPad (wall mode)

1. On a phone or computer as admin: Settings → **Wall tablets** → create a tablet → you get a
   pairing code (valid 15 minutes, works once).
2. On the iPad in Safari: open `https://dom.yourdomain.com/pair`, enter the code.
3. Share → **Add to Home Screen**, then open it from that icon (full screen, no Safari bars).
4. iPad Settings → Display & Brightness → Auto-Lock → **Never** (keep it on the charger).
5. iPad Settings → Accessibility → **Guided Access** → on. Open the app and triple-click
   the top button to lock the iPad to it.

## Updating

```bash
ssh root@<server-ip> /opt/yuvomi/deploy/hetzner/update.sh
```

Wait for the "Home Image" GitHub Action to finish after a push to `main` first.

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
