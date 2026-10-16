/**
 * Deterministic check that a merged PR summary does not claim changes the
 * merged diff no longer carries (Issue #3617).
 *
 * A merge-conflict pass merges `origin/<base>` into a fleet PR branch. When
 * the base already carries part of the PR's change, that part drops out of the
 * PR's own diff, but the PR summary still claims it. GRQ-validation#904 and a
 * private fleet PR (2026-10-11) both did this: the base landed the same fix and
 * the summary kept claiming the edits. The prompt rule from #3027 was not
 * enough to stop it, so this module checks the claims in code.
 *
 * The check runs after the merge is resolved and before the push. Claims that
 * no changed file backs get one recovery turn, which rewrites only the summary.
 * A summary that is still false refuses the push, so the PR body is never
 * rebuilt from a false summary.
 *
 * ```mermaid
 * flowchart TD
 *     M["Merge resolved in the working tree"] --> C["Check summary claims against the merged diff"]
 *     C -->|no summary| P["Proceed"]
 *     C -->|clean| P
 *     C -->|not checked| N["Proceed, noting the reason"]
 *     C -->|false claims| R["One recovery turn rewrites the summary"]
 *     R --> C2["Re-check"]
 *     C2 -->|clean| P
 *     C2 -->|still false or unverifiable| X["Refuse the push"]
 * ```
 *
 * The summary and the base ref are repository text, so the recovery prompt
 * fences every name it carries under a per-render nonce. Uses Australian
 * English throughout (behaviour, recognise, normalise, etc.).
 */

import type { Logger, Result } from "../types.ts";
import type { MergeConflictAgentOutcome } from "./merge_conflict_agent.ts";
import { parseDocsSweepLine } from "./docs_sweep_gate.ts";
import { isSummaryClaimPath } from "./summary_claim_check.ts";
import {
  extractChangeSectionPaths,
  extractUpdatedPaths,
  isPathInChangedFiles,
} from "./summary_claimed_paths.ts";
import {
  buildBoundaryIntegrityInstruction,
  fenceUntrustedIssueText,
  generateBoundaryId,
  isBoundaryId,
} from "./prompt_delimiter.ts";

/** Most PR summary files one check reads; more is refused rather than sampled. */
export const MAX_SUMMARIES_CHECKED = 10;

/** Largest summary read, in characters; longer is refused rather than truncated. */
export const MAX_SUMMARY_CHARS = 200_000;

/** Where a claimed path was found in the summary. */
export type ClaimSource = "docs-sweep-updated" | "change-section";

/** A path a summary claims to change, and where the summary said so. */
export interface ClaimedPath {
  path: string;
  source: ClaimSource;
}

/** A claimed path no changed file backs, with the summary that claimed it. */
export interface UnbackedClaim {
  summaryPath: string;
  path: string;
  source: ClaimSource;
}

/** What one check found. */
export type MergedSummaryClaimCheck =
  | { kind: "no-summary" }
  | { kind: "clean"; summaries: string[]; claimsChecked: number }
  | { kind: "false-claims"; summaries: string[]; unbacked: UnbackedClaim[] }
  | { kind: "not-checked"; reason: string };

/** Runs one git command in the working tree, folding spawn failures to non-zero. */
export type MergeClaimGitRunner = (
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Longest base ref accepted, in characters. */
const MAX_BASE_REF_CHARS = 200;

/** The plausible shape of a base ref, checked before git sees it. */
const BASE_REF_SHAPE_RE = /^[A-Za-z0-9._\/-]{1,200}$/;

/** The working-tree summary file the worker itself writes; it claims nothing. */
const PR_SUMMARY_SCRATCH_PATH = ".pr_summary";

/** Most unbacked claims {@link describeUnbackedClaims} names before counting the rest. */
const MAX_DESCRIBED_CLAIMS = 10;

/** Longest git stderr line quoted into a reason. */
const MAX_REASON_LINE_CHARS = 300;

/** Paths the summary claims, from both sources, deduplicated by path. */
export function extractClaimedPaths(summary: string): ClaimedPath[] {
  const claimed: ClaimedPath[] = [];
  const seen = new Set<string>();
  const add = (paths: readonly string[], source: ClaimSource) => {
    for (const path of paths) {
      if (seen.has(path)) continue;
      seen.add(path);
      claimed.push({ path, source });
    }
  };
  add(
    extractUpdatedPaths(parseDocsSweepLine(summary).rawBody),
    "docs-sweep-updated",
  );
  add(extractChangeSectionPaths(summary), "change-section");
  return claimed;
}

/** The first non-empty stderr line, the cause git prints first. */
function firstStderrLine(outcome: { code: number; stderr: string }): string {
  const line = outcome.stderr.split("\n").map((l) => l.trim()).find((l) =>
    l !== ""
  );
  if (line === undefined) return `git exited with code ${outcome.code}`;
  return line.slice(0, MAX_REASON_LINE_CHARS);
}

/** A thrown error's message, or the value itself when it is not an Error. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Non-empty trimmed lines of a git listing. */
function listLines(stdout: string): string[] {
  return stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
}

/**
 * Run one git command for the check. Never throws: a spawn failure and a
 * non-zero exit both come back as a reason the check can report.
 */
async function runClaimGit(
  runGit: MergeClaimGitRunner,
  args: string[],
  failurePrefix: string,
): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  let outcome: { code: number; stdout: string; stderr: string };
  try {
    outcome = await runGit(args);
  } catch (err) {
    return { ok: false, reason: `${failurePrefix}${messageOf(err)}` };
  }
  if (outcome.code !== 0) {
    return { ok: false, reason: `${failurePrefix}${firstStderrLine(outcome)}` };
  }
  return { ok: true, stdout: outcome.stdout };
}

