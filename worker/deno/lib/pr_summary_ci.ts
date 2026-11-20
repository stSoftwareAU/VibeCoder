/**
 * PR-summary CI gate (Issue #3768).
 *
 * `deno task pr-summary-ci` runs on every PR push. It runs the local PR-summary
 * gates (`pr_summary_check.ts`) on the PR's archived summary
 * (`docs/archive/pr-summaries/pr-summary-<N>.md`) and fails on a blocked gate
 * or a missing selected summary. The commit-order freshness check (summary
 * older than the newest code commit) was retired by Issue #5227 because commit
 * order is not evidence the summary's claims are accurate. Git is injected
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

/** `docs/archive/pr-summaries/pr-summary-<N>.md`, N > 0. */
const SUMMARY_FILE_RE =
  /^docs\/archive\/pr-summaries\/pr-summary-([1-9]\d*)\.md$/;

/** The issue a summary path belongs to, or `null` when it is not one. */
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
    /** The selected summary file is not in the checkout; the gates are not run. */
    kind: "summary_missing";
    issueNumber: number;
    summaryPath: string;
  }
  | {
    kind: "checked";
    issueNumber: number;
    summaryPath: string;
    gates: GateReport[];
  };

/** Run the PR-summary gates for this PR. */
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
        value: { kind: "summary_missing", issueNumber, summaryPath },
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
      gates: gates.value,
    },
  };
}

/** Whether the CI run should fail. */
export function ciFailed(result: PrSummaryCiResult): boolean {
  if (result.kind === "summary_missing") return true;
  return result.kind === "checked" && hasBlock(result.gates);
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

/** Render the CI result as log text. */
export function formatCiReport(result: PrSummaryCiResult): string {
  if (result.kind === "no_summary") {
    return "[NO SUMMARY] this PR carries no " +
      "docs/archive/pr-summaries/pr-summary-<N>.md, so there " +
      "is nothing to check.";
  }
  if (result.kind === "not_checked") {
    return [
      "[NOT CHECKED] PR summary (#3768)",
      `    note: ${escapeControl(result.reason)}`,
      "    a not-checked summary is not a pass.",
    ].join("\n");
  }
  if (result.kind === "summary_missing") {
    return [
      "[BLOCKED] PR summary (#3768)",
      `    - the summary ${result.summaryPath} is not in the checkout`,
    ].join("\n");
  }
  return formatReport(result.gates);
}
