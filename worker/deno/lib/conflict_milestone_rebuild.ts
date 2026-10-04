/**
 * Milestone redo — rebuild a conflicted `milestone/**` branch from its base
 * tip, rather than re-queuing one issue (Issue #3035, parent #3013).
 *
 * {@link abandonAndRestart} re-queues one originating issue and closes one
 * PR: that is the right unit of redo for an ordinary feature branch, because
 * an ordinary PR's head carries exactly one issue's work. A `milestone/**`
 * head is not that shape — it is the *merged* work of many sub-PRs, landed
 * one after another over days or weeks. Closing the milestone PR and
 * re-queuing a single issue would discard every other sub-PR's work along
 * with it, and there is no issue to re-queue that stands for the whole
 * branch anyway. The milestone route exists because the unit that needs
 * redoing is the branch, not an issue.
 *
 * **The design, in order:**
 *
 * 1. The rebuild starts **detached at the base tip** — a fresh detached
 *    checkout of the base tip, not a reset of the milestone branch — so
 *    nothing of the old, conflicting history is carried forward by accident.
 * 2. Every sub-PR that merged into the milestone branch is replayed, **in
 *    merge order**, by cherry-picking its merge commit onto the rebuild. Merge
 *    order (not PR number, not issue number) is the order history actually
 *    happened in, and replaying any other order risks a cherry-pick that
 *    depends on an earlier one.
 * 3. A sub-PR whose merge commit will not replay cleanly is **skipped**, not
 *    fatal: the rebuild keeps going without it, and its sub-issue is
 *    re-queued so the work it carried comes back on a fresh branch rather
 *    than being silently dropped.
 * 4. The rebuild is then made a **descendant** of the milestone branch's
 *    current tip, with `git merge -s ours` recording that tip as a parent
 *    while keeping the rebuild's own tree. That is what lets the result reach
 *    the milestone branch as a **fast-forward** — this route never
 *    force-pushes, for the same reason {@link abandonAndRestart} never does:
 *    a force-push over a shared branch can race another host's own push and
 *    destroy work neither side can recover.
 * 5. Delivery is a plain push first. When a `milestone/**` ruleset refuses
 *    that push (Issue #586), the rebuild lands through the milestone sync PR
 *    machinery instead ({@link raiseMilestoneSyncPr}), armed as a **merge
 *    commit** — a squash there would drop the base branch out of the
 *    resulting ancestry, which is the exact defect Issue #1048 exists to
 *    avoid.
 *
 * **No `needs-human`, anywhere, and no restart cap** — the same stance
 * {@link abandonAndRestart} takes (Issue #3033): a milestone branch that
 * conflicts is rebuilt again, not handed to a person.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger, Result } from "../types.ts";
import {
  type AbandonRestartOutcome,
  type AbandonRestartRequest,
  type AbandonStep,
  conflictRestartMarker,
  fetchIssueSnapshot,
  type IssueSnapshot,
  planRequeueLabel,
  type RequeueLabel,
  requeueLabelName,
} from "./conflict_abandon_restart.ts";
import { isMilestoneHead } from "./gated_head_guard.ts";
import {
  assertSafeGitRef,
  buildFetchTrackingRefArgs,
  buildPushCreateBranchArgs,
} from "./git_ref_args.ts";
import {
  isMilestoneSyncBranch,
  isRuleViolationPush,
  raiseMilestoneSyncPr,
} from "./milestone_sync_pr.ts";
import { resolveIssueForRevertedPr } from "./milestone_rollback_requeue.ts";
import { buildRollbackMarker } from "./milestone_rollback_marker.ts";
import { addLabelToIssue } from "./label_operations.ts";
import { conflictResolvedMarker } from "./merge_conflict_markers.ts";

// ---------------------------------------------------------------------------
// Merged sub-PR listing
// ---------------------------------------------------------------------------

/** One merged sub-PR that landed on the milestone branch. */
export interface MergedSubPr {
  number: number;
  headRefName: string;
  body: string;
  mergedAt: string;
  mergeCommitSha: string | null;
  issueNumber: number | null;
}

/** A 7-40 character hex sha — short sha through full sha. */
const SHA_PATTERN = /^[0-9a-f]{7,40}$/;

