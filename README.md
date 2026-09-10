# db-pages — Dutton Brown team pages

Public static HTML served by GitHub Pages, organized by team at the repo root.

- Site: https://duttonbrown.github.io/db-pages/
- Repo: https://github.com/duttonbrown/db-pages
- Branch: `main` (a push is live after the Pages deploy, about a minute)

This repo is public: anyone with the URL can read every file in it. What may and may not be
published here is in [CLAUDE.md](CLAUDE.md); the paths that are machine-written are in
[.claude/rules/generated-output.md](.claude/rules/generated-output.md).

## Layout

```
index.html      catalog of every page, grouped by team
.nojekyll       serve the repo as-is — do not delete (see CLAUDE.md)

company-wide/   index, 2026 roadmap, team pillars
operations/     index, QuickBooks classes rollout brief
  library/        parts + products catalog: parts.js/css, products.js/css, two multi-MB
                  JSON files and ~780 part, supply, glossary and 3D images
  open-orders/    open-order dashboard + its data.json
  parts-usage/    2025 parts usage, product sales, year-over-year dashboards
  purchase-request/  request form and purchaser console
  mrpeasy-migration/ the June 2026 build-vs-buy decision and the superseded March brief
production/     index, KPI map, print-queue board + rules page, parts-family.json
  parts-images/     part photos used by the board
  production-dashboard/  dashboard page + dashboard.json
marketing/      index, marketing KPI map, trust coefficients, website design directions
  trade-program/    three trade-program concepts
  monthly-marketing-meetings/  May and August 2026 meetings + assets
  omnisend/         email dashboard; its data.json stopped updating 2026-04 (no live writer)
  hb/               example page and setup notes for Hannah
brand-site/     published copy of db-marketing/branding-site/: brand site concept pages,
                css/ tokens and components, templates/ for email and social
dutton-brown/   one file — operations/open-orders/data.json, written hourly by the
                db-operations GitHub Actions job. Do not add anything else here.

admin-hr/  design-dev/  shared/  marketing/data/omnisend/   empty, .gitkeep only
```

Folders are created by whoever publishes into them, so the empty placeholders above hold
a `.gitkeep` and nothing more — no shared CSS or tokens live in `shared/`, and the
`/_shared/` paths some published pages reference belong to the private hub, not this repo.
