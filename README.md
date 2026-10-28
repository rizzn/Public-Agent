<p align="center">
  <img src="logo.png" alt="Public-Agent Logo" width="100%">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20Node.js%20%7C%20Python-339933" alt="Platform">
  <img src="https://img.shields.io/badge/Agents-Antigravity%20%7C%20Claude%20%7C%20Qwen-D97757" alt="Antigravity | Claude | Qwen">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green" alt="MIT License"></a>
</p>

# Public-Agent

Self-contained **agent skills**, **rules** and **hooks** for coding agents. Skills and rules are
**agent-independent**: a skill is a Markdown contract (`SKILL.md`) plus plain scripts, a rule is
a plain Markdown file, so any agent that reads Markdown and runs shell commands can use them.
Hooks depend on each agent's hook protocol; the one here speaks three. Every folder under
`skills/` works on its own: no shared code, no external config, nothing installed outside the
folder.

This repository is a small public part of my own agentic harness: the skills, rules and hooks
that work without the rest of it, stripped of every link to my private tools and projects.
[`AGENTS.md`](AGENTS.md) serves as the master index and operating agreement across all subfolders.

## Skills

| Skill | What it does | Needs |
|---|---|---|
| [`blast-radius`](skills/blast-radius/SKILL.md) | Maps reverse imports, export signature changes, broken call sites and affected tests for files or a `git diff` | Node.js, `git` (for `--diff`) |
| [`mediagrab`](skills/mediagrab/SKILL.md) | Downloads one public video as mp4 or its audio as mp3 via yt-dlp | Windows, Node.js |
| [`prompt-expansion`](skills/prompt-expansion/SKILL.md) | Expands a brief task into a structured XML prompt; trigger `+++` | — |
| [`transcribe`](skills/transcribe/SKILL.md) | Turns a local file or a YouTube URL into `M:SS <text>` lines, via captions or Groq Whisper | Windows, Python 3.13, Groq API key |
| [`webcopy`](skills/webcopy/SKILL.md) | Saves one web page with all its assets as an offline copy | Python 3, `requests`, `beautifulsoup4` |

## Rules

| Rule | What it sets |
|---|---|
| [`reply-format.md`](rules/reply-format.md) | Wording, skeleton and grounding markers of every agent reply |
| [`ticket-template.md`](rules/ticket-template.md) | How a work request becomes a ticket: format, vocabulary, lifecycle |

Rules carry no frontmatter. Copy `rules/` next to the agent's instruction file (`AGENTS.md`,
`CLAUDE.md` or the equivalent of the agent in use) and link or include the rules from there.
They reference each other and the `prompt-expansion` skill, so copy them together with it.

## Hooks

| Hook | What it does | Agents |
|---|---|---|
| [`pii-guard.js`](hooks/pii-guard.js) | Replaces e-mails, phone numbers, IBANs and public IPs in tool output with `[PII:…]` placeholders, blocks prompts that contain them, denies reads of `.env` files and credentials without asking, optionally asks before reads of dumps, databases, uploads or logs | Claude Code (full), Antigravity and Qwen Code (partial) |

```powershell
node --test hooks/tests/pii-guard.test.js   # unit tests, no network
node hooks/tests/pii-guard.bench.js         # recall, precision, throughput; ~8 s, no network
```

## Quick start

```powershell
# 1. Install: copy a skill folder into the agent's skill directory (<skill-root>)
Copy-Item -Recurse skills/mediagrab <skill-root>/
# 2. Binaries (mediagrab, transcribe): each skill runs its own setup into its own bin/
powershell -ExecutionPolicy Bypass -File <skill-root>/mediagrab/scripts/setup.ps1    # ~118 MB, network yes, no cost
powershell -ExecutionPolicy Bypass -File <skill-root>/transcribe/scripts/setup.ps1   # ~220 MB, network yes, no cost
# 3. Key (transcribe only): enter GROQ_API_KEY in config.json beside SKILL.md
Copy-Item <skill-root>/transcribe/config.example.json <skill-root>/transcribe/config.json
```

- **Agents with native skill loading** find a skill by the `name` and `description` in its
  frontmatter. Claude Code, for example, reads `~/.claude/skills/` as `<skill-root>`.
- **Any other agent** gets the path to `SKILL.md` in its instruction file, or in the prompt.

## Notes

- **Binaries are not in the repository.** `scripts/setup.ps1` of `mediagrab` and `transcribe`
  downloads `yt-dlp.exe` and `ffmpeg.exe` from their official releases and checks every SHA-256
  against `scripts/setup.lock.json`. `ffmpeg.exe` alone exceeds GitHub's 100 MB file limit.
- **Windows only** for `mediagrab` and `transcribe`: the scripts call the `.exe` builds in `bin/`.
- **`transcribe` uploads audio to Groq** whenever no original YouTube captions exist. Private
  recordings need the owner's consent first.
- **`mediagrab` handles public content only.** Platform terms of service may forbid downloading;
  that call stays with the user.

## License

[MIT](LICENSE)
