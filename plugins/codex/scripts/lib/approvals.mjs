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

import { readUserConfig, resolveJobsDir } from "./state.mjs";

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

export const DEFAULT_APPROVALS_CONFIG_KEY = "defaultApprovals";
// `setup --approval-timeout <minutes>`: how long a background job waits for
// an answer. CODEX_COMPANION_APPROVAL_TIMEOUT_MS still wins over it.
export const APPROVAL_TIMEOUT_CONFIG_KEY = "approvalTimeoutMinutes";
export const DEFAULT_APPROVAL_TIMEOUT_MINUTES = DEFAULT_APPROVAL_TIMEOUT_MS / 60000;
const MAX_APPROVAL_TIMEOUT_MINUTES = 24 * 60;

/**
 * A timeout in whole minutes, 1 to 1440. `strict` throws on anything else
 * (setup input); otherwise an invalid stored value counts as not set.
 */
export function normalizeApprovalTimeoutMinutes(value, { strict = true } = {}) {
  if (value == null || value === "") {
    return null;
  }
  const text = String(value).trim();
  const minutes = Number(text);
  if (!/^\d+$/.test(text) || minutes < 1 || minutes > MAX_APPROVAL_TIMEOUT_MINUTES) {
    if (strict) {
      throw new Error(`Unsupported approval timeout "${value}". Use whole minutes from 1 to ${MAX_APPROVAL_TIMEOUT_MINUTES}, or unset.`);
    }
    return null;
  }
  return minutes;
}

/**
 * The per-user default approval mode set with `setup --default-approvals`.
 * An unreadable or unknown value counts as not set.
 */
export function readDefaultApprovalMode() {
  return describeDefaultApprovalMode().mode;
}

/** The default mode plus the file it was read from (possibly a legacy one). */
export function describeDefaultApprovalMode() {
  const config = readUserConfig();
  let mode = null;
  try {
    mode = normalizeApprovalMode(config.values[DEFAULT_APPROVALS_CONFIG_KEY]);
  } catch {
    mode = null;
  }
  return { mode, file: config.file, legacy: Boolean(mode) && config.legacy };
}

/**
 * Effective approval mode: an explicit `--approvals` wins, then the plugin
 * default, then nothing (Codex's own `approvals_reviewer` config applies).
 */
export function resolveApprovalMode(explicit) {
  const fromFlag = normalizeApprovalMode(explicit);
  if (fromFlag) {
    return { mode: fromFlag, source: "flag" };
  }
  const fromDefault = describeDefaultApprovalMode();
  if (fromDefault.mode) {
    return { mode: fromDefault.mode, source: "plugin-default", file: fromDefault.file };
  }
  return { mode: null, source: "codex-config" };
}

/**
 * Thread/turn parameters that route approval requests. Without an explicit
 * mode nothing is sent, so the reviewer from the user's Codex config applies.
 * @returns {{ approvalsReviewer?: "user" | "auto_review" }}
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
  const error = /** @type {Error & { rpcCode?: number }} */ (new Error(`Unsupported server request: ${message.method}`));
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

/**
 * Create `filePath` with `payload` only if it does not exist yet, atomically:
 * the file appears complete or not at all. Returns true when this call created
 * it. Used for decisions, so the first decision wins and no later writer
 * (another `approve`, the timeout, a server-side resolve) can replace it.
 */
