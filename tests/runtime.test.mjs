import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { loadBrokerSession, saveBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { loadState, resolveStateDir, saveState } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

test("setup reports ready when fake codex is installed and authenticated", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.match(payload.codex.detail, /advanced runtime available/);
  assert.equal(payload.sessionRuntime.mode, "direct");
});

test("setup is ready without npm when Codex is already installed and authenticated", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  fs.symlinkSync(process.execPath, path.join(binDir, "node"));

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: binDir
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.npm.available, false);
  assert.equal(payload.codex.available, true);
  assert.equal(payload.auth.loggedIn, true);
});

test("setup trusts app-server API key auth even when login status alone would fail", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "api-key-account-only");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, "apiKey");
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /API key configured \(unverified\)/);
});

test("setup is ready when the active provider does not require OpenAI login", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "provider-no-auth");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, null);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /configured and does not require OpenAI authentication/i);
});

test("setup treats custom providers with app-server-ready config as ready", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "env-key-provider");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, null);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /configured and does not require OpenAI authentication/i);
});

test("setup reports not ready when app-server config read fails", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "config-read-fails");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.auth.loggedIn, false);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /config\/read failed for cwd/);
});

test("review renders a no-findings result from app-server review/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Reviewed uncommitted changes/);
  assert.match(result.stdout, /No material issues found/);
});

test("task runs when the active provider does not require OpenAI login", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "provider-no-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "check auth preflight"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test("task runs without auth preflight so Codex can refresh an expired session", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "refreshable-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "check refreshable auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test("transfer delegates the current Claude session directly to native import", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const sessionId = "sess-native-transfer";
  fs.mkdirSync(repo, { recursive: true });
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir);
  initGitRepo(repo);

  fs.writeFileSync(
    sourcePath,
    [
      { type: "custom-title", customTitle: "Native transfer" },
      { type: "user", cwd: repo, message: { role: "user", content: "Initial request" } },
      { type: "assistant", cwd: repo, message: { role: "assistant", content: "Initial answer" } },
      { type: "user", cwd: repo, message: { role: "user", content: "/codex:transfer" } }
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    "utf8"
  );
  const result = run("node", [SCRIPT, "transfer", "--json"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: path.join(home, ".codex"),
      CODEX_COMPANION_TRANSCRIPT_PATH: sourcePath
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const canonicalSourcePath = fs.realpathSync(sourcePath);
  assert.equal(payload.threadId, "thr_1");
  assert.equal(payload.resumeCommand, "codex resume thr_1");
  assert.equal(payload.sourcePath, canonicalSourcePath);
  assert.equal(payload.sessionId, sessionId);

  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(fakeState.threads.length, 1);
  assert.equal(fakeState.threads[0].ephemeral, false);
  assert.equal(fakeState.threads[0].name, "Native transfer");
  assert.equal(fakeState.lastExternalAgentImport.sourcePath, canonicalSourcePath);
  assert.deepEqual(
    fakeState.threads[0].visibleMessages.map((message) => message.text),
    ["Initial request", "Initial answer", "/codex:transfer"]
  );
});

test("transfer supports CLAUDE_CONFIG_DIR and stages a temporary default-root copy", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const claudeConfigDir = path.join(home, ".claude-work");
  const projectDir = path.join(claudeConfigDir, "projects", "-repo");
  const sourcePath = path.join(projectDir, "session-alt-root.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Transfer from relocated config." } })}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--json"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: path.join(home, ".codex"),
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      CODEX_COMPANION_TRANSCRIPT_PATH: sourcePath
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const original = fs.realpathSync(sourcePath);
  assert.equal(payload.sourcePath, original);

  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  const importedPath = fakeState.lastExternalAgentImport.sourcePath;
  const defaultProjects = path.join(home, ".claude", "projects");
  const relativeImport = path.relative(defaultProjects, importedPath);
  assert.equal(relativeImport.startsWith("..") || path.isAbsolute(relativeImport), false);
  assert.notEqual(importedPath, original);
  assert.equal(fs.existsSync(importedPath), false);
  assert.equal(fs.existsSync(original), true);
});

test("transfer retries with a collision-free staged filename when the mirrored destination exists", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const claudeConfigDir = path.join(home, ".claude-work");
  const projectDir = path.join(claudeConfigDir, "projects", "-repo");
  const sourcePath = path.join(projectDir, "session-collision.jsonl");
  const mirroredPath = path.join(home, ".claude", "projects", "-repo", "session-collision.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.dirname(mirroredPath), { recursive: true });
  fs.writeFileSync(mirroredPath, "STALE-STAGING\n", "utf8");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(sourcePath, `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Retry safely." } })}\n`, "utf8");

  const result = run("node", [SCRIPT, "transfer", "--json"], {
    cwd: repo,
    env: { ...buildEnv(binDir), HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: claudeConfigDir, CODEX_COMPANION_TRANSCRIPT_PATH: sourcePath }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(mirroredPath, "utf8"), "STALE-STAGING\n");
  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  const firstImportedPath = fakeState.lastExternalAgentImport.sourcePath;
  assert.notEqual(path.resolve(firstImportedPath), path.resolve(mirroredPath));
  assert.equal(fs.existsSync(firstImportedPath), false);

  const retry = run("node", [SCRIPT, "transfer", "--json"], {
    cwd: repo,
    env: { ...buildEnv(binDir), HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: claudeConfigDir, CODEX_COMPANION_TRANSCRIPT_PATH: sourcePath }
  });
  assert.equal(retry.status, 0, retry.stderr);
  const retryState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(path.resolve(retryState.lastExternalAgentImport.sourcePath), path.resolve(firstImportedPath));
  assert.equal(fs.existsSync(retryState.lastExternalAgentImport.sourcePath), false);
});

test("transfer rejects a staging path that escapes the default projects root through a symlink", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const claudeConfigDir = path.join(home, ".claude-work");
  const projectDir = path.join(claudeConfigDir, "projects", "-repo");
  const sourcePath = path.join(projectDir, "new", "session-symlink.jsonl");
  const defaultProjects = path.join(home, ".claude", "projects");
  const escapedDir = path.join(home, "escaped-staging");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.mkdirSync(defaultProjects, { recursive: true });
  fs.mkdirSync(escapedDir, { recursive: true });
  fs.symlinkSync(escapedDir, path.join(defaultProjects, "-repo"), "junction");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(sourcePath, `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Do not escape staging." } })}\n`, "utf8");

  const result = run("node", [SCRIPT, "transfer", "--json"], {
    cwd: repo,
    env: { ...buildEnv(binDir), HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: claudeConfigDir, CODEX_COMPANION_TRANSCRIPT_PATH: sourcePath }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside.*default Claude projects root|staging.*outside/i);
  assert.equal(fs.existsSync(path.join(escapedDir, "new")), false);
});

test("transfer reports an actionable upgrade error when native import is unsupported", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, "session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir, "external-import-unsupported");
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Continue this work." } })}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath, "--json"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: path.join(home, ".codex")
    }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not support Claude session transfer/);
  assert.match(result.stderr, /@openai\/codex@latest/);
});

test("transfer fails visibly when native import completes without a ledger record", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, "session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir, "external-import-fails");
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Do not lose this request." } })}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: path.join(home, ".codex")
    }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /did not record an imported thread/);
});

test("transfer rejects sources outside the Claude projects directory", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const sourcePath = path.join(home, "session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Outside source." } })}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath], {
    cwd: repo,
    env: { ...buildEnv(binDir), HOME: home, USERPROFILE: home }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only from .*\.claude.*projects/);
});

test("task reports the actual Codex auth error when the run is rejected", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "auth-run-fails");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "check failed auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /authentication expired; run codex login/);
});

test("review accepts the quoted raw argument style for built-in base-branch review", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review", "--base main"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Reviewed changes against main/);
  assert.match(result.stdout, /No material issues found/);
});

test("adversarial review renders structured findings over app-server turn/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Missing empty-state guard/);
});

test("adversarial review accepts the same base-branch targeting as review", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "adversarial-review", "--base", "main"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Branch review against main|against main/i);
  assert.match(result.stdout, /Missing empty-state guard/);
});

test("adversarial review asks Codex to inspect larger diffs itself", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(repo, "src", name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "src/a.js", "src/b.js", "src/c.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "a.js"), 'export const value = "PROMPT_SELF_COLLECT_A";\n');
  fs.writeFileSync(path.join(repo, "src", "b.js"), 'export const value = "PROMPT_SELF_COLLECT_B";\n');
  fs.writeFileSync(path.join(repo, "src", "c.js"), 'export const value = "PROMPT_SELF_COLLECT_C";\n');

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.match(state.lastTurnStart.prompt, /lightweight summary/i);
  assert.match(state.lastTurnStart.prompt, /read-only git commands/i);
  assert.doesNotMatch(state.lastTurnStart.prompt, /PROMPT_SELF_COLLECT_[ABC]/);
});

test("review includes reasoning output when the app server returns it", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reasoning:/);
  assert.match(result.stdout, /Reviewed the changed files and checked the likely regression paths first|Reviewed the changed files and checked the likely regression paths/i);
});

test("review logs reasoning summaries and review output to the job log", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Reasoning summary/);
  assert.match(log, /Reviewed the changed files and checked the likely regression paths/);
  assert.match(log, /Review output/);
  assert.match(log, /Reviewed uncommitted changes\./);
});

test("task --resume-last resumes the latest persisted task thread", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Resumed the prior run.\nFollow-up prompt accepted.\n");
});

test("task --resume-thread resumes the requested thread instead of the latest one", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  assert.equal(run("node", [SCRIPT, "task", "first task"], { cwd: repo, env: buildEnv(binDir) }).status, 0);
  assert.equal(run("node", [SCRIPT, "task", "second task"], { cwd: repo, env: buildEnv(binDir) }).status, 0);

  const result = run("node", [SCRIPT, "task", "--resume-thread", "thr_1", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  assert.equal(fakeState.lastTurnStart.prompt, "follow up");
});

test("task --resume-thread rebinds a foreign thread to the current workspace", () => {
  const repoA = makeTempDir();
  const repoB = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repoA);
  initGitRepo(repoB);

  assert.equal(run("node", [SCRIPT, "task", "first task"], { cwd: repoA, env: buildEnv(binDir) }).status, 0);
  const resumed = run("node", [SCRIPT, "task", "--resume-thread", "thr_1", "follow up"], {
    cwd: repoB,
    env: buildEnv(binDir)
  });

  assert.equal(resumed.status, 0, resumed.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(path.resolve(fakeState.threads.find((thread) => thread.id === "thr_1").cwd), path.resolve(repoB));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
});

test("task --resume-thread can continue without an explicit prompt", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  assert.equal(run("node", [SCRIPT, "task", "initial task"], { cwd: repo, env: buildEnv(binDir) }).status, 0);

  const result = run("node", [SCRIPT, "task", "--resume-thread", "thr_1"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  assert.equal(fakeState.lastTurnStart.prompt, "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.");
});
test("task --resume-thread rejects conflicting routing controls", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  const env = buildEnv(binDir);

  for (const args of [
    ["task", "--resume-thread", "thr_1", "--resume-last", "follow up"],
    ["task", "--resume-thread", "thr_1", "--fresh", "follow up"]
  ]) {
    const result = run("node", [SCRIPT, ...args], { cwd: repo, env });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Choose only one of --resume\/--resume-last, --resume-thread <id>, or --fresh/);
  }
});

test("task-resume-candidate returns the latest rescue thread from the current session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-current",
            status: "completed",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Investigate the flaky test",
            updatedAt: "2026-03-24T20:00:00.000Z"
          },
          {
            id: "task-other-session",
            status: "completed",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Old rescue run",
            updatedAt: "2026-03-24T20:05:00.000Z"
          },
          {
            id: "review-current",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-current",
            threadId: "thr_review",
            summary: "Review main...HEAD",
            updatedAt: "2026-03-24T20:10:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.available, true);
  assert.equal(payload.sessionId, "sess-current");
  assert.equal(payload.candidate.id, "task-current");
  assert.equal(payload.candidate.threadId, "thr_current");
});

test("task --resume-last does not resume a task from another Claude session", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const otherEnv = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-other"
  };
  const currentEnv = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: otherEnv
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const candidate = run("node", [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: repo,
    env: currentEnv
  });
  assert.equal(candidate.status, 0, candidate.stderr);
  assert.equal(JSON.parse(candidate.stdout).available, false);

  const resume = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env: currentEnv
  });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /No previous Codex task thread was found for this repository\./);

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  assert.equal(fakeState.lastTurnStart.prompt, "initial task");
});

test("task --resume-last ignores running tasks from other Claude sessions", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other-running",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Other session active task",
            updatedAt: "2026-03-24T20:05:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const status = run("node", [SCRIPT, "status", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).running, []);

  const resume = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env
  });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /No previous Codex task thread was found for this repository\./);
});

test("session start hook exports the Claude session id, transcript path, and plugin data dir", () => {
  const repo = makeTempDir();
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  fs.writeFileSync(envFile, "", "utf8");
  const pluginDataDir = makeTempDir();
  const transcriptPath = path.join(repo, "session.jsonl");

  const result = run("node", [SESSION_HOOK, "SessionStart"], {
    cwd: repo,
    env: {
      ...process.env,
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PLUGIN_DATA: pluginDataDir
    },
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-current",
      transcript_path: transcriptPath,
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  // Each export opens with its own newline, so a line another plugin's hook
  // appended without one cannot run into ours. Blank lines are nothing to the
  // shell that sources this file, so the contract is the exports and their
  // order, not byte-for-byte content.
  assert.deepEqual(
    fs.readFileSync(envFile, "utf8").split("\n").filter((line) => line !== ""),
    [
      "export CODEX_COMPANION_SESSION_ID='sess-current'",
      `export CODEX_COMPANION_TRANSCRIPT_PATH='${transcriptPath}'`,
      `export CLAUDE_PLUGIN_DATA='${pluginDataDir}'`
    ]
  );
});

test("write task output focuses on the Codex result without generic follow-up hints", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--write", "fix the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task --read-root sends a scoped permission profile without legacy sandbox", () => {
  const repo = makeTempDir();
  const extraReadRoot = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);

  const result = run(
    "node",
    [SCRIPT, "task", "--write", "--read-root", repo, "--read-root", extraReadRoot, "fix the test"],
    { cwd: repo, env: buildEnv(binDir) }
  );

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const params = fakeState.lastThreadStart;
  const profile = params.config.permissions.claude_companion_scoped;
  assert.equal(params.sandbox, undefined);
  assert.equal(params.config.default_permissions, "claude_companion_scoped");
  assert.equal(profile.filesystem[":root"], "deny");
  assert.equal(profile.filesystem[":minimal"], "read");
  assert.equal(profile.filesystem[":tmpdir"], "deny");
  assert.equal(profile.filesystem[":slash_tmp"], "deny");
  assert.equal(profile.filesystem[fs.realpathSync(repo)], "read");
  assert.equal(profile.filesystem[fs.realpathSync(extraReadRoot)], "read");
  assert.equal(profile.extends, ":workspace");
});

