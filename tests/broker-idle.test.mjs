import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  BROKER_IDLE_ENV,
  DEFAULT_BROKER_IDLE_MS,
  loadBrokerSession,
  resolveBrokerIdleMs
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");
const SESSION_HOOK = path.join(ROOT, "plugins", "codex", "scripts", "session-lifecycle-hook.mjs");
// Small enough for a quick test, large enough that a broker never idles out
// between two requests of one command.
const TEST_IDLE_MS = "400";

async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

function processAlive(pid) {
  if (!Number.isFinite(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function setupRepo(t, behavior, idleMs) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, behavior);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  const env = { ...buildEnv(binDir), [BROKER_IDLE_ENV]: idleMs };
  t.after(() => {
    run("node", [SESSION_HOOK, "SessionEnd"], {
      cwd: repo,
      env,
      input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo })
    });
  });
  const statePath = path.join(binDir, "fake-codex-state.json");
  return { repo, env, readFakeState: () => JSON.parse(fs.readFileSync(statePath, "utf8")) };
}

test("the broker idle timeout defaults to 5 minutes, 0 disables it, junk is ignored", () => {
  assert.equal(DEFAULT_BROKER_IDLE_MS, 300000);
  assert.deepEqual(resolveBrokerIdleMs({}), { idleMs: 300000, source: "default" });
  assert.deepEqual(resolveBrokerIdleMs({ [BROKER_IDLE_ENV]: " " }), { idleMs: 300000, source: "default" });
  assert.deepEqual(resolveBrokerIdleMs({ [BROKER_IDLE_ENV]: "0" }), { idleMs: 0, source: "env" });
  assert.deepEqual(resolveBrokerIdleMs({ [BROKER_IDLE_ENV]: "1500" }), { idleMs: 1500, source: "env" });
  for (const junk of ["-1", "5m", "1e3", "abc"]) {
    assert.deepEqual(resolveBrokerIdleMs({ [BROKER_IDLE_ENV]: junk }), { idleMs: 300000, source: "default", invalid: junk });
  }
});

