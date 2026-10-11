import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { resolveStateDir } from "./state.mjs";

export const PID_FILE_ENV = "CODEX_COMPANION_APP_SERVER_PID_FILE";
export const LOG_FILE_ENV = "CODEX_COMPANION_APP_SERVER_LOG_FILE";
// How long the shared broker (and its `codex app-server` with its MCP
// servers) stays up with nothing to do; 0 keeps it until SessionEnd.
export const BROKER_IDLE_ENV = "CODEX_COMPANION_BROKER_IDLE_MS";
export const DEFAULT_BROKER_IDLE_MS = 5 * 60 * 1000;
const BROKER_STATE_FILE = "broker.json";

/**
 * Idle timeout of the shared broker in milliseconds: CODEX_COMPANION_BROKER_IDLE_MS
 * when it is a non-negative integer (0 = never exit on idle), else 5 minutes.
 *
 * @returns {{ idleMs: number, source: "default" | "env", invalid?: string }}
 */
export function resolveBrokerIdleMs(env = process.env) {
  const raw = env?.[BROKER_IDLE_ENV];
  if (raw === undefined || String(raw).trim() === "") {
    return { idleMs: DEFAULT_BROKER_IDLE_MS, source: "default" };
  }
  const value = String(raw).trim();
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    return { idleMs: DEFAULT_BROKER_IDLE_MS, source: "default", invalid: value };
  }
  return { idleMs: Number(value), source: "env" };
}

export function createBrokerSessionDir(prefix = "cxc-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

export async function waitForBrokerEndpoint(endpoint, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise((resolve) => {
      const socket = connectToEndpoint(endpoint);
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export async function sendBrokerShutdown(endpoint) {
  await new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method: "broker/shutdown", params: {} })}\n`);
    });
    socket.on("data", () => {
      socket.end();
      resolve();
    });
    socket.on("error", resolve);
    socket.on("close", resolve);
  });
}

const BROKER_LAUNCHER_PATH = fileURLToPath(new URL("../broker-launcher.mjs", import.meta.url));
const BROKER_LAUNCH_TIMEOUT_MS = 15000;

/**
 * How the broker is started. "launcher" (Windows): through broker-launcher.mjs,
 * which starts the broker and exits, so the broker's ParentProcessId names a
 * dead process and `taskkill /PID <client> /T` (cancel of the task worker that
 * happened to start it) cannot reach the shared broker. "direct" (POSIX): a
 * detached child; it gets its own session and process group, and signals to
 * the client's group (cancel kills `-pid`) do not reach it.
 */
export function resolveBrokerLaunchMode(platform = process.platform) {
  return platform === "win32" ? "launcher" : "direct";
}

function spawnBrokerDirect({ args, cwd, logFile, env }) {
  const logFd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true
  });
  child.unref();
  fs.closeSync(logFd);
  return { pid: child.pid ?? null, mode: "direct" };
}

function parseLauncherPid(stdout) {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    try {
      const pid = JSON.parse(line)?.pid;
      if (Number.isInteger(pid)) {
        return pid;
      }
    } catch {
      // Not the launcher's JSON line.
    }
  }
  return null;
}

function spawnBrokerThroughLauncher({ args, cwd, logFile, env, launcherPath }) {
  return new Promise((resolve, reject) => {
    const launcher = spawn(process.execPath, [launcherPath, logFile, ...args], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let exitInfo = null;
    let graceTimer = null;
    launcher.stdout.setEncoding("utf8");
    launcher.stderr.setEncoding("utf8");
    launcher.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    launcher.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    function settle(error, value) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      // The broker may hold an inherited copy of the launcher's pipes
      // (Windows handle inheritance): stop reading, or they would keep this
      // client's event loop alive for as long as the broker runs.
      launcher.stdout.destroy();
      launcher.stderr.destroy();
      launcher.unref();
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    }

    function finish() {
      const { code, signal } = exitInfo;
      if (code === 0) {
        // `pid` is null only when the launcher's line has not arrived; the
        // broker writes its own pid file, which the caller reads instead.
        settle(null, { pid: parseLauncherPid(stdout), mode: "launcher" });
        return;
      }
      const detail = stderr.trim() || stdout.trim() || (signal ? `signal ${signal}` : `exit ${code}`);
      settle(new Error(`Could not start the shared Codex broker: ${detail}`));
    }

    const timer = setTimeout(() => {
      try {
        launcher.kill();
      } catch {
        // Already gone.
      }
      settle(new Error(`The broker launcher did not finish within ${BROKER_LAUNCH_TIMEOUT_MS} ms.`));
    }, BROKER_LAUNCH_TIMEOUT_MS);
    launcher.on("error", (error) => settle(error));
    // "exit" comes as soon as the launcher is gone; "close" also waits for
    // its pipes, which never close while the broker holds a copy of them.
    // Take whatever output arrived within a short grace period.
    launcher.on("exit", (code, signal) => {
      exitInfo = { code, signal };
      if (parseLauncherPid(stdout) !== null) {
        finish();
        return;
      }
      graceTimer = setTimeout(finish, 500);
    });
    launcher.on("close", () => {
      if (exitInfo) {
        finish();
      }
    });
  });
}

function readBrokerPidFile(pidFile) {
  try {
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Start the shared broker outside the calling client's process tree.
 * Resolves to `{ pid, mode }`, where `pid` is the broker's own pid (the one
 * recorded in broker.json), never the launcher's; null only when the
 * launcher's report did not arrive, and then the broker's pid file has it.
 */
export async function spawnBrokerProcess({
  scriptPath,
  cwd,
  endpoint,
  pidFile,
  logFile,
  env = process.env,
  mode = resolveBrokerLaunchMode(),
  launcherPath = BROKER_LAUNCHER_PATH
}) {
  const args = [scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile, "--log-file", logFile];
  if (mode === "launcher") {
    return spawnBrokerThroughLauncher({ args, cwd, logFile, env, launcherPath });
  }
  return spawnBrokerDirect({ args, cwd, logFile, env });
}

function resolveBrokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}

export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

export function saveBrokerSession(cwd, session) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(resolveBrokerStateFile(cwd), `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

export function clearBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
}

/**
 * A client found the broker at `endpoint` gone (it crashed, or exited after
 * its idle timeout): if broker.json still describes it, remove its leftover
 * files (pid file, log, Unix socket, session dir) and the record. No process
 * is killed: the broker is not answering on its endpoint any more.
 */
export function forgetDeadBrokerSession(cwd, endpoint) {
  const session = loadBrokerSession(cwd);
  if (!session || session.endpoint !== endpoint) {
    return false;
  }
  try {
    teardownBrokerSession({
      endpoint: session.endpoint ?? null,
      pidFile: session.pidFile ?? null,
      logFile: session.logFile ?? null,
      sessionDir: session.sessionDir ?? null,
      pid: null
    });
  } catch {
    // Leftover files are harmless; the record below is what matters.
  }
  return clearBrokerSessionIfOwned(cwd, endpoint);
}

/**
 * Remove broker.json only while it still describes the broker at `endpoint`
 * (a newer broker may have replaced it). Returns true when it was removed.
 */
export function clearBrokerSessionIfOwned(cwd, endpoint) {
  const session = loadBrokerSession(cwd);
  if (!session || session.endpoint !== endpoint) {
    return false;
  }
  try {
    clearBrokerSession(cwd);
    return true;
  } catch {
    return false;
  }
}

async function isBrokerEndpointReady(endpoint) {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForBrokerEndpoint(endpoint, 150);
  } catch {
    return false;
  }
}

