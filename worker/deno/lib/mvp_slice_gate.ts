/**
 * Deterministic MVP-slice gate for published planning runs (Issue #522).
 *
 * The planner drafts sub-issues "in implementation order with explicit
 * dependencies" — that is *technical* ordering. Nothing ordered by **value**,
 * and nothing stated whether landing only the first sub-issue leaves the repo
 * better off. A milestone can stop part-way (a run times out, a human pauses
 * it, the backlog shifts), and a half-finished plan then delivers whatever the
 * dependency graph happened to unblock first — possibly nothing usable.
 *
 * Adopted from GitHub spec-kit's spec template, where every user story is
 * prioritised and must be independently testable ("if you implement just ONE of
 * them, you should still have a viable MVP"). Here that costs the planner one
 * marker on the sub-issue list it already publishes: exactly one entry carries
 * `**MVP slice**` plus a sentence saying what value lands if nothing after it is
 * built — or, where genuinely nothing is deliverable alone (a pure refactor, a
 * mechanical migration), the plan says so with an explicit
 * `No independently valuable slice — <reason>` line rather than silently
 * omitting the marker.
 *
 * Modelled directly on `plan_coverage_gate.ts` (Issue #520): the same published
 * summary comment, the same single `closePlanningIssue()` chokepoint, and the
 * same `escalateToHuman()` outcome — no new comment type, no new label, no
 * second escalation path.
 *
 * The gate also enforces the ordering rule the value ordering must not break:
 * **value ordering never reorders across a `Depends on` edge**. A sub-issue
 * listed before one it depends on is an offender, and so is a sub-issue listed
 * before the MVP slice that is not a prerequisite of it.
 *
 * The pure {@link judgeMvpSlice} takes markdown so it is trivially testable;
 * {@link runMvpSliceGate} injects the GitHub read so the module never reaches
 * for a global client.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { GitHubClient, Logger } from "../types.ts";
import {
  escalateToHuman,
  type EscalateToHumanDeps,
} from "./needs_human_escalation.ts";

/** One sub-issue entry parsed from the published plan list. */
export interface PlanEntry {
  /** The sub-issue number, when the entry names one. */
  number?: number;
  /** The entry line, minus its list marker — used in offender messages. */
  text: string;
  /** Sub-issue numbers this entry records a `Depends on #N` edge to. */
  dependsOn: number[];
  /** Whether the entry carries the MVP marker. */
  isMvp: boolean;
  /** The value statement written after the marker (empty when absent). */
  valueStatement: string;
}

/** A single way a published plan fails the MVP-slice rule. */
export interface MvpSliceOffender {
  /** The entry (or the plan) the offence belongs to. */
  subject: string;
  /** Human-readable reason it fails. */
  reason: string;
}

/** Verdict of the MVP-slice gate over one published plan. */
export interface MvpSliceVerdict {
  /** Whether a numbered sub-issue list was found at all. */
  listFound: boolean;
  /** Entries parsed from that list. */
  entries: PlanEntry[];
  /** How many entries carry the MVP marker. */
  markerCount: number;
  /** The reason given on an explicit no-slice line, when present. */
  noSliceReason?: string;
  /** Everything that fails the rule. */
  offenders: MvpSliceOffender[];
  /** True only when the plan names one MVP slice (or an explicit no-slice
   * reason) and nothing offends. */
  passed: boolean;
  /** True when the parent could not be read, so the slice is unverifiable. */
  readFailed?: boolean;
}

/**
 * Canonical MVP-slice requirement for the in-code fallback publish prompts.
 *
 * Held beside the gate — not beside the prompts — so the instruction and the
 * rule {@link judgeMvpSlice} actually implements cannot drift apart. The
 * versioned templates under `prompts/planning_critique/` state the same rule in
 * their own words; this constant is what the degraded in-code fallbacks
 * interpolate.
 */
export const MVP_SLICE_REQUIREMENT =
  "In that summary comment, mark exactly one sub-issue in the numbered list " +
  "with `**MVP slice**` followed by one sentence saying what value lands if " +
  "nothing after it is ever built. Order the list MVP-first, except that a " +
  "sub-issue never precedes one it `Depends on #N` — value ordering must not " +
  "override a real dependency edge. Where nothing in the plan is " +
  "independently valuable (a pure refactor, a mechanical migration), write " +
  "the line `No independently valuable slice — <reason>` instead of marking " +
  "one. A deterministic gate rejects a published plan that carries no marker " +
  "and no such line, more than one marker, or a sub-issue listed before its " +
  "prerequisite.";

