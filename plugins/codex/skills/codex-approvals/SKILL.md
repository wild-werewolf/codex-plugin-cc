---
name: codex-approvals
description: Rules for following a background Codex job with `watch` and for asking the user about its approval requests. Use after `/codex:rescue` starts a background job and from `/codex:approve`.
user-invocable: false
---

# Codex Approvals

Codex can ask to leave its sandbox (run a command outside it, write outside the workspace, get network or extra permissions). Only a background job (`task --background`) can wait for an answer. These rules are the single place that says how Claude follows such a job and asks the user.

Companion script: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs"`.

## Following a background job

- As soon as a background launch line appears (`... started in the background as <job-id>. ...`), start the watcher with `Bash` and `run_in_background: true`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" watch <job-id> --json
```

- The launch line can also arrive late, inside the notification of a subagent that ran in the background. Treat it the same way: take `<job-id>` from that line and start `watch` at once.
- Do not poll `/codex:status` yourself, do not use `sleep`, and do not wait in the foreground. The background `Bash` call notifies you when `watch` exits.
- `watch` prints exactly one JSON line. Act on its `event`:
  - `approval`: answer every entry in `pending` as described below, then start `watch <job-id> --json` again in the background.
  - `done`: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" result <job-id>` and show its stdout to the user verbatim, without summarizing it. Stop following the job.
  - `timeout`: the job is still running. Start `watch <job-id> --json` again in the background.
- If `watch` fails (for example, the job no longer exists), tell the user and stop following the job.
- Keep following the job until `done`, even after the user answered every request.

## Asking about approval requests

- Ask about each pending request separately with `AskUserQuestion`: one question per request, in the order listed.
  - Show the request verbatim: `summary`, and when present `command`, `cwd`, `grantRoot`, `files`, `reason`, plus `expiresAt`.
  - Use exactly two options: `Decline (Recommended)` and `Approve once`.
  - Never pre-select, infer, or reuse an answer. Every request needs its own answer from the user.
- Only after the user answers, record that answer:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" approve <jobId> <approvalId> --decision <accept|decline>
```

- `Approve once` maps to `accept`. `Decline`, and any other or missing answer, maps to `decline`.
- Record only the user's answer. Do not approve on the user's behalf, do not approve several requests with one answer, and do not use any other decision value.
- If `approve` reports that the request is already closed or expired, or that the job was not started from this Claude session, tell the user. Do not retry it.

## Never

- Never answer a request without asking the user, even when the same command was approved before.
- Never suggest full access or session-wide approval; the plugin supports neither.
