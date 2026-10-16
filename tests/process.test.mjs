import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  binaryAvailable,
  commandWithWindowsShim,
  createProcessTreeTracker,
  descendantsOf,
  forceKillProcessTree,
  getProcessIdentity,
  isProcessRunning,
  isProcessTreeRunning,
  listProcesses,
  processHasLaunchSequence,
  runCommand,
  runCommandChecked,
  terminateProcessTree,
  waitForProcessExit
} from "../plugins/codex/scripts/lib/process.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SELF_TERMINATING_SCRIPT = "process.kill(process.pid, 'SIGTERM'); setInterval(() => {}, 1000);";

test("runCommand reports a signal-terminated process as a failure", { skip: process.platform === "win32" }, () => {
  const result = runCommand(process.execPath, ["-e", SELF_TERMINATING_SCRIPT]);

  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.status, null);
});

test("runCommandChecked throws when the process dies from a signal", { skip: process.platform === "win32" }, () => {
  assert.throws(
    () => runCommandChecked(process.execPath, ["-e", SELF_TERMINATING_SCRIPT]),
    /signal=SIGTERM/
  );
});

test("Linux zombie processes are treated as exited even when signal 0 succeeds", () => {
  const running = isProcessRunning(1234, {
    platform: "linux",
    killImpl() {},
    readProcessStat() {
      return { state: "Z", startTime: "42" };
    }
  });

  assert.equal(running, false);
});

test("Linux processes with unreadable /proc metadata stay running", () => {
  const running = isProcessRunning(1234, {
    platform: "linux",
    identity: "42",
    killImpl() {},
    readProcessStat() {
      return null;
    }
  });

  assert.equal(running, true);
});

test("macOS process identity uses the process start time", () => {
  let captured = null;
  const identity = getProcessIdentity(1234, {
    platform: "darwin",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "Fri Jul 25 01:02:03 2026\n",
        stderr: "",
        error: null
      };
    }
  });

  assert.deepEqual(captured, {
    command: "ps",
    args: ["-ww", "-p", "1234", "-o", "lstart="]
  });
  assert.equal(identity, "Fri Jul 25 01:02:03 2026");
});

test("Windows process identity uses PowerShell start-time ticks", () => {
  let capturedCommand = null;
  const identity = getProcessIdentity(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      capturedCommand = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "638890021230000000",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(capturedCommand.command, "powershell.exe");
  assert.match(capturedCommand.args.at(-1), /Get-Process -Id 1234/);
  assert.equal(identity, "638890021230000000");
});

test("non-Linux process identity distinguishes a reused PID", () => {
  const running = isProcessRunning(1234, {
    platform: "darwin",
    identity: "original-start",
    killImpl() {},
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "replacement-start\n",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(running, false);
});

test("process launch sequence fallback requires arguments in order", () => {
  const runCommandImpl = (command, args) => ({
    command,
    args,
    status: 0,
    signal: null,
    stdout: "node app-server-broker.mjs serve --endpoint pipe:broker --cwd /workspace --pid-file /tmp/broker.pid",
    stderr: "",
    error: null
  });

  assert.equal(
    processHasLaunchSequence(
      1234,
      ["serve", "--endpoint", "pipe:broker", "--cwd", "/workspace", "--pid-file", "/tmp/broker.pid"],
      { platform: "darwin", runCommandImpl }
    ),
    true
  );
  assert.equal(
    processHasLaunchSequence(1234, ["--cwd", "/workspace", "--endpoint", "pipe:broker"], {
      platform: "darwin",
      runCommandImpl
    }),
    false
  );
});

test("runCommand allows output larger than Node's default maxBuffer", () => {
  const outputBytes = 2 * 1024 * 1024;
  const result = runCommand(process.execPath, [
    "-e",
    `process.stdout.write("x".repeat(${outputBytes}))`
  ]);

  assert.equal(result.error, null);
  assert.equal(result.status, 0);
  assert.equal(Buffer.byteLength(result.stdout), outputBytes);
});

test("runCommand preserves an explicit maxBuffer override", () => {
  const result = runCommand(
    process.execPath,
    ["-e", `process.stdout.write("x".repeat(${2 * 1024}))`],
    { maxBuffer: 1024 }
  );

  assert.equal(result.error?.code, "ENOBUFS");
});

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args, options) {
      captured = { command, args, shell: options?.shell };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl(pid, signal) {
      assert.equal(pid, 1234);
      assert.equal(signal, 0);
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"],
    // Never through a shell: under Git Bash, MSYS path conversion rewrites
    // /PID into a filesystem path and every kill fails with "Invalid
    // argument/option", leaving background workers unkillable.
    shell: false
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree uses liveness instead of localized taskkill output", () => {
  let livenessChecks = 0;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "",
        stderr: "Erreur : le processus \"1234\" est introuvable.",
        error: null
      };
    },
    killImpl(pid, signal) {
      assert.equal(pid, 1234);
      assert.equal(signal, 0);
      livenessChecks += 1;
      if (livenessChecks === 1) {
        return;
      }
      const error = new Error("ESRCH");
      error.code = "ESRCH";
      throw error;
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.equal(livenessChecks, 2);
});

test("terminateProcessTree reports delivery when taskkill only failed on already-exiting descendants", () => {
  let livenessChecks = 0;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "SUCCESS: The process with PID 1234 has been terminated.",
        stderr:
          "ERROR: The process with PID 5678 (child process of PID 1234) could not be terminated.\n" +
          "Reason: The operation attempted is not supported.",
        error: null
      };
    },
    killImpl(pid, signal) {
      assert.equal(pid, 1234);
      assert.equal(signal, 0);
      livenessChecks += 1;
      if (livenessChecks === 1) {
        return;
      }
      const error = new Error("ESRCH");
      error.code = "ESRCH";
      throw error;
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.equal(livenessChecks, 2);
});

