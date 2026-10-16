import { spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

// Git metadata can exceed Node's 1 MiB spawnSync default. Keep a generous explicit bound.
const DEFAULT_MAX_BUFFER = 256 * 1024 * 1024;

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
    timeout: options.timeout,
    killSignal: options.killSignal,
    stdio: options.stdio ?? "pipe",
    // `process.env.SHELL` is a POSIX convention with no meaning for native
    // Windows process creation; consulting it routed commands through whatever
    // POSIX shell happened to be set (Git Bash, which Claude Code's own Bash
    // tool sets), and MSYS path conversion then mangled Windows-style flags
    // like `/PID`. Nothing is spawned through a shell here; a Windows `.cmd`
    // shim goes through commandWithWindowsShim() instead.
    shell: options.shell ?? false,
    windowsHide: true
  });

  return {
    command,
    args,
    // Preserve Node's spawnSync contract: signal-terminated commands have a
    // null status and a non-null signal.
    status: result.status,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.signal != null || result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function commandWithWindowsShim(command, args = [], options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { command, args, shell: false };
  }

  return {
    command: options.comspec ?? process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", "call", command, ...args],
    shell: false
  };
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  let result;

  if (options.shell !== undefined) {
    result = runCommandImpl(command, versionArgs, options);
  } else {
    const invocation = commandWithWindowsShim(command, versionArgs, options);
    result = runCommandImpl(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: options.env,
      shell: invocation.shell
    });
  }
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.signal != null || result.status !== 0) {
    const detail =
      result.stderr.trim() ||
      result.stdout.trim() ||
      (result.signal != null ? `signal ${result.signal}` : `exit ${result.status}`);
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

export function isPidAlive(pid, killImpl = process.kill.bind(process)) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    killImpl(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to another user.
    return /** @type {NodeJS.ErrnoException} */ (error)?.code === "EPERM";
  }
}

/**
 * Whether a pid is *provably* gone, as opposed to merely unreadable.
 *
 * Deliberately narrower than !isPidAlive(): only ESRCH proves absence. Any other failure — EPERM,
 * or whatever code a platform reports for a handle it will not open — leaves the question open,
 * and the teardown below must still try to kill, because skipping the kill on a live root leaks
 * its whole tree.
 */
function isProvablyGone(pid, killImpl) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return true;
  }
  try {
    killImpl(pid, 0);
    return false;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error)?.code === "ESRCH";
  }
}

export function isValidPid(pid) {
  return Number.isSafeInteger(pid) && pid > 0;
}

function readLinuxProcessStat(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd === -1) {
      return null;
    }
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    return {
      state: fields[0] ?? null,
      parentPid: fields[1] ?? null,
      processGroup: fields[2] ?? null,
      // /proc/<pid>/stat field 22; fields starts at field 3.
      startTime: fields[19] ?? null
    };
  } catch {
    return null;
  }
}

function queryProcessTable(pid, powershellCommand, psFormat, options) {
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const spawnOptions = {
    timeout: options.timeoutMs ?? 2000,
    killSignal: "SIGTERM",
    // ps -o lstart= renders via the C library's %c, which is locale- and
    // TZ-dependent: the same instant can print differently between the
    // recording and the checking invocation, producing a false mismatch on a
    // still-live broker. Force a fixed, unambiguous rendering. Harmless for
    // the PowerShell path (already UTC ticks) and for command-line reads.
    env: { ...(options.env ?? process.env), LC_ALL: "C", TZ: "UTC" }
  };
  const result =
    (options.platform ?? process.platform) === "win32"
      ? runCommandImpl(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", powershellCommand],
          spawnOptions
        )
      : runCommandImpl("ps", ["-ww", "-p", String(pid), "-o", psFormat], spawnOptions);
  if (result.error || result.signal != null || result.status !== 0) {
    return null;
  }
  return String(result.stdout ?? "");
}

