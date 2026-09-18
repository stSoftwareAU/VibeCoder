/**
 * The `merge-fallback` flag a milestone roll-back leaves behind
 * (Issue #2311, part of #2298).
 *
 * `merge_fallback_issue.ts` files the flag for both conflict paths and knows
 * nothing about either caller. This module is the milestone half of that
 * contract: it turns what the sync observed — the ledger's record of each
 * spent run, the conflicted files, how far behind the branch had fallen, and
 * what the roll-back reverted — into the filing, and reports the issue number
 * back so the roll-back notice can link it.
 *
 * It lives beside the roll-back rather than inside the 2,700-line sync module
 * because it is one job with one caller's worth of state, and because the
 * shapes it renders are worth testing without driving a whole sweep.
 *
 * **The fallback is never silent and never asks anyone.** A filing that failed
 * is said out loud and reported as `undefined`, so the notice tells the reader
 * the record is missing instead of linking to nothing.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { Result } from "../types.ts";
import { parseStageTimings } from "./conflict_stage_timer.ts";
import type {
  FileAnalysis,
  FileDecision,
} from "./milestone_conflict_triage.ts";
import type {
  MergeFallbackFiling,
  MergeFallbackOutcome,
  MergeFallbackRun,
} from "./merge_fallback_issue.ts";
import type { RollbackOutcome } from "./milestone_rollback.ts";
import type { ConflictAttemptRecord } from "./milestone_sync_streak.ts";

/** Runs `gh`, returning stdout; throws on failure. */
export type GhCommandFn = (args: string[]) => Promise<string>;

/** One self-heal event, as the sync's sink takes it. */
export type SelfHealEventFn = (event: {
  module: string;
  action: string;
  reason: string;
  result: "ok" | "skipped" | "failed";
}) => Promise<boolean>;

/** What the flag needs about the conflict behind a fallback. */
export interface FallbackContext {
  /** Files still conflicted when the budget ran out. */
  conflictedFiles?: readonly string[];
  /** Commits the branch was behind the default branch, when measured. */
  behindBy?: number;
  /** When it first went behind, as the compare read it. */
  behindSince?: string;
}

/** The branch a fallback ran on, as the flag names it. */
export interface FallbackBranch {
  milestoneBranch: string;
  defaultBranch: string;
}

/**
 * What one attempt made of the conflict, file by file (Issue #2311).
 *
 * The ladder writes its rung into each undecided file's reason, so these
 * lines are the run's own account — the half a one-line conclusion cannot
 * carry, and the half the flag's reader needs to see what was tried.
 *
 * @param error - The conflict escalation the attempt failed with
 * @returns The account, or an empty string when the error named no file
 */
export function describeConflictAnalyses(
  error: {
    analyses: readonly FileAnalysis[];
    resolved: readonly FileDecision[];
  },
): string {
  const undecided = error.analyses.map((a) => `- \`${a.path}\` — ${a.reason}`);
  const settled = error.resolved.map((d) => `- \`${d.path}\` — ${d.reason}`);
  return [
    ...(undecided.length > 0
      ? ["Files no rung could settle:", ...undecided]
      : []),
    ...(settled.length > 0
      ? ["", "Files the ladder did settle:", ...settled]
      : []),
  ].join("\n").trim();
}

/**
 * When the branch first fell behind, read from the tip it was last level
 * with (Issue #2311).
 *
 * One compare on the rare fallback path: the first commit the branch is
 * missing is the moment it went behind. Best-effort — an unreadable compare
 * leaves the field out, and the flag says `not recorded` rather than guessing
 * a date.
 *
 * @param repo - Repository in `owner/repo` form
 * @param lastSyncedDefaultSha - The tip the branch was last level with
 * @param defaultBranch - The branch it has fallen behind
 * @param ghCommandFn - Runs `gh`
 * @param log - Where a failed compare is said out loud
 * @returns `{ behindSince }`, or `{}` when it could not be read
 */
export async function readBehindSince(
  repo: string,
  lastSyncedDefaultSha: string | undefined,
  defaultBranch: string,
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
): Promise<{ behindSince?: string }> {
  if (!lastSyncedDefaultSha) return {};
  try {
    const out = await ghCommandFn([
      "api",
      `repos/${repo}/compare/${lastSyncedDefaultSha}...${defaultBranch}`,
      "--jq",
      ".commits[0].commit.committer.date",
    ]);
    const date = out.trim();
    return date && date !== "null" ? { behindSince: date } : {};
  } catch (err) {
    log(
      `WARNING: Could not read when '${defaultBranch}' in ${repo} moved past ` +
        `${lastSyncedDefaultSha}: ${
          err instanceof Error ? err.message : String(err)
        } — the merge-fallback flag records it as unknown (Issue #2311)`,
    );
    return {};
  }
}

