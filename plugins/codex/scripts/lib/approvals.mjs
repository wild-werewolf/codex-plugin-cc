/**
 * Approval handling for app-server server requests.
 *
 * Codex asks the client to approve sandbox escapes, file writes outside the
 * sandbox, and extra permissions. The companion never approves these on its
 * own: a request is either decided by the user (through `approve`), routed to
 * Codex's own `auto_review` reviewer, or declined (fail-closed).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveJobsDir } from "./state.mjs";

export const APPROVAL_MODES = ["ask", "auto-review", "deny"];
export const APPROVAL_DECISIONS = ["accept", "decline"];
export const AWAITING_APPROVAL_PHASE = "awaiting-approval";
export const APPROVAL_TIMEOUT_ENV = "CODEX_COMPANION_APPROVAL_TIMEOUT_MS";
const DEFAULT_APPROVAL_TIMEOUT_MS = 15 * 60 * 1000;
const DECISION_POLL_INTERVAL_MS = 500;

export const APPROVAL_REQUEST_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "execCommandApproval",
  "applyPatchApproval"
]);

// Every server request method this client answers deliberately. Anything else
// gets a JSON-RPC "unsupported" error; `protocol-check` reports new methods.
export const KNOWN_SERVER_REQUEST_METHODS = new Set([
  ...APPROVAL_REQUEST_METHODS,
  "mcpServer/elicitation/request",
  "item/tool/requestUserInput",
  "item/tool/call",
  "account/chatgptAuthTokens/refresh",
  "attestation/generate"
]);

export function normalizeApprovalMode(value) {
  if (value == null || value === "") {
    return null;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!APPROVAL_MODES.includes(normalized)) {
    throw new Error(`Unsupported approval mode "${value}". Use one of: ${APPROVAL_MODES.join(", ")}.`);
  }
  return normalized;
}

/**
 * Thread/turn parameters that route approval requests. Without an explicit
 * mode nothing is sent, so the reviewer from the user's Codex config applies.
 */
export function buildApprovalRoutingParams(mode) {
  if (mode === "auto-review") {
    return { approvalsReviewer: "auto_review" };
  }
  if (mode === "ask" || mode === "deny") {
    return { approvalsReviewer: "user" };
  }
  return {};
}

function unsupportedServerRequest(message) {
  const error = new Error(`Unsupported server request: ${message.method}`);
  error.rpcCode = -32601;
  return error;
}

function requestedPermissions(params) {
  const granted = {};
  if (params?.permissions?.network) {
    granted.network = params.permissions.network;
  }
  if (params?.permissions?.fileSystem) {
    granted.fileSystem = params.permissions.fileSystem;
  }
  return granted;
}

/**
 * Translate a one-shot decision into the response shape of the request
 * method. Session-wide grants (`acceptForSession`, execpolicy amendments,
 * `scope: "session"`) are never produced.
 */
export function buildApprovalResponse(method, params, decision, reason = null) {
  const accepted = decision === "accept";
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: accepted ? "accept" : "decline" };
    case "item/permissions/requestApproval":
      return { permissions: accepted ? requestedPermissions(params) : {}, scope: "turn" };
    case "execCommandApproval":
    case "applyPatchApproval":
      return accepted
        ? { decision: "approved" }
        : { decision: { denied: { rejection: reason ?? "Declined by the Codex companion." } } };
    default:
      throw unsupportedServerRequest({ method });
  }
}

/** Fail-closed answer used when nobody can decide: decline, never error out silently. */
export function failClosedServerRequestResult(message, reason = null) {
  if (APPROVAL_REQUEST_METHODS.has(message.method)) {
    return buildApprovalResponse(message.method, message.params, "decline", reason);
  }
  if (message.method === "mcpServer/elicitation/request") {
    return { action: "decline", content: null, _meta: null };
  }
  throw unsupportedServerRequest(message);
}

function formatPermissions(permissions) {
  const parts = [];
  if (permissions?.network) {
    parts.push(`network ${JSON.stringify(permissions.network)}`);
  }
  if (permissions?.fileSystem) {
    parts.push(`file system ${JSON.stringify(permissions.fileSystem)}`);
  }
  return parts.join("; ") || "unspecified permissions";
}

