import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

for (const behavior of ["missing-turn-id", "missing-turn-id-with-early-event"]) {
  test(`task finishes when turn/start omits turn.id (${behavior})`, () => {
    const repo = makeTempDir();
    const binDir = makeTempDir();
    installFakeCodex(binDir, behavior);
    initGitRepo(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
    run("git", ["add", "README.md"], { cwd: repo });
    run("git", ["commit", "-m", "init"], { cwd: repo });

    // Bound the regression: the old notification gate would wait forever.
    const result = spawnSync(process.execPath, [SCRIPT, "task", "verify progress"], {
      cwd: repo,
      env: buildEnv(binDir),
      encoding: "utf8",
      timeout: 8000
    });

    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
    const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
    assert.ok(state.lastTurnStart.turnId);
  });
}