test("terminateProcessTree still throws when taskkill fails and the root process survives", () => {
  assert.throws(
    () =>
      terminateProcessTree(1234, {
        platform: "win32",
        runCommandImpl(command, args) {
          return {
            command,
            args,
            status: 128,
            signal: null,
            stdout: "",
            stderr: "ERROR: The process with PID 1234 could not be terminated.\nReason: Access is denied.",
            error: null
          };
        },
        killImpl(pid, signal) {
          assert.equal(pid, 1234);
          assert.equal(signal, 0);
        }
      }),
    /could not be terminated/
  );
});

test("terminateProcessTree skips taskkill when the Windows process is already absent", () => {
  let taskkillCalled = false;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      taskkillCalled = true;
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "",
        stderr: "Erreur : le processus \"1234\" est introuvable.",
        error: null
      };
    },
    killImpl(pid, signal) {
      assert.equal(pid, 1234);
      assert.equal(signal, 0);
      const error = new Error("ESRCH");
      error.code = "ESRCH";
      throw error;
    }
  });

  assert.equal(taskkillCalled, false);
  assert.deepEqual(outcome, {
    attempted: false,
    delivered: false,
    method: null
  });
});

test("terminateProcessTree does not treat a Windows preflight permission error as missing", () => {
  let taskkillCalled = false;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      taskkillCalled = true;
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl(pid, signal) {
      assert.equal(pid, 1234);
      assert.equal(signal, 0);
      const error = new Error("EPERM");
      error.code = "EPERM";
      throw error;
    }
  });

  assert.equal(taskkillCalled, true);
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree preserves the Windows ENOENT fallback", () => {
  const killCalls = [];
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      const error = new Error("ENOENT");
      error.code = "ENOENT";
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error
      };
    },
    killImpl(pid, signal) {
      killCalls.push([pid, signal]);
    }
  });

  assert.deepEqual(killCalls, [
    [1234, 0],
    [1234, undefined]
  ]);
  assert.deepEqual(outcome, {
    attempted: true,
    delivered: true,
    method: "kill"
  });
});

test("terminateProcessTree leaves the non-Windows process-group path unchanged", () => {
  const killCalls = [];
  const outcome = terminateProcessTree(1234, {
    platform: "linux",
    killImpl(pid, signal) {
      killCalls.push([pid, signal]);
    }
  });

  assert.deepEqual(killCalls, [[-1234, "SIGTERM"]]);
  assert.deepEqual(outcome, {
    attempted: true,
    delivered: true,
    method: "process-group"
  });
});

