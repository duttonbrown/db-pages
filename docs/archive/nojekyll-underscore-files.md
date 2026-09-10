# The supplier images that were in the repo and still 404'd (2026-08-08)

Magic Rack supplier SKUs start with `#`. `parts_fetch.py` sanitizes that character to `_`
when it names the image file, so `operations/library/supply-images/` ended up holding six
files like `_1208-1-A.png`.

They were committed, pushed and visible on GitHub, and every one of them 404'd on the
published site.

GitHub Pages runs Jekyll on a repo by default, and Jekyll silently excludes any file or
folder whose name starts with `_` — no build error, no warning, the file simply never
reaches the site. Nothing in db-pages uses Jekyll: there is no `_config.yml` and no
markdown page to render.

The fix was a root `.nojekyll`, added 2026-08-08. Pages then serves the repo as-is:
underscore files serve, and deploys skip the Jekyll build entirely.

The rule that came out of it lives in `CLAUDE.md`: never delete the root `.nojekyll`.
