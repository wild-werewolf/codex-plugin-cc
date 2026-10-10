import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir, writeExecutable } from "./helpers.mjs";
import { CodexAppServerClient, buildAppServerSpawnEnv } from "../plugins/codex/scripts/lib/app-server.mjs";
import {
  PWSH_PATH_ENV,
  describeWindowsPowerShell,
  findCompatiblePwsh,
  formatPwshNotFoundWarning,
  isStorePowerShellPath,
  listPwshCandidates,
  prependPathDirectory,
  probePwshVersion,
  readEnvVar
} from "../plugins/codex/scripts/lib/windows-powershell.mjs";
import { renderSetupReport } from "../plugins/codex/scripts/lib/render.mjs";

// These tests exercise the selection rules with Windows-shaped paths, an
// in-memory filesystem and stub probes, or with small Node scripts standing in
// for pwsh. None of them is a check on real Windows or the MXC sandbox.

const MZ = Buffer.from("MZ\x90\x00", "latin1");
const SCRIPT = Buffer.from("@echo off\r\npwsh %*\r\n", "latin1");

/**
 * In-memory filesystem with Windows (case-insensitive) path semantics.
 * files: { [path]: Buffer | { content?: Buffer, realpath?: string, dir?: true } }
 */
function memoryFs(files) {
  const entries = new Map();
  for (const [file, value] of Object.entries(files)) {
    entries.set(file.toLowerCase(), Buffer.isBuffer(value) ? { content: value } : value);
  }
  const lookup = (file) => {
    const entry = entries.get(String(file).toLowerCase());
    if (!entry) {
      throw Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" });
    }
    return entry;
  };
  const fds = new Map();
  return {
    statSync: (file) => {
      const entry = lookup(file);
      return { isFile: () => !entry.dir };
    },
    realpathSync: (file) => lookup(file).realpath ?? file,
    openSync: (file) => {
      const fd = fds.size + 100;
      fds.set(fd, lookup(file).content ?? Buffer.alloc(0));
      return fd;
    },
    readSync: (fd, buffer, offset, length, position) => fds.get(fd).copy(buffer, offset, position, position + length),
    closeSync: (fd) => {
      fds.delete(fd);
    }
  };
}

/** A probe answering from a table: version string, "timeout", or a reason. */
function tableProbe(table, calls = []) {
  return (file, { timeoutMs }) => {
    calls.push(file);
    const answer = table[file.toLowerCase()] ?? table[file];
    if (answer === "timeout") {
      return { ok: false, reason: `did not answer -Version within ${timeoutMs} ms` };
    }
    if (typeof answer === "string" && /^\d/.test(answer)) {
      return Number(answer.split(".")[0]) >= 7
        ? { ok: true, version: answer }
        : { ok: false, reason: `is PowerShell ${answer}; PowerShell 7 or later is needed` };
    }
    return { ok: false, reason: answer ?? "could not be started" };
  };
}

const PF = "C:\\Program Files";
const PF_PWSH = `${PF}\\PowerShell\\7\\pwsh.exe`;
const PROFILE = "C:\\Users\\Пользователь Тест";
const RUNTIME_PWSH = `${PROFILE}\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\native\\powershell\\pwsh.exe`;
const ALIAS_DIR = `${PROFILE}\\AppData\\Local\\Microsoft\\WindowsApps`;
const STORE_PWSH = "C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.5.4.0_x64__8wekyb3d8bbwe\\pwsh.exe";
const PORTABLE_DIR = "D:\\Инструменты ё — тест\\PowerShell 7";
const PORTABLE_PWSH = `${PORTABLE_DIR}\\pwsh.exe`;

test("readEnvVar ignores the case of the variable name, as Windows does", () => {
  assert.equal(readEnvVar({ Path: "a" }, "PATH"), "a");
  assert.equal(readEnvVar({ PATH: "b", Path: "a" }, "PATH"), "b");
  assert.equal(readEnvVar({ programfiles: "x" }, "ProgramFiles"), "x");
  assert.equal(readEnvVar({}, "PATH"), undefined);
});