/**
 * Check the PR summaries in the working tree against the merged diff.
 *
 * The changed set is what `git add -A` will commit: the working tree against
 * `baseRef` (covering staged and unstaged edits), plus untracked files. A
 * summary deleted on disk claims nothing and is skipped. A summary claims a
 * path when its `updated:` list or a change section names it; the claim is
 * false when no changed file backs it.
 *
 * Never throws. Anything the check cannot read is `not-checked` with a reason,
 * so a caller can fail closed or note the gap.
 *
 * @param opts.workDir - The checkout the summaries are read from
 * @param opts.baseRef - The base ref the merge was made against, e.g. `origin/main`
 * @param opts.runGit - Runs one git command in the working tree
 * @param opts.readFile - Reads an absolute path (tests); defaults to `Deno.readTextFile`
 * @returns What the check found
 */
export async function checkMergedSummaryClaims(opts: {
  workDir: string;
  baseRef: string;
  runGit: MergeClaimGitRunner;
  readFile?: (absPath: string) => Promise<string>;
}): Promise<MergedSummaryClaimCheck> {
  const { workDir, baseRef, runGit } = opts;
  const readFile = opts.readFile ??
    ((absPath: string) => Deno.readTextFile(absPath));

  if (
    baseRef.length > MAX_BASE_REF_CHARS ||
    !BASE_REF_SHAPE_RE.test(baseRef) ||
    baseRef.startsWith("-")
  ) {
    return {
      kind: "not-checked",
      reason: `base ref '${baseRef}' is not a plausible git ref`,
    };
  }

  // Working tree against the base: what `git add -A` will commit, staged and
  // unstaged alike. A mid-merge `git add` is therefore seen too.
  const diff = await runClaimGit(
    runGit,
    ["diff", "--name-only", "--no-renames", baseRef, "--"],
    `git diff against ${baseRef} failed: `,
  );
  if (!diff.ok) return { kind: "not-checked", reason: diff.reason };

  const untracked = await runClaimGit(
    runGit,
    ["ls-files", "--others", "--exclude-standard"],
    "git ls-files failed: ",
  );
  if (!untracked.ok) return { kind: "not-checked", reason: untracked.reason };

  const changed = [
    ...new Set([...listLines(diff.stdout), ...listLines(untracked.stdout)]),
  ];

  const summaries = changed.filter((path) =>
    path !== PR_SUMMARY_SCRATCH_PATH && isSummaryClaimPath(path)
  );
  if (summaries.length === 0) return { kind: "no-summary" };
  if (summaries.length > MAX_SUMMARIES_CHECKED) {
    return {
      kind: "not-checked",
      reason:
        `${summaries.length} PR summary files changed, more than the ${MAX_SUMMARIES_CHECKED} the check reads`,
    };
  }

  const readSummaries: { path: string; content: string }[] = [];
  for (const path of summaries) {
    let content: string;
    try {
      content = await readFile(`${workDir}/${path}`);
    } catch (err) {
      // A summary deleted on disk claims nothing.
      if (err instanceof Deno.errors.NotFound) continue;
      return {
        kind: "not-checked",
        reason: `could not read PR summary '${path}': ${messageOf(err)}`,
      };
    }
    if (content.length > MAX_SUMMARY_CHARS) {
      return {
        kind: "not-checked",
        reason:
          `PR summary '${path}' is ${content.length} characters, more than the ${MAX_SUMMARY_CHARS} the check reads`,
      };
    }
    readSummaries.push({ path, content });
  }
  if (readSummaries.length === 0) return { kind: "no-summary" };

  const unbacked: UnbackedClaim[] = [];
  let claimsChecked = 0;
  for (const summary of readSummaries) {
    const claims = extractClaimedPaths(summary.content);
    claimsChecked += claims.length;
    for (const claim of claims) {
      if (isPathInChangedFiles(claim.path, changed)) continue;
      unbacked.push({
        summaryPath: summary.path,
        path: claim.path,
        source: claim.source,
      });
    }
  }

  const checkedSummaries = readSummaries.map((s) => s.path);
  if (unbacked.length > 0) {
    return { kind: "false-claims", summaries: checkedSummaries, unbacked };
  }
  return { kind: "clean", summaries: checkedSummaries, claimsChecked };
}

