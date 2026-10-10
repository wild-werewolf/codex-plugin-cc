import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { resolveLegacyUserConfigFiles, resolveUserConfigFile } from "../plugins/codex/scripts/lib/state.mjs";

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
  const lines = result.stdout.trim().split(/\r?\n/);
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
  const configFile = env.CODEX_COMPANION_CONFIG_FILE;
  assert.deepEqual(report.defaultApprovals, { mode: "auto-review", source: "plugin-default", file: configFile, configFile });
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, "utf8")), { defaultApprovals: "auto-review" });
  assert.match(run("node", [SCRIPT, "setup"], { cwd: repo, env }).stdout, /- default approvals: auto-review \(plugin default from .+config\.json\)/);

  // Another repository picks up the same default: it is per user, not per repo.
  const other = setupRepo();
  const otherEnv = { ...other.env, CODEX_COMPANION_CONFIG_FILE: env.CODEX_COMPANION_CONFIG_FILE };
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
  assert.match(run("node", [SCRIPT, "setup"], { cwd: repo, env }).stdout, /- default approvals: not set \(the approvals_reviewer from your Codex config applies; setting file: .+codex-companion-config\.json\)/);

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
    // Windows checkouts with core.autocrlf=true have CRLF line endings.
    const firstImport = source.split(/\r?\n/).find((line) => line.startsWith("import "));
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

// --- where the per-user setting lives ------------------------------------------

test("the per-user setting has a fixed default path on Windows and elsewhere", () => {
  assert.equal(
    resolveUserConfigFile({ env: { APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, platform: "win32", homedir: "C:\\Users\\me" }),
    "C:\\Users\\me\\AppData\\Roaming\\codex-companion\\config.json"
  );
  assert.equal(
    resolveUserConfigFile({ env: {}, platform: "win32", homedir: "C:\\Users\\me" }),
    "C:\\Users\\me\\AppData\\Roaming\\codex-companion\\config.json"
  );
  assert.equal(resolveUserConfigFile({ env: {}, platform: "linux", homedir: "/home/me" }), "/home/me/.config/codex-companion/config.json");
  assert.equal(
    resolveUserConfigFile({ env: { XDG_CONFIG_HOME: "/xdg" }, platform: "darwin", homedir: "/Users/me" }),
    "/xdg/codex-companion/config.json"
  );
  assert.equal(
    resolveUserConfigFile({ env: { XDG_CONFIG_HOME: "relative/dir" }, platform: "linux", homedir: "/home/me" }),
    "/home/me/.config/codex-companion/config.json",
    "a relative XDG_CONFIG_HOME is ignored"
  );
  // CLAUDE_PLUGIN_DATA no longer decides where the setting lives.
  assert.equal(
    resolveUserConfigFile({ env: { CLAUDE_PLUGIN_DATA: "/data/codex-wild-codex" }, platform: "linux", homedir: "/home/me" }),
    "/home/me/.config/codex-companion/config.json"
  );
  assert.equal(
    resolveUserConfigFile({ env: { CODEX_COMPANION_CONFIG_FILE: "/custom/settings.json", XDG_CONFIG_HOME: "/xdg" }, platform: "linux" }),
    "/custom/settings.json"
  );
  assert.equal(
    resolveUserConfigFile({ env: { CODEX_COMPANION_CONFIG_FILE: "D:\\cfg\\codex.json", APPDATA: "C:\\x" }, platform: "win32" }),
    "D:\\cfg\\codex.json"
  );
});

function setupWithoutOverride() {
  const fixture = setupRepo();
  const env = { ...fixture.env, XDG_CONFIG_HOME: makeTempDir(), APPDATA: makeTempDir() };
  delete env.CODEX_COMPANION_CONFIG_FILE;
  const configFile =
    process.platform === "win32"
      ? path.join(env.APPDATA, "codex-companion", "config.json")
      : path.join(env.XDG_CONFIG_HOME, "codex-companion", "config.json");
  return { ...fixture, env, configFile };
}

test("the default survives a change of CLAUDE_PLUGIN_DATA (another marketplace)", () => {
  const { repo, env, configFile, statePath } = setupWithoutOverride();
  const openaiEnv = { ...env, CLAUDE_PLUGIN_DATA: path.join(makeTempDir(), "codex-openai-codex") };
  const set = run("node", [SCRIPT, "setup", "--default-approvals", "auto-review", "--json"], { cwd: repo, env: openaiEnv });
  assert.equal(set.status, 0, set.stderr);
  assert.equal(JSON.parse(set.stdout).defaultApprovals.file, configFile);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, "utf8")), { defaultApprovals: "auto-review" });
  assert.equal(fs.existsSync(path.join(openaiEnv.CLAUDE_PLUGIN_DATA, "config.json")), false);

  const wildEnv = { ...env, CLAUDE_PLUGIN_DATA: path.join(makeTempDir(), "codex-wild-codex") };
  const report = JSON.parse(run("node", [SCRIPT, "setup", "--json"], { cwd: repo, env: wildEnv }).stdout);
  assert.deepEqual(report.defaultApprovals, { mode: "auto-review", source: "plugin-default", file: configFile, configFile });
  assert.equal(run("node", [SCRIPT, "task", "look around"], { cwd: repo, env: wildEnv }).status, 0);
  assert.equal(readFakeState(statePath).lastThreadStart.approvalsReviewer, "auto_review");

  const unset = run("node", [SCRIPT, "setup", "--default-approvals", "unset", "--json"], { cwd: repo, env: wildEnv });
  assert.equal(JSON.parse(unset.stdout).defaultApprovals.mode, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, "utf8")), {});
});

