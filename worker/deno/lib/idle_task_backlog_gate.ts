/**
 * Output-backlog gate for the idle-task filer (Issue #2082).
 *
 * Before raising a new idle-task wrapper for template T against target
 * repo R, the filer checks how many open issues in R already carry T's
 * `outputLabel`. If the count meets or exceeds {@link BACKLOG_THRESHOLD}
 * (currently a fixed 6 — KISS, per the issue), the filer refuses to
 * stack another wrapper on top of an un-triaged batch.
 *
 * The threshold lives here as a single source of truth so any future
 * tunable can be promoted with one edit. The first consumer is the
 * security-scan template; later templates (bump-dependencies, etc.)
 * plug in by declaring their `outputLabel` — no per-template branching
 * in the filer.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { runGhCommand } from "./github.ts";

/**
 * Fixed backlog ceiling. When `≥ BACKLOG_THRESHOLD` open issues on the
 * target repo carry the template's `outputLabel`, the filer skips the
 * repo for this round.
 *
 * Kept fixed at 6 across every template per the Issue #2082 scope.
 * May be made configurable later if a template needs a different
 * number — change here when that happens.
 */
export const BACKLOG_THRESHOLD = 6;

export interface CountOpenIssuesByLabelOptions {
  /** Target repository in `owner/repo` form. */
  repo: string;
  /** Label whose open-issue count drives the backlog gate. */
  label: string;
  /** Injectable gh runner — defaults to the production retry wrapper. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /**
   * Stop counting once we know the answer is "at least this many".
   * Mirrors the `--limit` argument we pass to gh — gh would happily
   * return all matching issues, but we never need to count higher than
   * the threshold to make a decision.
   */
  cap?: number;
}

/**
 * Return the number of open issues in `repo` that carry `label`,
 * capped at `cap` (defaults to {@link BACKLOG_THRESHOLD}). A gh failure
 * or malformed JSON response is treated as zero — the gate must not
 * stall the filer on a transient lookup hiccup.
 */
export async function countOpenIssuesByLabel(
  opts: CountOpenIssuesByLabelOptions,
): Promise<number> {
  const gh = opts.ghCommandFn ?? runGhCommand;
  const cap = opts.cap ?? BACKLOG_THRESHOLD;
  let raw: string;
  try {
    raw = await gh([
      "issue",
      "list",
      "--repo",
      opts.repo,
      "--label",
      opts.label,
      "--state",
      "open",
      "--json",
      "number",
      "--limit",
      String(cap),
    ]);
  } catch {
    return 0;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 0;
  }
  if (!Array.isArray(parsed)) return 0;
  return parsed.length;
}
