/**
 * Close-aware cache and registry maintenance at the `gh` chokepoint
 * (Issue #181).
 *
 * Nothing invalidated the scan caches when the worker itself closed an issue,
 * so the 600 s `issues_all` entry kept describing a closed issue as open and
 * the next pool entry re-claimed it. Hooking the single `gh` chokepoint
 * (`spawnGh`) covers every close path at once — the idle-task wrapper
 * closure, close-on-merge, the self-healing closes and the stale-workflow
 * purge — instead of each one remembering to invalidate for itself.
 *
 * Two things happen on a successful `gh issue close`:
 *
 *   1. the issue is recorded in the run's {@link ProcessedIssueRegistry}, so
 *      the scan excludes it and the claim path refuses it regardless of any
 *      cache TTL; and
 *   2. the repo's close-sensitive cache entries are removed, so the next scan
 *      re-reads the list from GitHub.
 *
 * A `gh issue reopen` does the reverse: the entry is dropped and the same
 * cache keys are invalidated, so a deliberately reopened issue is claimable
 * again in the same run.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { classifyGhMutation } from "./audit_mutation_classifier.ts";
import type { IssueCache } from "./issue_cache.ts";
import {
  type ProcessedIssueRegistry,
  sharedProcessedIssues,
} from "./processed_issue_registry.ts";

/** The scan cache whose entries a close invalidates. */
let scanCache: IssueCache | undefined;

/**
 * Register the scan cache the worker reads its issue lists from, so a close
 * can invalidate the entries that describe the issue as open. Called once at
 * start-up; without it the registry alone (which is authoritative) guards
 * against re-claiming.
 */
export function setScanCacheForCloseInvalidation(
  cache: IssueCache | undefined,
): void {
  scanCache = cache;
}

/**
 * Cache keys whose contents describe an issue's open/closed state and are
 * therefore stale the moment it is closed or reopened.
 *
 * `issues_all` is the open-issue list the scan ranks; `issues_closed_all` is
 * its closed counterpart; the two per-issue keys carry label and linked-PR
 * state read during pickup.
 */
export function closeInvalidatedCacheKeys(issueNumber: number): string[] {
  return [
    "issues_all",
    "issues_closed_all",
    `issue_labels_${issueNumber}`,
    `pr_linkage_open_v2_${issueNumber}`,
  ];
}

/**
 * The issue number a close/reopen argument vector targets.
 *
 * `gh issue close` accepts the number in any positional slot, and the worker
 * uses both shapes — `close 21 --repo o/r` and `close --repo o/r 21`
 * (`milestone_completion.ts`). The scan therefore takes the first bare integer
 * that is not the value of a preceding flag, so a `--repo`, `--reason` or
 * `--comment` value is never mistaken for the target.
 *
 * @returns The issue number, or undefined when the vector names none.
 */
export function issueNumberFromCloseArgs(
  args: readonly string[],
  verb: "close" | "reopen",
): number | undefined {
  const verbIndex = args.indexOf(verb);
  if (verbIndex < 0) return undefined;
  for (let i = verbIndex + 1; i < args.length; i++) {
    const token = args[i]!;
    if (token.startsWith("-")) continue;
    // A value belonging to the preceding flag, not a positional.
    if (args[i - 1]?.startsWith("-")) continue;
    if (/^\d+$/.test(token)) return Number(token);
  }
  return undefined;
}

/** Injectable seams for {@link noteGhIssueClose}. */
export interface NoteGhIssueCloseOptions {
  /** Registry to record into. Defaults to the run's shared registry. */
  registry?: ProcessedIssueRegistry;
  /** Cache to invalidate. Defaults to the registered scan cache. */
  cache?: IssueCache;
  /** Warning sink. Defaults to `console.warn`. */
  warn?: (message: string) => void;
}

/**
 * Note a `gh issue close` / `gh issue reopen` that has just run.
 *
 * Best-effort by contract: never throws, so bookkeeping can never turn a
 * successful `gh` call into a failure for the caller. A close whose target
 * repo or number cannot be derived from the argument vector is reported at
 * WARN rather than being dropped silently — the run would otherwise keep a
 * stale view of that issue with no trace of why.
 *
 * @param args - The argument vector passed to `gh`.
 * @param exitCode - The process exit code (only 0 changes any state).
 */
export async function noteGhIssueClose(
  args: readonly string[],
  exitCode: number,
  options: NoteGhIssueCloseOptions = {},
): Promise<void> {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  try {
    const info = classifyGhMutation(args);
    if (!info) return;
    if (info.verb !== "issue-close" && info.verb !== "issue-reopen") return;
    // A refused or failed close changed nothing on GitHub.
    if (exitCode !== 0) return;

    const issueNumber = issueNumberFromCloseArgs(
      args,
      info.verb === "issue-close" ? "close" : "reopen",
    );
    if (!info.repo || issueNumber === undefined || issueNumber <= 0) {
      warn(
        `[issue_close_notifier] cannot_note_${info.verb} ` +
          `repo=${info.repo ?? "(undeterminable)"} ` +
          `issue=${issueNumber ?? "(undeterminable)"} — the scan cache and ` +
          `the per-run registry were NOT updated for this close (Issue #181)`,
      );
      return;
    }

    const registry = options.registry ?? sharedProcessedIssues();
    if (info.verb === "issue-close") {
      registry.record(info.repo, issueNumber, "closed");
    } else {
      registry.forget(info.repo, issueNumber);
    }

    const cache = options.cache ?? scanCache;
    if (!cache) return;
    for (const key of closeInvalidatedCacheKeys(issueNumber)) {
      await cache.invalidate(info.repo, key);
    }
  } catch (err) {
    warn(
      `[issue_close_notifier] note_failed error=${
        err instanceof Error ? err.message : String(err)
      } args=${args.slice(0, 3).join(" ")} (Issue #181)`,
    );
  }
}
