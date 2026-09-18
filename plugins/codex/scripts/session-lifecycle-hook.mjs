#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { forceKillProcessTree, isPidAlive, terminateProcessTree } from "./lib/process.mjs";
import { reconcileJobLiveness } from "./lib/job-control.mjs";
import { brokerIdleShutdownMs, turnInterruptBudgetMs } from "./lib/lifecycle-limits.mjs";
import { BROKER_ENDPOINT_ENV } from "./lib/app-server.mjs";
import {
  LOG_FILE_ENV,
  loadBrokerSession,
  PID_FILE_ENV,
  sendBrokerShutdown,
  shutdownBrokerSession
} from "./lib/broker-lifecycle.mjs";
import { interruptAppServerTurn } from "./lib/codex.mjs";
import { isActiveJob, loadState, readJobFile, resolveJobFile, resolveStateFile, updateState, upsertJob, writeJobFile } from "./lib/state.mjs";
import { claimTerminalStatus, readTerminalClaim, reassertTerminalClaim, waitForTurnIdentity } from "./lib/tracked-jobs.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

// The SessionEnd hook runs under a 5-second timeout (hooks.json). The
// budgets below must sum comfortably under it: brokered turn interrupts
// (identity waits are capped per job and reserve room for the interrupt
// RPCs themselves), then a short exit grace for killed workers, then the
// shutdown exchange with its one retry.
const TURN_INTERRUPT_BUDGET_MS = turnInterruptBudgetMs();
const TURN_IDENTITY_WAIT_MS = 500;
const TURN_INTERRUPT_RESERVE_MS = 1000;

// After killing its own workers the hook sends broker/shutdown; a worker
// that is slow to exit still holds its broker socket and would make the
// broker refuse that shutdown. Give workers a short grace to exit, then
// SIGKILL stragglers that ignored SIGTERM (or wedged while finalizing).
const WORKER_EXIT_GRACE_MS = 800;

// Returns the pids still alive after the grace, having force-killed them.
async function waitForWorkerExits(pids) {
  const deadline = Date.now() + WORKER_EXIT_GRACE_MS;
  let stragglers = pids.filter((pid) => isPidAlive(pid));
  while (stragglers.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    stragglers = stragglers.filter((pid) => isPidAlive(pid));
  }
  if (stragglers.length === 0) {
    return [];
  }
  for (const pid of stragglers) {
    // Not `process.kill(-pid)`: on Windows that is an invalid handle rather than a process group,
    // and falling back to the bare pid would leave the worker's app-server subtree behind.
    forceKillProcessTree(pid);
  }
  // Give the forced kill a beat to release the sockets.
  await new Promise((resolve) => setTimeout(resolve, 100));
  return stragglers;
}

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function setEnv(name, value) {
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (!envFile || value == null || value === "") {
    return;
  }
  const prefix = `export ${name}=`;
  const line = `${prefix}${shellEscape(value)}`;

  // CLAUDE_ENV_FILE is shared with every other plugin's SessionStart hook and is
  // append-only by convention. Rewriting it (read, filter, rename) drops any
  // export another hook appended between the read and the rename, and the
  // rename replaces the file, discarding its mode along with it. So append.
  //
  // That means a value that changes every session (the session id, the
  // transcript path) adds a line every session: the shell takes the last
  // export for a key, so the file stays correct while it grows. Only an
  // unchanged value is skipped. Bounded growth is the price of never
  // destroying another plugin's export.
  let content = "";
  try {
    content = fs.readFileSync(envFile, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  const existing = content
    .split(/\r?\n/)
    .filter((entry) => entry.startsWith(prefix))
    .at(-1);
  if (existing === line) {
    return;
  }

  // Always open with a newline rather than deciding from the read above: a
  // hook appending an unterminated line between that read and this write would
  // otherwise run into ours, losing both exports. A blank line costs nothing to
  // the shell that sources this file.
  fs.appendFileSync(envFile, `\n${line}\n`, "utf8");
}

// A pid-less active record has no liveness signal at all (current code
// always records a worker pid, but records written by older versions or a
// torn write may not); without a bound such a record would pin the broker
// forever if its session never ran SessionEnd. Reap it once it is a day old.
const ACTIVE_JOB_STALENESS_MS = 24 * 60 * 60 * 1000;

function isStaleJobRecord(job) {
  const reference = job.updatedAt ?? job.createdAt ?? null;
  const timestamp = reference ? Date.parse(reference) : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    // Unparseable timestamps stay conservative: not stale.
    return false;
  }
  return Date.now() - timestamp > ACTIVE_JOB_STALENESS_MS;
}

// A record retained because its worker died with a turn still possibly running
// has no pid to probe, so the generic pid-less rule (a day) would keep it
// "running" — and keep it pinning the broker — for a day. The turn it protects
// cannot outlive the broker anyway: its client is gone, so the broker idles out
// on its own timer. Bound the protection to that same window.
function retainedOrphanExpired(job, env = process.env) {
  if (job?.workerExited !== true) {
    return false;
  }
  // This record is why SessionEnd declines to tear the broker down, so here
  // "cannot tell" must not mean "protected forever" — isStaleJobRecord()'s
  // conservative reading of an unparseable timestamp would do exactly that. A
  // record with no readable timestamp has outlived anything it could protect.
  const reference = job.updatedAt ?? job.createdAt ?? null;
  const timestamp = reference ? Date.parse(reference) : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    return true;
  }
  // The broker's idle timer is what actually ends the turn, so it sets the
  // window. With that timer disabled (CODEX_BROKER_IDLE_SHUTDOWN_MS=0) nothing
  // would end it, so fall back to the generic staleness bound rather than
  // pinning the broker — and its app-server and MCP servers — indefinitely.
  const idleMs = brokerIdleShutdownMs(env);
  const windowMs = Number.isFinite(idleMs) && idleMs > 0 ? idleMs : ACTIVE_JOB_STALENESS_MS;
  return Date.now() - timestamp > windowMs;
}

