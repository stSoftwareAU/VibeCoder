/**
 * Deterministic plan-coverage gate for published planning runs (Issue #520).
 *
 * The critique turn has always been asked to hunt for "**Missing work** — asks
 * in the issue with no sub-issue covering them", but that critique is
 * deliberately never published (`prompts/planning_critique/`), so the coverage
 * judgement left **no artefact**: nobody could see which ask maps to which
 * sub-issue, and nothing failed when an ask was silently dropped. A dropped
 * requirement looked exactly like a complete plan.
 *
 * This module is the enforcement half of the fix, modelled directly on
 * `failure_detection_gate.ts` — the precedent in this repo for turning a prose
 * expectation into a deterministic gate at the single `closePlanningIssue()`
 * chokepoint. The publish turn now posts a **coverage table** on the parent
 * (one row per ask: the ask, the sub-issue(s) covering it, and a note), and
 * this gate rejects any row that names neither a covering sub-issue nor an
 * explicit out-of-scope reason — mirroring how the Failure-Detection gate
 * rejects a bracketed placeholder.
 *
 * **No second escalation path.** An uncovered ask is a plan defect a human must
 * resolve (add the missing sub-issue, or accept the ask as out of scope), so
 * the gate routes through the existing `escalateToHuman()` chokepoint rather
 * than inventing a new label or a new resume pass. It deliberately does **not**
 * borrow `needs-failure-detection-repair`: that label's resume pass re-gates
 * Failure Detection only, so it would find nothing to repair and clear the
 * label — burying the coverage defect it was meant to surface.
 *
 * The pure {@link judgePlanCoverage} takes markdown so it is trivially
 * testable; {@link runPlanCoverageGate} injects the GitHub read so the module
 * never reaches for a global client.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { GitHubClient, Logger } from "../types.ts";
import {
  escalateToHuman,
  type EscalateToHumanDeps,
} from "./needs_human_escalation.ts";

/** One row of the published coverage table. */
export interface CoverageRow {
  /** The ask, drawn from the parent's accepted scope. */
  ask: string;
  /** The "Covered by" cell — sub-issue reference(s) or an out-of-scope marker. */
  coveredBy: string;
  /** The free-text note / reason cell (empty when the column is absent). */
  notes: string;
}

/** An ask row that fails the coverage gate. */
export interface CoverageOffender {
  /** The ask text as published. */
  ask: string;
  /** Human-readable reason the row fails. */
  reason: string;
}

/** Verdict of the coverage gate over one published plan. */
export interface PlanCoverageVerdict {
  /** Whether a coverage table was found at all. */
  tableFound: boolean;
  /** Number of ask rows the table carried. */
  rowCount: number;
  /** Rows that name neither a covering sub-issue nor an out-of-scope reason. */
  offenders: CoverageOffender[];
  /** True only when a table was found, carried rows, and none offended. */
  passed: boolean;
  /** True when the parent could not be read, so coverage is unverifiable. */
  readFailed?: boolean;
}

/** Canonical heading the publish turn writes above the table. */
export const COVERAGE_TABLE_HEADING = "## Plan Coverage";

/**
 * Canonical coverage-table requirement for the in-code fallback publish
 * prompts.
 *
 * Held beside the gate — not beside the prompts — so the instruction and the
 * rule `validateCoverageTable()` actually implements cannot drift apart. The
 * versioned templates under `prompts/planning_critique/` state the same rule in
 * their own words; this constant is what the degraded in-code fallbacks
 * interpolate.
 */
export const COVERAGE_TABLE_REQUIREMENT =
  "Your summary comment on the parent issue must carry a `## Plan Coverage` " +
  "table with the columns `| Ask | Covered by | Notes |` — one row per ask " +
  "in the issue's accepted scope. Put the covering sub-issue reference(s) " +
  "(`#N`) in the `Covered by` cell. An ask you deliberately left out is a row " +
  "too: write `Out of scope` in `Covered by` and the reason in `Notes` — " +
  "never omit the row. A deterministic gate rejects a published plan whose " +
  "table is missing, empty, or carries an ask with no covering sub-issue and " +
  "no out-of-scope reason, so fill every row before you post the comment.";

