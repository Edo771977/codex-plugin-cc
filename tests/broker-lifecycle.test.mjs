import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { sendBrokerShutdown } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";

test("sendBrokerShutdown times out when the broker accepts but never responds", async (t) => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-broker-test-"));
  const endpoint = createBrokerEndpoint(sessionDir);
  const { path: endpointPath } = parseBrokerEndpoint(endpoint);
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
    if (process.platform !== "win32" && fs.existsSync(endpointPath)) {
      fs.unlinkSync(endpointPath);
    }
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpointPath, resolve);
  });

  const startedAt = Date.now();
  await sendBrokerShutdown(endpoint, 50);
  const elapsedMs = Date.now() - startedAt;

  assert.ok(elapsedMs >= 40, `expected timeout path, completed after ${elapsedMs}ms`);
  assert.ok(elapsedMs < 1000, `shutdown timeout exceeded test budget: ${elapsedMs}ms`);
});
