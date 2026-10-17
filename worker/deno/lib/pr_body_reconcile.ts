/**
 * PR body digest reconcile, run on each PR scan for the repos due in that
 * cycle's polling selection (Issue #3760).
 *
 * The post-push body sync in `pr_body_sync.ts` runs only on the worker's own
 * runs: after a PR-feedback, CI-fix or merge-conflict push, or when a
 * PR-feedback run finds nothing left to push (`nothingLeftToPush`, Issue
 * #3315). So a push made outside the worker
 * (by a human, or another tool) never reaches it, and the body keeps describing
 * the old summary. This pass covers that case. For every worker-authored PR
 * whose body records a summary digest, it reads the summary and facts file at
 * the PR head through the contents API (no checkout) and compares the digest.
 * Only a mismatch rebuilds the body: a disposable shallow clone is checked out
 * at the head and the existing {@link syncPrBodyFromSummary} runs against it, so
 * it keeps that function's ancestry guard and carry-over rules. A head that
 * moved again since the listing fails that guard and is skipped, not
 * overwritten.
 *
 * A prefetched listing entry carries no body, so one without a body is read
 * with `gh pr view` before the check, and the fetched head is the one used.
 *
 * Steady state is silent (Issue #3651). The memo `inSync` is keyed per PR on
 * head SHA plus recorded digest. An entry is reused only while both are
 * unchanged, and is pruned when the PR is no longer listed. A PR whose recorded
 * digest matches the head logs nothing and makes no edit. A body with no digest
 * marker is a legacy body, still covered by the post-push before-SHA rule. A
 * failed read never rewrites the body; it is logged and counted.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger, Result } from "../types.ts";
import type {
  GitCommandOutput,
  runGitCommand as runGitCommandType,
} from "./git_timeout.ts";
import type { IssueCache } from "./issue_cache.ts";
import type { SyncFollowUpFiling } from "./pr_body_sync_follow_up.ts";
import {
  issueNumberFromMarker,
  prSummaryDigest,
  runPrBodySync,
  summaryDigestFromBody,
  syncPrBodyFromSummary,
} from "./pr_body_sync.ts";
import { isFleetAuthor } from "./fleet_authors.ts";
import { listOpenPrs, type PrEntry } from "./pr_maintenance.ts";
import {
  prSummaryDigestInput,
  prSummaryFactsPath,
} from "./pr_summary_facts.ts";

/** Prefix on every log line this pass writes. */
export const PR_BODY_RECONCILE_LOG_TAG = "[pr-body-reconcile]";

/** A full 40-hex commit SHA. Anything else never reaches a URL or git argv. */
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * The body and head of a PR, read live with `gh pr view`. A failed call, a reply
 * that is not JSON, or a body that is not a string is an error, never a skip.
 */
async function viewPrBodyAndHead(
  repo: string,
  prNumber: number,
  gh: (args: string[]) => Promise<string>,
): Promise<
  | { kind: "ok"; body: string; headRefOid: string }
  | { kind: "error"; reason: string }
> {
  let view: { body?: unknown; headRefOid?: unknown } | null;
  try {
    view = JSON.parse(
      await gh([
        "pr",
        "view",
        String(prNumber),
        "--repo",
        repo,
        "--json",
        "body,headRefOid",
      ]),
    );
  } catch (err) {
    return {
      kind: "error",
      reason: `Failed to read PR #${prNumber} with gh pr view: ${
        errorMessage(err)
      }`,
    };
  }
  if (typeof view?.body !== "string") {
    return {
      kind: "error",
      reason: `gh pr view for PR #${prNumber} returned no body`,
    };
  }
  return {
    kind: "ok",
    body: view.body,
    headRefOid: typeof view.headRefOid === "string" ? view.headRefOid : "",
  };
}

/** Outcome of reading the summary digest at a ref. */
export type HeadSummaryDigest =
  | { kind: "digest"; digest: string }
  | { kind: "no-summary" }
  | { kind: "error"; reason: string };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `gh api` reports an absent path as `... (HTTP 404)`. */
function isNotFound(err: unknown): boolean {
  return errorMessage(err).includes("(HTTP 404)");
}

/**
 * Raw text of `path` at `ref`, or null when the file is absent there. The
 * stdout is returned untrimmed: the digest must match the bytes the completion
 * phase hashed.
 */
