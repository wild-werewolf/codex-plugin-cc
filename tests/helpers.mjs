import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

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
// CODEX_COMPANION_WINDOWS_SANDBOX: tests expect the plugin default.
for (const name of [
  "CODEX_COMPANION_SESSION_ID",
  "CODEX_COMPANION_TRANSCRIPT_PATH",
  "CODEX_COMPANION_APP_SERVER_ENDPOINT",
  "CODEX_COMPANION_WINDOWS_SANDBOX"
]) {
  delete process.env[name];
}

export function makeTempDir(prefix = "codex-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
