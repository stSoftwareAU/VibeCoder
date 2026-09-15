/**
 * Sending a failed verification gate back to the agent rung (Issue #1965).
 *
 * A milestone sync whose textual conflicts are all resolved can still produce
 * a tree that does not compile: the default branch changed an interface the
 * milestone branch implements somewhere git never saw a conflict, so no hunk
 * overlapped and git merged the file cleanly. The gate then refuses a
 * resolution that is only a few lines short of correct — on
 * `GRQ-AutoTrader#292` a test fake missing one trait method, four lines
 * identical to its sibling on the default branch.
 *
 * That failure went straight to a human. This module is the rung it was
 * missing: a bounded number of repair runs on the same clone, each carrying
 * the gate's failing command and its output tail, the merged-in commits'
 * subjects and the same never-side-pick contract. The gate re-runs after each
 * one, and only a tree the gate still refuses reaches a human — with both
 * gate outputs.
 *
 * Nothing here judges the merge: a repair that changes nothing, a run the
 * worker ended, and a grant too small to cover a run are all reported as what
 * they are, never as a pass.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger, Result } from "../types.ts";
import { runGitCommand } from "./git_timeout.ts";
import type { GitCommandOptions } from "./git_timeout.ts";
import type { MergeGateOutcome } from "./milestone_merge_gate.ts";
import {
  type MilestoneConflictAgentFn,
  stageAgentResolution,
} from "./milestone_conflict_ladder.ts";
import { describeGitFailure } from "./milestone_merge_state.ts";
import type {
  GateRepairRecord,
  GateRepairRound,
} from "./milestone_sync_conflict.ts";

/**
 * Repair rounds one cycle may spend on one gate failure.
 *
 * Two, because one is demonstrably not enough: on
 * `GRQ-AutoTrader#304` the first repair — carrying a capital limit in its
 * authorised form through the default branch's new submit path — surfaced a
 * second semantic conflict in the branch's own tests. Bounded at two so a
 * repair that is not converging costs the cycle two runs, not the whole
 * budget.
 */
export const MAX_GATE_REPAIR_ROUNDS = 2;

/**
 * Agent seconds that must remain before a repair run is started at all.
 *
 * The same reasoning as the ladder's own floor (Issue #1693): a run started
 * with a minute left is a run the watchdog kills mid-edit, which leaves a
 * half-repaired tree and no verdict.
 */
export const MIN_GATE_REPAIR_SECONDS = 120;

/** Error name carried by an agent rung that has no budget left for a repair. */
export const GATE_REPAIR_NO_BUDGET_ERROR = "GateRepairNoBudget";

/**
 * The agent rung's refusal when the cycle's grant cannot cover a repair.
 *
 * Named rather than a bare `Error` so the loop can tell "there was no budget
 * for this" from "the run failed": the first is reported as a repair that was
 * never attempted, and the second as a repair that was.
 *
 * @param detail - What is left of the grant, and what a repair needs
 * @returns The refusal, ready to return as a failed `Result`
 */
export function gateRepairBudgetExhausted(detail: string): Error {
  const err = new Error(detail);
  err.name = GATE_REPAIR_NO_BUDGET_ERROR;
  return err;
}

/** Whether an error is the "no budget for a repair" refusal. */
export function isGateRepairBudgetExhausted(err: unknown): boolean {
  return err instanceof Error && err.name === GATE_REPAIR_NO_BUDGET_ERROR;
}

/** What the repair loop is asked to do. */
export interface GateRepairInput {
  /** The gate verdict that refused the resolution. */
  firstFailure: MergeGateOutcome;
  /** Re-runs the same verification over the merged tree. */
  gate: () => Promise<MergeGateOutcome>;
  /** The agent rung; absent means no repair is attempted. */
  agentFn?: MilestoneConflictAgentFn;
  /** Git options; `cwd` is the clone holding the merge. */
  options: GitCommandOptions;
  milestoneBranch: string;
  defaultBranch: string;
  /** The merge commit a repair is folded into. */
  mergeSha: string;
  /** Subjects of the commits the merge brought in. */
  mergedCommitSubjects: readonly string[];
  /** The paths that conflicted, as context; the repair is often elsewhere. */
  conflictedFiles?: readonly string[];
  /** Rounds allowed; defaults to {@link MAX_GATE_REPAIR_ROUNDS}. */
  maxRounds?: number;
  logger?: Logger;
}

