/**
 * PR merge-conflict resolution processor (Issue #84).
 *
 * **Merge conflicts are the worker's to resolve — never a person's.** A
 * conflicting PR is handled here end to end (replay onto the current base,
 * the deterministic rules, the resolution agent on the residue, retried
 * across cycles). No outcome of this processor may label a PR or issue
 * `needs-human` for a conflict or ask a human to merge; a path that does is
 * a bug (Issues #2214, #2226).
 *
 * This is the handler Issue #4373 deferred to and nobody implemented. The
 * branch updater refuses to side-pick a conflict — correctly, after a rebase
 * silently destroyed a PR's own changes — and hands the PR off to "the
 * PR-feedback agent or a human". PR feedback needs a review comment, CI fix
 * needs a failing check, and a CONFLICTING PR has neither, so the hand-off
 * had no receiver and PRs sat conflicting indefinitely.
 *
 * The contract this processor implements is exactly #4373's:
 *
 * - Perform a **real merge** of the base into the PR branch. Both sides'
 *   changes survive, or the attempt stops and escalates — never a side-pick.
 *   The one narrow exception is issue intent (Issue #1114): where the
 *   originating issues behind *both* sides are known and one explicitly
 *   supersedes the other, the agent resolves to the intended outcome and both
 *   issues are named on the PR. Absent that evidence the contract is unchanged,
 *   and the mechanical guards below apply either way.
 * - Run the repo's quality gate on the merged result (the agent does this;
 *   a conflicting PR has had no CI at all, so this is often the first run).
 * - Push without force, so every commit on the PR survives.
 * - Comment on the PR describing what was merged.
 *
 * The pass is bounded, and every attempt ends visibly (Issue #395): the
 * attempt is recorded on the PR *before* the merge runs, and each outcome —
 * merged, failed, escalated — posts its own conclusion marker. An attempt
 * that opened and never concluded was disrupted rather than judged, so it
 * does not spend the budget; the next attempt says so loudly on the PR. The
 * final *concluded* failure escalates with `needs-human` and a conflict
 * summary instead of retrying forever.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger, RepoConfig, Result } from "../types.ts";
import type { WorkerDeps } from "./issue_worker_wiring.ts";
import {
  createMergeConflictReplyReader,
  runMergeConflictAgent,
} from "./merge_conflict_agent.ts";
import { standDownMilestoneHead } from "./gated_head_guard.ts";
import { assertNever } from "./assert_never.ts";
import { isRuleViolationPush } from "./milestone_sync_pr.ts";
import { preparePrBranch } from "./pr_branch_preparation.ts";
import {
  type HeartbeatHandle,
  startHeartbeat,
  stopHeartbeat,
} from "./heartbeat.ts";
import {
  acquireBranchUpdateLock,
  type BranchLockRenewalHandle,
  releaseBranchUpdateLock,
  startBranchUpdateLockRenewal,
} from "./pr_branch_lock.ts";
import { assertPushTargetAllowed, resolvePreFlightSpec } from "./git_push.ts";
import { buildPushArgs } from "./git_ref_args.ts";
import { appendRunIdTrailer, getRunId } from "./run_id.ts";
import { fetchIssueCommentPages } from "./issue_comment_pages.ts";
import { partitionConflictComments } from "./conflict_marker_trust.ts";
import {
  decideLadderRung,
  parseLadderState,
} from "./conflict_verdict_ladder.ts";
import {
  conflictNudgeMarker,
  isConflictHeadSha,
} from "./merge_conflict_markers.ts";
import { ensureHistoryDepth } from "./git_history.ts";
import { escalateToHuman } from "./needs_human_escalation.ts";
import { createGhEscalationClient } from "./gh_escalation_client.ts";
import { BOTH_INSERTED_RULE_NAME } from "./both_inserted_conflict_rule.ts";
import {
  applyDependencyConflictRules,
  type DependencyRuleApplier,
  type ResolvedConflictFile,
} from "./dependency_conflict_apply.ts";
import type { DependencyDecision } from "./dependency_conflict_decisions.ts";
import {
  type ConflictIssueContext,
  gatherConflictIssueContext,
} from "./conflict_issue_context.ts";
import {
  buildConsultedIssuesSection,
  buildIntentOverrideSection,
  findUncorroboratedOverrides,
  parseIntentOverrides,
} from "./conflict_intent_audit.ts";
import {
  abandonAndRestart,
  type AbandonRestartOutcome,
  type AbandonRestartRequest,
  describeExhaustedRoute,
  exhaustedEscalationDedupKey,
  exhaustedEscalationRoute,
  requeueLabelName,
} from "./conflict_abandon_restart.ts";
import {
  clearMergeConflictLabel,
  CONFLICT_ATTEMPT_MARKER,
  CONFLICT_FAILED_MARKER,
  CONFLICT_RESOLVED_MARKER,
  DEFAULT_MAX_CONFLICT_ATTEMPTS,
  DEFAULT_MAX_DISRUPTED_ATTEMPTS,
  recordConflictDecision,
} from "./pr_merge_conflict_scan.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The conflicting PR to resolve. */
export interface MergeConflictInput {
  /** Repository in `owner/repo` format. */
  repo: string;
  /** PR number. */
  prNumber: number;
  /** Head branch name. */
  branchName: string;
  /** Base branch the PR targets. */
  baseBranch: string;
  /** Attempts that reached a conclusion — what spends the budget. */
  attemptCount: number;
  /**
   * Attempts disrupted before they concluded (Issue #395). Surfaced on the
   * PR so a silent stall cannot masquerade as a quiet queue.
   */
  disruptedCount?: number;
}

/** Outcome of one conflict-resolution attempt. */
export interface MergeConflictResult {
  /** Whether the attempt ran (false when the PR was locked or gone). */
  processed: boolean;
  /** Whether a merge was pushed to the PR branch. */
  merged: boolean;
  /** Whether the attempt escalated the PR to a human. */
  escalated: boolean;
  /** Human-readable summary. */
  summary: string;
  /**
   * Explicitly `false` when this pass opened an attempt and then withdrew it:
   * the watchdog SIGTERMed the agent because the cycle ended (Issue #1693),
   * or a repository ruleset refused the push (Issue #1772). Neither is the
   * PR's fault, so the attempt marker is deleted and the PR's budget is
   * untouched. Absent everywhere else — those paths either concluded their
   * attempt or never opened one.
   */
  attemptCharged?: boolean;
  /**
   * Explicitly `true` when the withdrawal happened because **the run itself**
   * was ending (Issue #1693) — the one withdrawal the drain must stop on,
   * because taking the next PR would open an attempt marker and withdraw it
   * again. Kept apart from {@link MergeConflictResult.attemptCharged}
   * (Issue #1772): a ruleset refusal is also uncharged, but it says nothing
   * about the run's remaining time, so the drain carries on to the next PR.
   */
  runEnded?: boolean;
  /**
   * The stale-verdict ladder rung this pass ran (Issues #2272, #2278).
   *
   * Set only when GitHub's `CONFLICTING` verdict turned out to be stale — the
   * base was already an ancestor of the PR head — so no merge was attempted
   * and no attempt was opened. `rebase` and `abandon` are named here for the
   * sub-issues that wire those rungs; only `nudge` is reachable today.
   */
  rung?: "nudge" | "rebase" | "abandon";
}

