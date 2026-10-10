import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

const startedRepos = [];
after(() => {
  for (const { repo, env } of startedRepos) {
    run("node", [SESSION_HOOK, "SessionEnd"], {
      cwd: repo,
      env,
      input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo })
    });
  }
});

function setupRepo(behavior, extraEnv = {}) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, behavior);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  // A private plugin data dir per test keeps the per-user config isolated.
  const env = { ...buildEnv(binDir), CLAUDE_PLUGIN_DATA: makeTempDir(), ...extraEnv };
  startedRepos.push({ repo, env });
  return { repo, binDir, env, statePath: path.join(binDir, "fake-codex-state.json") };
}

function readFakeState(statePath) {
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

// --- app-server: replies after the server died ---------------------------------

test("a request declined after codex app-server exits is not written to the dead stdin", () => {
  const { repo, env } = setupRepo("approval-then-exit");
  const result = run("node", [path.join(ROOT, "tests", "fixtures", "server-request-after-exit.mjs"), repo, makeTempDir()], {
    cwd: repo,
    env
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /EPIPE|ERR_STREAM_DESTROYED|write after end/);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { sentAfterExit: 0, decisions: ["closed"] });
});

// --- watch ---------------------------------------------------------------------

function watch(repo, env, jobId, extra = []) {
  return run("node", [SCRIPT, "watch", jobId, "--json", "--poll-interval-ms", "100", ...extra], { cwd: repo, env });
}

function parseEvent(result) {
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1, "watch prints exactly one line");
  return JSON.parse(lines[0]);
}

test("watch reports a waiting approval, then the finished job after approve", () => {
  const { repo, env, statePath } = setupRepo("approval-command");
  const launched = run("node", [SCRIPT, "task", "--background", "--write", "--json", "install a dependency"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);

  const approval = parseEvent(watch(repo, env, jobId, ["--timeout-ms", "20000"]));
  assert.equal(approval.event, "approval");
  assert.equal(approval.jobId, jobId);
  assert.equal(approval.pending.length, 1);
  assert.equal(approval.pending[0].command, "npm install left-pad");

  const text = run("node", [SCRIPT, "watch", jobId, "--timeout-ms", "20000"], { cwd: repo, env });
  assert.match(text.stdout, new RegExp(`Codex job ${jobId} is waiting for approval:\\n- ${approval.pending[0].approvalId}: Run npm install left-pad`));
  assert.match(text.stdout, new RegExp(`/codex:approve ${jobId}`));

  const approved = run("node", [SCRIPT, "approve", jobId, approval.pending[0].approvalId, "--decision", "accept"], { cwd: repo, env });
  assert.equal(approved.status, 0, approved.stderr);

  const done = parseEvent(watch(repo, env, jobId, ["--timeout-ms", "20000"]));
  assert.deepEqual(done, { event: "done", jobId, status: "completed" });
  assert.deepEqual(readFakeState(statePath).approvalResponses[0].result, { decision: "accept" });

  const result = run("node", [SCRIPT, "result", jobId], { cwd: repo, env });
  assert.match(result.stdout, /Approval requests:\n- accepted: Run npm install left-pad .+ \(by the user\)/);
});

test("watch times out while the job keeps running and fails for an unknown job", () => {
  const { repo, env } = setupRepo("interruptible-slow-task");
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "a slow task"], { cwd: repo, env });
  const { jobId } = JSON.parse(launched.stdout);

  const started = Date.now();
  assert.deepEqual(parseEvent(watch(repo, env, jobId, ["--timeout-ms", "600"])), { event: "timeout", jobId });
  assert.ok(Date.now() - started < 10000);
  const text = run("node", [SCRIPT, "watch", jobId, "--timeout-ms", "300"], { cwd: repo, env });
  assert.match(text.stdout, new RegExp(`Codex job ${jobId} is still running; run watch again`));

  const missing = watch(repo, env, "task-does-not-exist", ["--timeout-ms", "300"]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /No Codex job "task-does-not-exist"/);
  assert.equal(missing.stdout, "");

  const usage = run("node", [SCRIPT, "watch"], { cwd: repo, env });
  assert.notEqual(usage.status, 0);
  assert.match(usage.stderr, /Usage: watch <job-id>/);
});

// --- default approval mode -------------------------------------------------------

