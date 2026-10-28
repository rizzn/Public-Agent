---
name: transcribe
description: Transcribes an audio or video source (local file or YouTube URL) into a raw, timestamped `M:SS <text>` transcript block, ready to paste into a Markdown note. Use when a talk, video or recording needs a transcript, or the user says "transkribieren", "Transcript", "YouTube-Video abschreiben". Do NOT use for summarising a transcript — that is curation in the MD.
dependencies:
  scripts: [scripts/setup.ps1, scripts/transcribe.py]
  input: a local audio/video path or a YouTube URL, plus optional language and `--groq` flags
  output: one UTF-8 `.txt` with `M:SS <text>` lines; its path on stdout
---

# transcribe

Turns speech into the raw transcript block a Markdown note carries under `## Full transcript`
(§5). YouTube videos use their original captions; everything else runs through Groq
(`whisper-large-v3-turbo`). The helper binaries live
inside this folder, and the script needs nothing beyond the Python standard library.

- **captions** — YouTube URLs by default. The video's original captions via yt-dlp: human
  subtitles first, else YouTube's own speech recognition (`<lang>-orig`). No upload, no quota.
- **groq** — local files, YouTube videos without original captions, or any URL with `--groq`.
  Upload to the Groq API, word timestamps back.

## 0. Ground rules

- **Every audio source on the groq path is uploaded to Groq.** Private or client recordings
  need the user's explicit OK per file before the run; public talks and videos do not.
- **Caption translations are never used.** YouTube offers machine-translated captions in many
  languages; only the spoken language's original track counts, else the audio goes to Groq.
- **Binaries come from `bin/` only.** Scripts call `bin/ffmpeg.exe`, `bin/ffprobe.exe` and
  `bin/yt-dlp.exe`, resolved via `Path(__file__)` or `$PSScriptRoot` — no fallback to PATH, or
  the result depends on whatever the machine has installed.
- **Python 3.13, standard library only** (`py -3.13`). No pip packages, no venv: HTTP via
  `urllib`, tests via `unittest`.
- **The raw format is binding (§4).** Every line the skill writes matches the format regex;
  a line that does not is a bug, not a style choice.
- **The raw text is not cleaned up.** No summary, no removal of filler words, no speaker
  labels, no translation. Curation happens later in the MD (§5), where it stays visible.
- **Suspected hallucinations are flagged, never deleted.** Three or more identical consecutive
  lines produce a warning on stderr with their timestamps; the lines stay in the output.
- **The key comes from `config.json` in this folder only** (`GROQ_API_KEY`), never from an env
  var or another tool's config. A missing file or empty key exits `2`. The key is never
  printed, logged or written anywhere else.
- **No drive letters** in this file, the scripts or the lock file.

## 1. Folder layout

```text
skills/transcribe/
├── SKILL.md              # this file — the contract
├── config.example.json   # template for config.json, safe to share
├── config.json           # GROQ_API_KEY — never shared
├── scripts/
│   ├── setup.ps1         # downloads and verifies bin/ from pinned sources
│   ├── setup.lock.json   # version, URL and SHA-256 per binary
│   └── transcribe.py     # CLI entry point (§3)
├── tests/                # unittest suite, no network
├── bin/                  # ffmpeg.exe, ffprobe.exe, yt-dlp.exe (~220 MB) — rebuilt by setup.ps1
└── tmp/                  # <name>.transcript.txt outputs; tmp/<run>/ work folders, deleted when the run ends
```

## 2. Setup

```powershell
powershell -ExecutionPolicy Bypass -File skills/transcribe/scripts/setup.ps1          # downloads bin/, network yes, no cost
powershell -ExecutionPolicy Bypass -File skills/transcribe/scripts/setup.ps1 -Check   # status only, no network
```

- **Pinned and verified.** Every binary has version, URL and SHA-256 in `setup.lock.json`.
  A hash mismatch deletes the download and exits `1`. A re-run skips what already matches.
- **Official sources only:** `yt-dlp.exe` from the GitHub releases of `yt-dlp/yt-dlp`;
  `ffmpeg.exe` and `ffprobe.exe` from the gyan.dev `essentials_build`, pinned by version through
  its GitHub mirror `GyanD/codexffmpeg`. The pinned hashes were taken from the release's
  `SHA2-256SUMS` and the `.sha256` gyan.dev publishes; `setup.ps1` compares only against the
  lock file.
