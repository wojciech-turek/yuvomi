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

## Turn on AI (built 2026-10-19)

- [ ] Settings → Dom → AI: paste the Anthropic API key (console.anthropic.com), switch "Pomoc AI" on,
      press "Sprawdź połączenie". Monthly limit defaults to $5; expected use is about $1-3.
- [ ] Optional: TypeSafe Jev key in the same place (fast aisle sorting; without it Haiku does it)
- [ ] Add a few sentences under "Co Yuvomi o was wie" (diet, dislikes, shopping day), or press
      "Zadaj pytanie teraz" and answer on the dashboard
- [ ] Both iPhones: allow notifications in the home-screen app (for the 17:30 heads-up)

What it does: cook mode (recipes and the wall tablet), aisle guessing and "Pewnie się kończy"
chips in shopping, ingredient suggestions when entering a meal (one tap to the shopping list),
"Podpowiedz posiłek" ideas, pantry from a photo, one daily heads-up (rules only, no tokens),
and a weekly question plus learned habits that grow the memory.

## Backups

- [ ] Hetzner Storage Box with WebDAV → fill `WEBDAV_BACKUP_*` in the server's `.env`
- [ ] Test a restore once (Settings → Household → Backup and restore)

## Later: own features

- [ ] Photo carousel on the wall iPad without running Immich (today the screensaver only
      reads Immich). Options: photos uploaded into Yuvomi, or a shared iCloud album.
      Start from `public/components/photo-screensaver.js` and `server/routes/screensaver.js`.
- [ ] Own visual design (we no longer merge upstream, so core styles can change directly;
      `DESIGN.md` still describes the rules the tests enforce).
- [ ] Kitchen tablet "Brakuje" button: add to the shopping list from the wall (needs one display
      write route for shopping items).
- [ ] Remove the 24 unused locales (only pl and en matter) once nothing depends on them.
- [ ] Optional: SMTP (password reset emails), see `EMAIL_*` in `.env`

## Maintenance

- Developed independently since 2026-10-19 (no upstream merges, see FORK.md).
- Push to `main` → GitHub builds the image → the pre-push hook deploys it from the Mac.
- New UI strings: `node scripts/i18n-add.mjs scripts/i18n/<file>.json` (pl + en, others get en).