test("task --write requires the approved read scope to cover the workspace", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));

  const result = run("node", [SCRIPT, "task", "--write", "--read-root", "src", "fix"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--write requires an approved --read-root that covers the workspace/);
});

test("task --resume-last reapplies the approved read roots", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);

  const first = run("node", [SCRIPT, "task", "initial task"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(first.status, 0, first.stderr);

  const result = run("node", [SCRIPT, "task", "--resume-last", "--read-root", repo, "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastThreadResume.sandbox, undefined);
  assert.equal(fakeState.lastThreadResume.config.default_permissions, "claude_companion_scoped");
  assert.equal(
    fakeState.lastThreadResume.config.permissions.claude_companion_scoped.filesystem[fs.realpathSync(repo)],
    "read"
  );
});

test("task --read-root fails closed when permission profiles are unsupported", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "permission-profiles-unsupported");
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "task", "--read-root", repo, "inspect the file"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot enforce the requested read scope/i);
  assert.match(result.stderr, /0\.138\.0 or later/);
});

test("task --read-root rejects files and missing directories before starting Codex", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "allowed.txt"), "fixture\n");

  for (const readRoot of ["", "allowed.txt", "missing-directory"]) {
    const result = run("node", [SCRIPT, "task", "--read-root", readRoot, "inspect"], {
      cwd: repo,
      env: buildEnv(binDir)
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--read-root must name an existing directory/);
  }
});

test("task --resume acts like --resume-last without leaking the flag into the prompt", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run("node", [SCRIPT, "task", "--resume", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  assert.equal(fakeState.lastTurnStart.prompt, "follow up");
});

test("task --fresh is treated as routing control and does not leak into the prompt", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--fresh", "diagnose the flaky test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.prompt, "diagnose the flaky test");
});

test("task forwards model selection and reasoning effort to app-server turn/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--model", "spark", "--effort", "low", "diagnose the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.model, "gpt-5.3-codex-spark");
  assert.equal(fakeState.lastTurnStart.effort, "low");
});

