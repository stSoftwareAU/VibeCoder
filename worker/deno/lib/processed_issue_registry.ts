/**
 * Per-run registry of issues this worker has already finished with
 * (Issue #181).
 *
 * The scan ranks a cached `issues_all` list whose TTL is 600 s, so an issue
 * the worker finished — or closed — seconds ago is still in that list on the
 * next pool entry. Nothing local said "done with this one", so the scan
 * re-claimed a closed idle-task wrapper three times in a row while thirteen
 * open wrappers in the same repo went untouched.
 *
 * This registry is that local memory. It is in-process and one process is one
 * run, so an entry lives exactly as long as the run does. It costs no API
 * call: the scan simply skips what it already handled.
 *
 * ```mermaid
 * flowchart LR
 *     P["processIssue<br/>terminal outcome"] --> R["ProcessedIssueRegistry"]
 *     C["gh issue close<br/>(chokepoint)"] --> R
 *     R --> F["findNextIssue<br/>excludes"]
 *     R --> K["claimIssue<br/>refuses already_closed"]
 * ```
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** Why an issue is finished for this run. */
export type ProcessedIssueReason =
  /** The run completed successfully (including "no PR expected"). */
  | "success"
  /** The run bounced — claim rejected, pre-check refused, expected skip. */
  | "skip"
  /** The run failed. */
  | "failure"
  /** The worker itself closed the issue during this run. */
  | "closed";

/** One recorded issue. */
export interface ProcessedIssueEntry {
  /** `owner/repo`, as supplied when recorded. */
  repo: string;
  /** Issue number. */
  issueNumber: number;
  /** Why it is finished for this run. */
  reason: ProcessedIssueReason;
  /**
   * For a `skip` that was a refused claim: the claim path's reason key
   * (Issue #2405), e.g. `stream_affinity`. Absent on every other record.
   */
  claimRefusal?: string;
}

/**
 * Claim refusals that **defer** an issue — leave it with nobody working it.
 *
 * Every other refusal means someone else holds the issue (`already_assigned`,
 * `stream_busy`, `recent_claim`, a claim lost to a named winner): a healthy
 * fleet, and a legitimate hold. A deferral is the claim path declining ready
 * work on its own judgement, so the idle census must go on seeing the issue as
 * claimable — that is what lets a deferral that never ends raise the
 * idle-inversion escalation instead of hiding behind the run-local hold, as
 * stream affinity did for 23 hours (Issue #2403).
 *
 * A new deferring check in `claim_issue.ts` belongs on this list.
 */
export const CLAIM_DEFERRAL_REASONS: readonly string[] = ["stream_affinity"];

/** Is this claim refusal a deferral? See {@link CLAIM_DEFERRAL_REASONS}. */
export function isClaimDeferral(claimRefusal: string | undefined): boolean {
  return claimRefusal !== undefined &&
    CLAIM_DEFERRAL_REASONS.includes(claimRefusal);
}

/**
 * Build the lookup key. GitHub repository names are case-insensitive, and the
 * spelling reaching this registry comes from two sources (the config's repo
 * list and a `gh --repo` argument), so the key is normalised.
 */
function keyOf(repo: string, issueNumber: number): string {
  return `${repo.toLowerCase()}|${issueNumber}`;
}

/**
 * Should this run-local hold hide the issue from the idle detectors
 * (Issue #2405)?
 *
 * `idle_detect_diagnostics.ts` takes one yes/no per issue, so the distinction
 * the census draws with `deferredHolds` is made here for it: a hold the claim
 * path created by deferring the issue does **not** hide it. Both detectors
 * model the same gate; they must agree about it.
 *
 * @param registry - This run's processed issues.
 * @param isHeld - The run-local hold (cooldown + registry) for an issue.
 */
export function withholdsFromIdleDetection(
  registry: ProcessedIssueRegistry,
  isHeld: (repo: string, issueNumber: number) => boolean,
  repo: string,
  issueNumber: number,
): boolean {
  if (!isHeld(repo, issueNumber)) return false;
  return !isClaimDeferral(registry.claimRefusalFor(repo, issueNumber));
}

/** Issues finished during one run. */
export class ProcessedIssueRegistry {
  private readonly entries = new Map<string, ProcessedIssueEntry>();

  /**
   * Record a terminal outcome for an issue.
   *
   * A `closed` record is never downgraded by a later outcome: once the worker
   * has closed an issue, no subsequent bookkeeping can make it claimable
   * again within this run.
   */
  record(
    repo: string,
    issueNumber: number,
    reason: ProcessedIssueReason,
    detail: { claimRefusal?: string } = {},
  ): void {
    const key = keyOf(repo, issueNumber);
    const existing = this.entries.get(key);
    if (existing?.reason === "closed" && reason !== "closed") return;
    this.entries.set(key, {
      repo,
      issueNumber,
      reason,
      // Only a skip can be a refused claim; any later outcome replaces it.
      ...(reason === "skip" && detail.claimRefusal
        ? { claimRefusal: detail.claimRefusal }
        : {}),
    });
  }

  /** The claim refusal behind this issue's hold, when that is what it is. */
  claimRefusalFor(repo: string, issueNumber: number): string | undefined {
    return this.entries.get(keyOf(repo, issueNumber))?.claimRefusal;
  }

  /** True when this issue has already been finished during this run. */
  has(repo: string, issueNumber: number): boolean {
    return this.entries.has(keyOf(repo, issueNumber));
  }

  /** Why the issue is finished, or undefined when it is not recorded. */
  reasonFor(
    repo: string,
    issueNumber: number,
  ): ProcessedIssueReason | undefined {
    return this.entries.get(keyOf(repo, issueNumber))?.reason;
  }

  /** True when the worker itself closed this issue during this run. */
  wasClosedByWorker(repo: string, issueNumber: number): boolean {
    return this.reasonFor(repo, issueNumber) === "closed";
  }

  /**
   * Drop an entry — used when the worker reopens an issue it closed, which
   * makes it legitimately claimable again.
   */
  forget(repo: string, issueNumber: number): void {
    this.entries.delete(keyOf(repo, issueNumber));
  }

  /** Number of issues recorded. */
  size(): number {
    return this.entries.size;
  }

  /** Every recorded entry. */
  list(): ProcessedIssueEntry[] {
    return [...this.entries.values()];
  }
}

/**
 * The process-wide registry. One process is one run, so this instance carries
 * exactly the run's own history — the `gh` chokepoint and the claim path use
 * it without having to be threaded a reference.
 */
let shared = new ProcessedIssueRegistry();

/** The process-wide registry for this run. */
export function sharedProcessedIssues(): ProcessedIssueRegistry {
  return shared;
}

/** Replace the process-wide registry with an empty one. Test-only. */
export function resetSharedProcessedIssues(): void {
  shared = new ProcessedIssueRegistry();
}
