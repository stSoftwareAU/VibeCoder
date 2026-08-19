/**
 * Canonical worker run id (Issue #2381).
 *
 * Every GitHub mutation the worker performs — commits, PR bodies,
 * issue/PR comments, issue creates — must be traceable back to the
 * specific worker run that produced it. This module is the single
 * source of truth for that run id and the formatting helpers that stamp
 * it onto each mutation:
 *
 *   - {@link getRunId} resolves a stable run id for the current worker
 *     invocation, generating one once and caching it in the
 *     `VIBE_RUN_ID` environment variable so every child `deno` command
 *     spawned by the same worker process inherits the same id.
 *   - {@link appendRunIdTrailer} / {@link assertRunIdTrailer} /
 *     {@link hasRunIdTrailer} handle the `Vibe-Coder-Run-Id` git commit
 *     trailer (the join key between the GitHub timeline and the worker
 *     logs).
 *   - {@link buildRunIdFooterLine} produces the compact footer line for
 *     comments and PR bodies.
 *   - {@link buildRunIdMetadataBlock} produces the machine-readable
 *     metadata block embedded in worker-filed issue bodies.
 *
 * Implements the "identity delegation" actionable improvements from
 * `docs/AGENT-ACCOUNTABILITY.md` (Theme 2).
 *
 * Australian English spelling throughout (behaviour, organisation,
 * authorised).
 */

import type { Result } from "../types.ts";

/** Environment variable holding the canonical run id for this invocation. */
export const RUN_ID_ENV_VAR = "VIBE_RUN_ID";

/** Git trailer key that stamps a commit with its originating run id. */
export const RUN_ID_TRAILER_KEY = "Vibe-Coder-Run-Id";

/** Prefix every generated run id carries, so the id is greppable. */
export const RUN_ID_PREFIX = "vibe";

/** Options for {@link generateRunId} (injectable for deterministic tests). */
export interface GenerateRunIdOptions {
  /** Millisecond epoch timestamp. Defaults to `Date.now()`. */
  now?: number;
  /** Random source in [0, 1). Defaults to `Math.random`. */
  random?: () => number;
}

/**
 * Generate a fresh run id.
 *
 * Format: `vibe-<base36 epoch ms>-<6 hex random>` (e.g.
 * `vibe-lkz3p9x-1a2b3c`). Compact, URL-safe, greppable by the `vibe-`
 * prefix, and unique per invocation without needing any system
 * permission.
 */
export function generateRunId(opts: GenerateRunIdOptions = {}): string {
  const now = opts.now ?? Date.now();
  const random = opts.random ?? Math.random;
  const ts = Math.max(0, Math.floor(now)).toString(36);
  const suffix = Math.floor(random() * 0x1000000)
    .toString(16)
    .padStart(6, "0")
    .slice(0, 6);
  return `${RUN_ID_PREFIX}-${ts}-${suffix}`;
}

/** Read an environment variable, tolerating a denied `--allow-env`. */
function readEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

/** Set an environment variable, tolerating a denied `--allow-env`. */
function trySetEnv(name: string, value: string): void {
  try {
    Deno.env.set(name, value);
  } catch {
    // Permission denied — the caller still gets the generated id back,
    // it just will not propagate to child processes on this run.
  }
}

/**
 * Resolve the canonical run id for the current worker invocation.
 *
 * If `VIBE_RUN_ID` is already set (by the shell entry point or a parent
 * worker process), that value is returned verbatim so every mutation
 * path on the same invocation shares one id. Otherwise a fresh id is
 * generated, cached into `VIBE_RUN_ID` (so subsequent calls and child
 * processes reuse it), and returned.
 */
export function getRunId(): string {
  const existing = readEnv(RUN_ID_ENV_VAR);
  if (existing !== undefined && existing.trim().length > 0) {
    return existing.trim();
  }
  const id = generateRunId();
  trySetEnv(RUN_ID_ENV_VAR, id);
  return id;
}

/** Matches a `Vibe-Coder-Run-Id: <value>` trailer line anywhere in a message. */
const TRAILER_RE = new RegExp(
  `^${RUN_ID_TRAILER_KEY}:[ \\t]*(\\S.*)$`,
  "mi",
);

/** Whether `message` already carries a non-empty run-id trailer. */
export function hasRunIdTrailer(message: string): boolean {
  return TRAILER_RE.test(message);
}

/** Matches a generic git trailer line (`Some-Key: value`). */
const GENERIC_TRAILER_LINE_RE = /^[A-Za-z][A-Za-z0-9-]*:[ \t]+\S/;

/**
 * Append the run-id trailer to a commit message.
 *
 * Idempotent — if the message already carries a `Vibe-Coder-Run-Id`
 * trailer it is returned unchanged. When the message already ends with a
 * git trailer block (e.g. a `Co-Authored-By:` line), the run-id trailer
 * is appended on the next line so it joins the same block; otherwise it
 * is appended as a new trailer block separated by a blank line.
 */
export function appendRunIdTrailer(message: string, runId: string): string {
  if (hasRunIdTrailer(message)) return message;
  const trimmed = message.replace(/\s+$/, "");
  const trailerLine = `${RUN_ID_TRAILER_KEY}: ${runId}`;

  const lines = trimmed.split("\n");
  const lastLine = lines[lines.length - 1] ?? "";
  if (GENERIC_TRAILER_LINE_RE.test(lastLine)) {
    // Existing trailer block — keep the run id in the same block.
    return `${trimmed}\n${trailerLine}`;
  }
  return `${trimmed}\n\n${trailerLine}`;
}

/**
 * Assert that a commit message carries the run-id trailer.
 *
 * This is the validator behind the pre-commit run-id gate: a commit
 * message lacking the trailer is rejected with an actionable error.
 */
export function assertRunIdTrailer(message: string): Result<void> {
  if (hasRunIdTrailer(message)) {
    return { ok: true, value: undefined };
  }
  return {
    ok: false,
    error: new Error(
      `Commit message is missing the required ${RUN_ID_TRAILER_KEY} trailer ` +
        `(Issue #2381). Append a line of the form "${RUN_ID_TRAILER_KEY}: <run-id>" ` +
        "so the commit is traceable back to its originating worker run.",
    ),
  };
}

/**
 * Build the compact run-id footer line for comments and PR bodies.
 *
 * Produces a single greppable line, e.g. ``Run id: `vibe-...` ``.
 */
export function buildRunIdFooterLine(runId: string): string {
  return `🏷️ Run id: \`${runId}\``;
}

/**
 * Build a machine-readable run-id metadata block for issue bodies.
 *
 * Worker-filed issues (security-scan, best-practices, test-audit,
 * github-actions-audit, and idle-task wrappers) embed this block so a
 * reviewer can join the issue back to the run that filed it. The block
 * is a fenced `key: value` snippet that scripts can parse without
 * guessing.
 */
export function buildRunIdMetadataBlock(runId: string): string {
  return ["```", `run-id: ${runId}`, "```"].join("\n");
}
