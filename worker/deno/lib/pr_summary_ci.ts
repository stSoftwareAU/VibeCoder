/**
 * PR-summary freshness and CI gate (Issue #3768).
 *
 * `deno task pr-summary-ci` runs on every PR push. It fails when the PR's
 * archived summary (`docs/archive/pr-summaries/pr-summary-<N>.md`) is older
 * than the PR's newest code commit, and it runs the local PR-summary gates
 * (`pr_summary_check.ts`) and fails on any blocked gate. Git is injected
 * through `GitRunner`, so the judgement is testable against a real fixture
 * repository.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { resolveComparableBaseRef } from "./git_base_ref.ts";
import type { GitRunner } from "./git_base_ref.ts";
import {
  formatReport,
  hasBlock,
  runPrSummaryCheck,
} from "./pr_summary_check.ts";
import type { GateReport } from "./pr_summary_check.ts";
import { issueNumberFromBranch } from "./issue_branch_candidates.ts";
import { prSummaryFactsPath } from "./pr_summary_facts.ts";

/** Repo-relative path prefixes that count as code. `docs/**` never does. */
export const CODE_PATH_PREFIXES = ["worker/", "prompts/", ".claude/"] as const;

/** `docs/archive/pr-summaries/pr-summary-<N>.md` or `.facts.json`, N > 0. */
const SUMMARY_FILE_RE =
  /^docs\/archive\/pr-summaries\/pr-summary-([1-9]\d*)\.(?:md|facts\.json)$/;

/** Whether a repo-relative path is code for the freshness rule. */
export function isCodePath(path: string): boolean {
  return CODE_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** The issue a summary or facts path belongs to, or `null` when it is neither. */
export function summaryIssueOf(path: string): number | null {
  const match = SUMMARY_FILE_RE.exec(path);
  if (!match) return null;
  const issueNumber = Number(match[1]);
  return Number.isSafeInteger(issueNumber) ? issueNumber : null;
}

/** Repo-relative path of the archived summary for an issue. */
function summaryPathOf(issueNumber: number): string {
  return `docs/archive/pr-summaries/pr-summary-${issueNumber}.md`;
}

/** One commit on the PR and the files it changed. */
export interface CommitChange {
  sha: string;
  files: string[];
}

/** How the summary compares with the PR's code commits. */
export type Freshness =
  | { kind: "fresh"; summaryCommit: string }
  | { kind: "no_code_change" }
  | {
    kind: "stale";
    codeCommit: string;
    codeFiles: string[];
    summaryCommit: string | null;
  };

/**
 * Judge the summary against the PR's commits, given newest first.
 *
 * The first commit that touches the summary (or its facts file) is `fresh`,
 * which includes a commit that touches both code and summary. The first
 * commit that touches code before any summary commit is `stale`.
 */
export function judgeFreshness(
  commitsNewestFirst: readonly CommitChange[],
  issueNumber: number,
): Freshness {
  const summaryPath = summaryPathOf(issueNumber);
  const factsPath = prSummaryFactsPath(issueNumber);
  const touchesSummary = (commit: CommitChange): boolean =>
    commit.files.some((file) => file === summaryPath || file === factsPath);

  for (let i = 0; i < commitsNewestFirst.length; i++) {
    const commit = commitsNewestFirst[i]!;
    if (touchesSummary(commit)) {
      return { kind: "fresh", summaryCommit: commit.sha };
    }
    const codeFiles = commit.files.filter(isCodePath);
    if (codeFiles.length > 0) {
      const older = commitsNewestFirst.slice(i + 1).find(touchesSummary);
      return {
        kind: "stale",
        codeCommit: commit.sha,
        codeFiles,
        summaryCommit: older?.sha ?? null,
      };
    }
  }
  return { kind: "no_code_change" };
}

/** Which summary, if any, describes this PR. */
export type Selection =
  | { kind: "none" }
  | { kind: "selected"; issueNumber: number }
  | { kind: "not_checked"; reason: string };

/**
 * Pick the summary that describes this PR from the summaries in its diff.
 *
 * Only the head branch's own issue can name the PR's summary. A branch with
 * no `issue-<N>` name, or one whose own summary is absent, is not checked.
 */
export function selectSummary(
  changedPaths: readonly string[],
  headBranch: string,
): Selection {
  const found = new Set<number>();
  for (const path of changedPaths) {
    const issueNumber = summaryIssueOf(path);
    if (issueNumber !== null) found.add(issueNumber);
  }
  if (found.size === 0) return { kind: "none" };

  const listed = [...found].sort((a, b) => a - b)
    .map((n) => `#${n}`)
    .join(", ");
  const branchIssue = issueNumberFromBranch(headBranch);
  if (branchIssue === null) {
    return {
      kind: "not_checked",
      reason:
        `head branch '${headBranch}' is not an issue-<N> worker branch, ` +
        "so which summary describes this PR cannot be told; it carries " +
        `summaries for ${listed} (milestone roll-ups and sync PRs carry ` +
        "other PRs' summaries)",
    };
  }
  if (found.has(branchIssue)) {
    return { kind: "selected", issueNumber: branchIssue };
  }
  return {
    kind: "not_checked",
    reason: `head branch '${headBranch}' is for issue #${branchIssue}; this ` +
      `PR carries summaries for ${listed} but not its own ` +
      `(#${branchIssue})`,
  };
}

/** Run one git command, turning a runner error or non-zero exit into an error. */
async function runChecked(
  runGit: GitRunner,
  args: string[],
  cwd: string,
): Promise<Result<string, Error>> {
  const label = `git ${args.join(" ")}`;
  const r = await runGit(args, { cwd });
  if (!r.ok) {
    return {
      ok: false,
      error: new Error(`${label} failed: ${r.error.message}`),
    };
  }
  if (r.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `${label} exited ${r.value.code}: ${r.value.stderr.trim()}`,
      ),
    };
  }
  return { ok: true, value: r.value.stdout };
}