test("task defaults to a read-only sandbox and --write selects workspace-write", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const readOnly = run("node", [SCRIPT, "task", "diagnose the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(readOnly.status, 0, readOnly.stderr);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).lastThreadStart.sandbox, "read-only");

  const write = run("node", [SCRIPT, "task", "--write", "fix the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(write.status, 0, write.stderr);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).lastThreadStart.sandbox, "workspace-write");
});

test("task --sandbox forwards the requested sandbox mode to thread/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const fullAccess = run("node", [SCRIPT, "task", "--sandbox", "danger-full-access", "run the integration tests"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(fullAccess.status, 0, fullAccess.stderr);
  let fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastThreadStart.sandbox, "danger-full-access");
  assert.equal(fakeState.lastThreadStart.approvalPolicy, "never");
  assert.equal(fakeState.lastTurnStart.prompt, "run the integration tests");

  const readOnly = run("node", [SCRIPT, "task", "--sandbox", "READ-ONLY", "review the diff"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(readOnly.status, 0, readOnly.stderr);
  fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastThreadStart.sandbox, "read-only");
});

test("task reads --sandbox only before the task text", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const mentioned = run("node", [SCRIPT, "task", "explain how --sandbox danger-full-access works in this plugin"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(mentioned.status, 0, mentioned.stderr);
  let fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastThreadStart.sandbox, "read-only");
  assert.equal(fakeState.lastTurnStart.prompt, "explain how --sandbox danger-full-access works in this plugin");

  const splitTokens = run("node", [SCRIPT, "task", "document", "why", "--sandbox", "danger-full-access", "is", "off"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(splitTokens.status, 0, splitTokens.stderr);
  fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastThreadStart.sandbox, "read-only");
  assert.equal(fakeState.lastTurnStart.prompt, "document why --sandbox danger-full-access is off");

  const leading = run("node", [SCRIPT, "task", "-m", "spark", "--sandbox=danger-full-access", "--write", "run the integration tests"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(leading.status, 0, leading.stderr);
  fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastThreadStart.sandbox, "danger-full-access");
  assert.equal(fakeState.lastTurnStart.model, "gpt-5.3-codex-spark");
  assert.equal(fakeState.lastTurnStart.prompt, "run the integration tests");

  const quoted = run("node", [SCRIPT, "task", "--sandbox read-only '{\"key\":\"value\"}'"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(quoted.status, 0, quoted.stderr);
  fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastThreadStart.sandbox, "read-only");
  assert.equal(fakeState.lastTurnStart.prompt, '{"key":"value"}');
});

test("task --sandbox rejects unknown modes and takes precedence over --write", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const unknown = run("node", [SCRIPT, "task", "--sandbox", "everything", "diagnose the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(unknown.status > 0, true);
  assert.match(unknown.stderr, /Unsupported sandbox mode "everything"/);
  assert.match(unknown.stderr, /read-only, workspace-write, danger-full-access/);

  const suffixed = run("node", [SCRIPT, "task", "--sandbox=danger-full-access=false", "diagnose the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(suffixed.status > 0, true);
  assert.match(suffixed.stderr, /Unsupported sandbox mode "danger-full-access=false"/);

  for (const argv of [["--sandbox=", "diagnose the failing test"], ["--resume", "--sandbox"]]) {
    const empty = run("node", [SCRIPT, "task", ...argv], {
      cwd: repo,
      env: buildEnv(binDir)
    });

    assert.equal(empty.status > 0, true, argv.join(" "));
    assert.match(empty.stderr, /Missing value for --sandbox/);
  }

  const malformedBoolean = run("node", [SCRIPT, "task", "--write=false=x", "fix the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(malformedBoolean.status > 0, true);
  assert.match(malformedBoolean.stderr, /Invalid value for --write: expected true or false/);

  const threads = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")).threads : [];
  assert.equal(threads.length, 0);

  const explicit = run("node", [SCRIPT, "task", "--write", "--sandbox", "read-only", "fix the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(explicit.status, 0, explicit.stderr);
  let fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastThreadStart.sandbox, "read-only");
  assert.equal(fakeState.lastTurnStart.prompt, "fix the failing test");

  const writeFalse = run("node", [SCRIPT, "task", "--write=false", "diagnose the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(writeFalse.status, 0, writeFalse.stderr);
  fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastThreadStart.sandbox, "read-only");
});

test("task --resume-last refuses a sandbox the app-server does not grant the resumed thread", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = run("node", [SCRIPT, "task", "--sandbox", "danger-full-access", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const resumedWithSandbox = run("node", [SCRIPT, "task", "--resume", "--sandbox", "danger-full-access", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(resumedWithSandbox.status, 0, resumedWithSandbox.stderr);
  let fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastThreadResume.threadId, "thr_1");
  assert.equal(fakeState.lastThreadResume.sandbox, "danger-full-access");
  assert.equal(fakeState.lastTurnStart.prompt, "follow up");

  const resumedWithoutSandbox = run("node", [SCRIPT, "task", "--resume", "keep going"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(resumedWithoutSandbox.status > 0, true);
  assert.match(resumedWithoutSandbox.stderr, /still has sandbox danger-full-access in the shared app-server/);
  assert.match(resumedWithoutSandbox.stderr, /would not run read-only/);
  assert.match(resumedWithoutSandbox.stderr, /--fresh/);
  fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastThreadResume.sandbox, "read-only");
  assert.equal(fakeState.lastTurnStart.prompt, "follow up");

  const narrowedWithWrite = run("node", [SCRIPT, "task", "--resume", "--write", "apply the fix"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(narrowedWithWrite.status > 0, true);
  assert.match(narrowedWithWrite.stderr, /would not run workspace-write/);
  fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.prompt, "follow up");
});

test("task-worker replays a stored request without a sandbox field using the --write mapping", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const jobsDir = path.join(resolveStateDir(repo), "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const jobId = "task-legacy";
  fs.writeFileSync(
    path.join(jobsDir, `${jobId}.json`),
    `${JSON.stringify(
      {
        id: jobId,
        kind: "task",
        kindLabel: "task",
        status: "queued",
        phase: "queued",
        title: "Codex Task",
        jobClass: "task",
        summary: "fix the failing test",
        workspaceRoot: repo,
        write: true,
        createdAt: "2026-03-18T15:30:00.000Z",
        updatedAt: "2026-03-18T15:30:00.000Z",
        request: {
          cwd: repo,
          model: null,
          effort: null,
          prompt: "fix the failing test",
          write: true,
          resumeLast: false,
          jobId
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "task-worker", "--cwd", repo, "--job-id", jobId], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastThreadStart.sandbox, "workspace-write");
  assert.equal(fakeState.lastTurnStart.prompt, "fix the failing test");
});

test("task --resume-last refuses a resume when the app-server reports a sandbox policy it cannot compare", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "external-sandbox");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const resumed = run("node", [SCRIPT, "task", "--resume", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(resumed.status > 0, true);
  assert.match(resumed.stderr, /sandbox policy \(externalSandbox\) this plugin cannot compare with the requested read-only/);
  assert.match(resumed.stderr, /--fresh/);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastThreadResume.threadId, "thr_1");
  assert.equal(fakeState.lastTurnStart.prompt, "initial task");
});

test("task --background stores the sandbox in the job request so the detached worker reuses it", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const launched = run(
    "node",
    [SCRIPT, "task", "--background", "--json", "--sandbox", "danger-full-access", "run the integration tests"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.status, "queued");

  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  assert.equal(JSON.parse(waitedStatus.stdout).job.status, "completed");

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastThreadStart.sandbox, "danger-full-access");

  const resultPayload = await waitFor(() => {
    const result = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], {
      cwd: repo,
      env: buildEnv(binDir)
    });
    if (result.status !== 0) {
      return null;
    }
    return JSON.parse(result.stdout);
  });

  assert.equal(resultPayload.storedJob.request.sandbox, "danger-full-access");
  assert.equal(resultPayload.storedJob.request.write, true);
});

test("task logs reasoning summaries and assistant messages to the job log", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "investigate the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Reasoning summary/);
  assert.match(log, /Inspected the prompt, gathered evidence, and checked the highest-risk paths first/);
  assert.match(log, /Assistant message/);
  assert.match(log, /Handled the requested task/);
});

test("task logs subagent reasoning and messages with a subagent prefix", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Starting subagent design-challenger via collaboration tool: wait\./);
  assert.match(log, /Subagent design-challenger reasoning:/);
  assert.match(log, /Questioned the retry strategy and the cache invalidation boundaries\./);
  assert.match(log, /Subagent design-challenger:/);
  assert.match(
    log,
    /The design assumes retries are harmless, but they can duplicate side effects without stronger idempotency guarantees\./
  );
});

test("task waits for the main thread to complete before returning the final result", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task ignores later subagent messages when choosing the final returned output", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-late-subagent-message");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task can finish after subagent work even if the parent turn/completed event is missing", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent-no-main-turn-completed");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task completes when the app server exits right after the final answer", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "final-answer-then-exit");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  // The connection closes cleanly before the inferred-completion timer fires;
  // the already-delivered final answer must win over the transport loss.
  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task using the shared broker still completes when Codex spawns subagents", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);
  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  if (!loadBrokerSession(repo)) {
    return;
  }

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task --background enqueues a detached worker and exposes per-job status", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.status, "queued");
  assert.match(launchPayload.jobId, /^task-/);

  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  assert.equal(waitedPayload.job.id, launchPayload.jobId);
  assert.equal(waitedPayload.job.status, "completed");

  const resultPayload = await waitFor(() => {
    const result = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], {
      cwd: repo,
      env: buildEnv(binDir)
    });
    if (result.status !== 0) {
      return null;
    }
    return JSON.parse(result.stdout);
  });

  assert.equal(resultPayload.job.id, launchPayload.jobId);
  assert.equal(resultPayload.job.status, "completed");
  assert.match(resultPayload.storedJob.rendered, /Handled the requested task/);
});

test("task --background preserves an explicit resume thread", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  const env = buildEnv(binDir);

  assert.equal(run("node", [SCRIPT, "task", "first task"], { cwd: repo, env }).status, 0);
  assert.equal(run("node", [SCRIPT, "task", "second task"], { cwd: repo, env }).status, 0);

  const launched = run(
    "node",
    [SCRIPT, "task", "--background", "--json", "--resume-thread", "thr_1", "follow up"],
    { cwd: repo, env }
  );
  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  const waited = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"],
    { cwd: repo, env }
  );
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).job.status, "completed");

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  assert.equal(fakeState.lastTurnStart.prompt, "follow up");
});

test("task --background preserves read roots for the detached worker", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "--read-root", repo, "inspect"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const waited = run("node", [SCRIPT, "status", jobId, "--wait", "--timeout-ms", "15000", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(waited.status, 0, waited.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastThreadStart.sandbox, undefined);
  assert.equal(fakeState.lastThreadStart.config.default_permissions, "claude_companion_scoped");
});

test("review rejects focus text because it is native-review only", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review", "--scope working-tree focus on auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /does not support custom focus text/i);
  assert.match(result.stderr, /\/codex:adversarial-review focus on auth/i);
});

test("review rejects staged-only scope because it is native-review only", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  run("git", ["add", "README.md"], { cwd: repo });

  const result = run("node", [SCRIPT, "review", "--scope", "staged"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /Unsupported review scope "staged"/i);
  assert.match(result.stderr, /Use one of: auto, working-tree, branch, or pass --base <ref>/i);
});

test("adversarial review rejects staged-only scope to match review target selection", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  run("git", ["add", "README.md"], { cwd: repo });

  const result = run("node", [SCRIPT, "adversarial-review", "--scope", "staged"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /Unsupported review scope "staged"/i);
  assert.match(result.stderr, /Use one of: auto, working-tree, branch, or pass --base <ref>/i);
});

test("review accepts --background while still running as a tracked review job", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const launched = run("node", [SCRIPT, "review", "--background", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.review, "Review");
  assert.match(launchPayload.codex.stdout, /No material issues found/);

  const status = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /# Codex Status/);
  assert.match(status.stdout, /Codex Review/);
  assert.match(status.stdout, /completed/);
});

test("status shows phases, hints, and the latest finished job", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "review-live.log");
  fs.writeFileSync(
    logFile,
    [
      "[2026-03-18T15:30:00.000Z] Starting Codex Review.",
      "[2026-03-18T15:30:01.000Z] Thread ready (thr_1).",
      "[2026-03-18T15:30:02.000Z] Turn started (turn_1).",
      "[2026-03-18T15:30:03.000Z] Reviewer started: current changes"
    ].join("\n"),
    "utf8"
  );

  const finishedJobFile = path.join(jobsDir, "review-done.json");
  fs.writeFileSync(
    finishedJobFile,
    JSON.stringify(
      {
        id: "review-done",
        status: "completed",
        title: "Codex Review",
        rendered: "# Codex Review\n\nReviewed uncommitted changes.\nNo material issues found.\n"
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-live",
            kind: "review",
            kindLabel: "review",
            status: "running",
            title: "Codex Review",
            jobClass: "review",
            phase: "reviewing",
            threadId: "thr_1",
            summary: "Review working tree diff",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:03.000Z"
          },
          {
            id: "review-done",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            threadId: "thr_done",
            summary: "Review main...HEAD",
            createdAt: "2026-03-18T15:10:00.000Z",
            startedAt: "2026-03-18T15:10:05.000Z",
            completedAt: "2026-03-18T15:11:10.000Z",
            updatedAt: "2026-03-18T15:11:10.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Active jobs:/);
  assert.match(result.stdout, /\| Job \| Kind \| Status \| Phase \| Elapsed \| Codex Session ID \| Summary \| Actions \|/);
  assert.match(result.stdout, /\| review-live \| review \| running \| reviewing \| .* \| thr_1 \| Review working tree diff \|/);
  assert.match(result.stdout, /`\/codex:status review-live`<br>`\/codex:cancel review-live`/);
  assert.match(result.stdout, /Live details:/);
  assert.match(result.stdout, /Latest finished:/);
  assert.match(result.stdout, /Progress:/);
  assert.match(result.stdout, /Session runtime: direct startup/);
  assert.match(result.stdout, /Phase: reviewing/);
  assert.match(result.stdout, /Codex session ID: thr_1/);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_1/);
  assert.match(result.stdout, /Thread ready \(thr_1\)\./);
  assert.match(result.stdout, /Reviewer started: current changes/);
  assert.match(result.stdout, /Duration: 1m 5s/);
  assert.match(result.stdout, /Codex session ID: thr_done/);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_done/);
});

test("status without a job id only shows jobs from the current Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const currentLog = path.join(jobsDir, "review-current.log");
  const otherLog = path.join(jobsDir, "review-other.log");
  fs.writeFileSync(currentLog, "[2026-03-18T15:30:00.000Z] Reviewer started: current changes\n", "utf8");
  fs.writeFileSync(otherLog, "[2026-03-18T15:31:00.000Z] Reviewer started: old changes\n", "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-current",
            kind: "review",
            kindLabel: "review",
            status: "running",
            title: "Codex Review",
            jobClass: "review",
            phase: "reviewing",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Current session review",
            logFile: currentLog,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:00.000Z"
          },
          {
            id: "review-other",
            kind: "review",
            kindLabel: "review",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Previous session review",
            createdAt: "2026-03-18T15:20:00.000Z",
            startedAt: "2026-03-18T15:20:05.000Z",
            completedAt: "2026-03-18T15:21:00.000Z",
            updatedAt: "2026-03-18T15:21:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    [...new Set(result.stdout.match(/review-(?:current|other)/g) ?? [])],
    ["review-current"]
  );
});

test("status preserves adversarial review kind labels", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "review-adv.log");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Reviewer started: adversarial review\n", "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-adv-live",
            kind: "adversarial-review",
            status: "running",
            title: "Codex Adversarial Review",
            jobClass: "review",
            phase: "reviewing",
            threadId: "thr_adv_live",
            summary: "Adversarial review current changes",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:00.000Z"
          },
          {
            id: "review-adv",
            kind: "adversarial-review",
            status: "completed",
            title: "Codex Adversarial Review",
            jobClass: "review",
            threadId: "thr_adv_done",
            summary: "Adversarial review working tree diff",
            createdAt: "2026-03-18T15:10:00.000Z",
            startedAt: "2026-03-18T15:10:05.000Z",
            completedAt: "2026-03-18T15:11:10.000Z",
            updatedAt: "2026-03-18T15:11:10.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| review-adv-live \| adversarial-review \| running \| reviewing \|/);
  assert.match(result.stdout, /- review-adv \| completed \| adversarial-review \| Codex Adversarial Review/);
  assert.match(result.stdout, /Codex session ID: thr_adv_live/);
  assert.match(result.stdout, /Codex session ID: thr_adv_done/);
});

test("status --wait times out cleanly when a job is still active", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-live.log");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Codex Task.\n", "utf8");
  fs.writeFileSync(
    path.join(jobsDir, "task-live.json"),
    JSON.stringify(
      {
        id: "task-live",
        status: "running",
        title: "Codex Task",
        logFile
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-live",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            summary: "Investigate flaky test",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            startedAt: "2026-03-18T15:30:01.000Z",
            updatedAt: "2026-03-18T15:30:02.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status", "task-live", "--wait", "--timeout-ms", "25", "--json"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.job.id, "task-live");
  assert.equal(payload.job.status, "running");
  assert.equal(payload.waitTimedOut, true);
});

test("result returns the stored output for the latest finished job by default", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(jobsDir, "review-finished.json"),
    JSON.stringify(
      {
        id: "review-finished",
        status: "completed",
        title: "Codex Review",
        rendered: "# Codex Review\n\nReviewed uncommitted changes.\nNo material issues found.\n",
        result: {
          codex: {
            stdout: "Reviewed uncommitted changes.\nNo material issues found."
          }
        },
        threadId: "thr_review_finished"
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-finished",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            threadId: "thr_review_finished",
            summary: "Review working tree diff",
            createdAt: "2026-03-18T15:00:00.000Z",
            updatedAt: "2026-03-18T15:01:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "result"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "Reviewed uncommitted changes.\nNo material issues found.\n\nCodex session ID: thr_review_finished\nResume in Codex: codex resume thr_review_finished\n"
  );
});

test("result without a job id prefers the latest finished job from the current Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(jobsDir, "review-current.json"),
    JSON.stringify(
      {
        id: "review-current",
        status: "completed",
        title: "Codex Review",
        threadId: "thr_current",
        result: {
          codex: {
            stdout: "Current session output."
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(jobsDir, "review-other.json"),
    JSON.stringify(
      {
        id: "review-other",
        status: "completed",
        title: "Codex Review",
        threadId: "thr_other",
        result: {
          codex: {
            stdout: "Old session output."
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-current",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Current session review",
            createdAt: "2026-03-18T15:10:00.000Z",
            updatedAt: "2026-03-18T15:11:00.000Z"
          },
          {
            id: "review-other",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Old session review",
            createdAt: "2026-03-18T15:20:00.000Z",
            updatedAt: "2026-03-18T15:21:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "result"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "Current session output.\n\nCodex session ID: thr_current\nResume in Codex: codex resume thr_current\n"
  );
});

test("result for a finished write-capable task returns the raw Codex final response", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const taskRun = run("node", [SCRIPT, "task", "--write", "fix the flaky integration test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(taskRun.status, 0, taskRun.stderr);

  const result = run("node", [SCRIPT, "result"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Handled the requested task\.\nTask prompt accepted\.\n/);
  assert.match(result.stdout, /Codex session ID: thr_[a-z0-9]+/i);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_[a-z0-9]+/i);
});

test("cancel stops an active background job and marks it cancelled", async (t) => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: workspace,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  const logFile = path.join(jobsDir, "task-live.log");
  const jobFile = path.join(jobsDir, "task-live.json");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Codex Task.\n", "utf8");
  fs.writeFileSync(
    jobFile,
    JSON.stringify(
      {
        id: "task-live",
        status: "running",
        title: "Codex Task",
        logFile
      },
      null,
      2
    ),
    "utf8"
  );
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-live",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            summary: "Investigate flaky test",
            pid: sleeper.pid,
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            startedAt: "2026-03-18T15:30:01.000Z",
            updatedAt: "2026-03-18T15:30:02.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const cancelResult = run("node", [SCRIPT, "cancel", "task-live", "--json"], {
    cwd: workspace
  });

  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  assert.equal(JSON.parse(cancelResult.stdout).status, "cancelled");

  await waitFor(() => {
    try {
      process.kill(sleeper.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const cancelled = state.jobs.find((job) => job.id === "task-live");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.pid, null);

  const stored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(stored.status, "cancelled");
  assert.match(fs.readFileSync(logFile, "utf8"), /Cancelled by user/);
});

test("cancel without a job id ignores active jobs from other Claude sessions", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-other.log");
  fs.writeFileSync(logFile, "", "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            summary: "Other session run",
            updatedAt: "2026-03-24T20:05:00.000Z",
            logFile
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const status = run("node", [SCRIPT, "status", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).running, []);

  const cancel = run("node", [SCRIPT, "cancel", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(cancel.status, 1);
  assert.match(cancel.stderr, /No active Codex jobs to cancel for this session\./);

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "running");
});

test("cancel with a job id can still target an active job from another Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-other.log");
  fs.writeFileSync(logFile, "", "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            summary: "Other session run",
            updatedAt: "2026-03-24T20:05:00.000Z",
            logFile
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const cancel = run("node", [SCRIPT, "cancel", "task-other", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.equal(JSON.parse(cancel.stdout).jobId, "task-other");

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "cancelled");
});

test("cancel sends turn interrupt to the shared app-server before killing a brokered task", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "interruptible-slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = buildEnv(binDir);
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the flaky worker timeout"], {
    cwd: repo,
    env
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  const jobId = launchPayload.jobId;
  assert.ok(jobId);

  const stateDir = resolveStateDir(repo);
  const runningJob = await waitFor(() => {
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (job?.status === "running" && job.threadId && job.turnId) {
      return job;
    }
    return null;
  }, { timeoutMs: 15000 });

  const cancelResult = run("node", [SCRIPT, "cancel", jobId, "--json"], {
    cwd: repo,
    env
  });

  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  const cancelPayload = JSON.parse(cancelResult.stdout);
  assert.equal(cancelPayload.status, "cancelled");
  assert.equal(cancelPayload.turnInterruptAttempted, true);
  assert.equal(cancelPayload.turnInterrupted, true);

  await waitFor(() => {
    const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    return fakeState.lastInterrupt ?? null;
  });

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.deepEqual(fakeState.lastInterrupt, {
    threadId: runningJob.threadId,
    turnId: runningJob.turnId
  });

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("session end interrupts a brokered turn before killing its worker", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "interruptible-slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = { ...buildEnv(binDir), CODEX_COMPANION_SESSION_ID: "sess-ending" };
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the flaky worker timeout"], {
    cwd: repo,
    env
  });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  assert.ok(jobId);

  const stateDir = resolveStateDir(repo);
  const statePath = path.join(stateDir, "state.json");
  const runningJob = await waitFor(() => {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (job?.status === "running" && job.threadId && job.turnId) {
      return job;
    }
    return null;
  }, { timeoutMs: 15000 });

  if (!loadBrokerSession(repo)) {
    run("node", [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
    return;
  }

  // Pin the broker with another session's live job: the ending session's
  // cleanup is then the only thing that can stop its own turn.
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  t.after(() => {
    try {
      process.kill(sleeper.pid, "SIGTERM");
    } catch {
      // Ignore missing process.
    }
  });

  const pinnedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  pinnedState.jobs.push({
    id: "task-other-session",
    status: "running",
    title: "Codex Task",
    sessionId: "sess-other",
    pid: sleeper.pid,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  fs.writeFileSync(statePath, `${JSON.stringify(pinnedState, null, 2)}\n`, "utf8");

  const sessionEnd = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-ending",
      cwd: repo
    })
  });
  assert.equal(sessionEnd.status, 0, sessionEnd.stderr);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.deepEqual(
    fakeState.lastInterrupt,
    {
      threadId: runningJob.threadId,
      turnId: runningJob.turnId
    },
    "session end must interrupt the brokered turn, not just kill the relay worker"
  );

  const afterState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const cancelledJob = afterState.jobs.find((candidate) => candidate.id === jobId);
  assert.equal(cancelledJob.status, "cancelled");

  assert.ok(loadBrokerSession(repo), "the broker must survive for the other session");

  // Tear the shared broker down for cleanup.
  fs.writeFileSync(
    statePath,
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [] }, null, 2)}\n`,
    "utf8"
  );
  const finalEnd = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-other",
      cwd: repo
    })
  });
  assert.equal(finalEnd.status, 0, finalEnd.stderr);
  assert.equal(loadBrokerSession(repo), null);
});

test("session end removes finished jobs and records a terminal state for running ones", async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const completedLog = path.join(jobsDir, "completed.log");
  const runningLog = path.join(jobsDir, "running.log");
  const otherSessionLog = path.join(jobsDir, "other.log");
  const completedJobFile = path.join(jobsDir, "review-completed.json");
  const runningJobFile = path.join(jobsDir, "review-running.json");
  const otherJobFile = path.join(jobsDir, "review-other.json");
  fs.writeFileSync(completedLog, "completed\n", "utf8");
  fs.writeFileSync(runningLog, "running\n", "utf8");
  fs.writeFileSync(otherSessionLog, "other\n", "utf8");
  fs.writeFileSync(completedJobFile, JSON.stringify({ id: "review-completed" }, null, 2), "utf8");
  fs.writeFileSync(otherJobFile, JSON.stringify({ id: "review-other" }, null, 2), "utf8");

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  fs.writeFileSync(runningJobFile, JSON.stringify({ id: "review-running" }, null, 2), "utf8");

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-completed",
            status: "completed",
            title: "Codex Review",
            sessionId: "sess-current",
            logFile: completedLog,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:31:00.000Z"
          },
          {
            id: "review-running",
            status: "running",
            title: "Codex Review",
            sessionId: "sess-current",
            pid: sleeper.pid,
            logFile: runningLog,
            createdAt: "2026-03-18T15:32:00.000Z",
            updatedAt: "2026-03-18T15:33:00.000Z"
          },
          {
            id: "review-other",
            status: "completed",
            title: "Codex Review",
            sessionId: "sess-other",
            logFile: otherSessionLog,
            createdAt: "2026-03-18T15:34:00.000Z",
            updatedAt: "2026-03-18T15:35:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-current",
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(otherSessionLog), true);
  assert.equal(fs.existsSync(otherJobFile), true);
  assert.equal(fs.existsSync(completedLog), false);
  assert.equal(fs.existsSync(completedJobFile), false);

  await waitFor(() => {
    try {
      process.kill(sleeper.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.deepEqual(state.jobs.map((job) => job.id).sort(), ["review-other", "review-running"]);

  const cancelledJob = state.jobs.find((job) => job.id === "review-running");
  assert.equal(cancelledJob.status, "cancelled");
  assert.equal(cancelledJob.pid, null);
  assert.ok(cancelledJob.completedAt);
  assert.match(cancelledJob.errorMessage, /session ended/i);
  assert.equal(fs.existsSync(runningLog), true);
  const storedCancelled = JSON.parse(fs.readFileSync(runningJobFile, "utf8"));
  assert.equal(storedCancelled.status, "cancelled");

  const otherJob = state.jobs.find((job) => job.id === "review-other");
  assert.equal(otherJob.logFile, otherSessionLog);
});

test("session end reports the underlying cleanup failure", (t) => {
  const repo = makeTempDir();
  const brokerStateFile = path.join(resolveStateDir(repo), "broker.json");
  t.after(() => fs.rmSync(brokerStateFile, { force: true }));
  saveBrokerSession(repo, {
    endpoint: "unsupported:broker",
    pid: process.pid,
    pidFile: null,
    logFile: null,
    sessionDir: null,
    instanceToken: "instance-token-1234567890"
  });

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported broker endpoint: unsupported:broker/);
});

test("session end leaves a job intact when its worker already claimed the terminal status", () => {
  const repo = makeTempDir();
  initGitRepo(repo);

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const jobId = "task-finishing";
  const jobFile = path.join(jobsDir, `${jobId}.json`);
  const logFile = path.join(jobsDir, `${jobId}.log`);
  const claimFile = path.join(jobsDir, `${jobId}.terminal`);
  fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "running" }, null, 2), "utf8");
  fs.writeFileSync(logFile, "running\n", "utf8");
  // The worker has just won the terminal claim and is mid-way through
  // writing its completed record; the claimant must be a live pid, or the
  // hook would rightly adopt the claim as orphaned.
  fs.writeFileSync(claimFile, `${process.pid} worker\n`, "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: jobId,
            status: "running",
            title: "Codex Task",
            sessionId: "sess-current",
            logFile,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-current",
      cwd: repo
    })
  });
  assert.equal(result.status, 0, result.stderr);

  // The job must not be cancelled, dropped, or have its files deleted out
  // from under the live worker that is finishing it.
  assert.equal(fs.existsSync(jobFile), true);
  assert.equal(fs.existsSync(logFile), true);
  assert.equal(fs.existsSync(claimFile), true);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const job = state.jobs.find((candidate) => candidate.id === jobId);
  assert.equal(job?.status, "running");
});

test("broker refuses shutdown while another connection is mid-turn", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "interruptible-slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);
  const review = run("node", [SCRIPT, "review"], { cwd: repo, env });
  assert.equal(review.status, 0, review.stderr);

  const brokerSession = loadBrokerSession(repo);
  if (!brokerSession) {
    return;
  }
  t.after(() => {
    const surviving = loadBrokerSession(repo);
    if (surviving?.pid) {
      try {
        process.kill(surviving.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  // Start a turn directly on the broker, simulating a job admitted after a
  // session-end guard check: the turn stays in flight for several seconds.
  const client = await CodexAppServerClient.connect(repo, { brokerEndpoint: brokerSession.endpoint });
  const thread = await client.request("thread/start", { cwd: repo });
  const turn = await client.request("turn/start", {
    threadId: thread.thread.id,
    input: [{ type: "text", text: "investigate the flaky worker timeout" }]
  });

  // A session end racing that admission must not kill the in-flight turn.
  const sessionEnd = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-ending",
      cwd: repo
    })
  });
  assert.equal(sessionEnd.status, 0, sessionEnd.stderr);

  const surviving = loadBrokerSession(repo);
  assert.ok(surviving, "broker session record must survive a shutdown raced by a live turn");
  assert.doesNotThrow(() => process.kill(surviving.pid, 0), "broker process must still be alive");

  // Finish the turn. Even between requests (no active turn), a connected
  // client must keep refusing shutdown — the serialization variables being
  // momentarily clear is not the same as no client being admitted.
  await client.request("turn/interrupt", { threadId: thread.thread.id, turnId: turn.turn.id });

  const idleEnd = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-ending",
      cwd: repo
    })
  });
  assert.equal(idleEnd.status, 0, idleEnd.stderr);
  assert.ok(loadBrokerSession(repo), "an idle but connected client must still block shutdown");

  await client.close();

  const finalEnd = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-ending",
      cwd: repo
    })
  });
  assert.equal(finalEnd.status, 0, finalEnd.stderr);
  assert.equal(loadBrokerSession(repo), null);
});