test("a dead group leader with a surviving descendant still counts as a running tree", { skip: process.platform === "win32" }, async () => {
  // The leader spawns a grandchild without detaching it: an un-detached
  // child inherits its parent's process group (standard POSIX fork/exec
  // behavior), so the grandchild keeps the leader's original group alive
  // long after the leader itself has exited and been reaped.
  const leaderScript = `
    const { spawn } = require("node:child_process");
    const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    grandchild.unref();
    setTimeout(() => process.exit(0), 200);
  `;
  const leader = spawn(process.execPath, ["-e", leaderScript], {
    detached: true,
    stdio: "ignore"
  });
  await new Promise((resolve, reject) => {
    leader.once("spawn", resolve);
    leader.once("error", reject);
  });
  const leaderPid = leader.pid;

  try {
    const recordedIdentity = getProcessIdentity(leaderPid);
    assert.ok(recordedIdentity, "expected a recordable identity while the leader is alive");

    // Poll for the leader's own exit instead of a fixed sleep: its script
    // exits itself after ~200ms, but scheduling jitter under test-suite load
    // must not make this flaky.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && isProcessRunning(leaderPid)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(isProcessRunning(leaderPid), false, "the leader should have exited and been reaped by now");

    // The leader is gone, but the grandchild it left behind is still in the
    // leader's original process group. A live descendant must still read as
    // a running tree, matched against the identity recorded while the
    // leader itself was alive.
    assert.equal(
      isProcessTreeRunning(leaderPid, { identity: recordedIdentity }),
      true,
      "a surviving descendant must keep the recorded process group alive"
    );
  } finally {
    // The leader is already dead; -leaderPid still addresses the process
    // group as long as at least one member (the grandchild) survives.
    try {
      process.kill(-leaderPid, "SIGTERM");
    } catch {
      // Group may already be gone.
    }
    let exited = await waitForProcessExit(leaderPid, { timeoutMs: 2000 });
    if (!exited) {
      try {
        process.kill(-leaderPid, "SIGKILL");
      } catch {
        // Already gone between the check above and here.
      }
      exited = await waitForProcessExit(leaderPid, { timeoutMs: 2000 });
    }
    assert.equal(exited, true, "cleanup must confirm the test process exited");
  }
});

test("commandWithWindowsShim avoids shell:true on Windows", () => {
  assert.deepEqual(
    commandWithWindowsShim("codex", ["app-server"], {
      platform: "win32",
      comspec: "C:\\Windows\\System32\\cmd.exe"
    }),
    {
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "call", "codex", "app-server"],
      shell: false
    }
  );
});

test("binaryAvailable uses cmd.exe explicitly for Windows command shims", () => {
  let captured = null;
  const outcome = binaryAvailable("npm", ["--version"], {
    platform: "win32",
    comspec: "C:\\Windows\\System32\\cmd.exe",
    runCommandImpl(command, args, options) {
      captured = { command, args, options };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "11.16.0\n",
        stderr: "",
        error: null
      };
    }
  });

  assert.deepEqual(captured, {
    command: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", "call", "npm", "--version"],
    options: { cwd: undefined, env: undefined, shell: false }
  });
  assert.deepEqual(outcome, { available: true, detail: "11.16.0" });
});

test("forceKillProcessTree reaches descendants on Windows instead of signalling a negative pid", () => {
  let captured = null;
  const outcome = forceKillProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args, options) {
      captured = { command, args, shell: options?.shell };
      return { command, args, status: 0, signal: null, stdout: "", stderr: "", error: null };
    },
    killImpl(pid) {
      // Windows has no process groups: OpenProcess on a negative pid fails, so a
      // catch-and-retry would degrade to killing the worker alone and orphan the
      // app-server (and every MCP server) underneath it.
      throw new Error(`process.kill must not be used on Windows (called with ${pid})`);
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"],
    shell: false
  });
  assert.deepEqual(outcome, { attempted: true, delivered: true, method: "taskkill" });
});

test("forceKillProcessTree never throws when the Windows tree cannot be reached", () => {
  const outcome = forceKillProcessTree(1234, {
    platform: "win32",
    // A root that reads as live, so the pre-kill probe does not short-circuit the taskkill this
    // test is about. Injected rather than real: otherwise the outcome would depend on whether
    // pid 1234 happens to exist on the machine running the suite.
    killImpl() {},
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 1,
        signal: null,
        stdout: "",
        stderr: "ERROR: Access is denied.",
        error: null
      };
    }
  });

  assert.deepEqual(outcome, { attempted: true, delivered: false, method: "taskkill" });
});

