/**
 * Deterministic acceptance-criteria closure gate for PR summaries (Issue #518).
 *
 * The planner writes a `## Acceptance Criteria` checklist into every published
 * sub-issue (`prompts/planning/v21.md`), and until now nothing downstream ever
 * read it back: the implementing run never saw the criteria as a target and the
 * PR summary never said which were met, so a reviewer had to re-derive them by
 * hand. The artefact was written and orphaned.
 *
 * `prompts/issue/v36.md` closes the loop on the agent side — when the issue body
 * carries criteria, the PR summary must carry a `## Acceptance Criteria` block
 * assessing each one as `met` / `partial` / `missing`, with the file or test that
 * evidences it, a one-line reason for every gap, and an `unrequested` entry for
 * any change in the diff not traceable to the issue. A prose rule alone is a
 * quality escape (the same escape `failure_detection_gate.ts` closes on the
 * planner side), so this module is the deterministic check behind it: an
 * unexplained gap is a failure to surface, not a pass.
 *
 * Both exported functions are pure — the caller
 * (`phases/completion_phase.ts`) supplies the issue body and the assembled PR
 * body, so the whole path is unit-tested without a network.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { reviewBlockTemplateLines } from "./review_block_template.ts";

/** Statuses a criterion may be closed out with. */
export type CriterionStatus = "met" | "partial" | "missing";

/** Statuses that must name the evidence observed. */
const EVIDENCE_REQUIRED: CriterionStatus[] = ["met", "partial"];

/** Statuses that must carry a one-line reason for the gap. */
const REASON_REQUIRED: CriterionStatus[] = ["partial", "missing"];

/** One assessment entry parsed out of the PR summary's closure block. */
export interface ClosureEntry {
  /** `met` / `partial` / `missing`, or `unrequested` for a scope-creep entry. */
  status: CriterionStatus | "unrequested";
  /** Whether the entry names the evidence observed. */
  hasEvidence: boolean;
  /** Whether the entry carries a reason. */
  hasReason: boolean;
  /** The entry text, for failure messages. */
  text: string;
}

/** Verdict of the closure gate. */
export interface AcceptanceClosureResult {
  /** True when the issue body carries criteria, so the gate applies. */
  applicable: boolean;
  /** True when the gate passes (always true when it does not apply). */
  valid: boolean;
  /** Criteria found in the issue body. */
  criteria: string[];
  /** Assessment entries found in the PR summary's closure block. */
  entries: ClosureEntry[];
  /** One line per rule broken — empty when the gate passes. */
  problems: string[];
}

// A markdown heading reading "Acceptance Criteria" (any heading level).
const ACCEPTANCE_HEADING_RE =
  /^\s{0,3}#{1,6}\s+acceptance\s+criteria\s*:?\s*$/i;

// Any markdown heading — used as the section boundary.
const ANY_HEADING_RE = /^\s{0,3}#{1,6}\s+/;

// A top-level markdown list item: "- x", "* x", "1. x", optionally a checkbox.
const LIST_ITEM_RE = /^\s{0,1}(?:[-*+]|\d+[.)])\s+(.*)$/;

// The leading checkbox of a task-list item, stripped from the criterion text.
const CHECKBOX_RE = /^\[[ xX~]?\]\s*/;

/**
 * Extract the `## Acceptance Criteria` section body from a markdown document.
 *
 * @returns the raw lines of the section, or `null` when no such heading exists.
 */
function extractSection(markdown: string): string[] | null {
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!ACCEPTANCE_HEADING_RE.test(lines[i]!)) continue;
    const collected: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (ANY_HEADING_RE.test(lines[j]!)) break;
      collected.push(lines[j]!);
    }
    return collected;
  }
  return null;
}

/**
 * Group a section's lines into top-level list items, each joined with its own
 * indented continuation lines.
 *
 * Continuations matter because an agent may put the evidence or the reason on a
 * nested bullet under the criterion rather than on the same line.
 */
function collectListItems(sectionLines: string[]): string[] {
  const items: string[] = [];
  let current: string[] | null = null;

  for (const line of sectionLines) {
    const match = line.match(LIST_ITEM_RE);
    if (match) {
      if (current) items.push(current.join(" "));
      current = [match[1]!.trim()];
      continue;
    }
    if (current && line.trim() !== "") {
      current.push(line.trim());
      continue;
    }
    if (current && line.trim() === "") {
      // A blank line ends the item but not the section.
      items.push(current.join(" "));
      current = null;
    }
  }
  if (current) items.push(current.join(" "));

  return items.filter((item) => item.trim() !== "");
}

/**
 * Extract the acceptance criteria stated in an issue body.
 *
 * Reads the list items under the `## Acceptance Criteria` heading, with any
 * task-list checkbox stripped. An issue with no such heading — or one whose
 * heading carries no list items — has no criteria, and the gate does not apply.
 *
 * @param issueBody - The raw issue body.
 * @returns The criterion texts, in body order (empty when there are none).
 */
export function extractAcceptanceCriteria(issueBody: string): string[] {
  const section = extractSection(issueBody);
  if (section === null) return [];
  return collectListItems(section)
    .map((item) => item.replace(CHECKBOX_RE, "").trim())
    .filter((item) => item !== "");
}

/**
 * Match the entry's status word — the earliest standalone status token in the
 * text, so a criterion that merely mentions another status word in its prose
 * ("the block is not missing") is still classified by its own leading status.
 */
