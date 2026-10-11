import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  BROKER_IDLE_ENV,
  loadBrokerSession,
  resolveBrokerLaunchMode,
  sendBrokerShutdown,
  spawnBrokerProcess,
  waitForBrokerEndpoint
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { createBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";
import { isProcessAlive, terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");
const SESSION_HOOK = path.join(ROOT, "plugins", "codex", "scripts", "session-lifecycle-hook.mjs");
const BROKER_LIFECYCLE_URL = pathToFileURL(path.join(ROOT, "plugins", "codex", "scripts", "lib", "broker-lifecycle.mjs")).href;
const WINDOWS_ONLY = process.platform !== "win32" ? "Windows only: taskkill /T follows ParentProcessId links" : false;

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

function setupRepo(t, behavior) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, behavior);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  // The broker must not idle out while the test looks at it.
  const env = { ...buildEnv(binDir), [BROKER_IDLE_ENV]: "0" };
  t.after(async () => {
    const session = loadBrokerSession(repo);
    run("node", [SESSION_HOOK, "SessionEnd"], {
      cwd: repo,
      env,
      input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo })
    });
    if (session?.pid) {
      await waitFor(() => !isProcessAlive(session.pid), { timeoutMs: 10000 }).catch(() => {
        terminateProcessTree(session.pid);
      });
    }
  });
  const statePath = path.join(binDir, "fake-codex-state.json");
  return { repo, env, readFakeState: () => JSON.parse(fs.readFileSync(statePath, "utf8")) };
}

/**
 * A real client process that starts the shared broker the way a task worker
 * does (ensureBrokerSession), records the session and keeps running. Started
 * detached like the worker, so on POSIX it leads its own process group.
 */
