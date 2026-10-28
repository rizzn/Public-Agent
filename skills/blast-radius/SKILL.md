---
name: blast-radius
description: Computes the reverse dependency graph, export signature changes, broken call sites, affected tests and dynamic-code warnings for one or more files or a git diff. Use before editing a shared module or before committing a change, or when the user says "blast radius", "Auswirkungen prüfen", "wer ruft das auf", "welche Tests sind betroffen". Do NOT use for plain text search — use the agent's built-in search.
dependencies:
  scripts: [scripts/blast-radius.js]
  input: one or more <file> paths or --diff [<rev>], optional --root <dir>, --depth <n> and --json
  output: structured impact report (or JSON) on stdout
---

# blast-radius

Static change-impact analyser for JS/TS, Python, PHP and Go repositories: resolves reverse imports,
detects signature-breaking export changes, maps affected test files, and flags dynamic calls that
static analysis cannot see. Self-contained — needs nothing beyond the Node.js standard library and
`git` (for `--diff`).

- **file** — `<file>...`: inspect callers, exports, transitive dependents and tests before touching
  a shared module.
- **diff** — `--diff [<rev>]`: compare modified and untracked files against `HEAD` (or `<rev>`),
  flag removed exports or changed parameter bounds, and list broken call sites plus the exact test
  command.

## 0. Ground rules

- **Run before editing and before committing.** Call `blast-radius.js <file>` before changing a
  shared module's interface, and `blast-radius.js --diff` before proposing a commit.
- **Static analysis has a hard boundary at runtime strings.** Dynamic imports (`import(variable)`),
  `require(variable)`, `eval()` and reflection are invisible to a static parser. When the output
  includes a `DYNAMIC:` line, inspect those call sites manually instead of trusting an empty
  `BREAKING:` line.
- **Fix every `BREAKING:` entry before committing.** A caller passing the old argument count or
  importing a removed symbol is a confirmed bug unless the caller is updated in the same change.
- **Run the exact `TESTS:` command.** Execute the reported test command rather than guessing which
  test files cover the change. When `UNTESTED:` lists a modified production file, add a test or
  verify it explicitly.

## 1. Folder layout

```text
skills/blast-radius/
├── SKILL.md                   # this file — the contract
├── scripts/
│   └── blast-radius.js        # CLI entry point and static analyser (§2)
└── tests/
    └── blast-radius.test.js   # node:test suite, no network
```

## 2. Commands

```powershell
node skills/blast-radius/scripts/blast-radius.js <file>...                 # pre-edit impact, <1 s, no network, no cost
node skills/blast-radius/scripts/blast-radius.js --diff                    # diff vs HEAD, <1 s, no network, no cost
node skills/blast-radius/scripts/blast-radius.js --diff HEAD~1 --depth 5   # diff vs revision, transitive depth 5
node skills/blast-radius/scripts/blast-radius.js --diff --json             # machine-readable JSON output
```

- **`--root <dir>`** overrides automatic repository root detection (`git rev-parse --show-toplevel`
  or `process.cwd()`).
- **`--depth <n>`** caps reverse-dependency traversal depth (default `3`).
- **`--json`** prints the full report object as tab-indented JSON instead of the compact text
  lines.

## 3. Output

```text
CHANGED:   src/auth/token.js (export verifyToken: 1..2 params -> 2..3 params)
BREAKING:  src/api/middleware.js:4 (calls verifyToken with 1 arg (expects 2..3 params))
IMPACTED:  2 files (depth 1: 1, depth 2: 1) -> src/api/middleware.js [d1], src/api/server.js [d2]
TESTS:     node --test tests/server.test.js
UNTESTED:  src/cli/orphan.js (no test imports this path)
DYNAMIC:   src/api/middleware.js:3 (dynamic import())
```

- **stdout** carries the five core lines (`CHANGED`, `BREAKING`, `IMPACTED`, `TESTS`, `UNTESTED`)
  plus `DYNAMIC` whenever dynamic import or eval patterns appear in the dependency chain.
- **Exit codes:** `0` clean (zero breaking call sites) · `1` one or more breaking call sites or
  removed-export references · `2` bad arguments, missing file or git failure.

## 4. Supported languages and static rules

| Language | Extensions | Imports resolved | Exports and signatures tracked | Dynamic hazards flagged |
|---|---|---|---|---|
| JS / TS | `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.tsx` | ESM `import` / `export … from`, CJS `require()` | `export function`, arrow/fn vars, `class`, `export { … }`, `module.exports`, `exports.<name>` | `import(var)`, `require(var)`, `eval()`, `new Function()` |
| Python | `.py` | `from … import`, `import …`, `spec_from_file_location` | top-level `def` (excluding `_private`, stripping `self`/`cls`), `class` | `importlib.import_module()`, `__import__()`, `eval()` |
| PHP | `.php` | `require`, `require_once`, `include`, `include_once` | `function <name>(...)` | `call_user_func()`, `call_user_func_array()`, `eval()` |
| Go | `.go` | — | exported `func <Name>(...)` | — |

## 5. Done when

Every line is checked, not assumed:
- `node --test skills/blast-radius/tests/blast-radius.test.js` — 7/7 pass, no network.
- `node skills/blast-radius/scripts/blast-radius.js --diff` exits `0` when no caller is broken and
  `1` when a caller passes an incompatible argument count.

*Parser implementation and graph traversal live in `scripts/blast-radius.js`, not here.*

