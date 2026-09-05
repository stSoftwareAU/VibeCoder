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
   * with the remaining repos and the failed repo is treated as
   * "unknown — assume clean", matching the `busy_check_failed` pattern
   * in `maybe_file_idle_task.ts`.
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
 * Returns the first open `idle-task` issue in `opts.repo`, or null when
 * there is none. Any open `idle-task`-labelled issue blocks further
 * idle-task filing — there is no per-template dedup, and no marker is
 * required (Issue #2077).
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    const number = typeof r.number === "number" ? r.number : null;
    const url = typeof r.url === "string" ? r.url : null;
    if (number === null || url === null) continue;
    return { number, url };
  }
  return null;
}

/**
 * Shared scan behind {@link findOpenIdleTaskWrappers} and
 * {@link findAnyOpenIdleTaskWrapper}.
 *
 * Per-repo `gh` failures are logged via `warn` and the failing repo is
 * treated as "unknown — assume clean" so a single transient hiccup never
 * silently disables the filer (matches the existing `busy_check_failed`
 * pattern in `maybe_file_idle_task.ts`).
 */
async function scanForOpenIdleTaskWrappers(
  repos: readonly string[],
  opts: FindAnyOpenIdleTaskOptions,
  stopAtFirst: boolean,
): Promise<ExistingIdleTaskWrapper[]> {
  const gh = opts.ghCommandFn ?? runGhCommand;
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const found: ExistingIdleTaskWrapper[] = [];
  for (const repo of repos) {
    let existing: ExistingIdleTaskIssue | null;
    try {
      existing = await findExistingIdleTaskIssue({ repo, ghCommandFn: gh });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warn(
        `[idle-task] repo=${repo} action=warn reason=cross_repo_check_failed message=${message}`,
      );
      continue;
    }
    if (existing !== null) {
      found.push({ repo, number: existing.number, url: existing.url });
      if (stopAtFirst) return found;
    }
  }
  return found;
}

/**
 * Per-repo wrapper census (Issue #1083). Scans every repo in `repos` and
 * returns one entry for **each** repo already holding an open
 * `idle-task`-labelled issue, in caller order. A clean set returns an empty
 * array.
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
): Promise<ExistingIdleTaskWrapper[]> {
  return scanForOpenIdleTaskWrappers(repos, opts, false);
}

/**
 * Cross-repo dedup query (Issue #2092). Returns the first open
 * `idle-task`-labelled issue found anywhere in `repos`, or `null` when the
 * entire set is clean. The first match in caller order wins — the result is
 * deterministic for a fixed input list, and the scan stops at it.
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
  const found = await scanForOpenIdleTaskWrappers(repos, opts, true);
  return found[0] ?? null;
}
