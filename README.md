# Codex plugin for Claude Code

Use Codex from inside Claude Code for code reviews or to delegate tasks to Codex.

This plugin is for Claude Code users who want an easy way to start using Codex from the workflow
they already have.

> [!NOTE]
> This repository is a fork of [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc).
> It tracks upstream `main` and carries a set of community pull requests that are still open
> upstream — mostly broker/background-job lifecycle fixes plus a few extra flags. See
> [Differences From Upstream](#differences-from-upstream) for the full list.

<video src="./docs/plugin-demo.webm" controls muted playsinline autoplay></video>

## What You Get

- `/codex:review` for a normal read-only Codex review
- `/codex:adversarial-review` for a steerable challenge review
- `/codex:rescue`, `/codex:transfer`, `/codex:status`, `/codex:result`, and `/codex:cancel` to delegate work, hand off sessions, and manage background jobs
- `/codex:setup` to check that Codex is installed and signed in, and to toggle the optional stop-time review gate

### Commands At A Glance

| Command | What it does | Main flags |
| --- | --- | --- |
| [`/codex:review`](#codexreview) | read-only Codex review of your current work | `--wait`, `--background`, `--base <ref>`, `--scope <auto\|working-tree\|branch>`, `--model <model\|spark>`, `--effort <level>` |
| [`/codex:adversarial-review`](#codexadversarial-review) | steerable review that challenges the approach | same as `/codex:review`, plus free-form focus text |
| [`/codex:rescue`](#codexrescue) | delegate investigation or a fix to Codex | `--background`, `--wait`, `--resume`, `--resume-thread <id>`, `--fresh`, `--model`, `--effort`, `--write`, `--sandbox <mode>`, `--read-root <dir>` |
| [`/codex:transfer`](#codextransfer) | turn this Claude session into a resumable Codex thread | `--source <claude-jsonl>` |
| [`/codex:status`](#codexstatus) | show active and recent Codex jobs | `[job-id]`, `--wait`, `--timeout-ms <ms>`, `--all` |
| [`/codex:result`](#codexresult) | show the stored output of a finished job | `[job-id]` |
| [`/codex:cancel`](#codexcancel) | cancel an active background job | `[job-id]` |
| [`/codex:setup`](#codexsetup) | check the Codex install, manage the review gate | `--enable-review-gate`, `--disable-review-gate` |

Accepted `--effort` values are `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`. An
unrecognised `--flag` is not silently swallowed into the prompt: the plugin warns on stderr and
passes the token through as text.

## Requirements

- **ChatGPT subscription (incl. Free) or OpenAI API key.**
  - Usage will contribute to your Codex usage limits. [Learn more](https://developers.openai.com/codex/pricing).
- **Node.js 18.18 or later.**
  - It does not have to be on the system PATH: the hooks resolve Node through `scripts/run-node.sh`, which also looks in nvm, fnm, asdf, mise, Volta and Homebrew toolchains, preferring one that ships `codex` alongside it. Set `CODEX_COMPANION_NODE` to an executable path to pin a specific one.

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add Edo771977/codex-plugin-cc
```

(Use `openai/codex-plugin-cc` instead if you want upstream without the imported fixes. The
marketplace name is `openai-codex` either way, so only one of the two can be added at a time.)

Install the plugin:

```bash
/plugin install codex@openai-codex
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/codex:setup
```

`/codex:setup` will tell you whether Codex is ready. If Codex is missing and npm is available, it can offer to install Codex for you.

If you prefer to install Codex yourself, use:

```bash
npm install -g @openai/codex
```

If Codex is installed but not logged in yet, run:

```bash
!codex login
```

After install, you should see:

- the slash commands listed below
- the `codex:codex-rescue` subagent in `/agents`

One simple first run is:

```bash
/codex:review --background
/codex:status
/codex:result
```

## Usage

### `/codex:review`

Runs a normal Codex review on your current work. It gives you the same quality of code review as running `/review` inside Codex directly.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait`, `--background`, `--scope <auto|working-tree|branch>`, and — like `/codex:rescue` — `--model <model|spark>` and `--effort <level>` to pick the reviewing model and how hard it thinks. It is not steerable and does not take custom focus text. Use [`/codex:adversarial-review`](#codexadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/codex:review
/codex:review --base main
/codex:review --background
/codex:review --base main --model gpt-5.4-mini --effort high
```

This command is read-only and will not perform any changes. When run in the background you can use [`/codex:status`](#codexstatus) to check on the progress and [`/codex:cancel`](#codexcancel) to cancel the ongoing task.

### `/codex:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/codex:review`, including `--base <ref>` for branch review.
It also supports `--wait`, `--background`, `--model <model|spark>`, and `--effort <level>`. Unlike `/codex:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/codex:adversarial-review
/codex:adversarial-review --base main challenge whether this was the right caching and retry design
/codex:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/codex:rescue`

Hands a task to Codex through the `codex:codex-rescue` subagent.

Use it when you want Codex to:

- investigate a bug
- try a fix
- continue a previous Codex task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, `--resume-thread <id>`, `--fresh`, `--model <model|spark>`, `--effort <level>`, `--write`, `--sandbox <read-only|workspace-write|danger-full-access>`, and repeatable `--read-root <directory>`. If you omit the resume flags, the plugin can offer to continue the latest rescue thread for this repo.

Examples:

```bash
/codex:rescue investigate why the tests started failing
/codex:rescue fix the failing test with the smallest safe patch
/codex:rescue --resume apply the top fix from the last run
/codex:rescue --resume-thread thr_0199... keep working on that specific thread
/codex:rescue --model gpt-5.4-mini --effort medium investigate the flaky integration test
/codex:rescue --model spark fix the issue quickly
/codex:rescue --background investigate the regression
/codex:rescue --sandbox read-only explain how the cache invalidation works
/codex:rescue --sandbox danger-full-access run the integration tests and fix what fails
/codex:rescue --read-root ./src --read-root ./tests inspect only the approved paths
```

You can also just ask for a task to be delegated to Codex:

```text
Ask Codex to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, Codex chooses its own defaults.
- if you say `spark`, the plugin maps that to `gpt-5.3-codex-spark`
- follow-up rescue requests can continue the latest Codex task in the repo
- `--resume`/`--resume-last` continues the newest thread for this repository; `--resume-thread <id>` continues one specific thread (the id is printed by `/codex:status` and `/codex:result`). `--resume`, `--resume-thread`, and `--fresh` are mutually exclusive.
- `--sandbox` applies to `/codex:rescue` only; the review commands stay read-only. It takes precedence over `--write` and counts only before the task text. Rescue runs edit files inside the repository by default (`workspace-write`); `read-only` blocks edits, and `danger-full-access` disables the Codex sandbox entirely, so Codex can write outside the repository and use the network without asking. Reserve it for tasks the sandbox blocks.
- a resumed thread keeps the sandbox it was started with while the plugin's shared app-server still holds it, which is the normal case inside one Claude Code session (Codex CLI 0.153.2 applies a new mode only when it loads the thread again from disk). `task` refuses a resume whose sandbox differs from what the app-server reports; resume with the same `--sandbox`, or start a new thread with `--fresh`.
- each `--read-root <directory>` must name an existing directory and opts into an OS-enforced permission profile that denies local command reads outside the listed directories and Codex's minimal runtime paths
- a scoped `--write` (or `--sandbox workspace-write`) requires the approved read roots to cover the workspace directory and uses Codex's built-in `:workspace` write policy; `--read-root` is rejected together with `--sandbox danger-full-access`
- scoped reads require Codex 0.138.0 or later and fail closed when the runtime cannot enforce permission profiles
- filesystem profiles apply to local sandboxed commands, not web search, MCP servers, connectors, browser tools, or computer use

### `/codex:transfer`

Creates a persistent Codex thread from the current Claude Code session and prints a `codex resume <session-id>` command.

Use it when you started a debugging or implementation conversation in Claude Code and want to continue that same context directly in Codex.

Examples:

```bash
/codex:transfer
/codex:transfer --source ~/.claude/projects/-Users-me-repo/<session-id>.jsonl
```

The plugin's existing `SessionStart` hook supplies the current transcript path automatically; `--source` is available as a manual override. The transfer uses Codex's external-agent session importer, so it follows the same conversion rules as importing Claude history in the Codex App and creates visible turns that can be continued in the App or TUI. The source must live under a Claude projects root — `~/.claude/projects`, or `$CLAUDE_CONFIG_DIR/projects` when you have relocated your Claude config — and older Codex versions that do not expose session import must be upgraded before using this command.

### `/codex:status`

Shows running and recent Codex jobs for the current repository.

Examples:

```bash
/codex:status
/codex:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/codex:result`

Shows the final stored Codex output for a finished job.
When available, it also includes the Codex session ID so you can reopen that run directly in Codex with `codex resume <session-id>`.

Examples:

```bash
/codex:result
/codex:result task-abc123
```

### `/codex:cancel`

Cancels an active background Codex job.

Examples:

```bash
/codex:cancel
/codex:cancel task-abc123
```

### `/codex:setup`

Checks whether Codex is installed and authenticated.
If Codex is missing and npm is available, it can offer to install Codex for you.

You can also use `/codex:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/codex:setup --enable-review-gate
/codex:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Codex review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

On the continuation turn that follows a block, the gate does not review again: Claude Code re-invokes the hook with `stop_hook_active`, and re-running the review there would just block again until the harness's retry cap ends the turn. The skip is reported as a system message, so run `/codex:review --wait` yourself when you want the fixes verified.

> [!WARNING]
> The review gate can create a long-running Claude/Codex loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/codex:review
```

### Hand A Problem To Codex

```bash
/codex:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/codex:adversarial-review --background
/codex:rescue --background investigate the flaky test
```

Then check in with:

```bash
/codex:status
/codex:result
```

## Codex Integration

The Codex plugin wraps the [Codex app server](https://developers.openai.com/codex/app-server). It uses the global `codex` binary installed in your environment and [applies the same configuration](https://developers.openai.com/codex/config-basic).

### Common Configurations

If you want to change the default reasoning effort or the default model that gets used by the plugin, you can define that inside your user-level or project-level `config.toml`. For example to always use `gpt-5.4-mini` on `high` for a specific project you can add the following to a `.codex/config.toml` file at the root of the directory you started Claude in:

```toml
model = "gpt-5.4-mini"
model_reasoning_effort = "high"
```

Your configuration will be picked up based on:

- user-level config in `~/.codex/config.toml`
- project-level overrides in `.codex/config.toml`
- project-level overrides only load when the [project is trusted](https://developers.openai.com/codex/config-advanced#project-config-files-codexconfigtoml)

Check out the Codex docs for more [configuration options](https://developers.openai.com/codex/config-reference).

### Background Runtime Limits

Background tasks and reviews run through a shared, workspace-local broker process that outlives the Claude session that started it. A few environment variables bound how long different parts of that runtime are allowed to stay alive; all default to sensible values and accept `0` to disable the limit entirely.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_BROKER_IDLE_SHUTDOWN_MS` | 10 minutes | How long the shared broker may sit with no connected client before shutting itself down. |
| `CODEX_BROKER_STARTUP_TIMEOUT_MS` | 5 minutes | How long the broker may spend starting up (spawning its app-server and MCP servers) before it gives up and tears itself down. |
| `CODEX_TASK_WORKER_TTL_MS` | 24 hours | Ceiling on a detached background task's wall-clock lifetime — a runaway guard, not a task deadline. |

Set any of these in the environment before starting Claude Code, for example:

```bash
export CODEX_BROKER_IDLE_SHUTDOWN_MS=1800000  # 30 minutes
```

These are advanced knobs for tuning resource usage in long-running or resource-constrained environments; most users will never need to touch them.

### Moving The Work Over To Codex

Delegated tasks and any [stop gate](#what-does-the-review-gate-do) run can also be directly resumed inside Codex by running `codex resume` either with the specific session ID you received from running `/codex:result` or `/codex:status` or by selecting it from the list.

This way you can review the Codex work or continue the work there.

## Differences From Upstream

This fork is [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) `main` plus a
set of community pull requests that are still open upstream. Each one is a separate merge commit,
so any of them can be reverted on its own.

Broker and background-job lifecycle:

| Upstream PR | What it fixes |
| --- | --- |
| [#541](https://github.com/openai/codex-plugin-cc/pull/541) | broker leaks, state races, and signal-masked command failures in the test runtime |
| [#623](https://github.com/openai/codex-plugin-cc/pull/623) | session end no longer tears down the shared broker while another session's jobs are still using it |
| [#652](https://github.com/openai/codex-plugin-cc/pull/652) | bounds the lifetime of detached brokers and task workers (see [Background Runtime Limits](#background-runtime-limits)) |
| [#659](https://github.com/openai/codex-plugin-cc/pull/659) | state written under one `CLAUDE_PLUGIN_DATA` root is no longer invisible to an invocation that resolves to another, which orphaned brokers and hid jobs |
| [#707](https://github.com/openai/codex-plugin-cc/pull/707) | the broker releases its app-server thread subscriptions when a client disconnects, instead of leaking them for its whole lifetime |
| [#728](https://github.com/openai/codex-plugin-cc/pull/728) | a job whose worker died no longer reads as "running" forever; `/codex:status` reconciles the record against the live process |

Commands and flags:

| Upstream PR | What it adds |
| --- | --- |
| [#565](https://github.com/openai/codex-plugin-cc/pull/565) | the stop-review gate honors `stop_hook_active` instead of re-blocking a continuation turn |
| [#724](https://github.com/openai/codex-plugin-cc/pull/724) | `--read-root <directory>` for OS-enforced scoped reads |
| [#727](https://github.com/openai/codex-plugin-cc/pull/727) | `--resume-thread <id>` to continue one specific Codex thread |
| [#729](https://github.com/openai/codex-plugin-cc/pull/729) | `/codex:transfer` works with a relocated `CLAUDE_CONFIG_DIR` |
| [#742](https://github.com/openai/codex-plugin-cc/pull/742) | `--sandbox <mode>` on `task` and `/codex:rescue` |
| [#746](https://github.com/openai/codex-plugin-cc/pull/746) | `--model`/`--effort` on the review commands, and a warning for unrecognised options |
| [#748](https://github.com/openai/codex-plugin-cc/pull/748) | `CLAUDE_ENV_FILE` keeps one export per key instead of growing on every session |
| [#731](https://github.com/openai/codex-plugin-cc/pull/731) | the review-gate flag is persisted outside the transient state dir, so a different `CLAUDE_PLUGIN_DATA` no longer silently disables it |
| [#737](https://github.com/openai/codex-plugin-cc/pull/737) | hooks resolve Node through `scripts/run-node.sh`, so nvm/fnm/asdf/mise/Volta/Homebrew toolchains work under the minimal hook PATH |
| [#747](https://github.com/openai/codex-plugin-cc/pull/747) | `runCommand` sets an explicit 256 MiB `maxBuffer`, so a large `git diff` is no longer truncated at Node's 1 MiB default |
| [#763](https://github.com/openai/codex-plugin-cc/pull/763) | a turn that fails without throwing stores its error text, so `/codex:result` says why it failed |

Where two of these PRs disagreed, the merge commit says which side won and why. The plugin version
is deliberately left at the upstream number: these merges do not cut a release.

Beyond the imports, this fork carries fixes for defects the imports themselves surfaced:

- a busy broker refusing shutdown is reported as a refusal, not an identity rejection, so SessionEnd
  leaves a shared runtime to the sessions still using it instead of exiting with an error
- `scripts/run-node.sh` prefers a user-managed toolchain over a system install, which [#737](https://github.com/openai/codex-plugin-cc/pull/737)
  had inverted (see the note under [Requirements](#requirements))
- the durable review-gate config is written privately and atomically, so an interrupted write cannot
  silently disable the gate
- the app-server typecheck (`npm run build`) passes

Not imported: [#733](https://github.com/openai/codex-plugin-cc/pull/733) (durable startup
cancellation) — its behavior is already covered here by the terminal-claim mechanism, and its marker
files would add a second source of truth for the same decision. [#761](https://github.com/openai/codex-plugin-cc/pull/761)
(`max`/`ultra` reasoning efforts) — the same proposal was closed upstream as [#648](https://github.com/openai/codex-plugin-cc/pull/648).

## FAQ

### Do I need a separate Codex account for this plugin?

If you are already signed into Codex on this machine, that account should work immediately here too. This plugin uses your local Codex CLI authentication.

If you only use Claude Code today and have not used Codex yet, you will also need to sign in to Codex with either a ChatGPT account or an API key. [Codex is available with your ChatGPT subscription](https://developers.openai.com/codex/pricing/), and [`codex login`](https://developers.openai.com/codex/cli/reference/#codex-login) supports both ChatGPT and API key sign-in. Run `/codex:setup` to check whether Codex is ready, and use `!codex login` if it is not.

### Does the plugin use a separate Codex runtime?

No. This plugin delegates through your local [Codex CLI](https://developers.openai.com/codex/cli/) and [Codex app server](https://developers.openai.com/codex/app-server/) on the same machine.

That means:

- it uses the same Codex install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same Codex config I already have?

Yes. If you already use Codex, the plugin picks up the same [configuration](#common-configurations).

### Can I keep using my current API key or base URL setup?

Yes. Because the plugin uses your local Codex CLI, your existing sign-in method and config still apply.

If you need to point the built-in OpenAI provider at a different endpoint, set `openai_base_url` in your [Codex config](https://developers.openai.com/codex/config-advanced/#config-and-state-locations).
