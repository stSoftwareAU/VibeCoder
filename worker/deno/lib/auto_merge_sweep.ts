/**
 * Priority 1.65 auto-merge sweep (Issue #1082).
 *
 * Extracted from `run_core_production_deps.ts` so the two invariants the
 * fleet's throughput depends on are testable rather than asserted in prose:
 *
 * 1. **Every fleet author's PRs are swept** — not just this host's own login.
 *    This is the defect the extraction was made for.
 *    `getBlockingPRForIssue()` defers a `work-on` issue to a PR from *any*
 *    push-capable fleet account, so a sweep that only listed
 *    `prs_${githubUser}` left a sibling account's PR unattended forever.
 *    `GRQ-GTC#305` sat open for five days with no auto-merge attempt logged
 *    against it at all: it was authored by `stservice` while the scanning
 *    host was `VibeCoderST`.
 * 2. **Every monitored repo is swept, every cycle** — the sweep is driven by
 *    the repo list, never by which repo has claimable work. A repo whose only
 *    PR blocks all of its own issues has no claimable work by construction,
 *    so a work-driven sweep would never revisit it and the block would be
 *    permanent. This property was already true of the code this module
 *    replaces; it is now covered by a test, so it cannot quietly stop being
 *    true.
 * 3. **Auto-merge follows the base** (Issue #3433) — every swept PR
 *    passes the base check before any arming or branch update (the GraphQL
 *    read is skipped only for an unarmed, non-fix PR on a milestone base); a
 *    milestone-fix PR off its milestone branch, or a PR moved onto the default branch, is disarmed,
 *    so a retarget cannot land a milestone's work unreviewed. It is moved back
 *    onto the base it was opened against, or closed and its issue redone —
 *    never held for a human (Issue #4304).
 * 4. **Every PR is armed for auto-merge** (Issue #4291) — PRs do not merge
 *    until they have a review approval and CI is green, and GitHub enforces
 *    both. The sweep never withholds arming, or disarms, for a review, a
 *    finding or a label; only the routing holds in item 3 disarm.
 * 5. **A branch is updated for a ready PR only, one per base** (Issue #4613)
 *    — an armed PR that has fallen behind its base is updated only once it
 *    could merge (review satisfied, checks passed). Only one PR per base is
 *    updated per pass, and none while another PR on that base is ready and
 *    already up to date, so a queue of ready PRs on one base does not keep
 *    restarting each other's CI. A merge-queue base is left to its queue.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { RepoLoopQuotaStop } from "./repo_loop_quota_stop.ts";
import { sanitiseLogField } from "./issue_finder_logger.ts";
import { logPrLiveSkip, type PrLiveStateReading } from "./pr_live_state.ts";
import type { Logger, Result } from "../types.ts";
import {
  AutoMergeResult,
  type EnableAutoMergeResult,
} from "./pr_auto_merge.ts";

/** One open PR the sweep may act on. */
export interface SweepablePr {
  /** PR number. */
  number: number;
  /** Head branch — passed on so the milestone gate needs no extra lookup. */
  headRefName?: string;
  /** Base branch — decides native auto-merge versus the gated direct merge. */
  baseRefName?: string;
  /**
   * True when the PR is a draft (Issue #1800): GitHub refuses to arm
   * auto-merge on one, so the sweep skips it. Unset means unknown, and an
   * unknown is attempted as before.
   */
  isDraft?: boolean;
  /** Labels from the listing; `needs-human` means a person owns the PR. */
  labels?: Array<{ name?: string }>;
}

/**
 * Draft PRs already announced by this process, keyed `repo#pr` (Issue #1800).
 *
 * A draft stays a draft for as long as its author wants eyes on it — hours,
 * sometimes days — and the sweep runs every cycle. One line when the draft
 * is first seen says everything the next hundred would; the outcome is
 * recorded every sweep regardless.
 */
const announcedDrafts = new Set<string>();

/** Reset the announced-draft registry. Tests only. */
export function resetAnnouncedDraftsForTest(): void {
  announcedDrafts.clear();
}

