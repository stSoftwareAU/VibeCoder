/**
 * Discovery of *bot-authored* PRs for the maintenance scans (Issue #1846).
 *
 * The five PR-maintenance scans list only fleet-operated PRs (Issue #4076)
 * plus the human PRs that invited the worker in (Issue #4077). A dependency
 * bot's PR is neither, so a failing quality check on a `dependabot[bot]` or
 * `renovate[bot]` PR sat unattended. This module is the third door: it reads
 * the repo's one un-filtered open-PR listing and admits the bot-authored
 * entries whose head branch lives in the target repository.
 *
 * Two boundaries hold:
 *
 * - **Same repository only.** A fork-headed bot PR is dropped with a logged
 *   reason — the worker cannot push a fix to a fork it does not own, so
 *   admitting one would only produce a failed push every cycle. Unknown
 *   ownership (a listing or cache entry that never carried the field) is
 *   dropped by the same rule: fail closed.
 * - **Fail closed on an unreadable listing.** `fetchAllOpenPRs` throws
 *   rather than pass a failed call off as "no open PRs" (Issue #4257); the
 *   failure is logged once and no PR is admitted. Nothing is cached — the
 *   throw happens before the write.
 *
 * The source is the un-filtered listing rather than a per-author loop
 * (`listOpenPrs`) because bot logins cannot be enumerated ahead of time:
 * `gh pr list --author` needs a login, and which bots have opened a PR on a
 * repo is only knowable from the listing itself. That listing is fetched
 * once per repo per cycle (cache key `prs_open_all`), so this door costs no
 * extra API call.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { fetchAllOpenPRs, type OpenPRWithBody } from "./issue_query.ts";
import type { IssueCache } from "./issue_cache.ts";
import { sanitiseLogField } from "./issue_finder_logger.ts";
import { isBotLogin } from "./trust_exclusions.ts";
import type { PrEntry } from "./pr_maintenance.ts";

/** Options for {@link listBotPrs}. */
export interface ListBotPrsOptions {
  /** Repository in "owner/repo" format. */
  repo: string;
  /** Function to run gh commands. */
  ghCommandFn: (args: string[]) => Promise<string>;
  /**
   * Per-cycle listing cache. When supplied, the repo's un-filtered open-PR
   * listing is fetched once per cycle and shared with every other consumer
   * of `prs_open_all`.
   */
  cache?: IssueCache;
  /** Optional `--limit` for the listing. */
  limit?: number;
  /** Optional log sink for admissions and exclusions. */
  log?: (message: string) => void;
}

/** Project one admitted listing entry onto the maintenance scan's shape. */
function toPrEntry(pr: OpenPRWithBody, login: string): PrEntry {
  const entry: PrEntry = {
    number: pr.number,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    title: pr.title,
    author: { login },
    isCrossRepository: false,
  };
  if (pr.headRefOid !== undefined) entry.headRefOid = pr.headRefOid;
  if (pr.autoMergeRequest !== undefined) {
    entry.autoMergeRequest = pr.autoMergeRequest;
  }
  if (pr.mergeable !== undefined) entry.mergeable = pr.mergeable;
  return entry;
}

/**
 * List the open, bot-authored, same-repository PRs of `repo`.
 *
 * @param options - Repo, the gh runner, and the optional cycle cache.
 * @returns The admitted entries in listing order, de-duplicated by number.
 *   An unreadable listing yields an empty array and one logged failure —
 *   never a silent pass.
 */
export async function listBotPrs(
  options: ListBotPrsOptions,
): Promise<PrEntry[]> {
  const { repo, cache, limit, ghCommandFn, log } = options;

  let listing: OpenPRWithBody[];
  try {
    listing = await fetchAllOpenPRs(repo, cache, limit, ghCommandFn);
  } catch (err) {
    log?.(
      `[pr-bot] ${repo}: open PR listing failed: ${
        err instanceof Error ? err.message : String(err)
      } — no bot PR admitted`,
    );
    return [];
  }
  if (!Array.isArray(listing)) {
    // A cached listing is read back untyped, so a garbled entry arrives
    // here as a non-array. That is a failure, not an empty repository.
    log?.(
      `[pr-bot] ${repo}: open PR listing was not an array — ` +
        `no bot PR admitted`,
    );
    return [];
  }

  const admitted: PrEntry[] = [];
  const seen = new Set<number>();
  for (const pr of listing) {
    if (pr === null || typeof pr !== "object") continue;
    if (typeof pr.number !== "number" || seen.has(pr.number)) continue;
    seen.add(pr.number);

    const login = (pr.authorLogin ?? "").trim();
    if (login === "" || !isBotLogin(login)) continue;

    if (pr.isCrossRepository !== false) {
      const reason = pr.isCrossRepository === true
        ? "cross-repository-head"
        : "cross-repository-unknown";
      log?.(
        `[pr-bot] excluded repo=${repo} prNumber=${pr.number} ` +
          `author=${sanitiseLogField(login)} reason=${reason}`,
      );
      continue;
    }

    log?.(
      `[pr-bot] admitted repo=${repo} prNumber=${pr.number} ` +
        `author=${sanitiseLogField(login)}`,
    );
    admitted.push(toPrEntry(pr, login));
  }

  return admitted;
}
