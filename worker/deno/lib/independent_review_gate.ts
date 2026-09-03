/**
 * Independent two-axis review gate for PR summaries (Issue #663).
 *
 * Adopted from `skills/engineering/code-review/SKILL.md` in
 * [mattpocock/skills](https://github.com/mattpocock/skills), which reviews a
 * diff along two axes — **Standards** (does it follow the repo's documented
 * standards?) and **Spec** (does it faithfully implement the originating
 * issue?) — in independent sub-agent contexts, and reports them under separate
 * headings, never merged or reranked. A change can pass one axis and fail the
 * other; reporting them together lets one mask the other.
 *
 * We had both axes and neither property. The Spec axis is the
 * `## Acceptance Criteria` closure block that `acceptance_criteria_gate.ts`
 * checks, but it was **self-assessed by the agent that wrote the code**, in the
 * same context that produced it — which is why the prompt had to counter-steer
 * with "do not inflate a status". The Standards axis was the injected
 * `<coding_guidelines>` block, applied while writing rather than checked against
 * the finished diff, and the two were never reported side by side.
 *
 * `prompts/issue/prompt.md` dispatches a Spec reviewer sub-agent (diff + issue body
 * only, never the implementation transcript) and a Standards reviewer sub-agent
 * (diff + `CODING-STANDARDS.md`), and this module is the deterministic check
 * behind that prose:
 *
 *   - the criteria block carries the Spec reviewer's provenance marker and one
 *     `reviewer:` verdict per entry, so the block records an independent verdict
 *     rather than the author's recollection;
 *   - the author may still depart from that verdict — a fresh reviewer with no
 *     implementation context is sometimes wrong — but only out loud, naming the
 *     reviewer's verdict and a reason;
 *   - the Standards axis is reported under its own heading, and neither axis may
 *     carry the other's findings.
 *
 * It runs beside `acceptance_criteria_gate.ts` at the same PR-creation
 * chokepoint in `phases/completion_phase.ts` and applies to the same issues:
 * those whose body states acceptance criteria.
 *
 * All exported functions are pure — the caller supplies the issue body and the
 * assembled PR body, so the whole path is unit-tested without a network. The PR
 * summary is agent-authored and steered by an untrusted issue body, so it is
 * treated as untrusted text: bounded regexes over a capped slice, never
 * executed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { extractAcceptanceCriteria } from "./acceptance_criteria_gate.ts";
import { reviewBlockTemplateLines } from "./review_block_template.ts";

/** The Spec axis vocabulary — the closure statuses of a criterion. */
export type SpecStatus = "met" | "partial" | "missing" | "unrequested";

/** The Standards axis vocabulary. */
export type StandardsStatus = "violation" | "clean";

const SPEC_STATUSES: SpecStatus[] = [
  "met",
  "partial",
  "missing",
  "unrequested",
];
const STANDARDS_STATUSES: StandardsStatus[] = ["violation", "clean"];

/** One entry parsed out of either axis's block. */
export interface ReviewEntry {
  /** The leading status token of the entry. */
  status: SpecStatus | StandardsStatus;
  /** The `reviewer:` verdict recorded on a Spec entry, `null` when absent. */
  reviewerVerdict: SpecStatus | null;
  /** True when a Spec entry's own status differs from the reviewer's verdict. */
  departsFromReviewer: boolean;
  /** Whether the entry names the evidence observed. */
  hasEvidence: boolean;
  /** Whether the entry carries a reason. */
  hasReason: boolean;
  /** The entry text, for failure messages. */
  text: string;
}

/** Verdict of the independent-review gate. */
export interface IndependentReviewResult {
  /** True when the issue body states criteria, so the gate applies. */
  applicable: boolean;
  /** True when the gate passes (always true when it does not apply). */
  valid: boolean;
  /** True when the criteria block records the Spec reviewer's provenance. */
  specProvenance: boolean;
  /** True when the standards block records the Standards reviewer's provenance. */
  standardsProvenance: boolean;
  /** Assessment entries found under `## Acceptance Criteria`. */
  specEntries: ReviewEntry[];
  /** Findings found under `## Standards Review`. */
  standardsEntries: ReviewEntry[];
  /** One line per rule broken — empty when the gate passes. */
  problems: string[];
}

