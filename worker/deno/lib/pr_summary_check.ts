/**
 * Local PR-summary gate check (Issue #3423).
 *
 * Runs the deterministic PR-summary gates the worker applies when it raises a
 * PR against a draft summary and the branch diff, so an agent can see every
 * block before the worker does. Pure apart from the injected git runner.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { resolveComparableBaseRef } from "./git_base_ref.ts";
import type { GitRunner } from "./git_base_ref.ts";
import { validateAcceptanceClosure } from "./acceptance_criteria_gate.ts";
import { validateIndependentReview } from "./independent_review_gate.ts";
import { validateReproductionStatus } from "./reproduction_status_gate.ts";
import { validateDocsSweep } from "./docs_sweep_gate.ts";
import { validateResultPlaceholders } from "./result_placeholder_gate.ts";
import {
  lookupTestsAtHead,
  namedTestPaths,
  parseBranchOutcomes,
  validateBranchOutcomes,
} from "./branch_outcomes_gate.ts";

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

/** Run every local PR-summary gate. Fails loud when git cannot be read. */
export async function runPrSummaryCheck(
  input: PrSummaryCheckInput,
): Promise<Result<GateReport[], Error>> {
  const { summaryContent, issueBody, issueLabels, runGit, repoRoot } = input;

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

  const reports: GateReport[] = [];

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
  reports.push(fromVerdict(
    "Branch outcomes",
    "#3147",
    validateBranchOutcomes({
      changedFiles,
      prSummaryContent: summaryContent,
      testsAtHead,
    }),
  ));

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
