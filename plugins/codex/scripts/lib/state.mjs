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
const STATE_LOCK_DIR_NAME = ".state.lock";
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

// CLAUDE_PLUGIN_DATA is only present when the current invocation runs as a
// plugin hook; a directly-invoked CLI call (or a hook whose env didn't
// propagate it) resolves to the tmpdir fallback instead. Since the state
// root is derived from ambient environment rather than anything persisted,
// two invocations for the *same* workspace can land on different roots --
// the primary root is still the write target for new/updated state, but
// reads check every candidate so state written under one root is never
// invisible to a later invocation that resolves to the other.
function stateRootCandidates() {
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  return pluginDataDir
    ? [path.join(pluginDataDir, "state"), FALLBACK_STATE_ROOT_DIR]
    : [FALLBACK_STATE_ROOT_DIR];
}

export function resolveStateDir(cwd) {
  const [primaryRoot] = stateRootCandidates();
  return path.join(primaryRoot, resolveWorkspaceKey(cwd));
}

/**
 * All directories that could hold this workspace's state, primary root
 * first. Use for reads that must not miss state written under a different
 * root than the current invocation resolves to.
 */
export function resolveStateDirCandidates(cwd) {
  const dirName = resolveWorkspaceKey(cwd);
  return stateRootCandidates().map((root) => path.join(root, dirName));
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

function readStateFileIfValid(stateFile) {
  if (!fs.existsSync(stateFile)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

// Unlike the broker session (at most one meaningful record per workspace,
// so "first candidate found" is a correct selection), jobs are a growing
// collection that can genuinely differ across roots -- a job started while
// CLAUDE_PLUGIN_DATA was set and another started while it was unset are
// both real and non-conflicting. Returning only the first candidate's job
// list would silently hide whichever root wasn't picked, leaving the exact
// cross-root invisibility this fix targets for status/result/cancel
// whenever *both* roots happen to have a state.json (a reachable legacy
// state after invocations alternated). So every candidate's jobs are
// merged instead, keeping the more recently updated copy if the same job
// id somehow appears in more than one.
export function loadState(cwd) {
  const parsedCandidates = resolveStateDirCandidates(cwd)
    .map((stateDir) => readStateFileIfValid(path.join(stateDir, STATE_FILE_NAME)))
    .filter((parsed) => parsed != null);

  if (parsedCandidates.length === 0) {
    return defaultState();
  }

  const jobsById = new Map();
  for (const parsed of parsedCandidates) {
    for (const job of Array.isArray(parsed.jobs) ? parsed.jobs : []) {
      const existing = jobsById.get(job.id);
      if (!existing || String(job.updatedAt ?? "") > String(existing.updatedAt ?? "")) {
        jobsById.set(job.id, job);
      }
    }
  }

  // Like jobs, config can genuinely differ across roots depending on which
  // invocation wrote it -- e.g. `/codex:setup --enable-review-gate` running
  // without CLAUDE_PLUGIN_DATA writes stopReviewGate to the fallback root,
  // which a later invocation with CLAUDE_PLUGIN_DATA set would never see if
  // only the primary candidate's config were read. A boolean flag here is
  // an opt-in toward stricter/safer behavior, so any candidate setting it
  // true wins over a stale false elsewhere -- reconciling by "primary wins"
  // could silently downgrade an explicitly-enabled gate.
  //
  // Candidates are folded in reverse (fallback first, primary last) so the
  // primary root wins for anything that is not a boolean. The previous
  // "first writer wins" rule was dead for every key defaults already define —
  // which is all of them — so a non-boolean setting could never be read back
  // from any root.
  const mergedConfig = { ...defaultState().config };
  for (const parsed of [...parsedCandidates].reverse()) {
    for (const [key, value] of Object.entries(parsed.config ?? {})) {
      if (typeof value === "boolean") {
        mergedConfig[key] = mergedConfig[key] === true || value === true;
      } else {
        mergedConfig[key] = value;
      }
    }
  }

  const [primary] = parsedCandidates;
  return {
    ...defaultState(),
    ...primary,
    config: mergedConfig,
    jobs: [...jobsById.values()]
  };
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
  return path.join(resolveStateDir(cwd), STATE_LOCK_DIR_NAME);
}

// Rewriting another root's state.json is a read-modify-write on a file whose
// own lock is not the one saveState() holds: a process whose primary IS that
// root can be mid-update, and the rename would drop everything it just wrote.
// So take that root's lock too -- but never wait for it. Two processes holding
// each other's primary lock would deadlock, and this prune is not urgent: the
// pruned ids stay pruned in this root, and the next save re-runs it.
function pruneOtherStateRoot(otherStateDir, retainedIds) {
  const otherStateFile = path.join(otherStateDir, STATE_FILE_NAME);
  if (!fs.existsSync(otherStateFile)) {
    return;
  }
  try {
    withLockSync(
      path.join(otherStateDir, STATE_LOCK_DIR_NAME),
      () => {
        // Re-read under the lock: the copy this decision was made from could
        // have been replaced while the lock was being taken.
        const otherParsed = readStateFileIfValid(otherStateFile);
        const otherJobs = Array.isArray(otherParsed?.jobs) ? otherParsed.jobs : [];
        const prunedOtherJobs = otherJobs.filter((job) => retainedIds.has(job.id));
        if (prunedOtherJobs.length === otherJobs.length) {
          return;
        }
        writeJsonFileAtomic(otherStateFile, { ...otherParsed, jobs: prunedOtherJobs });
      },
      { timeoutMs: 0 }
    );
  } catch {
    // Busy or unlockable: leave that root alone rather than racing its owner.
  }
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
    for (const jobFile of resolveJobFileCandidates(cwd, job.id)) {
      removeFileIfExists(jobFile);
    }
    for (const claimFile of resolveJobClaimFileCandidates(cwd, job.id)) {
      removeFileIfExists(claimFile);
    }
    removeFileIfExists(job.logFile);
  }

  writeJsonFileAtomic(resolveStateFile(cwd), nextState);

  // previousJobs is the merged view across every candidate root (see loadState()),
  // so a job dropped from state.jobs here may have originated entirely in a root
  // other than the one just written above. Without this, that root's own
  // state.json still holds its own untouched copy, and the very next loadState()
  // merges it right back in -- deletions could never stick for a job that lives
  // only in a non-primary root. Prune every other candidate root down to the same
  // retained set; new and updated jobs are still only ever written to the primary
  // root, above. This only ever removes.
  const [, ...otherStateDirs] = resolveStateDirCandidates(cwd);
  for (const otherStateDir of otherStateDirs) {
    pruneOtherStateRoot(otherStateDir, retainedIds);
  }

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

// Same lock discipline as pruneOtherStateRoot(): that root's own lock, never
// waited on. A config copy this misses is corrected by the next write, and by
// the durable config, which is the authority.
function syncOtherStateRootConfig(otherStateDir, config) {
  const otherStateFile = path.join(otherStateDir, STATE_FILE_NAME);
  if (!fs.existsSync(otherStateFile)) {
    return;
  }
  try {
    withLockSync(
      path.join(otherStateDir, STATE_LOCK_DIR_NAME),
      () => {
        const otherParsed = readStateFileIfValid(otherStateFile);
        if (!otherParsed) {
          return;
        }
        writeJsonFileAtomic(otherStateFile, {
          ...otherParsed,
          config: { ...(otherParsed.config ?? {}), ...config }
        });
      },
      { timeoutMs: 0 }
    );
  } catch {
    // Busy or unlockable: leave that root alone rather than racing its owner.
  }
}

export function setConfig(cwd, key, value) {
  const nextConfig = writeDurableConfig(cwd, { ...getConfig(cwd), [key]: value });
  updateState(cwd, (state) => {
    state.config = { ...state.config, ...nextConfig };
  });
  // The cached copy in every other root has to follow. loadState() merges
  // booleans with OR — deliberately, so a gate enabled under one root is not
  // downgraded by a stale false under another — which also means a stranded
  // true would outvote this write forever whenever the durable config cannot
  // be read. Writing the new value everywhere keeps that safety direction
  // without making "disable" unreachable.
  const [, ...otherStateDirs] = resolveStateDirCandidates(cwd);
  for (const otherStateDir of otherStateDirs) {
    syncOtherStateRootConfig(otherStateDir, nextConfig);
  }
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

/**
 * Every path a job's terminal-claim file could be at, primary root first. The
 * claim lives beside the job's detail file, so it follows the same candidate
 * roots; unlike resolveJobClaimFile() this never creates a directory.
 */
export function resolveJobClaimFileCandidates(cwd, jobId) {
  return resolveStateDirCandidates(cwd).map((stateDir) => path.join(stateDir, JOBS_DIR_NAME, `${jobId}.terminal`));
}

/**
 * Every path a job's detail file could be at, primary root first. A job
 * listed via loadState()/listJobs() (which already searches every
 * candidate root) may have had its detail file written under a different
 * root than resolveJobFile()'s current primary; read lookups should not
 * miss it just because it isn't in the root a fresh call resolves to.
 */
export function resolveJobFileCandidates(cwd, jobId) {
  return resolveStateDirCandidates(cwd).map((stateDir) => path.join(stateDir, JOBS_DIR_NAME, `${jobId}.json`));
}
