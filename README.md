# Codex plugin for Claude Code

Use Codex from inside Claude Code for code reviews or to delegate tasks to Codex.

This plugin is for Claude Code users who want an easy way to start using Codex from the workflow
they already have.

<video src="./docs/plugin-demo.webm" controls muted playsinline autoplay></video>

## What You Get

- `/codex:review` for a normal read-only Codex review
- `/codex:adversarial-review` for a steerable challenge review
- `/codex:rescue`, `/codex:transfer`, `/codex:status`, `/codex:result`, and `/codex:cancel` to delegate work, hand off sessions, and manage background jobs

## Requirements

- **ChatGPT subscription (incl. Free) or OpenAI API key.**
  - Usage will contribute to your Codex usage limits. [Learn more](https://developers.openai.com/codex/pricing).
- **Node.js 18.18 or later**

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add openai/codex-plugin-cc
```

Install the plugin:

```bash
/plugin install codex@openai-codex
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/codex:setup
```

`/codex:setup` will tell you whether Codex is ready. If Codex is missing and npm is available, it can offer to install Codex for you.

If you prefer to install Codex yourself, use:

```bash
npm install -g @openai/codex
```

If Codex is installed but not logged in yet, run:

```bash
!codex login
```

After install, you should see:

- the slash commands listed below
- the `codex:codex-rescue` subagent in `/agents`

One simple first run is:

```bash
/codex:review --background
/codex:status
/codex:result
```

### Installing this fork (`wild-codex`)

This fork adds approval handling (`--approvals`, `/codex:approve`) on top of the upstream plugin. Its marketplace is named `wild-codex` so it does not clash with `openai-codex`; the plugin itself is still called `codex`, so only one of the two should be enabled at a time:

```bash
/plugin marketplace add wild-werewolf/codex-plugin-cc
/plugin disable codex@openai-codex
/plugin install codex@wild-codex
/reload-plugins
```

Skip the `disable` step if the upstream plugin was never installed. To go back, run `/plugin disable codex@wild-codex` and `/plugin enable codex@openai-codex`.

#### Pulling in upstream changes

```bash
git remote add upstream https://github.com/openai/codex-plugin-cc.git   # once
git fetch upstream
git checkout approvals
git rebase upstream/main
npm test
node plugins/codex/scripts/codex-companion.mjs protocol-check
git push --force-with-lease origin approvals
```

Resolve conflicts in favor of the approval handling (no `approvalPolicy: "never"`, no session-wide grants). If upstream bumped its version, set the fork version to match, for example `node scripts/bump-version.mjs 1.0.7-approvals.1`, and check it with `npm run check-version`. `protocol-check` needs the Codex CLI on `PATH` and should report `compatible`; re-run it whenever Codex itself is updated. After the change lands on the fork's `main`, refresh the plugin with `/plugin marketplace update wild-codex`.

## Usage

### `/codex:review`

Runs a normal Codex review on your current work. It gives you the same quality of code review as running `/review` inside Codex directly.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/codex:adversarial-review`](#codexadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/codex:review
/codex:review --base main
/codex:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/codex:status`](#codexstatus) to check on the progress and [`/codex:cancel`](#codexcancel) to cancel the ongoing task.

Reviews cannot stop to ask you, so approval requests Codex sends during a review are declined and listed under "Approval requests" in the output. `--approvals auto-review` hands them to Codex's built-in reviewer instead; `--approvals ask` and `deny` keep the default (decline). The same flag works for `/codex:adversarial-review`.

### `/codex:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/codex:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/codex:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/codex:adversarial-review
/codex:adversarial-review --base main challenge whether this was the right caching and retry design
/codex:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/codex:rescue`

Hands a task to Codex through the `codex:codex-rescue` subagent.

Use it when you want Codex to:

- investigate a bug
- try a fix
- continue a previous Codex task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue thread for this repo.

Examples:

```bash
/codex:rescue investigate why the tests started failing
/codex:rescue fix the failing test with the smallest safe patch
/codex:rescue --resume apply the top fix from the last run
/codex:rescue --model gpt-5.4-mini --effort medium investigate the flaky integration test
/codex:rescue --model spark fix the issue quickly
/codex:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Codex:

```text
Ask Codex to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, Codex chooses its own defaults.
- if you say `spark`, the plugin maps that to `gpt-5.3-codex-spark`
- follow-up rescue requests can continue the latest Codex task in the repo
- `--write` selects `workspace-write`, otherwise the run is `read-only`. The plugin never asks for full access.
- when Codex asks for approval is up to your Codex config (`approval_policy`, default `on-request`); the plugin no longer forces `never`.
- `--approvals <ask|auto-review|deny>` decides who answers those requests: `ask` lets you decide, `auto-review` hands them to Codex's built-in reviewer, `deny` declines them all. Without the flag the default from `/codex:setup --default-approvals` applies, and without that the `approvals_reviewer` from your Codex config. Only `--background` runs can wait for you; foreground runs decline and list the requests in the output.
- with `--background`, Codex runs as a detached job and Claude follows it for you: it starts `watch <job-id>` in the background, asks you about each approval request as it arrives (`Decline (Recommended)` or `Approve once`), and shows `/codex:result` when the job is done. `/codex:approve` does the same for a job you pick yourself.
- `auto-review` is Codex's built-in reviewer subagent. It decides each request on its own and can decline it; it is not "approve everything". The plugin never requests full access, whichever mode you choose.

### `/codex:approve`

Shows approval requests from a running background Codex job one at a time, records your answer, and keeps following the job until it finishes. Each request is approved once at most, never for the whole session. A request that gets no answer is declined after 15 minutes (`CODEX_COMPANION_APPROVAL_TIMEOUT_MS`). The first answer is final, and inside a Claude session only jobs started from that session can be answered.

```bash
/codex:approve
/codex:approve task-abc123
```

`node scripts/codex-companion.mjs protocol-check` compares the installed Codex app-server protocol with the fields and approval methods the plugin relies on. Run it after updating Codex.

### `/codex:transfer`

Creates a persistent Codex thread from the current Claude Code session and prints a `codex resume <session-id>` command.

Use it when you started a debugging or implementation conversation in Claude Code and want to continue that same context directly in Codex.

Examples:

```bash
/codex:transfer
/codex:transfer --source ~/.claude/projects/-Users-me-repo/<session-id>.jsonl
```

The plugin's existing `SessionStart` hook supplies the current transcript path automatically; `--source` is available as a manual override. The transfer uses Codex's external-agent session importer, so it follows the same conversion rules as importing Claude history in the Codex App and creates visible turns that can be continued in the App or TUI. The source must be under `~/.claude/projects`, and older Codex versions that do not expose session import must be upgraded before using this command.

### `/codex:status`

Shows running and recent Codex jobs for the current repository.

Examples:

```bash
/codex:status
/codex:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/codex:result`

Shows the final stored Codex output for a finished job.
When available, it also includes the Codex session ID so you can reopen that run directly in Codex with `codex resume <session-id>`.

Examples:

```bash
/codex:result
/codex:result task-abc123
```

### `/codex:cancel`

Cancels an active background Codex job.

Examples:

```bash
/codex:cancel
/codex:cancel task-abc123
```

### `/codex:setup`

Checks whether Codex is installed and authenticated.
If Codex is missing and npm is available, it can offer to install Codex for you.

It also shows the default approval mode and where it comes from, and reports whether the installed Codex app-server protocol matches what the plugin expects (`compatible`, `incompatible`, or `unverified` when the schema cannot be generated). This line is informational and does not change whether setup is ready; run `node scripts/codex-companion.mjs protocol-check` for details.

You can also use `/codex:setup` to manage the optional review gate.

#### Default approval mode

```bash
/codex:setup --default-approvals auto-review
/codex:setup --default-approvals unset
```

Sets the approval mode (`ask`, `auto-review`, or `deny`) used by `/codex:rescue`, `/codex:review`, and `/codex:adversarial-review` in every repository when you do not pass `--approvals`. An explicit `--approvals` always wins; `unset` removes the default so the `approvals_reviewer` from your Codex config applies again. A background job keeps the mode it was started with.

The setting is stored once per user, outside the plugin's data directory, so it survives reinstalling the plugin or installing it from another marketplace:

- Windows: `%APPDATA%\codex-companion\config.json`
- macOS and Linux: `${XDG_CONFIG_HOME:-~/.config}/codex-companion/config.json`
- anywhere else: set `CODEX_COMPANION_CONFIG_FILE` to the full path of the file

`/codex:setup` shows the mode, where it comes from, and the actual file. Releases up to `1.0.6-approvals.2` kept it in `${CLAUDE_PLUGIN_DATA}/config.json`, a directory named after the plugin and its marketplace (for example `~/.claude/plugins/data/codex-openai-codex`). While the new file does not exist yet, that old file is still read and `/codex:setup` says so; the next `/codex:setup --default-approvals ...` writes the new file, carrying the old values over and leaving the old file in place. To move the setting to another machine, copy the file. To reset it, run `/codex:setup --default-approvals unset` or delete the file. Job state (`state.json`, jobs) stays in `CLAUDE_PLUGIN_DATA`.

#### Enabling review gate

```bash
/codex:setup --enable-review-gate
/codex:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Codex review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Codex loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/codex:review
```

### Hand A Problem To Codex

```bash
/codex:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/codex:adversarial-review --background
/codex:rescue --background investigate the flaky test
```

Then check in with:

```bash
/codex:status
/codex:result
```

## Codex Integration

The Codex plugin wraps the [Codex app server](https://developers.openai.com/codex/app-server). It uses the global `codex` binary installed in your environment and [applies the same configuration](https://developers.openai.com/codex/config-basic).

### Common Configurations

If you want to change the default reasoning effort or the default model that gets used by the plugin, you can define that inside your user-level or project-level `config.toml`. For example to always use `gpt-5.4-mini` on `high` for a specific project you can add the following to a `.codex/config.toml` file at the root of the directory you started Claude in:

```toml
model = "gpt-5.4-mini"
model_reasoning_effort = "high"
```

Your configuration will be picked up based on:

- user-level config in `~/.codex/config.toml`
- project-level overrides in `.codex/config.toml`
- project-level overrides only load when the [project is trusted](https://developers.openai.com/codex/config-advanced#project-config-files-codexconfigtoml)

Check out the Codex docs for more [configuration options](https://developers.openai.com/codex/config-reference).

### Moving The Work Over To Codex

Delegated tasks and any [stop gate](#what-does-the-review-gate-do) run can also be directly resumed inside Codex by running `codex resume` either with the specific session ID you received from running `/codex:result` or `/codex:status` or by selecting it from the list.

This way you can review the Codex work or continue the work there.

## FAQ

### Do I need a separate Codex account for this plugin?

If you are already signed into Codex on this machine, that account should work immediately here too. This plugin uses your local Codex CLI authentication.

If you only use Claude Code today and have not used Codex yet, you will also need to sign in to Codex with either a ChatGPT account or an API key. [Codex is available with your ChatGPT subscription](https://developers.openai.com/codex/pricing/), and [`codex login`](https://developers.openai.com/codex/cli/reference/#codex-login) supports both ChatGPT and API key sign-in. Run `/codex:setup` to check whether Codex is ready, and use `!codex login` if it is not.

### Does the plugin use a separate Codex runtime?

No. This plugin delegates through your local [Codex CLI](https://developers.openai.com/codex/cli/) and [Codex app server](https://developers.openai.com/codex/app-server/) on the same machine.

That means:

- it uses the same Codex install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same Codex config I already have?

Yes. If you already use Codex, the plugin picks up the same [configuration](#common-configurations).

### Can I keep using my current API key or base URL setup?

Yes. Because the plugin uses your local Codex CLI, your existing sign-in method and config still apply.

If you need to point the built-in OpenAI provider at a different endpoint, set `openai_base_url` in your [Codex config](https://developers.openai.com/codex/config-advanced/#config-and-state-locations).
