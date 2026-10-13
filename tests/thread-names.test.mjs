import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";
import {
  DEFAULT_THREAD_PREFIX,
  THREAD_PREFIX_ENV,
  buildTaskThreadName,
  isTaskThreadName,
  normalizeTaskName,
  normalizeThreadPrefix,
  resolveThreadPrefix,
  taskThreadPrefixes
} from "../plugins/codex/scripts/lib/thread-names.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");
const SESSION_HOOK = path.join(ROOT, "plugins", "codex", "scripts", "session-lifecycle-hook.mjs");

function setupRepo(t, behavior = "review-ok", extraEnv = {}) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, behavior);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  const env = { ...buildEnv(binDir), ...extraEnv };
  delete env[THREAD_PREFIX_ENV];
  Object.assign(env, extraEnv);
  t.after(() => {
    run("node", [SESSION_HOOK, "SessionEnd"], {
      cwd: repo,
      env,
      input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo })
    });
  });
  const statePath = path.join(binDir, "fake-codex-state.json");
  const readFakeState = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
  const threadName = (threadId) => readFakeState().threads.find((thread) => thread.id === threadId)?.name ?? null;
  const readJobs = () => JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "state.json"), "utf8")).jobs;
  return { repo, env, readFakeState, threadName, readJobs };
}

function runTask(repo, env, args) {
  const result = run("node", [SCRIPT, "task", "--json", ...args], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("thread names are '<prefix>: <name or start of the prompt>', CCT by default", () => {
  assert.equal(DEFAULT_THREAD_PREFIX, "CCT");
  assert.equal(buildTaskThreadName({ prefix: "CCT", prompt: "fix the flaky test" }), "CCT: fix the flaky test");
  assert.equal(buildTaskThreadName({ prefix: "CCT", prompt: "fix it", name: "Cancel on Windows" }), "CCT: Cancel on Windows");
  assert.equal(buildTaskThreadName({ prefix: "CCT", prompt: "  a\n\n b  " }), "CCT: a b");
  assert.equal(buildTaskThreadName({ prefix: "CCT", prompt: "" }), "CCT");
  const long = buildTaskThreadName({ prefix: "CCT", prompt: "x".repeat(100) });
  assert.equal(long, `CCT: ${"x".repeat(53)}...`);

  assert.equal(normalizeTaskName("  Починка\ncancel  "), "Починка cancel");
  assert.equal(normalizeTaskName("n".repeat(100)).length, 80);
  assert.throws(() => normalizeTaskName("   "), /--name needs a non-empty name/);

  assert.equal(normalizeThreadPrefix(" My  tasks "), "My tasks");
  assert.throws(() => normalizeThreadPrefix(""), /Unsupported thread prefix/);
  assert.throws(() => normalizeThreadPrefix("p".repeat(41)), /Unsupported thread prefix/);
  assert.equal(normalizeThreadPrefix("", { strict: false }), null);

  assert.deepEqual(resolveThreadPrefix({}), { prefix: "CCT", source: "default" });
  assert.deepEqual(resolveThreadPrefix({ [THREAD_PREFIX_ENV]: "Mine" }), { prefix: "Mine", source: "env" });
  assert.deepEqual(resolveThreadPrefix({ [THREAD_PREFIX_ENV]: "p".repeat(41) }), {
    prefix: "CCT",
    source: "default",
    invalidEnv: "p".repeat(41)
  });

  assert.deepEqual(taskThreadPrefixes("Mine"), ["Mine", "CCT", "Codex Companion Task"]);
  assert.equal(isTaskThreadName("CCT: fix", ["CCT"]), true);
  assert.equal(isTaskThreadName("CCT", ["CCT"]), true);
  assert.equal(isTaskThreadName("CCTX: fix", ["CCT"]), false);
  assert.equal(isTaskThreadName(null, ["CCT"]), false);
});

test("task names its Codex thread CCT: <start of the prompt> by default and CCT: <name> with --name", (t) => {
  const { repo, env, threadName, readFakeState, readJobs } = setupRepo(t);

  const plain = runTask(repo, env, ["investigate the flaky worker timeout"]);
  assert.equal(threadName(plain.threadId), "CCT: investigate the flaky worker timeout");

  const named = runTask(repo, env, ["--name", "Cancel on Windows", "investigate the broker"]);
  assert.equal(threadName(named.threadId), "CCT: Cancel on Windows");
  // --name and its value are not part of the prompt.
  assert.equal(readFakeState().lastTurnStart.prompt, "investigate the broker");
  const job = readJobs().find((candidate) => candidate.threadId === named.threadId);
  assert.equal(job.threadName, "CCT: Cancel on Windows");

  const status = run("node", [SCRIPT, "status", job.id], { cwd: repo, env });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Codex thread: CCT: Cancel on Windows/);
  const result = run("node", [SCRIPT, "result", job.id], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Codex thread: CCT: Cancel on Windows/);

  const empty = run("node", [SCRIPT, "task", "--name", "  ", "do it"], { cwd: repo, env });
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /--name needs a non-empty name/);
});