function statusOf(entry: string): ClosureEntry["status"] | null {
  const normalised = entry.toLowerCase();
  let best: { status: ClosureEntry["status"]; index: number } | null = null;
  for (const status of ["unrequested", "partial", "missing", "met"] as const) {
    const match = normalised.match(
      new RegExp(`(?:^|[^a-z])(${status})(?:[^a-z]|$)`),
    );
    if (!match) continue;
    const index = match.index! + match[0].indexOf(status);
    if (!best || index < best.index) best = { status, index };
  }
  return best?.status ?? null;
}

// Hardcoded per-label patterns — a `new RegExp(label…)` built from an argument
// is a ReDoS surface Semgrep blocks on, and only these two labels exist.
const LABEL_PATTERNS = {
  evidence: /evidence\s*[:\-—]\s*(.*)$/i,
  reason: /reason\s*[:\-—]\s*(.*)$/i,
} as const;

/** Whether a labelled field (`evidence:`, `reason:`) is present and filled. */
function hasFilledLabel(
  entry: string,
  label: keyof typeof LABEL_PATTERNS,
): boolean {
  const match = entry.match(LABEL_PATTERNS[label]);
  if (!match) return false;
  return match[1]!.replace(/[`*_\s—-]/g, "") !== "";
}

/**
 * Parse the `## Acceptance Criteria` closure block out of a PR summary.
 *
 * Only list items carrying a recognised status word are treated as assessment
 * entries, so a prose lead-in above the list is ignored rather than mis-counted.
 *
 * @param prSummaryContent - The PR summary (or assembled PR body).
 * @returns The parsed entries, in summary order (empty when the block is absent).
 */
export function parseClosureEntries(prSummaryContent: string): ClosureEntry[] {
  const section = extractSection(prSummaryContent);
  if (section === null) return [];

  const entries: ClosureEntry[] = [];
  for (const item of collectListItems(section)) {
    const text = item.replace(CHECKBOX_RE, "").trim();
    const status = statusOf(text);
    if (!status) continue;
    entries.push({
      status,
      hasEvidence: hasFilledLabel(text, "evidence"),
      hasReason: hasFilledLabel(text, "reason"),
      text,
    });
  }
  return entries;
}

/**
 * Verify that a PR summary closes out the issue's acceptance criteria.
 *
 * Rules, all deterministic:
 *   1. The issue has no criteria → the gate does not apply and passes.
 *   2. The summary must carry a `## Acceptance Criteria` block with at least one
 *      assessment entry per stated criterion.
 *   3. A `met` or `partial` entry must name its evidence (`evidence: …`).
 *   4. A `partial`, `missing` or `unrequested` entry must carry a one-line
 *      reason (`reason: …`) — an unexplained gap is a failure to surface.
 *
 * @param opts.issueBody - The issue body the run implemented.
 * @param opts.prSummaryContent - The PR summary content (or assembled PR body).
 */
export function validateAcceptanceClosure(opts: {
  issueBody: string;
  prSummaryContent: string;
}): AcceptanceClosureResult {
  const criteria = extractAcceptanceCriteria(opts.issueBody);
  if (criteria.length === 0) {
    return {
      applicable: false,
      valid: true,
      criteria,
      entries: [],
      problems: [],
    };
  }

  const entries = parseClosureEntries(opts.prSummaryContent);
  const problems: string[] = [];

  const assessments = entries.filter((e) => e.status !== "unrequested");
  if (assessments.length === 0) {
    problems.push(
      `the PR summary carries no \`## Acceptance Criteria\` closure block, but the issue states ${criteria.length} criteri${
        criteria.length === 1 ? "on" : "a"
      }`,
    );
  } else if (assessments.length < criteria.length) {
    problems.push(
      `only ${assessments.length} of ${criteria.length} acceptance criteria are assessed in the closure block`,
    );
  }

  for (const entry of entries) {
    const status = entry.status;
    if (
      status !== "unrequested" &&
      EVIDENCE_REQUIRED.includes(status) && !entry.hasEvidence
    ) {
      problems.push(
        `\`${status}\` entry names no evidence: "${entry.text}"`,
      );
    }
    const needsReason = status === "unrequested" ||
      REASON_REQUIRED.includes(status as CriterionStatus);
    if (needsReason && !entry.hasReason) {
      problems.push(
        `\`${status}\` entry carries no reason: "${entry.text}"`,
      );
    }
  }

  return {
    applicable: true,
    valid: problems.length === 0,
    criteria,
    entries,
    problems,
  };
}

/**
 * Build the issue comment posted when the closure gate blocks PR creation.
 *
 * Names every rule broken and restates the required shape, so the next attempt
 * can fix the summary without re-deriving the format.
 *
 * The shape printed is `REVIEW_BLOCK_TEMPLATE`, the same block the
 * independent-review gate prints, including its `## Standards Review` half:
 * that gate runs immediately after this one at the same chokepoint, so a
 * criteria block written from a template it rejects only trades one block for
 * the next (Issue #751).
 */
export function buildClosureGateComment(
  result: AcceptanceClosureResult,
): string {
  const problems = result.problems.map((p) => `- ${p}`).join("\n");
  return [
    "⚠️ **Acceptance-criteria closure missing.** This issue states acceptance " +
    "criteria, so the PR summary must close each one out before the PR is " +
    "raised:",
    "",
    problems,
    "",
    "Add a `## Acceptance Criteria` block to " +
    "`docs/archive/pr-summaries/pr-summary-<issue>.md` with one entry per " +
    "criterion, in this shape — the `## Standards Review` half is printed with " +
    "it because the independent-review gate runs next and blocks a criteria " +
    "block raised without it:",
    "",
    ...reviewBlockTemplateLines(),
  ].join("\n");
}
