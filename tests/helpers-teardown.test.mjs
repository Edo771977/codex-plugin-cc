import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";

import { ensureBrokerSession, loadBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { isProcessRunning } from "../plugins/codex/scripts/lib/process.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir, teardownOwnedBrokers } from "./helpers.mjs";

/** Run `fn` with CLAUDE_PLUGIN_DATA set to `dir`, or unset for `undefined`. */
async function withPluginData(dir, fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  if (dir === undefined) {
    delete process.env.CLAUDE_PLUGIN_DATA;
  } else {
    process.env.CLAUDE_PLUGIN_DATA = dir;
  }
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
}

test(
  "the suite teardown finds a broker whose record lives under a test's own plugin-data root",
  { skip: process.platform === "win32" },
  async () => {
    const workspace = makeTempDir();
    const binDir = makeTempDir();
    const pluginData = makeTempDir();
    installFakeCodex(binDir);

    // What a hook run with its own CLAUDE_PLUGIN_DATA does: the record goes under that root.
    const session = await withPluginData(pluginData, () => ensureBrokerSession(workspace, { env: buildEnv(binDir) }));
    assert.ok(session?.pid);
    assert.equal(isProcessRunning(session.pid), true);
    assert.equal(
      await withPluginData(undefined, () => loadBrokerSession(workspace)),
      null,
      "without the variable the record is out of sight, which is how the broker used to leak"
    );

    const failures = await teardownOwnedBrokers([workspace, binDir, pluginData]);
    assert.deepEqual(failures, []);
    assert.equal(isProcessRunning(session.pid), false);
    assert.equal(await withPluginData(pluginData, () => loadBrokerSession(workspace)), null);
  }
);
