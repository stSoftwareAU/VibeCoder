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
 *     D -- yes --> S{"Every accepted scope<br/>item shown met?"}
 *     S -- yes --> P
 *     S -- no --> F["File (or reuse) one follow-up<br/>naming each shortfall"]
 *     F --> B["PR body gains a<br/>'Degraded run' section<br/>pointing at the follow-up"]
 *     B --> P2["PR raised; the residue<br/>survives the merge"]
 * ```
 *
 * The degraded verdict is the one {@link buildDegradationReport} gives the
 * run-stats comment, so the two can never disagree about a run. A scope item
 * is delivered only when the PR summary's closure block marks it `met`; a
 * `partial` or `missing` entry, or no entry at all, is a shortfall. A degraded
 * run on an issue that states no scope names the issue itself as unverified,
 * since there is nothing narrower to name.
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

/** One accepted scope item a degraded run did not show as met. */
export interface DegradedShortfall {
  /** The scope item, as the issue states it. */
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
  /** Scope items short of `met`. Always empty on a healthy run. */
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
  if (!verdict.degraded) {
    return { degraded: false, delivered: [], shortfalls: [] };
  }

  const stated = extractAcceptedScope(args.issueBody);
  const scope = stated.length > 0 ? stated : [UNSTATED_SCOPE_ITEM];
  // The closure block carries one assessment per criterion, in criterion
  // order; `unrequested` entries describe the diff, not the scope.
  const assessments = parseClosureEntries(args.prBody)
    .filter((entry) => entry.status !== "unrequested");

  const delivered: string[] = [];
  const shortfalls: DegradedShortfall[] = [];
  scope.forEach((criterion, index) => {
    const status = stated.length > 0 ? assessments[index]?.status : undefined;
    if (status === "met") {
      delivered.push(criterion);
    } else if (status === "partial" || status === "missing") {
      shortfalls.push({ criterion, status });
    } else {
      shortfalls.push({ criterion, status: "unassessed" });
    }
  });

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
  return shortfalls.map((s) => `- **${s.status}** — ${s.criterion}`);
}

/**
 * Build the follow-up issue a degraded run files for its shortfalls.
 *
 * The parent is mentioned but never with a closing keyword, and the body
 * carries the {@link degradedFollowUpFindingId} marker for dedup.
 */
export function buildDegradedFollowUpIssue(args: {
  parentNumber: number;
  parentTitle: string;
  verdict: DegradedDeliveryVerdict;
  runId: string;
}): { title: string; body: string } {
  const { parentNumber, verdict } = args;
  const delivered = verdict.delivered.length > 0
    ? verdict.delivered.map((c) => `- ${c}`)
    : ["- nothing the PR summary marks `met`"];
  const body = [
    `<!-- finding-id: ${degradedFollowUpFindingId(parentNumber)} -->`,
    "",
    `Auto-filed by the Vibe Coder (Issue #2562): the implementation run for ` +
    `#${parentNumber} was **degraded** — ${
      verdict.reason ?? "served by a fallback model"
    } — and did not show every accepted scope item as met. That run's PR ` +
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
    }) and did not show every accepted scope item as met. The outstanding ` +
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
