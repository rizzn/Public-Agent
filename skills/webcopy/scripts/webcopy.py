#!/usr/bin/env python3
"""
webcopy.py — make a 1:1 offline backup of a single web page.

Produces a self-contained folder:

    <out>/
    ├── index.html          # the page, references rewritten to ./assets/...
    └── assets/
        ├── css/  js/  img/  fonts/  media/  other/

It downloads everything the page needs to render offline: stylesheets (and the
fonts / background images referenced *inside* those stylesheets, recursively),
scripts, images (incl. srcset), <link> icons/manifests, media, and inline
style url()s. Cross-origin assets (CDNs) are downloaded too, because a backup
that depends on a CDN staying online is not a backup.

Navigation links to *other pages* are rewritten to absolute URLs pointing at
the live site — this tool copies one page, not the whole site, so those links
should still take you somewhere real rather than to a dead file:// path.

Usage:
    webcopy.py URL [--out DIR]
    webcopy.py URL --html-file rendered.html   # use pre-rendered HTML (JS pages)

The --html-file path is the escape hatch for JavaScript-rendered pages: when a
static fetch only returns an empty app shell, render the page in a real browser,
save the DOM to a file, and pass it here with the original URL so links resolve.
The script still fetches every asset over the network — it only takes the HTML
markup from the file.

Exit: prints a JSON summary line prefixed with "WEBCOPY_SUMMARY: ". If the page
looks like an un-rendered JS shell and no --html-file was given, the summary's
"js_shell" field is true — that's the signal to re-run with rendered HTML.
"""

import argparse
import json
import os
import re
import sys
from urllib.parse import urljoin, urlsplit, urlunsplit, unquote

import requests

try:
    from bs4 import BeautifulSoup
except ImportError:
    sys.exit("Missing dependency: pip install beautifulsoup4")

# Prefer lxml, fall back to the stdlib parser so the script runs anywhere.
try:
    import lxml  # noqa: F401
    PARSER = "lxml"
except ImportError:
    PARSER = "html.parser"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0 Safari/537.36")

# Where each asset kind lands, chosen by file extension or content-type.
EXT_DIR = {
    "css": "css",
    "js": "js", "mjs": "js",
    "png": "img", "jpg": "img", "jpeg": "img", "gif": "img", "svg": "img",
    "webp": "img", "avif": "img", "ico": "img", "bmp": "img",
    "woff": "fonts", "woff2": "fonts", "ttf": "fonts", "otf": "fonts", "eot": "fonts",
    "mp4": "media", "webm": "media", "ogg": "media", "mp3": "media", "wav": "media",
    "m4a": "media", "mov": "media",
}
CT_DIR = [
    ("text/css", "css"),
    ("javascript", "js"),
    ("font", "fonts"),
    ("image/", "img"),
    ("video/", "media"),
    ("audio/", "media"),
]


