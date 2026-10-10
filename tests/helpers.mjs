import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after } from "node:test";
import { spawnSync } from "node:child_process";

import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

// Isolate every test process from the developer's Claude Code session. Its
// SessionStart hook exports CLAUDE_PLUGIN_DATA (and the session id and
// transcript path) to every Bash command, so tests run from a session would
// otherwise write job state into the real plugin data directory and read the
// real per-user settings. The test process and all children it spawns
// (directly or through buildEnv) share this temporary root, so state that a
// test reads with resolveStateDir() is the state its commands wrote.
export const TEST_ENV_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-test-env-"));
export const TEST_PLUGIN_DATA = path.join(TEST_ENV_ROOT, "plugin-data");
export const TEST_USER_CONFIG_FILE = path.join(TEST_ENV_ROOT, "codex-companion-config.json");
process.env.CLAUDE_PLUGIN_DATA = TEST_PLUGIN_DATA;
process.env.CODEX_COMPANION_CONFIG_FILE = TEST_USER_CONFIG_FILE;
// CODEX_COMPANION_WINDOWS_SANDBOX, CODEX_COMPANION_PWSH: tests expect the
// plugin defaults.
for (const name of [
  "CODEX_COMPANION_SESSION_ID",
  "CODEX_COMPANION_TRANSCRIPT_PATH",
  "CODEX_COMPANION_APP_SERVER_ENDPOINT",
  "CODEX_COMPANION_WINDOWS_SANDBOX",
  "CODEX_COMPANION_PWSH"
]) {
  delete process.env[name];
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// Every temp dir made by makeTempDir in this process: tests that use their
// own CLAUDE_PLUGIN_DATA keep it inside one of them.
const createdTempDirs = new Set();

function findBrokerFiles(root, depth, found) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === "broker.json") {
      found.push(path.join(root, entry.name));
    } else if (entry.isDirectory() && depth > 0 && entry.name !== ".git" && entry.name !== "node_modules") {
      findBrokerFiles(path.join(root, entry.name), depth - 1, found);
    }
  }
  return found;
}

/**
 * Stop every shared broker a test of this process started. Brokers record
 * themselves in `<plugin data>/state/<workspace>/broker.json`; the plugin
 * data dirs of this process are TEST_PLUGIN_DATA and dirs inside its temp
 * dirs. SIGTERM lets a broker close its `codex app-server` and remove its
 * files; a broker still alive after that is killed with its process tree.
 */
export async function stopTestBrokers() {
  const brokerFiles = [TEST_PLUGIN_DATA, ...createdTempDirs].flatMap((root) => findBrokerFiles(root, 6, []));
  const pids = [];
  for (const brokerFile of new Set(brokerFiles)) {
    let session = null;
    try {
      session = JSON.parse(fs.readFileSync(brokerFile, "utf8"));
    } catch {
      continue;
    }
    const pid = Number(session?.pid);
    if (Number.isFinite(pid) && pid > 0 && processAlive(pid)) {
      pids.push(pid);
      try {
        if (process.platform === "win32") {
          terminateProcessTree(pid);
        } else {
          process.kill(pid, "SIGTERM");
        }
      } catch {
        // Already gone.
      }
    }
    fs.rmSync(brokerFile, { force: true });
  }
  const deadline = Date.now() + 5000;
  while (pids.some(processAlive) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (const pid of pids.filter(processAlive)) {
    try {
      terminateProcessTree(pid);
    } catch {
      // Already gone.
    }
  }
  return pids;
}

// After all tests of a test file. Only in test files: helpers are also
// imported by fixture scripts, where a test hook would print TAP output.
if (/\.test\.mjs$/.test(process.argv[1] ?? "")) {
  after(stopTestBrokers);
}

export function makeTempDir(prefix = "codex-plugin-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTempDirs.add(dir);
  return dir;
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: options.shell ?? (process.platform === "win32" && !path.isAbsolute(command)),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