export async function ensureBrokerSession(cwd, options = {}) {
  const existing = loadBrokerSession(cwd);
  if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
    return existing;
  }

  if (existing) {
    teardownBrokerSession({
      endpoint: existing.endpoint ?? null,
      pidFile: existing.pidFile ?? null,
      logFile: existing.logFile ?? null,
      sessionDir: existing.sessionDir ?? null,
      pid: existing.pid ?? null,
      killProcess: options.killProcess ?? null
    });
    clearBrokerSession(cwd);
  }

  // Checks that must pass before a new broker is started; may throw.
  options.beforeSpawn?.();

  const sessionDir = createBrokerSessionDir();
  const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
  const endpoint = endpointFactory(sessionDir, options.platform);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const scriptPath =
    options.scriptPath ??
    fileURLToPath(new URL("../app-server-broker.mjs", import.meta.url));

  let broker;
  try {
    broker = await spawnBrokerProcess({
      scriptPath,
      cwd,
      endpoint,
      pidFile,
      logFile,
      env: options.env ?? process.env,
      ...(options.brokerLaunchMode ? { mode: options.brokerLaunchMode } : {})
    });
  } catch {
    teardownBrokerSession({ endpoint, pidFile, logFile, sessionDir, pid: null });
    return null;
  }

  const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2000);
  if (!ready) {
    teardownBrokerSession({
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: broker.pid ?? null,
      killProcess: options.killProcess ?? null
    });
    return null;
  }

  const session = {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    // The broker writes its pid file before it listens on its endpoint.
    pid: broker.pid ?? readBrokerPidFile(pidFile)
  };
  saveBrokerSession(cwd, session);
  return session;
}

export function teardownBrokerSession({ endpoint = null, pidFile, logFile, sessionDir = null, pid = null, killProcess = null }) {
  if (Number.isFinite(pid) && killProcess) {
    try {
      killProcess(pid);
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  if (pidFile && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }

  if (logFile && fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown.
    }
  }

  const resolvedSessionDir = sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
}
