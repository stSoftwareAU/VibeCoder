/**
 * What the PR-path conflict fallback observed, read back off GitHub
 * (Issue #2310, part of #2298).
 *
 * The fallback closes a PR, and `merge_fallback_issue.ts` files the one record
 * of that event. This module gathers the three things that record needs and
 * neither the scan nor the abandon rung already holds:
 *
 * 1. **each run's stage timings and host**, parsed back out of the conclusion
 *    comments #2308 writes them onto — the run that measured them is long
 *    gone, so the comment is the only surviving source;
 * 2. **how far behind the base the head was, and since when** — `behind_by`
 *    from the compare API, and the `merge-conflict` `labeled` timeline event
 *    the stall watchdog already reads;
 * 3. **what the abandoned PR changed** — the diff summary that turns a flag
 *    issue into a re-do item when the PR's originating issue cannot be found.
 *
 * **Every reader here is best-effort by design, and never silent.** A flag
 * issue that could not be filed is a fallback nobody hears about, so a failed
 * read is logged at WARN and returns nothing — which the flag body renders as
 * `not recorded`, an honest statement rather than an invented number. What must
 * never happen is a read failure stopping the fallback itself.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger } from "../types.ts";
import { getLabelLastAddInfoComplete } from "./issue_query.ts";
import type {
  MergeFallbackDiffFile,
  MergeFallbackStageTiming,
} from "./merge_fallback_issue.ts";
import type { TimelineCache } from "./timeline_cache.ts";

/**
 * Paths one flag issue lists for an abandoned PR.
 *
 * A GitHub issue body is capped, and a PR that touched thousands of files
 * would spend the whole body on paths and lose the analyses that explain the
 * conflict. The count beyond the cap is reported rather than dropped.
 */
export const MAX_DIFF_SUMMARY_PATHS = 200;

/**
 * The timings line `formatStageTimings` renders (Issue #2308).
 *
 * Anchored to a line, and every group bounded, so a comment body of any size
 * costs one linear pass — an unbounded nested group here would be a ReDoS
 * surface on attacker-writable text.
 */
const TIMINGS_LINE = /^Timings \(host `([^`\n]*)`\): *([^\n]*)$/m;

/** `deepen 3s` — one timed stage. */
const STAGE_SECONDS = /^(\S{1,40}) (\d{1,9})s$/;

/** `agent unfinished` — a stage that started and never stopped. */
const STAGE_UNFINISHED = /^(\S{1,40}) unfinished$/;

/**
 * A git ref this module is willing to put in an API path.
 *
 * The refs come off GitHub's own listing, so this cannot fire in practice —
 * it is the defence that keeps it that way: a ref carrying `..`, a query
 * character or a space could redirect the compare call somewhere else
 * entirely, and a redirected read is worse than an unrecorded one.
 */
const SAFE_REF = /^[A-Za-z0-9._\-/]{1,255}$/;

/** What one conclusion comment recorded about the run that wrote it. */
export interface ParsedStageTimings {
  /** The host the run reported, when the line carried one. */
  host?: string;
  /** One entry per stage the line named, in the order it named them. */
  timings: MergeFallbackStageTiming[];
}

/**
 * Read the stage timings and host back out of one conclusion comment.
 *
 * @param body - The comment body, as GitHub returns it
 * @returns The host and stages, or `undefined` when the body carries no
 *   timings line at all — an attempt from before #2308, or one whose run died
 *   before it could write one
 */
export function parseStageTimingsLine(
  body: string,
): ParsedStageTimings | undefined {
  const match = TIMINGS_LINE.exec(body);
  if (match === null) return undefined;

  const host = (match[1] ?? "").trim();
  const timings: MergeFallbackStageTiming[] = [];
  for (const segment of (match[2] ?? "").split("·")) {
    const text = segment.trim();
    if (text.length === 0) continue;
    const timed = STAGE_SECONDS.exec(text);
    if (timed !== null) {
      timings.push({ stage: timed[1] as string, seconds: Number(timed[2]) });
      continue;
    }
    const unfinished = STAGE_UNFINISHED.exec(text);
    if (unfinished !== null) {
      // `null` seconds renders as `unfinished`, which is the whole point of
      // the stage that died: an invented duration would hide it.
      timings.push({ stage: unfinished[1] as string, seconds: null });
    }
    // Anything else is the renderer's own "no stage was timed", or text a
    // later version added. It is not a stage, so it records none.
  }
  return { ...(host.length > 0 ? { host } : {}), timings };
}

/** How far the head had fallen behind its base, and since when. */
export interface PrDivergence {
  /** Commits the base had that the head did not. */
  behindBy?: number;
  /** ISO timestamp the `merge-conflict` label last went on. */
  behindSince?: string;
}

/** Inputs for {@link readPrDivergence}. */
export interface ReadPrDivergenceOptions {
  repo: string;
  prNumber: number;
  /** The base branch the PR targets. */
  baseBranch: string;
  /** The PR's head branch. */
  headBranch: string;
  /** The queue label whose `labeled` event dates the divergence. */
  queueLabel: string;
  gh: (args: string[]) => Promise<string>;
  logger?: Logger;
  /** Shared timeline cache, when the caller keeps one. */
  timelineCache?: TimelineCache;
}

/**
 * Read how far behind the base a conflicting head was, and since when.
 *
 * Never throws: each of the two reads is independent, and a failure in either
 * leaves its field unrecorded rather than costing the flag issue the other.
 *
 * @returns The fields that could be read; an empty object when neither could
 */
export async function readPrDivergence(
  options: ReadPrDivergenceOptions,
): Promise<PrDivergence> {
  const { repo, prNumber, baseBranch, headBranch, gh, logger } = options;
  const divergence: PrDivergence = {};
  const warn = (message: string, error: unknown) => {
    logger?.warn?.(message, {
      repo,
      prNumber,
      error: error instanceof Error ? error.message : String(error),
    });
  };

  if (isSafeRef(baseBranch) && isSafeRef(headBranch)) {
    try {
      const raw = await gh([
        "api",
        `repos/${repo}/compare/${baseBranch}...${headBranch}`,
        "--jq",
        ".behind_by",
      ]);
      const behindBy = Number(raw.trim());
      if (Number.isSafeInteger(behindBy) && behindBy >= 0) {
        divergence.behindBy = behindBy;
      } else {
        warn(
          "Conflict fallback: the compare API reported no usable `behind_by`",
          new Error(`read ${JSON.stringify(raw.trim())}`),
        );
      }
    } catch (error) {
      warn(
        "Conflict fallback: could not compare the head with its base",
        error,
      );
    }
  } else {
    warn(
      "Conflict fallback: refusing to compare an unusable ref",
      new Error(`base=${baseBranch} head=${headBranch}`),
    );
  }

  try {
    const lastAdd = await getLabelLastAddInfoComplete(
      repo,
      prNumber,
      options.queueLabel,
      gh,
      options.timelineCache,
    );
    if (lastAdd !== null) {
      divergence.behindSince = new Date(lastAdd.addedAt * 1000).toISOString();
    } else {
      warn(
        `Conflict fallback: no \`labeled\` event for \`${options.queueLabel}\`` +
          " — the flag cannot say since when",
        new Error("no timeline event"),
      );
    }
  } catch (error) {
    warn("Conflict fallback: could not read the label timeline", error);
  }

  return divergence;
}

