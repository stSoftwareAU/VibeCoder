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
 *      re-reads the list from GitHub. That includes every per-milestone
 *      closed list (`issues_closed_milestone_<n>`, Issue #3662), since a
 *      close does not say which milestone the issue is in.
 *
 * A `gh issue reopen` does the reverse: the entry is dropped and the same
 * cache keys are invalidated, so a deliberately reopened issue is claimable
 * again in the same run.
 *
 * The REST form is a close too (Issue #1753): the idle-task wrapper closure
 * moved to `gh api -X PATCH repos/o/r/issues/N -f state=closed` so it lands
 * under the primary-quota latch, and a close the notifier did not recognise
 * would have re-created the Issue #181 re-claim it exists to prevent. The
 * shape is read by `classifyIssueLifecycle`, the same classifier the
 * agent-side guard uses, so the two can never disagree about what closes an
 * issue.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { classifyGhMutation } from "./audit_mutation_classifier.ts";
import { classifyIssueLifecycle } from "./gh_issue_lifecycle.ts";
import { CLOSED_MILESTONE_CACHE_PREFIX, ISSUE_STATE_CACHE_PREFIX } from "./issue_cache.ts";
import { sharedProcessedIssues } from "./processed_issue_registry.ts";
/** The scan cache whose entries a close invalidates. */ let scanCache;
/**
 * Register the scan cache the worker reads its issue lists from, so a close
 * can invalidate the entries that describe the issue as open. Called once at
 * start-up; without it the registry alone (which is authoritative) guards
 * against re-claiming.
 */ export function setScanCacheForCloseInvalidation(cache) {
  scanCache = cache;
}
/**
 * Cache keys whose contents describe an issue's open/closed state and are
 * therefore stale the moment it is closed or reopened.
 *
 * `issues_all` is the open-issue list the scan ranks; `issues_closed_all` is
 * its closed counterpart; the two per-issue keys carry label and linked-PR
 * state read during pickup.
 */ export function closeInvalidatedCacheKeys(issueNumber) {
  return [
    "issues_all",
    "issues_closed_all",
    `issue_labels_${issueNumber}`,
    `pr_linkage_open_v2_${issueNumber}`,
    // Issue #1818: the dependency fetcher's cached state for this issue.
    `${ISSUE_STATE_CACHE_PREFIX}${issueNumber}`
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
 */ export function issueNumberFromCloseArgs(args, verb) {
  const verbIndex = args.indexOf(verb);
  if (verbIndex < 0) return undefined;
  for(let i = verbIndex + 1; i < args.length; i++){
    const token = args[i];
    if (token.startsWith("-")) continue;
    // A value belonging to the preceding flag, not a positional.
    if (args[i - 1]?.startsWith("-")) continue;
    if (/^\d+$/.test(token)) return Number(token);
  }
  return undefined;
}
/**
 * Read a close/reopen out of a classified mutation, in either form.
 *
 * `gh issue close|reopen` keeps the positional scan
 * {@link issueNumberFromCloseArgs} performs (either argument order); a REST
 * PATCH on `repos/o/r/issues/N` carrying `state=` is read by
 * `classifyIssueLifecycle` (Issue #1753). Anything else — a comment, a label,
 * a title edit, a PR operation — is `undefined`.
 */ function issueStateChangeFrom(args, info) {
  if (info.verb === "issue-close" || info.verb === "issue-reopen") {
    const verb = info.verb === "issue-close" ? "close" : "reopen";
    const issueNumber = issueNumberFromCloseArgs(args, verb);
    return {
      verb,
      ...info.repo ? {
        repo: info.repo
      } : {},
      ...issueNumber !== undefined ? {
        issueNumber
      } : {}
    };
  }
  if (!info.verb.startsWith("api-")) return undefined;
  const attempt = classifyIssueLifecycle(args, info);
  if (attempt === undefined) return undefined;
  if (attempt.verb !== "close" && attempt.verb !== "reopen") return undefined;
  return {
    verb: attempt.verb,
    ...attempt.repo ? {
      repo: attempt.repo
    } : {},
    ...attempt.issueNumber !== undefined ? {
      issueNumber: attempt.issueNumber
    } : {}
  };
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
 */ export async function noteGhIssueClose(args, exitCode, options = {}) {
  const warn = options.warn ?? ((message)=>console.warn(message));
  try {
    const info = classifyGhMutation(args);
    if (!info) return;
    const change = issueStateChangeFrom(args, info);
    if (change === undefined) return;
    // A refused or failed close changed nothing on GitHub.
    if (exitCode !== 0) return;
    const { verb, repo, issueNumber } = change;
    if (!repo || issueNumber === undefined || issueNumber <= 0) {
      warn(`[issue_close_notifier] cannot_note_issue-${verb} ` + `repo=${repo ?? "(undeterminable)"} ` + `issue=${issueNumber ?? "(undeterminable)"} — the scan cache and ` + `the per-run registry were NOT updated for this close (Issue #181)`);
      return;
    }
    const registry = options.registry ?? sharedProcessedIssues();
    if (verb === "close") {
      registry.record(repo, issueNumber, "closed");
    } else {
      registry.forget(repo, issueNumber);
    }
    const cache = options.cache ?? scanCache;
    if (!cache) return;
    for (const key of closeInvalidatedCacheKeys(issueNumber)){
      await cache.invalidate(repo, key);
    }
    // Issue #3662: the per-milestone closed lists are keyed by milestone
    // number, which a close or reopen does not carry, so all of them go.
    await cache.invalidatePrefix(repo, CLOSED_MILESTONE_CACHE_PREFIX);
  } catch (err) {
    warn(`[issue_close_notifier] note_failed error=${err instanceof Error ? err.message : String(err)} args=${args.slice(0, 3).join(" ")} (Issue #181)`);
  }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9pc3N1ZV9jbG9zZV9ub3RpZmllci50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIENsb3NlLWF3YXJlIGNhY2hlIGFuZCByZWdpc3RyeSBtYWludGVuYW5jZSBhdCB0aGUgYGdoYCBjaG9rZXBvaW50XG4gKiAoSXNzdWUgIzE4MSkuXG4gKlxuICogTm90aGluZyBpbnZhbGlkYXRlZCB0aGUgc2NhbiBjYWNoZXMgd2hlbiB0aGUgd29ya2VyIGl0c2VsZiBjbG9zZWQgYW4gaXNzdWUsXG4gKiBzbyB0aGUgNjAwIHMgYGlzc3Vlc19hbGxgIGVudHJ5IGtlcHQgZGVzY3JpYmluZyBhIGNsb3NlZCBpc3N1ZSBhcyBvcGVuIGFuZFxuICogdGhlIG5leHQgcG9vbCBlbnRyeSByZS1jbGFpbWVkIGl0LiBIb29raW5nIHRoZSBzaW5nbGUgYGdoYCBjaG9rZXBvaW50XG4gKiAoYHNwYXduR2hgKSBjb3ZlcnMgZXZlcnkgY2xvc2UgcGF0aCBhdCBvbmNlIOKAlCB0aGUgaWRsZS10YXNrIHdyYXBwZXJcbiAqIGNsb3N1cmUsIGNsb3NlLW9uLW1lcmdlLCB0aGUgc2VsZi1oZWFsaW5nIGNsb3NlcyBhbmQgdGhlIHN0YWxlLXdvcmtmbG93XG4gKiBwdXJnZSDigJQgaW5zdGVhZCBvZiBlYWNoIG9uZSByZW1lbWJlcmluZyB0byBpbnZhbGlkYXRlIGZvciBpdHNlbGYuXG4gKlxuICogVHdvIHRoaW5ncyBoYXBwZW4gb24gYSBzdWNjZXNzZnVsIGBnaCBpc3N1ZSBjbG9zZWA6XG4gKlxuICogICAxLiB0aGUgaXNzdWUgaXMgcmVjb3JkZWQgaW4gdGhlIHJ1bidzIHtAbGluayBQcm9jZXNzZWRJc3N1ZVJlZ2lzdHJ5fSwgc29cbiAqICAgICAgdGhlIHNjYW4gZXhjbHVkZXMgaXQgYW5kIHRoZSBjbGFpbSBwYXRoIHJlZnVzZXMgaXQgcmVnYXJkbGVzcyBvZiBhbnlcbiAqICAgICAgY2FjaGUgVFRMOyBhbmRcbiAqICAgMi4gdGhlIHJlcG8ncyBjbG9zZS1zZW5zaXRpdmUgY2FjaGUgZW50cmllcyBhcmUgcmVtb3ZlZCwgc28gdGhlIG5leHQgc2NhblxuICogICAgICByZS1yZWFkcyB0aGUgbGlzdCBmcm9tIEdpdEh1Yi4gVGhhdCBpbmNsdWRlcyBldmVyeSBwZXItbWlsZXN0b25lXG4gKiAgICAgIGNsb3NlZCBsaXN0IChgaXNzdWVzX2Nsb3NlZF9taWxlc3RvbmVfPG4+YCwgSXNzdWUgIzM2NjIpLCBzaW5jZSBhXG4gKiAgICAgIGNsb3NlIGRvZXMgbm90IHNheSB3aGljaCBtaWxlc3RvbmUgdGhlIGlzc3VlIGlzIGluLlxuICpcbiAqIEEgYGdoIGlzc3VlIHJlb3BlbmAgZG9lcyB0aGUgcmV2ZXJzZTogdGhlIGVudHJ5IGlzIGRyb3BwZWQgYW5kIHRoZSBzYW1lXG4gKiBjYWNoZSBrZXlzIGFyZSBpbnZhbGlkYXRlZCwgc28gYSBkZWxpYmVyYXRlbHkgcmVvcGVuZWQgaXNzdWUgaXMgY2xhaW1hYmxlXG4gKiBhZ2FpbiBpbiB0aGUgc2FtZSBydW4uXG4gKlxuICogVGhlIFJFU1QgZm9ybSBpcyBhIGNsb3NlIHRvbyAoSXNzdWUgIzE3NTMpOiB0aGUgaWRsZS10YXNrIHdyYXBwZXIgY2xvc3VyZVxuICogbW92ZWQgdG8gYGdoIGFwaSAtWCBQQVRDSCByZXBvcy9vL3IvaXNzdWVzL04gLWYgc3RhdGU9Y2xvc2VkYCBzbyBpdCBsYW5kc1xuICogdW5kZXIgdGhlIHByaW1hcnktcXVvdGEgbGF0Y2gsIGFuZCBhIGNsb3NlIHRoZSBub3RpZmllciBkaWQgbm90IHJlY29nbmlzZVxuICogd291bGQgaGF2ZSByZS1jcmVhdGVkIHRoZSBJc3N1ZSAjMTgxIHJlLWNsYWltIGl0IGV4aXN0cyB0byBwcmV2ZW50LiBUaGVcbiAqIHNoYXBlIGlzIHJlYWQgYnkgYGNsYXNzaWZ5SXNzdWVMaWZlY3ljbGVgLCB0aGUgc2FtZSBjbGFzc2lmaWVyIHRoZVxuICogYWdlbnQtc2lkZSBndWFyZCB1c2VzLCBzbyB0aGUgdHdvIGNhbiBuZXZlciBkaXNhZ3JlZSBhYm91dCB3aGF0IGNsb3NlcyBhblxuICogaXNzdWUuXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbiwgZXRjLikuXG4gKi9cblxuaW1wb3J0IHtcbiAgY2xhc3NpZnlHaE11dGF0aW9uLFxuICB0eXBlIE11dGF0aW9uSW5mbyxcbn0gZnJvbSBcIi4vYXVkaXRfbXV0YXRpb25fY2xhc3NpZmllci50c1wiO1xuaW1wb3J0IHsgY2xhc3NpZnlJc3N1ZUxpZmVjeWNsZSB9IGZyb20gXCIuL2doX2lzc3VlX2xpZmVjeWNsZS50c1wiO1xuaW1wb3J0IHR5cGUgeyBJc3N1ZUNhY2hlIH0gZnJvbSBcIi4vaXNzdWVfY2FjaGUudHNcIjtcbmltcG9ydCB7XG4gIENMT1NFRF9NSUxFU1RPTkVfQ0FDSEVfUFJFRklYLFxuICBJU1NVRV9TVEFURV9DQUNIRV9QUkVGSVgsXG59IGZyb20gXCIuL2lzc3VlX2NhY2hlLnRzXCI7XG5pbXBvcnQge1xuICB0eXBlIFByb2Nlc3NlZElzc3VlUmVnaXN0cnksXG4gIHNoYXJlZFByb2Nlc3NlZElzc3Vlcyxcbn0gZnJvbSBcIi4vcHJvY2Vzc2VkX2lzc3VlX3JlZ2lzdHJ5LnRzXCI7XG5cbi8qKiBUaGUgc2NhbiBjYWNoZSB3aG9zZSBlbnRyaWVzIGEgY2xvc2UgaW52YWxpZGF0ZXMuICovXG5sZXQgc2NhbkNhY2hlOiBJc3N1ZUNhY2hlIHwgdW5kZWZpbmVkO1xuXG4vKipcbiAqIFJlZ2lzdGVyIHRoZSBzY2FuIGNhY2hlIHRoZSB3b3JrZXIgcmVhZHMgaXRzIGlzc3VlIGxpc3RzIGZyb20sIHNvIGEgY2xvc2VcbiAqIGNhbiBpbnZhbGlkYXRlIHRoZSBlbnRyaWVzIHRoYXQgZGVzY3JpYmUgdGhlIGlzc3VlIGFzIG9wZW4uIENhbGxlZCBvbmNlIGF0XG4gKiBzdGFydC11cDsgd2l0aG91dCBpdCB0aGUgcmVnaXN0cnkgYWxvbmUgKHdoaWNoIGlzIGF1dGhvcml0YXRpdmUpIGd1YXJkc1xuICogYWdhaW5zdCByZS1jbGFpbWluZy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNldFNjYW5DYWNoZUZvckNsb3NlSW52YWxpZGF0aW9uKFxuICBjYWNoZTogSXNzdWVDYWNoZSB8IHVuZGVmaW5lZCxcbik6IHZvaWQge1xuICBzY2FuQ2FjaGUgPSBjYWNoZTtcbn1cblxuLyoqXG4gKiBDYWNoZSBrZXlzIHdob3NlIGNvbnRlbnRzIGRlc2NyaWJlIGFuIGlzc3VlJ3Mgb3Blbi9jbG9zZWQgc3RhdGUgYW5kIGFyZVxuICogdGhlcmVmb3JlIHN0YWxlIHRoZSBtb21lbnQgaXQgaXMgY2xvc2VkIG9yIHJlb3BlbmVkLlxuICpcbiAqIGBpc3N1ZXNfYWxsYCBpcyB0aGUgb3Blbi1pc3N1ZSBsaXN0IHRoZSBzY2FuIHJhbmtzOyBgaXNzdWVzX2Nsb3NlZF9hbGxgIGlzXG4gKiBpdHMgY2xvc2VkIGNvdW50ZXJwYXJ0OyB0aGUgdHdvIHBlci1pc3N1ZSBrZXlzIGNhcnJ5IGxhYmVsIGFuZCBsaW5rZWQtUFJcbiAqIHN0YXRlIHJlYWQgZHVyaW5nIHBpY2t1cC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNsb3NlSW52YWxpZGF0ZWRDYWNoZUtleXMoaXNzdWVOdW1iZXI6IG51bWJlcik6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIFtcbiAgICBcImlzc3Vlc19hbGxcIixcbiAgICBcImlzc3Vlc19jbG9zZWRfYWxsXCIsXG4gICAgYGlzc3VlX2xhYmVsc18ke2lzc3VlTnVtYmVyfWAsXG4gICAgYHByX2xpbmthZ2Vfb3Blbl92Ml8ke2lzc3VlTnVtYmVyfWAsXG4gICAgLy8gSXNzdWUgIzE4MTg6IHRoZSBkZXBlbmRlbmN5IGZldGNoZXIncyBjYWNoZWQgc3RhdGUgZm9yIHRoaXMgaXNzdWUuXG4gICAgYCR7SVNTVUVfU1RBVEVfQ0FDSEVfUFJFRklYfSR7aXNzdWVOdW1iZXJ9YCxcbiAgXTtcbn1cblxuLyoqXG4gKiBUaGUgaXNzdWUgbnVtYmVyIGEgY2xvc2UvcmVvcGVuIGFyZ3VtZW50IHZlY3RvciB0YXJnZXRzLlxuICpcbiAqIGBnaCBpc3N1ZSBjbG9zZWAgYWNjZXB0cyB0aGUgbnVtYmVyIGluIGFueSBwb3NpdGlvbmFsIHNsb3QsIGFuZCB0aGUgd29ya2VyXG4gKiB1c2VzIGJvdGggc2hhcGVzIOKAlCBgY2xvc2UgMjEgLS1yZXBvIG8vcmAgYW5kIGBjbG9zZSAtLXJlcG8gby9yIDIxYFxuICogKGBtaWxlc3RvbmVfY29tcGxldGlvbi50c2ApLiBUaGUgc2NhbiB0aGVyZWZvcmUgdGFrZXMgdGhlIGZpcnN0IGJhcmUgaW50ZWdlclxuICogdGhhdCBpcyBub3QgdGhlIHZhbHVlIG9mIGEgcHJlY2VkaW5nIGZsYWcsIHNvIGEgYC0tcmVwb2AsIGAtLXJlYXNvbmAgb3JcbiAqIGAtLWNvbW1lbnRgIHZhbHVlIGlzIG5ldmVyIG1pc3Rha2VuIGZvciB0aGUgdGFyZ2V0LlxuICpcbiAqIEByZXR1cm5zIFRoZSBpc3N1ZSBudW1iZXIsIG9yIHVuZGVmaW5lZCB3aGVuIHRoZSB2ZWN0b3IgbmFtZXMgbm9uZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzc3VlTnVtYmVyRnJvbUNsb3NlQXJncyhcbiAgYXJnczogcmVhZG9ubHkgc3RyaW5nW10sXG4gIHZlcmI6IFwiY2xvc2VcIiB8IFwicmVvcGVuXCIsXG4pOiBudW1iZXIgfCB1bmRlZmluZWQge1xuICBjb25zdCB2ZXJiSW5kZXggPSBhcmdzLmluZGV4T2YodmVyYik7XG4gIGlmICh2ZXJiSW5kZXggPCAwKSByZXR1cm4gdW5kZWZpbmVkO1xuICBmb3IgKGxldCBpID0gdmVyYkluZGV4ICsgMTsgaSA8IGFyZ3MubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCB0b2tlbiA9IGFyZ3NbaV0hO1xuICAgIGlmICh0b2tlbi5zdGFydHNXaXRoKFwiLVwiKSkgY29udGludWU7XG4gICAgLy8gQSB2YWx1ZSBiZWxvbmdpbmcgdG8gdGhlIHByZWNlZGluZyBmbGFnLCBub3QgYSBwb3NpdGlvbmFsLlxuICAgIGlmIChhcmdzW2kgLSAxXT8uc3RhcnRzV2l0aChcIi1cIikpIGNvbnRpbnVlO1xuICAgIGlmICgvXlxcZCskLy50ZXN0KHRva2VuKSkgcmV0dXJuIE51bWJlcih0b2tlbik7XG4gIH1cbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn1cblxuLyoqIEEgY2xvc2Ugb3IgcmVvcGVuIHRoZSBjaG9rZXBvaW50IGhhcyBqdXN0IHNlZW4sIHdoaWNoZXZlciBhcmd2IGZvcm0uICovXG5pbnRlcmZhY2UgSXNzdWVTdGF0ZUNoYW5nZSB7XG4gIHZlcmI6IFwiY2xvc2VcIiB8IFwicmVvcGVuXCI7XG4gIHJlcG8/OiBzdHJpbmc7XG4gIGlzc3VlTnVtYmVyPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIFJlYWQgYSBjbG9zZS9yZW9wZW4gb3V0IG9mIGEgY2xhc3NpZmllZCBtdXRhdGlvbiwgaW4gZWl0aGVyIGZvcm0uXG4gKlxuICogYGdoIGlzc3VlIGNsb3NlfHJlb3BlbmAga2VlcHMgdGhlIHBvc2l0aW9uYWwgc2NhblxuICoge0BsaW5rIGlzc3VlTnVtYmVyRnJvbUNsb3NlQXJnc30gcGVyZm9ybXMgKGVpdGhlciBhcmd1bWVudCBvcmRlcik7IGEgUkVTVFxuICogUEFUQ0ggb24gYHJlcG9zL28vci9pc3N1ZXMvTmAgY2FycnlpbmcgYHN0YXRlPWAgaXMgcmVhZCBieVxuICogYGNsYXNzaWZ5SXNzdWVMaWZlY3ljbGVgIChJc3N1ZSAjMTc1MykuIEFueXRoaW5nIGVsc2Ug4oCUIGEgY29tbWVudCwgYSBsYWJlbCxcbiAqIGEgdGl0bGUgZWRpdCwgYSBQUiBvcGVyYXRpb24g4oCUIGlzIGB1bmRlZmluZWRgLlxuICovXG5mdW5jdGlvbiBpc3N1ZVN0YXRlQ2hhbmdlRnJvbShcbiAgYXJnczogcmVhZG9ubHkgc3RyaW5nW10sXG4gIGluZm86IE11dGF0aW9uSW5mbyxcbik6IElzc3VlU3RhdGVDaGFuZ2UgfCB1bmRlZmluZWQge1xuICBpZiAoaW5mby52ZXJiID09PSBcImlzc3VlLWNsb3NlXCIgfHwgaW5mby52ZXJiID09PSBcImlzc3VlLXJlb3BlblwiKSB7XG4gICAgY29uc3QgdmVyYiA9IGluZm8udmVyYiA9PT0gXCJpc3N1ZS1jbG9zZVwiID8gXCJjbG9zZVwiIDogXCJyZW9wZW5cIjtcbiAgICBjb25zdCBpc3N1ZU51bWJlciA9IGlzc3VlTnVtYmVyRnJvbUNsb3NlQXJncyhhcmdzLCB2ZXJiKTtcbiAgICByZXR1cm4ge1xuICAgICAgdmVyYixcbiAgICAgIC4uLihpbmZvLnJlcG8gPyB7IHJlcG86IGluZm8ucmVwbyB9IDoge30pLFxuICAgICAgLi4uKGlzc3VlTnVtYmVyICE9PSB1bmRlZmluZWQgPyB7IGlzc3VlTnVtYmVyIH0gOiB7fSksXG4gICAgfTtcbiAgfVxuICBpZiAoIWluZm8udmVyYi5zdGFydHNXaXRoKFwiYXBpLVwiKSkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgY29uc3QgYXR0ZW1wdCA9IGNsYXNzaWZ5SXNzdWVMaWZlY3ljbGUoYXJncywgaW5mbyk7XG4gIGlmIChhdHRlbXB0ID09PSB1bmRlZmluZWQpIHJldHVybiB1bmRlZmluZWQ7XG4gIGlmIChhdHRlbXB0LnZlcmIgIT09IFwiY2xvc2VcIiAmJiBhdHRlbXB0LnZlcmIgIT09IFwicmVvcGVuXCIpIHJldHVybiB1bmRlZmluZWQ7XG4gIHJldHVybiB7XG4gICAgdmVyYjogYXR0ZW1wdC52ZXJiLFxuICAgIC4uLihhdHRlbXB0LnJlcG8gPyB7IHJlcG86IGF0dGVtcHQucmVwbyB9IDoge30pLFxuICAgIC4uLihhdHRlbXB0Lmlzc3VlTnVtYmVyICE9PSB1bmRlZmluZWRcbiAgICAgID8geyBpc3N1ZU51bWJlcjogYXR0ZW1wdC5pc3N1ZU51bWJlciB9XG4gICAgICA6IHt9KSxcbiAgfTtcbn1cblxuLyoqIEluamVjdGFibGUgc2VhbXMgZm9yIHtAbGluayBub3RlR2hJc3N1ZUNsb3NlfS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgTm90ZUdoSXNzdWVDbG9zZU9wdGlvbnMge1xuICAvKiogUmVnaXN0cnkgdG8gcmVjb3JkIGludG8uIERlZmF1bHRzIHRvIHRoZSBydW4ncyBzaGFyZWQgcmVnaXN0cnkuICovXG4gIHJlZ2lzdHJ5PzogUHJvY2Vzc2VkSXNzdWVSZWdpc3RyeTtcbiAgLyoqIENhY2hlIHRvIGludmFsaWRhdGUuIERlZmF1bHRzIHRvIHRoZSByZWdpc3RlcmVkIHNjYW4gY2FjaGUuICovXG4gIGNhY2hlPzogSXNzdWVDYWNoZTtcbiAgLyoqIFdhcm5pbmcgc2luay4gRGVmYXVsdHMgdG8gYGNvbnNvbGUud2FybmAuICovXG4gIHdhcm4/OiAobWVzc2FnZTogc3RyaW5nKSA9PiB2b2lkO1xufVxuXG4vKipcbiAqIE5vdGUgYSBgZ2ggaXNzdWUgY2xvc2VgIC8gYGdoIGlzc3VlIHJlb3BlbmAgdGhhdCBoYXMganVzdCBydW4uXG4gKlxuICogQmVzdC1lZmZvcnQgYnkgY29udHJhY3Q6IG5ldmVyIHRocm93cywgc28gYm9va2tlZXBpbmcgY2FuIG5ldmVyIHR1cm4gYVxuICogc3VjY2Vzc2Z1bCBgZ2hgIGNhbGwgaW50byBhIGZhaWx1cmUgZm9yIHRoZSBjYWxsZXIuIEEgY2xvc2Ugd2hvc2UgdGFyZ2V0XG4gKiByZXBvIG9yIG51bWJlciBjYW5ub3QgYmUgZGVyaXZlZCBmcm9tIHRoZSBhcmd1bWVudCB2ZWN0b3IgaXMgcmVwb3J0ZWQgYXRcbiAqIFdBUk4gcmF0aGVyIHRoYW4gYmVpbmcgZHJvcHBlZCBzaWxlbnRseSDigJQgdGhlIHJ1biB3b3VsZCBvdGhlcndpc2Uga2VlcCBhXG4gKiBzdGFsZSB2aWV3IG9mIHRoYXQgaXNzdWUgd2l0aCBubyB0cmFjZSBvZiB3aHkuXG4gKlxuICogQHBhcmFtIGFyZ3MgLSBUaGUgYXJndW1lbnQgdmVjdG9yIHBhc3NlZCB0byBgZ2hgLlxuICogQHBhcmFtIGV4aXRDb2RlIC0gVGhlIHByb2Nlc3MgZXhpdCBjb2RlIChvbmx5IDAgY2hhbmdlcyBhbnkgc3RhdGUpLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbm90ZUdoSXNzdWVDbG9zZShcbiAgYXJnczogcmVhZG9ubHkgc3RyaW5nW10sXG4gIGV4aXRDb2RlOiBudW1iZXIsXG4gIG9wdGlvbnM6IE5vdGVHaElzc3VlQ2xvc2VPcHRpb25zID0ge30sXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3Qgd2FybiA9IG9wdGlvbnMud2FybiA/PyAoKG1lc3NhZ2U6IHN0cmluZykgPT4gY29uc29sZS53YXJuKG1lc3NhZ2UpKTtcbiAgdHJ5IHtcbiAgICBjb25zdCBpbmZvID0gY2xhc3NpZnlHaE11dGF0aW9uKGFyZ3MpO1xuICAgIGlmICghaW5mbykgcmV0dXJuO1xuICAgIGNvbnN0IGNoYW5nZSA9IGlzc3VlU3RhdGVDaGFuZ2VGcm9tKGFyZ3MsIGluZm8pO1xuICAgIGlmIChjaGFuZ2UgPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xuICAgIC8vIEEgcmVmdXNlZCBvciBmYWlsZWQgY2xvc2UgY2hhbmdlZCBub3RoaW5nIG9uIEdpdEh1Yi5cbiAgICBpZiAoZXhpdENvZGUgIT09IDApIHJldHVybjtcblxuICAgIGNvbnN0IHsgdmVyYiwgcmVwbywgaXNzdWVOdW1iZXIgfSA9IGNoYW5nZTtcbiAgICBpZiAoIXJlcG8gfHwgaXNzdWVOdW1iZXIgPT09IHVuZGVmaW5lZCB8fCBpc3N1ZU51bWJlciA8PSAwKSB7XG4gICAgICB3YXJuKFxuICAgICAgICBgW2lzc3VlX2Nsb3NlX25vdGlmaWVyXSBjYW5ub3Rfbm90ZV9pc3N1ZS0ke3ZlcmJ9IGAgK1xuICAgICAgICAgIGByZXBvPSR7cmVwbyA/PyBcIih1bmRldGVybWluYWJsZSlcIn0gYCArXG4gICAgICAgICAgYGlzc3VlPSR7aXNzdWVOdW1iZXIgPz8gXCIodW5kZXRlcm1pbmFibGUpXCJ9IOKAlCB0aGUgc2NhbiBjYWNoZSBhbmQgYCArXG4gICAgICAgICAgYHRoZSBwZXItcnVuIHJlZ2lzdHJ5IHdlcmUgTk9UIHVwZGF0ZWQgZm9yIHRoaXMgY2xvc2UgKElzc3VlICMxODEpYCxcbiAgICAgICk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgcmVnaXN0cnkgPSBvcHRpb25zLnJlZ2lzdHJ5ID8/IHNoYXJlZFByb2Nlc3NlZElzc3VlcygpO1xuICAgIGlmICh2ZXJiID09PSBcImNsb3NlXCIpIHtcbiAgICAgIHJlZ2lzdHJ5LnJlY29yZChyZXBvLCBpc3N1ZU51bWJlciwgXCJjbG9zZWRcIik7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJlZ2lzdHJ5LmZvcmdldChyZXBvLCBpc3N1ZU51bWJlcik7XG4gICAgfVxuXG4gICAgY29uc3QgY2FjaGUgPSBvcHRpb25zLmNhY2hlID8/IHNjYW5DYWNoZTtcbiAgICBpZiAoIWNhY2hlKSByZXR1cm47XG4gICAgZm9yIChjb25zdCBrZXkgb2YgY2xvc2VJbnZhbGlkYXRlZENhY2hlS2V5cyhpc3N1ZU51bWJlcikpIHtcbiAgICAgIGF3YWl0IGNhY2hlLmludmFsaWRhdGUocmVwbywga2V5KTtcbiAgICB9XG4gICAgLy8gSXNzdWUgIzM2NjI6IHRoZSBwZXItbWlsZXN0b25lIGNsb3NlZCBsaXN0cyBhcmUga2V5ZWQgYnkgbWlsZXN0b25lXG4gICAgLy8gbnVtYmVyLCB3aGljaCBhIGNsb3NlIG9yIHJlb3BlbiBkb2VzIG5vdCBjYXJyeSwgc28gYWxsIG9mIHRoZW0gZ28uXG4gICAgYXdhaXQgY2FjaGUuaW52YWxpZGF0ZVByZWZpeChyZXBvLCBDTE9TRURfTUlMRVNUT05FX0NBQ0hFX1BSRUZJWCk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHdhcm4oXG4gICAgICBgW2lzc3VlX2Nsb3NlX25vdGlmaWVyXSBub3RlX2ZhaWxlZCBlcnJvcj0ke1xuICAgICAgICBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycilcbiAgICAgIH0gYXJncz0ke2FyZ3Muc2xpY2UoMCwgMykuam9pbihcIiBcIil9IChJc3N1ZSAjMTgxKWAsXG4gICAgKTtcbiAgfVxufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NB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
// denoCacheMetadata=9515173866846036505,4288409413688021924