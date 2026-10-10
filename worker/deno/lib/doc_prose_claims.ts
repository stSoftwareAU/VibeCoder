/**
 * Manual and prompt prose the PR's own diff writes, checked against the head
 * code (Issue #3347).
 *
 * Fleet PRs kept adding operator-manual or prompt sentences about the PR's own
 * new behaviour that the head code contradicts (GRQ-AutoTrader#2609, #2685,
 * #2699, VibeCoder#3308), after #3120 and #3232 asked for this in prose only.
 * The two model passes that read prose against head code, the first-run claim
 * check (`summary_claim_check.ts`, Issue #3257) and the review-fix drift check
 * (`pr_feedback_drift_check.ts`, Issue #3143), share this module's scope and
 * question so both ask the same thing about a changed Markdown line.
 *
 * Uses Australian English throughout.
 */

import { isPrSummaryPath } from "./change_request_quotes.ts";
import { isTestFilePath } from "./security_fix_gate.ts";
import { isWorkerStatePath } from "./worker_state_paths.ts";

/**
 * Cap on manual/prompt files one first-run claim question is asked about.
 * Files past it are reported as not checked, never passed.
 */
export const MAX_DOC_PROSE_FILES = 20;

const MAX_PATH_LENGTH = 500;
const LEGACY_SUMMARY_PATH = /^docs\/pr-summary-\d+\.md$/;

function hasUnsafeCharacter(path: string): boolean {
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
    if (code === 0x5c || code === 0x60) return true; // backslash, backtick
  }
  return false;
}

/**
 * Manual or prompt prose: Markdown outside `docs/archive/pr-summaries/`
 * (manuals, `SECURITY.md`, `CODING-STANDARDS.md`, `prompts/**\/prompt.md`),
 * never a PR summary, a test fixture or a worker state file. The shape check
 * matters because the path is interpolated into a model prompt and read from
 * disk.
 */
export function isManualProsePath(path: string): boolean {
  if (typeof path !== "string" || path === "" || path !== path.trim()) {
    return false;
  }
  if (path.length > MAX_PATH_LENGTH) return false;
  if (hasUnsafeCharacter(path)) return false;
  if (path.startsWith("/") || path.startsWith("-")) return false;
  if (path.split("/").some((s) => s === "" || s === "." || s === "..")) {
    return false;
  }
  if (!path.toLowerCase().endsWith(".md")) return false;
  if (path.startsWith("docs/archive/pr-summaries/")) return false;
  if (isPrSummaryPath(path)) return false;
  if (LEGACY_SUMMARY_PATH.test(path)) return false;
  if (isTestFilePath(path)) return false;
  if (isWorkerStatePath(path)) return false;
  return true;
}

/**
 * De-duplicate the changed files (first occurrence order), keep only manual
 * or prompt prose paths, and split them at `cap`.
 */
export function selectManualProseFiles(
  changedFiles: readonly string[],
  cap: number,
): { files: string[]; overCap: string[] } {
  if (!Number.isInteger(cap) || cap < 0) {
    throw new Error(`cap must be a non-negative integer, got ${cap}`);
  }
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const file of changedFiles) {
    if (seen.has(file)) continue;
    seen.add(file);
    if (isManualProsePath(file)) kept.push(file);
  }
  return { files: kept.slice(0, cap), overCap: kept.slice(cap) };
}

/** The shared question both prose-against-code passes ask. */
export function docProseClaimInstruction(
  change: "this branch's diff" | "this push's change",
): string {
  return "For each listed Markdown manual or prompt (a `.md` file that is " +
    "not a PR summary), check only the lines " + change +
    " adds or edits, and only sentences that say when the change's new " +
    "behaviour happens, what it refuses, rejects, allows or skips, or that " +
    'use an absolute word ("only", "never", "always", "any", "every", ' +
    '"all", "each", "automatically") or a counted or closed list ' +
    '("X, Y and Z are the …"). For each such sentence, open the head code ' +
    "that decides it — the branch condition, its callers, the list or set " +
    "it names — with Read or Grep, and report the sentence when that code " +
    "contradicts it: a condition the code never tests, a refusal the code " +
    "catches and carries on past, an entry the list does not hold, a path " +
    "the absolute word misses. Quote it verbatim, one per entry, with " +
    "`file` = that manual or prompt's path, and name the contradicting " +
    "`file:line` in `reason`. Do not report a sentence the head code agrees " +
    "with, or one you could not check.";
}
