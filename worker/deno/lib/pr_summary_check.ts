/**
 * Local PR-summary gate check (Issue #3423).
 *
 * Runs the deterministic PR-summary gates the worker applies when it raises a
 * PR against a draft summary and the branch diff, so an agent can see every
 * block before the worker does. Pure apart from the injected git runner.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { summaryScrubProblem } from "./summary_scrub_gate.ts";

import type { Result } from "../types.ts";
import { resolveComparableBaseRef } from "./git_base_ref.ts";
import type { GitRunner } from "./git_base_ref.ts";
import { validateAcceptanceClosure } from "./acceptance_criteria_gate.ts";
import { validateIndependentReview } from "./independent_review_gate.ts";
import { validateReproductionStatus } from "./reproduction_status_gate.ts";
import { validateDocsSweep } from "./docs_sweep_gate.ts";
import { validateResultPlaceholders } from "./result_placeholder_gate.ts";
import { findMissingCriteria } from "./missing_criterion_close_guard.ts";
import { closingKeywordLine, ensurePrReferencesIssue } from "./pr_body.ts";
import {
  markdownLogicalUnits,
  maskMarkdownCode,
  splitMarkdownLines,
} from "./markdown_code_spans.ts";
import {
  lookupTestsAtHead,
  namedTestPaths,
  parseBranchOutcomes,
  validateBranchOutcomes,
} from "./branch_outcomes_gate.ts";
import {
  applyBranchOutcomesFacts,
  resolveBranchOutcomesFacts,
} from "./pr_summary_facts.ts";

/** Outcome of one gate. A `not_checked` gate is not a pass. */
export type GateStatus =
  | "passed"
  | "blocked"
  | "not_applicable"
  | "not_checked";

/** One gate's verdict. */
export interface GateReport {
  gate: string;
  issueRef: string;
  status: GateStatus;
  problems: string[];
  note?: string;
}

/** Input to {@link runPrSummaryCheck}. */
export interface PrSummaryCheckInput {
  summaryContent: string;
  /**
   * Issue number from the `pr-summary-<N>.md` filename, or `null` when the
   * name carries none. Locates `pr-summary-<N>.facts.json`; `null` skips the
   * facts file.
   */
  issueNumber: number | null;
  baseBranch: string;
  /** The issue body, or `null` when none was supplied. */
  issueBody: string | null;
  /** Comma-separated issue labels, or `null` when none were supplied. */
  issueLabels: string | null;
  runGit: GitRunner;
  /** Every git call runs here: pathspecs in summaries are root-relative. */
  repoRoot: string;
}

/** Map a validator verdict onto a report. */
function fromVerdict(
  gate: string,
  issueRef: string,
  v: { applicable: boolean; valid: boolean; problems: string[] },
): GateReport {
  const status: GateStatus = !v.applicable
    ? "not_applicable"
    : v.valid
    ? "passed"
    : "blocked";
  return { gate, issueRef, status, problems: v.valid ? [] : v.problems };
}

/** A gate that could not run for want of an input. */
function notChecked(gate: string, issueRef: string, note: string): GateReport {
  return { gate, issueRef, status: "not_checked", problems: [], note };
}

/**
 * `Part of #N` or `Refs #N` for the run's own issue. Whitespace inside the
 * phrase is bounded so a padded body cannot backtrack. The issue number is
 * compared after the match, never interpolated into the pattern.
 */
const PART_OR_REFS_RE = /\b(?:part\s{1,8}of|refs)\s{0,8}#(\d+)\b/gi;

/** How the summary says it leaves the run's issue open, in reading order. */
function keptOpenPhrases(summary: string, issueNumber: number): string[] {
  const lines = splitMarkdownLines(maskMarkdownCode(summary));
  const phrases: string[] = [];
  for (const unit of markdownLogicalUnits(lines)) {
    if (unit.kind === "code") continue;
    PART_OR_REFS_RE.lastIndex = 0;
    for (const match of unit.text.matchAll(PART_OR_REFS_RE)) {
      if (Number(match[1]) === issueNumber) phrases.push(match[0]);
    }
  }
  return phrases;
}

const WAYS_OUT =
  "Mark the unmet criterion missing (`- **missing** — … — reason: …`) so the close is withheld, or drop the Part of / Refs line if this pull request does close the issue.";

/**
 * When a summary says it is only part of the run's issue, but the assembled
 * body would still close that issue (Issue #4126).
 *
 * Route 1: no closing keyword, so `ensurePrReferencesIssue` appends
 * `Closes #N`. Route 2: the summary itself contains a closing keyword,
 * including a negated one such as "does not close #N", which GitHub still
 * honours. A parsed `missing` criterion is the #3177 hold, so it passes.
 *
 * @returns The block message, or undefined when the gate passes.
 */
function partOfStillClosesProblem(
  summary: string,
  issueNumber: number,
): string | undefined {
  const phrases = keptOpenPhrases(summary, issueNumber);
  if (phrases.length === 0) return undefined;
  if (findMissingCriteria(summary).length > 0) return undefined;
  const keptOpen = phrases[0]!;
  const closing = closingKeywordLine(maskMarkdownCode(summary), issueNumber);
  if (closing !== null) {
    return `${keptOpen} says the issue stays open, but the summary still contains the closing phrase "${closing}". ${WAYS_OUT}`;
  }
  if (ensurePrReferencesIssue(summary, issueNumber) !== summary) {
    return `${keptOpen} says the issue stays open, but the summary has no parsed missing criterion, so the worker appends Closes #${issueNumber}. ${WAYS_OUT}`;
  }
  return undefined;
}