export function describeApprovalRequest(method, params = {}) {
  switch (method) {
    case "item/commandExecution/requestApproval": {
      const command = params.command ?? (params.kind === "writeStdin" ? "input to a running command" : "a command");
      return {
        kind: params.kind === "writeStdin" ? "stdin" : "command",
        summary: `Run ${command}${params.cwd ? ` in ${params.cwd}` : ""}`,
        command: params.command ?? null,
        cwd: params.cwd ?? null,
        reason: params.reason ?? null
      };
    }
    case "item/fileChange/requestApproval":
      return {
        kind: "file-change",
        summary: params.grantRoot ? `Write files under ${params.grantRoot}` : "Apply file changes",
        grantRoot: params.grantRoot ?? null,
        reason: params.reason ?? null
      };
    case "item/permissions/requestApproval":
      return {
        kind: "permissions",
        summary: `Grant ${formatPermissions(params.permissions)} for this turn`,
        cwd: params.cwd ?? null,
        reason: params.reason ?? null
      };
    case "execCommandApproval":
      return {
        kind: "command",
        summary: `Run ${Array.isArray(params.command) ? params.command.join(" ") : "a command"}`,
        command: Array.isArray(params.command) ? params.command.join(" ") : null,
        cwd: params.cwd ?? null,
        reason: params.reason ?? null
      };
    case "applyPatchApproval":
      return {
        kind: "file-change",
        summary: `Apply changes to ${Object.keys(params.fileChanges ?? {}).length} file(s)`,
        files: Object.keys(params.fileChanges ?? {}),
        grantRoot: params.grantRoot ?? null,
        reason: params.reason ?? null
      };
    default:
      return { kind: "unknown", summary: method, reason: null };
  }
}

export function resolveApprovalsDir(workspaceRoot, jobId) {
  return path.join(resolveJobsDir(workspaceRoot), `${jobId}.approvals`);
}

function approvalFile(workspaceRoot, jobId, approvalId, suffix) {
  if (!/^apr-[a-f0-9]+$/.test(approvalId)) {
    throw new Error(`Invalid approval id "${approvalId}".`);
  }
  return path.join(resolveApprovalsDir(workspaceRoot, jobId), `${approvalId}.${suffix}.json`);
}

function writeJsonAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function listApprovals(workspaceRoot, jobId) {
  const dir = resolveApprovalsDir(workspaceRoot, jobId);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".request.json"))
    .map((name) => {
      const request = readJson(path.join(dir, name));
      if (!request) {
        return null;
      }
      const decision = readJson(path.join(dir, name.replace(".request.json", ".decision.json")));
      const outcome = readJson(path.join(dir, name.replace(".request.json", ".outcome.json")));
      return { ...request, decision, outcome };
    })
    .filter(Boolean)
    .sort((left, right) => String(left.requestedAt).localeCompare(String(right.requestedAt)));
}

export function listPendingApprovals(workspaceRoot, jobId) {
  return listApprovals(workspaceRoot, jobId).filter((entry) => !entry.decision && !entry.outcome);
}

/**
 * Record a user decision. Only a still-pending request can be decided, and a
 * decision is final: a second, different decision is rejected.
 */
export function recordApprovalDecision(workspaceRoot, jobId, approvalId, decision, options = {}) {
  if (!APPROVAL_DECISIONS.includes(decision)) {
    throw new Error(`Unsupported decision "${decision}". Use one of: ${APPROVAL_DECISIONS.join(", ")}.`);
  }
  const requestPath = approvalFile(workspaceRoot, jobId, approvalId, "request");
  const request = readJson(requestPath);
  if (!request) {
    throw new Error(`No approval request ${approvalId} for job ${jobId}.`);
  }
  const outcome = readJson(approvalFile(workspaceRoot, jobId, approvalId, "outcome"));
  if (outcome) {
    throw new Error(`Approval ${approvalId} is already closed (${outcome.decision}, ${outcome.source}).`);
  }
  const decisionPath = approvalFile(workspaceRoot, jobId, approvalId, "decision");
  const existing = readJson(decisionPath);
  if (existing) {
    if (existing.decision === decision) {
      return existing;
    }
    throw new Error(`Approval ${approvalId} was already decided: ${existing.decision}.`);
  }
  const record = {
    approvalId,
    decision,
    decidedAt: new Date().toISOString(),
    decidedBy: options.decidedBy ?? "user"
  };
  writeJsonAtomic(decisionPath, record);
  return record;
}

