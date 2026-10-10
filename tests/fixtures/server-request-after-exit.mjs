// Child process for the app-server exit test: a waiting approval request is
// declined by onClosed after `codex app-server` died. The reply must not be
// written to the dead stdin (EPIPE would crash this process).
import process from "node:process";

import { CodexAppServerClient } from "../../plugins/codex/scripts/lib/app-server.mjs";
import { createApprovalHandler } from "../../plugins/codex/scripts/lib/approvals.mjs";

const [cwd, workspaceRoot] = process.argv.slice(2);
const client = await CodexAppServerClient.connect(cwd, { disableBroker: true });
const handler = createApprovalHandler({ mode: "ask", interactive: true, workspaceRoot, jobId: "task-exit", timeoutMs: 60000 });
client.setServerRequestHandler(handler);

let sentAfterExit = 0;
const sendMessage = client.sendMessage.bind(client);
client.sendMessage = (message) => {
  if (client.exitResolved) {
    sentAfterExit += 1;
  }
  return sendMessage(message);
};

const thread = await client.request("thread/start", { cwd, sandbox: "read-only", ephemeral: true });
client.request("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "go", text_elements: [] }] }).catch(() => {});
await client.exitPromise;
// Let the declined answer and any stream errors surface.
await new Promise((resolve) => setTimeout(resolve, 500));
process.stdout.write(`${JSON.stringify({ sentAfterExit, decisions: handler.decisions.map((entry) => entry.source) })}\n`);
