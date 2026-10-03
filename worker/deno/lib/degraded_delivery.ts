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
 *     D -- no --> P["PR as today"]
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
 * unverified, since there is nothing narrower to name.
 *
 * Only a `partial` or `missing` shortfall files a follow-up (Issue #2695). An
 * `unassessed` item carries no evidence of a gap — the run said nothing about
 * it — and a follow-up built only from those just restated the whole issue as
 * a `Finish #N` ticket no later run could act on. When every shortfall
 * is `unassessed`, the PR still opens with a degraded section naming the
 * served model and reason and saying why nothing was filed.
 *
 * The follow-up carries the `idle-task` label — the one work-trigger label the
 * worker may apply itself — so a later run picks the residue up without a
 * human, and a `finding-id` marker keyed on the parent, so a second degraded
 * run on the same issue reuses the open follow-up rather than filing another.
 *
 * The verdict and the rendering are pure; {@link fileDegradedFollowUp} is the
 * one I/O step, with `gh` injected.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  extractAcceptedScope,
  parseClosureEntries,
} from "./acceptance_criteria_gate.ts";
import { matchClosureEntries } from "./closure_criterion_match.ts";
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
  /** Scope items the summary marks `met`. Empty on a healthy run. */
  delivered: string[];
  /** Scope items short of `met`, plus unmatched `partial` or `missing` gaps. Always empty on a healthy run. */
  shortfalls: DegradedShortfall[];
}

/** Stand-in scope item for an issue that states no criteria or scope. */
export const UNSTATED_SCOPE_ITEM =
  "The issue as written — it states no acceptance criteria or accepted scope, " +
  "so the whole body needs checking against what this PR delivered";

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

  const stated = extractAcceptedScope(args.issueBody);
  const scope = stated.length > 0 ? stated : [UNSTATED_SCOPE_ITEM];
  // Closure entries are matched to criteria by their words, not by list
  // position (Issue #3128): an entry that matches no criterion, or more than
  // one equally well, assesses nothing, so its criterion is `unassessed`; a
  // criterion split across several entries takes their worst status. A
  // `partial` or `missing` entry left unassigned is still a shortfall, named
  // by its own subject, so a paraphrased gap is not dropped.
  const match = stated.length > 0
    ? matchClosureEntries(stated, parseClosureEntries(args.prBody))
    : { statuses: [], unassignedGaps: [] };

  const delivered: string[] = [];
  const shortfalls: DegradedShortfall[] = [];
  scope.forEach((criterion, index) => {
    const status = stated.length > 0 ? match.statuses[index] : undefined;
    if (status === "met") {
      delivered.push(criterion);
    } else if (status === "partial" || status === "missing") {
      shortfalls.push({ criterion, status });
    } else {
      shortfalls.push({ criterion, status: "unassessed" });
    }
  });
  for (const gap of match.unassignedGaps) {
    shortfalls.push({ criterion: gap.subject, status: gap.status });
  }

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
 * Build the follow-up issue a degraded run files for its shortfalls.
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
  // Same reasoning as shortfallLines: `delivered` is copied from the issue
  // body, which is untrusted, into this fleet-authored issue — Issue #2778.
  const delivered = verdict.delivered.length > 0
    ? verdict.delivered.map((c) => `- ${neutraliseAgentMarkers(c).text}`)
    : ["- nothing the PR summary marks `met`"];
  const body = [
    `<!-- finding-id: ${degradedFollowUpFindingId(parentNumber)} -->`,
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
 * Whether a degraded verdict warrants a follow-up: at least one shortfall the
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
    : "no acceptance criterion was assessed `partial` or `missing`";
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
 * File the degraded run's follow-up, or reuse the open one for this parent
 * (Issue #2562).
 *
 * Fails loud: a follow-up that cannot be filed returns an error, and the
 * caller must not raise a PR that would close the parent with the residue
 * recorded nowhere.
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
    return { ok: true, value: { number: filed.number, reused: filed.skipped } };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