/** What a human is told to do when the gate fails. */
export const MVP_SLICE_GATE_NEXT_STEP =
  "Decide which sub-issue is the MVP slice — the one whose landing alone " +
  "leaves the repo better off — and edit the plan summary comment so exactly " +
  "one entry carries `**MVP slice**` and a sentence saying what value it " +
  "delivers on its own, with the list ordered MVP-first inside the " +
  "`Depends on` edges. If no slice is independently valuable, say so with a " +
  "`No independently valuable slice — <reason>` line instead, then remove the " +
  "label.";

// A numbered list entry: `1. …`, `2) …`, optionally indented.
const LIST_ITEM_RE = /^\s{0,3}(\d+)[.)]\s+(.*)$/;

// A sub-issue reference: `#12` or a full GitHub issue URL.
const ISSUE_REF_RE =
  /#(\d+)|https?:\/\/github\.com\/[^\s/]+\/[^\s/]+\/issues\/(\d+)/;

// The MVP marker, in either bold spelling, tolerant of inner whitespace.
const MVP_MARKER_RE = /(\*\*|__)\s*MVP slice\s*\1/i;

// The explicit "nothing here is independently valuable" line, with its reason.
const NO_SLICE_RE = /no independently valuable slice\s*(?:[—–:-]|,)\s*(.*)/i;

// Placeholder text that never counts as a real value statement.
const PLACEHOLDER_VALUE_RE = /^(tbd|todo|n\/?a|none|unknown|\?+)\b/i;

/**
 * Whether a trimmed string is wholly a template placeholder — the `[...]` shape
 * the sub-issue templates use, or the `<...>` shape this gate's own
 * instructions use for the no-slice reason.
 */
function isBracketedPlaceholder(trimmed: string): boolean {
  return /^\[[\s\S]*\]$/.test(trimmed) || /^<[^<>]*>$/.test(trimmed);
}

/** The first sub-issue number a line references, if any. */
function extractIssueNumber(text: string): number | undefined {
  const match = ISSUE_REF_RE.exec(text);
  if (!match) return undefined;
  const raw = match[1] ?? match[2];
  return raw ? Number(raw) : undefined;
}

/**
 * Collect the sub-issue numbers a `Depends on …` phrase names.
 *
 * Scanning stops at the first token that is neither a reference nor a
 * separator, so `depends on #101 (cache)` yields `[101]` and never swallows an
 * unrelated number later on the line.
 */
function extractDependsOn(text: string): number[] {
  const numbers: number[] = [];
  const phrase = /\bdepends?\s+on\b/gi;
  let match: RegExpExecArray | null;
  while ((match = phrase.exec(text)) !== null) {
    let rest = text.slice(match.index + match[0].length);
    for (;;) {
      const ref = /^[\s,&]*(?:and\s+)?#(\d+)/.exec(rest);
      if (!ref) break;
      numbers.push(Number(ref[1]));
      rest = rest.slice(ref[0].length);
    }
  }
  return [...new Set(numbers)];
}

/** The value statement written after the MVP marker on the same line. */
function extractValueStatement(text: string): string {
  const marker = MVP_MARKER_RE.exec(text);
  if (!marker) return "";
  return text
    .slice(marker.index + marker[0].length)
    .replace(/^[\s—–:,.-]+/, "")
    .trim();
}

/**
 * Parse the published sub-issue list out of a plan summary comment.
 *
 * Entries are located by their **shape** — a numbered list item naming a
 * sub-issue — rather than by the heading above them, so a reworded heading
 * cannot hide the plan from the gate. The longest run of consecutive numbered
 * items that name sub-issues wins, so an unrelated numbered list elsewhere in
 * the comment cannot displace the plan.
 */
export function extractPlanEntries(markdown: string): PlanEntry[] {
  const lines = markdown.split(/\r?\n/);
  let best: PlanEntry[] = [];
  let current: PlanEntry[] = [];

  const flush = () => {
    if (current.length > best.length) best = current;
    current = [];
  };

  for (const line of lines) {
    const item = LIST_ITEM_RE.exec(line);
    if (!item) {
      // A blank line inside a list is normal spacing; anything else ends it.
      if (line.trim() === "") continue;
      flush();
      continue;
    }
    const text = item[2]!.trim();
    const number = extractIssueNumber(text);
    if (number === undefined) {
      flush();
      continue;
    }
    current.push({
      number,
      text,
      dependsOn: extractDependsOn(text).filter((n) => n !== number),
      isMvp: MVP_MARKER_RE.test(text),
      valueStatement: extractValueStatement(text),
    });
  }
  flush();

  return best;
}