test("setup --default-approvals sets a per-user default that --approvals overrides", () => {
  const { repo, env, statePath } = setupRepo();

  const set = run("node", [SCRIPT, "setup", "--default-approvals", "auto-review", "--json"], { cwd: repo, env });
  assert.equal(set.status, 0, set.stderr);
  const report = JSON.parse(set.stdout);
  const configFile = path.join(env.CLAUDE_PLUGIN_DATA, "config.json");
  assert.deepEqual(report.defaultApprovals, { mode: "auto-review", source: "plugin-default", file: configFile });
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, "utf8")), { defaultApprovals: "auto-review" });
  assert.match(run("node", [SCRIPT, "setup"], { cwd: repo, env }).stdout, /- default approvals: auto-review \(plugin default from .+config\.json\)/);

  // Another repository picks up the same default: it is per user, not per repo.
  const other = setupRepo();
  const otherEnv = { ...other.env, CLAUDE_PLUGIN_DATA: env.CLAUDE_PLUGIN_DATA };
  assert.equal(run("node", [SCRIPT, "task", "look around"], { cwd: other.repo, env: otherEnv }).status, 0);
  assert.equal(readFakeState(other.statePath).lastThreadStart.approvalsReviewer, "auto_review");

  assert.equal(run("node", [SCRIPT, "task", "--write", "fix the bug"], { cwd: repo, env }).status, 0);
  let state = readFakeState(statePath);
  assert.equal(state.lastThreadStart.approvalsReviewer, "auto_review");
  assert.equal(state.lastTurnStart.approvalsReviewer, "auto_review");
  assert.equal("approvalPolicy" in state.lastThreadStart, false);
  assert.equal(state.lastThreadStart.sandbox, "workspace-write");

  assert.equal(run("node", [SCRIPT, "task", "--resume", "keep going"], { cwd: repo, env }).status, 0);
  state = readFakeState(statePath);
  assert.equal(state.lastThreadResume.approvalsReviewer, "auto_review");
  assert.equal(state.lastTurnStart.approvalsReviewer, "auto_review");

  assert.equal(run("node", [SCRIPT, "task", "--approvals", "ask", "fix the bug"], { cwd: repo, env }).status, 0);
  state = readFakeState(statePath);
  assert.equal(state.lastThreadStart.approvalsReviewer, "user");
  assert.equal(state.lastTurnStart.approvalsReviewer, "user");

  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  assert.equal(run("node", [SCRIPT, "adversarial-review"], { cwd: repo, env }).status, 0);
  assert.equal(readFakeState(statePath).lastThreadStart.approvalsReviewer, "auto_review");
  assert.equal(run("node", [SCRIPT, "review", "--approvals", "deny"], { cwd: repo, env }).status, 0);
  assert.equal(readFakeState(statePath).lastThreadStart.approvalsReviewer, "user");

  const unset = run("node", [SCRIPT, "setup", "--default-approvals", "unset", "--json"], { cwd: repo, env });
  assert.equal(JSON.parse(unset.stdout).defaultApprovals.mode, null);
  assert.equal(JSON.parse(unset.stdout).defaultApprovals.source, "codex-config");
  assert.equal(run("node", [SCRIPT, "task", "fix the bug"], { cwd: repo, env }).status, 0);
  state = readFakeState(statePath);
  assert.equal("approvalsReviewer" in state.lastThreadStart, false);
  assert.equal(state.lastTurnStart.approvalsReviewer, null);
  assert.match(run("node", [SCRIPT, "setup"], { cwd: repo, env }).stdout, /- default approvals: not set \(the approvals_reviewer from your Codex config applies\)/);

  const invalid = run("node", [SCRIPT, "setup", "--default-approvals", "always"], { cwd: repo, env });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Unsupported --default-approvals "always"/);
});

test("a background job keeps the default it was started with", () => {
  const { repo, env, statePath } = setupRepo("approval-command");
  run("node", [SCRIPT, "setup", "--default-approvals", "deny"], { cwd: repo, env });
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "install a dependency"], { cwd: repo, env });
  const { jobId } = JSON.parse(launched.stdout);
  run("node", [SCRIPT, "setup", "--default-approvals", "unset"], { cwd: repo, env });

  assert.deepEqual(parseEvent(watch(repo, env, jobId, ["--timeout-ms", "20000"])), { event: "done", jobId, status: "completed" });
  assert.deepEqual(readFakeState(statePath).approvalResponses[0].result, { decision: "decline" });
  assert.match(run("node", [SCRIPT, "result", jobId], { cwd: repo, env }).stdout, /declined: .+ \(approval mode is deny\)/);
});

test("a reviewer from the default is verified like an explicit one", () => {
  const { repo, env } = setupRepo("reviewer-ignored");
  run("node", [SCRIPT, "setup", "--default-approvals", "auto-review"], { cwd: repo, env });
  const result = run("node", [SCRIPT, "task", "fix the bug"], { cwd: repo, env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /routed approvals to "user" instead of "auto_review"\. Refusing to run/);
});

// --- DEP0190 --------------------------------------------------------------------

test("entry points filter DEP0190 and keep other warnings", () => {
  const preload = pathToFileURL(path.join(ROOT, "tests", "fixtures", "emit-warnings-preload.mjs")).href;
  const result = run("node", ["--import", preload, SCRIPT, "help"], { cwd: ROOT, env: process.env });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /DEP0190/);
  assert.match(result.stderr, /\[DEP0999\] DeprecationWarning: An unrelated deprecation\./);

  for (const entry of ["codex-companion.mjs", "app-server-broker.mjs", "session-lifecycle-hook.mjs", "stop-review-gate-hook.mjs"]) {
    const source = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", entry), "utf8");
    const firstImport = source.split("\n").find((line) => line.startsWith("import "));
    assert.equal(firstImport, 'import "./lib/quiet-deprecations.mjs";', `${entry} must load the filter first`);
  }
});

test("a real DEP0190 from spawn with shell: true is filtered (Node 24+)", { skip: Number(process.versions.node.split(".")[0]) < 24 && "DEP0190 exists from Node 24" }, () => {
  const script = [
    `await import(${JSON.stringify(pathToFileURL(path.join(PLUGIN_ROOT, "scripts", "lib", "quiet-deprecations.mjs")).href)});`,
    'const { spawnSync } = await import("node:child_process");',
    'spawnSync(process.execPath, ["--version"], { shell: true });',
    'process.emitWarning("An unrelated deprecation.", "DeprecationWarning", "DEP0999");'
  ].join("\n");
  const result = run(process.execPath, ["--input-type=module", "-e", script], { cwd: ROOT, env: process.env });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /DEP0190/);
  assert.match(result.stderr, /DEP0999/);
});
