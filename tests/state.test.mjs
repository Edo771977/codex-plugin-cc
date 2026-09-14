import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { resolveJobFile, resolveJobLogFile, resolveStateDir, resolveStateFile, saveState } from "../plugins/codex/scripts/lib/state.mjs";
import { runTrackedJob } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("runTrackedJob persists errorMessage on a non-throwing failed execution", async () => {
  const workspace = makeTempDir();
  const job = {
    id: "task-fail-nonthrowing",
    kind: "task",
    kindLabel: "Task",
    title: "Codex Task",
    workspaceRoot: workspace,
    jobClass: "task",
    summary: "",
    write: false,
    createdAt: new Date().toISOString()
  };

  await runTrackedJob(
    job,
    async () => ({
      exitStatus: 400,
      threadId: "thread-1",
      turnId: "turn-1",
      payload: { status: 400, rawOutput: "{\n  \"type\": \"error\"\n}", touchedFiles: [] },
      rendered: "rendered output\n",
      summary: "Unsupported value: 'x' is not supported.",
      errorMessage: "Unsupported value: 'x' is not supported with the 'gpt-5.6-terra' model."
    }),
    {}
  );

  const storedJob = JSON.parse(
    fs.readFileSync(resolveJobFile(workspace, job.id), "utf8")
  );
  const state = JSON.parse(fs.readFileSync(resolveStateFile(workspace), "utf8"));
  const indexed = state.jobs.find((entry) => entry.id === job.id);

  assert.equal(storedJob.status, "failed");
  assert.equal(storedJob.phase, "failed");
  assert.equal(
    storedJob.errorMessage,
    "Unsupported value: 'x' is not supported with the 'gpt-5.6-terra' model."
  );
  assert.equal(indexed.status, "failed");
  assert.equal(
    indexed.errorMessage,
    "Unsupported value: 'x' is not supported with the 'gpt-5.6-terra' model."
  );
  assert.equal(indexed.summary, "Unsupported value: 'x' is not supported.");
});

test("runTrackedJob stores no errorMessage for a completed execution", async () => {
  const workspace = makeTempDir();
  const job = {
    id: "task-ok",
    kind: "task",
    kindLabel: "Task",
    title: "Codex Task",
    workspaceRoot: workspace,
    jobClass: "task",
    summary: "",
    write: false,
    createdAt: new Date().toISOString()
  };

  await runTrackedJob(
    job,
    async () => ({
      exitStatus: 0,
      threadId: "thread-2",
      turnId: "turn-2",
      payload: { status: 0, rawOutput: "OK", touchedFiles: [] },
      rendered: "OK\n",
      summary: "OK",
      errorMessage: null
    }),
    {}
  );

  const storedJob = JSON.parse(
    fs.readFileSync(resolveJobFile(workspace, job.id), "utf8")
  );
  const state = JSON.parse(fs.readFileSync(resolveStateFile(workspace), "utf8"));
  const indexed = state.jobs.find((entry) => entry.id === job.id);

  assert.equal(storedJob.status, "completed");
  assert.equal(storedJob.errorMessage, null);
  assert.equal(indexed.status, "completed");
  assert.equal(indexed.errorMessage, null);
});
