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
import {
  describeGateRepair,
  type GateRepairRecord,
  type GateRepairRound,
  listGateRepairRounds,
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

/**
 * Whether an error is the "no budget for a repair" refusal.
 *
 * @param err - The error the agent rung returned
 * @returns True only for {@link gateRepairBudgetExhausted}'s refusal
 */
export function isGateRepairBudgetExhausted(err: unknown): boolean {
  return err instanceof Error && err.name === GATE_REPAIR_NO_BUDGET_ERROR;
}

/**
 * The verdict a resolution is judged by (Issue #1559).
 *
 * A tree that defines nothing to run verified nothing, so `skipped` is a
 * refusal rather than a pass. It is **not** a repairable failure either: an
 * agent asked to fix a check that never ran is asked to fix nothing, and
 * offering it the cycle's grant spends the budget to arrive at the same
 * refusal (Issue #1965).
 *
 * @param outcome - The gate's own verdict
 * @returns The verdict to report; `skipped` becomes a named refusal
 */
export function judgeResolutionVerdict(
  outcome: MergeGateOutcome,
): MergeGateOutcome {
  return outcome.status === "skipped"
    ? {
      ...outcome,
      status: "failed" as const,
      detail: `${outcome.detail} — an automatic conflict resolution that ` +
        `cannot be verified is not a resolution (Issue #1559)`,
    }
    : outcome;
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
 * @param logger - Says why the context is missing when git could not read it
 * @returns The subjects, or an empty list when none could be read
 */
export async function readMergedCommitSubjects(
  options: GitCommandOptions,
  preMergeSha: string,
  defaultRef: string,
  limit = 20,
  logger?: Logger,
): Promise<string[]> {
  if (!preMergeSha || !defaultRef) {
    logger?.warn(
      "Milestone sync: the repair prompt carries no merged-commit subjects — " +
        "one side of the merge is unknown (Issue #1965)",
      { preMergeSha, defaultRef },
    );
    return [];
  }
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
  if (!log.ok || log.value.code !== 0) {
    // Degraded, and said so: a repair prompt without the other side's intent
    // is weaker, and a silent gap is one nobody would ever diagnose.
    logger?.warn(
      `Milestone sync: the merged commits' subjects could not be read for ` +
        `the repair prompt (Issue #1965): ${describeGitFailure(log)}`,
      { preMergeSha, defaultRef },
    );
    return [];
  }
  return log.value.stdout.trim().split("\n").filter(Boolean);
}

/**
 * The tree the index currently holds, as a tree object id.
 *
 * Each round is measured against the one before it: reading `git diff
 * --cached` against the merge commit instead would report round one's files
 * as round two's, and would make "this round changed nothing" impossible to
 * detect after the first round.
 *
 * @param options - Git options; `cwd` is the clone holding the merge
 * @returns The tree id, or the failure that stopped it being written
 */
async function writeIndexTree(
  options: GitCommandOptions,
): Promise<Result<string>> {
  const tree = await runGitCommand(["write-tree"], options);
  if (!tree.ok || tree.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `the tree could not be recorded: ${describeGitFailure(tree)}`,
      ),
    };
  }
  return { ok: true, value: tree.value.stdout.trim() };
}

/**
 * Fold whatever the repair left behind into the merge commit's index.
 *
 * The repair prompt lets the agent stage or commit, exactly as the resolution
 * prompt does, so both shapes are handled the same way: a commit **on top of**
 * the merge is rewound with `reset --soft` so its content is staged again,
 * and the whole tree is then staged through the ladder's own staging path —
 * worker state files removed, the pre-commit safety gate applied.
 *
 * A HEAD that is not a descendant of the merge commit is the one shape that
 * is refused rather than absorbed: the agent rewound, reverted or recreated
 * the branch, and rewinding it back would silently bless whichever side it
 * dropped — the side-pick the contract forbids, arriving as history rather
 * than as a hunk.
 *
 * @param options - Git options; `cwd` is the clone holding the merge
 * @param mergeSha - The merge commit the repair belongs in
 * @param treeBefore - The tree this round started from
 * @returns The paths this round changed, or the failure that stopped the fold
 */
