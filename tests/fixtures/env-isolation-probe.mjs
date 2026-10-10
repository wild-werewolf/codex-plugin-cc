// Child process for the isolation test: started with a CLAUDE_PLUGIN_DATA as
// a Claude Code session would export it, then uses the normal test helpers.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "../fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "../helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

const binDir = makeTempDir();
installFakeCodex(binDir);
const repo = makeTempDir();
initGitRepo(repo);
fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
run("git", ["add", "README.md"], { cwd: repo });
run("git", ["commit", "-m", "init"], { cwd: repo });

const env = buildEnv(binDir);
const setup = JSON.parse(run("node", [SCRIPT, "setup", "--json"], { cwd: repo, env }).stdout);
const task = run("node", [SCRIPT, "task", "look around"], { cwd: repo, env });
const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
run("node", [path.join(ROOT, "plugins", "codex", "scripts", "session-lifecycle-hook.mjs"), "SessionEnd"], {
  cwd: repo,
  env,
  input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo })
});

process.stdout.write(
  `${JSON.stringify({
    processPluginData: process.env.CLAUDE_PLUGIN_DATA,
    buildEnvPluginData: env.CLAUDE_PLUGIN_DATA,
    sessionId: process.env.CODEX_COMPANION_SESSION_ID ?? null,
    defaultApprovals: setup.defaultApprovals,
    taskStatus: task.status,
    reviewerSent: "approvalsReviewer" in fakeState.lastThreadStart
  })}\n`
);
