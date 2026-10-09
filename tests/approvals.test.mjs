import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  buildApprovalResponse,
  buildApprovalRoutingParams,
  failClosedServerRequestResult,
  normalizeApprovalMode
} from "../plugins/codex/scripts/lib/approvals.mjs";
import {
  assertThreadPermissions,
  buildResumeParams,
  buildThreadParams,
  buildTurnStartParams
} from "../plugins/codex/scripts/lib/codex.mjs";
import { loadBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { checkProtocolSchema } from "../plugins/codex/scripts/lib/protocol-check.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

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
  return { repo, binDir, env: buildEnv(binDir), statePath: path.join(binDir, "fake-codex-state.json") };
}

function readFakeState(statePath) {
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
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
  writeSchema(dir, "PermissionsRequestApprovalResponse.json", { definitions: { PermissionGrantScope: { enum: ["turn", "session"] } } });
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
});

test("the approve command asks the user about each request and defaults to decline", () => {
  const source = fs.readFileSync(path.join(ROOT, "plugins", "codex", "commands", "approve.md"), "utf8");
  assert.match(source, /disable-model-invocation: true/);
  assert.match(source, /allowed-tools: Bash\(node:\*\), AskUserQuestion/);
  assert.match(source, /Decline \(Recommended\)/);
  assert.match(source, /Approve once/);
  assert.doesNotMatch(source, /acceptForSession|--decision accept\b(?!\|)/);
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
