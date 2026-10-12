#!/usr/bin/env node

// Starts the shared app-server broker on behalf of a client and exits at once.
//
// Usage: node broker-launcher.mjs <log-file> <broker-script> [broker args...]
//
// On Windows a process tree is the chain of ParentProcessId links, and
// `taskkill /PID <client> /T` walks it: a broker started directly by a task
// worker would die with that worker on `/codex:cancel`, together with its
// `codex app-server` and the tasks of every other session using it. Started
// from here, the broker's parent is this process, which is gone before the
// client returns, so no client's tree reaches the broker.
//
// Prints {"pid": <broker pid>} on stdout; exits non-zero when the broker
// could not be started.
import fs from "node:fs";
import process from "node:process";
import { spawn } from "node:child_process";

const [logFile, scriptPath, ...brokerArgs] = process.argv.slice(2);
if (!logFile || !scriptPath) {
  process.stderr.write("Usage: node broker-launcher.mjs <log-file> <broker-script> [broker args...]\n");
  process.exit(2);
}

const logFd = fs.openSync(logFile, "a");
const child = spawn(process.execPath, [scriptPath, ...brokerArgs], {
  cwd: process.cwd(),
  env: process.env,
  detached: true,
  stdio: ["ignore", logFd, logFd],
  windowsHide: true
});
fs.closeSync(logFd);

child.on("error", (error) => {
  process.stderr.write(`Could not start the broker: ${error.message}\n`);
  process.exitCode = 1;
});

if (child.pid !== undefined) {
  child.unref();
  process.stdout.write(`${JSON.stringify({ pid: child.pid })}\n`);
}
