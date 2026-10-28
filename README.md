# Public-Skills

Self-contained **agent skills** and **rules** for coding agents. Both are **agent-independent**:
a skill is a Markdown contract (`SKILL.md`) plus plain scripts, a rule is a plain Markdown file,
so any agent that reads Markdown and runs shell commands can use them. Every folder under
`skills/` works on its own: no shared code, no external config, nothing installed outside the
folder.

This repository is a small public part of my own agentic harness: the skills and rules that work
without the rest of it, stripped of every link to my private tools and projects.

## Skills

| Skill | What it does | Needs |
|---|---|---|
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
