---
description: Review and answer approval requests from a background Codex job
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion, Skill
---

Pending approval requests:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" approvals "$ARGUMENTS" --json`

Load the `codex:codex-approvals` skill with the `Skill` tool and follow it. It is the single source of the rules for asking the user and recording answers.

- If `pending` is empty and the result has `closed` entries (the job already finished), tell the user, for each entry, when and how its request was closed (`detail`, `source`, `closedAt`). If `resumeHint` is set, offer to continue the Codex thread with that command (`/codex:rescue --background --resume ...`) instead of just stopping; run nothing yourself.
- If `pending` is empty otherwise, tell the user that no Codex approval requests are waiting and stop.
- Otherwise ask about every entry in `pending` and record each answer exactly as the skill's "Asking about approval requests" section says.
- Then keep following each job you answered for, as the skill's "Following a background job" section says: start `watch <job-id> --json` with `Bash` and `run_in_background: true`, and show `result <job-id>` verbatim when it is done.
