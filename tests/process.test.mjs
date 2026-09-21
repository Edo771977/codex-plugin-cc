import test from "node:test";
import assert from "node:assert/strict";

import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
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
    args: ["/PID", "1234", "/T", "/F"]
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