test("session end escalates so its own dying worker cannot veto teardown", async (t) => {
  if (process.platform === "win32") {
    return;
  }
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);
  const review = run("node", [SCRIPT, "review"], { cwd: repo, env });
  assert.equal(review.status, 0, review.stderr);

  const brokerSession = loadBrokerSession(repo);
  if (!brokerSession) {
    return;
  }
  const socketPath = brokerSession.endpoint.replace(/^unix:/, "");

  // A worker that ignores SIGTERM while holding a live broker connection:
  // its lingering socket must not make the broker refuse the shutdown that
  // follows the session's own cleanup.
  const stubborn = spawn(
    process.execPath,
    [
      "-e",
      `const net = require("node:net"); process.on("SIGTERM", () => {}); net.createConnection({ path: ${JSON.stringify(socketPath)} }); setInterval(() => {}, 1000);`
    ],
    { cwd: repo, detached: true, stdio: "ignore" }
  );
  stubborn.unref();
  t.after(() => {
    try {
      process.kill(-stubborn.pid, "SIGKILL");
    } catch {
      try {
        process.kill(stubborn.pid, "SIGKILL");
      } catch {
        // Ignore missing process.
      }
    }
    const surviving = loadBrokerSession(repo);
    if (surviving?.pid) {
      try {
        process.kill(surviving.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });
  // Give the stubborn worker a beat to connect to the broker.
  await new Promise((resolve) => setTimeout(resolve, 500));

  const stateDir = resolveStateDir(repo);
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-stubborn",
            status: "running",
            title: "Codex Task",
            sessionId: "sess-current",
            pid: stubborn.pid,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-current",
      cwd: repo
    })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(loadBrokerSession(repo), null, "the dying worker must not veto the final teardown");
});

test("session end escalates a wedged finalizer so it cannot veto teardown", async (t) => {
  if (process.platform === "win32") {
    return;
  }
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);
  const review = run("node", [SCRIPT, "review"], { cwd: repo, env });
  assert.equal(review.status, 0, review.stderr);

  const brokerSession = loadBrokerSession(repo);
  if (!brokerSession) {
    return;
  }
  const socketPath = brokerSession.endpoint.replace(/^unix:/, "");

  // A worker that claimed its own terminal status (live finalizer) but then
  // wedged: ignores SIGTERM and holds a broker connection. The last session
  // out must still be able to tear the broker down.
  const wedged = spawn(
    process.execPath,
    [
      "-e",
      `const net = require("node:net"); process.on("SIGTERM", () => {}); net.createConnection({ path: ${JSON.stringify(socketPath)} }); setInterval(() => {}, 1000);`
    ],
    { cwd: repo, detached: true, stdio: "ignore" }
  );
  wedged.unref();
  t.after(() => {
    try {
      process.kill(-wedged.pid, "SIGKILL");
    } catch {
      try {
        process.kill(wedged.pid, "SIGKILL");
      } catch {
        // Ignore missing process.
      }
    }
    const surviving = loadBrokerSession(repo);
    if (surviving?.pid) {
      try {
        process.kill(surviving.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 500));

  const stateDir = resolveStateDir(repo);
  const jobId = "task-wedged-finalizer";
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "jobs", `${jobId}.json`),
    JSON.stringify({ id: jobId, status: "running", pid: wedged.pid }, null, 2),
    "utf8"
  );
  fs.writeFileSync(path.join(stateDir, "jobs", `${jobId}.terminal`), `${wedged.pid} worker\n`, "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: jobId,
            status: "running",
            title: "Codex Task",
            sessionId: "sess-current",
            pid: wedged.pid,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-current",
      cwd: repo
    })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(loadBrokerSession(repo), null, "a wedged finalizer must not veto the final teardown");

  // The force-killed finalizer's repaired record must be retained, not
  // erased as an ordinary finished job.
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const repaired = state.jobs.find((candidate) => candidate.id === jobId);
  assert.equal(repaired?.status, "failed", "the forced-kill outcome must stay visible");
});

test("session end kills a worker whose pid lives only in the job file", async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);

  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  t.after(() => {
    try {
      process.kill(sleeper.pid, "SIGTERM");
    } catch {
      // Ignore missing process.
    }
  });

  const jobId = "task-pid-in-file-only";
  // Record-before-spawn: the state index still has the queued pid: null
  // snapshot, while the worker has since written its real pid to the job
  // file. The terminal patch must not destroy that only copy before the
  // kill reads it.
  fs.writeFileSync(
    path.join(stateDir, "jobs", `${jobId}.json`),
    JSON.stringify({ id: jobId, status: "running", pid: sleeper.pid }, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: jobId,
            status: "queued",
            title: "Codex Task",
            sessionId: "sess-current",
            pid: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-current",
      cwd: repo
    })
  });
  assert.equal(result.status, 0, result.stderr);

  await waitFor(() => {
    try {
      process.kill(sleeper.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs.find((candidate) => candidate.id === jobId)?.status, "cancelled");
});

test("session end repairs a finalizer that dies during the grace wait", async (t) => {
  if (process.platform === "win32") {
    return;
  }
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);
  const review = run("node", [SCRIPT, "review"], { cwd: repo, env });
  assert.equal(review.status, 0, review.stderr);
  if (!loadBrokerSession(repo)) {
    return;
  }
  t.after(() => {
    const surviving = loadBrokerSession(repo);
    if (surviving?.pid) {
      try {
        process.kill(surviving.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  // A finalizer that dies on its own ~500ms in — during the hook's grace
  // wait — without ever writing its terminal record.
  const dying = spawn(
    process.execPath,
    ["-e", "setTimeout(() => process.exit(0), 500); setInterval(() => {}, 100);"],
    { cwd: repo, detached: true, stdio: "ignore" }
  );
  dying.unref();

  const stateDir = resolveStateDir(repo);
  const jobId = "task-dying-finalizer";
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "jobs", `${jobId}.json`),
    JSON.stringify({ id: jobId, status: "running", pid: dying.pid }, null, 2),
    "utf8"
  );
  fs.writeFileSync(path.join(stateDir, "jobs", `${jobId}.terminal`), `${dying.pid} worker\n`, "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: jobId,
            status: "running",
            title: "Codex Task",
            sessionId: "sess-current",
            pid: dying.pid,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-current",
      cwd: repo
    })
  });
  assert.equal(result.status, 0, result.stderr);

  // Whether the hook saw the finalizer alive (grace-wait death) or already
  // dead (orphan adoption), the record must end terminal and retained.
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs.find((candidate) => candidate.id === jobId)?.status, "failed");
  assert.equal(loadBrokerSession(repo), null);
});

