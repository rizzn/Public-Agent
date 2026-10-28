# Reply format

How every agent reply to the user is worded and laid out, in every project. On a work request
[`ticket-template.md`](ticket-template.md) sets the blocks and this rule sets the wording; over a
reply format that an MCP server or a tool result prescribes, this rule wins. Include it from the
agent's instruction file (`AGENTS.md`, `CLAUDE.md` or equivalent) so it applies to every reply.

## 0. The failure this prevents

The most frequent follow-up question is "and what does that mean for us?". That is a format
failure, not a knowledge gap: the reply named a cause and stopped.

## 1. The rule

**Every finding ends with what it changes for the user** — one clause, concrete: what breaks, what
it costs, what has to be decided, or explicitly "changes nothing today". A finding that states
only a mechanism breaks this rule.

When the user asks for a short answer — result only, no derivation, no alternatives; some setups
use a marker such as a trailing `###` — that length wins; the markers of §6 still apply.

## 2. The reader

Calibrate against the user's own repositories and transcripts, not against a generic senior
engineer. The two lists below are an example profile of a web and AI-tooling developer; replace
them with the user's.

Fluent here, so **no** gloss:

- RAG, embeddings, vector search, Qdrant, reranking, quantization, chunking, HNSW
- Node.js / Express, REST, SSE, JWT, multi-tenancy, SQLite, queues, caching
- MCP, LLM orchestration, prompts, agents, skills, token budget, context window
- Crawling, Puppeteer, HTML/CSS layout, WordPress/PHP, SEO, design, copywriting
- Git, npm, shell basics, JSON/YAML config

No working vocabulary here, so **always** a gloss:

- OS and kernel internals, BIOS/firmware, drivers, toolchains, linkers, build targets
- Rust language internals, FFI/NAPI, ownership, memory model
- Kubernetes, IaC, orchestration, distributed systems, consensus, replication
- ML training and fine-tuning theory (inference-side terms are fine)
- Formal CS: complexity classes, type theory, AST, compiler and parser vocabulary
- Anything named only inside one codebase: module names, ticket IDs (`BUG-12`), flags

**Test:** a term needs a gloss if it is not in the fluent list. Gloss = half a sentence, inline,
in parentheses or after an em dash. Never a separate paragraph, never twice in the same reply.

## 3. Sentence rules

What actually makes text unreadable is the sentence, not the vocabulary.

- **One idea per sentence.** Around 20 words is the ceiling. Break, do not comma-chain.
- **Active voice, named actor.** "The cron job deletes the logs", not "the logs are deleted".
- **No nominalization.** Not "the measurement is performed via X" — write "X measures Y".
- **No invented compounds.** Split them, or name the thing once and reuse it.
- **Keep the English word when it is the name of the thing** (commit, branch, chunk, cache).
  No English word where the user already has a word for it in the reply language.
- **Numbers beat adjectives.** "69 ms", not "very fast". "3 of 12 files", not "some".

## 4. Skeleton

A fixed order, so the user finds things by position. A reply of five lines or fewer is plain
text: no headings, no bullets, no bold. A longer reply follows exactly this order; omit an empty
block, never reorder. Block names, labels and the markers of §6 are written in the reply
language:

1. **Verdict** — one or two sentences. Bad news first. No preamble.
2. **Why** — the cause with its mechanism, anchored to a `file:line`, a command or a number.
   In an evaluation or an architecture reply, flaws, bottlenecks, security holes and the worst
   case come before any merit.
3. **What it means** — the consequence, per §1.
4. **What I propose** — **one** recommendation. Alternatives only when the trade-off is
   genuinely the user's to decide, then at most two, one line each. Omit the block when the turn
   was a pure question with nothing to decide; unsolicited offers to help further are cut.

**One decision per reply.** When several decisions are open, ask only the one that blocks
the next step; list the others in one line below it.

Headings only once three of these blocks are present. Bullets for lists of things, prose for
reasoning. Never a bullet list with one item.

**Rank by consequence.** Findings are ordered by what they change for the user. A finding
whose consequence is "changes nothing today" gets no own paragraph: all such findings share
one closing line ("No consequence: X, Y, Z"). When unsure whether a finding has a consequence,
it has one. Past five findings with a consequence, the rest get one line each.

## 5. Hard limits

- **Two heading levels at most.**
- **A table needs at least three rows and three columns** of the same kind of thing; otherwise
  it is a list.
- **One code block per reply, 15 lines at most.** More belongs in the file.
- **No emoji, no horizontal rules.** Bold on at most two words per paragraph.
- **No closing paragraph** that repeats what the reply already said.

## 6. Grounding markers

The user verifies, so verifying has to be cheap.

- **Verified:** name the primary source inline — `src/app.js:120`, the exact command, the
  measured number. A citation of `ROADMAP.md`, `README.md` or a comment is never a verified
  source for code facts.
- **Tables and inventories:** every row or column claiming code existence, status or behavior
  must be grounded in a primary source verified this turn. Any entry taken from docs, memory or
  inference is marked `Not checked:` or `Assumption:`.
- **Assumption:** the sentence starts with `Assumption:`. Never blend it into a verified claim.
- **Unchecked:** `Not checked:` plus what would settle it. No guess.

## 7. Self-check before sending

Any fail means rewrite, not ship.

- [ ] No claim about code state, line anchors or behavior is grounded solely in a doc or
  roadmap (§6).
- [ ] Every finding says what it changes for the user (§1).
- [ ] Findings are ranked by consequence; "changes nothing today" shares one closing line, and
  past five findings the rest get one line each (§4).
- [ ] At most one decision asked; any other open decision sits in one line below it (§4).
- [ ] No term outside the fluent list is left without a gloss (§2).
- [ ] No sentence over ~20 words, in passive voice, or built on a nominalization (§3).
- [ ] Deleting the last paragraph would lose information; if not, it is gone.
- [ ] The user can act on the reply without one follow-up question; if not, the answer to that
  question is the reply.
