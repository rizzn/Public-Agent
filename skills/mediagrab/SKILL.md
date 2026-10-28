---
name: mediagrab
description: Downloads one public video as mp4 (H.264/AAC) or its audio as mp3 from a URL — YouTube, X, Instagram, TikTok and other yt-dlp sites — and prints the file path. Use when a video or its audio has to be saved locally, or the user says "Video runterladen", "download this video", "als mp3". Do NOT use for transcripts — use transcribe; not for content behind a login or DRM.
dependencies:
  scripts: [scripts/setup.ps1, scripts/mediagrab.js]
  input: one URL, optional `--mp3` and `--out <dir>`
  output: one mp4 or mp3 file; its absolute path on stdout
---

# mediagrab

Non-interactive download on the yt-dlp engine: one call, one file, the path on stdout.
Self-contained — its binaries live in `bin/`, the script needs nothing beyond the Node standard
library.

## 0. Ground rules

- **Public content only.** No cookies, no login, no `--cookies-from-browser`. Content behind a
  login or DRM fails by design; report the yt-dlp error, never work around it.
- **Binaries come from this skill's `bin/` only,** resolved from `__dirname`. No PATH fallback
  and no other skill's `bin/`: a machine-installed yt-dlp with its own config would change the
  result.
- **One URL per call.** Playlists are ignored (`--no-playlist`); a playlist URL yields only the
  linked video.
- **Downloads are personal archiving.** Platform terms of service may forbid it; the user decides
  per source, the agent does not download in bulk on its own initiative.
- **Output stays in this skill's `tmp/` until the user deletes it.** Agents never delete, move or
  clean up files there. `--out` only when the user names another folder.

## 1. Folder layout

```text
skills/mediagrab/
├── SKILL.md              # this file — the contract
├── scripts/
│   ├── setup.ps1         # downloads and verifies bin/ from pinned sources (§4)
│   ├── setup.lock.json   # version, URL and SHA-256 per binary
│   └── mediagrab.js      # CLI entry point (§2)
├── tests/                # node:test suite, no network
├── bin/                  # yt-dlp.exe, ffmpeg.exe (~118 MB) — rebuilt by setup.ps1
└── tmp/                  # downloaded files — kept until the user deletes them
```

## 2. Commands

```powershell
node skills/mediagrab/scripts/mediagrab.js <url>              # mp4 into tmp/
node skills/mediagrab/scripts/mediagrab.js <url> --mp3        # audio only, mp3 into tmp/
node skills/mediagrab/scripts/mediagrab.js <url> --out <dir>  # folder named by the user
```

- **Formats** come from yt-dlp's built-in presets (`--preset-alias mp4` / `mp3`), not from own
  format logic.
- **YouTube** needs a JS runtime for its signature challenge; the script passes the Node that runs
  it (`--js-runtimes node:<execPath>`).
- **File name:** `<title> [<id>].<ext>`.

## 3. Output

- **stdout** carries only the absolute path of the finished file. yt-dlp warnings and errors go
  to stderr.
- **Exit codes:** `0` done · `2` bad arguments or `bin/yt-dlp.exe` missing (run `setup.ps1`) ·
  anything else is yt-dlp's own code.

## 4. Binaries

```powershell
powershell -ExecutionPolicy Bypass -File skills/mediagrab/scripts/setup.ps1          # downloads bin/, network yes, no cost
powershell -ExecutionPolicy Bypass -File skills/mediagrab/scripts/setup.ps1 -Check   # status only, no network
```

- **Pinned and verified.** Every binary has version, URL and SHA-256 in `setup.lock.json`:
  `yt-dlp.exe` from the GitHub releases of `yt-dlp/yt-dlp`, `ffmpeg.exe` from the gyan.dev
  `essentials_build` via its GitHub mirror `GyanD/codexffmpeg`. A hash mismatch deletes the
  download and exits `1`. A re-run skips what already matches.
- **`-Check`** prints one line per binary (`ok` · `missing` · `hash mismatch` · `not pinned`)
  and exits `1` if any is not `ok`.
- **Never auto-update.** `yt-dlp -U` is not run; a new version gets a new entry in
  `setup.lock.json` with its URL and hashes.
- **Decided 2026-10-01 — no `ffprobe.exe` (105 MB).** yt-dlp prefers it for stream inspection in
  post-processing and falls back to `ffmpeg.exe`. **Measured:** YouTube mp3 and mp4 without it —
  exit `0`, byte-identical to the runs with it; X video download exit `0`. Rejected: shipping it
  for untested edge cases. If a site fails in post-processing, add it to `setup.lock.json`.

## 5. Platform support

Measured on 2026-10-01 with yt-dlp `2026.08.19`, no login, against the public test URLs in
yt-dlp's own extractor sources (`--simulate`, no download unless noted).

| Platform | Result | Note |
|---|---|---|
| YouTube | ✅ | real downloads, mp4 1920×1080 H.264/AAC and mp3 |
| X/Twitter | ✅ | 6/6 recent tweets; old tweets fail where the video is gone |
| Instagram | ✅ | 4/4 posts and reels |
| TikTok | ⚠️ | 2/4 — TikTok answers "Your IP address is blocked from accessing this post" |
| Vimeo | ❌ | 0/2 — login required or HTTP 403 |
| Threads | ❓ | yt-dlp has no Threads extractor; only its generic fallback, not tested |

Reproduce with:

```powershell
skills/mediagrab/bin/yt-dlp.exe --simulate --no-warnings --print "OK %(extractor)s" <url>
```

## 6. Done when

- `setup.ps1 -Check` exits `0`.
- `node --test skills/mediagrab/tests/mediagrab.test.js` — all pass, no network.
- The run exits `0` and the path on stdout exists.

*Pinned versions and hashes live in `scripts/setup.lock.json`, not here.*
