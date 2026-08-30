/**
 * Honest reproduction status for bug fixes (Issue #521).
 *
 * Adopted from GitHub spec-kit's `bug` extension, whose guardrail is one
 * sentence worth taking whole: "a reproduction that was not actually performed
 * is reported as `partial` or `not-run`, not `verified`."
 *
 * Every work tier shares one pipeline here and `bug` is a purely descriptive
 * label, so a PR summary claiming "added a regression test" reads identically
 * whether the test was watched to fail before the fix or merely written
 * afterwards — exactly the over-claim the fail-loud standard exists to prevent.
 * This module is the deterministic half of the fix: when the issue carries the
 * `bug` label, the PR summary must carry a `## Reproduction` block recording
 * the symptom, the status as `verified` / `partial` / `not-run`, and the
 * regression test that covers it.
 *
 * `verified` may only be claimed when the regression test was observed failing
 * against the unfixed code and passing after the fix; anything less is
 * `partial` or `not-run` with a one-line reason. A not-run reproduction is a
 * legitimate, reportable outcome — the gate blocks the silent over-claim, not
 * the honest downgrade.
 *
 * No new label, no new priority tier, no separate lane: this is a conditional
 * block in the existing PR-summary contract, gated at the same PR-creation
 * chokepoint as `acceptance_criteria_gate.ts`.
 *
 * All exported functions are pure — the caller (`phases/completion_phase.ts`)
 * supplies the labels and the assembled PR body, so the whole path is
 * unit-tested without a network. The PR summary is agent-authored and steered
 * by an untrusted issue body, so it is treated as untrusted text: bounded
 * regexes over a capped slice, never executed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** The three-value reproduction vocabulary. */
export type ReproductionStatus = "verified" | "partial" | "not-run";

/** The `## Reproduction` block parsed out of a PR summary. */
export interface ReproductionBlock {
  /** Whether a `## Reproduction` heading exists at all. */
  present: boolean;
  /** The recorded status, or `null` when absent or unrecognised. */
  status: ReproductionStatus | null;
  /** The recorded symptom (empty when absent). */
  symptom: string;
  /** The regression test named as covering the symptom (empty when absent). */
  regressionTest: string;
  /** The one-line reason for a downgraded status (empty when absent). */
  reason: string;
  /** Whether the block states the fail-before / pass-after observation. */
  observedFailBeforePassAfter: boolean;
}

/** Verdict of the reproduction-status gate. */
export interface ReproductionGateResult {
  /** True when the issue carries the `bug` label, so the gate applies. */
  applicable: boolean;
  /** True when the gate passes (always true when it does not apply). */
  valid: boolean;
  /** The parsed block, for failure messages and logging. */
  block: ReproductionBlock;
  /** One line per rule broken — empty when the gate passes. */
  problems: string[];
}

/** Cap on untrusted text scanned by the gate's regexes (defence in depth). */
const MAX_SCAN_CHARS = 200_000;

/** A `## Reproduction` (or `## Reproduction Status`) heading, any level. */
const REPRODUCTION_HEADING_RE =
  /^\s{0,3}#{1,6}\s+reproduction(\s+status)?\s*:?\s*$/i;

/** Any markdown heading — the section boundary. */
const ANY_HEADING_RE = /^\s{0,3}#{1,6}\s+/;

/** A list marker or task-list checkbox leading a line. */
const LIST_MARKER_RE = /^\s{0,3}(?:[-*+]|\d+[.)])\s+(?:\[[ xX~]?\]\s*)?/;

/**
 * The block's labelled fields. Hardcoded patterns only — a `new RegExp()`
 * built from an argument is a ReDoS surface Semgrep blocks on.
 */
const FIELD_PATTERNS = {
  symptom: /^symptom\s*[:\-–—]\s*(.*)$/i,
  status: /^(?:reproduction\s+)?status\s*[:\-–—]\s*(.*)$/i,
  regressionTest: /^(?:regression\s+)?test\s*[:\-–—]\s*(.*)$/i,
} as const;

/** The reason a downgraded status carries, wherever it sits in the block. */
const REASON_RE = /reason\s*[:\-–—]\s*(.*)$/i;

