# Dutton Brown — Pages (GitHub Pages)

Public static HTML hosted via GitHub Pages. Dutton Brown content organized by team under `dutton-brown/`. Other brands (iloveyouth, etc.) get their own top-level folders.

- URL: https://duttonbrown.github.io/pages/
- Repo: https://github.com/duttonbrown/pages
- Branch: `main`

## Structure

```
dutton-brown/
  company-wide/    — roadmap, annual report, team pillars
  admin-hr/        — (empty for now)
  operations/      — QB rollout, MrPeasy migration, parts usage, open orders
  production/      — KPI map, BOMs, color queue, wash lists, fulfillment
  design-dev/      — (empty for now)
  marketing/       — KPI map, trade program, dashboards
    data/          — JSON files written by n8n workflows (powering dashboards)
      omnisend/    — campaigns.json, automations.json, goals.json (future)
  shared/          — Chart.js, brand tokens, common CSS

brand-site/        — Dutton Brown brand concepts (kept at root for URL stability)
iloveyouth-brand/  — iloveyouth logo preview (eventually moves to ily-public)
swiftbladefelix/   — external/personal project
index.html         — landing page with team-grouped catalog
```

## On privacy

This repo is **public**. Content is accessible to anyone who finds the URL. Do NOT commit anything that's truly sensitive (customer PII, unreleased financials, private strategic plans that competitors could weaponize).

Most operational content (KPI maps, BOMs, color queues, open orders) is low-sensitivity — the realistic threat of a random stranger finding these URLs is low. For convenience and iframe-friendly embedding in Notion, public hosting is the right tradeoff.

## Cross-Machine Sync

- `dbpush` — commit & push all repos
- `dbpull` — pull latest on all repos
- `dbs` — show status across all repos
- Script: `~/repos/db-sync.sh` | Aliases in `~/.bashrc`