test("isStorePowerShellPath rejects Store PowerShell and aliases but not the rest of WindowsApps", () => {
  for (const file of [
    STORE_PWSH,
    "C:\\Program Files\\WindowsApps\\Microsoft.PowerShellPreview_8wekyb3d8bbwe\\pwsh.exe",
    `${ALIAS_DIR}\\pwsh.exe`,
    `${ALIAS_DIR}\\powershell.exe`,
    `${ALIAS_DIR}\\Microsoft.PowerShell_8wekyb3d8bbwe\\pwsh.exe`,
    "C:\\PROGRAM FILES\\WINDOWSAPPS\\MICROSOFT.POWERSHELL\\PWSH.EXE"
  ]) {
    assert.equal(isStorePowerShellPath(file), true, file);
  }
  for (const file of [
    PF_PWSH,
    "C:\\Program Files\\WindowsApps\\OpenAI.CodexPrimaryRuntime_1.0.0.0_x64__abc\\dependencies\\native\\powershell\\pwsh.exe",
    RUNTIME_PWSH,
    "C:\\portable\\NotWindowsApps\\pwsh.exe",
    PORTABLE_PWSH
  ]) {
    assert.equal(isStorePowerShellPath(file), false, file);
  }
});

test("listPwshCandidates keeps PATH order, then the install directory, then the Codex runtime", () => {
  const env = {
    Path: [
      "C:\\first",
      "",
      ".\\relative",
      `"${PORTABLE_DIR}"`,
      "c:\\FIRST",
      `${PF}\\PowerShell\\7`,
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0"
    ].join(";"),
    ProgramFiles: PF,
    ProgramW6432: PF,
    USERPROFILE: PROFILE
  };
  assert.deepEqual(listPwshCandidates(env), [
    { path: "C:\\first\\pwsh.exe", source: "path" },
    { path: PORTABLE_PWSH, source: "path" },
    { path: PF_PWSH, source: "path" },
    { path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\pwsh.exe", source: "path" },
    { path: RUNTIME_PWSH, source: "codex-runtime" }
  ]);
  // Nothing outside the variables the OS provides.
  assert.deepEqual(listPwshCandidates({}), []);
});

test("findCompatiblePwsh does nothing outside Windows, whatever the environment says", () => {
  for (const platform of ["linux", "darwin"]) {
    assert.equal(findCompatiblePwsh({ platform, env: { [PWSH_PATH_ENV]: "not a path", PATH: "/usr/bin" } }), null);
    assert.equal(describeWindowsPowerShell({ platform, env: {} }), null);
  }
});

test("findCompatiblePwsh skips aliases, Store packages, shims, old versions and timeouts and keeps PATH order", () => {
  const scriptDir = "C:\\tools\\script";
  const oldDir = "C:\\tools\\pwsh6";
  const slowDir = "C:\\tools\\slow";
  const linkDir = "C:\\tools\\link";
  const env = {
    Path: [ALIAS_DIR, "C:\\missing", scriptDir, linkDir, oldDir, slowDir, PORTABLE_DIR, `${PF}\\PowerShell\\7`].join(";"),
    ProgramFiles: PF,
    USERPROFILE: PROFILE
  };
  const files = memoryFs({
    [`${ALIAS_DIR}\\pwsh.exe`]: MZ,
    [`${scriptDir}\\pwsh.exe`]: SCRIPT,
    [`${linkDir}\\pwsh.exe`]: { content: MZ, realpath: STORE_PWSH },
    [`${oldDir}\\pwsh.exe`]: MZ,
    [`${slowDir}\\pwsh.exe`]: MZ,
    [PORTABLE_PWSH]: MZ,
    [PF_PWSH]: MZ
  });
  const calls = [];
  const probe = tableProbe(
    { [`${oldDir}\\pwsh.exe`]: "6.2.7", [`${slowDir}\\pwsh.exe`]: "timeout", [PORTABLE_PWSH]: "7.5.4", [PF_PWSH]: "7.4.6" },
    calls
  );

  const result = findCompatiblePwsh({ platform: "win32", env, fs: files, probe, timeoutMs: 1234 });
  assert.equal(result.status, "found");
  assert.equal(result.path, PORTABLE_PWSH);
  assert.equal(result.directory, PORTABLE_DIR);
  assert.equal(result.version, "7.5.4");
  assert.equal(result.source, "path");
  // The alias and the Store target are never started; the first good one ends the search.
  assert.deepEqual(calls, [`${oldDir}\\pwsh.exe`, `${slowDir}\\pwsh.exe`, PORTABLE_PWSH]);
});

test("findCompatiblePwsh falls back to the install directory, then the Codex runtime", () => {
  const env = { Path: `${ALIAS_DIR};C:\\Windows\\System32`, ProgramFiles: PF, USERPROFILE: PROFILE };

  const fromProgramFiles = findCompatiblePwsh({
    platform: "win32",
    env,
    fs: memoryFs({ [`${ALIAS_DIR}\\pwsh.exe`]: MZ, [PF_PWSH]: MZ, [RUNTIME_PWSH]: MZ }),
    probe: tableProbe({ [PF_PWSH]: "7.4.6", [RUNTIME_PWSH]: "7.5.0" })
  });
  assert.deepEqual(
    { path: fromProgramFiles.path, source: fromProgramFiles.source },
    { path: PF_PWSH, source: "program-files" }
  );

  const fromRuntime = findCompatiblePwsh({
    platform: "win32",
    env,
    fs: memoryFs({ [`${ALIAS_DIR}\\pwsh.exe`]: MZ, [RUNTIME_PWSH]: MZ }),
    probe: tableProbe({ [RUNTIME_PWSH]: "7.5.0" })
  });
  assert.deepEqual(
    { path: fromRuntime.path, directory: fromRuntime.directory, source: fromRuntime.source },
    { path: RUNTIME_PWSH, directory: path.win32.dirname(RUNTIME_PWSH), source: "codex-runtime" }
  );
});

test("findCompatiblePwsh reports not-found with the skipped candidates (missing files are not listed)", () => {
  const env = { Path: `${ALIAS_DIR};C:\\tools\\pwsh6;C:\\missing`, ProgramFiles: PF, USERPROFILE: PROFILE };
  const result = findCompatiblePwsh({
    platform: "win32",
    env,
    fs: memoryFs({ [`${ALIAS_DIR}\\pwsh.exe`]: MZ, "C:\\tools\\pwsh6\\pwsh.exe": MZ }),
    probe: tableProbe({ "C:\\tools\\pwsh6\\pwsh.exe": "6.2.7" })
  });
  assert.equal(result.status, "not-found");
  assert.deepEqual(
    result.rejected.map((entry) => entry.path),
    [`${ALIAS_DIR}\\pwsh.exe`, "C:\\tools\\pwsh6\\pwsh.exe"]
  );
  assert.match(result.rejected[0].reason, /Microsoft Store PowerShell or its App Execution Alias/);
  assert.match(result.rejected[1].reason, /PowerShell 6\.2\.7; PowerShell 7 or later is needed/);

  const warning = formatPwshNotFoundWarning(result);
  assert.match(warning, /no usable PowerShell 7/);
  assert.match(warning, /may run commands in Windows PowerShell 5\.1/);
  assert.match(warning, /CODEX_COMPANION_PWSH/);
  assert.doesNotMatch(warning, /fixed|resolved/i);
});

test("an explicit CODEX_COMPANION_PWSH wins over PATH, and paths with spaces, Cyrillic and quotes work", () => {
  const env = {
    [PWSH_PATH_ENV]: ` "${PORTABLE_PWSH}" `,
    Path: `${PF}\\PowerShell\\7`,
    ProgramFiles: PF
  };
  const calls = [];
  const result = findCompatiblePwsh({
    platform: "win32",
    env,
    fs: memoryFs({ [PORTABLE_PWSH]: MZ, [PF_PWSH]: MZ }),
    probe: tableProbe({ [PORTABLE_PWSH]: "7.5.4", [PF_PWSH]: "7.4.6" }, calls)
  });
  assert.deepEqual(result, { status: "found", path: PORTABLE_PWSH, directory: PORTABLE_DIR, version: "7.5.4", source: "env" });
  assert.deepEqual(calls, [PORTABLE_PWSH]);
});

test("an unusable explicit CODEX_COMPANION_PWSH is an error, never a silent fallback", () => {
  const files = memoryFs({
    [PF_PWSH]: MZ,
    "C:\\tools\\pwsh.cmd": SCRIPT,
    "C:\\tools\\script\\pwsh.exe": SCRIPT,
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe": MZ,
    "C:\\tools\\pwsh6\\pwsh.exe": MZ,
    "C:\\tools\\slow\\pwsh.exe": MZ,
    "C:\\tools\\dir.exe\\pwsh.exe": { dir: true }
  });
  const probe = tableProbe({ [PF_PWSH]: "7.4.6", "C:\\tools\\pwsh6\\pwsh.exe": "6.2.7", "C:\\tools\\slow\\pwsh.exe": "timeout" });
  const cases = [
    ["pwsh.exe", /is not an absolute path/],
    ["C:\\nowhere\\pwsh.exe", /does not exist/],
    ["C:\\tools\\pwsh.cmd", /is not pwsh\.exe/],
    ["C:\\tools\\script\\pwsh.exe", /is not a Windows executable/],
    ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", /Windows PowerShell 5\.1/],
    [STORE_PWSH, /Microsoft Store PowerShell/],
    ["C:\\tools\\pwsh6\\pwsh.exe", /PowerShell 6\.2\.7/],
    ["C:\\tools\\slow\\pwsh.exe", /did not answer -Version within/],
    ["C:\\tools\\dir.exe\\pwsh.exe", /is not a file/]
  ];
  for (const [value, reason] of cases) {
    assert.throws(
      () =>
        findCompatiblePwsh({ platform: "win32", env: { [PWSH_PATH_ENV]: value, Path: `${PF}\\PowerShell\\7` }, fs: files, probe }),
      (error) =>
        error instanceof Error &&
        error.message.startsWith(`${PWSH_PATH_ENV}=${JSON.stringify(value)} `) &&
        reason.test(error.message) &&
        /full path of pwsh\.exe/.test(error.message),
      value
    );
  }
  // An empty value means "not set".
  const unset = findCompatiblePwsh({ platform: "win32", env: { [PWSH_PATH_ENV]: "  ", Path: `${PF}\\PowerShell\\7` }, fs: files, probe });
  assert.equal(unset.path, PF_PWSH);

  const described = describeWindowsPowerShell({
    platform: "win32",
    env: {},
    find: () => {
      throw new Error("bad path");
    }
  });
  assert.deepEqual(described, { status: "invalid", error: "bad path" });
});

test("prependPathDirectory puts the directory first and keeps PATH and every other variable", () => {
  const env = { Path: "C:\\Windows\\system32;C:\\Windows", MARKER: "ё — тест", Other: "1" };
  const next = prependPathDirectory(env, PORTABLE_DIR);
  assert.notEqual(next, env);
  assert.deepEqual(env, { Path: "C:\\Windows\\system32;C:\\Windows", MARKER: "ё — тест", Other: "1" });
  assert.deepEqual(next, { Path: `${PORTABLE_DIR};C:\\Windows\\system32;C:\\Windows`, MARKER: "ё — тест", Other: "1" });
  // Already first: unchanged. Every case variant is updated; none added.
  assert.deepEqual(prependPathDirectory(next, PORTABLE_DIR.toUpperCase()), next);
  assert.deepEqual(prependPathDirectory({ PATH: "a", Path: "b" }, "C:\\x"), { PATH: "C:\\x;a", Path: "C:\\x;b" });
  assert.deepEqual(prependPathDirectory({}, "C:\\x"), { Path: "C:\\x" });
  assert.deepEqual(prependPathDirectory({ Path: "" }, "C:\\x"), { Path: "C:\\x" });
});

test("buildAppServerSpawnEnv: Windows gets PowerShell 7 first on PATH, other platforms keep env as is", () => {
  const env = { Path: "C:\\Windows\\system32", MARKER: "x" };
  let calls = 0;
  const found = () => {
    calls += 1;
    return { status: "found", path: PORTABLE_PWSH, directory: PORTABLE_DIR, version: "7.5.4", source: "path" };
  };

  for (const platform of ["linux", "darwin"]) {
    assert.equal(buildAppServerSpawnEnv({ platform, env, findPwsh: found }), env);
  }
  assert.equal(calls, 0);

  assert.deepEqual(buildAppServerSpawnEnv({ platform: "win32", env, findPwsh: found }), {
    Path: `${PORTABLE_DIR};C:\\Windows\\system32`,
    MARKER: "x"
  });

  const warnings = [];
  const notFound = buildAppServerSpawnEnv({
    platform: "win32",
    env,
    findPwsh: () => ({ status: "not-found", rejected: [] }),
    warn: (message) => warnings.push(message)
  });
  assert.equal(notFound, env);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /CODEX_COMPANION_PWSH/);

  assert.throws(
    () =>
      buildAppServerSpawnEnv({
        platform: "win32",
        env,
        findPwsh: () => {
          throw new Error(`${PWSH_PATH_ENV}="x" is not an absolute path.`);
        }
      }),
    /is not an absolute path/
  );
});

