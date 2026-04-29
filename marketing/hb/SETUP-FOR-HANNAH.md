# How to Share Marketing Pages — Setup for Hannah

Hi Hannah! This guide gets you set up to publish your dashboards and reports yourself. After the one-time setup, publishing a new page takes 30 seconds.

## What you'll be doing

- Building HTML pages (or copying templates) inside the `marketing/hb/` folder
- Pushing them live yourself with three git commands — no need to involve Thomas
- Each page gets its own URL like `https://duttonbrown.github.io/db-pages/marketing/hb/your-folder/`

---

## One-time setup (Mac)

### 1. Make sure git is installed

Open **Terminal** (Cmd+Space → "Terminal" → Enter) and run:

```bash
git --version
```

If it prints a version number, you're good. If it pops up a prompt to install developer tools, click "Install" and wait for it to finish.

### 2. Tell git who you are

In Terminal, run these once:

```bash
git config --global user.name "Hannah <Your Last Name>"
git config --global user.email "hannah@duttonbrown.com"
```

### 3. Clone the db-pages repo

Still in Terminal:

```bash
mkdir -p ~/repos
cd ~/repos
git clone https://github.com/duttonbrown/db-pages.git
```

This downloads the whole site to your Mac at `~/repos/db-pages` (which is `/Users/<yourname>/repos/db-pages` in Finder). You'll edit files inside `marketing/hb/`.

### 4. Get GitHub access

Ask Thomas to add you to the `duttonbrown` GitHub org with write access to `db-pages`. The first time you push, your Mac will pop up a login window — sign in with your GitHub account and macOS Keychain will remember you.

### 5. Install a text editor (optional but recommended)

[VS Code](https://code.visualstudio.com/) is free and great for HTML. TextEdit will technically work but isn't ideal for code.

---

## Daily workflow — adding a new page

### 1. Pull the latest changes

Always do this first so you don't conflict with anything Thomas pushed:

```bash
cd ~/repos/db-pages
git pull
```

### 2. Create your page

Make a new folder inside `marketing/hb/` and put an `index.html` file in it:

```
marketing/hb/q2-report/index.html
```

The folder name becomes part of the URL, so use lowercase with dashes (`q2-report`, not `Q2 Report`).

Easiest way to start: copy `marketing/hb/example-page/index.html` into your new folder and edit from there.

### 3. Test it locally

Double-click your `index.html` file in Finder. It opens in your browser — no need for a server. If it looks right locally, it'll look right when published.

### 4. Push it live

Three commands in Terminal:

```bash
cd ~/repos/db-pages
git add marketing/hb/
git commit -m "Add Q2 report"
git push
```

Within ~1 minute, your page is live at:
`https://duttonbrown.github.io/db-pages/marketing/hb/q2-report/`

### 5. Updating a page later

Same flow — edit the file, then:

```bash
cd ~/repos/db-pages
git pull
# make your edits
git add marketing/hb/
git commit -m "Update Q2 report with new charts"
git push
```

---

## File structure

Put each page/report in its own folder:

```
db-pages/marketing/hb/
├── README.md
├── SETUP-FOR-HANNAH.md (this file)
├── example-page/
│   └── index.html
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

The file inside the folder must be named exactly `index.html` — that's what GitHub Pages serves when someone visits the folder URL.

---

## Important: this repo is public

`db-pages` is a **public GitHub repo**. Everything you push is visible on the internet — anyone can read your HTML, CSS, and any data files you include.

This is intentional — GitHub Pages needs the repo to be public to host the site for free. But it means:

**Never put any of this in db-pages:**

- API keys, passwords, or tokens
- Customer PII (names, emails, addresses, phone numbers)
- Financial data you don't want public
- Internal documents or trade secrets

**Safe to publish:**

- Dashboard mockups
- Reports with anonymized or aggregated data
- Design concepts and presentations
- Public-facing content

If you need to analyze sensitive data, do that locally on your Mac — just publish the final cleaned-up report.

---

## Common issues

### "Permission denied" when pushing

You don't have write access yet — ask Thomas to add you to the `duttonbrown` GitHub org.

### "Updates were rejected because the remote contains work that you do not have"

Someone (probably Thomas) pushed something while you were editing. Run:

```bash
git pull
git push
```

### My page is 404'ing

- The file inside your folder must be named exactly `index.html` (not `Index.html`, not `q2-report.html`)
- Wait ~60 seconds after pushing — GitHub Pages takes a minute to rebuild
- Make sure your folder name matches the URL exactly (case-sensitive)

### I broke something

You can always undo your last uncommitted edits:

```bash
git checkout -- marketing/hb/your-folder/
```

For anything beyond that, ask Thomas.

---

## Questions?

Ask Thomas.
