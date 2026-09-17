#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getCodexAuthStatus,
    getCodexAvailability,
    getSessionRuntimeStatus,
    importExternalAgentSession,
    interruptAppServerTurn,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn
  } from "./lib/codex.mjs";
import { prepareClaudeSessionImport, resolveClaudeSessionPath } from "./lib/claude-session-transfer.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { armTimeout, disarmTimeout, workerTtlMs } from "./lib/lifecycle-limits.mjs";
import { binaryAvailable, isPidAlive, terminateProcessTree, terminateProcessTreeAndExit } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  reconcileJobLiveness,
  reconcileJobsLiveness,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  claimTerminalStatus,
  createJobLogFile,
  readTerminalClaim,
  reassertTerminalClaim,
  waitForTurnIdentity,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const CANCEL_TURN_INTERRUPT_TIMEOUT_MS = 5000;
const CANCEL_TURN_IDENTITY_WAIT_MS = 3000;
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const VALID_SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const MODEL_ALIASES = new Map([["spark", "gpt-5.3-codex-spark"]]);
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/codex-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/codex-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [focus text]",
      "  node scripts/codex-companion.mjs task [--background] [--write] [--sandbox <read-only|workspace-write|danger-full-access>] [--read-root <directory> ...] [--resume-last|--resume|--resume-thread <id>|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [prompt]",
      "  node scripts/codex-companion.mjs transfer [--source <claude-jsonl>] [--json]",
      "  node scripts/codex-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/codex-companion.mjs result [job-id] [--json]",
      "  node scripts/codex-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: none, minimal, low, medium, high, xhigh.`
    );
  }
  return normalized;
}

function normalizeSandboxMode(sandbox) {
  if (sandbox === undefined) {
    return null;
  }
  const normalized = String(sandbox).trim().toLowerCase();
  if (!normalized) {
    throw new Error("Missing value for --sandbox. Use one of: read-only, workspace-write, danger-full-access.");
  }
  if (!VALID_SANDBOX_MODES.has(normalized)) {
    throw new Error(
      `Unsupported sandbox mode "${sandbox}". Use one of: read-only, workspace-write, danger-full-access.`
    );
  }
  return normalized;
}

function defaultTaskSandbox(write) {
  return write ? "workspace-write" : "read-only";
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  const parsed = parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });

  // An unrecognised long option is still treated as a positional, because some
  // commands take free-form text. Say so on stderr rather than swallowing it:
  // a mistyped or unsupported flag would otherwise be silently folded into a
  // prompt, and the run would look like it did what was asked.
  for (const token of parsed.unknownOptions ?? []) {
    console.warn(
      `Warning: unrecognised option ${token}; treating it as text. It will be passed through verbatim, not interpreted as a flag.`
    );
  }

  return parsed;
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function resolveReadRoot(cwd, readRoot) {
  if (typeof readRoot !== "string" || !readRoot.trim()) {
    throw new Error("--read-root must name an existing directory: value is empty");
  }
  const resolved = path.resolve(cwd, readRoot);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`--read-root must name an existing directory: ${readRoot}`);
  }
  return fs.realpathSync(resolved);
}

function pathCovers(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/codex:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
}