async function foldRepairIntoMerge(
  options: GitCommandOptions,
  mergeSha: string,
  treeBefore: string,
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
    const descends = await runGitCommand(
      ["merge-base", "--is-ancestor", mergeSha, "HEAD"],
      options,
    );
    if (!descends.ok || descends.value.code !== 0) {
      return {
        ok: false,
        error: new Error(
          `the repair moved the branch off the merge commit ${mergeSha} ` +
            `instead of building on it — the merge was rewound, reverted or ` +
            `recreated, which is a side-pick by another route and is refused`,
        ),
      };
    }
    // An ordinary commit on top of the merge: its content belongs in the
    // merge commit, not in a stray commit a milestone branch then carries.
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

  const treeAfter = await writeIndexTree(options);
  if (!treeAfter.ok) return { ok: false, error: treeAfter.error };

  const diff = await runGitCommand(
    ["diff", "--name-only", treeBefore, treeAfter.value],
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
  /**
   * Stop with a repair that was attempted and did not save the tree.
   *
   * A run that failed, was ended by the worker, changed nothing or could not
   * be folded in is a repair that *ran*: reporting it as "not attempted"
   * would tell the reader the opposite of what happened. Only a rung that was
   * never asked — no agent, no merge to repair, no budget — is not-attempted.
   */
  const stop = (detail: string): GateRepairOutcome => ({
    status: "failed",
    gate: lastGate,
    record: { failingCommand: firstFailure.detail, rounds },
    detail,
  });

  for (let round = 1; round <= maxRounds; round++) {
    // Measure this round against the tree it starts from, so round two
    // reports its own files and its own "changed nothing".
    const treeBefore = await writeIndexTree(options);
    if (!treeBefore.ok) {
      return stop(`repair round ${round}: ${treeBefore.error.message}`);
    }
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
      if (isGateRepairBudgetExhausted(outcome.error)) {
        // The rung refused before it ran, so nothing was repaired and the
        // escalation must say exactly that.
        const detail =
          `the repair was not attempted for want of budget — ${outcome.error.message}`;
        return rounds.length === 0
          ? { status: "not-attempted", gate: lastGate, detail }
          : stop(detail);
      }
      return stop(`repair round ${round} failed — ${outcome.error.message}`);
    }
    if (outcome.value.terminated) {
      // Not a verdict on the tree: the worker ended the run (Issue #1693).
      return stop(
        `repair round ${round} was ended by the worker before it finished ` +
          `(Issue #1693)`,
      );
    }
    if (outcome.value.providerUnavailable !== undefined) {
      // Nor is a provider that refused the run — a 402, say (Issue #2613).
      return stop(
        `repair round ${round} was not run — the agent provider was ` +
          `unavailable: ${outcome.value.providerUnavailable} (Issue #2613)`,
      );
    }

    const folded = await foldRepairIntoMerge(
      options,
      mergeSha,
      treeBefore.value,
    );
    if (!folded.ok) {
      return stop(`repair round ${round}: ${folded.error.message}`);
    }
    if (folded.value.length === 0) {
      // Re-running the gate over a tree nothing touched would spend the
      // verification budget to learn what it already said.
      return stop(`repair round ${round} changed nothing in the tree`);
    }
    rounds.push({ round, files: folded.value });

    const verdict = await gate();
    lastGate = judgeResolutionVerdict(verdict);
    if (verdict.status === "skipped") {
      // Nothing ran, so there is nothing a further repair could answer.
      return stop(
        `repair round ${round}: ${lastGate.detail} — no further repair can ` +
          `answer a verification that does not run`,
      );
    }
    if (verdict.status === "passed") {
      logger?.info(
        `Milestone sync: the repaired tree passes the verification ` +
          `(Issue #1965)`,
        { milestoneBranch, defaultBranch, round, files: folded.value },
      );
      return {
        status: "repaired",
        gate: verdict,
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

/** What {@link runGateWithRepair} produced for the push path to act on. */
export interface GateWithRepairResult {
  /** The verdict the push path must honour — the last one taken. */
  gate: MergeGateOutcome;
  /**
   * The first verdict, which is the one a repair was offered. Identical to
   * `gate` when no repair ran, and what the escalation quotes alongside the
   * last one so both outputs reach the reader.
   */
  firstGate: MergeGateOutcome;
  /** What the repair rung did, when the first verdict was a refusal. */
  repair?: GateRepairOutcome;
  /**
   * Set when the repaired tree could not be re-committed. The caller refuses
   * the resolution and puts the branch back: a repair that is not in the
   * merge commit is a repair nothing would record.
   */
  amendFailure?: string;
}

/** Everything {@link runGateWithRepair} needs to verify, repair and record. */
export interface GateWithRepairInput extends
  Omit<
    GateRepairInput,
    "firstFailure" | "mergeSha" | "mergedCommitSubjects"
  > {
  /** Where the milestone branch stood before the merge. */
  preMergeSha: string;
  /** The default branch's tip that was merged in. */
  defaultRef: string;
  /** The merge commit's message, which the repair is appended to. */
  resolutionMessage: string;
}

/**
 * Verify the merged tree, repair what the verification refuses, and record it.
 *
 * The gate runs here rather than inside the push path because that path
 * resets a refused merge away at once, and a resolution reset away cannot be
 * repaired (Issue #1965). A repaired tree is folded into the merge commit and
 * the commit message names the repair, so the record survives the run.
 *
 * @param input - The gate, the rung, the clone and the commit to amend
 * @returns The verdict for the push path, the repair, and any amend failure
 */
export async function runGateWithRepair(
  input: GateWithRepairInput,
): Promise<GateWithRepairResult> {
  const {
    gate,
    options,
    preMergeSha,
    defaultRef,
    resolutionMessage,
    logger,
  } = input;

  const verdict = await gate();
  // A pass needs nothing, and a `skipped` verification is a refusal no agent
  // can answer — only a genuine check failure buys a repair run.
  if (verdict.status !== "failed") {
    const firstGate = judgeResolutionVerdict(verdict);
    return { gate: firstGate, firstGate };
  }
  const firstGate = verdict;

  const mergeShaResult = await runGitCommand(["rev-parse", "HEAD"], options);
  const mergeSha = mergeShaResult.ok && mergeShaResult.value.code === 0
    ? mergeShaResult.value.stdout.trim()
    : "";

  const repair = await repairGatedResolution({
    ...input,
    firstFailure: firstGate,
    mergeSha,
    mergedCommitSubjects: await readMergedCommitSubjects(
      options,
      preMergeSha,
      defaultRef,
      undefined,
      logger,
    ),
  });
  if (repair.status !== "repaired") {
    return { gate: repair.gate, firstGate, repair };
  }

  const amended = await runGitCommand(
    [
      "commit",
      "--amend",
      "-m",
      `${resolutionMessage}\n\n${describeGateRepair(repair.record)}`,
    ],
    options,
  );
  if (!amended.ok || amended.value.code !== 0) {
    return {
      gate: repair.gate,
      firstGate,
      repair,
      amendFailure:
        `the repaired resolution could not be committed (Issue #1965): ${
          describeGitFailure(amended)
        }`,
    };
  }
  return { gate: repair.gate, firstGate, repair };
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
  if (outcome.status === "not-attempted") {
    // The refusal this note is appended to already carries this very output,
    // so repeating it here would double the compiler wall #1542 was about.
    return `No repair was attempted (Issue #1965): ${outcome.detail}.`;
  }
  if (outcome.status === "repaired") {
    // Not an escalation shape, but never silently blank.
    return `The resolution was repaired and the verification passed ` +
      `(Issue #1965).`;
  }
  const rounds = listGateRepairRounds(outcome.record.rounds);
  // Here the two outputs genuinely differ — the refusal carries the last one,
  // and the reader needs the first to see whether the repair helped at all.
  const first = `The verification that refused the first resolution: ` +
    `${firstFailure.detail}${
      firstFailure.output ? `\n\n${firstFailure.output}` : ""
    }`;
  return `The resolution went back to the agent rung and the verification ` +
    `still refuses it (Issue #1965): ${outcome.detail}.\n\n` +
    `${rounds || "- (no repair round completed)"}\n\n${first}`;
}