/** What a human is told to do when the gate fails. */
export const COVERAGE_GATE_NEXT_STEP =
  "Decide, for each ask listed above, whether it needs a sub-issue or is " +
  "genuinely out of scope. Create the missing sub-issue(s) and update the " +
  "`## Plan Coverage` table on this issue, or record the ask as " +
  "`Out of scope` with a reason, then remove the label.";

// A table row line: starts with an optional indent then a pipe.
const ROW_RE = /^\s{0,3}\|/;

// A separator row, e.g. `| --- | :--- | ---: |`.
const SEPARATOR_RE = /^\s{0,3}\|[\s:|-]*-[\s:|-]*\|?\s*$/;

// Header cell that names the ask column.
const ASK_HEADER_RE = /^(ask|asks|requirement|requirements)\b/i;

// Header cell that names the covering sub-issue column.
const COVERED_HEADER_RE = /cover|sub-?issue/i;

// Header cell that names the note column.
const NOTES_HEADER_RE = /note|reason|comment/i;

// A sub-issue reference: `#12` or a full GitHub issue URL.
const ISSUE_REF_RE =
  /(?:#\d+|https?:\/\/github\.com\/[^\s/]+\/[^\s/]+\/issues\/\d+)/;

// The out-of-scope marker the publish turn writes for a deliberately dropped
// ask. Matched in either the covered-by or the notes cell.
const OUT_OF_SCOPE_RE = /\bout[\s-]of[\s-]scope\b/i;

/** Whether a trimmed cell is wholly a bracketed template placeholder. */
function isBracketedPlaceholder(trimmed: string): boolean {
  return /^\[[\s\S]*\]$/.test(trimmed);
}

/** Split one markdown table row into trimmed cells, honouring `\|` escapes. */
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, "|").trim());
}

/**
 * Extract the coverage table from a markdown blob.
 *
 * The table is located by its **header signature** — a column naming the ask
 * and a column naming the covering sub-issue — rather than by the heading
 * above it, so a reworded heading cannot silently hide the table from the gate.
 *
 * @returns The table's rows (possibly empty for a header-only table), or `null`
 *   when the blob carries no coverage table.
 */
export function extractCoverageTable(markdown: string): CoverageRow[] | null {
  const lines = markdown.split(/\r?\n/);

  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]!;
    if (!ROW_RE.test(line) || SEPARATOR_RE.test(line)) continue;
    if (!SEPARATOR_RE.test(lines[i + 1]!)) continue;

    const headers = splitRow(line);
    const askIdx = headers.findIndex((h) => ASK_HEADER_RE.test(h));
    const coveredIdx = headers.findIndex((h) => COVERED_HEADER_RE.test(h));
    if (askIdx < 0 || coveredIdx < 0) continue;
    const notesIdx = headers.findIndex((h) => NOTES_HEADER_RE.test(h));

    const rows: CoverageRow[] = [];
    for (let j = i + 2; j < lines.length; j++) {
      const rowLine = lines[j]!;
      if (!ROW_RE.test(rowLine)) break;
      if (SEPARATOR_RE.test(rowLine)) continue;
      const cells = splitRow(rowLine);
      rows.push({
        ask: cells[askIdx] ?? "",
        coveredBy: cells[coveredIdx] ?? "",
        notes: notesIdx >= 0 ? cells[notesIdx] ?? "" : "",
      });
    }
    return rows;
  }

  return null;
}

/**
 * Whether one of the supplied cells carries a real out-of-scope reason.
 *
 * Each cell is considered on its own so a bracketed placeholder in the notes
 * cannot be rescued by text in the covered-by cell (and vice versa). A cell
 * qualifies when, with the out-of-scope marker and surrounding punctuation
 * removed, it still carries word characters.
 */
function hasOutOfScopeReason(cells: string[]): boolean {
  for (const cell of cells) {
    const trimmed = cell.trim();
    if (trimmed === "" || isBracketedPlaceholder(trimmed)) continue;
    const remainder = trimmed
      .replace(new RegExp(OUT_OF_SCOPE_RE.source, "gi"), " ")
      .replace(/[\s\-—–:.,;()[\]]+/g, " ")
      .trim();
    if (/[\p{L}\p{N}]/u.test(remainder)) return true;
  }
  return false;
}

