# Ticket template

How a work request becomes a ticket and how that ticket lives in an issue tracker (Trello, GitHub
Issues, Jira or similar): cutting, format, comments, lifecycle. Applies to every request that
changes code, config, docs or a deployment; questions and chat turns are not tickets. On a work
request this shape replaces any answer skeleton an MCP server or another rule supplies.

## 0. The failure this prevents

Tasks kept as `- [ ]` lines in the description cannot be ticked by tooling and drift out of sync.
A ticket that ends in a to-do written as prose has no checkable end state, so neither a reviewer
nor an unattended agent can decide between done and blocked. A ticket cut only in chat is gone
after the session, while the tracker keeps the raw text for every later reopen.

## 1. The rule

**The tracker item is the only source of the ticket.** Every work request that needs a ticket
(below) is an item in the format of §3 before work starts; the chat shows what the item holds and
never a second version. Agents get the ticket only from the item: title, labels, description and
checklists.

**Ticket or briefing.** A work request gets a tracker item when it outlives the session, arrives
from outside (e-mail, tracker), is meant for an unattended agent (§6), or holds a unit of work
with risk 6 or higher (§3.5). Everything else — work done right now in the same chat — runs as a
`+++` briefing: a structured XML prompt the agent writes in chat when a message ends in `+++`
([`prompt-expansion`](../skills/prompt-expansion/SKILL.md)). The briefing only describes the
work; work starts as a separate step once the user gives an explicit go-ahead in a later message.
Briefing and ticket use the same words: XML tag `<x_y>` is heading or checklist `X y`, so a
briefing that turns into a ticket is moved over, not cut again. Only the category, difficulty and
risk of each `Instructions` item (§3.4) are added on the way, because the briefing carries title
and target alone.

## 2. Cutting a ticket

- **Normalise silently:** resolve pronouns, name the real files and commands, split conjoined
  jobs. The result surfaces as the objective and the checklist items, never as a separate recap.
- **Never invent scope.** Work that is required but unstated gets its own `Instructions` item,
  marked `(assumption)`, and a line in `Assumptions`.
- **One blocker question.** An ambiguity that changes the outcome is asked as one question —
  in chat and as a `Question` comment (§4). The ticket stays raw until it is answered.
- **No end state, no start.** If no checkable end state can be written for
  `Acceptance criteria`, that is the blocker question.
- **Name exact targets:** `file:line`, a command, a URL, a document section. Compress wording,
  never the targets, versions, error strings or risk reasons.

## 3. Ticket format

Headings and checklist names are the English tag words of the `+++` briefing; the body text uses
the team's language. The type prefixes and the vocabulary of §3.5 stay as written.

| Briefing tag | In the tracker |
|---|---|
| `<title>` | title with type prefix |
| `<objective>` | first line of the description, no heading |
| `<context>` | `## Context` |
| `<assumptions>` | `## Assumptions` |
| `<constraints>` | `## Constraints` |
| `<out_of_scope>` | `## Out of scope` |
| `<acceptance_criteria>` | checklist `Acceptance criteria` |
| `<instructions>` | checklist `Instructions` |
| `<output_format>` | `## Output format` |

### 3.1 Title

- **What happens, at most eight words.** An optional component goes first with a colon:
  `Login: Show error on empty password`.
- **Never rename a ticket that came by e-mail.** A tracker that merges e-mail replies by title
  loses every later reply to a renamed item.
- **A type prefix:** `[BUG]`, `[FEATURE]`, `[UI/UX]` or `[REFACTOR]`. A tracker with labels
  turns the prefix into the type label.

### 3.2 Labels

- **Exactly one type label,** taken from the prefix; the queue is sorted by it.
- **`Important`** in addition only when the ticket must jump the queue.
- **`Unattended`** only on a normalised ticket that meets §6. The label is the approval; setting
  it is the user's call.

### 3.3 Description

Headings, bullets and bold only — no tables, no HTML, no checkboxes, no `---` rules.

````markdown
<Objective: 1–3 sentences, what changes and why. First line, no heading above it.>

## Context
- **Finding <YYYY-MM-DD>:** <observation with its evidence>
- <relevant file, command, error string>

## Assumptions
- <decision nobody stated, with its reason>

## Constraints
- <how the work must be done: forbidden dependency, compatibility, limit>

## Out of scope
- <adjacent code, system or known defect this ticket does not touch>

## Output format
- <fixed shape of the result, e.g. report file, migration script>

## Links
- `<path/file>` · <URL>

## Source
**Reported by:** <sender of a ticket from outside; keep the line verbatim>
````

- **The objective is the first non-empty line, without a heading.** Tools that summarise a ticket
  (reports, notifications) take that line; a heading there would leak into them.
- **`Out of scope` is fixed when the ticket is cut** — two or three lines. What stands there
  is invisible for the life of the ticket, broken or not; it changes only through a `Correction`
  comment (§4).
- **`Constraints` limits how, `Out of scope` limits what.** "No new dependency" is a constraint;
  "the checkout page stays untouched" is out of scope.
- **`## Source` only on tickets from outside,** such as e-mail: who reported it, kept verbatim
  when the description is rewritten.