/** The Part-of gate report for one summary. */
function partOfStillClosesReport(
  summary: string,
  issueNumber: number,
): GateReport {
  const problem = partOfStillClosesProblem(summary, issueNumber);
  return {
    gate: "Part of still closes",
    issueRef: "#4126",
    status: problem === undefined ? "passed" : "blocked",
    problems: problem === undefined ? [] : [problem],
  };
}

/** Run every local PR-summary gate. Fails loud when git cannot be read. */
export async function runPrSummaryCheck(
  input: PrSummaryCheckInput,
): Promise<Result<GateReport[], Error>> {
  const { issueBody, issueLabels, runGit, repoRoot } = input;
  const rawSummary = input.summaryContent;

  // Issue #3535: same facts-file handling as the completion phase, so a
  // summary holding only the marker is judged on the rendered list.
  const facts = input.issueNumber === null
    ? ({ kind: "absent" } as const)
    : await resolveBranchOutcomesFacts(repoRoot, input.issueNumber);
  let summaryContent = rawSummary;
  let factsProblem: string | null = facts.kind === "error"
    ? facts.reason
    : null;
  if (facts.kind === "valid") {
    const rendered = applyBranchOutcomesFacts(rawSummary, facts.rendered);
    if (rendered.ok) summaryContent = rendered.value;
    else factsProblem = rendered.error.message;
  }

  const base = await resolveComparableBaseRef(runGit, input.baseBranch, {
    cwd: repoRoot,
  });
  if (!base.ok) return { ok: false, error: base.error };

  const diff = await runGit(
    ["diff", "--name-only", `${base.value}...HEAD`],
    { cwd: repoRoot },
  );
  if (!diff.ok) {
    return {
      ok: false,
      error: new Error(`git diff failed: ${diff.error.message}`),
    };
  }
  if (diff.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `git diff exited ${diff.value.code}: ${diff.value.stderr.trim()}`,
      ),
    };
  }
  const changedFiles = diff.value.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const scrubProblem = summaryScrubProblem(summaryContent);
  const reports: GateReport[] = [{
    gate: "Prompt-scrubbed Markdown",
    issueRef: "#3710",
    status: scrubProblem === undefined ? "passed" : "blocked",
    problems: scrubProblem === undefined ? [] : [scrubProblem],
  }];

  reports.push(
    issueBody === null
      ? notChecked(
        "Acceptance-criteria closure",
        "#518",
        "no --issue-body-file given",
      )
      : fromVerdict(
        "Acceptance-criteria closure",
        "#518",
        validateAcceptanceClosure({
          issueBody,
          prSummaryContent: summaryContent,
        }),
      ),
  );

  reports.push(
    issueBody === null
      ? notChecked(
        "Independent two-axis review",
        "#663",
        "no --issue-body-file given",
      )
      : fromVerdict(
        "Independent two-axis review",
        "#663",
        validateIndependentReview({
          issueBody,
          prSummaryContent: summaryContent,
        }),
      ),
  );

  reports.push(
    issueLabels === null
      ? notChecked("Reproduction status", "#521", "no --labels given")
      : fromVerdict(
        "Reproduction status",
        "#521",
        validateReproductionStatus({
          issueLabels,
          prSummaryContent: summaryContent,
        }),
      ),
  );

  reports.push(fromVerdict(
    "Docs sweep",
    "#3073",
    validateDocsSweep({ changedFiles, prSummaryContent: summaryContent }),
  ));

  const placeholders = validateResultPlaceholders(summaryContent);
  reports.push({
    gate: "Result placeholders",
    issueRef: "#3124",
    status: placeholders.valid ? "passed" : "blocked",
    problems: placeholders.valid ? [] : [
      `left-over fill-in-later token(s): ${placeholders.tokens.join(", ")}`,
    ],
  });

  // Same wiring as the completion phase, with git run from the repo root.
  const testsAtHead = await lookupTestsAtHead(
    namedTestPaths(parseBranchOutcomes(summaryContent)),
    (args) => runGit(args, { cwd: repoRoot }),
  );
  const branchOutcomes = fromVerdict(
    "Branch outcomes",
    "#3147",
    validateBranchOutcomes({
      changedFiles,
      prSummaryContent: summaryContent,
      testsAtHead,
    }),
  );
  if (factsProblem !== null) {
    branchOutcomes.status = "blocked";
    branchOutcomes.problems.unshift(factsProblem);
  }
  reports.push(branchOutcomes);

  reports.push(
    input.issueNumber === null
      ? notChecked(
        "Part of still closes",
        "#4126",
        "no issue number in the summary file name",
      )
      : partOfStillClosesReport(summaryContent, input.issueNumber),
  );

  reports.push(notChecked(
    "Summary claim check",
    "#3257",
    "needs a model call; the worker runs it when it raises the PR",
  ));

  return { ok: true, value: reports };
}

/** Whether any gate blocked. */
export function hasBlock(reports: readonly GateReport[]): boolean {
  return reports.some((r) => r.status === "blocked");
}

/** Render the reports, one line per gate with indented detail. */
export function formatReport(reports: readonly GateReport[]): string {
  const lines: string[] = [];
  for (const r of reports) {
    lines.push(`[${r.status.toUpperCase()}] ${r.gate} (${r.issueRef})`);
    for (const p of r.problems) lines.push(`    - ${p}`);
    if (r.note) lines.push(`    note: ${r.note}`);
  }
  const blocked = reports.filter((r) => r.status === "blocked").length;
  const unchecked = reports.filter((r) => r.status === "not_checked").length;
  lines.push(
    `${blocked} gate(s) blocked; ${unchecked} not checked ` +
      "(a not-checked gate is not a pass).",
  );
  return lines.join("\n");
}
