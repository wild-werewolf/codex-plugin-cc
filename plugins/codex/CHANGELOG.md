# Changelog

## Unreleased

- Stop forcing `approvalPolicy: "never"` on `thread/start` and `thread/resume`; the Codex config decides when to ask. `--write` still selects `workspace-write`, otherwise `read-only`.
- Handle app-server approval requests (`item/commandExecution|fileChange|permissions/requestApproval` and the legacy `execCommandApproval`/`applyPatchApproval`) instead of rejecting them as unsupported. Background tasks wait for `/codex:approve`; foreground runs and reviews decline. Unanswered requests are declined after a timeout.
- `task --approvals <ask|auto-review|deny>` sets `approvalsReviewer` consistently on `thread/start`, `thread/resume`, and `turn/start`.
- The shared broker forwards approval requests to the attached client and declines them when no client is attached.
- Refuse a thread whose applied sandbox or approval reviewer differs from what was requested.
- New `protocol-check` subcommand that compares the installed app-server schema with what the plugin relies on.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
