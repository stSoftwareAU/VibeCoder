/**
 * The structured closure verdict the worker renders the review blocks from
 * (Issue #2242).
 *
 * The two PR-summary gates check a *document* whose shape is fixed and
 * machine-checked: two headings, two provenance markers, one labelled entry per
 * criterion, each naming a `reviewer:` verdict. The in-run recovery (#2189)
 * asked the model for that document — with the gate's own comment, template
 * included, as its brief — and on VibeCoder#2104 an eighteen-minute invocation
 * produced 103 lines of prose carrying none of it. Two runs of an hour each
 * died on a block the model was told, twice, exactly how to satisfy.
 *
 * So the worker stops depending on that compliance. The model is asked for the
 * verdict as **data** — one entry per stated criterion, plus the standards half
 * — and this module renders the `## Acceptance Criteria` and
 * `## Standards Review` blocks in the `REVIEW_BLOCK_TEMPLATE` shape both
 * validators accept. The content stays the model's; the shape can no longer be
 * wrong.
 *
 * Everything here is pure, so the whole path is unit-tested without a network,
 * and `tests/closure_verdict_test.ts` feeds the rendered block back through
 * both gates exactly as `review_block_template_test.ts` does for the template.
 *
 * The verdict text is model-authored and steered by an untrusted issue body, so
 * every free-text field is sanitised before it is rendered: one line, no label
 * keywords, no markdown heading or comment syntax. A criterion that could open
 * its own `## Standards Review` section, or carry its own `reviewer:` field,
 * would let the text decide the verdict the worker is rendering.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";

/** The Spec axis vocabulary — the closure statuses of a criterion. */
export type VerdictStatus = "met" | "partial" | "missing" | "unrequested";

/** The Standards axis vocabulary. */
export type StandardsVerdictStatus = "violation" | "clean";

const VERDICT_STATUSES: readonly VerdictStatus[] = [
  "met",
  "partial",
  "missing",
  "unrequested",
];

const STANDARDS_STATUSES: readonly StandardsVerdictStatus[] = [
  "violation",
  "clean",
];

/** Statuses whose entry must name the evidence observed. */
const EVIDENCE_REQUIRED: readonly VerdictStatus[] = ["met", "partial"];

/** Statuses whose entry must carry a one-line reason. */
const REASON_REQUIRED: readonly VerdictStatus[] = [
  "partial",
  "missing",
  "unrequested",
];

/** One criterion's verdict, as the model reported it. */
export interface CriterionVerdict {
  /** The criterion judged, or the unrequested change described. */
  criterion: string;
  /** The Spec reviewer's verdict on it. */
  status: VerdictStatus;
  /** The file, test or artefact that demonstrates it. */
  evidence?: string;
  /** One line explaining a gap, a departure or an unrequested change. */
  reason?: string;
}

/** One Standards-axis finding, as the model reported it. */
export interface StandardsVerdict {
  /** `violation` or `clean`. */
  status: StandardsVerdictStatus;
  /** The standard breached, or the areas checked and found compliant. */
  finding: string;
  /** The `file:line` a violation was seen at. */
  evidence?: string;
  /** Whether a violation was fixed here, or why it stands. */
  reason?: string;
}

/** A whole closure verdict — both axes, plus what could not be read. */
export interface ClosureVerdict {
  /** Spec-axis entries, in the order the model gave them. */
  criteria: CriterionVerdict[];
  /** Standards-axis findings, in the order the model gave them. */
  standards: StandardsVerdict[];
  /**
   * Entries the parser refused, each described for the log and the re-ask.
   *
   * A dropped entry is never silently discarded: it makes the verdict
   * incomplete (see {@link assessVerdictCoverage}), so the model is asked once
   * more with the shortfall named.
   */
  dropped: string[];
}

