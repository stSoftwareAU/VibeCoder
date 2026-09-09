/**
 * Generic, check-agnostic baseline-aware quality-gate bypass (Issue #2604).
 *
 * The whole-gate "treat as passed when every current finding was already
 * present at baseline" decision reasons over every diffable check at once:
 * mermaid, markdownlint and workflow hygiene. (Shellcheck is no longer run
 * by the worker — Issue #3129 delegated bash linting to each target repo's
 * own CI, and Issue #844 removed the docs prompt-version check with prompt
 * versioning itself.)
 *
 * A pre-existing failure in an untouched mermaid/markdownlint artefact
 * no longer fails the post-Claude gate (the production symptom — a Mermaid
 * reserved-keyword collision in an unrelated doc pushing the worker into a
 * remediation loop). Workflow hygiene joined the set in Issue #1641: the
 * built-in gate runs its `set -euo pipefail` and version-comment rules on
 * every monitored repository, so a repository whose workflows predate those
 * conventions failed every run on residue the run did not create —
 * GRQ-FX-validation#119 spent its whole invocation budget on seven
 * `version-comment-drift` findings that were all on `Develop`. The
 * decision sees ALL failing checks, so a genuinely-new failure is never
 * waved through just because another check had carryover.
 *
 * A check that is NOT diffable (deno test/lint/type-check, etc.) failing
 * means the PR likely touched code — never bypass in that case.
 *
 * Uses Australian English throughout (behaviour, colour, organisation,
 * favour, centre).
 */

import { type MermaidCheckResult, runMermaidCheck } from "./mermaid_check.ts";
import {
  type MarkdownlintCheckResult,
  runMarkdownlintCheck,
} from "./markdownlint_check.ts";
import {
  scanWorkflowsForHygiene,
  type WorkflowHygieneResult,
} from "./workflow_hygiene_check.ts";
/**
 * The diffable check kinds the generic bypass can reason over. Each maps
 * one-to-one to a `GenericFinding.check` value and to a quality-gate
 * check name (see `CHECK_NAME_TO_KIND`).
 */
export type DiffableCheck = "mermaid" | "markdownlint" | "workflow hygiene";

/**
 * Quality-gate check NAMES (as reported in `CheckResult.name`) that are
 * diffable. A failing check whose name is absent from this set blocks the
 * bypass outright.
 */
export const DIFFABLE_CHECK_NAMES: ReadonlySet<string> = new Set([
  "mermaid",
  "markdownlint",
  "workflow hygiene",
]);

/** Map a failing quality-gate check name to its diffable kind. */
const CHECK_NAME_TO_KIND: Readonly<Record<string, DiffableCheck>> = {
  "mermaid": "mermaid",
  "markdownlint": "markdownlint",
  "workflow hygiene": "workflow hygiene",
};

/**
 * A single check-agnostic finding.
 *
 * - `check` — which diffable check produced it.
 * - `key` — position-insensitive identity. Two findings comparing equal
 *   across baseline and current share a key even if line/column shifted.
 * - `display` — a human-readable one-line description for retry prompts.
 */
export interface GenericFinding {
  check: DiffableCheck;
  key: string;
  display: string;
}

/** Outcome of the generic whole-gate bypass decision. */
export interface GateBypassDecision {
  /** Whether the failing gate should be treated as passed. */
  bypass: boolean;
  /** Current findings whose key was already present at baseline. */
  preExisting: GenericFinding[];
  /** Current findings introduced versus the baseline (regressions). */
  newFindings: GenericFinding[];
  /** Machine-readable reason for the decision (logging/telemetry). */
  reason: GateBypassReason;
}

/** Reasons the generic bypass decision can return. */
export type GateBypassReason =
  | "bypassed"
  | "non_diffable_failing"
  | "unparsed_failing_check"
  | "new_findings"
  | "no_carryover";

/**
 * Injectable runners so `collectDiffableGateFindings` is unit-testable
 * without invoking real subprocesses. Each defaults to the production
 * check when omitted.
 */
export interface DiffableGateDeps {
  mermaid?: (cwd: string) => Promise<MermaidCheckResult>;
  markdownlint?: (cwd: string) => Promise<MarkdownlintCheckResult>;
  workflowHygiene?: (cwd: string) => Promise<WorkflowHygieneResult>;
}

// ---------------------------------------------------------------------------
// Per-check key extraction (position-insensitive)
// ---------------------------------------------------------------------------

/** GenericFinding for a mermaid failure. */
export function mermaidFinding(
  f: { file: string; startLine: number; type: string; error: string },
): GenericFinding {
  return {
    check: "mermaid",
    key: `mermaid|${f.file}|${f.type}|${f.error}`,
    display: `${f.file}:${f.startLine} (${
      f.type || "no-declaration"
    }): ${f.error}`,
  };
}

