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

## 1.0.0

- Initial version of the Codex plugin for Claude Code