// SIMPLE-ON-PURPOSE: one page of 200 merged sub-PRs — upgrade when a milestone collects more than 200
const MERGED_SUB_PR_LIMIT = 200;

/**
 * List the merged sub-PRs that landed on a milestone branch, in merge order.
 *
 * Sync PRs are excluded: they carry the base branch, which the rebuild starts
 * from on its own, and replaying one would redo the base merge a second time.
 *
 * @throws when the listing cannot be read or parsed, or when it returns
 *   exactly {@link MERGED_SUB_PR_LIMIT} entries — a truncated list would
 *   silently drop sub-PRs from the rebuild, which must fail loud rather than
 *   quietly rebuild an incomplete branch.
 */
export async function listMergedSubPrs(
  repo: string,
  milestoneBranch: string,
  gh: (args: string[]) => Promise<string>,
): Promise<MergedSubPr[]> {
  const raw = await gh([
    "pr",
    "list",
    "--repo",
    repo,
    "--base",
    milestoneBranch,
    "--state",
    "merged",
    "--limit",
    String(MERGED_SUB_PR_LIMIT),
    "--json",
    "number,headRefName,body,mergedAt,mergeCommit",
  ]);
  const parsed: unknown = JSON.parse(raw.trim() || "[]");
  if (!Array.isArray(parsed)) {
    throw new Error(
      `Expected a PR array listing merged sub-PRs for ${repo} base ` +
        `'${milestoneBranch}', got ${parsed === null ? "null" : typeof parsed}`,
    );
  }
  if (parsed.length === MERGED_SUB_PR_LIMIT) {
    throw new Error(
      `Merged sub-PR listing for ${repo} base '${milestoneBranch}' returned ` +
        `exactly the ${MERGED_SUB_PR_LIMIT}-entry limit — it may be ` +
        "truncated, and rebuilding from an incomplete list would silently " +
        "drop sub-PRs",
    );
  }

  const subPrs: MergedSubPr[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as {
      number?: unknown;
      headRefName?: unknown;
      body?: unknown;
      mergedAt?: unknown;
      mergeCommit?: unknown;
    };
    const number = typeof row.number === "number" ? row.number : NaN;
    if (!Number.isSafeInteger(number)) continue;
    const headRefName = typeof row.headRefName === "string"
      ? row.headRefName
      : "";
    if (isMilestoneSyncBranch(headRefName)) continue;
    const body = typeof row.body === "string" ? row.body : "";
    const mergedAt = typeof row.mergedAt === "string" ? row.mergedAt : "";
    const oid = (row.mergeCommit as { oid?: unknown } | null)?.oid;
    const mergeCommitSha = typeof oid === "string" &&
        SHA_PATTERN.test(oid.toLowerCase())
      ? oid.toLowerCase()
      : null;
    subPrs.push({
      number,
      headRefName,
      body,
      mergedAt,
      mergeCommitSha,
      issueNumber: resolveIssueForRevertedPr(headRefName, body),
    });
  }

  subPrs.sort((a, b) => {
    const aMs = Date.parse(a.mergedAt);
    const bMs = Date.parse(b.mergedAt);
    const aTime = Number.isNaN(aMs) ? 0 : aMs;
    const bTime = Number.isNaN(bMs) ? 0 : bMs;
    if (aTime !== bTime) return aTime - bTime;
    return a.number - b.number;
  });
  return subPrs;
}

// ---------------------------------------------------------------------------
// Outcome taxonomy
// ---------------------------------------------------------------------------

/** One sub-PR that replayed cleanly onto the rebuild. */
export interface SubPrReplay {
  prNumber: number;
  issueNumber: number | null;
  sha: string | null;
}

/** One sub-PR that did not replay, and why. */
export interface SkippedSubPr extends SubPrReplay {
  reason: string;
}

/** How the rebuild reached the milestone branch. */
export type MilestoneDelivery =
  | { kind: "pushed" }
  | { kind: "sync-pr"; branch: string; opened: boolean };

/** One sub-issue re-queued because its sub-PR was skipped. */
export interface RequeuedSubIssue {
  issueNumber: number;
  prNumber: number;
  label: RequeueLabel;
}