/**
 * Classify one coverage row.
 *
 * @returns `undefined` when the row is satisfied, otherwise why it fails.
 */
function classifyRow(row: CoverageRow): string | undefined {
  const ask = row.ask.trim();
  if (ask === "" || isBracketedPlaceholder(ask)) {
    return "coverage row has no ask text";
  }

  const coveredBy = row.coveredBy.trim();
  const notes = row.notes.trim();

  if (isBracketedPlaceholder(coveredBy)) {
    return "`Covered by` left as a bracketed template placeholder";
  }
  if (ISSUE_REF_RE.test(coveredBy)) return undefined;

  if (OUT_OF_SCOPE_RE.test(coveredBy) || OUT_OF_SCOPE_RE.test(notes)) {
    return hasOutOfScopeReason([notes, coveredBy])
      ? undefined
      : "marked out of scope with no reason";
  }

  return "no covering sub-issue and no out-of-scope reason";
}

/**
 * Pure gate: return the ask rows that fail the coverage rule.
 *
 * A row passes when its `Covered by` cell names at least one sub-issue (`#N` or
 * a GitHub issue URL), or when the ask is marked `Out of scope` **and** a
 * reason is given. Everything else — an empty cell, `None`, `TBD`, a bracketed
 * placeholder, or a bare `Out of scope` — is an offender.
 */
export function validateCoverageTable(
  rows: CoverageRow[],
): CoverageOffender[] {
  const offenders: CoverageOffender[] = [];
  for (const row of rows) {
    const reason = classifyRow(row);
    if (reason) offenders.push({ ask: row.ask.trim(), reason });
  }
  return offenders;
}

/**
 * Judge one markdown blob (a parent comment or the parent body) for coverage.
 *
 * A missing table is a **failure**, not a pass: the absence of the artefact is
 * exactly the silent escape this gate exists to close.
 */
export function judgePlanCoverage(markdown: string): PlanCoverageVerdict {
  const rows = extractCoverageTable(markdown);
  if (rows === null) {
    return { tableFound: false, rowCount: 0, offenders: [], passed: false };
  }
  const offenders = validateCoverageTable(rows);
  return {
    tableFound: true,
    rowCount: rows.length,
    offenders,
    passed: rows.length > 0 && offenders.length === 0,
  };
}

/** Parent issue payload the gate reads. */
interface ParentPayload {
  body?: string;
  comments?: Array<{ body?: string }>;
}

/**
 * Fetch the planning parent and judge the coverage table it carries.
 *
 * The publish turn posts the table in its summary comment, so comments are
 * scanned **newest first** (a re-published table supersedes an earlier one) and
 * the parent body is the final fallback. A read failure fails the gate with
 * `readFailed` set — coverage that cannot be verified is not coverage that
 * passed.
 */
