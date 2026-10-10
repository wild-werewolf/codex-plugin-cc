#!/usr/bin/env node

// First import: filters only DEP0190 before any child process is spawned.
import "./lib/quiet-deprecations.mjs";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./lib/app-server.mjs";
import { failClosedServerRequestResult } from "./lib/approvals.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";
import { BROKER_IDLE_ENV, clearBrokerSessionIfOwned, resolveBrokerIdleMs } from "./lib/broker-lifecycle.mjs";

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);

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

function isResponseMessage(message) {
  return message?.id !== undefined && message?.method === undefined && ("result" in message || "error" in message);
}

function serverRequestKey(id) {
  return JSON.stringify(id);
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

function removeQuietly(remove) {
  try {
    remove();
  } catch {
    // Already removed, still open elsewhere (Windows) or not empty.
  }
}

function log(message) {
  process.stderr.write(`[${new Date().toISOString()}] ${message}\n`);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error(
      "Usage: node scripts/app-server-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>] [--log-file <path>]"
    );
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "log-file", "endpoint"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  const logFile = options["log-file"] ? path.resolve(options["log-file"]) : null;
  const idle = resolveBrokerIdleMs(process.env);
  if (idle.invalid !== undefined) {
    log(`Ignoring ${BROKER_IDLE_ENV}=${JSON.stringify(idle.invalid)} (not a non-negative integer); using ${idle.idleMs} ms.`);
  }
  writePidFile(pidFile);

  const appClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  const sockets = new Set();
  // Server requests (approvals) forwarded to a client socket, keyed by the
  // app-server request id. Ids are kept as-is: clients tell them apart from
  // their own responses because server requests carry a `method`.
  const forwardedServerRequests = new Map();
  // Idle tracking: the broker exits after `idle.idleMs` without a connected
  // client, an active request, an active turn stream or a forwarded server
  // request (an approval the user has not answered yet counts as work). A
  // connected client counts even while it sends nothing: a task sits between
  // `initialize` and `thread/start` for as long as its process takes, and
  // must not lose the broker midway (EPIPE, or a second broker for one task).
  // The readiness probe closes its socket at once, so it does not keep the
  // broker up. Connections, messages and disconnects restart the clock.
  let lastActivityAt = Date.now();
  let shuttingDown = false;
  function touch() {
    lastActivityAt = Date.now();
  }
  function isBusy() {
    return Boolean(sockets.size > 0 || activeRequestSocket || activeStreamSocket || forwardedServerRequests.size > 0);
  }

  function settleForwardedRequests(socket) {
    for (const [key, entry] of forwardedServerRequests) {
      if (entry.socket === socket) {
        forwardedServerRequests.delete(key);
        entry.resolve(entry.failClosed());
      }
    }
  }

  function clearSocketOwnership(socket) {
    settleForwardedRequests(socket);
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      activeStreamSocket = null;
      activeStreamThreadIds = null;
    }
  }

  function routeNotification(message) {
    touch();
    const target = activeRequestSocket ?? activeStreamSocket;
    if (!target) {
      return;
    }
    send(target, message);
    if (message.method === "turn/completed" && activeStreamSocket === target) {
      const threadId = message.params?.threadId ?? null;
      if (!threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId)) {
        activeStreamSocket = null;
        activeStreamThreadIds = null;
        if (activeRequestSocket === target) {
          activeRequestSocket = null;
        }
      }
    }
  }

  async function shutdown(server) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    // Stop accepting clients first, then make broker.json stop pointing here
    // (only if it still does): the next client starts a new broker instead
    // of connecting to one that is going away.
    const closed = new Promise((resolve) => server.close(resolve));
    removeQuietly(() => clearBrokerSessionIfOwned(cwd, endpoint));
    for (const socket of sockets) {
      socket.end();
    }
    await appClient.close().catch(() => {});
    await closed;
    if (listenTarget.kind === "unix") {
      removeQuietly(() => fs.existsSync(listenTarget.path) && fs.unlinkSync(listenTarget.path));
    }
    if (pidFile) {
      removeQuietly(() => fs.existsSync(pidFile) && fs.unlinkSync(pidFile));
    }
    if (logFile) {
      removeQuietly(() => fs.existsSync(logFile) && fs.unlinkSync(logFile));
    }
    if (pidFile) {
      // The per-broker session directory; removed only once it is empty.
      removeQuietly(() => fs.rmdirSync(path.dirname(pidFile)));
    }
  }

  async function shutdownAndExit(server, reason) {
    if (shuttingDown) {
      return;
    }
    log(`Shutting down: ${reason}.`);
    await shutdown(server);
    process.exit(0);
  }

  appClient.setNotificationHandler(routeNotification);
  appClient.setServerRequestHandler((message) => {
    const target = activeRequestSocket ?? activeStreamSocket;
    if (!target || target.destroyed) {
      return failClosedServerRequestResult(message, "No Codex companion client is attached to the shared runtime.");
    }
    return new Promise((resolve, reject) => {
      forwardedServerRequests.set(serverRequestKey(message.id), {
        socket: target,
        resolve,
        reject,
        failClosed: () => {
          try {
            return failClosedServerRequestResult(message, "The Codex companion client disconnected.");
          } catch (error) {
            reject(error);
            return undefined;
          }
        }
      });
      send(target, message);
    });
  });

  const server = net.createServer((socket) => {
    touch();
    if (shuttingDown) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      touch();
      buffer += chunk;
      // Re-read the buffer on every pass: while this handler awaits a request,
      // another data event (e.g. the answer to a forwarded approval request)
      // may already have consumed lines from it.
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }

        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: {
              userAgent: "codex-companion-broker"
            }
          });
          continue;
        }

        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          send(socket, { id: message.id, result: {} });
          await shutdownAndExit(server, "broker/shutdown requested");
          return;
        }

        if (shuttingDown) {
          if (message.id !== undefined && !isResponseMessage(message)) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(-32000, "Shared Codex broker is shutting down.")
            });
          }
          continue;
        }

        if (isResponseMessage(message)) {
          const key = serverRequestKey(message.id);
          const forwarded = forwardedServerRequests.get(key);
          if (forwarded && forwarded.socket === socket) {
            forwardedServerRequests.delete(key);
            if (message.error) {
              const error = new Error(message.error.message ?? "Server request failed in the client.");
              error.rpcCode = message.error.code;
              forwarded.reject(error);
            } else {
              forwarded.resolve(message.result ?? {});
            }
          }
          continue;
        }

        if (message.id === undefined) {
          continue;
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
          continue;
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
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        activeRequestSocket = socket;

        try {
          const result = await appClient.request(message.method, message.params ?? {});
          touch();
          send(socket, { id: message.id, result });
          if (isStreaming) {
            activeStreamSocket = socket;
            activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
          }
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
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
          }
        }
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
      touch();
    });

    socket.on("error", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
      touch();
    });
  });

  process.on("SIGTERM", () => {
    void shutdownAndExit(server, "SIGTERM");
  });

  process.on("SIGINT", () => {
    void shutdownAndExit(server, "SIGINT");
  });

  // Without its app-server the broker cannot serve anyone: exit, so the next
  // client starts a new broker instead of reusing this one.
  void appClient.exitPromise.then(() => {
    if (!shuttingDown) {
      void shutdownAndExit(server, `codex app-server exited${appClient.exitError ? ` (${appClient.exitError.message})` : ""}`);
    }
  });

  if (idle.idleMs > 0) {
    const checkEveryMs = Math.max(20, Math.min(1000, Math.floor(idle.idleMs / 4)));
    const idleTimer = setInterval(() => {
      if (shuttingDown) {
        return;
      }
      if (isBusy()) {
        touch();
        return;
      }
      if (Date.now() - lastActivityAt >= idle.idleMs) {
        clearInterval(idleTimer);
        void shutdownAndExit(server, `idle for ${idle.idleMs} ms`);
      }
    }, checkEveryMs);
    // The listening server keeps the process alive; the timer must not.
    idleTimer.unref();
  }

  server.listen(listenTarget.path);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
