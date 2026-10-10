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
import { failClosedServerRequestResult } from "./approvals.mjs";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { ensureBrokerSession, loadBrokerSession } from "./broker-lifecycle.mjs";
import { terminateProcessTree } from "./process.mjs";
import { formatPwshNotFoundWarning, prependPathDirectory, resolveCompatiblePwsh } from "./windows-powershell.mjs";

const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));

export const BROKER_ENDPOINT_ENV = "CODEX_COMPANION_APP_SERVER_ENDPOINT";
export const BROKER_BUSY_RPC_CODE = -32001;

// Windows sandbox implementation for the `codex app-server` the companion
// starts. The legacy elevated sandbox runs a "setup refresh" before every
// command that fails while a runtime EXE (node_repl.exe) is in use
// (openai/codex#51822), so every command is rejected; the MXC sandbox does not
// have that step. Passed as a one-off `-c windows.sandbox=<value>` override for
// that process only; ~/.codex/config.toml is not touched.
export const WINDOWS_SANDBOX_ENV = "CODEX_COMPANION_WINDOWS_SANDBOX";
export const WINDOWS_SANDBOX_DEFAULT = "mxc";
// "config": pass no override, so the user's Codex config decides.
export const WINDOWS_SANDBOX_CONFIG = "config";
// The values of WindowsSandboxImplementation in the Codex config schema
// (`codex app-server generate-json-schema`, Codex 0.162). Only these reach the
// command line: on Windows `codex` is started through a shell.
export const WINDOWS_SANDBOX_VALUES = Object.freeze(["mxc", "elevated", "unelevated"]);

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

/**
 * The Windows sandbox the companion asks `codex app-server` to use, or null
 * off Windows (where CODEX_COMPANION_WINDOWS_SANDBOX is ignored).
 *
 * @param {{ platform?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {{ mode: string, source: "plugin-default" | "env" } | null}
 */
export function resolveWindowsSandbox({ platform = process.platform, env = process.env } = {}) {
  if (platform !== "win32") {
    return null;
  }
  const raw = env?.[WINDOWS_SANDBOX_ENV];
  if (raw === undefined || raw.trim() === "") {
    return { mode: WINDOWS_SANDBOX_DEFAULT, source: "plugin-default" };
  }
  const value = raw.trim().toLowerCase();
  if (value !== WINDOWS_SANDBOX_CONFIG && !WINDOWS_SANDBOX_VALUES.includes(value)) {
    throw new Error(
      `Unsupported ${WINDOWS_SANDBOX_ENV}=${JSON.stringify(raw)}. Use one of: ${[...WINDOWS_SANDBOX_VALUES, WINDOWS_SANDBOX_CONFIG].join(", ")} ` +
        `("${WINDOWS_SANDBOX_CONFIG}" keeps the windows.sandbox setting from your Codex config).`
    );
  }
  return { mode: value, source: "env" };
}

/**
 * The Windows sandbox for `/codex:setup`: informational, never throws. An
 * unsupported CODEX_COMPANION_WINDOWS_SANDBOX is reported with its error.
 *
 * @param {{ platform?: string, env?: Record<string, string | undefined> }} [options]
 */