/** What {@link abandonAndRebuildMilestone} did when it succeeded. */
export interface MilestoneRebuilt {
  outcome: "milestone-rebuilt";
  milestoneBranch: string;
  baseBranch: string;
  baseSha: string;
  rebuildSha: string;
  replayed: SubPrReplay[];
  skipped: SkippedSubPr[];
  requeued: RequeuedSubIssue[];
  delivery: MilestoneDelivery;
}

/** What {@link abandonAndRebuildMilestone} returns. */
export type MilestoneRebuildOutcome =
  | MilestoneRebuilt
  | Extract<AbandonRestartOutcome, { outcome: "failed" }>;

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

/** Injected seams so the whole rebuild is testable without git or GitHub. */
export interface MilestoneRebuildDeps {
  /** Runs `gh`, returning stdout; throws on failure. */
  gh: (args: string[]) => Promise<string>;
  /** Runs git in the clone; resolves with the exit code and both streams. Never throws. */
  git: (
    args: string[],
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  logger?: Logger;
  /** Label application — defaults to {@link addLabelToIssue}. */
  addLabel?: (
    repo: string,
    issueNumber: number,
    label: string,
  ) => Promise<Result<void>>;
  /** Sync-PR raiser — defaults to {@link raiseMilestoneSyncPr}. */
  raiseSyncPr?: typeof raiseMilestoneSyncPr;
}

// ---------------------------------------------------------------------------
// Comments and the log line
// ---------------------------------------------------------------------------

/** One log line naming the milestone, the base and every sub-issue touched. */
export function describeMilestoneRebuild(outcome: MilestoneRebuilt): string {
  const replayedText = outcome.replayed.length === 0 ? "none" : outcome.replayed
    .map((r) =>
      `#${r.prNumber}${
        r.issueNumber !== null ? ` (sub-issue #${r.issueNumber})` : ""
      }`
    )
    .join(", ");
  const skippedText = outcome.skipped.length === 0 ? "none" : outcome.skipped
    .map((s) =>
      `#${s.prNumber}${
        s.issueNumber !== null
          ? ` (sub-issue #${s.issueNumber}, re-queued)`
          : ""
      }`
    )
    .join(", ");
  return `Rebuilt ${outcome.milestoneBranch} from ` +
    `${outcome.baseBranch}@${outcome.baseSha.slice(0, 7)}: replayed sub-PRs ` +
    `${replayedText}; skipped ${skippedText}`;
}

/** The comment posted once on the milestone PR. */
export function buildMilestoneRebuildPrComment(
  outcome: MilestoneRebuilt,
): string {
  const deliveryLine = outcome.delivery.kind === "pushed"
    ? `Pushed directly to \`${outcome.milestoneBranch}\`.`
    : `\`${outcome.milestoneBranch}\` refused the direct push (a ` +
      `repository ruleset), so the rebuild was ${
        outcome.delivery.opened ? "raised" : "updated"
      } as the milestone sync PR from \`${outcome.delivery.branch}\`, which lands as a merge commit once its checks pass.`;
  const replayedLines = outcome.replayed.length === 0
    ? ["- (none)"]
    : outcome.replayed.map((r) =>
      `- #${r.prNumber} — ${
        r.issueNumber !== null ? `sub-issue #${r.issueNumber}` : "no sub-issue"
      }`
    );
  const skippedLines = outcome.skipped.length === 0
    ? ["- (none)"]
    : outcome.skipped.map((s) =>
      `- #${s.prNumber} — ${
        s.issueNumber !== null
          ? `sub-issue #${s.issueNumber} — ${s.reason} — re-queued`
          : `no sub-issue, nothing re-queued — ${s.reason}`
      }`
    );
  return [
    // Issue #3036: the rebuild is a fresh start, so it restarts the shared
    // budget — the redo gets its own attempts rather than inheriting the
    // spent ones that triggered it, and the next pass does not rebuild again.
    conflictResolvedMarker("takeover", outcome.rebuildSha),
    `♻️ **\`${outcome.milestoneBranch}\` was rebuilt from ` +
    `\`${outcome.baseBranch}\`**`,
    "",
    `Base: \`${outcome.baseBranch}\`@\`${outcome.baseSha}\`. Rebuild: ` +
    `\`${outcome.rebuildSha}\`.`,
    "",
    deliveryLine,
    "",
    "**Replayed (merge order)**",
    "",
    ...replayedLines,
    "",
    "**Skipped**",
    "",
    ...skippedLines,
    "",
    "No human is asked: every skipped sub-PR's sub-issue is re-queued for a " +
    `redo on a fresh branch cut from \`${outcome.milestoneBranch}\`'s ` +
    "current tip, and there is no cap on how often a milestone may be " +
    "rebuilt.",
  ].join("\n");
}