test("racing shutdown requesters do not deadlock an idle broker", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);
  const review = run("node", [SCRIPT, "review"], { cwd: repo, env });
  assert.equal(review.status, 0, review.stderr);

  const brokerSession = loadBrokerSession(repo);
  if (!brokerSession) {
    return;
  }
  t.after(() => {
    if (brokerSession.pid) {
      try {
        process.kill(brokerSession.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  // Two session-end hooks racing after all jobs are done: each holds a
  // shutdown connection. They must not refuse each other into a deadlock
  // that leaks the idle broker.
  const clientA = await CodexAppServerClient.connect(repo, { brokerEndpoint: brokerSession.endpoint });
  const clientB = await CodexAppServerClient.connect(repo, { brokerEndpoint: brokerSession.endpoint });

  // B is refused: A is connected and not yet known to be a peer shutdown.
  await assert.rejects(
    clientB.request("broker/shutdown", { instanceToken: brokerSession.instanceToken }),
    /busy/i
  );

  // A must now succeed: B is a marked peer shutdown requester, not work.
  await clientA.request("broker/shutdown", { instanceToken: brokerSession.instanceToken });
  await clientA.close().catch(() => {});
  await clientB.close().catch(() => {});

  // Assert the shutdown's observable filesystem effect rather than pid
  // liveness: in a container without an init reaper the exited detached
  // broker lingers as a zombie and kill(pid, 0) keeps succeeding. Windows
  // pipes are never unlinked, so fall back to the pid probe there.
  if (process.platform === "win32") {
    await waitFor(() => {
      try {
        process.kill(brokerSession.pid, 0);
        return false;
      } catch (error) {
        return error?.code === "ESRCH";
      }
    }, { timeoutMs: 10000 });
  } else {
    const socketPath = brokerSession.endpoint.replace(/^unix:/, "");
    await waitFor(() => !fs.existsSync(socketPath), { timeoutMs: 10000 });
  }
});

test("session end never expires a live worker by record age", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);
  const review = run("node", [SCRIPT, "review"], { cwd: repo, env });
  assert.equal(review.status, 0, review.stderr);

  if (!loadBrokerSession(repo)) {
    return;
  }

  // Task runtime is unbounded and updatedAt is not a heartbeat: a worker
  // that is demonstrably alive must pin the broker however old its record.
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  t.after(() => {
    try {
      process.kill(sleeper.pid, "SIGTERM");
    } catch {
      // Ignore missing process.
    }
    const surviving = loadBrokerSession(repo);
    if (surviving?.pid) {
      try {
        process.kill(surviving.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  const staleTimestamp = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const stateDir = resolveStateDir(repo);
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-long-running",
            status: "running",
            title: "Codex Task",
            sessionId: "sess-other",
            pid: sleeper.pid,
            createdAt: staleTimestamp,
            updatedAt: staleTimestamp
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-current",
      cwd: repo
    })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(loadBrokerSession(repo), "a live worker must pin the broker regardless of record age");
});

test("session end completes and tears down even when a turn interrupt hangs", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "interrupt-hang");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = { ...buildEnv(binDir), CODEX_COMPANION_SESSION_ID: "sess-hang" };
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the flaky worker timeout"], {
    cwd: repo,
    env
  });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;

  const stateDir = resolveStateDir(repo);
  const statePath = path.join(stateDir, "state.json");
  await waitFor(() => {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    return job?.status === "running" && job.threadId && job.turnId ? job : null;
  }, { timeoutMs: 15000 });

  if (!loadBrokerSession(repo)) {
    run("node", [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
    return;
  }
  t.after(() => {
    const surviving = loadBrokerSession(repo);
    if (surviving?.pid) {
      try {
        process.kill(surviving.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  // The fake app-server never answers turn/interrupt. The hook must time the
  // interrupt out, tear its own connection down (so the abandoned request
  // neither blocks broker/shutdown nor keeps the hook process alive), kill
  // the worker, record the cancellation, and still tear the broker down.
  const sessionEnd = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-hang",
      cwd: repo
    })
  });
  assert.equal(sessionEnd.status, 0, sessionEnd.stderr);

  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.jobs.find((candidate) => candidate.id === jobId)?.status, "cancelled");
  assert.equal(loadBrokerSession(repo), null, "the broker must still be torn down after a hung interrupt");
});

test("session end keeps a terminal record for the ending session's dead worker", () => {
  const repo = makeTempDir();
  initGitRepo(repo);

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const deadWorker = run(process.execPath, ["-e", ""], { cwd: repo });
  assert.equal(deadWorker.status, 0);

  const jobId = "task-own-dead";
  const jobFile = path.join(jobsDir, `${jobId}.json`);
  fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "running", pid: deadWorker.pid }, null, 2), "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: jobId,
            status: "running",
            title: "Codex Task",
            sessionId: "sess-current",
            pid: deadWorker.pid,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-current",
      cwd: repo
    })
  });
  assert.equal(result.status, 0, result.stderr);

  // The ending session's dead-worker job must keep a terminal record and its
  // job file — not be reaped to failed and then erased as an old terminal
  // job, which would recreate the "No job found" outcome.
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const retained = state.jobs.find((candidate) => candidate.id === jobId);
  assert.equal(retained?.status, "cancelled");
  assert.equal(fs.existsSync(jobFile), true);
});

test("session end kills a worker whose pid was published only after the terminal claim", async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const jobId = "task-late-pid";
  const jobFile = path.join(jobsDir, `${jobId}.json`);
  const claimFile = path.join(jobsDir, `${jobId}.terminal`);

  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000);"], {
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGKILL");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGKILL");
      } catch {
        // Ignore missing process.
      }
    }
  });

  // Record-before-spawn: the stores know the job but not the worker's pid yet.
  fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "running", pid: null }, null, 2), "utf8");

  // The worker publishes its pid only after the hook wins the terminal claim
  // (the claim file is the observable boundary between the hook's pre-claim
  // read and its post-claim reread). Filler records fatten state.json so the
  // hook's post-claim index update leaves the publisher a comfortable window;
  // they stay below the prune cap so the write does not also churn job files.
  const filler = Array.from({ length: 49 }, (unused, index) => ({
    id: `filler-${index}`,
    status: "completed",
    title: "Codex Task",
    sessionId: "sess-filler",
    summary: "x".repeat(200000),
    createdAt: "2026-03-18T15:30:00.000Z",
    updatedAt: "2026-03-18T15:30:00.000Z"
  }));
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: jobId,
            status: "running",
            title: "Codex Task",
            sessionId: "sess-current",
            pid: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          },
          ...filler
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const publisherScript = path.join(makeTempDir(), "publish-pid.mjs");
  fs.writeFileSync(
    publisherScript,
    [
      'import fs from "node:fs";',
      "const [claimFile, jobFile, jobId, pid] = process.argv.slice(2);",
      "function poll() {",
      "  if (fs.existsSync(claimFile)) {",
      '    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "running", pid: Number(pid) }, null, 2));',
      "    process.exit(0);",
      "  }",
      "  setTimeout(poll, 2);",
      "}",
      "poll();",
      "setTimeout(() => process.exit(1), 30000);"
    ].join("\n"),
    "utf8"
  );
  const publisher = spawn(process.execPath, [publisherScript, claimFile, jobFile, jobId, String(sleeper.pid)], {
    stdio: "ignore"
  });
  t.after(() => {
    try {
      publisher.kill("SIGKILL");
    } catch {
      // Ignore missing process.
    }
  });

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-current",
      cwd: repo
    })
  });
  assert.equal(result.status, 0, result.stderr);

  // The cancel patch nulls the pid, so the post-claim reread held the only
  // copy: the hook must have captured it and killed the worker — a survivor
  // would hold its broker socket and pin the shared broker after session end.
  await waitFor(() => {
    try {
      process.kill(sleeper.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const storedJob = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(storedJob.status, "cancelled");
  assert.equal(storedJob.pid, null);
});

test("session end converges the index when a finalizer dies between its two store writes", async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const jobId = "task-torn-finalizer";
  const jobFile = path.join(jobsDir, `${jobId}.json`);
  const claimFile = path.join(jobsDir, `${jobId}.terminal`);

  // A finalizer that wins its own terminal claim, writes the terminal job
  // file — and dies before the state.json update that normally follows it.
  // It must be alive when the hook checks its claim and dead by the end of
  // the exit grace: a decoy job right behind it in the loop provides the
  // synchronization signal — the decoy's cancelled record proves the
  // finalizer's own claim check has already passed.
  const finalizerScript = path.join(makeTempDir(), "torn-finalizer.mjs");
  fs.writeFileSync(
    finalizerScript,
    [
      'import fs from "node:fs";',
      "const [jobFile, jobId, stateFile] = process.argv.slice(2);",
      "function poll() {",
      "  let cancelled = false;",
      "  try {",
      '    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));',
      '    cancelled = state.jobs.some((job) => job.id === "task-decoy" && job.status === "cancelled");',
      "  } catch {",
      "    // Mid-write state file; retry.",
      "  }",
      "  if (cancelled) {",
      "    fs.writeFileSync(jobFile, JSON.stringify({",
      "      id: jobId,",
      '      status: "completed",',
      '      phase: "done",',
      "      pid: null,",
      "      completedAt: new Date().toISOString()",
      "    }, null, 2));",
      "    process.exit(0);",
      "  }",
      "  setTimeout(poll, 10);",
      "}",
      "poll();",
      "setTimeout(() => process.exit(1), 30000);"
    ].join("\n"),
    "utf8"
  );
  // The finalizer runs under a launcher rather than as this test's own child:
  // the test blocks in spawnSync while the hook runs, so a direct child would
  // linger as an unreaped zombie that still reads as alive — masking the exit
  // the hook's grace wait must observe. The launcher's free event loop reaps
  // the finalizer the moment it dies.
  const launcherScript = path.join(makeTempDir(), "finalizer-launcher.mjs");
  fs.writeFileSync(
    launcherScript,
    [
      'import fs from "node:fs";',
      'import { spawn } from "node:child_process";',
      "const [finalizerScript, jobFile, jobId, stateFile, pidFile] = process.argv.slice(2);",
      'const child = spawn(process.execPath, [finalizerScript, jobFile, jobId, stateFile], { stdio: "ignore" });',
      "fs.writeFileSync(pidFile, String(child.pid));",
      'child.on("exit", () => process.exit(0));',
      "setTimeout(() => {",
      '  try { child.kill("SIGKILL"); } catch {}',
      "  process.exit(1);",
      "}, 30000);"
    ].join("\n"),
    "utf8"
  );
  const pidFile = path.join(stateDir, "finalizer.pid");
  const launcher = spawn(
    process.execPath,
    [launcherScript, finalizerScript, jobFile, jobId, path.join(stateDir, "state.json"), pidFile],
    { detached: true, stdio: "ignore" }
  );
  launcher.unref();
  t.after(() => {
    try {
      process.kill(-launcher.pid, "SIGKILL");
    } catch {
      try {
        process.kill(launcher.pid, "SIGKILL");
      } catch {
        // Ignore missing process.
      }
    }
  });
  const finalizerPid = Number(await waitFor(() => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").trim() : null)));

  fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "running", pid: finalizerPid }, null, 2), "utf8");
  fs.writeFileSync(claimFile, `${finalizerPid} worker\n`, "utf8");
  // The decoy carries a turn identity so its own processing does not stall
  // on an identity wait; its interrupt fails fast against the dead endpoint.
  fs.writeFileSync(
    path.join(jobsDir, "task-decoy.json"),
    JSON.stringify({ id: "task-decoy", status: "running", pid: null, threadId: "th-decoy", turnId: "turn-decoy" }, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: jobId,
            status: "running",
            title: "Codex Task",
            sessionId: "sess-current",
            pid: finalizerPid,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          },
          {
            id: "task-decoy",
            status: "running",
            title: "Codex Task",
            sessionId: "sess-current",
            pid: null,
            threadId: "th-decoy",
            turnId: "turn-decoy",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  // A (dead) broker endpoint turns the interrupt/grace-wait path on; the
  // shutdown probe against it reports unreachable, which is fine here.
  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_APP_SERVER_ENDPOINT: `unix:${path.join(stateDir, "dead-broker.sock")}`
    },
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-current",
      cwd: repo
    })
  });
  assert.equal(result.status, 0, result.stderr);

  // The index must not retain a running record with a dead pid — the torn
  // write converges to the job file's completed outcome, after which the job
  // is erased like the session's other finished jobs (files included).
  if (fs.existsSync(jobFile)) {
    assert.equal(JSON.parse(fs.readFileSync(jobFile, "utf8")).status, "completed");
  }
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const record = state.jobs.find((candidate) => candidate.id === jobId);
  assert.ok(
    !record || (record.status !== "running" && record.status !== "queued"),
    `index must not keep a running record for a dead finalizer: ${JSON.stringify(record)}`
  );
});

test("a hung turn interrupt cannot starve later jobs' interrupt attempts", async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const socketPath = path.join(makeTempDir("cx-sock-"), "broker.sock");
  const recordFile = path.join(stateDir, "interrupts.jsonl");
  const readyFile = path.join(stateDir, "broker-ready");

  // A fake broker that answers initialize, records every turn/interrupt,
  // never responds for the first job's turn, and refuses broker/shutdown.
  const brokerScript = path.join(makeTempDir(), "hanging-broker.mjs");
  fs.writeFileSync(
    brokerScript,
    [
      'import fs from "node:fs";',
      'import net from "node:net";',
      "const [socketPath, recordFile, readyFile] = process.argv.slice(2);",
      "const server = net.createServer((socket) => {",
      '  socket.setEncoding("utf8");',
      '  let buffer = "";',
      '  socket.on("error", () => {});',
      '  socket.on("data", (chunk) => {',
      "    buffer += chunk;",
      "    let index;",
      '    while ((index = buffer.indexOf("\\n")) !== -1) {',
      "      const line = buffer.slice(0, index);",
      "      buffer = buffer.slice(index + 1);",
      "      if (!line.trim()) continue;",
      "      let message;",
      "      try { message = JSON.parse(line); } catch { continue; }",
      '      if (message.method === "turn/interrupt") {',
      "        fs.appendFileSync(recordFile, `${JSON.stringify(message.params)}\\n`);",
      '        if (message.params?.turnId === "turn-hang") continue;',
      "        socket.write(`${JSON.stringify({ id: message.id, result: {} })}\\n`);",
      '      } else if (message.method === "broker/shutdown") {',
      '        socket.write(`${JSON.stringify({ id: message.id, error: { code: -32001, message: "busy" } })}\\n`);',
      "      } else if (message.id != null) {",
      "        socket.write(`${JSON.stringify({ id: message.id, result: {} })}\\n`);",
      "      }",
      "    }",
      "  });",
      "});",
      'server.listen(socketPath, () => fs.writeFileSync(readyFile, "ready"));'
    ].join("\n"),
    "utf8"
  );
  const broker = spawn(process.execPath, [brokerScript, socketPath, recordFile, readyFile], { stdio: "ignore" });
  t.after(() => {
    try {
      broker.kill("SIGKILL");
    } catch {
      // Ignore missing process.
    }
  });
  await waitFor(() => fs.existsSync(readyFile));

  const jobs = [
    { id: "task-hang", threadId: "th-hang", turnId: "turn-hang" },
    { id: "task-late", threadId: "th-late", turnId: "turn-late" }
  ];
  for (const job of jobs) {
    fs.writeFileSync(
      path.join(jobsDir, `${job.id}.json`),
      JSON.stringify({ id: job.id, status: "running", pid: null, threadId: job.threadId, turnId: job.turnId }, null, 2),
      "utf8"
    );
  }
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: jobs.map((job) => ({
          id: job.id,
          status: "running",
          title: "Codex Task",
          sessionId: "sess-current",
          pid: null,
          threadId: job.threadId,
          turnId: job.turnId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }))
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_APP_SERVER_ENDPOINT: `unix:${socketPath}`,
      // What is under test is that the budget is *shared*, not how large it is: the hung
      // interrupt consumes its whole slice, so with the 2200ms default a loaded machine can
      // spend the remainder before the second job is ever attempted, and the test reports a
      // starvation that did not happen. The slicing is identical at any budget.
      CODEX_TURN_INTERRUPT_BUDGET_MS: "8000"
    },
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-current",
      cwd: repo
    })
  });
  assert.equal(result.status, 0, result.stderr);

  // The first job's interrupt hangs until its budget share runs out; the
  // second job must still get its own bounded attempt, not be recorded
  // cancelled while its server-side turn runs on uninterrupted.
  const attempts = fs
    .readFileSync(recordFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).turnId)
    .sort();
  assert.deepEqual(attempts, ["turn-hang", "turn-late"]);

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  for (const job of jobs) {
    assert.equal(state.jobs.find((candidate) => candidate.id === job.id)?.status, "cancelled");
  }
});