class Downloader:
    def __init__(self, out_dir, page_url):
        self.out = out_dir
        self.assets_root = os.path.join(out_dir, "assets")
        self.page_url = page_url
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": UA})
        self.cache = {}          # absolute url -> relative local path
        self.used_names = set()  # taken local filenames, to avoid collisions
        self.ok = 0
        self.failed = []         # list of (url, reason)

    @staticmethod
    def _normalize(base, ref):
        """Resolve ref against base; return absolute http(s) url or None to skip."""
        if not ref:
            return None
        ref = ref.strip()
        low = ref.lower()
        if (low.startswith("data:") or low.startswith("mailto:")
                or low.startswith("tel:") or low.startswith("javascript:")
                or low.startswith("blob:") or ref.startswith("#")):
            return None
        absu = urljoin(base, ref)
        parts = urlsplit(absu)
        if parts.scheme not in ("http", "https"):
            return None
        return urlunsplit((parts.scheme, parts.netloc, parts.path, parts.query, ""))

    def _local_name(self, url, kind_hint=None):
        parts = urlsplit(url)
        base = os.path.basename(unquote(parts.path)) or "index"
        base = re.sub(r"[^A-Za-z0-9._-]", "_", base)
        stem, ext = os.path.splitext(base)
        ext = ext.lstrip(".").lower()
        subdir = EXT_DIR.get(ext) or kind_hint or "other"
        if not ext and kind_hint:
            stem = stem or "asset"
        candidate = f"{stem}.{ext}" if ext else stem
        candidate = candidate or "asset"
        rel = os.path.join("assets", subdir, candidate)
        n = 1
        root, e = os.path.splitext(candidate)
        while rel.lower() in self.used_names:
            candidate = f"{root}_{n}{e}"
            rel = os.path.join("assets", subdir, candidate)
            n += 1
        self.used_names.add(rel.lower())
        return rel, subdir

    def _dir_from_ct(self, ct):
        ct = (ct or "").lower()
        for needle, d in CT_DIR:
            if needle in ct:
                return d
        return None

    def fetch(self, url, kind_hint=None, is_css=False):
        """Download url once; return the path relative to index.html (or None)."""
        if url in self.cache:
            return self.cache[url]
        try:
            r = self.session.get(url, timeout=30, allow_redirects=True)
            r.raise_for_status()
        except Exception as e:  # noqa: BLE001
            self.failed.append((url, str(e)[:120]))
            self.cache[url] = None
            return None

        ct_dir = self._dir_from_ct(r.headers.get("Content-Type"))
        rel, subdir = self._local_name(url, kind_hint=ct_dir or kind_hint)
        abspath = os.path.join(self.out, rel)
        os.makedirs(os.path.dirname(abspath), exist_ok=True)

        if is_css or subdir == "css":
            css = r.content.decode(r.apparent_encoding or "utf-8", errors="replace")
            css = self._rewrite_css(css, base_url=r.url,
                                    css_rel_dir=os.path.dirname(rel))
            with open(abspath, "w", encoding="utf-8") as f:
                f.write(css)
        else:
            with open(abspath, "wb") as f:
                f.write(r.content)

        self.cache[url] = rel
        self.ok += 1
        return rel

    _CSS_URL = re.compile(r"url\(\s*(['\"]?)([^'\")]+)\1\s*\)", re.I)
    _CSS_IMPORT = re.compile(r"""@import\s+(?:url\()?\s*(['"])(.+?)\1""", re.I)

    def _rewrite_css(self, css, base_url, css_rel_dir):
        """Rewrite refs inside a stylesheet to be relative to that stylesheet."""
        def to_rel(target_rel):
            return os.path.relpath(target_rel, css_rel_dir).replace(os.sep, "/")

        def repl_url(m):
            quote, ref = m.group(1), m.group(2)
            absu = self._normalize(base_url, ref)
            if not absu:
                return m.group(0)
            rel = self.fetch(absu)
            if not rel:
                return m.group(0)
            return f"url({quote}{to_rel(rel)}{quote})"

        def repl_import(m):
            quote, ref = m.group(1), m.group(2)
            absu = self._normalize(base_url, ref)
            if not absu:
                return m.group(0)
            rel = self.fetch(absu, is_css=True)
            if not rel:
                return m.group(0)
            return f'@import "{to_rel(rel)}"'

        css = self._CSS_IMPORT.sub(repl_import, css)
        css = self._CSS_URL.sub(repl_url, css)
        return css

    def _rewrite_srcset(self, value, base):
        out = []
        for part in value.split(","):
            part = part.strip()
            if not part:
                continue
            bits = part.split(None, 1)
            absu = self._normalize(base, bits[0])
            if absu:
                rel = self.fetch(absu, kind_hint="img")
                if rel:
                    bits[0] = rel
            out.append(" ".join(bits))
        return ", ".join(out)

    def _rewrite_inline_style(self, value, base):
        def repl(m):
            quote, ref = m.group(1), m.group(2)
            absu = self._normalize(base, ref)
            if not absu:
                return m.group(0)
            rel = self.fetch(absu)
            return f"url({quote}{rel}{quote})" if rel else m.group(0)
        return self._CSS_URL.sub(repl, value)


ASSET_ATTRS = [
    ("link", "href", None),
    ("script", "src", "js"),
    ("img", "src", "img"),
    ("img", "data-src", "img"),
    ("source", "src", "media"),
    ("video", "src", "media"),
    ("video", "poster", "img"),
    ("audio", "src", "media"),
    ("embed", "src", None),
    ("object", "data", None),
    ("track", "src", None),
]
DOWNLOAD_RELS = {"stylesheet", "icon", "shortcut icon", "apple-touch-icon",
                 "apple-touch-icon-precomposed", "manifest", "preload",
                 "mask-icon", "modulepreload"}