/** Whether a verdict covers what the gates will check, and what is short. */
export interface VerdictCoverage {
  /** True when nothing is outstanding. */
  complete: boolean;
  /** One line per shortfall — the brief for the single re-ask. */
  shortfalls: string[];
}

/** The delimiters the model wraps its verdict JSON in. */
export const CLOSURE_VERDICT_OPEN = "<closure_verdict>";
/** Closing delimiter — see {@link CLOSURE_VERDICT_OPEN}. */
export const CLOSURE_VERDICT_CLOSE = "</closure_verdict>";

/** Cap on any single rendered field, so one entry cannot swamp the summary. */
const MAX_FIELD_CHARS = 300;

/** Cap on the JSON scanned out of an agent reply (defence in depth). */
const MAX_VERDICT_CHARS = 100_000;

/** Cap on entries read from one verdict — a runaway reply renders nothing useful. */
const MAX_ENTRIES = 100;

/**
 * Render one model-supplied field as a single safe line of markdown.
 *
 * Three things are removed, each because the gates' own parsers would otherwise
 * read them as structure rather than as text:
 *
 *   - newlines and list markers, which would split one entry into several;
 *   - `#` headings and HTML comments, which would open a section or forge a
 *     provenance marker;
 *   - the `evidence:` / `reason:` / `reviewer:` label keywords, which the
 *     validators match on — the first match wins, so a criterion carrying its
 *     own `reviewer: missing` would override the verdict being rendered.
 *
 * The keyword scrub deliberately consumes any letters **before** the keyword as
 * well. The validators' own patterns are unanchored (`/evidence\s*[:\-—]/i`),
 * so `Xevidence: trust me` reads to them as a filled `evidence:` field: a
 * `\b`-anchored scrub would leave exactly the forgery it exists to remove.
 *
 * @param raw - The model's text.
 * @returns The sanitised single line, empty when nothing survived.
 */