/**
 * The PR's commits, newest first, with the files each one changed.
 *
 * Merge commits contribute no files, because `git diff-tree` without `-m`
 * prints nothing for a merge. So a merge that brings the base in, even one
 * carrying its own conflict-resolution edit, never counts as a code or summary
 * change: this is the same commit set `git log --no-merges` gives. The
 * `--topo-order` walk keeps a child ahead of its parent even when the child's
 * committer date is older, so the newest-first judgement follows the graph.
 * Fails loud when git cannot be read.
 */
export async function listPrCommits(
  runGit: GitRunner,
  baseRef: string,
  cwd: string,
): Promise<Result<CommitChange[], Error>> {
  const revs = await runChecked(
    runGit,
    ["rev-list", "--topo-order", `${baseRef}..HEAD`],
    cwd,
  );
  if (!revs.ok) return revs;

  const shas = revs.value.split("\n").map((line) => line.trim())
    .filter((line) => line.length > 0);
  const commits: CommitChange[] = [];
  for (const sha of shas) {
    const files = await runChecked(
      runGit,
      ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", sha],
      cwd,
    );
    if (!files.ok) return files;
    commits.push({
      sha,
      files: files.value.split("\0").filter((file) => file.length > 0),
    });
  }
  return { ok: true, value: commits };
}

/** Input to {@link runPrSummaryCi}. */
export interface PrSummaryCiInput {
  baseBranch: string;
  headBranch: string;
  runGit: GitRunner;
  repoRoot: string;
  readTextFile: (path: string) => Promise<string>;
}

/** What the CI check found for this PR. */
export type PrSummaryCiResult =
  | { kind: "no_summary" }
  | { kind: "not_checked"; reason: string }
  | {
    kind: "checked";
    issueNumber: number;
    summaryPath: string;
    /**
     * `summary_missing` when only the facts file is on the branch, so there is
     * no summary to judge; the gates are then not run.
     */
    freshness: Freshness | { kind: "summary_missing" };
    gates: GateReport[];
  };

