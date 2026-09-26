---
name: gpt-6-prompting
description: Internal guidance for composing GPT-6 (Luna, Sol, Astra) Codex prompts for coding, review, diagnosis, research, and vision tasks inside the Codex Claude Code plugin
user-invocable: false
---
<!-- Canonical source: andrewmaspero/codex-skills skills/gpt-6-prompting. Keep in sync. -->


# GPT-6 Prompting

GPT-6 models are strong but differ from Claude and from GPT-5.6 in ways that
silently break vague briefs. Write for a capable operator that follows the
brief literally, is very sensitive to instruction files, and pauses to ask
questions nobody will answer in a background job.

Grounded in OpenAI's [GPT-6 model guidance](https://developers.openai.com/api/docs/guides/latest-model),
the [Sol/Luna launch](https://openai.com/index/introducing-gpt-6-sol-and-luna/),
the [Astra launch](https://openai.com/index/gpt-6-astra/), and live Codex runs
on 25 September 2026. Recheck the model guide when OpenAI ships a new release.

## Pick the model

| model | slug | list $ in/out per 1M | efforts | use it for |
|---|---|---|---|---|
| Luna | `gpt-6-luna` | 0.10 / 0.50 | none–max | Default for anything bulk or well-specified: research, lookups, codebase scans, bulk vision (screenshots, documents, image triage), data extraction, and strictly specified coding. Effectively free, so run many in parallel. |
| Sol | `gpt-6-sol` | 2 / 10 | none–max | The workhorse: multi-file implementation, debugging, test/lint loops, reviews, and code that should be ready to merge. Thorough and checks its own work. |
| Astra | `gpt-6-astra` | 10 / 50 | low–max (no `none`) | Rare and deliberate: architecture review or second opinion, an occasional end-to-end review, writing prompts for other models, complex computer use (for example redrawing a sketch in Figma), and 3D/CAD work. Priced like Fable 5.1. |

Effort:

- Luna: `none` or `low` for lookups, extraction, and bulk vision; `medium` for
  research and coding; `high` only when a medium run demonstrably fell short.
- Sol: `medium` by default; `high` for large multi-part jobs; `low` for small edits.
- Astra: `low` or `medium` only. Never above `medium`: it burns tokens for no
  gain. It has no `none`; use `low`.
- Tighten the brief before raising effort. A sharper contract beats more reasoning.
- Keep effort at `high` or below. This fork accepts `xhigh` as well, so nothing
  stops you from passing it: treat that as a cost decision to make deliberately,
  not a default. `max` and `ultra` are not accepted at all.

Escalate without asking when output misses the bar: Luna → Sol → Astra (or a
Claude reviewer). Judge the output, not the price.

## The six GPT-6 behaviours every brief must handle

OpenAI documents these for GPT-6, with Astra as the main example; live runs
confirmed them on Luna and Sol too. Re-evaluate when a model changes.

1. **It asks instead of acting.** GPT-6 asks clarifying questions more than
   GPT-5.6. In a background job the question just ends the turn. Always include
   the `<autonomy>` block from [references/blocks.md](references/blocks.md): no
   questions, a BLOCKED report when a decision lacks evidence or permission,
   and a budget.
2. **It obeys instruction files.** It weighs `AGENTS.md`, `CLAUDE.md`, and
   skill files heavily. Repos often contain automation rules such as "push, open
   a PR, and merge automatically", and the worker will follow them. Always
   state repository-policy overrides explicitly: branch, commit, push, PR, and
   merge permissions. Say that the brief takes precedence over repository
   instruction files.
3. **It is literal, and Luna is the most literal.** It fills routine gaps, but
   consequential ones get guessed or skipped. Spell out the output shape, the
   verification commands, what is out of scope, and the stop conditions. For Luna coding work, give exact files,
   signatures, and acceptance tests. Luna codes well when the spec is strict and
   drifts when it is loose.
4. **It defaults to Markdown lists and tables.** If the output feeds a parser
   or another model, give an exact schema. If it feeds a human, say what length
   and form you want.
5. **It over-tests small changes.** Scope verification: run the named checks;
   do not add tests for reversible, low-impact changes that mirror the
   implementation. Require regression tests only where a bug was fixed.
6. **It under-delegates.** Sol and Astra can run their own subagents. For big
   decomposable jobs, explicitly permit parallel delegation (see the
   `<delegation>` block). Otherwise it will serialize.

## Brief shape

Use XML-tagged blocks; they keep long briefs debuggable and let steering
deltas refer to them by name. Minimum for any Codex job:

```xml
<task>What to do, where (absolute repo path), and what done looks like.</task>
<autonomy>…</autonomy>
<repo_policy>Branch/commit/push/PR permissions; brief overrides repo instruction files.</repo_policy>
<scope>Allowed paths. Forbidden paths. No unrelated refactors.</scope>
<verification>Exact commands; pass criteria; what not to test.</verification>
<progress_updates>…</progress_updates>
<output_contract>Exact shape of the final message, with a word cap.</output_contract>
```

Add blocks only when they are needed: `<grounding>` for research and review,
`<delegation>` for big jobs, `<vision>` for image work, and `<stop_rules>`
for loops. Copy the blocks from [references/blocks.md](references/blocks.md);
full recipes per model live in [references/recipes.md](references/recipes.md).

Always include `<progress_updates>` for background jobs. Codex runs GPT-6 at
low verbosity by default (model catalog `default_verbosity: low`), so without
the block the job log shows only commands. With it, every
milestone lands as an "Assistant message" line that a controller's log monitor
turns into a live mini-update.

## Steering and goals

- A steer is a delta: what changed, what to stop, the next expected output.
  Keep it under 150 words and name the block or item it amends ("Correction to
  item 3"). The model applies it at its next reasoning step, and the completed
  work is preserved.
- If a steer changes what "done" means, update the goal too.
- A goal objective states the outcome, checkable acceptance criteria, a loop
  rule ("after every change re-run X"), and a stop rule ("after 3 distinct
  failed fixes, mark blocked and summarize").

## Astra as prompt author

Astra is unusually good at writing prompts that other models follow. Use it
(effort `medium`) when building an LLM/VLM pipeline, a classifier, an
extraction prompt, a Luna fan-out brief that will run thousands of times, or a
system prompt. Give it the target model, real sample inputs, the failure cases
you have seen, and the output schema; ask for the prompt plus a short test set.
Then run the prompt on Luna against the samples before adopting it. The recipe
is in [references/recipes.md](references/recipes.md#astra-prompt-author).

## Choose the command

- Use the built-in `review` or `adversarial-review` commands when the job is reviewing local git changes. Their prompts already carry the review contract.
- Use `task` when the task is diagnosis, planning, research, or implementation and you need to control the prompt directly.
- Use `task --resume-last` for follow-up instructions on the same Codex thread. Send only the delta unless the direction changed materially.

## Anti-patterns

- "Look into X and fix whatever seems wrong": no done-state, so Luna stops
  early and Sol wanders.
- Relying on the repo's `AGENTS.md` for git behaviour, which is how workers end
  up pushing and merging on their own.
- Asking a background job to "confirm with me before …": nobody will answer.
  Give it the decision rule instead.
- Pasting whole transcripts or files. Give paths and let the worker read them.
- Raising effort to fix a vague brief.
- Astra for bulk work, or Astra above `medium`.