/** Dependencies for {@link sweepAutoMerge}. */
export interface SweepAutoMergeOptions {
  /** Monitored repositories in `owner/repo` format. */
  repos: readonly string[];
  /** Repo allowlist gate. */
  isRepoAllowed: (repo: string) => boolean;
  /**
   * Fleet logins whose open PRs the sweep covers — the same push-capable set
   * the blocking guard defers `work-on` issues to.
   */
  fleetAuthors: readonly string[];
  /** List a repo's open PRs across the supplied authors. */
  listOpenPrs: (
    repo: string,
    authors: readonly string[],
  ) => Promise<readonly SweepablePr[]>;
  /**
   * Re-read the PR's live state at the claim point (Issue #1774).
   *
   * The listing this sweep walks is cached for up to ten minutes, and
   * `attemptMerge` writes to the PR. A PR closed since the listing is skipped;
   * so is one whose state cannot be read, which is never assumed open.
   */
  prLiveState: (
    repo: string,
    pr: SweepablePr,
  ) => Promise<PrLiveStateReading>;
  /**
   * Ask GitHub to update an armed PR's branch through the `update-branch`
   * REST endpoint (Issue #2462). Called only for a PR that is armed, behind
   * its base and ready to merge — review satisfied and checks passed (Issue
   * #4613) — and at most one such call per base per sweep pass. A failed
   * update is recorded and the sweep moves on.
   */
  updateBranchFn: (repo: string, prNumber: number) => Promise<Result<void>>;
  /**
   * Whether a base branch is behind a GitHub merge queue (Issue #4424). An
   * armed, behind PR on a queued base is not sent to `updateBranchFn`: the
   * queue tests it against its future head, and auto-merge is already armed.
   * The queue check runs before the ready-to-merge test (Issue #4613), so a
   * queued base never reaches the one-per-base rule.
   */
  isMergeQueueBase: (repo: string, baseRefName: string) => Promise<boolean>;
  /**
   * Re-check the PR's base before any arming or branch update (Issue #3433).
   * `hold` records the outcome and skips the PR; `proceed` with `disarmed`
   * means auto-merge was just disarmed, so the PR is treated as unarmed.
   */
  checkBaseIntegrity: (
    repo: string,
    pr: SweepablePr,
    armed: boolean,
  ) => Promise<
    | { action: "hold"; outcome: EnableAutoMergeResult }
    | { action: "proceed"; disarmed: boolean }
  >;
  /** Attempt the merge for one PR. */
  attemptMerge: (
    repo: string,
    pr: SweepablePr,
  ) => Promise<EnableAutoMergeResult>;
  /** Record the outcome (Issue #470 — a gate may refuse, not refuse silently). */
  recordOutcome: (
    repo: string,
    prNumber: number,
    outcome: EnableAutoMergeResult,
  ) => void;
  /** Drop the repo's cached open-PR list after a merge attempt mutated it. */
  invalidateOpenPrCache: (repo: string) => Promise<void>;
  /** Logger. */
  logger: Pick<Logger, "info" | "warn">;
}

/** What one sweep did. */
export interface SweepAutoMergeSummary {
  /** Repositories the sweep visited (allowlisted, listing succeeded or not). */
  reposVisited: string[];
  /** PRs a merge was attempted for. */
  prsAttempted: number;
  /**
   * Repositories whose listing succeeded and returned no open fleet PR
   * (Issue #1136). Named, not counted away: "the sweep found nothing" and
   * "the sweep refused everything" must never read the same in the log.
   */
  reposWithNoCandidates: string[];
  /**
   * PRs the live-state re-read stood the sweep down on (Issue #1774) —
   * closed, merged, or unreadable. Counted apart from `prsAttempted` so a
   * sweep that attempted nothing because everything had already landed does
   * not read like a sweep that found nothing at all.
   */
  prsSkippedNotOpen: number;
}

/**
 * Sweep every monitored repository's open fleet PRs for auto-merge.
 *
 * Best-effort at both levels and loud about it: a repo whose PR listing fails
 * is logged and skipped, and a PR whose attempt throws is logged and skipped,
 * so one unreachable repo can never stop the fleet from landing the rest.
 */