/** What the repair loop left behind. */
export type GateRepairOutcome =
  /** The gate passed after the repair; the tree is ready to push. */
  | { status: "repaired"; gate: MergeGateOutcome; record: GateRepairRecord }
  /** A repair ran and the gate still refuses the tree. */
  | {
    status: "failed";
    gate: MergeGateOutcome;
    record: GateRepairRecord;
    detail: string;
  }
  /** No repair ran at all — no rung, no budget, or no merge to repair. */
  | { status: "not-attempted"; gate: MergeGateOutcome; detail: string };

/**
 * Subjects of the commits the merge brought in, newest first.
 *
 * The repair agent is reconciling *someone's change* with this branch, so the
 * commits on the other side are most of the intent it needs. Best-effort: a
 * log git could not produce degrades the prompt, and is never allowed to fail
 * the repair.
 *
 * @param options - Git options; `cwd` is the clone holding the merge
 * @param preMergeSha - Where the milestone branch stood before the merge
 * @param defaultRef - The default branch's tip that was merged in
 * @param limit - Most subjects to read
 * @returns The subjects, or an empty list when none could be read
 */
export async function readMergedCommitSubjects(
  options: GitCommandOptions,
  preMergeSha: string,
  defaultRef: string,
  limit = 20,
): Promise<string[]> {
  if (!preMergeSha || !defaultRef) return [];
  const log = await runGitCommand(
    [
      "log",
      "--no-merges",
      `--max-count=${limit}`,
      "--format=%s",
      `${preMergeSha}..${defaultRef}`,
    ],
    options,
  );
  if (!log.ok || log.value.code !== 0) return [];
  return log.value.stdout.trim().split("\n").filter(Boolean);
}

/**
 * Fold whatever the repair left behind into the merge commit's index.
 *
 * The repair prompt lets the agent stage or commit, exactly as the resolution
 * prompt does, so both shapes are handled the same way: a commit on top of
 * the merge is rewound with `reset --soft` so its content is staged again,
 * and the whole tree is then staged through the ladder's own staging path —
 * worker state files removed, the pre-commit safety gate applied.
 *
 * @param options - Git options; `cwd` is the clone holding the merge
 * @param mergeSha - The merge commit the repair belongs in
 * @returns The paths the repair changed, or the failure that stopped the fold
 */
async function foldRepairIntoMerge(
  options: GitCommandOptions,
  mergeSha: string,
): Promise<Result<string[]>> {
  const head = await runGitCommand(["rev-parse", "HEAD"], options);
  if (!head.ok || head.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `the repaired tree's HEAD could not be read: ${
          describeGitFailure(head)
        }`,
      ),
    };
  }
  if (head.value.stdout.trim() !== mergeSha) {
    // The agent committed its repair. Its content belongs in the merge
    // commit, not in a commit on top of it — a milestone branch that gains a
    // stray non-merge commit per repair is a branch nobody can read.
    const reset = await runGitCommand(["reset", "--soft", mergeSha], options);
    if (!reset.ok || reset.value.code !== 0) {
      return {
        ok: false,
        error: new Error(
          `the repair's own commit could not be folded back into the merge: ${
            describeGitFailure(reset)
          }`,
        ),
      };
    }
  }

  const staged = await stageAgentResolution(options);
  if (!staged.ok) return { ok: false, error: staged.error };

  const diff = await runGitCommand(
    ["diff", "--cached", "--name-only"],
    options,
  );
  if (!diff.ok || diff.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `the repair's own changes could not be listed: ${
          describeGitFailure(diff)
        }`,
      ),
    };
  }
  return {
    ok: true,
    value: diff.value.stdout.trim().split("\n").filter(Boolean),
  };
}

/**
 * Offer a failed verification back to the agent rung, then re-run it.
 *
 * @param input - The gate failure, the gate itself and the rung to offer it to
 * @returns Whether the tree was repaired, and what each round touched
 */