test("a default from the old CLAUDE_PLUGIN_DATA config.json is read and moved on the next write", () => {
  const { repo, env, configFile, statePath } = setupWithoutOverride();
  const legacyEnv = { ...env, CLAUDE_PLUGIN_DATA: path.join(makeTempDir(), "codex-openai-codex") };
  const legacyFile = path.join(legacyEnv.CLAUDE_PLUGIN_DATA, "config.json");
  assert.equal(resolveLegacyUserConfigFiles(legacyEnv)[0], legacyFile);
  fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
  fs.writeFileSync(legacyFile, JSON.stringify({ defaultApprovals: "deny", somethingElse: 1 }));

  const report = JSON.parse(run("node", [SCRIPT, "setup", "--json"], { cwd: repo, env: legacyEnv }).stdout);
  assert.deepEqual(report.defaultApprovals, { mode: "deny", source: "plugin-default-legacy", file: legacyFile, configFile });
  assert.match(
    run("node", [SCRIPT, "setup"], { cwd: repo, env: legacyEnv }).stdout,
    /- default approvals: deny \(plugin default read from the old location .+config\.json; the next `--default-approvals` change saves it to .+codex-companion.config\.json\)/
  );
  assert.equal(run("node", [SCRIPT, "task", "look around"], { cwd: repo, env: legacyEnv }).status, 0);
  assert.equal(readFakeState(statePath).lastThreadStart.approvalsReviewer, "user", "deny routes to the user reviewer");
  assert.equal(fs.existsSync(configFile), false, "reading does not write");

  // First write migrates every legacy value into the new file and keeps the old file.
  run("node", [SCRIPT, "setup", "--default-approvals", "auto-review"], { cwd: repo, env: legacyEnv });
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, "utf8")), { defaultApprovals: "auto-review", somethingElse: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(legacyFile, "utf8")), { defaultApprovals: "deny", somethingElse: 1 });
  const after = JSON.parse(run("node", [SCRIPT, "setup", "--json"], { cwd: repo, env: legacyEnv }).stdout);
  assert.deepEqual(after.defaultApprovals, { mode: "auto-review", source: "plugin-default", file: configFile, configFile });

  // Once the new file exists it wins, even after unset.
  run("node", [SCRIPT, "setup", "--default-approvals", "unset"], { cwd: repo, env: legacyEnv });
  assert.equal(JSON.parse(run("node", [SCRIPT, "setup", "--json"], { cwd: repo, env: legacyEnv }).stdout).defaultApprovals.mode, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, "utf8")), { somethingElse: 1 });
});

