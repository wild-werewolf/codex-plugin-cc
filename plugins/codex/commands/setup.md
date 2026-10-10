---
description: Check whether the local Codex CLI is ready, optionally toggle the stop-time review gate, and set the default approval mode and approval timeout
argument-hint: '[--enable-review-gate|--disable-review-gate] [--default-approvals ask|auto-review|deny|unset] [--approval-timeout <minutes>|unset]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup --json $ARGUMENTS
```

If the result says Codex is unavailable and npm is available:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Codex now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Codex (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g @openai/codex
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup --json $ARGUMENTS
```

If Codex is already installed or npm is unavailable:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Codex is installed but not authenticated, preserve the guidance to run `!codex login`.
- Show the `defaultApprovals` value and where it comes from: a plugin default (`mode` and the actual `file`), a plugin default still read from the old location (`source: plugin-default-legacy`; the next `--default-approvals` change saves it to `configFile`), or not set, in which case the `approvals_reviewer` from the user's Codex config applies.
- Show the `approvalTimeout` value in minutes and where it comes from: the default (15 minutes), the plugin setting (`file`), or `CODEX_COMPANION_APPROVAL_TIMEOUT_MS` (`source: env`), which overrides `--approval-timeout`.
- On Windows, if `windowsPowerShell.status` is `not-found` or `invalid`, keep the guidance about `CODEX_COMPANION_PWSH` and do not say that the garbled PowerShell startup messages are fixed.