/** Cap on untrusted text scanned by the gate's regexes (defence in depth). */
const MAX_SCAN_CHARS = 200_000;

/** A `## Acceptance Criteria` heading, any level. */
const SPEC_HEADING_RE = /^\s{0,3}#{1,6}\s+acceptance\s+criteria\s*:?\s*$/i;

/** A `## Standards Review` heading, any level. */
const STANDARDS_HEADING_RE = /^\s{0,3}#{1,6}\s+standards\s+review\s*:?\s*$/i;

/** Any markdown heading — the section boundary. */
const ANY_HEADING_RE = /^\s{0,3}#{1,6}\s+/;

/** A top-level markdown list item, with any task-list checkbox stripped. */
const LIST_ITEM_RE = /^\s{0,1}(?:[-*+]|\d+[.)])\s+(?:\[[ xX~]?\]\s*)?(.*)$/;

/** The leading status token of an entry: `**met**`, `met`, `` `met` ``. */
const LEADING_TOKEN_RE = /^[`*_\s]*([a-z][a-z-]{1,15})[`*_\s]*(?=[—\-:,.]|$)/i;

// Hardcoded per-label patterns — a `new RegExp(label…)` built from an argument
// is a ReDoS surface Semgrep blocks on, and only these three labels exist.
const LABEL_PATTERNS = {
  evidence: /evidence\s*[:\-—]\s*([^\n]*)/i,
  reason: /reason\s*[:\-—]\s*([^\n]*)/i,
  reviewer: /reviewer\s*[:\-—]\s*[`*_]*([a-z-]{1,16})/i,
} as const;

/** The provenance markers each axis's reviewer stamps on its block. */
const PROVENANCE_PATTERNS = {
  spec: /<!--\s*vibe-spec-review\s+inputs\s*=\s*"([^"]*)"[^>]*-->/i,
  standards: /<!--\s*vibe-standards-review\s+inputs\s*=\s*"([^"]*)"[^>]*-->/i,
} as const;

/** Extract a heading's section body, or `null` when the heading is absent. */
function extractSection(markdown: string, heading: RegExp): string[] | null {
  const lines = markdown.slice(0, MAX_SCAN_CHARS).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!heading.test(lines[i]!)) continue;
    const collected: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (ANY_HEADING_RE.test(lines[j]!)) break;
      collected.push(lines[j]!);
    }
    return collected;
  }
  return null;
}

/** Group a section's lines into list items, each joined with its continuations. */
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
    if (current) {
      items.push(current.join(" "));
      current = null;
    }
  }
  if (current) items.push(current.join(" "));

  return items.filter((item) => item.trim() !== "");
}

/** Whether a labelled field is present and filled. */
function labelValue(
  entry: string,
  label: keyof typeof LABEL_PATTERNS,
): string | null {
  const match = entry.match(LABEL_PATTERNS[label]);
  if (!match) return null;
  const value = match[1]!.replace(/[`*_\s—-]/g, "");
  return value === "" ? null : match[1]!.trim();
}

/**
 * Classify an entry by its **leading** status token only.
 *
 * Leading-token classification is what keeps the axis-separation rule honest:
 * a criterion whose prose happens to mention "clean" or "violation" is still a
 * Spec entry, so only a genuinely merged finding trips the rule.
 */
function leadingStatus(text: string): string | null {
  const match = text.match(LEADING_TOKEN_RE);
  return match ? match[1]!.toLowerCase() : null;
}

/** Parse one list item into an entry, or `null` when it carries no status. */
function toEntry(
  text: string,
  vocabulary: readonly string[],
): ReviewEntry | null {
  const status = leadingStatus(text);
  if (!status || !vocabulary.includes(status)) return null;

  const reviewerRaw = labelValue(text, "reviewer")?.toLowerCase() ?? null;
  const reviewerVerdict = SPEC_STATUSES.includes(reviewerRaw as SpecStatus)
    ? reviewerRaw as SpecStatus
    : null;

  return {
    status: status as SpecStatus | StandardsStatus,
    reviewerVerdict,
    departsFromReviewer: reviewerVerdict !== null && reviewerVerdict !== status,
    hasEvidence: labelValue(text, "evidence") !== null,
    hasReason: labelValue(text, "reason") !== null,
    text,
  };
}

