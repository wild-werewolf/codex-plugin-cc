/**
 * Compare the installed Codex app-server protocol with what the companion
 * relies on. The schema comes from `codex app-server generate-json-schema`,
 * so a Codex update that renames a field or adds a server request shows up
 * here instead of as a silently ignored parameter.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { KNOWN_SERVER_REQUEST_METHODS } from "./approvals.mjs";
import { runCommand } from "./process.mjs";

const REQUIRED_PARAMS = [
  { file: "v2/ThreadStartParams.json", method: "thread/start", fields: ["cwd", "model", "sandbox", "approvalsReviewer", "serviceName", "ephemeral"] },
  { file: "v2/ThreadResumeParams.json", method: "thread/resume", fields: ["threadId", "cwd", "model", "sandbox", "approvalsReviewer"] },
  { file: "v2/TurnStartParams.json", method: "turn/start", fields: ["threadId", "input", "model", "effort", "outputSchema", "approvalsReviewer"] }
];

const REQUIRED_ENUMS = [
  { file: "v2/ThreadStartParams.json", definition: "ApprovalsReviewer", values: ["user", "auto_review"] },
  { file: "v2/ThreadStartParams.json", definition: "SandboxMode", values: ["read-only", "workspace-write"] },
  { file: "CommandExecutionRequestApprovalResponse.json", definition: "CommandExecutionApprovalDecision", values: ["accept", "decline"] },
  { file: "FileChangeRequestApprovalResponse.json", definition: "FileChangeApprovalDecision", values: ["accept", "decline"] },
  { file: "PermissionsRequestApprovalResponse.json", definition: "PermissionGrantScope", values: ["turn"] }
];

const APPROVAL_METHODS_REQUIRED = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval"
];

function readSchema(schemaDir, file) {
  const filePath = path.join(schemaDir, ...file.split("/"));
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

// Collect string literals of an enum-like definition (`enum` or `oneOf` of enums).
function collectEnumValues(node) {
  if (!node || typeof node !== "object") {
    return [];
  }
  const values = [];
  if (Array.isArray(node.enum)) {
    values.push(...node.enum.filter((value) => typeof value === "string"));
  }
  for (const key of ["oneOf", "anyOf"]) {
    if (Array.isArray(node[key])) {
      for (const entry of node[key]) {
        values.push(...collectEnumValues(entry));
      }
    }
  }
  return values;
}

function collectServerRequestMethods(schema) {
  return (schema?.oneOf ?? []).flatMap((entry) => entry?.properties?.method?.enum ?? []);
}

/** Pure check over an already generated schema directory. */
export function checkProtocolSchema(schemaDir) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, level: ok ? "ok" : "error", detail });

  for (const spec of REQUIRED_PARAMS) {
    const schema = readSchema(schemaDir, spec.file);
    const properties = Object.keys(schema?.properties ?? {});
    const missing = spec.fields.filter((field) => !properties.includes(field));
    add(
      `${spec.method} params`,
      Boolean(schema) && missing.length === 0,
      !schema ? `${spec.file} not found` : missing.length ? `missing: ${missing.join(", ")}` : "all fields present"
    );
  }

  for (const spec of REQUIRED_ENUMS) {
    const schema = readSchema(schemaDir, spec.file);
    const values = collectEnumValues(schema?.definitions?.[spec.definition]);
    const missing = spec.values.filter((value) => !values.includes(value));
    add(
      spec.definition,
      values.length > 0 && missing.length === 0,
      values.length === 0 ? `${spec.definition} not found in ${spec.file}` : missing.length ? `missing: ${missing.join(", ")}` : values.join(", ")
    );
  }

  const serverRequests = collectServerRequestMethods(readSchema(schemaDir, "ServerRequest.json"));
  const missingApprovals = APPROVAL_METHODS_REQUIRED.filter((method) => !serverRequests.includes(method));
  add(
    "approval server requests",
    serverRequests.length > 0 && missingApprovals.length === 0,
    serverRequests.length === 0 ? "ServerRequest.json not found" : missingApprovals.length ? `missing: ${missingApprovals.join(", ")}` : "present"
  );

  const unknown = serverRequests.filter((method) => !KNOWN_SERVER_REQUEST_METHODS.has(method));
  checks.push({
    name: "unhandled server requests",
    ok: true,
    level: unknown.length ? "warning" : "ok",
    detail: unknown.length ? `${unknown.join(", ")} (answered as unsupported)` : "none"
  });

  return { ok: checks.every((check) => check.ok), checks };
}

// On Windows runCommand goes through a shell (cmd or $SHELL, often bash), which
// joins arguments unquoted and lets bash eat backslashes: pass a quoted
// forward-slash path that both shells read the same way.
function shellSafePath(value) {
  return process.platform === "win32" ? `"${value.replace(/\\/g, "/")}"` : value;
}

/** Generate the schema from the installed Codex and check it. */
export function runProtocolCheck(cwd, options = {}) {
  const version = runCommand("codex", ["--version"], { cwd, env: options.env });
  const schemaDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-protocol-"));
  try {
    const generated = runCommand("codex", ["app-server", "generate-json-schema", "--out", shellSafePath(schemaDir)], {
      cwd,
      env: options.env
    });
    if (generated.error || generated.status !== 0) {
      return {
        ok: false,
        codexVersion: version.stdout.trim() || null,
        checks: [
          {
            name: "generate-json-schema",
            ok: false,
            level: "error",
            detail: (generated.stderr || generated.error?.message || `exit ${generated.status}`).trim()
          }
        ]
      };
    }
    return { codexVersion: version.stdout.trim() || null, ...checkProtocolSchema(schemaDir) };
  } finally {
    fs.rmSync(schemaDir, { recursive: true, force: true });
  }
}

export function renderProtocolCheck(report) {
  const lines = [`# Codex Protocol Check`, "", `Codex: ${report.codexVersion ?? "unknown"}`, `Result: ${report.ok ? "compatible" : "INCOMPATIBLE"}`, ""];
  for (const check of report.checks) {
    lines.push(`- [${check.level}] ${check.name}: ${check.detail}`);
  }
  return `${lines.join("\n")}\n`;
}
