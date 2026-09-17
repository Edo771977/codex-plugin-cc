/**
 * @typedef {Error & { data?: unknown, rpcCode?: number }} ProtocolError
 * @typedef {import("./app-server-protocol").AppServerMethod} AppServerMethod
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").AppServerNotificationHandler} AppServerNotificationHandler
 * @typedef {import("./app-server-protocol").ClientInfo} ClientInfo
 * @typedef {import("./app-server-protocol").CodexAppServerClientOptions} CodexAppServerClientOptions
 * @typedef {import("./app-server-protocol").InitializeCapabilities} InitializeCapabilities
 */
import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { ensureBrokerSession, isBrokerEndpointReady, loadBrokerSession } from "./broker-lifecycle.mjs";
import { commandWithWindowsShim, terminateProcessTree } from "./process.mjs";

const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));

export const BROKER_ENDPOINT_ENV = "CODEX_COMPANION_APP_SERVER_ENDPOINT";
export { BROKER_BUSY_RPC_CODE } from "./broker-endpoint.mjs";

/** How long a failed connect waits for its transport to report an exit before killing it. */
const CONNECT_CLEANUP_GRACE_MS = 5000;

/** @type {ClientInfo} */
const DEFAULT_CLIENT_INFO = {
  title: "Codex Plugin",
  name: "Claude Code",
  version: PLUGIN_MANIFEST.version ?? "0.0.0"
};

/** @type {InitializeCapabilities} */
const DEFAULT_CAPABILITIES = {
  experimentalApi: false,
  requestAttestation: false,
  optOutNotificationMethods: [
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta"
  ]
};

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function createProtocolError(message, data) {
  const error = /** @type {ProtocolError} */ (new Error(message));
  error.data = data;
  if (data?.code !== undefined) {
    error.rpcCode = data.code;
  }
  return error;
}

class AppServerClientBase {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.exitError = null;
    /** @type {AppServerNotificationHandler | null} */
    this.notificationHandler = null;
    this.lineBuffer = "";
    this.transport = "unknown";
    // Only the spawned transport owns a child process; the broker transport
    // talks to one it does not own. Declaring it here keeps the shared cleanup
    // paths honest about the union instead of reaching for a property half the
    // clients never have.
    /** @type {import("node:child_process").ChildProcess | null} */
    this.proc = null;

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  /**
   * @template {AppServerMethod} M
   * @param {M} method
   * @param {import("./app-server-protocol").AppServerRequestParams<M>} params
   * @returns {Promise<import("./app-server-protocol").AppServerResponse<M>>}
   */
  request(method, params) {
    if (this.closed) {
      throw new Error("codex app-server client is closed.");
    }
    // `closed` only covers a close we asked for. The transport can die on its own — between a
    // successful connect and the very next request, for instance — and a request registered after
    // that never resolves, because the exit that would reject it has already been reported.
    if (this.exitResolved) {
      throw this.exitError ?? new Error("codex app-server connection closed.");
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.sendMessage({ id, method, params });
    });
  }

  notify(method, params = {}) {
    if (this.closed || this.exitResolved) {
      return;
    }
    this.sendMessage({ method, params });
  }

  handleChunk(chunk) {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(createProtocolError(`Failed to parse codex app-server JSONL: ${error.message}`, { line }));
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(createProtocolError(message.error.message ?? `codex app-server ${pending.method} failed.`, message.error));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method && this.notificationHandler) {
      this.notificationHandler(/** @type {AppServerNotification} */ (message));
    }
  }

  handleServerRequest(message) {
    this.sendMessage({
      id: message.id,
      error: buildJsonRpcError(-32601, `Unsupported server request: ${message.method}`)
    });
  }

  handleExit(error) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.exitError = error ?? null;

    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new Error("codex app-server connection closed."));
    }
    this.pending.clear();
    this.resolveExit(undefined);
  }

  /**
   * Settle the exit state when initialization failed before a transport existed.
   *
   * `close()` ends by awaiting `exitPromise`, and only a live transport ever resolves it. But
   * initialization can fail before one is created — a malformed endpoint rejects while being
   * parsed, a spawn can throw — and closing then waits for an exit that nothing will report,
   * turning a configuration error into a hang.
   */
  settleExitIfNoTransport(hasTransport) {
    if (!hasTransport) {
      this.handleExit(this.exitError);
    }
  }

  sendMessage(_message) {
    throw new Error("sendMessage must be implemented by subclasses.");
  }
}

class SpawnedCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "direct";
  }

  async initialize() {
    const invocation = commandWithWindowsShim("codex", ["app-server"]);
    this.proc = spawn(invocation.command, invocation.args, {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      // See runCommand(): SHELL is a POSIX convention and is never consulted
      // for Windows process creation. `codex` is a .cmd shim there, so the
      // invocation above wraps it in an explicit cmd.exe call instead.
      shell: invocation.shell,
      windowsHide: true
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });

    this.proc.on("error", (error) => {
      this.handleExit(error);
    });

    this.proc.on("exit", (code, signal) => {
      const stderr = this.stderr.trim();
      const detail =
        code === 0
          ? null
          : createProtocolError(
              `codex app-server exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).${stderr ? `\n${stderr}` : ""}`
            );
      this.handleExit(detail);
    });

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on("line", (line) => {
      this.handleLine(line);
    });

    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;

    if (this.readline) {
      this.readline.close();
    }

    if (this.proc && !this.proc.killed) {
      this.proc.stdin.end();
      setTimeout(() => {
        if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
          // On Windows the direct child is cmd.exe — `codex` is a .cmd shim, so
          // commandWithWindowsShim() spawns `cmd.exe /d /s /c call codex …`.
          // Killing that child alone would leave the app-server grandchild
          // running, so tear down the whole tree.
          if (process.platform === "win32") {
            try {
              terminateProcessTree(this.proc.pid);
            } catch {
              // Best-effort cleanup inside an unref'd timer — swallow errors
              // to avoid crashing the host process during shutdown.
            }
          } else {
            this.proc.kill("SIGTERM");
          }
        }
      }, 50).unref?.();
    }

    this.settleExitIfNoTransport(Boolean(this.proc));
    await this.exitPromise;
  }

  // Immediate teardown for callers that cannot wait for a graceful close
  // (e.g. a timed-out request whose response may never come): kill the
  // process so the exit handler rejects any pending requests.
  destroy() {
    this.closed = true;
    if (this.readline) {
      this.readline.close();
    }
    if (this.proc && !this.proc.killed) {
      try {
        if (process.platform === "win32") {
          // Same as close(): on Windows the direct child is the cmd.exe that
          // runs the `codex` shim, so the whole tree has to go or the
          // app-server grandchild survives the timeout.
          terminateProcessTree(this.proc.pid);
        } else {
          this.proc.kill("SIGKILL");
        }
      } catch {
        // Ignore missing process.
      }
    }
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("codex app-server stdin is not available.");
    }
    stdin.write(line);
  }
}

class BrokerCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "broker";
    this.endpoint = options.brokerEndpoint;
  }

  async initialize() {
    await new Promise((resolve, reject) => {
      const target = parseBrokerEndpoint(this.endpoint);
      this.socket = net.createConnection({ path: target.path });
      this.socket.setEncoding("utf8");
      this.socket.on("connect", resolve);
      this.socket.on("data", (chunk) => {
        this.handleChunk(chunk);
      });
      this.socket.on("error", (error) => {
        if (!this.exitResolved) {
          reject(error);
        }
        this.handleExit(error);
      });
      this.socket.on("close", () => {
        this.handleExit(this.exitError);
      });
    });

    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;
    if (this.socket) {
      this.socket.end();
    }
    this.settleExitIfNoTransport(Boolean(this.socket));
    await this.exitPromise;
  }

  // Immediate teardown for callers that cannot wait for a graceful close: a
  // half-closed socket with a pending request would stay registered as an
  // active request on the broker and keep this process's event loop alive.
  destroy() {
    this.closed = true;
    if (this.socket) {
      this.socket.destroy();
    }
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const socket = this.socket;
    if (!socket) {
      throw new Error("codex app-server broker connection is not connected.");
    }
    socket.write(line);
  }
}

export class CodexAppServerClient {
  static async connect(cwd, options = {}) {
    let brokerEndpoint = null;
    if (!options.disableBroker) {
      brokerEndpoint = options.brokerEndpoint ?? options.env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV] ?? null;
      if (!brokerEndpoint && options.reuseExistingBroker) {
        // Probe before trusting the record. A broker that was killed rather than shut down leaves
        // its session behind, and connecting to that endpoint surfaces ENOENT/ECONNREFUSED as a
        // failure of whatever the caller was doing — an authentication check, most visibly —
        // rather than as a broker that is simply gone. Fall through to spawning instead.
        //
        // The record itself is left alone: `status` and `setup` report a recorded shared runtime
        // whether or not it answers, and reclaiming a dead broker's files belongs to
        // `ensureBrokerSession`, which is the path that actually replaces it.
        const persisted = loadBrokerSession(cwd)?.endpoint ?? null;
        if (persisted && (await isBrokerEndpointReady(persisted))) {
          brokerEndpoint = persisted;
        }
      }
      if (!brokerEndpoint && !options.reuseExistingBroker) {
        const brokerSession = await ensureBrokerSession(cwd, { env: options.env });
        brokerEndpoint = brokerSession?.endpoint ?? null;
      }
    }
    const client = brokerEndpoint
      ? new BrokerCodexAppServerClient(cwd, { ...options, brokerEndpoint })
      : new SpawnedCodexAppServerClient(cwd, options);
    // Hand the instance out before initialize: a caller racing connect
    // against a deadline must be able to destroy a client wedged inside
    // initialize, whose socket/child would otherwise outlive the timeout.
    options.onClientCreated?.(client);
    try {
      await client.initialize();
    } catch (error) {
      // initialize() has usually already spawned the app-server, and with it every configured MCP
      // server. The caller never receives this object, so this is the only chance to reclaim them.
      //
      // Bounded, because close() waits on the transport reporting its exit: an app-server that
      // answered with an error but ignores EOF and SIGTERM would otherwise swallow the original
      // failure entirely and leave the caller waiting forever. Whatever is still up after the
      // grace gets killed outright.
      await Promise.race([
        client.close().catch(() => {}),
        new Promise((resolve) => {
          setTimeout(resolve, CONNECT_CLEANUP_GRACE_MS).unref?.();
        })
      ]);
      if (client.proc && client.proc.exitCode === null && !client.proc.killed) {
        try {
          client.proc.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
      throw error;
    }
    return client;
  }
}