// /proc/<pid>/stat's starttime is in clock ticks since BOOT, not since the
// epoch, so the bare value collides across reboots (a reused pid after a
// reboot can present the same tick count as an earlier, unrelated process).
// Prefixing with the boot id disambiguates across reboots while keeping
// identities comparable within one. Read once and cache for the process
// lifetime -- it cannot change without a reboot, which also invalidates any
// identity recorded before it. Only a SUCCESSFUL read is cached: a transient
// failure (e.g. a sandboxed /proc) must not poison every later call for the
// rest of the process's lifetime -- each subsequent call gets another chance
// to read it.
let cachedBootId;
function bootId() {
  if (cachedBootId === undefined) {
    try {
      cachedBootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } catch {
      return "";
    }
  }
  return cachedBootId;
}

export function getProcessIdentity(pid, options = {}) {
  if (!isValidPid(pid)) {
    return null;
  }
  if ((options.platform ?? process.platform) === "linux") {
    const startTime = readLinuxProcessStat(pid)?.startTime ?? null;
    if (startTime == null) {
      return null;
    }
    const boot = bootId();
    if (!boot) {
      // boot_id unreadable: a raw tick count is boot-relative and would both
      // collide across boots and falsely mismatch against composite values
      // recorded when boot_id WAS readable. Unknown must never masquerade
      // as a comparable identity.
      return null;
    }
    return `${boot}:${startTime}`;
  }
  const output = queryProcessTable(
    pid,
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($null -ne $p) { [Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks) }`,
    "lstart=",
    options
  );
  return output?.trim() || null;
}

export function isProcessRunning(pid, options = {}) {
  if (!isValidPid(pid)) {
    return false;
  }

  const platform = options.platform ?? process.platform;
  const killImpl = options.killImpl ?? process.kill.bind(process);
  try {
    killImpl(pid, 0);
  } catch (error) {
    if (error?.code === "EPERM") {
      return true;
    }
    if (error?.code === "ESRCH") {
      return false;
    }
    throw error;
  }

  if (platform === "linux") {
    const readProcessStat = options.readProcessStat ?? readLinuxProcessStat;
    const stat = readProcessStat(pid);
    // A null stat means /proc could not be inspected even though kill(pid, 0)
    // proved the process exists. Failure to inspect is not proof of exit or
    // replacement, so stay conservative and keep reporting it as running.
    if (stat) {
      // Zombies still answer kill(pid, 0), but no longer own a live resource.
      if (stat.state === "Z" || stat.state === "X") {
        return false;
      }
      if (options.identity != null) {
        // getProcessIdentity() prefixes Linux identities with the boot id
        // (see its comment); build the same composite here so this direct
        // stat.startTime comparison stays consistent with values recorded
        // through getProcessIdentity(). Only compare when boot_id is
        // currently readable and the composite can actually be formed --
        // a bare tick count is boot-relative and must never be compared
        // directly, which would both collide across boots and falsely
        // mismatch a still-live process against a composite identity
        // recorded when boot_id WAS readable.
        const boot = bootId();
        if (boot) {
          const currentIdentity = `${boot}:${stat.startTime}`;
          if (currentIdentity !== String(options.identity)) {
            return false;
          }
        }
        // boot_id unreadable right now: the comparison cannot be formed, so
        // it proves nothing. Failure to inspect is not proof of replacement.
      }
    }
  } else if (options.identity != null) {
    const currentIdentity = getProcessIdentity(pid, options);
    // Failure to inspect a live process is not proof that it was replaced.
    if (currentIdentity != null && currentIdentity !== String(options.identity)) {
      return false;
    }
  }

  return true;
}

function isLinuxProcessGroupRunning(pid) {
  let entries;
  try {
    entries = fs.readdirSync("/proc", { withFileTypes: true });
  } catch {
    return isProcessRunning(pid);
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
      continue;
    }
    const stat = readLinuxProcessStat(Number(entry.name));
    if (
      stat?.processGroup === String(pid) &&
      stat.state !== "Z" &&
      stat.state !== "X"
    ) {
      return true;
    }
  }
  return false;
}

export function isProcessTreeRunning(pid, options = {}) {
  if (!isValidPid(pid)) {
    return false;
  }
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return isProcessRunning(pid, options);
  }
  if (options.identity != null) {
    const currentIdentity = getProcessIdentity(pid, options);
    if (currentIdentity != null && currentIdentity !== String(options.identity)) {
      // The pid exists and belongs to a different process. POSIX keeps a group
      // leader's pid reserved while its group still has members, so a confirmed
      // replacement also proves the recorded group is gone.
      return false;
    }
    // An absent or unreadable pid proves nothing about survivors in its group;
    // fall through to the group checks below. In particular, a leader that
    // has already exited (identity now unreadable) must not short-circuit
    // here: its process group can still have live descendants.
  }
  if (platform === "linux" && !options.killImpl) {
    return isLinuxProcessGroupRunning(pid);
  }

  const killImpl = options.killImpl ?? process.kill.bind(process);
  try {
    killImpl(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    if (error?.code === "EPERM") {
      return true;
    }
    throw error;
  }
}

export async function waitForProcessExit(pid, options = {}) {
  if (!isValidPid(pid)) {
    return false;
  }
  const timeoutMs = options.timeoutMs ?? 2000;
  const intervalMs = options.intervalMs ?? 25;
  const isRunning = options.tree === false ? isProcessRunning : isProcessTreeRunning;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(pid, options)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return !isRunning(pid, options);
}

function readProcessCommandLine(pid, options) {
  return queryProcessTable(
    pid,
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -ne $p) { [Console]::Out.Write($p.CommandLine) }`,
    "command=",
    options
  );
}