export async function runPlanCoverageGate(opts: {
  repo: string;
  parentIssueNumber: number;
  ghCommandFn: (args: string[]) => Promise<string>;
  logger: Pick<Logger, "info" | "warn">;
}): Promise<PlanCoverageVerdict> {
  const { repo, parentIssueNumber, ghCommandFn, logger } = opts;

  let payload: ParentPayload;
  try {
    const raw = await ghCommandFn([
      "issue",
      "view",
      String(parentIssueNumber),
      "--repo",
      repo,
      "--json",
      "body,comments",
    ]);
    payload = JSON.parse(raw) as ParentPayload;
  } catch (err) {
    logger.warn(
      "Plan-coverage gate: could not read the planning parent — coverage is unverified (Issue #520)",
      {
        repo,
        issueNumber: parentIssueNumber,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return {
      tableFound: false,
      rowCount: 0,
      offenders: [],
      passed: false,
      readFailed: true,
    };
  }

  const candidates = [
    ...(payload.comments ?? []).map((c) => c.body ?? "").reverse(),
    payload.body ?? "",
  ];

  for (const candidate of candidates) {
    if (candidate.trim() === "") continue;
    const verdict = judgePlanCoverage(candidate);
    if (verdict.tableFound) return verdict;
  }

  return { tableFound: false, rowCount: 0, offenders: [], passed: false };
}

/**
 * A short label for **which** coverage failure occurred (Issue #859).
 *
 * The escalation comment has always been accurate — `buildCoverageGateReason`
 * branches on the four outcomes. The operator-facing log line did not: it
 * asserted "the published plan does not account for every ask" for all of
 * them, including the case where no table was posted at all. The
 * accompanying fields then contradicted it (`tableFound=false asks=0
 * uncovered=`), which reads as a false positive and costs the reader a code
 * dive to disprove.
 */
export function summariseCoverageGateFailure(
  verdict: PlanCoverageVerdict,
): string {
  if (verdict.readFailed) {
    return "the planning parent could not be read, so coverage is unverified";
  }
  if (!verdict.tableFound) {
    return "no `## Plan Coverage` table was posted";
  }
  if (verdict.rowCount === 0) {
    return "the `## Plan Coverage` table carries no ask rows";
  }
  const n = verdict.offenders.length;
  return `${n} ask${n === 1 ? "" : "s"} name neither a covering sub-issue ` +
    "nor an out-of-scope reason";
}

/**
 * Build the `**Why:**` line for the escalation comment — the rule, then every
 * offending ask and why it fails.
 */
export function buildCoverageGateReason(verdict: PlanCoverageVerdict): string {
  if (verdict.readFailed) {
    return "this planning run published sub-issues, but the parent issue could " +
      "not be read, so its `## Plan Coverage` table could not be checked. An " +
      "ask may have been dropped without anyone seeing it.";
  }
  if (!verdict.tableFound) {
    return "this planning run published sub-issues but posted **no coverage " +
      "table** on this issue, so there is no artefact showing which ask each " +
      "sub-issue satisfies — a dropped ask would look exactly like a complete " +
      "plan.";
  }
  if (verdict.rowCount === 0) {
    return "this planning run published a `## Plan Coverage` table with **no " +
      "ask rows**, so no ask in the issue's accepted scope is traceable to a " +
      "sub-issue.";
  }
  const lines = verdict.offenders
    .map((o) => `- ${o.ask} — ${o.reason}`)
    .join("\n");
  return [
    "every ask in the published `## Plan Coverage` table must name a covering " +
    "sub-issue or an explicit out-of-scope reason. The following ask(s) do " +
    "not:",
    "",
    lines,
  ].join("\n");
}

/**
 * Hand an uncovered ask to a human through the shared escalation chokepoint.
 *
 * Deliberately reuses `escalateToHuman()` — the repo's single needs-human
 * chokepoint, which enforces the paired label + explanation comment and dedups
 * repeat escalations within 24 hours — instead of adding a second escalation
 * path for coverage.
 *
 * @returns Whether the escalation landed (label or comment).
 */
export async function escalateUncoveredAsks(opts: {
  ghClient: GitHubClient;
  repo: string;
  parentIssueNumber: number;
  needsHumanLabel: string;
  verdict: PlanCoverageVerdict;
  githubUser?: string;
  logger: Logger;
  deps?: EscalateToHumanDeps;
}): Promise<boolean> {
  const {
    ghClient,
    repo,
    parentIssueNumber,
    needsHumanLabel,
    verdict,
    githubUser,
    logger,
    deps,
  } = opts;

  const result = await escalateToHuman({
    ghClient,
    repo,
    target: { kind: "issue", number: parentIssueNumber },
    needsHumanLabel,
    heading: "Plan coverage gate",
    reason: buildCoverageGateReason(verdict),
    nextStep: COVERAGE_GATE_NEXT_STEP,
    dedupKey: `plan-coverage-${parentIssueNumber}`,
    ...(githubUser ? { githubUser } : {}),
    ...(deps ? { deps } : {}),
    logger,
  });

  if (!result.ok) {
    logger.error(
      "Plan-coverage gate: failed to escalate the uncovered ask(s) to a human (Issue #520)",
      { repo, issueNumber: parentIssueNumber, error: result.error.message },
    );
    return false;
  }
  return result.value.labelAdded || result.value.commentPosted;
}