function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/codex:review\` now maps directly to the built-in reviewer and does not support custom focus text. Retry with \`/codex:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }

  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error("This `/codex:review` target is not supported by the built-in reviewer. Retry with `/codex:adversarial-review` for custom targeting.");
  }

  return nativeTarget;
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(reconcileJobsLiveness(listJobs(workspaceRoot))).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /codex:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

async function executeReviewRun(request) {
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    const reviewTarget = validateNativeReviewRequest(target, focusText);
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      onProgress: request.onProgress
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      codex: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr
      },
      { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: shorten(firstMeaningfulLine(result.reviewText, `${reviewName} completed.`), 96),
      errorMessage: result.error?.message ?? result.stderr ?? null,
      jobTitle: `Codex ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(context, focusText);
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    effort: request.effort,
    sandbox: "read-only",
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const failureMessage = result.error?.message ?? result.stderr ?? parsed.parseError ?? "";
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? shorten(firstMeaningfulLine(failureMessage || result.finalMessage, `${reviewName} finished.`), 96),
    errorMessage: failureMessage || null,
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureCodexAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast || Boolean(request.resumeThread)
  });

  let resumeThreadId = null;
  if (request.resumeThread) {
    resumeThreadId = request.resumeThread;
  } else if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Codex task thread was found for this repository.");
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last / --resume-thread <id>.");
  }

  const result = await runAppServerTurn(workspaceRoot, {
    resumeThreadId,
    prompt: request.prompt,
    defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
    model: request.model,
    effort: request.effort,
    sandbox: request.sandbox ?? defaultTaskSandbox(Boolean(request.write)),
    readRoots: request.readRoots,
    write: request.write,
    onProgress: request.onProgress,
    persistThread: true,
    threadName: resumeThreadId ? null : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT)
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write)
    }
  );
  const payload = {
    status: result.status,
    threadId: result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary
  };
  const summary = shorten(
    firstMeaningfulLine(failureMessage || rawOutput, `${taskMetadata.title} finished.`),
    96
  );

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary,
    errorMessage: failureMessage || null,
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Codex Resume" : "Codex Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /codex:status ${payload.jobId} for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({ cwd, model, effort, prompt, write, sandbox, readRoots, resumeLast, resumeThread = null, jobId }) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    sandbox,
    readRoots,
    resumeLast,
    resumeThread,
    jobId
  };
}

function renderTransferResult(payload) {
  const lines = [
    "Transferred the Claude session into a Codex thread with visible turn history.",
    `Codex session ID: ${payload.threadId}`,
    `Resume in Codex: ${payload.resumeCommand}`
  ];
  return `${lines.join("\n")}\n`;
}

