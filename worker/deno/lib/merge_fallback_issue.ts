/**
 * The `merge-fallback` flag issue every conflict fallback leaves behind
 * (Issue #2304, part of #2298).
 *
 * The conflict ladder ends in a fallback: on the PR path the PR is closed and
 * its originating issue re-queued; on the milestone path the merged children
 * are reverted newest-first and re-queued. Both were silent. The work was
 * undone, the conflict that undid it was not written down anywhere durable,
 * and the next attempt started from the same blank page — so the same
 * conflict could be walked into again with nothing to learn from.
 *
 * This module is the one place that writes that record down, for both paths.
 * It knows nothing about either caller: it takes what the fallback observed
 * and files (or appends to) one issue carrying the `merge-fallback` content
 * label.
 *
 * **Nothing is omitted.** Every field renders, and a field the caller could
 * not record renders as `not recorded` rather than disappearing. A missing
 * section and an unrecorded one look identical once the body is written, and
 * the reader cannot tell "the fleet did not measure this" from "the fleet
 * measured nothing worth saying" — which is exactly the silence this issue
 * exists to remove.
 *
 * **The dedup match is author-verified**, for the same reason
 * `escalate_as_work.ts` verifies its own: the match is keyed on a title,
 * anyone who can open an issue chooses a title, and an unverified match does
 * two harmful things at once — it suppresses the flag, and it redirects the
 * flag's contents onto an issue somebody else opened. The match must also be
 * **open**: a closed flag means a human has finished with that PR or branch,
 * and a fresh fallback deserves its own issue rather than reopening a
 * conversation that ended.
 *
 * **The fail direction is towards filing.** An unparseable listing, an
 * unresolvable fleet identity or a label that could not be created all end in
 * a filed issue. A duplicate flag is noise a human closes in a moment; a
 * suppressed one is a fallback nobody ever hears about.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import type { Logger, Result } from "../types.ts";
import {
  ALERT_DEDUP_TITLE_JSON_FIELDS,
  type AlertDedupAuthorOptions,
  type AlertDedupRow,
  selectFleetAuthoredMatches,
} from "./alert_dedup_authors.ts";
import { sanitiseIssueText } from "./conflict_intent_context.ts";
import { spawnGh } from "./gh_spawn.ts";
import { guardedLabelArgs } from "./guarded_issue_labels.ts";
import { ensureLabelExists as defaultEnsureLabelExists } from "./label_operations.ts";

/** Content label marking an issue filed by a conflict fallback. */
export const MERGE_FALLBACK_LABEL = "merge-fallback";

/** Label applied only when the caller asks for the flag to be re-done work. */
const IDLE_TASK_LABEL = "idle-task";

/** Callsite recorded in the label guard's audit line. */
const CALLER = "worker/deno/lib/merge_fallback_issue.ts";

/**
 * Per-run analysis cap, in characters.
 *
 * A GitHub issue body is capped at 65,536 characters, so two unbounded agent
 * replies can make the filing fail outright — the flag lost to the very thing
 * it records. Truncation is announced in the body rather than applied
 * quietly.
 */
const MAX_ANALYSIS_CHARS = 20_000;

/** Rendered in place of any field the fallback could not record. */
const NOT_RECORDED = "not recorded";

/** The PR or milestone branch a fallback ran on. */
export type MergeFallbackTarget =
  | {
    kind: "pr";
    /** Repository in `owner/repo` form — the flag is filed here. */
    repo: string;
    prNumber: number;
    headBranch?: string;
    baseBranch?: string;
  }
  | {
    kind: "milestone";
    repo: string;
    milestoneBranch: string;
    defaultBranch?: string;
  };

/** One stage of one attempt, and the wall-clock seconds it took. */
export interface MergeFallbackStageTiming {
  /** Stage name — `deepen`, `rules`, `context`, `agent`, `gate`, `push`. */
  stage: string;
  /**
   * Whole seconds the stage took, or `null` when it was started and never
   * stopped — rendered as `unfinished`, exactly as `conflict_stage_timer.ts`
   * reports it (Issue #2308). An attempt that died inside the agent is the
   * case these timings exist to show, so it must not render as a duration.
   */
  seconds: number | null;
}