async function readFileAtRef(
  repo: string,
  path: string,
  ref: string,
  gh: (args: string[]) => Promise<string>,
): Promise<string | null> {
  try {
    return await gh([
      "api",
      `repos/${repo}/contents/${path}?ref=${ref}`,
      "-H",
      "Accept: application/vnd.github.raw",
    ]);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * Digest of the PR summary (and facts file) at `ref`, read through the
 * contents API — no checkout. `ref` must already be a validated 40-hex SHA.
 *
 * The summary candidates mirror `loadPrSummary` (`pr_summary_loader.ts`): the
 * archive path first, then the legacy loose path. The `.pr_summary` fallback
 * is not read: it is a gitignored hidden file that is never committed, so the
 * contents API cannot see it.
 */
export async function headSummaryDigest(
  repo: string,
  issueNumber: number,
  ref: string,
  gh: (args: string[]) => Promise<string>,
): Promise<HeadSummaryDigest> {
  let path = "";
  let summary: string | undefined;
  let facts: string | null = null;
  try {
    const candidates = [
      `docs/archive/pr-summaries/pr-summary-${issueNumber}.md`,
      `docs/pr-summary-${issueNumber}.md`,
    ];
    for (const candidate of candidates) {
      path = candidate;
      const content = await readFileAtRef(repo, candidate, ref, gh);
      // A whitespace-only file counts as absent, as in loadPrSummary.
      if (content !== null && content.trim().length > 0) {
        summary = content;
        break;
      }
    }
    if (summary === undefined) return { kind: "no-summary" };
    path = prSummaryFactsPath(issueNumber);
    facts = await readFileAtRef(repo, path, ref, gh);
  } catch (err) {
    return {
      kind: "error",
      reason: `Failed to read ${path} at ${ref}: ${errorMessage(err)}`,
    };
  }
  return {
    kind: "digest",
    digest: await prSummaryDigest(prSummaryDigestInput(summary, facts)),
  };
}

/** A checked-out PR head, removed with `cleanup` once the rebuild is done. */
export interface PrBodyCheckout {
  path: string;
  cleanup: () => Promise<void>;
}

/** Produces a checkout of `repo` at `headSha`. */
export type PrepareHeadCheckout = (
  repo: string,
  headSha: string,
) => Promise<Result<PrBodyCheckout>>;

/** Why a git step failed, or the stdout of the step when it succeeded. */
export async function checkedGit(
  runGit: typeof runGitCommandType,
  name: string,
  args: string[],
  cwd: string,
): Promise<Result<string>> {
  const result: Result<GitCommandOutput> = await runGit(args, { cwd });
  if (!result.ok) {
    return {
      ok: false,
      error: new Error(`git ${name} failed: ${result.error.message}`),
    };
  }
  if (result.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `git ${name} failed (exit ${result.value.code}): ${result.value.stderr.trim()}`,
      ),
    };
  }
  return { ok: true, value: result.value.stdout };
}

/**
 * Production default: disposable shallow clone of `repo` checked out (detached)
 * at `headSha`. Only called on a digest mismatch, so steady state never clones.
 * On any failure the temp dir is removed before the error is returned.
 */