test("forceKillProcessTree SIGKILLs the process group on POSIX", () => {
  const signalled = [];
  const outcome = forceKillProcessTree(1234, {
    platform: "linux",
    killImpl(pid, signal) {
      signalled.push({ pid, signal });
    }
  });

  assert.deepEqual(signalled, [{ pid: -1234, signal: "SIGKILL" }]);
  assert.equal(outcome.method, "process-group");
  assert.equal(outcome.delivered, true);
});

test("forceKillProcessTree falls back to the process when it leads no group", () => {
  const signalled = [];
  const outcome = forceKillProcessTree(1234, {
    platform: "linux",
    killImpl(pid, signal) {
      signalled.push({ pid, signal });
      if (pid < 0) {
        const error = new Error("No such process");
        error.code = "ESRCH";
        throw error;
      }
    }
  });

  assert.deepEqual(signalled, [
    { pid: -1234, signal: "SIGKILL" },
    { pid: 1234, signal: "SIGKILL" }
  ]);
  assert.equal(outcome.method, "process");
  assert.equal(outcome.delivered, true);
});

test("no plugin script force-kills through a negative pid outside the platform-guarded helpers", () => {
  // `kill(-pid, …)` addresses a process group, which exists only on POSIX; on Windows it is
  // an invalid handle, and a catch-and-retry on the bare pid silently orphans the descendants.
  // So a direct `process.kill(-pid)` is banned outright: group signalling belongs to the
  // platform-guarded helpers in process.mjs, which send it through an injectable `killImpl`
  // and pick taskkill on Windows.
  const scriptsDir = path.join(ROOT, "plugins", "codex", "scripts");
  const direct = new Set();
  const viaKillImpl = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".mjs")) {
        continue;
      }
      const relative = path.relative(ROOT, full).split(path.sep).join("/");
      for (const line of fs.readFileSync(full, "utf8").split("\n")) {
        const code = line.trim();
        if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) {
          continue;
        }
        if (/\bprocess\.kill\(\s*-/.test(code)) {
          direct.add(relative);
        } else if (/\bkill\w*\(\s*-/.test(code)) {
          viaKillImpl.add(relative);
        }
      }
    }
  };
  walk(scriptsDir);

  assert.deepEqual([...direct], []);
  assert.deepEqual([...viaKillImpl], ["plugins/codex/scripts/lib/process.mjs"]);
});

test("terminateProcessTree signals the process when it does not lead a process group", () => {
  const calls = [];
  const outcome = terminateProcessTree(1234, {
    platform: "linux",
    killImpl(pid, signal) {
      calls.push([pid, signal]);
      if (pid < 0) {
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      }
    }
  });

  assert.deepEqual(calls, [
    [-1234, "SIGTERM"],
    [1234, "SIGTERM"]
  ]);
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "process");
});

test("terminateProcessTree treats missing POSIX processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "linux",
    killImpl() {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.delivered, false);
});

// A process table the tracker reads through its injected seam: the tests move entries around
// (reparent, reuse a pid, ignore SIGTERM) without touching a real process.
function fakeProcessTable(entries, { ignoresTerm = [] } = {}) {
  const table = new Map(entries.map((entry) => [entry.pid, { ...entry }]));
  const signals = [];
  return {
    table,
    signals,
    list: () => [...table.values()].map((entry) => ({ ...entry })),
    kill(pid, signal) {
      signals.push([pid, signal]);
      if (!table.has(pid)) {
        const error = new Error("ESRCH");
        error.code = "ESRCH";
        throw error;
      }
      if (signal === "SIGKILL" || !ignoresTerm.includes(pid)) {
        table.delete(pid);
      }
    }
  };
}

const SELF = 100;
const APP = 200;

function trackerFor(fake, extra = {}) {
  return createProcessTreeTracker(APP, {
    selfPid: SELF,
    listProcessesImpl: fake.list,
    killImpl: fake.kill,
    sleepImpl: async () => {},
    ...extra
  });
}

