# How to Share Marketing Pages — Setup for Hannah

Hi Hannah! This guide explains how to publish your dashboards and reports so the team can see them.

## The Simple Version

1. Clone `db-pages` to your computer (ask Thomas for the link)
2. Create HTML files in the `marketing/hb/` folder
3. Test them locally (just open the file in your browser)
4. Tell Thomas: "I'm ready to publish my Q2 report" or "Push my campaign analysis"
5. Thomas pushes it to GitHub, and your page is live at: `https://duttonbrown.github.io/db-pages/marketing/hb/<your-folder>/`

## Why This Setup?

**Public vs. Private:**
- `db-pages` is **public on GitHub**. Anyone can see the code and HTML files on the internet.
- This is intentional — it powers all our published dashboards and team pages.
- It's published via GitHub Pages, which automatically deploys everything to the web.

**No Sensitive Data:**
Because it's public, **never put this in db-pages:**
- API keys or credentials
- Personal information
- Passwords or tokens
- Financial data you don't want public
- Internal trade secrets

**Keep it public-safe:**
- Dashboard mockups ✅
- Reports you'd share with the team ✅
- Design concepts ✅
- Anonymized data and trends ✅

If you need to analyze sensitive data locally, do that on your own machine — just publish the final, cleaned-up report.

## What You Need

1. **db-pages repo** — clone it once, then you're good. It's a local folder on your computer.
2. **A text editor** — VS Code (free), Notepad++, or even Windows Notepad.
3. **No git knowledge** — you're just editing files. Thomas handles the GitHub part.

## File Structure

Put each page/report in its own folder:

```
db-pages/marketing/hb/
├── README.md (this file)
├── q2-report/
│   ├── index.html
│   ├── style.css
│   └── data.json
├── campaign-analysis/
│   └── index.html
└── dashboards/
    └── sales/
        └── index.html
```

Each folder gets its own live URL:
- `hb/q2-report/index.html` → `https://duttonbrown.github.io/db-pages/marketing/hb/q2-report/`
- `hb/dashboards/sales/index.html` → `https://duttonbrown.github.io/db-pages/marketing/hb/dashboards/sales/`

## How to Publish

**When you're ready to share a page:**

1. Make sure all files are in a folder (e.g., `hb/my-report/`)
2. Test it locally: double-click `index.html` and make sure it looks right
3. Message Thomas: "Push my report" or "I'm ready to publish the Q2 analysis"
4. Thomas will push it, and within seconds it's live on the web

**That's it.** No git, no command line, no scary stuff.

## Questions?

Ask Thomas.
