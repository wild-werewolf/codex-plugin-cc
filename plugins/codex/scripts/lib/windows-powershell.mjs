import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

// PowerShell 7 for the `codex app-server` the companion starts on Windows.
//
// Codex picks its shell by looking for `pwsh` on PATH, then
// `C:\Program Files\PowerShell\7\pwsh.exe`, then Windows PowerShell 5.1
// (codex-rs/shell-command/src/shell_detect.rs, Codex 0.162). Windows
// PowerShell 5.1 prints startup errors (such as an InitializeDefaultDrives
// failure for an unavailable network drive) in the OEM code page before the
// command body switches its output to UTF-8, so they arrive garbled. When a
// usable PowerShell 7 exists, the companion puts its directory first on PATH
// in the app-server's environment only, so Codex finds it first; nothing else
// (global PATH, profiles, ~/.codex/config.toml) is changed.

/** Full path of pwsh.exe to use instead of searching for one. */
export const PWSH_PATH_ENV = "CODEX_COMPANION_PWSH";
export const PWSH_PROBE_TIMEOUT_MS = 5000;
export const PWSH_MIN_MAJOR_VERSION = 7;

const PWSH_EXE = "pwsh.exe";
// Codex's managed primary runtime, under %USERPROFILE%\.cache like Codex's own
// lookup (core-plugins/src/marketplace_policy.rs); the PowerShell it bundles is
// in dependencies\native\powershell (shell_detect.rs tests, Codex 0.162).
const CODEX_RUNTIME_PWSH = [".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "native", "powershell", PWSH_EXE];

/**
 * @typedef {{ path: string, source: "env" | "path" | "program-files" | "codex-runtime" }} PwshCandidate
 * @typedef {{ status: "found", path: string, directory: string, version: string, source: PwshCandidate["source"] }} PwshFound
 * @typedef {{ status: "not-found", rejected: { path: string, reason: string }[] }} PwshNotFound
 * @typedef {(file: string, options: { env: Record<string, string | undefined>, timeoutMs: number }) => { ok: true, version: string } | { ok: false, reason: string }} PwshProbe
 * @typedef {{ fs?: Pick<typeof fs, "statSync" | "realpathSync" | "openSync" | "readSync" | "closeSync">, pathModule?: typeof path.win32, probe?: PwshProbe, timeoutMs?: number }} PwshDeps
 */

/**
 * Environment variable lookup that ignores case, as Windows does
 * (`{ ...process.env }` keeps names such as `Path` as the OS reports them).
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 */
export function readEnvVar(env, name) {
  if (!env) {
    return undefined;
  }
  if (env[name] !== undefined) {
    return env[name];
  }
  const upper = name.toUpperCase();
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === upper);
  return key === undefined ? undefined : env[key];
}

function unquote(value) {
  const trimmed = value.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1).trim() : trimmed;
}