- **Drop empty sections.** `Context` and `Out of scope` are required; `Assumptions`,
  `Constraints`, `Output format`, `Links` and `Source` appear only with content — unlike the
  briefing, the ticket writes no "None.".

### 3.4 Checklists

Two named checklists:

- **`Acceptance criteria`** — one to three checkable end states: a command with its expected
  result, a number, an observable. All ticked means done. Where the project compares visible
  changes by before and after screenshots, the item names the page URL and viewport width.
- **`Instructions`** — one item per unit of work, in execution order:

  ```text
  <Title> — <exact target> · <category> · <difficulty> · R<n>[ · Safeguard: <safeguard>]
  Add error message — login.js validate() on empty password · add · easy · R3
  ```

- **Item titles are unique within the ticket.** Tools that tick items by name match the first
  item containing the text — tick by full title.
- **The item with the highest risk names its safeguard** (backup, snapshot, dry run, revert).

### 3.5 Vocabulary

- **Category** — the kind of intervention: `fix` `add` `change` `refactor` `remove`
  `investigate` `document` `verify`.
- **Difficulty:** `easy` one target, no unknowns · `medium` several targets or needs verifying ·
  `hard` design decision, unknown blast radius, external dependency.
- **Risk 0–10** (`R<n>`), the worst case if the item goes wrong: `0` no runtime effect · `3` a
  local feature degrades · `5` a service fails, a revert fixes it · `8` data corruption or a
  broken deploy that needs manual repair · `10` unrecoverable loss or a dead system.

## 4. Comments and parking

Comments carry what happens to the ticket; the description carries what the ticket is.

- **`**Original request:**`** — the previous description, posted before the first rewrite. A
  rewrite replaces everything, and the requester's wording is evidence.
- **`**Question:**`** — the one blocker question (§2).
- **`**Correction <YYYY-MM-DD>:**`** — a scope change after a reopen: what changed and why.
- **`**Side findings:**`** — at most three lines `<Title> — file:line`, posted before closing.
  No severity, no rationale, no recommendation.

Parking, in this order:

- **Blocker first.** A finding that falsifies `Acceptance criteria` is not a side finding: say it
  at once, post it as `Question`, leave the ticket active. Never park it, never close over it.
- **Caused by this change:** fix it inside the ticket, no separate mention.
- **Noticed nearby:** into `Side findings`; overflow beyond three is dropped. Anything listed
  under `Out of scope` is not a finding.
- **The only sink is the project backlog** (`ROADMAP.md` or equivalent), and only when the user
  pulls a line. No new tickets from side findings.

## 5. Lifecycle

| Transition | Trigger | Steps, in order | Approval |
|---|---|---|---|
| new → raw | e-mail, tracker UI, agent | create the item | — |
| raw → normalised | the ticket is taken | comment `Original request` → rewrite the description → fill `Acceptance criteria` → fill `Instructions` → set the type label if missing | the user approves the cut ticket in chat, per ticket |
| raw → raw | blocker question | comment `Question` | the question is shown in chat |
| normalised → active | work starts | move to active, assign | covered by the approval above |
| active → done | all `Acceptance criteria` ticked | tick each item → comment `Side findings` → close | — |
| done → raw | a new reply or comment reopens it | comment `Correction`, adjust description and checklists | again, before work restarts |
| briefing → raw | an approved `+++` briefing outlives the session | create the item from the briefing, tags moved per §3, no `Original request` comment | covered by the briefing approval |

- **A ticket counts as normalised** when its description has the objective line, `## Context`
  and `## Out of scope`, and `Acceptance criteria` holds at least one item.

## 6. Unattended-ready minimum

`Unattended` may be set only when all of these hold — an agent running without a human has no
chat and no way to ask:

- The ticket is normalised (§5).
- Every `Acceptance criteria` item can be checked from inside the project folder.
- The highest risk in `Instructions` is at most `5`. Anything higher needs a human at the
  keyboard.
- No `Question` comment is open.

The unattended run reports its result as a comment. Ticking `Acceptance criteria` against that
result is the review step after the run.

## 7. Projects without a tracker

Projects without an issue tracker get the ticket as a `+++` briefing in chat
([`prompt-expansion`](../skills/prompt-expansion/SKILL.md)) — the same words and the same
parking rules, with chat in place of comments. Each `Instructions` item gets category, difficulty
and risk in the format of §3.4 as soon as the work is judged for §1. It is the fallback, not a
second format.

## 8. Self-check before writing back

- [ ] The objective is the first non-empty line; `Context` and `Out of scope` are present.
- [ ] No checkbox, table, HTML or `---` in the description.
- [ ] `Acceptance criteria` holds one to three checkable end states.
- [ ] Every `Instructions` item has target, category, difficulty and risk; titles are unique.
- [ ] The highest risk names its safeguard.
- [ ] Headings and checklist names match the tag words of §3.
- [ ] A ticket from e-mail keeps its title and its `Source` line.
- [ ] The original description is saved as an `Original request` comment before the rewrite.
- [ ] `Unattended` only if §6 holds.
