---
name: webcopy
description: >-
  Make a 1:1 offline backup of a single web page — download its HTML plus every
  asset it needs (CSS, JavaScript, images, fonts, icons, media) into a clean
  `index.html` + `assets/` folder that opens and renders offline. Use this
  whenever the user wants to save, back up, archive, snapshot, mirror, or grab a
  local/offline copy of a web page or website, or triggers `/webcopy`. Trigger
  even when they don't say "webcopy" — phrases like "save this page for offline",
  "back up this site", "download the whole page with images and css", "make a
  local copy of this URL", or "archive this before it goes down" all mean this
  skill. Do NOT use this for extracting/summarizing a page's text content, for
  taking a screenshot, or for crawling an entire multi-page site — this copies
  one page at a time, faithfully, with its assets.
---

# webcopy

Back up a single web page as a self-contained folder that renders offline.

## What it produces

```text
<output-folder>/
├── index.html          # the page, every reference rewritten to ./assets/...
└── assets/
    ├── css/  js/  img/  fonts/  media/  other/
```

Stylesheets are downloaded along with the fonts and background images referenced
*inside* them (recursively, including `@import`). Cross-origin/CDN assets are
pulled down too — a backup that still depends on a CDN staying online isn't a
backup. Links to *other pages* are rewritten to absolute live URLs so they don't
turn into dead `file://` links; this tool copies one page, not a whole site.

## How to use it

### 1. Get the target

You need the page URL and, ideally, where to save it. If the user gave a URL,
use it. If they want a specific output folder, pass `--out`; otherwise the script
derives a folder name from the URL. Save into the user's connected folder when
there is one so they can open the result.

### 2. Run the downloader

```bash
python3 <skill-dir>/scripts/webcopy.py "<URL>" --out "<output-folder>"
```

Dependencies are `requests` and `beautifulsoup4` (both standard in this
environment; if missing, `pip install requests beautifulsoup4 --break-system-packages`).
`lxml` is used automatically if present but isn't required.

The script prints progress and ends with a machine-readable line:

```text
WEBCOPY_SUMMARY: {"assets_downloaded": 42, "failed": 0, "js_shell": false, ...}
```

Read that JSON. Report `assets_downloaded`. If `failed` > 0, the script listed
each failed URL on stderr — mention how many assets couldn't be fetched and why
(a few failures, e.g. a tracking pixel or a 403'd font, are normal and don't
break the backup).

### 3. Handle JavaScript-rendered pages

Many modern sites (React, Vue, Next.js, etc.) ship an almost-empty HTML shell and
build the page in the browser. A plain fetch of those gets you a blank `<div id="root">`
and none of the real content. The script detects this and sets **`"js_shell": true`**
in the summary (it also prints a warning). When you see that flag — or when the
saved `index.html` obviously lacks the visible content — render the page first,
then feed the rendered HTML back in:

1. Open the URL in the browser (`mcp__claude-in-chrome__navigate`), let it load.
2. Grab the fully rendered markup — the reliable way is to return
   `document.documentElement.outerHTML` via `mcp__claude-in-chrome__javascript_tool`
   (or read the page and reconstruct the HTML). Save it to a temp file, e.g.
   `rendered.html`.
3. Re-run the script pointing at that file, keeping the **original URL** so all
   the relative asset paths resolve correctly:

```bash
python3 <skill-dir>/scripts/webcopy.py "<URL>" --html-file rendered.html --out "<output-folder>"
```

The script takes only the HTML markup from the file; it still fetches every asset
over the network. If no browser tool is available, deliver the static copy and
tell the user it may be missing JS-rendered content.

### 4. Deliver

Tell the user where the backup is and how many assets were saved, and present
`index.html` so they can open it. It opens directly in any browser with no server.

## Notes and edge cases

- **Network access.** The script fetches over the network with `requests`. In a
  restricted/proxied sandbox some or all external hosts may be blocked — if you
  see many connection failures in the summary, that's an environment limit, not a
  bug; say so plainly rather than retrying endlessly.
- **One page, not a site.** This deliberately backs up the single given URL. If
  the user wants multiple pages, run it once per URL (each into its own folder).
- **What's intentionally left alone.** `data:` URIs, `mailto:`/`tel:` links, and
  pure `#fragment` links are kept as-is; off-page navigation links are made
  absolute to the live site.
- **Re-runs.** Running again into the same folder overwrites `index.html` and
  re-fills `assets/`; point `--out` at a fresh folder to keep a dated snapshot.
