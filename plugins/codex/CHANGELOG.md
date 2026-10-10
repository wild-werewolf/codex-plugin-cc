# Changelog

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