/** Run the freshness judgement and the PR-summary gates for this PR. */
export async function runPrSummaryCi(
  input: PrSummaryCiInput,
): Promise<Result<PrSummaryCiResult, Error>> {
  const { baseBranch, headBranch, runGit, repoRoot, readTextFile } = input;

  const base = await resolveComparableBaseRef(runGit, baseBranch, {
    cwd: repoRoot,
  });
  if (!base.ok) return { ok: false, error: base.error };

  const diff = await runChecked(
    runGit,
    ["diff", "--name-only", "-z", "--diff-filter=ACMR", `${base.value}...HEAD`],
    repoRoot,
  );
  if (!diff.ok) return diff;
  const changedPaths = diff.value.split("\0").filter((path) => path.length > 0);

  const selection = selectSummary(changedPaths, headBranch);
  if (selection.kind === "none") {
    return { ok: true, value: { kind: "no_summary" } };
  }
  if (selection.kind === "not_checked") {
    return {
      ok: true,
      value: { kind: "not_checked", reason: selection.reason },
    };
  }

  const issueNumber = selection.issueNumber;
  const summaryPath = summaryPathOf(issueNumber);
  let summaryContent: string;
  try {
    summaryContent = await readTextFile(`${repoRoot}/${summaryPath}`);
  } catch (error: unknown) {
    if (error instanceof Deno.errors.NotFound) {
      return {
        ok: true,
        value: {
          kind: "checked",
          issueNumber,
          summaryPath,
          freshness: { kind: "summary_missing" },
          gates: [],
        },
      };
    }
    return {
      ok: false,
      error: new Error(
        `Failed to read PR summary ${summaryPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    };
  }

  const commits = await listPrCommits(runGit, base.value, repoRoot);
  if (!commits.ok) return commits;
  const freshness = judgeFreshness(commits.value, issueNumber);

  const gates = await runPrSummaryCheck({
    summaryContent,
    issueNumber,
    baseBranch,
    issueBody: null,
    issueLabels: null,
    runGit,
    repoRoot,
  });
  if (!gates.ok) return gates;

  return {
    ok: true,
    value: {
      kind: "checked",
      issueNumber,
      summaryPath,
      freshness,
      gates: gates.value,
    },
  };
}

/** Whether the CI run should fail. */
export function ciFailed(result: PrSummaryCiResult): boolean {
  if (result.kind !== "checked") return false;
  return result.freshness.kind === "summary_missing" ||
    result.freshness.kind === "stale" ||
    hasBlock(result.gates);
}

/**
 * Escape control characters (code < 0x20 or 0x7f) as `\uXXXX`, so a crafted
 * file name or branch cannot start a new log line or workflow command.
 */
function escapeControl(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    out += code < 0x20 || code === 0x7f
      ? `\\u${code.toString(16).padStart(4, "0")}`
      : ch;
  }
  return out;
}

const FRESHNESS_TITLE = "Summary freshness (#3768)";
const MAX_LISTED_CODE_PATHS = 5;

/** The freshness section of a checked result. */
function freshnessLines(result: CheckedResult): string[] {
  const freshness = result.freshness;
  switch (freshness.kind) {
    case "summary_missing": {
      const factsPath = prSummaryFactsPath(result.issueNumber);
      return [
        `[BLOCKED] ${FRESHNESS_TITLE}`,
        `    - the facts file ${factsPath} is on the branch but the summary ` +
        `${result.summaryPath} is not`,
      ];
    }
    case "fresh":
      return [
        `[PASSED] ${FRESHNESS_TITLE}`,
        "    note: the summary was changed in commit " +
        `${escapeControl(freshness.summaryCommit)}, at or after the newest ` +
        "code change",
      ];
    case "no_code_change":
      return [
        `[PASSED] ${FRESHNESS_TITLE}`,
        "    note: no PR commit changes worker/, prompts/ or .claude/",
      ];
    case "stale": {
      const shown = freshness.codeFiles.slice(0, MAX_LISTED_CODE_PATHS)
        .map(escapeControl)
        .join(", ");
      const more = freshness.codeFiles.length - MAX_LISTED_CODE_PATHS;
      const paths = more > 0 ? `${shown} and ${more} more` : shown;
      const summaryState = freshness.summaryCommit === null
        ? "no commit on this branch changes it"
        : "the summary was last changed in commit " +
          escapeControl(freshness.summaryCommit);
      return [
        `[BLOCKED] ${FRESHNESS_TITLE}`,
        `    - code commit ${escapeControl(freshness.codeCommit)} changes ` +
        `${paths}, but ${summaryState}; rewrite ${result.summaryPath} for ` +
        "the head: re-enumerate Branch outcomes, renumber path:line " +
        "citations and add a Test Plan entry for the push",
      ];
    }
  }
}

/** The checked-result variant of {@link PrSummaryCiResult}. */
type CheckedResult = Extract<PrSummaryCiResult, { kind: "checked" }>;

/** Render the CI result as log text. */
export function formatCiReport(result: PrSummaryCiResult): string {
  if (result.kind === "no_summary") {
    return "[NO SUMMARY] this PR carries no " +
      "docs/archive/pr-summaries/pr-summary-<N>.md or facts file, so there " +
      "is nothing to check.";
  }
  if (result.kind === "not_checked") {
    return [
      "[NOT CHECKED] PR summary (#3768)",
      `    note: ${escapeControl(result.reason)}`,
      "    a not-checked summary is not a pass.",
    ].join("\n");
  }
  return [
    ...freshnessLines(result),
    formatReport(result.gates),
  ].join("\n");
}
