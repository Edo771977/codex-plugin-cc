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
import {
  getProcessIdentity,
  isProcessRunning,
  terminateProcessTree
} from "../plugins/codex/scripts/lib/process.mjs";
import { makeTempDir, writeExecutable } from "./helpers.mjs";

// A codex stand-in whose app-server starts the kind of children a real one does — an MCP server
// in the broker's process group, one that moved to a group of its own, and one that ignores
// SIGTERM — and records their pids. `mode` decides how the app-server itself leaves:
//   clean   exits as soon as its stdin closes
//   wedged  ignores both the close and SIGTERM
//   late    like clean, but starts one more child after the handshake, in a group of its own
//   crash   starts that same late child, then dies
//   daemon  like clean, plus a build client that starts a daemon in a session of its own
// Every child gives up on its own after two minutes, so a failing test cannot strand it for good.
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
const LIFETIME = "setTimeout(() => process.exit(0), 120000);";
const idle = ["-e", "setInterval(() => {}, 1000); " + LIFETIME];
const pids = { app: process.pid };
function record() {
  fs.writeFileSync(PIDS + ".tmp", JSON.stringify(pids));
  fs.renameSync(PIDS + ".tmp", PIDS);
}
pids.sameGroup = spawn(process.execPath, idle, { stdio: "ignore" }).pid;
pids.ownGroup = spawn(process.execPath, idle, { stdio: "ignore", detached: true }).pid;
pids.stubborn = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); " + LIFETIME], { stdio: "ignore" }).pid;
record();
if (MODE === "daemon") {
  const client = spawn(
    process.execPath,
    ["-e", "const d = require('node:child_process').spawn(process.execPath, " + JSON.stringify(idle) + ", { stdio: 'ignore', detached: true }); process.stdout.write(String(d.pid)); setInterval(() => {}, 1000); " + LIFETIME],
    { stdio: ["ignore", "pipe", "ignore"] }
  );
  pids.client = client.pid;
  client.stdout.once("data", (chunk) => {
    pids.daemon = Number(String(chunk));
    record();
  });
}
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
  try {
    return JSON.parse(fs.readFileSync(pidsFile, "utf8"));
  } catch {
    return {};
  }
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
  // Registered before anything can fail, and lazy: whatever the assertions found, leave nothing
  // behind for the rest of the suite. Each pid is pinned to the process it named when the test saw
  // it, so a pid reused since is never killed.
  const seen = new Map();
  const pin = (pid) => {
    if (Number.isInteger(pid) && !seen.has(pid)) {
      seen.set(pid, getProcessIdentity(pid));
    }
  };
  let brokerPid = null;
  t.after(() => {
    pin(brokerPid);
    for (const pid of Object.values(readPids(pidsFile))) {
      pin(pid);
    }
    for (const [pid, identity] of seen) {
      if (identity && isProcessRunning(pid, { identity })) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  });
  const session = await ensureBrokerSession(workspace, { env });
  brokerPid = session?.pid ?? null;
  pin(brokerPid);
  assert.ok(session?.pid, "the broker must start");
  assert.ok(await waitFor(() => fs.existsSync(pidsFile)), "the fake app-server must record its children");
  for (const pid of Object.values(readPids(pidsFile))) {
    pin(pid);
  }
  return { workspace, session, pidsFile, pin };
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
  "a daemon a command started in a session of its own outlives the broker",
  { skip: process.platform !== "linux" },
  async (t) => {
    // A Gradle daemon, an ssh ControlPersist master, another workspace's broker: each passes
    // through the app-server's tree on its way to a session of its own, then serves others.
    const { workspace, pidsFile, pin } = await startTreeBroker(t, "daemon");
    assert.ok(await waitFor(() => readPids(pidsFile).daemon), "the build client must start its daemon");
    const { daemon, ...ours } = readPids(pidsFile);
    pin(daemon);
    // The reading shutdown takes still finds the daemon below its client; it is left alone anyway.
    const outcome = await shutdownBrokerSession(workspace, { killProcess: terminateProcessTree });
    assert.equal(outcome.exited, true);

    assert.ok(await waitFor(() => survivors(ours).length === 0), `still running: ${survivors(ours).join(", ")}`);
    assert.equal(isProcessRunning(daemon), true, "the daemon is not the broker's to stop");
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
