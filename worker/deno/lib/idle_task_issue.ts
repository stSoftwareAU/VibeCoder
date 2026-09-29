/**
 * Idle-task issue dedup helper.
 *
 * The idle-task framework files a real GitHub issue carrying the
 * `idle-task` label whenever the worker has nothing else to do (parent
 * #1959). This module is the dedup gate that prevents two
 * simultaneously-idle workers from filing more than one idle-task issue
 * per repo — any open `idle-task` issue blocks further filing.
 *
 * Issue #2077: filed wrappers are now human-style — title and body
 * read like an issue a person would type, with no hidden
 * `<!-- idle-task: ... -->` marker. Dispatch matches issues to
 * templates by title (see `idle_task_claim_handler.ts`), so the marker
 * is no longer required. As a consequence, dedup is pure label-only:
 * any open `idle-task` issue in the repo counts as a hit, whether the
 * worker or a human filed it.
 *
 * The `idle-task-pending` label (Issue #2055) was retired alongside
 * the `requiresApproval` template flag — `idle-task` is already the
 * lowest priority in the queue, so a separate approval gate added
 * complexity without changing pickup behaviour.
 *
 * Australian English spelling used throughout (behaviour,
 * organisation, etc.).
 */

import { runGhCommand } from "./github.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FindExistingIdleTaskOptions {
  /** Target repository in `owner/repo` form. */
  repo: string;
  /**
   * Idle-task template name — accepted for backwards compatibility but
   * **ignored** (#1984). Dedup is label-only: any open `idle-task`
   * issue in `repo` blocks further filing.
   */
  template?: string;
  /** Injectable gh runner — defaults to the production retry wrapper. */
  ghCommandFn?: (args: string[]) => Promise<string>;
}

export interface ExistingIdleTaskIssue {
  number: number;
  url: string;
  /** Present when the lookup asked for `title` and gh returned a string. */
  title?: string;
}

/**
 * Result of the per-repo wrapper census (Issues #1083, #2750). `wrappers`
 * lists the repos confirmed to hold an open `idle-task` issue; `failedRepos`
 * lists the repos whose lookup failed, in caller order. A failed repo is
 * unknown, never clean — callers must not file into it.
 */
export interface IdleTaskWrapperCensus {
  wrappers: ExistingIdleTaskWrapper[];
  failedRepos: string[];
}

/** Cross-repo lookup result (#2092). */
export interface ExistingIdleTaskWrapper {
  /** Repository where the open `idle-task` wrapper was found. */
  repo: string;
  number: number;
  url: string;
}

