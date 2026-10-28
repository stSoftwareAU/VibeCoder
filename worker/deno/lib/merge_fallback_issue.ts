/**
 * The `merge-fallback` record every conflict fallback leaves behind
 * (Issue #2304, part of #2298), filed in VibeCoder as a worker failure
 * (Issue #4456).
 *
 * A fallback means the worker failed to finish the work, so it is never filed
 * as a new issue in the repository the conflict was in: that read as a fresh
 * work item instead of the worker completing the one it had. It is filed in
 * {@link MERGE_FALLBACK_TARGET_REPO}, labelled `bug`, with one open issue per
 * cause; a repeat appends a comment. VibeCoder is public, so a private source
 * repository is never named there: its repository, branches, PR, paths and
 * the agents' full replies are left out, and only the host, the timings, each
 * run's conclusion and how far behind the branch was are recorded.
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
 * **The dedup match is author-verified**, for the same reason every
 * title-keyed dedup in the worker verifies its own: the match is keyed on a
 * title, anyone who can open an issue chooses a title, and an unverified match
 * does two harmful things at once — it suppresses the flag, and it redirects the
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

/**
 * Where every fallback is filed (Issue #4456): a fallback is the worker's
 * failure, whichever monitored repository the conflict was in.
 */
export const MERGE_FALLBACK_TARGET_REPO = "stSoftwareAU/VibeCoder";

/** Worker-fault label every fallback record carries. */
const BUG_LABEL = "bug";

/** Title and cause when no conclusion names one. */
const UNCLASSIFIED_CAUSE = "unclassified";

/** Longest cause kept in a title. */
const MAX_CAUSE_CHARS = 100;