test("renderSetupReport shows the PowerShell line only when the report has one", () => {
  const base = {
    ready: true,
    node: { detail: "v22" },
    npm: { detail: "10" },
    codex: { detail: "codex-cli test" },
    auth: { detail: "ok" },
    sessionRuntime: { label: "direct startup" },
    reviewGateEnabled: false,
    actionsTaken: [],
    nextSteps: []
  };
  assert.doesNotMatch(renderSetupReport(base), /powershell/);
  assert.match(
    renderSetupReport({
      ...base,
      windowsPowerShell: { status: "found", path: PF_PWSH, directory: "x", version: "7.4.6", source: "program-files" }
    }),
    /- powershell: 7\.4\.6 at C:\\Program Files\\PowerShell\\7\\pwsh\.exe \(standard install directory; first on the app-server PATH\)/
  );
  assert.match(
    renderSetupReport({
      ...base,
      windowsPowerShell: { status: "not-found", rejected: [{ path: STORE_PWSH, reason: "is the Microsoft Store PowerShell" }] }
    }),
    /- powershell: no PowerShell 7 found; Codex keeps its own choice and may use Windows PowerShell 5\.1 .*skipped .*Microsoft Store/
  );
  assert.match(
    renderSetupReport({ ...base, windowsPowerShell: { status: "invalid", error: "CODEX_COMPANION_PWSH=\"x\" is not an absolute path." } }),
    /- powershell: invalid \(CODEX_COMPANION_PWSH="x" is not an absolute path\.\)/
  );
});

