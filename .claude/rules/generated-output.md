---
paths:
  - "production/print-queue*.html"
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
| `production/print-queue.html`, `print-queue-rules.html`, `logo-dutton-brown.svg` | `db-operations/projects/work-order-sync/print_queue.py --publish`, on the hourly `print-queue-task.ps1` schedule |
| `production/production-dashboard/data/dashboard.json` | `db-operations/projects/production-dashboard/build_data.py` |
| `operations/library/parts-library.json`, `parts-images/`, `supply-images/`, `glossary-images/` | `db-operations/projects/bom-source-of-truth/parts_fetch.py` |
| `operations/library/products-library.json` | `db-operations/projects/products-library/build_products_library.py`, run by `refresh_products.py`, which commits and pushes this repo itself |
| `operations/parts-usage/*.html` | `db-operations/projects/parts-usage/build_dashboard.py` and `build_yoy_dashboard.py`, which render beside the script and are copied here |
| `dutton-brown/operations/open-orders/data.json` | `db-operations/.github/workflows/open-orders.yml`, hourly, pushing straight to `main` |
| `brand-site/**` | the source pages in `db-marketing/branding-site/` |

Two things the print-queue publisher enforces, which a hand edit would undo:

- The public copy is redacted (`redact_for_public`) — no customer name, address, phone,
  email or note ever reaches this repo. The unredacted board and
  `unfulfilled-travelers.json` go to db-private only.
- `RELEASE_WEBHOOK` and `REFRESH_WEBHOOK` are replaced with `/disabled-on-public-board`.
  Path secrecy is the only authorization on those doorbells, so publishing the real
  endpoints would let anyone reading the page source release a board.

Adding a file whose name starts with `_` under `operations/library/` only works because
the root `.nojekyll` exists; see `docs/archive/nojekyll-underscore-files.md`.
