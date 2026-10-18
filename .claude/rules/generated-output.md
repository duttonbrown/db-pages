---
paths:
  - "production/production-dashboard/**"
  - "operations/library/*.json"
  - "operations/library/*.js"
  - "operations/library/*.css"
  - "operations/open-orders/data.json"
  - "operations/parts-usage/*.html"
  - "dutton-brown/**"
  - "brand-site/**"
---

# Published output — edit the source, not this copy

Every path above is written by a job or copied from another repo. A hand edit here is
overwritten on the next run and never reaches the thing people actually use.

| Published here | Written by |
|---|---|
| `production/production-dashboard/data/dashboard.json` | `db-operations/projects/production-dashboard/build_data.py` |
| `operations/library/parts-library.json`, `parts-images/`, `supply-images/`, `glossary-images/` | `db-operations/projects/bom-source-of-truth/parts_fetch.py` |
| `operations/library/products-library.json` | `db-operations/projects/products-library/build_products_library.py`, run by `refresh_products.py`, which commits and pushes this repo itself |
| `operations/parts-usage/*.html` | `db-operations/projects/parts-usage/build_dashboard.py` and `build_yoy_dashboard.py`, which render beside the script and are copied here |
| `dutton-brown/operations/open-orders/data.json` | `db-operations/.github/workflows/open-orders.yml`, hourly, pushing straight to `main` |
| `brand-site/**` | the source pages in `db-marketing/branding-site/` |

The print queue is not published here. Its public copy was retired on 2026-10-18 (travelers belong
on the gated hub); the board lives only in db-private. `production/logo-dutton-brown.svg` stays,
because `print_queue.py` copies it into the hub board as the canonical brandmark.

Adding a file whose name starts with `_` under `operations/library/` only works because
the root `.nojekyll` exists; see `docs/archive/nojekyll-underscore-files.md`.