function resolveTimeoutMs(explicit) {
  const fromEnv = Number(process.env[APPROVAL_TIMEOUT_ENV]);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_APPROVAL_TIMEOUT_MS;
}

function requestKey(id) {
  return JSON.stringify(id);
}

/**
 * Build the server request handler used by a companion run.
 *
 * - approval requests in `ask` mode with a background job wait for a user
 *   decision recorded via `approve`; the wait is bounded and ends in decline;
 * - without an interactive channel (foreground runs, reviews) or in `deny`
 *   mode they are declined immediately;
 * - `auto-review` normally keeps requests on the Codex side; any request that
 *   still reaches the client is treated like `ask`.
 */
export function createApprovalHandler(options = {}) {
  const mode = options.mode ?? "ask";
  const interactive = Boolean(options.interactive && options.workspaceRoot && options.jobId);
  const timeoutMs = resolveTimeoutMs(options.timeoutMs);
  const onProgress = options.onProgress ?? null;
  const decisions = [];
  const waiting = new Map();

  function report(message, phase = null) {
    if (onProgress && message) {
      onProgress(phase ? { message, phase } : message);
    }
  }

  function closeApproval(approvalId, decision, source) {
    if (!interactive) {
      return;
    }
    writeJsonAtomic(approvalFile(options.workspaceRoot, options.jobId, approvalId, "outcome"), {
      approvalId,
      decision,
      source,
      closedAt: new Date().toISOString()
    });
  }

  async function waitForDecision(approvalId, key) {
    const decisionPath = approvalFile(options.workspaceRoot, options.jobId, approvalId, "decision");
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        const recorded = readJson(decisionPath);
        if (recorded && APPROVAL_DECISIONS.includes(recorded.decision)) {
          finish({ decision: recorded.decision, source: recorded.decidedBy ?? "user" });
        } else if (Date.now() >= deadline) {
          finish({ decision: "decline", source: "timeout" });
        }
      }, DECISION_POLL_INTERVAL_MS);
      function finish(result) {
        clearInterval(timer);
        waiting.delete(key);
        resolve(result);
      }
      waiting.set(key, () => finish({ decision: "decline", source: "resolved-by-server" }));
    });
  }

  async function handle(message) {
    if (!APPROVAL_REQUEST_METHODS.has(message.method)) {
      return failClosedServerRequestResult(message);
    }

    const description = describeApprovalRequest(message.method, message.params);
    if (mode === "deny" || !interactive) {
      const why = mode === "deny" ? "approval mode is deny" : "this run cannot ask the user (rerun with --background)";
      report(`Declined approval request: ${description.summary} (${why}).`);
      decisions.push({ method: message.method, ...description, decision: "decline", source: mode === "deny" ? "deny-mode" : "non-interactive" });
      return buildApprovalResponse(message.method, message.params, "decline", `Declined: ${why}.`);
    }

    const approvalId = `apr-${crypto.randomBytes(4).toString("hex")}`;
    const key = requestKey(message.id);
    writeJsonAtomic(approvalFile(options.workspaceRoot, options.jobId, approvalId, "request"), {
      approvalId,
      jobId: options.jobId,
      requestId: message.id,
      method: message.method,
      threadId: message.params?.threadId ?? null,
      turnId: message.params?.turnId ?? null,
      itemId: message.params?.itemId ?? null,
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
      ...description
    });
    report(`Waiting for approval ${approvalId}: ${description.summary}. Run /codex:approve ${options.jobId}.`, AWAITING_APPROVAL_PHASE);

    const { decision, source } = await waitForDecision(approvalId, key);
    closeApproval(approvalId, decision, source);
    decisions.push({ method: message.method, approvalId, ...description, decision, source });
    report(`Approval ${approvalId} ${decision === "accept" ? "accepted" : "declined"} (${source}).`, "running");
    return buildApprovalResponse(message.method, message.params, decision, `Declined (${source}).`);
  }

  handle.onResolved = (params) => {
    const resolve = waiting.get(requestKey(params?.requestId));
    resolve?.();
  };
  handle.decisions = decisions;
  handle.mode = mode;
  return handle;
}