/** GenericFinding for a markdownlint violation. */
export function markdownlintFinding(
  v: { file: string; line: number; rule: string; message: string },
): GenericFinding {
  return {
    check: "markdownlint",
    key: `markdownlint|${v.file}|${v.rule}|${v.message}`,
    display: `${v.file}:${v.line} ${v.rule} ${v.message}`,
  };
}

/**
 * GenericFinding for a workflow-hygiene violation (Issue #1641).
 *
 * Keyed on file, kind and detail — not the line — so a violation that moves
 * because the run edited the workflow above it still matches its baseline
 * twin, exactly as the mermaid and markdownlint keys do.
 */
export function workflowHygieneFinding(
  v: { file: string; line: number; kind: string; detail: string },
): GenericFinding {
  return {
    check: "workflow hygiene",
    key: `workflow hygiene|${v.file}|${v.kind}|${v.detail}`,
    display: `${v.file}:${v.line} ${v.kind}: ${v.detail}`,
  };
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/**
 * Run the diffable checks against `repoPath` and flatten their results
 * into a single `GenericFinding[]`.
 */
export async function collectDiffableGateFindings(
  repoPath: string,
  deps: DiffableGateDeps = {},
): Promise<GenericFinding[]> {
  const mermaidRun = deps.mermaid ?? runMermaidCheck;
  const markdownlintRun = deps.markdownlint ?? runMarkdownlintCheck;
  const hygieneRun = deps.workflowHygiene ?? scanWorkflowsForHygiene;

  const findings: GenericFinding[] = [];

  const mermaid = await mermaidRun(repoPath);
  for (const f of mermaid.failures) findings.push(mermaidFinding(f));

  const markdownlint = await markdownlintRun(repoPath);
  for (const v of markdownlint.violations) {
    findings.push(markdownlintFinding(v));
  }

  // Same scan the gate's `workflow hygiene` check runs (Issue #1641), so the
  // findings here account for that check's failure one-to-one.
  const hygiene = await hygieneRun(repoPath);
  for (const v of hygiene.violations) {
    findings.push(workflowHygieneFinding(v));
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Decision (pure)
// ---------------------------------------------------------------------------

/**
 * Decide whether a failing quality run should be treated as passed
 * because every current diffable finding was already present at baseline.
 *
 * Order of checks:
 *   1. Any failing check whose name is NOT diffable → never bypass.
 *   2. Parser-drift guard: any failing diffable check that produced ZERO
 *      current findings of its own kind → never bypass (we could not
 *      structurally account for the failure).
 *   3. Otherwise diff current against baseline by key-set. Bypass only
 *      when there are no new findings AND at least one pre-existing
 *      finding carried over (the carryover explains the failure).
 *
 * @param baseline - Diffable findings captured on the clean repo.
 * @param current - Diffable findings captured after Claude.
 * @param failingCheckNames - Names of every quality-gate check reported
 *   as FAILED on the current run.
 */
export function decideGateBypass(
  baseline: GenericFinding[],
  current: GenericFinding[],
  failingCheckNames: string[],
): GateBypassDecision {
  // (1) Any non-diffable failing check means the PR likely touched code.
  for (const name of failingCheckNames) {
    if (!DIFFABLE_CHECK_NAMES.has(name)) {
      return {
        bypass: false,
        preExisting: [],
        newFindings: [],
        reason: "non_diffable_failing",
      };
    }
  }

  // (2) Parser-drift guard — a failing diffable check we could not parse
  // into at least one current finding of its own kind is unaccountable.
  for (const name of failingCheckNames) {
    const kind = CHECK_NAME_TO_KIND[name];
    if (kind === undefined) continue; // already excluded by step (1)
    const parsed = current.some((f) => f.check === kind);
    if (!parsed) {
      return {
        bypass: false,
        preExisting: [],
        newFindings: [],
        reason: "unparsed_failing_check",
      };
    }
  }

  // (3) Diff by key-set.
  const baselineKeys = new Set(baseline.map((f) => f.key));
  const preExisting: GenericFinding[] = [];
  const newFindings: GenericFinding[] = [];
  for (const f of current) {
    if (baselineKeys.has(f.key)) preExisting.push(f);
    else newFindings.push(f);
  }

  if (newFindings.length > 0) {
    return { bypass: false, preExisting, newFindings, reason: "new_findings" };
  }
  if (preExisting.length === 0) {
    return { bypass: false, preExisting, newFindings, reason: "no_carryover" };
  }
  return { bypass: true, preExisting, newFindings, reason: "bypassed" };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format a Claude retry prompt that focuses on only the newly-introduced
 * findings across all diffable checks (Issue #2604).
 */
export function formatCarryoverFindings(findings: GenericFinding[]): string {
  if (findings.length === 0) return "";
  const lines: string[] = [
    "The post-change quality check introduced the following new findings",
    "(these were NOT present on the baseline run before changes):",
    "",
    ...findings.map((f) => `- [${f.check}] ${f.display}`),
    "",
    "Please fix only these new findings. Pre-existing baseline findings are " +
    "tracked separately and should NOT be modified as part of this change.",
  ];
  return lines.join("\n");
}
