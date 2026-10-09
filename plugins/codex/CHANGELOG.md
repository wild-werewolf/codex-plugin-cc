# Changelog

## Unreleased

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