function sanitiseField(raw: string): string {
  return raw
    .replace(/[\r\n]+/g, " ")
    .replace(/<!--|-->/g, " ")
    .replace(/[A-Za-z]{0,32}(?:evidence|reason|reviewer)\s*[:\-—]+\s*/gi, " ")
    .replace(/[`*_#|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_FIELD_CHARS)
    .trim();
}

/** Read a string field, sanitised; `null` when absent or empty after the scrub. */
function field(source: Record<string, unknown>, name: string): string | null {
  const raw = source[name];
  if (typeof raw !== "string") return null;
  const cleaned = sanitiseField(raw);
  return cleaned === "" ? null : cleaned;
}

/** A short, safe description of a rejected entry, for the log and the re-ask. */
function describeRejected(
  index: number,
  problem: string,
  raw: unknown,
): string {
  const shown = sanitiseField(JSON.stringify(raw) ?? String(raw)).slice(0, 120);
  return `entry ${index + 1} ${problem}: ${shown}`;
}

/**
 * Take at most {@link MAX_ENTRIES} entries, recording any truncation.
 *
 * The cap is a bound on a runaway reply, not a licence to lose entries
 * quietly: what is cut is named in `dropped`, so the coverage check reports it
 * and the re-ask asks for it.
 */
function capEntries(
  raw: unknown[],
  label: string,
  dropped: string[],
): unknown[] {
  if (raw.length <= MAX_ENTRIES) return raw;
  dropped.push(
    `the verdict listed ${raw.length} ${label} entries; only the first ` +
      `${MAX_ENTRIES} were read`,
  );
  return raw.slice(0, MAX_ENTRIES);
}

/** Parse the `criteria` array, collecting what had to be dropped. */
function readCriteria(
  raw: unknown[],
  dropped: string[],
): CriterionVerdict[] {
  const entries: CriterionVerdict[] = [];
  capEntries(raw, "criteria", dropped).forEach((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      dropped.push(describeRejected(index, "is not an object", item));
      return;
    }
    const record = item as Record<string, unknown>;
    const criterion = field(record, "criterion");
    const status = typeof record.status === "string"
      ? record.status.trim().toLowerCase()
      : "";
    if (!criterion) {
      dropped.push(describeRejected(index, "names no criterion", item));
      return;
    }
    if (!VERDICT_STATUSES.includes(status as VerdictStatus)) {
      dropped.push(
        describeRejected(
          index,
          "carries no met/partial/missing/unrequested " +
            "status",
          item,
        ),
      );
      return;
    }
    const evidence = field(record, "evidence");
    const reason = field(record, "reason");
    entries.push({
      criterion,
      status: status as VerdictStatus,
      ...(evidence ? { evidence } : {}),
      ...(reason ? { reason } : {}),
    });
  });
  return entries;
}

/** Parse the `standards` array, collecting what had to be dropped. */
function readStandards(
  raw: unknown[],
  dropped: string[],
): StandardsVerdict[] {
  const entries: StandardsVerdict[] = [];
  capEntries(raw, "standards", dropped).forEach((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      dropped.push(describeRejected(index, "is not an object", item));
      return;
    }
    const record = item as Record<string, unknown>;
    const finding = field(record, "finding");
    const status = typeof record.status === "string"
      ? record.status.trim().toLowerCase()
      : "";
    if (!finding) {
      dropped.push(describeRejected(index, "names no finding", item));
      return;
    }
    if (!STANDARDS_STATUSES.includes(status as StandardsVerdictStatus)) {
      dropped.push(
        describeRejected(index, "carries no violation/clean status", item),
      );
      return;
    }
    const evidence = field(record, "evidence");
    const reason = field(record, "reason");
    entries.push({
      status: status as StandardsVerdictStatus,
      finding,
      ...(evidence ? { evidence } : {}),
      ...(reason ? { reason } : {}),
    });
  });
  return entries;
}

/**
 * Parse the verdict block out of an agent reply.
 *
 * The **last** block is the model's own — an earlier one quoted out of the
 * prompt's own example cannot displace it, the same rule
 * `parseQuorumVerdict` applies to a judge's reply.
 *
 * Fails loud (never defaults): a reply with no block, an unclosed block, or
 * JSON that does not parse into the two arrays is a verdict that was not
 * given, and the caller asks again or lets the gate block stand.
 *
 * @param output - The agent's raw reply text.
 * @returns The verdict, or the reason it could not be read.
 */
export function parseClosureVerdict(output: string): Result<ClosureVerdict> {
  const text = output.slice(0, MAX_VERDICT_CHARS);
  const open = text.lastIndexOf(CLOSURE_VERDICT_OPEN);
  if (open < 0) {
    return {
      ok: false,
      error: new Error(
        `The reply carries no ${CLOSURE_VERDICT_OPEN} block, so no closure ` +
          `verdict was returned.`,
      ),
    };
  }
  const close = text.indexOf(CLOSURE_VERDICT_CLOSE, open);
  if (close < 0) {
    return {
      ok: false,
      error: new Error(
        `The ${CLOSURE_VERDICT_OPEN} block is never closed with ` +
          `${CLOSURE_VERDICT_CLOSE}.`,
      ),
    };
  }

  // Strip a code fence the model may have wrapped the JSON in.
  const body = text
    .slice(open + CLOSURE_VERDICT_OPEN.length, close)
    .split("\n")
    .filter((line) => !/^\s*```/.test(line))
    .join("\n")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `The closure verdict could not be read as JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error: new Error(
        "The closure verdict could not be read: the block holds no JSON " +
          "object with `criteria` and `standards`.",
      ),
    };
  }

  const record = parsed as Record<string, unknown>;
  const rawCriteria = record.criteria;
  if (!Array.isArray(rawCriteria)) {
    return {
      ok: false,
      error: new Error(
        "The closure verdict could not be read: `criteria` is not an array.",
      ),
    };
  }
  const rawStandards = Array.isArray(record.standards) ? record.standards : [];
  const dropped: string[] = [];
  const criteria = readCriteria(rawCriteria, dropped);
  const standards = readStandards(rawStandards, dropped);
  if (!Array.isArray(record.standards)) {
    dropped.push("the verdict carries no `standards` array");
  }

  return { ok: true, value: { criteria, standards, dropped } };
}

/**
 * Judge whether a verdict covers everything the two gates will check.
 *
 * The same rules `validateAcceptanceClosure` and `validateIndependentReview`
 * apply, checked against the *data* before it is rendered — so a short verdict
 * is caught here, where one more question can fix it, rather than after the
 * rendered block has already failed the gate.
 *
 * @param verdict - The parsed verdict.
 * @param criteria - The criteria the issue body states.
 * @returns Whether the verdict is complete, and one line per shortfall.
 */
export function assessVerdictCoverage(
  verdict: ClosureVerdict,
  criteria: readonly string[],
): VerdictCoverage {
  const shortfalls: string[] = [];
  const assessments = verdict.criteria.filter((e) =>
    e.status !== "unrequested"
  );
  // Counted by DISTINCT criterion text: five entries restating criterion one
  // are one criterion judged five times, not five criteria covered.
  const distinct = new Set(
    assessments.map((e) => e.criterion.trim().toLowerCase()),
  );
  if (distinct.size < criteria.length) {
    shortfalls.push(
      `only ${distinct.size} of ${criteria.length} stated acceptance ` +
        `criteria carry a verdict — every criterion needs its own entry, and ` +
        `a criterion you did not touch is \`missing\`, not omitted`,
    );
  }
  for (const entry of verdict.criteria) {
    if (EVIDENCE_REQUIRED.includes(entry.status) && !entry.evidence) {
      shortfalls.push(
        `the \`${entry.status}\` verdict on "${entry.criterion}" names no ` +
          `evidence — give the file, test or test identifier that shows it`,
      );
    }
    if (REASON_REQUIRED.includes(entry.status) && !entry.reason) {
      shortfalls.push(
        `the \`${entry.status}\` verdict on "${entry.criterion}" carries no ` +
          `reason — an unexplained gap is a failure to surface, not a pass`,
      );
    }
  }

  if (verdict.standards.length === 0) {
    shortfalls.push(
      "the verdict states no Standards Review finding — record each " +
        "`violation` the Standards reviewer saw, or the `clean` areas it " +
        "checked and found compliant",
    );
  }
  for (const finding of verdict.standards) {
    if (finding.status !== "violation") continue;
    if (!finding.evidence) {
      shortfalls.push(
        `the \`violation\` "${finding.finding}" names no evidence — give the ` +
          `\`file:line\` the reviewer saw`,
      );
    }
    if (!finding.reason) {
      shortfalls.push(
        `the \`violation\` "${finding.finding}" carries no reason — say ` +
          `whether it was fixed in this diff or why it stands`,
      );
    }
  }

  for (const rejected of verdict.dropped) {
    shortfalls.push(`this entry could not be read: ${rejected}`);
  }

  return { complete: shortfalls.length === 0, shortfalls };
}

