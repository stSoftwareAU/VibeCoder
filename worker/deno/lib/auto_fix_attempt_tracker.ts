/**
 * Auto-fix attempt cap, keyed on a stable failure signature (Issue #3582).
 *
 * The existing CI retry counter (`pr_ci_checks.ts`) keys on the GitHub
 * check-run id, which is new on every push — so each attempted fix resets
 * the counter and the cap never binds. This module keys instead on a
 * signature composed of durable parts (repo + failure locus + check name +
 * a fingerprint of the normalised log excerpt), so three attempts at the
 * same underlying failure count 1, 2, 3 and the fourth is refused.
 *
 * **The tally itself lives on the pull request** (Issue #1879). Until then
 * each attempt was persisted to `$HOME/auto-issue-work/.ci_check_state/
 * <signature>.autofix.json`, a directory no other host can see, so every
 * host spent its own three attempts and posted its own copy of the same
 * diagnosis — nine comments in 76 minutes on one pull request. The record
 * is now the fleet-authored marker `ci_fix_attempt_markers.ts` writes into
 * the comment each attempt posts, which every host reads. This module is
 * therefore pure: it composes the signature, decides whether the cap binds,
 * and renders the consolidated summary; it performs no I/O at all.
 *
 * Design decisions worth stating explicitly:
 *
 * - **`infrastructure`-category failures do not consume an attempt**
 *   (see {@link consumesAutoFixAttempt}). A transient runner error, DNS
 *   blip or 503 is not evidence that the worker cannot fix the code, so
 *   spending the human-escalation budget on it would escalate healthy
 *   repos. Every other category consumes an attempt.
 * - **The signature is logged on every attempt** so an operator can audit
 *   the sequence in the worker log and spot a signature that is too
 *   unstable (cap never binds) or too stable (a new failure inherits a
 *   spent budget).
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { WorkerConfig } from "../types.ts";
import type { CiFailureCategory } from "./ci_failure_classifier.ts";
import { neutraliseAgentMarkers } from "./agent_marker_neutralisation.ts";

/** Default attempt budget per failure signature. */
export const DEFAULT_MAX_AUTO_FIX_ATTEMPTS = 3;

/** Where the failure lives — a PR, or a failure issue in issue mode. */
export interface FailureLocus {
  kind: "pr" | "issue";
  number: number;
}

/** Inputs from which a failure signature is composed. */
export interface FailureSignatureInput {
  /** Repository in "owner/repo" format. */
  repo: string;
  /** PR number, or the failure-issue number in issue mode. */
  locus: FailureLocus;
  /** Name of the failing check. */
  checkName: string;
  /** Root-cause log excerpt (normalised before hashing). */
  logExcerpt?: string;
  /**
   * Workspace root stripped from paths before hashing, so the same
   * failure fingerprints identically across machines and runners.
   */
  workspaceRoot?: string;
}

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

/**
 * Normalise a log excerpt so two attempts at the same failure fingerprint
 * identically.
 *
 * Strips the volatile parts that change on every build — ISO timestamps,
 * dates, clock times, build/run/job numbers, URL build segments, memory
 * addresses, durations, and the workspace root prefix — then lower-cases
 * and collapses whitespace. Everything durable (the error text, the file
 * and line, the symbol name) survives, so a genuinely different failure
 * still normalises differently.
 *
 * @param excerpt - Raw log excerpt.
 * @param workspaceRoot - Optional absolute workspace root to strip.
 * @returns The normalised excerpt.
 */