/** The comment posted on a skipped sub-PR's re-queued sub-issue. */
export function buildSubIssueRequeueComment(args: {
  repo: string;
  milestoneBranch: string;
  subPrNumber: number;
  subPrHeadRefName: string;
  baseBranch: string;
  rebuildSha: string;
  label: RequeueLabel;
}): string {
  const { repo, milestoneBranch, subPrNumber, subPrHeadRefName } = args;
  const labelClause = "kept" in args.label
    ? `it keeps the \`${requeueLabelName(args.label)}\` label it already ` +
      "carries"
    : `\`${
      requeueLabelName(args.label)
    }\` is being applied to it, since it carried no pickup label`;
  return [
    conflictRestartMarker(repo, subPrNumber, subPrHeadRefName),
    buildRollbackMarker({
      prNumber: subPrNumber,
      revertSha: args.rebuildSha,
      branch: milestoneBranch,
    }),
    "♻️ **Re-queued: this sub-PR's work did not survive a milestone rebuild**",
    "",
    `\`${milestoneBranch}\` was rebuilt from \`${args.baseBranch}\` ` +
    "(Issue #3035). Sub-PR " +
    `#${subPrNumber} did not replay cleanly onto the rebuild, so its work ` +
    `is not in the rebuilt branch.`,
    "",
    `This issue is re-queued — ${labelClause} — for a redo on a fresh ` +
    `branch cut from \`${milestoneBranch}\`'s current tip. No human is ` +
    "needed, and there is no cap on how many times this may happen.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The rebuild
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Rebuild a conflicted `milestone/**` branch from its base tip, replaying
 * every sub-PR that merged into it, and deliver the result (Issue #3035).
 *
 * Never throws: every failure is returned as `{ outcome: "failed", step }`.
 */
export async function abandonAndRebuildMilestone(
  request: AbandonRestartRequest,
  deps: MilestoneRebuildDeps,
): Promise<MilestoneRebuildOutcome> {
  const { repo, prNumber, branchName, baseBranch } = request;
  const { gh, git, logger } = deps;

  const failed = (
    step: AbandonStep,
    message: string,
    issueNumber?: number,
  ): MilestoneRebuildOutcome => {
    logger?.error?.("Milestone rebuild failed", {
      repo,
      prNumber,
      step,
      ...(issueNumber !== undefined ? { issueNumber } : {}),
      error: message,
    });
    return {
      outcome: "failed",
      step,
      message,
      ...(issueNumber !== undefined ? { issueNumber } : {}),
    };
  };

  // --- Step 0: this must be a milestone head, and the refs must be safe. --
  if (!isMilestoneHead(branchName)) {
    return failed(
      "milestone-rebuild",
      `'${branchName}' is not a milestone branch — the milestone rebuild ` +
        "route only applies to milestone/** heads",
    );
  }
  try {
    assertSafeGitRef(branchName, "milestone branch");
    assertSafeGitRef(baseBranch, "base branch");
  } catch (error) {
    return failed("milestone-rebuild", errorMessage(error));
  }

  // --- Step 1: list the merged sub-PRs, in merge order. --------------------
  let subPrs: MergedSubPr[];
  try {
    subPrs = await listMergedSubPrs(repo, branchName, gh);
  } catch (error) {
    return failed("milestone-sub-prs", errorMessage(error));
  }
  if (subPrs.length === 0) {
    return failed(
      "milestone-sub-prs",
      `no merged sub-PRs were found for '${branchName}' — refusing to reset ` +
        "it to the bare base tip, which would silently drop anything that " +
        "landed on it another way",
    );
  }

  // --- Step 2: fetch both branches, and start the rebuild at the base tip. -
  const fetchBase = await git(buildFetchTrackingRefArgs("origin", baseBranch));
  if (fetchBase.code !== 0) {
    return failed(
      "milestone-rebuild",
      `could not fetch '${baseBranch}': ${fetchBase.stderr}`,
    );
  }
  const fetchBranch = await git(
    buildFetchTrackingRefArgs("origin", branchName),
  );
  if (fetchBranch.code !== 0) {
    return failed(
      "milestone-rebuild",
      `could not fetch '${branchName}': ${fetchBranch.stderr}`,
    );
  }

  const revParseBase = await git([
    "rev-parse",
    "--verify",
    `refs/remotes/origin/${baseBranch}^{commit}`,
  ]);
  if (revParseBase.code !== 0) {
    return failed(
      "milestone-rebuild",
      `could not resolve the base tip of '${baseBranch}': ` +
        revParseBase.stderr,
    );
  }
  const baseSha = revParseBase.stdout.trim();

  const checkout = await git(["checkout", "--detach", baseSha]);
  if (checkout.code !== 0) {
    return failed(
      "milestone-rebuild",
      `could not detach onto the base tip ${baseSha}: ${checkout.stderr}`,
    );
  }

  // --- Step 3: replay every sub-PR, in merge order. -------------------------
  const replayed: SubPrReplay[] = [];
  const skipped: SkippedSubPr[] = [];
  for (const subPr of subPrs) {
    if (subPr.mergeCommitSha === null) {
      skipped.push({
        prNumber: subPr.number,
        issueNumber: subPr.issueNumber,
        sha: null,
        reason: "no merge commit recorded",
      });
      continue;
    }
    const sha = subPr.mergeCommitSha;

    const revList = await git(["rev-list", "--parents", "-n", "1", sha]);
    if (revList.code !== 0) {
      skipped.push({
        prNumber: subPr.number,
        issueNumber: subPr.issueNumber,
        sha,
        reason: "merge commit not found in the clone",
      });
      continue;
    }
    const tokens = revList.stdout.trim().split(/\s+/).filter((t) =>
      t.length > 0
    );
    const parentCount = Math.max(tokens.length - 1, 0);

    const cherryPickArgs = [
      "cherry-pick",
      "--allow-empty",
      "--keep-redundant-commits",
      ...(parentCount > 1 ? ["-m", "1"] : []),
      sha,
    ];
    const cherryPick = await git(cherryPickArgs);
    if (cherryPick.code !== 0) {
      logger?.warn?.(
        `Sub-PR #${subPr.number} (${sha}) did not replay onto the ` +
          `${branchName} rebuild`,
        { repo, prNumber, subPr: subPr.number, stderr: cherryPick.stderr },
      );
      const reset = await git(["reset", "--hard", "HEAD"]);
      if (reset.code !== 0) {
        return failed(
          "milestone-rebuild",
          `cherry-pick of sub-PR #${subPr.number} (${sha}) failed and the ` +
            `clone could not be reset afterwards: ${reset.stderr}`,
        );
      }
      skipped.push({
        prNumber: subPr.number,
        issueNumber: subPr.issueNumber,
        sha,
        reason: `did not replay cleanly onto ${baseBranch}`,
      });
      continue;
    }
    replayed.push({
      prNumber: subPr.number,
      issueNumber: subPr.issueNumber,
      sha,
    });
  }

  // --- Step 4: make the rebuild a descendant of the milestone tip. ---------
  const merge = await git([
    "merge",
    "-s",
    "ours",
    "--no-edit",
    "-m",
    `Rebuild ${branchName} from ${baseBranch} (Issue #3035)`,
    `refs/remotes/origin/${branchName}`,
  ]);
  if (merge.code !== 0) {
    return failed(
      "milestone-rebuild",
      `could not make the rebuild a descendant of '${branchName}': ` +
        merge.stderr,
    );
  }
  const revParseHead = await git(["rev-parse", "HEAD"]);
  if (revParseHead.code !== 0) {
    return failed(
      "milestone-rebuild",
      `could not read the rebuild's own sha: ${revParseHead.stderr}`,
    );
  }
  const rebuildSha = revParseHead.stdout.trim();

  // --- Step 5: deliver. Never a force-push. ---------------------------------
  const push = await git(
    buildPushCreateBranchArgs("origin", "HEAD", branchName),
  );
  let delivery: MilestoneDelivery;
  if (push.code === 0) {
    delivery = { kind: "pushed" };
  } else if (isRuleViolationPush(`${push.stderr}\n${push.stdout}`)) {
    const raiseSyncPr = deps.raiseSyncPr ?? raiseMilestoneSyncPr;
    const raised = await raiseSyncPr(repo, branchName, baseBranch, {
      git,
      gh,
      log: (message: string) => logger?.info?.(message),
    });
    if (!raised.ok) {
      return failed("milestone-push", errorMessage(raised.error));
    }
    delivery = {
      kind: "sync-pr",
      branch: raised.value.branch,
      opened: raised.value.opened,
    };
  } else {
    return failed(
      "milestone-push",
      `could not push the rebuild to '${branchName}': ${push.stderr}`,
    );
  }

  // --- Step 6: re-queue every skipped sub-PR's sub-issue. -------------------
  const requeued: RequeuedSubIssue[] = [];
  const requeuedIssueNumbers = new Set<number>();
  for (const skip of skipped) {
    if (skip.issueNumber === null) continue;
    if (requeuedIssueNumbers.has(skip.issueNumber)) continue;
    requeuedIssueNumbers.add(skip.issueNumber);

    const issueNumber = skip.issueNumber;
    let snapshot: IssueSnapshot;
    try {
      snapshot = await fetchIssueSnapshot(repo, issueNumber, gh);
    } catch (error) {
      return failed("sub-issue-requeue", errorMessage(error), issueNumber);
    }
    const label = planRequeueLabel(snapshot.labels);

    const subPr = subPrs.find((p) => p.number === skip.prNumber);
    try {
      await gh([
        "issue",
        "comment",
        String(issueNumber),
        "--repo",
        repo,
        "--body",
        buildSubIssueRequeueComment({
          repo,
          milestoneBranch: branchName,
          subPrNumber: skip.prNumber,
          subPrHeadRefName: subPr?.headRefName ?? "",
          baseBranch,
          rebuildSha,
          label,
        }),
      ]);
    } catch (error) {
      return failed("sub-issue-requeue", errorMessage(error), issueNumber);
    }

    if (snapshot.state.toUpperCase() === "CLOSED") {
      try {
        await gh(["issue", "reopen", String(issueNumber), "--repo", repo]);
      } catch (error) {
        return failed("sub-issue-requeue", errorMessage(error), issueNumber);
      }
    }

    if ("applied" in label) {
      try {
        const labelled = deps.addLabel
          ? await deps.addLabel(repo, issueNumber, label.applied)
          : await addLabelToIssue(repo, issueNumber, label.applied, {
            ghCommandFn: gh,
          });
        if (!labelled.ok) {
          return failed(
            "sub-issue-requeue",
            errorMessage(labelled.error),
            issueNumber,
          );
        }
      } catch (error) {
        return failed("sub-issue-requeue", errorMessage(error), issueNumber);
      }
    }

    requeued.push({ issueNumber, prNumber: skip.prNumber, label });
  }

  const outcome: MilestoneRebuilt = {
    outcome: "milestone-rebuilt",
    milestoneBranch: branchName,
    baseBranch,
    baseSha,
    rebuildSha,
    replayed,
    skipped,
    requeued,
    delivery,
  };

  // --- Step 7: one comment on the milestone PR. -----------------------------
  try {
    await gh([
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      repo,
      "--body",
      buildMilestoneRebuildPrComment(outcome),
    ]);
  } catch (error) {
    return failed("pr-comment", errorMessage(error));
  }

  logger?.warn?.(describeMilestoneRebuild(outcome), {
    repo,
    prNumber,
    replayedIssues: replayed
      .map((r) => r.issueNumber)
      .filter((n): n is number => n !== null),
    skippedIssues: skipped
      .map((s) => s.issueNumber)
      .filter((n): n is number => n !== null),
  });

  return outcome;
}
