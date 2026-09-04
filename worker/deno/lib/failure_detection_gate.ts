/**
 * Deterministic Failure-Detection presence gate for published planning
 * sub-issues (Issue #3246).
 *
 * The planning prompt (from `prompts/planning/prompt.md`, Issue #3245) instructs
 * the planner to emit a `## Failure Detection` section in every sub-issue body.
 * A prose rule alone is a "quality escape": the planner can silently omit it and
 * nothing catches the miss. This module closes that escape with a deterministic
 * presence gate — modelled on `screenshot_validation.ts`, the analogous gate on
 * PR output — that verifies every published sub-issue body carries a filled
 * `## Failure Detection` section and reports the offenders when one does not.
 *
 * The caller (planning_processor.ts) never lets a reported offender pass
 * silently. Since Issue #59 the response depends on what the run achieved: a
 * run that published no sub-issues at all still drives the loud
 * `handlePlanningFailure` path, while a run that published a usable plan but
 * could not repair every sub-issue is a *partial repair* — the parent is
 * labelled `needs-failure-detection-repair` (see
 * `failure_detection_repair_label.ts`) and commented on, not failed. At runtime
 * this gate IS the failure-detection surface for the planner.
 *
 * The pure {@link validateFailureDetectionCriteria} takes already-fetched
 * bodies so it is trivially testable; {@link runFailureDetectionGate} injects
 * the GitHub read so the module never reaches for a global client.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger } from "../types.ts";

/** A published sub-issue whose body the gate inspects. */
export interface SubIssueForGate {
  number: number;
  title: string;
  body: string;
}

/** A sub-issue that failed the Failure-Detection presence gate. */
export interface FailureDetectionOffender {
  number: number;
  title: string;
  /** Human-readable reason naming the missing-criterion mode. */
  reason: string;
}

/** Minimal logger surface the gate needs — a subset of {@link Logger}. */
export type GateLogger = Pick<Logger, "info" | "warn">;

// A markdown heading line reading "Failure Detection" (any heading level).
const HEADING_RE = /^\s{0,3}#{1,6}\s+failure\s+detection\s*:?\s*$/i;

// A bolded inline label, e.g. "**Failure detection:** A new test ...".
const BOLD_LABEL_RE =
  /^\s{0,3}\*\*\s*failure\s+detection\s*:?\s*\*\*\s*:?\s*(.*)$/i;

// Any markdown heading — used as the section boundary.
const ANY_HEADING_RE = /^\s{0,3}#{1,6}\s+/;

/**
 * Extract the `## Failure Detection` section content from a sub-issue body.
 *
 * Recognises two shapes:
 *   - a markdown heading (`## Failure Detection`) whose content is every line up
 *     to the next markdown heading, and
 *   - a bolded inline label (`**Failure detection:** ...`) whose content is the
 *     remainder of that line plus following lines up to the next blank line,
 *     heading, or bold label.
 *
 * @returns `{ found: false }` when no section is present, otherwise the raw
 *   section content (un-trimmed).
 */
function extractSection(
  body: string,
): { found: false } | { found: true; content: string } {
  const lines = body.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (HEADING_RE.test(line)) {
      const collected: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (ANY_HEADING_RE.test(lines[j]!)) break;
        collected.push(lines[j]!);
      }
      return { found: true, content: collected.join("\n") };
    }

    const boldMatch = line.match(BOLD_LABEL_RE);
    if (boldMatch) {
      const collected: string[] = [boldMatch[1] ?? ""];
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j]!;
        if (
          next.trim() === "" || ANY_HEADING_RE.test(next) ||
          BOLD_LABEL_RE.test(next)
        ) {
          break;
        }
        collected.push(next);
      }
      return { found: true, content: collected.join("\n") };
    }
  }

  return { found: false };
}

/**
 * Whether the trimmed section content is the bracketed template placeholder.
 *
 * The v19 template leaves the section as a single `[...]` block; a sub-issue
 * that still carries that block has not filled in a real criterion. Any content
 * that is not wholly bracket-delimited (a real criterion, or an `N/A — <reason>`
 * line) is treated as filled.
 */
function isBracketedPlaceholder(trimmed: string): boolean {
  return /^\[[\s\S]*\]$/.test(trimmed);
}

/**
 * Classify a sub-issue body against the Failure-Detection presence rule.
 *
 * @returns `undefined` when the body carries a filled criterion, otherwise the
 *   reason it fails the gate.
 */
function classifyBody(body: string): string | undefined {
  const section = extractSection(body);
  if (!section.found) {
    return "missing `## Failure Detection` section";
  }

  const trimmed = section.content.trim();
  if (trimmed === "") {
    return "empty `## Failure Detection` section";
  }
  if (isBracketedPlaceholder(trimmed)) {
    return "`## Failure Detection` left as the bracketed template placeholder";
  }
  return undefined;
}

/**
 * Pure gate: return the sub-issues whose body lacks a filled
 * `## Failure Detection` section.
 *
 * A body passes when it contains a `## Failure Detection` heading (or a bolded
 * `**Failure detection:**` line) followed by non-whitespace content that is not
 * the bracketed template placeholder. An `N/A — <reason>` line counts as filled
 * (docs-only / prompt-only work).
 *
 * @param subIssues - Published sub-issues with their fetched bodies.
 * @returns Offenders in input order (empty when every body carries the section).
 */
export function validateFailureDetectionCriteria(
  subIssues: SubIssueForGate[],
): FailureDetectionOffender[] {
  const offenders: FailureDetectionOffender[] = [];
  for (const sub of subIssues) {
    const reason = classifyBody(sub.body);
    if (reason) {
      offenders.push({ number: sub.number, title: sub.title, reason });
    }
  }
  return offenders;
}