- **`-Check`** prints one line per item (`ok` · `missing` · `hash mismatch` · `not pinned`) —
  the binaries, `py -3.13` and whether `config.json` holds a non-empty `GROQ_API_KEY` (never its
  value) — and exits `1` if any is not `ok`.
- **The key is entered by the user,** once, into `config.json` (copy of
  `config.example.json`). The repository's `.gitignore` excludes the file, so the key never
  reaches a commit.

## 3. Commands

```powershell
py -3.13 skills/transcribe/scripts/transcribe.py <source> [-o out.txt] [--lang de|en|…] [--groq]
```

- **`<source>`** — a local audio/video path or a YouTube URL.
- **`-o`** — output path. Default: `tmp/<source stem>.transcript.txt` for a local source,
  `tmp/<video id>.transcript.txt` for a URL — always in this skill's `tmp/`, never beside the
  source or in the working directory. From there the block moves into the target note (§5).
- **`--lang`** — spoken language. Default for a URL: the video's language (§3.1 step 2); for a
  file: Groq's detection. The output keeps the source language.
- **`--groq`** — URL only: skip the captions and transcribe the audio via Groq.

stderr names the path taken: `captions auto <lang>-orig (no upload)`, `captions manual <track>
(no upload)`, `no original captions - transcribing the audio via Groq` or `audio via Groq (--groq)`.

Exit codes: `0` transcript written · `1` transcription, download or quota error · `2` setup
incomplete (run `setup.ps1 -Check`). Errors go to stderr; stdout carries only the output path.

### 3.1 Pipeline

1. **Detect the source.** A URL goes to step 2, a path to step 3. A missing file or unreachable
   URL exits `1`.
