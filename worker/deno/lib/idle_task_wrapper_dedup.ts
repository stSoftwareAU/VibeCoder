/**
 * Author-verified title-marker dedup for the idle-task wrapper templates and
 * the two trackers that share their shape (Issue #1064 follow-on).
 *
 * Eighteen idle-task templates decide whether to file this run's wrapper by
 * asking GitHub whether one is already open:
 * `gh issue list --search '"<CONSTANT_TITLE>" in:title'`. The titles are
 * compile-time constants in a public repository, so anybody who can open an
 * issue can reproduce one exactly — and the search proved nothing about who
 * wrote the match. Eighteen open issues with guessable titles were therefore
 * enough to convince every host in the fleet that every idle task was already
 * filed, which stops the fleet's entire idle-task supply for that repository.
 * Only the issue **author** is authenticated, so the author is what the
 * decision has to rest on.
 *
 * This module is that control, in one place. It is the title-search sibling of
 * {@link file://./alert_dedup_authors.ts}, which closed the same gap for the
 * five escalation modules' `in:body` marker searches, and it reuses that
 * module's fleet resolution ({@link resolveAlertDedupAuthors}) and row filter
 * ({@link selectFleetAuthoredMatches}) rather than restating either.
 *
 * **One place, not eighteen.** Copy-paste is precisely how the defect spread:
 * each template carried its own near-identical `hasOpen…Wrapper` helper, so
 * the missing author check was written eighteen times. Fixing the same five
 * lines eighteen times would leave the nineteenth template free to copy the
 * eighteenth, so the whole lookup moves here and the templates call it.
 *
 * **The comparison set is the fleet identity** — `service_accounts` ∪
 * `fleet_pr_authors` ∪ this host's `GITHUB_USER`, via
 * `resolveFleetMaintenanceAuthorSet`. Never `config.allowedAuthors`, which is
 * a human permission list and answers a different question (Issue #1064), and
 * never `--author @me`: fleet hosts authenticate as different accounts, and
 * cross-host convergence depends on this host finding the wrapper a sibling
 * host filed.
 *
 * **The fail direction is towards filing.** An unresolvable fleet author set
 * means no match can be attributed, so no match counts and the wrapper is
 * filed. A duplicate wrapper is a recoverable annoyance a human closes in a
 * moment; a silenced idle-task supply is an invisible throughput kill. The
 * condition is logged in full every time by `selectFleetAuthoredMatches`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import {
  ALERT_DEDUP_JSON_FIELDS,
  type AlertDedupAuthorOptions,
  type AlertDedupRow,
  selectFleetAuthoredMatches,
} from "./alert_dedup_authors.ts";
import { parseGhJsonArray } from "./idle_task_snapshot.ts";

/**
 * The `--json` field list a title-marker dedup search must request.
 *
 * `ALERT_DEDUP_JSON_FIELDS` already carries `number,body,author`; `title` is
 * added because this family matches on the title rather than the body. The
 * `author` field is the whole point — a search that omits it can only trust
 * attacker-writable text.
 */
export const TITLE_MARKER_DEDUP_JSON_FIELDS =
  `${ALERT_DEDUP_JSON_FIELDS},title`;

/** One row of a title-marker dedup search. */
export interface TitleMarkerDedupRow extends AlertDedupRow {
  title?: string;
  url?: string;
}

/**
 * A title-marker dedup lookup.
 *
 * Extends {@link AlertDedupAuthorOptions}, so a caller states the fleet with
 * `fleetAuthors` (tests) or omits it and gets the configured fleet identity
 * (every production caller) — the default keeps production behaviour
 * unchanged.
 */
export interface TitleMarkerDedupQuery extends AlertDedupAuthorOptions {
  /** Target repository in `owner/repo` form. */
  repo: string;
  /** The exact title the fleet writes; matches are compared against it. */
  title: string;
  /** Names the lookup in log lines (e.g. `"dead-code wrapper"`). */
  context: string;
  /** Injected `gh` runner. */
  ghCommand: (args: string[]) => Promise<string>;
  /**
   * `--search` expression. Defaults to `"<title>" in:title`, which is what
   * every wrapper template uses; a caller with an existing unquoted spelling
   * passes its own so the server-side query is unchanged.
   */
  searchExpression?: string;
  /** Extra `--json` fields this caller needs (e.g. `["url"]`). */
  extraJsonFields?: readonly string[];
  /** `--limit`. Defaults to 10, the wrapper templates' existing value. */
  limit?: number;
  /** Sink for the author-verification log lines. Defaults to `console.error`. */
  log?: (message: string) => void;
}

/**
 * Return the open issues in `repo` titled exactly `query.title` **and**
 * authored by the fleet.
 *
 * The server-side `in:title` search narrows the candidate set; the exact
 * client-side title comparison guards against the search being fuzzy; the
 * author filter is what makes a surviving match evidence rather than a claim.
 *
 * Throws whatever the injected `gh` runner throws — a lookup that could not be
 * performed must not read as "nothing matched" without the caller choosing
 * that. {@link hasFleetAuthoredOpenIssueTitled} is the variant that does
 * choose it.
 *
 * @param query - The lookup, including author-verification inputs.
 * @returns The fleet-authored matches, in the order gh returned them.
 */
export async function findFleetAuthoredIssuesTitled(
  query: TitleMarkerDedupQuery,
): Promise<TitleMarkerDedupRow[]> {
  const fields = [
    TITLE_MARKER_DEDUP_JSON_FIELDS,
    ...(query.extraJsonFields ?? []),
  ].join(",");
  const raw = await query.ghCommand([
    "issue",
    "list",
    "--repo",
    query.repo,
    "--state",
    "open",
    "--search",
    query.searchExpression ?? `"${query.title}" in:title`,
    "--json",
    fields,
    "--limit",
    String(query.limit ?? 10),
  ]);

  const candidates: TitleMarkerDedupRow[] = [];
  for (const item of parseGhJsonArray(raw, `find ${query.context}`)) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.number !== "number") continue;
    if (typeof row.title !== "string") continue;
    if (row.title.trim() !== query.title) continue;
    candidates.push(row as unknown as TitleMarkerDedupRow);
  }

  const log = query.log ?? ((message: string) => console.error(message));
  return await selectFleetAuthoredMatches(
    candidates,
    query.context,
    query,
    log,
  );
}

/**
 * True when the fleet already has an open issue in `repo` titled exactly
 * `query.title`.
 *
 * A `gh` failure yields `false` — "no wrapper found", so the caller carries on
 * — which is both the behaviour every wrapper template already had and the
 * safe direction here: a transient hiccup must not stall the idle-task supply.
 * An unresolvable fleet author set yields `false` for the same reason.
 *
 * @param query - The lookup, including author-verification inputs.
 * @returns Whether a fleet-authored open issue with that exact title exists.
 */
export async function hasFleetAuthoredOpenIssueTitled(
  query: TitleMarkerDedupQuery,
): Promise<boolean> {
  try {
    return (await findFleetAuthoredIssuesTitled(query)).length > 0;
  } catch {
    return false;
  }
}