def looks_like_js_shell(soup, html):
    """Heuristic: near-empty body + a JS bundle + a mount div => needs rendering."""
    body = soup.body
    text_len = len(body.get_text(strip=True)) if body else 0
    scripts = soup.find_all("script", src=True)
    mount = soup.select_one("#root, #app, #__next, [data-reactroot]")
    return text_len < 200 and len(scripts) >= 1 and mount is not None


def main():
    ap = argparse.ArgumentParser(description="1:1 offline backup of a single web page.")
    ap.add_argument("url", help="Page URL to back up.")
    ap.add_argument("--out", help="Output folder (default: derived from the URL).")
    ap.add_argument("--html-file", help="Use pre-rendered HTML from this file "
                    "instead of a static fetch (for JS-rendered pages).")
    args = ap.parse_args()

    page_url = args.url
    parts = urlsplit(page_url)
    if parts.scheme not in ("http", "https"):
        sys.exit("URL must start with http:// or https://")

    out_dir = args.out
    if not out_dir:
        slug = (parts.netloc + parts.path).rstrip("/")
        slug = re.sub(r"[^A-Za-z0-9._-]", "_", slug) or "webcopy"
        out_dir = os.path.join(os.getcwd(), slug)
    os.makedirs(out_dir, exist_ok=True)

    dl = Downloader(out_dir, page_url)

    if args.html_file:
        with open(args.html_file, "r", encoding="utf-8", errors="replace") as f:
            html = f.read()
        rendered = True
    else:
        try:
            r = dl.session.get(page_url, timeout=30)
            r.raise_for_status()
            page_url = r.url
            html = r.content.decode(r.apparent_encoding or "utf-8", errors="replace")
        except Exception as e:  # noqa: BLE001
            sys.exit(f"Failed to fetch page: {e}")
        rendered = False

    soup = BeautifulSoup(html, PARSER)
    base = page_url
    base_tag = soup.find("base", href=True)
    if base_tag:
        base = urljoin(page_url, base_tag["href"])
        base_tag.decompose()

    js_shell = (not rendered) and looks_like_js_shell(soup, html)

    # 1) Tag/attribute assets.
    for tag, attr, hint in ASSET_ATTRS:
        for el in soup.find_all(tag):
            if not el.has_attr(attr):
                continue
            if tag == "link":
                rels = {x.lower() for x in (el.get("rel") or [])}
                if not (rels & DOWNLOAD_RELS):
                    continue
            absu = dl._normalize(base, el[attr])
            if not absu:
                continue
            is_css = (tag == "link" and "stylesheet" in
                      {x.lower() for x in (el.get("rel") or [])})
            rel = dl.fetch(absu, kind_hint=hint, is_css=is_css)
            if rel:
                el[attr] = rel

    # 2) srcset (img/source).
    for el in soup.find_all(["img", "source"]):
        for a in ("srcset", "data-srcset"):
            if el.has_attr(a):
                el[a] = dl._rewrite_srcset(el[a], base)

    # 3) Inline style="" url()s.
    for el in soup.find_all(style=True):
        el["style"] = dl._rewrite_inline_style(el["style"], base)

    # 4) <style> blocks.
    for el in soup.find_all("style"):
        if el.string:
            el.string.replace_with(
                dl._rewrite_css(el.string, base_url=base, css_rel_dir=""))

    # 5) Navigation links to other pages: absolutize so they still reach the
    #    live site when clicked, instead of becoming dead file:// links.
    for el in soup.find_all(["a", "area"]):
        href = el.get("href")
        if not href or href.strip().startswith("#"):
            continue
        absu = dl._normalize(base, href)
        if absu:
            el["href"] = absu

    index_path = os.path.join(out_dir, "index.html")
    with open(index_path, "w", encoding="utf-8") as f:
        f.write(str(soup))

    summary = {
        "url": args.url,
        "out": out_dir,
        "index": index_path,
        "assets_downloaded": dl.ok,
        "failed": len(dl.failed),
        "js_shell": bool(js_shell),
        "rendered_input": rendered,
    }
    if dl.failed:
        for u, why in dl.failed[:10]:
            print(f"  ! failed: {u} ({why})", file=sys.stderr)
    if js_shell:
        print("  * This page looks JavaScript-rendered; the static copy may be "
              "missing content. Re-run with --html-file using rendered HTML.",
              file=sys.stderr)
    print("WEBCOPY_SUMMARY: " + json.dumps(summary))


if __name__ == "__main__":
    main()