export function disposableHeadCheckout(deps: {
  runGhCommand: (args: string[]) => Promise<string>;
  runGitCommand: typeof runGitCommandType;
}): PrepareHeadCheckout {
  return async (repo, headSha) => {
    // The SHA reaches git argv, so it is checked again here (defence in depth).
    if (!FULL_SHA_PATTERN.test(headSha)) {
      return {
        ok: false,
        error: new Error(
          `Refusing to check out ${repo}: not a full commit SHA: ${headSha}`,
        ),
      };
    }
    const tmp = await Deno.makeTempDir({ prefix: "pr-body-reconcile-" });
    const dir = `${tmp}/checkout`;
    const fail = async (message: string): Promise<Result<PrBodyCheckout>> => {
      // The original failure stays the returned error; a removal failure is
      // appended to its message rather than dropped.
      try {
        await Deno.remove(tmp, { recursive: true });
      } catch (removeErr) {
        return {
          ok: false,
          error: new Error(
            `${message} (and the temporary directory ${tmp} could not be removed: ${
              errorMessage(removeErr)
            })`,
          ),
        };
      }
      return { ok: false, error: new Error(message) };
    };

    try {
      await deps.runGhCommand([
        "repo",
        "clone",
        repo,
        dir,
        "--",
        "--depth=1",
        "--no-checkout",
        "--filter=blob:none",
      ]);
    } catch (err) {
      return fail(`Failed to clone ${repo}: ${errorMessage(err)}`);
    }

    const steps: Array<[string, string[]]> = [
      ["fetch", ["fetch", "--depth=1", "origin", headSha]],
      [
        "checkout",
        [
          "-c",
          "advice.detachedHead=false",
          "checkout",
          "--detach",
          "FETCH_HEAD",
        ],
      ],
    ];
    for (const [name, args] of steps) {
      const step = await checkedGit(deps.runGitCommand, name, args, dir);
      if (!step.ok) return fail(step.error.message);
    }
    const head = await checkedGit(
      deps.runGitCommand,
      "rev-parse",
      ["rev-parse", "HEAD"],
      dir,
    );
    if (!head.ok) return fail(head.error.message);
    if (head.value.trim() !== headSha) {
      return fail(
        `Checkout of ${repo} resolved to ${head.value.trim()}, not ${headSha}`,
      );
    }

    return {
      ok: true,
      value: {
        path: dir,
        // Removes only the directory this call created.
        cleanup: () => Deno.remove(tmp, { recursive: true }),
      },
    };
  };
}

/** Inputs for {@link reconcilePrBodyDigests}. */
export interface ReconcilePrBodiesOptions {
  repos: readonly string[];
  /** Resolved push-capable fleet maintenance author set (resolveFleetMaintenanceAuthorSet). */
  maintenanceAuthors: string[];
  workerName: string;
  githubUser: string;
  runId?: string;
}

/** Collaborators {@link reconcilePrBodyDigests} needs — all injectable for testing. */
export interface ReconcilePrBodiesDeps {
  runGhCommand: (args: string[]) => Promise<string>;
  runGitCommand: typeof runGitCommandType;
  logger: Logger;
  followUpFiling: SyncFollowUpFiling | undefined;
  cache?: IssueCache;
  /**
   * Memo keyed per PR as `${repo}#${pr}`, holding `${headRefOid}:${recordedDigest}`
   * last confirmed in sync (or confirmed to have no summary). An entry is reused
   * only while both the head and the digest are unchanged, and is pruned when
   * the PR is no longer listed.
   */
  inSync: Map<string, string>;
  /** Default: {@link disposableHeadCheckout}. */
  prepareCheckout?: PrepareHeadCheckout;
  /** Default: {@link syncPrBodyFromSummary}. */
  syncFn?: typeof syncPrBodyFromSummary;
}

/** Counts from one reconcile pass. */
export interface ReconcilePrBodiesSummary {
  /** PRs for which a digest read was attempted. */
  checked: number;
  /** PRs whose body sync was invoked. */
  rebuilt: number;
  /** Digest reads that failed; the body was left unchanged. */
  readFailures: number;
}

/**
 * Re-sync each open worker PR body whose recorded summary digest no longer
 * matches the summary at the PR head (Issue #3760), whoever pushed the head.
 *
 * Quietly skips a PR with no worker marker, no digest marker (legacy), an
 * invalid head SHA, or a memo hit. The sync re-reads the PR live and checks the
 * local HEAD against `headRefOid` with its ancestry guard, so a head that moved
 * since the listing is skipped there rather than overwritten.
 */
