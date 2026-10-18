/**
 * Claim freshness re-check (Issue #344).
 *
 * A claim is legitimate when it is taken and can be worthless by the time the
 * run ends. The worker holds one claim across a whole cycle — on VibeCoder#333
 * across a rate-limit pause of nearly an hour — and nothing re-checked the
 * world before the PR went up: #333 was closed by merged PR #339 at 07:57:54Z
 * and the worker opened PR #341 against it at 08:15:06Z, seventeen minutes
 * later. The result was a `CONFLICTING`/`DIRTY` duplicate PR against work
 * already on `main`.
 *
 * The trigger is not exotic: any issue worked concurrently by a human, another
 * fleet host, or a second slot on the same host produces it, and it is *more*
 * likely when cycles are long — which is exactly when the host is degraded.
 *
 * Two checks, one decision function:
 *
 *  - **pre-write** (start of the execute phase) — the cheap one. Has the issue
 *    closed since the claim was taken? One `gh issue view`, before an agent run
 *    is spent on work that may already be merged.
 *  - **pre-pr** (immediately before `gh pr create`) — the full one. The issue
 *    state, plus what PRs now reference the issue.
 *
 * Where a merged PR is concerned this defers to `pr_run_provenance.ts` (#174)
 * rather than inventing a second notion of "already done": a merged PR whose
 * head is *this run's branch* means there is nothing left to raise, while a
 * merged PR from a human or a sibling host on a *different* branch does not
 * complete this run — #174 exists precisely because treating it as completion
 * discarded three unpublished commits on VibeCoder#42.
 *
 * **An open PR for the issue is deliberately not a rule here.** The third
 * hazard #344 names — "do not open a competing PR" — is already answered by
 * `decideCompletionPr`, which *recovers* an open PR that references the issue
 * instead of creating a second one. Duplicating that as a stale-claim abort
 * would be the second notion of "already done" this module exists to avoid,
 * and it would be the harsher of the two: `superseding_pr.ts` fails safe to
 * "open" when a PR's state cannot be read, so an unreadable `gh pr view` would
 * abandon a finished run that today recovers cleanly.
 *
 * Every lookup failure fails safe to `fresh`. This guard refuses a PR for
 * finished, pushed, quality-gated work, so a `gh` hiccup must never be the
 * thing that withholds it — but the reason is always logged, never swallowed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type {
  IssueContext,
  PhaseResult,
  PhaseState,
} from "./issue_worker_types.ts";
import type { WorkerDeps } from "./issue_worker_wiring.ts";
import { claimStaleOutcome } from "./run_outcome.ts";
import { isAncestorOf } from "./dependency_landed.ts";
import { readMergedHeadRefPrs } from "./stale_branch_lineage.ts";
import { extractIssueNumberFromPrTitle, hasClosingKeyword } from "./pr_body.ts";
import {
  markdownLogicalUnits,
  splitMarkdownCode,
  splitMarkdownLines,
} from "./markdown_code_spans.ts";
import { isValidRepoSlug } from "./repo_slug.ts";
import {
  extractAcceptanceCriteria,
  extractAcceptedScope,
  parseClosureEntries,
  validateAcceptanceClosure,
} from "./acceptance_criteria_gate.ts";
import { assessScopeShortfalls } from "./degraded_delivery.ts";
import { assertSafeGitRef, buildFetchArgs } from "./git_ref_args.ts";
import { redactSecrets } from "./secret_redaction.ts";
import type { GitRunner } from "./git_base_ref.ts";
import { mergedPrCompletesThisRun } from "./pr_run_provenance.ts";
import {
  type ClassifyExistingPrDeps,
  classifyExistingPrForIssue,
  type ExistingPrDisposition,
} from "./superseding_pr.ts";

/** Why a claim that was legitimate when taken is no longer worth a PR. */
export type ClaimStaleReason =
  /** The issue closed during the cycle. */
  | "issue_closed"
  /** A merged PR already carries this run's branch — nothing left to raise. */
  | "work_already_merged";