/**
 * The fail-before / pass-after observation `verified` requires. Matches
 * explicit before/after-the-fix wording, unfixed/pre-fix phrasing, or a
 * "fails … passes" sequence.
 */
const FAIL_BEFORE_PASS_AFTER_RE =
  /\b(?:before|after|without|against)\s+(?:the\s+)?(?:fix|patch|change)\b|\bunfixed\b|\bpre-fix\b|fail\w*\b[\s\S]{0,120}\bpass\w*\b/i;

/** Strip markdown decoration so `- **status** — x` reads as `status — x`. */
function stripDecoration(line: string): string {
  return line.replace(LIST_MARKER_RE, "").replace(/[*`]/g, "").trim();
}

/** Whether a decorated line opens one of the block's labelled fields. */
function opensField(line: string): boolean {
  return Object.values(FIELD_PATTERNS).some((pattern) => pattern.test(line));
}

/**
 * Group the section's lines into entries: a new entry starts at a list item or
 * a labelled field, and any following non-blank line continues it. Wrapped
 * markdown is common, so a `reason:` that spills onto the next line still
 * belongs to its field.
 */
function collectEntries(sectionLines: string[]): string[] {
  const entries: string[] = [];
  let current: string[] | null = null;

  for (const raw of sectionLines) {
    if (raw.trim() === "") {
      if (current) entries.push(current.join(" "));
      current = null;
      continue;
    }
    const line = stripDecoration(raw);
    if (LIST_MARKER_RE.test(raw) || opensField(line)) {
      if (current) entries.push(current.join(" "));
      current = [line];
      continue;
    }
    if (current) current.push(line);
    else current = [line];
  }
  if (current) entries.push(current.join(" "));

  return entries.filter((entry) => entry.trim() !== "");
}

/** Extract the `## Reproduction` section body, or `null` when absent. */
function extractSection(markdown: string): string[] | null {
  const lines = markdown.slice(0, MAX_SCAN_CHARS).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!REPRODUCTION_HEADING_RE.test(lines[i]!)) continue;
    const collected: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (ANY_HEADING_RE.test(lines[j]!)) break;
      collected.push(lines[j]!);
    }
    return collected;
  }
  return null;
}

/** The value of a labelled field, or `""` when absent or empty. */
function fieldValue(
  entries: string[],
  field: keyof typeof FIELD_PATTERNS,
): string {
  for (const entry of entries) {
    const match = entry.match(FIELD_PATTERNS[field]);
    if (match && match[1]!.trim() !== "") return match[1]!.trim();
  }
  return "";
}

/**
 * The status word an entry records — the earliest recognised token, so a line
 * that also mentions another status word in its prose is still classified by
 * the status it leads with.
 */
function statusOf(text: string): ReproductionStatus | null {
  const normalised = text.toLowerCase().replace(/not[\s_]run/g, "not-run");
  let best: { status: ReproductionStatus; index: number } | null = null;
  for (const status of ["not-run", "partial", "verified"] as const) {
    const index = normalised.indexOf(status);
    if (index === -1) continue;
    if (!best || index < best.index) best = { status, index };
  }
  return best?.status ?? null;
}

/**
 * Parse the `## Reproduction` block out of a PR summary.
 *
 * @param prSummaryContent - The PR summary (or assembled PR body).
 * @returns The parsed block; `present` is `false` when the heading is absent.
 */
export function parseReproductionBlock(
  prSummaryContent: string,
): ReproductionBlock {
  const section = extractSection(prSummaryContent ?? "");
  if (section === null) {
    return {
      present: false,
      status: null,
      symptom: "",
      regressionTest: "",
      reason: "",
      observedFailBeforePassAfter: false,
    };
  }

  const entries = collectEntries(section);
  const statusText = fieldValue(entries, "status");
  const reasonMatch = entries
    .map((entry) => entry.match(REASON_RE))
    .find((match) => match !== null && match[1]!.trim() !== "");

  return {
    present: true,
    status: statusOf(statusText),
    symptom: fieldValue(entries, "symptom"),
    regressionTest: fieldValue(entries, "regressionTest"),
    reason: reasonMatch?.[1]?.trim() ?? "",
    observedFailBeforePassAfter: FAIL_BEFORE_PASS_AFTER_RE.test(
      entries.join("\n"),
    ),
  };
}