// Nothing else transitions the record of a worker that died without its
// SessionEnd ever running (SIGKILL, OOM, reboot): reap it to failed here so
// the broker guard, the pruner, and status queries all agree, instead of a
// zombie active record accumulating forever and — after pid reuse — pinning
// the shared broker indefinitely.
async function reapDeadWorkerJobs(workspaceRoot, { excludeSessionId = null, cwd = null, interruptTurns = false, interruptDeadline = 0 } = {}) {
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  const jobs = loadState(workspaceRoot).jobs;
  // Every interrupt this SessionEnd may still have to send shares one
  // deadline: the remaining reap candidates here plus the ending session's
  // own active jobs, which cleanupSessionJobs interrupts right after this
  // reaper. Each attempt takes an equal share of what remains (own jobs
  // stay counted throughout — their turn comes later), so one hung reap
  // RPC cannot drain the budget and leave the session's own server-side
  // turns running while their records read cancelled.
  let jobsAwaitingInterrupt = jobs.filter((job) => isActiveJob(job)).length;

  for (const job of jobs) {
    if (!isActiveJob(job)) {
      continue;
    }
    // The ending session's own jobs are cleaned up by cleanupSessionJobs,
    // which retains a cancelled record; reaping them to failed first would
    // make that cleanup drop them as old terminal jobs — erasing the record
    // and its files, the exact "No job found" outcome this PR removes.
    if (excludeSessionId && job.sessionId === excludeSessionId) {
      continue;
    }
    jobsAwaitingInterrupt -= 1;
    const workerDead =
      job.pid != null
        ? !isPidAlive(job.pid)
        : job.workerExited === true
          ? retainedOrphanExpired(job)
          : isStaleJobRecord(job);
    if (!workerDead) {
      continue;
    }
    if (!claimTerminalStatus(workspaceRoot, job.id, "reaper")) {
      // A claimant died between taking the claim and writing its record (or
      // is writing it right now); converge the stores to a terminal state.
      reassertTerminalClaim(workspaceRoot, job.id, job);
      continue;
    }
    // The dead worker was only the relay: its server-side turn may still be
    // running. Interrupt it before failing the record — once failed, the
    // job leaves the active set and nothing else will ever interrupt it.
    if (interruptTurns && cwd) {
      const identity = await waitForTurnIdentity(workspaceRoot, job.id, {
        threadId: job.threadId ?? null,
        turnId: job.turnId ?? null,
        deadline: 0,
        workerPid: Number.NaN
      });
      const attemptMs = Math.floor((interruptDeadline - Date.now()) / (jobsAwaitingInterrupt + 1));
      if (identity.threadId && identity.turnId && attemptMs > 0) {
        try {
          await interruptAppServerTurn(cwd, {
            threadId: identity.threadId,
            turnId: identity.turnId,
            timeoutMs: attemptMs,
            skipAvailabilityProbe: true
          });
        } catch {
          // Best-effort: a failed interrupt must not block the reap.
        }
      }
    }
    const completedAt = new Date().toISOString();
    const failedPatch = {
      status: "failed",
      phase: "failed",
      pid: null,
      completedAt,
      errorMessage: "Failed: the worker process died without recording an outcome."
    };
    try {
      const jobFile = resolveJobFile(workspaceRoot, job.id);
      const storedJob = fs.existsSync(jobFile) ? readJobFile(jobFile) : job;
      writeJobFile(workspaceRoot, job.id, { ...storedJob, ...failedPatch });
    } catch {
      // Best-effort: the state.json record below is the canonical outcome.
    }
    upsertJob(workspaceRoot, { id: job.id, ...failedPatch });
  }
}