/** One path an abandoned PR changed, as `gh pr view --json files` lists it. */
export interface MergeFallbackDiffFile {
  path: string;
  additions: number;
  deletions: number;
}

/** What one agent run did, and what it cost. */
export interface MergeFallbackRun {
  /** 1-based run number, as the attempt ledger counts it. */
  run: number;
  /** The agent's own reply text. Sanitised before it is rendered. */
  analysis?: string;
  /** Per-stage wall-clock timings for this run. */
  timings?: readonly MergeFallbackStageTiming[];
  /** Host that ran it. */
  host?: string;
}

/** One fallback event, as the flag issue records it. */
export interface MergeFallbackEvent {
  target: MergeFallbackTarget;
  /** Files still conflicted when the fallback was reached. */
  conflictedFiles?: readonly string[];
  /** Both agent runs, in order. */
  runs?: readonly MergeFallbackRun[];
  /** Commits the branch was behind its base. */
  behindBy?: number;
  /** When it first went behind — an ISO timestamp, as the caller read it. */
  behindSince?: string;
  /** What the fallback closed or reverted. */
  fallbackAction?: string;
  /**
   * What the abandoned PR changed (Issue #2310). This is what makes the flag a
   * re-do item for a conflicting PR whose originating issue cannot be found:
   * the PR is closed, so the summary is the only statement of what the work
   * touched. Rendered for a PR target only — a milestone branch has no PR diff.
   */
  diffSummary?: readonly MergeFallbackDiffFile[];
  /** Paths beyond the caller's cap, counted rather than dropped in silence. */
  diffSummaryOmitted?: number;
}

/** A fallback event, plus the one filing choice the caller owns. */
export interface MergeFallbackFiling extends MergeFallbackEvent {
  /**
   * Ask for `idle-task` as well, making the flag the re-do work item — the
   * conflicting PR whose originating issue could not be found (Issue #2298).
   * Applied only through the worker label guard, like every other label.
   */
  requestIdleTask?: boolean;
}

/** What {@link fileMergeFallbackIssue} did. */
export interface MergeFallbackOutcome {
  issueNumber: number;
  /** URL of the flag issue, or "" when `gh` did not report one. */
  url: string;
  /** True when the event was appended to an existing flag issue. */
  appended: boolean;
}

/** Injected seams so the whole path is testable without GitHub. */
export interface MergeFallbackIssueDeps extends AlertDedupAuthorOptions {
  /** Runs `gh`, returning stdout; throws on failure. */
  gh?: (args: string[]) => Promise<string>;
  /** Label creation override (tests). Production: `ensureLabelExists`. */
  ensureLabelExists?: (
    repo: string,
    labelName: string,
    colour?: string,
    description?: string,
  ) => Promise<Result<void>>;
  logger?: Logger;
}

async function defaultGh(args: string[]): Promise<string> {
  const result = await spawnGh(args);
  if (!result.success) {
    throw new Error(
      `gh ${args[0]} ${args[1] ?? ""} failed (exit ${result.code}): ${
        result.stderr.trim() || result.stdout.trim()
      }`,
    );
  }
  return result.stdout;
}

/**
 * Title of the flag issue — also its deduplication key.
 *
 * Deterministic and derived only from the target, so two fallbacks on the
 * same PR or branch land on the same issue however differently they failed.
 */
export function mergeFallbackTitle(target: MergeFallbackTarget): string {
  return target.kind === "pr"
    ? `Merge fallback: ${target.repo} PR #${target.prNumber}`
    : `Merge fallback: ${target.repo} ${target.milestoneBranch}`;
}

/**
 * Marker tying a flag issue to the PR or branch it was raised for.
 *
 * Canonical `vibe-*` grammar — a bare prefix and `key="value"` attributes
 * (Issue #842). Quotes are stripped from the values so a branch name can
 * never close an attribute early.
 */
