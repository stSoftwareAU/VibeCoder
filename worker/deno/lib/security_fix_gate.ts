/**
 * Security-fix patch-verification gate (Issue #3540, gap G4).
 *
 * VibeCoder's scans are detect-only: a finding is filed as a `security`
 * -labelled issue and the fix rides the normal `work-on` PR. That PR has no
 * vulnerability-specific gate, so nothing guarantees a regression test
 * reproduces the flaw, nor that the original trigger is actually closed — the
 * static analogue of Anthropic `/patch`'s "PoC no longer fires / no bypass"
 * and Visa VVAH S11's adversarial validation panel.
 *
 * This module is the lightweight per-repo gate (Issue #3239 — no cross-repo
 * centralisation). It activates only when the PR closes a security finding
 * (the issue carries the `security` label, or the PR summary references a
 * `SEC-<hex>` finding id) and then requires two kinds of evidence:
 *
 * **Machine-checkable (the gate proper, Issue #3652)** — asserted against the
 * branch diff, which the agent cannot satisfy by writing prose:
 *
 *  1. the diff **adds or modifies a test file**; and
 *  2. a **test identifier named in the PR summary actually appears** in the
 *     added lines of that test diff.
 *
 * **Self-reported prose (a human-review aid, kept as a secondary requirement)**
 * — a regression-test fail-before/pass-after linkage, and an original-trigger-
 * closed statement. Prose alone is no longer sufficient: the summary is written
 * by the same party the evidence is about, and the finding body that steers it
 * is untrusted input, so it is treated as untrusted text here (bounded regexes
 * over a capped slice, never executed).
 *
 * Aligns with the "fail loud / never mask a fault as success" principle
 * (Issue #3234): a security-fix PR that cannot show the fault is genuinely
 * closed must not sail through as a clean success — including when the diff
 * evidence could not be collected at all.
 *
 * Pure functions, no I/O. Australian English throughout.
 */

/** Distinct evidence items the gate requires of a security-fix PR. */
export type SecurityFixEvidenceKind =
  | "regression-test"
  | "trigger-closed"
  | "test-file-changed"
  | "test-identifier-in-diff"
  | "diff-unavailable";

/**
 * Machine-checkable diff evidence for the PR branch, collected by
 * `security_fix_diff.ts` (`git diff` only — nothing is executed).
 */
export interface SecurityFixDiffEvidence {
  /** Paths changed by the branch (`git diff --name-only <base>...HEAD`). */
  changedFiles: string[];
  /** Diff body restricted to the changed test files. */
  testDiffText: string;
}

/** Outcome of evaluating the security-fix gate against a PR summary. */
export interface SecurityFixGateResult {
  /**
   * Whether this PR closes a security finding, i.e. whether the gate is
   * active. When `false`, the gate is a no-op and `ok` is always `true`.
   */
  isSecurityFix: boolean;
  /**
   * `true` when the gate is inactive, or active with every required evidence
   * item present. `false` only when active and at least one item is missing.
   */
  ok: boolean;
  /** Required evidence items that were not found (empty when `ok`). */
  missing: SecurityFixEvidenceKind[];
}

/** Input to {@link evaluateSecurityFixGate}. */
export interface SecurityFixGateInput {
  /** The PR summary / body content to inspect. Untrusted, agent-authored. */
  prSummaryContent: string;
  /** Comma-separated issue labels (e.g. `security,work-on`). */
  issueLabels: string;
  /**
   * Diff evidence for the PR branch, or `null` when it could not be collected.
   * Required — a caller must not be able to omit the machine-checkable half by
   * accident, and `null` blocks rather than silently passing (Issue #3652).
   */
  diff: SecurityFixDiffEvidence | null;
}

/** Cap on untrusted text scanned by the gate's regexes (defence in depth). */
const MAX_SCAN_CHARS = 200_000;

/** Stable `SEC-<hex>` finding id, e.g. `SEC-a1b2c3d4e5f6` (Issue #1938). */
const FINDING_ID_PATTERN = /\bSEC-[0-9a-f]{6,}\b/i;

/** A test that reproduces the flaw (regression / failing test reference). */
const REGRESSION_TEST_REFERENCE =
  /\b(regression test|reproduc\w+|failing test|test that fails)\b/i;

/**
 * Fail-before / pass-after linkage — the static analogue of "PoC no longer
 * fires". Matches explicit before/after-the-fix wording, unfixed/pre-fix
 * phrasing, or a "fails … passes" sequence.
 */
const BEFORE_AFTER_LINKAGE =
  /\b(before|after|without|with)\s+(the\s+)?(fix|patch|change)\b|\bunfixed\b|\bpre-fix\b|\bpost-fix\b|fails?\b[\s\S]{0,80}\bpasses?\b/i;

