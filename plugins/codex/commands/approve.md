---
description: Review and answer approval requests from a background Codex job
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion
---

Pending approval requests:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" approvals "$ARGUMENTS" --json`

Rules:

- If `pending` is empty, tell the user that no Codex approval requests are waiting and stop.
- Ask about each pending request separately with `AskUserQuestion`, one question per request, in the order listed.
  - Show the request verbatim: `summary`, and when present `command`, `cwd`, `grantRoot`, `files`, `reason`, plus `expiresAt`.
  - Use exactly two options: `Decline (Recommended)` and `Approve once`.
  - Never pre-select, infer, or reuse an answer. Every request needs its own answer from the user.
- Only after the user answers, record that answer:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" approve <jobId> <approvalId> --decision <accept|decline>
```

- `Approve once` maps to `accept`; `Decline` and any other or missing answer map to `decline`.
- Do not approve on the user's behalf, do not approve several requests with one answer, and do not use any other decision value.
- If `approve` reports that the request is already closed or expired, tell the user. Do not retry it.
- Afterwards, suggest `/codex:status <job-id>` to follow the job.
