/**
 * Deterministic structural gate on the `## Milestones` table a planning run
 * publishes (Issue #2172, part of #2163).
 *
 * A planning run now groups its sub-issues by **file area** so the fleet can
 * work several milestones in parallel without landing in merge hell. The
 * publish turn records that grouping as a `## Milestones` table on the parent
 * — one row per group, naming the milestone, the file area and the group's
 * sub-issues — and this module is the enforcement half, modelled directly on
 * `plan_coverage_gate.ts`: a pure parser and validator that a single wiring
 * point in `planning_processor.ts` drives.
 *
 * **Structure only.** The gate rules on what can be checked deterministically:
 * a published sub-issue in no group or in two, a group that names no file
 * area, and the four-milestone cap. Whether two groups touch the same file is
 * **never** checked — the accepted scope of #2163 makes file overlap planner
 * judgement, and a gate that guessed at it would reject sound plans.
 *
 * **No table is not a failure.** The prompts teach the table (#2174), but a
 * degraded run, an operator's own planning template or a plan published before
 * that landed may carry none — so a parent with no `## Milestones` table takes
 * the legacy path — one milestone for the whole plan, exactly as today. A
 * table that is present but structurally broken *is* a failure: it escalates through the
 * shared `escalateToHuman()` chokepoint, and the caller still creates the
 * legacy single milestone so overnight delivery keeps working while a human
 * regroups.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { GitHubClient, Logger } from "../types.ts";
import {
  escalateToHuman,
  type EscalateToHumanDeps,
} from "./needs_human_escalation.ts";
import {
  type AlertDedupAuthorOptions,
  selectFleetAuthoredComments,
} from "./alert_dedup_authors.ts";
import { exceedsTableScanCap, findMarkdownTable } from "./markdown_table.ts";

/** One row of the published `## Milestones` table. */
export interface MilestoneGroup {
  /** The file area the group touches — a top-level directory or subsystem. */
  area: string;
  /**
   * The milestone title for the group, or `""` when the row's milestone cell
   * is `—` / `none`: a group that merges straight to the default branch and
   * therefore gets no milestone at all.
   */
  title: string;
  /** The sub-issue numbers the row names, in published order. */
  subIssueNumbers: number[];
}

/** A row (or a published sub-issue) that fails the structural gate. */
export interface MilestoneGroupOffender {
  /** What offends: the offending row's label, or `#N` for a sub-issue. */
  subject: string;
  /** Human-readable reason the subject fails. */
  reason: string;
}

/** What {@link runMilestoneGroupsGate} read from the planning parent. */
export interface MilestoneGroupsVerdict {
  /** Whether a `## Milestones` table was found at all. */
  tableFound: boolean;
  /** The groups the table carried — empty when no table was found. */
  groups: MilestoneGroup[];
  /** True when the parent could not be read, so the grouping is unknown. */
  readFailed?: boolean;
}

/**
 * Most milestones one plan may create.
 *
 * The accepted scope of #2163: a plan creates at most four milestones, and
 * sub-issues that merge straight to the default branch (a group of one) do not
 * count towards it. More streams than this stop being parallelism and start
 * being a milestone backlog nobody finishes.
 */
export const MAX_MILESTONE_GROUPS = 4;

/**
 * Canonical `## Milestones` requirement for the in-code fallback publish
 * prompts.
 *
 * Held beside the gate — not beside the prompts — so the instruction and the
 * rule {@link validateMilestoneGroups} actually implements cannot drift apart,
 * exactly as `COVERAGE_TABLE_REQUIREMENT` does for the coverage gate. This
 * constant is what the degraded in-code fallbacks interpolate;
 * `prompts/planning/prompt.md` and `prompts/planning_critique/prompt.md` teach
 * the same table in their own words (Issue #2174). Neither is guaranteed to
 * have run, which is why the gate must tolerate a plan that carries no table
 * at all.
 */
export const MILESTONES_TABLE_REQUIREMENT =
  "Your summary comment on the parent issue must also carry a " +
  "`## Milestones` table with the columns `| Milestone | File area | " +
  "Sub-issues |` — one row per group of sub-issues that share a file area " +
  "(a top-level directory or subsystem). Put the milestone title in " +
  "`Milestone`, the file area in `File area`, and the group's sub-issue " +
  "references (`#N`) in `Sub-issues`. A sub-issue that merges straight to " +
  "the default branch is a row too: write `—` in `Milestone` and give it a " +
  "row of its own. Every sub-issue you published must appear in exactly one " +
  "row, every row must name a file area, and at most four rows may carry two " +
  "or more sub-issues. A deterministic gate reports a table that breaks " +
  "those rules, so group every sub-issue before you post the comment.";

