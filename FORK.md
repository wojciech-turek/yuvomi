# This repository

`wojciech-turek/yuvomi` started as a copy of [ulsklyc/yuvomi](https://github.com/ulsklyc/yuvomi)
v2.78.0 for one household, self-hosted on Hetzner. Upstream's README describes the app;
this file describes what is different here.

**Since 2026-10-19 it is developed independently.** We no longer merge upstream releases
and change core code directly: there is no need to keep changes in side files for merge
compatibility. Upstream's conventions (tests, i18n, design rules in DESIGN.md) still apply,
because the test suite enforces them.

## What is different from upstream

- `deploy/hetzner/`: Docker Compose + Caddy deployment, bootstrap and update scripts,
  setup guide. Deploys run from the Mac (`deploy/hetzner/deploy.sh` + git hooks in
  `deploy/hetzner/git-hooks`), so GitHub holds no key to the server.
- `.github/workflows/home-image.yml` builds this repo's image to `ghcr.io/wojciech-turek/yuvomi`.
  Upstream's publishing workflows stay in place but are guarded with
  `if: github.repository == 'ulsklyc/yuvomi'`; the Claude workflows skip themselves without a token.
- Cook mode (`public/components/cook-mode.js`): full-screen recipe view with steps, timers and
  a screen that stays awake, also on the kitchen wall tablet (which may now read meals and recipes).
- AI features (in progress): see TODO.md.

## Translations

Only Polish and English matter for this household. `node scripts/i18n-add.mjs <keys.json>`
adds keys to every locale at once: Polish and English get their own text, every other
locale (German included) gets the English text, which keeps `test:i18n` and
`test:i18n-translated` green. Key files live in `scripts/i18n/`.