async function executeTransfer(cwd, options = {}) {
  const sourcePath = resolveClaudeSessionPath(cwd, {
    source: options.source
  });
  const prepared = prepareClaudeSessionImport(cwd, sourcePath);
  let result;
  try {
    result = await importExternalAgentSession(cwd, { sourcePath: prepared.importPath });
  } finally {
    prepared.cleanup();
  }
  const payload = {
    threadId: result.threadId,
    resumeCommand: `codex resume ${result.threadId}`,
    sourcePath,
    sessionId: path.basename(sourcePath, ".jsonl")
  };

  return {
    payload,
    rendered: renderTransferResult(payload)
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast, resumeThread = null) {
  if (!prompt && !resumeLast && !resumeThread) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last / --resume-thread <id>.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "codex-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  // Spawn failures (EMFILE/EAGAIN) surface as an async 'error' event; without
  // a listener that becomes an uncaught exception. The synchronous pid check
  // in enqueueBackgroundTask reports the failure.
  child.on("error", () => {});
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  // Persist the queued record BEFORE spawning: the job must be visible to
  // session-end guards (and to its own worker) from the first instant —
  // spawning first leaves a window in which the job has neither a state
  // record nor a broker socket, so a racing SessionEnd passes every guard
  // and tears the runtime down under the brand-new job.
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  const child = spawnDetachedTaskWorker(cwd, job.id);
  if (child.pid == null) {
    // The spawn failed before the worker ever existed; a queued record with
    // no pid would count as active forever and pin the shared broker.
    const errorMessage = "Failed to spawn the background task worker.";
    const failedPatch = {
      status: "failed",
      phase: "failed",
      pid: null,
      completedAt: nowIso(),
      errorMessage
    };
    writeJobFile(job.workspaceRoot, job.id, { ...queuedRecord, ...failedPatch });
    upsertJob(job.workspaceRoot, { id: job.id, ...failedPatch });
    appendLogLine(logFile, errorMessage);
    throw new Error(errorMessage);
  }
  // Record the worker pid; merge over the freshest stored record in case
  // the worker already flipped the job to running.
  upsertJob(job.workspaceRoot, { id: job.id, pid: child.pid });
  const storedAfterSpawn = readStoredJob(job.workspaceRoot, job.id);
  if (storedAfterSpawn && storedAfterSpawn.status === "queued") {
    writeJobFile(job.workspaceRoot, job.id, { ...storedAfterSpawn, pid: child.pid });
  }

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "effort", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const effort = normalizeReasoningEffort(options.effort);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  config.validateRequest?.(target, focusText);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: options.model,
        effort,
        focusText,
        reviewName: config.reviewName,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "sandbox", "resume-thread"],
    multiValueOptions: ["read-root"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"],
    leadingOnlyOptions: ["sandbox"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const resumeThreadOption = options["resume-thread"];
  const resumeThread = resumeThreadOption === undefined ? null : String(resumeThreadOption).trim();
  const fresh = Boolean(options.fresh);
  if (resumeThreadOption !== undefined && !resumeThread) {
    throw new Error("--resume-thread requires a non-empty thread id.");
  }
  if (Number(resumeLast) + Number(Boolean(resumeThread)) + Number(fresh) > 1) {
    throw new Error("Choose only one of --resume/--resume-last, --resume-thread <id>, or --fresh.");
  }
  const sandbox = normalizeSandboxMode(options.sandbox) ?? defaultTaskSandbox(Boolean(options.write));
  const write = sandbox !== "read-only";
  const readRoots = (options["read-root"] ?? []).map((readRoot) => resolveReadRoot(cwd, readRoot));
  if (readRoots.length > 0 && sandbox === "danger-full-access") {
    throw new Error(
      "--read-root cannot be combined with --sandbox danger-full-access: that mode disables the Codex sandbox, so no read scope is enforced."
    );
  }
  if (write && readRoots.length > 0 && !readRoots.some((readRoot) => pathCovers(readRoot, workspaceRoot))) {
    throw new Error(
      "--write requires an approved --read-root that covers the workspace directory; the same applies to --sandbox workspace-write."
    );
  }
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast: resumeLast || Boolean(resumeThread)
  });

  if (options.background) {
    ensureCodexAvailable(cwd);
    requireTaskRequest(prompt, resumeLast, resumeThread);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write);
    const request = buildTaskRequest({
      cwd,
      model,
      effort,
      prompt,
      write,
      sandbox,
      readRoots,
      resumeLast,
      resumeThread,
      jobId: job.id
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        prompt,
        write,
        sandbox,
        readRoots,
        resumeLast,
        resumeThread,
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const { payload, rendered } = await executeTransfer(cwd, {
    source: options.source
  });
  outputCommandResult(payload, rendered, options.json);
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  const releaseTtl = armWorkerTtl({ workspaceRoot, jobId: storedJob.id, storedJob, logFile });
  try {
    await runTrackedJob(
      {
        ...storedJob,
        workspaceRoot,
        logFile
      },
      () =>
        executeTaskRun({
          ...request,
          onProgress: progress
        }),
      { logFile }
    );
  } finally {
    releaseTtl();
  }
}

/**
 * Bound how long a detached worker may live.
 *
 * The worker is deliberately detached so a background task survives the session that queued it,
 * and its immediate parent exits right after enqueue — so there is no parent to watch and nothing
 * else that ever reclaims it. Without a ceiling a single wedged task keeps its whole process tree
 * (app-server plus every MCP server under it) alive indefinitely.
 *
 * Returns a function that disarms the timer once the job finishes normally.
 */
/** How long the tree gets to leave on SIGTERM before the group is killed outright. */
const WORKER_TERMINATION_GRACE_MS = 5000;

function armWorkerTtl({ workspaceRoot, jobId, storedJob, logFile }) {
  const ttlMs = workerTtlMs();
  const timer = armTimeout(ttlMs, () => {
    const errorMessage = `Worker exceeded its ${ttlMs}ms lifetime.`;

    // Record the outcome before terminating: the process group is about to take this process down
    // with it, and a job left at "running" with a dead pid is exactly the stale record that makes
    // leaked workers invisible. All of it is best effort — a full disk or a deleted state
    // directory must not be what keeps a runaway tree alive.
    const completedAt = nowIso();
    const terminal = {
      status: "failed",
      phase: "failed",
      pid: null,
      completedAt,
      errorMessage
    };

    // Each of these is best effort on its own. Sharing one try means a missing log directory or a
    // full disk would skip the terminal status too, leaving the job "running" behind a dead pid —
    // the stale record that hides leaked workers in the first place. Status goes first, because it
    // is the part anything else reads.
    const attempt = (action) => {
      try {
        action();
      } catch {
        // Never let bookkeeping keep a runaway tree alive.
      }
    };

    const recordExpiry = () => {
      attempt(() => {
        // Re-read rather than reusing the snapshot this timer closed over a day ago: it predates
        // startedAt, threadId, turnId and every progress update since.
        const current = readStoredJob(workspaceRoot, jobId) ?? storedJob;
        writeJobFile(workspaceRoot, jobId, { ...current, ...terminal, logFile });
      });
      attempt(() => upsertJob(workspaceRoot, { id: jobId, ...terminal }));
    };

    recordExpiry();
    attempt(() => appendLogLine(logFile, `${errorMessage} Terminating its process tree.`));

    // Terminate the tree rather than just this process: the app-server and MCP servers underneath
    // are the expensive part, and they do not exit on their own.
    //
    // SIGTERM alone is not a ceiling — a descendant that traps or ignores it keeps running, and
    // once this worker is gone nothing is left to escalate. So the worker survives its own signal
    // for a grace period. That means the job can finish during it and record a success over the
    // expiry, which would be a lie: its tree is about to be killed. Writing the expiry again as
    // the last act before the kill makes it the outcome that stands.
    terminateProcessTreeAndExit(process.pid, {
      graceMs: WORKER_TERMINATION_GRACE_MS,
      beforeKill: recordExpiry
    });
  });
  return () => disarmTimeout(timer);
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(reconcileJobsLiveness(listJobs(workspaceRoot))));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  let threadId = existing.threadId ?? job.threadId ?? null;
  let turnId = existing.turnId ?? job.turnId ?? null;
  // The state snapshot can carry the queued record's pid: null while the
  // worker has since written its real pid to the job file — and the terminal
  // writes below null the pid field, so capture the fresher value first.
  let workerPid = existing.pid ?? job.pid ?? Number.NaN;

  // Claim the terminal status first: if the worker finished in the meantime,
  // its completed/failed record stands and there is nothing left to cancel.
  // That race is benign, so report the job's terminal outcome as a normal
  // result instead of failing the command — after a brief wait for the
  // winner's record write to land, so the reported status is not stale.
  let orphanAdopted = false;
  const claimOwned = claimTerminalStatus(workspaceRoot, job.id);
  if (!claimOwned) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const finished = readStoredJob(workspaceRoot, job.id) ?? job;
    const finishedStatus = finished.status ?? "unknown";
    const claimant = readTerminalClaim(workspaceRoot, job.id);
    const claimantAlive = claimant?.pid != null && isPidAlive(claimant.pid);
    if (finishedStatus !== "queued" && finishedStatus !== "running") {
      // The claimant may have died between its terminal job-file write and
      // its state.json update; converge the index to the file's terminal
      // outcome so the job does not stay listed as running with a dead pid.
      reassertTerminalClaim(workspaceRoot, job.id, finished);
      const payload = {
        jobId: job.id,
        status: finishedStatus,
        title: job.title,
        alreadyFinished: true
      };
      outputCommandResult(
        payload,
        `Job ${job.id} already finished (${finishedStatus}); nothing to cancel.\n`,
        options.json
      );
      return;
    }
    if (claimantAlive) {
      // The claim owner is still finalizing the job (e.g. the worker is
      // writing its completed record); leave it to finish.
      const payload = {
        jobId: job.id,
        status: finishedStatus,
        title: job.title,
        alreadyFinished: true
      };
      outputCommandResult(
        payload,
        `Job ${job.id} is being finalized (${finishedStatus}); nothing to cancel.\n`,
        options.json
      );
      return;
    }
    // The claim is orphaned: its owner died before persisting a terminal
    // record. Repair the records (the claim's recorded intent decides
    // failed vs cancelled) and proceed with the interrupt and the worker
    // kill below — otherwise a hung worker could never be cancelled,
    // because every retry would lose the same claim.
    workerPid = finished?.pid ?? workerPid;
    reassertTerminalClaim(workspaceRoot, job.id, finished);
    orphanAdopted = true;
  }

  // A worker that exited after turn/start was accepted, but before it recorded
  // a turn id, leaves a Codex turn that may still be running and nothing to
  // address it by. This has to refuse before the record-first write below:
  // reporting the job cancelled while its turn runs on is the failure mode.
  // No identity wait can help here either — the worker that would publish the
  // turn id is already gone.
  const reconciledForCancel = reconcileJobLiveness(readStoredJob(workspaceRoot, job.id) ?? job);
  if (reconciledForCancel.workerExited && (threadId ?? reconciledForCancel.threadId) && !(turnId ?? reconciledForCancel.turnId)) {
    throw new Error(
      `Cannot safely cancel ${job.id}: the worker exited after turn/start was accepted, but the turn id is not yet known. The Codex turn may still be running.`
    );
  }

  // Persist the terminal record before touching the turn or the worker: a
  // crash partway through must never leave an interrupted turn behind with no
  // recorded outcome.
  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  // An adopted orphan already carries the record the claim's intent calls
  // for (failed for a dead worker's own claim); don't overwrite it.
  if (!orphanAdopted) {
    // Re-read at write time and apply only the terminal fields: the early
    // snapshot must not erase a turn identity the worker persisted since
    // (the updater de-duplicates ids and would never re-send them).
    const freshStored = readStoredJob(workspaceRoot, job.id) ?? existing;
    workerPid = freshStored?.pid ?? workerPid;
    writeJobFile(workspaceRoot, job.id, {
      ...freshStored,
      status: "cancelled",
      phase: "cancelled",
      pid: null,
      completedAt,
      errorMessage: "Cancelled by user.",
      cancelledAt: completedAt
    });
    upsertJob(workspaceRoot, {
      id: job.id,
      status: "cancelled",
      phase: "cancelled",
      pid: null,
      errorMessage: "Cancelled by user.",
      completedAt
    });
  }

  // A cancel can land before the worker persisted the turn identity; wait
  // for it (while the worker is alive to produce it, bounded so a wedged
  // worker cannot stall the cancel) rather than skipping the interrupt and
  // orphaning the turn.
  {
    // The wait also refreshes the worker pid: with record-before-spawn the
    // snapshot can carry pid null, and the kill below must target the real
    // worker, not NaN.
    const identity = await waitForTurnIdentity(workspaceRoot, job.id, {
      threadId,
      turnId,
      deadline: Date.now() + CANCEL_TURN_IDENTITY_WAIT_MS,
      workerPid: job.pid ?? null
    });
    threadId = identity.threadId;
    turnId = identity.turnId;
    workerPid = identity.workerPid ?? workerPid;
  }

  // Bounded like the session-end path: the terminal records are already
  // written, so a turn/interrupt that never replies must not hang the
  // command before the worker kill below runs — that would strand a live
  // worker behind a cancelled record it can no longer overwrite.
  const interrupt = await interruptAppServerTurn(cwd, {
    threadId,
    turnId,
    timeoutMs: CANCEL_TURN_INTERRUPT_TIMEOUT_MS
  });
  let workerKillError = null;
  try {
    terminateProcessTree(workerPid);
  } catch (error) {
    // The cancellation is already recorded; a failed kill (EPERM, taskkill
    // access denied) must not turn it into a CLI crash with no payload.
    workerKillError = error;
  }

  // Log appends are best-effort; an unwritable log must not fail the cancel.
  try {
    if (workerKillError) {
      appendLogLine(
        job.logFile,
        `Worker termination failed: ${workerKillError instanceof Error ? workerKillError.message : String(workerKillError)}`
      );
    }
    if (interrupt.attempted) {
      appendLogLine(
        job.logFile,
        interrupt.interrupted
          ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
          : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
      );
    }
    appendLogLine(job.logFile, "Cancelled by user.");
  } catch {
    // Ignore log write failures after the cancellation is already recorded.
  }

  // An adopted orphan keeps the status the claim's intent produced (e.g.
  // failed for a dead worker's own claim) instead of reporting cancelled.
  const effectiveStatus = orphanAdopted
    ? readStoredJob(workspaceRoot, job.id)?.status ?? "cancelled"
    : "cancelled";
  const payload = {
    jobId: job.id,
    status: effectiveStatus,
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted,
    // A failed kill leaves the worker alive even though the record is
    // cancelled; the caller must be able to tell that from a clean cancel.
    workerTerminated: workerKillError == null
  };

  outputCommandResult(
    payload,
    renderCancelReport({ ...nextJob, status: effectiveStatus }, { workerTerminated: workerKillError == null }),
    options.json
  );
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "transfer":
      await handleTransfer(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