// Real files and real processes, with a POSIX path module: Node scripts with
// a shebang stand in for pwsh (they cannot run as .exe on Windows).
const posixOnly = { skip: process.platform === "win32" ? "uses shebang scripts as stand-ins for pwsh" : false };

function writeFakePwsh(dir, body) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "pwsh.exe");
  writeExecutable(file, `#!/usr/bin/env node\n${body}\n`);
  return file;
}

test("probePwshVersion starts the candidate with an argument array and checks the version", posixOnly, () => {
  const root = path.join(makeTempDir("pwsh-probe-"), "Program Files", "Пауэршелл ё — 7");
  const argsFile = path.join(root, "..", "args.json");
  const good = writeFakePwsh(
    path.join(root, "good"),
    `require("node:fs").writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\nconsole.log("PowerShell 7.4.6");`
  );
  assert.deepEqual(probePwshVersion(good), { ok: true, version: "7.4.6" });
  assert.deepEqual(JSON.parse(fs.readFileSync(argsFile, "utf8")), ["-Version"]);

  const preview = writeFakePwsh(path.join(root, "preview"), `console.log("PowerShell 7.6.0-preview.4");`);
  assert.deepEqual(probePwshVersion(preview), { ok: true, version: "7.6.0-preview.4" });

  const old = writeFakePwsh(path.join(root, "old"), `console.log("PowerShell 6.2.7");`);
  assert.match(probePwshVersion(old).reason, /is PowerShell 6\.2\.7/);

  const failing = writeFakePwsh(path.join(root, "failing"), `console.log("PowerShell 7.4.6"); process.exit(3);`);
  assert.match(probePwshVersion(failing).reason, /-Version exited with code 3/);

  const noise = writeFakePwsh(path.join(root, "noise"), `console.log("Windows PowerShell\\nCopyright");`);
  assert.match(probePwshVersion(noise).reason, /printed no PowerShell version/);

  assert.match(probePwshVersion(path.join(root, "absent", "pwsh.exe")).reason, /could not be started/);
});