/** A claim that has gone stale, with what a human needs to see. */
export interface StaleClaim {
  reason: ClaimStaleReason;
  /** One sentence naming what changed, for the log and the release comment. */
  detail: string;
  /** The PR that made the claim stale, when one did. */
  prUrl?: string;
  prNumber?: number;
  /** Proven delivery target for an active run's already-landed result. */
  baseBranch?: string;
  defaultBranch?: string;
  mergeCommit?: string;
}

/** The verdict: keep going, or stop cleanly. */
export type ClaimFreshness =
  | { kind: "fresh" }
  | ({ kind: "stale" } & StaleClaim);

/** How much of the world to re-read before deciding. */
export type ClaimFreshnessMode =
  /** Issue state only — one `gh` call, at the start of the write phase. */
  | "pre-write"
  /** Issue state and the PRs referencing the issue — before PR creation. */
  | "pre-pr";

/** The world as it stood at the moment of the re-check. */
export interface ClaimSnapshot {
  /** `state` from `gh issue view`, upper-cased; null when unreadable. */
  issueState: string | null;
  /**
   * The existing PR for this issue, classified by `superseding_pr.ts`, or
   * null when the mode did not look one up.
   */
  existingPr: ExistingPrDisposition | null;
  /** The branch this run pushed (or is about to push). */
  runBranch: string;
}

/**
 * Decide whether a claim is still worth a PR.
 *
 * Pure and side-effect free, so every rule is testable without a network.
 *
 * Order, most decisive first:
 *
 *  1. **The issue is closed.** Whatever closed it, this run must not open a PR
 *     against it — the VibeCoder#333 case.
 *  2. **A merged PR already carries this run's branch** (#174's
 *     `mergedPrCompletesThisRun`). The work is published; a second PR would be
 *     empty or conflicting. A merged PR on a *different* branch is deliberately
 *     NOT stale: #174's rule is that it does not complete this run, and the
 *     branch's commits still deserve their PR.
 *  3. Otherwise the claim is fresh — including when an open PR references the
 *     issue, which `decideCompletionPr` recovers rather than competing with.
 *
 * An unreadable issue state (`null`) is fresh: it means the lookup failed, and
 * withholding a finished PR on a failed lookup is the worse error.
 */
export function decideClaimFreshness(snapshot: ClaimSnapshot): ClaimFreshness {
  const { issueState, existingPr, runBranch } = snapshot;

  if (issueState === "CLOSED") {
    // Name the PR that referenced the issue when the mode looked one up: on
    // VibeCoder#333 that is merged PR #339, and it is the single most useful
    // thing the hand-off comment can point a reader at.
    const closer = existingPr && existingPr.kind !== "none" &&
        existingPr.prNumber > 0
      ? { prUrl: existingPr.prUrl, prNumber: existingPr.prNumber }
      : {};
    return {
      kind: "stale",
      reason: "issue_closed",
      detail:
        "the issue closed while this run was working, so its PR would land " +
        "against work that is already resolved",
      ...closer,
    };
  }

  if (existingPr?.kind === "superseded" && existingPr.prState === "MERGED") {
    if (mergedPrCompletesThisRun(existingPr.headRefName, runBranch)) {
      return {
        kind: "stale",
        reason: "work_already_merged",
        detail:
          `merged PR #${existingPr.prNumber} already carries this run's ` +
          `branch \`${runBranch}\`, so there is nothing left to raise`,
        prUrl: existingPr.prUrl,
        prNumber: existingPr.prNumber,
      };
    }
    // Issue #174: someone else's merged PR does not complete this run — the
    // commits on this branch are still unpublished and still want a PR.
    return { kind: "fresh" };
  }

  return { kind: "fresh" };
}

/** Seams for the re-check — the phase passes its own `deps`. */
export type ClaimFreshnessDeps = ClassifyExistingPrDeps;

/** Everything {@link checkClaimFreshness} needs. */
export interface CheckClaimFreshnessOptions {
  repo: string;
  issueNumber: number;
  /** The branch this run pushed (or is about to push). */
  runBranch: string;
  mode: ClaimFreshnessMode;
  deps: ClaimFreshnessDeps;
}