export function describeWindowsSandbox({ platform = process.platform, env = process.env } = {}) {
  try {
    return resolveWindowsSandbox({ platform, env });
  } catch (error) {
    return { mode: null, source: "env", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Arguments for the `codex` process that runs the app-server. Only the
 * process that executes commands gets the sandbox override; `codex --version`
 * and `codex app-server --help|generate-json-schema` run nothing.
 *
 * @param {{ platform?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {string[]}
 */
export function buildAppServerSpawnArgs({ platform = process.platform, env = process.env } = {}) {
  const sandbox = resolveWindowsSandbox({ platform, env });
  if (!sandbox || sandbox.mode === WINDOWS_SANDBOX_CONFIG) {
    return ["app-server"];
  }
  return ["-c", `windows.sandbox=${sandbox.mode}`, "app-server"];
}

let pwshWarningShown = false;

function warnOncePerProcess(message) {
  if (pwshWarningShown) {
    return;
  }
  pwshWarningShown = true;
  process.stderr.write(`${message}\n`);
}

/**
 * Environment for the `codex` process that runs the app-server. On Windows a
 * usable PowerShell 7 goes first on its PATH, so Codex's shell detection
 * (`pwsh` on PATH first) picks it instead of Windows PowerShell 5.1; the rest
 * of the environment and the original PATH are kept. Without one, env is
 * returned as is and a warning explains how to point the plugin at pwsh.exe.
 * An unusable CODEX_COMPANION_PWSH throws. Other platforms: env unchanged.
 *
 * @param {{ platform?: string, env?: Record<string, string | undefined>, findPwsh?: typeof resolveCompatiblePwsh, warn?: (message: string) => void }} [options]
 * @returns {Record<string, string | undefined>}
 */
export function buildAppServerSpawnEnv({
  platform = process.platform,
  env = process.env,
  findPwsh = resolveCompatiblePwsh,
  warn = warnOncePerProcess
} = {}) {
  if (platform !== "win32") {
    return env;
  }
  const pwsh = findPwsh({ platform, env });
  if (pwsh?.status === "found") {
    return prependPathDirectory(env, pwsh.directory);
  }
  if (pwsh?.status === "not-found") {
    warn(formatPwshNotFoundWarning(pwsh));
  }
  return env;
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
    this.serverRequestHandler = null;
    this.lineBuffer = "";
    this.transport = "unknown";

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  /**
   * Install the handler for server-initiated requests (approvals, elicitation).
   * It may be async; an optional `handler.onResolved(params)` hears
   * `serverRequest/resolved` for requests the server closed on its own, and
   * an optional `handler.onClosed()` runs when the connection ends.
   */
  setServerRequestHandler(handler) {
    this.serverRequestHandler = handler ?? null;
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

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.sendMessage({ id, method, params });
    });
  }

  notify(method, params = {}) {
    if (this.closed) {
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

    if (message.method === "serverRequest/resolved") {
      this.serverRequestHandler?.onResolved?.(message.params);
    }

    if (message.method && this.notificationHandler) {
      this.notificationHandler(/** @type {AppServerNotification} */ (message));
    }
  }

  handleServerRequest(message) {
    // Without a handler, approval requests are declined (fail-closed) rather
    // than answered "unsupported", which Codex treats as a broken turn.
    const handler = this.serverRequestHandler ?? failClosedServerRequestResult;
    const reply = (payload) => {
      // After the connection ended (e.g. onClosed declined a waiting request
      // because `codex app-server` died) there is nobody to answer, and a
      // write to the dead stdin would fail with EPIPE.
      if (this.closed || this.exitResolved) {
        return;
      }
      try {
        this.sendMessage({ id: message.id, ...payload });
      } catch {
        // The transport went away between the check and the write.
      }
    };
    Promise.resolve()
      .then(() => handler(message))
      .then(
        (result) => reply({ result: result ?? {} }),
        (error) => reply({ error: buildJsonRpcError(error?.rpcCode ?? -32000, error?.message ?? String(error)) })
      );
  }

  handleExit(error) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.exitError = error ?? null;
    // Server requests still waiting for an answer can no longer be answered.
    this.serverRequestHandler?.onClosed?.();

    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new Error("codex app-server connection closed."));
    }
    this.pending.clear();
    this.resolveExit(undefined);
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
    const baseEnv = this.options.env ?? process.env;
    // `platform` and `findPwsh` only let tests apply the Windows launch rules.
    const platform = this.options.platform ?? process.platform;
    const args = buildAppServerSpawnArgs({ platform, env: baseEnv });
    const env = buildAppServerSpawnEnv({
      platform,
      env: baseEnv,
      ...(this.options.findPwsh ? { findPwsh: this.options.findPwsh } : {})
    });
    this.proc = spawn("codex", args, {
      cwd: this.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
      windowsHide: true
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    // A write racing the child's exit fails asynchronously (EPIPE); the exit
    // itself is reported through "exit", so do not let it crash the process.
    this.proc.stdin.on("error", () => {});

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
          // On Windows with shell: true, the direct child is cmd.exe.
          // Use terminateProcessTree to kill the entire tree including
          // the grandchild node process.
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

    await this.exitPromise;
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
    await this.exitPromise;
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
        brokerEndpoint = loadBrokerSession(cwd)?.endpoint ?? null;
      }
      if (!brokerEndpoint && !options.reuseExistingBroker) {
        // Reject an unsupported CODEX_COMPANION_WINDOWS_SANDBOX here rather
        // than after the broker failed to start its app-server.
        buildAppServerSpawnArgs({ env: options.env ?? process.env });
        const brokerSession = await ensureBrokerSession(cwd, {
          env: options.env,
          // Only when a new broker is started: an unusable CODEX_COMPANION_PWSH
          // or a missing PowerShell 7 is reported here, where the user sees it,
          // not only in the broker log. The broker's own app-server gets the
          // same PATH from buildAppServerSpawnEnv; the broker's env is unchanged.
          beforeSpawn: () => {
            buildAppServerSpawnEnv({ env: options.env ?? process.env });
          }
        });
        brokerEndpoint = brokerSession?.endpoint ?? null;
      }
    }
    const client = brokerEndpoint
      ? new BrokerCodexAppServerClient(cwd, { ...options, brokerEndpoint })
      : new SpawnedCodexAppServerClient(cwd, options);
    await client.initialize();
    return client;
  }
}