function createJsonExclusive(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  try {
    fs.linkSync(tempPath, filePath);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") {
      return false;
    }
    // File systems without hard links: fall back to an exclusive create.
    try {
      fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      return true;
    } catch (fallbackError) {
      if (fallbackError?.code === "EEXIST") {
        return false;
      }
      throw fallbackError;
    }
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

// A decision file that exists but is still being written by the fallback path
// reads as null for a moment; retry briefly before giving up.
function readExistingJson(filePath) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const value = readJson(filePath);
    if (value) {
      return value;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  return null;
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
 * Record a user decision. Only a still-pending request of this job can be
 * decided, and a decision is final: the first one wins (it may also be the
 * timeout or Codex closing the request), a repeated identical decision is a
 * no-op, and a second, different decision is rejected.
 */
export function recordApprovalDecision(workspaceRoot, jobId, approvalId, decision, options = {}) {
  if (!APPROVAL_DECISIONS.includes(decision)) {
    throw new Error(`Unsupported decision "${decision}". Use one of: ${APPROVAL_DECISIONS.join(", ")}.`);
  }
  const requestPath = approvalFile(workspaceRoot, jobId, approvalId, "request");
  const request = readJson(requestPath);
  if (!request || request.jobId !== jobId || request.approvalId !== approvalId) {
    throw new Error(`No approval request ${approvalId} for job ${jobId}.`);
  }
  const outcome = readJson(approvalFile(workspaceRoot, jobId, approvalId, "outcome"));
  if (outcome) {
    throw new Error(formatClosedApprovalMessage({ ...request, outcome }));
  }
  const decisionPath = approvalFile(workspaceRoot, jobId, approvalId, "decision");
  const record = {
    approvalId,
    decision,
    decidedAt: new Date().toISOString(),
    decidedBy: options.decidedBy ?? "user"
  };
  if (createJsonExclusive(decisionPath, record)) {
    return record;
  }
  const existing = readExistingJson(decisionPath);
  if (existing?.decision === decision && (existing.decidedBy ?? "user") === record.decidedBy) {
    return existing;
  }
  if (existing && existing.decidedBy && existing.decidedBy !== "user") {
    throw new Error(formatClosedApprovalMessage({ ...request, decision: existing }));
  }
  throw new Error(`Approval ${approvalId} was already decided: ${existing?.decision ?? "unknown"}.`);
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return null;
  }
  if (ms % 60000 === 0) {
    return `${ms / 60000} minute${ms === 60000 ? "" : "s"}`;
  }
  return ms >= 1000 ? `${Math.round(ms / 1000)} seconds` : `${ms} ms`;
}

// Sources that close a request without the user's answer: the thread can be
// continued to retry what Codex wanted to do.
const UNANSWERED_CLOSE_SOURCES = new Set(["timeout", "resolved-by-server", "closed", "job-ended"]);

/**
 * How and when an approval request was closed, from its request, decision
 * and outcome records (as listApprovals returns them). `job` is the job
 * record; a request with neither decision nor outcome counts as closed when
 * the job is no longer running.
 */
export function describeApprovalClosure(entry, job = null) {
  const decision = entry?.outcome?.decision ?? entry?.decision?.decision ?? null;
  let source = entry?.outcome?.source ?? entry?.decision?.decidedBy ?? null;
  const closedAt = entry?.outcome?.closedAt ?? entry?.decision?.decidedAt ?? null;
  if (!source && job && job.status !== "running" && job.status !== "queued") {
    source = "job-ended";
  }
  if (!source) {
    return null;
  }
  const at = closedAt ? ` at ${closedAt}` : "";
  const waitedFor = formatDuration(Date.parse(entry?.expiresAt) - Date.parse(entry?.requestedAt));
  let detail;
  switch (source) {
    case "user":
      detail = `the user already answered it${at}: ${decision}`;
      break;
    case "timeout":
      detail = `nobody answered it ${waitedFor ? `within ${waitedFor}` : "before the timeout"} (asked at ${entry?.requestedAt}, expired at ${entry?.expiresAt}), so it was declined${at}`;
      break;
    case "resolved-by-server":
      detail = `Codex closed it itself${at} (resolved-by-server) before an answer arrived`;
      break;
    case "closed":
      detail = `the connection to Codex closed${at} before an answer, so it was declined`;
      break;
    case "job-ended":
      detail = `job ${entry?.jobId ?? job?.id} ended (${job?.status}${job?.completedAt ? ` at ${job.completedAt}` : ""}) before it was answered`;
      break;
    default:
      detail = `it was closed${at} (${source})`;
  }
  return {
    approvalId: entry?.approvalId ?? null,
    summary: entry?.summary ?? null,
    decision,
    source,
    closedAt,
    requestedAt: entry?.requestedAt ?? null,
    expiresAt: entry?.expiresAt ?? null,
    detail,
    resumable: UNANSWERED_CLOSE_SOURCES.has(source)
  };
}

/**
 * The command that continues the Codex thread to retry a request nobody
 * answered: a background run, so the new request can be asked about.
 */
export function formatApprovalResumeHint(summary) {
  const what = summary ? `Retry: ${summary}` : "<what Codex should retry>";
  return `To continue the Codex thread and retry, run: /codex:rescue --background --resume ${what}`;
}

/** The `approve` error for a request that can no longer be answered. */
export function formatClosedApprovalMessage(entry, job = null) {
  const closure = describeApprovalClosure(entry, job);
  if (!closure) {
    return `Approval ${entry?.approvalId} is not open.`;
  }
  const state =
    closure.source === "job-ended" ? "can no longer be answered" : `is already closed (${closure.decision}, ${closure.source})`;
  const lines = [`Approval ${closure.approvalId}${closure.summary ? ` (${closure.summary})` : ""} ${state}: ${closure.detail}.`];
  if (closure.resumable) {
    lines.push(formatApprovalResumeHint(closure.summary));
  }
  return lines.join("\n");
}

// Explicit option, then CODEX_COMPANION_APPROVAL_TIMEOUT_MS, then the
// `setup --approval-timeout` setting, then 15 minutes.
export function resolveApprovalTimeout(explicit) {
  if (Number.isFinite(explicit) && explicit > 0) {
    return { timeoutMs: explicit, source: "option" };
  }
  const fromEnv = Number(process.env[APPROVAL_TIMEOUT_ENV]);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return { timeoutMs: fromEnv, source: "env" };
  }
  const config = readUserConfig();
  const minutes = normalizeApprovalTimeoutMinutes(config.values[APPROVAL_TIMEOUT_CONFIG_KEY], { strict: false });
  if (minutes) {
    return { timeoutMs: minutes * 60000, source: "plugin-default", file: config.file };
  }
  return { timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS, source: "default" };
}

