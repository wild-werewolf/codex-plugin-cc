# Changelog

## 1.0.6-approvals.6

- Windows: `taskkill` is started as `%SystemRoot%\System32\taskkill.exe` without a shell. With Git Bash as `$SHELL`, MSYS rewrote `/PID` into `C:/Program Files/Git/PID` and `taskkill` failed, so `/codex:cancel`, the `SessionEnd` cleanup of jobs and the broker, and closing a direct app-server left processes running. Exit code 128 (no such process) counts as already stopped in every locale. The other Windows commands still run through the shell only where they need it (`codex` and `npm` are `.cmd` shims; their arguments do not start with `/`, and paths are quoted), `git` and `pwsh` already ran without one.
- `/codex:cancel` no longer ends up as `failed`: the worker reads the job again before its final write and keeps a `cancelled` record, and an interrupted turn (`turn/completed` with status `interrupted`) is recorded as `cancelled`. Late turn events no longer change the phase of a cancelled job. If the worker cannot be stopped, `cancel` still records the cancellation and says so (`workerTerminated`, `workerTerminationError` in `--json`).
- The shared broker stops after 5 minutes without work (no request in progress, no turn streaming, no approval request waiting for the user; a pending approval keeps it up), closes its `codex app-server` and the MCP servers under it, removes its socket or pipe, pid file, log and this session's `broker.json` if it still points to it. `CODEX_COMPANION_BROKER_IDLE_MS` sets the idle time in milliseconds, `0` keeps the old behavior (until `SessionEnd`). It also stops when its app-server exits. A client that finds a dead broker in `broker.json` (crash, or an idle exit racing the lookup) forgets it and starts a new broker, or uses a direct app-server where it only reuses one (`setup` no longer reports a login error then).
- `approve` for a closed or expired request says when and how it was closed (`timeout`, `user`, `resolved-by-server`, connection closed, job ended) and, when nobody answered, how to continue: `/codex:rescue --background --resume Retry: <request>`. `approvals <job-id>` on a finished job lists its closed requests with the same hint instead of failing, and a result with requests declined that way ends with the hint. The `codex-approvals` skill and `/codex:approve` offer that continuation instead of stopping.
- `/codex:setup --approval-timeout <minutes|unset>` stores how long background jobs wait for an answer (1–1440 minutes, default 15) in the per-user `config.json` (`approvalTimeoutMinutes`); `CODEX_COMPANION_APPROVAL_TIMEOUT_MS` still takes precedence. `/codex:setup` shows the value and its source (`approvalTimeout` in `--json`).
- Tests stop every broker they start (also those under their own `CLAUDE_PLUGIN_DATA`); previously a full run left about 30 brokers with their app-servers running.

## 1.0.6-approvals.5

- On Windows the companion looks for a usable PowerShell 7 before it starts `codex app-server` and puts its directory first on `PATH` in that process's environment only, so Codex's shell detection (`pwsh` on `PATH` first) uses it instead of Windows PowerShell 5.1, whose startup messages (such as `InitializeDefaultDrives` errors) are printed in the console code page before the command switches to UTF-8 and arrive garbled. Order: `CODEX_COMPANION_PWSH`, `pwsh.exe` on `PATH` in order, `%ProgramFiles%\PowerShell\7`, Codex's managed runtime under `%USERPROFILE%\.cache\codex-runtimes`. Each candidate must be a `pwsh.exe` executable outside the Store PowerShell package and its App Execution Alias (other `WindowsApps` packages are allowed) whose `-Version` reports 7+ within 5 s. Direct and shared-broker runtimes alike; the broker's own environment, the global `PATH`, profiles and `~/.codex/config.toml` are unchanged, and the MXC override, approvals and sandbox modes stay as they were.
- Without a usable PowerShell 7 Codex keeps its own choice and the companion prints a warning with how to set `CODEX_COMPANION_PWSH`. A set `CODEX_COMPANION_PWSH` that is not usable is an error. Ignored on macOS and Linux.
- `/codex:setup` shows the PowerShell found or the candidates skipped (`windowsPowerShell` in `--json`, Windows only, informational).

## 1.0.6-approvals.4

