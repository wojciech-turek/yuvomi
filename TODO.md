# TODO

Home manager on Yuvomi for `https://home.wojciechturek.com` (Hetzner `49.13.231.163`).
Setup details: [`deploy/hetzner/README.md`](deploy/hetzner/README.md). Fork notes: [`FORK.md`](FORK.md).

## Status (2026-10-18)

- [x] Fork upstream Yuvomi v2.78.0 with full history (`upstream` remote = `ulsklyc/yuvomi`)
- [x] Hetzner deployment: Compose, optional Caddy, `bootstrap.sh`, `update.sh`, setup guide
- [x] GitHub Actions: "Home Image" builds `ghcr.io/wojciech-turek/yuvomi:main` (first build passed),
      "Deploy" runs `update.sh` on the server (skips until the secrets exist)

## Go live

- [ ] DNS: `A` record `home.wojciechturek.com → 49.13.231.163` (+ `AAAA` if the server has IPv6)
- [ ] Hetzner Cloud Firewall (if any): allow 80/tcp, 443/tcp, 443/udp
- [ ] On the server: `curl -fsSL https://raw.githubusercontent.com/wojciech-turek/yuvomi/main/deploy/hetzner/bootstrap.sh | bash`
- [ ] Save `DB_ENCRYPTION_KEY` in the password manager
- [ ] If 80/443 were already taken: add a site for the domain to the existing nginx/Caddy
      proxying to `127.0.0.1:3080` (examples in the deploy README)
- [ ] GitHub secrets: `DEPLOY_HOST`, `DEPLOY_KNOWN_HOSTS`, `DEPLOY_SSH_KEY` (printed by the script),
      then re-run the "Deploy" workflow to check it works
- [ ] Optional: make the GHCR package `yuvomi` public, so the server pulls instead of building

## Set up the household

- [ ] Create the admin account at `/setup` with `accounts@wojciechturek.com`
- [ ] Language → Polski; household region/time zone → Europe/Warsaw
- [ ] Invite wife: Settings → Household → Family
- [ ] iCloud: Settings → Calendar sync → Apple Calendar (app-specific password from account.apple.com)
- [ ] Optional: Settings → Reminder sync for iCloud Reminders ↔ tasks
- [ ] Both iPhones: Safari → Add to Home Screen → open from icon → allow notifications
- [ ] Kitchen iPad: Settings → Wall tablets → pairing code → `/pair` on the iPad →
      Add to Home Screen → Auto-Lock Never → Guided Access
- [ ] Try task priorities (none / low / medium / high / urgent)

## Backups

- [ ] Hetzner Storage Box with WebDAV → fill `WEBDAV_BACKUP_*` in the server's `.env`
- [ ] Test a restore once (Settings → Household → Backup and restore)

## Later: own features

- [ ] Photo carousel on the wall iPad without running Immich (today the screensaver only
      reads Immich). Options: photos uploaded into Yuvomi, or a shared iCloud album.
      Start from `public/components/photo-screensaver.js` and `server/routes/screensaver.js`.
- [ ] Own visual design. Keep it in separate override files (and modules, see `MODULES.md`)
      so upstream merges stay easy; see `DESIGN.md` for upstream's design rules.
- [ ] Optional: SMTP (password reset emails), see `EMAIL_*` in `.env`

## Maintenance

- Upstream update: `git fetch upstream --tags && git merge vX.Y.Z` → push to `main`
  → image builds and deploys automatically.
- Use a regular merge for PRs into `main`, not squash, so the upstream history stays intact.