function readLinuxCommandLineArgs(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
  } catch {
    return null;
  }
}

export function processHasLaunchSequence(pid, expectedArgs, options = {}) {
  if (
    !isValidPid(pid) ||
    !Array.isArray(expectedArgs) ||
    expectedArgs.length === 0 ||
    expectedArgs.some((arg) => typeof arg !== "string" || arg.length === 0)
  ) {
    return false;
  }

  if ((options.platform ?? process.platform) === "linux") {
    const argv = readLinuxCommandLineArgs(pid)?.filter(Boolean);
    if (!argv) {
      return false;
    }
    return argv.some((_, start) =>
      expectedArgs.every((expected, offset) => argv[start + offset] === expected)
    );
  }

  const commandLine = readProcessCommandLine(pid, options);
  if (commandLine == null) {
    return false;
  }
  let cursor = 0;
  for (const expected of expectedArgs) {
    const index = commandLine.indexOf(expected, cursor);
    if (index === -1) {
      return false;
    }
    cursor = index + expected.length;
  }
  return true;
}

export function processHasLaunchToken(pid, token, options = {}) {
  if (!isValidPid(pid) || typeof token !== "string" || token.length < 16) {
    return false;
  }

  const marker = options.marker ?? "--worker-token";
  if ((options.platform ?? process.platform) === "linux") {
    const argv = readLinuxCommandLineArgs(pid);
    return argv != null && argv.includes(marker) && argv.includes(token);
  }

  const commandLine = readProcessCommandLine(pid, options);
  if (commandLine == null) {
    return false;
  }
  return commandLine.includes(marker) && commandLine.includes(token);
}

/**
 * Force-kill a process and everything under it, for callers that have already tried a graceful stop.
 *
 * POSIX has a harder signal to escalate to, and the process group addresses the descendants:
 * SIGKILL the group, falling back to the process alone for a caller that never was a group leader.
 *
 * Windows has neither. There are no process groups — a negative pid is just an invalid handle, so
 * `process.kill(-pid)` throws ESRCH and a naive catch-and-retry silently degrades to killing the
 * direct process while its descendants (the app-server, and every MCP server under it) keep
 * running. taskkill's own tree walk is the only way to reach them, and `/F` is already the hardest
 * stop there is, so the Windows branch is the same call as the graceful one.
 */
