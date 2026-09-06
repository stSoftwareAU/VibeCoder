/**
 * Author verification for the worker's marker-driven dedup searches.
 *
 * Every self-diagnostic escalation the worker files is deduped by searching
 * the target repository for a machine-readable marker in an issue body:
 * `gh issue list --search '"<MARKER>" in:body'`. An issue body is text
 * anyone who can open an issue may write, so a marker match on its own
 * proves nothing — only the issue **author** is authenticated. Without an
 * author check a match written by anybody at all reads as "the alert is
 * already filed", and the escalation stays silent. That is suppression of
 * the fleet's own self-diagnostics: launcher failures, idle inversion,
 * bump-script failures, branch-update failures and idle starvation.
 *
 * `claim_issue.ts` already closes the same gap for `CLAIM_LOCK` comment
 * markers by filtering comment authors through
 * {@link isFleetAuthor} (Issue #3664); this module is that control applied
 * to the body-marker dedup searches, in one place so the five escalation
 * modules cannot drift apart.
 *
 * **The comparison set is the fleet identity** — `service_accounts` ∪
 * `fleet_pr_authors` ∪ this host's own login, i.e.
 * {@link resolveFleetMaintenanceAuthorSet}. Deliberately **not**
 * `--author @me`: cross-host convergence depends on one host finding the
 * issue another host filed, and fleet hosts authenticate as different
 * accounts, so a self-only filter would raise one duplicate alert per host.
 *
 * **The fail direction is always "discard the unverifiable match".** When
 * the fleet author set cannot be resolved — no configuration, an unreadable
 * config — a marker match cannot be attributed, and this module treats it as
 * *no match*. What that means for the caller differs by site, and every
 * caller states its own consequence in the log through `unverifiedOutcome`:
 *
 * - A marker that **suppresses** an action (an alert already filed, a
 *   cooldown, a proposal already raised, a scan already covered) is
 *   discarded, so the action goes ahead. A duplicate alert is noise a human
 *   closes in a moment; a suppressed one is an incident nobody hears about.
 * - A marker that **drives** an action (an issue to close, a label to
 *   write) is discarded, so the write does not happen. An unwanted
 *   destructive write is the one outcome that cannot be undone.
 *
 * The single rule underneath both: *fail towards the action that cannot
 * cause harm*. Discarding the row is that action in both shapes, which is
 * why one helper serves every site. The condition is logged loudly every
 * time so it is visible rather than inferred.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { loadConfig } from "./config.ts";
import { type EnvLookup, processEnvLookup } from "./env_lookup.ts";
import {
  isFleetAuthor,
  resolveFleetMaintenanceAuthorSet,
} from "./fleet_authors.ts";
import type { WorkerConfig } from "../types.ts";

/**
 * The `--json` field list every escalation dedup search must request.
 *
 * `author` is what makes the match verifiable; a search that omits it can
 * only trust the body, which is exactly the defect this module closes.
 */
export const ALERT_DEDUP_JSON_FIELDS = "number,body,author";

/**
 * The `--json` field list a **title**-keyed dedup search must request.
 *
 * A title is as writable as a body — anyone who can open an issue chooses
 * it — so a title-match dedup needs exactly the same author evidence.
 */
export const ALERT_DEDUP_TITLE_JSON_FIELDS = "number,title,author";

/** The `author` object `gh issue list --json author` returns. */
export interface AlertIssueAuthor {
  login?: string | null;
}

/** One row of an escalation dedup search. */
export interface AlertDedupRow {
  number: number;
  body?: string;
  author?: AlertIssueAuthor | null;
}

/**
 * One comment carrying a marker.
 *
 * `gh issue view --json comments` and the worker's own `GitHubComment`
 * both render the author as a bare login rather than the `{ login }`
 * object `gh issue list --json author` returns, so comment-marker sites
 * get their own row shape instead of reshaping the data to fit.
 */
export interface AlertDedupCommentRow {
  author?: string | null;
}

/** Author-verification inputs an escalation module threads through. */
export interface AlertDedupAuthorOptions {
  /**
   * Fleet logins whose markers are trusted. Omitted means "read the
   * configured fleet identity", which is what every production caller
   * does; a test states the fleet instead of writing a config file.
   *
   * An explicitly empty list is an *unresolved* fleet, and is handled the
   * same way an unreadable config is — no match, alert raised, logged.
   */
  fleetAuthors?: readonly string[];
  /** Where `CONFIG_PATH` and `GITHUB_USER` are read from (tests). */
  env?: EnvLookup;
  /** Config loader override (tests). Production: `loadConfig`. */
  loadConfigFn?: (configPath: string) => Promise<WorkerConfig>;
}

/**
 * Resolve the fleet logins whose escalation markers this worker trusts.
 *
 * Reads the configured fleet identity — `service_accounts` and
 * `fleet_pr_authors` (which `loadConfig` has already unioned) plus this
 * host's `GITHUB_USER` — through {@link resolveFleetMaintenanceAuthorSet},
 * so there is no sixth definition of "the fleet" in the worker.
 *
 * Never throws: a config that cannot be read yields an empty set, which
 * callers treat as "cannot verify" and therefore "no match".
 *
 * @param opts - Injected fleet list, env and config loader.
 * @param log - Sink for the loud failure.
 * @returns The trusted logins, or `[]` when they could not be resolved.
 */