/**
 * One line per unbacked claim, for logs and PR comments.
 *
 * Names the claimed path, the summary that claimed it, and whether the summary
 * claimed it after `updated:` or in a change list. At most
 * {@link MAX_DESCRIBED_CLAIMS} are named; the rest are counted.
 *
 * @param unbacked - The claims no changed file backs
 * @returns The claims joined with `; `
 */
export function describeUnbackedClaims(
  unbacked: readonly UnbackedClaim[],
): string {
  const parts = unbacked.slice(0, MAX_DESCRIBED_CLAIMS).map((claim) => {
    const where = claim.source === "docs-sweep-updated"
      ? "after `updated:`"
      : "change list";
    return `\`${claim.path}\` (claimed in \`${claim.summaryPath}\`, ${where})`;
  });
  if (unbacked.length > MAX_DESCRIBED_CLAIMS) {
    parts.push(`and ${unbacked.length - MAX_DESCRIBED_CLAIMS} more`);
  }
  return parts.join("; ");
}

/**
 * Build the one recovery turn: rewrite only the summary files that claim
 * changes the merged diff does not carry (Issue #3617).
 *
 * The base branch, the summary paths and the claimed paths are repository
 * text, so each is fenced under one nonce for this render. The base branch is
 * named only inside its fence; the prose refers to it as the base branch named
 * below.
 *
 * @param opts.repo - `owner/name` of the repo the PR is for
 * @param opts.prNumber - The PR being merged into, a positive integer
 * @param opts.baseBranch - The base branch merged in (repository text)
 * @param opts.unbacked - The claims to recover from, non-empty
 * @param opts.boundaryId - Pinned nonce for tests; production mints one
 * @returns The prompt
 */
export function buildSummaryClaimRecoveryPrompt(opts: {
  repo: string;
  prNumber: number;
  baseBranch: string;
  unbacked: readonly UnbackedClaim[];
  boundaryId?: string;
}): string {
  if (!Number.isInteger(opts.prNumber) || opts.prNumber <= 0) {
    throw new Error(
      `buildSummaryClaimRecoveryPrompt requires a positive integer PR number, got '${opts.prNumber}'`,
    );
  }
  if (opts.unbacked.length === 0) {
    throw new Error(
      "buildSummaryClaimRecoveryPrompt requires at least one unbacked claim",
    );
  }

  const boundaryId = isBoundaryId(opts.boundaryId)
    ? opts.boundaryId
    : generateBoundaryId();
  const summaryPaths = [...new Set(opts.unbacked.map((c) => c.summaryPath))];
  const claimedPaths = [...new Set(opts.unbacked.map((c) => c.path))];

  const lines = [
    `# PR summary claim recovery — PR #${opts.prNumber} in ${opts.repo}`,
    "",
    `A merge of the base branch (named below) into PR #${opts.prNumber} in ${opts.repo} is resolved in your working tree, and the worker is about to commit and push it. The PR summary file(s) listed below still claim that this PR changes the files listed below, but the merged diff (\`git diff --name-only origin/<base>\`, base named below) no longer changes them — the base branch already carries that change, so this PR does not make it any more.`,
    "",
    "Do exactly this:",
    "",
    "1. Read each named summary file and `git diff origin/<base>` (substitute the fenced base).",
    "2. Rewrite only those summary files so every file and behaviour they claim appears in the merged diff: drop each listed path from the Docs sweep line's `updated:` list and from any Changes / What changed / Files changed list, and rewrite or remove the prose that describes that change as this PR's work. Keep everything that is still true.",
    "3. `git add` the summary files and stop.",
    "",
    "Do not edit any other file, do not redo or revert the change, and do not commit, push, rebase, reset or abort the merge. The worker checks the summary again; a summary that still claims one of these paths stops the push and fails this attempt.",
    "",
    ...fenceUntrustedIssueText(
      opts.baseBranch,
      "**Base branch** (repository text, fenced):",
      boundaryId,
    ),
    "",
    ...fenceUntrustedIssueText(
      summaryPaths.join("\n"),
      "**Summary files that still claim these changes** (repository text, fenced):",
      boundaryId,
    ),
    "",
    ...fenceUntrustedIssueText(
      claimedPaths.join("\n"),
      "**Claimed paths the merged diff does not change** (repository text, fenced):",
      boundaryId,
    ),
    "",
    buildBoundaryIntegrityInstruction(boundaryId, [
      "the base branch name",
      "the summary file paths",
      "the claimed paths",
    ]),
  ];
  return lines.join("\n");
}