test("an idle broker exits with its app-server after a task, and the next task starts a new one", async (t) => {
  const { repo, env, readFakeState } = setupRepo(t, "review-ok", TEST_IDLE_MS);

  const first = run("node", [SCRIPT, "task", "look around"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);
  const firstBroker = loadBrokerSession(repo);
  assert.ok(firstBroker, "the task should start the shared broker");
  assert.ok(processAlive(firstBroker.pid));
  const [firstAppServerPid] = readFakeState().appServerPids;
  assert.ok(processAlive(firstAppServerPid));

  await waitFor(() => !processAlive(firstBroker.pid));
  await waitFor(() => !processAlive(firstAppServerPid));
  // The broker removed its own record and files on the way out.
  assert.equal(loadBrokerSession(repo), null);
  assert.equal(fs.existsSync(firstBroker.pidFile), false);
  assert.equal(fs.existsSync(firstBroker.sessionDir), false);

  const status = run("node", [SCRIPT, "status", "--json"], { cwd: repo, env });
  assert.equal(status.status, 0, status.stderr);

  const second = run("node", [SCRIPT, "task", "look around again"], { cwd: repo, env });
  assert.equal(second.status, 0, second.stderr);
  const secondBroker = loadBrokerSession(repo);
  assert.ok(secondBroker, "the next task should start a new broker");
  assert.notEqual(secondBroker.pid, firstBroker.pid);
  assert.notEqual(secondBroker.endpoint, firstBroker.endpoint);
  assert.equal(readFakeState().appServerStarts, 2);
});

test("a stale broker.json left by a dead broker breaks neither setup nor the next task", async (t) => {
  const { repo, env, readFakeState } = setupRepo(t, "review-ok", "0");

  const first = run("node", [SCRIPT, "task", "look around"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);
  const firstBroker = loadBrokerSession(repo);
  assert.ok(firstBroker);
  const [orphanAppServerPid] = readFakeState().appServerPids;
  // A crash: the broker dies without cleaning up (SIGKILL), its record stays.
  process.kill(firstBroker.pid, "SIGKILL");
  await waitFor(() => !processAlive(firstBroker.pid));
  // Its app-server sees stdin close and exits on its own.
  await waitFor(() => !processAlive(orphanAppServerPid));
  assert.ok(loadBrokerSession(repo), "the stale record is still there");

  // setup only reuses an existing broker: it must notice the dead one,
  // forget it and ask a direct app-server instead of reporting a login error.
  const setup = run("node", [SCRIPT, "setup", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);
  const report = JSON.parse(setup.stdout);
  assert.equal(report.auth.loggedIn, true, report.auth.detail);
  assert.equal(report.ready, true);
  assert.equal(loadBrokerSession(repo), null, "the stale record is removed");
  assert.equal(fs.existsSync(firstBroker.sessionDir), false, "the dead broker's files are removed too");

  const second = run("node", [SCRIPT, "task", "look around again"], { cwd: repo, env });
  assert.equal(second.status, 0, second.stderr);
  const secondBroker = loadBrokerSession(repo);
  assert.ok(secondBroker);
  assert.notEqual(secondBroker.pid, firstBroker.pid);
}, { skip: process.platform === "win32" ? "SIGKILL is not a distinct signal on Windows" : false });

test("the broker stays up while an approval waits for the user, longer than its idle timeout", async (t) => {
  const { repo, env, readFakeState } = setupRepo(t, "approval-command", TEST_IDLE_MS);

  const launched = run("node", [SCRIPT, "task", "--background", "--write", "--json", "install a dependency"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);

  const pending = await waitFor(() => {
    const listed = run("node", [SCRIPT, "approvals", jobId, "--json"], { cwd: repo, env });
    if (listed.status !== 0) {
      return null;
    }
    const payload = JSON.parse(listed.stdout);
    return payload.pending.length ? payload.pending : null;
  });
  const broker = loadBrokerSession(repo);
  assert.ok(broker, "the worker should use the shared broker");
  const [appServerPid] = readFakeState().appServerPids;

  // Several idle timeouts pass while the user has not answered.
  await new Promise((resolve) => setTimeout(resolve, Number(TEST_IDLE_MS) * 4));
  assert.ok(processAlive(broker.pid), "the broker must not exit while an approval is waiting");
  assert.ok(processAlive(appServerPid));
  assert.deepEqual(loadBrokerSession(repo), broker);

  const approved = run("node", [SCRIPT, "approve", jobId, pending[0].approvalId, "--decision", "accept"], { cwd: repo, env });
  assert.equal(approved.status, 0, approved.stderr);
  const waited = run("node", [SCRIPT, "status", jobId, "--wait", "--timeout-ms", "20000", "--json"], { cwd: repo, env });
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).job.status, "completed");
  assert.deepEqual(readFakeState().approvalResponses[0].result, { decision: "accept" });

  // Once the turn is over, the broker idles out.
  await waitFor(() => !processAlive(broker.pid));
  await waitFor(() => !processAlive(appServerPid));
  assert.equal(loadBrokerSession(repo), null);
});

test("with an idle timeout of 0 the broker stays until SessionEnd", async (t) => {
  const { repo, env, readFakeState } = setupRepo(t, "review-ok", "0");

  const first = run("node", [SCRIPT, "task", "look around"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);
  const broker = loadBrokerSession(repo);
  assert.ok(broker);
  const [appServerPid] = readFakeState().appServerPids;

  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.ok(processAlive(broker.pid), "the broker must stay up without an idle timeout");
  assert.ok(processAlive(appServerPid));

  const second = run("node", [SCRIPT, "task", "look around again"], { cwd: repo, env });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(loadBrokerSession(repo).pid, broker.pid, "the same broker is reused");
  assert.equal(readFakeState().appServerStarts, 1);

  const ended = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo })
  });
  assert.equal(ended.status, 0, ended.stderr);
  await waitFor(() => !processAlive(broker.pid));
  await waitFor(() => !processAlive(appServerPid));
  assert.equal(loadBrokerSession(repo), null);
});