/** What an abandoned PR changed, bounded for one issue body. */
export interface PrDiffSummary {
  /** Up to {@link MAX_DIFF_SUMMARY_PATHS} paths, as GitHub listed them. */
  files: MergeFallbackDiffFile[];
  /** Paths beyond the cap, counted rather than dropped in silence. */
  omitted: number;
}

/** Inputs for {@link readPrDiffSummary}. */
export interface ReadPrDiffSummaryOptions {
  repo: string;
  prNumber: number;
  gh: (args: string[]) => Promise<string>;
  logger?: Logger;
}

/**
 * Read the abandoned PR's diff summary — path, additions, deletions.
 *
 * This is what makes a flag issue a re-do item: the PR is closed, so the
 * summary is the only statement of what the work actually touched.
 *
 * @returns The capped summary, or `undefined` when it could not be read —
 *   which the flag body renders as `not recorded`
 */
export async function readPrDiffSummary(
  options: ReadPrDiffSummaryOptions,
): Promise<PrDiffSummary | undefined> {
  const { repo, prNumber, gh, logger } = options;
  try {
    const raw = await gh([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "files",
    ]);
    const parsed: unknown = JSON.parse(raw.trim() || "{}");
    const listed = (parsed as { files?: unknown }).files;
    if (!Array.isArray(listed)) {
      throw new Error("the response carried no `files` array");
    }
    const files: MergeFallbackDiffFile[] = [];
    let seen = 0;
    for (const entry of listed) {
      if (typeof entry !== "object" || entry === null) continue;
      const file = entry as {
        path?: unknown;
        additions?: unknown;
        deletions?: unknown;
      };
      if (typeof file.path !== "string" || file.path.length === 0) continue;
      seen++;
      if (files.length >= MAX_DIFF_SUMMARY_PATHS) continue;
      files.push({
        path: file.path,
        additions: typeof file.additions === "number" ? file.additions : 0,
        deletions: typeof file.deletions === "number" ? file.deletions : 0,
      });
    }
    return { files, omitted: seen - files.length };
  } catch (error) {
    logger?.warn?.(
      "Conflict fallback: could not read the PR's diff summary",
      {
        repo,
        prNumber,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return undefined;
  }
}

/** Whether a ref is safe to interpolate into an API path. */
function isSafeRef(ref: string): boolean {
  return SAFE_REF.test(ref) && !ref.includes("..");
}
