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
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});

test("terminateProcessTree reports delivery when taskkill only failed on already-exiting descendants", () => {
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
      const error = new Error("ESRCH");
      error.code = "ESRCH";
      throw error;
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
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
        killImpl() {
          return true;
        }
      }),
    /could not be terminated/
  );
});