export async function reconcilePrBodyDigests(
  opts: ReconcilePrBodiesOptions,
  deps: ReconcilePrBodiesDeps,
): Promise<ReconcilePrBodiesSummary> {
  const summary: ReconcilePrBodiesSummary = {
    checked: 0,
    rebuilt: 0,
    readFailures: 0,
  };
  const prepareCheckout = deps.prepareCheckout ??
    disposableHeadCheckout({
      runGhCommand: deps.runGhCommand,
      runGitCommand: deps.runGitCommand,
    });
  const syncFn = deps.syncFn ?? syncPrBodyFromSummary;
  const logLine = (message: string) =>
    `${PR_BODY_RECONCILE_LOG_TAG} ${message}`;

  const reconcilePr = async (repo: string, pr: PrEntry): Promise<void> => {
    // Defensive: the listing is already limited to the maintenance authors.
    const login = pr.author?.login;
    if (login && !isFleetAuthor(login, opts.maintenanceAuthors)) return;

    // A prefetched maintenance entry carries no body, so read it live (Issue #3760).
    let body = pr.body ?? "";
    let headRefOid = pr.headRefOid ?? "";
    if (typeof pr.body !== "string") {
      const view = await viewPrBodyAndHead(repo, pr.number, deps.runGhCommand);
      if (view.kind === "error") {
        summary.readFailures += 1;
        deps.logger.warn(
          logLine(
            "PR body digest check could not read the PR body — leaving the body unchanged (Issue #3760)",
          ),
          { repo, prNumber: pr.number, reason: view.reason },
        );
        return;
      }
      body = view.body;
      headRefOid = view.headRefOid;
    }
    const issueNumber = issueNumberFromMarker(body);
    if (issueNumber === undefined) return;
    const recordedDigest = summaryDigestFromBody(body);
    // Legacy body: the post-push before-SHA rule still covers it.
    if (recordedDigest === undefined) return;
    // Interpolated into an API URL and git argv: validate at the boundary.
    if (!FULL_SHA_PATTERN.test(headRefOid)) return;

    const key = `${repo}#${pr.number}`;
    const settled = `${headRefOid}:${recordedDigest}`;
    if (deps.inSync.get(key) === settled) return;

    summary.checked += 1;
    const head = await headSummaryDigest(
      repo,
      issueNumber,
      headRefOid,
      deps.runGhCommand,
    );
    if (head.kind === "error") {
      summary.readFailures += 1;
      deps.logger.warn(
        logLine(
          "PR body digest check could not read the summary at the PR head — leaving the body unchanged (Issue #3760)",
        ),
        { repo, prNumber: pr.number, headRefOid, reason: head.reason },
      );
      return;
    }
    // The sync would skip a deleted summary anyway, so there is nothing to do.
    if (head.kind === "no-summary" || head.digest === recordedDigest) {
      deps.inSync.set(key, settled);
      return;
    }

    deps.logger.info(
      logLine(
        "PR body digest differs from the summary at the PR head — rebuilding the body (Issue #3760)",
      ),
      {
        repo,
        prNumber: pr.number,
        headRefOid,
        recorded: recordedDigest,
        current: head.digest,
      },
    );
    const checkout = await prepareCheckout(repo, headRefOid);
    if (!checkout.ok) {
      deps.logger.warn(
        logLine(
          "Could not check out the PR head to rebuild its body — leaving the body unchanged (Issue #3760)",
        ),
        {
          repo,
          prNumber: pr.number,
          headRefOid,
          error: checkout.error.message,
        },
      );
      return;
    }
    try {
      summary.rebuilt += 1;
      await runPrBodySync(
        {
          repo,
          prNumber: pr.number,
          repoPath: checkout.value.path,
          beforeSha: undefined,
          workerName: opts.workerName,
          githubUser: opts.githubUser,
          runId: opts.runId,
        },
        {
          runGhCommand: deps.runGhCommand,
          runGitCommand: deps.runGitCommand,
          logger: deps.logger,
          followUpFiling: deps.followUpFiling,
        },
        syncFn,
      );
    } finally {
      // Not memoised: the next pass re-verifies against the rebuilt body.
      try {
        await checkout.value.cleanup();
      } catch (err) {
        deps.logger.warn(
          logLine(
            "Could not remove the disposable PR head checkout (Issue #3760)",
          ),
          {
            repo,
            prNumber: pr.number,
            path: checkout.value.path,
            error: errorMessage(err),
          },
        );
      }
    }
  };

  for (const repo of opts.repos) {
    const prs = await listOpenPrs(
      repo,
      opts.maintenanceAuthors,
      "number,headRefOid,body,author",
      deps.runGhCommand,
      deps.cache,
    );
    const listed = new Set<number>();
    for (const pr of prs) {
      listed.add(pr.number);
      try {
        await reconcilePr(repo, pr);
      } catch (err) {
        deps.logger.warn(
          logLine("PR body digest check failed unexpectedly (Issue #3760)"),
          { repo, prNumber: pr.number, error: errorMessage(err) },
        );
      }
    }
    // Keep the memo bounded: drop this repo's PRs that are no longer open.
    const prefix = `${repo}#`;
    for (const key of deps.inSync.keys()) {
      if (
        key.startsWith(prefix) &&
        !listed.has(Number(key.slice(prefix.length)))
      ) {
        deps.inSync.delete(key);
      }
    }
  }
  return summary;
}
