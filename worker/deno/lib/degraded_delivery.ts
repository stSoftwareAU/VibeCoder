/**
 * Degraded-run delivery guard: a fallback-model run never reads as complete
 * delivery (Issue #2562).
 *
 * On #2543 the implementation run asked for `opus`, was served Haiku after a
 * rate-limit fallback, shipped one of seven accepted changes, and its PR closed
 * the issue. The run-stats comment said `Degraded: ⚠️ yes`, so the fleet knew —
 * but nothing on the PR path read that verdict, the run wrote no PR summary,
 * and the grill-me scope sat under `### Accepted scope so far`, which the
 * acceptance-criteria gate does not read. The remainder had to be rediscovered
 * by hand and refiled as #2560.
 *
 * The guard keeps the PR (the work is not thrown away, and a PR without a
 * closing keyword loops for ever — Issue #520) but makes the gap impossible to
 * miss:
 *
 * ```mermaid
 * flowchart TD
 *     R["Implementation run<br/>reaches completion"] --> D{"Degraded?<br/>(same verdict as the<br/>run-stats comment)"}
 *     D -- no --> H{"Any closure entry<br/>partial or missing?"}
 *     H -- no --> P["PR as today"]
 *     H -- yes --> C{"Issue is itself a<br/>partial-delivery follow-up?"}
 *     C -- no --> F2["File (or reuse) the same follow-up;<br/>PR body gains a 'Partial delivery'<br/>section pointing at it"]
 *     C -- yes --> CS["No nested follow-up; label<br/>needs-human; PR body opens<br/>'handed to a human', says 'Part of'"]
 *     D -- yes --> S{"Every scope item met<br/>and no unmatched<br/>partial/missing entry?"}
 *     S -- yes --> P
 *     S -- no --> G{"Any shortfall<br/>partial or missing?"}
 *     G -- yes --> F["File (or reuse) one follow-up<br/>naming each shortfall"]
 *     F --> B["PR body gains a<br/>'Degraded run' section<br/>pointing at the follow-up"]
 *     B --> P2["PR raised; the residue<br/>survives the merge"]
 *     G -- "no — all unassessed" --> N["PR body gains a<br/>'Degraded run' section<br/>saying why no follow-up"]
 *     N --> P3["PR raised; closes the<br/>issue as a healthy PR would"]
 * ```
 *
 * The degraded verdict is the one {@link buildDegradationReport} gives the
 * run-stats comment, so the two can never disagree about a run — except that
 * a previous generation of the requested tier (a stale container) does not
 * count here: the run was not handed to a fallback model. Closure entries are
 * matched to scope items by their words, not by their position in the list
 * (Issue #3128): an entry that matches no scope item, or matches more than
 * one equally well, does not assess that item, so it reads `unassessed`; one
 * split across several entries takes their worst status. A `partial` or
 * `missing` entry left unassigned is still a shortfall, named by its own
 * subject, or by its `reason:` when the subject has no words. A scope item is
 * delivered only when it is matched to a `met` entry (and nothing worse); a
 * `partial` or `missing` match, or no match at all, is a shortfall. A
 * degraded run on an issue that states no scope names the issue itself as
 * unverified, since there is nothing narrower to name, and still files a
 * follow-up for each actionable `partial` or `missing` entry, named
 * by that entry's subject (PR #3676 review).
 *
 * Only an actionable `partial` or `missing` shortfall files a follow-up.
 * Pending-only merge checks remain in the summary (Issue #3961). An
 * `unassessed` item carries no evidence of a gap — the run said nothing about
 * it — and a follow-up built only from those just restated the whole issue as
 * a `Finish #N` ticket no later run could act on. When every shortfall
 * is `unassessed`, the PR still opens with a degraded section naming the
 * served model and reason and saying why nothing was filed.
 *
 * A healthy run is not exempt from its own report (Issue #3506): when its PR
 * summary closes an implementation criterion out as `partial` or `missing`,
 * {@link assessReportedGaps} yields those entries and the same follow-up is
 * filed (or reused, keyed on the parent) with a body for a healthy run, and the
 * PR body gains a section from {@link buildReportedGapPrSection}. `unassessed`
 * items file nothing (Issue #2695).
 *
 * PR #3676 review, chain stop: a healthy run on an issue that is itself a
 * partial-delivery follow-up (see {@link isPartialDeliveryFollowUp}) files no
 * nested follow-up. It labels the issue `needs-human`, and its PR body opens
 * with the chain-stop section from {@link buildFollowUpChainStopSection}, which
 * says `Part of` rather than closing the issue. A degraded run on such an issue
 * still files one, as above.
 *
 * The follow-up carries the `idle-task` label — the one work-trigger label the
 * worker may apply itself — so a later run picks the residue up without a
 * human, and a `finding-id` marker keyed on the parent, so a second degraded
 * run on the same issue reuses the open follow-up rather than filing
 * another — and rewrites its body to that later run's shortfalls and
 * delivered items, so the follow-up never goes stale (Issue #3145).
 *
 * A PR-body re-sync (Issue #3350) re-derives this section from the current
 * issue body and summary via {@link rederiveDegradedSection}, keeping only the
 * original run's reason and follow-up number, because model routing cannot be
 * re-judged after the run. A healthy run's section is re-derived the same way
 * by {@link rederiveReportedGapSection}.
 *
 * The verdict and the rendering are pure; {@link fileDegradedFollowUp} is the
 * one I/O step, with `gh` injected.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  type ClosureEntry,
  extractAcceptedScope,
  parseClosureEntries,
} from "./acceptance_criteria_gate.ts";
import {
  gapSubject,
  matchClosureEntries,
  subjectOf,
} from "./closure_criterion_match.ts";
import { neutraliseAgentMarkers } from "./agent_marker_neutralisation.ts";
import { IMPLEMENTATION_RUN_STATS_PHASE } from "./issue_run_stats_comment.ts";
import {
  buildPhaseInvocations,
  type PhaseClaudeResult,
} from "./phase_run_stats.ts";
import { buildDegradationReport } from "./planning_run_stats.ts";
import type { EnvLookup } from "./env_lookup.ts";
import { guardedLabelArgs } from "./guarded_issue_labels.ts";
import { IDLE_TASK_LABEL } from "./idle_task_issue.ts";
import { LABEL_DEFAULTS } from "./config_defaults.ts";
import {
  fileFindingOnce,
  type FindingIdDedupOptions,
} from "./idle_task_snapshot.ts";
import type { Result } from "../types.ts";

/** Why a scope item counts as not delivered. */
export type ShortfallStatus = "partial" | "missing" | "unassessed";

