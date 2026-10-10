import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";

import { makeTempDir } from "./helpers.mjs";
import { resolveTaskkillCommand, terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

test("terminateProcessTree runs taskkill.exe on Windows without a shell", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    env: { SystemRoot: "C:\\Windows", SHELL: "C:\\Program Files\\Git\\bin\\bash.exe" },
    runCommandImpl(command, args, options) {
      captured = { command, args, shell: options.shell };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  // shell: false: a Git Bash $SHELL must not rewrite "/PID" into a path.
  assert.deepEqual(captured, {
    command: "C:\\Windows\\System32\\taskkill.exe",
    args: ["/PID", "1234", "/T", "/F"],
    shell: false
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("resolveTaskkillCommand falls back to taskkill.exe on PATH without SystemRoot", () => {
  assert.equal(resolveTaskkillCommand({}), "taskkill.exe");
  assert.equal(resolveTaskkillCommand({ SYSTEMROOT: "D:\\Win" }), "D:\\Win\\System32\\taskkill.exe");
});

test("terminateProcessTree treats taskkill exit 128 as an already stopped process in any locale", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    env: {},
    runCommandImpl(command, args) {
      return { command, args, status: 128, signal: null, stdout: "", stderr: "\u041e\u0448\u0438\u0431\u043a\u0430", error: null };
    }
  });
  assert.equal(outcome.attempted, true);
  assert.equal(outcome.delivered, false);
});

test("terminateProcessTree reports a real taskkill failure", () => {
  assert.throws(
    () =>
      terminateProcessTree(1234, {
        platform: "win32",
        env: {},
        runCommandImpl(command, args) {
          return { command, args, status: 1, signal: null, stdout: "", stderr: "ERROR: Invalid argument/option - 'C:/Program Files/Git/PID'.", error: null };
        }
      }),
    /taskkill\.exe \/PID 1234 \/T \/F: exit=1/
  );
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});

function findWindowsBash() {
  const candidates = [
    process.env.SHELL,
    process.env.ProgramFiles && path.win32.join(process.env.ProgramFiles, "Git", "bin", "bash.exe"),
    process.env.ProgramW6432 && path.win32.join(process.env.ProgramW6432, "Git", "bin", "bash.exe")
  ].filter(Boolean);
  const where = spawnSync("where.exe", ["bash.exe"], { encoding: "utf8", windowsHide: true });
  if (where.status === 0) {
    candidates.push(...where.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  }
  return candidates.find((candidate) => /bash(\.exe)?$/i.test(candidate) && fs.existsSync(candidate)) ?? null;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitUntil(predicate, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

const windowsBash = process.platform === "win32" ? findWindowsBash() : null;

test(
  "terminateProcessTree kills a real Windows process tree while SHELL points to bash",
  {
    skip:
      process.platform !== "win32"
        ? "Windows only: taskkill and MSYS path conversion exist only there"
        : !windowsBash
          ? "Git Bash (bash.exe) was not found; set SHELL to bash.exe to run this test"
          : false
  },
  async (t) => {
    const dir = makeTempDir();
    const grandchildPidFile = path.join(dir, "grandchild.pid");
    // The parent starts a long-running grandchild and records its pid; both
    // must be gone after one terminateProcessTree(parent) call.
    const parentSource = `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
      fs.writeFileSync(${JSON.stringify(grandchildPidFile)}, String(child.pid));
      setInterval(() => {}, 1000);
    `;
    const parent = spawn(process.execPath, ["-e", parentSource], { stdio: "ignore", windowsHide: true });
    const previousShell = process.env.SHELL;
    process.env.SHELL = windowsBash;
    t.after(() => {
      if (previousShell === undefined) {
        delete process.env.SHELL;
      } else {
        process.env.SHELL = previousShell;
      }
      for (const pid of [parent.pid, Number(fs.existsSync(grandchildPidFile) ? fs.readFileSync(grandchildPidFile, "utf8") : NaN)]) {
        if (Number.isFinite(pid) && processAlive(pid)) {
          try {
            process.kill(pid);
          } catch {
            // Already gone.
          }
        }
      }
    });

    assert.ok(await waitUntil(() => fs.existsSync(grandchildPidFile) && fs.readFileSync(grandchildPidFile, "utf8").trim() !== ""));
    const grandchildPid = Number(fs.readFileSync(grandchildPidFile, "utf8"));
    assert.ok(processAlive(grandchildPid));

    const outcome = terminateProcessTree(parent.pid);
    assert.equal(outcome.method, "taskkill");
    assert.equal(outcome.delivered, true, JSON.stringify(outcome.result ?? null));
    assert.ok(await waitUntil(() => !processAlive(parent.pid)), "the parent process should be gone");
    assert.ok(await waitUntil(() => !processAlive(grandchildPid)), "the grandchild process should be gone with the tree");
  }
);
