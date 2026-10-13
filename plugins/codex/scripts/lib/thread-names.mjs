import process from "node:process";

import { readUserConfig } from "./state.mjs";

// Names of the Codex threads that `task` creates: "<prefix>: <name>", where
// <name> is `task --name` or else the start of the prompt. The prefix comes
// from CODEX_COMPANION_THREAD_PREFIX, then `setup --thread-prefix`, then
// DEFAULT_THREAD_PREFIX.
export const THREAD_PREFIX_ENV = "CODEX_COMPANION_THREAD_PREFIX";
export const THREAD_PREFIX_CONFIG_KEY = "threadPrefix";
export const DEFAULT_THREAD_PREFIX = "CCT";
// Prefixes of earlier releases: `--resume-last` without a job record still
// finds threads named with them.
export const LEGACY_THREAD_PREFIXES = Object.freeze(["Codex Companion Task"]);
export const MAX_THREAD_PREFIX_LENGTH = 40;
export const MAX_TASK_NAME_LENGTH = 80;
const PROMPT_EXCERPT_LENGTH = 56;

function collapseWhitespace(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function shorten(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

/**
 * A thread name prefix: whitespace collapsed, 1 to 40 characters. `strict`
 * throws on anything else (user input); otherwise invalid counts as not set.
 */
export function normalizeThreadPrefix(value, { strict = true } = {}) {
  if (value == null) {
    return null;
  }
  const prefix = collapseWhitespace(value);
  if (!prefix || prefix.length > MAX_THREAD_PREFIX_LENGTH) {
    if (strict) {
      throw new Error(
        `Unsupported thread prefix "${value}". Use 1 to ${MAX_THREAD_PREFIX_LENGTH} characters, or unset.`
      );
    }
    return null;
  }
  return prefix;
}

/**
 * The name given with `task --name`: whitespace (line breaks included)
 * collapsed, at most 80 characters. An empty name is an error.
 */
export function normalizeTaskName(value) {
  if (value == null) {
    return null;
  }
  const name = collapseWhitespace(value);
  if (!name) {
    throw new Error("--name needs a non-empty name for the Codex thread.");
  }
  return shorten(name, MAX_TASK_NAME_LENGTH);
}

/**
 * @returns {{ prefix: string, source: "env" | "plugin-default" | "default", file?: string, invalidEnv?: string }}
 */
export function resolveThreadPrefix(env = process.env) {
  const raw = env?.[THREAD_PREFIX_ENV];
  let invalidEnv;
  if (raw !== undefined && String(raw).trim() !== "") {
    const fromEnv = normalizeThreadPrefix(raw, { strict: false });
    if (fromEnv) {
      return { prefix: fromEnv, source: "env" };
    }
    invalidEnv = String(raw);
  }
  const config = readUserConfig();
  const fromConfig = normalizeThreadPrefix(config.values[THREAD_PREFIX_CONFIG_KEY], { strict: false });
  if (fromConfig) {
    return { prefix: fromConfig, source: "plugin-default", file: config.file, ...(invalidEnv ? { invalidEnv } : {}) };
  }
  return { prefix: DEFAULT_THREAD_PREFIX, source: "default", ...(invalidEnv ? { invalidEnv } : {}) };
}

/**
 * "<prefix>: <name>" with the `--name` given, else "<prefix>: <start of the
 * prompt>", else just the prefix.
 */
export function buildTaskThreadName({ name = null, prompt = "", prefix = resolveThreadPrefix().prefix } = {}) {
  const label = name ? normalizeTaskName(name) : shorten(collapseWhitespace(prompt), PROMPT_EXCERPT_LENGTH);
  return label ? `${prefix}: ${label}` : prefix;
}

/** The prefixes task threads may carry: the current one first. */
export function taskThreadPrefixes(current = resolveThreadPrefix().prefix) {
  return [...new Set([current, DEFAULT_THREAD_PREFIX, ...LEGACY_THREAD_PREFIXES])];
}

/** Whether a thread name looks like one `task` gave (`prefix` or `prefix: ...`). */
export function isTaskThreadName(name, prefixes = taskThreadPrefixes()) {
  if (typeof name !== "string") {
    return false;
  }
  return prefixes.some((prefix) => name === prefix || name.startsWith(`${prefix}: `));
}
