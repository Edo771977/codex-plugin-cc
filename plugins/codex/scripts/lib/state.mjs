import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ensurePrivateDir,
  removeFileIfExists,
  writeJsonFileAtomic
} from "./fs.mjs";
import { withLockSync } from "./locking.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const CODEX_HOME_ENV = "CODEX_HOME";
const CONFIG_DIR_NAME = path.join("plugin-cc", "config");
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const MIN_TERMINAL_JOBS = 10;

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

function resolveWorkspaceKey(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }
  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  return `${slug}-${hash}`;
}

export function resolveStateDir(cwd) {
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, resolveWorkspaceKey(cwd));
}

export function resolveConfigFile(cwd) {
  const codexHome = path.resolve(process.env[CODEX_HOME_ENV] || path.join(os.homedir(), ".codex"));
  return path.join(codexHome, CONFIG_DIR_NAME, `${resolveWorkspaceKey(cwd)}.json`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  const stateDir = resolveStateDir(cwd);
  const jobsDir = resolveJobsDir(cwd);
  for (const dir of [stateDir, jobsDir]) {
    ensurePrivateDir(dir);
  }
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

// Shared by the pruner, the session-end broker guard, and the dead-worker
// reaper: "what pins the broker" and "what survives pruning" must agree.
export function isActiveJob(job) {
  return job.status === "queued" || job.status === "running";
}

function pruneJobs(jobs) {
  const sorted = [...jobs].sort((left, right) =>
    String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
  );
  if (sorted.length <= MAX_JOBS) {
    return sorted;
  }
  // Never prune active records, however old: dropping one would hide
  // in-flight work from the session-end broker guard and delete the running
  // worker's files out from under it. Only terminal records age out — and a
  // floor keeps the newest terminal records retained even when active jobs
  // consume the whole cap, so a job finishing alongside many active peers
  // does not vanish the moment it completes.
  let terminalBudget = Math.max(MIN_TERMINAL_JOBS, MAX_JOBS - sorted.filter(isActiveJob).length);
  return sorted.filter((job) => {
    if (isActiveJob(job)) {
      return true;
    }
    if (terminalBudget > 0) {
      terminalBudget -= 1;
      return true;
    }
    return false;
  });
}

function resolveStateLockDir(cwd) {
  return path.join(resolveStateDir(cwd), ".state.lock");
}

function saveStateLocked(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeFileIfExists(resolveJobFile(cwd, job.id));
    removeFileIfExists(resolveJobClaimFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  writeJsonFileAtomic(resolveStateFile(cwd), nextState);
  return nextState;
}

export function saveState(cwd, state) {
  ensureStateDir(cwd);
  return withLockSync(resolveStateLockDir(cwd), () => saveStateLocked(cwd, state));
}

export function updateState(cwd, mutate) {
  ensureStateDir(cwd);
  return withLockSync(resolveStateLockDir(cwd), () => {
    const state = loadState(cwd);
    mutate(state);
    return saveStateLocked(cwd, state);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

function readDurableConfig(cwd) {
  const configFile = resolveConfigFile(cwd);
  if (!fs.existsSync(configFile)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile, "utf8"));
    return { ...defaultState().config, ...(parsed ?? {}) };
  } catch {
    return null;
  }
}

function writeDurableConfig(cwd, config) {
  const configFile = resolveConfigFile(cwd);
  // Every other artifact this module creates is private and written
  // atomically; the durable config is no different, and a partially written
  // file here would silently disable the review gate on the next read.
  ensurePrivateDir(path.dirname(configFile));
  const nextConfig = { ...defaultState().config, ...(config ?? {}) };
  writeJsonFileAtomic(configFile, nextConfig);
  return nextConfig;
}

export function setConfig(cwd, key, value) {
  const nextConfig = writeDurableConfig(cwd, { ...getConfig(cwd), [key]: value });
  updateState(cwd, (state) => {
    state.config = { ...state.config, ...nextConfig };
  });
  return nextConfig;
}

export function getConfig(cwd) {
  return readDurableConfig(cwd) ?? loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  // Write-then-rename (via writeJsonFileAtomic) so concurrent readers never see
  // a torn record: the enqueue rewrites this file (merging the worker pid) at
  // the same moment the detached worker's startup reads it, and a
  // truncate-in-place write hands that reader invalid JSON.
  writeJsonFileAtomic(jobFile, payload);
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

export function resolveJobClaimFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.terminal`);
}
