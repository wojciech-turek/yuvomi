# Yuvomi at home: Hetzner deployment

`https://home.wojciechturek.com` on the Hetzner server `49.13.231.163`, which also runs other
things. Containers:

- **yuvomi**: this fork, image `ghcr.io/wojciech-turek/yuvomi:main`, built by
  `.github/workflows/home-image.yml` on every push to `main`. Listens on `127.0.0.1` only.
- **yuvomi-caddy** (only when ports 80/443 are free): HTTPS with automatic Let's Encrypt
  certificates. If another web server already owns 80/443, that one proxies to Yuvomi instead.

Data lives in `/opt/yuvomi/deploy/hetzner/{data,backups,documents}` on the server.

## 1. DNS

Create an `A` record `home.wojciechturek.com → 49.13.231.163` (and an `AAAA` record if the
server has IPv6). Wait until `dig +short home.wojciechturek.com` returns the IP.

If the server has a Hetzner Cloud Firewall, it must allow 80 and 443 (TCP; 443 UDP too for HTTP/3).

## 2. Install (once)

```bash
ssh root@49.13.231.163
curl -fsSL https://raw.githubusercontent.com/wojciech-turek/yuvomi/main/deploy/hetzner/bootstrap.sh | bash
```

The script does not enable a firewall or take ports that are already in use, and it only installs
Docker if it is missing. At the end it prints:

- `DB_ENCRYPTION_KEY`: **store it in your password manager.** The database and every backup
  are encrypted with it.
- Three GitHub secrets for automatic deploys (next step).
- If 80/443 were taken: the local port Yuvomi listens on (see "Existing web server" below).

## 3. Automatic deploys

In GitHub → `wojciech-turek/yuvomi` → Settings → Secrets and variables → Actions, add
`DEPLOY_HOST`, `DEPLOY_KNOWN_HOSTS` and `DEPLOY_SSH_KEY` exactly as the script printed them.
From then on, every merge to `main` builds the image ("Home Image") and runs `update.sh` on
the server ("Deploy"). The deploy key is restricted in `/root/.ssh/authorized_keys` to that one
command: it cannot open a shell. To revoke it, delete the `yuvomi-github-deploy` line there.

If the server cannot pull the image (a new GHCR package can start out private), `update.sh`
builds it on the server instead, which is slower. To avoid that, make the package public: GitHub → your
profile → Packages → yuvomi → Package settings → Change visibility.

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

1. Open `https://home.wojciechturek.com`. The setup page creates the admin account:
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
2. On the iPad in Safari: open `https://home.wojciechturek.com/pair`, enter the code.
3. Share → **Add to Home Screen**, then open it from that icon (full screen, no Safari bars).
4. iPad Settings → Display & Brightness → Auto-Lock → **Never** (keep it on the charger).
5. iPad Settings → Accessibility → **Guided Access** → on. Open the app and triple-click
   the top button to lock the iPad to it.

## Updating

Automatic after each merge to `main` (step 3). By hand:

```bash
ssh root@49.13.231.163 /opt/yuvomi/deploy/hetzner/update.sh
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
