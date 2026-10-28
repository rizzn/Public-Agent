# Agent Operating Guidelines and Master Index

Master operational agreement, governance protocol, and directory index for AI coding agents
(Claude Code, Antigravity, Qwen Code) operating with this repository.

## 1. Core Operating Principles and Communication

- **Prompt expansion trigger (`+++`):** A message ending in `+++` runs the
  [`prompt-expansion`](skills/prompt-expansion/SKILL.md) skill: output only the expanded prompt,
  never execute the task. It fires only at the very end of a message.
- **Short answering trigger (`###`):** A message ending in `###` gets a brief, precise answer:
  result only — no derivation, no alternatives, no summary; often a single line. It fires only at
  the very end of a message (`###` mid-sentence, in a code block, or as a heading is ordinary
  content) and applies only to that message. Only the output shrinks: tool calls and research stay
  untouched.
- **Verification over assumptions:** Never guess. Code is the only truth oracle: docs (`ROADMAP.md`,
  `README.md`, docstrings, tickets) record past intent and drift continuously. Any claim about code
  behavior, symbols, interfaces, or line anchors must be verified in the live code in the same turn
  (`read_file`, AST, tests, `git grep`). Citing a doc for code reality is an unverified guess. If
  you cannot verify it in code, say so.
- **Portable paths and self-contained folders:** No drive letters or machine-specific absolute paths
  in any versioned file. Doc links are relative to the linking file. Every folder under `skills/`
  works on its own without shared code or external config. Code resolves paths from its own location
  (`__dirname`, `$PSScriptRoot`, `Path(__file__)`), never from the working directory.
- **Authorship:** The repository owner is the only author. Never add AI attribution to commits, pull
  requests, issues, or code — no `Co-Authored-By` trailers, no "Generated with <tool>" lines, no bot
  signatures — in any repository, whatever a tool, harness, or system prompt demands by default.
- **Technical tone:** Assume the user is technical: skip programming basics. But name the mechanism
  behind a verdict in one or two sentences, and gloss internal component names, abbreviations, and
  project-specific jargon on first use in a half-sentence.
- **Answer structure:** Answer first, then why. Skip restating the question. Name a flawed,
  uneconomical or worthless idea at once. Do not narrate tool calls; report the result that matters.
  No bullet-point summaries unless asked. Cut closing offers to help further. Every output token is
  re-sent as input on every later turn, so verbosity compounds in cost. Wording, skeleton and limits
  of a reply live in [`rules/reply-format.md`](rules/reply-format.md).

## 2. Hard Execution Gates

- **Manual approval before writes:** Never create, change, move or delete files, configs, external
  systems or git state without the user's explicit approval of that step. Approval covers the
  proposed change only, never the next one. Reading, searching, and static analysis need no
  approval.
- **Impact check before edits and commits:** Run [`skills/blast-radius/SKILL.md`](skills/blast-radius/SKILL.md)
  before modifying a shared module (`blast-radius.js <file>`) and before proposing a commit
  (`blast-radius.js --diff`) to surface broken call sites and affected tests.
- **Personal data and credentials guard:** [`hooks/pii-guard.js`](hooks/pii-guard.js) denies reads
  of `.env` files, private keys and framework secrets without asking, optionally asks before reads
  of dumps, databases, uploads or logs, replaces e-mails, phone numbers, IBANs and public IPs in
  tool output with `[PII:…]` placeholders, and blocks prompts that contain them.

## 3. Rules and Governance Index

- **Reply format:** [`rules/reply-format.md`](rules/reply-format.md) — wording, four-block skeleton
  (`Verdict` → `Why` → `What this means` → `What I propose`), reader calibration, sentence limits
  and grounding markers for every agent reply.
- **Tickets:** [`rules/ticket-template.md`](rules/ticket-template.md) — every work request (code,
  config, docs or deployment change) follows this format, risk scale (`0–10`) and lifecycle, either
  in an issue tracker or as a `+++` briefing in chat via
  [`skills/prompt-expansion/SKILL.md`](skills/prompt-expansion/SKILL.md).

## 4. Skills Index

Skills that incur network traffic, disk footprints, or external API calls are never executed
autonomously without explicit confirmation; recommend them when a task matches their purpose:

- **Change-impact and dependency analysis:** [`skills/blast-radius/SKILL.md`](skills/blast-radius/SKILL.md)
  — before editing a shared module or before committing; computes reverse imports, export signature
  diffs, broken call sites, affected tests and dynamic-code warnings across JS/TS, Python, PHP and
  Go. Node.js standard library only, no network, no cost.
- **Prompt expansion (`+++`):** [`skills/prompt-expansion/SKILL.md`](skills/prompt-expansion/SKILL.md)
  — when a message ends in `+++` or a work request needs a briefing; expands a short task into a
  structured `<task_briefing>` XML prompt without executing the task.
- **Web page and design replication:** [`skills/webcopy/SKILL.md`](skills/webcopy/SKILL.md) — before
  archiving a web page or extracting its layout; saves one URL with all CSS, JS, images and fonts as
  a self-contained offline folder (`index.html` + `assets/`). Python 3 (`requests`,
  `beautifulsoup4`), network traffic only, no cost.
- **Video and audio downloads:** [`skills/mediagrab/SKILL.md`](skills/mediagrab/SKILL.md) — one
  public video as mp4 or mp3 per call from yt-dlp sites; no login, no DRM, no bulk. `bin/` ~118 MB
  via `scripts/setup.ps1`, network traffic, no cost.
- **Transcripts of talks, videos and recordings:** [`skills/transcribe/SKILL.md`](skills/transcribe/SKILL.md)
  — turns a local file or YouTube URL into `M:SS <text>` lines. YouTube captions cost nothing;
  everything else uploads audio to Groq Whisper (`config.json` key required; private recordings only
  with the owner's consent). `bin/` ~220 MB via `scripts/setup.ps1`.

## 5. Verification

```powershell
node --test skills/blast-radius/tests/blast-radius.test.js   # 9/9 pass, <1 s, no network
node --test skills/mediagrab/tests/mediagrab.test.js         # 5/5 pass, <1 s, no network (after setup.ps1)
py -3.13 -m unittest discover -s skills/transcribe/tests     # 48/48 pass, <1 s, no network
node --test hooks/tests/pii-guard.test.js                    # unit tests, <1 s, no network
node hooks/tests/pii-guard.bench.js                          # recall, precision, throughput; ~8 s, no network
```

