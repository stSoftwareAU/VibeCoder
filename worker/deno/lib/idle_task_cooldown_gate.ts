/**
 * Per-repo cooldown gate for idle-task templates (Issue #2104).
 *
 * Before raising a new idle-task wrapper for template T against target
 * repo R, the filer consults this gate to enforce a rolling per-repo
 * window: T fires at most once per `cooldownHours` per repo. The
 * cooldown clock is keyed off the **`createdAt`** of the previous
 * wrapper (or finding), not `closedAt`, so a fast-failing scan still
 * counts towards the window.
 *
 * Source of truth is GitHub issue history (open + closed) across two
 * sources:
 *   (a) wrappers — issues whose title matches
 *       `template.buildIssueTitle(repo)` AND carry the `idle-task` label.
 *   (b) findings — issues that carry `template.outputLabel`, when set.
 *
 * Default window is {@link DEFAULT_COOLDOWN_HOURS} (24h). Templates may
 * override it via the optional `cooldownHours` field on
 * {@link IdleTaskTemplate}.
 *
 * Transient gh failures are warned and treated as "no history found"
 * (i.e. "not cooled down") — matches the `busy_check_failed` pattern in
 * `maybe_file_idle_task.ts` so a transient hiccup never silently
 * disables the filer.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { runGhCommand } from "./github.ts";
import { IDLE_TASK_LABEL } from "./idle_task_issue.ts";
import type { IdleTaskTemplate } from "./idle_task_template.ts";

/**
 * Default cooldown window applied when a template does not declare
 * `cooldownHours`. Fixed at 24 hours per the Issue #2104 scope.
 */
export const DEFAULT_COOLDOWN_HOURS = 24;

/**
 * Bounded query size — we only need the most recent row to make a
 * decision, but allow a small headroom so client-side title filtering
 * (used for the wrapper query) is not starved by adjacent rows.
 */
const HISTORY_LIMIT = 5;

export interface GetLastFiledCreatedAtOptions {
  /** Target repository in `owner/repo` form. */
  repo: string;
  /** Template whose history we want to consult. */
  template: IdleTaskTemplate;
  /** Injectable gh runner — defaults to the production retry wrapper. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /**
   * Warning sink for transient gh failures. Defaults to `console.warn`.
   * Matches the `busy_check_failed` pattern in `maybe_file_idle_task.ts`:
   * a failure is logged and treated as "no history found" so the filer
   * makes its own decision.
   */
  warn?: (message: string) => void;
}

export interface IsRepoCooledDownOptions extends GetLastFiledCreatedAtOptions {
  /** Clock — defaults to `new Date()`. */
  now?: Date;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse a JSON list and return the highest `createdAt` it contains, or
 * `null` when the payload is malformed, empty, or contains no usable
 * `createdAt` values. When `titleFilter` is supplied, only rows whose
 * `title` field matches exactly are considered.
 */
function maxCreatedAt(raw: string, titleFilter?: string): Date | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  let max: Date | null = null;
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    if (titleFilter !== undefined && r.title !== titleFilter) continue;
    const created = typeof r.createdAt === "string" ? r.createdAt : null;
    if (created === null) continue;
    const d = new Date(created);
    if (Number.isNaN(d.getTime())) continue;
    if (max === null || d.getTime() > max.getTime()) max = d;
  }
  return max;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the most recent `createdAt` across the template's wrapper and
 * finding history in `repo`, or `null` when no usable history exists or
 * every gh lookup failed.
 *
 * Bounded queries: `--state all`, `--limit 5`. The query JSON for the
 * wrapper source includes `title` so we can filter to the template's
 * exact `buildIssueTitle(repo)` client-side — `gh issue list` has no
 * exact-title flag.
 */
export async function getLastFiledCreatedAt(
  opts: GetLastFiledCreatedAtOptions,
): Promise<Date | null> {
  const gh = opts.ghCommandFn ?? runGhCommand;
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const { repo, template } = opts;
  const wrapperTitle = template.buildIssueTitle(repo);

  const candidates: Date[] = [];

  // (a) Wrapper history — `idle-task` label + title match.
  try {
    const raw = await gh([
      "issue",
      "list",
      "--repo",
      repo,
      "--label",
      IDLE_TASK_LABEL,
      "--state",
      "all",
      "--json",
      "createdAt,title",
      "--limit",
      String(HISTORY_LIMIT),
    ]);
    const d = maxCreatedAt(raw, wrapperTitle);
    if (d !== null) candidates.push(d);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn(
      `[idle-task] template=${template.name} repo=${repo} action=warn reason=cooldown_wrapper_query_failed message=${message}`,
    );
  }

  // (b) Finding history — by `outputLabel`, when the template declares one.
  if (template.outputLabel !== undefined && template.outputLabel.length > 0) {
    try {
      const raw = await gh([
        "issue",
        "list",
        "--repo",
        repo,
        "--label",
        template.outputLabel,
        "--state",
        "all",
        "--json",
        "createdAt",
        "--limit",
        String(HISTORY_LIMIT),
      ]);
      const d = maxCreatedAt(raw);
      if (d !== null) candidates.push(d);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warn(
        `[idle-task] template=${template.name} repo=${repo} action=warn reason=cooldown_finding_query_failed message=${message}`,
      );
    }
  }

  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (a.getTime() >= b.getTime() ? a : b));
}

/**
 * Convenience predicate: returns `true` when
 * `(now - lastFiledCreatedAt) < cooldownHours * 3600 * 1000`, i.e. the
 * repo is still within the cooldown window. Returns `false` when no
 * history exists, the window has elapsed, or every gh lookup failed —
 * the filer makes its own decision in those cases.
 */
export async function isRepoCooledDown(
  opts: IsRepoCooledDownOptions,
): Promise<boolean> {
  const last = await getLastFiledCreatedAt(opts);
  if (last === null) return false;
  const now = opts.now ?? new Date();
  const windowMs = (opts.template.cooldownHours ?? DEFAULT_COOLDOWN_HOURS) *
    3600 * 1000;
  return now.getTime() - last.getTime() < windowMs;
}