export function normaliseLogExcerpt(
  excerpt: string,
  workspaceRoot?: string,
): string {
  let text = excerpt;

  if (workspaceRoot && workspaceRoot.length > 0) {
    text = text.replaceAll(workspaceRoot, "<ws>");
  }

  return text
    // ISO-8601 timestamps first — they contain a date and a time.
    .replace(/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?z?/gi, "<ts>")
    .replace(/\d{4}-\d{2}-\d{2}/g, "<date>")
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, "<time>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<addr>")
    .replace(/\b(build|run|job|attempt|pipeline)\s*#?\d+/gi, "$1 <n>")
    .replace(/(https?:\/\/\S*?\/)\d+(?=\/|\s|$)/g, "$1<n>")
    .replace(/(?<![\w#])#\d+\b/g, "#<n>")
    .replace(/\b\d+(?:\.\d+)?\s?m?s\b/gi, "<dur>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Compute a stable failure signature.
 *
 * Composed from durable parts only — check-run ids are deliberately
 * excluded because they are new on every push.
 *
 * @param input - Repo, locus, check name and log excerpt.
 * @returns A filename-safe signature string.
 */
export function computeFailureSignature(input: FailureSignatureInput): string {
  const fingerprint = normaliseLogExcerpt(
    input.logExcerpt ?? "",
    input.workspaceRoot,
  );
  const material = [
    input.repo.trim().toLowerCase(),
    `${input.locus.kind}:${input.locus.number}`,
    input.checkName.trim().toLowerCase(),
    fingerprint,
  ].join("\0");

  return fnv1a64Hex(material);
}

/**
 * 64-bit FNV-1a hash, rendered as 16 lower-case hex characters.
 *
 * A non-cryptographic hash is sufficient here — the signature is a state
 * key, not a security boundary — and keeps the function synchronous, so
 * callers need no `crypto.subtle` await or extra permissions.
 */
function fnv1a64Hex(input: string): string {
  const prime = 1099511628211n;
  const mask = 0xffffffffffffffffn;
  let hash = 14695981039346656037n;

  const bytes = new TextEncoder().encode(input);
  for (const byte of bytes) {
    hash = (hash ^ BigInt(byte)) * prime & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

// ---------------------------------------------------------------------------
// Cap decisions
// ---------------------------------------------------------------------------

/**
 * Whether the recorded attempts have exhausted the budget.
 *
 * @param attemptCount - Attempts already recorded for the signature.
 * @param maxAttempts - Configured budget.
 */
export function hasReachedAutoFixCap(
  attemptCount: number,
  maxAttempts: number,
): boolean {
  return attemptCount >= maxAttempts;
}

/**
 * Whether a failure of this category should consume an attempt.
 *
 * `infrastructure` failures do not: a transient runner error, DNS failure
 * or upstream 5xx says nothing about the worker's ability to fix the code,
 * so charging it against the human-escalation budget would escalate
 * perfectly healthy repos. Every other category consumes an attempt.
 */
export function consumesAutoFixAttempt(
  category: CiFailureCategory | undefined,
): boolean {
  return category !== "infrastructure";
}

/**
 * Resolve the effective attempt budget for a repository.
 *
 * Per-repo `maxAutoFixAttempts` wins over the global setting; non-integer
 * or non-positive values (config arrives untrusted from `.config.json`)
 * fall back to the global setting, and an invalid global falls back to
 * {@link DEFAULT_MAX_AUTO_FIX_ATTEMPTS}.
 */
export function resolveMaxAutoFixAttempts(
  config: Pick<WorkerConfig, "maxAutoFixAttempts" | "repoConfig">,
  repo: string,
): number {
  const globalValue = positiveIntegerOr(
    config.maxAutoFixAttempts,
    DEFAULT_MAX_AUTO_FIX_ATTEMPTS,
  );
  const override = config.repoConfig?.[repo]?.maxAutoFixAttempts;
  return positiveIntegerOr(override, globalValue);
}

function positiveIntegerOr(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Consolidated escalation summary
// ---------------------------------------------------------------------------

/**
 * One attempt as the consolidated summary renders it (Issue #1879).
 *
 * Every field is read straight off a fleet-authored attempt marker and the
 * comment that carried it, so the summary is assembled from what the pull
 * request itself records rather than from a host-local file.
 */
export interface AutoFixCapAttempt {
  /** 1-based attempt number the marker stated. */
  attempt: number;
  /** What the attempt did, in prose ("pushed a fix; still not green"). */
  outcome: string;
  /**
   * The attempt comment's own first line — the agent's diagnosis.
   *
   * Comment prose, so it is escaped for the Markdown table cell it lands in
   * rather than trusted.
   */
  diagnosis: string;
}

/** Inputs for {@link buildAutoFixCapSummary}. */
export interface AutoFixCapSummaryInput {
  /** Name of the failing check. */
  checkName: string;
  /** The failure signature — printed so the sequence is auditable. */
  signature: string;
  /** Configured attempt budget. */
  maxAttempts: number;
  /** Every attempt the pull request records for this signature. */
  attempts: readonly AutoFixCapAttempt[];
}

/**
 * Build the single consolidated summary posted when the cap binds.
 *
 * One comment covering every attempt — deliberately not a fourth
 * "I tried again" note.
 *
 * Issue #2260: the fleet account posts this body, and its markers are the
 * fleet-wide CI-fix record. Two of the values rendered here are outside the
 * worker's control — the check name (fork-chosen on a `pull_request`-triggered
 * workflow) and each attempt's `diagnosis`, lifted from a comment body — so the
 * finished summary is made inert as a whole by construction. It carries no
 * marker of the worker's own; the escalation's marker is added afterwards.
 */
export function buildAutoFixCapSummary(
  input: AutoFixCapSummaryInput,
): string {
  const { checkName, signature, maxAttempts, attempts } = input;
  const lines: string[] = [
    `The worker has spent its ${maxAttempts} automatic fix attempts on the failing check **${checkName}** without reaching a green build, so it has stopped and is handing over.`,
    "",
    `Failure signature: \`${signature}\` (stable across pushes — every attempt below is the same underlying failure).`,
    "",
  ];

  if (attempts.length === 0) {
    lines.push(
      "No attempt detail was recorded — see the worker log for the attempt history.",
    );
    return neutraliseAgentMarkers(lines.join("\n")).text;
  }

  lines.push("| Attempt | Outcome | Diagnosed |");
  lines.push("| ------- | ------- | --------- |");
  for (const [index, attempt] of attempts.entries()) {
    lines.push(
      `| ${attempt.attempt || index + 1} | ${cell(attempt.outcome)} | ${
        cell(attempt.diagnosis)
      } |`,
    );
  }
  return neutraliseAgentMarkers(lines.join("\n")).text;
}

/** Escape a value for safe inclusion in a Markdown table cell. */
function cell(value: string): string {
  const text = value.trim().replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  return text.length > 0 ? text : "_not recorded_";
}