/** Short label for an entry in an offender message. */
function labelOf(entry: PlanEntry): string {
  return entry.number !== undefined ? `#${entry.number}` : entry.text;
}

/** Every entry index reachable from `start` by following `Depends on` edges. */
function prerequisiteIndices(
  entries: PlanEntry[],
  start: number,
): Set<number> {
  const byNumber = new Map<number, number>();
  entries.forEach((entry, index) => {
    if (entry.number !== undefined && !byNumber.has(entry.number)) {
      byNumber.set(entry.number, index);
    }
  });

  const reached = new Set<number>();
  const queue = [start];
  while (queue.length > 0) {
    const index = queue.pop()!;
    for (const dep of entries[index]!.dependsOn) {
      const depIndex = byNumber.get(dep);
      if (depIndex === undefined || reached.has(depIndex)) continue;
      reached.add(depIndex);
      queue.push(depIndex);
    }
  }
  return reached;
}

/**
 * Pure ordering check: value ordering must never reorder across a real
 * `Depends on` edge, and nothing unrelated may sit ahead of the MVP slice.
 *
 * @returns The offending entries, empty when the order holds.
 */
export function validatePlanOrder(entries: PlanEntry[]): MvpSliceOffender[] {
  const offenders: MvpSliceOffender[] = [];

  const positionOf = new Map<number, number>();
  entries.forEach((entry, index) => {
    if (entry.number !== undefined && !positionOf.has(entry.number)) {
      positionOf.set(entry.number, index);
    }
  });

  entries.forEach((entry, index) => {
    for (const dep of entry.dependsOn) {
      const depIndex = positionOf.get(dep);
      if (depIndex !== undefined && depIndex > index) {
        offenders.push({
          subject: labelOf(entry),
          reason:
            `listed before #${dep}, which it depends on — value ordering must ` +
            "not reorder across a `Depends on` edge",
        });
      }
    }
  });

  const mvpIndex = entries.findIndex((entry) => entry.isMvp);
  if (mvpIndex > 0) {
    const prerequisites = prerequisiteIndices(entries, mvpIndex);
    for (let i = 0; i < mvpIndex; i++) {
      if (prerequisites.has(i)) continue;
      offenders.push({
        subject: labelOf(entries[i]!),
        reason:
          "listed before the MVP slice without being a prerequisite of it — " +
          "the plan is not ordered MVP-first",
      });
    }
  }

  return offenders;
}

/**
 * Judge one markdown blob (a parent comment or the parent body) for its MVP
 * slice.
 *
 * A plan with **no** marker and **no** explicit no-slice line is a failure, not
 * a pass: the absence of the statement is exactly the silent escape this gate
 * exists to close.
 */
export function judgeMvpSlice(markdown: string): MvpSliceVerdict {
  const entries = extractPlanEntries(markdown);
  const listFound = entries.length > 0;
  const markerCount = entries.filter((entry) => entry.isMvp).length;

  const noSliceMatch = NO_SLICE_RE.exec(markdown);
  const noSliceReasonRaw = noSliceMatch ? (noSliceMatch[1] ?? "").trim() : "";
  const noSliceDeclared = noSliceMatch !== null;
  // A real reason never *starts* with a template placeholder, so `<reason>` —
  // the shape the instructions themselves use — never counts as one.
  const noSliceReasonGiven = noSliceDeclared &&
    noSliceReasonRaw !== "" &&
    !isBracketedPlaceholder(noSliceReasonRaw) &&
    !/^[<[][^>\]]*[>\]]/.test(noSliceReasonRaw) &&
    /[\p{L}\p{N}]/u.test(noSliceReasonRaw);

  const offenders: MvpSliceOffender[] = [];

  if (!listFound) {
    offenders.push({
      subject: "the plan",
      reason:
        "no published sub-issue list was found, so no MVP slice can be named",
    });
  }

  if (noSliceDeclared && markerCount > 0) {
    offenders.push({
      subject: "the plan",
      reason:
        "claims no independently valuable slice exists *and* marks one — the " +
        "two statements contradict each other",
    });
  } else if (noSliceDeclared) {
    if (!noSliceReasonGiven) {
      offenders.push({
        subject: "the plan",
        reason: "declares no independently valuable slice but gives no reason",
      });
    }
  } else if (markerCount === 0) {
    offenders.push({
      subject: "the plan",
      reason: "names no `**MVP slice**` and carries no " +
        "`No independently valuable slice — <reason>` line, so nothing says " +
        "what lands if the plan stops part-way",
    });
  } else if (markerCount > 1) {
    offenders.push({
      subject: "the plan",
      reason:
        `marks ${markerCount} sub-issues as the MVP slice — exactly one slice ` +
        "is the whole point of naming it",
    });
  }

  for (const entry of entries) {
    if (!entry.isMvp) continue;
    const value = entry.valueStatement;
    if (
      value === "" || isBracketedPlaceholder(value) ||
      PLACEHOLDER_VALUE_RE.test(value) || !/[\p{L}\p{N}]/u.test(value)
    ) {
      offenders.push({
        subject: labelOf(entry),
        reason:
          "marked as the MVP slice with no statement of what value lands if " +
          "nothing after it is built",
      });
    }
  }

  offenders.push(...validatePlanOrder(entries));

  return {
    listFound,
    entries,
    markerCount,
    ...(noSliceReasonGiven ? { noSliceReason: noSliceReasonRaw } : {}),
    offenders,
    passed: offenders.length === 0,
  };
}

