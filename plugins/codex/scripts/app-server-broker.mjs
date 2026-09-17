#!/usr/bin/env node

import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./lib/app-server.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";
import { ensurePrivateDir, writePrivateFile } from "./lib/fs.mjs";
import {
  clearBrokerSession,
  loadBrokerSession,
  teardownBrokerSession
} from "./lib/broker-lifecycle.mjs";
import {
  armTimeout,
  brokerIdleShutdownMs,
  brokerStartupTimeoutMs,
  disarmTimeout
} from "./lib/lifecycle-limits.mjs";
import { terminateProcessTreeAndExit } from "./lib/process.mjs";

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);
const SUBSCRIBING_METHODS = new Set(["thread/start", "thread/resume", "thread/fork"]);
const UNSUBSCRIBE_RETRY_DELAYS_MS = [100, 500, 2000];
// Upper bound on how long a request waits for an in-flight thread/unsubscribe of
// the same thread. A hung cleanup request must not wedge the shared broker.
const UNSUBSCRIBE_WAIT_TIMEOUT_MS = 5000;

// Resolves true once the promise settles, or false if the timeout expires first.
function settleWithin(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise.then(
      () => true,
      () => true
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    })
  ]).finally(() => clearTimeout(timer));
}

function buildSubscriptionThreadIds(method, result) {
  const threadIds = new Set();
  if (SUBSCRIBING_METHODS.has(method) && result?.thread?.id) {
    threadIds.add(result.thread.id);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}

function buildProvisionalSubscriptionThreadIds(method, params) {
  const threadIds = new Set();
  if (method === "thread/resume" && params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && params?.threadId) {
    threadIds.add(params.threadId);
  }
  return threadIds;
}

function buildNotificationSubscriptionRelationships(message) {
  const relationships = [];
  const thread = message?.method === "thread/started" ? message.params?.thread : null;
  if (thread?.id && thread?.parentThreadId) {
    relationships.push({ sourceThreadId: thread.parentThreadId, subscribedThreadId: thread.id });
  }

  const item = message?.params?.item;
  if (item?.type === "collabAgentToolCall" && item?.senderThreadId && Array.isArray(item.receiverThreadIds)) {
    for (const threadId of item.receiverThreadIds) {
      if (threadId) {
        relationships.push({ sourceThreadId: item.senderThreadId, subscribedThreadId: threadId });
      }
    }
  }
  return relationships;
}

/** How long each step of a shutdown waits before giving up and going down without it. */
const SHUTDOWN_GRACE_MS = 5000;

/** How many abandoned turns to keep discarding notifications for. */
const ABANDONED_THREAD_MEMORY = 32;

/** A deadline that never keeps the event loop alive on its own. */
function grace(ms = SHUTDOWN_GRACE_MS) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

/** Whether the app-server — and with it every configured MCP server — has been started. */
let backendStarted = false;

function buildStreamThreadIds(method, params, result) {
  const threadIds = new Set();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}

/**
 * The single thread the started turn actually runs on.
 *
 * A detached review streams on the review thread it just created, not on the source thread it was
 * launched from. Both need routing, but only this one will ever produce a completion — marking the
 * other abandoned would leave it marked for good, and every later turn resumed on it would have
 * its notifications discarded.
 */
function turnThreadId(method, params, result) {
  if (method === "review/start") {
    return result?.reviewThreadId ?? params?.threadId ?? null;
  }
  return params?.threadId ?? null;
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function isInterruptRequest(message) {
  return message?.method === "turn/interrupt";
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  ensurePrivateDir(path.dirname(pidFile));
  writePrivateFile(pidFile, `${process.pid}\n`);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error(
      "Usage: node scripts/app-server-broker.mjs serve --endpoint <value> --instance-token <value> [--cwd <path>] [--pid-file <path>] [--log-file <path>]"
    );
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint", "instance-token", "log-file"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }
  if (!options["instance-token"]) {
    throw new Error("Missing required --instance-token.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  const instanceToken = String(options["instance-token"]);
  const logFile = options["log-file"] ? path.resolve(options["log-file"]) : null;
  writePidFile(pidFile);

  // Connecting spawns the app-server, which in turn spawns every configured MCP server. Until the
  // listener below is up there is no idle timer and no parent watching — the spawning client gives
  // up after a couple of seconds and, on the normal path, kills nothing. So bound the startup
  // itself: a wedged connect would otherwise strand this whole tree for good.
  const startupTimeoutMs = brokerStartupTimeoutMs();
  const startupTimer = armTimeout(startupTimeoutMs, () => {
    process.stderr.write(`broker startup exceeded ${startupTimeoutMs}ms; terminating\n`);
    terminateProcessTreeAndExit(process.pid);
  });

  const appClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  backendStarted = true;
  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  const sockets = new Set();
  // Sockets whose request is a broker/shutdown: two racing session-end hooks
  // must not count each other as busy clients, or both back off and the idle
  // broker leaks with no future event to retire it.
  const shutdownRequesters = new Set();
  // Turns whose client left before the stream could be handed over: their notifications go
  // nowhere, and they are interrupted rather than left running for the next client to receive.
  const abandonedThreadIds = new Set();
  // Completions seen while a streaming start is still awaiting its response. Scoped to that
  // window and cleared when it closes, so nothing here can outlive the handoff it belongs to.
  const completedDuringHandoff = new Set();
  let pendingStreamStarts = 0;
  const idleShutdownMs = brokerIdleShutdownMs();
  let idleTimer = null;
  let shuttingDown = false;
  let shutdownPromise = null;

  // App-server subscriptions belong to the broker's single upstream connection.
  // Mirror downstream ownership so one client cannot release another client's thread.
  const socketThreadIds = new Map();
  const threadSockets = new Map();
  const pendingUnsubscribes = new Map();
  const unsubscribeRetryTimers = new Map();
  // Threads a socket claimed for a request that has not succeeded yet, plus any
  // child threads it inherited through those claims while the request was open.
  const provisionalClaims = new Map();

  function cancelUnsubscribeRetry(threadId) {
    const retry = unsubscribeRetryTimers.get(threadId);
    if (!retry) {
      return;
    }
    clearTimeout(retry.timer);
    unsubscribeRetryTimers.delete(threadId);
  }

  function addThreadOwner(socket, threadId) {
    cancelUnsubscribeRetry(threadId);
    let ownedThreadIds = socketThreadIds.get(socket);
    if (!ownedThreadIds) {
      ownedThreadIds = new Set();
      socketThreadIds.set(socket, ownedThreadIds);
    }
    if (ownedThreadIds.has(threadId)) {
      return false;
    }
    ownedThreadIds.add(threadId);

    let owners = threadSockets.get(threadId);
    if (!owners) {
      owners = new Set();
      threadSockets.set(threadId, owners);
    }
    owners.add(socket);
    return true;
  }

  function removeThreadOwner(socket, threadId) {
    const ownedThreadIds = socketThreadIds.get(socket);
    if (!ownedThreadIds?.delete(threadId)) {
      return false;
    }
    if (ownedThreadIds.size === 0) {
      socketThreadIds.delete(socket);
    }

    const owners = threadSockets.get(threadId);
    owners?.delete(socket);
    if (owners?.size === 0) {
      threadSockets.delete(threadId);
    }
    return true;
  }

  function requestThreadUnsubscribe(threadId) {
    // A request that has already been sent is never reused: the thread may have
    // been reacquired and released again while it was in flight. A request that
    // is still queued behind an earlier one re-checks ownership when it sends, so
    // every release until then can share it instead of growing the chain.
    const previous = pendingUnsubscribes.get(threadId);
    if (previous && !previous.sent) {
      return previous.request;
    }
    const entry = { request: null, sent: false };
    const execute = async () => {
      if (previous) {
        // Wait without a bound. The pending entry must not settle while any
        // earlier upstream unsubscribe for this thread is still outstanding,
        // otherwise a retried claim could slip past a hung cleanup request.
        await previous.request.then(
          () => {},
          () => {}
        );
      }
      if (threadSockets.has(threadId)) {
        return { result: null, error: null, skipped: true };
      }
      entry.sent = true;
      const result = await appClient.request("thread/unsubscribe", { threadId });
      return { result, error: null };
    };
    entry.request = execute().then(
      (outcome) => {
        if (pendingUnsubscribes.get(threadId) === entry) {
          pendingUnsubscribes.delete(threadId);
        }
        return outcome;
      },
      (error) => {
        if (pendingUnsubscribes.get(threadId) === entry) {
          pendingUnsubscribes.delete(threadId);
        }
        process.stderr.write(
          `Failed to unsubscribe Codex thread ${threadId}: ${error instanceof Error ? error.message : String(error)}\n`
        );
        return { result: null, error };
      }
    );
    pendingUnsubscribes.set(threadId, entry);
    return entry.request;
  }

  function scheduleUnsubscribeRetry(threadId, retryIndex) {
    if (
      retryIndex >= UNSUBSCRIBE_RETRY_DELAYS_MS.length ||
      unsubscribeRetryTimers.has(threadId) ||
      threadSockets.has(threadId) ||
      appClient.closed
    ) {
      return;
    }
    const timer = setTimeout(() => {
      unsubscribeRetryTimers.delete(threadId);
      void unsubscribeIfUnowned(threadId, { retryOnFailure: true, retryIndex: retryIndex + 1 });
    }, UNSUBSCRIBE_RETRY_DELAYS_MS[retryIndex]);
    timer.unref?.();
    unsubscribeRetryTimers.set(threadId, { timer, retryIndex });
  }

  async function unsubscribeIfUnowned(threadId, { retryOnFailure = false, retryIndex = 0 } = {}) {
    if (threadSockets.has(threadId) || appClient.closed) {
      cancelUnsubscribeRetry(threadId);
      return null;
    }
    const outcome = await requestThreadUnsubscribe(threadId);
    if (outcome.error && retryOnFailure) {
      scheduleUnsubscribeRetry(threadId, retryIndex);
    } else if (!outcome.error) {
      cancelUnsubscribeRetry(threadId);
    }
    return outcome;
  }

  async function releaseThreadOwners(socket, threadIds = socketThreadIds.get(socket) ?? new Set()) {
    const releasedThreadIds = [];
    for (const threadId of [...threadIds]) {
      if (removeThreadOwner(socket, threadId) && !threadSockets.has(threadId)) {
        releasedThreadIds.push(threadId);
      }
    }
    await Promise.all(
      releasedThreadIds.map((threadId) => unsubscribeIfUnowned(threadId, { retryOnFailure: true }))
    );
  }

  function trackSubscriptionResults(socket, method, result) {
    for (const threadId of buildSubscriptionThreadIds(method, result)) {
      if (socket.destroyed || !sockets.has(socket)) {
        void unsubscribeIfUnowned(threadId, { retryOnFailure: true });
        continue;
      }
      addThreadOwner(socket, threadId);
    }
  }

  function trackNotificationSubscriptions(message) {
    // App-server can auto-subscribe its connection to subagent threads. Attribute
    // each child to the downstream owners of its causal parent, not the client
    // that happens to be active when a delayed notification arrives.
    for (const { sourceThreadId, subscribedThreadId } of buildNotificationSubscriptionRelationships(message)) {
      const sourceOwners = [...(threadSockets.get(sourceThreadId) ?? [])].filter(
        (socket) => !socket.destroyed && sockets.has(socket)
      );
      if (sourceOwners.length === 0) {
        void unsubscribeIfUnowned(subscribedThreadId, { retryOnFailure: true });
        continue;
      }
      if (pendingUnsubscribes.has(subscribedThreadId)) {
        // A cleanup request for this child is still outstanding, so its upstream
        // subscription is going away. Do not hand it to new owners.
        continue;
      }
      for (const socket of sourceOwners) {
        if (addThreadOwner(socket, subscribedThreadId)) {
          // Ownership inherited through a claim that has not succeeded yet is
          // rolled back with that claim. The source may itself be an inherited
          // child, so nested descendants are recorded too.
          const claim = provisionalClaims.get(socket);
          if (claim && (claim.threadIds.has(sourceThreadId) || claim.inheritedThreadIds.has(sourceThreadId))) {
            claim.inheritedThreadIds.add(subscribedThreadId);
          }
        }
      }
    }
  }

  async function handleThreadUnsubscribe(socket, params) {
    const threadId = params?.threadId;
    if (typeof threadId !== "string") {
      return appClient.request("thread/unsubscribe", params ?? {});
    }

    const ownedThreadIds = socketThreadIds.get(socket);
    if (!ownedThreadIds?.has(threadId)) {
      if (threadSockets.has(threadId)) {
        return { status: "notSubscribed" };
      }
      const outcome = await unsubscribeIfUnowned(threadId);
      if (outcome?.error) {
        throw outcome.error;
      }
      return outcome?.result ?? { status: "notSubscribed" };
    }

    removeThreadOwner(socket, threadId);
    if (threadSockets.has(threadId)) {
      return { status: "unsubscribed" };
    }

    const outcome = await unsubscribeIfUnowned(threadId);
    if (outcome?.error) {
      if (!socket.destroyed && sockets.has(socket)) {
        addThreadOwner(socket, threadId);
      } else {
        // The requester is gone, so nobody will retry on its behalf. Fall back
        // to the automatic cleanup path for the now-unowned thread.
        scheduleUnsubscribeRetry(threadId, 0);
      }
      throw outcome.error;
    }
    return outcome?.result ?? { status: "unsubscribed" };
  }

  function clearSocketOwnership(socket) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      activeStreamSocket = null;
      activeStreamThreadIds = null;
    }
  }

  /**
   * Stop a turn whose client left before it could be handed the stream.
   *
   * Leaving it running is not harmless: nobody is reading it, and its notifications would be
   * delivered to whichever client connects next, because routing follows whoever currently owns
   * the broker rather than the turn that produced them.
   */
  async function abandonStream(threadId, turnId) {
    if (!threadId) {
      return;
    }
    // Bounded: an interrupt need not be followed by a completion, and an entry left here
    // silently discards every future turn on that thread.
    if (abandonedThreadIds.size >= ABANDONED_THREAD_MEMORY) {
      abandonedThreadIds.delete(abandonedThreadIds.values().next().value);
    }
    abandonedThreadIds.add(threadId);
    try {
      // The turn id is required alongside the thread; without it the interrupt is rejected and
      // the turn we meant to stop keeps running while its thread stays marked abandoned.
      await appClient.request("turn/interrupt", { threadId, turnId });
    } catch {
      // Best effort: the turn may already be finishing on its own.
    }
  }

  function routeNotification(message) {
    const threadId = message.params?.threadId ?? null;

    // An abandoned turn belongs to a client that is gone. Never hand it to whoever is here now.
    if (threadId && abandonedThreadIds.has(threadId)) {
      if (message.method === "turn/completed") {
        abandonedThreadIds.delete(threadId);
        armIdleShutdown();
      }
      return;
    }

    // The response and its completion can arrive in one chunk, so a completion can land before the
    // request continuation assigns ownership. Remember it, or that continuation would take
    // ownership of a turn that is already over and hold the broker busy until the client leaves.
    //
    // Recorded by window rather than by identity: a detached review runs on a thread it only names
    // in its response, so there is nothing to match against beforehand. The window is what makes
    // this safe — an entry cannot outlive the start it raced, and the continuation checks it
    // against the threads the response actually reports.
    if (message.method === "turn/completed" && threadId && pendingStreamStarts > 0) {
      completedDuringHandoff.add(threadId);
    }

    const target = activeRequestSocket ?? activeStreamSocket;
    trackNotificationSubscriptions(message);
    if (!target) {
      return;
    }
    send(target, message);
    if (message.method === "turn/completed" && activeStreamSocket === target) {
      if (!threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId)) {
        activeStreamSocket = null;
        activeStreamThreadIds = null;
        if (activeRequestSocket === target) {
          activeRequestSocket = null;
        }
        // Releasing ownership can be the moment the broker becomes idle — the client may already
        // have disconnected mid-turn. Nothing else fires afterwards, so if the timer is not armed
        // here it never is.
        armIdleShutdown();
      }
    }
  }

  function isBrokerBusy() {
    return sockets.size > 0 || activeRequestSocket !== null || activeStreamSocket !== null;
  }

  function cancelIdleShutdown() {
    disarmTimeout(idleTimer);
    idleTimer = null;
  }

  // A broker outlives the client that spawned it, so without this it survives a crashed or
  // timed-out SessionEnd hook and keeps its app-server (and every MCP server under it) alive
  // indefinitely. Re-armed whenever the last client disconnects, cancelled when one connects.
  function armIdleShutdown() {
    cancelIdleShutdown();
    // A shutdown already in flight must not be rescheduled behind itself; sockets closing as part
    // of it would otherwise arm a timer for a broker that is on its way out.
    if (shuttingDown || isBrokerBusy()) {
      return;
    }
    idleTimer = armTimeout(idleShutdownMs, async () => {
      idleTimer = null;
      if (isBrokerBusy()) {
        armIdleShutdown();
        return;
      }
      await shutdown(server).catch(() => {});
      process.exit(0);
    });
  }

  async function shutdown(server, responseSocket = null) {
    // Every entry point — the idle timer, `broker/shutdown`, SIGTERM, SIGINT — can land while
    // another is mid-flight. Run once and let the rest await that same pass.
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shutdownPromise = runShutdown(server, responseSocket);
    return shutdownPromise;
  }

  async function runShutdown(server, responseSocket) {
    cancelIdleShutdown();
    // Pending unsubscribe retries are timers on a broker that is going away: left
    // armed they would fire against a closed app-server.
    for (const { timer } of unsubscribeRetryTimers.values()) {
      clearTimeout(timer);
    }
    unsubscribeRetryTimers.clear();
    // Stop accepting before the first await. Otherwise a client can connect while we are closing
    // the app-server, get a broker that looks alive but has no backend, and hold server.close()
    // open on a socket nobody will serve.
    shuttingDown = true;
    const closed = new Promise((resolve) => server.close(() => resolve()));

    for (const socket of sockets) {
      if (socket === responseSocket) {
        socket.destroySoon();
      } else {
        socket.destroy();
      }
    }

    // A wedged app-server must not outlive the guard meant to reclaim it: waiting on it forever
    // is exactly how the tree survives.
    let backendClosed = false;
    const settled = () => {
      backendClosed = true;
    };
    await Promise.race([appClient.close().then(settled, settled), grace()]);

    // `end()` only half-closes: a client holding its read side open keeps server.close() pending
    // for as long as it likes, which would hang SIGTERM and broker/shutdown just as surely.
    await Promise.race([closed, grace()]);
    for (const socket of sockets) {
      socket.destroy();
    }

    // Clean up after ourselves. When the idle timer fires there is no session-end hook to run
    // teardown for us, so these would otherwise survive every expiry.
    //
    // The artifacts are ours unconditionally — we were told their paths at startup precisely so
    // that this does not depend on the shared record, which by now may name a broker that
    // superseded us while we sat idle. The record itself is the one thing we must not touch in
    // that case: it belongs to whoever it points at.
    try {
      teardownBrokerSession({
        endpoint,
        pidFile,
        logFile,
        sessionDir: pidFile ? path.dirname(pidFile) : null,
        ownershipVerified: true
      });
    } catch {
      // Best effort; never let bookkeeping block the shutdown.
    }

    try {
      if (loadBrokerSession(cwd)?.endpoint === endpoint) {
        clearBrokerSession(cwd);
      }
    } catch {
      // Best effort; a record we cannot read is one we must not delete.
    }

    // If the app-server never acknowledged the close, it is still running — and on POSIX the
    // client's own fallback signals only its direct pid, so the MCP servers under it would outlive
    // this broker and defeat the whole point of shutting down. Take the group with us. Done last,
    // after the artifacts and the record are already cleaned up, because this ends us too.
    if (!backendClosed) {
      terminateProcessTreeAndExit(process.pid);
    }
  }

  appClient.setNotificationHandler(routeNotification);

  const server = net.createServer((socket) => {
    if (shuttingDown) {
      // Racing a shutdown already in flight: refuse cleanly so the caller falls back to starting
      // its own broker rather than talking to one whose app-server is going away.
      socket.destroy();
      return;
    }
    sockets.add(socket);
    cancelIdleShutdown();
    socket.setEncoding("utf8");
    let buffer = "";


    let processing = Promise.resolve();

    // Every line is handled to completion before the next one starts. Without this a second
    // data event can interleave with an await inside the first, and the per-request ownership
    // claims below stop being a correct picture of who holds which thread.
    async function handleLine(line) {
      if (!line.trim() || socket.destroyed || !sockets.has(socket)) {
        return;
      }


        if (!line.trim()) {
          return;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          return;
        }

        // `null`, a bare number and an array are all valid JSON. Dereferencing them below would
        // throw inside this async listener, which on current Node takes the whole broker down —
        // detached, so nothing tears down its app-server or its session record.
        if (message === null || typeof message !== "object" || Array.isArray(message)) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32600, "Invalid JSON-RPC message: expected an object.")
          });
          return;
        }

        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: {
              userAgent: "codex-companion-broker"
            }
          });
          return;
        }

        if (message.method === "initialized" && message.id === undefined) {
          return;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          shutdownRequesters.add(socket);
          if (message.params?.instanceToken !== instanceToken) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(-32003, "Broker shutdown identity did not match this instance.")
            });
            return;
          }
          // Teardown must be atomic with client admission: a client that
          // connected between a session-end guard check and this shutdown
          // request must not have the broker killed under it — including a
          // worker that is between requests, when the per-request
          // serialization variables are momentarily clear. Peer shutdown
          // requesters are not work and never count as busy.
          let busyWithAnotherConnection = false;
          for (const other of sockets) {
            if (other !== socket && !other.destroyed && !shutdownRequesters.has(other)) {
              busyWithAnotherConnection = true;
              break;
            }
          }
          if (busyWithAnotherConnection) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
            });
            return;
          }
          send(socket, {
            id: message.id,
            result: { pid: process.pid, instanceToken }
          });
          await shutdown(server, socket);
          process.exit(0);
        }

        if (message.id === undefined) {
          return;
        }

        const allowInterruptDuringActiveStream =
          isInterruptRequest(message) && activeStreamSocket && activeStreamSocket !== socket && !activeRequestSocket;

        if (
          ((activeRequestSocket && activeRequestSocket !== socket) || (activeStreamSocket && activeStreamSocket !== socket)) &&
          !allowInterruptDuringActiveStream
        ) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
          });
          return;
        }

        if (allowInterruptDuringActiveStream) {
          try {
            const result = await appClient.request(message.method, message.params ?? {});
            send(socket, { id: message.id, result });
          } catch (error) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
            });
          }
          return;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);

        // Claim the thread ids this request already names before awaiting the
        // app-server, so another client's close handler cannot unsubscribe a
        // thread this one is concurrently resuming.
        const provisionalThreadIds = buildProvisionalSubscriptionThreadIds(message.method, message.params ?? {});
        const addedProvisionalThreadIds = new Set();
        for (const threadId of provisionalThreadIds) {
          if (addThreadOwner(socket, threadId)) {
            addedProvisionalThreadIds.add(threadId);
          }
        }
        const claim = { threadIds: addedProvisionalThreadIds, inheritedThreadIds: new Set() };
        if (addedProvisionalThreadIds.size > 0) {
          provisionalClaims.set(socket, claim);
        }
        const rollBackClaim = () => {
          if (provisionalClaims.get(socket) === claim) {
            provisionalClaims.delete(socket);
          }
          void releaseThreadOwners(socket, new Set([...claim.threadIds, ...claim.inheritedThreadIds]));
        };

        activeRequestSocket = socket;

        // Let an in-flight unsubscribe for the same thread settle first so it cannot overtake the
        // new subscription. The wait is bounded: a hung cleanup request must not hold this client
        // or keep the broker busy for everyone else.
        const gatedThreadIds = new Set(provisionalThreadIds);
        if (message.method === "thread/unsubscribe" && typeof message.params?.threadId === "string") {
          gatedThreadIds.add(message.params.threadId);
        }
        const settled = await Promise.all(
          [...gatedThreadIds].map((threadId) => {
            const pending = pendingUnsubscribes.get(threadId);
            return pending ? settleWithin(pending.request, UNSUBSCRIBE_WAIT_TIMEOUT_MS) : true;
          })
        );
        if (settled.includes(false)) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(
              -32000,
              "Codex thread is still being released upstream; retry the request shortly."
            )
          });
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
            // This request never reached the app-server, so no notification follows to arm the
            // timer later.
            armIdleShutdown();
          }
          rollBackClaim();
          return;
        }

        // A detached review streams on a thread it only names in its response, so a completion
        // racing that response cannot be recognised by thread id in advance. Record completions
        // for the duration of the start instead, and match them once the response tells us which
        // threads this turn actually uses.
        if (isStreaming) {
          pendingStreamStarts += 1;
        }

        try {
          const result =
            message.method === "thread/unsubscribe"
              ? await handleThreadUnsubscribe(socket, message.params ?? {})
              : await appClient.request(message.method, message.params ?? {});
          trackSubscriptionResults(socket, message.method, result);
          if (provisionalClaims.get(socket) === claim) {
            provisionalClaims.delete(socket);
          }
          send(socket, { id: message.id, result });
          if (isStreaming) {
            const threadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
            const finishedAlready = [...threadIds].some((id) => completedDuringHandoff.has(id));
            if (finishedAlready) {
              // Over before we got here: nothing to hand over, and nothing to abandon. Marking it
              // abandoned now would be permanent — interrupting a finished turn need not produce
              // another completion to clear the mark, and every later turn on that thread would
              // have its notifications discarded, including the one its caller is waiting for.
            } else if (!sockets.has(socket)) {
              // The client left while the turn was starting. Taking ownership on its behalf would
              // hold the broker busy for a socket nobody reads; leaving the turn running would let
              // its notifications reach the next client. Stop it instead — the turn's own thread
              // only, since that is the one that will report the completion clearing the mark.
              await abandonStream(
                turnThreadId(message.method, message.params ?? {}, result),
                result?.turn?.id ?? null
              );
            } else {
              activeStreamSocket = socket;
              activeStreamThreadIds = threadIds;
            }
          }
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
            // The close handler could not arm the timer while this request still owned the broker,
            // and for a non-streaming request no notification follows to do it later. Releasing
            // ownership here can therefore be the last event the broker ever sees.
            armIdleShutdown();
          }
        } catch (error) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
          });
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
          if (activeStreamSocket === socket && !isStreaming) {
            activeStreamSocket = null;
            activeStreamThreadIds = null;
          }
          armIdleShutdown();
          // Released after replying: a hung upstream unsubscribe must not withhold the error or
          // leave the broker busy for other clients.
          rollBackClaim();
        } finally {
          // The handoff is over either way. Once no start is in flight, a completion belongs to a
          // running turn rather than to a race, so nothing recorded here may survive.
          if (isStreaming) {
            pendingStreamStarts -= 1;
            if (pendingStreamStarts === 0) {
              completedDuringHandoff.clear();
            }
          }
        }
    }

    socket.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        processing = processing.then(() => handleLine(line)).catch((error) => {
          process.stderr.write(
            `Failed to process broker request: ${error instanceof Error ? error.message : String(error)}\n`
          );
        });
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      shutdownRequesters.delete(socket);
      clearSocketOwnership(socket);
      void releaseThreadOwners(socket);
      armIdleShutdown();
    });

    socket.on("error", () => {
      sockets.delete(socket);
      shutdownRequesters.delete(socket);
      clearSocketOwnership(socket);
      void releaseThreadOwners(socket);
      armIdleShutdown();
    });
  });

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, async () => {
      await shutdown(server);
      process.exit(0);
    });
  }

  // Startup is over once we are accepting; from here the idle timer takes over. A broker nobody
  // ever connects to must not linger either, so arm it immediately.
  //
  // A listen failure — a stale socket path, a permission problem, an address already in use —
  // must reach main()'s handler rather than surfacing as an unhandled error event, or the process
  // dies with its app-server and MCP servers still running and its session record still on disk.
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenTarget.path, () => {
      server.off("error", reject);
      disarmTimeout(startupTimer);
      armIdleShutdown();
      resolve();
    });
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  // Once the app-server is up it has its own MCP servers under it, and this process is detached —
  // exiting alone would leave that tree with no parent and no record, the leak this script exists
  // to prevent. Only then, though: a bad argument fails before anything was spawned, and there is
  // nothing to take down.
  if (backendStarted) {
    terminateProcessTreeAndExit(process.pid);
    return;
  }
  process.exit(1);
});
