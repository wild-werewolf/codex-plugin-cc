import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;

function nowIso() {
  return new Date().toISOString();
}

// Readers (status, approvals, a worker's progress updates) run concurrently
// with writers, and a half-written state.json reads as an empty state that a
// later save would persist. Write to a temp file and rename it into place.
function writeFileAtomic(filePath, contents) {
  const tempPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tempPath, contents, "utf8");
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(tempPath, filePath);
      return;
    } catch (error) {
      // Windows refuses to replace a file another process has open; retry
      // briefly, then fall back to a plain write.
      if ((error?.code === "EPERM" || error?.code === "EACCES" || error?.code === "EBUSY") && attempt < 10) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        continue;
      }
      fs.rmSync(tempPath, { force: true });
      if (error?.code === "EPERM" || error?.code === "EACCES" || error?.code === "EBUSY") {
        fs.writeFileSync(filePath, contents, "utf8");
        return;
      }
      throw error;
    }
  }
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function saveState(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
    // Approval requests and decisions recorded for the job (see approvals.mjs).
    fs.rmSync(path.join(resolveJobsDir(cwd), `${job.id}.approvals`), { recursive: true, force: true });
  }

  writeFileAtomic(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`);
  return nextState;
}

export function updateState(cwd, mutate) {
  const state = loadState(cwd);
  mutate(state);
  return saveState(cwd, state);
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

// Per-user settings shared by every repository, e.g. the default approval
// mode. They live in a fixed per-user location: CLAUDE_PLUGIN_DATA is named
// after the plugin *and* its marketplace, so it changes when the plugin is
// installed from another marketplace and can be removed with the plugin.
export const USER_CONFIG_FILE_ENV = "CODEX_COMPANION_CONFIG_FILE";
const USER_CONFIG_DIR_NAME = "codex-companion";
const USER_CONFIG_FILE_NAME = "config.json";

/**
 * Where per-user settings are written:
 * `CODEX_COMPANION_CONFIG_FILE`, else `%APPDATA%\codex-companion\config.json`
 * on Windows, else `${XDG_CONFIG_HOME:-~/.config}/codex-companion/config.json`.
 */
export function resolveUserConfigFile(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homedir = options.homedir ?? os.homedir();
  if (env[USER_CONFIG_FILE_ENV]) {
    return platform === "win32" ? path.win32.resolve(env[USER_CONFIG_FILE_ENV]) : path.resolve(env[USER_CONFIG_FILE_ENV]);
  }
  if (platform === "win32") {
    const appData = env.APPDATA || path.win32.join(homedir, "AppData", "Roaming");
    return path.win32.join(appData, USER_CONFIG_DIR_NAME, USER_CONFIG_FILE_NAME);
  }
  // XDG: a relative XDG_CONFIG_HOME is invalid and must be ignored.
  const configHome = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(homedir, ".config");
  return path.join(configHome, USER_CONFIG_DIR_NAME, USER_CONFIG_FILE_NAME);
}

/** Where releases up to 1.0.6-approvals.2 kept the per-user settings. */
export function resolveLegacyUserConfigFiles(env = process.env) {
  const files = [];
  if (env[PLUGIN_DATA_ENV]) {
    files.push(path.join(env[PLUGIN_DATA_ENV], USER_CONFIG_FILE_NAME));
  }
  files.push(path.join(FALLBACK_STATE_ROOT_DIR, USER_CONFIG_FILE_NAME));
  return files;
}

function ownedByAnotherUser(filePath) {
  // The legacy fallback root is in the shared temp dir; ignore a file planted
  // there by another local account.
  if (typeof process.getuid !== "function") {
    return false;
  }
  try {
    return fs.statSync(filePath).uid !== process.getuid();
  } catch {
    return false;
  }
}

function readConfigObject(filePath) {
  if (!fs.existsSync(filePath) || ownedByAnotherUser(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Read the per-user settings. The current file wins as soon as it exists;
 * until then the first legacy file found is used (`legacy: true`).
 */
export function readUserConfig() {
  const file = resolveUserConfigFile();
  const current = readConfigObject(file);
  if (current) {
    return { values: current, file, legacy: false };
  }
  for (const legacyFile of resolveLegacyUserConfigFiles()) {
    const legacy = readConfigObject(legacyFile);
    if (legacy) {
      return { values: legacy, file: legacyFile, legacy: true };
    }
  }
  return { values: {}, file, legacy: false };
}

export function loadUserConfig() {
  return readUserConfig().values;
}

/**
 * Set (or, with `undefined`, remove) one per-user setting, written atomically
 * to the current file. Values still only in a legacy file are carried over on
 * this first write; the legacy file itself is left in place.
 */
export function setUserConfigValue(key, value) {
  const filePath = resolveUserConfigFile();
  const next = { ...readUserConfig().values };
  if (value === undefined) {
    delete next[key];
  } else {
    next[key] = value;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  writeFileAtomic(jobFile, `${JSON.stringify(payload, null, 2)}\n`);
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