/** Parent issue payload the gate reads. */
interface ParentPayload {
  body?: string;
  comments?: Array<{ body?: string }>;
}

/**
 * Fetch the planning parent and judge the MVP slice its plan summary names.
 *
 * The publish turn posts the sub-issue list in its summary comment, so comments
 * are scanned **newest first** (a re-published plan supersedes an earlier one)
 * and the parent body is the final fallback. A read failure fails the gate with
 * `readFailed` set — a slice that cannot be verified is not a slice that
 * passed.
 */
export async function runMvpSliceGate(opts: {
  repo: string;
  parentIssueNumber: number;
  ghCommandFn: (args: string[]) => Promise<string>;
  logger: Pick<Logger, "info" | "warn">;
}): Promise<MvpSliceVerdict> {
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
      "MVP-slice gate: could not read the planning parent — the MVP slice is unverified (Issue #522)",
      {
        repo,
        issueNumber: parentIssueNumber,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return {
      listFound: false,
      entries: [],
      markerCount: 0,
      offenders: [{
        subject: "the plan",
        reason: "the planning parent could not be read",
      }],
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
    const verdict = judgeMvpSlice(candidate);
    if (verdict.listFound) return verdict;
  }

  return {
    listFound: false,
    entries: [],
    markerCount: 0,
    offenders: [{
      subject: "the plan",
      reason:
        "no published sub-issue list was found, so no MVP slice can be named",
    }],
    passed: false,
  };
}

/**
 * Build the `**Why:**` line for the escalation comment — the rule, then every
 * offence and why it fails.
 */
export function buildMvpSliceGateReason(verdict: MvpSliceVerdict): string {
  if (verdict.readFailed) {
    return "this planning run published sub-issues, but the parent issue could " +
      "not be read, so the plan's MVP slice could not be checked. The plan may " +
      "deliver nothing usable if it stops part-way.";
  }
  const lines = verdict.offenders
    .map((o) => `- ${o.subject} — ${o.reason}`)
    .join("\n");
  return [
    "a published plan must name exactly one `**MVP slice**` — the sub-issue " +
    "whose landing alone leaves the repo better off — or state plainly that " +
    "no slice is independently valuable, and it must stay ordered MVP-first " +
    "inside its `Depends on` edges. This plan does not:",
    "",
    lines,
  ].join("\n");
}

/**
 * Hand a plan with no named MVP slice to a human through the shared escalation
 * chokepoint.
 *
 * Deliberately reuses `escalateToHuman()` — the repo's single needs-human
 * chokepoint, which enforces the paired label + explanation comment and dedups
 * repeat escalations within 24 hours — instead of adding a second escalation
 * path for value ordering.
 *
 * @returns Whether the escalation landed (label or comment).
 */
export async function escalateMissingMvpSlice(opts: {
  ghClient: GitHubClient;
  repo: string;
  parentIssueNumber: number;
  needsHumanLabel: string;
  verdict: MvpSliceVerdict;
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
    heading: "MVP-slice gate",
    reason: buildMvpSliceGateReason(verdict),
    nextStep: MVP_SLICE_GATE_NEXT_STEP,
    dedupKey: `mvp-slice-${parentIssueNumber}`,
    ...(githubUser ? { githubUser } : {}),
    ...(deps ? { deps } : {}),
    logger,
  });

  if (!result.ok) {
    logger.error(
      "MVP-slice gate: failed to escalate the unnamed MVP slice to a human (Issue #522)",
      { repo, issueNumber: parentIssueNumber, error: result.error.message },
    );
    return false;
  }
  return result.value.labelAdded || result.value.commentPosted;
}