/**
 * @param {number} pid
 * @param {{ platform?: string, killImpl?: Function, runCommandImpl?: Function }} [options]
 * @returns {{ attempted: boolean, delivered: boolean, method: string | null }}
 */
export function forceKillProcessTree(pid, options = {}) {
  if (!isValidPid(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  if ((options.platform ?? process.platform) === "win32") {
    try {
      const outcome = terminateProcessTree(pid, options);
      return { attempted: outcome.attempted, delivered: outcome.delivered, method: outcome.method };
    } catch {
      // Teardown is best effort: a taskkill that fails outright must not throw at the caller.
      return { attempted: true, delivered: false, method: "taskkill" };
    }
  }

  const killImpl = options.killImpl ?? process.kill.bind(process);
  try {
    killImpl(-pid, "SIGKILL");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch {
    try {
      killImpl(pid, "SIGKILL");
      return { attempted: true, delivered: true, method: "process" };
    } catch {
      return { attempted: true, delivered: false, method: "process" };
    }
  }
}

/**
 * Terminate a process tree and make sure it is actually gone.
 *
 * `terminateProcessTree` sends SIGTERM and stops there, so a descendant that traps or ignores it
 * survives — and when the tree being terminated is our own, we die with the signal and nothing is
 * left to escalate. This keeps the caller alive through its own SIGTERM, gives the tree a grace
 * period to leave on its own, then kills what remains and exits.
 *
 * Only meaningful for a group leader; a caller that is not one signals nothing, which is the
 * existing behaviour of `terminateProcessTree`.
 */
/**
 * @param {number} pid
 * @param {{ graceMs?: number, exitCode?: number, beforeKill?: () => void }} [options]
 */
export function terminateProcessTreeAndExit(pid, { graceMs = 5000, exitCode = 1, beforeKill } = {}) {
  if (pid === process.pid) {
    process.on("SIGTERM", () => {});
  }
  terminateProcessTree(pid);
  // Deliberately not unref'd: this timer is the escalation, and the process must stay up for it.
  setTimeout(() => {
    // Surviving our own SIGTERM means ordinary work keeps running during the grace period and can
    // record an outcome of its own. This is the last moment before the group dies, so a caller
    // that needs the final say gets it here.
    try {
      beforeKill?.();
    } catch {
      // Never let bookkeeping stop the kill.
    }
    // Nothing left in the group, a caller that was never its leader, or a Windows tree that
    // taskkill could not reach: none of them may stop us from exiting.
    forceKillProcessTree(pid);
    process.exit(exitCode);
  }, graceMs);
}

export function terminateProcessTree(pid, options = {}) {
  if (!isValidPid(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    // Probe the root before spawning taskkill at all, rather than parsing its localized "not
    // found" message afterwards: a root that is provably gone is reported the same way in every
    // system language.
    if (isProvablyGone(pid, killImpl)) {
      return { attempted: false, delivered: false, method: null };
    }

    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env,
      shell: false
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    // A non-zero status: taskkill /T walks the tree and then terminates each entry, so a
    // descendant that exits in between — a short-lived git or cmd helper — makes it report a
    // failure although the root did die. The root's own liveness is the fact; its message is not,
    // and matching that message only ever worked in English. `delivered` therefore describes the
    // root only, exactly like the process-group SIGTERM on other platforms: it does not prove
    // that every descendant is gone.
    if (!result.error && isProvablyGone(pid, killImpl)) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch {
    // The group kill also fails with ESRCH when the pid is alive but does not lead its
    // own process group (e.g. a companion started in the foreground of a shell).
    try {
      killImpl(pid, "SIGTERM");
      return { attempted: true, delivered: true, method: "process" };
    } catch (error) {
      if (error?.code === "ESRCH") {
        return { attempted: true, delivered: false, method: "process" };
      }
      throw error;
    }
  }
}

/**
 * Every live process on a POSIX system, as `{ pid, parentPid, processGroup, identity }`.
 *
 * `identity` is the process's start time, so an entry compares equal only to the same process: a
 * pid the system handed to someone else since reads as a different entry. It is `null` when the
 * start time cannot be read, and such an entry is never trusted as a match. Zombies are left out —
 * they own nothing and cannot be signalled into exiting.
 *
 * Returns `null` on Windows, which has no process groups and does not reparent orphans, and when
 * the table itself cannot be read; callers treat that as "nothing is known", never as "nothing is
 * running".
 */
export function listProcesses(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return null;
  }
  if (platform === "linux" && !options.runCommandImpl) {
    let names;
    try {
      names = fs.readdirSync("/proc");
    } catch {
      return null;
    }
    const boot = bootId();
    const readProcessStat = options.readProcessStat ?? readLinuxProcessStat;
    const entries = [];
    for (const name of names) {
      if (!/^\d+$/.test(name)) {
        continue;
      }
      const stat = readProcessStat(Number(name));
      if (!stat || stat.state === "Z" || stat.state === "X") {
        continue;
      }
      entries.push({
        pid: Number(name),
        parentPid: Number(stat.parentPid),
        processGroup: Number(stat.processGroup),
        // Same composite as getProcessIdentity(): a bare tick count is boot-relative.
        identity: boot && stat.startTime != null ? `${boot}:${stat.startTime}` : null
      });
    }
    return entries;
  }

  const runCommandImpl = options.runCommandImpl ?? runCommand;
  // Fixed locale and zone for the same reason as queryProcessTable(): lstart is rendered through
  // the C library, and two readings of one process must print the same.
  const result = runCommandImpl("ps", ["-axww", "-o", "pid=,ppid=,pgid=,stat=,lstart="], {
    timeout: options.timeoutMs ?? 2000,
    killSignal: "SIGTERM",
    env: { ...(options.env ?? process.env), LC_ALL: "C", TZ: "UTC" }
  });
  if (result.error || result.signal != null || result.status !== 0) {
    return null;
  }
  const entries = [];
  for (const line of String(result.stdout ?? "").split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/);
    if (!match || match[4].startsWith("Z")) {
      continue;
    }
    entries.push({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      processGroup: Number(match[3]),
      identity: match[5].replace(/\s+/g, " ")
    });
  }
  return entries;
}

/** The entries of `table` below `rootPid`, following parent links; the root itself is excluded. */
export function descendantsOf(rootPid, table) {
  const children = new Map();
  for (const entry of table) {
    if (entry.pid === entry.parentPid) {
      continue;
    }
    const siblings = children.get(entry.parentPid) ?? [];
    siblings.push(entry);
    children.set(entry.parentPid, siblings);
  }
  const found = [];
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()) ?? []) {
      if (!seen.has(child.pid)) {
        seen.add(child.pid);
        found.push(child);
        queue.push(child.pid);
      }
    }
  }
  return found;
}

