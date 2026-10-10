import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test, { after } from "node:test";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  buildApprovalResponse,
  buildApprovalRoutingParams,
  createApprovalHandler,
  describeApprovalClosure,
  failClosedServerRequestResult,
  formatClosedApprovalMessage,
  normalizeApprovalTimeoutMinutes,
  listPendingApprovals,
  normalizeApprovalMode,
  recordApprovalDecision,
  resolveApprovalsDir
} from "../plugins/codex/scripts/lib/approvals.mjs";
import {
  assertThreadPermissions,
  buildResumeParams,
  buildThreadParams,
  buildTurnStartParams
} from "../plugins/codex/scripts/lib/codex.mjs";
import { loadBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { checkProtocolSchema, summarizeProtocolCheck } from "../plugins/codex/scripts/lib/protocol-check.mjs";
import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import { createBrokerSessionDir, waitForBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");
const BROKER = path.join(ROOT, "plugins", "codex", "scripts", "app-server-broker.mjs");
const SESSION_HOOK = path.join(ROOT, "plugins", "codex", "scripts", "session-lifecycle-hook.mjs");

async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 100 } = {}) {
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

function setupRepo(behavior) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, behavior);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  const env = buildEnv(binDir);
  startedRepos.push({ repo, env });
  return { repo, binDir, env, statePath: path.join(binDir, "fake-codex-state.json") };
}

// Runs start a shared broker on first use; shut them all down at the end.
const startedRepos = [];
after(() => {
  for (const { repo, env } of startedRepos) {
    stopBroker(repo, env);
  }
});

function readFakeState(statePath) {
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

// Shut down the shared broker a run started, like the SessionEnd hook does.
function stopBroker(repo, env) {
  run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo })
  });
}