export function mergeFallbackMarker(target: MergeFallbackTarget): string {
  const attr = (value: string) => sanitiseIssueText(value).replaceAll('"', "");
  const subject = target.kind === "pr"
    ? `pr="${target.prNumber}"`
    : `branch="${attr(target.milestoneBranch)}"`;
  return `<!-- vibe-merge-fallback repo="${attr(target.repo)}" ${subject} -->`;
}

/** One `- **Label**: value` line, saying so when there is no value. */
function field(label: string, value: string | number | undefined): string {
  const rendered = value === undefined || value === ""
    ? NOT_RECORDED
    : sanitiseIssueText(String(value));
  return `- **${label}**: ${rendered}`;
}

/**
 * Fence a block of agent text without letting it escape the fence.
 *
 * The analysis is the agent's own words and may contain a fenced block of
 * its own, so the fence is one backtick longer than the longest run inside
 * it — the CommonMark rule, applied deterministically rather than hoping.
 */
function fenceAnalysis(text: string): string[] {
  const longestRun = Math.max(
    0,
    ...[...text.matchAll(/`+/g)].map((match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return [fence, text, fence];
}

/** The analysis, sanitised and capped, or `not recorded`. */
function renderAnalysis(analysis: string | undefined): string[] {
  const text = analysis === undefined ? "" : sanitiseIssueText(analysis).trim();
  if (text.length === 0) return [`- **Analysis**: ${NOT_RECORDED}`];

  let capped = text.length > MAX_ANALYSIS_CHARS
    ? text.slice(0, MAX_ANALYSIS_CHARS)
    : text;
  // Never cut through a surrogate pair: half an emoji renders as U+FFFD and
  // makes the truncation look like corruption rather than a bound.
  const lastUnit = capped.charCodeAt(capped.length - 1);
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) capped = capped.slice(0, -1);
  const dropped = text.length - capped.length;
  return [
    "- **Analysis**:",
    "",
    ...fenceAnalysis(capped),
    ...(dropped > 0
      ? [
        "",
        `_${dropped} characters truncated — the full reply is in the run log._`,
      ]
      : []),
  ];
}

/** One run's host, timings and analysis. */
function renderRun(run: MergeFallbackRun): string[] {
  const timings = run.timings ?? [];
  return [
    `#### Run ${run.run}`,
    "",
    field("Host", run.host),
    timings.length === 0
      ? `- **Stage timings**: ${NOT_RECORDED}`
      : `- **Stage timings**: ${
        timings
          .map((t) =>
            `${sanitiseIssueText(t.stage)} ${
              t.seconds === null ? "unfinished" : `${t.seconds}s`
            }`
          )
          .join(", ")
      }`,
    ...renderAnalysis(run.analysis),
    "",
  ];
}

/** The target block — which PR or branch, and against what. */
function renderTarget(target: MergeFallbackTarget): string[] {
  if (target.kind === "pr") {
    return [
      field("Repository", target.repo),
      field("Pull request", `#${target.prNumber}`),
      field("Head branch", target.headBranch),
      field("Base branch", target.baseBranch),
    ];
  }
  return [
    field("Repository", target.repo),
    field("Milestone branch", target.milestoneBranch),
    field("Default branch", target.defaultBranch),
  ];
}

/**
 * What the abandoned PR changed, for a PR target (Issue #2310).
 *
 * Rendered only for a PR: a milestone branch has no PR diff, and a
 * `not recorded` section there would say nothing a reader could act on. For a
 * PR it always renders, because "the fleet could not read the diff" and "the
 * PR changed nothing" must not look the same.
 */
function renderDiffSummary(event: MergeFallbackEvent): string[] {
  if (event.target.kind !== "pr") return [];
  const files = event.diffSummary ?? [];
  const omitted = event.diffSummaryOmitted ?? 0;
  return [
    "### What the PR changed",
    "",
    ...(files.length === 0
      ? [NOT_RECORDED]
      : files.map((file) =>
        `- \`${sanitiseIssueText(file.path)}\` ` +
        `(+${file.additions}/-${file.deletions})`
      )),
    ...(omitted > 0
      ? ["", `_${omitted} further path(s) are not listed — the cap was hit._`]
      : []),
    "",
  ];
}

/**
 * Body of the flag issue — and of the comment appended for a repeat event.
 *
 * Pure: the same event always renders the same body. Every field renders,
 * and one the caller could not record renders as `not recorded`.
 */
export function buildMergeFallbackBody(event: MergeFallbackEvent): string {
  const { target, conflictedFiles = [], runs = [] } = event;
  const what = target.kind === "pr"
    ? `${sanitiseIssueText(target.repo)}#${target.prNumber}`
    : `${sanitiseIssueText(target.repo)} \`${
      sanitiseIssueText(target.milestoneBranch)
    }\``;

  return [
    mergeFallbackMarker(target),
    "",
    `The conflict fallback ran on ${what}: both agent runs failed to settle ` +
    "the conflict, so the fleet fell back to the last known good state. " +
    "This issue is the record of that event, filed so the cause can be seen " +
    "and avoided rather than walked into again (Issue #2298).",
    "",
    "### Target",
    "",
    ...renderTarget(target),
    "",
    "### Conflicted files",
    "",
    ...(conflictedFiles.length === 0
      ? [NOT_RECORDED]
      : conflictedFiles.map((path) => `- \`${sanitiseIssueText(path)}\``)),
    "",
    "### Agent runs",
    "",
    ...(runs.length === 0 ? [NOT_RECORDED, ""] : runs.flatMap(renderRun)),
    ...renderDiffSummary(event),
    "### How far behind the base",
    "",
    field("Commits behind the base", event.behindBy),
    field("Behind since", event.behindSince),
    "",
    "### What was closed or reverted",
    "",
    event.fallbackAction === undefined || event.fallbackAction === ""
      ? NOT_RECORDED
      : sanitiseIssueText(event.fallbackAction),
  ].join("\n");
}

/** `--json` fields the dedup search needs: author, exact title, state, URL. */
const DEDUP_JSON_FIELDS = `${ALERT_DEDUP_TITLE_JSON_FIELDS},state,url`;

/** One row of the flag-issue dedup search. */
interface FlagIssueRow extends AlertDedupRow {
  title?: string;
  state?: string;
  url?: string;
}

/**
 * File the `merge-fallback` flag for one fallback event, or append it to the
 * open flag issue already covering this PR or branch.
 *
 * @param filing - The event, and whether the flag is also the re-do task.
 * @param deps - Injected `gh`, label creation, fleet identity and logger.
 * @returns The flag issue, and whether this call appended to an existing one.
 *   A `gh` failure is returned as the error, never swallowed.
 */
export async function fileMergeFallbackIssue(
  filing: MergeFallbackFiling,
  deps: MergeFallbackIssueDeps = {},
): Promise<Result<MergeFallbackOutcome>> {
  const gh = deps.gh ?? defaultGh;
  const { repo } = filing.target;
  const title = mergeFallbackTitle(filing.target);
  const body = buildMergeFallbackBody(filing);
  const log = (message: string) => {
    if (deps.logger?.warn) deps.logger.warn(message, { repo });
    else console.warn(message);
  };

  try {
    const existing = await findOpenFlagIssue(gh, repo, title, deps, log);

    if (existing !== undefined) {
      await gh([
        "issue",
        "comment",
        String(existing.number),
        "--repo",
        repo,
        "--body",
        body,
      ]);
      deps.logger?.info?.("Appended a fallback event to its flag issue", {
        repo,
        issueNumber: existing.number,
      });
      return {
        ok: true,
        value: {
          issueNumber: existing.number,
          url: existing.url ?? "",
          appended: true,
        },
      };
    }

    // The flag is only readable if the label exists. A repo that has never
    // had a fallback has never had the label, so create it on first use —
    // colour and description come from the canonical content-label table.
    const ensure = deps.ensureLabelExists ?? defaultEnsureLabelExists;
    const ensured = await ensure(repo, MERGE_FALLBACK_LABEL);
    if (!ensured.ok) {
      // Said out loud, then pressed on: the label may already exist, and a
      // genuinely missing one fails the create below rather than silently.
      log(
        `[merge-fallback] could not create the \`${MERGE_FALLBACK_LABEL}\` ` +
          `label in ${repo}: ${ensured.error.message}. Filing anyway — the ` +
          "flag matters more than its colour.",
      );
    }

    const created = await gh([
      "issue",
      "create",
      "--repo",
      repo,
      "--title",
      title,
      "--body",
      body,
      ...guardedLabelArgs(
        filing.requestIdleTask
          ? [MERGE_FALLBACK_LABEL, IDLE_TASK_LABEL]
          : [MERGE_FALLBACK_LABEL],
        CALLER,
      ),
    ]);
    const url = created.trim();
    const parsed = Number(url.split("/").pop());
    const issueNumber = Number.isInteger(parsed) ? parsed : 0;
    if (issueNumber === 0) {
      // The issue exists — `gh` did not fail — but nothing can link to it.
      // A `0` handed back silently would read as a filed, findable flag.
      log(
        `[merge-fallback] filed the flag in ${repo} but could not read its ` +
          `number from \`gh issue create\` output (${url || "empty"}). The ` +
          "issue exists; the caller has no number to link it by.",
      );
    }
    deps.logger?.info?.("Filed a conflict fallback as a merge-fallback issue", {
      repo,
      issueNumber,
      idleTask: filing.requestIdleTask === true,
    });
    return { ok: true, value: { issueNumber, url, appended: false } };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * The open, fleet-authored flag issue for this title, if there is one.
 *
 * Unparseable output yields `undefined`, which files a fresh flag: the fail
 * direction is towards a duplicate rather than towards silence.
 */
async function findOpenFlagIssue(
  gh: (args: string[]) => Promise<string>,
  repo: string,
  title: string,
  deps: MergeFallbackIssueDeps,
  log: (message: string) => void,
): Promise<FlagIssueRow | undefined> {
  const listed = await gh([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    // Deliberately not filtered by `--label`: a human who takes the label off
    // a flag issue would otherwise make it invisible here, and the next
    // fallback would file a second flag for the same target. The exact title,
    // the open state and the fleet author are the match.
    "--search",
    `in:title "${title}"`,
    "--json",
    DEDUP_JSON_FIELDS,
  ]);

  let rows: FlagIssueRow[];
  try {
    rows = JSON.parse(listed || "[]") as FlagIssueRow[];
    if (!Array.isArray(rows)) throw new Error("the listing is not an array");
  } catch (error) {
    // Said out loud, never swallowed: dedup is off for this event, so the
    // flag is filed again rather than lost.
    log(
      `[merge-fallback] could not read the dedup listing for ${repo} ` +
        `"${title}": ${
          error instanceof Error ? error.message : String(error)
        }. Filing a fresh flag — a duplicate is recoverable, a lost ` +
        "fallback record is not.",
    );
    return undefined;
  }

  // Belt: the exact title, and an issue GitHub still reports as open. The
  // `--state open` filter above says the same thing, but the flag redirects
  // an event onto whatever it matches, so the state is re-read from the row
  // rather than assumed from the argument.
  const candidates = rows.filter((row) =>
    row.title === title &&
    (row.state === undefined || row.state.toUpperCase() === "OPEN")
  );
  // Braces: and only an issue a fleet account authored.
  const verified = await selectFleetAuthoredMatches(
    candidates,
    `merge fallback ${repo} ${title}`,
    deps,
    log,
    "a fresh flag issue is filed — a fallback event must never be posted " +
      "onto an issue the fleet did not open",
  );
  return verified[0];
}