/** What a human is told to do when the gate fails. */
export const MILESTONE_GROUPS_GATE_NEXT_STEP =
  "Regroup the sub-issues in the `## Milestones` table on this issue: give " +
  "every published sub-issue exactly one row, name the file area each group " +
  "touches, and keep the plan to at most " + MAX_MILESTONE_GROUPS +
  " milestones carrying two or more sub-issues (a row whose milestone is " +
  "`—` merges straight to the default branch and does not count). Update " +
  "the table, then remove the label.";

// Header cell that names the milestone column.
const MILESTONE_HEADER_RE = /milestone/i;

// Header cell that names the file-area column.
const AREA_HEADER_RE = /\barea\b/i;

// Header cell that names the sub-issue column. Deliberately narrower than the
// coverage gate's `cover|sub-?issue`: a `## Plan Coverage` table must never
// match this one, and it has no milestone or area column to begin with.
const SUB_ISSUES_HEADER_RE = /sub-?issues?/i;

// Every sub-issue reference in a cell: `#12` or a full GitHub issue URL.
const ISSUE_REF_RE =
  /(?:https?:\/\/github\.com\/[^\s/]+\/[^\s/]+\/issues\/(\d+)|#(\d+))/g;

/**
 * A milestone cell that means "no milestone": an em/en dash, a hyphen, an
 * empty cell, or the words the publish turn might reach for instead.
 */
const NO_MILESTONE_RE = /^(?:[—–-]{1,2}|none|n\/a|no milestone)$/i;

/** Whether a trimmed cell is wholly a bracketed template placeholder. */
function isBracketedPlaceholder(trimmed: string): boolean {
  return /^\[[\s\S]*\]$/.test(trimmed);
}

/** Every sub-issue number a cell names, de-duplicated, in published order. */
function parseSubIssueNumbers(cell: string): number[] {
  const numbers: number[] = [];
  for (const match of cell.matchAll(ISSUE_REF_RE)) {
    const raw = match[1] ?? match[2];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n <= 0) continue;
    if (!numbers.includes(n)) numbers.push(n);
  }
  return numbers;
}

/**
 * Extract the `## Milestones` table from a markdown blob.
 *
 * The table is located by its **header signature** — a milestone column, a
 * file-area column and a sub-issues column — rather than by the heading above
 * it, so a reworded heading cannot hide the table from the gate and the
 * adjacent `## Plan Coverage` table (or any unrelated table) is skipped rather
 * than parsed as this one.
 *
 * A blob past the shared scan cap is rejected rather than scanned, for the
 * reasons `markdown_table.ts` records (Issue #1245).
 *
 * @returns The table's groups (possibly empty for a header-only table), or
 *   `null` when the blob carries no `## Milestones` table.
 */
export function extractMilestoneGroups(
  markdown: string,
): MilestoneGroup[] | null {
  const table = findMarkdownTable(
    markdown,
    (headers) =>
      headers.some((h) => MILESTONE_HEADER_RE.test(h)) &&
      headers.some((h) => AREA_HEADER_RE.test(h)) &&
      headers.some((h) => SUB_ISSUES_HEADER_RE.test(h)),
  );
  if (table === null) return null;

  const titleIdx = table.headers.findIndex((h) => MILESTONE_HEADER_RE.test(h));
  const areaIdx = table.headers.findIndex((h) => AREA_HEADER_RE.test(h));
  const subIdx = table.headers.findIndex((h) => SUB_ISSUES_HEADER_RE.test(h));

  return table.rows.map((cells) => {
    const rawTitle = (cells[titleIdx] ?? "").trim();
    return {
      title: NO_MILESTONE_RE.test(rawTitle) ? "" : rawTitle,
      area: (cells[areaIdx] ?? "").trim(),
      subIssueNumbers: parseSubIssueNumbers(cells[subIdx] ?? ""),
    };
  });
}

/** How one group is named in an offender line and in the escalation comment. */
function groupLabel(group: MilestoneGroup): string {
  const name = group.title !== "" ? group.title : "—";
  const refs = group.subIssueNumbers.map((n) => `#${n}`).join(", ");
  return refs === "" ? name : `${name} (${refs})`;
}

