/**
 * Local PR-summary gate check (Issue #3423, extended by Issue #4234).
 *
 * Runs the PR-summary gates the worker applies when it raises a PR against a
 * draft summary and the branch diff, so an agent can see every block before
 * the worker does. Pure apart from the injected git runner, and the injected
 * model-backed checks (the claim check and the pre-PR verifier), which the
 * caller supplies only when it wants a model call made.
 *
 * Report names and issue references come from `summary_gate_registry.ts`, the
 * same registry the drift test holds against the completion phase.
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
import {
  type RemovedAssertionGateResult,
  validateRemovedAssertions,
} from "./removed_assertion_gate.ts";
import { readRemovedAssertionInput } from "./removed_assertion_input.ts";
import {
  assessUnmetCriteria,
  unmetCriteriaReason,
} from "./unmet_criteria_gate.ts";
import type { DegradedShortfall } from "./degraded_delivery.ts";
import {
  summaryClaimBlockReason,
  summaryClaimCheckBlocked,
  type SummaryClaimCheckResult,
} from "./summary_claim_check.ts";
import {
  prePrVerifierBlocked,
  prePrVerifierBlockReason,
  type PrePrVerifierResult,
} from "./pre_pr_verifier.ts";
import { gateRef, PR_SUMMARY_GATES } from "./summary_gate_registry.ts";

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

/**
 * What a model-backed check is handed. `summaryPath` is the summary's
 * repo-relative path, or `null` when the caller does not know it.
 */
export interface SummaryGateContext {
  summaryPath: string | null;
  summaryContent: string;
  baseRef: string;
  changedFiles: readonly string[];
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
  /**
   * Repo-relative path of the summary, handed to the model-backed checks;
   * `null` (the default) when unknown.
   */
  summaryPath?: string | null;
  baseBranch: string;
  /** The issue body, or `null` when none was supplied. */
  issueBody: string | null;
  /**
   * The issue title, or `null` when none was supplied. Only the removed-
   * assertion gate reads it, and it accepts a `Required by:` quote from the
   * body alone.
   */
  issueTitle: string | null;
  /** Comma-separated issue labels, or `null` when none were supplied. */
  issueLabels: string | null;
  runGit: GitRunner;
  /** Every git call runs here: pathspecs in summaries are root-relative. */
  repoRoot: string;
  /** Receives the removed-assertion gate's read warnings; optional. */
  logger?: { warn(message: string): void };
  /**
   * The summary claim check (model call). Absent → reported not checked,
   * never a pass.
   */
  claimCheck?: (
    ctx: SummaryGateContext,
  ) => Promise<SummaryClaimCheckResult>;
  /**
   * The pre-PR verifier (model call, opt-in). Absent → reported not checked,
   * never a pass.
   */
  verifier?: (ctx: SummaryGateContext) => Promise<PrePrVerifierResult>;
}

/** Note for a model-backed check that was not handed a runner. */
const CLAIM_CHECK_NOT_RUN =
  "not run: this check was given no model call (the worker runs it when it raises the PR)";
/** Note for the opt-in verifier when no runner was handed in. */
const VERIFIER_NOT_RUN =
  "opt-in, not run: pass --verifier to run the pre-PR verifier here (the worker runs it when it raises the PR)";
/** Note for a gate that needs a runner only the worker has. */
const WORKER_ONLY_NOTE =
  "needs the worker's test runner, so the local check cannot run it";
/** Note for a gate that needs the issue body, which was not supplied. */
const NO_ISSUE_BODY = "no --issue-body-file given";

/** Map a validator verdict onto a report. */
function fromVerdict(
  id: string,
  v: { applicable: boolean; valid: boolean; problems: string[] },
): GateReport {
  const status: GateStatus = !v.applicable
    ? "not_applicable"
    : v.valid
    ? "passed"
    : "blocked";
  return {
    ...gateRef(id),
    status,
    problems: v.valid ? [] : v.problems,
  };
}

/** A gate that could not run for want of an input. */
function notChecked(id: string, note: string): GateReport {
  return { ...gateRef(id), status: "not_checked", problems: [], note };
}

/** The removed-assertion gate's verdict as a report. */
function removedAssertionReport(v: RemovedAssertionGateResult): GateReport {
  const ref = gateRef("removed-assertions");
  if (!v.applicable) return { ...ref, status: "not_applicable", problems: [] };
  if (!v.valid) return { ...ref, status: "blocked", problems: v.problems };
  if (!v.testDiffKnown) {
    return {
      ...ref,
      status: "not_checked",
      problems: [],
      note:
        "the test-file diff could not be read, so only the Test Plan heading rule was checked",
    };
  }
  return { ...ref, status: "passed", problems: [] };
}