/** One shortfall a degraded run files: a scope item not shown as met, or an unmatched gap the closure block reported. */
export interface DegradedShortfall {
  /**
   * The scope item, as the issue states it. A gap the closure block left
   * unmatched carries the entry's own subject instead — its `reason:` when
   * that subject has no words.
   */
  criterion: string;
  /** `partial`/`missing` as the summary said, or `unassessed` when it said nothing. */
  status: ShortfallStatus;
}

/** Verdict of {@link assessDegradedDelivery}. */
export interface DegradedDeliveryVerdict {
  /** True when the run was served by a fallback model. */
  degraded: boolean;
  /** The degradation reason, as the run-stats comment states it. */
  reason?: string;
  /** Scope items the summary marks `met`, or, for an issue that states no scope, the subjects of its `met` closure entries. Empty on the verdict {@link assessDegradedDelivery} gives a healthy run; {@link assessReportedGaps} fills it. */
  delivered: string[];
  /** Scope items short of `met`, plus unmatched `partial` or `missing` gaps. Always empty on the verdict {@link assessDegradedDelivery} gives a healthy run; {@link assessReportedGaps} fills only the `partial`/`missing` ones. */
  shortfalls: DegradedShortfall[];
}

/** Stand-in scope item for an issue that states no criteria or scope. */
export const UNSTATED_SCOPE_ITEM =
  "The issue as written — it states no acceptance criteria or accepted scope, " +
  "so the whole body needs checking against what this PR delivered";

// Deliberately narrow: unknown words keep a gap actionable. In particular,
// unknown implementation or tooling details remain actionable in legacy entries.
const MERGE_CHECK_WORDS = new Set(
  "ci quality sh gate gates check checks required clean code review independent routine pass passes passing green and the all must be is are before merge merging verified verification execution not yet pending awaiting run runs ran executed complete completed only still on pr a this will locally has been"
    .split(" "),
);