test("a hung dead-worker reap interrupt cannot starve the session's own interrupts", async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const socketPath = path.join(makeTempDir("cx-sock-"), "broker.sock");
  const recordFile = path.join(stateDir, "interrupts.jsonl");
  const readyFile = path.join(stateDir, "broker-ready");

  // Same fake broker as above: answers initialize, records every
  // turn/interrupt, never responds for the reaped job's turn, and refuses
  // broker/shutdown.
  const brokerScript = path.join(makeTempDir(), "hanging-broker.mjs");
  fs.writeFileSync(
    brokerScript,
    [
      'import fs from "node:fs";',
      'import net from "node:net";',
      "const [socketPath, recordFile, readyFile] = process.argv.slice(2);",
      "const server = net.createServer((socket) => {",
      '  socket.setEncoding("utf8");',
      '  let buffer = "";',
      '  socket.on("error", () => {});',
      '  socket.on("data", (chunk) => {',
      "    buffer += chunk;",
      "    let index;",
      '    while ((index = buffer.indexOf("\\n")) !== -1) {',
      "      const line = buffer.slice(0, index);",
      "      buffer = buffer.slice(index + 1);",
      "      if (!line.trim()) continue;",
      "      let message;",
      "      try { message = JSON.parse(line); } catch { continue; }",
      '      if (message.method === "turn/interrupt") {',
      "        fs.appendFileSync(recordFile, `${JSON.stringify(message.params)}\\n`);",
      '        if (message.params?.turnId === "turn-reap-hang") continue;',
      "        socket.write(`${JSON.stringify({ id: message.id, result: {} })}\\n`);",
      '      } else if (message.method === "broker/shutdown") {',
      '        socket.write(`${JSON.stringify({ id: message.id, error: { code: -32001, message: "busy" } })}\\n`);',
      "      } else if (message.id != null) {",
      "        socket.write(`${JSON.stringify({ id: message.id, result: {} })}\\n`);",
      "      }",
      "    }",
      "  });",
      "});",
      'server.listen(socketPath, () => fs.writeFileSync(readyFile, "ready"));'
    ].join("\n"),
    "utf8"
  );
  const broker = spawn(process.execPath, [brokerScript, socketPath, recordFile, readyFile], { stdio: "ignore" });
  t.after(() => {
    try {
      broker.kill("SIGKILL");
    } catch {
      // Ignore missing process.
    }
  });
  await waitFor(() => fs.existsSync(readyFile));

  // Another session's worker is dead with a persisted turn identity: the
  // reaper interrupts that turn before failing the record — and that RPC
  // hangs. The ending session's own running job must still get its own
  // bounded interrupt attempt from the shared deadline.
  const deadWorker = run(process.execPath, ["-e", ""], { cwd: repo });
  assert.equal(deadWorker.status, 0);

  const reapedJob = { id: "task-reaped", threadId: "th-reap", turnId: "turn-reap-hang" };
  const ownJob = { id: "task-own", threadId: "th-own", turnId: "turn-own" };
  fs.writeFileSync(
    path.join(jobsDir, `${reapedJob.id}.json`),
    JSON.stringify({ id: reapedJob.id, status: "running", pid: deadWorker.pid, threadId: reapedJob.threadId, turnId: reapedJob.turnId }, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(jobsDir, `${ownJob.id}.json`),
    JSON.stringify({ id: ownJob.id, status: "running", pid: null, threadId: ownJob.threadId, turnId: ownJob.turnId }, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: reapedJob.id,
            status: "running",
            title: "Codex Task",
            sessionId: "sess-other",
            pid: deadWorker.pid,
            threadId: reapedJob.threadId,
            turnId: reapedJob.turnId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          },
          {
            id: ownJob.id,
            status: "running",
            title: "Codex Task",
            sessionId: "sess-current",
            pid: null,
            threadId: ownJob.threadId,
            turnId: ownJob.turnId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_APP_SERVER_ENDPOINT: `unix:${socketPath}`,
      // What is under test is that the budget is *shared*, not how large it is: the hung
      // interrupt consumes its whole slice, so with the 2200ms default a loaded machine can
      // spend the remainder before the second job is ever attempted, and the test reports a
      // starvation that did not happen. The slicing is identical at any budget.
      CODEX_TURN_INTERRUPT_BUDGET_MS: "8000"
    },
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-current",
      cwd: repo
    })
  });
  assert.equal(result.status, 0, result.stderr);

  const attempts = fs
    .readFileSync(recordFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).turnId)
    .sort();
  assert.deepEqual(attempts, ["turn-own", "turn-reap-hang"]);

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs.find((candidate) => candidate.id === reapedJob.id)?.status, "failed");
  assert.equal(state.jobs.find((candidate) => candidate.id === ownJob.id)?.status, "cancelled");
});

test("background task records the turn id even when turn/started never arrives", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "no-turn-started");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = { ...buildEnv(binDir), CODEX_COMPANION_SESSION_ID: "sess-noturn" };
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the flaky worker timeout"], {
    cwd: repo,
    env
  });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;

  t.after(() => {
    run("node", [SESSION_HOOK, "SessionEnd"], {
      cwd: repo,
      env,
      input: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "sess-noturn", cwd: repo })
    });
  });

  // Cleanup can only interrupt a turn whose id reached the stored record;
  // the id must come from the turn/start response, not just notifications.
  const statePath = path.join(resolveStateDir(repo), "state.json");
  const runningJob = await waitFor(() => {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    return job?.threadId && job.turnId ? job : null;
  }, { timeoutMs: 15000 });
  assert.ok(runningJob.turnId);
});

test("session end reaps a dead worker's active record to failed", () => {
  const repo = makeTempDir();
  initGitRepo(repo);

  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });

  const deadWorker = run(process.execPath, ["-e", ""], { cwd: repo });
  assert.equal(deadWorker.status, 0);

  // A worker SIGKILLed/OOMed without its SessionEnd ever running has no
  // other reaper; the zombie record must not stay active forever.
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-zombie",
            status: "running",
            title: "Codex Task",
            sessionId: "sess-gone",
            pid: deadWorker.pid,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-current",
      cwd: repo
    })
  });
  assert.equal(result.status, 0, result.stderr);

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const reaped = state.jobs.find((candidate) => candidate.id === "task-zombie");
  assert.equal(reaped?.status, "failed", "a dead worker's record must be reaped to failed");
  assert.equal(reaped?.pid, null);
});

test("session end interrupts a reaped dead worker's turn before failing it", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);
  const review = run("node", [SCRIPT, "review"], { cwd: repo, env });
  assert.equal(review.status, 0, review.stderr);

  if (!loadBrokerSession(repo)) {
    return;
  }

  // Pin the broker with a live job so it survives this session end — the
  // reaped dead worker's server-side turn would otherwise keep running.
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  t.after(() => {
    try {
      process.kill(sleeper.pid, "SIGTERM");
    } catch {
      // Ignore missing process.
    }
    const surviving = loadBrokerSession(repo);
    if (surviving?.pid) {
      try {
        process.kill(surviving.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  const deadWorker = run(process.execPath, ["-e", ""], { cwd: repo });
  assert.equal(deadWorker.status, 0);

  const stateDir = resolveStateDir(repo);
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-dead-with-turn",
            status: "running",
            title: "Codex Task",
            sessionId: "sess-other",
            pid: deadWorker.pid,
            threadId: "thr_dead",
            turnId: "turn_dead",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          },
          {
            id: "task-live-pin",
            status: "running",
            title: "Codex Task",
            sessionId: "sess-other2",
            pid: sleeper.pid,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-current",
      cwd: repo
    })
  });
  assert.equal(result.status, 0, result.stderr);

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs.find((candidate) => candidate.id === "task-dead-with-turn")?.status, "failed");
  assert.ok(loadBrokerSession(repo), "the live job must keep the broker running");

  // The reaper must have interrupted the dead worker's server-side turn
  // before dropping the record out of the active set.
  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.deepEqual(fakeState.lastInterrupt, { threadId: "thr_dead", turnId: "turn_dead" });
});

test("cancel reports a benign already-finished result when the worker owns the terminal claim", async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);

  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  t.after(() => {
    try {
      process.kill(sleeper.pid, "SIGTERM");
    } catch {
      // Ignore missing process.
    }
  });

  const jobId = "task-finishing-now";
  fs.writeFileSync(
    path.join(stateDir, "jobs", `${jobId}.json`),
    JSON.stringify({ id: jobId, status: "running", pid: sleeper.pid }, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: jobId,
            status: "running",
            title: "Codex Task",
            sessionId: "sess-current",
            pid: sleeper.pid,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  // The worker won the terminal claim as its turn completed.
  fs.writeFileSync(path.join(stateDir, "jobs", `${jobId}.terminal`), `${sleeper.pid} worker\n`, "utf8");

  const result = run("node", [SCRIPT, "cancel", jobId, "--json"], {
    cwd: repo,
    env: { ...process.env, CODEX_COMPANION_SESSION_ID: "sess-current" }
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.alreadyFinished, true);
  assert.equal(payload.jobId, jobId);
});

test("cancel syncs a stale running index when the finished worker died before its state.json write", () => {
  const repo = makeTempDir();
  initGitRepo(repo);

  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });

  const deadWorker = run(process.execPath, ["-e", ""], { cwd: repo });
  assert.equal(deadWorker.status, 0);

  // The worker won the terminal claim, wrote its terminal job file, and died
  // before the upsertJob state-index write landed: state.json still says
  // running with the dead pid.
  const jobId = "task-index-stale";
  fs.writeFileSync(
    path.join(stateDir, "jobs", `${jobId}.json`),
    JSON.stringify(
      { id: jobId, status: "completed", phase: "completed", pid: null, completedAt: new Date().toISOString() },
      null,
      2
    ),
    "utf8"
  );
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: jobId,
            status: "running",
            title: "Codex Task",
            sessionId: "sess-current",
            pid: deadWorker.pid,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  fs.writeFileSync(path.join(stateDir, "jobs", `${jobId}.terminal`), `${deadWorker.pid} worker\n`, "utf8");

  const result = run("node", [SCRIPT, "cancel", jobId, "--json"], {
    cwd: repo,
    env: { ...process.env, CODEX_COMPANION_SESSION_ID: "sess-current" }
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.alreadyFinished, true);
  assert.equal(payload.status, "completed");

  // The already-finished return must have repaired the index, not just read
  // the job file: otherwise the job stays listed as running with a dead pid.
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const indexed = state.jobs.find((entry) => entry.id === jobId);
  assert.equal(indexed.status, "completed");
  assert.equal(indexed.pid, null);
});