/** Stand-in for a field that sanitised away to nothing — never invented text. */
const NO_TEXT = "(the verdict supplied no text here)";

/**
 * Render one Spec entry in the shape both validators accept.
 *
 * Sanitising happens here as well as at the parse, because this is the
 * function that guarantees the shape: a verdict built by any other caller gets
 * the same single-line, label-free text.
 */
function renderCriterionEntry(entry: CriterionVerdict): string {
  const criterion = sanitiseField(entry.criterion) || NO_TEXT;
  const evidence = entry.evidence ? sanitiseField(entry.evidence) : "";
  const reason = entry.reason ? sanitiseField(entry.reason) : "";
  const parts = [`- **${entry.status}** — ${criterion}`];
  if (evidence) parts.push(`evidence: \`${evidence}\``);
  // The reviewer's verdict IS the entry's status — the worker renders what the
  // reviewer said, so there is never a departure to record.
  parts.push(`reviewer: ${entry.status}`);
  if (reason) parts.push(`reason: ${reason}`);
  return parts.join(" — ");
}

/** Render one Standards finding in the shape the validator accepts. */
function renderStandardsEntry(finding: StandardsVerdict): string {
  const text = sanitiseField(finding.finding) || NO_TEXT;
  const evidence = finding.evidence ? sanitiseField(finding.evidence) : "";
  const reason = finding.reason ? sanitiseField(finding.reason) : "";
  const parts = [`- **${finding.status}** — ${text}`];
  if (evidence) parts.push(`evidence: \`${evidence}\``);
  if (reason) parts.push(`reason: ${reason}`);
  return parts.join(" — ");
}

