# 2025 Parts Usage Dashboard — How It Was Made

## What This Is

An interactive dashboard showing estimated annual parts consumption for every component Dutton Brown uses, broken down by finish type (Brass, Nickel, Black, Color/powder coat, and No Finish/standard hardware).

## Data Sources

Three inputs feed the dashboard:

1. **Shopify Orders CSV** — A full export of 2025 orders from Shopify, providing the raw order line items with SKU and variant info.

2. **Sales Master Excel** (`DuttonBrown_2025_Master.xlsx`) — Built from the Shopify export, this spreadsheet has one row per product SKU with unit counts split by finish: Brass, Nickel, Black, Color, and Total. For non-color products, the finish splits come directly from SKU suffix codes. For color products (which also come in brass/nickel/black metal finishes), the splits were derived from the order line item names in the CSV.

3. **Notion Databases** — Three databases were queried via the Notion API:
   - **Products DB**: Each product page contains a parts table listing every component and its quantity per unit. A "Finish Type" property (Finish Only, Color Only, or Finish+Color) and a "Color Parts" relation determine how each part's usage gets bucketed.
   - **Parts DB**: The master list of ~270 components, each tagged with a Part Role (Standard, Finish Only, Color Only, or Finish+Color) and a Glossary Term (the part category like "Coupling", "Globe Cap", "Nipple", etc.).
   - **Kits DB**: Used for extension rod (ER) products, which are assembled from sub-components tracked in a separate database with a recursive parent/child structure.

## How It Works

A Python script (`notion_parts_usage_9.py`) does the heavy lifting:

1. **Loads sales data** from Excel and enriches color product finish splits from the Shopify CSV
2. **Queries all 268 products** with 2025 sales from Notion
3. **Reads each product's parts table** via the Notion API (the tables live inside the product page as block content)
4. **Multiplies** part quantity × units sold per finish, routing each part to the correct bucket based on its Part Role and the product's Finish Type
5. **Handles special cases**: extension rods via the Kits DB, plug-in variants (CA5 canopy swapped for CA5-M2), and products with mixed finish/color parts
6. **Writes the results** back to the Parts DB in Notion (five number properties: Brass Use 2025, Nickel Use 2025, Black Use 2025, Color Use 2025, No Finish Use 2025)
7. **Exports a JSON scratchpad** of all accumulated part counts

The dashboard HTML was then generated from that JSON scratchpad. It's a single self-contained file using Chart.js for the visualizations — no server or database connection needed to view it.

## What the Dashboard Shows

- **KPI cards** — Total units plus per-finish totals across all parts
- **Finish Mix donut** — Overall proportion of brass vs. nickel vs. black vs. color vs. no-finish
- **Top 15 Parts by Volume** — Highest-consumption parts, stacked by finish
- **Glossary Term Usage** — Parts grouped by their category (e.g., all Couplings, all Nipples), stacked by finish
- **Drill-down table** — Every glossary term expandable to show individual parts, with search, sorting, and inline finish-mix bars
- **Procurement Summary** — Units split into three procurement categories: pre-finished from supplier (brass + nickel + black), raw for in-house powder coat (color), and standard hardware (no finish)
- **Top 10 Color Parts** — Highest-volume parts going through the powder coat process

## Key Numbers (2025)

| Metric | Value |
|---|---|
| Products processed | 268 |
| Unique parts tracked | 242 |
| Glossary terms (categories) | ~45 |

## Notes

- Refunded orders are included in the counts (consistent with how the sales master is built)
- 3 part references couldn't be resolved due to formatting issues in Notion — these are excluded but represent negligible volume
- The dashboard is a snapshot from the last script run, not a live connection
