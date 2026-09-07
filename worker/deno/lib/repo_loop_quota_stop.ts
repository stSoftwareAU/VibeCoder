/**
 * One condition, one line: quota handling for a per-repository loop
 * (Issue #1515).
 *
 * The worker has a dozen scans shaped `for (const repo of repos) { try {
 * await gh(...) } catch { logger.warn(...); continue; } }`. When the primary
 * GraphQL quota runs out, the first call says so and the latch (Issue #42)
 * fires — after which every later call in the loop is refused before it
 * spawns. Correct, and yet each loop still visited every remaining
 * repository and warned once per repository: on 2026-09-07 one exhaustion
 * produced thirty-two WARNING lines from two scans in a second, and the log
 * read as if thirty repositories were broken. Issue #1477 fixed the
 * merged-PR issue sweep; this is the same treatment, lifted out so the next
 * loop gets it by construction rather than by remembering.
 *
 * Usage:
 *
 *     const quota = new RepoLoopQuotaStop("Auto-merge sweep", repos.length, warn);
 *     for (const repo of repos) {
 *       if (quota.latchedBeforeRepo()) break;
 *       try { ... } catch (err) {
 *         if (quota.isQuotaFailure(err)) break;
 *         ...per-repo warning, as before...
 *         continue;
 *       }
 *       quota.repoDone();
 *     }
 *
 * The stop logs exactly one WARNING naming the scan, the condition and how
 * many repositories are left for the next cycle. Nothing is wrong with any
 * repository, so it is never recorded as a per-repo failure. With a healthy
 * quota the guard is inert and the loop visits every repository as before.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  isPrimaryQuotaLatched,
  isPrimaryRateLimitMessage,
} from "./primary_quota_latch.ts";

/** Why and where a per-repository loop stopped for want of quota. */
export interface RepoLoopQuotaStopRecord {
  /** The one-line condition (the refusal, or "latched for this process"). */
  condition: string;
  /** Repositories the loop did not sweep, including the one that hit it. */
  reposSkipped: number;
  /** Repositories the loop was asked to sweep. */
  reposTotal: number;
}

/** The message a stopped loop logs — one line, once. */
export function formatRepoLoopQuotaStop(
  label: string,
  stop: RepoLoopQuotaStopRecord,
): string {
  return `${label}: GraphQL quota exhausted — skipped ${stop.reposSkipped} ` +
    `of ${stop.reposTotal} repo(s) this cycle, resumes next cycle: ` +
    stop.condition;
}

/** The error message, whatever was thrown. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Per-loop quota guard. One instance per pass over the repositories.
 */
export class RepoLoopQuotaStop {
  private done = 0;
  private record?: RepoLoopQuotaStopRecord;

  /**
   * @param label - The scan's name, as the log line should read it.
   * @param reposTotal - How many repositories the loop covers.
   * @param warn - Where the one line goes.
   * @param latched - Latch query (injectable for tests).
   */
  constructor(
    private readonly label: string,
    private readonly reposTotal: number,
    private readonly warn: (message: string) => void,
    private readonly latched: () => boolean = isPrimaryQuotaLatched,
  ) {}

  /** The stop, when the loop was stopped; undefined while it is running. */
  get stopped(): RepoLoopQuotaStopRecord | undefined {
    return this.record;
  }

  /**
   * Call before each repository. True — and the one line is logged — when a
   * latch fired anywhere in this process, so every further GraphQL call is
   * known to fail and the loop must end without making one.
   */
  latchedBeforeRepo(): boolean {
    if (this.record) return true;
    if (!this.latched()) return false;
    this.stop("primary GraphQL quota latched for this process");
    return true;
  }

  /**
   * Call in a per-repository catch. True — and the one line is logged — when
   * the error is the primary-quota refusal, so the loop must end rather than
   * observe the same condition once per remaining repository. False for any
   * other failure, which stays the caller's to report per repository.
   */
  isQuotaFailure(err: unknown): boolean {
    const message = messageOf(err);
    if (!isPrimaryRateLimitMessage(message)) return false;
    this.stop(message);
    return true;
  }

  /** Call after a repository completes (whatever it found). */
  repoDone(): void {
    this.done++;
  }

  private stop(condition: string): void {
    if (this.record) return;
    this.record = {
      condition,
      reposSkipped: Math.max(0, this.reposTotal - this.done),
      reposTotal: this.reposTotal,
    };
    this.warn(formatRepoLoopQuotaStop(this.label, this.record));
  }
}