function mergeCheckWords(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function isMergeCheckOnly(text: string): boolean {
  const words = mergeCheckWords(text);
  return words.some((word) => ["ci", "quality", "review"].includes(word)) &&
    words.every((word) => MERGE_CHECK_WORDS.has(word));
}

/** Current check results in evidence; a later clean result supersedes its failure. */
function hasFailedMergeCheck(evidence: string): boolean {
  const failed = new Map<string, boolean>();
  const declarations = evidence.matchAll(
    /(?:^|[;.—]\s*)((?:(?:required|local|all|unit|integration)\s+)?(?:CI(?:\s+checks?)?|quality(?:\s+gates?)?|gates?|(?:(?:clean|code|independent)\s+)?reviews?|tests?))\s*:?\s*(?:(?:is|are|was|were|has|have|now|still|currently)\s+)*(failed|failing|broken|not (?:clean|green|passing)|rejected|blocking findings?|passed|pass|passing|clean|green|fixed|resolved)\b/gi,
  );
  for (const match of declarations) {
    const name = match[1]!.toLowerCase();
    const check = name.includes("review")
      ? "review"
      : name.includes("test")
      ? name.replace(/^(?:required|local|all)\s+/, "").replace(
        /tests?$/,
        "tests",
      )
      : name.includes("quality") || name.includes("gate")
      ? "quality"
      : "ci";
    failed.set(
      check,
      !/^(?:passed|pass|passing|clean|green|fixed|resolved)$/i.test(match[2]!),
    );
  }
  return [...failed.values()].some(Boolean);
}

/** Pending merge checks are visible in the summary, not unfinished work. */
function isPendingMergeCheck(entry: ClosureEntry): boolean {
  if (entry.status !== "partial" && entry.status !== "missing") return false;
  const evidence = entry.text.match(
    /\bevidence\s*[:—-]\s*([\s\S]*?)(?:\s+[—-]\s+(?:reviewer|reason|remaining)\s*[:—-]|$)/i,
  )?.[1] ?? "";
  if (hasFailedMergeCheck(evidence)) return false;
  // A mixed criterion can have completed product work and only verification
  // left. The generator states that explicitly while retaining its partial
  // closure status; CI/review/acceptance gates still judge the original entry.
  if (
    /\breason:\s*(?:CI not yet verified|awaiting code review|quality gate not yet run)\s*[—-]\s*remaining:\s*merge-verification-only\s*$/i
      .test(entry.text)
  ) return true;
  const subject = subjectOf(entry);
  const reason = entry.text.match(/\breason\s*[:\-—]\s*([\s\S]+)$/i)?.[1] ?? "";
  return isMergeCheckOnly(subject) &&
    /^(?:(?:required )?CI (?:(?:is |still )?pending|not yet verified)|awaiting (?:independent |clean )?code review|(?:required )?quality (?:gate )?(?:not yet (?:run|executed|complete|completed)|pending)|(?:clean )?code review pending)[.!]?$/i
      .test(reason.trim());
}

/**
 * Match the issue's accepted scope against the PR body's closure block: which
 * items are delivered (`met`) and which are shortfalls. Pure, and independent
 * of how the run was routed, so a PR-body re-sync can re-run it (Issue #3350).
 */
export function assessScopeShortfalls(
  issueBody: string,
  prBody: string,
): { delivered: string[]; shortfalls: DegradedShortfall[] } {
  const stated = extractAcceptedScope(issueBody);
  const parsed = parseClosureEntries(prBody);
  const pending = parsed.filter(isPendingMergeCheck);
  const entries = parsed.filter((entry) => !isPendingMergeCheck(entry));

  if (stated.length === 0) {
    // An issue that states no scope has no criterion to match, so every entry
    // is unassigned (PR #3676 review). Each `met` entry is what the run says it
    // delivered, and each `partial` or `missing` entry is a shortfall named by
    // its own subject, so a degraded run keeps the gap it reported.
    const { unassignedGaps } = matchClosureEntries([], entries);
    return {
      delivered: entries
        .filter((entry) => entry.status === "met")
        .map((entry) => gapSubject(entry)),
      shortfalls: [
        { criterion: UNSTATED_SCOPE_ITEM, status: "unassessed" },
        ...unassignedGaps.map((gap) => ({
          criterion: gap.subject,
          status: gap.status,
        })),
      ],
    };
  }

  // Closure entries are matched to criteria by their words, not by list
  // position (Issue #3128): an entry that matches no criterion, or more than
  // one equally well, assesses nothing, so its criterion is `unassessed`; a
  // criterion split across several entries takes their worst status. A
  // `partial` or `missing` entry left unassigned is still a shortfall, named
  // by its own subject, so a paraphrased gap is not dropped.
  const match = matchClosureEntries(stated, entries);

  const delivered: string[] = [];
  const shortfalls: DegradedShortfall[] = [];
  stated.forEach((criterion, index) => {
    const status = match.statuses[index];
    if (status === "met") {
      delivered.push(criterion);
    } else if (status === "partial" || status === "missing") {
      shortfalls.push({ criterion, status });
    } else {
      if (
        isMergeCheckOnly(criterion) &&
        matchClosureEntries([criterion], pending).statuses[0] !== undefined
      ) return;
      shortfalls.push({ criterion, status: "unassessed" });
    }
  });
  for (const gap of match.unassignedGaps) {
    shortfalls.push({ criterion: gap.subject, status: gap.status });
  }

  return { delivered, shortfalls };
}

/** Opening heading of the PR-body section a healthy run's reported gaps get (Issue #3506). */
export const REPORTED_GAP_SECTION_HEADING =
  "## ⚠️ Partial delivery — follow-up filed";

/**
 * A healthy run's own gaps (Issue #3506): the closure entries its PR summary
 * marks `partial` or `missing`, matched exactly as assessScopeShortfalls does.
 * `unassessed` items are dropped — the run said nothing about them (Issue #2695).
 *
 * An issue that states no scope keeps each `partial` or `missing` entry as a
 * gap named by its own subject, and lists its `met` entries as delivered (PR
 * #3676 review); {@link assessScopeShortfalls} does that for both cases.
 */
export function assessReportedGaps(
  issueBody: string,
  prBody: string,
): DegradedDeliveryVerdict {
  const { delivered, shortfalls } = assessScopeShortfalls(issueBody, prBody);
  return {
    degraded: false,
    delivered,
    shortfalls: shortfalls.filter((s) =>
      s.status === "partial" || s.status === "missing"
    ),
  };
}

/**
 * Judge whether a run was degraded and, if so, which accepted scope it did
 * not show as delivered.
 *
 * @param args.claudeResults - The run's recorded agent invocations.
 * @param args.issueBody - The issue the run implemented.
 * @param args.prBody - The assembled PR body (summary included).
 * @param args.env - Environment lookup the expected model is derived through;
 *   defaults to the process environment, as for the run-stats comment.
 */
export function assessDegradedDelivery(args: {
  claudeResults: readonly PhaseClaudeResult[];
  issueBody: string;
  prBody: string;
  env?: EnvLookup;
}): DegradedDeliveryVerdict {
  // No recorded invocation, nothing to judge — and no routing to resolve, as
  // for the run-stats comment, which posts nothing in this case either.
  if (args.claudeResults.length === 0) {
    return { degraded: false, delivered: [], shortfalls: [] };
  }
  const { verdict } = buildDegradationReport({
    invocations: args.claudeResults.flatMap((result) =>
      buildPhaseInvocations(IMPLEMENTATION_RUN_STATS_PHASE, result)
    ),
    phase: IMPLEMENTATION_RUN_STATS_PHASE,
    ...(args.env ? { env: args.env } : {}),
  });
  // A stale generation of the requested tier (a container whose CLI still
  // resolves `opus` to Opus 5) is reported by the run-stats comment, but the
  // run was not handed to a fallback model, so its delivery is not in doubt —
  // treating it as degraded filed a follow-up on every run (Issue #2560).
  if (!verdict.degraded || verdict.previousGeneration) {
    return { degraded: false, delivered: [], shortfalls: [] };
  }

  const { delivered, shortfalls } = assessScopeShortfalls(
    args.issueBody,
    args.prBody,
  );

  return {
    degraded: true,
    ...(verdict.reason ? { reason: verdict.reason } : {}),
    delivered,
    shortfalls,
  };
}

/** Finding-id prefix that identifies a degraded-run follow-up issue. */
export const DEGRADED_FOLLOW_UP_ID_PREFIX = "degraded-follow-up-";

/**
 * The follow-up's finding id, keyed on its parent issue — so a second
 * degraded run on the same issue reuses the open follow-up.
 */
export function degradedFollowUpFindingId(parentNumber: number): string {
  return `${DEGRADED_FOLLOW_UP_ID_PREFIX}${parentNumber}`;
}

/** One markdown bullet per shortfall. */
function shortfallLines(shortfalls: readonly DegradedShortfall[]): string[] {
  // `criterion` is the issue's scope item, or the closure entry's subject
  // for an unmatched gap. Either is untrusted, and it is copied into a
  // fleet-authored idle-task issue whose own finding-id marker
  // `findOpenIssueByFindingId` trusts for dedup — Issue #2778.
  return shortfalls.map((s) =>
    `- **${s.status}** — ${neutraliseAgentMarkers(s.criterion).text}`
  );
}

/**
 * Build the follow-up issue a run files for its shortfalls: a degraded
 * verdict gets the degraded-run body (Issue #2562), a healthy one the body for
 * a run's reported gaps (Issue #3506). Both share one finding id, so a healthy
 * and a degraded run on one parent share one follow-up.
 *
 * The parent is mentioned but never with a closing keyword, and the body
 * carries the {@link degradedFollowUpFindingId} marker for dedup. The
 * shortfall criteria and delivered lines have their HTML-comment delimiters
 * neutralised so only the worker's own finding-id marker is live.
 */
export function buildDegradedFollowUpIssue(args: {
  parentNumber: number;
  parentTitle: string;
  verdict: DegradedDeliveryVerdict;
  runId: string;
}): { title: string; body: string } {
  const { parentNumber, verdict } = args;
  // Same reasoning as shortfallLines: `delivered` is the issue's own scope
  // items or, when the issue states none, the subjects of the summary's `met`
  // closure entries. Both are untrusted (issue body, agent-written PR
  // summary) and are copied into this fleet-authored issue — Issue #2778.
  const delivered = verdict.delivered.length > 0
    ? verdict.delivered.map((c) => `- ${neutraliseAgentMarkers(c).text}`)
    : ["- nothing the PR summary marks `met`"];
  const marker = `<!-- finding-id: ${
    degradedFollowUpFindingId(parentNumber)
  } -->`;
  const body = !verdict.degraded
    ? [
      marker,
      "",
      `Auto-filed by the Vibe Coder (Issue #3506): the implementation run for ` +
      `#${parentNumber} closed out one or more acceptance criteria as ` +
      `\`partial\` or \`missing\` in its PR summary. The outstanding scope ` +
      `continues here so it survives that PR's merge.`,
      "",
      "## Acceptance Criteria",
      "",
      "Outstanding from that run (status as its PR summary reported it):",
      "",
      ...shortfallLines(verdict.shortfalls),
      "",
      "## Already delivered by that run",
      "",
      ...delivered,
      "",
      `Check each outstanding item against the merged code before changing ` +
      `anything: the run may have done more than its summary claimed.`,
      "",
      `_Run id: \`${args.runId}\`_`,
    ].join("\n")
    : [
      marker,
      "",
      `Auto-filed by the Vibe Coder (Issue #2562): the implementation run for ` +
      `#${parentNumber} was **degraded** — ${
        verdict.reason ?? "served by a fallback model"
      } — and did not show every accepted scope item as met, or reported a ` +
      `gap of its own. That run's PR ` +
      `still completes #${parentNumber} on merge; the outstanding scope ` +
      `continues here so it is not lost with it.`,
      "",
      "## Acceptance Criteria",
      "",
      "Outstanding from the degraded run (status as that run's PR summary " +
      "reported it — `unassessed` means it said nothing):",
      "",
      ...shortfallLines(verdict.shortfalls),
      "",
      "## Already delivered by the degraded run",
      "",
      ...delivered,
      "",
      `Check each outstanding item against the merged code before changing ` +
      `anything: a degraded run may have done more than its summary claimed.`,
      "",
      `_Run id: \`${args.runId}\`_`,
    ].join("\n");
  return {
    title: `Finish #${parentNumber}: ${args.parentTitle}`.slice(0, 250),
    body,
  };
}

/**
 * Whether a verdict (degraded, or a healthy run's {@link assessReportedGaps})
 * warrants a follow-up: at least one shortfall the
 * PR summary itself marked `partial` or `missing` (Issue #2695). `unassessed`
 * items alone never do.
 */
export function degradedNeedsFollowUp(
  verdict: DegradedDeliveryVerdict,
): boolean {
  return verdict.shortfalls.some((s) =>
    s.status === "partial" || s.status === "missing"
  );
}

/**
 * Build the PR-body section for a degraded run whose shortfalls are all
 * `unassessed`, so no follow-up is filed (Issue #2695). It names the served
 * model and reason, says why nothing was filed, and references no follow-up.
 * Throws when the verdict does warrant a follow-up or has no shortfalls.
 */
export function buildDegradedNoFollowUpSection(
  verdict: DegradedDeliveryVerdict,
): string {
  if (verdict.shortfalls.length === 0 || degradedNeedsFollowUp(verdict)) {
    throw new Error(
      "buildDegradedNoFollowUpSection: needs only unassessed shortfalls",
    );
  }
  const unstated = verdict.shortfalls.length === 1 &&
    verdict.shortfalls[0]?.criterion === UNSTATED_SCOPE_ITEM;
  const why = unstated
    ? "the issue states no acceptance criteria"
    : "no acceptance criterion was assessed `partial` or `missing` as an actionable implementation gap";
  const lines = [
    "## ⚠️ Degraded run — no follow-up filed",
    "",
    `This run was degraded (${
      verdict.reason ?? "served by a fallback model"
    }). No follow-up was filed because ${why}.`,
  ];
  if (!unstated) {
    lines.push(
      "",
      "Unassessed by this run's PR summary — check them against the diff " +
        "before merging:",
      "",
      ...shortfallLines(verdict.shortfalls),
    );
  }
  return [...lines, "", ""].join("\n");
}

/**
 * Build the PR-body section a degraded run's PR carries, naming the
 * shortfalls and the follow-up that holds them.
 */
export function buildDegradedPrSection(
  verdict: DegradedDeliveryVerdict,
  followUpNumber: number,
): string {
  return [
    "## ⚠️ Degraded run — partial delivery",
    "",
    `This run was degraded (${
      verdict.reason ?? "served by a fallback model"
    }) and did not show every accepted scope item as met, or reported a ` +
    `gap of its own. The outstanding ` +
    `items continue in #${followUpNumber}:`,
    "",
    ...shortfallLines(verdict.shortfalls),
    "",
    "",
  ].join("\n");
}

/**
 * Read the original run's reason and follow-up number back from a degraded-run
 * section (Issue #3350). Only the single `This run was degraded (` line is
 * read: the shortfall bullets are untrusted text and must never supply a
 * follow-up number. Reasons contain parentheses themselves, so the reason ends
 * at the earliest known suffix, not the first `)`.
 */
export function parseDegradedSection(
  section: string,
): { reason?: string; followUpNumber?: number } {
  const prefix = "This run was degraded (";
  const line = section.split("\n").find((l) => l.startsWith(prefix));
  if (line === undefined) return {};
  const ends = [") and did not show", "). No follow-up was filed"]
    .map((suffix) => line.indexOf(suffix, prefix.length))
    .filter((i) => i !== -1);
  const out: { reason?: string; followUpNumber?: number } = {};
  if (ends.length > 0) {
    out.reason = line.slice(prefix.length, Math.min(...ends));
  }
  const match = line.match(/continue in #(\d{1,9}):/);
  if (match) {
    const n = Number(match[1]);
    if (Number.isSafeInteger(n) && n > 0) out.followUpNumber = n;
  }
  return out;
}

/**
 * Build the PR-body section for a degraded run with a `partial`/`missing`
 * shortfall but no worker follow-up (Issue #3350), e.g. a re-sync after the
 * summary gained a gap the original no-follow-up banner did not know of.
 * Throws when the verdict does not warrant a follow-up.
 */
export function buildDegradedUnfiledGapSection(
  verdict: DegradedDeliveryVerdict,
): string {
  if (!degradedNeedsFollowUp(verdict)) {
    throw new Error(
      "buildDegradedUnfiledGapSection: needs a partial or missing shortfall",
    );
  }
  return [
    "## ⚠️ Degraded run — partial delivery",
    "",
    `This run was degraded (${
      verdict.reason ?? "served by a fallback model"
    }) and did not show every accepted scope item as met, or reported a ` +
    `gap of its own. The worker filed no follow-up for these items when the ` +
    `PR was raised — check them against the diff before merging:`,
    "",
    ...shortfallLines(verdict.shortfalls),
    "",
    "",
  ].join("\n");
}

/**
 * Build the PR-body section a healthy run's PR carries when its summary closed
 * out criteria as `partial` or `missing` (Issue #3506), pointing at the
 * follow-up that holds them. Throws without a healthy verdict carrying one.
 */
export function buildReportedGapPrSection(
  verdict: DegradedDeliveryVerdict,
  followUpNumber: number,
): string {
  if (verdict.degraded || !degradedNeedsFollowUp(verdict)) {
    throw new Error(
      "buildReportedGapPrSection: needs a healthy verdict with a partial or missing shortfall",
    );
  }
  return [
    REPORTED_GAP_SECTION_HEADING,
    "",
    `This run's PR summary closed out the criteria below as \`partial\` or ` +
    `\`missing\`. The outstanding items continue in #${followUpNumber}:`,
    "",
    ...shortfallLines(verdict.shortfalls),
    "",
    "",
  ].join("\n");
}

/**
 * Build the partial-delivery section for a re-sync whose rebuilt gaps differ
 * from the ones the section was raised with. The follow-up it names was filed
 * from the earlier gaps and a re-sync never rewrites it (PR #3676 review), so
 * the section says it may not list every item instead of claiming it does.
 * Throws without a healthy verdict carrying a gap.
 */
export function buildReportedGapStaleFollowUpSection(
  verdict: DegradedDeliveryVerdict,
  followUpNumber: number,
): string {
  if (verdict.degraded || !degradedNeedsFollowUp(verdict)) {
    throw new Error(
      "buildReportedGapStaleFollowUpSection: needs a healthy verdict with a partial or missing shortfall",
    );
  }
  return [
    REPORTED_GAP_SECTION_HEADING,
    "",
    `This run's PR summary closed out the criteria below as \`partial\` or ` +
    `\`missing\`. The worker filed #${followUpNumber} for the outstanding ` +
    `items when the PR was raised and a re-sync does not rewrite it, so it ` +
    `may not list every item below — check them against the diff before ` +
    `merging:`,
    "",
    ...shortfallLines(verdict.shortfalls),
    "",
    "",
  ].join("\n");
}

/**
 * Re-derive a live partial-delivery section from the current issue body and PR
 * summary (Issue #3506). Returns "" when no gap remains. The follow-up number
 * is read only from the single opening line, never from the untrusted
 * shortfall bullets; when it cannot be read the live section is kept as is.
 *
 * Pure, and it never touches the follow-up: a sync must not write freshly
 * fetched issue text into an issue the fleet works as trusted (PR #3676
 * review). A section built from the same gaps stays as it is. Any other gap
 * set is rendered by {@link buildReportedGapStaleFollowUpSection}, which does
 * not claim the follow-up holds it.
 */
export function rederiveReportedGapSection(args: {
  liveSection: string;
  issueBody: string;
  prBody: string;
}): string {
  const verdict = assessReportedGaps(args.issueBody, args.prBody);
  if (verdict.shortfalls.length === 0) return "";
  const line = args.liveSection.split("\n").find((l) =>
    l.startsWith("This run's PR summary closed out")
  );
  const match = line?.match(/(?:continue in|filed) #(\d{1,9})[: ]/);
  const n = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) return args.liveSection;
  const heldSection = buildReportedGapPrSection(verdict, n);
  return args.liveSection === heldSection
    ? args.liveSection
    : buildReportedGapStaleFollowUpSection(verdict, n);
}

/**
 * Opening heading of the PR-body section a healthy run gets instead of a
 * nested follow-up when its issue is itself a partial-delivery follow-up
 * (PR #3676 review).
 */
export const FOLLOW_UP_CHAIN_STOP_SECTION_HEADING =
  "## ⚠️ Partial delivery — handed to a human";

/**
 * Marker the chain-stop section carries, so the merged-PR closers leave the
 * follow-up open (`hasFollowUpChainStop` in `missing_criterion_close_guard.ts`).
 */
export const FOLLOW_UP_CHAIN_STOP_MARKER = "<!-- vibe-follow-up-chain-stop -->";

/** A live `degraded-follow-up-<N>` finding-id marker, as the filer writes it. */
const FOLLOW_UP_FINDING_ID_RE = new RegExp(
  `<!--\\s*finding-id:\\s*${DEGRADED_FOLLOW_UP_ID_PREFIX}\\d+\\s*-->`,
);

/**
 * Whether an issue body is a partial-delivery follow-up the worker filed: it
 * carries a live `degraded-follow-up-<N>` finding-id marker (PR #3676 review).
 *
 * A healthy run on such an issue must not file a nested `Finish #F: Finish
 * #N: …` follow-up: an item no run can deliver would otherwise chain fleet
 * runs without end. A degraded run on such an issue still files one. Authorship is not checked. A planted marker only routes a
 * run's gaps to a human instead of to a fleet follow-up, which fails toward
 * a person, never toward silence.
 */
export function isPartialDeliveryFollowUp(issueBody: string): boolean {
  return FOLLOW_UP_FINDING_ID_RE.test(issueBody);
}

/**
 * Build the PR-body section a healthy run on a partial-delivery follow-up
 * carries in place of a nested follow-up (PR #3676 review). The closers read
 * its {@link FOLLOW_UP_CHAIN_STOP_MARKER} and leave the issue open on merge.
 * Throws without a healthy verdict carrying a gap.
 */
export function buildFollowUpChainStopSection(
  verdict: DegradedDeliveryVerdict,
  issueNumber: number,
): string {
  if (verdict.degraded || !degradedNeedsFollowUp(verdict)) {
    throw new Error(
      "buildFollowUpChainStopSection: needs a healthy verdict with a partial or missing shortfall",
    );
  }
  return [
    FOLLOW_UP_CHAIN_STOP_SECTION_HEADING,
    FOLLOW_UP_CHAIN_STOP_MARKER,
    "",
    `This run's PR summary closed out the criteria below as \`partial\` or ` +
    `\`missing\`. #${issueNumber} is itself a partial-delivery follow-up, so ` +
    `the worker files no further one: it is labelled ` +
    `\`${LABEL_DEFAULTS.needsHumanLabel}\`, and when this PR merges the ` +
    `worker leaves #${issueNumber} open for a human:`,
    "",
    ...shortfallLines(verdict.shortfalls),
    "",
    "",
  ].join("\n");
}

/**
 * Hand a partial-delivery follow-up whose own run left gaps to a human (PR
 * #3676 review): label it `needs-human` and comment naming the gaps. The
 * label goes on first, so a failed comment never leaves an unlabelled issue
 * that reads as handed over.
 *
 * Fails loud: the caller must not raise a PR that would close the follow-up
 * with its gaps recorded nowhere a person will look.
 */
export async function handFollowUpToHuman(args: {
  repo: string;
  issueNumber: number;
  verdict: DegradedDeliveryVerdict;
  runId: string;
  gh: (args: string[]) => Promise<string>;
}): Promise<Result<void>> {
  const comment = [
    `⚠️ **Handed to a human — this run closed out ` +
    `${args.verdict.shortfalls.length} criteri${
      args.verdict.shortfalls.length === 1 ? "on" : "a"
    } as \`partial\` or \`missing\`:**`,
    "",
    ...shortfallLines(args.verdict.shortfalls),
    "",
    `This issue is itself a partial-delivery follow-up, so the worker files ` +
    `no further one (PR #3676 review). It is labelled ` +
    `\`${LABEL_DEFAULTS.needsHumanLabel}\` and stays open when the run's PR ` +
    `merges. Finish the items by hand, or close this issue if the gap is ` +
    `acceptable.`,
    "",
    `_Run id: \`${args.runId}\`_`,
  ].join("\n");
  try {
    await args.gh([
      "issue",
      "edit",
      String(args.issueNumber),
      "--repo",
      args.repo,
      "--add-label",
      LABEL_DEFAULTS.needsHumanLabel,
    ]);
    await args.gh([
      "issue",
      "comment",
      String(args.issueNumber),
      "--repo",
      args.repo,
      "--body",
      comment,
    ]);
    return { ok: true, value: undefined };
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: new Error(
        `could not hand partial-delivery follow-up #${args.issueNumber} to ` +
          `a human: ${cause}`,
      ),
    };
  }
}

/**
 * Re-derive a live chain-stop section from the current issue body and PR
 * summary (PR #3676 review). Returns "" when no gap remains, so the merged PR
 * then closes the follow-up as usual.
 */
export function rederiveFollowUpChainStopSection(args: {
  issueNumber: number;
  issueBody: string;
  prBody: string;
}): string {
  const verdict = assessReportedGaps(args.issueBody, args.prBody);
  return degradedNeedsFollowUp(verdict)
    ? buildFollowUpChainStopSection(verdict, args.issueNumber)
    : "";
}

/**
 * Re-derive a live degraded-run section from the current issue body and PR
 * summary (Issue #3350). Only the original run's reason and follow-up number
 * are kept from the live section. Returns "" when nothing is outstanding, as
 * PR creation does.
 */
export function rederiveDegradedSection(args: {
  liveSection: string;
  issueBody: string;
  prBody: string;
}): string {
  const { reason, followUpNumber } = parseDegradedSection(args.liveSection);
  const { delivered, shortfalls } = assessScopeShortfalls(
    args.issueBody,
    args.prBody,
  );
  if (shortfalls.length === 0) return "";
  const verdict: DegradedDeliveryVerdict = {
    degraded: true,
    ...(reason ? { reason } : {}),
    delivered,
    shortfalls,
  };
  const gaps = parseClosureEntries(args.prBody).filter((entry) =>
    entry.status === "partial" || entry.status === "missing"
  );
  const pendingOnly = gaps.length > 0 && gaps.every(isPendingMergeCheck);
  if (followUpNumber !== undefined && !pendingOnly) {
    return buildDegradedPrSection(verdict, followUpNumber);
  }
  return degradedNeedsFollowUp(verdict)
    ? buildDegradedUnfiledGapSection(verdict)
    : buildDegradedNoFollowUpSection(verdict);
}

/**
 * File the follow-up of a degraded run, or of a healthy run's reported gaps
 * (Issue #3506), or reuse the open one for this parent
 * (Issue #2562).
 *
 * On reuse the open follow-up's body is rewritten to this run's verdict —
 * its finding-id marker is kept, since {@link buildDegradedFollowUpIssue}
 * emits the same one — so a later run's shortfalls and delivered items
 * replace the earlier run's stale ones rather than being silently dropped
 * (Issue #3145). The title is keyed on the parent and is left alone.
 *
 * Fails loud: a follow-up that cannot be filed, or a reused one that cannot
 * be brought up to date, returns an error, and the caller must not raise a
 * PR that would close the parent with the residue recorded nowhere.
 *
 * @returns The follow-up's issue number.
 */
export async function fileDegradedFollowUp(args: {
  repo: string;
  parentNumber: number;
  parentTitle: string;
  verdict: DegradedDeliveryVerdict;
  runId: string;
  gh: (args: string[]) => Promise<string>;
  dedupAuthors?: FindingIdDedupOptions;
  /**
   * The parent's milestone title, when it has one. A newly filed follow-up
   * joins it so the fleet works it on the milestone branch where the
   * parent's delivered half lives, not on the default branch (PR #3676
   * review). A reused follow-up keeps the milestone it was filed with.
   */
  milestoneTitle?: string;
}): Promise<Result<{ number: number; reused: boolean }>> {
  const findingId = degradedFollowUpFindingId(args.parentNumber);
  const issue = buildDegradedFollowUpIssue(args);
  try {
    const filed = await fileFindingOnce({
      repo: args.repo,
      logLabel: "degraded-follow-up",
      findingId,
      ghCommandFn: args.gh,
      ...(args.dedupAuthors ? { dedupAuthors: args.dedupAuthors } : {}),
      fileFn: async () => {
        const url = (await args.gh([
          "issue",
          "create",
          "--repo",
          args.repo,
          "--title",
          issue.title,
          "--body",
          issue.body,
          ...guardedLabelArgs(
            [IDLE_TASK_LABEL],
            "worker/deno/lib/degraded_delivery.ts",
          ),
          ...(args.milestoneTitle ? ["--milestone", args.milestoneTitle] : []),
        ])).trim();
        const number = Number(url.split("/").pop());
        return Number.isInteger(number) && number > 0
          ? { number, findingId }
          : null;
      },
    });
    if (filed === null) {
      return {
        ok: false,
        error: new Error(
          `gh issue create returned no issue number for the degraded-run ` +
            `follow-up of #${args.parentNumber}`,
        ),
      };
    }
    if (filed.skipped) {
      try {
        await args.gh([
          "issue",
          "edit",
          String(filed.number),
          "--repo",
          args.repo,
          "--body",
          issue.body,
        ]);
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          error: new Error(
            `could not update the reused degraded-run follow-up ` +
              `#${filed.number} of #${args.parentNumber}: ${cause}`,
          ),
        };
      }
    }
    return { ok: true, value: { number: filed.number, reused: filed.skipped } };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