export async function sweepAutoMerge(
  options: SweepAutoMergeOptions,
): Promise<Result<SweepAutoMergeSummary>> {
  const {
    repos,
    isRepoAllowed,
    fleetAuthors,
    listOpenPrs,
    prLiveState,
    updateBranchFn,
    isMergeQueueBase,
    checkBaseIntegrity,
    attemptMerge,
    recordOutcome,
    invalidateOpenPrCache,
    logger,
  } = options;

  const summary: SweepAutoMergeSummary = {
    reposVisited: [],
    prsAttempted: 0,
    reposWithNoCandidates: [],
    prsSkippedNotOpen: 0,
  };
  const authors = fleetAuthors.join(", ");
  // Issue #4424: a PR with no base ref is "not queued". A base whose queue
  // lookup throws is also "not queued" — today's behaviour — but never
  // silently: it is logged at WARNING naming the repo, the base and the cause.
  const isBaseQueued = async (
    repo: string,
    pr: SweepablePr,
  ): Promise<boolean> => {
    if (!pr.baseRefName) return false;
    try {
      return await isMergeQueueBase(repo, pr.baseRefName);
    } catch (err) {
      logger.warn(
        `Auto-merge sweep: merge-queue lookup for ${repo} base ${pr.baseRefName} threw — treating the base as not queued (Issue #4424): ${
          sanitiseLogField(errorMessage(err))
        }`,
        { repo, baseRefName: pr.baseRefName },
      );
      return false;
    }
  };
  // Issue #1515: one quota exhaustion is one line, not one per repository.
  const quota = new RepoLoopQuotaStop(
    "Auto-merge sweep",
    repos.length,
    (message) => logger.warn(message),
  );

  try {
    for (const repo of repos) {
      if (quota.latchedBeforeRepo()) break;
      if (!isRepoAllowed(repo)) {
        quota.repoDone();
        continue;
      }
      summary.reposVisited.push(repo);

      let prs: readonly SweepablePr[];
      try {
        prs = await listOpenPrs(repo, fleetAuthors);
      } catch (err) {
        if (quota.isQuotaFailure(err)) break;
        logger.warn("Auto-merge sweep could not list open PRs", {
          repo,
          error: errorMessage(err),
        });
        quota.repoDone();
        continue;
      }

      // Issue #1136: say what this repo contributed. Without these lines the
      // whole pass produced one log entry — the priority's name — so an
      // unswept PR was indistinguishable from an empty backlog.
      if (prs.length === 0) {
        summary.reposWithNoCandidates.push(repo);
        logger.info("Auto-merge sweep: no candidates", { repo, authors });
        quota.repoDone();
        continue;
      }
      logger.info(
        `Auto-merge sweep: candidates: ${prs.length}`,
        { repo, authors, prNumbers: prs.map((pr) => pr.number).join(", ") },
      );

      let mutated = false;
      // Issue #4613: the bases this pass has already sent an update to. A base
      // is added only when GitHub accepted the update.
      const updatedBases = new Set<string>();
      // One live read per PR per pass (Issue #1774): the in-flight check below
      // and the main loop share it, so a PR is never read twice.
      const readings = new Map<number, Promise<PrLiveStateReading>>();
      const readingOf = (pr: SweepablePr): Promise<PrLiveStateReading> => {
        let memo = readings.get(pr.number);
        if (memo === undefined) {
          memo = (async (): Promise<PrLiveStateReading> => {
            try {
              return await prLiveState(repo, pr);
            } catch (err) {
              return { unknown: true, error: errorMessage(err) };
            }
          })();
          readings.set(pr.number, memo);
        }
        return memo;
      };
      // Issue #4613: a PR is in flight on its base when it is armed, up to
      // date, mergeable, approved and its checks have passed or are still
      // pending. It is about to land, so another PR on that base waits for it.
      // An unreadable check is not in flight.
      const findInFlightOnBase = async (
        pr: SweepablePr,
      ): Promise<SweepablePr | undefined> => {
        const base = pr.baseRefName ?? "";
        for (const other of prs) {
          if (other.number === pr.number) continue;
          if ((other.baseRefName ?? "") !== base) continue;
          if (other.isDraft === true) continue;
          if (
            other.labels?.some((l) => l.name?.toLowerCase() === "needs-human")
          ) {
            continue;
          }
          const reading = await readingOf(other);
          if (reading.open !== true) continue;
          if (
            reading.armed === true && reading.behind !== true &&
            reading.mergeable !== "CONFLICTING" &&
            reading.reviewSatisfied === true &&
            (reading.checks === "passed" || reading.checks === "pending")
          ) {
            return other;
          }
        }
        return undefined;
      };
      for (const pr of prs) {
        // Owner rule 2026-11-01: a needs-human PR waits on a person. Updating
        // its branch only reruns CI, so the sweep leaves it alone.
        if (
          pr.labels?.some((l) => l.name?.toLowerCase() === "needs-human")
        ) {
          logger.info(
            "Auto-merge sweep: skipping needs-human PR — it waits on a person",
            { repo, prNumber: pr.number },
          );
          continue;
        }
        // Issue #1800: `gh pr merge --auto` on a draft is refused with
        // "Pull Request is still a draft", and every cycle used to log that
        // refusal as a failure. A draft is the author asking for eyes, not
        // a merge candidate — skip it, and say so once per process.
        if (pr.isDraft === true) {
          const key = `${repo}#${pr.number}`;
          if (!announcedDrafts.has(key)) {
            announcedDrafts.add(key);
            logger.info(
              "Auto-merge sweep: skipping draft PR — auto-merge cannot be " +
                "armed until it is marked ready for review (Issue #1800)",
              { repo, prNumber: pr.number },
            );
          }
          continue;
        }

        // Issue #1774: one live `pr view` before the merge attempt. A PR
        // closed or merged since the cached listing gets no further write,
        // and an unreadable state is skipped this cycle rather than assumed
        // open — the next sweep asks again. Deliberately outside the try
        // below: a state read that failed is not "the merge attempt threw",
        // and reporting it as one would name the wrong cause.
        const reading = await readingOf(pr);
        if (!reading.open) {
          summary.prsSkippedNotOpen++;
          logPrLiveSkip(logger, "Auto-merge sweep", repo, pr.number, reading);
          continue;
        }

        // Issue #3433: auto-merge follows the base. This runs before the
        // armed+behind path below, which skips `attemptMerge` entirely.
        let armedNow = reading.armed === true;
        try {
          const check = await checkBaseIntegrity(repo, pr, armedNow);
          if (check.action === "hold") {
            recordOutcome(repo, pr.number, check.outcome);
            continue;
          }
          if (check.disarmed) armedNow = false;
        } catch (err) {
          logger.warn("Auto-merge sweep base check threw — not arming", {
            repo,
            prNumber: pr.number,
            error: errorMessage(err),
          });
          continue;
        }

        // Issue #2462: an armed PR whose head falls behind its base stays
        // open forever under the strict up-to-date policy — GitHub never
        // updates the branch itself, and re-arming does not either. Ask for
        // an update, then leave the merge attempt to the next pass (no retry
        // loop here — `handleMergeAttempt`'s ladder owns the rest).
        // This deliberately overlaps the git-based `decidePrUpdateAction`
        // in pr_branch_update.ts: that pass owns unarmed branch upkeep for
        // its own candidates, while this one only unblocks an already-armed
        // merge. A conflicting PR is never updated — GitHub would refuse it.
        //
        // Issue #4613: nor is one that could not merge yet. The update is for
        // a PR that is ready to merge — review satisfied and checks passed —
        // and only one PR per base is updated per pass. None is updated while
        // another PR on the same base is ready and already up to date, so a
        // queue of ready PRs does not keep restarting each other's CI. A
        // failed update leaves nothing in flight, so the next ready PR may try.
        //
        // Issue #2702: nor is one a reviewer has blocked. It cannot merge
        // until the review is answered, so the update unblocks nothing — and
        // on GRQ#5032 it moved the head underneath the owner's review. The
        // merge attempt is skipped too: auto-merge is already armed.
        //
        // Issue #4424: nor is one on a base behind a merge queue. The queue
        // tests the PR against its future head, so an update only moves that
        // head; the queue lands the PR once it is green. The merge attempt is
        // skipped too: auto-merge is already armed.
        if (
          armedNow && reading.behind === true &&
          reading.changesRequested === true
        ) {
          logger.info(
            "Auto-merge sweep: armed PR is behind its base, but a reviewer " +
              "requested changes (CHANGES_REQUESTED) — no branch update " +
              "until the review is answered (Issue #2702)",
            { repo, prNumber: pr.number },
          );
          continue;
        }
        if (
          armedNow && reading.behind === true &&
          reading.mergeable !== "CONFLICTING" &&
          await isBaseQueued(repo, pr)
        ) {
          logger.info(
            "Auto-merge sweep: armed PR is behind its base, which is behind a " +
              "GitHub merge queue — no branch update; the queue tests the PR " +
              "against its future head and lands it (Issue #4424)",
            { repo, prNumber: pr.number },
          );
          continue;
        }
        if (
          armedNow && reading.behind === true &&
          reading.mergeable !== "CONFLICTING"
        ) {
          // Issue #4613: a PR that could not merge yet is not updated.
          let notReady: string | undefined;
          if (reading.reviewSatisfied !== true) {
            notReady = "review not satisfied";
          } else if (reading.checks !== "passed") {
            notReady = `checks ${
              reading.checks ?? "unreadable"
            } on its current head`;
          }
          if (notReady !== undefined) {
            logger.info(
              "Auto-merge sweep: armed PR is behind its base, but is not ready " +
                `to merge (${notReady}) — no branch update; it is refreshed ` +
                "only once it can merge, one PR per base at a time (Issue #4613)",
              { repo, prNumber: pr.number },
            );
            continue;
          }
          const base = pr.baseRefName ?? "";
          if (updatedBases.has(base)) {
            logger.info(
              "Auto-merge sweep: armed PR is behind its base and ready, but " +
                "another PR on this base was already updated this pass " +
                "(Issue #4613) — no branch update",
              { repo, prNumber: pr.number },
            );
            continue;
          }
          const inFlight = await findInFlightOnBase(pr);
          if (inFlight !== undefined) {
            logger.info(
              "Auto-merge sweep: armed PR is behind its base and ready, but " +
                `#${inFlight.number} on the same base is ready and already up ` +
                "to date — waiting for it to merge or fail before updating " +
                "another (Issue #4613)",
              { repo, prNumber: pr.number, inFlightPrNumber: inFlight.number },
            );
            continue;
          }
          try {
            const update = await updateBranchFn(repo, pr.number);
            if (update.ok) updatedBases.add(base);
            recordOutcome(
              repo,
              pr.number,
              update.ok
                ? {
                  result: AutoMergeResult.BranchUpdateRequested,
                  message: "armed PR behind its base — branch update requested",
                }
                : {
                  result: AutoMergeResult.Failed,
                  message: `branch update failed: ${update.error.message}`,
                },
            );
          } catch (err) {
            recordOutcome(repo, pr.number, {
              result: AutoMergeResult.Failed,
              message: `branch update failed: ${errorMessage(err)}`,
            });
          }
          continue;
        }

        try {
          const outcome = await attemptMerge(repo, pr);
          recordOutcome(repo, pr.number, outcome);
          summary.prsAttempted++;
          mutated = true;
        } catch (err) {
          logger.warn("Auto-merge attempt threw", {
            repo,
            prNumber: pr.number,
            error: errorMessage(err),
          });
        }
      }

      // Enabling auto-merge can close a PR immediately when the checks
      // already pass, so the cached open-PR list is stale from here on.
      if (mutated) {
        try {
          await invalidateOpenPrCache(repo);
        } catch (err) {
          logger.warn("Auto-merge sweep could not invalidate the PR cache", {
            repo,
            error: errorMessage(err),
          });
        }
      }
      quota.repoDone();
    }
    return { ok: true, value: summary };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
