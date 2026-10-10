import test from "node:test";
import assert from "node:assert/strict";

import "./helpers.mjs";
import {
  WINDOWS_SANDBOX_ENV,
  WINDOWS_SANDBOX_VALUES,
  buildAppServerSpawnArgs,
  describeWindowsSandbox,
  resolveWindowsSandbox
} from "../plugins/codex/scripts/lib/app-server.mjs";
import { renderSetupReport } from "../plugins/codex/scripts/lib/render.mjs";

const MXC_ARGS = ["-c", "windows.sandbox=mxc", "app-server"];

test("buildAppServerSpawnArgs selects the MXC sandbox on Windows by default", () => {
  assert.deepEqual(buildAppServerSpawnArgs({ platform: "win32", env: {} }), MXC_ARGS);
  assert.deepEqual(buildAppServerSpawnArgs({ platform: "win32", env: { [WINDOWS_SANDBOX_ENV]: "" } }), MXC_ARGS);
  assert.deepEqual(buildAppServerSpawnArgs({ platform: "win32", env: { [WINDOWS_SANDBOX_ENV]: "  " } }), MXC_ARGS);
});

test("buildAppServerSpawnArgs leaves other platforms unchanged and ignores the variable there", () => {
  for (const platform of ["linux", "darwin"]) {
    assert.deepEqual(buildAppServerSpawnArgs({ platform, env: {} }), ["app-server"]);
    for (const value of ["mxc", "elevated", "config", "not-a-sandbox", "mxc & calc"]) {
      assert.deepEqual(buildAppServerSpawnArgs({ platform, env: { [WINDOWS_SANDBOX_ENV]: value } }), ["app-server"]);
    }
    assert.equal(resolveWindowsSandbox({ platform, env: { [WINDOWS_SANDBOX_ENV]: "bogus" } }), null);
    assert.equal(describeWindowsSandbox({ platform, env: {} }), null);
  }
});

test("buildAppServerSpawnArgs passes no override on Windows with CODEX_COMPANION_WINDOWS_SANDBOX=config", () => {
  assert.deepEqual(buildAppServerSpawnArgs({ platform: "win32", env: { [WINDOWS_SANDBOX_ENV]: "config" } }), ["app-server"]);
  assert.deepEqual(resolveWindowsSandbox({ platform: "win32", env: { [WINDOWS_SANDBOX_ENV]: "config" } }), {
    mode: "config",
    source: "env"
  });
});

test("buildAppServerSpawnArgs passes a supported value from the environment", () => {
  assert.deepEqual([...WINDOWS_SANDBOX_VALUES], ["mxc", "elevated", "unelevated"]);
  for (const value of WINDOWS_SANDBOX_VALUES) {
    assert.deepEqual(buildAppServerSpawnArgs({ platform: "win32", env: { [WINDOWS_SANDBOX_ENV]: value } }), [
      "-c",
      `windows.sandbox=${value}`,
      "app-server"
    ]);
    assert.deepEqual(resolveWindowsSandbox({ platform: "win32", env: { [WINDOWS_SANDBOX_ENV]: value } }), {
      mode: value,
      source: "env"
    });
  }
  // Case and surrounding spaces are normalized; the result is still a schema value.
  assert.deepEqual(buildAppServerSpawnArgs({ platform: "win32", env: { [WINDOWS_SANDBOX_ENV]: " Unelevated " } }), [
    "-c",
    "windows.sandbox=unelevated",
    "app-server"
  ]);
});

test("buildAppServerSpawnArgs rejects values outside the Codex schema", () => {
  for (const value of ["bogus", "disabled", "danger-full-access", "none", "mxc & calc", "mxc\" app-server", "mxc elevated"]) {
    assert.throws(
      () => buildAppServerSpawnArgs({ platform: "win32", env: { [WINDOWS_SANDBOX_ENV]: value } }),
      (error) =>
        error instanceof Error &&
        error.message.includes(`Unsupported ${WINDOWS_SANDBOX_ENV}=`) &&
        error.message.includes("mxc, elevated, unelevated, config"),
      value
    );
  }
});

test("describeWindowsSandbox reports the source and an invalid value without throwing", () => {
  assert.deepEqual(describeWindowsSandbox({ platform: "win32", env: {} }), { mode: "mxc", source: "plugin-default" });
  assert.deepEqual(describeWindowsSandbox({ platform: "win32", env: { [WINDOWS_SANDBOX_ENV]: "elevated" } }), {
    mode: "elevated",
    source: "env"
  });
  const invalid = describeWindowsSandbox({ platform: "win32", env: { [WINDOWS_SANDBOX_ENV]: "bogus" } });
  assert.equal(invalid.mode, null);
  assert.equal(invalid.source, "env");
  assert.match(invalid.error, /Unsupported CODEX_COMPANION_WINDOWS_SANDBOX="bogus"/);
});

test("renderSetupReport shows the Windows sandbox line only when the report has one", () => {
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
  assert.doesNotMatch(renderSetupReport(base), /windows sandbox/);
  assert.match(
    renderSetupReport({ ...base, windowsSandbox: { mode: "mxc", source: "plugin-default" } }),
    /- windows sandbox: mxc \(plugin default; set CODEX_COMPANION_WINDOWS_SANDBOX=config to use your Codex config\)/
  );
  assert.match(
    renderSetupReport({ ...base, windowsSandbox: { mode: "config", source: "env" } }),
    /- windows sandbox: from your Codex config \(CODEX_COMPANION_WINDOWS_SANDBOX=config\)/
  );
  assert.match(
    renderSetupReport({ ...base, windowsSandbox: { mode: "unelevated", source: "env" } }),
    /- windows sandbox: unelevated \(CODEX_COMPANION_WINDOWS_SANDBOX\)/
  );
  assert.match(
    renderSetupReport({ ...base, windowsSandbox: { mode: null, source: "env", error: "Unsupported value" } }),
    /- windows sandbox: invalid \(Unsupported value\)/
  );
});