test("descendantsOf follows parent links below the root and leaves the root out", () => {
  const table = [
    { pid: 1, parentPid: 0 },
    { pid: 10, parentPid: 1 },
    { pid: 11, parentPid: 10 },
    { pid: 12, parentPid: 11 },
    { pid: 20, parentPid: 1 }
  ];
  assert.deepEqual(
    descendantsOf(10, table).map((entry) => entry.pid),
    [11, 12]
  );
  assert.deepEqual(descendantsOf(20, table), []);
});

test("the tracker reaps a child that was reparented after it was remembered", async () => {
  const fake = fakeProcessTable([
    { pid: SELF, parentPid: 1, processGroup: 50, identity: "self" },
    { pid: APP, parentPid: SELF, processGroup: 50, identity: "app" },
    { pid: 300, parentPid: APP, processGroup: 300, identity: "mcp" }
  ]);
  const tracker = trackerFor(fake);
  tracker.remember();

  // The app-server exits on its own; its child is reparented to init and sits in a group of its
  // own, so neither parent links nor a group signal lead to it any more.
  fake.table.delete(APP);
  fake.table.get(300).parentPid = 1;
  tracker.remember();

  const outcome = await tracker.reap({ graceMs: 50 });
  assert.equal(outcome.known, true);
  assert.deepEqual(outcome.signalled, [300]);
  assert.equal(fake.table.has(300), false);
});

test("the tracker does not forget a process that one reading missed", async () => {
  const fake = fakeProcessTable([
    { pid: SELF, parentPid: 1, processGroup: 50, identity: "self" },
    { pid: APP, parentPid: SELF, processGroup: 50, identity: "app" },
    { pid: 300, parentPid: APP, processGroup: 300, identity: "mcp" }
  ]);
  const tracker = trackerFor(fake);
  tracker.remember();

  // One reading where its stat file could not be read: the process is absent from that table only.
  const hidden = fake.table.get(300);
  fake.table.delete(300);
  tracker.remember();
  fake.table.set(300, hidden);

  const outcome = await tracker.reap({ graceMs: 50 });
  assert.ok(outcome.signalled.includes(300));
});

test("the tracker never signals a pid that now belongs to a different process", async () => {
  const fake = fakeProcessTable([
    { pid: SELF, parentPid: 1, processGroup: 50, identity: "self" },
    { pid: APP, parentPid: SELF, processGroup: 50, identity: "app" },
    { pid: 300, parentPid: APP, processGroup: 300, identity: "mcp" }
  ]);
  const tracker = trackerFor(fake);
  tracker.remember();

  // The remembered child exits and the system hands its pid to an unrelated process.
  fake.table.set(300, { pid: 300, parentPid: 1, processGroup: 300, identity: "someone-else" });

  const outcome = await tracker.reap({ graceMs: 50 });
  assert.deepEqual(outcome.signalled, [APP]);
  assert.equal(fake.signals.some(([pid]) => pid === 300), false);
  assert.equal(fake.table.has(300), true);
});

test("the tracker reaps the process group named after it, and no one else's", async () => {
  const fake = fakeProcessTable([
    // A member, not the leader, of the group that started it — a shell's, say.
    { pid: SELF, parentPid: 1, processGroup: 50, identity: "self" },
    { pid: 51, parentPid: 1, processGroup: 50, identity: "shell" },
    // Started by something the tracker never saw, in the group it created: no remembered entry
    // leads to it, and only the group does.
    { pid: 400, parentPid: 1, processGroup: SELF, identity: "stray" }
  ]);
  const outcome = await trackerFor(fake).reap({ graceMs: 50 });
  assert.deepEqual(outcome.signalled, [400]);
  assert.deepEqual(fake.signals, [[400, "SIGTERM"]]);
});

test("the tracker escalates to SIGKILL only for what outlives the grace period", async () => {
  const fake = fakeProcessTable(
    [
      { pid: SELF, parentPid: 1, processGroup: 50, identity: "self" },
      { pid: APP, parentPid: SELF, processGroup: 50, identity: "app" },
      { pid: 301, parentPid: APP, processGroup: 50, identity: "polite" },
      { pid: 302, parentPid: APP, processGroup: 50, identity: "stubborn" }
    ],
    { ignoresTerm: [302] }
  );
  const tracker = trackerFor(fake);
  tracker.remember();

  const outcome = await tracker.reap({ graceMs: 50 });
  assert.deepEqual(outcome.signalled.sort(), [APP, 301, 302].sort());
  assert.deepEqual(outcome.killed, [302]);
  assert.deepEqual(
    fake.signals.filter(([, signal]) => signal === "SIGKILL"),
    [[302, "SIGKILL"]]
  );
  assert.deepEqual([...fake.table.keys()], [SELF]);
});