test("probePwshVersion gives up on a hanging candidate after its timeout", posixOnly, () => {
  const slow = writeFakePwsh(path.join(makeTempDir("pwsh-slow-"), "медленный pwsh"), `setTimeout(() => console.log("PowerShell 7.4.6"), 30000);`);
  const started = Date.now();
  const result = probePwshVersion(slow, { timeoutMs: 300 });
  const elapsed = Date.now() - started;
  assert.deepEqual(result, { ok: false, reason: "did not answer -Version within 300 ms" });
  assert.ok(elapsed < 10000, `probe took ${elapsed} ms`);
});

test("findCompatiblePwsh checks real files: existence, MZ header, Store targets behind links", posixOnly, () => {
  const root = makeTempDir("pwsh-fs-");
  const dirs = {
    script: path.join(root, "script shim"),
    link: path.join(root, "link to store"),
    good: path.join(root, "Program Files", "PowerShell ё — 7")
  };
  const store = path.join(root, "WindowsApps", "Microsoft.PowerShell_7.5.4.0_x64__8wekyb3d8bbwe");
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, "pwsh.exe"), MZ);
  for (const dir of Object.values(dirs)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(dirs.script, "pwsh.exe"), SCRIPT);
  fs.symlinkSync(path.join(store, "pwsh.exe"), path.join(dirs.link, "pwsh.exe"));
  fs.writeFileSync(path.join(dirs.good, "pwsh.exe"), MZ);

  const probed = [];
  const result = findCompatiblePwsh({
    platform: "win32",
    env: { PATH: [path.join(root, "missing"), dirs.script, dirs.link, dirs.good].join(":") },
    pathModule: path.posix,
    probe: (file) => {
      probed.push(file);
      return { ok: true, version: "7.4.6" };
    }
  });
  assert.equal(result.status, "found");
  assert.equal(result.directory, dirs.good);
  assert.deepEqual(probed, [path.join(dirs.good, "pwsh.exe")]);
});

