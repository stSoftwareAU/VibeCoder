/**
 * Periodic scan that nudges CI on Vibe Coder PRs idle more than 5 minutes
 * (Issue #2100).
 *
 * GitHub deliberately suppresses `pull_request` workflows on PRs raised by
 * a workflow authenticated with `GITHUB_TOKEN` (anti-recursion). The Vibe
 * Coder works around this by detecting affected PRs in its periodic scan
 * loop and invoking the nudge library from #2099.
 *
 * This module is the wiring between the priority dispatch and the nudge
 * library: it lists open worker PRs across the monitored repos, filters
 * to those older than `minAgeSec` with no CI activity, and posts an
 * audit comment (deduped by an HTML marker) for each one it nudges.
 *
 * Pure helper — all `gh` access goes through an injected `ghCommandFn`
 * so tests can stub the responses.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { issueCommentsContainMarker } from "./issue_comment_pages.ts";
import { getCiStartStatus } from "./pr_ci_started.ts";
import { nudgeCi, type NudgeOutcome } from "./pr_ci_nudge.ts";
import {
  isFleetAuthor,
  resolveFleetMaintenanceAuthorSet,
} from "./fleet_authors.ts";
import { listInvitedHumanPrs } from "./pr_invitation_lookup.ts";
import type { IssueCache } from "./issue_cache.ts";
import {
  PR_MAINTENANCE_LIST_FIELDS,
  PR_MAINTENANCE_LIST_LIMIT,
} from "./pr_maintenance.ts";

/** HTML marker used to dedup the audit comment on a single PR. */
export const NUDGE_COMMENT_MARKER = "<!-- vibe-coder:ci-nudge -->";

/** Default minimum age (seconds) before a PR is eligible for a nudge. */
export const DEFAULT_MIN_AGE_SECONDS = 300;

/** `gh pr list --limit` used by every listing this scan issues. */
const PR_LIST_LIMIT = 50;

/** A PR identified as needing a CI nudge. */
export interface NudgeCandidate {
  /** Repository in `owner/repo` format. */
  repo: string;
  /** PR number. */
  prNumber: number;
  /** Head branch name. */
  headBranch: string;
  /** Head SHA. */
  headSha: string;
  /** CI status reported by `getCiStartStatus`: `none` or `queued`. */
  status: "none" | "queued";
}

/** Options for {@link findPrsNeedingCiNudge}. */
export interface FindPrsNeedingCiNudgeOptions {
  /** GitHub username that authored the Vibe Coder PRs. */
  githubUser: string;
  /**
   * Trusted authors (`allowed_authors`) — humans trusted to instruct the
   * worker, whose PRs this scan deliberately does **not** nudge
   * (Issue #4076). Nudging comments on the PR, so the scan is scoped to
   * the push-capable maintenance set; retained for the
   * explicit-invitation path (Issue #4077).
   */
  allowedAuthors?: readonly string[];
  /** Sibling fleet logins (`fleet_pr_authors`) — Issue #4023. */
  fleetPrAuthors?: readonly string[];
  /** Monitored repos in `owner/repo` format. */
  repos: readonly string[];
  /**
   * Minimum age (seconds) the PR must have reached before being
   * eligible for a nudge. Defaults to {@link DEFAULT_MIN_AGE_SECONDS}.
   */
  minAgeSec?: number;
  /** Injected `gh` CLI runner. */
  ghCommandFn: (args: string[]) => Promise<string>;
  /**
   * Shared PR-list cache (Issue #4303): serves the same
   * `prs_maint_<author>` superset listing the other Priority-1.x scans
   * use, so this scan stops re-listing identical PRs.
   */
  cache?: IssueCache;
  /** Optional clock override (epoch seconds). */
  nowSeconds?: () => number;
  /** Optional logger. */
  log?: (message: string) => void;
}

/** Minimal subset of `gh pr list` fields used by the scanner. */
interface ListedPr {
  number: number;
  headRefName: string;
  headRefOid: string;
  updatedAt: string;
  createdAt: string;
  author?: { login?: string };
  /** GitHub mergeability — "CONFLICTING" means CI cannot start (Issue #52). */
  mergeable?: string;
}

