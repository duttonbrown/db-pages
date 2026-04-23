# Dutton Brown — Pages (PUBLIC)

Public-facing static HTML hosted via GitHub Pages. Internal/sensitive content lives in the private `db-private` repo (Cloudflare Pages, auth-gated at private.duttonbrown.com).

- URL: https://duttonbrown.github.io/pages/
- Repo: https://github.com/duttonbrown/pages (PUBLIC — anything committed is visible to anyone)
- Branch: `main`
- Future rename: `db-public` (deferred)

## What belongs here

Only content meant for the open web — brand concepts intended for outside marketers, public-facing design references, etc. If it has revenue numbers, customer data, internal strategy, or operational detail, it does NOT belong here — push to `db-private` instead.

## Structure

- `index.html` — Landing page
- `brand-site/` — Brand site design concepts (DB)
- `iloveyouth-brand/` — Logo preview (will move to `ily-public` repo when created)

## Cross-Machine Sync

- `dbpush` — commit & push all repos (skips settings_data.json)
- `dbpull` — pull latest on all repos (auto-stashes if dirty)
- `dbs` — show status across all repos
- Script: `~/repos/db-sync.sh` | Aliases in `~/.bashrc`
- Repos synced: db-development, db-marketing, db-brand, db-operations, db-design, pages, db-private
