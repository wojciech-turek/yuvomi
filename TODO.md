# TODO

Home manager on Yuvomi for `https://home.wojciechturek.com` (own Hetzner server `2.28.142.180`,
SSH as root with `~/.ssh/id_ed25519_lush`).
Setup details: [`deploy/hetzner/README.md`](deploy/hetzner/README.md). Fork notes: [`FORK.md`](FORK.md).

## Status (2026-10-18)

- [x] Fork upstream Yuvomi v2.78.0 with full history (`upstream` remote = `ulsklyc/yuvomi`)
- [x] Hetzner deployment: Compose, optional Caddy, `bootstrap.sh`, `update.sh`, setup guide
- [x] GitHub Actions: "Home Image" builds `ghcr.io/wojciech-turek/yuvomi:main` (first build passed)
- [x] Deploys from the Mac, no secrets on GitHub: `deploy/hetzner/deploy.sh`, run in the background
      by git hooks after pushing/pulling `main` (`git config core.hooksPath deploy/hetzner/git-hooks`)
- [x] CI green again: upstream workflows restored (their tests read them), publishing ones guarded

## Go live

- [x] DNS: `A` record `home.wojciechturek.com → 2.28.142.180`
- [ ] DNS: `AAAA` record `home.wojciechturek.com → 2a01:4f8:c012:2993::1` (IPv6 already serves HTTPS)
- [x] Ports 80/443 reachable (no Hetzner Cloud Firewall in the way)
- [x] Bootstrap on the server (2026-10-18): Yuvomi + bundled Caddy, Let's Encrypt certificate issued
- [x] Save `DB_ENCRYPTION_KEY` in the password manager
- [x] GHCR package `yuvomi` is public, so the server pulls the image

## Set up the household

- [x] Create the admin account at `/setup`
- [ ] Add `accounts@wojciechturek.com` as the email in the profile (usernames cannot contain `@`)
- [ ] Language → Polski; household region/time zone → Europe/Warsaw
- [ ] Invite wife: Settings → Household → Family
- [ ] iCloud: Settings → Calendar sync → CalDAV Calendars → Add CalDAV Account (`https://caldav.icloud.com`,
      Apple ID, app-specific password from account.apple.com), then tick the calendars
- [ ] ~~Reminder sync for iCloud Reminders~~: Apple stopped exposing Reminders lists over CalDAV in iOS 13
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
  → GitHub builds the image, the pre-push hook deploys it.
- Use a regular merge for PRs into `main`, not squash, so the upstream history stays intact.
