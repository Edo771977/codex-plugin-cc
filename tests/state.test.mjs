import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import { readStoredJob } from "../plugins/codex/scripts/lib/job-control.mjs";
import { acquireLockSync, releaseLock } from "../plugins/codex/scripts/lib/locking.mjs";
import {
  getConfig,
  loadState,
  resolveConfigFile,
  listJobs,
  resolveJobFile,
  resolveJobLogFile,
  resolveJobsDir,
  resolveStateDir,
  resolveStateFile,
  saveState,
  setConfig,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";
import { createJobLogFile, runTrackedJob } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";

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

test("state, job, and log artifacts are private", { skip: process.platform === "win32" }, () => {
  const workspace = makeTempDir();
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: []
  });
  const jobFile = writeJobFile(workspace, "private-job", { prompt: "sensitive prompt" });
  const logFile = createJobLogFile(workspace, "private-job", "Private Job");

  assert.equal(fs.statSync(resolveStateDir(workspace)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(resolveJobsDir(workspace)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(resolveStateFile(workspace)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(jobFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);
});

test("review-gate config remains authoritative when CLAUDE_PLUGIN_DATA changes", () => {
  const workspace = makeTempDir();
  const codexHome = makeTempDir();
  const pluginDataA = makeTempDir();
  const pluginDataB = makeTempDir();
  const previousCodexHome = process.env.CODEX_HOME;
  const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  try {
    process.env.CODEX_HOME = codexHome;
    process.env.CLAUDE_PLUGIN_DATA = pluginDataA;
    setConfig(workspace, "stopReviewGate", true);
    process.env.CLAUDE_PLUGIN_DATA = pluginDataB;
    assert.equal(getConfig(workspace).stopReviewGate, true);
    setConfig(workspace, "stopReviewGate", false);
    process.env.CLAUDE_PLUGIN_DATA = pluginDataA;
    assert.equal(getConfig(workspace).stopReviewGate, false);
  } finally {
    if (previousCodexHome == null) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
    if (previousPluginData == null) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  }
});

// The reverse (state written *with* CLAUDE_PLUGIN_DATA set, later read with
// it unset) isn't fixable this way: an unset env var carries no trace of
// what value it previously held, so there's nothing to check beyond the
// always-known tmpdir fallback. This direction is the one with concrete
// real-world evidence in the issue (a broker registered under the tmpdir
// fallback, later orphaned by a lookup that ran with CLAUDE_PLUGIN_DATA set).
test("loadState finds state written without CLAUDE_PLUGIN_DATA when the current invocation has it set", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;

  try {
    delete process.env.CLAUDE_PLUGIN_DATA;
    saveState(workspace, { config: { stopReviewGate: true }, jobs: [] });

    process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
    const state = loadState(workspace);

    assert.equal(state.config.stopReviewGate, true);
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

// Caught in review: jobs are a growing collection, not a single pointer like
// the broker session -- a job started while CLAUDE_PLUGIN_DATA was set and a
// different job started while it was unset are both real and non-
// conflicting, so loadState() must merge every candidate's jobs rather than
// returning only the first state.json found (which would silently hide
// whichever root wasn't picked, for every status/result/cancel lookup, any
// time both roots happen to have a state.json -- a reachable legacy state
// after invocations alternated).
function writeStateFileDirectly(stateDir, state) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

test("loadState merges jobs from every candidate root instead of only the first found", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;

  try {
    // Written directly (not via saveState()) so this test exercises only
    // loadState()'s read-side merge, independent of saveState()'s own
    // write/deletion-propagation behavior (covered separately below).
    delete process.env.CLAUDE_PLUGIN_DATA;
    writeStateFileDirectly(resolveStateDir(workspace), {
      config: {},
      jobs: [{ id: "job-fallback", status: "running", updatedAt: "2026-08-19T00:00:00.000Z" }]
    });

    process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
    writeStateFileDirectly(resolveStateDir(workspace), {
      config: {},
      jobs: [{ id: "job-plugin-data", status: "running", updatedAt: "2026-08-19T00:01:00.000Z" }]
    });

    const state = loadState(workspace);
    const jobIds = state.jobs.map((job) => job.id).sort();

    assert.deepEqual(jobIds, ["job-fallback", "job-plugin-data"]);
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

// Caught in review: config (like jobs) can genuinely differ across roots --
// e.g. `/codex:setup --enable-review-gate` running without CLAUDE_PLUGIN_DATA
// writes stopReviewGate to the fallback root, which a later invocation with
// CLAUDE_PLUGIN_DATA set (a different primary) would never see if only the
// primary candidate's config were read. Unlike the sibling test above (only
// one root has state.json, so "primary" trivially picks the only candidate
// available either way), this exercises the actual bug: *both* roots have
// state, and the non-primary one is the one with the flag enabled.
test("loadState merges config across roots, preferring an enabled boolean over a stale disabled one", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;

  try {
    delete process.env.CLAUDE_PLUGIN_DATA;
    writeStateFileDirectly(resolveStateDir(workspace), {
      config: { stopReviewGate: true },
      jobs: []
    });

    process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
    writeStateFileDirectly(resolveStateDir(workspace), {
      config: { stopReviewGate: false },
      jobs: []
    });

    const state = loadState(workspace);

    assert.equal(state.config.stopReviewGate, true);
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

// Caught in review: merging reads across roots (the previous test) isn't
// enough on its own -- saveState() only ever wrote the new job list to the
// current primary root, so a job that originated in a *different* root and
// gets filtered out (e.g. cleanupSessionJobs() during SessionEnd, which
// loads the merged view, drops jobs for the ending session, and saves the
// remainder) never actually disappears: the other root's own state.json
// still has its own untouched copy, and the next loadState() merges it
// right back in. A "removed" job could keep reporting as running forever.
test("saveState persists a job removal across every candidate root, not just the current primary", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;

  try {
    // Setup writes both roots directly (not via saveState()), exactly like
    // the previous test -- a real caller always derives saveState()'s job
    // list from a prior loadState() (see updateState()/cleanupSessionJobs()
    // themselves), so seeding two roots via two independent, non-full-list
    // saveState() calls wouldn't reflect any real call pattern and would
    // trip the very deletion-propagation behavior under test here.
    delete process.env.CLAUDE_PLUGIN_DATA;
    writeStateFileDirectly(resolveStateDir(workspace), {
      config: {},
      jobs: [
        { id: "job-fallback-keep", status: "running", updatedAt: "2026-08-19T00:00:00.000Z" },
        { id: "job-fallback-remove", status: "running", updatedAt: "2026-08-19T00:00:00.000Z" }
      ]
    });

    process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
    writeStateFileDirectly(resolveStateDir(workspace), {
      config: {},
      jobs: [{ id: "job-plugin-data", status: "running", updatedAt: "2026-08-19T00:01:00.000Z" }]
    });

    // Mirrors cleanupSessionJobs(): load the merged view, drop one job that
    // originated entirely in the fallback root, save the remainder -- still
    // with CLAUDE_PLUGIN_DATA set, the same as a real SessionEnd hook.
    const merged = loadState(workspace);
    saveState(workspace, {
      ...merged,
      jobs: merged.jobs.filter((job) => job.id !== "job-fallback-remove")
    });

    const jobIdsAfterRemoval = loadState(workspace)
      .jobs.map((job) => job.id)
      .sort();

    assert.deepEqual(jobIdsAfterRemoval, ["job-fallback-keep", "job-plugin-data"]);
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("readStoredJob finds a job's detail file written without CLAUDE_PLUGIN_DATA when the current invocation has it set", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;

  try {
    delete process.env.CLAUDE_PLUGIN_DATA;
    const jobFile = resolveJobFile(workspace, "job-1");
    fs.writeFileSync(jobFile, JSON.stringify({ id: "job-1", status: "completed" }), "utf8");

    process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
    const job = readStoredJob(workspace, "job-1");

    assert.deepEqual(job, { id: "job-1", status: "completed" });
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

test("concurrent upsertJob calls from separate processes do not lose updates", async () => {
  const workspace = makeTempDir();
  const stateModuleUrl = pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "codex", "scripts", "lib", "state.mjs")
  ).href;
  const jobsPerWorker = 15;

  const spawnWorker = (prefix) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { upsertJob } from ${JSON.stringify(stateModuleUrl)};
           for (let index = 0; index < ${jobsPerWorker}; index++) {
             upsertJob(${JSON.stringify(workspace)}, { id: ${JSON.stringify(prefix)} + "-" + index });
           }`
        ],
        { stdio: ["ignore", "ignore", "pipe"] }
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`worker ${prefix} failed (code=${code} signal=${signal}): ${stderr}`));
      });
    });

  await Promise.all([spawnWorker("left"), spawnWorker("right")]);

  const jobIds = new Set(listJobs(workspace).map((job) => job.id));
  for (let index = 0; index < jobsPerWorker; index++) {
    assert.equal(jobIds.has(`left-${index}`), true, `missing left-${index}`);
    assert.equal(jobIds.has(`right-${index}`), true, `missing right-${index}`);
  }
});

test("saveState never prunes active jobs, however old their records are", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 52 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const jobFile = resolveJobFile(workspace, jobId);
    // The two oldest records belong to another session's in-flight work;
    // pruning them would hide the jobs from the session-end broker guard.
    const status = index <= 1 ? "running" : "completed";
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status }, null, 2), "utf8");
    return {
      id: jobId,
      status,
      updatedAt,
      createdAt: updatedAt
    };
  });

  const savedState = saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  assert.equal(savedState.jobs.length, 50);
  const retainedIds = new Set(savedState.jobs.map((job) => job.id));
  assert.equal(retainedIds.has("job-0"), true, "oldest running job must survive the prune");
  assert.equal(retainedIds.has("job-1"), true, "second running job must survive the prune");
  assert.equal(retainedIds.has("job-2"), false, "oldest terminal jobs age out instead");
  assert.equal(retainedIds.has("job-3"), false);
  assert.equal(fs.existsSync(resolveJobFile(workspace, "job-0")), true);
});

test("saveState keeps a newly terminal job even when active jobs fill the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    // The newest record is a job that just finished among 50 active peers;
    // it must not vanish the moment it completes.
    const status = index === 50 ? "completed" : "running";
    fs.writeFileSync(resolveJobFile(workspace, jobId), JSON.stringify({ id: jobId, status }, null, 2), "utf8");
    return { id: jobId, status, updatedAt, createdAt: updatedAt };
  });

  const savedState = saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const retainedIds = new Set(savedState.jobs.map((job) => job.id));
  assert.equal(retainedIds.has("job-50"), true, "the newly completed job must survive the prune");
  assert.equal(fs.existsSync(resolveJobFile(workspace, "job-50")), true);
  assert.equal(savedState.jobs.length, 51, "all 50 active jobs plus the fresh terminal record are retained");
});

test("writeJobFile never exposes a torn record to a concurrent reader", async (t) => {
  const { writeJobFile, readJobFile } = await import("../plugins/codex/scripts/lib/state.mjs");
  const workspace = makeTempDir();
  const jobId = "job-atomic";
  const jobFile = resolveJobFile(workspace, jobId);
  fs.mkdirSync(path.dirname(jobFile), { recursive: true });
  // A payload large enough that a truncate-in-place write leaves a torn
  // window a concurrent reader can observe (the enqueue rewrites this file
  // while the detached worker's startup reads it).
  const payload = { id: jobId, status: "queued", filler: "x".repeat(64 * 1024) };
  writeJobFile(workspace, jobId, payload);

  const { spawn } = await import("node:child_process");
  const readerScript = `
    const fs = require("node:fs");
    const deadline = Date.now() + 2000;
    let reads = 0;
    while (Date.now() < deadline) {
      try {
        JSON.parse(fs.readFileSync(${JSON.stringify(jobFile)}, "utf8"));
        reads++;
      } catch (error) {
        console.error("TORN-READ after " + reads + " reads: " + error.message);
        process.exit(1);
      }
    }
    console.log(reads);
  `;
  const reader = spawn(process.execPath, ["-e", readerScript], { stdio: ["ignore", "pipe", "pipe"] });
  let readerErr = "";
  reader.stderr.on("data", (chunk) => (readerErr += chunk));
  const done = new Promise((resolve) => reader.on("exit", resolve));

  const writeDeadline = Date.now() + 1900;
  while (Date.now() < writeDeadline) {
    writeJobFile(workspace, jobId, { ...payload, updatedAt: new Date().toISOString() });
  }

  const exitCode = await done;
  assert.equal(exitCode, 0, `concurrent reader observed a torn job record: ${readerErr.trim()}`);
  assert.deepEqual(readJobFile(jobFile).id, jobId);
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


test("the durable review-gate config is private", { skip: process.platform === "win32" }, () => {
  const workspace = makeTempDir();
  const codexHome = makeTempDir();
  const previousCodexHome = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = codexHome;
    setConfig(workspace, "stopReviewGate", true);

    const configFile = resolveConfigFile(workspace);
    // The gate decides whether Codex reviews every turn of this workspace, so
    // it gets the same treatment as every other artifact this module writes:
    // nobody else on the machine reads or rewrites it.
    assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(configFile)).mode & 0o777, 0o700);
  } finally {
    if (previousCodexHome == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
});

test("a durable config write that fails mid-write leaves the previous config intact", () => {
  const workspace = makeTempDir();
  const codexHome = makeTempDir();
  const previousCodexHome = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = codexHome;
    setConfig(workspace, "stopReviewGate", true);
    const configFile = resolveConfigFile(workspace);
    const before = fs.readFileSync(configFile, "utf8");

    // Fails inside writeJsonFileAtomic(), after it has created its temporary
    // file: the replacement is interrupted exactly where a crash or a full
    // disk would interrupt it. The gate decides whether Codex reviews every
    // turn, so a half-written file must never end up in its place -- that
    // would read back as unset and silently disable the gate.
    const explodingValue = {
      toJSON() {
        throw new Error("serialization failed mid-write");
      }
    };
    assert.throws(() => setConfig(workspace, "stopReviewGate", explodingValue), /serialization failed mid-write/);

    assert.equal(fs.readFileSync(configFile, "utf8"), before);
    assert.equal(getConfig(workspace).stopReviewGate, true);
    // The temporary file is cleaned up, so nothing is left to be mistaken for
    // the real config.
    assert.deepEqual(fs.readdirSync(path.dirname(configFile)), [path.basename(configFile)]);
  } finally {
    if (previousCodexHome == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
});


function withRoots(fn) {
  const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  const previousCodexHome = process.env.CODEX_HOME;
  const workspace = makeTempDir();
  const pluginData = makeTempDir();
  const codexHome = makeTempDir();
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  process.env.CODEX_HOME = codexHome;
  const primaryDir = resolveStateDir(workspace);
  // The second candidate is the tmpdir fallback a CLI invocation without
  // CLAUDE_PLUGIN_DATA resolves to.
  const fallbackDir = path.join(os.tmpdir(), "codex-companion", path.basename(primaryDir));
  fs.mkdirSync(fallbackDir, { recursive: true });
  try {
    return fn({ workspace, primaryDir, fallbackDir, codexHome });
  } finally {
    fs.rmSync(fallbackDir, { recursive: true, force: true });
    if (previousPluginData == null) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
    if (previousCodexHome == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
}

test("pruning another state root waits for nobody and clobbers nobody", () => {
  withRoots(({ workspace, fallbackDir }) => {
    const fallbackState = path.join(fallbackDir, "state.json");
    const foreignJob = { id: "task-foreign", status: "completed", updatedAt: "2026-01-01T00:00:00.000Z" };
    fs.writeFileSync(
      fallbackState,
      `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [foreignJob] }, null, 2)}\n`,
      "utf8"
    );

    // A process whose primary IS that root, mid-update.
    const held = acquireLockSync(path.join(fallbackDir, ".state.lock"));
    try {
      saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [] });
      // Rewriting it here would have thrown away whatever the lock holder is
      // about to write.
      const untouched = JSON.parse(fs.readFileSync(fallbackState, "utf8"));
      assert.deepEqual(untouched.jobs, [foreignJob]);
    } finally {
      releaseLock(held);
    }

    // Once nobody holds it, the same prune goes through.
    saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [] });
    assert.deepEqual(JSON.parse(fs.readFileSync(fallbackState, "utf8")).jobs, []);
  });
});

test("disabling the review gate is not outvoted by a stranded enable in another root", () => {
  withRoots(({ workspace, fallbackDir, codexHome }) => {
    setConfig(workspace, "stopReviewGate", true);
    // A root that was written while CLAUDE_PLUGIN_DATA was unset.
    fs.writeFileSync(
      path.join(fallbackDir, "state.json"),
      `${JSON.stringify({ version: 1, config: { stopReviewGate: true }, jobs: [] }, null, 2)}\n`,
      "utf8"
    );

    setConfig(workspace, "stopReviewGate", false);

    // With the durable config gone, getConfig() falls back to merging the
    // roots, where booleans are ORed. A stranded true would outvote this
    // disable forever unless the write reached that root too.
    fs.rmSync(path.join(codexHome, "plugin-cc"), { recursive: true, force: true });
    assert.equal(getConfig(workspace).stopReviewGate, false);
  });
});