/** Parse the entries of one section under `heading` using `vocabulary`. */
function parseSection(
  markdown: string,
  heading: RegExp,
  vocabulary: readonly string[],
): ReviewEntry[] {
  const section = extractSection(markdown, heading);
  if (section === null) return [];
  const entries: ReviewEntry[] = [];
  for (const item of collectListItems(section)) {
    const entry = toEntry(item, vocabulary);
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * Parse the `## Standards Review` findings out of a PR summary.
 *
 * @param prSummaryContent - The PR summary (or assembled PR body).
 * @returns The findings, in summary order (empty when the section is absent).
 */
export function parseStandardsEntries(prSummaryContent: string): ReviewEntry[] {
  return parseSection(
    prSummaryContent,
    STANDARDS_HEADING_RE,
    STANDARDS_STATUSES,
  );
}

/**
 * Parse the `## Acceptance Criteria` entries, each with its reviewer verdict.
 *
 * @param prSummaryContent - The PR summary (or assembled PR body).
 * @returns The Spec entries, in summary order (empty when the block is absent).
 */
export function parseSpecEntries(prSummaryContent: string): ReviewEntry[] {
  return parseSection(prSummaryContent, SPEC_HEADING_RE, SPEC_STATUSES);
}

/** Whether a section carries its axis's provenance marker with real inputs. */
function hasProvenance(
  sectionLines: string[] | null,
  axis: keyof typeof PROVENANCE_PATTERNS,
): boolean {
  if (sectionLines === null) return false;
  const match = sectionLines.join("\n").match(PROVENANCE_PATTERNS[axis]);
  return match !== null && match[1]!.trim() !== "";
}

/** Count list items in a section whose leading token belongs to `vocabulary`. */
function countForeignEntries(
  markdown: string,
  heading: RegExp,
  vocabulary: readonly string[],
): ReviewEntry[] {
  return parseSection(markdown, heading, vocabulary);
}

/**
 * Verify that the PR summary reports an independent review on both axes.
 *
 * Rules, all deterministic:
 *   1. The issue states no criteria → the gate does not apply and passes.
 *   2. The `## Acceptance Criteria` block carries the Spec reviewer's
 *      provenance marker, naming the inputs it was given.
 *   3. Every Spec entry names the reviewer's verdict (`reviewer: <status>`).
 *   4. An entry whose status departs from that verdict carries a reason.
 *   5. A `## Standards Review` section exists, carries its own provenance
 *      marker and at least one finding, and every `violation` names evidence
 *      and a reason.
 *   6. Neither axis carries the other's findings — never merged, never reranked.
 *
 * @param opts.issueBody - The issue body the run implemented.
 * @param opts.prSummaryContent - The PR summary content (or assembled PR body).
 */
export function validateIndependentReview(opts: {
  issueBody: string;
  prSummaryContent: string;
}): IndependentReviewResult {
  const criteria = extractAcceptanceCriteria(opts.issueBody);
  if (criteria.length === 0) {
    return {
      applicable: false,
      valid: true,
      specProvenance: false,
      standardsProvenance: false,
      specEntries: [],
      standardsEntries: [],
      problems: [],
    };
  }

  const summary = opts.prSummaryContent.slice(0, MAX_SCAN_CHARS);
  const specSection = extractSection(summary, SPEC_HEADING_RE);
  const standardsSection = extractSection(summary, STANDARDS_HEADING_RE);
  const specEntries = parseSpecEntries(summary);
  const standardsEntries = parseStandardsEntries(summary);
  const specProvenance = hasProvenance(specSection, "spec");
  const standardsProvenance = hasProvenance(standardsSection, "standards");
  const problems: string[] = [];

  // --- the Spec axis ---
  if (!specProvenance) {
    problems.push(
      "the `## Acceptance Criteria` block carries no " +
        '`<!-- vibe-spec-review inputs="…" -->` marker — the verdict must come ' +
        "from the independent Spec reviewer sub-agent, not the author's " +
        "recollection",
    );
  }
  for (const entry of specEntries) {
    if (entry.reviewerVerdict === null) {
      problems.push(
        `\`${entry.status}\` entry names no \`reviewer:\` verdict (met / partial / missing / unrequested): "${entry.text}"`,
      );
      continue;
    }
    if (entry.departsFromReviewer && !entry.hasReason) {
      problems.push(
        `\`${entry.status}\` entry departs from the Spec reviewer's \`${entry.reviewerVerdict}\` verdict with no reason: "${entry.text}"`,
      );
    }
  }

  // --- the Standards axis ---
  if (standardsSection === null) {
    problems.push(
      "the PR summary carries no `## Standards Review` section — the Standards " +
        "axis is reported under its own heading, never folded into the criteria " +
        "block",
    );
  } else {
    if (!standardsProvenance) {
      problems.push(
        "the `## Standards Review` section carries no " +
          '`<!-- vibe-standards-review inputs="…" -->` marker — the findings ' +
          "must come from the independent Standards reviewer sub-agent",
      );
    }
    if (standardsEntries.length === 0) {
      problems.push(
        "the `## Standards Review` section states no finding — record each " +
          "`violation` or the `clean` areas the reviewer checked",
      );
    }
  }
  for (const entry of standardsEntries) {
    if (entry.status !== "violation") continue;
    if (!entry.hasEvidence) {
      problems.push(
        `\`violation\` finding names no evidence: "${entry.text}"`,
      );
    }
    if (!entry.hasReason) {
      problems.push(
        `\`violation\` finding carries no reason saying whether it was fixed: "${entry.text}"`,
      );
    }
  }

  // --- axis separation, both directions ---
  const mergedIntoSpec = countForeignEntries(
    summary,
    SPEC_HEADING_RE,
    STANDARDS_STATUSES,
  );
  for (const entry of mergedIntoSpec) {
    problems.push(
      `Standards finding merged into the \`## Acceptance Criteria\` block — move it under \`## Standards Review\`: "${entry.text}"`,
    );
  }
  const mergedIntoStandards = countForeignEntries(
    summary,
    STANDARDS_HEADING_RE,
    SPEC_STATUSES,
  );
  for (const entry of mergedIntoStandards) {
    problems.push(
      `acceptance-criteria entry merged into the \`## Standards Review\` section — the two axes are never merged or reranked: "${entry.text}"`,
    );
  }

  return {
    applicable: true,
    valid: problems.length === 0,
    specProvenance,
    standardsProvenance,
    specEntries,
    standardsEntries,
    problems,
  };
}

/**
 * Build the issue comment posted when the independent-review gate blocks the PR.
 *
 * Names every rule broken and restates both blocks, so the next attempt can fix
 * the summary without re-deriving the format. The shape printed is
 * `REVIEW_BLOCK_TEMPLATE`, the same block the acceptance-criteria gate prints,
 * so a run blocked by either gate is handed one shape rather than two that
 * contradict each other (Issue #751).
 */
export function buildIndependentReviewComment(
  result: IndependentReviewResult,
): string {
  const problems = result.problems.map((p) => `- ${p}`).join("\n");
  return [
    "⚠️ **Independent review missing.** This issue states acceptance criteria, " +
    "so the Spec and Standards axes must each be judged by their own reviewer " +
    "sub-agent and reported under their own heading — never merged, never " +
    "reranked:",
    "",
    problems,
    "",
    "Dispatch the two reviewers before writing the summary — the Spec reviewer " +
    "sees only `git diff <base>...HEAD` and the issue body, the Standards " +
    "reviewer only the diff and `CODING-STANDARDS.md` — then record both in " +
    "`docs/archive/pr-summaries/pr-summary-<issue>.md`:",
    "",
    ...reviewBlockTemplateLines(),
    "",
    "Keep the `reviewer:` field as the reviewer wrote it. Where your own " +
    "status departs from it, say so out loud in the entry's `reason:` — an " +
    "unrecorded departure is the self-assessment the axis exists to remove.",
  ].join("\n");
}