/** What the gate tells the resolver to do with the merge. */
export type SummaryClaimGateOutcome =
  | { kind: "proceed"; note: string }
  | { kind: "refuse"; detail: string }
  | { kind: "cut-short"; providerUnavailable?: string };

/**
 * Gate the push on the merged PR summary's claims (Issue #3617).
 *
 * Checks first. A false claim gets one recovery turn, then a second check.
 * The push proceeds only when the summary is clean, cannot be checked, or
 * has no summary at all. A claim that is still false, or that cannot be
 * confirmed after the recovery turn, refuses the push: the claim was false and
 * is unconfirmed, so it is not waved through. A recovery turn the worker or
 * the provider ended cuts the attempt short without spending it.
 *
 * @param opts.repo - `owner/name` of the repo the PR is for
 * @param opts.prNumber - The PR being merged into
 * @param opts.baseBranch - The base branch merged in
 * @param opts.check - Runs the check; called before and after the recovery turn
 * @param opts.recover - Runs the recovery turn with the given prompt
 * @param opts.logger - Logs the false claims and any unchecked summary
 * @returns What the resolver should do
 */
export async function gateMergedSummaryClaims(opts: {
  repo: string;
  prNumber: number;
  baseBranch: string;
  check: () => Promise<MergedSummaryClaimCheck>;
  recover: (prompt: string) => Promise<Result<MergeConflictAgentOutcome>>;
  logger: Logger;
}): Promise<SummaryClaimGateOutcome> {
  const { repo, prNumber, baseBranch, check, recover, logger } = opts;

  const first = await check();
  if (first.kind === "no-summary") return { kind: "proceed", note: "" };
  if (first.kind === "clean") {
    return {
      kind: "proceed",
      note:
        `**Summary claims:** ${first.claimsChecked} claimed path(s) in ${first.summaries.length} PR summary file(s) checked against the merged diff — all present (Issue #3617).`,
    };
  }
  if (first.kind === "not-checked") {
    logger.warn("PR summary claims not checked against the merged diff", {
      repo,
      prNumber,
      reason: first.reason,
    });
    return {
      kind: "proceed",
      note: `**Summary claims:** not checked — ${first.reason} (Issue #3617).`,
    };
  }

  const described = describeUnbackedClaims(first.unbacked);
  logger.warn(
    "PR summary claims changes the merged diff does not carry — running one recovery turn",
    {
      repo,
      prNumber,
      unbacked: first.unbacked.map((c) => `${c.path} (in ${c.summaryPath})`),
    },
  );

  const rec = await recover(
    buildSummaryClaimRecoveryPrompt({
      repo,
      prNumber,
      baseBranch,
      unbacked: first.unbacked,
    }),
  );
  if (!rec.ok) {
    return {
      kind: "refuse",
      detail:
        `the PR summary claims changes the merged diff does not carry (${described}), and the recovery turn could not run: ${rec.error.message}`,
    };
  }
  if (rec.value.terminated) return { kind: "cut-short" };
  if (rec.value.providerUnavailable !== undefined) {
    return {
      kind: "cut-short",
      providerUnavailable: rec.value.providerUnavailable,
    };
  }

  const second = await check();
  if (second.kind === "false-claims") {
    return {
      kind: "refuse",
      detail:
        `the PR summary still claims changes the merged diff does not carry after one recovery turn: ${
          describeUnbackedClaims(second.unbacked)
        } — the merge was not pushed, so the PR body is not rebuilt from a false summary (Issue #3617)`,
    };
  }
  if (second.kind === "not-checked") {
    // Fail closed: the claim was false, and the re-check cannot confirm it
    // was made true.
    return {
      kind: "refuse",
      detail:
        `the PR summary claimed changes the merged diff does not carry (${described}), and after the recovery turn the claims could not be checked again: ${second.reason}`,
    };
  }
  return {
    kind: "proceed",
    note:
      `**Summary claims:** the PR summary claimed ${described}, which the merged diff no longer changes; the recovery turn rewrote it, and the re-check passed (Issue #3617).`,
  };
}
