> **`db-pages`** — one domain in Thomas's `~/repos` workspace. **Owns:** the public GitHub Pages site for Dutton Brown team pages — published HTML and its data files, no PII.
> Master cross-repo rules and area map: `~/repos/CLAUDE.md` (source: `systems/repos-CLAUDE.md`). Keep out-of-scope work in its home repo.
> **Sync:** `syncpull` at session start · `syncpush` after edits (`dbpush`/`ilypush`, `dbs` status), see `~/repos/SYNC-GUIDE.md`. **Cowork:** Claude edits files but never runs git (it strands `.git/index.lock`); Thomas runs the sync commands.

Site URL, folder layout and what each folder holds: `README.md`.

## This repo is public

- **Anyone with the URL can read every file here.** Never commit customer PII, unreleased financials, private strategic plans, or parts **prices** — the published `operations/library/parts-library.json` is redacted, and costs live only in the db-private overlay (see `db-operations/CLAUDE.md`).
- **BOMs, color queues, wash lists and work-order travelers are customer-order data,** not low-sensitivity: they belong on the gated hub (`db-private`), never here. Low-sensitivity dashboards — KPI maps, open-order counts, fulfillment stats — are fine, and Notion embeds them by iframe.
- **`noindex` is not access control.** Every page outside the catalog carries `<meta name="robots" content="noindex">` and the five team index pages stay indexable, but anything that must not be readable at all moves to db-private instead.
- **Scan before pushing:** `python ~/repos/db-operations/tools/db-pages-guard/scan.py --all` flags contact, order, customer and employee data. It warns, never blocks, and treats dollar amounts as public on purpose.

## Rules

- **Never delete the root `.nojekyll`.** Without it Pages runs Jekyll, which silently drops every path starting with `_`, so the `_`-prefixed supplier images in `operations/library/supply-images/` 404 while sitting in the repo. Nothing here uses Jekyll. → story: `docs/archive/nojekyll-underscore-files.md`
- **Most of this repo is published output, not source.** Which paths are machine-written, and where each generator lives, is in `.claude/rules/generated-output.md` — edit the source, never the copy here.
- **`brand-site/` stays at the repo root** for URL stability. It is the published copy of `db-marketing/branding-site/`; brand values themselves live in `db-brand`.
- **The hourly open-orders job writes `dutton-brown/operations/open-orders/data.json`** (db-operations `.github/workflows/open-orders.yml`), while the page fetches `operations/open-orders/data.json` beside itself. The two are not the same file — repoint one before trusting the numbers.