/**
 * Original trigger closed with no trivial bypass — the static analogue of
 * "a fresh find agent cannot bypass" / VVAH S11 adoption scoring.
 */
const TRIGGER_CLOSED =
  /\bno\s+(trivial\s+)?bypass\b|\b(cannot|can't|unable to|prevents?|blocks?|rejects?|neutralis\w+|mitigat\w+)\b[\s\S]{0,60}\bbypass\b|\boriginal\s+(trigger|attack|input|vector|payload|poc|exploit|request)\b|\btrigger\s+is\s+(now\s+)?closed\b|\bno longer\s+(fires|triggers|exploitable|vulnerable)\b|\bclose[sd]?\s+the\s+(original\s+)?(trigger|attack|vector|hole|vulnerability)\b/i;

/** Path shapes that count as a test file across this fleet's ecosystems. */
const TEST_PATH_PATTERNS: RegExp[] = [
  /(^|\/)tests?\//i, // tests/… or test/…
  /_test\.[a-z]+$/i, // foo_test.ts (Deno), foo_test.py
  /\.test\.[a-z]+$/i, // foo.test.ts (Jest/Vitest)
  /\.spec\.[a-z]+$/i, // foo.spec.ts (Cypress/Jasmine)
  /(^|\/)test_[^/]+\.[a-z]+$/i, // test_foo.py
  /\.bats$/i, // BATS suites
  /(^|\/)cypress\//i, // Cypress specs
  /Test\.java$/, // FooTest.java
];

/** Whether a repo-relative path is a test file. */
export function isTestFilePath(path: string): boolean {
  const trimmed = path.trim();
  if (!trimmed) return false;
  return TEST_PATH_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Test identifiers cited in a PR summary. Bounded patterns only — the summary
 * is untrusted text.
 */
const TEST_IDENTIFIER_PATTERNS: RegExp[] = [
  // `tests/foo_test.ts::rejects_injection` — the documented citation form.
  /::\s*([A-Za-z0-9_][A-Za-z0-9_.\-]{2,120})/g,
  // `tests/foo.bats::"handles empty input"` — quoted names may hold spaces.
  /::\s*["'`]([^\n"'`]{3,160})["'`]/g,
  // An inline test declaration quoted in the summary.
  /\b(?:Deno\.test|@test|it|test)\s*\(?\s*["'`]([^"'`\n]{3,160})["'`]/g,
];

/** Lowercase and collapse punctuation so `a_b` and `a b` compare equal. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Extract the test identifiers a PR summary claims to have added, e.g. the
 * `rejects_injection` in ``tests/db_test.ts::rejects_injection``.
 */
export function extractTestIdentifiers(content: string): string[] {
  const scanned = content.slice(0, MAX_SCAN_CHARS);
  const identifiers = new Set<string>();
  for (const pattern of TEST_IDENTIFIER_PATTERNS) {
    for (const match of scanned.matchAll(pattern)) {
      const candidate = normalise(match[1] ?? "");
      // Four characters keeps trivially-short matches from passing the gate.
      if (candidate.length >= 4) identifiers.add(candidate);
    }
  }
  return [...identifiers];
}

/** Added (`+`) lines of a unified diff, excluding the `+++` file header. */
function addedLines(diffText: string): string {
  return diffText
    .slice(0, MAX_SCAN_CHARS)
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .join("\n");
}

/**
 * Whether any identifier cited in the summary actually appears in the added
 * lines of the test diff — the coupling that prose alone cannot fake.
 */
export function citedTestIdentifierInDiff(
  content: string,
  testDiffText: string,
): boolean {
  const added = normalise(addedLines(testDiffText));
  if (!added) return false;
  return extractTestIdentifiers(content).some((id) => added.includes(id));
}

/** Whether the issue labels contain `security` as a whole label. */
export function hasSecurityLabel(issueLabels: string): boolean {
  return issueLabels
    .split(",")
    .map((label) => label.trim().toLowerCase())
    .includes("security");
}

/** Whether the content references a `SEC-<hex>` finding id. */
export function referencesFindingId(content: string): boolean {
  return FINDING_ID_PATTERN.test(content);
}

/**
 * Evaluate the security-fix patch-verification gate.
 *
 * The gate is active when the issue carries the `security` label or the PR
 * summary references a `SEC-<hex>` finding id. When active it asserts the
 * machine-checkable diff signals first (a test file is changed, and a test
 * identifier named in the summary appears in that test diff), then the
 * self-reported prose linkage as a secondary human-review aid. Pure — inspects
 * strings only, never executes anything.
 */
export function evaluateSecurityFixGate(
  input: SecurityFixGateInput,
): SecurityFixGateResult {
  const content = (input.prSummaryContent ?? "").slice(0, MAX_SCAN_CHARS);
  const isSecurityFix = hasSecurityLabel(input.issueLabels) ||
    referencesFindingId(content);

  if (!isSecurityFix) {
    return { isSecurityFix: false, ok: true, missing: [] };
  }

  const missing: SecurityFixEvidenceKind[] = [];

  // Machine-checkable evidence — the gate proper (Issue #3652).
  if (!input.diff) {
    missing.push("diff-unavailable");
  } else {
    if (!input.diff.changedFiles.some(isTestFilePath)) {
      missing.push("test-file-changed");
    }
    if (!citedTestIdentifierInDiff(content, input.diff.testDiffText)) {
      missing.push("test-identifier-in-diff");
    }
  }

  // Self-reported prose — retained as a human-review aid, not the gate.
  const hasRegressionTest = REGRESSION_TEST_REFERENCE.test(content) &&
    BEFORE_AFTER_LINKAGE.test(content);
  if (!hasRegressionTest) missing.push("regression-test");

  if (!TRIGGER_CLOSED.test(content)) missing.push("trigger-closed");

  return { isSecurityFix: true, ok: missing.length === 0, missing };
}

/**
 * Remediation instruction for each missing evidence item.
 *
 * Exported (Issue #4057) so the coding prompt can state the same contract up
 * front instead of leaving an agent to discover it by being blocked — one
 * source of truth for what the gate demands and what the prompt promises.
 */
export const SECURITY_FIX_EVIDENCE_DESCRIPTIONS: Record<
  SecurityFixEvidenceKind,
  string
> = {
  "test-file-changed":
    "Add or modify a TEST FILE in this branch. The branch diff currently changes no test file, so there is no regression test to verify — prose in the summary cannot substitute for it.",
  "test-identifier-in-diff":
    "Name the ACTUAL TEST IDENTIFIER you added, in the form `path/to/foo_test.ts::the test name`, and make sure that name matches a test added in this branch's diff. The summary either names no test or names one that does not appear in the added test lines.",
  "diff-unavailable":
    "The branch diff could not be computed against the base branch, so the machine-checkable test assertion could not run. Ensure the base branch is fetched (`git fetch origin <base>`) and retry — an uncheckable security fix is blocked rather than assumed good.",
  "regression-test":
    'Add a regression test that FAILS against the unfixed code and PASSES after the fix (state the test\'s linkage explicitly, per the TDD standard — e.g. "Added `tests/foo_test.ts::rejects_injection` which reproduces the flaw, fails against the unfixed code and passes after the fix").',
  "trigger-closed":
    'Add a short statement that the ORIGINAL TRIGGER is closed with no trivial bypass (static reasoning over the changed code path — e.g. "the original attack input is now rejected by the allowlist and no equivalent bypass exists").',
};

/**
 * Evidence items a security-fix PR must positively supply, in the order the
 * prompt states them (Issue #4057). `diff-unavailable` is excluded: it reports
 * an environment fault, not something the PR summary can be written to satisfy.
 */
export const REQUIRED_SECURITY_FIX_EVIDENCE:
  readonly SecurityFixEvidenceKind[] = [
    "test-file-changed",
    "test-identifier-in-diff",
    "regression-test",
    "trigger-closed",
  ];

/** Whether a value is one of the gate's evidence kinds (Issue #4057). */
export function isSecurityFixEvidenceKind(
  value: unknown,
): value is SecurityFixEvidenceKind {
  return typeof value === "string" &&
    Object.hasOwn(SECURITY_FIX_EVIDENCE_DESCRIPTIONS, value);
}

/**
 * Build the operator-facing failure message for a blocked security-fix PR.
 * Lists exactly what the PR summary must add so the retry is productive.
 */
export function buildSecurityFixGateMessage(
  missing: SecurityFixEvidenceKind[],
): string {
  const items = missing
    .map((kind) => `- ${SECURITY_FIX_EVIDENCE_DESCRIPTIONS[kind]}`)
    .join("\n");
  return `PR creation blocked: this PR closes a security-labelled finding but is missing required vulnerability-fix verification evidence.

Any PR that closes a \`security\` finding must show — in the branch diff, not only in prose — that the fault is genuinely closed (fail loud — never mask a fault as success, Issue #3234):

${items}

Fix the branch (and \`docs/archive/pr-summaries/pr-summary-<issue>.md\`), then retry. No execution is required: the test assertions are static checks over \`git diff\`, and the trigger-closed statement is static reasoning over the changed code path.`;
}
