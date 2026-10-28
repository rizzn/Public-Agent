# Public-Skills

Self-contained **agent skills** — a `SKILL.md` contract plus scripts — for Claude Code and any
other agent that reads the skill format. Every folder under `skills/` works on its own: no shared
code, no external config, nothing installed outside the folder.

## Skills

| Skill | What it does | Needs |
|---|---|---|
| [`mediagrab`](skills/mediagrab/SKILL.md) | Downloads one public video as mp4 or its audio as mp3 via yt-dlp | Windows, Node.js |
| [`prompt-expansion`](skills/prompt-expansion/SKILL.md) | Expands a brief task into a structured XML prompt; trigger `+++` | — |
| [`transcribe`](skills/transcribe/SKILL.md) | Turns a local file or a YouTube URL into `M:SS <text>` lines, via captions or Groq Whisper | Windows, Python 3.13, Groq API key |
| [`webcopy`](skills/webcopy/SKILL.md) | Saves one web page with all its assets as an offline copy | Python 3, `requests`, `beautifulsoup4` |

## Quick start

```powershell
# 1. Install: copy a skill folder into the agent's skill directory (Claude Code: ~/.claude/skills/)
Copy-Item -Recurse skills/mediagrab $HOME/.claude/skills/
# 2. Binaries (mediagrab, transcribe): each skill runs its own setup into its own bin/
powershell -ExecutionPolicy Bypass -File $HOME/.claude/skills/mediagrab/scripts/setup.ps1    # ~118 MB, network yes, no cost
powershell -ExecutionPolicy Bypass -File $HOME/.claude/skills/transcribe/scripts/setup.ps1   # ~220 MB, network yes, no cost
# 3. Key (transcribe only): enter GROQ_API_KEY in config.json beside SKILL.md
Copy-Item $HOME/.claude/skills/transcribe/config.example.json $HOME/.claude/skills/transcribe/config.json
```

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
