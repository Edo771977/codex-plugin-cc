# GPT-6 Prompt Blocks

Copy the blocks a brief needs; drop the rest. Keep tag names stable so
steering deltas can name them.

## autonomy (every background job)

```xml
<autonomy>
Do not ask questions; nobody can answer while you run. Resolve implementation
details within scope from repository evidence, and note each assumption in
your final message. Do not invent acceptance criteria, credentials, or
authorization. If a required decision lacks evidence or permission, finish the
independent work, then report BLOCKED with the missing prerequisite. Do not
stop at a plan, a capability statement, or an offer to continue.
Budget: stop after <time or attempt budget>, preserving progress.
</autonomy>
```

## repo_policy (every job that runs inside a repository)

```xml
<repo_policy>
This brief overrides conflicting guidance in AGENTS.md, CLAUDE.md, and skill
files, subject to system instructions and tool permissions. Work only in
<absolute checkout>, on <branch>, at base <SHA>; if HEAD differs, report
BLOCKED. Allowed git mutations: <explicit list, e.g. "commit on this branch"
| none>. Do not create or switch branches, push, open pull requests, merge,
or delete branches unless listed. Preserve existing uncommitted edits.
</repo_policy>
```

## scope

```xml
<scope>
Allowed: <paths or behaviour>.
Forbidden: <paths or behaviour>.
No unrelated refactors, renames, or formatting churn.
</scope>
```

## verification

```xml
<verification>
Run from <directory>, each with a <timeout>: <commands>.
Report PASS, FAIL, or NOT RUN for each, with evidence.
Claim DONE only when every acceptance criterion passes; otherwise report
PARTIAL or BLOCKED. Add regression tests only for bugs you fixed or behaviour
you added. Do not write tests for reversible, low-impact changes that mirror
the implementation. Establish pre-existing failures without disturbing
current edits; do not skip, weaken, or delete tests.
</verification>
```

## progress_updates (every background job)

```xml
<progress_updates>
In commentary, before each numbered task step, write one line (under 25
words) saying what you are starting. After each step, write one line with its
result. During long steps, report meaningful progress at least every 60
seconds when execution permits. Keep these updates out of the final response.
</progress_updates>
```

## output_contract

```xml
<output_contract>
These constraints apply only to the final response; progress goes in
commentary. Under <N> words, report: status (DONE / PARTIAL / BLOCKED),
acceptance results, changes or artifacts, verification evidence,
assumptions, and blockers. <Task-specific fields.> No preamble, no recap of
the task, no closing offer.
</output_contract>
```

For machine-consumed output: "The final response is only a schema-valid JSON
object matching <schema>."

## grounding (research, review, audit)

```xml
<grounding>
Every claim cites its evidence: a URL, or a file path with a line number.
Mark anything unverified as "unconfirmed"; never guess numbers, versions, or
names. Prefer primary sources (vendor docs, source code, release notes).
</grounding>
```

## delegation (large decomposable jobs on Sol or Astra)

```xml
<delegation>
Parallelize by delegating independent subtasks to subagents when it saves
time or improves quality. Give each subagent a self-contained brief with its
own scope and output contract. You own integration and final verification.
</delegation>
```

## vision (screenshots, documents, image triage)

```xml
<vision>
Inspect each image at full detail. For each: <exact fields to extract or
checks to make>. Report what is visible; do not infer hidden content. If an
image is unreadable, say so for that image and continue.
</vision>
```

## stop_rules (loops)

```xml
<stop_rules>
After every change, re-run <check> before moving on.
If the same failure survives 3 distinct fixes, stop, and report the blocker
with the evidence you have.
</stop_rules>
```