export async function resolveAlertDedupAuthors(
  opts: AlertDedupAuthorOptions,
  log: (message: string) => void,
): Promise<string[]> {
  if (opts.fleetAuthors !== undefined) {
    return resolveFleetMaintenanceAuthorSet({
      githubUser: "",
      fleetPrAuthors: [...opts.fleetAuthors],
    });
  }
  const env = opts.env ?? processEnvLookup;
  const load = opts.loadConfigFn ?? loadConfig;
  try {
    const config = await load(env("CONFIG_PATH") ?? ".config.json");
    return resolveFleetMaintenanceAuthorSet({
      githubUser: env("GITHUB_USER") ?? "",
      fleetPrAuthors: config.fleetPrAuthors ?? [],
      serviceAccounts: config.serviceAccounts ?? [],
    });
  } catch (err) {
    log(
      `[alert-dedup] could not load the fleet author set: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * Default consequence sentence — the alerting shape #1095 established.
 *
 * A caller whose marker *drives* an action rather than suppressing one
 * passes its own sentence, because "the escalation is raised" would be a
 * lie in the log of a module that closes issues.
 */
const DEFAULT_UNVERIFIED_OUTCOME =
  "none is treated as an existing alert and the escalation is raised. A " +
  "duplicate alert is recoverable; a suppressed one is not";

/** Shared body of the two selectors — one author check, two row shapes. */
async function selectVerified<T>(
  rows: readonly T[],
  loginOf: (row: T) => string | null | undefined,
  context: string,
  opts: AlertDedupAuthorOptions,
  log: (message: string) => void,
  unverifiedOutcome: string,
): Promise<T[]> {
  if (rows.length === 0) return [];
  const fleet = await resolveAlertDedupAuthors(opts, log);
  if (fleet.length === 0) {
    log(
      `[alert-dedup] ${context}: fleet author set unresolved — cannot ` +
        `verify who wrote ${rows.length} marker match(es), so ` +
        `${unverifiedOutcome}. Configure service_accounts / ` +
        `fleet_pr_authors to restore dedup.`,
    );
    return [];
  }
  const kept = rows.filter((row) => isFleetAuthor(loginOf(row), fleet));
  const discarded = rows.length - kept.length;
  if (discarded > 0) {
    log(
      `[alert-dedup] ${context}: ignored ${discarded} marker match(es) ` +
        `authored outside the fleet — a marker in an issue body is not ` +
        `evidence the fleet filed it.`,
    );
  }
  return kept;
}

/**
 * Keep only the marker matches a fleet account actually authored.
 *
 * Call it with the rows a module's own marker predicate already accepted,
 * so the discard log names genuine marker matches from outside the fleet
 * rather than unrelated search noise.
 *
 * Fail direction: an unresolved fleet author set discards **every** row.
 * See the module comment for why that is the harmless direction whether
 * the marker suppresses an action or drives one.
 *
 * @param rows - Marker-matching rows from the dedup search.
 * @param context - Identifies the dedup site in the log line.
 * @param opts - Author-verification inputs.
 * @param log - Sink for the discard and unresolved-set warnings.
 * @param unverifiedOutcome - What the caller does with an unverifiable
 *   match, in its own words, completing "so …". Defaults to the
 *   alerting shape ("the escalation is raised").
 * @returns The rows authored by a fleet account.
 */
export function selectFleetAuthoredMatches<T extends AlertDedupRow>(
  rows: readonly T[],
  context: string,
  opts: AlertDedupAuthorOptions,
  log: (message: string) => void,
  unverifiedOutcome: string = DEFAULT_UNVERIFIED_OUTCOME,
): Promise<T[]> {
  return selectVerified(
    rows,
    (row) => row.author?.login,
    context,
    opts,
    log,
    unverifiedOutcome,
  );
}

/**
 * Keep only the marker **comments** a fleet account actually authored.
 *
 * The comment shape of {@link selectFleetAuthoredMatches}: a cooldown
 * signal or a retry-attempt tally lives in a comment thread anyone can
 * post to, and the author is the only authenticated part of it.
 *
 * @param rows - Marker-carrying comments.
 * @param context - Identifies the dedup site in the log line.
 * @param opts - Author-verification inputs.
 * @param log - Sink for the discard and unresolved-set warnings.
 * @param unverifiedOutcome - What the caller does with an unverifiable
 *   comment, completing "so …".
 * @returns The comments authored by a fleet account.
 */
export function selectFleetAuthoredComments<T extends AlertDedupCommentRow>(
  rows: readonly T[],
  context: string,
  opts: AlertDedupAuthorOptions,
  log: (message: string) => void,
  unverifiedOutcome: string = DEFAULT_UNVERIFIED_OUTCOME,
): Promise<T[]> {
  return selectVerified(
    rows,
    (row) => row.author,
    context,
    opts,
    log,
    unverifiedOutcome,
  );
}

/**
 * Parse a `gh api …/comments --jq` payload into author-carrying rows
 * (Issue #1249).
 *
 * Three sites now project `{author, …}` off a comment listing so the match can
 * be attributed, and each was writing the same defensive parse: JSON, array
 * check, per-row object check, per-field type check. One helper keeps that
 * shape in a single place, next to the selector the rows are handed to.
 *
 * A payload that is not a JSON array yields `[]` — no rows to attribute, which
 * every caller already treats as "nothing verified".
 *
 * @param raw - The `gh` stdout to parse
 * @param field - The second field each row carries beside `author`
 * @returns One row per parsed comment, with a `null` author when absent
 */
export function parseAuthoredCommentRows(
  raw: string,
  field: string,
): Array<{ author: string | null; value: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const rows: Array<{ author: string | null; value: string }> = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    rows.push({
      author: typeof row.author === "string" ? row.author : null,
      value: typeof row[field] === "string" ? row[field] as string : "",
    });
  }
  return rows;
}