test("the tracker kills a child a survivor started during the grace period", async () => {
  const fake = fakeProcessTable(
    [
      { pid: SELF, parentPid: 1, processGroup: 50, session: SELF, identity: "self" },
      { pid: APP, parentPid: SELF, processGroup: 50, session: SELF, identity: "app" }
    ],
    { ignoresTerm: [APP] }
  );
  let polls = 0;
  const tracker = trackerFor(fake, {
    sleepImpl: async () => {
      polls += 1;
      if (polls === 1) {
        fake.table.set(500, { pid: 500, parentPid: APP, processGroup: 500, session: SELF, identity: "late" });
      }
    }
  });
  tracker.remember();

  const outcome = await tracker.reap({ graceMs: 50 });
  assert.ok(polls > 0);
  assert.deepEqual(outcome.killed.sort(), [APP, 500].sort());
  assert.deepEqual([...fake.table.keys()], [SELF]);
});

test("the tracker never signals itself or init", async () => {
  const fake = fakeProcessTable([
    { pid: 1, parentPid: 0, processGroup: SELF, identity: "init" },
    { pid: SELF, parentPid: 1, processGroup: SELF, identity: "self" },
    { pid: APP, parentPid: SELF, processGroup: SELF, identity: "app" }
  ]);
  const tracker = trackerFor(fake);
  tracker.remember();

  await tracker.reap({ graceMs: 50 });
  assert.deepEqual(fake.signals, [[APP, "SIGTERM"]]);
});

test("the tracker reports an unreadable process table instead of claiming a clean reap", async () => {
  const tracker = createProcessTreeTracker(APP, {
    selfPid: SELF,
    listProcessesImpl: () => null,
    killImpl: () => assert.fail("nothing may be signalled blind")
  });
  tracker.remember();
  assert.deepEqual(await tracker.reap(), { known: false, signalled: [], killed: [] });

  const throwing = createProcessTreeTracker(APP, {
    selfPid: SELF,
    listProcessesImpl: () => {
      throw new Error("ps went away");
    },
    killImpl: () => assert.fail("nothing may be signalled blind")
  });
  throwing.remember();
  assert.equal((await throwing.reap()).known, false);
});

test("the tracker leaves a daemon alone once it has left for a session of its own", async () => {
  // The app-server runs a build; the build client starts a daemon that detaches into a session of
  // its own and goes on serving the user's other builds after this broker is gone.
  const fake = fakeProcessTable([
    { pid: SELF, parentPid: 1, processGroup: SELF, session: SELF, identity: "self" },
    { pid: APP, parentPid: SELF, processGroup: SELF, session: SELF, identity: "app" },
    { pid: 310, parentPid: APP, processGroup: 310, session: SELF, identity: "build-client" },
    { pid: 311, parentPid: 310, processGroup: 311, session: SELF, identity: "build-worker" },
    { pid: 320, parentPid: 310, processGroup: 320, session: 320, identity: "daemon" },
    { pid: 321, parentPid: 320, processGroup: 320, session: 320, identity: "daemon-worker" }
  ]);
  const tracker = trackerFor(fake);
  tracker.remember();

  const outcome = await tracker.reap({ graceMs: 50 });
  assert.deepEqual(outcome.signalled.sort(), [APP, 310, 311].sort());
  assert.equal(fake.table.has(320), true, "the daemon serves others now");
  assert.equal(fake.table.has(321), true, "nothing below the daemon is followed");
});

