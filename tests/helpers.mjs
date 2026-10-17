import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { after } from "node:test";

import {
  loadBrokerSession,
  shutdownBrokerSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

const trackedTempDirs = [];

export function makeTempDir(prefix = "codex-plugin-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackedTempDirs.push(dir);
  return dir;
}

/**
 * Shut down every broker a test started under one of `dirs`, and report the ones that would not go.
 *
 * A broker's record lives under the state root of the process that started it, and that root
 * follows `CLAUDE_PLUGIN_DATA`. A test that gives a hook or a companion run its own plugin-data
 * directory therefore leaves the record where an invocation without that variable — this teardown,
 * by default — never looks. So every directory here that holds a `state/` tree is also tried as a
 * plugin-data root, with every directory as the workspace.
 */
export async function teardownOwnedBrokers(dirs) {
  const failures = [];
  const pluginDataRoots = dirs.filter((dir) => fs.existsSync(path.join(dir, "state")));
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  const seen = new Set();
  try {
    for (const pluginDataRoot of [previous, ...pluginDataRoots]) {
      if (pluginDataRoot === undefined) {
        delete process.env.CLAUDE_PLUGIN_DATA;
      } else {
        process.env.CLAUDE_PLUGIN_DATA = pluginDataRoot;
      }
      for (const dir of dirs) {
        const session = loadBrokerSession(dir);
        // A fixture may deliberately persist an arbitrary endpoint. Only sessions
        // with the per-process secret introduced by ensureBrokerSession are ours.
        // Every root also reads the default one, so the same record can turn up twice.
        if (!session?.instanceToken || seen.has(session.instanceToken)) {
          continue;
        }
        seen.add(session.instanceToken);
        try {
          await shutdownBrokerSession(dir, {
            killProcess: terminateProcessTree,
            timeoutMs: 1000,
            intervalMs: 25
          });
        } catch (error) {
          failures.push(error);
        }
      }
    }
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
  return failures;
}

// Global teardown: any broker a test started (directly or lazily) and did not
// tear down is shut down here, so the suite never leaves broker/app-server
// processes behind — even when a test fails or returns early.
after(async () => {
  const failures = await teardownOwnedBrokers(trackedTempDirs);
  if (failures.length > 0) {
    throw new AggregateError(failures, "Owned broker teardown did not finish.");
  }
});

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: options.shell ?? (process.platform === "win32" && !path.isAbsolute(command)),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
