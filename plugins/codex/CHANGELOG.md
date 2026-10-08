# Changelog

## Unreleased

- Add opt-in `--read-root` enforcement for Codex rescue tasks using request-scoped permission profiles (openai/codex-plugin-cc#724).
- Preserve scoped roots across foreground, background, and resumed tasks, with fail-closed runtime compatibility errors.
- Require every `--read-root` to be an existing, non-empty directory so scoped tasks do not claim unsupported file-level isolation on macOS.
- Use the built-in `:workspace` profile for scoped write tasks and require the approved read roots to cover the workspace.
- Deny inherited system temp roots in scoped profiles so only approved directories and minimal runtime paths remain readable.
- Reject `--read-root` together with `--sandbox danger-full-access`, which disables the sandbox entirely.
- Treat a busy broker's shutdown refusal as a refusal rather than an identity rejection, so SessionEnd leaves the shared runtime to the sessions still using it instead of exiting with an error.
- Set an explicit 256 MiB `maxBuffer` for spawned commands so a large `git diff` is no longer truncated at Node's 1 MiB default.
- Persist the failure text of a turn that fails without throwing, and shorten job summaries to 96 characters.
- Keep the review-gate flag in a durable per-workspace file under `CODEX_HOME`, written privately and atomically.
- Resolve Node through `scripts/run-node.sh` in the hooks, preferring a user-managed toolchain over a system install.
- Release the broker's app-server thread subscriptions when a client disconnects, so a departed client no longer leaks them for the broker's lifetime (openai/codex-plugin-cc#707).
- Read state from every candidate `CLAUDE_PLUGIN_DATA` root, so jobs and broker records written by one invocation are not invisible to another (openai/codex-plugin-cc#659).
- Reconcile a job against its worker process, so a job whose worker died stops reading as running (openai/codex-plugin-cc#728).
- Replace the internal `gpt-5-4-prompting` skill with `gpt-6-prompting`: GPT-6 brief blocks (autonomy, repo policy, verification states, progress updates, output contracts) and per-model recipes for Luna, Sol and Astra (openai/codex-plugin-cc#784, skill commit only). Its launch lines use full model slugs and its effort note matches this fork's validators.
- Add short model aliases for the GPT-6 models: `sol`, `luna` and `astra` expand to `gpt-6-sol`, `gpt-6-luna` and `gpt-6-astra`, alongside the existing `spark`. Aliases are now expanded on `review` and `adversarial-review` as well, which previously forwarded the raw `--model` value to Codex.

- Signal the pid itself when the process-group SIGTERM fails with ESRCH, so a process that does not lead its own process group still gets the graceful stop instead of only the later force kill (openai/codex-plugin-cc#787).
- Name a delegated thread after the `<task>` block of a structured prompt, so threads shaped by the prompting skill can be told apart in Codex's list instead of all reading "Codex Companion Task: <task> …" (openai/codex-plugin-cc#792).
- Stop cutting a surrogate pair in half when shortening a thread name or job summary: a lone surrogate made the app-server drop the request (openai/codex-plugin-cc#800).
- Tell the review commands not to read or wait for the background command's output at all, rather than naming `BashOutput` as the one thing not to call, and restate the result-handling stop rule without the shouting: present the findings, ask which to fix, edit nothing until the user picks (openai/codex-plugin-cc#799).

## 1.0.0

- Initial version of the Codex plugin for Claude Code