async function startBrokerClient(t, repo, env, { mode } = {}) {
  const dir = makeTempDir();
  const sessionFile = path.join(dir, "session.json");
  const clientScript = path.join(dir, "client.mjs");
  fs.writeFileSync(
    clientScript,
    `import fs from "node:fs";
import { ensureBrokerSession } from ${JSON.stringify(BROKER_LIFECYCLE_URL)};
const session = await ensureBrokerSession(${JSON.stringify(repo)}, {
  timeoutMs: 15000${mode ? `,\n  brokerLaunchMode: ${JSON.stringify(mode)}` : ""}
});
fs.writeFileSync(${JSON.stringify(sessionFile)}, JSON.stringify(session));
setInterval(() => {}, 1000);
`,
    "utf8"
  );
  const client = spawn(process.execPath, [clientScript], {
    cwd: repo,
    env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  client.unref();
  t.after(() => {
    if (isProcessAlive(client.pid)) {
      terminateProcessTree(client.pid);
    }
  });
  const session = await waitFor(() => {
    try {
      return JSON.parse(fs.readFileSync(sessionFile, "utf8"));
    } catch {
      return null;
    }
  }, { timeoutMs: 20000 });
  assert.ok(session?.pid, "the client should have started a broker");
  return { client, session };
}

test("brokers start through the launcher on Windows and directly elsewhere", () => {
  assert.equal(resolveBrokerLaunchMode("win32"), "launcher");
  assert.equal(resolveBrokerLaunchMode("linux"), "direct");
  assert.equal(resolveBrokerLaunchMode("darwin"), "direct");
});

for (const mode of ["launcher", "direct"]) {
  test(`spawnBrokerProcess (${mode}) reports the broker's own pid, the one in its pid file`, async (t) => {
    const { repo, env } = setupRepo(t, "review-ok");
    const sessionDir = makeTempDir("cxc-test-");
    const endpoint = createBrokerEndpoint(sessionDir);
    const pidFile = path.join(sessionDir, "broker.pid");
    const logFile = path.join(sessionDir, "broker.log");
    const broker = await spawnBrokerProcess({
      scriptPath: path.join(ROOT, "plugins", "codex", "scripts", "app-server-broker.mjs"),
      cwd: repo,
      endpoint,
      pidFile,
      logFile,
      env,
      mode
    });
    t.after(async () => {
      await sendBrokerShutdown(endpoint);
      await waitFor(() => !isProcessAlive(broker.pid), { timeoutMs: 10000 }).catch(() => terminateProcessTree(broker.pid));
    });
    assert.equal(broker.mode, mode);
    assert.ok(Number.isInteger(broker.pid));
    assert.ok(await waitForBrokerEndpoint(endpoint, 15000), "the broker should listen on its endpoint");
    assert.equal(Number(fs.readFileSync(pidFile, "utf8").trim()), broker.pid);
    if (mode === "launcher" && process.platform === "linux") {
      // The launcher is gone: the broker was handed to init (or a subreaper).
      const stat = fs.readFileSync(`/proc/${broker.pid}/stat`, "utf8");
      const parentPid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      assert.notEqual(parentPid, process.pid);
    }
  });
}

test("a broker survives the process tree of the client that started it being killed", async (t) => {
  const { repo, env, readFakeState } = setupRepo(t, "review-ok");
  const { client, session } = await startBrokerClient(t, repo, env);
  const [appServerPid] = readFakeState().appServerPids;
  assert.ok(isProcessAlive(session.pid));
  assert.ok(isProcessAlive(appServerPid));

  // What `/codex:cancel` does to a task worker: taskkill /PID <client> /T /F
  // on Windows, SIGTERM to the client's process group elsewhere.
  const outcome = terminateProcessTree(client.pid);
  assert.equal(outcome.delivered, true, JSON.stringify(outcome.result ?? null));
  await waitFor(() => !isProcessAlive(client.pid));

  // Give a tree kill time to reach everything it is going to reach.
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(isProcessAlive(session.pid), "the shared broker should still run");
  assert.ok(isProcessAlive(appServerPid), "the broker's codex app-server should still run");
  assert.ok(await waitForBrokerEndpoint(session.endpoint, 2000), "the broker should still answer on its endpoint");
  assert.deepEqual(loadBrokerSession(repo), session);
});

test(
  "(Windows) taskkill /T of the client reaches a broker started directly, which is why the launcher exists",
  { skip: WINDOWS_ONLY },
  async (t) => {
    const { repo, env } = setupRepo(t, "review-ok");
    const { client, session } = await startBrokerClient(t, repo, env, { mode: "direct" });
    assert.ok(isProcessAlive(session.pid));
    terminateProcessTree(client.pid);
    await waitFor(() => !isProcessAlive(session.pid), { timeoutMs: 10000 });
    // The broker died without its shutdown: clean up what it left behind.
    fs.rmSync(path.join(resolveStateDir(repo), "broker.json"), { force: true });
    fs.rmSync(session.sessionDir, { recursive: true, force: true });
  }
);

test("the broker started by a background task survives cancel of that task, and the next task uses it", async (t) => {
  const { repo, env, readFakeState } = setupRepo(t, "interruptible-slow-task");

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the flaky worker timeout"], {
    cwd: repo,
    env
  });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;

  const stateFile = path.join(resolveStateDir(repo), "state.json");
  const runningJob = await waitFor(() => {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    return job?.status === "running" && job.threadId && job.turnId && job.pid ? job : null;
  });
  // The worker of this task started the broker: it is the broker's client.
  const broker = loadBrokerSession(repo);
  assert.ok(broker?.pid);
  const [appServerPid] = readFakeState().appServerPids;

  const cancelled = run("node", [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  const payload = JSON.parse(cancelled.stdout);
  assert.equal(payload.status, "cancelled");
  assert.equal(payload.turnInterrupted, true);
  assert.ok(["exited", "terminated"].includes(payload.workerStop), cancelled.stdout);
  assert.equal(payload.workerExited, payload.workerStop === "exited");
  assert.equal(payload.workerTerminated, payload.workerStop === "terminated");
  assert.equal(payload.workerTerminationError, undefined);
  await waitFor(() => !isProcessAlive(runningJob.pid));

  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(isProcessAlive(broker.pid), "cancel must not kill the shared broker");
  assert.ok(isProcessAlive(appServerPid), "cancel must not kill the broker's codex app-server");
  assert.deepEqual(loadBrokerSession(repo), broker);

  const next = run("node", [SCRIPT, "task", "--json", "look around again"], { cwd: repo, env });
  assert.equal(next.status, 0, next.stderr);
  assert.equal(loadBrokerSession(repo)?.pid, broker.pid, "the next task should use the same broker");
  assert.equal(readFakeState().appServerStarts, 1);
});
