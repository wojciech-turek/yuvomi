# This fork

`wojciech-turek/yuvomi` is a fork of [ulsklyc/yuvomi](https://github.com/ulsklyc/yuvomi)
for one household, self-hosted on Hetzner. Upstream's README describes the app;
this file describes what is different here.

## What changed compared to upstream

- `deploy/hetzner/`: Docker Compose + Caddy deployment, bootstrap and update scripts,
  setup guide (start there).
- `.github/workflows/home-image.yml` builds this fork's image to
  `ghcr.io/wojciech-turek/yuvomi`. Upstream's publish, Umbrel, Claude review and
  Dependabot workflows were removed: they push to upstream's registries or need
  upstream's secrets. Dependency updates arrive by merging upstream.

## Pulling in upstream releases

```bash
git remote add upstream https://github.com/ulsklyc/yuvomi.git   # once
git fetch upstream --tags
git merge v2.79.0          # or upstream/main
```

Keep our own changes small and in their own files where possible, so these merges stay easy:
custom features as modules in `modules/` (see `MODULES.md`), design changes as
overrides on top of the existing styles rather than edits all over upstream's CSS.

## Ideas / backlog

- Photo carousel on the wall iPad without running Immich (e.g. a shared iCloud album or
  photos uploaded into Yuvomi).
- Own visual design.