/**
 * Keep track of a process tree that outlives its root, and take it down on request.
 *
 * Signalling a root — or even its process group — does not reach everything it started: a child
 * of an app-server that exits on its own is reparented, and parent links no longer lead to it; a
 * child that moved to its own process group (or session) is out of reach of a group signal. Both
 * keep running after their owner is gone, with nothing left that knows about them. So the tree is
 * remembered while it is still intact — each `remember()` adds whatever is below the root right
 * now — and `reap()` signals what is left of it.
 *
 * Every remembered entry carries its start time and is signalled only while a fresh reading still
 * shows the same process under that pid; a pid the system has since reused is left alone. The
 * process group named after the caller is reaped as well — only the caller can have created it —
 * and no identity is needed there; any other group, the caller's shell's included, is left alone.
 *
 * Best effort and never throws. On Windows (and wherever the process table cannot be read) it
 * knows nothing and reaps nothing; the caller's existing teardown is all there is.
 */
export function createProcessTreeTracker(rootPid, options = {}) {
  const selfPid = options.selfPid ?? process.pid;
  const list = () => {
    try {
      return (options.listProcessesImpl ?? listProcesses)(options);
    } catch {
      return null;
    }
  };
  const killImpl = options.killImpl ?? process.kill.bind(process);
  const sleep = options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  /** @type {Map<string, { pid: number, identity: string }>} */
  const owned = new Map();
  const keyOf = (entry) => `${entry.pid}:${entry.identity}`;

  function rememberEntry(entry) {
    if (entry.pid !== selfPid && entry.identity) {
      owned.set(keyOf(entry), { pid: entry.pid, identity: entry.identity });
    }
  }

  /** What, in `table`, is still ours: remembered entries, their new descendants, and our group. */
  function survivors(table) {
    const byPid = new Map(table.map((entry) => [entry.pid, entry]));
    const found = new Map();
    const add = (entry) => {
      if (entry.pid !== selfPid && entry.pid > 1) {
        found.set(entry.pid, entry);
      }
    };
    for (const { pid, identity } of owned.values()) {
      const current = byPid.get(pid);
      if (current && current.identity === identity) {
        add(current);
      }
    }
    // A process group is named after the process that created it, and a pid is unique while its
    // process lives: a group carrying our pid can only be one we started.
    for (const entry of table) {
      if (entry.processGroup === selfPid) {
        add(entry);
      }
    }
    // Something a survivor started after the last reading belongs to us just the same.
    for (const entry of [...found.values()]) {
      for (const child of descendantsOf(entry.pid, table)) {
        add(child);
      }
    }
    return [...found.values()];
  }

  return {
    /** Add whatever is below the root right now, and forget entries that are gone. */
    remember() {
      const table = list();
      if (!table) {
        return;
      }
      const present = new Set(table.map(keyOf));
      for (const key of owned.keys()) {
        if (!present.has(key)) {
          owned.delete(key);
        }
      }
      const root = table.find((entry) => entry.pid === rootPid);
      if (root) {
        rememberEntry(root);
        for (const entry of descendantsOf(rootPid, table)) {
          rememberEntry(entry);
        }
      }
    },

    /**
     * SIGTERM what is left, give it `graceMs` to leave, then SIGKILL whatever still answers to the
     * same identity. Resolves with the pids that were signalled and killed; `known` is false when
     * the process table could not be read, so nothing was.
     */
    async reap({ graceMs = 1000, intervalMs = 25 } = {}) {
      const table = list();
      if (!table) {
        return { known: false, signalled: [], killed: [] };
      }
      const targets = survivors(table);
      for (const entry of targets) {
        try {
          killImpl(entry.pid, "SIGTERM");
        } catch {
          // Gone already, or not ours to signal; either way there is nothing more to do for it.
        }
      }
      if (targets.length === 0) {
        return { known: true, signalled: [], killed: [] };
      }
      const deadline = Date.now() + graceMs;
      let remaining = targets;
      while (remaining.length > 0 && Date.now() < deadline) {
        await sleep(intervalMs);
        const current = list();
        if (!current) {
          break;
        }
        const live = new Set(survivors(current).map(keyOf));
        remaining = remaining.filter((entry) => live.has(keyOf(entry)));
      }
      const killed = [];
      const current = list();
      if (current) {
        const live = new Map(survivors(current).map((entry) => [keyOf(entry), entry]));
        for (const entry of remaining) {
          const still = live.get(keyOf(entry));
          if (!still) {
            continue;
          }
          try {
            killImpl(still.pid, "SIGKILL");
            killed.push(still.pid);
          } catch {
            // Exited between the reading and the kill.
          }
        }
        // A survivor may have started children during the grace period; they get no grace.
        for (const entry of live.values()) {
          if (!targets.some((target) => keyOf(target) === keyOf(entry))) {
            try {
              killImpl(entry.pid, "SIGKILL");
              killed.push(entry.pid);
            } catch {
              // Exited already.
            }
          }
        }
      }
      return { known: true, signalled: targets.map((entry) => entry.pid), killed };
    }
  };
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