/** Dependencies for {@link processMergeConflict}. */
export interface MergeConflictProcessorDeps {
  /** Logger for diagnostic output. */
  logger: Logger;
  /** Worker deps for cross-cutting concerns. */
  deps: WorkerDeps;
  /** Working directory — the target repo checkout. */
  workDir: string;
  /**
   * The `WORK_DIR` root where heartbeat and marker state files live — never a
   * clone (Issue #1660).
   *
   * Kept separate from {@link MergeConflictProcessorDeps.workDir}, which is the
   * clone every git and agent `cwd` uses. It cannot be derived from the clone's
   * parent: a lane worktree sits at `<workRoot>/worktrees/<lane>/<repo>`, so
   * `dirname` names the lane, not the root.
   */
  workRoot: string;
  /** Quality instructions for the prompt. */
  qualityInstructions?: string;
  /** Custom repo-specific instructions. */
  customInstructions?: string;
  /** Claude hard timeout in seconds. */
  claudeTimeout?: number;
  /** Silence watchdog in seconds (Issue #1825). */
  claudeNoOutputTimeout?: number;
  /** Maximum rate-limit retries. */
  maxRateLimitRetries?: number;
  /** Unique worker identity for the cross-host PR lock. */
  workerId?: string;
  /** Attempts allowed before escalating (default 2). */
  maxAttempts?: number;
  /** Label applied on escalation. Defaults to `needs-human`. */
  needsHumanLabel?: string;
  /** Per-repo config, used to resolve the pre-flight push gate. */
  repoConfigs?: Record<string, RepoConfig>;
  /** Override the prompts directory (tests). */
  promptsDir?: string;
  /** Injectable lock acquisition. Defaults to {@link acquireBranchUpdateLock}. */
  acquireLockFn?: typeof acquireBranchUpdateLock;
  /** Injectable lock release. Defaults to {@link releaseBranchUpdateLock}. */
  releaseLockFn?: typeof releaseBranchUpdateLock;
  /**
   * Injectable lock renewal. Defaults to
   * {@link startBranchUpdateLockRenewal}.
   */
  startLockRenewalFn?: typeof startBranchUpdateLockRenewal;
  /** Renewal interval in milliseconds (tests). */
  lockRenewalIntervalMs?: number;
  /**
   * Injectable deterministic dependency-rule pass (Issue #466). Defaults to
   * {@link applyDependencyConflictRules}.
   */
  applyDependencyRulesFn?: DependencyRuleApplier;
  /**
   * Injectable originating-issue gather (Issue #1114). Defaults to
   * {@link gatherConflictIssueContext}.
   */
  gatherIssueContextFn?: typeof gatherConflictIssueContext;
  /**
   * Injectable abandon-and-restart rung (Issue #1115) — what the final
   * concluded failure tries before a human. Defaults to
   * {@link abandonAndRestart}.
   */
  abandonRestartFn?: (
    request: AbandonRestartRequest,
  ) => Promise<AbandonRestartOutcome>;
  /**
   * Fleet logins whose marker comments count (Issue #1247), passed through to
   * the abandon rung.
   *
   * Left empty, a restart claim on the originating issue cannot be
   * attributed, so the rung declines and the conflict rests at `needs-human`
   * naming that route — loud and non-destructive, never a silent close.
   */
  trustedAuthors?: readonly string[];
}

/** What the human must do when the worker gives up on a conflict. */
export const CONFLICT_ESCALATION_NEXT_STEP =
  "Merge the base branch into the PR branch by hand, keeping both sides' " +
  "changes, run the repo's quality gate on the result, and push. Remove the " +
  "`needs-human` label once the PR is mergeable again.";

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/** Minimal git runner surface this processor needs. */
type GitRunner = WorkerDeps["git"]["runGitCommand"];