export async function repairGatedResolution(
  input: GateRepairInput,
): Promise<GateRepairOutcome> {
  const {
    firstFailure,
    gate,
    agentFn,
    options,
    milestoneBranch,
    defaultBranch,
    mergeSha,
    mergedCommitSubjects,
    conflictedFiles = [],
    logger,
  } = input;
  const maxRounds = input.maxRounds ?? MAX_GATE_REPAIR_ROUNDS;

  if (!agentFn) {
    return {
      status: "not-attempted",
      gate: firstFailure,
      detail: "no resolution agent was available to this sync",
    };
  }
  if (!mergeSha) {
    return {
      status: "not-attempted",
      gate: firstFailure,
      detail: "the merge commit could not be read, so a repair could not " +
        "have been folded into it",
    };
  }

  const rounds: GateRepairRound[] = [];
  let lastGate = firstFailure;
  /** Stop, saying what happened: a repair that ran is a repair that failed. */
  const stop = (detail: string): GateRepairOutcome =>
    rounds.length === 0
      ? { status: "not-attempted", gate: lastGate, detail }
      : {
        status: "failed",
        gate: lastGate,
        record: { failingCommand: firstFailure.detail, rounds },
        detail,
      };

  for (let round = 1; round <= maxRounds; round++) {
    logger?.info(
      `Milestone sync: the verification refused the resolution — offering ` +
        `repair round ${round} of ${maxRounds} to the agent rung ` +
        `(Issue #1965)`,
      { milestoneBranch, defaultBranch, failingCommand: lastGate.detail },
    );
    const outcome = await agentFn({
      conflictedFiles,
      milestoneBranch,
      defaultBranch,
      workDir: options.cwd ?? ".",
      repair: {
        round,
        maxRounds,
        failingCommand: lastGate.detail,
        output: lastGate.output,
        mergedCommitSubjects,
      },
    });

    if (!outcome.ok) {
      return stop(
        isGateRepairBudgetExhausted(outcome.error)
          ? `the repair was not attempted for want of budget — ${outcome.error.message}`
          : `repair round ${round} failed — ${outcome.error.message}`,
      );
    }
    if (outcome.value.terminated) {
      // Not a verdict on the tree: the worker ended the run (Issue #1693).
      return stop(
        `repair round ${round} was ended by the worker before it finished ` +
          `(Issue #1693)`,
      );
    }

    const folded = await foldRepairIntoMerge(options, mergeSha);
    if (!folded.ok) {
      return stop(`repair round ${round}: ${folded.error.message}`);
    }
    if (folded.value.length === 0) {
      // Re-running the gate over a tree nothing touched would spend the
      // verification budget to learn what it already said.
      return stop(`repair round ${round} changed nothing in the tree`);
    }
    rounds.push({ round, files: folded.value });

    lastGate = await gate();
    if (lastGate.status === "passed") {
      logger?.info(
        `Milestone sync: the repaired tree passes the verification ` +
          `(Issue #1965)`,
        { milestoneBranch, defaultBranch, round, files: folded.value },
      );
      return {
        status: "repaired",
        gate: lastGate,
        record: { failingCommand: firstFailure.detail, rounds },
      };
    }
  }

  return {
    status: "failed",
    gate: lastGate,
    record: { failingCommand: firstFailure.detail, rounds },
    detail: `${rounds.length} repair round(s) ran and the verification still ` +
      `refuses the tree`,
  };
}

/**
 * The note an escalation carries about the repair, with the first gate output.
 *
 * The refusal the caller builds already carries the *last* gate's output, so
 * this carries the first one and what happened in between — the reader needs
 * both to tell a repair that helped nothing from one that made it worse.
 *
 * @param firstFailure - The gate verdict that refused the first resolution
 * @param outcome - What the repair loop left behind
 * @returns The note, ready to append to the refusal
 */
export function describeRepairEscalation(
  firstFailure: MergeGateOutcome,
  outcome: GateRepairOutcome,
): string {
  const first = `The verification that refused the first resolution: ` +
    `${firstFailure.detail}${
      firstFailure.output ? `\n\n${firstFailure.output}` : ""
    }`;
  if (outcome.status === "not-attempted") {
    return `No repair was attempted (Issue #1965): ${outcome.detail}.\n\n` +
      first;
  }
  if (outcome.status === "repaired") {
    // Not an escalation shape, but never silently blank.
    return `The resolution was repaired and the verification passed ` +
      `(Issue #1965).\n\n${first}`;
  }
  const rounds = outcome.record.rounds.map((r) =>
    `- round ${r.round} — ${
      r.files.length > 0 ? r.files.join(", ") : "no file changed"
    }`
  ).join("\n");
  return `The resolution went back to the agent rung and the verification ` +
    `still refuses it (Issue #1965): ${outcome.detail}.\n\n` +
    `${rounds || "- (no repair round completed)"}\n\n${first}`;
}
