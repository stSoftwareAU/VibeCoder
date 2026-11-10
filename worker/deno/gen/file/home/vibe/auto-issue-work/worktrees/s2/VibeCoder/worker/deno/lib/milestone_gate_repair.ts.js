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
 * A gate failure carrying a {@link RustToolchainGap} (Issue #3255) is not
 * offered a repair at all: the host's `rustc` being older than a workspace
 * package's `rust-version` is an environment fault, and no agent editing the
 * tree can change what toolchain the container runs. A dependency-only
 * refusal carries no gap, so it is offered a repair like any other failure.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { runGitCommand } from "./git_timeout.ts";
import { stageAgentResolution } from "./milestone_conflict_ladder.ts";
import { describeGitFailure } from "./milestone_merge_state.ts";
import { describeGateRepair, listGateRepairRounds } from "./milestone_sync_conflict.ts";
/**
 * Repair rounds one cycle may spend on one gate failure.
 *
 * Two, because one is demonstrably not enough: on
 * `GRQ-AutoTrader#304` the first repair — carrying a capital limit in its
 * authorised form through the default branch's new submit path — surfaced a
 * second semantic conflict in the branch's own tests. Bounded at two so a
 * repair that is not converging costs the cycle two runs, not the whole
 * budget.
 */ export const MAX_GATE_REPAIR_ROUNDS = 2;
/**
 * Agent seconds that must remain before a repair run is started at all.
 *
 * The same reasoning as the ladder's own floor (Issue #1693): a run started
 * with a minute left is a run the watchdog kills mid-edit, which leaves a
 * half-repaired tree and no verdict.
 */ export const MIN_GATE_REPAIR_SECONDS = 120;
/** Error name carried by an agent rung that has no budget left for a repair. */ export const GATE_REPAIR_NO_BUDGET_ERROR = "GateRepairNoBudget";
/**
 * The agent rung's refusal when the cycle's grant cannot cover a repair.
 *
 * Named rather than a bare `Error` so the loop can tell "there was no budget
 * for this" from "the run failed": the first is reported as a repair that was
 * never attempted, and the second as a repair that was.
 *
 * @param detail - What is left of the grant, and what a repair needs
 * @returns The refusal, ready to return as a failed `Result`
 */ export function gateRepairBudgetExhausted(detail) {
  const err = new Error(detail);
  err.name = GATE_REPAIR_NO_BUDGET_ERROR;
  return err;
}
/**
 * Whether an error is the "no budget for a repair" refusal.
 *
 * @param err - The error the agent rung returned
 * @returns True only for {@link gateRepairBudgetExhausted}'s refusal
 */ export function isGateRepairBudgetExhausted(err) {
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
 * The one exception is a merge-only gate (Issue #4326), which marks its
 * `skipped` verdict `landUnverified` because the host cannot afford the build.
 *
 * @param outcome - The gate's own verdict
 * @returns The verdict to report; `skipped` becomes a named refusal
 */ export function judgeResolutionVerdict(outcome) {
  return outcome.status === "skipped" && outcome.landUnverified !== true ? {
    ...outcome,
    status: "failed",
    detail: `${outcome.detail} — an automatic conflict resolution that ` + `cannot be verified is not a resolution (Issue #1559)`
  } : outcome;
}
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
 */ export async function readMergedCommitSubjects(options, preMergeSha, defaultRef, limit = 20, logger) {
  if (!preMergeSha || !defaultRef) {
    logger?.warn("Milestone sync: the repair prompt carries no merged-commit subjects — " + "one side of the merge is unknown (Issue #1965)", {
      preMergeSha,
      defaultRef
    });
    return [];
  }
  const log = await runGitCommand([
    "log",
    "--no-merges",
    `--max-count=${limit}`,
    "--format=%s",
    `${preMergeSha}..${defaultRef}`
  ], options);
  if (!log.ok || log.value.code !== 0) {
    // Degraded, and said so: a repair prompt without the other side's intent
    // is weaker, and a silent gap is one nobody would ever diagnose.
    logger?.warn(`Milestone sync: the merged commits' subjects could not be read for ` + `the repair prompt (Issue #1965): ${describeGitFailure(log)}`, {
      preMergeSha,
      defaultRef
    });
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
 */ async function writeIndexTree(options) {
  const tree = await runGitCommand([
    "write-tree"
  ], options);
  if (!tree.ok || tree.value.code !== 0) {
    return {
      ok: false,
      error: new Error(`the tree could not be recorded: ${describeGitFailure(tree)}`)
    };
  }
  return {
    ok: true,
    value: tree.value.stdout.trim()
  };
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
 */ async function foldRepairIntoMerge(options, mergeSha, treeBefore) {
  const head = await runGitCommand([
    "rev-parse",
    "HEAD"
  ], options);
  if (!head.ok || head.value.code !== 0) {
    return {
      ok: false,
      error: new Error(`the repaired tree's HEAD could not be read: ${describeGitFailure(head)}`)
    };
  }
  if (head.value.stdout.trim() !== mergeSha) {
    const descends = await runGitCommand([
      "merge-base",
      "--is-ancestor",
      mergeSha,
      "HEAD"
    ], options);
    if (!descends.ok || descends.value.code !== 0) {
      return {
        ok: false,
        error: new Error(`the repair moved the branch off the merge commit ${mergeSha} ` + `instead of building on it — the merge was rewound, reverted or ` + `recreated, which is a side-pick by another route and is refused`)
      };
    }
    // An ordinary commit on top of the merge: its content belongs in the
    // merge commit, not in a stray commit a milestone branch then carries.
    const reset = await runGitCommand([
      "reset",
      "--soft",
      mergeSha
    ], options);
    if (!reset.ok || reset.value.code !== 0) {
      return {
        ok: false,
        error: new Error(`the repair's own commit could not be folded back into the merge: ${describeGitFailure(reset)}`)
      };
    }
  }
  const staged = await stageAgentResolution(options);
  if (!staged.ok) return {
    ok: false,
    error: staged.error
  };
  const treeAfter = await writeIndexTree(options);
  if (!treeAfter.ok) return {
    ok: false,
    error: treeAfter.error
  };
  const diff = await runGitCommand([
    "diff",
    "--name-only",
    treeBefore,
    treeAfter.value
  ], options);
  if (!diff.ok || diff.value.code !== 0) {
    return {
      ok: false,
      error: new Error(`the repair's own changes could not be listed: ${describeGitFailure(diff)}`)
    };
  }
  return {
    ok: true,
    value: diff.value.stdout.trim().split("\n").filter(Boolean)
  };
}
/**
 * Offer a failed verification back to the agent rung, then re-run it.
 *
 * @param input - The gate failure, the gate itself and the rung to offer it to
 * @returns Whether the tree was repaired, and what each round touched
 */ export async function repairGatedResolution(input) {
  const { firstFailure, gate, agentFn, options, milestoneBranch, defaultBranch, mergeSha, mergedCommitSubjects, conflictedFiles = [], logger } = input;
  const maxRounds = input.maxRounds ?? MAX_GATE_REPAIR_ROUNDS;
  if (!agentFn) {
    return {
      status: "not-attempted",
      gate: firstFailure,
      detail: "no resolution agent was available to this sync"
    };
  }
  if (!mergeSha) {
    return {
      status: "not-attempted",
      gate: firstFailure,
      detail: "the merge commit could not be read, so a repair could not " + "have been folded into it"
    };
  }
  const rounds = [];
  let lastGate = firstFailure;
  /**
   * Stop with a repair that was attempted and did not save the tree.
   *
   * A run that failed, was ended by the worker, changed nothing or could not
   * be folded in is a repair that *ran*: reporting it as "not attempted"
   * would tell the reader the opposite of what happened. Only a rung that was
   * never asked — no agent, no merge to repair, no budget — is not-attempted.
   */ const stop = (detail)=>({
      status: "failed",
      gate: lastGate,
      record: {
        failingCommand: firstFailure.detail,
        rounds
      },
      detail
    });
  for(let round = 1; round <= maxRounds; round++){
    // Measure this round against the tree it starts from, so round two
    // reports its own files and its own "changed nothing".
    const treeBefore = await writeIndexTree(options);
    if (!treeBefore.ok) {
      return stop(`repair round ${round}: ${treeBefore.error.message}`);
    }
    logger?.info(`Milestone sync: the verification refused the resolution — offering ` + `repair round ${round} of ${maxRounds} to the agent rung ` + `(Issue #1965)`, {
      milestoneBranch,
      defaultBranch,
      failingCommand: lastGate.detail
    });
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
        mergedCommitSubjects
      }
    });
    if (!outcome.ok) {
      if (isGateRepairBudgetExhausted(outcome.error)) {
        // The rung refused before it ran, so nothing was repaired and the
        // escalation must say exactly that.
        const detail = `the repair was not attempted for want of budget — ${outcome.error.message}`;
        return rounds.length === 0 ? {
          status: "not-attempted",
          gate: lastGate,
          detail
        } : stop(detail);
      }
      return stop(`repair round ${round} failed — ${outcome.error.message}`);
    }
    if (outcome.value.terminated) {
      // Not a verdict on the tree: the worker ended the run (Issue #1693).
      return stop(`repair round ${round} was ended by the worker before it finished ` + `(Issue #1693)`);
    }
    if (outcome.value.providerUnavailable !== undefined) {
      // Nor is a provider that refused the run — a 402, say (Issue #2613).
      return stop(`repair round ${round} was not run — the agent provider was ` + `unavailable: ${outcome.value.providerUnavailable} (Issue #2613)`);
    }
    const folded = await foldRepairIntoMerge(options, mergeSha, treeBefore.value);
    if (!folded.ok) {
      return stop(`repair round ${round}: ${folded.error.message}`);
    }
    if (folded.value.length === 0) {
      // Re-running the gate over a tree nothing touched would spend the
      // verification budget to learn what it already said.
      return stop(`repair round ${round} changed nothing in the tree`);
    }
    rounds.push({
      round,
      files: folded.value
    });
    const verdict = await gate();
    // Issue #4326: only the first verdict may land unverified. A tree whose
    // real verification failed and was then repaired must not be pushed on a
    // later gate that did not run.
    lastGate = judgeResolutionVerdict(verdict.status === "skipped" ? {
      ...verdict,
      landUnverified: false
    } : verdict);
    if (verdict.status === "skipped") {
      // Nothing ran, so there is nothing a further repair could answer.
      return stop(`repair round ${round}: ${lastGate.detail} — no further repair can ` + `answer a verification that does not run`);
    }
    if (verdict.status === "passed") {
      logger?.info(`Milestone sync: the repaired tree passes the verification ` + `(Issue #1965)`, {
        milestoneBranch,
        defaultBranch,
        round,
        files: folded.value
      });
      return {
        status: "repaired",
        gate: verdict,
        record: {
          failingCommand: firstFailure.detail,
          rounds
        }
      };
    }
  }
  return {
    status: "failed",
    gate: lastGate,
    record: {
      failingCommand: firstFailure.detail,
      rounds
    },
    detail: `${rounds.length} repair round(s) ran and the verification still ` + `refuses the tree`
  };
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
 */ export async function runGateWithRepair(input) {
  const { gate, options, preMergeSha, defaultRef, resolutionMessage, logger } = input;
  const verdict = await gate();
  // A pass needs nothing, and a `skipped` verification is a refusal no agent
  // can answer — only a genuine check failure buys a repair run.
  if (verdict.status !== "failed") {
    const firstGate = judgeResolutionVerdict(verdict);
    return {
      gate: firstGate,
      firstGate
    };
  }
  const firstGate = verdict;
  // Issue #3255: a host `rustc` older than the merged tree's `rust-version`
  // is an environment fault, not a bad resolution — no repair round can
  // raise the container's Rust pin, so none is offered.
  if (verdict.toolchainGap) {
    const repair = {
      status: "not-attempted",
      gate: verdict,
      detail: "the host's Rust toolchain is older than the merged tree " + "requires — an environment fault no repair round can fix " + "(Issue #3255)"
    };
    return {
      gate: verdict,
      firstGate: verdict,
      repair
    };
  }
  const mergeShaResult = await runGitCommand([
    "rev-parse",
    "HEAD"
  ], options);
  const mergeSha = mergeShaResult.ok && mergeShaResult.value.code === 0 ? mergeShaResult.value.stdout.trim() : "";
  const repair = await repairGatedResolution({
    ...input,
    firstFailure: firstGate,
    mergeSha,
    mergedCommitSubjects: await readMergedCommitSubjects(options, preMergeSha, defaultRef, undefined, logger)
  });
  if (repair.status !== "repaired") {
    return {
      gate: repair.gate,
      firstGate,
      repair
    };
  }
  const amended = await runGitCommand([
    "commit",
    "--amend",
    "-m",
    `${resolutionMessage}\n\n${describeGateRepair(repair.record)}`
  ], options);
  if (!amended.ok || amended.value.code !== 0) {
    return {
      gate: repair.gate,
      firstGate,
      repair,
      amendFailure: `the repaired resolution could not be committed (Issue #1965): ${describeGitFailure(amended)}`
    };
  }
  return {
    gate: repair.gate,
    firstGate,
    repair
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
 */ export function describeRepairEscalation(firstFailure, outcome) {
  if (outcome.status === "not-attempted") {
    // The refusal this note is appended to already carries this very output,
    // so repeating it here would double the compiler wall #1542 was about.
    return `No repair was attempted (Issue #1965): ${outcome.detail}.`;
  }
  if (outcome.status === "repaired") {
    // Not an escalation shape, but never silently blank.
    return `The resolution was repaired and the verification passed ` + `(Issue #1965).`;
  }
  const rounds = listGateRepairRounds(outcome.record.rounds);
  // Here the two outputs genuinely differ — the refusal carries the last one,
  // and the reader needs the first to see whether the repair helped at all.
  const first = `The verification that refused the first resolution: ` + `${firstFailure.detail}${firstFailure.output ? `\n\n${firstFailure.output}` : ""}`;
  return `The resolution went back to the agent rung and the verification ` + `still refuses it (Issue #1965): ${outcome.detail}.\n\n` + `${rounds || "- (no repair round completed)"}\n\n${first}`;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9taWxlc3RvbmVfZ2F0ZV9yZXBhaXIudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBTZW5kaW5nIGEgZmFpbGVkIHZlcmlmaWNhdGlvbiBnYXRlIGJhY2sgdG8gdGhlIGFnZW50IHJ1bmcgKElzc3VlICMxOTY1KS5cbiAqXG4gKiBBIG1pbGVzdG9uZSBzeW5jIHdob3NlIHRleHR1YWwgY29uZmxpY3RzIGFyZSBhbGwgcmVzb2x2ZWQgY2FuIHN0aWxsIHByb2R1Y2VcbiAqIGEgdHJlZSB0aGF0IGRvZXMgbm90IGNvbXBpbGU6IHRoZSBkZWZhdWx0IGJyYW5jaCBjaGFuZ2VkIGFuIGludGVyZmFjZSB0aGVcbiAqIG1pbGVzdG9uZSBicmFuY2ggaW1wbGVtZW50cyBzb21ld2hlcmUgZ2l0IG5ldmVyIHNhdyBhIGNvbmZsaWN0LCBzbyBubyBodW5rXG4gKiBvdmVybGFwcGVkIGFuZCBnaXQgbWVyZ2VkIHRoZSBmaWxlIGNsZWFubHkuIFRoZSBnYXRlIHRoZW4gcmVmdXNlcyBhXG4gKiByZXNvbHV0aW9uIHRoYXQgaXMgb25seSBhIGZldyBsaW5lcyBzaG9ydCBvZiBjb3JyZWN0IOKAlCBvblxuICogYEdSUS1BdXRvVHJhZGVyIzI5MmAgYSB0ZXN0IGZha2UgbWlzc2luZyBvbmUgdHJhaXQgbWV0aG9kLCBmb3VyIGxpbmVzXG4gKiBpZGVudGljYWwgdG8gaXRzIHNpYmxpbmcgb24gdGhlIGRlZmF1bHQgYnJhbmNoLlxuICpcbiAqIFRoYXQgZmFpbHVyZSB3ZW50IHN0cmFpZ2h0IHRvIGEgaHVtYW4uIFRoaXMgbW9kdWxlIGlzIHRoZSBydW5nIGl0IHdhc1xuICogbWlzc2luZzogYSBib3VuZGVkIG51bWJlciBvZiByZXBhaXIgcnVucyBvbiB0aGUgc2FtZSBjbG9uZSwgZWFjaCBjYXJyeWluZ1xuICogdGhlIGdhdGUncyBmYWlsaW5nIGNvbW1hbmQgYW5kIGl0cyBvdXRwdXQgdGFpbCwgdGhlIG1lcmdlZC1pbiBjb21taXRzJ1xuICogc3ViamVjdHMgYW5kIHRoZSBzYW1lIG5ldmVyLXNpZGUtcGljayBjb250cmFjdC4gVGhlIGdhdGUgcmUtcnVucyBhZnRlciBlYWNoXG4gKiBvbmUsIGFuZCBvbmx5IGEgdHJlZSB0aGUgZ2F0ZSBzdGlsbCByZWZ1c2VzIHJlYWNoZXMgYSBodW1hbiDigJQgd2l0aCBib3RoXG4gKiBnYXRlIG91dHB1dHMuXG4gKlxuICogTm90aGluZyBoZXJlIGp1ZGdlcyB0aGUgbWVyZ2U6IGEgcmVwYWlyIHRoYXQgY2hhbmdlcyBub3RoaW5nLCBhIHJ1biB0aGVcbiAqIHdvcmtlciBlbmRlZCwgYW5kIGEgZ3JhbnQgdG9vIHNtYWxsIHRvIGNvdmVyIGEgcnVuIGFyZSBhbGwgcmVwb3J0ZWQgYXMgd2hhdFxuICogdGhleSBhcmUsIG5ldmVyIGFzIGEgcGFzcy5cbiAqXG4gKiBBIGdhdGUgZmFpbHVyZSBjYXJyeWluZyBhIHtAbGluayBSdXN0VG9vbGNoYWluR2FwfSAoSXNzdWUgIzMyNTUpIGlzIG5vdFxuICogb2ZmZXJlZCBhIHJlcGFpciBhdCBhbGw6IHRoZSBob3N0J3MgYHJ1c3RjYCBiZWluZyBvbGRlciB0aGFuIGEgd29ya3NwYWNlXG4gKiBwYWNrYWdlJ3MgYHJ1c3QtdmVyc2lvbmAgaXMgYW4gZW52aXJvbm1lbnQgZmF1bHQsIGFuZCBubyBhZ2VudCBlZGl0aW5nIHRoZVxuICogdHJlZSBjYW4gY2hhbmdlIHdoYXQgdG9vbGNoYWluIHRoZSBjb250YWluZXIgcnVucy4gQSBkZXBlbmRlbmN5LW9ubHlcbiAqIHJlZnVzYWwgY2FycmllcyBubyBnYXAsIHNvIGl0IGlzIG9mZmVyZWQgYSByZXBhaXIgbGlrZSBhbnkgb3RoZXIgZmFpbHVyZS5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IExvZ2dlciwgUmVzdWx0IH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5pbXBvcnQgeyBydW5HaXRDb21tYW5kIH0gZnJvbSBcIi4vZ2l0X3RpbWVvdXQudHNcIjtcbmltcG9ydCB0eXBlIHsgR2l0Q29tbWFuZE9wdGlvbnMgfSBmcm9tIFwiLi9naXRfdGltZW91dC50c1wiO1xuaW1wb3J0IHR5cGUgeyBNZXJnZUdhdGVPdXRjb21lIH0gZnJvbSBcIi4vbWlsZXN0b25lX21lcmdlX2dhdGUudHNcIjtcbmltcG9ydCB7XG4gIHR5cGUgTWlsZXN0b25lQ29uZmxpY3RBZ2VudEZuLFxuICBzdGFnZUFnZW50UmVzb2x1dGlvbixcbn0gZnJvbSBcIi4vbWlsZXN0b25lX2NvbmZsaWN0X2xhZGRlci50c1wiO1xuaW1wb3J0IHsgZGVzY3JpYmVHaXRGYWlsdXJlIH0gZnJvbSBcIi4vbWlsZXN0b25lX21lcmdlX3N0YXRlLnRzXCI7XG5pbXBvcnQge1xuICBkZXNjcmliZUdhdGVSZXBhaXIsXG4gIHR5cGUgR2F0ZVJlcGFpclJlY29yZCxcbiAgdHlwZSBHYXRlUmVwYWlyUm91bmQsXG4gIGxpc3RHYXRlUmVwYWlyUm91bmRzLFxufSBmcm9tIFwiLi9taWxlc3RvbmVfc3luY19jb25mbGljdC50c1wiO1xuXG4vKipcbiAqIFJlcGFpciByb3VuZHMgb25lIGN5Y2xlIG1heSBzcGVuZCBvbiBvbmUgZ2F0ZSBmYWlsdXJlLlxuICpcbiAqIFR3bywgYmVjYXVzZSBvbmUgaXMgZGVtb25zdHJhYmx5IG5vdCBlbm91Z2g6IG9uXG4gKiBgR1JRLUF1dG9UcmFkZXIjMzA0YCB0aGUgZmlyc3QgcmVwYWlyIOKAlCBjYXJyeWluZyBhIGNhcGl0YWwgbGltaXQgaW4gaXRzXG4gKiBhdXRob3Jpc2VkIGZvcm0gdGhyb3VnaCB0aGUgZGVmYXVsdCBicmFuY2gncyBuZXcgc3VibWl0IHBhdGgg4oCUIHN1cmZhY2VkIGFcbiAqIHNlY29uZCBzZW1hbnRpYyBjb25mbGljdCBpbiB0aGUgYnJhbmNoJ3Mgb3duIHRlc3RzLiBCb3VuZGVkIGF0IHR3byBzbyBhXG4gKiByZXBhaXIgdGhhdCBpcyBub3QgY29udmVyZ2luZyBjb3N0cyB0aGUgY3ljbGUgdHdvIHJ1bnMsIG5vdCB0aGUgd2hvbGVcbiAqIGJ1ZGdldC5cbiAqL1xuZXhwb3J0IGNvbnN0IE1BWF9HQVRFX1JFUEFJUl9ST1VORFMgPSAyO1xuXG4vKipcbiAqIEFnZW50IHNlY29uZHMgdGhhdCBtdXN0IHJlbWFpbiBiZWZvcmUgYSByZXBhaXIgcnVuIGlzIHN0YXJ0ZWQgYXQgYWxsLlxuICpcbiAqIFRoZSBzYW1lIHJlYXNvbmluZyBhcyB0aGUgbGFkZGVyJ3Mgb3duIGZsb29yIChJc3N1ZSAjMTY5Myk6IGEgcnVuIHN0YXJ0ZWRcbiAqIHdpdGggYSBtaW51dGUgbGVmdCBpcyBhIHJ1biB0aGUgd2F0Y2hkb2cga2lsbHMgbWlkLWVkaXQsIHdoaWNoIGxlYXZlcyBhXG4gKiBoYWxmLXJlcGFpcmVkIHRyZWUgYW5kIG5vIHZlcmRpY3QuXG4gKi9cbmV4cG9ydCBjb25zdCBNSU5fR0FURV9SRVBBSVJfU0VDT05EUyA9IDEyMDtcblxuLyoqIEVycm9yIG5hbWUgY2FycmllZCBieSBhbiBhZ2VudCBydW5nIHRoYXQgaGFzIG5vIGJ1ZGdldCBsZWZ0IGZvciBhIHJlcGFpci4gKi9cbmV4cG9ydCBjb25zdCBHQVRFX1JFUEFJUl9OT19CVURHRVRfRVJST1IgPSBcIkdhdGVSZXBhaXJOb0J1ZGdldFwiO1xuXG4vKipcbiAqIFRoZSBhZ2VudCBydW5nJ3MgcmVmdXNhbCB3aGVuIHRoZSBjeWNsZSdzIGdyYW50IGNhbm5vdCBjb3ZlciBhIHJlcGFpci5cbiAqXG4gKiBOYW1lZCByYXRoZXIgdGhhbiBhIGJhcmUgYEVycm9yYCBzbyB0aGUgbG9vcCBjYW4gdGVsbCBcInRoZXJlIHdhcyBubyBidWRnZXRcbiAqIGZvciB0aGlzXCIgZnJvbSBcInRoZSBydW4gZmFpbGVkXCI6IHRoZSBmaXJzdCBpcyByZXBvcnRlZCBhcyBhIHJlcGFpciB0aGF0IHdhc1xuICogbmV2ZXIgYXR0ZW1wdGVkLCBhbmQgdGhlIHNlY29uZCBhcyBhIHJlcGFpciB0aGF0IHdhcy5cbiAqXG4gKiBAcGFyYW0gZGV0YWlsIC0gV2hhdCBpcyBsZWZ0IG9mIHRoZSBncmFudCwgYW5kIHdoYXQgYSByZXBhaXIgbmVlZHNcbiAqIEByZXR1cm5zIFRoZSByZWZ1c2FsLCByZWFkeSB0byByZXR1cm4gYXMgYSBmYWlsZWQgYFJlc3VsdGBcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdhdGVSZXBhaXJCdWRnZXRFeGhhdXN0ZWQoZGV0YWlsOiBzdHJpbmcpOiBFcnJvciB7XG4gIGNvbnN0IGVyciA9IG5ldyBFcnJvcihkZXRhaWwpO1xuICBlcnIubmFtZSA9IEdBVEVfUkVQQUlSX05PX0JVREdFVF9FUlJPUjtcbiAgcmV0dXJuIGVycjtcbn1cblxuLyoqXG4gKiBXaGV0aGVyIGFuIGVycm9yIGlzIHRoZSBcIm5vIGJ1ZGdldCBmb3IgYSByZXBhaXJcIiByZWZ1c2FsLlxuICpcbiAqIEBwYXJhbSBlcnIgLSBUaGUgZXJyb3IgdGhlIGFnZW50IHJ1bmcgcmV0dXJuZWRcbiAqIEByZXR1cm5zIFRydWUgb25seSBmb3Ige0BsaW5rIGdhdGVSZXBhaXJCdWRnZXRFeGhhdXN0ZWR9J3MgcmVmdXNhbFxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNHYXRlUmVwYWlyQnVkZ2V0RXhoYXVzdGVkKGVycjogdW5rbm93bik6IGJvb2xlYW4ge1xuICByZXR1cm4gZXJyIGluc3RhbmNlb2YgRXJyb3IgJiYgZXJyLm5hbWUgPT09IEdBVEVfUkVQQUlSX05PX0JVREdFVF9FUlJPUjtcbn1cblxuLyoqXG4gKiBUaGUgdmVyZGljdCBhIHJlc29sdXRpb24gaXMganVkZ2VkIGJ5IChJc3N1ZSAjMTU1OSkuXG4gKlxuICogQSB0cmVlIHRoYXQgZGVmaW5lcyBub3RoaW5nIHRvIHJ1biB2ZXJpZmllZCBub3RoaW5nLCBzbyBgc2tpcHBlZGAgaXMgYVxuICogcmVmdXNhbCByYXRoZXIgdGhhbiBhIHBhc3MuIEl0IGlzICoqbm90KiogYSByZXBhaXJhYmxlIGZhaWx1cmUgZWl0aGVyOiBhblxuICogYWdlbnQgYXNrZWQgdG8gZml4IGEgY2hlY2sgdGhhdCBuZXZlciByYW4gaXMgYXNrZWQgdG8gZml4IG5vdGhpbmcsIGFuZFxuICogb2ZmZXJpbmcgaXQgdGhlIGN5Y2xlJ3MgZ3JhbnQgc3BlbmRzIHRoZSBidWRnZXQgdG8gYXJyaXZlIGF0IHRoZSBzYW1lXG4gKiByZWZ1c2FsIChJc3N1ZSAjMTk2NSkuXG4gKlxuICogVGhlIG9uZSBleGNlcHRpb24gaXMgYSBtZXJnZS1vbmx5IGdhdGUgKElzc3VlICM0MzI2KSwgd2hpY2ggbWFya3MgaXRzXG4gKiBgc2tpcHBlZGAgdmVyZGljdCBgbGFuZFVudmVyaWZpZWRgIGJlY2F1c2UgdGhlIGhvc3QgY2Fubm90IGFmZm9yZCB0aGUgYnVpbGQuXG4gKlxuICogQHBhcmFtIG91dGNvbWUgLSBUaGUgZ2F0ZSdzIG93biB2ZXJkaWN0XG4gKiBAcmV0dXJucyBUaGUgdmVyZGljdCB0byByZXBvcnQ7IGBza2lwcGVkYCBiZWNvbWVzIGEgbmFtZWQgcmVmdXNhbFxuICovXG5leHBvcnQgZnVuY3Rpb24ganVkZ2VSZXNvbHV0aW9uVmVyZGljdChcbiAgb3V0Y29tZTogTWVyZ2VHYXRlT3V0Y29tZSxcbik6IE1lcmdlR2F0ZU91dGNvbWUge1xuICByZXR1cm4gb3V0Y29tZS5zdGF0dXMgPT09IFwic2tpcHBlZFwiICYmIG91dGNvbWUubGFuZFVudmVyaWZpZWQgIT09IHRydWVcbiAgICA/IHtcbiAgICAgIC4uLm91dGNvbWUsXG4gICAgICBzdGF0dXM6IFwiZmFpbGVkXCIgYXMgY29uc3QsXG4gICAgICBkZXRhaWw6IGAke291dGNvbWUuZGV0YWlsfSDigJQgYW4gYXV0b21hdGljIGNvbmZsaWN0IHJlc29sdXRpb24gdGhhdCBgICtcbiAgICAgICAgYGNhbm5vdCBiZSB2ZXJpZmllZCBpcyBub3QgYSByZXNvbHV0aW9uIChJc3N1ZSAjMTU1OSlgLFxuICAgIH1cbiAgICA6IG91dGNvbWU7XG59XG5cbi8qKiBXaGF0IHRoZSByZXBhaXIgbG9vcCBpcyBhc2tlZCB0byBkby4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgR2F0ZVJlcGFpcklucHV0IHtcbiAgLyoqIFRoZSBnYXRlIHZlcmRpY3QgdGhhdCByZWZ1c2VkIHRoZSByZXNvbHV0aW9uLiAqL1xuICBmaXJzdEZhaWx1cmU6IE1lcmdlR2F0ZU91dGNvbWU7XG4gIC8qKiBSZS1ydW5zIHRoZSBzYW1lIHZlcmlmaWNhdGlvbiBvdmVyIHRoZSBtZXJnZWQgdHJlZS4gKi9cbiAgZ2F0ZTogKCkgPT4gUHJvbWlzZTxNZXJnZUdhdGVPdXRjb21lPjtcbiAgLyoqIFRoZSBhZ2VudCBydW5nOyBhYnNlbnQgbWVhbnMgbm8gcmVwYWlyIGlzIGF0dGVtcHRlZC4gKi9cbiAgYWdlbnRGbj86IE1pbGVzdG9uZUNvbmZsaWN0QWdlbnRGbjtcbiAgLyoqIEdpdCBvcHRpb25zOyBgY3dkYCBpcyB0aGUgY2xvbmUgaG9sZGluZyB0aGUgbWVyZ2UuICovXG4gIG9wdGlvbnM6IEdpdENvbW1hbmRPcHRpb25zO1xuICBtaWxlc3RvbmVCcmFuY2g6IHN0cmluZztcbiAgZGVmYXVsdEJyYW5jaDogc3RyaW5nO1xuICAvKiogVGhlIG1lcmdlIGNvbW1pdCBhIHJlcGFpciBpcyBmb2xkZWQgaW50by4gKi9cbiAgbWVyZ2VTaGE6IHN0cmluZztcbiAgLyoqIFN1YmplY3RzIG9mIHRoZSBjb21taXRzIHRoZSBtZXJnZSBicm91Z2h0IGluLiAqL1xuICBtZXJnZWRDb21taXRTdWJqZWN0czogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBUaGUgcGF0aHMgdGhhdCBjb25mbGljdGVkLCBhcyBjb250ZXh0OyB0aGUgcmVwYWlyIGlzIG9mdGVuIGVsc2V3aGVyZS4gKi9cbiAgY29uZmxpY3RlZEZpbGVzPzogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBSb3VuZHMgYWxsb3dlZDsgZGVmYXVsdHMgdG8ge0BsaW5rIE1BWF9HQVRFX1JFUEFJUl9ST1VORFN9LiAqL1xuICBtYXhSb3VuZHM/OiBudW1iZXI7XG4gIGxvZ2dlcj86IExvZ2dlcjtcbn1cblxuLyoqIFdoYXQgdGhlIHJlcGFpciBsb29wIGxlZnQgYmVoaW5kLiAqL1xuZXhwb3J0IHR5cGUgR2F0ZVJlcGFpck91dGNvbWUgPVxuICAvKiogVGhlIGdhdGUgcGFzc2VkIGFmdGVyIHRoZSByZXBhaXI7IHRoZSB0cmVlIGlzIHJlYWR5IHRvIHB1c2guICovXG4gIHwgeyBzdGF0dXM6IFwicmVwYWlyZWRcIjsgZ2F0ZTogTWVyZ2VHYXRlT3V0Y29tZTsgcmVjb3JkOiBHYXRlUmVwYWlyUmVjb3JkIH1cbiAgLyoqIEEgcmVwYWlyIHJhbiBhbmQgdGhlIGdhdGUgc3RpbGwgcmVmdXNlcyB0aGUgdHJlZS4gKi9cbiAgfCB7XG4gICAgc3RhdHVzOiBcImZhaWxlZFwiO1xuICAgIGdhdGU6IE1lcmdlR2F0ZU91dGNvbWU7XG4gICAgcmVjb3JkOiBHYXRlUmVwYWlyUmVjb3JkO1xuICAgIGRldGFpbDogc3RyaW5nO1xuICB9XG4gIC8qKiBObyByZXBhaXIgcmFuIGF0IGFsbCDigJQgbm8gcnVuZywgbm8gYnVkZ2V0LCBvciBubyBtZXJnZSB0byByZXBhaXIuICovXG4gIHwgeyBzdGF0dXM6IFwibm90LWF0dGVtcHRlZFwiOyBnYXRlOiBNZXJnZUdhdGVPdXRjb21lOyBkZXRhaWw6IHN0cmluZyB9O1xuXG4vKipcbiAqIFN1YmplY3RzIG9mIHRoZSBjb21taXRzIHRoZSBtZXJnZSBicm91Z2h0IGluLCBuZXdlc3QgZmlyc3QuXG4gKlxuICogVGhlIHJlcGFpciBhZ2VudCBpcyByZWNvbmNpbGluZyAqc29tZW9uZSdzIGNoYW5nZSogd2l0aCB0aGlzIGJyYW5jaCwgc28gdGhlXG4gKiBjb21taXRzIG9uIHRoZSBvdGhlciBzaWRlIGFyZSBtb3N0IG9mIHRoZSBpbnRlbnQgaXQgbmVlZHMuIEJlc3QtZWZmb3J0OiBhXG4gKiBsb2cgZ2l0IGNvdWxkIG5vdCBwcm9kdWNlIGRlZ3JhZGVzIHRoZSBwcm9tcHQsIGFuZCBpcyBuZXZlciBhbGxvd2VkIHRvIGZhaWxcbiAqIHRoZSByZXBhaXIuXG4gKlxuICogQHBhcmFtIG9wdGlvbnMgLSBHaXQgb3B0aW9uczsgYGN3ZGAgaXMgdGhlIGNsb25lIGhvbGRpbmcgdGhlIG1lcmdlXG4gKiBAcGFyYW0gcHJlTWVyZ2VTaGEgLSBXaGVyZSB0aGUgbWlsZXN0b25lIGJyYW5jaCBzdG9vZCBiZWZvcmUgdGhlIG1lcmdlXG4gKiBAcGFyYW0gZGVmYXVsdFJlZiAtIFRoZSBkZWZhdWx0IGJyYW5jaCdzIHRpcCB0aGF0IHdhcyBtZXJnZWQgaW5cbiAqIEBwYXJhbSBsaW1pdCAtIE1vc3Qgc3ViamVjdHMgdG8gcmVhZFxuICogQHBhcmFtIGxvZ2dlciAtIFNheXMgd2h5IHRoZSBjb250ZXh0IGlzIG1pc3Npbmcgd2hlbiBnaXQgY291bGQgbm90IHJlYWQgaXRcbiAqIEByZXR1cm5zIFRoZSBzdWJqZWN0cywgb3IgYW4gZW1wdHkgbGlzdCB3aGVuIG5vbmUgY291bGQgYmUgcmVhZFxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVhZE1lcmdlZENvbW1pdFN1YmplY3RzKFxuICBvcHRpb25zOiBHaXRDb21tYW5kT3B0aW9ucyxcbiAgcHJlTWVyZ2VTaGE6IHN0cmluZyxcbiAgZGVmYXVsdFJlZjogc3RyaW5nLFxuICBsaW1pdCA9IDIwLFxuICBsb2dnZXI/OiBMb2dnZXIsXG4pOiBQcm9taXNlPHN0cmluZ1tdPiB7XG4gIGlmICghcHJlTWVyZ2VTaGEgfHwgIWRlZmF1bHRSZWYpIHtcbiAgICBsb2dnZXI/Lndhcm4oXG4gICAgICBcIk1pbGVzdG9uZSBzeW5jOiB0aGUgcmVwYWlyIHByb21wdCBjYXJyaWVzIG5vIG1lcmdlZC1jb21taXQgc3ViamVjdHMg4oCUIFwiICtcbiAgICAgICAgXCJvbmUgc2lkZSBvZiB0aGUgbWVyZ2UgaXMgdW5rbm93biAoSXNzdWUgIzE5NjUpXCIsXG4gICAgICB7IHByZU1lcmdlU2hhLCBkZWZhdWx0UmVmIH0sXG4gICAgKTtcbiAgICByZXR1cm4gW107XG4gIH1cbiAgY29uc3QgbG9nID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICBbXG4gICAgICBcImxvZ1wiLFxuICAgICAgXCItLW5vLW1lcmdlc1wiLFxuICAgICAgYC0tbWF4LWNvdW50PSR7bGltaXR9YCxcbiAgICAgIFwiLS1mb3JtYXQ9JXNcIixcbiAgICAgIGAke3ByZU1lcmdlU2hhfS4uJHtkZWZhdWx0UmVmfWAsXG4gICAgXSxcbiAgICBvcHRpb25zLFxuICApO1xuICBpZiAoIWxvZy5vayB8fCBsb2cudmFsdWUuY29kZSAhPT0gMCkge1xuICAgIC8vIERlZ3JhZGVkLCBhbmQgc2FpZCBzbzogYSByZXBhaXIgcHJvbXB0IHdpdGhvdXQgdGhlIG90aGVyIHNpZGUncyBpbnRlbnRcbiAgICAvLyBpcyB3ZWFrZXIsIGFuZCBhIHNpbGVudCBnYXAgaXMgb25lIG5vYm9keSB3b3VsZCBldmVyIGRpYWdub3NlLlxuICAgIGxvZ2dlcj8ud2FybihcbiAgICAgIGBNaWxlc3RvbmUgc3luYzogdGhlIG1lcmdlZCBjb21taXRzJyBzdWJqZWN0cyBjb3VsZCBub3QgYmUgcmVhZCBmb3IgYCArXG4gICAgICAgIGB0aGUgcmVwYWlyIHByb21wdCAoSXNzdWUgIzE5NjUpOiAke2Rlc2NyaWJlR2l0RmFpbHVyZShsb2cpfWAsXG4gICAgICB7IHByZU1lcmdlU2hhLCBkZWZhdWx0UmVmIH0sXG4gICAgKTtcbiAgICByZXR1cm4gW107XG4gIH1cbiAgcmV0dXJuIGxvZy52YWx1ZS5zdGRvdXQudHJpbSgpLnNwbGl0KFwiXFxuXCIpLmZpbHRlcihCb29sZWFuKTtcbn1cblxuLyoqXG4gKiBUaGUgdHJlZSB0aGUgaW5kZXggY3VycmVudGx5IGhvbGRzLCBhcyBhIHRyZWUgb2JqZWN0IGlkLlxuICpcbiAqIEVhY2ggcm91bmQgaXMgbWVhc3VyZWQgYWdhaW5zdCB0aGUgb25lIGJlZm9yZSBpdDogcmVhZGluZyBgZ2l0IGRpZmZcbiAqIC0tY2FjaGVkYCBhZ2FpbnN0IHRoZSBtZXJnZSBjb21taXQgaW5zdGVhZCB3b3VsZCByZXBvcnQgcm91bmQgb25lJ3MgZmlsZXNcbiAqIGFzIHJvdW5kIHR3bydzLCBhbmQgd291bGQgbWFrZSBcInRoaXMgcm91bmQgY2hhbmdlZCBub3RoaW5nXCIgaW1wb3NzaWJsZSB0b1xuICogZGV0ZWN0IGFmdGVyIHRoZSBmaXJzdCByb3VuZC5cbiAqXG4gKiBAcGFyYW0gb3B0aW9ucyAtIEdpdCBvcHRpb25zOyBgY3dkYCBpcyB0aGUgY2xvbmUgaG9sZGluZyB0aGUgbWVyZ2VcbiAqIEByZXR1cm5zIFRoZSB0cmVlIGlkLCBvciB0aGUgZmFpbHVyZSB0aGF0IHN0b3BwZWQgaXQgYmVpbmcgd3JpdHRlblxuICovXG5hc3luYyBmdW5jdGlvbiB3cml0ZUluZGV4VHJlZShcbiAgb3B0aW9uczogR2l0Q29tbWFuZE9wdGlvbnMsXG4pOiBQcm9taXNlPFJlc3VsdDxzdHJpbmc+PiB7XG4gIGNvbnN0IHRyZWUgPSBhd2FpdCBydW5HaXRDb21tYW5kKFtcIndyaXRlLXRyZWVcIl0sIG9wdGlvbnMpO1xuICBpZiAoIXRyZWUub2sgfHwgdHJlZS52YWx1ZS5jb2RlICE9PSAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGB0aGUgdHJlZSBjb3VsZCBub3QgYmUgcmVjb3JkZWQ6ICR7ZGVzY3JpYmVHaXRGYWlsdXJlKHRyZWUpfWAsXG4gICAgICApLFxuICAgIH07XG4gIH1cbiAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB0cmVlLnZhbHVlLnN0ZG91dC50cmltKCkgfTtcbn1cblxuLyoqXG4gKiBGb2xkIHdoYXRldmVyIHRoZSByZXBhaXIgbGVmdCBiZWhpbmQgaW50byB0aGUgbWVyZ2UgY29tbWl0J3MgaW5kZXguXG4gKlxuICogVGhlIHJlcGFpciBwcm9tcHQgbGV0cyB0aGUgYWdlbnQgc3RhZ2Ugb3IgY29tbWl0LCBleGFjdGx5IGFzIHRoZSByZXNvbHV0aW9uXG4gKiBwcm9tcHQgZG9lcywgc28gYm90aCBzaGFwZXMgYXJlIGhhbmRsZWQgdGhlIHNhbWUgd2F5OiBhIGNvbW1pdCAqKm9uIHRvcCBvZioqXG4gKiB0aGUgbWVyZ2UgaXMgcmV3b3VuZCB3aXRoIGByZXNldCAtLXNvZnRgIHNvIGl0cyBjb250ZW50IGlzIHN0YWdlZCBhZ2FpbixcbiAqIGFuZCB0aGUgd2hvbGUgdHJlZSBpcyB0aGVuIHN0YWdlZCB0aHJvdWdoIHRoZSBsYWRkZXIncyBvd24gc3RhZ2luZyBwYXRoIOKAlFxuICogd29ya2VyIHN0YXRlIGZpbGVzIHJlbW92ZWQsIHRoZSBwcmUtY29tbWl0IHNhZmV0eSBnYXRlIGFwcGxpZWQuXG4gKlxuICogQSBIRUFEIHRoYXQgaXMgbm90IGEgZGVzY2VuZGFudCBvZiB0aGUgbWVyZ2UgY29tbWl0IGlzIHRoZSBvbmUgc2hhcGUgdGhhdFxuICogaXMgcmVmdXNlZCByYXRoZXIgdGhhbiBhYnNvcmJlZDogdGhlIGFnZW50IHJld291bmQsIHJldmVydGVkIG9yIHJlY3JlYXRlZFxuICogdGhlIGJyYW5jaCwgYW5kIHJld2luZGluZyBpdCBiYWNrIHdvdWxkIHNpbGVudGx5IGJsZXNzIHdoaWNoZXZlciBzaWRlIGl0XG4gKiBkcm9wcGVkIOKAlCB0aGUgc2lkZS1waWNrIHRoZSBjb250cmFjdCBmb3JiaWRzLCBhcnJpdmluZyBhcyBoaXN0b3J5IHJhdGhlclxuICogdGhhbiBhcyBhIGh1bmsuXG4gKlxuICogQHBhcmFtIG9wdGlvbnMgLSBHaXQgb3B0aW9uczsgYGN3ZGAgaXMgdGhlIGNsb25lIGhvbGRpbmcgdGhlIG1lcmdlXG4gKiBAcGFyYW0gbWVyZ2VTaGEgLSBUaGUgbWVyZ2UgY29tbWl0IHRoZSByZXBhaXIgYmVsb25ncyBpblxuICogQHBhcmFtIHRyZWVCZWZvcmUgLSBUaGUgdHJlZSB0aGlzIHJvdW5kIHN0YXJ0ZWQgZnJvbVxuICogQHJldHVybnMgVGhlIHBhdGhzIHRoaXMgcm91bmQgY2hhbmdlZCwgb3IgdGhlIGZhaWx1cmUgdGhhdCBzdG9wcGVkIHRoZSBmb2xkXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGZvbGRSZXBhaXJJbnRvTWVyZ2UoXG4gIG9wdGlvbnM6IEdpdENvbW1hbmRPcHRpb25zLFxuICBtZXJnZVNoYTogc3RyaW5nLFxuICB0cmVlQmVmb3JlOiBzdHJpbmcsXG4pOiBQcm9taXNlPFJlc3VsdDxzdHJpbmdbXT4+IHtcbiAgY29uc3QgaGVhZCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoW1wicmV2LXBhcnNlXCIsIFwiSEVBRFwiXSwgb3B0aW9ucyk7XG4gIGlmICghaGVhZC5vayB8fCBoZWFkLnZhbHVlLmNvZGUgIT09IDApIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYHRoZSByZXBhaXJlZCB0cmVlJ3MgSEVBRCBjb3VsZCBub3QgYmUgcmVhZDogJHtcbiAgICAgICAgICBkZXNjcmliZUdpdEZhaWx1cmUoaGVhZClcbiAgICAgICAgfWAsXG4gICAgICApLFxuICAgIH07XG4gIH1cbiAgaWYgKGhlYWQudmFsdWUuc3Rkb3V0LnRyaW0oKSAhPT0gbWVyZ2VTaGEpIHtcbiAgICBjb25zdCBkZXNjZW5kcyA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgICBbXCJtZXJnZS1iYXNlXCIsIFwiLS1pcy1hbmNlc3RvclwiLCBtZXJnZVNoYSwgXCJIRUFEXCJdLFxuICAgICAgb3B0aW9ucyxcbiAgICApO1xuICAgIGlmICghZGVzY2VuZHMub2sgfHwgZGVzY2VuZHMudmFsdWUuY29kZSAhPT0gMCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICAgIGB0aGUgcmVwYWlyIG1vdmVkIHRoZSBicmFuY2ggb2ZmIHRoZSBtZXJnZSBjb21taXQgJHttZXJnZVNoYX0gYCArXG4gICAgICAgICAgICBgaW5zdGVhZCBvZiBidWlsZGluZyBvbiBpdCDigJQgdGhlIG1lcmdlIHdhcyByZXdvdW5kLCByZXZlcnRlZCBvciBgICtcbiAgICAgICAgICAgIGByZWNyZWF0ZWQsIHdoaWNoIGlzIGEgc2lkZS1waWNrIGJ5IGFub3RoZXIgcm91dGUgYW5kIGlzIHJlZnVzZWRgLFxuICAgICAgICApLFxuICAgICAgfTtcbiAgICB9XG4gICAgLy8gQW4gb3JkaW5hcnkgY29tbWl0IG9uIHRvcCBvZiB0aGUgbWVyZ2U6IGl0cyBjb250ZW50IGJlbG9uZ3MgaW4gdGhlXG4gICAgLy8gbWVyZ2UgY29tbWl0LCBub3QgaW4gYSBzdHJheSBjb21taXQgYSBtaWxlc3RvbmUgYnJhbmNoIHRoZW4gY2Fycmllcy5cbiAgICBjb25zdCByZXNldCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoW1wicmVzZXRcIiwgXCItLXNvZnRcIiwgbWVyZ2VTaGFdLCBvcHRpb25zKTtcbiAgICBpZiAoIXJlc2V0Lm9rIHx8IHJlc2V0LnZhbHVlLmNvZGUgIT09IDApIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgICBgdGhlIHJlcGFpcidzIG93biBjb21taXQgY291bGQgbm90IGJlIGZvbGRlZCBiYWNrIGludG8gdGhlIG1lcmdlOiAke1xuICAgICAgICAgICAgZGVzY3JpYmVHaXRGYWlsdXJlKHJlc2V0KVxuICAgICAgICAgIH1gLFxuICAgICAgICApLFxuICAgICAgfTtcbiAgICB9XG4gIH1cblxuICBjb25zdCBzdGFnZWQgPSBhd2FpdCBzdGFnZUFnZW50UmVzb2x1dGlvbihvcHRpb25zKTtcbiAgaWYgKCFzdGFnZWQub2spIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IHN0YWdlZC5lcnJvciB9O1xuXG4gIGNvbnN0IHRyZWVBZnRlciA9IGF3YWl0IHdyaXRlSW5kZXhUcmVlKG9wdGlvbnMpO1xuICBpZiAoIXRyZWVBZnRlci5vaykgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogdHJlZUFmdGVyLmVycm9yIH07XG5cbiAgY29uc3QgZGlmZiA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgW1wiZGlmZlwiLCBcIi0tbmFtZS1vbmx5XCIsIHRyZWVCZWZvcmUsIHRyZWVBZnRlci52YWx1ZV0sXG4gICAgb3B0aW9ucyxcbiAgKTtcbiAgaWYgKCFkaWZmLm9rIHx8IGRpZmYudmFsdWUuY29kZSAhPT0gMCkge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgdGhlIHJlcGFpcidzIG93biBjaGFuZ2VzIGNvdWxkIG5vdCBiZSBsaXN0ZWQ6ICR7XG4gICAgICAgICAgZGVzY3JpYmVHaXRGYWlsdXJlKGRpZmYpXG4gICAgICAgIH1gLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG4gIHJldHVybiB7XG4gICAgb2s6IHRydWUsXG4gICAgdmFsdWU6IGRpZmYudmFsdWUuc3Rkb3V0LnRyaW0oKS5zcGxpdChcIlxcblwiKS5maWx0ZXIoQm9vbGVhbiksXG4gIH07XG59XG5cbi8qKlxuICogT2ZmZXIgYSBmYWlsZWQgdmVyaWZpY2F0aW9uIGJhY2sgdG8gdGhlIGFnZW50IHJ1bmcsIHRoZW4gcmUtcnVuIGl0LlxuICpcbiAqIEBwYXJhbSBpbnB1dCAtIFRoZSBnYXRlIGZhaWx1cmUsIHRoZSBnYXRlIGl0c2VsZiBhbmQgdGhlIHJ1bmcgdG8gb2ZmZXIgaXQgdG9cbiAqIEByZXR1cm5zIFdoZXRoZXIgdGhlIHRyZWUgd2FzIHJlcGFpcmVkLCBhbmQgd2hhdCBlYWNoIHJvdW5kIHRvdWNoZWRcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlcGFpckdhdGVkUmVzb2x1dGlvbihcbiAgaW5wdXQ6IEdhdGVSZXBhaXJJbnB1dCxcbik6IFByb21pc2U8R2F0ZVJlcGFpck91dGNvbWU+IHtcbiAgY29uc3Qge1xuICAgIGZpcnN0RmFpbHVyZSxcbiAgICBnYXRlLFxuICAgIGFnZW50Rm4sXG4gICAgb3B0aW9ucyxcbiAgICBtaWxlc3RvbmVCcmFuY2gsXG4gICAgZGVmYXVsdEJyYW5jaCxcbiAgICBtZXJnZVNoYSxcbiAgICBtZXJnZWRDb21taXRTdWJqZWN0cyxcbiAgICBjb25mbGljdGVkRmlsZXMgPSBbXSxcbiAgICBsb2dnZXIsXG4gIH0gPSBpbnB1dDtcbiAgY29uc3QgbWF4Um91bmRzID0gaW5wdXQubWF4Um91bmRzID8/IE1BWF9HQVRFX1JFUEFJUl9ST1VORFM7XG5cbiAgaWYgKCFhZ2VudEZuKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1czogXCJub3QtYXR0ZW1wdGVkXCIsXG4gICAgICBnYXRlOiBmaXJzdEZhaWx1cmUsXG4gICAgICBkZXRhaWw6IFwibm8gcmVzb2x1dGlvbiBhZ2VudCB3YXMgYXZhaWxhYmxlIHRvIHRoaXMgc3luY1wiLFxuICAgIH07XG4gIH1cbiAgaWYgKCFtZXJnZVNoYSkge1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXM6IFwibm90LWF0dGVtcHRlZFwiLFxuICAgICAgZ2F0ZTogZmlyc3RGYWlsdXJlLFxuICAgICAgZGV0YWlsOiBcInRoZSBtZXJnZSBjb21taXQgY291bGQgbm90IGJlIHJlYWQsIHNvIGEgcmVwYWlyIGNvdWxkIG5vdCBcIiArXG4gICAgICAgIFwiaGF2ZSBiZWVuIGZvbGRlZCBpbnRvIGl0XCIsXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IHJvdW5kczogR2F0ZVJlcGFpclJvdW5kW10gPSBbXTtcbiAgbGV0IGxhc3RHYXRlID0gZmlyc3RGYWlsdXJlO1xuICAvKipcbiAgICogU3RvcCB3aXRoIGEgcmVwYWlyIHRoYXQgd2FzIGF0dGVtcHRlZCBhbmQgZGlkIG5vdCBzYXZlIHRoZSB0cmVlLlxuICAgKlxuICAgKiBBIHJ1biB0aGF0IGZhaWxlZCwgd2FzIGVuZGVkIGJ5IHRoZSB3b3JrZXIsIGNoYW5nZWQgbm90aGluZyBvciBjb3VsZCBub3RcbiAgICogYmUgZm9sZGVkIGluIGlzIGEgcmVwYWlyIHRoYXQgKnJhbio6IHJlcG9ydGluZyBpdCBhcyBcIm5vdCBhdHRlbXB0ZWRcIlxuICAgKiB3b3VsZCB0ZWxsIHRoZSByZWFkZXIgdGhlIG9wcG9zaXRlIG9mIHdoYXQgaGFwcGVuZWQuIE9ubHkgYSBydW5nIHRoYXQgd2FzXG4gICAqIG5ldmVyIGFza2VkIOKAlCBubyBhZ2VudCwgbm8gbWVyZ2UgdG8gcmVwYWlyLCBubyBidWRnZXQg4oCUIGlzIG5vdC1hdHRlbXB0ZWQuXG4gICAqL1xuICBjb25zdCBzdG9wID0gKGRldGFpbDogc3RyaW5nKTogR2F0ZVJlcGFpck91dGNvbWUgPT4gKHtcbiAgICBzdGF0dXM6IFwiZmFpbGVkXCIsXG4gICAgZ2F0ZTogbGFzdEdhdGUsXG4gICAgcmVjb3JkOiB7IGZhaWxpbmdDb21tYW5kOiBmaXJzdEZhaWx1cmUuZGV0YWlsLCByb3VuZHMgfSxcbiAgICBkZXRhaWwsXG4gIH0pO1xuXG4gIGZvciAobGV0IHJvdW5kID0gMTsgcm91bmQgPD0gbWF4Um91bmRzOyByb3VuZCsrKSB7XG4gICAgLy8gTWVhc3VyZSB0aGlzIHJvdW5kIGFnYWluc3QgdGhlIHRyZWUgaXQgc3RhcnRzIGZyb20sIHNvIHJvdW5kIHR3b1xuICAgIC8vIHJlcG9ydHMgaXRzIG93biBmaWxlcyBhbmQgaXRzIG93biBcImNoYW5nZWQgbm90aGluZ1wiLlxuICAgIGNvbnN0IHRyZWVCZWZvcmUgPSBhd2FpdCB3cml0ZUluZGV4VHJlZShvcHRpb25zKTtcbiAgICBpZiAoIXRyZWVCZWZvcmUub2spIHtcbiAgICAgIHJldHVybiBzdG9wKGByZXBhaXIgcm91bmQgJHtyb3VuZH06ICR7dHJlZUJlZm9yZS5lcnJvci5tZXNzYWdlfWApO1xuICAgIH1cbiAgICBsb2dnZXI/LmluZm8oXG4gICAgICBgTWlsZXN0b25lIHN5bmM6IHRoZSB2ZXJpZmljYXRpb24gcmVmdXNlZCB0aGUgcmVzb2x1dGlvbiDigJQgb2ZmZXJpbmcgYCArXG4gICAgICAgIGByZXBhaXIgcm91bmQgJHtyb3VuZH0gb2YgJHttYXhSb3VuZHN9IHRvIHRoZSBhZ2VudCBydW5nIGAgK1xuICAgICAgICBgKElzc3VlICMxOTY1KWAsXG4gICAgICB7IG1pbGVzdG9uZUJyYW5jaCwgZGVmYXVsdEJyYW5jaCwgZmFpbGluZ0NvbW1hbmQ6IGxhc3RHYXRlLmRldGFpbCB9LFxuICAgICk7XG4gICAgY29uc3Qgb3V0Y29tZSA9IGF3YWl0IGFnZW50Rm4oe1xuICAgICAgY29uZmxpY3RlZEZpbGVzLFxuICAgICAgbWlsZXN0b25lQnJhbmNoLFxuICAgICAgZGVmYXVsdEJyYW5jaCxcbiAgICAgIHdvcmtEaXI6IG9wdGlvbnMuY3dkID8/IFwiLlwiLFxuICAgICAgcmVwYWlyOiB7XG4gICAgICAgIHJvdW5kLFxuICAgICAgICBtYXhSb3VuZHMsXG4gICAgICAgIGZhaWxpbmdDb21tYW5kOiBsYXN0R2F0ZS5kZXRhaWwsXG4gICAgICAgIG91dHB1dDogbGFzdEdhdGUub3V0cHV0LFxuICAgICAgICBtZXJnZWRDb21taXRTdWJqZWN0cyxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBpZiAoIW91dGNvbWUub2spIHtcbiAgICAgIGlmIChpc0dhdGVSZXBhaXJCdWRnZXRFeGhhdXN0ZWQob3V0Y29tZS5lcnJvcikpIHtcbiAgICAgICAgLy8gVGhlIHJ1bmcgcmVmdXNlZCBiZWZvcmUgaXQgcmFuLCBzbyBub3RoaW5nIHdhcyByZXBhaXJlZCBhbmQgdGhlXG4gICAgICAgIC8vIGVzY2FsYXRpb24gbXVzdCBzYXkgZXhhY3RseSB0aGF0LlxuICAgICAgICBjb25zdCBkZXRhaWwgPVxuICAgICAgICAgIGB0aGUgcmVwYWlyIHdhcyBub3QgYXR0ZW1wdGVkIGZvciB3YW50IG9mIGJ1ZGdldCDigJQgJHtvdXRjb21lLmVycm9yLm1lc3NhZ2V9YDtcbiAgICAgICAgcmV0dXJuIHJvdW5kcy5sZW5ndGggPT09IDBcbiAgICAgICAgICA/IHsgc3RhdHVzOiBcIm5vdC1hdHRlbXB0ZWRcIiwgZ2F0ZTogbGFzdEdhdGUsIGRldGFpbCB9XG4gICAgICAgICAgOiBzdG9wKGRldGFpbCk7XG4gICAgICB9XG4gICAgICByZXR1cm4gc3RvcChgcmVwYWlyIHJvdW5kICR7cm91bmR9IGZhaWxlZCDigJQgJHtvdXRjb21lLmVycm9yLm1lc3NhZ2V9YCk7XG4gICAgfVxuICAgIGlmIChvdXRjb21lLnZhbHVlLnRlcm1pbmF0ZWQpIHtcbiAgICAgIC8vIE5vdCBhIHZlcmRpY3Qgb24gdGhlIHRyZWU6IHRoZSB3b3JrZXIgZW5kZWQgdGhlIHJ1biAoSXNzdWUgIzE2OTMpLlxuICAgICAgcmV0dXJuIHN0b3AoXG4gICAgICAgIGByZXBhaXIgcm91bmQgJHtyb3VuZH0gd2FzIGVuZGVkIGJ5IHRoZSB3b3JrZXIgYmVmb3JlIGl0IGZpbmlzaGVkIGAgK1xuICAgICAgICAgIGAoSXNzdWUgIzE2OTMpYCxcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChvdXRjb21lLnZhbHVlLnByb3ZpZGVyVW5hdmFpbGFibGUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgLy8gTm9yIGlzIGEgcHJvdmlkZXIgdGhhdCByZWZ1c2VkIHRoZSBydW4g4oCUIGEgNDAyLCBzYXkgKElzc3VlICMyNjEzKS5cbiAgICAgIHJldHVybiBzdG9wKFxuICAgICAgICBgcmVwYWlyIHJvdW5kICR7cm91bmR9IHdhcyBub3QgcnVuIOKAlCB0aGUgYWdlbnQgcHJvdmlkZXIgd2FzIGAgK1xuICAgICAgICAgIGB1bmF2YWlsYWJsZTogJHtvdXRjb21lLnZhbHVlLnByb3ZpZGVyVW5hdmFpbGFibGV9IChJc3N1ZSAjMjYxMylgLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCBmb2xkZWQgPSBhd2FpdCBmb2xkUmVwYWlySW50b01lcmdlKFxuICAgICAgb3B0aW9ucyxcbiAgICAgIG1lcmdlU2hhLFxuICAgICAgdHJlZUJlZm9yZS52YWx1ZSxcbiAgICApO1xuICAgIGlmICghZm9sZGVkLm9rKSB7XG4gICAgICByZXR1cm4gc3RvcChgcmVwYWlyIHJvdW5kICR7cm91bmR9OiAke2ZvbGRlZC5lcnJvci5tZXNzYWdlfWApO1xuICAgIH1cbiAgICBpZiAoZm9sZGVkLnZhbHVlLmxlbmd0aCA9PT0gMCkge1xuICAgICAgLy8gUmUtcnVubmluZyB0aGUgZ2F0ZSBvdmVyIGEgdHJlZSBub3RoaW5nIHRvdWNoZWQgd291bGQgc3BlbmQgdGhlXG4gICAgICAvLyB2ZXJpZmljYXRpb24gYnVkZ2V0IHRvIGxlYXJuIHdoYXQgaXQgYWxyZWFkeSBzYWlkLlxuICAgICAgcmV0dXJuIHN0b3AoYHJlcGFpciByb3VuZCAke3JvdW5kfSBjaGFuZ2VkIG5vdGhpbmcgaW4gdGhlIHRyZWVgKTtcbiAgICB9XG4gICAgcm91bmRzLnB1c2goeyByb3VuZCwgZmlsZXM6IGZvbGRlZC52YWx1ZSB9KTtcblxuICAgIGNvbnN0IHZlcmRpY3QgPSBhd2FpdCBnYXRlKCk7XG4gICAgLy8gSXNzdWUgIzQzMjY6IG9ubHkgdGhlIGZpcnN0IHZlcmRpY3QgbWF5IGxhbmQgdW52ZXJpZmllZC4gQSB0cmVlIHdob3NlXG4gICAgLy8gcmVhbCB2ZXJpZmljYXRpb24gZmFpbGVkIGFuZCB3YXMgdGhlbiByZXBhaXJlZCBtdXN0IG5vdCBiZSBwdXNoZWQgb24gYVxuICAgIC8vIGxhdGVyIGdhdGUgdGhhdCBkaWQgbm90IHJ1bi5cbiAgICBsYXN0R2F0ZSA9IGp1ZGdlUmVzb2x1dGlvblZlcmRpY3QoXG4gICAgICB2ZXJkaWN0LnN0YXR1cyA9PT0gXCJza2lwcGVkXCJcbiAgICAgICAgPyB7IC4uLnZlcmRpY3QsIGxhbmRVbnZlcmlmaWVkOiBmYWxzZSB9XG4gICAgICAgIDogdmVyZGljdCxcbiAgICApO1xuICAgIGlmICh2ZXJkaWN0LnN0YXR1cyA9PT0gXCJza2lwcGVkXCIpIHtcbiAgICAgIC8vIE5vdGhpbmcgcmFuLCBzbyB0aGVyZSBpcyBub3RoaW5nIGEgZnVydGhlciByZXBhaXIgY291bGQgYW5zd2VyLlxuICAgICAgcmV0dXJuIHN0b3AoXG4gICAgICAgIGByZXBhaXIgcm91bmQgJHtyb3VuZH06ICR7bGFzdEdhdGUuZGV0YWlsfSDigJQgbm8gZnVydGhlciByZXBhaXIgY2FuIGAgK1xuICAgICAgICAgIGBhbnN3ZXIgYSB2ZXJpZmljYXRpb24gdGhhdCBkb2VzIG5vdCBydW5gLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKHZlcmRpY3Quc3RhdHVzID09PSBcInBhc3NlZFwiKSB7XG4gICAgICBsb2dnZXI/LmluZm8oXG4gICAgICAgIGBNaWxlc3RvbmUgc3luYzogdGhlIHJlcGFpcmVkIHRyZWUgcGFzc2VzIHRoZSB2ZXJpZmljYXRpb24gYCArXG4gICAgICAgICAgYChJc3N1ZSAjMTk2NSlgLFxuICAgICAgICB7IG1pbGVzdG9uZUJyYW5jaCwgZGVmYXVsdEJyYW5jaCwgcm91bmQsIGZpbGVzOiBmb2xkZWQudmFsdWUgfSxcbiAgICAgICk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdGF0dXM6IFwicmVwYWlyZWRcIixcbiAgICAgICAgZ2F0ZTogdmVyZGljdCxcbiAgICAgICAgcmVjb3JkOiB7IGZhaWxpbmdDb21tYW5kOiBmaXJzdEZhaWx1cmUuZGV0YWlsLCByb3VuZHMgfSxcbiAgICAgIH07XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBzdGF0dXM6IFwiZmFpbGVkXCIsXG4gICAgZ2F0ZTogbGFzdEdhdGUsXG4gICAgcmVjb3JkOiB7IGZhaWxpbmdDb21tYW5kOiBmaXJzdEZhaWx1cmUuZGV0YWlsLCByb3VuZHMgfSxcbiAgICBkZXRhaWw6IGAke3JvdW5kcy5sZW5ndGh9IHJlcGFpciByb3VuZChzKSByYW4gYW5kIHRoZSB2ZXJpZmljYXRpb24gc3RpbGwgYCArXG4gICAgICBgcmVmdXNlcyB0aGUgdHJlZWAsXG4gIH07XG59XG5cbi8qKiBXaGF0IHtAbGluayBydW5HYXRlV2l0aFJlcGFpcn0gcHJvZHVjZWQgZm9yIHRoZSBwdXNoIHBhdGggdG8gYWN0IG9uLiAqL1xuZXhwb3J0IGludGVyZmFjZSBHYXRlV2l0aFJlcGFpclJlc3VsdCB7XG4gIC8qKiBUaGUgdmVyZGljdCB0aGUgcHVzaCBwYXRoIG11c3QgaG9ub3VyIOKAlCB0aGUgbGFzdCBvbmUgdGFrZW4uICovXG4gIGdhdGU6IE1lcmdlR2F0ZU91dGNvbWU7XG4gIC8qKlxuICAgKiBUaGUgZmlyc3QgdmVyZGljdCwgd2hpY2ggaXMgdGhlIG9uZSBhIHJlcGFpciB3YXMgb2ZmZXJlZC4gSWRlbnRpY2FsIHRvXG4gICAqIGBnYXRlYCB3aGVuIG5vIHJlcGFpciByYW4sIGFuZCB3aGF0IHRoZSBlc2NhbGF0aW9uIHF1b3RlcyBhbG9uZ3NpZGUgdGhlXG4gICAqIGxhc3Qgb25lIHNvIGJvdGggb3V0cHV0cyByZWFjaCB0aGUgcmVhZGVyLlxuICAgKi9cbiAgZmlyc3RHYXRlOiBNZXJnZUdhdGVPdXRjb21lO1xuICAvKiogV2hhdCB0aGUgcmVwYWlyIHJ1bmcgZGlkLCB3aGVuIHRoZSBmaXJzdCB2ZXJkaWN0IHdhcyBhIHJlZnVzYWwuICovXG4gIHJlcGFpcj86IEdhdGVSZXBhaXJPdXRjb21lO1xuICAvKipcbiAgICogU2V0IHdoZW4gdGhlIHJlcGFpcmVkIHRyZWUgY291bGQgbm90IGJlIHJlLWNvbW1pdHRlZC4gVGhlIGNhbGxlciByZWZ1c2VzXG4gICAqIHRoZSByZXNvbHV0aW9uIGFuZCBwdXRzIHRoZSBicmFuY2ggYmFjazogYSByZXBhaXIgdGhhdCBpcyBub3QgaW4gdGhlXG4gICAqIG1lcmdlIGNvbW1pdCBpcyBhIHJlcGFpciBub3RoaW5nIHdvdWxkIHJlY29yZC5cbiAgICovXG4gIGFtZW5kRmFpbHVyZT86IHN0cmluZztcbn1cblxuLyoqIEV2ZXJ5dGhpbmcge0BsaW5rIHJ1bkdhdGVXaXRoUmVwYWlyfSBuZWVkcyB0byB2ZXJpZnksIHJlcGFpciBhbmQgcmVjb3JkLiAqL1xuZXhwb3J0IGludGVyZmFjZSBHYXRlV2l0aFJlcGFpcklucHV0IGV4dGVuZHNcbiAgT21pdDxcbiAgICBHYXRlUmVwYWlySW5wdXQsXG4gICAgXCJmaXJzdEZhaWx1cmVcIiB8IFwibWVyZ2VTaGFcIiB8IFwibWVyZ2VkQ29tbWl0U3ViamVjdHNcIlxuICA+IHtcbiAgLyoqIFdoZXJlIHRoZSBtaWxlc3RvbmUgYnJhbmNoIHN0b29kIGJlZm9yZSB0aGUgbWVyZ2UuICovXG4gIHByZU1lcmdlU2hhOiBzdHJpbmc7XG4gIC8qKiBUaGUgZGVmYXVsdCBicmFuY2gncyB0aXAgdGhhdCB3YXMgbWVyZ2VkIGluLiAqL1xuICBkZWZhdWx0UmVmOiBzdHJpbmc7XG4gIC8qKiBUaGUgbWVyZ2UgY29tbWl0J3MgbWVzc2FnZSwgd2hpY2ggdGhlIHJlcGFpciBpcyBhcHBlbmRlZCB0by4gKi9cbiAgcmVzb2x1dGlvbk1lc3NhZ2U6IHN0cmluZztcbn1cblxuLyoqXG4gKiBWZXJpZnkgdGhlIG1lcmdlZCB0cmVlLCByZXBhaXIgd2hhdCB0aGUgdmVyaWZpY2F0aW9uIHJlZnVzZXMsIGFuZCByZWNvcmQgaXQuXG4gKlxuICogVGhlIGdhdGUgcnVucyBoZXJlIHJhdGhlciB0aGFuIGluc2lkZSB0aGUgcHVzaCBwYXRoIGJlY2F1c2UgdGhhdCBwYXRoXG4gKiByZXNldHMgYSByZWZ1c2VkIG1lcmdlIGF3YXkgYXQgb25jZSwgYW5kIGEgcmVzb2x1dGlvbiByZXNldCBhd2F5IGNhbm5vdCBiZVxuICogcmVwYWlyZWQgKElzc3VlICMxOTY1KS4gQSByZXBhaXJlZCB0cmVlIGlzIGZvbGRlZCBpbnRvIHRoZSBtZXJnZSBjb21taXQgYW5kXG4gKiB0aGUgY29tbWl0IG1lc3NhZ2UgbmFtZXMgdGhlIHJlcGFpciwgc28gdGhlIHJlY29yZCBzdXJ2aXZlcyB0aGUgcnVuLlxuICpcbiAqIEBwYXJhbSBpbnB1dCAtIFRoZSBnYXRlLCB0aGUgcnVuZywgdGhlIGNsb25lIGFuZCB0aGUgY29tbWl0IHRvIGFtZW5kXG4gKiBAcmV0dXJucyBUaGUgdmVyZGljdCBmb3IgdGhlIHB1c2ggcGF0aCwgdGhlIHJlcGFpciwgYW5kIGFueSBhbWVuZCBmYWlsdXJlXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5HYXRlV2l0aFJlcGFpcihcbiAgaW5wdXQ6IEdhdGVXaXRoUmVwYWlySW5wdXQsXG4pOiBQcm9taXNlPEdhdGVXaXRoUmVwYWlyUmVzdWx0PiB7XG4gIGNvbnN0IHtcbiAgICBnYXRlLFxuICAgIG9wdGlvbnMsXG4gICAgcHJlTWVyZ2VTaGEsXG4gICAgZGVmYXVsdFJlZixcbiAgICByZXNvbHV0aW9uTWVzc2FnZSxcbiAgICBsb2dnZXIsXG4gIH0gPSBpbnB1dDtcblxuICBjb25zdCB2ZXJkaWN0ID0gYXdhaXQgZ2F0ZSgpO1xuICAvLyBBIHBhc3MgbmVlZHMgbm90aGluZywgYW5kIGEgYHNraXBwZWRgIHZlcmlmaWNhdGlvbiBpcyBhIHJlZnVzYWwgbm8gYWdlbnRcbiAgLy8gY2FuIGFuc3dlciDigJQgb25seSBhIGdlbnVpbmUgY2hlY2sgZmFpbHVyZSBidXlzIGEgcmVwYWlyIHJ1bi5cbiAgaWYgKHZlcmRpY3Quc3RhdHVzICE9PSBcImZhaWxlZFwiKSB7XG4gICAgY29uc3QgZmlyc3RHYXRlID0ganVkZ2VSZXNvbHV0aW9uVmVyZGljdCh2ZXJkaWN0KTtcbiAgICByZXR1cm4geyBnYXRlOiBmaXJzdEdhdGUsIGZpcnN0R2F0ZSB9O1xuICB9XG4gIGNvbnN0IGZpcnN0R2F0ZSA9IHZlcmRpY3Q7XG5cbiAgLy8gSXNzdWUgIzMyNTU6IGEgaG9zdCBgcnVzdGNgIG9sZGVyIHRoYW4gdGhlIG1lcmdlZCB0cmVlJ3MgYHJ1c3QtdmVyc2lvbmBcbiAgLy8gaXMgYW4gZW52aXJvbm1lbnQgZmF1bHQsIG5vdCBhIGJhZCByZXNvbHV0aW9uIOKAlCBubyByZXBhaXIgcm91bmQgY2FuXG4gIC8vIHJhaXNlIHRoZSBjb250YWluZXIncyBSdXN0IHBpbiwgc28gbm9uZSBpcyBvZmZlcmVkLlxuICBpZiAodmVyZGljdC50b29sY2hhaW5HYXApIHtcbiAgICBjb25zdCByZXBhaXI6IEdhdGVSZXBhaXJPdXRjb21lID0ge1xuICAgICAgc3RhdHVzOiBcIm5vdC1hdHRlbXB0ZWRcIixcbiAgICAgIGdhdGU6IHZlcmRpY3QsXG4gICAgICBkZXRhaWw6IFwidGhlIGhvc3QncyBSdXN0IHRvb2xjaGFpbiBpcyBvbGRlciB0aGFuIHRoZSBtZXJnZWQgdHJlZSBcIiArXG4gICAgICAgIFwicmVxdWlyZXMg4oCUIGFuIGVudmlyb25tZW50IGZhdWx0IG5vIHJlcGFpciByb3VuZCBjYW4gZml4IFwiICtcbiAgICAgICAgXCIoSXNzdWUgIzMyNTUpXCIsXG4gICAgfTtcbiAgICByZXR1cm4geyBnYXRlOiB2ZXJkaWN0LCBmaXJzdEdhdGU6IHZlcmRpY3QsIHJlcGFpciB9O1xuICB9XG5cbiAgY29uc3QgbWVyZ2VTaGFSZXN1bHQgPSBhd2FpdCBydW5HaXRDb21tYW5kKFtcInJldi1wYXJzZVwiLCBcIkhFQURcIl0sIG9wdGlvbnMpO1xuICBjb25zdCBtZXJnZVNoYSA9IG1lcmdlU2hhUmVzdWx0Lm9rICYmIG1lcmdlU2hhUmVzdWx0LnZhbHVlLmNvZGUgPT09IDBcbiAgICA/IG1lcmdlU2hhUmVzdWx0LnZhbHVlLnN0ZG91dC50cmltKClcbiAgICA6IFwiXCI7XG5cbiAgY29uc3QgcmVwYWlyID0gYXdhaXQgcmVwYWlyR2F0ZWRSZXNvbHV0aW9uKHtcbiAgICAuLi5pbnB1dCxcbiAgICBmaXJzdEZhaWx1cmU6IGZpcnN0R2F0ZSxcbiAgICBtZXJnZVNoYSxcbiAgICBtZXJnZWRDb21taXRTdWJqZWN0czogYXdhaXQgcmVhZE1lcmdlZENvbW1pdFN1YmplY3RzKFxuICAgICAgb3B0aW9ucyxcbiAgICAgIHByZU1lcmdlU2hhLFxuICAgICAgZGVmYXVsdFJlZixcbiAgICAgIHVuZGVmaW5lZCxcbiAgICAgIGxvZ2dlcixcbiAgICApLFxuICB9KTtcbiAgaWYgKHJlcGFpci5zdGF0dXMgIT09IFwicmVwYWlyZWRcIikge1xuICAgIHJldHVybiB7IGdhdGU6IHJlcGFpci5nYXRlLCBmaXJzdEdhdGUsIHJlcGFpciB9O1xuICB9XG5cbiAgY29uc3QgYW1lbmRlZCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgW1xuICAgICAgXCJjb21taXRcIixcbiAgICAgIFwiLS1hbWVuZFwiLFxuICAgICAgXCItbVwiLFxuICAgICAgYCR7cmVzb2x1dGlvbk1lc3NhZ2V9XFxuXFxuJHtkZXNjcmliZUdhdGVSZXBhaXIocmVwYWlyLnJlY29yZCl9YCxcbiAgICBdLFxuICAgIG9wdGlvbnMsXG4gICk7XG4gIGlmICghYW1lbmRlZC5vayB8fCBhbWVuZGVkLnZhbHVlLmNvZGUgIT09IDApIHtcbiAgICByZXR1cm4ge1xuICAgICAgZ2F0ZTogcmVwYWlyLmdhdGUsXG4gICAgICBmaXJzdEdhdGUsXG4gICAgICByZXBhaXIsXG4gICAgICBhbWVuZEZhaWx1cmU6XG4gICAgICAgIGB0aGUgcmVwYWlyZWQgcmVzb2x1dGlvbiBjb3VsZCBub3QgYmUgY29tbWl0dGVkIChJc3N1ZSAjMTk2NSk6ICR7XG4gICAgICAgICAgZGVzY3JpYmVHaXRGYWlsdXJlKGFtZW5kZWQpXG4gICAgICAgIH1gLFxuICAgIH07XG4gIH1cbiAgcmV0dXJuIHsgZ2F0ZTogcmVwYWlyLmdhdGUsIGZpcnN0R2F0ZSwgcmVwYWlyIH07XG59XG5cbi8qKlxuICogVGhlIG5vdGUgYW4gZXNjYWxhdGlvbiBjYXJyaWVzIGFib3V0IHRoZSByZXBhaXIsIHdpdGggdGhlIGZpcnN0IGdhdGUgb3V0cHV0LlxuICpcbiAqIFRoZSByZWZ1c2FsIHRoZSBjYWxsZXIgYnVpbGRzIGFscmVhZHkgY2FycmllcyB0aGUgKmxhc3QqIGdhdGUncyBvdXRwdXQsIHNvXG4gKiB0aGlzIGNhcnJpZXMgdGhlIGZpcnN0IG9uZSBhbmQgd2hhdCBoYXBwZW5lZCBpbiBiZXR3ZWVuIOKAlCB0aGUgcmVhZGVyIG5lZWRzXG4gKiBib3RoIHRvIHRlbGwgYSByZXBhaXIgdGhhdCBoZWxwZWQgbm90aGluZyBmcm9tIG9uZSB0aGF0IG1hZGUgaXQgd29yc2UuXG4gKlxuICogQHBhcmFtIGZpcnN0RmFpbHVyZSAtIFRoZSBnYXRlIHZlcmRpY3QgdGhhdCByZWZ1c2VkIHRoZSBmaXJzdCByZXNvbHV0aW9uXG4gKiBAcGFyYW0gb3V0Y29tZSAtIFdoYXQgdGhlIHJlcGFpciBsb29wIGxlZnQgYmVoaW5kXG4gKiBAcmV0dXJucyBUaGUgbm90ZSwgcmVhZHkgdG8gYXBwZW5kIHRvIHRoZSByZWZ1c2FsXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZXNjcmliZVJlcGFpckVzY2FsYXRpb24oXG4gIGZpcnN0RmFpbHVyZTogTWVyZ2VHYXRlT3V0Y29tZSxcbiAgb3V0Y29tZTogR2F0ZVJlcGFpck91dGNvbWUsXG4pOiBzdHJpbmcge1xuICBpZiAob3V0Y29tZS5zdGF0dXMgPT09IFwibm90LWF0dGVtcHRlZFwiKSB7XG4gICAgLy8gVGhlIHJlZnVzYWwgdGhpcyBub3RlIGlzIGFwcGVuZGVkIHRvIGFscmVhZHkgY2FycmllcyB0aGlzIHZlcnkgb3V0cHV0LFxuICAgIC8vIHNvIHJlcGVhdGluZyBpdCBoZXJlIHdvdWxkIGRvdWJsZSB0aGUgY29tcGlsZXIgd2FsbCAjMTU0MiB3YXMgYWJvdXQuXG4gICAgcmV0dXJuIGBObyByZXBhaXIgd2FzIGF0dGVtcHRlZCAoSXNzdWUgIzE5NjUpOiAke291dGNvbWUuZGV0YWlsfS5gO1xuICB9XG4gIGlmIChvdXRjb21lLnN0YXR1cyA9PT0gXCJyZXBhaXJlZFwiKSB7XG4gICAgLy8gTm90IGFuIGVzY2FsYXRpb24gc2hhcGUsIGJ1dCBuZXZlciBzaWxlbnRseSBibGFuay5cbiAgICByZXR1cm4gYFRoZSByZXNvbHV0aW9uIHdhcyByZXBhaXJlZCBhbmQgdGhlIHZlcmlmaWNhdGlvbiBwYXNzZWQgYCArXG4gICAgICBgKElzc3VlICMxOTY1KS5gO1xuICB9XG4gIGNvbnN0IHJvdW5kcyA9IGxpc3RHYXRlUmVwYWlyUm91bmRzKG91dGNvbWUucmVjb3JkLnJvdW5kcyk7XG4gIC8vIEhlcmUgdGhlIHR3byBvdXRwdXRzIGdlbnVpbmVseSBkaWZmZXIg4oCUIHRoZSByZWZ1c2FsIGNhcnJpZXMgdGhlIGxhc3Qgb25lLFxuICAvLyBhbmQgdGhlIHJlYWRlciBuZWVkcyB0aGUgZmlyc3QgdG8gc2VlIHdoZXRoZXIgdGhlIHJlcGFpciBoZWxwZWQgYXQgYWxsLlxuICBjb25zdCBmaXJzdCA9IGBUaGUgdmVyaWZpY2F0aW9uIHRoYXQgcmVmdXNlZCB0aGUgZmlyc3QgcmVzb2x1dGlvbjogYCArXG4gICAgYCR7Zmlyc3RGYWlsdXJlLmRldGFpbH0ke1xuICAgICAgZmlyc3RGYWlsdXJlLm91dHB1dCA/IGBcXG5cXG4ke2ZpcnN0RmFpbHVyZS5vdXRwdXR9YCA6IFwiXCJcbiAgICB9YDtcbiAgcmV0dXJuIGBUaGUgcmVzb2x1dGlvbiB3ZW50IGJhY2sgdG8gdGhlIGFnZW50IHJ1bmcgYW5kIHRoZSB2ZXJpZmljYXRpb24gYCArXG4gICAgYHN0aWxsIHJlZnVzZXMgaXQgKElzc3VlICMxOTY1KTogJHtvdXRjb21lLmRldGFpbH0uXFxuXFxuYCArXG4gICAgYCR7cm91bmRzIHx8IFwiLSAobm8gcmVwYWlyIHJvdW5kIGNvbXBsZXRlZClcIn1cXG5cXG4ke2ZpcnN0fWA7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBNkJDLEdBR0QsU0FBUyxhQUFhLFFBQVEsbUJBQW1CO0FBR2pELFNBRUUsb0JBQW9CLFFBQ2YsaUNBQWlDO0FBQ3hDLFNBQVMsa0JBQWtCLFFBQVEsNkJBQTZCO0FBQ2hFLFNBQ0Usa0JBQWtCLEVBR2xCLG9CQUFvQixRQUNmLCtCQUErQjtBQUV0Qzs7Ozs7Ozs7O0NBU0MsR0FDRCxPQUFPLE1BQU0seUJBQXlCLEVBQUU7QUFFeEM7Ozs7OztDQU1DLEdBQ0QsT0FBTyxNQUFNLDBCQUEwQixJQUFJO0FBRTNDLDhFQUE4RSxHQUM5RSxPQUFPLE1BQU0sOEJBQThCLHFCQUFxQjtBQUVoRTs7Ozs7Ozs7O0NBU0MsR0FDRCxPQUFPLFNBQVMsMEJBQTBCLE1BQWM7RUFDdEQsTUFBTSxNQUFNLElBQUksTUFBTTtFQUN0QixJQUFJLElBQUksR0FBRztFQUNYLE9BQU87QUFDVDtBQUVBOzs7OztDQUtDLEdBQ0QsT0FBTyxTQUFTLDRCQUE0QixHQUFZO0VBQ3RELE9BQU8sZUFBZSxTQUFTLElBQUksSUFBSSxLQUFLO0FBQzlDO0FBRUE7Ozs7Ozs7Ozs7Ozs7O0NBY0MsR0FDRCxPQUFPLFNBQVMsdUJBQ2QsT0FBeUI7RUFFekIsT0FBTyxRQUFRLE1BQU0sS0FBSyxhQUFhLFFBQVEsY0FBYyxLQUFLLE9BQzlEO0lBQ0EsR0FBRyxPQUFPO0lBQ1Ys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
// denoCacheMetadata=11255281528252525021,5346838549856719161