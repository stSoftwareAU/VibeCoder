/**
 * Discovery of *invited* human-authored PRs (Issue #4077).
 *
 * The five PR-maintenance scans list only fleet-operated PRs since
 * Issue #4076. This module is the narrow, audited door back in: it lists
 * the open PRs authored by trusted humans (`allowed_authors`) and admits
 * only those where {@link isPrInvited} says a trusted human handed the PR
 * over — by applying the invite label, or by @mentioning the fleet in a
 * comment or review.
 *
 * Everything the predicate needs arrives in a single `gh pr list` call
 * (`labels`, `comments`, `reviews`, `author`). Only a PR that actually
 * carries the invite label costs an extra timeline read, which is what
 * establishes *who* applied it — label presence alone never admits a PR.
 *
 * Every admission emits one structured log line so an intervention on a
 * human's PR is always traceable to its invitation.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { getLabelLastAddInfoComplete } from "./issue_query.ts";
import type { IssueCache } from "./issue_cache.ts";
import { sanitiseLogField } from "./issue_finder_logger.ts";
import { resolveFleetMaintenanceAuthorSet } from "./fleet_authors.ts";
import {
  DEFAULT_INVITE_LABEL,
  type InvitationComment,
  type InvitationPr,
  isPrInvited,
} from "./pr_invitation.ts";

/**
 * Fields the invitation listing always requests on top of the caller's own.
 *
 * Exported so tests can tell an invitation listing apart from a
 * maintenance listing by the `--json` argument alone.
 */
export const INVITATION_PR_FIELDS: readonly string[] = [
  "number",
  "author",
  "labels",
  "comments",
  "reviews",
] as const;

/**
 * The fixed field superset the invitation listing fetches when a per-cycle
 * cache is supplied (Issue #41). It must cover every scan's needs — the same
 * union the cached fleet listing (`PR_MAINTENANCE_LIST_FIELDS`) carries plus
 * the invitation predicate's fields — so a single fetch per repo×author per
 * cycle can be served to all 4–6 scans regardless of the fields each asked
 * for. Kept a literal here to avoid a cycle with pr_maintenance.ts.
 */
export const INVITATION_CACHE_FIELDS =
  "number,title,headRefName,headRefOid,baseRefName,autoMergeRequest," +
  "createdAt,updatedAt,author,mergeable,labels,comments,reviews";

/** Options for {@link listInvitedHumanPrs}. */
export interface ListInvitedHumanPrsOptions {
  /** Repository in "owner/repo" format. */
  repo: string;
  /** The current host's GitHub login. */
  githubUser: string;
  /** Trusted humans (`allowed_authors`) — the only accounts that may invite. */
  allowedAuthors?: readonly string[];
  /** Sibling fleet logins (`fleet_pr_authors`). */
  fleetPrAuthors?: readonly string[];
  /** Invitation label name. Defaults to `work-on`. */
  inviteLabel?: string;
  /** Comma-separated `--json` fields the calling scan needs. */
  fields: string;
  /** Optional `--limit` for the listing. */
  limit?: number;
  /** Function to run gh commands. */
  ghCommandFn: (args: string[]) => Promise<string>;
  /** Optional log sink for admissions and failures. */
  log?: (message: string) => void;
  /**
   * Per-cycle listing cache (Issue #41). When supplied, each repo×author
   * invitation listing is fetched once per cycle (with {@link
   * INVITATION_CACHE_FIELDS}) and served to every scan, instead of one
   * `gh pr list` per author per scan — the #4303 saving applied to #4077.
   */
  cache?: IssueCache;
}

/** Merge the caller's fields with the invitation fields, preserving order. */
function mergeFields(fields: string): string {
  const requested = fields.split(",").map((f) => f.trim()).filter((f) =>
    f.length > 0
  );
  const merged = [...requested];
  for (const field of INVITATION_PR_FIELDS) {
    if (!merged.includes(field)) merged.push(field);
  }
  return merged.join(",");
}

/** Lower-cased, blank-free view of a configured login list. */
function normalise(logins: readonly string[] | undefined): string[] {
  return (logins ?? [])
    .filter((l): l is string => typeof l === "string")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * The human logins to list: trusted authors that are not fleet accounts.
 *
 * A login in both lists is already covered by the maintenance listing, so
 * querying it again would only duplicate work.
 */
function resolveHumanAuthors(options: ListInvitedHumanPrsOptions): string[] {
  const fleet = resolveFleetMaintenanceAuthorSet({
    githubUser: options.githubUser,
    fleetPrAuthors: options.fleetPrAuthors,
  }).map((l) => l.toLowerCase());
  const seen = new Set<string>();
  const humans: string[] = [];
  for (const login of normalise(options.allowedAuthors)) {
    const key = login.toLowerCase();
    if (fleet.includes(key) || seen.has(key)) continue;
    seen.add(key);
    humans.push(login);
  }
  return humans;
}

/** Coerce a `gh` comment/review array into the predicate's shape. */
function toComments(value: unknown): InvitationComment[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is InvitationComment =>
    entry !== null && typeof entry === "object"
  );
}

/** Names of the labels currently on a listed PR. */
function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    const name = (entry as { name?: unknown } | null)?.name;
    if (typeof name === "string" && name.trim().length > 0) names.push(name);
  }
  return names;
}