/** Whether the source repository may be named in VibeCoder. */
export type SourceVisibility = "public" | "private";

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
   * Whole seconds the stage took, or `null` for a stage that started and
   * never stopped (Issue #2311) — rendered `unfinished`, exactly as
   * `conflict_stage_timer.ts` reports it (Issue #2308). An attempt that died
   * inside the agent is the case these timings exist to show, so it must not
   * render as a duration.
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
   * What a conflicting PR with no originating issue changed (Issue #2310),
   * rendered only for a public source. Absent means the fallback did not read one — a milestone branch has
   * no PR diff, and the route that re-queues an originating issue does not need
   * one — and the section is then not rendered at all, rather than claiming a
   * read that was never attempted.
   */
  diffSummary?: readonly MergeFallbackDiffFile[];
  /** Paths beyond the caller's cap, counted rather than dropped in silence. */
  diffSummaryOmitted?: number;
  /**
   * Why the fallback was reached, when the caller knows it. Absent, it is read
   * from the last run's conclusion line ({@link mergeFallbackCause}).
   */
  cause?: string;
}

/** What a caller hands {@link fileMergeFallbackIssue}. */
export type MergeFallbackFiling = MergeFallbackEvent;

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

/** The names a private source would be recognised by, longest first. */
function sourceNames(target: MergeFallbackTarget): string[] {
  const names = [
    target.repo,
    target.repo.split("/").pop() ?? "",
    ...(target.kind === "pr"
      ? [target.headBranch ?? "", target.baseBranch ?? ""]
      : [target.milestoneBranch, target.defaultBranch ?? ""]),
  ];
  return [...new Set(names.filter((name) => name.length > 0))]
    .sort((a, b) => b.length - a.length);
}

/**
 * Text with nothing that names a private source: its repository and branch
 * names, any path or slash-joined name, and any `#N` — a bare number in
 * VibeCoder links to an unrelated VibeCoder issue.
 */
function scrubPrivate(text: string, target: MergeFallbackTarget): string {
  let scrubbed = text;
  for (const name of sourceNames(target)) {
    scrubbed = replaceWord(scrubbed, name, "<source>");
  }
  return scrubbed
    .replace(/[^\s`'"(),]*\/[^\s`'"(),]*/g, "<path>")
    .replace(/#(\d+)/g, "number $1");
}

/** A character that continues a name, so a match inside a longer one is left. */
function isNameChar(char: string | undefined): boolean {
  return char !== undefined && /[\w/-]/.test(char);
}

/**
 * Every whole-word, case-insensitive occurrence of `word` replaced. A plain
 * scan rather than a regular expression built from the name, so no name can
 * change the pattern.
 */
function replaceWord(text: string, word: string, replacement: string): string {
  const haystack = text.toLowerCase();
  const needle = word.toLowerCase();
  let out = "";
  let from = 0;
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, at + 1)
  ) {
    if (at < from) continue;
    const end = at + needle.length;
    if (isNameChar(text[at - 1]) || isNameChar(text[end])) continue;
    out += text.slice(from, at) + replacement;
    from = end;
  }
  return out + text.slice(from);
}

/** `#N` qualified as `owner/repo#N`, so it never links to a VibeCoder issue. */
function qualifyReferences(text: string, repo: string): string {
  return text.replace(/(^|[^\w/.-])#(\d+)\b/g, `$1${repo}#$2`);
}

/** One conclusion line, as the milestone ledger writes it. */
const CONCLUSION_RE = /^Concluded `[^`]+` at \S+: (.+)$/m;

/** A refusal that climbed, wrapping the reason it was refused for. */
const REFUSAL_CLIMB_RE = /^refused \d+ cycles? in a row \((.+)\) — climbing/;

/** The conclusion line of one run, when it wrote one. */
function conclusionLine(run: MergeFallbackRun): string | undefined {
  const match = CONCLUSION_RE.exec(run.analysis ?? "");
  return match ? match[0] : undefined;
}

/**
 * Why the fallback was reached — the deduplication key (Issue #4456).
 *
 * The caller's explicit cause, else the last run's conclusion with a refusal
 * climb unwrapped to the reason that was refused and anything after the first
 * colon dropped, so measurements that vary per event cannot split one cause
 * into many issues. Names of the source are scrubbed whatever its
 * visibility, so one cause has one title across every repository.
 *
 * @param event - The fallback event
 * @returns A short, repository-agnostic cause
 */
export function mergeFallbackCause(event: MergeFallbackEvent): string {
  let cause = event.cause?.trim() ?? "";
  if (cause === "") {
    const last = event.runs?.at(-1);
    const match = CONCLUSION_RE.exec(last?.analysis ?? "");
    if (match) {
      const reason = match[1]!.trim();
      const climbed = REFUSAL_CLIMB_RE.exec(reason);
      cause = (climbed ? climbed[1]! : reason).split(":")[0]!.trim();
    }
  }
  cause = scrubPrivate(sanitiseIssueText(cause), event.target)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CAUSE_CHARS);
  return cause === "" ? UNCLASSIFIED_CAUSE : cause;
}

/**
 * Title of the fallback record — also its deduplication key: one open issue
 * per cause, whichever repository or branch it happened on (Issue #4456).
 */
export function mergeFallbackTitle(event: MergeFallbackEvent): string {
  return `Merge fallback: ${mergeFallbackCause(event)}`;
}

/**
 * Marker tying a record to its cause.
 *
 * Canonical `vibe-*` grammar — a bare prefix and `key="value"` attributes
 * (Issue #842). Quotes are stripped so a cause can never close the attribute
 * early, and no source repository is named.
 */
export function mergeFallbackMarker(event: MergeFallbackEvent): string {
  const cause = mergeFallbackCause(event).replaceAll('"', "");
  return `<!-- vibe-merge-fallback cause="${cause}" -->`;
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

/** The analysis, sanitised, qualified by repo and capped, or `not recorded`. */
function renderAnalysis(analysis: string | undefined, repo: string): string[] {
  const text = analysis === undefined
    ? ""
    : qualifyReferences(sanitiseIssueText(analysis), repo).trim();
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

/** One run's stage timings line. */
function renderTimings(run: MergeFallbackRun): string {
  const timings = run.timings ?? [];
  return timings.length === 0
    ? `- **Stage timings**: ${NOT_RECORDED}`
    : `- **Stage timings**: ${
      timings
        .map((t) =>
          `${sanitiseIssueText(t.stage)} ${
            t.seconds === null ? "unfinished" : `${t.seconds}s`
          }`
        )
        .join(", ")
    }`;
}

/** One run's host, timings and analysis. */
function renderRun(run: MergeFallbackRun, repo: string): string[] {
  return [
    `#### Run ${run.run}`,
    "",
    field("Host", run.host),
    renderTimings(run),
    ...renderAnalysis(run.analysis, repo),
    "",
  ];
}

/** One run of a private source: host, timings and its conclusion only. */
function renderPrivateRun(
  run: MergeFallbackRun,
  target: MergeFallbackTarget,
): string[] {
  const conclusion = conclusionLine(run);
  return [
    `#### Run ${run.run}`,
    "",
    field("Host", run.host),
    renderTimings(run),
    conclusion === undefined
      ? `- **Conclusion**: ${NOT_RECORDED}`
      : `- **Conclusion**: ${
        scrubPrivate(sanitiseIssueText(conclusion), target)
      }`,
    "",
  ];
}

/** The target block — which PR or branch, and against what. */
function renderTarget(target: MergeFallbackTarget): string[] {
  if (target.kind === "pr") {
    return [
      field("Repository", target.repo),
      field("Pull request", `${target.repo}#${target.prNumber}`),
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
 * What the abandoned PR changed, when the fallback read it (Issue #2310).
 *
 * The section renders only when {@link MergeFallbackEvent.diffSummary} is
 * present, because absent means nobody asked: a milestone branch has no PR diff
 * at all, and the PR route that re-queues an originating issue needs none.
 * Printing `not recorded` for a read nobody
 * attempted would claim a measurement failure that never happened.
 *
 * A summary that **was** read and came back empty says so in words, so "GitHub
 * reported no changed file" is never mistaken for "the diff was not read".
 */
function renderDiffSummary(event: MergeFallbackEvent): string[] {
  const files = event.diffSummary;
  if (files === undefined) return [];
  const omitted = event.diffSummaryOmitted ?? 0;
  return [
    "### What the PR changed",
    "",
    ...(files.length === 0
      ? ["GitHub reported no changed file for this PR."]
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
 * Body of the fallback record — and of the comment appended for a repeat.
 *
 * Pure: the same event and visibility always render the same body. A public
 * source renders every field, one the caller could not record as
 * `not recorded`, with each `#N` qualified by its repository. A private
 * source — the default, so an unknown visibility never leaks — renders only
 * what names nothing of it (Issue #4456).
 */
export function buildMergeFallbackBody(
  event: MergeFallbackEvent,
  visibility: SourceVisibility = "private",
): string {
  return visibility === "public"
    ? buildPublicBody(event)
    : buildPrivateBody(event);
}

function buildPrivateBody(event: MergeFallbackEvent): string {
  const { target, runs = [] } = event;
  const kind = target.kind === "pr" ? "a pull request" : "a milestone branch";
  return [
    mergeFallbackMarker(event),
    "",
    `The conflict fallback ran on ${kind} of a private monitored ` +
    "repository: the agent runs could not settle the conflict, so the fleet " +
    "fell back. A fallback is a worker failure (Issue #4456). The source is " +
    "private, so its repository, branches, paths and the agents' full " +
    "replies are left out; the hosts and times below find them in each " +
    "host's run log.",
    "",
    "### Cause",
    "",
    mergeFallbackCause(event),
    "",
    "### Agent runs",
    "",
    ...(runs.length === 0
      ? [NOT_RECORDED, ""]
      : runs.flatMap((run) => renderPrivateRun(run, target))),
    "### How far behind the base",
    "",
    field("Commits behind the base", event.behindBy),
    field("Behind since", event.behindSince),
  ].join("\n");
}

function buildPublicBody(event: MergeFallbackEvent): string {
  const { target, conflictedFiles = [], runs = [] } = event;
  const repo = sanitiseIssueText(target.repo);
  const what = target.kind === "pr"
    ? `${repo}#${target.prNumber}`
    : `${repo} \`${sanitiseIssueText(target.milestoneBranch)}\``;

  return [
    mergeFallbackMarker(event),
    "",
    `The conflict fallback ran on ${what}: the agent runs could not settle ` +
    "the conflict, so the fleet fell back. A fallback is a worker failure, " +
    "recorded here so the cause can be fixed rather than walked into again " +
    "(Issues #2298, #4456).",
    "",
    "### Cause",
    "",
    mergeFallbackCause(event),
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
    ...(runs.length === 0
      ? [NOT_RECORDED, ""]
      : runs.flatMap((run) => renderRun(run, repo))),
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
      : qualifyReferences(sanitiseIssueText(event.fallbackAction), repo),
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
 * The source repository's visibility, read through the caller's `gh`.
 *
 * Anything but an explicit `public` — an error, an empty answer, `internal` —
 * is private, so a failed lookup never names a private repository.
 */
async function sourceVisibility(
  gh: (args: string[]) => Promise<string>,
  repo: string,
): Promise<SourceVisibility> {
  try {
    const answer = await gh(["api", `repos/${repo}`, "--jq", ".visibility"]);
    return answer.trim().toLowerCase() === "public" ? "public" : "private";
  } catch {
    return "private";
  }
}

/**
 * File one fallback event in VibeCoder as a worker failure, or append it to
 * the open record for the same cause (Issue #4456).
 *
 * @param filing - The event.
 * @param deps - Injected `gh`, label creation, fleet identity and logger.
 * @returns The flag issue, and whether this call appended to an existing one.
 *   A `gh` failure is returned as the error, never swallowed.
 */
export async function fileMergeFallbackIssue(
  filing: MergeFallbackFiling,
  deps: MergeFallbackIssueDeps = {},
): Promise<Result<MergeFallbackOutcome>> {
  const gh = deps.gh ?? defaultGh;
  const repo = MERGE_FALLBACK_TARGET_REPO;
  const title = mergeFallbackTitle(filing);
  const body = buildMergeFallbackBody(
    filing,
    await sourceVisibility(gh, filing.target.repo),
  );
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
      ...guardedLabelArgs([BUG_LABEL, MERGE_FALLBACK_LABEL], CALLER),
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
    deps.logger?.info?.("Filed a conflict fallback as a VibeCoder failure", {
      repo,
      issueNumber,
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
 * The filer both PR-path fallback routes use, bound to one `gh` (Issue #2310).
 *
 * One definition of the wiring rather than two: the label creation has to be
 * routed through the caller's own `gh` — the default reaches the real CLI — and
 * a second copy of that closure is a second thing to get wrong.
 *
 * @param deps - The caller's `gh`, its logger, and the fleet identity the
 *   dedup match is verified against
 * @returns A filer taking only the filing, for use as an injected seam
 */
export function createFallbackFlagFiler(deps: {
  gh: (args: string[]) => Promise<string>;
  logger?: Logger;
  fleetAuthors?: readonly string[];
}): (filing: MergeFallbackFiling) => Promise<Result<MergeFallbackOutcome>> {
  return (filing: MergeFallbackFiling) =>
    fileMergeFallbackIssue(filing, {
      gh: deps.gh,
      ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
      ...(deps.fleetAuthors !== undefined
        ? { fleetAuthors: deps.fleetAuthors }
        : {}),
      ensureLabelExists: (
        repo: string,
        labelName: string,
        colour?: string,
        description?: string,
      ) =>
        defaultEnsureLabelExists(repo, labelName, colour, description, {
          ghCommandFn: deps.gh,
        }),
    });
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
