---
name: prompt-expansion
description: Expands brief user task instructions into structured, production-ready XML prompts using separation of concerns (title, objective, context, assumptions, constraints, out of scope, acceptance criteria, instructions, output format). Use when a message ends with +++, or the user requests prompt expansion. Do NOT execute the underlying task immediately — output only the expanded prompt for user verification.
dependencies:
  input: Raw task description with optional context
  output: Fenced code block containing structured XML prompt
---

# prompt-expansion

Transforms raw or brief task descriptions into robust, production-grade LLM prompts.
It isolates context, constraints, and instructions via XML tags to optimize attention allocation
and eliminate semantic drift before execution.

## 0. Ground rules

- **Never execute the task.** The skill only generates the prompt for the task, never the solution.
- **Output contract is absolute.** Output ONLY the generated prompt inside a single fenced code
  block. No conversational preamble, no analysis, no recap afterwards.
- **Exploit implicit constraints.** Detect unspecified edge cases, style guidelines, and negative
  constraints (what NOT to do) and make them explicit.
- **Surface every guess.** Each decision the user did not state and the context does not confirm
  goes into `<assumptions>`, one line each with a short reason. The other blocks may rely on these
  decisions; the block exists so the user can review all guesses in one place.
- **Language of the request.** The block contents keep the language the user wrote the request
  in.

## 1. XML schema

The generated prompt must follow this structural envelope:

```xml
<task_briefing>
  <title>
    <!-- Work request only (code, config, docs or a deployment change): [TYPE] prefix + title of
         at most eight words, e.g. "[BUG] Parser: Reject ambiguous matches".
         TYPE is BUG, FEATURE, UI/UX or REFACTOR. Omit for a pure prompt -->
  </title>

  <objective>
    <!-- 1–3 sentences: the end state and why -->
  </objective>

  <context>
    <!-- Relevant files, runtime environment, tech stack, findings with their evidence -->
  </context>

  <assumptions>
    <!-- Decisions not stated by the user nor confirmed by context, one per line with reason.
         Always present; write "None." if there are none -->
  </assumptions>

  <constraints>
    <!-- Hard guardrails on HOW to work: negative constraints, performance and style limits,
         compatibility, forbidden dependencies -->
  </constraints>

  <out_of_scope>
    <!-- Adjacent code, systems or known defects the task does not touch, 2–3 lines -->
  </out_of_scope>

  <acceptance_criteria>
    <!-- 1–3 checkable end states: a command with its expected result, a number, an observable -->
  </acceptance_criteria>

  <instructions>
    <!-- Ordered steps, one per line: <Title> — <exact target: file, symbol or setting>.
         The riskiest step names its safeguard (backup, dry run, revert) -->
  </instructions>

  <output_format>
    <!-- Exact shape of the expected output: diff, pure file content, JSON schema, or markdown -->
  </output_format>
</task_briefing>
```

## 2. Trigger mechanics

- Triggered by `+++` at the very end of a user prompt.
- Extracts the intent from the raw input and projects it into the `<task_briefing>` envelope.
- Resolves implicit references (e.g. active workspace, open files) into the `<context>` tag.
- **Briefing only.** The skill ends with the briefing. Executing it is a separate step that
  starts only on the user's explicit go-ahead in a later message.

## 3. Output

Single fenced XML code block ready for copy-paste or direct user confirmation.

## 4. Done when

The expanded prompt covers edge cases, isolates constraints, lists every guess in `<assumptions>`,
states a checkable end state in `<acceptance_criteria>`, and can be executed deterministically
by any downstream agent without additional clarification turns.