/**
 * List the open PRs authored by trusted humans that have explicitly invited
 * the worker.
 *
 * Uninvited human PRs are dropped silently — that is the #4076 default and
 * not a fault. Failures (an unreadable listing, an unreadable timeline) are
 * logged and fail **closed**: the PR is not admitted.
 *
 * @param options - Repo, author configuration, fields, and the gh runner.
 * @returns The admitted PR entries, in listing order, de-duplicated by
 *   number. Typed as the caller's own listing shape — the entries are the
 *   parsed `gh pr list` objects with the invitation fields added.
 */
/**
 * Run one `gh pr list --author <author>` invitation listing with the given
 * (already-merged) `--json` fields. Returns the parsed array, or `null` when
 * the listing could not be read — logged, never silent (no PR is admitted
 * from an unreadable listing).
 */
async function fetchInvitationListing(
  repo: string,
  author: string,
  jsonFields: string,
  options: ListInvitedHumanPrsOptions,
): Promise<unknown[] | null> {
  const args = [
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--author",
    author,
    "--json",
    jsonFields,
  ];
  if (typeof options.limit === "number") {
    args.push("--limit", String(options.limit));
  }
  try {
    const parsed = JSON.parse(await options.ghCommandFn(args));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    options.log?.(
      `[pr-invitation] ${repo}: invitation listing for author ` +
        `${sanitiseLogField(author)} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
    return null;
  }
}

export async function listInvitedHumanPrs<T extends { number: number }>(
  options: ListInvitedHumanPrsOptions,
): Promise<T[]> {
  const { repo, log } = options;
  const humans = resolveHumanAuthors(options);
  if (humans.length === 0) return [];

  const inviteLabel = (options.inviteLabel ?? DEFAULT_INVITE_LABEL).trim();
  const fields = mergeFields(options.fields);
  const admitted: T[] = [];
  const seen = new Set<number>();

  for (const author of humans) {
    // Issue #41: served once per cycle from the cache when one is supplied,
    // fetched with the fixed superset so every scan reads the fields it needs.
    const cacheKey = `prs_invited_${author}`;
    let parsed: unknown;
    if (options.cache) {
      const cached = await options.cache.read<unknown[]>(repo, cacheKey);
      if (cached !== null) {
        parsed = cached;
      } else {
        const fetched = await fetchInvitationListing(
          repo,
          author,
          INVITATION_CACHE_FIELDS,
          options,
        );
        if (fetched === null) continue;
        parsed = fetched;
        if (Array.isArray(parsed)) {
          await options.cache.write(repo, cacheKey, parsed);
        }
      }
    } else {
      const fetched = await fetchInvitationListing(
        repo,
        author,
        fields,
        options,
      );
      if (fetched === null) continue;
      parsed = fetched;
    }
    if (!Array.isArray(parsed)) continue;

    for (const entry of parsed) {
      if (entry === null || typeof entry !== "object") continue;
      const pr = entry as Record<string, unknown>;
      const prNumber = typeof pr.number === "number" ? pr.number : null;
      if (prNumber === null || seen.has(prNumber)) continue;
      seen.add(prNumber);

      const invitation = isPrInvited(
        await buildInvitationPr(repo, prNumber, pr, inviteLabel, options),
        {
          githubUser: options.githubUser,
          allowedAuthors: options.allowedAuthors,
          fleetPrAuthors: options.fleetPrAuthors,
          inviteLabel,
        },
      );
      if (!invitation.invited) continue;

      log?.(
        `[pr-invitation] admitted repo=${repo} prNumber=${prNumber} ` +
          `author=${sanitiseLogField(author)} via=${invitation.via} ` +
          `invitedBy=${sanitiseLogField(invitation.invitedBy ?? "")}`,
      );
      admitted.push(entry as T);
    }
  }

  return admitted;
}

/**
 * Assemble the facts {@link isPrInvited} decides on for one listed PR.
 *
 * The only extra network call is the timeline read that establishes who
 * applied the invite label, and it is made only when the label is present.
 * A failed read leaves `addedBy` unset, so the label cannot admit the PR.
 */
async function buildInvitationPr(
  repo: string,
  prNumber: number,
  pr: Record<string, unknown>,
  inviteLabel: string,
  options: ListInvitedHumanPrsOptions,
): Promise<InvitationPr> {
  const names = labelNames(pr.labels);
  const present = names.find(
    (name) => name.trim().toLowerCase() === inviteLabel.toLowerCase(),
  );

  let addedBy: string | null = null;
  if (present !== undefined && inviteLabel.length > 0) {
    try {
      // Exhaustive timeline read (Issue #3296/#3709): the genuinely
      // most-recent adder, never a page-1 approximation.
      const info = await getLabelLastAddInfoComplete(
        repo,
        prNumber,
        present,
        options.ghCommandFn,
      );
      addedBy = info?.addedBy ?? null;
      if (addedBy === null) {
        options.log?.(
          `[pr-invitation] ${repo}#${prNumber}: '${
            sanitiseLogField(present)
          }' has no verifiable adder — not invited`,
        );
      }
    } catch (err) {
      options.log?.(
        `[pr-invitation] ${repo}#${prNumber}: label authorship check ` +
          `failed: ${err instanceof Error ? err.message : String(err)} — ` +
          `not invited`,
      );
    }
  }

  return {
    number: prNumber,
    author: (pr.author ?? null) as InvitationPr["author"],
    labels: present === undefined ? [] : [{ name: present, addedBy }],
    comments: toComments(pr.comments),
    reviews: toComments(pr.reviews),
  };
}