/**
 * Fetch a single sub-issue's title and body for the gate.
 *
 * Best-effort: returns `null` on any failure so an unreadable sub-issue is
 * skipped rather than mis-reported as a missing-criterion offender (a transient
 * read error must not manufacture a false planning failure).
 */
export async function fetchSubIssueForGate(
  repo: string,
  issueNumber: number,
  ghCommandFn: (args: string[]) => Promise<string>,
  logger: GateLogger,
): Promise<SubIssueForGate | null> {
  try {
    const raw = await ghCommandFn([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repo,
      "--json",
      "number,title,body",
    ]);
    const parsed = JSON.parse(raw) as {
      number?: number;
      title?: string;
      body?: string;
    };
    return {
      number: typeof parsed.number === "number" ? parsed.number : issueNumber,
      title: typeof parsed.title === "string" ? parsed.title : "",
      body: typeof parsed.body === "string" ? parsed.body : "",
    };
  } catch (err) {
    logger.warn(
      "Failure-Detection gate: could not read sub-issue body — skipping (non-fatal)",
      {
        repo,
        issueNumber,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return null;
  }
}

/**
 * Fetch each published sub-issue's body and run the presence gate.
 *
 * The GitHub read is injected (`ghCommandFn`), so the whole path is unit-tested
 * without a network. An empty `subIssueNumbers` makes no calls and returns no
 * offenders — a planning run with zero sub-issues has nothing to gate.
 */
export async function runFailureDetectionGate(opts: {
  repo: string;
  subIssueNumbers: number[];
  ghCommandFn: (args: string[]) => Promise<string>;
  logger: GateLogger;
}): Promise<FailureDetectionOffender[]> {
  const { repo, subIssueNumbers, ghCommandFn, logger } = opts;
  if (subIssueNumbers.length === 0) return [];

  const subIssues: SubIssueForGate[] = [];
  for (const number of subIssueNumbers) {
    const sub = await fetchSubIssueForGate(repo, number, ghCommandFn, logger);
    if (sub) subIssues.push(sub);
  }

  return validateFailureDetectionCriteria(subIssues);
}

/**
 * The shared body of both parent comments: the rule, then the offender list
 * naming each sub-issue and why it fails.
 *
 * Kept in one place (Issue #59) so the failure wording and the partial-repair
 * wording cannot drift; each caller supplies only its own closing instruction.
 */
function buildParentOffenderBody(
  offenders: FailureDetectionOffender[],
): string {
  const lines = offenders
    .map((o) => `- #${o.number} (${o.title}) — ${o.reason}`)
    .join("\n");
  return [
    "every published sub-issue must carry a non-empty `## Failure Detection` " +
    "section (a concrete test / CI gate / alert, or an explicit " +
    "`N/A — <reason>`). The following sub-issue(s) do not:",
    "",
    lines,
  ].join("\n");
}

/**
 * Build the parent-issue failure message naming every offending sub-issue and
 * the missing-criterion reason for each.
 *
 * Returned without a leading heading so it reads correctly when the caller
 * passes it through the shared planning-failure handler (which prepends
 * "Planning failed: ").
 *
 * Since Issue #59 the planning run itself no longer fails on unresolved
 * offenders — it takes the partial-repair path below. This wording stays as the
 * gate's canonical *failure* text for the callers that do fail a run outright
 * (the resume pass's bounded-retry escalation, #60).
 */
export function buildParentGateFailureComment(
  offenders: FailureDetectionOffender[],
): string {
  return [
    buildParentOffenderBody(offenders),
    "",
    "Fix each sub-issue's `## Failure Detection` section, then re-run planning.",
  ].join("\n");
}

/**
 * Build the parent-issue comment for a **partial repair** (Issue #59).
 *
 * A run that published its sub-issues and repaired only some of them is not a
 * planning failure — the plan is published and usable — so this comment
 * replaces the failure comment on that path. It names exactly which sub-issues
 * still need repair and why, then states the recovery: finish those repairs,
 * not re-run planning.
 *
 * Extends {@link buildParentGateFailureComment}'s wording via the shared
 * offender body, so the rule is stated identically on both paths.
 *
 * @param offenders - Sub-issues still lacking a filled criterion.
 * @param repairLabel - The label applied to the parent to mark the outstanding
 *   repairs, named in the comment so the state is self-describing.
 */
export function buildParentPartialRepairComment(
  offenders: FailureDetectionOffender[],
  repairLabel: string,
): string {
  return [
    "⚠️ **Partial Failure-Detection repair.** This planning run published its " +
    "sub-issues successfully, so it is **not** a failed planning run and the " +
    "parent is not marked `failed-once` — but " +
    buildParentOffenderBody(offenders),
    "",
    `The parent carries the \`${repairLabel}\` label so a later pass can ` +
    "finish the outstanding repairs. The recovery is to repair the sub-issues " +
    "named above (by hand, or by the resume pass) — not to re-run planning.",
  ].join("\n");
}

/**
 * Build the short comment posted on an offending sub-issue so the signal is
 * actionable at the sub-issue, not only on the parent.
 */
export function buildSubIssueGateComment(
  offender: FailureDetectionOffender,
): string {
  return [
    "⚠️ This sub-issue is missing its `## Failure Detection` criterion " +
    `(${offender.reason}).`,
    "",
    "Add a `## Failure Detection` section stating how a regression in this " +
    "work is detected — prefer an automated test or a CI quality gate. If " +
    "this work has no runtime failure surface (docs-only / prompt-only), " +
    "write `N/A — <one-line reason>`.",
  ].join("\n");
}
