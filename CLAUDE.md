# Dutton Brown — Pages (GitHub Pages)

> **`db-pages` — one domain in Thomas's `~/repos` workspace.**
> **Owns:** Dutton Brown static published pages (public GitHub Pages). No PII — customer data lives in `db-private`, never here.
> Master cross-repo rules & area map: `~/repos/CLAUDE.md` (source: `systems/repos-CLAUDE.md`). Keep out-of-scope work in its home repo.
> **Sync:** `syncpull` at session start · `syncpush` after edits (`dbpush`/`ilypush` brand-scoped, `dbs` status) — see `~/repos/SYNC-GUIDE.md`.
> **Cowork:** Claude edits files (they sync to disk) but does **NOT** run git — not even read-only; any git command in the Cowork mount strands `.git/index.lock` (fix: `rm -f .git/index.lock`). Thomas runs the sync commands.

Public static HTML hosted via GitHub Pages, organized by team at the repo root.

- URL: https://duttonbrown.github.io/db-pages/
- Repo: https://github.com/duttonbrown/db-pages
- Branch: `main`

## .nojekyll — do not remove

The root `.nojekyll` (added 2026-08-08) makes GitHub Pages serve the repo as-is. Without it, Pages runs Jekyll, which **silently excludes any file or folder starting with `_`** — `operations/library/supply-images/_1208-1-A.png` (from `#`-prefixed Magic Rack supplier SKUs, `#` sanitizes to `_`) 404'd while sitting in the repo. Nothing here uses Jekyll (no `_config.yml`, no markdown pages), so the file is pure win: underscore files serve, and deploys skip the Jekyll build.

## Structure (team folders live at repo ROOT — verified 2026-08-08)

```
company-wide/    — roadmap, annual report, team pillars
admin-hr/
operations/      — QB rollout, inventory/PO build, parts usage, open orders, parts library
production/      — KPI map, print-queue pages, fulfillment dashboards, parts-images/
design-dev/
marketing/       — KPI map, trade program, dashboards (data/ JSON written by n8n)
shared/          — Chart.js, brand tokens, common CSS
brand-site/      — Dutton Brown brand concepts (kept at root for URL stability)
dutton-brown/    — legacy leftover (operations/open-orders only) — do not add new content here
index.html       — landing page with team-grouped catalog
```

## On privacy

This repo is **public** — anyone with the URL can read it. Never commit: customer PII, unreleased financials, private strategic plans, or parts **prices** (the public `parts-library.json` is redacted; costs live only in the db-private overlay — see db-operations/CLAUDE.md).

**BOMs, color queues, and wash lists are NOT low-sensitivity** — they contain customer-order data and live on the gated hub (`db-private`), never here. If a page needs PII or order detail, it belongs in db-private. Low-sensitivity operational dashboards (KPI maps, open-order counts, fulfillment stats) are fine here for Notion iframe embedding.