/**
 * Locate every Vibe Coder PR across the monitored repos that needs a CI
 * nudge.
 *
 * A PR qualifies when:
 *   - The author login belongs to an account the fleet operates —
 *     `githubUser` or `fleetPrAuthors` (Issue #4076).
 *   - The most recent activity (max of `updatedAt`, `createdAt`) is older
 *     than `minAgeSec`.
 *   - `getCiStartStatus()` returns `none` or `queued`.
 *
 * The function is best-effort per repo: any per-repo failure is logged
 * (when a logger is provided) and the scan continues. A top-level error
 * yields `{ ok: false, error }`.
 */
export async function findPrsNeedingCiNudge(
  opts: FindPrsNeedingCiNudgeOptions,
): Promise<Result<NudgeCandidate[], Error>> {
  const {
    githubUser,
    allowedAuthors = [],
    fleetPrAuthors = [],
    repos,
    minAgeSec = DEFAULT_MIN_AGE_SECONDS,
    ghCommandFn,
    nowSeconds = () => Math.floor(Date.now() / 1000),
    log,
  } = opts;

  // Issue #4076: the scan comments on the PRs it finds, so it resolves the
  // push-capable maintenance set — host login + sibling fleet logins. A
  // trusted human's `allowed_authors` login never reaches the `gh pr list`
  // query, and the post-list guard below is checked against the same set
  // so an unfiltered listing cannot slip a human PR through either.
  const maintenanceAuthors = resolveFleetMaintenanceAuthorSet({
    githubUser,
    allowedAuthors,
    fleetPrAuthors,
  });
  const candidates: NudgeCandidate[] = [];
  const now = nowSeconds();

  for (const repo of repos) {
    let prs: ListedPr[];
    try {
      prs = await listOpenPrs(
        repo,
        maintenanceAuthors,
        ghCommandFn,
        log,
        opts.cache,
      );
    } catch (err) {
      log?.(`[ci-nudge-scan] ${repo}: list failed: ${errorMessage(err)}`);
      continue;
    }

    // Issue #4077: a human-authored PR whose author explicitly invited the
    // worker — by the invite label or an @mention — is nudged as well. Each
    // admission is logged by the lookup with its cause.
    const invitedNumbers = new Set<number>();
    for (
      const pr of await listInvitedHumanPrs<ListedPr>({
        repo,
        githubUser,
        allowedAuthors,
        fleetPrAuthors,
        fields: "number,headRefName,headRefOid,createdAt,updatedAt",
        limit: PR_LIST_LIMIT,
        ghCommandFn,
        log,
      })
    ) {
      if (prs.some((existing) => existing.number === pr.number)) continue;
      invitedNumbers.add(pr.number);
      prs.push(pr);
    }

    for (const pr of prs) {
      // Author guard — defensive even though `--author` filters server-side.
      // Checked against the maintenance set (Issue #4076): a human PR that
      // reaches this point is dropped rather than nudged — unless it was
      // admitted by an explicit invitation above (Issue #4077).
      const author = pr.author?.login ?? "";
      if (
        author && !isFleetAuthor(author, maintenanceAuthors) &&
        !invitedNumbers.has(pr.number)
      ) continue;

      const ageSec = computeAgeSeconds(pr, now);
      if (ageSec < minAgeSec) continue;

      // Issue #52: a CONFLICTING PR has no checks for a reason no empty commit
      // can change — GitHub will not build a merge commit until the conflict
      // is resolved. Nudging it just pushes noise (or fails non-fast-forward)
      // every pass, so skip it and say why (once per PR per run).
      if (pr.mergeable === "CONFLICTING") {
        log?.(
          `[ci-nudge-scan] ${repo}#${pr.number}: not nudged — PR is ` +
            `conflicting; CI cannot start until it is resolved`,
        );
        continue;
      }

      let status: "started" | "queued" | "none";
      try {
        status = await getCiStartStatus(
          repo,
          pr.number,
          ghCommandFn,
          pr.headRefOid,
        );
      } catch (err) {
        log?.(
          `[ci-nudge-scan] ${repo}#${pr.number}: status check failed: ${
            errorMessage(err)
          }`,
        );
        continue;
      }

      if (status === "started") continue;

      candidates.push({
        repo,
        prNumber: pr.number,
        headBranch: pr.headRefName,
        headSha: pr.headRefOid,
        status,
      });
    }
  }

  return { ok: true, value: candidates };
}

