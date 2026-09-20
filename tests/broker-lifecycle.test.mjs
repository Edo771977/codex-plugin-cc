import net from "node:net";
import test from "node:test";
import assert from "node:assert/strict";

import { waitForBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

function hangingConnection() {
  return {
    setTimeout() {},
    on() {
      return this;
    },
    removeAllListeners() {},
    end() {},
    destroy() {}
  };
}

test("waitForBrokerEndpoint returns false when connect hangs past the timeout", { timeout: 2000 }, async (t) => {
  const originalCreateConnection = net.createConnection;
  net.createConnection = hangingConnection;
  t.after(() => {
    net.createConnection = originalCreateConnection;
  });

  const started = Date.now();
  const ready = await waitForBrokerEndpoint("unix:/tmp/codex-hung-broker.sock", 150);

  assert.equal(ready, false);
  assert.equal(Date.now() - started < 1000, true);
});