function samePath(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Store PowerShell (a Microsoft.PowerShell* package under WindowsApps) and its
 * App Execution Alias (WindowsApps\pwsh.exe) cannot be started by the MXC
 * sandbox. The rest of WindowsApps stays allowed: Codex's own runtime packages
 * live there too. Same rule as Codex's is_inaccessible_windows_apps_powershell_path.
 *
 * @param {string} file
 */
export function isStorePowerShellPath(file) {
  const components = String(file).split(/[\\/]/);
  const index = components.findIndex((component) => component.toLowerCase() === "windowsapps");
  if (index === -1 || index + 1 >= components.length) {
    return false;
  }
  const next = components[index + 1].toLowerCase();
  return next === "pwsh.exe" || next === "powershell.exe" || next.startsWith("microsoft.powershell");
}

/**
 * Where to look for pwsh.exe when CODEX_COMPANION_PWSH is not set, in order:
 * PATH (its order kept), the standard install directory, Codex's runtime.
 *
 * @param {Record<string, string | undefined>} env
 * @param {typeof path.win32} [pathModule]
 * @returns {PwshCandidate[]}
 */
export function listPwshCandidates(env, pathModule = path.win32) {
  /** @type {PwshCandidate[]} */
  const candidates = [];
  const add = (dir, source, ...rest) => {
    const directory = unquote(dir ?? "");
    // Relative PATH entries depend on the current directory: not used.
    if (!directory || !pathModule.isAbsolute(directory)) {
      return;
    }
    const file = pathModule.join(directory, ...rest);
    if (!candidates.some((candidate) => samePath(candidate.path, file))) {
      candidates.push({ path: file, source });
    }
  };

  for (const entry of String(readEnvVar(env, "PATH") ?? "").split(pathModule.delimiter)) {
    add(entry, "path", PWSH_EXE);
  }
  // The MSI/winget install directory; ProgramW6432 is the 64-bit one when the
  // companion itself runs as a 32-bit process.
  for (const name of ["ProgramFiles", "ProgramW6432"]) {
    add(readEnvVar(env, name), "program-files", "PowerShell", "7", PWSH_EXE);
  }
  add(readEnvVar(env, "USERPROFILE"), "codex-runtime", ...CODEX_RUNTIME_PWSH);
  return candidates;
}

/**
 * Runs `pwsh.exe -Version` (no profile, no command, no shell) and checks
 * that it is PowerShell 7 or later.
 *
 * @param {string} file
 * @param {{ env?: Record<string, string | undefined>, timeoutMs?: number, spawnSyncImpl?: typeof spawnSync }} [options]
 * @returns {{ ok: true, version: string } | { ok: false, reason: string }}
 */
export function probePwshVersion(file, { env = process.env, timeoutMs = PWSH_PROBE_TIMEOUT_MS, spawnSyncImpl = spawnSync } = {}) {
  const result = spawnSyncImpl(file, ["-Version"], {
    env,
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer: 64 * 1024,
    windowsHide: true
  });
  if (result.error) {
    const code = /** @type {NodeJS.ErrnoException} */ (result.error).code;
    return code === "ETIMEDOUT"
      ? { ok: false, reason: `did not answer -Version within ${timeoutMs} ms` }
      : { ok: false, reason: `could not be started (${result.error.message})` };
  }
  if (result.status !== 0) {
    return { ok: false, reason: `-Version exited with ${result.signal ? `signal ${result.signal}` : `code ${result.status}`}` };
  }
  const match = /^PowerShell\s+v?((\d+)\.\d+[^\s]*)/m.exec(String(result.stdout ?? ""));
  if (!match) {
    return { ok: false, reason: "-Version printed no PowerShell version" };
  }
  if (Number(match[2]) < PWSH_MIN_MAJOR_VERSION) {
    return { ok: false, reason: `is PowerShell ${match[1]}; PowerShell ${PWSH_MIN_MAJOR_VERSION} or later is needed` };
  }
  return { ok: true, version: match[1] };
}

function readsAsWindowsExecutable(fsImpl, file) {
  const fd = fsImpl.openSync(file, "r");
  try {
    const header = Buffer.alloc(2);
    const read = fsImpl.readSync(fd, header, 0, 2, 0);
    return read === 2 && header.toString("latin1") === "MZ";
  } finally {
    fsImpl.closeSync(fd);
  }
}

/**
 * Checks one pwsh.exe candidate: PowerShell 7+ executable that the Windows
 * sandbox can start and that answers `-Version` in time.
 *
 * @param {string} file
 * @param {Record<string, string | undefined>} env
 * @param {PwshDeps} [deps]
 * @returns {{ ok: true, version: string } | { ok: false, reason: string, missing?: boolean }}
 */
export function inspectPwshCandidate(file, env, deps = {}) {
  const fsImpl = deps.fs ?? fs;
  const pathModule = deps.pathModule ?? path.win32;
  const probe = deps.probe ?? probePwshVersion;
  const base = pathModule.basename(file).toLowerCase();
  if (base === "powershell.exe") {
    return { ok: false, reason: "is Windows PowerShell 5.1 (powershell.exe), not PowerShell 7" };
  }
  if (base !== PWSH_EXE) {
    return { ok: false, reason: "is not pwsh.exe (script shims such as pwsh.cmd or pwsh.ps1 are not used)" };
  }
  const storeReason = "is the Microsoft Store PowerShell or its App Execution Alias, which the Windows sandbox cannot start";
  if (isStorePowerShellPath(file)) {
    return { ok: false, reason: storeReason };
  }
  let stat;
  try {
    stat = fsImpl.statSync(file);
  } catch {
    return { ok: false, reason: "does not exist", missing: true };
  }
  if (!stat.isFile()) {
    return { ok: false, reason: "is not a file" };
  }
  try {
    if (isStorePowerShellPath(fsImpl.realpathSync(file))) {
      return { ok: false, reason: storeReason };
    }
  } catch {
    // Not resolvable (for example a reparse point realpath cannot follow):
    // the lexical check above and the probe below still apply.
  }
  try {
    if (!readsAsWindowsExecutable(fsImpl, file)) {
      return { ok: false, reason: "is not a Windows executable (a script or shim named pwsh.exe?)" };
    }
  } catch (error) {
    return { ok: false, reason: `cannot be read (${error instanceof Error ? error.message : String(error)})` };
  }
  if (pathModule.dirname(file).includes(pathModule.delimiter)) {
    return { ok: false, reason: `is in a directory whose name contains "${pathModule.delimiter}", which cannot be put on PATH` };
  }
  return probe(file, { env, timeoutMs: deps.timeoutMs ?? PWSH_PROBE_TIMEOUT_MS });
}

/**
 * The PowerShell 7 to put first on the app-server's PATH, or null off Windows.
 * An explicit CODEX_COMPANION_PWSH that is not usable is an error (no silent
 * fallback); otherwise the first usable candidate wins and "not-found" keeps
 * Codex's own selection.
 *
 * @param {{ platform?: string, env?: Record<string, string | undefined> } & PwshDeps} [options]
 * @returns {PwshFound | PwshNotFound | null}
 */
export function findCompatiblePwsh({ platform = process.platform, env = process.env, ...deps } = {}) {
  if (platform !== "win32") {
    return null;
  }
  const pathModule = deps.pathModule ?? path.win32;
  const raw = readEnvVar(env, PWSH_PATH_ENV);
  if (raw !== undefined && raw.trim() !== "") {
    const file = unquote(raw);
    const result = pathModule.isAbsolute(file)
      ? inspectPwshCandidate(file, env, deps)
      : { ok: false, reason: "is not an absolute path" };
    if ("reason" in result) {
      throw new Error(
        `${PWSH_PATH_ENV}=${JSON.stringify(raw)} ${result.reason}. ` +
          `Set it to the full path of pwsh.exe from PowerShell ${PWSH_MIN_MAJOR_VERSION} or later (not the Microsoft Store version), or unset it.`
      );
    }
    return { status: "found", path: file, directory: pathModule.dirname(file), version: result.version, source: "env" };
  }

  const rejected = [];
  for (const candidate of listPwshCandidates(env, pathModule)) {
    const result = inspectPwshCandidate(candidate.path, env, deps);
    if ("version" in result) {
      return {
        status: "found",
        path: candidate.path,
        directory: pathModule.dirname(candidate.path),
        version: result.version,
        source: candidate.source
      };
    }
    if (!("missing" in result && result.missing)) {
      rejected.push({ path: candidate.path, reason: result.reason });
    }
  }
  return { status: "not-found", rejected };
}

/**
 * A copy of env with directory first on PATH (every case variant of the name
 * that is present, `Path` on Windows if none is). Everything else is kept.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} directory
 * @param {typeof path.win32} [pathModule]
 */
export function prependPathDirectory(env, directory, pathModule = path.win32) {
  const next = { ...env };
  const keys = Object.keys(next).filter((key) => key.toUpperCase() === "PATH");
  if (keys.length === 0) {
    next.Path = directory;
    return next;
  }
  for (const key of keys) {
    const current = next[key] ?? "";
    const first = unquote(current.split(pathModule.delimiter)[0] ?? "");
    if (first && samePath(first, directory)) {
      continue;
    }
    next[key] = current ? `${directory}${pathModule.delimiter}${current}` : directory;
  }
  return next;
}

/**
 * The diagnostic for "no PowerShell 7": Codex keeps its own selection, which
 * can be Windows PowerShell 5.1.
 *
 * @param {PwshNotFound} result
 */
export function formatPwshNotFoundWarning(result) {
  const lines = [
    `Codex Companion: no usable PowerShell ${PWSH_MIN_MAJOR_VERSION} (pwsh.exe) found, so Codex keeps its own shell choice and may run commands in Windows PowerShell 5.1, ` +
      "where messages printed before a command starts (for example InitializeDefaultDrives errors) can appear garbled.",
    `Install PowerShell ${PWSH_MIN_MAJOR_VERSION} with the MSI or winget (the Microsoft Store version cannot run in the Windows sandbox), ` +
      `or set ${PWSH_PATH_ENV} to the full path of pwsh.exe in the environment Claude Code starts in.`
  ];
  for (const entry of result.rejected.slice(0, 3)) {
    lines.push(`  skipped ${entry.path}: ${entry.reason}`);
  }
  return lines.join("\n");
}

const cache = new Map();

/**
 * findCompatiblePwsh with the real filesystem and probe, memoized per process
 * for the inputs that decide it (the companion and the broker each start the
 * app-server at most a few times).
 *
 * @param {{ platform?: string, env?: Record<string, string | undefined> }} [options]
 */
export function resolveCompatiblePwsh({ platform = process.platform, env = process.env } = {}) {
  if (platform !== "win32") {
    return null;
  }
  const key = JSON.stringify(
    [PWSH_PATH_ENV, "PATH", "ProgramFiles", "ProgramW6432", "USERPROFILE"].map((name) => readEnvVar(env, name) ?? null)
  );
  if (!cache.has(key)) {
    try {
      cache.set(key, { value: findCompatiblePwsh({ platform, env }) });
    } catch (error) {
      cache.set(key, { error });
    }
  }
  const entry = cache.get(key);
  if (entry.error) {
    throw entry.error;
  }
  return entry.value;
}

/**
 * For `/codex:setup`: informational, never throws; null off Windows.
 *
 * @param {{ platform?: string, env?: Record<string, string | undefined>, find?: typeof resolveCompatiblePwsh }} [options]
 */
export function describeWindowsPowerShell({ platform = process.platform, env = process.env, find = resolveCompatiblePwsh } = {}) {
  if (platform !== "win32") {
    return null;
  }
  try {
    return find({ platform, env });
  } catch (error) {
    return { status: "invalid", error: error instanceof Error ? error.message : String(error) };
  }
}