/** Dependencies for {@link processCiNudgeCandidate}. */
export interface ProcessCiNudgeCandidateDeps {
  /** Injected `gh` CLI runner. */
  ghCommandFn: (args: string[]) => Promise<string>;
  /** Injected `git` CLI runner (only needed for the `none` empty-commit path). */
  gitCommandFn: (args: string[]) => Promise<string>;
  /** Optional logger. */
  log?: (message: string) => void;
}

/** Outcome of {@link processCiNudgeCandidate}. */
export interface ProcessCiNudgeOutcome {
  /** What `nudgeCi` did. */
  nudge: NudgeOutcome;
  /** Whether the audit comment was posted (false when already present). */
  commentPosted: boolean;
}

/**
 * Process a single nudge candidate: invoke {@link nudgeCi} and post the
 * audit comment if not already present.
 *
 * The comment is deduped via {@link NUDGE_COMMENT_MARKER}; we never post
 * a second nudge comment on the same PR.
 */
export async function processCiNudgeCandidate(
  candidate: NudgeCandidate,
  deps: ProcessCiNudgeCandidateDeps,
): Promise<Result<ProcessCiNudgeOutcome, Error>> {
  const { ghCommandFn, gitCommandFn, log } = deps;

  // Dedup: check whether the marker comment already exists on this PR.
  // Best-effort — on lookup failure we proceed without posting to avoid
  // duplicate comments if the lookup later succeeds.
  let alreadyCommented = false;
  try {
    alreadyCommented = await prHasNudgeMarker(
      candidate.repo,
      candidate.prNumber,
      ghCommandFn,
    );
  } catch (err) {
    log?.(
      `[ci-nudge-scan] ${candidate.repo}#${candidate.prNumber}: ` +
        `marker lookup failed: ${errorMessage(err)} — skipping comment`,
    );
    alreadyCommented = true;
  }

  const nudge = await nudgeCi({
    repo: candidate.repo,
    prNumber: candidate.prNumber,
    headBranch: candidate.headBranch,
    headSha: candidate.headSha,
    status: candidate.status,
    ghCommandFn,
    gitCommandFn,
  });

  if (!nudge.ok) {
    return { ok: false, error: nudge.error };
  }

  if (alreadyCommented) {
    return {
      ok: true,
      value: { nudge: nudge.value, commentPosted: false },
    };
  }

  const body = buildNudgeCommentBody(nudge.value.description);
  try {
    await ghCommandFn([
      "pr",
      "comment",
      String(candidate.prNumber),
      "--repo",
      candidate.repo,
      "--body",
      body,
    ]);
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `failed to post nudge audit comment on ${candidate.repo}#${candidate.prNumber}: ${
          errorMessage(err)
        }`,
      ),
    };
  }

  return {
    ok: true,
    value: { nudge: nudge.value, commentPosted: true },
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Build the audit comment body, including the dedup marker. */
function buildNudgeCommentBody(description: string): string {
  return (
    `${NUDGE_COMMENT_MARKER}\n` +
    `🤖 **CI nudge** — ${description}\n\n` +
    "GitHub suppresses `pull_request` workflows on PRs raised by " +
    "`GITHUB_TOKEN`. The Vibe Coder nudges CI so this PR does not sit " +
    "idle. See Issue #2094."
  );
}

/**
 * List open fleet-authored PRs for a single repo, with the fields we need.
 *
 * One `gh pr list --author <a>` call per fleet login, merged and
 * de-duplicated by PR number. A single author's failure is logged and the
 * remaining authors still contribute; when *every* author fails the error
 * is rethrown so the caller logs the repo as failed rather than silently
 * treating an outage as "no PRs" (Issue #3234).
 */
async function listOpenPrs(
  repo: string,
  fleetAuthors: readonly string[],
  ghCommandFn: (args: string[]) => Promise<string>,
  log?: (message: string) => void,
  cache?: IssueCache,
): Promise<ListedPr[]> {
  const authors = fleetAuthors.filter((a) => a.trim() !== "");
  const seen = new Set<number>();
  const merged: ListedPr[] = [];
  let firstError: unknown;
  let failures = 0;

  for (const author of authors) {
    let prs: ListedPr[];
    try {
      prs = await listOpenPrsForAuthor(repo, author, ghCommandFn, cache);
    } catch (err) {
      failures++;
      if (firstError === undefined) firstError = err;
      log?.(
        `[ci-nudge-scan] ${repo}: list for author ${author} failed: ${
          errorMessage(err)
        }`,
      );
      continue;
    }
    for (const pr of prs) {
      if (seen.has(pr.number)) continue;
      seen.add(pr.number);
      merged.push(pr);
    }
  }

  if (authors.length > 0 && failures === authors.length) {
    throw firstError instanceof Error
      ? firstError
      : new Error(String(firstError));
  }
  return merged;
}

/** Run one `gh pr list --author <githubUser>` and parse the entries. */
async function listOpenPrsForAuthor(
  repo: string,
  githubUser: string,
  ghCommandFn: (args: string[]) => Promise<string>,
  cache?: IssueCache,
): Promise<ListedPr[]> {
  // Shared superset listing (Issue #4303): a hit here means another
  // Priority-1.x scan already listed this repo×author this cycle.
  const cacheKey = `prs_maint_${githubUser}`;
  if (cache) {
    const cached = await cache.read<ListedPr[]>(repo, cacheKey);
    if (cached !== null) return cached;
  }
  const raw = await ghCommandFn([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--author",
    githubUser,
    "--json",
    cache
      ? PR_MAINTENANCE_LIST_FIELDS
      : "number,headRefName,headRefOid,createdAt,updatedAt,author,mergeable",
    "--limit",
    cache ? String(PR_MAINTENANCE_LIST_LIMIT) : String(PR_LIST_LIMIT),
  ]);
  const trimmed = raw.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ListedPr[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const number = typeof obj.number === "number" ? obj.number : NaN;
    const headRefName = typeof obj.headRefName === "string"
      ? obj.headRefName
      : "";
    const headRefOid = typeof obj.headRefOid === "string" ? obj.headRefOid : "";
    const createdAt = typeof obj.createdAt === "string" ? obj.createdAt : "";
    const updatedAt = typeof obj.updatedAt === "string" ? obj.updatedAt : "";
    const author = (obj.author && typeof obj.author === "object")
      ? obj.author as Record<string, unknown>
      : undefined;
    const authorLogin = author && typeof author.login === "string"
      ? author.login
      : undefined;
    // Issue #52: carry mergeability so the scan can skip CONFLICTING PRs.
    const mergeable = typeof obj.mergeable === "string"
      ? obj.mergeable
      : undefined;
    if (!Number.isFinite(number) || !headRefName || !headRefOid) continue;
    out.push({
      number,
      headRefName,
      headRefOid,
      createdAt,
      updatedAt,
      author: authorLogin ? { login: authorLogin } : undefined,
      ...(mergeable ? { mergeable } : {}),
    });
  }
  return out;
}

/** Compute the PR's age in seconds, using `updatedAt` if present else `createdAt`. */
function computeAgeSeconds(pr: ListedPr, nowSeconds: number): number {
  const candidate = pr.updatedAt || pr.createdAt;
  if (!candidate) return Number.POSITIVE_INFINITY;
  const epoch = Date.parse(candidate);
  if (!Number.isFinite(epoch)) return Number.POSITIVE_INFINITY;
  return Math.max(0, nowSeconds - Math.floor(epoch / 1000));
}

/**
 * Check whether the marker comment is already present on a PR.
 *
 * Issue #3709: pages the thread with a hard page cap and stops at the first
 * page containing the marker, instead of materialising the whole thread with
 * an uncapped `--paginate` only to substring-match it.
 */
async function prHasNudgeMarker(
  repo: string,
  prNumber: number,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<boolean> {
  return await issueCommentsContainMarker(
    repo,
    prNumber,
    NUDGE_COMMENT_MARKER,
    ghCommandFn,
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
