import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  ensureBrokerSession,
  loadBrokerSession,
  shutdownBrokerSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { isProcessRunning, terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";
import { makeTempDir, writeExecutable } from "./helpers.mjs";

// A codex stand-in whose app-server starts the kind of children a real one does — an MCP server
// in the broker's process group, one that moved to a group of its own, and one that ignores
// SIGTERM — and records their pids. `mode` decides how the app-server itself leaves:
//   clean   exits as soon as its stdin closes
//   wedged  ignores both the close and SIGTERM
//   late    like clean, but starts one more child after the handshake, in a group of its own
//   crash   starts that same late child, then dies
function installTreeCodex(binDir, mode) {
  const pidsFile = path.join(binDir, "pids.json");
  writeExecutable(
    path.join(binDir, "codex"),
    `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const readline = require("node:readline");
const MODE = ${JSON.stringify(mode)};
const PIDS = ${JSON.stringify(pidsFile)};
const idle = ["-e", "setInterval(() => {}, 1000)"];
const pids = { app: process.pid };
function record() {
  fs.writeFileSync(PIDS + ".tmp", JSON.stringify(pids));
  fs.renameSync(PIDS + ".tmp", PIDS);
}
pids.sameGroup = spawn(process.execPath, idle, { stdio: "ignore" }).pid;
pids.ownGroup = spawn(process.execPath, idle, { stdio: "ignore", detached: true }).pid;
pids.stubborn = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" }).pid;
record();
if (MODE === "wedged") process.on("SIGTERM", () => {});
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: "tree-codex" } }) + "\\n");
  }
  if (message.method === "initialized" && (MODE === "late" || MODE === "crash")) {
    setTimeout(() => {
      pids.late = spawn(process.execPath, idle, { stdio: "ignore", detached: true }).pid;
      record();
    }, 100);
    if (MODE === "crash") setTimeout(() => process.exit(1), 600);
  }
});
rl.on("close", () => {
  if (MODE !== "wedged") process.exit(0);
});
`
  );
  return pidsFile;
}

async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

function readPids(pidsFile) {
  return JSON.parse(fs.readFileSync(pidsFile, "utf8"));
}

// Zombie-aware: a killed child stays in the table until init reaps it, and that is not a leak.
function survivors(pids) {
  return Object.entries(pids)
    .filter(([, pid]) => isProcessRunning(pid))
    .map(([name]) => name);
}

async function startTreeBroker(t, mode, extraEnv = {}) {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  const pidsFile = installTreeCodex(binDir, mode);
  const env = {
    ...process.env,
    CODEX_HOME: path.join(binDir, "codex-home"),
    PATH: `${binDir}:${process.env.PATH}`,
    ...extraEnv
  };
  const session = await ensureBrokerSession(workspace, { env });
  assert.ok(session?.pid, "the broker must start");
  assert.ok(await waitFor(() => fs.existsSync(pidsFile)), "the fake app-server must record its children");
  t.after(() => {
    // Whatever the assertions found, leave nothing behind for the rest of the suite.
    for (const pid of [session.pid, ...Object.values(readPids(pidsFile))]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });
  return { workspace, session, pidsFile };
}

test(
  "a session-end shutdown takes the app-server's children with it",
  { skip: process.platform === "win32" },
  async (t) => {
    const { workspace, pidsFile } = await startTreeBroker(t, "clean");
    const pids = readPids(pidsFile);

    // The app-server leaves cleanly, but its children do not leave with it. Before they were
    // reaped, they also kept the broker's process group alive, so this very call failed with
    // "ownership changed before forced shutdown" and the session record was preserved.
    const outcome = await shutdownBrokerSession(workspace, { killProcess: terminateProcessTree });
    assert.equal(outcome.exited, true);
    assert.equal(loadBrokerSession(workspace), null);

    assert.ok(await waitFor(() => survivors(pids).length === 0), `still running: ${survivors(pids).join(", ")}`);
  }
);

test(
  "a child started after the last reading is found when shutdown begins",
  { skip: process.platform === "win32" },
  async (t) => {
    // No periodic reading at all: only the startup one, which ran before the late child existed,
    // and the one shutdown takes while the app-server is still up to lead to it.
    const { workspace, pidsFile } = await startTreeBroker(t, "late", { CODEX_BROKER_PROCESS_SCAN_MS: "0" });
    assert.ok(await waitFor(() => readPids(pidsFile).late), "the fake app-server must start its late child");
    const pids = readPids(pidsFile);

    const outcome = await shutdownBrokerSession(workspace, { killProcess: terminateProcessTree });
    assert.equal(outcome.exited, true);
    assert.ok(await waitFor(() => survivors(pids).length === 0), `still running: ${survivors(pids).join(", ")}`);
  }
);

test(
  "an idle shutdown kills an app-server that ignores the close, and everything it started",
  { skip: process.platform === "win32" },
  async (t) => {
    const { session, pidsFile } = await startTreeBroker(t, "wedged", {
      CODEX_BROKER_IDLE_SHUTDOWN_MS: "200"
    });
    const pids = readPids(pidsFile);

    // Nothing is waiting on this broker: no hook, no client. The group SIGKILL meant for a wedged
    // app-server used to sit on a timer that the caller's own exit cancelled, so the app-server
    // and the child ignoring SIGTERM both outlived it.
    assert.ok(await waitFor(() => !isProcessRunning(session.pid)), "the broker must leave on its own");
    assert.ok(await waitFor(() => survivors(pids).length === 0), `still running: ${survivors(pids).join(", ")}`);
  }
);

test(
  "a child orphaned by an app-server crash is still reaped",
  { skip: process.platform === "win32" },
  async (t) => {
    const { session, pidsFile } = await startTreeBroker(t, "crash", {
      CODEX_BROKER_PROCESS_SCAN_MS: "50"
    });

    // The late child is started after the startup reading and sits in a group of its own; by the
    // time the broker shuts down its parent is dead and it has been reparented, so only an
    // earlier periodic reading can still lead to it.
    assert.ok(await waitFor(() => readPids(pidsFile).late), "the fake app-server must start its late child");
    const pids = readPids(pidsFile);

    assert.ok(await waitFor(() => !isProcessRunning(session.pid)), "the broker must leave with its app-server");
    assert.ok(await waitFor(() => survivors(pids).length === 0), `still running: ${survivors(pids).join(", ")}`);
  }
);