- On Windows the companion starts `codex -c windows.sandbox=mxc app-server` (direct and shared-broker runtimes alike). With the legacy `elevated` sandbox, Codex's per-command "setup refresh" fails while `node_repl.exe` is running (`os error 32`, [openai/codex#51822](https://github.com/openai/codex/pull/51822)), and every command was rejected with `helper_unknown_error: setup refresh had errors`. The override is per process; `~/.codex/config.toml` is untouched. `CODEX_COMPANION_WINDOWS_SANDBOX=config` passes no override, `mxc`/`elevated`/`unelevated` pass that value, anything else is an error. No fallback to another sandbox, and approval policy, reviewer and the thread sandbox are unchanged. Other platforms still run `codex app-server`.
- `/codex:setup` shows the Windows sandbox and its source (`windowsSandbox` in `--json`, Windows only, informational).

## 1.0.6-approvals.3

- `/codex:rescue` calls the `Agent` tool with `run_in_background: false` in every mode. The tool runs subagents in the background when the parameter is left out, so `--background` jobs reached the user only after a notification instead of within seconds. If the subagent still returns through a notification, Claude now starts `watch` right away from the launch line in it (also in the `codex-approvals` skill).
- The per-user default approval mode moved out of `CLAUDE_PLUGIN_DATA`, whose directory is named after the plugin *and* its marketplace and is removed on uninstall. It now lives in `%APPDATA%\codex-companion\config.json` on Windows and `${XDG_CONFIG_HOME:-~/.config}/codex-companion/config.json` elsewhere, or in `CODEX_COMPANION_CONFIG_FILE`. An old `${CLAUDE_PLUGIN_DATA}/config.json`, or else the newest `config.json` with a plugin setting in another installation's data directory next to it (`codex-openai-codex`, ...), is still read until the next write moves the known settings (`defaultApprovals`) over; other keys are never read or copied, and the old file is kept. `/codex:setup` shows the actual file and says when the value comes from the old location.

## 1.0.6-approvals.2

- New `watch <job-id> [--json]` subcommand: waits until a background job has a pending approval request, finishes, or the timeout passes, and prints one event.
- `/codex:rescue --background` passes `--background` to `task` (the companion's detached job is the only kind that can wait for approvals) and the main Claude thread follows the job with `watch`, asking about each approval request and showing the result when it is done. `/codex:approve` keeps following the job too. The rules live in the new `codex-approvals` skill.
- `/codex:setup --default-approvals <ask|auto-review|deny|unset>` stores a per-user default approval mode in `${CLAUDE_PLUGIN_DATA}/config.json`. Precedence: `--approvals`, then the default, then the Codex config. Applies to `task`, `review`, and `adversarial-review`; the applied reviewer is verified the same way.
- A server request answered after `codex app-server` exited is no longer written to its dead stdin (EPIPE could crash the worker).
- Entry points filter Node's DEP0190 warning ("Passing args to a child process with shell option true") and keep every other warning.

## 1.0.6-approvals.1

- Stop forcing `approvalPolicy: "never"` on `thread/start` and `thread/resume`; the Codex config decides when to ask. `--write` still selects `workspace-write`, otherwise `read-only`.
- Handle app-server approval requests (`item/commandExecution|fileChange|permissions/requestApproval` and the legacy `execCommandApproval`/`applyPatchApproval`) instead of rejecting them as unsupported. Background tasks wait for `/codex:approve`; foreground runs and reviews decline. Unanswered requests are declined after a timeout.
- `task --approvals <ask|auto-review|deny>` sets `approvalsReviewer` consistently on `thread/start`, `thread/resume`, and `turn/start`.
- The shared broker forwards approval requests to the attached client and declines them when no client is attached.
- Refuse a thread whose applied sandbox or approval reviewer differs from what was requested.
- New `protocol-check` subcommand that compares the installed app-server schema with what the plugin relies on, including the legacy decisions, elicitation, the granted permission profile, and the thread response fields used for verification.
- `review` and `adversarial-review` accept `--approvals`; by default their approval requests are still declined, and they are now listed under "Approval requests" in the output and in `/codex:result`.
- `/codex:setup` shows an informational app-server protocol line (`compatible`, `incompatible`, or `unverified`).
- `approve` only decides jobs started from the current Claude session when the session is known.
- A decision is recorded atomically: the first of the user, the timeout, Codex resolving the request, or the connection closing wins; a late or different decision is rejected.
- Requests still waiting when the app-server connection closes are declined at once, so a finished worker no longer lingers until the timeout.
- A job stays in `awaiting-approval` while any of its requests waits, even when turn events arrive meanwhile.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