/** Whether a group names a real file area (not blank, not a placeholder). */
function namesFileArea(group: MilestoneGroup): boolean {
  const area = group.area.trim();
  return area !== "" && !isBracketedPlaceholder(area) &&
    /[\p{L}\p{N}]/u.test(area);
}

/**
 * Pure gate: return the rows that fail the structural rules.
 *
 * A grouping passes when every published sub-issue sits in exactly one group,
 * every group names a file area, and at most {@link MAX_MILESTONE_GROUPS}
 * groups carry two or more sub-issues. Single-sub-issue groups merge straight
 * to the default branch, so they never count towards that cap.
 *
 * **File overlap between groups is never an offence** — that is planner
 * judgement (#2163), and a structural gate has no way to tell an accepted
 * housekeeping overlap from a real one.
 *
 * @param groups - The groups parsed from the published table.
 * @param publishedSubIssueNumbers - The sub-issues **this run** published.
 */
export function validateMilestoneGroups(
  groups: readonly MilestoneGroup[],
  publishedSubIssueNumbers: readonly number[],
): MilestoneGroupOffender[] {
  const offenders: MilestoneGroupOffender[] = [];

  // 1. A group must say which file area it touches.
  for (const group of groups) {
    if (!namesFileArea(group)) {
      offenders.push({
        subject: groupLabel(group),
        reason: "this milestone group names no file area",
      });
    }
  }

  // 2. Every published sub-issue sits in exactly one group.
  for (
    const number of [...new Set(publishedSubIssueNumbers)].sort((a, b) => a - b)
  ) {
    const carrying = groups.filter((g) => g.subIssueNumbers.includes(number));
    if (carrying.length === 0) {
      offenders.push({
        subject: `#${number}`,
        reason:
          "this published sub-issue sits in no milestone group — every one " +
          "must appear in exactly one row",
      });
      continue;
    }
    if (carrying.length > 1) {
      const names = carrying
        .map((g) => (g.title !== "" ? g.title : "—"))
        .join(", ");
      offenders.push({
        subject: `#${number}`,
        reason:
          `this published sub-issue sits in ${carrying.length} milestone ` +
          `groups (${names}) — it must appear in exactly one row`,
      });
    }
  }

  // 3. At most MAX_MILESTONE_GROUPS milestones per plan. A group of one
  //    sub-issue creates no milestone, so it never counts.
  const multi = groups.filter((g) => g.subIssueNumbers.length >= 2);
  for (let i = MAX_MILESTONE_GROUPS; i < multi.length; i++) {
    offenders.push({
      subject: groupLabel(multi[i]!),
      reason:
        `a plan creates at most ${MAX_MILESTONE_GROUPS} milestones; this is ` +
        `milestone ${i + 1} (groups of one sub-issue do not count)`,
    });
  }

  return offenders;
}

/** Parent issue payload the gate reads. */
interface ParentPayload {
  body?: string;
  comments?: Array<{ body?: string; author?: { login?: string | null } }>;
}

/** What an unattributable milestones table costs, in this site's own words. */
const MILESTONES_UNVERIFIED_OUTCOME =
  "no comment counts as a published `## Milestones` table and the plan takes " +
  "the single-milestone legacy path. A needless legacy milestone costs one " +
  "serialised stream; a grouping a stranger posted decides how the fleet " +
  "splits the work";

/**
 * Fetch the planning parent and extract the `## Milestones` table it carries.
 *
 * Comments are scanned **newest first** — a re-published table supersedes an
 * earlier one — and the parent body is the final fallback, so the first
 * fleet-authored candidate carrying the table wins. That is exactly the
 * ordering `runPlanCoverageGate` uses, including the author check: a comment
 * is writable by any account, so only fleet-authored comments are candidates
 * (Issue #1244) and an unverifiable table is discarded rather than obeyed.
 *
 * A read failure reports `readFailed` rather than "no table": the caller must
 * be able to tell an absent grouping from an unknown one.
 */