/** The unmet-criteria gate's verdict as a report. */
function unmetCriteriaReport(unmet: readonly DegradedShortfall[]): GateReport {
  const ref = gateRef("unmet-criteria");
  if (unmet.length === 0) return { ...ref, status: "passed", problems: [] };
  return {
    ...ref,
    status: "blocked",
    problems: [
      unmetCriteriaReason(unmet),
      ...unmet.map((s) => `${s.criterion} (${s.status})`),
    ],
  };
}

/** The summary claim check's verdict as a report (its blocking predicate). */
function claimCheckReport(r: SummaryClaimCheckResult): GateReport {
  const ref = gateRef("claim-check");
  const note = r.notChecked.length > 0 ? r.notChecked.join("; ") : undefined;
  if (summaryClaimCheckBlocked(r)) {
    return {
      ...ref,
      status: "blocked",
      problems: [summaryClaimBlockReason(r)],
      note,
    };
  }
  if (note !== undefined) {
    return { ...ref, status: "not_checked", problems: [], note };
  }
  return { ...ref, status: "passed", problems: [] };
}

/** The pre-PR verifier's verdict as a report (its blocking predicate). */
function verifierReport(r: PrePrVerifierResult): GateReport {
  const ref = gateRef("pre-pr-verifier");
  if (r.status === "not_checked") {
    return { ...ref, status: "not_checked", problems: [], note: r.reason };
  }
  if (prePrVerifierBlocked(r)) {
    return {
      ...ref,
      status: "blocked",
      problems: [
        prePrVerifierBlockReason(r.review),
        ...r.review.findings.map((f) => `${f.file}:${f.line} — ${f.problem}`),
      ],
    };
  }
  return { ...ref, status: "passed", problems: [] };
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
    ...gateRef("prompt-scrub"),
    status: scrubProblem === undefined ? "passed" : "blocked",
    problems: scrubProblem === undefined ? [] : [scrubProblem],
  }];

  reports.push(
    issueBody === null
      ? notChecked("acceptance-closure", NO_ISSUE_BODY)
      : fromVerdict(
        "acceptance-closure",
        validateAcceptanceClosure({
          issueBody,
          prSummaryContent: summaryContent,
        }),
      ),
  );

  reports.push(
    issueBody === null
      ? notChecked("independent-review", NO_ISSUE_BODY)
      : fromVerdict(
        "independent-review",
        validateIndependentReview({
          issueBody,
          prSummaryContent: summaryContent,
        }),
      ),
  );

  reports.push(
    issueLabels === null
      ? notChecked("reproduction-status", "no --labels given")
      : fromVerdict(
        "reproduction-status",
        validateReproductionStatus({
          issueLabels,
          prSummaryContent: summaryContent,
        }),
      ),
  );

  reports.push(fromVerdict(
    "docs-sweep",
    validateDocsSweep({ changedFiles, prSummaryContent: summaryContent }),
  ));

  const placeholders = validateResultPlaceholders(summaryContent);
  reports.push({
    ...gateRef("result-placeholders"),
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
    "branch-outcomes",
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

  // The removed-assertion gate needs the issue body: a `Required by:` quote
  // is checked against it. Without one it is not checked, as the closure
  // gate is, rather than blocking every quote it cannot verify.
  if (issueBody === null) {
    reports.push(notChecked("removed-assertions", NO_ISSUE_BODY));
  } else {
    const removedInput = await readRemovedAssertionInput({
      runGit: (args) => runGit(args, { cwd: repoRoot }),
      base: base.value,
      changedFiles,
      changedFilesKnown: true,
      logger: input.logger,
    });
    reports.push(removedAssertionReport(validateRemovedAssertions({
      changedFiles: [...changedFiles, ...removedInput.testFiles],
      testDiff: removedInput.testDiff,
      prSummaryContent: summaryContent,
      issueTitle: input.issueTitle ?? "",
      issueBody,
    })));
  }

  const unmetCriteria = issueBody === null
    ? null
    : assessUnmetCriteria(issueBody, summaryContent);
  reports.push(
    unmetCriteria === null
      ? notChecked("unmet-criteria", NO_ISSUE_BODY)
      : unmetCriteriaReport(unmetCriteria),
  );

  const ctx: SummaryGateContext = {
    summaryPath: input.summaryPath ?? null,
    summaryContent,
    baseRef: base.value,
    changedFiles,
  };
  reports.push(
    input.claimCheck === undefined
      ? notChecked("claim-check", CLAIM_CHECK_NOT_RUN)
      : claimCheckReport(await input.claimCheck(ctx)),
  );
  reports.push(
    input.verifier === undefined
      ? notChecked("pre-pr-verifier", VERIFIER_NOT_RUN)
      : verifierReport(await input.verifier(ctx)),
  );

  for (const gate of PR_SUMMARY_GATES) {
    if (gate.localCheck === "worker-only") {
      reports.push(notChecked(gate.id, WORKER_ONLY_NOTE));
    }
  }

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