test("a default left in another installation's data directory is found and moved on the next write", () => {
  const { repo, env, configFile, statePath } = setupWithoutOverride();
  const dataRoot = path.join(makeTempDir(), "plugins", "data");
  const wildData = path.join(dataRoot, "codex-wild-codex");
  fs.mkdirSync(wildData, { recursive: true });
  const openaiFile = path.join(dataRoot, "codex-openai-codex", "config.json");
  const olderFile = path.join(dataRoot, "codex-older-marketplace", "config.json");
  const unrelatedFile = path.join(dataRoot, "other-plugin-x", "config.json");
  for (const [file, value] of [[olderFile, "deny"], [openaiFile, "auto-review"], [unrelatedFile, "ask"]]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ defaultApprovals: value }));
  }
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(olderFile, old, old);

  const wildEnv = { ...env, CLAUDE_PLUGIN_DATA: wildData };
  assert.deepEqual(resolveLegacyUserConfigFiles(wildEnv).slice(0, 3), [path.join(wildData, "config.json"), openaiFile, olderFile]);

  const report = JSON.parse(run("node", [SCRIPT, "setup", "--json"], { cwd: repo, env: wildEnv }).stdout);
  assert.deepEqual(report.defaultApprovals, { mode: "auto-review", source: "plugin-default-legacy", file: openaiFile, configFile });
  assert.equal(run("node", [SCRIPT, "task", "look around"], { cwd: repo, env: wildEnv }).status, 0);
  assert.equal(readFakeState(statePath).lastThreadStart.approvalsReviewer, "auto_review");
  assert.equal(fs.existsSync(path.join(wildData, "config.json")), false, "reading does not write");

  run("node", [SCRIPT, "setup", "--default-approvals", "auto-review"], { cwd: repo, env: wildEnv });
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, "utf8")), { defaultApprovals: "auto-review" });
  assert.deepEqual(JSON.parse(fs.readFileSync(openaiFile, "utf8")), { defaultApprovals: "auto-review" }, "the old file is kept");
});

test("an empty config.json of another installation does not hide an older one with a value", () => {
  const { repo, env } = setupWithoutOverride();
  const dataRoot = path.join(makeTempDir(), "plugins", "data");
  const wildData = path.join(dataRoot, "codex-wild-codex");
  fs.mkdirSync(wildData, { recursive: true });
  const emptyFile = path.join(dataRoot, "codex-newer", "config.json");
  const valueFile = path.join(dataRoot, "codex-openai-codex", "config.json");
  fs.mkdirSync(path.dirname(emptyFile), { recursive: true });
  fs.mkdirSync(path.dirname(valueFile), { recursive: true });
  fs.writeFileSync(valueFile, JSON.stringify({ defaultApprovals: "auto-review" }));
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(valueFile, old, old);
  fs.writeFileSync(emptyFile, "{}");

  const wildEnv = { ...env, CLAUDE_PLUGIN_DATA: wildData };
  const report = JSON.parse(run("node", [SCRIPT, "setup", "--json"], { cwd: repo, env: wildEnv }).stdout);
  assert.equal(report.defaultApprovals.mode, "auto-review");
  assert.equal(report.defaultApprovals.file, valueFile);

  // This installation's own old file wins even when empty: that was an unset.
  fs.writeFileSync(path.join(wildData, "config.json"), "{}");
  const own = JSON.parse(run("node", [SCRIPT, "setup", "--json"], { cwd: repo, env: wildEnv }).stdout);
  assert.equal(own.defaultApprovals.mode, null);
});