export interface FindAnyOpenIdleTaskOptions {
  /** Injectable gh runner — defaults to the production retry wrapper. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /**
   * Optional warning sink for per-repo `gh` failures. Defaults to
   * `console.warn`. When a single repo lookup fails the scan continues
   * with the remaining repos and the failed repo is reported in
   * `failedRepos` — its state is unknown, so it is never treated as clean
   * (fail closed, Issue #2750).
   */
  warn?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Label every filed idle-task issue carries. */
export const IDLE_TASK_LABEL = "idle-task";

// ---------------------------------------------------------------------------
// Dedup query
// ---------------------------------------------------------------------------

/**
 * Parses the JSON printed by
 * `gh issue list --label idle-task --state open --json number[,title],url` into the
 * well-formed entries it holds (Issue #2750). Shared so every open-idle-task
 * gate reads that payload the same way.
 *
 * Fails closed: output that is not JSON, or JSON that is not an array, throws
 * with `repo` in the message rather than reading as "no open issue". Entries
 * lacking a numeric `number` or string `url` are skipped. A string `title` is
 * kept when the query asked for it (Issue #2752).
 */
export function parseOpenIdleTaskIssues(
  raw: string,
  repo: string,
): ExistingIdleTaskIssue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `open idle-task lookup for ${repo} returned non-JSON output: ${message}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `open idle-task lookup for ${repo} returned a non-array JSON value`,
    );
  }

  const issues: ExistingIdleTaskIssue[] = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    if (typeof r.number !== "number" || typeof r.url !== "string") continue;
    issues.push(
      typeof r.title === "string"
        ? { number: r.number, url: r.url, title: r.title }
        : { number: r.number, url: r.url },
    );
  }
  return issues;
}

/**
 * Returns the first open `idle-task` issue in `opts.repo`, or null when
 * there is none. Any open `idle-task`-labelled issue blocks further
 * idle-task filing — there is no per-template dedup, and no marker is
 * required (Issue #2077).
 *
 * Throws when `gh` fails or prints malformed output (Issue #2750): only a
 * well-formed empty list means "no open issue".
 */
export async function findExistingIdleTaskIssue(
  opts: FindExistingIdleTaskOptions,
): Promise<ExistingIdleTaskIssue | null> {
  const gh = opts.ghCommandFn ?? runGhCommand;
  const raw = await gh([
    "issue",
    "list",
    "--repo",
    opts.repo,
    "--label",
    IDLE_TASK_LABEL,
    "--state",
    "open",
    "--json",
    "number,url",
    "--limit",
    "200",
  ]);
  return parseOpenIdleTaskIssues(raw, opts.repo)[0] ?? null;
}

/**
 * Shared scan behind {@link findOpenIdleTaskWrappers} and
 * {@link findAnyOpenIdleTaskWrapper}.
 *
 * Per-repo lookup failures are logged via `warn` and reported in
 * `failedRepos` (Issue #2750): the failing repo's state is unknown, so it is
 * never treated as clean. The scan still continues, so one repo's hiccup does
 * not hide the state of the others.
 */
async function scanForOpenIdleTaskWrappers(
  repos: readonly string[],
  opts: FindAnyOpenIdleTaskOptions,
  stopAtFirst: boolean,
): Promise<IdleTaskWrapperCensus> {
  const gh = opts.ghCommandFn ?? runGhCommand;
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const found: ExistingIdleTaskWrapper[] = [];
  const failedRepos: string[] = [];
  for (const repo of repos) {
    let existing: ExistingIdleTaskIssue | null;
    try {
      existing = await findExistingIdleTaskIssue({ repo, ghCommandFn: gh });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warn(
        `[idle-task] repo=${repo} action=warn reason=cross_repo_check_failed message=${message}`,
      );
      failedRepos.push(repo);
      continue;
    }
    if (existing !== null) {
      found.push({ repo, number: existing.number, url: existing.url });
      if (stopAtFirst) break;
    }
  }
  return { wrappers: found, failedRepos };
}

/**
 * Per-repo wrapper census (Issue #1083). Scans every repo in `repos` and
 * returns one entry for **each** repo already holding an open
 * `idle-task`-labelled issue, in caller order, plus every repo whose lookup
 * failed (`failedRepos`, Issue #2750). Only a repo in neither list is clean.
 *
 * The filer subtracts this from the monitored set rather than short-circuiting
 * on it: the operator's concurrency rule is *one issue in flight per work
 * stream*, and applied to idle work that reads "at most one open wrapper **per
 * repository**". The previous fleet-wide maximum of one (Issue #2092) was a
 * far stronger constraint than the rule asks for, and it capped the fleet at a
 * single filled idle slot however many empty repositories were available:
 * measured live at four Vibe Coders, eight slots, two issues in flight and
 * exactly one idle task (Issue #1083).
 *
 * #2089's protection is kept, because its fault was **fan-out from a
 * shuffle** rather than plurality: a repository still never accumulates two
 * open wrappers (this census excludes it), and a single idle tick still files
 * at most one wrapper, so the next tick re-decides from fresh state.
 */
export function findOpenIdleTaskWrappers(
  repos: readonly string[],
  opts: FindAnyOpenIdleTaskOptions = {},
): Promise<IdleTaskWrapperCensus> {
  return scanForOpenIdleTaskWrappers(repos, opts, false);
}

/**
 * Cross-repo dedup query (Issue #2092). Returns the first open
 * `idle-task`-labelled issue found anywhere in `repos`, or `null` when the
 * entire set is confirmed clean. Throws when no wrapper was found but at least
 * one repo's lookup failed (Issue #2750) — an unknown repo is never clean. The
 * first match in caller order wins — the result is deterministic for a fixed
 * input list, and the scan stops at it.
 *
 * This answers "does the monitored set hold **any** wrapper?". It is no
 * longer what gates filing — see {@link findOpenIdleTaskWrappers} for why —
 * and remains for callers that only need existence, at one `gh` call rather
 * than one per repository.
 */
export async function findAnyOpenIdleTaskWrapper(
  repos: readonly string[],
  opts: FindAnyOpenIdleTaskOptions = {},
): Promise<ExistingIdleTaskWrapper | null> {
  const census = await scanForOpenIdleTaskWrappers(repos, opts, true);
  const first = census.wrappers[0];
  if (first !== undefined) return first;
  if (census.failedRepos.length > 0) {
    throw new Error(
      `open idle-task lookup failed for: ${census.failedRepos.join(", ")}`,
    );
  }
  return null;
}