/**
 * Render both review blocks from a verdict.
 *
 * The headings, the provenance markers and the entry shape are the worker's;
 * the statuses, criteria, evidence and reasons are the model's, verbatim but
 * for the sanitising above. Nothing is invented: a verdict short of a
 * criterion renders short, and the gate then blocks on it — which is the fault
 * being reported, not one being papered over.
 *
 * @param verdict - The parsed verdict.
 * @returns The two blocks, ready to append to a PR summary.
 */
export function renderClosureBlocks(verdict: ClosureVerdict): string {
  return [
    "## Acceptance Criteria",
    "",
    '<!-- vibe-spec-review inputs="diff+issue-body" -->',
    "",
    ...verdict.criteria.map(renderCriterionEntry),
    "",
    "## Standards Review",
    "",
    '<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->',
    "",
    ...verdict.standards.map(renderStandardsEntry),
    "",
  ].join("\n");
}

/**
 * A `## Acceptance Criteria` or `## Standards Review` heading, any level,
 * matched against an already-trimmed line with any trailing colon removed.
 *
 * Trimming first is what keeps this linear: the gates' own heading patterns
 * end `\s*:?\s*$`, two adjacent unbounded whitespace quantifiers, and a line
 * of 160k spaces after a matching heading takes seconds to fail. The summary
 * this runs over is agent-authored and steered by an untrusted issue body, so
 * the ambiguity is removed rather than assumed unreachable.
 */
const REVIEW_HEADING_RE =
  /^#{1,6}[ \t]+(?:acceptance[ \t]+criteria|standards[ \t]+review)$/i;

/** Any markdown heading — the section boundary. */
const ANY_HEADING_RE = /^\s{0,3}#{1,6}\s/;

/** Longest line this scans as a candidate heading. */
const MAX_HEADING_CHARS = 200;

/** Whether a summary line opens one of the two review sections. */
function isReviewHeading(line: string): boolean {
  if (line.length > MAX_HEADING_CHARS) return false;
  return REVIEW_HEADING_RE.test(line.trim().replace(/:$/, "").trimEnd());
}

/**
 * Put the rendered blocks into a PR summary, replacing whatever stood there.
 *
 * Both validators read the **first** heading of each name, so a prose
 * `## Acceptance Criteria` left above the rendered one would shadow it and the
 * gate would block on the prose. The old sections are therefore removed, not
 * merely appended past.
 *
 * @param summary - The summary as the agent left it (may be empty).
 * @param blocks - The rendered blocks from {@link renderClosureBlocks}.
 * @returns The summary with exactly one of each review block, at the end.
 */
export function applyClosureBlocks(summary: string, blocks: string): string {
  const kept: string[] = [];
  let skipping = false;
  for (const line of summary.split(/\r?\n/)) {
    if (isReviewHeading(line)) {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (!ANY_HEADING_RE.test(line)) continue;
      skipping = false;
    }
    kept.push(line);
  }

  const body = kept.join("\n").trimEnd();
  return body === "" ? blocks : `${body}\n\n${blocks}`;
}