test("cancel repairs an orphaned terminal claim and still stops the worker", async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);

  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  t.after(() => {
    try {
      process.kill(sleeper.pid, "SIGTERM");
    } catch {
      // Ignore missing process.
    }
  });

  const deadClaimant = run(process.execPath, ["-e", ""], { cwd: repo });
  assert.equal(deadClaimant.status, 0);

  const jobId = "task-orphan-claim";
  fs.writeFileSync(
    path.join(stateDir, "jobs", `${jobId}.json`),
    JSON.stringify({ id: jobId, status: "running", pid: sleeper.pid }, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: jobId,
            status: "running",
            title: "Codex Task",
            sessionId: "sess-current",
            pid: sleeper.pid,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  // A previous cancel claimed the terminal status and died before writing
  // any record: the worker is still alive and must remain cancellable.
  fs.writeFileSync(path.join(stateDir, "jobs", `${jobId}.terminal`), `${deadClaimant.pid} cancel\n`, "utf8");

  const result = run("node", [SCRIPT, "cancel", jobId, "--json"], {
    cwd: repo,
    env: { ...process.env, CODEX_COMPANION_SESSION_ID: "sess-current" }
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "cancelled");
  assert.notEqual(payload.alreadyFinished, true);

  await waitFor(() => {
    try {
      process.kill(sleeper.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs.find((candidate) => candidate.id === jobId)?.status, "cancelled");
});

test("cancel reports failed for a dead worker's own orphaned claim", () => {
  const repo = makeTempDir();
  initGitRepo(repo);

  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });

  const deadWorker = run(process.execPath, ["-e", ""], { cwd: repo });
  assert.equal(deadWorker.status, 0);

  const jobId = "task-worker-claim-died";
  fs.writeFileSync(
    path.join(stateDir, "jobs", `${jobId}.json`),
    JSON.stringify({ id: jobId, status: "running", pid: deadWorker.pid }, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: jobId,
            status: "running",
            title: "Codex Task",
            sessionId: "sess-current",
            pid: deadWorker.pid,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  // The worker claimed for its own terminal write and died before it landed;
  // the job actually ran, so the outcome is failed, not cancelled.
  fs.writeFileSync(path.join(stateDir, "jobs", `${jobId}.terminal`), `${deadWorker.pid} worker\n`, "utf8");

  const result = run("node", [SCRIPT, "cancel", jobId, "--json"], {
    cwd: repo,
    env: { ...process.env, CODEX_COMPANION_SESSION_ID: "sess-current" }
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "failed", "the claim's intent decides the terminal status");

  const stored = JSON.parse(fs.readFileSync(path.join(stateDir, "jobs", `${jobId}.json`), "utf8"));
  assert.equal(stored.status, "failed");
});

test("session end adopts an orphaned claim on its own job and still stops the worker", async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  t.after(() => {
    try {
      process.kill(sleeper.pid, "SIGTERM");
    } catch {
      // Ignore missing process.
    }
  });

  const deadClaimant = run(process.execPath, ["-e", ""], { cwd: repo });
  assert.equal(deadClaimant.status, 0);

  const jobId = "task-orphan-at-end";
  fs.writeFileSync(
    path.join(jobsDir, `${jobId}.json`),
    JSON.stringify({ id: jobId, status: "running", pid: sleeper.pid }, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: jobId,
            status: "running",
            title: "Codex Task",
            sessionId: "sess-current",
            pid: sleeper.pid,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  // A previous cancel claimed the terminal status and died before writing
  // any record; session end must adopt the claim, not skip the job.
  fs.writeFileSync(path.join(jobsDir, `${jobId}.terminal`), `${deadClaimant.pid} cancel\n`, "utf8");

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-current",
      cwd: repo
    })
  });
  assert.equal(result.status, 0, result.stderr);

  await waitFor(() => {
    try {
      process.kill(sleeper.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs.find((candidate) => candidate.id === jobId)?.status, "cancelled");
});

test("session end tears down the broker when the other session's active record is stale", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);
  const review = run("node", [SCRIPT, "review"], { cwd: repo, env });
  assert.equal(review.status, 0, review.stderr);

  if (!loadBrokerSession(repo)) {
    return;
  }

  // A pid-less active record has no liveness signal; once it is a day old
  // it must not pin the broker (a live pid always wins over record age).
  const staleTimestamp = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const stateDir = resolveStateDir(repo);
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-stale-record",
            status: "running",
            title: "Codex Task",
            sessionId: "sess-other",
            pid: null,
            createdAt: staleTimestamp,
            updatedAt: staleTimestamp
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-current",
      cwd: repo
    })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(loadBrokerSession(repo), null, "a stale active record must not pin the shared broker");
});

test("session end leaves the shared broker running while another session has an active job", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);
  const review = run("node", [SCRIPT, "review"], { cwd: repo, env });
  assert.equal(review.status, 0, review.stderr);

  const brokerSession = loadBrokerSession(repo);
  if (!brokerSession) {
    return;
  }

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  t.after(() => {
    try {
      process.kill(sleeper.pid, "SIGTERM");
    } catch {
      // Ignore missing process.
    }
  });

  const stateDir = resolveStateDir(repo);
  const writeJobs = (jobs) => {
    fs.writeFileSync(
      path.join(stateDir, "state.json"),
      `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs }, null, 2)}\n`,
      "utf8"
    );
  };
  writeJobs([
    {
      id: "task-other-session",
      status: "running",
      title: "Codex Task",
      sessionId: "sess-other",
      pid: sleeper.pid,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  ]);

  const firstEnd = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-current",
      cwd: repo
    })
  });
  assert.equal(firstEnd.status, 0, firstEnd.stderr);

  const survivingSession = loadBrokerSession(repo);
  assert.ok(survivingSession, "broker session record should survive while another session's job is running");
  assert.doesNotThrow(() => process.kill(survivingSession.pid, 0), "broker process should still be alive");

  // Once the other session's job is finished, the next session end tears the broker down.
  writeJobs([
    {
      id: "task-other-session",
      status: "completed",
      title: "Codex Task",
      sessionId: "sess-other",
      pid: null,
      createdAt: "2026-03-18T15:30:00.000Z",
      updatedAt: "2026-03-18T15:32:00.000Z"
    }
  ]);

  const secondEnd = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-other",
      cwd: repo
    })
  });
  assert.equal(secondEnd.status, 0, secondEnd.stderr);
  assert.equal(loadBrokerSession(repo), null);
});

test("session end still tears down the broker when the other session's job worker is dead", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);
  const review = run("node", [SCRIPT, "review"], { cwd: repo, env });
  assert.equal(review.status, 0, review.stderr);

  const brokerSession = loadBrokerSession(repo);
  if (!brokerSession) {
    return;
  }

  // A worker that crashed at startup leaves a permanently queued record with
  // a dead pid; it must not pin the broker.
  const deadWorker = run(process.execPath, ["-e", ""], { cwd: repo });
  assert.equal(deadWorker.status, 0);
  const deadPid = deadWorker.pid;

  const stateDir = resolveStateDir(repo);
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-dead-worker",
            status: "queued",
            title: "Codex Task",
            sessionId: "sess-other",
            pid: deadPid,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:31:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const end = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-current",
      cwd: repo
    })
  });
  assert.equal(end.status, 0, end.stderr);
  assert.equal(loadBrokerSession(repo), null, "dead queued worker must not keep the broker alive");
});

test("background task records a failure instead of hanging when the broker dies mid-turn", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "interruptible-slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = buildEnv(binDir);
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the flaky worker timeout"], {
    cwd: repo,
    env
  });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  assert.ok(jobId);

  const stateDir = resolveStateDir(repo);
  const readJob = () => {
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
    return state.jobs.find((candidate) => candidate.id === jobId) ?? null;
  };

  await waitFor(() => {
    const job = readJob();
    return job?.status === "running" && job.threadId && job.turnId ? job : null;
  }, { timeoutMs: 15000 });

  const brokerSession = loadBrokerSession(repo);
  if (!brokerSession) {
    return;
  }

  process.kill(brokerSession.pid, "SIGKILL");

  const failedJob = await waitFor(() => {
    const job = readJob();
    return job?.status === "failed" ? job : null;
  }, { timeoutMs: 15000 });

  assert.equal(failedJob.pid, null);
  assert.ok(failedJob.completedAt);
  assert.ok(failedJob.errorMessage, "failed job should record why it failed");

  const storedJob = JSON.parse(fs.readFileSync(path.join(stateDir, "jobs", `${jobId}.json`), "utf8"));
  assert.equal(storedJob.status, "failed");
  assert.ok(storedJob.errorMessage);
});

test("cancel records the terminal state even when the job log is unwritable", async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  t.after(() => {
    try {
      process.kill(sleeper.pid, "SIGTERM");
    } catch {
      // Ignore missing process.
    }
  });

  const unwritableLog = path.join(stateDir, "missing-dir", "task.log");
  const job = {
    id: "task-unwritable-log",
    status: "running",
    title: "Codex Task",
    sessionId: "sess-current",
    pid: sleeper.pid,
    logFile: unwritableLog,
    createdAt: "2026-03-18T15:30:00.000Z",
    updatedAt: "2026-03-18T15:31:00.000Z"
  };
  fs.writeFileSync(path.join(jobsDir, `${job.id}.json`), `${JSON.stringify(job, null, 2)}\n`, "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [job] }, null, 2)}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "cancel", job.id, "--json"], {
    cwd: repo,
    env: process.env
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "cancelled");

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const cancelled = state.jobs.find((candidate) => candidate.id === job.id);
  assert.equal(cancelled.status, "cancelled");
  assert.ok(cancelled.completedAt);

  const storedJob = JSON.parse(fs.readFileSync(path.join(jobsDir, `${job.id}.json`), "utf8"));
  assert.equal(storedJob.status, "cancelled");
});

test("stop hook runs a stop-time review task and blocks on findings when the review gate is enabled", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);
  const setupPayload = JSON.parse(setup.stdout);
  assert.equal(setupPayload.reviewGateEnabled, true);

  const taskResult = run("node", [SCRIPT, "task", "--write", "fix the issue"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(taskResult.status, 0, taskResult.stderr);

  const blocked = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({
      cwd: repo,
      session_id: "sess-stop-review",
      last_assistant_message: "I completed the refactor and updated the retry logic."
    })
  });
  assert.equal(blocked.status, 0, blocked.stderr);
  const blockedPayload = JSON.parse(blocked.stdout);
  assert.equal(blockedPayload.decision, "block");
  assert.match(blockedPayload.reason, /Codex stop-time review found issues that still need fixes/i);
  assert.match(blockedPayload.reason, /Missing empty-state guard/i);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.match(fakeState.lastTurnStart.prompt, /<task>/i);
  assert.match(fakeState.lastTurnStart.prompt, /<compact_output_contract>/i);
  assert.match(fakeState.lastTurnStart.prompt, /Only review the work from the previous Claude turn/i);
  assert.match(fakeState.lastTurnStart.prompt, /I completed the refactor and updated the retry logic\./);

  const status = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      CODEX_COMPANION_SESSION_ID: "sess-stop-review"
    }
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Codex Stop Gate Review/);
});

test("stop hook does not re-run the review and does not block on a forced retry (stop_hook_active)", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  // `appServerStarts` only increments when the fake Codex binary's
  // `app-server` subcommand actually runs (i.e. a real review turn was
  // spawned). Snapshot it now so we can prove below that the forced retry
  // does not spawn a second review.
  const appServerStartsBeforeRetry = fs.existsSync(fakeStatePath)
    ? JSON.parse(fs.readFileSync(fakeStatePath, "utf8")).appServerStarts || 0
    : 0;

  const retried = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({
      cwd: repo,
      session_id: "sess-stop-review-retry",
      stop_hook_active: true,
      last_assistant_message: "I completed the refactor and updated the retry logic."
    })
  });

  assert.equal(retried.status, 0, retried.stderr);
  const payload = JSON.parse(retried.stdout.trim());
  assert.equal(payload.decision, undefined);
  assert.match(payload.systemMessage, /skipped/i);

  const appServerStartsAfterRetry = fs.existsSync(fakeStatePath)
    ? JSON.parse(fs.readFileSync(fakeStatePath, "utf8")).appServerStarts || 0
    : 0;
  assert.equal(appServerStartsAfterRetry, appServerStartsBeforeRetry);
});

test("stop hook logs running tasks to stderr without blocking when the review gate is disabled", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const runningLog = path.join(jobsDir, "task-running.log");
  fs.writeFileSync(runningLog, "running\n", "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: {
          stopReviewGate: false
        },
        jobs: [
          {
            id: "task-live",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-current",
            logFile: runningLog,
            createdAt: "2026-03-18T15:32:00.000Z",
            updatedAt: "2026-03-18T15:33:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const blocked = run("node", [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(blocked.stdout.trim(), "");
  assert.match(blocked.stderr, /Codex task task-live is still running/i);
  assert.match(blocked.stderr, /\/codex:status/i);
  assert.match(blocked.stderr, /\/codex:cancel task-live/i);
});

test("review gate enabled under one plugin-data root is enforced by Stop under another", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const codexHome = makeTempDir();
  const pluginDataSetup = makeTempDir();
  const pluginDataStop = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: { ...buildEnv(binDir), CODEX_HOME: codexHome, CLAUDE_PLUGIN_DATA: pluginDataSetup }
  });
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(JSON.parse(setup.stdout).reviewGateEnabled, true);
  const stopped = run("node", [STOP_HOOK], {
    cwd: repo,
    env: { ...buildEnv(binDir), CODEX_HOME: codexHome, CLAUDE_PLUGIN_DATA: pluginDataStop, CODEX_COMPANION_SESSION_ID: "sess-cross-root" },
    input: JSON.stringify({ cwd: repo, session_id: "sess-cross-root", last_assistant_message: "I completed the change." })
  });
  assert.equal(stopped.status, 0, stopped.stderr);
  const payload = JSON.parse(stopped.stdout);
  assert.equal(payload.decision, "block");
  assert.match(payload.reason, /Codex stop-time review found issues/i);
});

test("stop hook allows the stop when the review gate is enabled and the stop-time review task is clean", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "adversarial-clean");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo, session_id: "sess-stop-clean" })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
});