2. **Captions (URL only, skipped with `--groq`).** `bin/yt-dlp.exe --dump-single-json` gives
   the language and the caption tracks; an unavailable, private or age-restricted video exits
   `1`. The spoken language is `--lang`, else the metadata's, else the one a `<lang>-orig` track
   names; with none of the three, the audio goes to Groq. Pick a human subtitle track in that
   language, else the auto track `<lang>-orig` (YouTube's recognition of the original audio),
   else the plain `<lang>` auto track if it is the video's own language. Found → download it as
   `json3`, turn its words (auto) or cues (human) into timed tokens — each word ending no later
   than the next one starts — and go to step 8. Not found → download the original audio track
   (`bestaudio[format_note*=original]`, never an AI-dubbed one) and continue with step 3.
3. **Extract audio.** `bin/ffmpeg.exe` → `tmp/<run>/audio.flac`, 16 kHz, mono — the format Groq
   recommends, lossless. A source without an audio stream exits `1`.
4. **Check the quota.** Free tier per `whisper-large-v3-turbo`: 20 requests/min, 7,200 audio
   seconds/hour, 28,800 audio seconds/day. A source longer than 8 h exits `1` before any upload.
5. **Chunk.** Every source longer than 4 min is split into chunks of at most 4 min — longer
   uploads make Whisper skip whole windows (measured 2026-09-30: a 19 min upload lost four
   stretches of 13–30 s) — and at most 24 MB (Groq's free tier takes 25 MB per file). Each cut
   moves back to the middle of the nearest silence (`silencedetect`, within 30 s) so no word is
   cut. Chunks are re-encoded from the cut, so each chunk's offset is exactly its cut time.
6. **Transcribe.** One `POST https://api.groq.com/openai/v1/audio/transcriptions` per chunk:
   `model=whisper-large-v3-turbo`, `response_format=verbose_json`,
   `timestamp_granularities[]=word` and `=segment`, `temperature=0`, `language` if given.
   HTTP 429 and 5xx → wait for `retry-after`, at most 5 retries, then exit `1`. HTTP 401 → exit
   `2` (wrong key); any other 4xx → exit `1` with Groq's message.
7. **Repair lost speech.** Every word gap over 3 s — including before the first and after the
   last word, with each word counted for at most 1.5 s because Whisper stretches single words
   over skipped audio — that is less than 80 % silence is re-requested with 1 s, then 4 s, then
   8 s of context until words come back. Groq answers the same bytes with the same miss, so every
   attempt sends a different window. Recovered words are inserted at the gap without re-sorting
   (Groq's word starts are not monotonic); context words repeated at the edges are dropped. A gap
   that stays empty inside a stretched word means the word's start was wrong — Whisper pulls a
   first word back over intro music — so the word is re-timed to its end. Any other gap that
   stays empty is kept and reported on stderr as `warning: no words for …` (music, applause or
   lost speech — check by ear).
8. **Offset and normalise.** Add each chunk's start to its segments and words; drop U+FFFD
   (broken bytes from Whisper) and attach bare punctuation to the word before it. Merge neighbours
   under 5 s; split segments over 8 s at the last sentence end — or, failing that, the longest
   pause — before the 8 s mark, using word timestamps. Segment start = first word's start.
9. **Format and write.** Floor each start to whole seconds, render `M:SS` / `H:MM:SS`, write
   UTF-8 with LF and a final newline.
10. **Clean up.** Delete `tmp/<run>/` — also on error, via `finally`.

## 4. Output format

Derived from the author's hand-built reference transcript of a 33 min talk, which follows the
YouTube transcript view. The reference is not part of this repository.

- **One segment per line:** `<timestamp> <text>`, a single space between them, no line break
  inside a segment, no blank lines.
- **Timestamp = segment start,** floored to whole seconds. No end time, no brackets.
- **`M:SS` under one hour** — minutes without a leading zero, seconds always two digits
  (`0:05`, `12:40`). **`H:MM:SS` from one hour on** (`1:02:15`).
- **Strictly increasing timestamps.** Two segments that floor to the same second are merged.
- **Segment length target 5–8 s**, measured as the gap to the next timestamp.
- **File:** UTF-8, LF, final newline. No header, no fences — fences are added in the MD.
- **Format regex** (every line must match):

  ```text
  ^(\d+:)?\d{1,2}:\d{2} \S.*$
  ```

- **Synthetic example:**

  ```text
  0:00 Welcome to the session, um, let's get started.
  0:06 Today we look at how the pipeline handles long recordings.
  0:13 The first step is always to extract the audio track.
  ```

**Measured 2026-09-30 by the author:** the reference block has 303 lines, all matching the regex. 283 of the
302 gaps between timestamps lie in 5–8 s (5 s: 50, 6 s: 116, 7 s: 76, 8 s: 41), the rest in
9–13 s. Line length: median 84, max 126 characters. Check any transcript block the same way:

```bash
awk '/^```text/{p=1;next} /^```/{p=0} p' <note>.md > t.txt                               # extract the block from a note
grep -cvE '^([0-9]+:)?[0-9]{1,2}:[0-9]{2} \S' t.txt                                      # 0 = every line matches
awk '{split($1,a,":"); s=a[1]*60+a[2]; if(NR>1) print s-p; p=s}' t.txt | sort -n | uniq -c   # gap distribution
```

**Assumption:** `H:MM:SS` for recordings of one hour or more. The reference ends at `33:36`;
the form follows the YouTube transcript view, which the reference format matches.

## 5. MD handoff

The `.txt` goes unchanged into a Markdown note. The skill does not write the MD; curation is a
separate, reviewed step.

````markdown
# <Talk title>

**<Subtitle>**
*Speaker: <name, role> · Event: <event>*
*Source: <URL>*

## Core principles

<Curated summary, written from the transcript.>

## Full transcript

```text
<content of the .txt, pasted unchanged>
```
````

- **Assemble and verify the MD by shell, never retype the block.** Header metadata from
  `bin/yt-dlp.exe --skip-download --print "%(title)s | %(uploader)s | %(upload_date)s"` (auto
  captions garble names). Write header and Core principles to a file, then
  `` { cat header.md; printf '```text\n'; cat <id>.transcript.txt; printf '```\n'; } > <md> ``.
  Extract the block with the §4 `awk` line and `cmp` it against the `.txt`; delete the `.txt` only
  on a match. Retyping ~800 lines costs ~35k output tokens and risks altering the block
  (2026-10-02: `cmp` identical, SHA-256 matching).

**Third-party talks stay private.** A transcript of someone else's talk is a reference for own
use; it is not published or committed to a public repo.

## 6. Done when

Every line is checked, not assumed:

- `setup.ps1 -Check` exits `0`.
- `git check-ignore skills/transcribe/config.json` names the root `.gitignore`, with `bin/` and
  `tmp/` beside it.
- `py -3.13 -m unittest discover -s skills/transcribe/tests` passes.
- A local file, a YouTube URL with captions and a YouTube URL without captions each produce a
  `.txt` in which every line matches the §4 regex and timestamps strictly increase.
- No path in `SKILL.md`, `scripts/` or `setup.lock.json` contains a drive letter.

*Pinned versions and hashes live in `scripts/setup.lock.json`, not here.*