/**
 * One `merge-fallback` run, built from the ledger's record of it
 * (Issue #2311).
 *
 * @param record - The concluded attempt, as the ledger kept it
 * @param run - 1-based run number, in the order the budget spent them
 */
export function fallbackRun(
  record: ConflictAttemptRecord,
  run: number,
): MergeFallbackRun {
  const parsed = record.timings === undefined
    ? undefined
    : parseStageTimings(record.timings);
  const host = record.host ?? parsed?.host;
  // The one-line conclusion is always worth saying; the file-by-file account
  // joins it when the attempt recorded one.
  const analysis = [
    `Concluded \`${record.outcome}\` at ${record.at}: ${record.reason}`,
    ...(record.analysis ? [record.analysis] : []),
  ].join("\n\n");
  return {
    run,
    analysis,
    ...(host ? { host } : {}),
    ...(parsed && parsed.stages.length > 0 ? { timings: parsed.stages } : {}),
  };
}

/**
 * What the flag says was closed or reverted (Issue #2311).
 *
 * Both outcomes are named, because both are a fallback: one reverted the
 * children in the way, the other could not and left the branch where it
 * stood.
 */
export function describeFallbackAction(
  outcome: RollbackOutcome,
  defaultBranch: string,
): string {
  const reverted = outcome.reverted.map((child) =>
    `PR #${child.prNumber}${child.sha ? ` (revert \`${child.sha}\`)` : ""}`
  );
  return outcome.merged
    ? `Reverted newest-first so \`${defaultBranch}\` merges cleanly, and ` +
      `re-queued: ${reverted.join(", ") || "nothing to revert"}.`
    : `The roll-back could not make \`${defaultBranch}\` merge cleanly: ` +
      `${outcome.reason ?? "roll-back did not merge"}. Nothing was left ` +
      `reverted beyond ${reverted.join(", ") || "nothing"}.`;
}

/** Everything one filing needs. */
export interface FileFallbackFlagOptions {
  repo: string;
  branch: FallbackBranch;
  /** The runs the budget actually spent, oldest first. */
  runs: readonly ConflictAttemptRecord[];
  outcome: RollbackOutcome;
  fallback: FallbackContext;
  fileMergeFallbackFn: (
    filing: MergeFallbackFiling,
  ) => Promise<Result<MergeFallbackOutcome>>;
  log: (message: string) => void;
  emitSelfHealEvent?: SelfHealEventFn;
}

/**
 * File (or append to) the one `merge-fallback` flag this fallback leaves
 * behind (Issue #2311).
 *
 * Every roll-back files it, whether or not the roll-back itself merged: the
 * flag is the durable record of a conflict two runs could not settle, and it
 * is the only issue the milestone path ever files for one. A filing that
 * failed is said out loud and returns `undefined`, so the notice says the
 * record is missing rather than linking to nothing.
 *
 * @returns The flag issue number, or undefined when it could not be filed
 */
export async function fileFallbackFlag(
  opts: FileFallbackFlagOptions,
): Promise<number | undefined> {
  const { repo, branch, outcome, fallback, log } = opts;

  const filed = await opts.fileMergeFallbackFn({
    target: {
      kind: "milestone",
      repo,
      milestoneBranch: branch.milestoneBranch,
      defaultBranch: branch.defaultBranch,
    },
    ...(fallback.conflictedFiles && fallback.conflictedFiles.length > 0
      ? { conflictedFiles: fallback.conflictedFiles }
      : {}),
    runs: opts.runs.map((record, index) => fallbackRun(record, index + 1)),
    ...(fallback.behindBy !== undefined ? { behindBy: fallback.behindBy } : {}),
    ...(fallback.behindSince !== undefined
      ? { behindSince: fallback.behindSince }
      : {}),
    fallbackAction: describeFallbackAction(outcome, branch.defaultBranch),
  });

  if (!filed.ok) {
    log(
      `WARNING: Could not file the merge-fallback flag for ` +
        `'${branch.milestoneBranch}' in ${repo}: ${filed.error.message} — ` +
        `the fallback still ran, but nothing durable records it ` +
        `(Issue #2311)`,
    );
    return undefined;
  }

  log(
    `${filed.value.appended ? "Appended to" : "Filed"} the merge-fallback ` +
      `flag #${filed.value.issueNumber} for '${branch.milestoneBranch}' ` +
      `in ${repo} (Issue #2311)`,
  );
  await opts.emitSelfHealEvent?.({
    module: "milestone_branch_sync",
    action: "fallback_flagged",
    reason: `${repo} branch ${branch.milestoneBranch}: merge-fallback ` +
      `flag #${filed.value.issueNumber}${
        filed.value.appended ? " (appended)" : ""
      }`,
    result: "ok",
  }).catch(() => undefined);
  return filed.value.issueNumber > 0 ? filed.value.issueNumber : undefined;
}
