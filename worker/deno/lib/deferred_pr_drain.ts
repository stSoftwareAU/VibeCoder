/**
 * Raise the pull requests GitHub's secondary rate limit refused (Issue #1951).
 *
 * A deferred PR is finished work: the branch is pushed and the body is
 * composed; only `gh pr create` was refused, by a content-creation throttle
 * that clears itself in minutes. This drain runs as an ordinary cycle
 * priority, so the PR appears on the next pass **with no agent run at all** —
 * where before the run was charged as a failure and the branch waited for
 * some later claim to notice it.
 *
 * Creation goes over REST (`pr_create_rest.ts`): it is the same endpoint the
 * primary-quota fallback uses and it is exempt from the primary-quota latch,
 * so a drain is not itself blocked by an unrelated GraphQL exhaustion.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import {
  clearDeferredPr,
  type DeferredPrRecord,
  listDeferredPrs,
  recordDeferredPr,
} from "./deferred_pr_store.ts";
import {
  createPullRequestViaRest,
  findOpenPrUrlViaRest,
} from "./pr_create_rest.ts";
import { isSecondaryRateLimitMessage } from "./secondary_rate_limit.ts";
import { redactSecrets } from "./secret_redaction.ts";

/**
 * Creation attempts a parked PR gets before the drain gives up on it.
 *
 * A refusal that is still the secondary limit never counts against this: that
 * is the drain doing exactly what it exists for. The cap is for the other
 * kind of failure — a deleted branch, a base that no longer exists — which
 * will never succeed however often it is retried.
 */
export const MAX_DEFERRED_PR_ATTEMPTS = 5;

/**
 * Longest a PR stays parked, whatever keeps refusing it.
 *
 * The attempt cap cannot bound a record the throttle keeps refusing — a
 * refusal that is still the secondary limit deliberately does not count
 * against it — so the age does. A content-creation throttle clears in
 * minutes; one still refusing a day later is not that throttle, and parking
 * the record for ever would be the silent hold this codebase refuses.
 */
export const MAX_DEFERRED_PR_AGE_SECONDS = 24 * 60 * 60;

/** Injection seams for {@link drainDeferredPrs}. */
export interface DeferredPrDrainDeps {
  /** Work directory holding the parked records. */
  workDir: string;
  /** Raise the PR. Defaults to the REST create. */
  createPr?: (record: DeferredPrRecord) => Promise<Result<string>>;
  /** Look up an open PR already on the branch. Defaults to the REST lookup. */
  findOpenPr?: (repo: string, branch: string) => Promise<Result<string>>;
  /** Comment on the issue — best-effort, never fails the drain. */
  comment?: (
    repo: string,
    issueNumber: number,
    body: string,
  ) => Promise<void>;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  warn?: (message: string, fields?: Record<string, unknown>) => void;
  error?: (message: string, fields?: Record<string, unknown>) => void;
  nowSeconds?: () => number;
  /** Attempts before a parked PR is abandoned; defaults to 5. */
  maxAttempts?: number;
  /** Age before a parked PR is abandoned whatever refused it; defaults to 24h. */
  maxAgeSeconds?: number;
}

/** What one drain pass did. */
export interface DeferredPrDrainResult {
  /** PRs raised by this pass. */
  raised: number;
  /** Records dropped because the PR was already open. */
  alreadyOpen: number;
  /** Records left parked for the next pass. */
  pending: number;
  /** Records abandoned after {@link MAX_DEFERRED_PR_ATTEMPTS} attempts. */
  abandoned: number;
}