export async function runMilestoneGroupsGate(opts: {
  repo: string;
  parentIssueNumber: number;
  ghCommandFn: (args: string[]) => Promise<string>;
  logger: Pick<Logger, "info" | "warn">;
  /**
   * Fleet identity for the comment author check (Issue #1244). Omitted means
   * "read the configured fleet identity" from `CONFIG_PATH` / `GITHUB_USER`.
   */
  authorOptions?: AlertDedupAuthorOptions;
}): Promise<MilestoneGroupsVerdict> {
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
      "Milestone-groups gate: could not read the planning parent — the grouping is unknown (Issue #2172)",
      {
        repo,
        issueNumber: parentIssueNumber,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return { tableFound: false, groups: [], readFailed: true };
  }

  // Only comments carrying a table are put to the author check, so the discard
  // log names genuine candidates from outside the fleet, not chatter. An
  // oversized comment is never scanned, so it cannot be excluded for carrying
  // no table: it stays a candidate and the loop below reports the skip out
  // loud rather than dropping it silently here (Issue #1358).
  const tableComments = (payload.comments ?? [])
    .map((c) => ({ author: c.author?.login ?? null, body: c.body ?? "" }))
    .filter((c) =>
      exceedsTableScanCap(c.body) || extractMilestoneGroups(c.body) !== null
    );
  const fleetComments = await selectFleetAuthoredComments(
    tableComments,
    `plan milestones table ${repo}#${parentIssueNumber}`,
    opts.authorOptions ?? {},
    (message) => logger.warn(message),
    MILESTONES_UNVERIFIED_OUTCOME,
  );

  const candidates = [
    ...fleetComments.map((c) => c.body).reverse(),
    payload.body ?? "",
  ];

  for (const candidate of candidates) {
    if (candidate.trim() === "") continue;
    if (exceedsTableScanCap(candidate)) {
      // `extractMilestoneGroups` would reject it anyway; checked here so the
      // skip is reported. Loud, not silent: an unscanned candidate is not a
      // candidate that carried no table (Issue #1245).
      logger.warn(
        "Milestone-groups gate: skipped an oversized candidate without scanning it (Issue #1245)",
        { repo, issueNumber: parentIssueNumber, chars: candidate.length },
      );
      continue;
    }
    const groups = extractMilestoneGroups(candidate);
    if (groups !== null) return { tableFound: true, groups };
  }

  return { tableFound: false, groups: [] };
}

/**
 * Build the `**Why:**` line for the escalation comment — the rule, then every
 * offending row and why it fails.
 */
export function buildMilestoneGroupsGateReason(
  offenders: readonly MilestoneGroupOffender[],
): string {
  const lines = offenders
    .map((o) => `- ${o.subject} — ${o.reason}`)
    .join("\n");
  return [
    "the `## Milestones` table on this issue must put every published " +
    "sub-issue in exactly one group, name the file area each group touches, " +
    `and create at most ${MAX_MILESTONE_GROUPS} milestones. The following ` +
    "row(s) do not:",
    "",
    lines,
    "",
    "The plan still published, and the sub-issues were put in a single " +
    "milestone so delivery continues while the grouping is corrected.",
  ].join("\n");
}

/**
 * Hand a broken `## Milestones` table to a human through the shared
 * escalation chokepoint.
 *
 * Deliberately reuses `escalateToHuman()` — the repo's single needs-human
 * chokepoint, which enforces the paired label + explanation comment and dedups
 * repeat escalations within 24 hours — instead of adding a second escalation
 * path for milestone grouping.
 *
 * @returns Whether the escalation landed (label or comment).
 */
export async function escalateMilestoneGroupOffenders(opts: {
  ghClient: GitHubClient;
  repo: string;
  parentIssueNumber: number;
  needsHumanLabel: string;
  offenders: readonly MilestoneGroupOffender[];
  githubUser?: string;
  logger: Logger;
  deps?: EscalateToHumanDeps;
}): Promise<boolean> {
  const {
    ghClient,
    repo,
    parentIssueNumber,
    needsHumanLabel,
    offenders,
    githubUser,
    logger,
    deps,
  } = opts;

  const result = await escalateToHuman({
    ghClient,
    repo,
    target: { kind: "issue", number: parentIssueNumber },
    needsHumanLabel,
    heading: "Plan milestones gate",
    reason: buildMilestoneGroupsGateReason(offenders),
    nextStep: MILESTONE_GROUPS_GATE_NEXT_STEP,
    dedupKey: `plan-milestones-${parentIssueNumber}`,
    ...(githubUser ? { githubUser } : {}),
    ...(deps ? { deps } : {}),
    logger,
  });

  if (!result.ok) {
    logger.error(
      "Milestone-groups gate: failed to escalate the broken grouping to a human (Issue #2172)",
      { repo, issueNumber: parentIssueNumber, error: result.error.message },
    );
    return false;
  }
  return result.value.labelAdded || result.value.commentPosted;
}