test("--resume-last keeps the thread name unless --name gives a new one", (t) => {
  const { repo, env, threadName, readFakeState } = setupRepo(t);
  const first = runTask(repo, env, ["--name", "First name", "initial task"]);

  runTask(repo, env, ["--resume-last", "follow up"]);
  assert.equal(readFakeState().lastThreadResume.threadId, first.threadId);
  assert.equal(threadName(first.threadId), "CCT: First name");

  runTask(repo, env, ["--resume-last", "--name", "Second name", "follow up again"]);
  assert.equal(threadName(first.threadId), "CCT: Second name");
});

test("the prefix comes from setup --thread-prefix, and CODEX_COMPANION_THREAD_PREFIX overrides it", (t) => {
  const { repo, env, threadName } = setupRepo(t);

  const set = run("node", [SCRIPT, "setup", "--json", "--thread-prefix", "My tasks"], { cwd: repo, env });
  assert.equal(set.status, 0, set.stderr);
  const report = JSON.parse(set.stdout);
  assert.equal(report.threadPrefix.prefix, "My tasks");
  assert.equal(report.threadPrefix.source, "plugin-default");
  assert.match(report.actionsTaken.join("\n"), /thread name prefix for all repositories to "My tasks"/);
  const config = JSON.parse(fs.readFileSync(env.CODEX_COMPANION_CONFIG_FILE, "utf8"));
  assert.equal(config.threadPrefix, "My tasks");

  const fromSetting = runTask(repo, env, ["--name", "Setting", "do it"]);
  assert.equal(threadName(fromSetting.threadId), "My tasks: Setting");

  const fromEnv = runTask(repo, { ...env, [THREAD_PREFIX_ENV]: "ENV" }, ["--name", "Env", "do it"]);
  assert.equal(threadName(fromEnv.threadId), "ENV: Env");

  const text = run("node", [SCRIPT, "setup"], { cwd: repo, env: { ...env, [THREAD_PREFIX_ENV]: "ENV" } });
  assert.match(text.stdout, /- thread prefix: "ENV" \(from CODEX_COMPANION_THREAD_PREFIX, which overrides `--thread-prefix`\)/);

  const bad = run("node", [SCRIPT, "setup", "--thread-prefix", "   "], { cwd: repo, env });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Unsupported thread prefix/);

  const unset = run("node", [SCRIPT, "setup", "--json", "--thread-prefix", "unset"], { cwd: repo, env });
  assert.equal(unset.status, 0, unset.stderr);
  assert.deepEqual(
    { prefix: JSON.parse(unset.stdout).threadPrefix.prefix, source: JSON.parse(unset.stdout).threadPrefix.source },
    { prefix: "CCT", source: "default" }
  );
  const afterUnset = runTask(repo, env, ["--name", "Default", "do it"]);
  assert.equal(threadName(afterUnset.threadId), "CCT: Default");
});

test("a background task with --name shows the thread name in its launch line and job record", (t) => {
  const { repo, env, readJobs } = setupRepo(t);
  const launched = run("node", [SCRIPT, "task", "--background", "--name", "Background run", "look around"], {
    cwd: repo,
    env
  });
  assert.equal(launched.status, 0, launched.stderr);
  assert.match(launched.stdout, /started in the background as task-\S+ \(Codex thread "CCT: Background run"\)\./);

  const json = run("node", [SCRIPT, "task", "--background", "--json", "--name", "Background json", "look around"], {
    cwd: repo,
    env
  });
  assert.equal(json.status, 0, json.stderr);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.threadName, "CCT: Background json");
  assert.equal(readJobs().find((job) => job.id === payload.jobId).threadName, "CCT: Background json");
});

test("--resume-last without a job record still finds threads named with the old prefix", (t) => {
  const { repo, env, readFakeState } = setupRepo(t);
  const old = runTask(repo, { ...env, [THREAD_PREFIX_ENV]: "Codex Companion Task" }, ["an older task"]);
  // No job record: the companion has to ask Codex for the latest task thread.
  // broker.json stays, so the test's cleanup still finds the broker.
  const stateFile = path.join(resolveStateDir(repo), "state.json");
  fs.writeFileSync(stateFile, `${JSON.stringify({ ...JSON.parse(fs.readFileSync(stateFile, "utf8")), jobs: [] }, null, 2)}\n`);
  fs.rmSync(path.join(resolveStateDir(repo), "jobs"), { recursive: true, force: true });

  runTask(repo, env, ["--resume-last", "follow up"]);
  assert.equal(readFakeState().lastThreadResume.threadId, old.threadId);
});