/**
 * Read the world and decide. Never throws: every lookup failure is warned
 * about and degrades to the fail-safe `fresh`.
 */
export async function checkClaimFreshness(
  options: CheckClaimFreshnessOptions,
): Promise<ClaimFreshness> {
  const { repo, issueNumber, runBranch, mode, deps } = options;
  const warn = deps.warn ?? (() => {});

  const issueState = await readIssueState(
    repo,
    issueNumber,
    deps.runGhCommand,
    warn,
  );
  const existingPr = mode === "pre-pr"
    ? await classifyExistingPrForIssue(repo, issueNumber, deps)
    : null;

  return decideClaimFreshness({ issueState, existingPr, runBranch });
}

/**
 * The issue's state, upper-cased, or null when it cannot be read.
 *
 * A malformed payload is as unreadable as a failed call — both are warned
 * about rather than reconciled into a state the worker never saw.
 */
async function readIssueState(
  repo: string,
  issueNumber: number,
  runGhCommand: (args: string[]) => Promise<string>,
  warn: (message: string) => void,
): Promise<string | null> {
  let output: string;
  try {
    output = await runGhCommand([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repo,
      "--json",
      "state",
    ]);
  } catch (err) {
    warn(
      `Could not read the state of ${repo}#${issueNumber} for the claim ` +
        `freshness re-check — treating the claim as fresh (Issue #344): ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
    return null;
  }

  try {
    const parsed = JSON.parse(output) as { state?: unknown };
    if (typeof parsed.state === "string" && parsed.state.trim() !== "") {
      return parsed.state.trim().toUpperCase();
    }
  } catch {
    // Fall through to the shared warning below.
  }
  warn(
    `Unreadable 'gh issue view' payload for ${repo}#${issueNumber} — treating ` +
      `the claim as fresh (Issue #344)`,
  );
  return null;
}

/**
 * The `PhaseResult.reason` for a stale claim.
 *
 * Starts with the stable `claim_stale:<reason>` token, so a worker-log grep,
 * the phase reason and the derived `RunOutcome` all read the same way — the
 * shape `superseded:pr#N` established in #218.
 */
export function formatStaleClaimReason(stale: StaleClaim): string {
  return `claim_stale:${stale.reason} — ${stale.detail}`;
}

/**
 * The comment left on the issue when a claim goes stale after the branch was
 * pushed.
 *
 * Its whole job is that the work is not lost: it names the branch, links to
 * it, and says plainly that no PR was raised and why. The reader decides
 * whether that branch is still wanted — the worker does not close, reopen or
 * relabel anything on the strength of this.
 */
export function formatStaleClaimComment(options: {
  repo: string;
  branch: string;
  stale: StaleClaim;
}): string {
  const { repo, branch, stale } = options;
  const branchUrl = `https://github.com/${repo}/tree/${
    encodeURIComponent(branch)
  }`;
  return [
    `The Vibe Coder finished this work but did **not** open a PR: ` +
    `${stale.detail} (Issue #344).`,
    "",
    `The work is pushed and safe on [\`${branch}\`](${branchUrl})` +
    (stale.prUrl ? `, and the PR that overtook it is ${stale.prUrl}.` : "."),
    "",
    `If that branch is still wanted, re-label the issue and the next claim ` +
    `resumes it; if it is not, the branch can be deleted.`,
  ].join("\n");
}

/** Read-only proof before recovery or failure bookkeeping (Issue #3977). */
export interface CheckAlreadyLandedOptions {
  repo: string;
  issueNumber: number;
  issueBody: string;
  runBranch: string;
  baseBranch: string;
  defaultBranch: string;
  cwd: string;
  reapproved?: boolean;
  runGit: GitRunner;
  runGh: (args: string[]) => Promise<string>;
  warn?: (message: string) => void;
}

export async function checkAlreadyLanded(
  options: CheckAlreadyLandedOptions,
): Promise<ClaimFreshness> {
  const {
    repo,
    issueNumber,
    runBranch,
    baseBranch,
    defaultBranch,
    runGh,
    runGit,
    cwd,
  } = options;
  const fresh = { kind: "fresh" } as const;
  if (options.reapproved) return fresh;
  try {
    assertSafeGitRef(runBranch, "already-landed run branch");
    assertSafeGitRef(baseBranch, "already-landed target branch");
    assertSafeGitRef(defaultBranch, "already-landed default branch");
    if (
      !isValidRepoSlug(repo) || !Number.isSafeInteger(issueNumber) ||
      issueNumber <= 0
    ) {
      throw new Error("Invalid repository or issue for merged-work evidence");
    }
    const evidence = await readMergedHeadRefPrs(repo, runBranch, runGh);
    if (!evidence.ok) throw evidence.error;
    const git = async (args: string[]) => {
      const result = await runGit(args, { cwd });
      if (!result.ok) throw result.error;
      if (result.value.code !== 0) {
        throw new Error(`git ${args[0]} failed: ${result.value.stderr}`);
      }
      return result.value.stdout.trim();
    };
    const prs = evidence.value;
    if (prs.length === 0) return fresh;
    // Untracked and tracked work both belong to the run; never hide either.
    if (await git(["status", "--porcelain", "--untracked-files=all"])) {
      return fresh;
    }
    const head = await git([
      "rev-parse",
      "--verify",
      "--end-of-options",
      "HEAD^{commit}",
    ]);
    const branch = await git([
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${runBranch}^{commit}`,
    ]);
    const sha = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
    const fullSha = (value: unknown): value is string =>
      typeof value === "string" && sha.test(value);
    if (!fullSha(head) || !fullSha(branch)) {
      throw new Error("Unreadable local commit identity");
    }
    for (const candidate of prs) {
      if (candidate === null) continue;
      const pr = candidate as {
        number?: number;
        title?: string;
        url?: string;
        body?: string;
        state?: string;
        mergedAt?: string;
        headRefName?: string;
        headRefOid?: string;
        baseRefName?: string;
        headRepository?: { name?: string };
        headRepositoryOwner?: { login?: string };
        mergeCommit?: { oid?: string };
      };
      const prHead = pr.headRefOid;
      const mergedCommit = pr.mergeCommit?.oid;
      if (
        pr.state !== "MERGED" || !Number.isSafeInteger(pr.number) ||
        pr.number! <= 0 ||
        !mergedPrCompletesThisRun(pr.headRefName, runBranch) ||
        `${pr.headRepositoryOwner?.login}/${pr.headRepository?.name}`
            .toLowerCase() !==
          repo.toLowerCase() ||
        pr.baseRefName !== baseBranch || !fullSha(prHead) ||
        !fullSha(mergedCommit) ||
        typeof pr.mergedAt !== "string" ||
        !Number.isFinite(Date.parse(pr.mergedAt)) ||
        typeof pr.url !== "string" ||
        pr.url.toLowerCase() !==
          `https://github.com/${repo}/pull/${pr.number}`.toLowerCase() ||
        typeof pr.body !== "string"
      ) continue;
      // A same-branch PR must explicitly claim this issue, not merely mention it.
      const linked = typeof pr.title === "string"
        ? extractIssueNumberFromPrTitle(pr.title)
        : undefined;
      const lines = splitMarkdownLines(pr.body);
      const closingContract = markdownLogicalUnits(lines)
        .filter((unit) =>
          unit.kind !== "code" && unit.kind !== "html" &&
          !unit.text.startsWith(">") &&
          unit.lines.every((index) => !/^(?: {4}| {0,3}\t)/.test(lines[index]!))
        )
        .some((unit) =>
          splitMarkdownCode(unit.text).some((segment) =>
            !segment.inCode && hasClosingKeyword(segment.value, issueNumber)
          )
        );
      if (!linked?.ok || linked.value !== issueNumber || !closingContract) {
        continue;
      }
      // Scope-less historical issues may predate today's closure template.
      // Current declared scope still needs matched delivery evidence.
      const entries = parseClosureEntries(pr.body);
      if (
        entries.length === 0 && extractAcceptanceCriteria(pr.body).length > 0
      ) continue;
      const closure = validateAcceptanceClosure({
        issueBody: options.issueBody,
        prSummaryContent: pr.body,
      });
      if (
        !closure.valid ||
        entries.some((entry) =>
          entry.status === "partial" || entry.status === "missing"
        )
      ) {
        continue;
      }
      if (
        extractAcceptedScope(options.issueBody).length > 0 &&
        assessScopeShortfalls(options.issueBody, pr.body).shortfalls.length > 0
      ) continue;
      if (!await isAncestorOf(repo, baseBranch, mergedCommit, runGh)) {
        continue;
      }
      // Fetching the immutable pull ref learns objects without moving a branch.
      await git(buildFetchArgs("origin", `refs/pull/${pr.number}/head`));
      const fetchedHead = await git([
        "rev-parse",
        "--verify",
        "--end-of-options",
        "FETCH_HEAD^{commit}",
      ]);
      if (fetchedHead !== prHead) {
        throw new Error("Merged PR head changed while proving completion");
      }
      let contained = true;
      for (const local of new Set([head, branch])) {
        const result = await runGit([
          "merge-base",
          "--is-ancestor",
          local,
          prHead,
        ], { cwd });
        if (!result.ok) throw result.error;
        if (result.value.code !== 0 && result.value.code !== 1) {
          throw new Error("Cannot compare local work with merged PR");
        }
        if (result.value.code === 1) contained = false;
      }
      if (!contained) continue;
      if (
        await git(["status", "--porcelain", "--untracked-files=all"]) ||
        await git([
            "rev-parse",
            "--verify",
            "--end-of-options",
            "HEAD^{commit}",
          ]) !== head ||
        await git([
            "rev-parse",
            "--verify",
            "--end-of-options",
            `${runBranch}^{commit}`,
          ]) !== branch
      ) return fresh;
      return {
        kind: "stale",
        reason: "work_already_merged",
        prNumber: pr.number,
        prUrl: pr.url,
        baseBranch,
        defaultBranch,
        mergeCommit: mergedCommit,
        detail:
          `already landed: PR #${pr.number} contains this run's work on \`${baseBranch}\`; no distinct local work remains`,
      };
    }
  } catch (error) {
    options.warn?.(
      "Already-landed reconciliation did not prove completion: " +
        redactSecrets(String(error)),
    );
  }
  return fresh;
}

/** Stop only on proved merged work; this path writes no completion/failure comment. */
export async function alreadyLandedPhaseResult(
  ctx: IssueContext,
  state: PhaseState,
  deps: WorkerDeps,
  phase: string,
): Promise<PhaseResult | undefined> {
  const landed = await checkAlreadyLanded({
    repo: ctx.repo,
    issueNumber: ctx.issueNumber,
    issueBody: ctx.issueBody,
    runBranch: state.branchName,
    baseBranch: state.milestoneBranch ?? state.defaultBranch,
    defaultBranch: state.defaultBranch,
    cwd: state.repoPath,
    reapproved: state.postMergeReapproval !== undefined,
    runGit: deps.git.runGitCommand,
    runGh: deps.github.runGhCommand,
    warn: (message) => deps.logger.warn(message),
  });
  if (landed.kind !== "stale") return undefined;
  deps.logger.info(
    "Run work already landed; skipping recovery and failure recording",
    {
      repo: ctx.repo,
      issueNumber: ctx.issueNumber,
      prNumber: landed.prNumber,
      baseBranch: landed.baseBranch,
    },
  );
  return {
    category: "unknown",
    status: "early_exit",
    expectedSkip: true,
    reason: formatStaleClaimReason(landed),
    outcome: claimStaleOutcome({
      phase,
      stale: landed,
      branch: state.branchName,
    }),
  };
}