test("a direct app-server started with the Windows rules gets PowerShell 7 first on PATH, nothing else changed", posixOnly, async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const cwd = makeTempDir();
  const pwshDir = path.join(makeTempDir("pwsh-dir-"), "Program Files", "PowerShell ё — 7");
  const base = buildEnv(binDir);
  // prependPathDirectory joins with ";" under the Windows rules; the leading
  // placeholder keeps binDir a separate entry for the POSIX lookup of `codex`.
  const env = { ...base, PATH: `/nonexistent-first:${base.PATH}`, CODEX_TEST_ENV_MARKER: "Привет, ё — тест" };
  const lookups = [];
  const client = await CodexAppServerClient.connect(cwd, {
    disableBroker: true,
    env,
    platform: "win32",
    findPwsh: (options) => {
      lookups.push(options.platform);
      return { status: "found", path: path.join(pwshDir, "pwsh.exe"), directory: pwshDir, version: "7.4.6", source: "path" };
    }
  });
  try {
    const account = await client.request("account/read", {});
    assert.equal(account.account.email, "test@example.com");
  } finally {
    await client.close();
  }
  assert.deepEqual(lookups, ["win32"]);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  // The MXC override stays in place next to the PATH change.
  assert.deepEqual(state.appServerArgs, [["-c", "windows.sandbox=mxc", "app-server"]]);
  assert.deepEqual(state.appServerEnv, [{ PATH: `${pwshDir};${env.PATH}`, marker: "Привет, ё — тест" }]);
  // The caller's env object is not modified.
  assert.equal(env.PATH, `/nonexistent-first:${base.PATH}`);
});
