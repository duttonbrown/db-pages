# favicons/ — Browser tab, home screen, PWA

Pixel-specific icon assets for web browsers, iOS home screens, Android launchers, and PWAs.

## Use these when

- Wiring up a website's `<head>` (tab icon, apple-touch-icon, PWA manifest)
- Configuring a browser extension or webview icon
- Any context that requires *exact* pixel dimensions

## Don't use these for

- Social avatars — use [`../avatars/`](../avatars/), which are sized for feeds not browsers
- Anywhere outside web/app infrastructure — use [`../brandmark/`](../brandmark/)

## Why the brandmark (not the wordmark)

Favicons are tiny — 16 × 16 up to 512 × 512. The full wordmark is unreadable at those sizes. These use the **Satoshi Medium 500 brandmark** because the heavier weight survives the scale-down; Light 300 blurs out below ~48 px.

## Files shipped

| File | Used for |
|---|---|
| `favicon.ico` | Legacy browser fallback. Include for max compatibility. |
| `favicon-16.png` | Browser tab (standard DPI) |
| `favicon-32.png` | Browser tab (retina) |
| `favicon-48.png` | Windows / some PWAs |
| (PNG note) | All PNGs ship with a Ghost White bg baked in — they read on light *and* dark browser tabs because the tile carries its own surface. |
| `apple-touch-icon.png` (180×180) | iOS home screen |
| `android-chrome-192.png` | Android launcher (standard) |
| `android-chrome-512.png` | Android launcher (retina) + PWA splash |
| `favicon.svg` | Modern browsers, **light-mode tabs** — solid Shadow Grey on transparent |
| `favicon-white.svg` | Modern browsers, **dark-mode tabs** — solid white on transparent |

## Recommended `<head>` setup

```html
<!-- SVG, theme-aware: browser picks the matching ink for the user's OS theme -->
<link rel="icon" type="image/svg+xml" href="/favicons/favicon.svg"
      media="(prefers-color-scheme: light)">
<link rel="icon" type="image/svg+xml" href="/favicons/favicon-white.svg"
      media="(prefers-color-scheme: dark)">

<!-- PNG fallbacks (Ghost White bg baked in — readable on any tab theme) -->
<link rel="icon" type="image/png" sizes="32x32" href="/favicons/favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/favicons/favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="/favicons/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
```

The two-SVG `media="(prefers-color-scheme: ...)"` pattern is supported in current Chrome, Safari, and Firefox. Older browsers ignore the media attribute and fall through to the PNG fallbacks, which always show a Ghost White tile — visible regardless of tab theme.

## Regenerating

Two-step:

1. Run `ily-export-favicons.jsx` from Illustrator → exports the 6 PNGs + 2 SVGs.
2. From the repo root, run `py logos/scripts/make-favicon-ico.py` → bundles `favicon-16/32/48.png` into `favicon.ico`.

The script's alert at the end of step 1 prints the exact `py` command to copy.