function resolveTimeoutMs(explicit) {
  return resolveApprovalTimeout(explicit).timeoutMs;
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
 *   still reaches the client is treated like `ask`;
 * - when the connection closes, every request still waiting is declined.
 */
export function createApprovalHandler(options = {}) {
  const mode = options.mode ?? "ask";
  const interactive = Boolean(options.interactive && options.workspaceRoot && options.jobId);
  const nonInteractiveReason = options.nonInteractiveReason ?? "this run cannot ask the user (rerun with --background)";
  const nonInteractiveSource = options.nonInteractiveSource ?? "non-interactive";
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
    writeJsonAtomic(approvalFile(options.workspaceRoot, options.jobId, approvalId, "outcome"), {
      approvalId,
      decision,
      source,
      closedAt: new Date().toISOString()
    });
  }

  // The decision file is the single source of truth: whoever creates it first
  // (the user via `approve`, or this worker on timeout/close) decides.
  function settle(decisionPath, approvalId, fallback) {
    createJsonExclusive(decisionPath, {
      approvalId,
      decision: fallback.decision,
      decidedAt: new Date().toISOString(),
      decidedBy: fallback.source
    });
    const recorded = readExistingJson(decisionPath);
    if (recorded && APPROVAL_DECISIONS.includes(recorded.decision)) {
      return { decision: recorded.decision, source: recorded.decidedBy ?? "user" };
    }
    return fallback;
  }

  function waitForDecision(approvalId, key) {
    const decisionPath = approvalFile(options.workspaceRoot, options.jobId, approvalId, "decision");
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        const recorded = readJson(decisionPath);
        if (recorded && APPROVAL_DECISIONS.includes(recorded.decision)) {
          finish({ decision: recorded.decision, source: recorded.decidedBy ?? "user" });
        } else if (Date.now() >= deadline) {
          finish(settle(decisionPath, approvalId, { decision: "decline", source: "timeout" }));
        }
      }, DECISION_POLL_INTERVAL_MS);
      function finish(result) {
        clearInterval(timer);
        waiting.delete(key);
        resolve(result);
      }
      // Codex closed the request, or the connection is gone: no answer can
      // reach Codex any more. Claim the decision so a late `approve` is
      // rejected, and record the request as declined.
      waiting.set(key, (source) => {
        settle(decisionPath, approvalId, { decision: "decline", source });
        finish({ decision: "decline", source });
      });
    });
  }

  async function handle(message) {
    if (!APPROVAL_REQUEST_METHODS.has(message.method)) {
      return failClosedServerRequestResult(message);
    }

    const description = describeApprovalRequest(message.method, message.params);
    if (mode === "deny" || !interactive || handle.closed) {
      const why = mode === "deny" ? "approval mode is deny" : handle.closed ? "the run is finishing" : nonInteractiveReason;
      const source = mode === "deny" ? "deny-mode" : handle.closed ? "closed" : nonInteractiveSource;
      report(`Declined approval request: ${description.summary} (${why}).`);
      decisions.push({ method: message.method, ...description, decision: "decline", source });
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
    const pending = waitForDecision(approvalId, key);
    report(`Waiting for approval ${approvalId}: ${description.summary}. Run /codex:approve ${options.jobId}.`, AWAITING_APPROVAL_PHASE);

    const { decision, source } = await pending;
    closeApproval(approvalId, decision, source);
    decisions.push({ method: message.method, approvalId, ...description, decision, source });
    // Stay in awaiting-approval while other requests of this run still wait.
    report(`Approval ${approvalId} ${decision === "accept" ? "accepted" : "declined"} (${source}).`, waiting.size === 0 ? "running" : null);
    return buildApprovalResponse(message.method, message.params, decision, `Declined (${source}).`);
  }

  handle.onResolved = (params) => {
    waiting.get(requestKey(params?.requestId))?.("resolved-by-server");
  };
  // Called when the app-server connection ends: nobody can answer any more.
  handle.onClosed = () => {
    handle.closed = true;
    for (const cancel of [...waiting.values()]) {
      cancel("closed");
    }
  };
  handle.closed = false;
  handle.pendingCount = () => waiting.size;
  handle.decisions = decisions;
  handle.mode = mode;
  return handle;
}

/**
 * Wrap a progress reporter so turn events cannot move the job out of
 * `awaiting-approval` while a request of `handler` is still waiting.
 */
export function holdAwaitingApprovalPhase(onProgress, handler) {
  if (!onProgress) {
    return onProgress;
  }
  return (event) => {
    if (handler.pendingCount?.() > 0 && event && typeof event === "object" && event.phase && event.phase !== AWAITING_APPROVAL_PHASE) {
      onProgress({ ...event, phase: AWAITING_APPROVAL_PHASE });
      return;
    }
    onProgress(event);
  };
}