function hasActiveJobsFromOtherSessions(workspaceRoot, sessionId) {
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return false;
  }

  return loadState(workspaceRoot).jobs.some((job) => {
    if (!isActiveJob(job)) {
      return false;
    }
    if (sessionId && job.sessionId === sessionId) {
      return false;
    }
    // Both queued and running records carry the worker pid; a dead worker
    // (e.g. one that crashed at startup, leaving a permanently queued record)
    // must not pin the broker. Liveness is authoritative when a pid exists:
    // task runtime is unbounded and updatedAt is not a heartbeat, so a live
    // worker must never be expired by record age. Only pid-less records,
    // which have no liveness signal, fall back to the staleness bound.
    if (job.pid != null) {
      return isPidAlive(job.pid);
    }
    if (job.workerExited === true) {
      return !retainedOrphanExpired(job);
    }
    return !isStaleJobRecord(job);
  });
}

async function cleanupSessionJobs(cwd, sessionId, { interruptTurns = false, interruptDeadline = null } = {}) {
  if (!cwd || !sessionId) {
    return { retainedOrphans: 0 };
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  // loadState() is candidate-aware and already returns an empty job list when
  // nothing exists in any root; a raw existsSync() against the primary candidate
  // alone would miss a session whose jobs only live in the fallback root.
  const sessionJobs = loadState(workspaceRoot).jobs.filter((job) => job.sessionId === sessionId);
  if (sessionJobs.length === 0) {
    return { retainedOrphans: 0 };
  }

  const completedAt = new Date().toISOString();
  const cancelPatch = {
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled: the Claude session ended while the job was still running."
  };
  const cancelledIds = new Set();
  // Jobs left active because their turn may still be running: the broker must
  // outlive this hook run for them, and hasActiveJobsFromOtherSessions() will
  // not speak for them — they belong to the session that is ending.
  let retainedOrphans = 0;
  const killedPids = [];
  const finishingJobs = [];
  interruptDeadline = interruptDeadline ?? Date.now() + TURN_INTERRUPT_BUDGET_MS;
  // Jobs that have not had their interrupt attempt yet, the current one
  // included. Each attempt gets an equal share of whatever budget is left:
  // one hung interrupt RPC must not consume the shared deadline and leave
  // every later job killed (and recorded cancelled) with its server-side
  // turn never interrupted.
  let jobsAwaitingInterrupt = sessionJobs.filter(isActiveJob).length;

  for (const job of sessionJobs) {
    const stillRunning = job.status === "queued" || job.status === "running";
    if (!stillRunning) {
      continue;
    }
    // The state snapshot can carry the queued record's pid: null while the
    // worker has since written its real pid (and turn identity) to the job
    // file — and the terminal patches below null the pid field, destroying
    // the only copy. Capture the fresher values first.
    let workerPid = job.pid ?? null;
    let threadId = job.threadId ?? null;
    let turnId = job.turnId ?? null;
    try {
      const freshFile = resolveJobFile(workspaceRoot, job.id);
      const freshJob = fs.existsSync(freshFile) ? readJobFile(freshFile) : null;
      workerPid = freshJob?.pid ?? workerPid;
      threadId = freshJob?.threadId ?? threadId;
      turnId = freshJob?.turnId ?? turnId;
    } catch {
      // Keep the snapshot values.
    }
    // A dead worker still gets its terminal record below — that is what keeps
    // /codex:status from answering "No job found" for the session that just
    // ended. Reconciliation is consulted only for the one case where writing
    // that record would be a lie, and it reads the values captured above
    // rather than the snapshot: the snapshot's pid can be null while the
    // worker has long since published its real pid and turn identity, which
    // would both skip this check and misjudge the turn as unidentified.
    const reconciled = reconcileJobLiveness({ ...job, pid: workerPid, threadId, turnId });
    if (reconciled.workerExited && threadId && !turnId) {
      // The worker died after turn/start was accepted but before it recorded a
      // turn id, so the Codex turn may still be running and there is nothing to
      // interrupt it by. Cancelling the record here would claim an outcome that
      // did not happen; leave it active (its phase says why) for the next
      // status query. The verdict is persisted instead of the pid: writing a
      // dead pid back would let another session's dead-worker reaper fail the
      // record and stop it pinning the broker — tearing the runtime down under
      // the very turn this retain protects. A pid-less active record keeps the
      // broker up (bounded by the staleness rule) and reconciles from the flag.
      upsertJob(workspaceRoot, {
        id: job.id,
        phase: reconciled.phase,
        pid: null,
        threadId,
        workerExited: true
      });
      retainedOrphans += 1;
      continue;
    }
    jobsAwaitingInterrupt -= 1;
    // The worker may be recording its own terminal outcome right now; only
    // cancel jobs whose terminal status this hook wins — unless the claim is
    // orphaned (its owner died before writing a terminal record), in which
    // case adopt it and proceed, exactly like the cancel path; skipping
    // would let the worker survive session shutdown and pin the broker.
    let adoptedOrphan = false;
    if (!claimTerminalStatus(workspaceRoot, job.id)) {
      const claimant = readTerminalClaim(workspaceRoot, job.id);
      if (claimant?.pid != null && isPidAlive(claimant.pid)) {
        // A live finalizer is writing the job's outcome — let it finish,
        // but its worker must not outlive this hook's broker shutdown: it
        // is waited for below and force-killed (with a claim repair) if it
        // wedges, or the last session out would leak the broker.
        if (Number.isFinite(workerPid)) {
          finishingJobs.push({ jobId: job.id, pid: workerPid });
        }
        continue;
      }
      // The claim's recorded intent decides failed vs cancelled; don't
      // overwrite the repaired record with a cancellation below.
      reassertTerminalClaim(workspaceRoot, job.id, job);
      adoptedOrphan = true;
    }
    // Record-first, like handleCancel: hook timeouts are short and the
    // interrupt below is a broker round-trip, so persist the terminal outcome
    // immediately after winning the claim. Keeping a terminal record for
    // in-flight jobs (instead of erasing them) lets status queries see a
    // cause rather than "No job found".
    cancelledIds.add(job.id);
    if (!adoptedOrphan) {
      upsertJob(workspaceRoot, { id: job.id, ...cancelPatch });
      try {
        const jobFile = resolveJobFile(workspaceRoot, job.id);
        const storedJob = fs.existsSync(jobFile) ? readJobFile(jobFile) : job;
        // The worker may have published its pid and turn identity between
        // the pre-claim read above and this hook winning the claim — and the
        // cancel patch nulls the pid, so this reread holds the last copy.
        // Capture it before the write, or the worker is neither interrupted
        // nor killed and its open socket pins the broker.
        workerPid = storedJob.pid ?? workerPid;
        threadId = storedJob.threadId ?? threadId;
        turnId = storedJob.turnId ?? turnId;
        writeJobFile(workspaceRoot, job.id, { ...storedJob, ...cancelPatch });
      } catch {
        // Best-effort: the state.json record above is the canonical outcome.
      }
    }
    // The worker only relays a brokered turn: killing it leaves the turn
    // running inside the shared app-server, so interrupt the turn first.
    // The interrupts share a deadline well inside the SessionEnd hook
    // timeout, so a hung broker RPC cannot starve the worker kills below;
    // the timeout lives inside the helper, which tears its connection down
    // so an abandoned request cannot linger on the broker or keep this
    // hook process alive.
    if (interruptTurns && (!threadId || !turnId)) {
      // The identity wait is capped per job and always leaves a reserve for
      // the interrupt RPCs themselves: one id-less job must not consume the
      // shared budget and starve every job's interrupt.
      const identityDeadline = Math.min(
        interruptDeadline - TURN_INTERRUPT_RESERVE_MS,
        Date.now() + TURN_IDENTITY_WAIT_MS
      );
      const identity = await waitForTurnIdentity(workspaceRoot, job.id, {
        threadId,
        turnId,
        deadline: identityDeadline,
        workerPid
      });
      threadId = identity.threadId;
      turnId = identity.turnId;
      // The wait also refreshes the worker pid: with record-before-spawn
      // the snapshot can carry pid null, and the kill below must target
      // the real worker, not NaN.
      workerPid = identity.workerPid ?? workerPid;
    }
    if (interruptTurns && threadId && turnId) {
      // This job's fair share of the remaining budget: itself plus the jobs
      // still waiting behind it. Shares are computed against what actually
      // remains, so time an earlier job did not use flows to later ones.
      const attemptMs = Math.floor((interruptDeadline - Date.now()) / (jobsAwaitingInterrupt + 1));
      if (attemptMs > 0) {
        try {
          await interruptAppServerTurn(cwd, {
            threadId,
            turnId,
            timeoutMs: attemptMs,
            skipAvailabilityProbe: true
          });
        } catch {
          // Best-effort: a failed interrupt must not block session cleanup.
        }
      }
    }
    try {
      terminateProcessTree(workerPid ?? Number.NaN);
      if (Number.isFinite(workerPid)) {
        killedPids.push(workerPid);
      }
    } catch {
      // Ignore teardown failures during session shutdown.
    }
  }

  // A dying (or wedged-while-finalizing) worker's still-open broker socket
  // must not veto the broker shutdown that may follow this cleanup.
  if (interruptTurns && (killedPids.length > 0 || finishingJobs.length > 0)) {
    const stragglers = await waitForWorkerExits([...killedPids, ...finishingJobs.map((entry) => entry.pid)]);
    for (const entry of finishingJobs) {
      const jobFile = resolveJobFile(workspaceRoot, entry.jobId);
      const stored = fs.existsSync(jobFile) ? readJobFile(jobFile) : null;
      const workerWroteOutcome = stored != null && !isActiveJob(stored);
      if (workerWroteOutcome && !stragglers.includes(entry.pid)) {
        // The finalizer finished its job-file write and exited on its own —
        // but it may have died between its two store writes (job file first,
        // state.json second), leaving the index still running with a dead
        // pid. Converge the index to the file's terminal outcome (a no-op
        // when the finalizer got both writes out); the filter below then
        // erases it like the session's other finished jobs.
        reassertTerminalClaim(workspaceRoot, entry.jobId, stored);
        continue;
      }
      // The finalizer was force-killed mid-write, or died during the grace
      // wait without recording an outcome; converge its claim to a terminal
      // record so the job does not stay running forever — and retain that
      // record below: the user needs the outcome, not "No job found".
      reassertTerminalClaim(workspaceRoot, entry.jobId, stored, { force: true });
      cancelledIds.add(entry.jobId);
    }
  }

  // Drop the session's finished jobs, but keep the records cancelled above
  // and any still-active job whose terminal claim its worker won mid-write
  // (deleting those files would pull them out from under the live worker).
  // Fresh read-modify-write: records other sessions created or updated while
  // the interrupts above were awaited must not be clobbered by writing back
  // a stale snapshot.
  updateState(workspaceRoot, (state) => {
    state.jobs = state.jobs.filter((job) => {
      if (job.sessionId !== sessionId) {
        return true;
      }
      if (cancelledIds.has(job.id)) {
        return true;
      }
      return isActiveJob(job);
    });
  });

  return { retainedOrphans };
}

function handleSessionStart(input) {
  setEnv(SESSION_ID_ENV, input.session_id);
  setEnv(TRANSCRIPT_PATH_ENV, input.transcript_path);
  setEnv(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || process.env[SESSION_ID_ENV];
  const brokerSession =
    loadBrokerSession(cwd) ??
    (process.env[BROKER_ENDPOINT_ENV]
      ? {
          endpoint: process.env[BROKER_ENDPOINT_ENV],
          pidFile: process.env[PID_FILE_ENV] ?? null,
          logFile: process.env[LOG_FILE_ENV] ?? null
        }
      : null);
  const brokerEndpoint = brokerSession?.endpoint ?? null;

  // The reaper's dead-turn interrupts and the cleanup's own interrupts share
  // one budget so they cannot stack past the hook timeout.
  const interruptTurns = Boolean(brokerEndpoint);
  const interruptDeadline = Date.now() + TURN_INTERRUPT_BUDGET_MS;
  await reapDeadWorkerJobs(resolveWorkspaceRoot(cwd), {
    excludeSessionId: sessionId,
    cwd,
    interruptTurns,
    interruptDeadline
  });
  const cleanup = await cleanupSessionJobs(cwd, sessionId, { interruptTurns, interruptDeadline });

  // A turn this session could not interrupt — its worker died before publishing
  // a turn id — may still be running on this broker. The guard below speaks
  // only for other sessions' work, so without this the same hook run would
  // tear the runtime down under the turn the retain exists to protect.
  //
  // What ends the wait: normally the broker's own idle timer, since the turn's
  // client is gone. With that timer disabled the next session end in this
  // workspace reclaims the broker once the record passes the staleness bound
  // (see retainedOrphanExpired), so the runtime is held, never stranded.
  if (cleanup?.retainedOrphans > 0) {
    return;
  }

  // The broker and state dir are workspace-shared, not session-owned. If any
  // other session still has work in flight, tearing the broker down would
  // abort its turn mid-flight, so leave the runtime for the survivors.
  if (hasActiveJobsFromOtherSessions(resolveWorkspaceRoot(cwd), sessionId)) {
    return;
  }

  if (brokerEndpoint) {
    const shutdown = await sendBrokerShutdown(brokerEndpoint, {
      instanceToken: brokerSession?.instanceToken
    });
    // The broker refuses shutdown while another client is connected: work
    // admitted between the guard check above and this request must not be
    // killed. Leave the runtime up for it; a later session end retires it.
    if (shutdown?.refused) {
      return;
    }
    // An ambiguous outcome (connection lost mid-exchange — the refusal may
    // have been dropped) must fail closed: don't kill a possibly-busy
    // broker. Only a confirmed shutdown or an unreachable endpoint (nothing
    // listening) proceeds to teardown. shutdownBrokerSession() re-verifies
    // ownership (and PID-reuse safety) below before touching anything.
    if (!shutdown?.delivered && !shutdown?.unreachable) {
      return;
    }
  }

  await shutdownBrokerSession(cwd, {
    killProcess: terminateProcessTree
  });
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