/** Raise every parked PR that GitHub will now accept. */
export async function drainDeferredPrs(
  deps: DeferredPrDrainDeps,
): Promise<Result<DeferredPrDrainResult>> {
  const {
    workDir,
    createPr = (record: DeferredPrRecord) =>
      createPullRequestViaRest({
        repo: record.repo,
        title: record.title,
        body: record.body,
        head: record.branch,
        base: record.base,
        ...(record.reviewers ? { reviewers: record.reviewers } : {}),
      }),
    findOpenPr = findOpenPrUrlViaRest,
    nowSeconds = () => Math.floor(Date.now() / 1000),
    maxAttempts = MAX_DEFERRED_PR_ATTEMPTS,
    maxAgeSeconds = MAX_DEFERRED_PR_AGE_SECONDS,
  } = deps;
  const result: DeferredPrDrainResult = {
    raised: 0,
    alreadyOpen: 0,
    pending: 0,
    abandoned: 0,
  };
  if (!workDir) return { ok: true, value: result };

  const records = await listDeferredPrs(
    workDir,
    (problem) => deps.warn?.(problem),
  );
  for (const record of records) {
    const where = {
      repo: record.repo,
      issueNumber: record.issueNumber,
      branch: record.branch,
    };

    // Something else may have raised it — the next claim of the issue
    // recovers a branch's PR too. Dropping the record is then the whole job.
    const existing = await findOpenPr(record.repo, record.branch);
    if (!existing.ok && !/no open pr/i.test(existing.error.message)) {
      // "No open PR" and "the lookup failed" arrive in the same shape, and
      // only one is a fact about the world. Say which was seen: the create
      // below still runs (GitHub answers a duplicate with the existing PR,
      // which `createPullRequestViaRest` resolves), but a lookup outage read
      // as "no PR exists" must not pass unreported.
      deps.warn?.(
        "Deferred-PR lookup failed — creating anyway; a duplicate resolves " +
          "to the open PR (Issue #1951)",
        { ...where, error: existing.error.message },
      );
    }
    if (existing.ok) {
      await forget(workDir, record, deps);
      deps.log?.(
        "Deferred PR already open — dropping the parked record (Issue #1951)",
        { ...where, prUrl: existing.value },
      );
      result.alreadyOpen++;
      continue;
    }

    const created = await createPr(record);
    if (created.ok) {
      await forget(workDir, record, deps);
      deps.log?.(
        "Raised a PR GitHub's secondary rate limit had refused (Issue #1951)",
        { ...where, prUrl: created.value },
      );
      await bestEffortComment(
        deps,
        record,
        `✅ **PR raised** — the pull request deferred by GitHub's secondary ` +
          `(content-creation) rate limit is now open: ${created.value}`,
      );
      result.raised++;
      continue;
    }

    const message = created.error.message;
    const stillThrottled = isSecondaryRateLimitMessage(message);
    const attempts = stillThrottled ? record.attempts : record.attempts + 1;
    const tooOld = nowSeconds() - record.deferredAtEpoch > maxAgeSeconds;
    if (tooOld || (!stillThrottled && attempts >= maxAttempts)) {
      // Loud, not silent: the branch still holds the work, but nothing will
      // raise this PR now, so the thread has to say so.
      const why = tooOld
        ? `it has been parked for more than ${
          Math.round(maxAgeSeconds / 3600)
        }h`
        : `${attempts} attempts failed`;
      deps.error?.(
        `Abandoning a deferred PR (${why}) — the work is still on its ` +
          `branch (Issue #1951)`,
        { ...where, error: message },
      );
      await forget(workDir, record, deps);
      await bestEffortComment(
        deps,
        record,
        `⚠️ **Deferred PR not raised** — ${why}, so the pull ` +
          `request for \`${record.branch}\` → \`${record.base}\` could not be ` +
          `opened:\n\n> ${oneLine(message)}\n\nThe work is still on ` +
          `\`${record.branch}\`` +
          ` and nothing has been lost; raising the PR now needs a human.`,
      );
      result.abandoned++;
      continue;
    }

    const kept = await recordDeferredPr(workDir, {
      ...record,
      attempts,
      lastError: oneLine(message),
      deferredAtEpoch: record.deferredAtEpoch || nowSeconds(),
    });
    if (!kept.ok) {
      deps.error?.(
        "Could not update a deferred-PR record — the parked PR may be retried " +
          "with a stale attempt count (Issue #1951)",
        { ...where, error: kept.error.message },
      );
    }
    deps.warn?.(
      stillThrottled
        ? "Deferred PR still refused by GitHub's secondary rate limit — " +
          "leaving it parked for the next cycle (Issue #1951)"
        : "Deferred PR could not be raised — leaving it parked (Issue #1951)",
      { ...where, attempts, error: message },
    );
    result.pending++;
  }

  return { ok: true, value: result };
}

/** Drop a record, reporting (never swallowing) a removal that failed. */
async function forget(
  workDir: string,
  record: DeferredPrRecord,
  deps: DeferredPrDrainDeps,
): Promise<void> {
  const cleared = await clearDeferredPr(
    workDir,
    record.repo,
    record.issueNumber,
  );
  if (!cleared.ok) {
    deps.error?.(
      "Could not clear a deferred-PR record — the next pass will see it again",
      {
        repo: record.repo,
        issueNumber: record.issueNumber,
        error: cleared.error.message,
      },
    );
  }
}

/** Comment on the issue without ever failing the drain. */
async function bestEffortComment(
  deps: DeferredPrDrainDeps,
  record: DeferredPrRecord,
  body: string,
): Promise<void> {
  if (!deps.comment) return;
  try {
    await deps.comment(record.repo, record.issueNumber, body);
  } catch (err) {
    deps.warn?.("Could not comment on a deferred PR's issue", {
      repo: record.repo,
      issueNumber: record.issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * One redacted line of an error, safe to write to an issue comment.
 *
 * `gh` stderr can echo a URL carrying a token, so every outbound sink routes
 * through `redactSecrets` independently — `postComment` does none of its own.
 */
function oneLine(message: string): string {
  const flat = redactSecrets(message).replace(/\s+/g, " ").trim();
  return flat.length <= 300 ? flat : `${flat.substring(0, 299)}…`;
}