function launchBackgroundTask(repo, env, args) {
  const launched = run("node", [SCRIPT, "task", "--background", "--json", ...args], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  return JSON.parse(launched.stdout).jobId;
}

function waitForPending(repo, env, jobId) {
  return waitFor(() => {
    const listed = run("node", [SCRIPT, "approvals", jobId, "--json"], { cwd: repo, env });
    if (listed.status !== 0) {
      return null;
    }
    const payload = JSON.parse(listed.stdout);
    return payload.pending.length ? payload.pending : null;
  });
}

function waitForJob(repo, env, jobId) {
  const waited = run("node", [SCRIPT, "status", jobId, "--wait", "--timeout-ms", "20000", "--json"], { cwd: repo, env });
  assert.equal(waited.status, 0, waited.stderr);
  return JSON.parse(waited.stdout).job;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A pending approval request on disk, as a background worker writes it.
function writePendingRequest(workspaceRoot, jobId, approvalId) {
  const dir = resolveApprovalsDir(workspaceRoot, jobId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${approvalId}.request.json`),
    JSON.stringify({ approvalId, jobId, method: "item/commandExecution/requestApproval", summary: "Run ls", requestedAt: new Date().toISOString() })
  );
}

const COMMAND_REQUEST = {
  id: "srv_1",
  method: "item/commandExecution/requestApproval",
  params: { threadId: "thr_1", turnId: "turn_1", itemId: "cmd_1", command: "npm install left-pad", cwd: "/repo" }
};

function onlyApprovalId(workspaceRoot, jobId) {
  return waitFor(() => listPendingApprovals(workspaceRoot, jobId)[0]?.approvalId ?? null, { timeoutMs: 5000, intervalMs: 20 });
}

// --- unit: parameter builders ------------------------------------------------

test("thread, resume and turn params never force an approval policy", () => {
  const start = buildThreadParams("/repo", { sandbox: "workspace-write" });
  const resume = buildResumeParams("thr_1", "/repo", { sandbox: "read-only" });
  const turn = buildTurnStartParams("thr_1", "hi", { model: "m", effort: "low" });

  assert.equal("approvalPolicy" in start, false);
  assert.equal("approvalPolicy" in resume, false);
  assert.equal("approvalPolicy" in turn, false);
  assert.equal(start.sandbox, "workspace-write");
  assert.equal(resume.sandbox, "read-only");
  assert.equal("sandboxPolicy" in turn, false);
  assert.equal("approvalsReviewer" in start, false, "no explicit mode keeps the reviewer from the Codex config");
});

test("an explicit approval mode routes the reviewer on thread and turn alike", () => {
  for (const [mode, reviewer] of [["auto-review", "auto_review"], ["ask", "user"], ["deny", "user"]]) {
    assert.equal(buildThreadParams("/repo", { approvalMode: mode }).approvalsReviewer, reviewer);
    assert.equal(buildResumeParams("thr_1", "/repo", { approvalMode: mode }).approvalsReviewer, reviewer);
    assert.equal(buildTurnStartParams("thr_1", "hi", { approvalMode: mode }).approvalsReviewer, reviewer);
  }
  assert.deepEqual(buildApprovalRoutingParams(null), {});
});

test("full access is never requested and a wider applied sandbox is refused", () => {
  assert.throws(() => buildThreadParams("/repo", { sandbox: "danger-full-access" }), /Unsupported sandbox mode/);
  assert.throws(
    () => assertThreadPermissions({ sandbox: { type: "dangerFullAccess" } }, { sandbox: "workspace-write" }),
    /Refusing to run/
  );
  assert.throws(
    () => assertThreadPermissions({ sandbox: { type: "readOnly" }, approvalsReviewer: "user" }, { approvalMode: "auto-review" }),
    /Refusing to run/
  );
  assert.doesNotThrow(() => assertThreadPermissions({ sandbox: { type: "workspaceWrite" } }, { sandbox: "workspace-write" }));
});

test("approval mode values are validated", () => {
  assert.equal(normalizeApprovalMode(undefined), null);
  assert.equal(normalizeApprovalMode("Auto-Review"), "auto-review");
  assert.throws(() => normalizeApprovalMode("always"), /Unsupported approval mode/);
});

// --- unit: decision mapping ---------------------------------------------------

test("decisions map onto each approval method without session-wide grants", () => {
  assert.deepEqual(buildApprovalResponse("item/commandExecution/requestApproval", {}, "accept"), { decision: "accept" });
  assert.deepEqual(buildApprovalResponse("item/fileChange/requestApproval", {}, "decline"), { decision: "decline" });
  const permissions = { network: { enabled: true }, fileSystem: null };
  assert.deepEqual(buildApprovalResponse("item/permissions/requestApproval", { permissions }, "accept"), {
    permissions: { network: { enabled: true } },
    scope: "turn"
  });
  assert.deepEqual(buildApprovalResponse("item/permissions/requestApproval", { permissions }, "decline"), {
    permissions: {},
    scope: "turn"
  });
  // Exactly what was requested, nothing else the request may carry, only for the turn.
  const requested = { network: { enabled: true }, fileSystem: { write: ["/repo/vendor"], read: null }, somethingNew: { all: true } };
  assert.deepEqual(buildApprovalResponse("item/permissions/requestApproval", { permissions: requested }, "accept"), {
    permissions: { network: { enabled: true }, fileSystem: { write: ["/repo/vendor"], read: null } },
    scope: "turn"
  });
  for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "execCommandApproval", "applyPatchApproval"]) {
    const accepted = JSON.stringify(buildApprovalResponse(method, {}, "accept"));
    assert.doesNotMatch(accepted, /ForSession|for_session|amendment|session/i);
  }
  assert.deepEqual(buildApprovalResponse("execCommandApproval", {}, "accept"), { decision: "approved" });
  assert.deepEqual(buildApprovalResponse("applyPatchApproval", {}, "decline", "no"), {
    decision: { denied: { rejection: "no" } }
  });
});

test("the default server request answer is fail-closed", () => {
  assert.deepEqual(failClosedServerRequestResult({ method: "item/commandExecution/requestApproval", params: {} }), {
    decision: "decline"
  });
  assert.deepEqual(failClosedServerRequestResult({ method: "mcpServer/elicitation/request", params: {} }), {
    action: "decline",
    content: null,
    _meta: null
  });
  assert.throws(
    () => failClosedServerRequestResult({ method: "item/tool/call", params: {} }),
    (error) => error.rpcCode === -32601
  );
});

// --- unit: protocol schema check ---------------------------------------------

function writeSchema(dir, file, value) {
  const filePath = path.join(dir, ...file.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
}

function writeMinimalSchema(dir, overrides = {}) {
  const enumDef = (values) => ({ oneOf: values.map((value) => ({ enum: [value], type: "string" })) });
  const definitions = { ApprovalsReviewer: enumDef(["user", "auto_review"]), SandboxMode: { enum: ["read-only", "workspace-write"] } };
  const props = (names) => Object.fromEntries(names.map((name) => [name, {}]));
  writeSchema(dir, "v2/ThreadStartParams.json", {
    properties: props(overrides.threadStartFields ?? ["cwd", "model", "sandbox", "approvalsReviewer", "serviceName", "ephemeral"]),
    definitions
  });
  writeSchema(dir, "v2/ThreadResumeParams.json", { properties: props(["threadId", "cwd", "model", "sandbox", "approvalsReviewer"]) });
  writeSchema(dir, "v2/TurnStartParams.json", { properties: props(["threadId", "input", "model", "effort", "outputSchema", "approvalsReviewer"]) });
  writeSchema(dir, "CommandExecutionRequestApprovalResponse.json", { definitions: { CommandExecutionApprovalDecision: enumDef(["accept", "decline"]) } });
  writeSchema(dir, "FileChangeRequestApprovalResponse.json", { definitions: { FileChangeApprovalDecision: enumDef(["accept", "decline"]) } });
  writeSchema(dir, "PermissionsRequestApprovalResponse.json", {
    definitions: {
      PermissionGrantScope: { enum: ["turn", "session"] },
      GrantedPermissionProfile: { properties: props(["network", "fileSystem"]) }
    }
  });
  writeSchema(dir, "PermissionsRequestApprovalParams.json", {
    definitions: { RequestPermissionProfile: { properties: props(overrides.requestPermissionFields ?? ["network", "fileSystem"]) } }
  });
  const reviewDecision = {
    oneOf: [
      { enum: ["approved"], type: "string" },
      { type: "object", required: ["denied"], properties: { denied: {} } },
      { enum: ["abort"], type: "string" }
    ]
  };
  writeSchema(dir, "ExecCommandApprovalResponse.json", { definitions: { ReviewDecision: reviewDecision } });
  writeSchema(dir, "ApplyPatchApprovalResponse.json", { definitions: { ReviewDecision: reviewDecision } });
  writeSchema(dir, "McpServerElicitationRequestResponse.json", { definitions: { McpServerElicitationAction: { enum: ["accept", "decline", "cancel"] } } });
  for (const file of ["v2/ThreadStartResponse.json", "v2/ThreadResumeResponse.json"]) {
    writeSchema(dir, file, { properties: props(["thread", "approvalPolicy", "approvalsReviewer", "sandbox"]) });
  }
  writeSchema(dir, "ServerNotification.json", {
    oneOf: ["turn/completed", "serverRequest/resolved"].map((method) => ({ properties: { method: { enum: [method] } } }))
  });
  const methods = overrides.serverRequests ?? [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval"
  ];
  writeSchema(dir, "ServerRequest.json", { oneOf: methods.map((method) => ({ properties: { method: { enum: [method] } } })) });
}

test("protocol check accepts a compatible schema and flags drift", () => {
  const good = makeTempDir();
  writeMinimalSchema(good);
  assert.equal(checkProtocolSchema(good).ok, true);

  const renamed = makeTempDir();
  writeMinimalSchema(renamed, { threadStartFields: ["cwd", "model", "sandbox", "serviceName", "ephemeral"] });
  const renamedReport = checkProtocolSchema(renamed);
  assert.equal(renamedReport.ok, false);
  assert.match(renamedReport.checks.find((check) => check.name === "thread/start params").detail, /approvalsReviewer/);

  const extra = makeTempDir();
  writeMinimalSchema(extra, {
    serverRequests: ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/new/thing"]
  });
  const extraReport = checkProtocolSchema(extra);
  assert.equal(extraReport.ok, true);
  assert.equal(extraReport.checks.find((check) => check.name === "unhandled server requests").level, "warning");

  const widerPermissions = makeTempDir();
  writeMinimalSchema(widerPermissions, { requestPermissionFields: ["network", "fileSystem", "macos"] });
  const widerReport = checkProtocolSchema(widerPermissions);
  assert.equal(widerReport.ok, true);
  assert.match(widerReport.checks.find((check) => check.name === "RequestPermissionProfile").detail, /macos would never be granted/);

  assert.equal(summarizeProtocolCheck(checkProtocolSchema(good)).status, "compatible");
  assert.equal(summarizeProtocolCheck(renamedReport).status, "incompatible");
  assert.equal(summarizeProtocolCheck(checkProtocolSchema(makeTempDir())).status, "unverified");
});

test("the approve command asks the user about each request and defaults to decline", () => {
  const source = fs.readFileSync(path.join(ROOT, "plugins", "codex", "commands", "approve.md"), "utf8");
  const rules = fs.readFileSync(path.join(ROOT, "plugins", "codex", "skills", "codex-approvals", "SKILL.md"), "utf8");
  assert.match(source, /disable-model-invocation: true/);
  assert.match(source, /allowed-tools: Bash\(node:\*\), AskUserQuestion, Skill/);
  assert.match(source, /`codex:codex-approvals` skill/);
  assert.match(rules, /Decline \(Recommended\)/);
  assert.match(rules, /Approve once/);
  // An expired or closed request is not a silent stop: offer --resume.
  assert.match(rules, /already closed or expired[\s\S]*do not stop silently/);
  assert.match(rules, /offer the user to continue the same Codex thread with that command/);
  assert.match(rules, /\/codex:rescue --background --resume/);
  assert.match(source, /`resumeHint`[\s\S]*\/codex:rescue --background --resume/);
  for (const text of [source, rules]) {
    assert.doesNotMatch(text, /acceptForSession|--decision accept\b(?!\|)/);
  }
});

// --- runtime: fake app-server -------------------------------------------------

test("task keeps the --write sandbox and leaves the approval policy to Codex config", () => {
  const { repo, env, statePath } = setupRepo();

  const written = run("node", [SCRIPT, "task", "--write", "fix the bug"], { cwd: repo, env });
  assert.equal(written.status, 0, written.stderr);
  let state = readFakeState(statePath);
  assert.equal(state.lastThreadStart.sandbox, "workspace-write");
  assert.equal("approvalPolicy" in state.lastThreadStart, false);
  assert.equal(state.lastTurnStart.approvalPolicy, null);
  assert.equal(state.lastTurnStart.sandboxPolicy, null);

  const readOnly = run("node", [SCRIPT, "task", "--resume", "look again"], { cwd: repo, env });
  assert.equal(readOnly.status, 0, readOnly.stderr);
  state = readFakeState(statePath);
  assert.equal(state.lastThreadResume.sandbox, "read-only");
  assert.equal("approvalPolicy" in state.lastThreadResume, false);
});

test("task --approvals auto-review routes approvals to Codex on start, resume and turn", () => {
  const { repo, env, statePath } = setupRepo();

  const started = run("node", [SCRIPT, "task", "--approvals", "auto-review", "--write", "fix the bug"], { cwd: repo, env });
  assert.equal(started.status, 0, started.stderr);
  let state = readFakeState(statePath);
  assert.equal(state.lastThreadStart.approvalsReviewer, "auto_review");
  assert.equal(state.lastTurnStart.approvalsReviewer, "auto_review");

  const resumed = run("node", [SCRIPT, "task", "--resume", "--approvals", "auto-review", "keep going"], { cwd: repo, env });
  assert.equal(resumed.status, 0, resumed.stderr);
  state = readFakeState(statePath);
  assert.equal(state.lastThreadResume.approvalsReviewer, "auto_review");
  assert.equal(state.lastTurnStart.approvalsReviewer, "auto_review");
});

test("task refuses a thread whose applied sandbox is wider than requested", () => {
  const { repo, env } = setupRepo("sandbox-escalated");
  const result = run("node", [SCRIPT, "task", "--write", "fix the bug"], { cwd: repo, env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /Refusing to run/);
});

test("a foreground task declines approval requests and reports them", () => {
  const { repo, env, statePath } = setupRepo("approval-command");
  const result = run("node", [SCRIPT, "task", "--write", "install a dependency"], { cwd: repo, env });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Approval decision: "decline"/);
  assert.match(result.stdout, /Approval requests:\n- declined: Run npm install left-pad in .+ \(foreground runs cannot ask/);
  const state = readFakeState(statePath);
  assert.deepEqual(state.approvalResponses[0].result, { decision: "decline" });
});

test("a background task waits for the user's decision recorded with approve", async () => {
  const { repo, env, statePath } = setupRepo("approval-command");
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
  assert.equal(pending.length, 1);
  assert.equal(pending[0].command, "npm install left-pad");

  const status = run("node", [SCRIPT, "status", jobId], { cwd: repo, env });
  assert.match(status.stdout, /Phase: awaiting-approval/);
  assert.match(status.stdout, new RegExp(`/codex:approve ${jobId}`));

  const bogus = run("node", [SCRIPT, "approve", jobId, "apr-00000000", "--decision", "accept"], { cwd: repo, env });
  assert.notEqual(bogus.status, 0);

  const approved = run("node", [SCRIPT, "approve", jobId, pending[0].approvalId, "--decision", "accept"], { cwd: repo, env });
  assert.equal(approved.status, 0, approved.stderr);
  const conflicting = run("node", [SCRIPT, "approve", jobId, pending[0].approvalId, "--decision", "decline"], { cwd: repo, env });
  assert.notEqual(conflicting.status, 0);

  const waited = run("node", [SCRIPT, "status", jobId, "--wait", "--timeout-ms", "20000", "--json"], { cwd: repo, env });
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).job.status, "completed");
  assert.deepEqual(readFakeState(statePath).approvalResponses[0].result, { decision: "accept" });
  // The worker connected through the shared broker, so the request crossed it both ways.
  assert.ok(loadBrokerSession(repo), "expected the run to use the shared broker");
});

test("an unanswered approval request is declined after the timeout", async () => {
  const { repo, env, statePath } = setupRepo("approval-command");
  const timedEnv = { ...env, CODEX_COMPANION_APPROVAL_TIMEOUT_MS: "1500" };
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "install a dependency"], { cwd: repo, env: timedEnv });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);

  const waited = run("node", [SCRIPT, "status", jobId, "--wait", "--timeout-ms", "20000", "--json"], { cwd: repo, env: timedEnv });
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).job.status, "completed");
  assert.deepEqual(readFakeState(statePath).approvalResponses[0].result, { decision: "decline" });

  const result = run("node", [SCRIPT, "result", jobId], { cwd: repo, env: timedEnv });
  assert.match(result.stdout, /declined: Run npm install left-pad in .+ \(no answer before the timeout\)/);
});

// --- unit: decisions and the waiting worker -----------------------------------

test("a decision is final: repeats are idempotent, a different one is rejected", () => {
  const workspace = makeTempDir();
  writePendingRequest(workspace, "task-a", "apr-0a");
  writePendingRequest(workspace, "task-b", "apr-0b");

  assert.equal(recordApprovalDecision(workspace, "task-a", "apr-0a", "accept").decision, "accept");
  assert.equal(recordApprovalDecision(workspace, "task-a", "apr-0a", "accept").decision, "accept");
  assert.throws(() => recordApprovalDecision(workspace, "task-a", "apr-0a", "decline"), /already decided: accept/);
  assert.throws(() => recordApprovalDecision(workspace, "task-a", "apr-0a", "acceptForSession"), /Unsupported decision/);

  // A request id only resolves inside its own job, and ids cannot escape the directory.
  assert.throws(() => recordApprovalDecision(workspace, "task-a", "apr-0b", "accept"), /No approval request apr-0b for job task-a/);
  assert.throws(() => recordApprovalDecision(workspace, "task-a", "../task-b/apr-0b", "accept"), /Invalid approval id/);
  // A request file copied into another job's directory does not belong to it.
  fs.copyFileSync(
    path.join(resolveApprovalsDir(workspace, "task-b"), "apr-0b.request.json"),
    path.join(resolveApprovalsDir(workspace, "task-a"), "apr-0b.request.json")
  );
  assert.throws(() => recordApprovalDecision(workspace, "task-a", "apr-0b", "accept"), /No approval request apr-0b for job task-a/);
});

test("an approval waits for the user, and the first decision wins over the timeout", async () => {
  const workspace = makeTempDir();
  const phases = [];
  const handler = createApprovalHandler({
    mode: "ask",
    interactive: true,
    workspaceRoot: workspace,
    jobId: "task-wait",
    timeoutMs: 60000,
    onProgress: (event) => phases.push(typeof event === "string" ? null : event.phase)
  });
  const answer = handler(COMMAND_REQUEST);
  const approvalId = await onlyApprovalId(workspace, "task-wait");
  recordApprovalDecision(workspace, "task-wait", approvalId, "accept");

  assert.deepEqual(await answer, { decision: "accept" });
  assert.deepEqual(phases, ["awaiting-approval", "running"]);
  assert.throws(() => recordApprovalDecision(workspace, "task-wait", approvalId, "accept"), /already closed \(accept, user\)/);
  assert.equal(handler.decisions[0].source, "user");
});

test("an unanswered approval times out to decline and a late approve is refused", async () => {
  const workspace = makeTempDir();
  const handler = createApprovalHandler({ mode: "ask", interactive: true, workspaceRoot: workspace, jobId: "task-late", timeoutMs: 600 });
  const answer = handler(COMMAND_REQUEST);
  const approvalId = await onlyApprovalId(workspace, "task-late");

  assert.deepEqual(await answer, { decision: "decline" });
  assert.equal(handler.decisions[0].source, "timeout");
  assert.throws(() => recordApprovalDecision(workspace, "task-late", approvalId, "accept"), /already closed \(decline, timeout\)/);
  assert.deepEqual(listPendingApprovals(workspace, "task-late"), []);
});

test("closing the connection or Codex resolving the request ends the wait with decline", async () => {
  const workspace = makeTempDir();
  const handler = createApprovalHandler({ mode: "ask", interactive: true, workspaceRoot: workspace, jobId: "task-close", timeoutMs: 60000 });

  const resolvedAnswer = handler(COMMAND_REQUEST);
  const resolvedId = await onlyApprovalId(workspace, "task-close");
  handler.onResolved({ threadId: "thr_1", requestId: "srv_1" });
  assert.deepEqual(await resolvedAnswer, { decision: "decline" });
  assert.throws(() => recordApprovalDecision(workspace, "task-close", resolvedId, "accept"), /already closed/);

  const closedAnswer = handler({ ...COMMAND_REQUEST, id: 7 });
  const closedId = await onlyApprovalId(workspace, "task-close");
  const started = Date.now();
  handler.onClosed();
  assert.deepEqual(await closedAnswer, { decision: "decline" });
  assert.ok(Date.now() - started < 1000, "a closed connection must not keep the worker waiting");
  assert.throws(() => recordApprovalDecision(workspace, "task-close", closedId, "accept"), /already closed \(decline, closed\)/);

  // Requests arriving after the close are declined without waiting.
  assert.deepEqual(await handler({ ...COMMAND_REQUEST, id: 8 }), { decision: "decline" });
  assert.deepEqual(handler.decisions.map((entry) => entry.source), ["resolved-by-server", "closed", "closed"]);
});

test("the job stays awaiting-approval until every concurrent request is answered", async () => {
  const workspace = makeTempDir();
  const phases = [];
  const handler = createApprovalHandler({
    mode: "ask",
    interactive: true,
    workspaceRoot: workspace,
    jobId: "task-two",
    timeoutMs: 60000,
    onProgress: (event) => phases.push(typeof event === "string" ? null : event.phase)
  });
  const first = handler(COMMAND_REQUEST);
  const second = handler({ ...COMMAND_REQUEST, id: "srv_2" });
  const ids = await waitFor(() => {
    const pending = listPendingApprovals(workspace, "task-two");
    return pending.length === 2 ? pending.map((entry) => entry.approvalId) : null;
  });
  recordApprovalDecision(workspace, "task-two", ids[0], "decline");
  await Promise.race([first, second]);
  recordApprovalDecision(workspace, "task-two", ids[1], "accept");
  await Promise.all([first, second]);

  assert.deepEqual(phases, ["awaiting-approval", "awaiting-approval", null, "running"]);
});

test("deny mode and runs that cannot ask decline without waiting", async () => {
  for (const options of [{ mode: "deny", interactive: true }, { mode: "ask", interactive: false }, { mode: "auto-review", interactive: false }]) {
    const workspace = makeTempDir();
    const handler = createApprovalHandler({ ...options, workspaceRoot: workspace, jobId: "task-x" });
    assert.deepEqual(await handler(COMMAND_REQUEST), { decision: "decline" });
    assert.deepEqual(listPendingApprovals(workspace, "task-x"), []);
  }
  const handler = createApprovalHandler({ mode: "ask", interactive: false });
  assert.deepEqual(await handler({ id: 1, method: "mcpServer/elicitation/request", params: {} }), {
    action: "decline",
    content: null,
    _meta: null
  });
  await assert.rejects(Promise.resolve().then(() => handler({ id: 2, method: "item/tool/requestUserInput", params: {} })), (error) => error.rpcCode === -32601);
});

// --- runtime: races, permissions, sessions ------------------------------------

for (const behavior of ["approval-before-turn-response", "approval-with-turn-response"]) {
  test(`a background task gets the approval request when it races the turn/start response (${behavior})`, async () => {
    const { repo, env, statePath } = setupRepo(behavior);
    const jobId = launchBackgroundTask(repo, env, ["--write", "install a dependency"]);

    const pending = await waitForPending(repo, env, jobId);
    assert.equal(pending[0].command, "npm install left-pad");
    const approved = run("node", [SCRIPT, "approve", jobId, pending[0].approvalId, "--decision", "accept"], { cwd: repo, env });
    assert.equal(approved.status, 0, approved.stderr);

    assert.equal(waitForJob(repo, env, jobId).status, "completed");
    assert.deepEqual(readFakeState(statePath).approvalResponses[0].result, { decision: "accept" });
  });
}

test("an accepted permissions request grants exactly what was requested, for the turn only", async () => {
  const { repo, env, statePath } = setupRepo("approval-permissions");
  const jobId = launchBackgroundTask(repo, env, ["fetch a dependency"]);

  const pending = await waitForPending(repo, env, jobId);
  assert.equal(pending[0].kind, "permissions");
  assert.match(pending[0].summary, /network \{"enabled":true\}.*for this turn/);
  run("node", [SCRIPT, "approve", jobId, pending[0].approvalId, "--decision", "accept"], { cwd: repo, env });

  assert.equal(waitForJob(repo, env, jobId).status, "completed");
  const fakeState = readFakeState(statePath);
  assert.deepEqual(fakeState.approvalResponses[0].result, {
    permissions: { network: { enabled: true }, fileSystem: { write: [`${fakeState.threads[0].cwd}/vendor`], read: null } },
    scope: "turn"
  });
});

test("a request Codex resolves on its own is closed, cannot be approved, and the worker exits", async () => {
  const { repo, env, statePath } = setupRepo("approval-resolved");
  const jobId = launchBackgroundTask(repo, env, ["install a dependency"]);

  const pending = await waitForPending(repo, env, jobId);
  const stateFile = path.join(resolveStateDir(repo), "state.json");
  const workerPid = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find((job) => job.id === jobId).pid;

  assert.equal(waitForJob(repo, env, jobId).status, "completed");
  const late = run("node", [SCRIPT, "approve", jobId, pending[0].approvalId, "--decision", "accept"], { cwd: repo, env });
  assert.notEqual(late.status, 0);
  assert.match(late.stderr, /completed; it has no open approvals/);

  await waitFor(() => readFakeState(statePath).lateApprovalResponses?.length === 1);
  assert.deepEqual(readFakeState(statePath).lateApprovalResponses[0].result, { decision: "decline" });
  await waitFor(() => !processAlive(workerPid), { timeoutMs: 5000 });

  const result = run("node", [SCRIPT, "result", jobId], { cwd: repo, env });
  assert.match(result.stdout, /declined: Run npm install left-pad .+ \(closed by Codex\)/);
});

test("approve only decides jobs started from the same Claude session", async () => {
  const { repo, env } = setupRepo("approval-command");
  const sessionEnv = { ...env, CODEX_COMPANION_SESSION_ID: "session-a" };
  const jobId = launchBackgroundTask(repo, sessionEnv, ["install a dependency"]);
  const pending = await waitForPending(repo, sessionEnv, jobId);

  for (const otherEnv of [{ ...env, CODEX_COMPANION_SESSION_ID: "session-b" }]) {
    const refused = run("node", [SCRIPT, "approve", jobId, pending[0].approvalId, "--decision", "accept"], { cwd: repo, env: otherEnv });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /not started from this Claude session/);
  }
  assert.equal((await waitForPending(repo, sessionEnv, jobId)).length, 1, "a refused approve leaves the request pending");

  const own = run("node", [SCRIPT, "approve", jobId, pending[0].approvalId, "--decision", "decline"], { cwd: repo, env: sessionEnv });
  assert.equal(own.status, 0, own.stderr);
  assert.equal(waitForJob(repo, sessionEnv, jobId).status, "completed");
});

test("reviews accept --approvals and list declined requests in their output", () => {
  const { repo, env, statePath } = setupRepo("approval-command");
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const declined = run("node", [SCRIPT, "adversarial-review", "--approvals", "deny"], { cwd: repo, env });
  assert.equal(declined.status, 0, declined.stderr);
  assert.match(declined.stdout, /Approval requests:\n- declined: Run npm install left-pad .+ \(approval mode is deny\)/);
  assert.equal(readFakeState(statePath).lastThreadStart.approvalsReviewer, "user");

  const byDefault = run("node", [SCRIPT, "adversarial-review"], { cwd: repo, env });
  assert.equal(byDefault.status, 0, byDefault.stderr);
  assert.match(byDefault.stdout, /declined: Run npm install left-pad .+ \(reviews cannot ask the user\)/);
  assert.equal("approvalsReviewer" in readFakeState(statePath).lastThreadStart, false);
  assert.deepEqual(readFakeState(statePath).approvalResponses.map((response) => response.result), [
    { decision: "decline" },
    { decision: "decline" }
  ]);

  const autoReview = run("node", [SCRIPT, "review", "--approvals", "auto-review"], { cwd: repo, env });
  assert.equal(autoReview.status, 0, autoReview.stderr);
  assert.equal(readFakeState(statePath).lastThreadStart.approvalsReviewer, "auto_review");
  assert.equal(readFakeState(statePath).lastThreadStart.sandbox, "read-only");

  const invalid = run("node", [SCRIPT, "review", "--approvals", "always"], { cwd: repo, env });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Unsupported approval mode/);
});

test("setup reports protocol compatibility without changing readiness", () => {
  const { repo, env } = setupRepo();
  const setup = run("node", [SCRIPT, "setup", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);
  const report = JSON.parse(setup.stdout);
  assert.equal(report.ready, true);
  assert.equal(report.protocol.status, "unverified");
  assert.match(run("node", [SCRIPT, "setup"], { cwd: repo, env }).stdout, /- app-server protocol: unverified \(/);

  const check = run("node", [SCRIPT, "protocol-check", "--json"], { cwd: repo, env });
  assert.equal(check.status, 1);
  assert.equal(JSON.parse(check.stdout).verified, false);

  const missing = run("node", [SCRIPT, "setup", "--json"], { cwd: repo, env: { ...env, PATH: path.dirname(process.execPath) } });
  assert.deepEqual(JSON.parse(missing.stdout).protocol, { status: "unverified", detail: "Codex CLI is not available" });
});

// --- runtime: the shared broker with raw clients ------------------------------

function connectRaw(endpoint) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: parseBrokerEndpoint(endpoint).path });
    socket.setEncoding("utf8");
    const messages = [];
    const waiters = [];
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const message = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        messages.push(message);
        for (const waiter of [...waiters]) {
          if (waiter.match(message)) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(message);
          }
        }
      }
    });
    socket.on("connect", () =>
      resolve({
        socket,
        send: (message) => socket.write(`${JSON.stringify(message)}\n`),
        next: (match) =>
          new Promise((resolveNext) => {
            const seen = messages.find(match);
            if (seen) {
              messages.splice(messages.indexOf(seen), 1);
              resolveNext(seen);
            } else {
              waiters.push({ match, resolve: resolveNext });
            }
          })
      })
    );
    socket.on("error", reject);
  });
}

test("the broker forwards approvals to the owning client only and declines when it disconnects", async (t) => {
  const { repo, env, statePath } = setupRepo("approval-command");
  const sessionDir = createBrokerSessionDir();
  const endpoint = createBrokerEndpoint(sessionDir);
  const broker = spawn(process.execPath, [BROKER, "serve", "--endpoint", endpoint, "--cwd", repo], { cwd: repo, env, stdio: "ignore" });
  t.after(() => {
    broker.kill();
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });
  assert.ok(await waitForBrokerEndpoint(endpoint, 10000), "broker did not start");

  const owner = await connectRaw(endpoint);
  owner.send({ id: 1, method: "initialize", params: {} });
  await owner.next((message) => message.id === 1);
  owner.send({ id: 2, method: "thread/start", params: { cwd: repo, sandbox: "read-only", ephemeral: true } });
  const thread = await owner.next((message) => message.id === 2);
  owner.send({ id: 3, method: "turn/start", params: { threadId: thread.result.thread.id, input: [{ type: "text", text: "go", text_elements: [] }] } });
  const request = await owner.next((message) => message.method === "item/commandExecution/requestApproval");
  assert.equal(request.id, "srv_1", "the server request id reaches the client unchanged");

  const other = await connectRaw(endpoint);
  other.send({ id: 1, method: "initialize", params: {} });
  await other.next((message) => message.id === 1);
  // Another client cannot answer the owner's request, and cannot start work meanwhile.
  other.send({ id: request.id, result: { decision: "accept" } });
  other.send({ id: 2, method: "thread/list", params: {} });
  const busy = await other.next((message) => message.id === 2);
  assert.equal(busy.error?.code, -32001);
  assert.equal(readFakeState(statePath).approvalResponses, undefined, "a foreign answer must be ignored");

  owner.socket.destroy();
  await waitFor(() => readFakeState(statePath).approvalResponses?.length === 1);
  assert.deepEqual(readFakeState(statePath).approvalResponses[0].result, { decision: "decline" });
  other.socket.destroy();
});

// --- closed and expired requests, approval timeout setting -------------------

test("a closed request says when and how it was closed and how to continue the thread", () => {
  const request = {
    approvalId: "apr-0c",
    jobId: "task-old",
    summary: "Run npm test in /repo",
    requestedAt: "2026-10-10T10:00:00.000Z",
    expiresAt: "2026-10-10T10:15:00.000Z"
  };
  const timedOut = formatClosedApprovalMessage({
    ...request,
    outcome: { decision: "decline", source: "timeout", closedAt: "2026-10-10T10:15:00.400Z" }
  });
  assert.match(timedOut, /already closed \(decline, timeout\)/);
  assert.match(timedOut, /nobody answered it within 15 minutes .*declined at 2026-10-10T10:15:00\.400Z/);
  assert.match(timedOut, /\/codex:rescue --background --resume Retry: Run npm test in \/repo/);

  const resolved = formatClosedApprovalMessage({
    ...request,
    outcome: { decision: "decline", source: "resolved-by-server", closedAt: "2026-10-10T10:01:00.000Z" }
  });
  assert.match(resolved, /Codex closed it itself at 2026-10-10T10:01:00\.000Z \(resolved-by-server\)/);
  assert.match(resolved, /--resume/);

  // The user's own answer needs no retry hint.
  const answered = formatClosedApprovalMessage({
    ...request,
    outcome: { decision: "accept", source: "user", closedAt: "2026-10-10T10:02:00.000Z" }
  });
  assert.match(answered, /already closed \(accept, user\): the user already answered it at 2026-10-10T10:02:00\.000Z: accept/);
  assert.doesNotMatch(answered, /--resume/);

  // A request the job never closed (the worker was killed) ended with the job.
  const ended = describeApprovalClosure(request, { id: "task-old", status: "cancelled", completedAt: "2026-10-10T10:05:00.000Z" });
  assert.equal(ended.source, "job-ended");
  assert.equal(ended.resumable, true);
  assert.equal(describeApprovalClosure(request, { id: "task-old", status: "running" }), null);
});

test("approve on a finished job explains the expired request and suggests --resume", async () => {
  const { repo, env } = setupRepo("approval-command");
  const timedEnv = { ...env, CODEX_COMPANION_APPROVAL_TIMEOUT_MS: "2000" };
  const jobId = launchBackgroundTask(repo, timedEnv, ["install a dependency"]);
  const pending = await waitForPending(repo, timedEnv, jobId);
  assert.equal(waitForJob(repo, timedEnv, jobId).status, "completed");

  const late = run("node", [SCRIPT, "approve", jobId, pending[0].approvalId, "--decision", "accept"], { cwd: repo, env: timedEnv });
  assert.notEqual(late.status, 0);
  assert.match(late.stderr, /completed; it has no open approvals/);
  assert.match(late.stderr, new RegExp(`${pending[0].approvalId} \\(Run npm install left-pad .+\\) is already closed \\(decline, timeout\\)`));
  assert.match(late.stderr, /nobody answered it within 2 seconds .*so it was declined at \d{4}-\d\d-\d\dT/);
  assert.match(late.stderr, /\/codex:rescue --background --resume Retry: Run npm install left-pad/);

  const listed = run("node", [SCRIPT, "approvals", jobId, "--json"], { cwd: repo, env: timedEnv });
  assert.equal(listed.status, 0, listed.stderr);
  const payload = JSON.parse(listed.stdout);
  assert.deepEqual(payload.pending, []);
  assert.equal(payload.job.status, "completed");
  assert.equal(payload.closed[0].approvalId, pending[0].approvalId);
  assert.equal(payload.closed[0].source, "timeout");
  assert.match(payload.resumeHint, /\/codex:rescue --background --resume Retry: Run npm install left-pad/);

  const result = run("node", [SCRIPT, "result", jobId], { cwd: repo, env: timedEnv });
  assert.match(result.stdout, /\(no answer before the timeout\)\nTo continue the Codex thread and retry, run: \/codex:rescue --background --resume/);
});

test("setup --approval-timeout sets the wait in the per-user config; the env variable still wins", async () => {
  assert.equal(normalizeApprovalTimeoutMinutes("40"), 40);
  for (const junk of ["0", "-5", "1.5", "abc", "1441"]) {
    assert.throws(() => normalizeApprovalTimeoutMinutes(junk), /Unsupported approval timeout/);
  }

  const { repo, binDir, env } = setupRepo("approval-command");
  const configFile = path.join(binDir, "codex-companion-config.json");
  const defaults = JSON.parse(run("node", [SCRIPT, "setup", "--json"], { cwd: repo, env }).stdout);
  assert.deepEqual(
    { minutes: defaults.approvalTimeout.minutes, source: defaults.approvalTimeout.source },
    { minutes: 15, source: "default" }
  );

  const rejected = run("node", [SCRIPT, "setup", "--approval-timeout", "0"], { cwd: repo, env });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Unsupported approval timeout "0"/);

  const set = run("node", [SCRIPT, "setup", "--approval-timeout", "1", "--default-approvals", "ask"], { cwd: repo, env });
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout, /approval timeout: 1 minute \(plugin setting from /);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, "utf8")), { defaultApprovals: "ask", approvalTimeoutMinutes: 1 });

  const overridden = JSON.parse(
    run("node", [SCRIPT, "setup", "--json"], { cwd: repo, env: { ...env, CODEX_COMPANION_APPROVAL_TIMEOUT_MS: "120000" } }).stdout
  );
  assert.deepEqual(
    { minutes: overridden.approvalTimeout.minutes, source: overridden.approvalTimeout.source },
    { minutes: 2, source: "env" }
  );

  // A background job waits as long as the setting says.
  const jobId = launchBackgroundTask(repo, env, ["install a dependency"]);
  const pending = await waitForPending(repo, env, jobId);
  assert.equal(Date.parse(pending[0].expiresAt) - Date.parse(pending[0].requestedAt), 60000);
  run("node", [SCRIPT, "approve", jobId, pending[0].approvalId, "--decision", "decline"], { cwd: repo, env });
  assert.equal(waitForJob(repo, env, jobId).status, "completed");

  const unset = run("node", [SCRIPT, "setup", "--approval-timeout", "unset", "--json"], { cwd: repo, env });
  assert.equal(unset.status, 0, unset.stderr);
  assert.equal(JSON.parse(unset.stdout).approvalTimeout.source, "default");
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, "utf8")), { defaultApprovals: "ask" });
});
