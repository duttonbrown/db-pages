# HB Marketing Pages

This folder is for your dashboards, reports, and pages that you want to share.

You can publish your own pages — you don't need to ask Thomas. Read [SETUP-FOR-HANNAH.md](SETUP-FOR-HANNAH.md) for the full setup. Quick version below.

## How to add and publish a page

1. Make a new folder inside `marketing/hb/` — e.g. `hb/q2-report/`
2. Create a file called `index.html` inside it
3. Build your page (copy `hb/example-page/index.html` as a starting point)
4. Test locally — double-click `index.html` to open it in your browser
5. When ready, push it live with these commands in Terminal (Cmd+Space → "Terminal"):

```bash
cd ~/repos/db-pages
git pull
git add marketing/hb/
git commit -m "Add Q2 report"
git push
```

Within a minute, your page is live at:
`https://duttonbrown.github.io/db-pages/marketing/hb/q2-report/`

## Examples

- `hb/q2-report/index.html` → Published at `/marketing/hb/q2-report/`
- `hb/campaign-analysis/index.html` → Published at `/marketing/hb/campaign-analysis/`
- `hb/dashboards/sales/index.html` → Published at `/marketing/hb/dashboards/sales/`

Use subfolders to organize however makes sense to you.

## What you need

1. A copy of the `db-pages` repo cloned to `~/repos/db-pages` (one-time setup — see SETUP-FOR-HANNAH.md)
2. Terminal (built into macOS — Cmd+Space → "Terminal")
3. A text editor (VS Code recommended)

## Important: this repo is public

`db-pages` is a public GitHub repo. Anything you push is visible on the internet. Never put API keys, passwords, customer PII, or sensitive financial data in here. Dashboards, mockups, reports, and anonymized data are all fine.

## Questions?

Ask Thomas.