interface GitOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a git command, folding a spawn failure into a non-zero exit so no
 * caller can mistake "could not run git" for "git said nothing was wrong"
 * (fail loud — Issue #3234).
 */
async function git(
  run: GitRunner,
  args: string[],
  cwd: string,
): Promise<GitOutcome> {
  const result = await run(args, { cwd });
  if (!result.ok) {
    return { code: 1, stdout: "", stderr: result.error.message };
  }
  return result.value;
}

/** Paths git still reports as unmerged. */
export function parseUnmergedPaths(stdout: string): string[] {
  return stdout.split("\n").map((line) => line.trim()).filter((line) =>
    line.length > 0
  );
}

/**
 * Whether the resolution left conflict markers in the files it resolved.
 *
 * Scoped to `paths` — the files this merge actually conflicted in — and never
 * the whole tree (Issue #584). A tree-wide grep fails on any repository that
 * legitimately contains marker-shaped lines: GRQ carries
 * `docs/JSON_Merge_Conflict_Prevention.md`, a document *about* merge
 * conflicts, whose worked example opens `<<<<<<< Updated upstream`. Every
 * conflict in that repository was therefore rejected after a correct
 * resolution — the deterministic lock rules resolved `deno.lock`, and the
 * guard then aborted the merge over a documentation file nothing had touched.
 *
 * `git grep` exits 1 when nothing matches, so a zero exit with output is
 * the only "markers remain" signal. An empty `paths` means nothing was
 * resolved, so there is nothing to check.
 */
async function hasConflictMarkers(
  run: GitRunner,
  cwd: string,
  paths: readonly string[],
): Promise<boolean> {
  if (paths.length === 0) return false;
  const result = await git(run, [
    "grep",
    "-l",
    "-I",
    "-E",
    "^(<<<<<<<|>>>>>>>) ",
    "--",
    ...paths,
  ], cwd);
  return result.code === 0 && result.stdout.trim().length > 0;
}

/**
 * The sha `rev-parse` reports for a revision, or `null` when it reports none.
 *
 * A failure is logged at warn rather than thrown: every caller here uses the
 * sha to *detect* a fault (a merge that moved nothing, a nudge that committed
 * nothing), and an unreadable HEAD is not itself that fault. It is never
 * silent — a caller that cannot compare says so and declines the check.
 */
async function readSha(
  run: GitRunner,
  cwd: string,
  revision: string,
  logger: Logger,
  repo: string,
): Promise<string | null> {
  const result = await git(run, ["rev-parse", revision], cwd);
  const sha = result.stdout.trim().toLowerCase();
  if (result.code !== 0 || !isConflictHeadSha(sha)) {
    logger.warn(
      "Could not read a git object name for the merge-conflict pass",
      {
        repo,
        revision,
        detail: result.stderr.trim() || result.stdout.trim(),
      },
    );
    return null;
  }
  return sha;
}

/** The sha `HEAD` points at, or `null` when it cannot be read. */
function readHeadSha(
  run: GitRunner,
  cwd: string,
  logger: Logger,
  repo: string,
): Promise<string | null> {
  return readSha(run, cwd, "HEAD", logger, repo);
}

/** Abort an in-progress merge, leaving the branch exactly as its author had it. */
async function abortMerge(run: GitRunner, cwd: string): Promise<void> {
  await git(run, ["merge", "--abort"], cwd);
}

// ---------------------------------------------------------------------------
// Comment helpers
// ---------------------------------------------------------------------------

/**
 * Body of the comment that records an attempt before it runs.
 *
 * When earlier attempts were disrupted rather than judged, the comment says
 * so (Issue #395) — the silence on GRQ#4408/#4409 after "attempt 1 of 2" is
 * exactly the state this makes visible.
 */
export function buildAttemptComment(
  attemptNumber: number,
  maxAttempts: number,
  baseBranch: string,
  disruptedCount: number = 0,
): string {
  const lines = [
    `${CONFLICT_ATTEMPT_MARKER} n="${attemptNumber}" -->`,
    `🔀 **Merge-conflict resolution — attempt ${attemptNumber} of ${maxAttempts}**`,
    "",
    `This PR conflicts with \`${baseBranch}\`, so no CI can run on it. The ` +
    "worker is merging the base branch in for real — both sides' changes " +
    "must survive — and will run the repository's quality gate on the result.",
  ];

  if (disruptedCount > 0) {
    lines.push(
      "",
      `⚠️ **${disruptedCount} earlier attempt(s) were disrupted** — they ` +
        "opened an attempt and never reported a conclusion, so the conflict " +
        "was never judged. A disrupted attempt does not spend the " +
        `${maxAttempts}-attempt budget; after ` +
        `${DEFAULT_MAX_DISRUPTED_ATTEMPTS} disruptions this PR is handed to ` +
        "a human instead.",
    );
  }

  return lines.join("\n");
}

/**
 * One dependency decision, in a form a reviewer can audit without the diff.
 *
 * The rules pick the higher published version per dependency key — a
 * documented carve-out from the never-side-pick contract — so the comment
 * states both sides' specifiers and which one is now in the tree.
 */
export function describeDependencyDecision(
  decision: DependencyDecision,
  baseBranch: string,
  branchName: string,
): string {
  const name = decision.key === null ? "a line" : `\`${decision.key}\``;
  const { ours, theirs, kept } = decision;

  if (kept === null) {
    return `  - ${name}: dropped (\`${branchName}\`: ${
      ours ?? "absent"
    }, \`${baseBranch}\`: ${theirs ?? "absent"})`;
  }
  if (ours === null) {
    return `  - ${name}: \`${kept}\` — added by \`${baseBranch}\``;
  }
  if (theirs === null) {
    return `  - ${name}: \`${kept}\` — kept from \`${branchName}\`, which ` +
      `\`${baseBranch}\` does not carry`;
  }
  if (kept === theirs) {
    return `  - ${name}: \`${ours}\` → \`${kept}\` (taken from \`${baseBranch}\`)`;
  }
  return `  - ${name}: \`${kept}\` kept from \`${branchName}\` ` +
    `(\`${baseBranch}\` had \`${theirs}\`)`;
}

/**
 * The section naming what the deterministic rules resolved (Issue #466).
 *
 * Empty when the rules resolved nothing, so a conflict the agent handled alone
 * produces exactly the comment it produced before.
 */
export function buildRuleResolutionSection(
  ruleResolved: readonly ResolvedConflictFile[],
  baseBranch: string,
  branchName: string,
): string[] {
  if (ruleResolved.length === 0) return [];

  const lines = [
    "",
    "**Resolved by deterministic rule — no AI decision was involved for " +
    "these files:**",
    "",
  ];
  for (const file of ruleResolved) {
    if (file.kind === "lock") {
      lines.push(
        `- \`${file.path}\` — never text-merged; regenerated from the merged ` +
          `manifest with \`${file.resolvedBy}\``,
      );
      continue;
    }
    if (file.resolvedBy === BOTH_INSERTED_RULE_NAME) {
      // Not a dependency decision at all (Issue #1768): both sides only added
      // to this file, so the per-dependency wording below would describe a
      // pick that was never made.
      lines.push(
        `- \`${file.path}\` (rule \`${file.resolvedBy}\`) — both sides only ` +
          `added to this file, so both additions were kept, ` +
          `\`${baseBranch}\`'s first`,
      );
      continue;
    }
    lines.push(`- \`${file.path}\` (rule \`${file.resolvedBy}\`)`);
    if (file.decisionsUnattributed) {
      lines.push(
        "  - the per-dependency decisions could not be attributed — review " +
          "this file in the diff",
      );
      continue;
    }
    if (file.decisions.length === 0) {
      lines.push("  - both sides agreed on every dependency in the conflict");
      continue;
    }
    for (const decision of file.decisions) {
      lines.push(describeDependencyDecision(decision, baseBranch, branchName));
    }
  }
  if (
    ruleResolved.some((file) => file.resolvedBy !== BOTH_INSERTED_RULE_NAME)
  ) {
    lines.push(
      "",
      "Per dependency key the higher published version wins and every other " +
        "entry from both sides survives, so nothing either branch changed was " +
        "dropped. Audit the picks above rather than in the diff.",
    );
  }
  return lines;
}

/**
 * Body of the comment posted when the merge lands.
 *
 * When the agent settled a conflict on issue intent (Issue #1114) the comment
 * names each override — both issue numbers, the file, and what was superseded
 * — so the judgement is auditable without reading the diff.
 */
export function buildResolvedComment(
  baseBranch: string,
  branchName: string,
  detail?: string,
  ruleResolved: readonly ResolvedConflictFile[] = [],
  issueContext?: ConflictIssueContext | null,
): string {
  const body = detail && detail.trim().length > 0
    ? detail.trim()
    : `Merged \`${baseBranch}\` into \`${branchName}\` and pushed the result.`;
  return [
    `${CONFLICT_RESOLVED_MARKER}\n✅ **Merge conflict resolved**`,
    "",
    body,
    ...buildIntentOverrideSection(parseIntentOverrides(detail), issueContext),
    ...buildRuleResolutionSection(ruleResolved, baseBranch, branchName),
  ].join("\n");
}

/**
 * Body of the comment posted when an attempt is judged and fails (Issue
 * #395).
 *
 * This is the conclusion that turns an opened attempt into a spent one. Its
 * absence is what makes a disrupted attempt detectable on a later scan, so it
 * must be posted for every judged failure — including the last one, which
 * also escalates.
 */
export function buildFailedComment(
  attemptNumber: number,
  maxAttempts: number,
  baseBranch: string,
  failureDetail: string,
  conflictedFiles: readonly string[],
): string {
  const files = conflictedFiles.length > 0
    ? ["", "Conflicted files:", ...conflictedFiles.map((f) => `- \`${f}\``)]
    : [];
  return [
    `${CONFLICT_FAILED_MARKER} n="${attemptNumber}" -->`,
    `❌ **Merge-conflict resolution — attempt ${attemptNumber} of ${maxAttempts} failed**`,
    "",
    `Merging \`${baseBranch}\` in did not produce a mergeable branch: ` +
    `${failureDetail}`,
    ...files,
    "",
    "The branch was left exactly as its author pushed it — the worker never " +
    "side-picks a conflict (Issue #4373), so no change has been lost.",
  ].join("\n");
}

/**
 * Message of the empty commit the nudge rung pushes (Issues #2272, #2278).
 *
 * It names the base sha the ancestry check found, so a reader can verify the
 * claim from the commit alone, and carries the `Vibe-Coder-Run-Id` trailer the
 * pre-commit gate requires of every worker-authored commit.
 */
export function buildNudgeCommitMessage(
  baseBranch: string,
  baseSha: string,
  runId: string,
): string {
  return appendRunIdTrailer(
    [
      "chore: nudge GitHub to recompute this PR's merge status (Issue #2272)",
      "",
      `GitHub reports this PR as CONFLICTING, but \`origin/${baseBranch}\` ` +
      `(${baseSha}) is already an ancestor of the PR head — the base's ` +
      "changes are all present and there is nothing left to merge, so the " +
      "verdict is stale.",
      "",
      "This commit is empty. It changes no file; it only moves the head so " +
      "GitHub recomputes mergeability. Safe to ignore.",
    ].join("\n"),
    runId,
  );
}

/**
 * Body of the comment the nudge rung posts (Issues #2272, #2278).
 *
 * Carries {@link conflictNudgeMarker} for the **new** head, which is what
 * bounds the rung to one nudge per head: the next scan reads that marker back
 * and climbs to the rebase rung instead of nudging again.
 */
export function buildNudgeComment(
  baseBranch: string,
  baseSha: string,
  previousHead: string,
  newHead: string,
): string {
  return [
    conflictNudgeMarker(newHead),
    "🔁 **Stale merge verdict — nudged GitHub to recompute it**",
    "",
    `GitHub reports this PR as \`CONFLICTING\`, but \`origin/${baseBranch}\` ` +
    `(\`${baseSha}\`) is **already an ancestor** of the head this PR was at ` +
    `(\`${previousHead}\`). The base's changes are all present, so there is ` +
    "nothing for the resolver to merge — the verdict is stale, not the branch.",
    "",
    "So instead of merging, the worker pushed one **empty commit** — no file " +
    "changes, no `--force`, every existing commit intact — to move the head " +
    `to \`${newHead}\`, which is what makes GitHub recompute the verdict.`,
    "",
    "No resolution attempt was opened or spent on this (Issue #2272).",
  ].join("\n");
}

/** Escalation reason naming what was tried and what is still conflicted. */
export function buildConflictEscalationReason(
  input: MergeConflictInput,
  conflictedFiles: readonly string[],
  failureDetail: string,
  maxAttempts: number,
): string {
  const files = conflictedFiles.length > 0
    ? conflictedFiles.map((f) => `- \`${f}\``).join("\n")
    : "- (git reported no unmerged paths)";
  return [
    `The worker has spent its ${maxAttempts} merge-conflict attempts on ` +
    `PR #${input.prNumber} without producing a mergeable branch, so it has ` +
    "stopped rather than retrying.",
    "",
    `Merging \`${input.baseBranch}\` into \`${input.branchName}\` conflicted in:`,
    "",
    files,
    "",
    `Last failure: ${failureDetail}`,
    "",
    "The branch was left exactly as its author pushed it — the worker never " +
    "side-picks a conflict (Issue #4373), so no change has been lost.",
  ].join("\n");
}

/**
 * The comment id GitHub's own URL names, or `null` when it names none.
 *
 * `gh pr comment` prints the new comment's URL, which ends
 * `#issuecomment-<id>`. That id is what lets the attempt comment be amended
 * later with the issues consulted (Issue #1114) instead of being followed by a
 * second comment.
 */
export function parseCommentId(output: string | undefined): number | null {
  const match = /#issuecomment-(\d+)/.exec(output ?? "");
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function postPrComment(
  deps: WorkerDeps,
  repo: string,
  prNumber: number,
  body: string,
): Promise<number | null> {
  const output = await deps.github.runGhCommand([
    "pr",
    "comment",
    String(prNumber),
    "--repo",
    repo,
    "--body",
    body,
  ]);
  return parseCommentId(output);
}

/**
 * Record on the attempt which issues were consulted (Issue #1114).
 *
 * The attempt comment is posted *before* the merge starts — that ordering is
 * what makes a disrupted attempt detectable (Issue #395) — and the conflicted
 * paths are not known until after it. The consulted issues are therefore
 * appended to that same comment once the gather has run and before the agent
 * is asked anything, so the record survives a resolution that then fails: a
 * reader can tell "consulted and still contradictory" from "never looked".
 *
 * When the comment cannot be amended the section is posted on its own rather
 * than dropped — the audit record must exist either way.
 */
async function recordConsultedIssues(
  processorDeps: MergeConflictProcessorDeps,
  repo: string,
  prNumber: number,
  attemptCommentId: number | null,
  attemptBody: string,
  issueContext: ConflictIssueContext | null,
): Promise<void> {
  const { deps, logger } = processorDeps;
  const section = buildConsultedIssuesSection(issueContext);

  if (attemptCommentId !== null) {
    try {
      await deps.github.runGhCommand([
        "api",
        "-X",
        "PATCH",
        `repos/${repo}/issues/comments/${attemptCommentId}`,
        "-f",
        `body=${[attemptBody, "", ...section].join("\n")}`,
      ]);
      return;
    } catch (err) {
      logger.warn(
        "Could not amend the merge-conflict attempt comment — posting the " +
          "issues consulted separately",
        {
          repo,
          prNumber,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  try {
    await postPrComment(deps, repo, prNumber, section.join("\n"));
  } catch (err) {
    logger.error("Failed to record the issues consulted for the conflict", {
      repo,
      prNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

/**
 * Resolve one conflicting PR by merging its base branch in for real.
 *
 * @param input - The conflicting PR, from the merge-conflict scan.
 * @param processorDeps - Processor dependencies.
 * @returns The attempt outcome. An `ok: false` result means the attempt
 *   itself failed loudly (git or agent error), not that the conflict was
 *   simply too hard — that case returns `ok: true` with `merged: false`.
 */
export async function processMergeConflict(
  input: MergeConflictInput,
  processorDeps: MergeConflictProcessorDeps,
): Promise<Result<MergeConflictResult>> {
  const { repo, prNumber } = input;
  const { logger, workerId } = processorDeps;
  const acquireLock = processorDeps.acquireLockFn ?? acquireBranchUpdateLock;
  const releaseLock = processorDeps.releaseLockFn ?? releaseBranchUpdateLock;

  logger.info("Resolving PR merge conflict", {
    repo,
    prNumber,
    baseBranch: input.baseBranch,
    attemptCount: input.attemptCount,
  });

  // Issue #1772: a `milestone/**` head belongs to the every-cycle milestone
  // branch sync, which owns `default -> milestone/*` merges and already lands
  // them through a sync PR when a ruleset refuses the direct push (#589).
  // Running the ladder here too would duplicate that merge on the same branch
  // and race its push — so stand down whether or not a rule is in force
  // (#1679 stood down only on the gated case). Before the lock, the lock
  // comment and the heartbeat, so the PR churns nothing on every run, and
  // before the attempt marker below, so no attempt is spent.
  if (
    await standDownMilestoneHead({
      repo,
      prNumber,
      branchName: input.branchName,
      logger,
      runGhCommand: processorDeps.deps.github.runGhCommand,
    })
  ) {
    return {
      ok: true,
      value: {
        processed: false,
        merged: false,
        escalated: false,
        summary: `PR #${prNumber} head '${input.branchName}' is a milestone ` +
          `branch — left to the milestone branch sync, no attempt spent`,
      },
    };
  }

  let lockCommentId: number | undefined;
  if (workerId) {
    const lock = await acquireLock({ repo, prNumber, workerId });
    if (!lock.ok || !lock.value.acquired) {
      const winner = lock.ok ? lock.value.winnerId ?? "unknown" : "unknown";
      // The same closed taxonomy the scan and the drain record against, so
      // "another host has it" is a queryable reason rather than prose only
      // (Issue #1109).
      recordConflictDecision(logger, {
        repo,
        prNumber,
        outcome: "skipped",
        reason: { kind: "lock-held", lockHolder: winner },
      });
      return {
        ok: true,
        value: {
          processed: false,
          merged: false,
          escalated: false,
          summary: `PR #${prNumber} locked by ${winner}`,
        },
      };
    }
    lockCommentId = lock.value.lockCommentId;
  } else {
    logger.warn(
      "No workerId configured — resolving the conflict without a cross-host lock",
      { repo, prNumber },
    );
  }

  const heartbeatStart = await startHeartbeat({
    repo,
    issueNumber: prNumber,
    // A PR, not an issue (Issue #391): the kind keys this heartbeat apart
    // from an issue of the same number, and matches the maintenance hold the
    // sweep's live set reports.
    kind: "pr",
    // Issue #1660: the work root, never the clone — `.heartbeat_*` and
    // `.heartbeat-marker_*` written into the clone dirty its tree and stay
    // invisible to stuck recovery and the prune liveness check, which both
    // read the root. `stopHeartbeat` reuses these options, so the final
    // `clearHeartbeat` follows.
    workDir: processorDeps.workRoot,
    recordFn: processorDeps.deps.crashHandling.recordHeartbeat,
    clearFn: processorDeps.deps.crashHandling.clearHeartbeat,
  });
  const heartbeatHandle: HeartbeatHandle | undefined = heartbeatStart.ok
    ? heartbeatStart.value
    : undefined;
  if (!heartbeatStart.ok) {
    logger.warn("Failed to start heartbeat for merge-conflict resolution", {
      repo,
      prNumber,
      error: heartbeatStart.error.message,
    });
  }

  // The lock TTL is five minutes; a resolution runs for as long as the agent
  // takes (Issue #395). Without renewal a second host cleans this lock as
  // stale and starts a competing attempt on the same branch — which races
  // this one's push and leaves this attempt looking disrupted.
  let renewal: BranchLockRenewalHandle | undefined;
  if (lockCommentId !== undefined && workerId) {
    const startRenewal = processorDeps.startLockRenewalFn ??
      startBranchUpdateLockRenewal;
    renewal = startRenewal({
      repo,
      lockCommentId,
      workerId,
      ghCommandFn: processorDeps.deps.github.runGhCommand,
      note: `🔀 Resolving this PR's merge conflict (worker \`${workerId}\`).`,
      ...(processorDeps.lockRenewalIntervalMs !== undefined
        ? { intervalMs: processorDeps.lockRenewalIntervalMs }
        : {}),
      onError: (message: string) =>
        logger.error(`merge_conflict_lock=renew-failed ${message}`, {
          repo,
          prNumber,
        }),
    });
  }

  try {
    return await resolveConflict(input, processorDeps);
  } finally {
    renewal?.stop();
    if (heartbeatHandle) await stopHeartbeat(heartbeatHandle);
    if (lockCommentId !== undefined) {
      await releaseLock({ repo, prNumber, lockCommentId });
    }
  }
}

async function resolveConflict(
  input: MergeConflictInput,
  processorDeps: MergeConflictProcessorDeps,
): Promise<Result<MergeConflictResult>> {
  const { repo, prNumber, branchName, baseBranch } = input;
  const {
    logger,
    deps,
    workDir,
    maxAttempts = DEFAULT_MAX_CONFLICT_ATTEMPTS,
  } = processorDeps;
  const run = deps.git.runGitCommand;
  const attemptNumber = input.attemptCount + 1;

  // Check out the PR branch. A branch that no longer exists on origin means
  // the PR closed or merged since the scan listed it — nothing to do.
  const prepared = await preparePrBranch(branchName, {
    logger,
    git: deps.git,
    cwd: workDir,
  });
  if (!prepared.ok) {
    return {
      ok: true,
      value: {
        processed: false,
        merged: false,
        escalated: false,
        summary:
          `PR #${prNumber} branch '${branchName}' unusable: ${prepared.reason}`,
      },
    };
  }

  const fetchBase = await git(run, ["fetch", "origin", baseBranch], workDir);
  if (fetchBase.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `Failed to fetch base branch '${baseBranch}' for PR #${prNumber}: ${fetchBase.stderr.trim()}`,
      ),
    };
  }

  // Issue #1458: monitored repos are `--depth=1` clones, and a merge on a
  // shallow clone whose tips have diverged fails with "refusing to merge
  // unrelated histories" — GitHub can see the ancestor; the clone cannot.
  // Deepen until the merge base is present (a no-op on a full clone) BEFORE
  // the attempt is opened, so a clone problem never spends an attempt. A
  // branch with no common ancestor even in full history is a human's
  // problem — a re-initialised or rewritten branch — not a conflict the
  // agent failed to resolve.
  const depth = await ensureHistoryDepth([`origin/${baseBranch}`, "HEAD"], {
    cwd: workDir,
    gitRunner: run,
  });
  if (!depth.ok) {
    return await escalateNoCommonAncestor(
      input,
      processorDeps,
      depth.error.message,
    );
  }

  // Issue #2278: GitHub's `CONFLICTING` verdict can be stale. When the base is
  // already an ancestor of the PR head there is nothing left to merge, and the
  // merge below would exit 0 with "Already up to date", push nothing, and fall
  // through to the resolved marker and the label clear — which resets the
  // attempt budget and leaves GitHub's verdict exactly as it was. That loop ran
  // for days on NEAT-AI-Lamarck#239. Ask git first, in the same slot as the
  // deepen step above: **before** the attempt comment, so nothing is spent and
  // no comment has to be withdrawn.
  const staleVerdict = await git(
    run,
    ["merge-base", "--is-ancestor", `origin/${baseBranch}`, "HEAD"],
    workDir,
  );
  if (staleVerdict.code === 0) {
    return await runStaleVerdictLadder(input, processorDeps);
  }

  // The head the merge starts from, for the invariant guard below.
  const headBeforeMerge = await readHeadSha(run, workDir, logger, repo);

  // Record the attempt before merging anything (Issue #84): the marker is
  // what a later scan reads to tell "this attempt was disrupted" from "no
  // attempt has run". It opens the attempt; only a conclusion posted below
  // spends it (Issue #395).
  const attemptBody = buildAttemptComment(
    attemptNumber,
    maxAttempts,
    baseBranch,
    input.disruptedCount ?? 0,
  );
  let attemptCommentId: number | null = null;
  try {
    attemptCommentId = await postPrComment(deps, repo, prNumber, attemptBody);
  } catch (err) {
    // Without the marker the attempt is unbounded, so refuse to start.
    return {
      ok: false,
      error: new Error(
        `Failed to record merge-conflict attempt on PR #${prNumber}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
    };
  }

  const merge = await git(
    run,
    ["merge", `origin/${baseBranch}`, "--no-edit"],
    workDir,
  );

  // Issue #2278: the pre-check above established that the base is *not* an
  // ancestor of HEAD, so a successful merge must move HEAD — by a merge commit
  // or a fast-forward. A zero exit that leaves HEAD where it was is the
  // "Already up to date" no-op the stale route exists to catch, arriving on a
  // route that has just ruled it out. Fail loud rather than posting a resolved
  // marker for a merge that pushed nothing.
  if (merge.code === 0 && headBeforeMerge !== null) {
    const headAfterMerge = await readHeadSha(run, workDir, logger, repo);
    if (headAfterMerge === headBeforeMerge) {
      return {
        ok: false,
        error: new Error(
          `Invariant violated on PR #${prNumber}: 'origin/${baseBranch}' was ` +
            `not an ancestor of '${branchName}' before the merge, yet ` +
            `\`git merge\` succeeded without moving HEAD (still ` +
            `${headBeforeMerge}). Nothing was merged, so nothing may be ` +
            `reported as resolved (Issue #2278).`,
        ),
      };
    }
  }

  let conflictedFiles: string[] = [];
  /** What the deterministic rules resolved, named on the resolved comment. */
  let ruleResolved: readonly ResolvedConflictFile[] = [];
  /** Whether the AI fallback was asked for anything at all. */
  let agentRan = false;
  /** The originating issues behind both sides, when the agent is involved. */
  let issueContext: ConflictIssueContext | null = null;

  // The reply file is consumed on read so a stale reply cannot be reused, and
  // this attempt reads it in up to three places — the override guard, the
  // ancestor failure and the resolved comment. Read it once (Issue #1767).
  const agentReply = createMergeConflictReplyReader(workDir, logger);
  if (merge.code !== 0) {
    const unmerged = await git(
      run,
      ["diff", "--name-only", "--diff-filter=U"],
      workDir,
    );
    conflictedFiles = parseUnmergedPaths(unmerged.stdout);

    if (conflictedFiles.length === 0) {
      // The merge failed for a reason that is not a content conflict (a
      // dirty tree, a missing ref). Leave the branch untouched.
      await abortMerge(run, workDir);
      // Belt and braces for Issue #1458: should git still refuse after the
      // deepen step, name the refusal for what it is rather than spend an
      // attempt on a generic "did not conflict but failed".
      if (/refusing to merge unrelated histories/i.test(merge.stderr)) {
        await deleteAttemptMarker(
          deps,
          repo,
          attemptCommentId,
          logger,
          "no common ancestor even in full history (Issue #1458)",
        );
        return await escalateNoCommonAncestor(
          input,
          processorDeps,
          merge.stderr.trim(),
        );
      }
      return await failAttempt(
        input,
        processorDeps,
        [],
        `git merge did not conflict but failed: ${
          merge.stderr.trim() || merge.stdout.trim()
        }`,
        attemptNumber,
      );
    }

    // Try the deterministic dependency rules first (Issue #466). A version
    // bump on both sides is the one conflict shape the agent's contract
    // forbids it from deciding, and it needs no judgement: the higher
    // published version wins per key. Whatever the rules cannot decide is
    // still the agent's — narrowed to those paths so it is not asked to
    // re-reason about files that are already staged and resolved.
    const applyRules = processorDeps.applyDependencyRulesFn ??
      applyDependencyConflictRules;
    const ruleReport = await applyRules({
      workingDir: workDir,
      conflictedFiles,
      git: (args) => git(run, [...args], workDir),
      logger,
    });
    const deferredFiles = ruleReport.deferred.map((file) => file.path);
    if (ruleReport.resolved.length > 0) {
      logger.info("Deterministic dependency rules resolved conflicted files", {
        repo,
        prNumber,
        ruleResolved: ruleReport.resolved.map((file) => file.path),
        deferred: ruleReport.deferred.map((file) =>
          `${file.path}: ${file.reason}`
        ),
      });
    }

    if (deferredFiles.length > 0) {
      logger.info("Merge conflicted — handing the resolution to the agent", {
        repo,
        prNumber,
        conflictedFiles: deferredFiles,
      });

      // What were the two sides trying to do? (Issue #1114) Gathered only for
      // the paths actually going to the agent — the rule-resolved files cost
      // no judgement, so they cost no lookups either — and recorded on the
      // attempt before the agent is asked anything.
      issueContext = await gatherIssueContext(
        input,
        processorDeps,
        deferredFiles,
      );
      await recordConsultedIssues(
        processorDeps,
        repo,
        prNumber,
        attemptCommentId,
        attemptBody,
        issueContext,
      );

      agentRan = true;
      const agentOutcome = await runMergeConflictAgent({
        repo,
        target: { kind: "pr", prNumber },
        baseBranch,
        conflictedFiles: deferredFiles,
        issueContext,
        workDir,
        promptsDir: processorDeps.promptsDir,
        qualityInstructions: processorDeps.qualityInstructions,
        customInstructions: processorDeps.customInstructions,
        timeouts: {
          claudeTimeout: processorDeps.claudeTimeout,
          claudeNoOutputTimeout: processorDeps.claudeNoOutputTimeout,
          maxRateLimitRetries: processorDeps.maxRateLimitRetries,
        },
        logger,
        runAgent: deps.claude.runClaudeWithRetry,
      });
      if (!agentOutcome.ok) {
        await abortMerge(run, workDir);
        return await failAttempt(
          input,
          processorDeps,
          conflictedFiles,
          agentOutcome.error.message,
          attemptNumber,
        );
      }
      if (agentOutcome.value.terminated) {
        await abortMerge(run, workDir);
        return await withdrawCutShortAttempt(
          input,
          processorDeps,
          attemptCommentId,
          conflictedFiles,
          attemptNumber,
        );
      }
    } else {
      logger.info(
        "Merge conflict resolved by deterministic rules — no agent run",
        { repo, prNumber, conflictedFiles },
      );
    }

    ruleResolved = ruleReport.resolved;

    // The tree must be fully resolved — by the rules, the agent, or both.
    // Unmerged paths or leftover conflict markers mean it is not, so abort
    // rather than pushing a broken merge. These guards run over the whole
    // tree, so they cover the rule-resolved files too.
    const stillUnmerged = parseUnmergedPaths(
      (await git(run, ["diff", "--name-only", "--diff-filter=U"], workDir))
        .stdout,
    );
    if (stillUnmerged.length > 0) {
      await abortMerge(run, workDir);
      return await failAttempt(
        input,
        processorDeps,
        conflictedFiles,
        `${
          agentRan ? "the agent" : "the deterministic rules"
        } left ${stillUnmerged.length} path(s) unmerged: ${
          stillUnmerged.join(", ")
        }`,
        attemptNumber,
      );
    }
    if (await hasConflictMarkers(run, workDir, conflictedFiles)) {
      await abortMerge(run, workDir);
      return await failAttempt(
        input,
        processorDeps,
        conflictedFiles,
        "the working tree still contains conflict markers",
        attemptNumber,
      );
    }

    // An override claimed where both sides' originating issues were *not*
    // known is a side-pick with a justification attached (Issue #1114). The
    // eligibility is the worker's own, so this is decidable here rather than
    // trusted to the model — refuse it before anything is pushed.
    const uncorroborated = findUncorroboratedOverrides(
      parseIntentOverrides(await agentReply()),
      issueContext,
    );
    if (uncorroborated.length > 0) {
      await abortMerge(run, workDir);
      return await failAttempt(
        input,
        processorDeps,
        conflictedFiles,
        `the resolution settled ${
          uncorroborated.map((o) => `\`${o.path}\``).join(", ")
        } on issue intent, but both sides' originating issues were not known ` +
          "for those paths — the both-sides-survive contract applied there",
        attemptNumber,
      );
    }
  }

  // Commit whatever the agent left staged and push. No force: the merge
  // commit fast-forwards the remote branch, so every PR commit survives.
  const preFlight = resolvePreFlightSpec(processorDeps.repoConfigs, repo);
  const finalise = await deps.git.commitAndPushPending(
    branchName,
    `Merge ${baseBranch} into ${branchName} (Issue #84)\n\nResolved the PR's merge conflict without side-picking.`,
    { cwd: workDir },
    false,
    preFlight,
  );
  if (!finalise.ok) {
    // A ruleset refusing the push is a configuration fact, not a resolution
    // the agent got wrong (Issue #1772) — it recurs identically every run, so
    // charging it would burn the PR's budget on something no retry can fix.
    if (isRuleViolationPush(finalise.error.message)) {
      return await withdrawRulesetRefusedAttempt(
        input,
        processorDeps,
        attemptCommentId,
        attemptNumber,
        finalise.error.message,
      );
    }
    return await failAttempt(
      input,
      processorDeps,
      conflictedFiles,
      `commit/push failed: ${finalise.error.message}`,
      attemptNumber,
    );
  }
  if (finalise.value.finalUnpushedCount > 0) {
    // Issue #211: `detail=5 commit(s) could not be pushed` with no git output
    // told an operator nothing. Ask git what the remote would say — a dry-run
    // push has no side effects and names the rejection reason.
    const dryRun = await git(
      run,
      ["push", "--dry-run", "--end-of-options", "origin", branchName],
      workDir,
    );
    const pushOutput = dryRun.stderr + dryRun.stdout;
    const gitDetail = pushOutput.trim().split("\n")
      .slice(-3).join(" | ");
    // Same refusal, reported by the dry run rather than by the push itself.
    if (isRuleViolationPush(pushOutput)) {
      return await withdrawRulesetRefusedAttempt(
        input,
        processorDeps,
        attemptCommentId,
        attemptNumber,
        gitDetail,
      );
    }
    return await failAttempt(
      input,
      processorDeps,
      conflictedFiles,
      `${finalise.value.finalUnpushedCount} commit(s) could not be pushed: ${
        gitDetail || "git reported no output"
      }`,
      attemptNumber,
    );
  }

  // The merge only counts when the base is genuinely an ancestor of the
  // branch tip — that is what "the base's changes survived" means, and it
  // also catches an agent that aborted the merge and escalated instead.
  const ancestor = await git(
    run,
    ["merge-base", "--is-ancestor", `origin/${baseBranch}`, "HEAD"],
    workDir,
  );
  if (ancestor.code !== 0) {
    const detail = await agentReply();
    return await failAttempt(
      input,
      processorDeps,
      conflictedFiles,
      detail && detail.trim().length > 0
        ? detail.trim()
        : `'${baseBranch}' is still not merged into '${branchName}'`,
      attemptNumber,
    );
  }

  const detail = await agentReply();
  try {
    await postPrComment(
      deps,
      repo,
      prNumber,
      buildResolvedComment(
        baseBranch,
        branchName,
        detail,
        ruleResolved,
        issueContext,
      ),
    );
  } catch (err) {
    logger.warn("Failed to post merge-resolved comment", {
      repo,
      prNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    await clearMergeConflictLabel(repo, prNumber, deps.github.runGhCommand);
  } catch (err) {
    logger.warn("Failed to clear the merge-conflict label", {
      repo,
      prNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  logger.info("Merge conflict resolved and pushed", {
    repo,
    prNumber,
    conflictedFiles,
    ruleResolved: ruleResolved.map((file) => file.path),
    agentRan,
  });

  const ruleNote = ruleResolved.length === 0
    ? ""
    : ` (${ruleResolved.length} by deterministic rule${
      agentRan ? "" : ", no AI call"
    })`;
  return {
    ok: true,
    value: {
      processed: true,
      merged: true,
      escalated: false,
      summary: conflictedFiles.length === 0
        ? `Merged ${baseBranch} into PR #${prNumber} cleanly`
        : `Merged ${baseBranch} into PR #${prNumber}, resolving ${conflictedFiles.length} conflicted file(s)${ruleNote}`,
    },
  };
}

/**
 * Run the stale-verdict ladder instead of a merge (Issues #2272, #2278).
 *
 * Reached only when `git merge-base --is-ancestor origin/BASE HEAD` exits 0
 * while GitHub still calls the PR `CONFLICTING`: the base is already in, so
 * there is no merge to attempt and no attempt has been opened. **No path here
 * posts a resolved, attempt or failed marker, and none adds a label** — the
 * conflict is unresolved until GitHub says otherwise, and claiming otherwise
 * is the loop this route replaces.
 *
 * The head sha and the verdict are read together from one `gh pr view`: the
 * scan's projection carries neither, and a rung decided on a head from one
 * moment and a verdict from another is a rung run at the wrong head.
 */
async function runStaleVerdictLadder(
  input: MergeConflictInput,
  processorDeps: MergeConflictProcessorDeps,
): Promise<Result<MergeConflictResult>> {
  const { repo, prNumber, branchName, baseBranch } = input;
  const { logger, deps } = processorDeps;
  const gh = deps.github.runGhCommand;

  let currentHead: string;
  let mergeable: string;
  try {
    // `author` rides along because it is the projection this subsystem's
    // other PR reads use; `headRefOid` and `mergeable` are what decide here.
    const raw = await gh([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "headRefOid,mergeable,author",
    ]);
    const parsed = JSON.parse(raw.trim() || "{}") as {
      headRefOid?: unknown;
      mergeable?: unknown;
    };
    if (
      typeof parsed.headRefOid !== "string" ||
      typeof parsed.mergeable !== "string"
    ) {
      throw new Error("gh reported no headRefOid/mergeable pair");
    }
    currentHead = parsed.headRefOid;
    mergeable = parsed.mergeable;
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `Failed to read the head sha and merge verdict for PR #${prNumber}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
    };
  }

  let decision;
  try {
    const thread = await fetchIssueCommentPages(repo, prNumber, gh);
    const trust = partitionConflictComments(
      thread,
      processorDeps.trustedAuthors ?? [],
    );
    if (trust.unattributable > 0) {
      // Never silent: an unattributable rung marker is discarded, so a rung
      // that already ran can read as un-run and repeat. The nudge is
      // non-destructive, so repeating it is the safe direction — but the
      // reason a rung repeated must be visible.
      logger.warn(
        "Some merge-conflict comments could not be attributed — their ladder " +
          "markers were discarded",
        { repo, prNumber, unattributable: trust.unattributable },
      );
    }
    decision = decideLadderRung({
      state: parseLadderState(trust.trusted, { logger }),
      currentHead,
      mergeable,
    });
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `Failed to decide a stale-verdict ladder rung for PR #${prNumber}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
    };
  }

  logger.info("GitHub's merge verdict is stale — running the ladder", {
    repo,
    prNumber,
    branchName,
    baseBranch,
    currentHead,
    mergeable,
    rung: decision.kind,
  });

  switch (decision.kind) {
    case "not-conflicting": {
      // GitHub has caught up on its own. Drop the label and leave the thread
      // alone — nothing was merged here, so nothing may claim to have been.
      try {
        await clearMergeConflictLabel(repo, prNumber, gh);
      } catch (err) {
        return {
          ok: false,
          error: new Error(
            `Failed to clear the merge-conflict label on PR #${prNumber} ` +
              `after GitHub reported it mergeable again: ${
                err instanceof Error ? err.message : String(err)
              }`,
          ),
        };
      }
      return {
        ok: true,
        value: {
          processed: true,
          merged: false,
          escalated: false,
          attemptCharged: false,
          summary: `PR #${prNumber} is mergeable again — cleared the ` +
            `merge-conflict label, no attempt spent`,
        },
      };
    }

    case "nudge":
      return await runNudgeRung(input, processorDeps, currentHead);

    case "wait":
      logger.warn(
        `Stale merge verdict on PR #${prNumber} — no ladder rung run`,
        { repo, prNumber, currentHead, mergeable, reason: decision.reason },
      );
      return {
        ok: true,
        value: {
          processed: false,
          merged: false,
          escalated: false,
          attemptCharged: false,
          summary: `PR #${prNumber}: GitHub's merge verdict is stale but no ` +
            `ladder rung can run (${decision.reason}) — no attempt spent`,
        },
      };

    case "rebase":
    case "abandon":
      logger.warn(
        `Stale merge verdict on PR #${prNumber} needs the ` +
          `'${decision.kind}' rung, which is not wired yet`,
        { repo, prNumber, currentHead, rung: decision.kind },
      );
      return {
        ok: true,
        value: {
          processed: false,
          merged: false,
          escalated: false,
          attemptCharged: false,
          summary: `PR #${prNumber}: the stale-verdict ladder's ` +
            `'${decision.kind}' rung is not yet wired — no attempt spent`,
        },
      };
  }

  return assertNever(decision);
}

/**
 * Rung 1 — push one empty commit so GitHub recomputes mergeability.
 *
 * Non-destructive by construction: `--allow-empty` changes no file, and the
 * push carries no lease and no force, so every commit the PR already had
 * survives. The comment names the **new** head, which is what stops the next
 * scan nudging the same head twice.
 *
 * Every step is checked and every failure is loud: a commit that did not move
 * HEAD, or a push that did not land, must not be reported as a nudge — the
 * marker would then name a sha nobody can see and the ladder would skip a rung.
 */
async function runNudgeRung(
  input: MergeConflictInput,
  processorDeps: MergeConflictProcessorDeps,
  previousHead: string,
): Promise<Result<MergeConflictResult>> {
  const { repo, prNumber, branchName, baseBranch } = input;
  const { logger, deps, workDir } = processorDeps;
  const run = deps.git.runGitCommand;

  // The default branch is read-only for the worker (Issue #2584), and a PR
  // head that *is* the default branch would otherwise be pushed to here.
  const guard = await assertPushTargetAllowed(branchName, { cwd: workDir });
  if (!guard.ok) {
    return {
      ok: false,
      error: new Error(
        `Refusing to nudge PR #${prNumber}: ${guard.error.message}`,
      ),
    };
  }

  const baseSha = await readSha(
    run,
    workDir,
    `origin/${baseBranch}`,
    logger,
    repo,
  );
  if (baseSha === null) {
    return {
      ok: false,
      error: new Error(
        `Cannot nudge PR #${prNumber}: 'origin/${baseBranch}' has no readable ` +
          `object name, so the ancestry the nudge claims cannot be evidenced`,
      ),
    };
  }

  const commit = await git(
    run,
    [
      "commit",
      "--allow-empty",
      "-m",
      buildNudgeCommitMessage(baseBranch, baseSha, getRunId()),
    ],
    workDir,
  );
  if (commit.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `Failed to create the nudge commit on PR #${prNumber}: ${
          commit.stderr.trim() || commit.stdout.trim()
        }`,
      ),
    };
  }

  const newHead = await readHeadSha(run, workDir, logger, repo);
  if (newHead === null || newHead === previousHead.trim().toLowerCase()) {
    return {
      ok: false,
      error: new Error(
        `The nudge commit on PR #${prNumber} did not move HEAD (still ` +
          `${newHead ?? "unreadable"}) — nothing was pushed and no nudge ` +
          `marker was posted`,
      ),
    };
  }

  // No lease, no force: the new head is a descendant of the old one, so a
  // plain push fast-forwards the remote branch and loses nothing.
  const push = await git(
    run,
    buildPushArgs("origin", branchName),
    workDir,
  );
  if (push.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `Failed to push the nudge commit for PR #${prNumber}: ${
          push.stderr.trim() || push.stdout.trim()
        }`,
      ),
    };
  }

  try {
    await postPrComment(
      deps,
      repo,
      prNumber,
      buildNudgeComment(baseBranch, baseSha, previousHead, newHead),
    );
  } catch (err) {
    // The commit is pushed, so the head has moved; without the marker the next
    // scan nudges this head again rather than climbing. Bounded and harmless,
    // but never silent.
    logger.error("Pushed the nudge commit but could not post its marker", {
      repo,
      prNumber,
      newHead,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  logger.info("Nudged a stale merge verdict", {
    repo,
    prNumber,
    branchName,
    baseBranch,
    baseSha,
    previousHead,
    newHead,
  });

  return {
    ok: true,
    value: {
      processed: true,
      merged: false,
      escalated: false,
      attemptCharged: false,
      rung: "nudge",
      summary: `PR #${prNumber}: 'origin/${baseBranch}' (${baseSha}) is ` +
        `already an ancestor of the head — pushed an empty commit ` +
        `(${newHead}) so GitHub recomputes the verdict, no attempt spent`,
    },
  };
}

/**
 * Gather the originating issues behind both sides of the conflict.
 *
 * Degrades to `null` — today's behaviour, with the attempt comment saying no
 * originating issues were found — rather than failing the attempt: the gather
 * is extra evidence, and a conflict is still resolvable under the unchanged
 * both-sides-survive contract without it. The failure is logged, never
 * swallowed silently.
 */
async function gatherIssueContext(
  input: MergeConflictInput,
  processorDeps: MergeConflictProcessorDeps,
  conflictedPaths: readonly string[],
): Promise<ConflictIssueContext | null> {
  const { logger, deps, workDir } = processorDeps;
  const gather = processorDeps.gatherIssueContextFn ??
    gatherConflictIssueContext;
  try {
    return await gather({
      repo: input.repo,
      prNumber: input.prNumber,
      prBranch: input.branchName,
      baseBranch: input.baseBranch,
      conflictedPaths,
      cwd: workDir,
    }, {
      git: deps.git.runGitCommand,
      gh: deps.github.runGhCommand,
    });
  } catch (err) {
    logger.warn(
      "Could not gather the originating issues for the conflict — resolving " +
        "under the unchanged both-sides-survive contract",
      {
        repo: input.repo,
        prNumber: input.prNumber,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return null;
  }
}

/**
 * Withdraw an attempt marker opened before the attempt turned out not to be
 * one the PR should pay for — a clone fault (Issue #1458), or a run that
 * ended under the agent (Issue #1693).
 * * A marker that cannot be withdrawn is left and said out loud, `why` and all,
 * so the cause is never misattributed: the PR then reads as *disrupted* on
 * the next scan, which is retried rather than judged, and that bound holds.
 *
 * @param why - What withdrew it, named in the warning if the delete fails.
 */
async function deleteAttemptMarker(
  deps: WorkerDeps,
  repo: string,
  commentId: number | null,
  logger: Logger,
  why: string,
): Promise<void> {
  if (commentId === null) {
    // `gh pr comment` printed no comment URL, so the marker on the PR cannot
    // be addressed. Never silent: the attempt would otherwise be left open
    // with nothing saying why (Issue #1693).
    logger.warn(
      "Could not withdraw the attempt marker — no comment id was reported " +
        "when it was posted",
      { repo, why },
    );
    return;
  }
  try {
    await deps.github.runGhCommand([
      "api",
      "-X",
      "DELETE",
      `repos/${repo}/issues/comments/${commentId}`,
    ]);
  } catch (err) {
    logger.warn("Could not withdraw the attempt marker", {
      repo,
      commentId,
      why,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The branch and its base share no common ancestor even in full history
 * (Issue #1458). That is not a conflict the agent failed to resolve, so no
 * attempt is spent: the PR is handed to a human with the ancestry named.
 */
async function escalateNoCommonAncestor(
  input: MergeConflictInput,
  processorDeps: MergeConflictProcessorDeps,
  detail: string,
): Promise<Result<MergeConflictResult>> {
  const { logger, deps } = processorDeps;
  const { repo, prNumber, branchName, baseBranch } = input;

  logger.warn(
    "Merge-conflict resolution needs a common ancestor the clone cannot produce",
    { repo, prNumber, branchName, baseBranch, detail },
  );

  const escalation = await escalateToHuman({
    ghClient: createGhEscalationClient(deps.github.runGhCommand),
    repo,
    target: { kind: "pr", number: prNumber },
    needsHumanLabel: processorDeps.needsHumanLabel ?? "needs-human",
    heading: "Merge conflict needs human attention",
    reason: [
      `\`${branchName}\` and \`origin/${baseBranch}\` share **no common ` +
      `ancestor**, even after the worker fetched full history ` +
      `(\`git fetch --unshallow\`). The branch does not descend from the ` +
      `base — a re-initialised branch, a force-pushed rewrite, or a clone ` +
      `the worker cannot repair — so there is no merge for the resolver to ` +
      `attempt (Issue #1458).`,
      "",
      `git said: \`${detail.split("\n")[0]?.trim() ?? detail}\``,
      "",
      "No resolution attempt was spent on this.",
    ].join("\n"),
    nextStep: `Check the ancestry (\`git merge-base origin/${baseBranch} ` +
      `${branchName}\`). Rebase or recreate the branch from ` +
      `\`origin/${baseBranch}\`, then remove \`needs-human\` and ` +
      `\`merge-conflict\` so the resolver can try again.`,
    dedupKey: `merge-conflict-no-common-ancestor-${prNumber}`,
    ensureLabelColour: "d4c5f9",
    ensureLabelDescription:
      "Worker could not produce a fix; human review required",
    deps: { github: { ensureLabelExists: deps.github.ensureLabelExists } },
    logger,
  });
  if (!escalation.ok) {
    return {
      ok: false,
      error: new Error(
        `Failed to escalate the missing common ancestor on PR #${prNumber}: ${escalation.error.message}`,
      ),
    };
  }

  return {
    ok: true,
    value: {
      processed: true,
      merged: false,
      escalated: true,
      summary: `PR #${prNumber}: no common ancestor between '${branchName}' ` +
        `and 'origin/${baseBranch}' even in full history — escalated to a ` +
        `human, no attempt spent (Issue #1458)`,
    },
  };
}

/**
 * Withdraw an attempt whose push a repository ruleset refused (Issue #1772).
 *
 * GH013 is not a resolution the agent got wrong — the merge itself succeeded,
 * and the same refusal arrives on every run for as long as the rule stands.
 * Charging it spent the PR's two-attempt budget on a push that could never
 * land and escalated a conflict nobody had failed to resolve. So this posts no
 * `CONFLICT_FAILED_MARKER` and deletes the attempt marker instead: the next
 * scan counts neither a concluded attempt nor an open one.
 *
 * A marker that cannot be deleted is left and said out loud by
 * {@link deleteAttemptMarker} — the PR then reads as disrupted, which is
 * retried rather than judged, and that bound still holds.
 */
async function withdrawRulesetRefusedAttempt(
  input: MergeConflictInput,
  processorDeps: MergeConflictProcessorDeps,
  attemptCommentId: number | null,
  attemptNumber: number,
  detail: string,
): Promise<Result<MergeConflictResult>> {
  const { logger, deps } = processorDeps;
  const { repo, prNumber, branchName } = input;

  await deleteAttemptMarker(
    deps,
    repo,
    attemptCommentId,
    logger,
    "the push was refused by a repository ruleset (Issue #1772)",
  );

  logger.warn(
    "Merge-conflict resolution not charged: push rejected by ruleset",
    {
      repo,
      prNumber,
      branchName,
      attempt: attemptNumber,
      attemptCharged: false,
      detail,
    },
  );

  return {
    ok: true,
    value: {
      processed: false,
      merged: false,
      escalated: false,
      attemptCharged: false,
      summary: `Merge-conflict resolution on PR #${prNumber} was not ` +
        `charged: push rejected by ruleset — ${detail}`,
    },
  };
}

/** * Withdraw an attempt the worker itself cut short (Issue #1693).
 *
 * The maintenance-lane watchdog SIGTERMs the agent when the handler is
 * abandoned at the cycle deadline. The tree it leaves is half-resolved, and
 * reading that as "the agent left N path(s) unmerged" charged the kill to the
 * PR. The kill is the worker's decision, so this spends nothing — the same
 * principle the pass already applies to markers the fleet did not author.
 *
 * The attempt marker is deleted, so the next scan sees neither a concluded
 * attempt (which would spend the two-attempt budget) nor an open one (which
 * would spend the three-disruption budget). A marker that cannot be deleted
 * is left and said out loud: the PR then reads as disrupted on the next scan,
 * which is retried rather than judged, and that bound still holds.
 */
async function withdrawCutShortAttempt(
  input: MergeConflictInput,
  processorDeps: MergeConflictProcessorDeps,
  attemptCommentId: number | null,
  conflictedFiles: readonly string[],
  attemptNumber: number,
): Promise<Result<MergeConflictResult>> {
  const { logger, deps } = processorDeps;
  const { repo, prNumber } = input;

  await deleteAttemptMarker(
    deps,
    repo,
    attemptCommentId,
    logger,
    "the run ended under the agent (Issue #1693)",
  );

  logger.warn(
    "Merge-conflict resolution cut short by the run ending — no attempt " +
      "spent, the PR will be retried at the same attempt number",
    {
      repo,
      prNumber,
      attempt: attemptNumber,
      conflictedFiles,
      attemptCharged: false,
    },
  );

  return {
    ok: true,
    value: {
      // Nothing concluded, so the pass did no work on this PR: the attempt is
      // withdrawn, not judged.
      processed: false,
      merged: false,
      escalated: false,
      attemptCharged: false,
      runEnded: true,
      summary:
        `Merge-conflict resolution on PR #${prNumber} was cut short by ` +
        `the run ending — the attempt was withdrawn, not spent`,
    },
  };
}

/**
 * Record a failed attempt, escalating to a human when the budget is spent.
 *
 * The failure is always posted on the PR (Issue #395): it is the conclusion
 * that spends this attempt, and without it the attempt is indistinguishable
 * from one a dying worker abandoned. The branch is left exactly as its author
 * pushed it — the caller has already aborted any in-progress merge.
 */
async function failAttempt(
  input: MergeConflictInput,
  processorDeps: MergeConflictProcessorDeps,
  conflictedFiles: readonly string[],
  failureDetail: string,
  attemptNumber: number,
): Promise<Result<MergeConflictResult>> {
  const { logger, deps } = processorDeps;
  const maxAttempts = processorDeps.maxAttempts ??
    DEFAULT_MAX_CONFLICT_ATTEMPTS;
  const { repo, prNumber } = input;

  logger.warn("Merge-conflict attempt failed", {
    repo,
    prNumber,
    attempt: attemptNumber,
    maxAttempts,
    detail: failureDetail,
  });

  try {
    await postPrComment(
      deps,
      repo,
      prNumber,
      buildFailedComment(
        attemptNumber,
        maxAttempts,
        input.baseBranch,
        failureDetail,
        conflictedFiles,
      ),
    );
  } catch (err) {
    // Below the cap the attempt then reads as disrupted on the next scan and
    // is retried — the safe direction, and bounded by the disruption budget.
    // At the cap the abandon rung runs next, and it re-reads this thread: a
    // missing conclusion means it quotes one failure instead of two, and if
    // `gh` is down for its calls too it stops at a named step. Say so either
    // way rather than swallowing this.
    logger.error("Failed to post the merge-conflict failure conclusion", {
      repo,
      prNumber,
      attempt: attemptNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (attemptNumber < maxAttempts) {
    return {
      ok: true,
      value: {
        processed: true,
        merged: false,
        escalated: false,
        summary:
          `Merge-conflict attempt ${attemptNumber}/${maxAttempts} on PR #${prNumber} failed: ${failureDetail}`,
      },
    };
  }

  // Issue #1115: a human is not the next rung any more. The budget is spent,
  // so the branch has defeated two real merges — usually cheaper to redo than
  // to reconcile, and redoing it needs nobody. Only when that is declined or
  // fails does the escalation below run, and it then says which route it took.
  const abandon = await (processorDeps.abandonRestartFn ??
    ((request: AbandonRestartRequest) =>
      abandonAndRestart(request, {
        gh: deps.github.runGhCommand,
        logger,
        trustedAuthors: processorDeps.trustedAuthors ?? [],
      })))({
      repo,
      prNumber,
      branchName: input.branchName,
      baseBranch: input.baseBranch,
      // No thread passed: the rung fetches it, and fails loud if it cannot —
      // "no failure comment survives" must never be published because a read
      // failed.
    });

  if (abandon.outcome === "abandoned") {
    // Issue #2277: the issue keeps the pickup label it already carried, or
    // gains `idle-task`. Either way it is re-queued without a human.
    const label = requeueLabelName(abandon.label);
    logger.warn(
      `Merge-conflict attempts exhausted on PR #${prNumber} — closed it and ` +
        `re-queued issue #${abandon.issueNumber} (\`${label}\`)`,
      { repo, prNumber, issueNumber: abandon.issueNumber, label, maxAttempts },
    );
    return {
      ok: true,
      value: {
        processed: true,
        merged: false,
        escalated: false,
        summary:
          `Merge-conflict attempts exhausted on PR #${prNumber} — abandoned ` +
          `it and re-queued issue #${abandon.issueNumber} (\`${label}\`)`,
      },
    };
  }

  const route = exhaustedEscalationRoute(abandon);
  const escalation = await escalateToHuman({
    ghClient: createGhEscalationClient(deps.github.runGhCommand),
    repo,
    target: { kind: "pr", number: prNumber },
    needsHumanLabel: processorDeps.needsHumanLabel ?? "needs-human",
    heading: "Merge conflict needs human attention",
    reason: [
      buildConflictEscalationReason(
        input,
        conflictedFiles,
        failureDetail,
        maxAttempts,
      ),
      "",
      ...describeExhaustedRoute(route),
    ].join("\n"),
    nextStep: CONFLICT_ESCALATION_NEXT_STEP,
    dedupKey: exhaustedEscalationDedupKey(prNumber, route),
    ensureLabelColour: "d4c5f9",
    ensureLabelDescription:
      "Worker could not produce a fix; human review required",
    deps: { github: { ensureLabelExists: deps.github.ensureLabelExists } },
    logger,
  });
  if (!escalation.ok) {
    return {
      ok: false,
      error: new Error(
        `Failed to escalate the merge conflict on PR #${prNumber}: ${escalation.error.message}`,
      ),
    };
  }

  return {
    ok: true,
    value: {
      processed: true,
      merged: false,
      escalated: true,
      summary:
        `Merge-conflict attempts exhausted on PR #${prNumber} — escalated to a human`,
    },
  };
}