test("stop hook does not block when Codex is unavailable even if the review gate is enabled", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const codexHome = makeTempDir();
  const setup = run(process.execPath, [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: { ...process.env, CODEX_HOME: codexHome }
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run(process.execPath, [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      PATH: ""
    },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
  assert.match(allowed.stderr, /Codex is not set up for the review gate/i);
  assert.match(allowed.stderr, /Run \/codex:setup/i);
});

test("stop hook runs the actual task when auth status looks stale", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "refreshable-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.doesNotMatch(allowed.stderr, /Codex is not set up for the review gate/i);
  const payload = JSON.parse(allowed.stdout);
  assert.equal(payload.decision, "block");
  assert.match(payload.reason, /Missing empty-state guard/i);
});

test("commands lazily start and reuse one shared app-server after first use", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");

  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  const brokerSession = loadBrokerSession(repo);
  if (!brokerSession) {
    return;
  }

  const adversarial = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env
  });
  assert.equal(adversarial.status, 0, adversarial.stderr);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.appServerStarts, 1);

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("setup reuses an existing shared app-server without starting another one", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");

  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  const brokerSession = loadBrokerSession(repo);
  if (!brokerSession) {
    return;
  }

  const setup = run("node", [SCRIPT, "setup", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(setup.status, 0, setup.stderr);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.appServerStarts, 1);

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("status reports shared session runtime when a lazy broker is active", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(review.status, 0, review.stderr);

  if (!loadBrokerSession(repo)) {
    return;
  }

  const result = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Session runtime: shared session/);

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("setup and status honor --cwd when reading shared session runtime", () => {
  const targetWorkspace = makeTempDir();
  const invocationWorkspace = makeTempDir();

  saveBrokerSession(targetWorkspace, {
    endpoint: "unix:/tmp/fake-broker.sock"
  });

  const status = run("node", [SCRIPT, "status", "--cwd", targetWorkspace], {
    cwd: invocationWorkspace
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Session runtime: shared session/);

  const setup = run("node", [SCRIPT, "setup", "--cwd", targetWorkspace, "--json"], {
    cwd: invocationWorkspace
  });
  assert.equal(setup.status, 0, setup.stderr);
  const payload = JSON.parse(setup.stdout);
  assert.equal(payload.sessionRuntime.mode, "shared");
  assert.equal(payload.sessionRuntime.endpoint, "unix:/tmp/fake-broker.sock");
});

// Caught in review: cleanupSessionJobs() checked only resolveStateFile()'s
// (the primary candidate's) existence before deciding whether to look for
// jobs to clean up -- but loadState() is candidate-aware, so a session
// whose jobs live only in the fallback root (e.g. started without
// CLAUDE_PLUGIN_DATA, with SessionEnd later running with it set, flipping
// which root is primary) would be silently skipped: the early check saw no
// primary file and returned before loadState() was ever called.
test("SessionEnd cleans up a session's jobs even when they exist only in the fallback root", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;

  try {
    delete process.env.CLAUDE_PLUGIN_DATA;
    saveState(workspace, {
      config: {},
      jobs: [{ id: "job-fallback-only", sessionId: "sess-under-test", status: "completed", updatedAt: "2026-08-19T00:00:00.000Z" }]
    });

    const env = { ...process.env, CLAUDE_PLUGIN_DATA: pluginDataDir };
    const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
      cwd: workspace,
      env,
      input: JSON.stringify({
        hook_event_name: "SessionEnd",
        cwd: workspace,
        session_id: "sess-under-test"
      })
    });
    assert.equal(cleanup.status, 0, cleanup.stderr);

    process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
    const state = loadState(workspace);
    assert.equal(
      state.jobs.some((job) => job.id === "job-fallback-only"),
      false
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("task --resume-last ignores a stale current-session worker and resumes the prior completed thread", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  const env = { ...buildEnv(binDir), CODEX_COMPANION_SESSION_ID: "sess-current" };
  const first = run("node", [SCRIPT, "task", "initial task"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);
  const statePath = path.join(resolveStateDir(repo), "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.jobs.push({ id: "task-stale", status: "running", title: "Codex Task", jobClass: "task", sessionId: "sess-current", pid: 999999, updatedAt: "2099-01-01T00:00:00.000Z" });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  const resumed = run("node", [SCRIPT, "task", "--resume-last", "follow up"], { cwd: repo, env });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(resumed.stdout, "Resumed the prior run.\nFollow-up prompt accepted.\n");
});

test("task --resume-last blocks when a dead wrapper still has a live turn identity", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  const env = { ...buildEnv(binDir), CODEX_COMPANION_SESSION_ID: "sess-current" };
  const first = run("node", [SCRIPT, "task", "initial task"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);
  const statePath = path.join(resolveStateDir(repo), "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.jobs.push({ id: "task-orphan-turn", status: "running", title: "Codex Task", jobClass: "task", sessionId: "sess-current", pid: 999999, threadId: "thr_orphan", turnId: "turn_orphan", updatedAt: "2099-01-01T00:00:00.000Z" });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  const resumed = run("node", [SCRIPT, "task", "--resume-last", "follow up"], { cwd: repo, env });
  assert.notEqual(resumed.status, 0);
  assert.match(resumed.stderr, /task-orphan-turn is still running/i);
});

test("cancel fails closed when an orphaned turn has no persisted turn id", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "state.json"), `${JSON.stringify({
    version: 1, config: { stopReviewGate: false }, jobs: [{
      id: "task-turn-pending", status: "running", title: "Codex Task", jobClass: "task",
      sessionId: "sess-current", pid: 999999, threadId: "thr_pending",
      updatedAt: "2099-01-01T00:00:00.000Z"
    }]
  }, null, 2)}
`, "utf8");
  const env = { ...process.env, CODEX_COMPANION_SESSION_ID: "sess-current" };
  const result = run("node", [SCRIPT, "cancel", "task-turn-pending", "--json"], { cwd: workspace, env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /turn id|safely interrupt|still running/i);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "running");
});

test("session end preserves an orphaned turn whose worker exited", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "state.json"), `${JSON.stringify({
    version: 1, config: { stopReviewGate: false }, jobs: [{
      id: "task-orphaned-turn", status: "running", title: "Codex Task", jobClass: "task",
      sessionId: "sess-current", pid: 999999, threadId: "thr_pending",
      updatedAt: "2099-01-01T00:00:00.000Z"
    }]
  }, null, 2)}
`, "utf8");
  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: workspace, env: { ...process.env, CODEX_COMPANION_SESSION_ID: "sess-current" },
    input: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "sess-current", cwd: workspace })
  });
  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].id, "task-orphaned-turn");
});

test("stop hook ignores a stale current-session worker when the review gate is disabled", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "state.json"), `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [{ id: "task-stale", status: "running", title: "Codex Task", jobClass: "task", sessionId: "sess-current", pid: 999999, updatedAt: "2099-01-01T00:00:00.000Z" }] }, null, 2)}\n`, "utf8");
  const result = run("node", [STOP_HOOK], {
    cwd: repo,
    env: { ...process.env, CODEX_COMPANION_SESSION_ID: "sess-current" },
    input: JSON.stringify({ cwd: repo })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "");
  assert.doesNotMatch(result.stderr, /task-stale is still running/i);
});

test("stop hook keeps an orphaned live turn active when its wrapper died", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "state.json"), `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [{ id: "task-orphan-turn", status: "running", title: "Codex Task", jobClass: "task", sessionId: "sess-current", pid: 999999, threadId: "thr_orphan", turnId: "turn_orphan", updatedAt: "2099-01-01T00:00:00.000Z" }] }, null, 2)}\n`, "utf8");
  const result = run("node", [STOP_HOOK], {
    cwd: repo,
    env: { ...process.env, CODEX_COMPANION_SESSION_ID: "sess-current" },
    input: JSON.stringify({ cwd: repo })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "");
  assert.match(result.stderr, /task-orphan-turn is still running/i);
});


test("a refused cancel leaves no terminal claim behind", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "state.json"), `${JSON.stringify({
    version: 1, config: { stopReviewGate: false }, jobs: [{
      id: "task-turn-pending", status: "running", title: "Codex Task", jobClass: "task",
      sessionId: "sess-current", pid: 999999, threadId: "thr_pending",
      updatedAt: "2099-01-01T00:00:00.000Z"
    }]
  }, null, 2)}\n`, "utf8");
  const env = { ...process.env, CODEX_COMPANION_SESSION_ID: "sess-current" };

  const refused = run("node", [SCRIPT, "cancel", "task-turn-pending", "--json"], { cwd: workspace, env });
  assert.equal(refused.status, 1);

  // The terminal claim is never released, so a claim taken before the refusal
  // would be adopted by the next cancel (or by SessionEnd) and reasserted into
  // a cancelled record — for the turn this refusal exists to protect.
  assert.equal(fs.existsSync(path.join(jobsDir, "task-turn-pending.terminal")), false);

  const again = run("node", [SCRIPT, "cancel", "task-turn-pending", "--json"], { cwd: workspace, env });
  assert.equal(again.status, 1);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "running");
});

test("task --resume-last still works with scoped read roots", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  const env = buildEnv(binDir);

  const first = run("node", [SCRIPT, "task", "--write", "--read-root", repo, "initial task"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);

  // A scoped run sends a permission profile and no sandbox mode, so the mode
  // the app-server reports on resume is not the one this turn asked for.
  // Asserting it refused every --read-root resume outright.
  const resumed = run("node", [SCRIPT, "task", "--resume-last", "--write", "--read-root", repo, "follow up"], {
    cwd: repo,
    env
  });
  assert.equal(resumed.status, 0, resumed.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastThreadResume.sandbox, undefined);
  assert.equal(fakeState.lastThreadResume.config.default_permissions, "claude_companion_scoped");
});


test("a retained orphaned turn stays reconcilable after session end", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  // The index carries the queued record's pid: null, while the job file has the
  // real (now dead) pid and the thread the worker started. Session end must read
  // the file, not the snapshot: on the snapshot alone there is no pid to judge,
  // so the job would be recorded cancelled while its turn may still run.
  fs.writeFileSync(path.join(jobsDir, "task-retained.json"), `${JSON.stringify({
    id: "task-retained", status: "running", title: "Codex Task", jobClass: "task",
    sessionId: "sess-current", pid: 999999, threadId: "thr_pending"
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(stateDir, "state.json"), `${JSON.stringify({
    version: 1, config: { stopReviewGate: false }, jobs: [{
      id: "task-retained", status: "running", title: "Codex Task", jobClass: "task",
      sessionId: "sess-current", pid: null, threadId: null,
      updatedAt: "2099-01-01T00:00:00.000Z"
    }]
  }, null, 2)}\n`, "utf8");

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: workspace,
    env: { ...process.env, CODEX_COMPANION_SESSION_ID: "sess-current" },
    input: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "sess-current", cwd: workspace })
  });
  assert.equal(result.status, 0, result.stderr);

  const retained = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")).jobs[0];
  assert.equal(retained.status, "running");
  assert.equal(retained.threadId, "thr_pending");
  assert.equal(retained.phase, "worker-exited-turn-unknown");
  // The verdict is persisted, not the dead pid: the record has to stay
  // reconcilable without handing the dead-worker reaper something to fail.
  assert.equal(retained.pid, null);
  assert.equal(retained.workerExited, true);

  // Another session ending must not reap it: its turn may still be running,
  // and failing the record would also stop it pinning the shared broker.
  const other = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: workspace,
    env: { ...process.env, CODEX_COMPANION_SESSION_ID: "sess-other" },
    input: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "sess-other", cwd: workspace })
  });
  assert.equal(other.status, 0, other.stderr);
  const afterOther = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")).jobs[0];
  assert.equal(afterOther.status, "running");
});


test("the session start hook appends to CLAUDE_ENV_FILE without rewriting it", () => {
  const repo = makeTempDir();
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  const foreignExport = "export SOME_OTHER_PLUGIN_VAR='kept'\n";
  fs.writeFileSync(envFile, foreignExport, "utf8");
  fs.chmodSync(envFile, 0o600);
  const pluginDataDir = makeTempDir();
  const transcriptPath = path.join(repo, "session.jsonl");
  const env = {
    ...process.env,
    CLAUDE_ENV_FILE: envFile,
    CLAUDE_PLUGIN_DATA: pluginDataDir
  };
  const input = JSON.stringify({
    hook_event_name: "SessionStart",
    session_id: "sess-current",
    transcript_path: transcriptPath,
    cwd: repo
  });

  assert.equal(run("node", [SESSION_HOOK, "SessionStart"], { cwd: repo, env, input }).status, 0);
  assert.equal(run("node", [SESSION_HOOK, "SessionStart"], { cwd: repo, env, input }).status, 0);

  const contents = fs.readFileSync(envFile, "utf8");
  // The file is shared with every other plugin's SessionStart hook: a rewrite
  // would drop whatever another hook appended, and replacing the file discards
  // its mode with it.
  assert.match(contents, /export SOME_OTHER_PLUGIN_VAR='kept'/);
  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
  // Re-exporting the same value must not grow the file either.
  assert.equal(contents.split("\n").filter((line) => line.startsWith("export CODEX_COMPANION_SESSION_ID=")).length, 1);

  // A changed value is appended; the shell takes the last export for a key.
  assert.equal(
    run("node", [SESSION_HOOK, "SessionStart"], {
      cwd: repo,
      env,
      input: JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "sess-next",
        transcript_path: transcriptPath,
        cwd: repo
      })
    }).status,
    0
  );
  const sessionExports = fs
    .readFileSync(envFile, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("export CODEX_COMPANION_SESSION_ID="));
  assert.equal(sessionExports.at(-1), "export CODEX_COMPANION_SESSION_ID='sess-next'");
});


function seedRetainedOrphan(workspace, updatedAt) {
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({
      version: 1,
      config: { stopReviewGate: false },
      jobs: [{
        id: "task-orphan", status: "running", title: "Codex Task", jobClass: "task",
        sessionId: "sess-owner", pid: null, threadId: "thr_pending", workerExited: true, updatedAt
      }]
    }, null, 2)}\n`,
    "utf8"
  );
  return stateDir;
}

function endSessionFor(workspace, env) {
  return run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: workspace,
    env: { ...process.env, CODEX_COMPANION_SESSION_ID: "sess-other", ...env },
    input: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "sess-other", cwd: workspace })
  });
}

test("a retained orphan expires even when the broker idle timer is disabled", () => {
  const workspace = makeTempDir();
  const hoursAgo = (hours) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  // Two hours old, idle shutdown off: still protected — nothing has proved the
  // turn is over.
  let stateDir = seedRetainedOrphan(workspace, hoursAgo(2));
  assert.equal(endSessionFor(workspace, { CODEX_BROKER_IDLE_SHUTDOWN_MS: "0" }).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")).jobs[0].status, "running");

  // Past the generic staleness bound, still with the idle timer off: reaped,
  // rather than pinning the broker for good.
  stateDir = seedRetainedOrphan(workspace, hoursAgo(25));
  assert.equal(endSessionFor(workspace, { CODEX_BROKER_IDLE_SHUTDOWN_MS: "0" }).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")).jobs[0].status, "failed");

  // With the timer at ten minutes, the same two-hour-old record is over.
  stateDir = seedRetainedOrphan(workspace, hoursAgo(2));
  assert.equal(endSessionFor(workspace, { CODEX_BROKER_IDLE_SHUTDOWN_MS: "600000" }).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")).jobs[0].status, "failed");
});

test("a retained orphan with an unreadable timestamp does not pin the broker forever", () => {
  const workspace = makeTempDir();
  const stateDir = seedRetainedOrphan(workspace, "not-a-timestamp");

  assert.equal(endSessionFor(workspace, {}).status, 0);

  // This is the one record that stops a teardown, so an unreadable timestamp
  // has to count as expired: "cannot tell" must not mean "protected forever".
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")).jobs[0].status, "failed");
});