/** Whether the issue labels contain `bug` as a whole label. */
export function hasBugLabel(issueLabels: string): boolean {
  return (issueLabels ?? "")
    .split(",")
    .map((label) => label.trim().toLowerCase())
    .includes("bug");
}

/**
 * Verify that a bug fix records an honest reproduction status.
 *
 * Rules, all deterministic:
 *   1. The issue does not carry `bug` → the gate does not apply and passes.
 *   2. The summary must carry a `## Reproduction` block.
 *   3. The block must record the symptom and one of `verified` / `partial` /
 *      `not-run`.
 *   4. `verified` must name the regression test and state that it was observed
 *      failing against the unfixed code and passing after the fix.
 *   5. `partial` and `not-run` must carry a one-line `reason:` — the honest
 *      downgrade is accepted, the unexplained one is not.
 *
 * @param opts.issueLabels - Comma-separated issue labels (e.g. `bug,work-on`).
 * @param opts.prSummaryContent - The PR summary content (or assembled PR body).
 */
export function validateReproductionStatus(opts: {
  issueLabels: string;
  prSummaryContent: string;
}): ReproductionGateResult {
  const block = parseReproductionBlock(opts.prSummaryContent ?? "");
  if (!hasBugLabel(opts.issueLabels)) {
    return { applicable: false, valid: true, block, problems: [] };
  }

  const problems: string[] = [];

  if (!block.present) {
    problems.push(
      "the PR summary carries no `## Reproduction` block, but this issue is labelled `bug`",
    );
    return { applicable: true, valid: false, block, problems };
  }

  if (block.symptom === "") {
    problems.push(
      "the `## Reproduction` block records no `symptom` — state the behaviour the fix removes",
    );
  }

  if (block.status === null) {
    problems.push(
      "the `## Reproduction` block records no recognised `status` — it must be one of `verified`, `partial` or `not-run`",
    );
  }

  if (block.status === "verified") {
    if (block.regressionTest === "") {
      problems.push(
        "a `verified` reproduction must name the `regression test` that covers the symptom",
      );
    }
    if (!block.observedFailBeforePassAfter) {
      problems.push(
        "a `verified` reproduction must state that the regression test was observed failing against the unfixed code and passing after the fix — if it was not, report `partial` or `not-run` with a reason",
      );
    }
  }

  if (
    (block.status === "partial" || block.status === "not-run") &&
    block.reason === ""
  ) {
    problems.push(
      `a \`${block.status}\` reproduction must carry a one-line \`reason:\` saying what stopped it being verified`,
    );
  }

  return { applicable: true, valid: problems.length === 0, block, problems };
}

/**
 * Build the issue comment posted when the reproduction gate blocks PR creation.
 *
 * Names every rule broken and restates the required shape, so the next attempt
 * can fix the summary without re-deriving the format.
 */
export function buildReproductionGateComment(
  result: ReproductionGateResult,
): string {
  const problems = result.problems.map((problem) => `- ${problem}`).join("\n");
  return [
    "⚠️ **Reproduction status missing.** This issue is labelled `bug`, so the " +
    "PR summary must record how far the original symptom was actually " +
    "reproduced before the PR is raised:",
    "",
    problems,
    "",
    "Add a `## Reproduction` block to " +
    "`docs/archive/pr-summaries/pr-summary-<issue>.md` in this shape:",
    "",
    "```markdown",
    "## Reproduction",
    "",
    "- **symptom** — <the behaviour the fix removes>",
    "- **status** — `verified` — the regression test was observed failing " +
    "against the unfixed code and passing after the fix",
    "- **regression test** — `tests/foo_test.ts::reproduces the fault`",
    "```",
    "",
    "`verified` may only be claimed when that fail-before / pass-after " +
    "observation actually happened. Anything less is `partial` or `not-run` " +
    "with a one-line `reason:` — a reproduction that was not performed is a " +
    "legitimate, reportable outcome, not a failure to hide.",
  ].join("\n");
}
