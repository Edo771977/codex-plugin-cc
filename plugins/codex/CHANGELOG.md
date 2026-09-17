# Changelog

## Unreleased

- Add opt-in `--read-root` enforcement for Codex rescue tasks using request-scoped permission profiles (openai/codex-plugin-cc#724).
- Preserve scoped roots across foreground, background, and resumed tasks, with fail-closed runtime compatibility errors.
- Require every `--read-root` to be an existing, non-empty directory so scoped tasks do not claim unsupported file-level isolation on macOS.
- Use the built-in `:workspace` profile for scoped write tasks and require the approved read roots to cover the workspace.
- Deny inherited system temp roots in scoped profiles so only approved directories and minimal runtime paths remain readable.
- Reject `--read-root` together with `--sandbox danger-full-access`, which disables the sandbox entirely.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
