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
}

/**
 * Build the lookup key. GitHub repository names are case-insensitive, and the
 * spelling reaching this registry comes from two sources (the config's repo
 * list and a `gh --repo` argument), so the key is normalised.
 */
function keyOf(repo: string, issueNumber: number): string {
  return `${repo.toLowerCase()}|${issueNumber}`;
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
  ): void {
    const key = keyOf(repo, issueNumber);
    const existing = this.entries.get(key);
    if (existing?.reason === "closed" && reason !== "closed") return;
    this.entries.set(key, { repo, issueNumber, reason });
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
