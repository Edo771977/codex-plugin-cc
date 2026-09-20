import test from "node:test";
import assert from "node:assert/strict";

import {
  BROKER_CONNECT_TIMEOUT_MS,
  CodexAppServerClient,
  resolveBrokerConnectTimeoutMs
} from "../plugins/codex/scripts/lib/app-server.mjs";

/** Reject rather than hang, so a wedged connect fails the test instead of stalling the run. */
function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

test("connect reports a malformed broker endpoint instead of hanging", async () => {
  // parseBrokerEndpoint throws before a socket exists, so cleanup has no transport to wait on.
  // Closing then awaited an exit nothing would ever report, and connect() never settled — a
  // configuration mistake turned into a hang.
  await assert.rejects(
    () =>
      withDeadline(
        CodexAppServerClient.connect(process.cwd(), { brokerEndpoint: "not-an-endpoint" }),
        5000,
        "connect"
      ),
    /Unsupported broker endpoint/
  );
});

test("connect reports an empty broker endpoint instead of hanging", async () => {
  await assert.rejects(
    () =>
      withDeadline(
        CodexAppServerClient.connect(process.cwd(), { brokerEndpoint: "unix:" }),
        5000,
        "connect"
      ),
    /missing its path/
  );
});

// A socket that is handed out but never connects, errors or closes: what a wedged endpoint looks
// like from the client's side. Everything the client attaches to it is a no-op, so only the
// connect deadline can end the attempt.
function neverSettlingSocket() {
  const handlers = new Map();
  const socket = {
    destroyed: false,
    handlers,
    setEncoding() {},
    setTimeout() {},
    on(event, handler) {
      handlers.set(event, handler);
      return socket;
    },
    write() {},
    end() {
      socket.destroy();
    },
    destroy() {
      if (socket.destroyed) {
        return;
      }
      socket.destroyed = true;
      // A real socket reports its own teardown, and the client's cleanup waits for that report:
      // a stub that stays silent here would hang the close path instead of the connect path.
      queueMicrotask(() => handlers.get("close")?.());
    }
  };
  return socket;
}

test("a broker connect that never settles is given up on, not waited on forever", async () => {
  const socket = neverSettlingSocket();
  await assert.rejects(
    () =>
      withDeadline(
        CodexAppServerClient.connect(process.cwd(), {
          brokerEndpoint: "unix:/tmp/codex-never-accepts.sock",
          connectTimeoutMs: 50,
          createConnection: () => socket
        }),
        5000,
        "connect"
      ),
    (error) => {
      assert.equal(error.code, "ETIMEDOUT");
      assert.match(error.message, /Timed out connecting to the Codex app-server broker/);
      return true;
    }
  );
  assert.equal(socket.destroyed, true, "the abandoned socket must not be left open");
});

test("a broker connect error is reported as itself, not as a timeout", async () => {
  // The deadline timer must not outlive the failure: the caller distinguishes ECONNREFUSED (fall
  // back to a direct app-server) from a timeout, and a masked code sends it down the wrong path.
  const socket = neverSettlingSocket();
  const connecting = CodexAppServerClient.connect(process.cwd(), {
    brokerEndpoint: "unix:/tmp/codex-refused.sock",
    connectTimeoutMs: 50_000,
    createConnection: () => socket
  });
  const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  socket.handlers.get("error")?.(refused);

  await assert.rejects(() => withDeadline(connecting, 5000, "connect"), /ECONNREFUSED/);
});

test("the broker connect budget defaults to 2s and honours an override", () => {
  assert.equal(resolveBrokerConnectTimeoutMs({}), BROKER_CONNECT_TIMEOUT_MS);
  assert.equal(BROKER_CONNECT_TIMEOUT_MS, 2000);
  assert.equal(resolveBrokerConnectTimeoutMs({ connectTimeoutMs: 75 }), 75);
  for (const unusable of [0, -1, "soon", null, undefined, Number.NaN]) {
    assert.equal(resolveBrokerConnectTimeoutMs({ connectTimeoutMs: unusable }), BROKER_CONNECT_TIMEOUT_MS);
  }
});
