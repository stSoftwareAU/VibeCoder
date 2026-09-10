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
 * Issue #1852 adds the check-agnostic half of the same question. A repository
 * whose OWN check is red on its default branch produces no findings to diff,
 * so it failed the gate on every run and recorded a host health failure each
 * time. `decidePreExistingGateFailure` compares the failing checks and their
 * output against the untouched tree's instead: same checks, same lines, so the
 * run reproduced a failure it did not cause and ends without failing.
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
import { redactSecrets } from "./secret_redaction.ts";
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

// ---------------------------------------------------------------------------
// Pre-existing whole-gate failure (Issue #1852)
// ---------------------------------------------------------------------------

/**
 * One quality-gate check that failed, with what it printed.
 *
 * The bypass above reasons over *findings*, which only the diffable checks
 * produce. A repository whose own non-diffable check is red on its default
 * branch has no findings to diff, so every run failed the gate on breakage
 * it did not create, recorded a host health failure, and cooled the issue
 * down — after which the next claim repeated the same doomed run. The
 * comparison below is check-agnostic: it asks whether the post-change gate
 * failed on the *same checks* with the *same output* as the untouched tree.
 */
export interface FailedCheck {
  /** Quality-gate check name, as reported in `CheckResult.name`. */
  name: string;
  /** What that check printed. */
  output: string;
}

/** Why {@link decidePreExistingGateFailure} decided as it did. */
export type PreExistingGateReason =
  /** Every failing check was already red, printing the same or less. */
  | "pre_existing"
  /** No baseline outcome, or the baseline gate passed. */
  | "baseline_passed"
  /** The baseline failed but recorded no per-check output to compare. */
  | "baseline_unattributed"
  /** The current run reported no failing check to attribute. */
  | "no_failing_checks"
  /** A check that was green on the untouched tree is now red. */
  | "new_failing_check"
  /** A check red at baseline is printing something it did not print then. */
  | "new_output";

/** Outcome of the pre-existing whole-gate failure decision. */
export interface PreExistingGateDecision {
  /** Whether this failure predates the run entirely. */
  preExisting: boolean;
  /** Machine-readable reason (logging/telemetry). */
  reason: PreExistingGateReason;
  /** Names of the checks red both on the untouched tree and now. */
  checks: string[];
  /** Normalised output lines the baseline did not have (empty when pre-existing). */
  newLines: string[];
}

/** Escape sequences a terminal-aware check writes around its output. */
// deno-lint-ignore no-control-regex -- ANSI SGR sequences are control chars.
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

/** A wall-clock measurement, which differs run to run on identical content. */
const DURATION_RE = /\b\d+(?:[.,]\d+)?\s*(?:ns|µs|us|ms|s|m)\b/g;

/** The per-check duration line the gate appends (Issue #86). */
const TIMING_LINE_RE = /⏱/;

/**
 * Reduce gate output to the lines that identify *what failed*, dropping what
 * differs between two runs over identical content.
 *
 * Secrets are masked first, because a cached baseline is stored redacted
 * while the live run's output is raw — comparing the two unmasked would read
 * a masked credential as a brand-new line and refuse every comparison.
 */
export function normaliseGateOutputLines(output: string): string[] {
  return redactSecrets(output)
    .replace(ANSI_ESCAPE_RE, "")
    .split("\n")
    .map((line) => line.replace(DURATION_RE, "<duration>").trim())
    .map((line) => line.replace(/\s+/g, " "))
    .filter((line) => line !== "" && !TIMING_LINE_RE.test(line));
}

/** The failing checks of a gate run, with the output each one printed. */
export function failedChecks(
  checks: readonly { name: string; status: string; output?: string }[],
): FailedCheck[] {
  return checks
    .filter((check) => check.status === "FAILED")
    .map((check) => ({ name: check.name, output: check.output ?? "" }));
}

/**
 * Decide whether a failing gate run reproduces a failure the untouched tree
 * already had (Issue #1852).
 *
 * True only when the run is **entirely** accounted for by the baseline: every
 * failing check was failing then, and every line it prints now was printed
 * then. A check that has gone red since, or a red check that has gained a
 * line, is a regression this run owns — today's failure behaviour stands.
 *
 * Fail-closed by construction: a missing baseline, a baseline that recorded
 * no per-check output (an entry written before this comparison existed), or
 * a run reporting no failing check at all all decide `false`.
 *
 * @param baseline - The untouched tree's outcome, or `undefined` when none
 *   was captured.
 * @param current - The failing checks of the post-change run.
 */
export function decidePreExistingGateFailure(
  baseline:
    | { passed: boolean; failedChecks?: readonly FailedCheck[] }
    | undefined,
  current: readonly FailedCheck[],
): PreExistingGateDecision {
  const no = (
    reason: PreExistingGateReason,
    newLines: string[] = [],
  ): PreExistingGateDecision => ({
    preExisting: false,
    reason,
    checks: [],
    newLines,
  });

  if (!baseline || baseline.passed) return no("baseline_passed");
  const baselineFailed = baseline.failedChecks ?? [];
  if (baselineFailed.length === 0) return no("baseline_unattributed");
  if (current.length === 0) return no("no_failing_checks");

  const baselineByName = new Map(
    baselineFailed.map((check) => [check.name, check]),
  );

  for (const check of current) {
    if (!baselineByName.has(check.name)) return no("new_failing_check");
  }

  const newLines: string[] = [];
  for (const check of current) {
    const before = new Set(
      normaliseGateOutputLines(baselineByName.get(check.name)?.output ?? ""),
    );
    for (const line of normaliseGateOutputLines(check.output)) {
      if (!before.has(line)) newLines.push(`${check.name}: ${line}`);
    }
  }
  if (newLines.length > 0) return no("new_output", newLines);

  return {
    preExisting: true,
    reason: "pre_existing",
    checks: current.map((check) => check.name),
    newLines: [],
  };
}