test("the tracker still reaps a direct child of the root that detached, but nothing below it", async () => {
  // An MCP server the app-server started may detach into its own session; it is still ours. What
  // it started in turn is followed only while it stays in our session.
  const fake = fakeProcessTable([
    { pid: SELF, parentPid: 1, processGroup: SELF, session: SELF, identity: "self" },
    { pid: APP, parentPid: SELF, processGroup: SELF, session: SELF, identity: "app" },
    { pid: 330, parentPid: APP, processGroup: 330, session: 330, identity: "mcp" },
    { pid: 331, parentPid: 330, processGroup: 330, session: 330, identity: "mcp-helper" }
  ]);
  const tracker = trackerFor(fake);
  tracker.remember();

  const outcome = await tracker.reap({ graceMs: 50 });
  assert.deepEqual(outcome.signalled.sort(), [APP, 330].sort());
  assert.equal(fake.table.has(331), true);
});

test("without session ids the tracker reaps only the root, its direct children and its group", async () => {
  // What `ps` reports outside Linux: no session column, so leaving one cannot be told apart from
  // staying, and the tracker errs towards leaving a process running.
  const fake = fakeProcessTable([
    { pid: SELF, parentPid: 1, processGroup: SELF, session: null, identity: "self" },
    { pid: APP, parentPid: SELF, processGroup: SELF, session: null, identity: "app" },
    { pid: 340, parentPid: APP, processGroup: 340, session: null, identity: "command" },
    { pid: 341, parentPid: 340, processGroup: 341, session: null, identity: "maybe-a-daemon" },
    { pid: 342, parentPid: 340, processGroup: SELF, session: null, identity: "in-our-group" }
  ]);
  const tracker = trackerFor(fake);
  tracker.remember();

  const outcome = await tracker.reap({ graceMs: 50 });
  assert.deepEqual(outcome.signalled.sort(), [APP, 340, 342].sort());
  assert.equal(fake.table.has(341), true);
});

test("the tracker distrusts a reading that does not show the caller", async () => {
  const fake = fakeProcessTable([{ pid: APP, parentPid: 1, processGroup: SELF, session: SELF, identity: "app" }]);
  const tracker = trackerFor(fake);
  tracker.remember();
  assert.deepEqual(await tracker.reap(), { known: false, signalled: [], killed: [] });
  assert.deepEqual(fake.signals, []);
});

test("listProcesses parses ps output, keeps lstart whole, and leaves zombies out", () => {
  const calls = [];
  const entries = listProcesses({
    platform: "darwin",
    runCommandImpl: (command, args, options) => {
      calls.push({ command, args, env: options.env });
      return {
        status: 0,
        signal: null,
        error: null,
        // The ps that produced this reading, listing itself.
        pid: 104,
        stdout: [
          "  101     1   101 Ss   Thu Oct  2 09:15:01 2026",
          "  102   101   101 S+   Thu Oct  2 09:15:02 2026",
          "  103   101   103 Z    Thu Oct  2 09:15:03 2026",
          "  104   101   101 R+   Thu Oct  2 09:15:04 2026",
          "garbage"
        ].join("\n")
      };
    }
  });
  assert.equal(calls[0].command, "ps");
  // One -o per column: other BSDs read a single comma-separated list as one column plus a header.
  assert.deepEqual(calls[0].args, ["-axww", "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "stat=", "-o", "lstart="]);
  assert.equal(calls[0].env.LC_ALL, "C");
  assert.equal(calls[0].env.TZ, "UTC");
  assert.deepEqual(entries, [
    { pid: 101, parentPid: 1, processGroup: 101, session: null, identity: "Thu Oct 2 09:15:01 2026" },
    { pid: 102, parentPid: 101, processGroup: 101, session: null, identity: "Thu Oct 2 09:15:02 2026" }
  ]);
  assert.equal(listProcesses({ platform: "darwin", runCommandImpl: () => ({ status: 1, stdout: "" }) }), null);
  assert.equal(listProcesses({ platform: "win32" }), null);
});

test("listProcesses sees this process with its parent and group", { skip: process.platform === "win32" }, () => {
  const entries = listProcesses();
  assert.ok(Array.isArray(entries));
  const self = entries.find((entry) => entry.pid === process.pid);
  assert.ok(self, "the current process must be listed");
  assert.equal(self.parentPid, process.ppid);
  assert.ok(Number.isInteger(self.processGroup) && self.processGroup > 0);
  if (process.platform === "linux") {
    assert.equal(self.identity, getProcessIdentity(process.pid));
    assert.ok(Number.isInteger(self.session) && self.session > 0);
  } else {
    assert.ok(self.identity);
  }
});
