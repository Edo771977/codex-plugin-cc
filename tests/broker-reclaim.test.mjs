import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createBrokerEndpoint,
  parseBrokerEndpoint
} from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import {
  ensureBrokerSession,
  loadBrokerSession,
  saveBrokerSession,
  spawnBrokerProcess
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

/**
 * A broker session whose files exist on disk, so we can see whether they survive.
 *
 * The endpoint must match what createBrokerEndpoint() would generate for this sessionDir on the
 * current platform (a named pipe on Windows, a Unix socket elsewhere) — ownership verification
 * compares the persisted endpoint against exactly that. `socketPath` is null on Windows: a pipe
 * has no filesystem artifact to plant or to check for.
 */
function plantSession(pid) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cxc-cwd-"));
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxc-session-"));
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const endpoint = createBrokerEndpoint(sessionDir);
  const target = parseBrokerEndpoint(endpoint);
  const socketPath = target.kind === "unix" ? target.path : null;
  fs.writeFileSync(pidFile, `${pid}\n`);
  fs.writeFileSync(logFile, "log\n");
  if (socketPath) {
    fs.writeFileSync(socketPath, "");
  }
  const session = { endpoint, pidFile, logFile, sessionDir, pid };
  saveBrokerSession(cwd, session);
  return { cwd, session, socketPath };
}

// The endpoint never answers, so the readiness probe fails either way; what differs is whether the
// process behind the record is still alive.
const nowhere = { scriptPath: path.join(os.tmpdir(), "cxc-does-not-exist.mjs"), timeoutMs: 50 };

test("a broker that is merely unresponsive keeps its files", async () => {
  // process.pid is unmistakably alive. Tearing this one down would delete a running broker's
  // socket without stopping it — it would keep its app-server and every MCP server underneath,
  // now unreachable and untracked.
  const { cwd, session, socketPath } = plantSession(process.pid);

  await ensureBrokerSession(cwd, nowhere).catch(() => {});

  assert.equal(fs.existsSync(session.pidFile), true, "pid file was removed");
  assert.equal(fs.existsSync(session.logFile), true, "log was removed");
  if (socketPath) {
    assert.equal(fs.existsSync(socketPath), true, "socket was removed");
  }

  fs.rmSync(session.sessionDir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("a broker that is gone is reclaimed", async () => {
  // A pid that is guaranteed dead: spawnSync only returns once the child has exited, and a fresh
  // pid is vanishingly unlikely to be reassigned to a live process before the assertions below run.
  const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
  const { cwd, session, socketPath } = plantSession(deadPid);

  await ensureBrokerSession(cwd, nowhere).catch(() => {});

  assert.equal(fs.existsSync(session.pidFile), false, "pid file survived");
  assert.equal(fs.existsSync(session.logFile), false, "log survived");
  if (socketPath) {
    assert.equal(fs.existsSync(socketPath), false, "socket survived");
  }
  assert.equal(loadBrokerSession(cwd), null, "record survived");

  fs.rmSync(session.sessionDir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("a broker is told its own log path", async () => {
  // Its record may name a successor by the time it shuts down, so it cannot rely on that to find
  // its own artifacts — it has to be given them at startup.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cxc-args-"));
  const argvFile = path.join(dir, "argv.json");
  const scriptPath = path.join(dir, "fake-broker.mjs");
  fs.writeFileSync(
    scriptPath,
    `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\n`
  );
  const logFile = path.join(dir, "broker.log");

  const child = spawnBrokerProcess({
    scriptPath,
    cwd: dir,
    endpoint: `unix:${path.join(dir, "broker.sock")}`,
    pidFile: path.join(dir, "broker.pid"),
    logFile,
    instanceToken: "test-instance-token-0123456789"
  });
  // spawnBrokerProcess() unref()s the child so a real broker never blocks its spawning client's
  // exit; ref() it back here so this test's own process waits for the fake broker's "exit" event
  // instead of racing an empty event loop to process shutdown.
  child.ref();
  await new Promise((resolve) => child.on("exit", resolve));

  const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
  assert.equal(argv[argv.indexOf("--log-file") + 1], logFile);
  fs.rmSync(dir, { recursive: true, force: true });
});
