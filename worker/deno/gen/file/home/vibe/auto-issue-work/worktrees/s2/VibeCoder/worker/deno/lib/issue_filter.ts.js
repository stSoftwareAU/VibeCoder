/**
 * Issue filtering and sorting logic (Issue #910).
 *
 * Replaces worker/shared/issue_filter.sh with type-safe TypeScript.
 * Handles assignee-based filtering, milestone occupancy checks,
 * label exclusion, reopened issue detection, and author-based filtering.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */ import { runGhCommand } from "./github.ts";
import { invalidateTimelineCache } from "./timeline_cache.ts";
import { fetchTimelineWithCache } from "./issue_query.ts";
import { LABEL_DEFAULTS } from "./config_defaults.ts";
/**
 * HTML comment marker embedded in milestone tracking issue bodies.
 * Used as the primary detection mechanism to prevent the worker from
 * processing tracking issues as regular work items (Issue #1134).
 */ export { MILESTONE_TRACKING_MARKER } from "./milestone_tracking_marker.ts";
/**
 * Fallback title pattern for pre-existing milestone tracking issues
 * that were created before the body marker was introduced (Issue #1134).
 */ const MILESTONE_TRACKING_TITLE_PATTERN = /^Merge milestone '.+' to .+$/;
/** Name-only head of the marker; older bodies vary in the trailing prose. */ const MILESTONE_TRACKING_MARKER_HEAD = "<!-- milestone-tracking-issue";
/** Opening or closing line of a CommonMark fenced code block. */ const CODE_FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
/** A line that opens with the marker; a tab or 4+ spaces is indented code. */ const LIVE_MARKER_LINE_RE = new RegExp(`^ {0,3}${MILESTONE_TRACKING_MARKER_HEAD}`);
/**
 * Return true when `body` carries the tracker marker as a live HTML comment
 * (Issue #2673): a line opening with it, indented at most three spaces,
 * outside a fenced code block — the CommonMark HTML-block position the
 * worker writes it in. A marker quoted in prose, inline code or a code block
 * is a *mention*: Migration_v21#450 quoted it while asking for tracker
 * cleanup, the scan dropped it as a tracker and the census, counting it
 * claimable, filed a false idle-inversion alert every cycle.
 */ export function hasLiveMilestoneTrackingMarker(body) {
  if (!body?.includes(MILESTONE_TRACKING_MARKER_HEAD)) return false;
  let fence = null;
  for (const line of body.split("\n")){
    const fenceMatch = CODE_FENCE_RE.exec(line)?.[1];
    if (fence !== null) {
      // A fence closes only on the same character, at least as long.
      if (fenceMatch && fenceMatch[0] === fence[0] && fenceMatch.length >= fence.length) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch;
      continue;
    }
    if (LIVE_MARKER_LINE_RE.test(line)) return true;
  }
  return false;
}
/**
 * Detect whether an issue is a milestone tracking issue.
 *
 * Uses two checks (defence in depth):
 * 1. Primary: body carries the live HTML marker comment
 *    ({@link hasLiveMilestoneTrackingMarker}; a quoted marker does not count).
 * 2. Fallback: title matches the tracking issue title pattern
 *    (for pre-existing issues without the marker).
 *
 * @param issue - Issue to check
 * @returns True if the issue is a milestone tracking issue
 */ export function isMilestoneTrackingIssue(issue) {
  // Primary check — body marker
  if (hasLiveMilestoneTrackingMarker(issue.body)) {
    return true;
  }
  // Fallback — title pattern for backfill (pre-existing tracking issues)
  if (MILESTONE_TRACKING_TITLE_PATTERN.test(issue.title)) {
    return true;
  }
  return false;
}
/**
 * Filter issues to exclude those with any assignees.
 *
 * Only keeps unassigned issues. In multi-worker setups where workers
 * share the same GitHub username, an assigned issue means another worker
 * is actively working on it.
 *
 * @param issues - Array of issues to filter
 * @returns Only unassigned issues
 */ export function filterByAssignee(issues) {
  return issues.filter((issue)=>issue.assignees.length === 0);
}
/**
 * The stream-sharing tiers under the fleet's **default** label names
 * (Issues #2530, #2532).
 *
 * For the readers that hold no operator config: the idle-decision census and
 * the idle-detect audit, which must apply exactly the rule the collectors do
 * or the `ALERT mis_classification` line fires on every tick. One constant,
 * because two copies of this literal is one drift away from that alert.
 * Callers that do have config (the collectors, the claim phase) pass the
 * operator's own labels instead.
 */ export const DEFAULT_STREAM_SHARING_TIERS = {
  issueLabels: [
    LABEL_DEFAULTS.topPriorityLabel
  ],
  workOnLabel: LABEL_DEFAULTS.workOnLabel
};
/**
 * Whether an issue's tier may join a milestone stream another host already
 * holds (Issue #2530).
 *
 * The fleet-wide one-run-per-stream lock (Issue #2334) exists so a stream's
 * shared conversation carries one run at a time. `top-priority` and `work-on`
 * are the tiers a human has asked for now: they are claimed anyway and run in
 * their own per-issue conversation, so the stream's transcript is never shared
 * by two runs. Every other tier (`low-priority`, `idle-task`) still waits.
 *
 * Labels are compared case- and whitespace-insensitively, because a label is
 * operator-typed on both sides of this comparison.
 *
 * @param labels - Labels the issue actually carries
 * @param tiers - The configured tier labels to match against
 * @returns True when the issue carries a stream-sharing tier label
 */ export function isStreamSharingTier(labels, tiers) {
  const normalise = (label)=>label.trim().toLowerCase();
  const applied = new Set(labels.map(normalise).filter((l)=>l.length > 0));
  return [
    ...tiers.issueLabels ?? [],
    tiers.workOnLabel ?? ""
  ].map(normalise).filter((label)=>label.length > 0).some((label)=>applied.has(label));
}
/**
 * Check whether a work stream is already occupied by a Vibe Coder.
 *
 * Scheduling exists only **between Vibe Coders**. There is no locking or
 * scheduling between humans and Vibe Coders, so a human assignee never
 * occupies a work stream and never stalls the worker.
 *
 * Fleet-aware (Issue #3099): a work stream is "occupied" when an issue in the
 * same milestone/branch is assigned to ANY account the fleet operates — the
 * current host OR a sibling host. In a multi-account fleet
 * (e.g. `Vibecoderbot`, `stsvcbot`) another host's assignment is otherwise
 * invisible, so a second host would not consider the work stream occupied and
 * would start the same issue — the root cause of duplicate PRs (#3095). The
 * underlying issue data already carries every assignee, so widening the match
 * set requires no extra GitHub calls.
 *
 * Issue #1064: the fleet set MUST be resolved by
 * `resolveFleetMaintenanceAuthorSet` (host login + `fleet_pr_authors` +
 * `service_accounts`) — the same push-capable set `getBlockingPRForIssue`
 * uses. Callers used to pass `config.allowedAuthors`, which is a
 * **permission** list ("whose issues may we work on") and legitimately holds
 * humans; one human-assigned issue therefore parked a whole work stream for
 * ~21 hours while higher-priority unassigned work sat filtered out. The
 * parameter is named `pushCapableAuthors` rather than `allowedAuthors`
 * precisely so the permission list cannot be handed to it again by habit.
 *
 * @param allIssues - All open issues in the repo
 * @param milestoneTitle - Milestone to check (empty string for non-milestone)
 * @param workerUser - The current host's GitHub login
 * @param pushCapableAuthors - The accounts the fleet operates, from
 *   `resolveFleetMaintenanceAuthorSet`. NEVER `config.allowedAuthors`. The
 *   current host is always counted even if omitted here.
 * @returns True if the work stream holds a fleet-assigned issue (occupied)
 */ export function isMilestoneOccupied(allIssues, milestoneTitle, workerUser, pushCapableAuthors = []) {
  const fleetAccounts = fleetAccountSet(workerUser, pushCapableAuthors);
  return allIssues.some((issue)=>{
    if (issue.milestone !== milestoneTitle) return false;
    return issue.assignees.some((a)=>fleetAccounts.has(a.toLowerCase()));
  });
}
/**
 * Case-insensitive fleet set, matching the lowercase convention used by
 * `filterByAllowedAuthors`. The current host is always included so a
 * misconfigured fleet list never drops this host's own assignments.
 */ function fleetAccountSet(workerUser, pushCapableAuthors) {
  return new Set([
    workerUser,
    ...pushCapableAuthors
  ].map((a)=>a.toLowerCase()));
}
/**
 * Whether **this one issue** is already assigned to an account the fleet
 * operates (Issue #2532).
 *
 * The stream-level question is {@link isMilestoneOccupied}; this is the
 * issue-level one the stream-sharing tiers still have to ask. `work-on` and
 * `top-priority` candidates share a busy stream, but the single issue a
 * sibling slot on this host already holds must never be re-offered — and in
 * the window before the GitHub assignment lands, the only record of that hold
 * is the overlay `applyInFlightClaims` (`work_stream.ts`) writes onto the
 * all-issues listing. A human's assignment is ignored here for the same
 * reason it is ignored there: scheduling exists only between Vibe Coders.
 *
 * @param allIssues - All open issues in the repo, with any in-flight overlay
 * @param issueNumber - The candidate under consideration
 * @param workerUser - The current host's GitHub login
 * @param pushCapableAuthors - The accounts the fleet operates, from
 *   `resolveFleetMaintenanceAuthorSet`. NEVER `config.allowedAuthors`.
 * @returns True when the fleet already holds this issue
 */ export function isIssueFleetAssigned(allIssues, issueNumber, workerUser, pushCapableAuthors = []) {
  const fleetAccounts = fleetAccountSet(workerUser, pushCapableAuthors);
  return allIssues.some((issue)=>issue.number === issueNumber && issue.assignees.some((a)=>fleetAccounts.has(a.toLowerCase())));
}
/**
 * Filter and sort issues by excluding blocking labels.
 *
 * Filters out:
 * - Issues with assignees (in multi-worker setups)
 * - Issues with any blocking label (needs-human, planning, etc.) — never
 *   `failed`, which no longer parks an issue (Issue #4158)
 *
 * Sorts by createdAt ascending (oldest first).
 *
 * @param issues - Issues to filter
 * @param labels - Label configuration for exclusion
 * @returns Filtered and sorted issues
 */ export function filterAndSort(issues, labels) {
  const blockingLabels = new Set([
    labels.needsRevisionLabel,
    labels.refineIssueLabel,
    labels.planningLabel,
    labels.questionLabel,
    // Issue #1470, #2031: needs-human — worker explicitly handed back to a
    // human; never re-pick during discovery. Issue #2031 retired the
    // standalone `needs-clarification` label and folded the clarification
    // handoff onto `needs-human`.
    labels.needsHumanLabel
  ]);
  return issues.filter((issue)=>{
    if (issue.assignees.length > 0) return false;
    if (issue.labels.some((l)=>blockingLabels.has(l))) return false;
    // Issue #1134: skip milestone tracking issues
    if (isMilestoneTrackingIssue(issue)) return false;
    return true;
  }).sort((a, b)=>a.createdAt.localeCompare(b.createdAt));
}
/**
 * Filter issues to only include those by allowed authors.
 *
 * @param issues - Issues to filter
 * @param allowedAuthors - Authorised GitHub usernames
 * @returns Issues from allowed authors only
 */ export function filterByAllowedAuthors(issues, allowedAuthors) {
  const authorSet = new Set(allowedAuthors.map((a)=>a.toLowerCase()));
  return issues.filter((issue)=>authorSet.has(issue.author.toLowerCase()));
}
/**
 * Generate filter diagnostics for logging.
 *
 * @param issues - Issues to diagnose
 * @param failedLabel - Label for permanently failed issues
 * @param needsHumanLabel - Label for issues handed back to a human (Issue #2031)
 * @returns Diagnostic counts
 */ export function getFilterDiagnostics(issues, failedLabel, needsHumanLabel) {
  return {
    total: issues.length,
    assignedToOthers: issues.filter((i)=>i.assignees.length > 0).length,
    withFailedLabel: issues.filter((i)=>i.labels.includes(failedLabel)).length,
    withNeedsHumanLabel: issues.filter((i)=>i.labels.includes(needsHumanLabel)).length
  };
}
/**
 * Check if an issue was reopened after a specific label was applied.
 *
 * @param timeline - Timeline events from GitHub API
 * @param labelName - Label to check
 * @returns True if reopened after the label was applied
 */ export function wasReopenedAfterLabel(timeline, labelName) {
  const lastLabeled = timeline.filter((e)=>e.event === "labeled" && e.label?.name === labelName).map((e)=>e.created_at).pop() ?? "";
  const lastReopened = timeline.filter((e)=>e.event === "reopened").map((e)=>e.created_at).pop() ?? "";
  return lastReopened !== "" && lastLabeled !== "" && lastReopened > lastLabeled;
}
/**
 * Find stale failure labels on an issue.
 *
 * Issue #2031: `needs-clarification` was retired — the stale-label
 * cleanup no longer touches it. Only the failure labels remain in the
 * stale set.
 *
 * Issue #4158: `failed` is always stale. The worker no longer applies it,
 * because parking an assigned issue is a failure of the Vibe Coder, so one
 * still on an issue is a leftover to strip. `failed-once` is stale only
 * once the issue was reopened after it was applied.
 *
 * @param issueLabels - Current labels on the issue
 * @param timeline - Timeline events from GitHub API
 * @param failedLabel - Label for permanently failed issues
 * @param failedOnceLabel - Label for first-failure issues
 * @returns Array of stale label names that should be removed
 */ export function getStaleLabelsForReopenedIssue(issueLabels, timeline, failedLabel, failedOnceLabel) {
  const checkLabels = [
    failedLabel,
    failedOnceLabel
  ];
  return checkLabels.filter((label)=>issueLabels.includes(label) && (label === failedLabel || wasReopenedAfterLabel(timeline, label)));
}
/**
 * Clean stale labels from reopened issues.
 *
 * For each issue with a blocking label, checks the GitHub timeline API
 * to see if the issue was reopened after the label was applied. If so,
 * removes the stale labels.
 *
 * Issue #1785: Routes timeline reads through `TimelineCache` so the
 * cold-call-per-iteration pattern (one `gh api .../timeline` call per
 * blocked issue per iteration) collapses to one read every TTL window.
 * Worker-initiated label removal invalidates the cached entry so the
 * next iteration sees fresh data.
 *
 * Issue #2031: `needs-clarification` retired — only the failure labels
 * are subject to reopened-issue stale cleanup.
 *
 * @param issues - Issues to check
 * @param repo - Repository in "owner/repo" format
 * @param failedLabel - Label for permanently failed issues
 * @param failedOnceLabel - Label for first-failure issues
 * @param ghCommandFn - Optional gh command function for testing
 * @param cache - Optional timeline cache for read-through
 * @returns Updated issues with stale labels removed
 */ export async function cleanStaleLabels(issues, repo, failedLabel, failedOnceLabel, ghCommandFn = runGhCommand, cache) {
  const blockingLabels = new Set([
    failedLabel,
    failedOnceLabel
  ]);
  const result = [
    ...issues
  ];
  for(let i = 0; i < result.length; i++){
    const issue = result[i];
    const hasBlocking = issue.labels.some((l)=>blockingLabels.has(l));
    if (!hasBlocking) continue;
    // Issue #4158: a leftover `failed` needs no timeline to be stale, so
    // an unreadable timeline must not strand the issue behind it.
    const timeline = await fetchTimelineWithCache(repo, issue.number, ghCommandFn, cache) ?? [];
    const staleLabels = getStaleLabelsForReopenedIssue(issue.labels, timeline, failedLabel, failedOnceLabel);
    let mutated = false;
    for (const label of staleLabels){
      try {
        await ghCommandFn([
          "issue",
          "edit",
          String(issue.number),
          "--repo",
          repo,
          "--remove-label",
          label
        ]);
        mutated = true;
      } catch  {
      // Non-fatal — continue
      }
    }
    // Worker-initiated label change must invalidate the cached
    // timeline so the next read sees the fresh state.
    if (mutated) {
      await invalidateTimelineCache(repo, issue.number, cache);
    }
    if (staleLabels.length > 0) {
      const staleSet = new Set(staleLabels);
      result[i] = {
        ...issue,
        labels: issue.labels.filter((l)=>!staleSet.has(l))
      };
    }
  }
  return result;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9pc3N1ZV9maWx0ZXIudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBJc3N1ZSBmaWx0ZXJpbmcgYW5kIHNvcnRpbmcgbG9naWMgKElzc3VlICM5MTApLlxuICpcbiAqIFJlcGxhY2VzIHdvcmtlci9zaGFyZWQvaXNzdWVfZmlsdGVyLnNoIHdpdGggdHlwZS1zYWZlIFR5cGVTY3JpcHQuXG4gKiBIYW5kbGVzIGFzc2lnbmVlLWJhc2VkIGZpbHRlcmluZywgbWlsZXN0b25lIG9jY3VwYW5jeSBjaGVja3MsXG4gKiBsYWJlbCBleGNsdXNpb24sIHJlb3BlbmVkIGlzc3VlIGRldGVjdGlvbiwgYW5kIGF1dGhvci1iYXNlZCBmaWx0ZXJpbmcuXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggc3BlbGxpbmcgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pXG4gKi9cblxuaW1wb3J0IHsgcnVuR2hDb21tYW5kIH0gZnJvbSBcIi4vZ2l0aHViLnRzXCI7XG5pbXBvcnQgdHlwZSB7IFRpbWVsaW5lQ2FjaGUgfSBmcm9tIFwiLi90aW1lbGluZV9jYWNoZS50c1wiO1xuaW1wb3J0IHsgaW52YWxpZGF0ZVRpbWVsaW5lQ2FjaGUgfSBmcm9tIFwiLi90aW1lbGluZV9jYWNoZS50c1wiO1xuaW1wb3J0IHsgZmV0Y2hUaW1lbGluZVdpdGhDYWNoZSB9IGZyb20gXCIuL2lzc3VlX3F1ZXJ5LnRzXCI7XG5pbXBvcnQgeyBMQUJFTF9ERUZBVUxUUyB9IGZyb20gXCIuL2NvbmZpZ19kZWZhdWx0cy50c1wiO1xuXG4vKipcbiAqIE1pbmltYWwgaXNzdWUgcmVwcmVzZW50YXRpb24gZm9yIGZpbHRlcmluZyBvcGVyYXRpb25zLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEZpbHRlcmFibGVJc3N1ZSB7XG4gIG51bWJlcjogbnVtYmVyO1xuICB0aXRsZTogc3RyaW5nO1xuICB1cmw6IHN0cmluZztcbiAgYXV0aG9yOiBzdHJpbmc7XG4gIGFzc2lnbmVlczogc3RyaW5nW107XG4gIGxhYmVsczogc3RyaW5nW107XG4gIGNyZWF0ZWRBdDogc3RyaW5nO1xuICBtaWxlc3RvbmU6IHN0cmluZztcbiAgLyoqIElzc3VlIGJvZHkgdGV4dCDigJQgdXNlZCBmb3IgbWlsZXN0b25lIHRyYWNraW5nIGlzc3VlIGRldGVjdGlvbi4gKi9cbiAgYm9keT86IHN0cmluZztcbiAgLyoqXG4gICAqIElTTyB0aW1lc3RhbXAgb2YgdGhlIGxhc3QgaXNzdWUgdXBkYXRlLiBPcHRpb25hbCBiZWNhdXNlIGxlZ2FjeVxuICAgKiBjYWNoZWQgZW50cmllcyBtYXkgcHJlLWRhdGUgdGhlIGZpZWxkIChJc3N1ZSAjMTc4NCDigJQgd2lyZWQgc28gdGhlXG4gICAqIHN0YWxlLXdvcmtmbG93IHNjYW4gY2FuIHJlYWQgZnJvbSB0aGUgc2hhcmVkIGBpc3N1ZXNfYWxsYCBjYWNoZSkuXG4gICAqL1xuICB1cGRhdGVkQXQ/OiBzdHJpbmc7XG4gIC8qKiBHaXRIdWIgbmF0aXZlIHN1Yi1pc3N1ZSBjb3VudHMgKElzc3VlICMzMzE0KTsgYWJzZW50IG9uIG9sZCBjYWNoZSBlbnRyaWVzLiAqL1xuICBzdWJJc3N1ZXNTdW1tYXJ5PzogeyB0b3RhbDogbnVtYmVyOyBjb21wbGV0ZWQ6IG51bWJlciB9O1xufVxuXG4vKipcbiAqIExhYmVsIGNvbmZpZ3VyYXRpb24gZm9yIGZpbHRlcmluZy5cbiAqXG4gKiBBbnkgaXNzdWUgY2Fycnlpbmcgb25lIG9mIHRoZXNlIGxhYmVscyBpcyBleGNsdWRlZCBmcm9tIGRpc2NvdmVyeSDigJQgc2VlXG4gKiBgZmlsdGVyQW5kU29ydGAuIE5vdGFibGUgc2tpcCByZWFzb25zOlxuICogLSBgbmVlZHNIdW1hbkxhYmVsYCAoXCJuZWVkcy1odW1hblwiKTogdGhlIHdvcmtlciBoYXMgaGFuZGVkIHRoZSBpc3N1ZSBiYWNrXG4gKiAgIHRvIGEgaHVtYW4gKElzc3VlICMxNDcwLCAjMjAzMSkuIERpc2NvdmVyeSBtdXN0IG5vdCByZS1waWNrIHRoZXNlXG4gKiAgIGlzc3Vlcywgb3RoZXJ3aXNlIHRoZSB3b3JrZXIgbG9vcHMgb24gdGFza3MgaXQgY2Fubm90IHByb2dyZXNzXG4gKiAgIGF1dG9ub21vdXNseS4gSXNzdWUgIzIwMzEgcmV0aXJlZCB0aGUgc2VwYXJhdGUgYG5lZWRzLWNsYXJpZmljYXRpb25gXG4gKiAgIGxhYmVsIGFuZCBjb25zb2xpZGF0ZWQgdGhlIGhhbmRvZmYgc2lnbmFsIG9udG8gYG5lZWRzLWh1bWFuYC5cbiAqXG4gKiBJc3N1ZSAjNDE1ODogYGZhaWxlZGAgaXMgbm90IGFtb25nIHRoZW0uIEFuIGFzc2lnbmVkIGlzc3VlIGlzIG5ldmVyXG4gKiBwYXJrZWQ6IGEgcmVwZWF0ZWQgZmFpbHVyZSBrZWVwcyBgZmFpbGVkLW9uY2VgIGFuZCBpdHMgY29vbGRvd24sIGFuZCBhXG4gKiBsZWZ0b3ZlciBgZmFpbGVkYCBpcyBzdHJpcHBlZCBhcyBzdGFsZSBieSBgY2xlYW5TdGFsZUxhYmVsc2AuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgRmlsdGVyTGFiZWxzIHtcbiAgbmVlZHNSZXZpc2lvbkxhYmVsOiBzdHJpbmc7XG4gIHJlZmluZUlzc3VlTGFiZWw6IHN0cmluZztcbiAgcGxhbm5pbmdMYWJlbDogc3RyaW5nO1xuICBxdWVzdGlvbkxhYmVsOiBzdHJpbmc7XG4gIC8qKiBMYWJlbCBmb3Igd29ya2VyLXRvLWh1bWFuIGVzY2FsYXRpb24gKElzc3VlICMxNDcwLCAjMjAzMSkgKi9cbiAgbmVlZHNIdW1hbkxhYmVsOiBzdHJpbmc7XG59XG5cbi8qKlxuICogRGlhZ25vc3RpYyBpbmZvcm1hdGlvbiBhYm91dCBmaWx0ZXJpbmcgcmVzdWx0cy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBGaWx0ZXJEaWFnbm9zdGljcyB7XG4gIHRvdGFsOiBudW1iZXI7XG4gIGFzc2lnbmVkVG9PdGhlcnM6IG51bWJlcjtcbiAgd2l0aEZhaWxlZExhYmVsOiBudW1iZXI7XG4gIHdpdGhOZWVkc0h1bWFuTGFiZWw6IG51bWJlcjtcbn1cblxuLyoqXG4gKiBIVE1MIGNvbW1lbnQgbWFya2VyIGVtYmVkZGVkIGluIG1pbGVzdG9uZSB0cmFja2luZyBpc3N1ZSBib2RpZXMuXG4gKiBVc2VkIGFzIHRoZSBwcmltYXJ5IGRldGVjdGlvbiBtZWNoYW5pc20gdG8gcHJldmVudCB0aGUgd29ya2VyIGZyb21cbiAqIHByb2Nlc3NpbmcgdHJhY2tpbmcgaXNzdWVzIGFzIHJlZ3VsYXIgd29yayBpdGVtcyAoSXNzdWUgIzExMzQpLlxuICovXG5leHBvcnQgeyBNSUxFU1RPTkVfVFJBQ0tJTkdfTUFSS0VSIH0gZnJvbSBcIi4vbWlsZXN0b25lX3RyYWNraW5nX21hcmtlci50c1wiO1xuXG4vKipcbiAqIEZhbGxiYWNrIHRpdGxlIHBhdHRlcm4gZm9yIHByZS1leGlzdGluZyBtaWxlc3RvbmUgdHJhY2tpbmcgaXNzdWVzXG4gKiB0aGF0IHdlcmUgY3JlYXRlZCBiZWZvcmUgdGhlIGJvZHkgbWFya2VyIHdhcyBpbnRyb2R1Y2VkIChJc3N1ZSAjMTEzNCkuXG4gKi9cbmNvbnN0IE1JTEVTVE9ORV9UUkFDS0lOR19USVRMRV9QQVRURVJOID0gL15NZXJnZSBtaWxlc3RvbmUgJy4rJyB0byAuKyQvO1xuXG4vKiogTmFtZS1vbmx5IGhlYWQgb2YgdGhlIG1hcmtlcjsgb2xkZXIgYm9kaWVzIHZhcnkgaW4gdGhlIHRyYWlsaW5nIHByb3NlLiAqL1xuY29uc3QgTUlMRVNUT05FX1RSQUNLSU5HX01BUktFUl9IRUFEID0gXCI8IS0tIG1pbGVzdG9uZS10cmFja2luZy1pc3N1ZVwiO1xuXG4vKiogT3BlbmluZyBvciBjbG9zaW5nIGxpbmUgb2YgYSBDb21tb25NYXJrIGZlbmNlZCBjb2RlIGJsb2NrLiAqL1xuY29uc3QgQ09ERV9GRU5DRV9SRSA9IC9eIHswLDN9KGB7Myx9fH57Myx9KS87XG5cbi8qKiBBIGxpbmUgdGhhdCBvcGVucyB3aXRoIHRoZSBtYXJrZXI7IGEgdGFiIG9yIDQrIHNwYWNlcyBpcyBpbmRlbnRlZCBjb2RlLiAqL1xuY29uc3QgTElWRV9NQVJLRVJfTElORV9SRSA9IG5ldyBSZWdFeHAoXG4gIGBeIHswLDN9JHtNSUxFU1RPTkVfVFJBQ0tJTkdfTUFSS0VSX0hFQUR9YCxcbik7XG5cbi8qKlxuICogUmV0dXJuIHRydWUgd2hlbiBgYm9keWAgY2FycmllcyB0aGUgdHJhY2tlciBtYXJrZXIgYXMgYSBsaXZlIEhUTUwgY29tbWVudFxuICogKElzc3VlICMyNjczKTogYSBsaW5lIG9wZW5pbmcgd2l0aCBpdCwgaW5kZW50ZWQgYXQgbW9zdCB0aHJlZSBzcGFjZXMsXG4gKiBvdXRzaWRlIGEgZmVuY2VkIGNvZGUgYmxvY2sg4oCUIHRoZSBDb21tb25NYXJrIEhUTUwtYmxvY2sgcG9zaXRpb24gdGhlXG4gKiB3b3JrZXIgd3JpdGVzIGl0IGluLiBBIG1hcmtlciBxdW90ZWQgaW4gcHJvc2UsIGlubGluZSBjb2RlIG9yIGEgY29kZSBibG9ja1xuICogaXMgYSAqbWVudGlvbio6IE1pZ3JhdGlvbl92MjEjNDUwIHF1b3RlZCBpdCB3aGlsZSBhc2tpbmcgZm9yIHRyYWNrZXJcbiAqIGNsZWFudXAsIHRoZSBzY2FuIGRyb3BwZWQgaXQgYXMgYSB0cmFja2VyIGFuZCB0aGUgY2Vuc3VzLCBjb3VudGluZyBpdFxuICogY2xhaW1hYmxlLCBmaWxlZCBhIGZhbHNlIGlkbGUtaW52ZXJzaW9uIGFsZXJ0IGV2ZXJ5IGN5Y2xlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaGFzTGl2ZU1pbGVzdG9uZVRyYWNraW5nTWFya2VyKFxuICBib2R5OiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkLFxuKTogYm9vbGVhbiB7XG4gIGlmICghYm9keT8uaW5jbHVkZXMoTUlMRVNUT05FX1RSQUNLSU5HX01BUktFUl9IRUFEKSkgcmV0dXJuIGZhbHNlO1xuICBsZXQgZmVuY2U6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBmb3IgKGNvbnN0IGxpbmUgb2YgYm9keS5zcGxpdChcIlxcblwiKSkge1xuICAgIGNvbnN0IGZlbmNlTWF0Y2ggPSBDT0RFX0ZFTkNFX1JFLmV4ZWMobGluZSk/LlsxXTtcbiAgICBpZiAoZmVuY2UgIT09IG51bGwpIHtcbiAgICAgIC8vIEEgZmVuY2UgY2xvc2VzIG9ubHkgb24gdGhlIHNhbWUgY2hhcmFjdGVyLCBhdCBsZWFzdCBhcyBsb25nLlxuICAgICAgaWYgKFxuICAgICAgICBmZW5jZU1hdGNoICYmIGZlbmNlTWF0Y2hbMF0gPT09IGZlbmNlWzBdICYmXG4gICAgICAgIGZlbmNlTWF0Y2gubGVuZ3RoID49IGZlbmNlLmxlbmd0aFxuICAgICAgKSBmZW5jZSA9IG51bGw7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGZlbmNlTWF0Y2gpIHtcbiAgICAgIGZlbmNlID0gZmVuY2VNYXRjaDtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoTElWRV9NQVJLRVJfTElORV9SRS50ZXN0KGxpbmUpKSByZXR1cm4gdHJ1ZTtcbiAgfVxuICByZXR1cm4gZmFsc2U7XG59XG5cbi8qKlxuICogRGV0ZWN0IHdoZXRoZXIgYW4gaXNzdWUgaXMgYSBtaWxlc3RvbmUgdHJhY2tpbmcgaXNzdWUuXG4gKlxuICogVXNlcyB0d28gY2hlY2tzIChkZWZlbmNlIGluIGRlcHRoKTpcbiAqIDEuIFByaW1hcnk6IGJvZHkgY2FycmllcyB0aGUgbGl2ZSBIVE1MIG1hcmtlciBjb21tZW50XG4gKiAgICAoe0BsaW5rIGhhc0xpdmVNaWxlc3RvbmVUcmFja2luZ01hcmtlcn07IGEgcXVvdGVkIG1hcmtlciBkb2VzIG5vdCBjb3VudCkuXG4gKiAyLiBGYWxsYmFjazogdGl0bGUgbWF0Y2hlcyB0aGUgdHJhY2tpbmcgaXNzdWUgdGl0bGUgcGF0dGVyblxuICogICAgKGZvciBwcmUtZXhpc3RpbmcgaXNzdWVzIHdpdGhvdXQgdGhlIG1hcmtlcikuXG4gKlxuICogQHBhcmFtIGlzc3VlIC0gSXNzdWUgdG8gY2hlY2tcbiAqIEByZXR1cm5zIFRydWUgaWYgdGhlIGlzc3VlIGlzIGEgbWlsZXN0b25lIHRyYWNraW5nIGlzc3VlXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc01pbGVzdG9uZVRyYWNraW5nSXNzdWUoaXNzdWU6IEZpbHRlcmFibGVJc3N1ZSk6IGJvb2xlYW4ge1xuICAvLyBQcmltYXJ5IGNoZWNrIOKAlCBib2R5IG1hcmtlclxuICBpZiAoaGFzTGl2ZU1pbGVzdG9uZVRyYWNraW5nTWFya2VyKGlzc3VlLmJvZHkpKSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICAvLyBGYWxsYmFjayDigJQgdGl0bGUgcGF0dGVybiBmb3IgYmFja2ZpbGwgKHByZS1leGlzdGluZyB0cmFja2luZyBpc3N1ZXMpXG4gIGlmIChNSUxFU1RPTkVfVFJBQ0tJTkdfVElUTEVfUEFUVEVSTi50ZXN0KGlzc3VlLnRpdGxlKSkge1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgcmV0dXJuIGZhbHNlO1xufVxuXG4vKipcbiAqIEZpbHRlciBpc3N1ZXMgdG8gZXhjbHVkZSB0aG9zZSB3aXRoIGFueSBhc3NpZ25lZXMuXG4gKlxuICogT25seSBrZWVwcyB1bmFzc2lnbmVkIGlzc3Vlcy4gSW4gbXVsdGktd29ya2VyIHNldHVwcyB3aGVyZSB3b3JrZXJzXG4gKiBzaGFyZSB0aGUgc2FtZSBHaXRIdWIgdXNlcm5hbWUsIGFuIGFzc2lnbmVkIGlzc3VlIG1lYW5zIGFub3RoZXIgd29ya2VyXG4gKiBpcyBhY3RpdmVseSB3b3JraW5nIG9uIGl0LlxuICpcbiAqIEBwYXJhbSBpc3N1ZXMgLSBBcnJheSBvZiBpc3N1ZXMgdG8gZmlsdGVyXG4gKiBAcmV0dXJucyBPbmx5IHVuYXNzaWduZWQgaXNzdWVzXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmaWx0ZXJCeUFzc2lnbmVlKGlzc3VlczogRmlsdGVyYWJsZUlzc3VlW10pOiBGaWx0ZXJhYmxlSXNzdWVbXSB7XG4gIHJldHVybiBpc3N1ZXMuZmlsdGVyKChpc3N1ZSkgPT4gaXNzdWUuYXNzaWduZWVzLmxlbmd0aCA9PT0gMCk7XG59XG5cbi8qKlxuICogVGhlIHR3byBkaXNjb3ZlcnkgdGllcnMgd2hvc2UgaXNzdWVzIHNoYXJlIGEgYnVzeSBtaWxlc3RvbmUgc3RyZWFtXG4gKiAoSXNzdWUgIzI1MzApIOKAlCB0aGUgY29uZmlndXJlZCBgdG9wLXByaW9yaXR5YCB0aWVyIGFuZCBgd29yay1vbmAuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgU3RyZWFtU2hhcmluZ0xhYmVscyB7XG4gIC8qKiBDb25maWd1cmVkLWxhYmVsIGRpc2NvdmVyeSB0aWVyIOKAlCBgY29uZmlnLmlzc3VlTGFiZWxzYC4gKi9cbiAgaXNzdWVMYWJlbHM/OiByZWFkb25seSBzdHJpbmdbXTtcbiAgLyoqIFRoZSBgd29yay1vbmAgbGFiZWwg4oCUIGBjb25maWcud29ya09uTGFiZWxgLiAqL1xuICB3b3JrT25MYWJlbD86IHN0cmluZztcbn1cblxuLyoqXG4gKiBUaGUgc3RyZWFtLXNoYXJpbmcgdGllcnMgdW5kZXIgdGhlIGZsZWV0J3MgKipkZWZhdWx0KiogbGFiZWwgbmFtZXNcbiAqIChJc3N1ZXMgIzI1MzAsICMyNTMyKS5cbiAqXG4gKiBGb3IgdGhlIHJlYWRlcnMgdGhhdCBob2xkIG5vIG9wZXJhdG9yIGNvbmZpZzogdGhlIGlkbGUtZGVjaXNpb24gY2Vuc3VzIGFuZFxuICogdGhlIGlkbGUtZGV0ZWN0IGF1ZGl0LCB3aGljaCBtdXN0IGFwcGx5IGV4YWN0bHkgdGhlIHJ1bGUgdGhlIGNvbGxlY3RvcnMgZG9cbiAqIG9yIHRoZSBgQUxFUlQgbWlzX2NsYXNzaWZpY2F0aW9uYCBsaW5lIGZpcmVzIG9uIGV2ZXJ5IHRpY2suIE9uZSBjb25zdGFudCxcbiAqIGJlY2F1c2UgdHdvIGNvcGllcyBvZiB0aGlzIGxpdGVyYWwgaXMgb25lIGRyaWZ0IGF3YXkgZnJvbSB0aGF0IGFsZXJ0LlxuICogQ2FsbGVycyB0aGF0IGRvIGhhdmUgY29uZmlnICh0aGUgY29sbGVjdG9ycywgdGhlIGNsYWltIHBoYXNlKSBwYXNzIHRoZVxuICogb3BlcmF0b3IncyBvd24gbGFiZWxzIGluc3RlYWQuXG4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX1NUUkVBTV9TSEFSSU5HX1RJRVJTOiBTdHJlYW1TaGFyaW5nTGFiZWxzID0ge1xuICBpc3N1ZUxhYmVsczogW0xBQkVMX0RFRkFVTFRTLnRvcFByaW9yaXR5TGFiZWxdLFxuICB3b3JrT25MYWJlbDogTEFCRUxfREVGQVVMVFMud29ya09uTGFiZWwsXG59O1xuXG4vKipcbiAqIFdoZXRoZXIgYW4gaXNzdWUncyB0aWVyIG1heSBqb2luIGEgbWlsZXN0b25lIHN0cmVhbSBhbm90aGVyIGhvc3QgYWxyZWFkeVxuICogaG9sZHMgKElzc3VlICMyNTMwKS5cbiAqXG4gKiBUaGUgZmxlZXQtd2lkZSBvbmUtcnVuLXBlci1zdHJlYW0gbG9jayAoSXNzdWUgIzIzMzQpIGV4aXN0cyBzbyBhIHN0cmVhbSdzXG4gKiBzaGFyZWQgY29udmVyc2F0aW9uIGNhcnJpZXMgb25lIHJ1biBhdCBhIHRpbWUuIGB0b3AtcHJpb3JpdHlgIGFuZCBgd29yay1vbmBcbiAqIGFyZSB0aGUgdGllcnMgYSBodW1hbiBoYXMgYXNrZWQgZm9yIG5vdzogdGhleSBhcmUgY2xhaW1lZCBhbnl3YXkgYW5kIHJ1biBpblxuICogdGhlaXIgb3duIHBlci1pc3N1ZSBjb252ZXJzYXRpb24sIHNvIHRoZSBzdHJlYW0ncyB0cmFuc2NyaXB0IGlzIG5ldmVyIHNoYXJlZFxuICogYnkgdHdvIHJ1bnMuIEV2ZXJ5IG90aGVyIHRpZXIgKGBsb3ctcHJpb3JpdHlgLCBgaWRsZS10YXNrYCkgc3RpbGwgd2FpdHMuXG4gKlxuICogTGFiZWxzIGFyZSBjb21wYXJlZCBjYXNlLSBhbmQgd2hpdGVzcGFjZS1pbnNlbnNpdGl2ZWx5LCBiZWNhdXNlIGEgbGFiZWwgaXNcbiAqIG9wZXJhdG9yLXR5cGVkIG9uIGJvdGggc2lkZXMgb2YgdGhpcyBjb21wYXJpc29uLlxuICpcbiAqIEBwYXJhbSBsYWJlbHMgLSBMYWJlbHMgdGhlIGlzc3VlIGFjdHVhbGx5IGNhcnJpZXNcbiAqIEBwYXJhbSB0aWVycyAtIFRoZSBjb25maWd1cmVkIHRpZXIgbGFiZWxzIHRvIG1hdGNoIGFnYWluc3RcbiAqIEByZXR1cm5zIFRydWUgd2hlbiB0aGUgaXNzdWUgY2FycmllcyBhIHN0cmVhbS1zaGFyaW5nIHRpZXIgbGFiZWxcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzU3RyZWFtU2hhcmluZ1RpZXIoXG4gIGxhYmVsczogcmVhZG9ubHkgc3RyaW5nW10sXG4gIHRpZXJzOiBTdHJlYW1TaGFyaW5nTGFiZWxzLFxuKTogYm9vbGVhbiB7XG4gIGNvbnN0IG5vcm1hbGlzZSA9IChsYWJlbDogc3RyaW5nKSA9PiBsYWJlbC50cmltKCkudG9Mb3dlckNhc2UoKTtcbiAgY29uc3QgYXBwbGllZCA9IG5ldyBTZXQobGFiZWxzLm1hcChub3JtYWxpc2UpLmZpbHRlcigobCkgPT4gbC5sZW5ndGggPiAwKSk7XG4gIHJldHVybiBbLi4uKHRpZXJzLmlzc3VlTGFiZWxzID8/IFtdKSwgdGllcnMud29ya09uTGFiZWwgPz8gXCJcIl1cbiAgICAubWFwKG5vcm1hbGlzZSlcbiAgICAuZmlsdGVyKChsYWJlbCkgPT4gbGFiZWwubGVuZ3RoID4gMClcbiAgICAuc29tZSgobGFiZWwpID0+IGFwcGxpZWQuaGFzKGxhYmVsKSk7XG59XG5cbi8qKlxuICogQ2hlY2sgd2hldGhlciBhIHdvcmsgc3RyZWFtIGlzIGFscmVhZHkgb2NjdXBpZWQgYnkgYSBWaWJlIENvZGVyLlxuICpcbiAqIFNjaGVkdWxpbmcgZXhpc3RzIG9ubHkgKipiZXR3ZWVuIFZpYmUgQ29kZXJzKiouIFRoZXJlIGlzIG5vIGxvY2tpbmcgb3JcbiAqIHNjaGVkdWxpbmcgYmV0d2VlbiBodW1hbnMgYW5kIFZpYmUgQ29kZXJzLCBzbyBhIGh1bWFuIGFzc2lnbmVlIG5ldmVyXG4gKiBvY2N1cGllcyBhIHdvcmsgc3RyZWFtIGFuZCBuZXZlciBzdGFsbHMgdGhlIHdvcmtlci5cbiAqXG4gKiBGbGVldC1hd2FyZSAoSXNzdWUgIzMwOTkpOiBhIHdvcmsgc3RyZWFtIGlzIFwib2NjdXBpZWRcIiB3aGVuIGFuIGlzc3VlIGluIHRoZVxuICogc2FtZSBtaWxlc3RvbmUvYnJhbmNoIGlzIGFzc2lnbmVkIHRvIEFOWSBhY2NvdW50IHRoZSBmbGVldCBvcGVyYXRlcyDigJQgdGhlXG4gKiBjdXJyZW50IGhvc3QgT1IgYSBzaWJsaW5nIGhvc3QuIEluIGEgbXVsdGktYWNjb3VudCBmbGVldFxuICogKGUuZy4gYFZpYmVjb2RlcmJvdGAsIGBzdHN2Y2JvdGApIGFub3RoZXIgaG9zdCdzIGFzc2lnbm1lbnQgaXMgb3RoZXJ3aXNlXG4gKiBpbnZpc2libGUsIHNvIGEgc2Vjb25kIGhvc3Qgd291bGQgbm90IGNvbnNpZGVyIHRoZSB3b3JrIHN0cmVhbSBvY2N1cGllZCBhbmRcbiAqIHdvdWxkIHN0YXJ0IHRoZSBzYW1lIGlzc3VlIOKAlCB0aGUgcm9vdCBjYXVzZSBvZiBkdXBsaWNhdGUgUFJzICgjMzA5NSkuIFRoZVxuICogdW5kZXJseWluZyBpc3N1ZSBkYXRhIGFscmVhZHkgY2FycmllcyBldmVyeSBhc3NpZ25lZSwgc28gd2lkZW5pbmcgdGhlIG1hdGNoXG4gKiBzZXQgcmVxdWlyZXMgbm8gZXh0cmEgR2l0SHViIGNhbGxzLlxuICpcbiAqIElzc3VlICMxMDY0OiB0aGUgZmxlZXQgc2V0IE1VU1QgYmUgcmVzb2x2ZWQgYnlcbiAqIGByZXNvbHZlRmxlZXRNYWludGVuYW5jZUF1dGhvclNldGAgKGhvc3QgbG9naW4gKyBgZmxlZXRfcHJfYXV0aG9yc2AgK1xuICogYHNlcnZpY2VfYWNjb3VudHNgKSDigJQgdGhlIHNhbWUgcHVzaC1jYXBhYmxlIHNldCBgZ2V0QmxvY2tpbmdQUkZvcklzc3VlYFxuICogdXNlcy4gQ2FsbGVycyB1c2VkIHRvIHBhc3MgYGNvbmZpZy5hbGxvd2VkQXV0aG9yc2AsIHdoaWNoIGlzIGFcbiAqICoqcGVybWlzc2lvbioqIGxpc3QgKFwid2hvc2UgaXNzdWVzIG1heSB3ZSB3b3JrIG9uXCIpIGFuZCBsZWdpdGltYXRlbHkgaG9sZHNcbiAqIGh1bWFuczsgb25lIGh1bWFuLWFzc2lnbmVkIGlzc3VlIHRoZXJlZm9yZSBwYXJrZWQgYSB3aG9sZSB3b3JrIHN0cmVhbSBmb3JcbiAqIH4yMSBob3VycyB3aGlsZSBoaWdoZXItcHJpb3JpdHkgdW5hc3NpZ25lZCB3b3JrIHNhdCBmaWx0ZXJlZCBvdXQuIFRoZVxuICogcGFyYW1ldGVyIGlzIG5hbWVkIGBwdXNoQ2FwYWJsZUF1dGhvcnNgIHJhdGhlciB0aGFuIGBhbGxvd2VkQXV0aG9yc2BcbiAqIHByZWNpc2VseSBzbyB0aGUgcGVybWlzc2lvbiBsaXN0IGNhbm5vdCBiZSBoYW5kZWQgdG8gaXQgYWdhaW4gYnkgaGFiaXQuXG4gKlxuICogQHBhcmFtIGFsbElzc3VlcyAtIEFsbCBvcGVuIGlzc3VlcyBpbiB0aGUgcmVwb1xuICogQHBhcmFtIG1pbGVzdG9uZVRpdGxlIC0gTWlsZXN0b25lIHRvIGNoZWNrIChlbXB0eSBzdHJpbmcgZm9yIG5vbi1taWxlc3RvbmUpXG4gKiBAcGFyYW0gd29ya2VyVXNlciAtIFRoZSBjdXJyZW50IGhvc3QncyBHaXRIdWIgbG9naW5cbiAqIEBwYXJhbSBwdXNoQ2FwYWJsZUF1dGhvcnMgLSBUaGUgYWNjb3VudHMgdGhlIGZsZWV0IG9wZXJhdGVzLCBmcm9tXG4gKiAgIGByZXNvbHZlRmxlZXRNYWludGVuYW5jZUF1dGhvclNldGAuIE5FVkVSIGBjb25maWcuYWxsb3dlZEF1dGhvcnNgLiBUaGVcbiAqICAgY3VycmVudCBob3N0IGlzIGFsd2F5cyBjb3VudGVkIGV2ZW4gaWYgb21pdHRlZCBoZXJlLlxuICogQHJldHVybnMgVHJ1ZSBpZiB0aGUgd29yayBzdHJlYW0gaG9sZHMgYSBmbGVldC1hc3NpZ25lZCBpc3N1ZSAob2NjdXBpZWQpXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc01pbGVzdG9uZU9jY3VwaWVkKFxuICBhbGxJc3N1ZXM6IEZpbHRlcmFibGVJc3N1ZVtdLFxuICBtaWxlc3RvbmVUaXRsZTogc3RyaW5nLFxuICB3b3JrZXJVc2VyOiBzdHJpbmcsXG4gIHB1c2hDYXBhYmxlQXV0aG9yczogc3RyaW5nW10gPSBbXSxcbik6IGJvb2xlYW4ge1xuICBjb25zdCBmbGVldEFjY291bnRzID0gZmxlZXRBY2NvdW50U2V0KHdvcmtlclVzZXIsIHB1c2hDYXBhYmxlQXV0aG9ycyk7XG4gIHJldHVybiBhbGxJc3N1ZXMuc29tZSgoaXNzdWUpID0+IHtcbiAgICBpZiAoaXNzdWUubWlsZXN0b25lICE9PSBtaWxlc3RvbmVUaXRsZSkgcmV0dXJuIGZhbHNlO1xuICAgIHJldHVybiBpc3N1ZS5hc3NpZ25lZXMuc29tZSgoYSkgPT4gZmxlZXRBY2NvdW50cy5oYXMoYS50b0xvd2VyQ2FzZSgpKSk7XG4gIH0pO1xufVxuXG4vKipcbiAqIENhc2UtaW5zZW5zaXRpdmUgZmxlZXQgc2V0LCBtYXRjaGluZyB0aGUgbG93ZXJjYXNlIGNvbnZlbnRpb24gdXNlZCBieVxuICogYGZpbHRlckJ5QWxsb3dlZEF1dGhvcnNgLiBUaGUgY3VycmVudCBob3N0IGlzIGFsd2F5cyBpbmNsdWRlZCBzbyBhXG4gKiBtaXNjb25maWd1cmVkIGZsZWV0IGxpc3QgbmV2ZXIgZHJvcHMgdGhpcyBob3N0J3Mgb3duIGFzc2lnbm1lbnRzLlxuICovXG5mdW5jdGlvbiBmbGVldEFjY291bnRTZXQoXG4gIHdvcmtlclVzZXI6IHN0cmluZyxcbiAgcHVzaENhcGFibGVBdXRob3JzOiByZWFkb25seSBzdHJpbmdbXSxcbik6IFJlYWRvbmx5U2V0PHN0cmluZz4ge1xuICByZXR1cm4gbmV3IFNldChcbiAgICBbd29ya2VyVXNlciwgLi4ucHVzaENhcGFibGVBdXRob3JzXS5tYXAoKGEpID0+IGEudG9Mb3dlckNhc2UoKSksXG4gICk7XG59XG5cbi8qKlxuICogV2hldGhlciAqKnRoaXMgb25lIGlzc3VlKiogaXMgYWxyZWFkeSBhc3NpZ25lZCB0byBhbiBhY2NvdW50IHRoZSBmbGVldFxuICogb3BlcmF0ZXMgKElzc3VlICMyNTMyKS5cbiAqXG4gKiBUaGUgc3RyZWFtLWxldmVsIHF1ZXN0aW9uIGlzIHtAbGluayBpc01pbGVzdG9uZU9jY3VwaWVkfTsgdGhpcyBpcyB0aGVcbiAqIGlzc3VlLWxldmVsIG9uZSB0aGUgc3RyZWFtLXNoYXJpbmcgdGllcnMgc3RpbGwgaGF2ZSB0byBhc2suIGB3b3JrLW9uYCBhbmRcbiAqIGB0b3AtcHJpb3JpdHlgIGNhbmRpZGF0ZXMgc2hhcmUgYSBidXN5IHN0cmVhbSwgYnV0IHRoZSBzaW5nbGUgaXNzdWUgYVxuICogc2libGluZyBzbG90IG9uIHRoaXMgaG9zdCBhbHJlYWR5IGhvbGRzIG11c3QgbmV2ZXIgYmUgcmUtb2ZmZXJlZCDigJQgYW5kIGluXG4gKiB0aGUgd2luZG93IGJlZm9yZSB0aGUgR2l0SHViIGFzc2lnbm1lbnQgbGFuZHMsIHRoZSBvbmx5IHJlY29yZCBvZiB0aGF0IGhvbGRcbiAqIGlzIHRoZSBvdmVybGF5IGBhcHBseUluRmxpZ2h0Q2xhaW1zYCAoYHdvcmtfc3RyZWFtLnRzYCkgd3JpdGVzIG9udG8gdGhlXG4gKiBhbGwtaXNzdWVzIGxpc3RpbmcuIEEgaHVtYW4ncyBhc3NpZ25tZW50IGlzIGlnbm9yZWQgaGVyZSBmb3IgdGhlIHNhbWVcbiAqIHJlYXNvbiBpdCBpcyBpZ25vcmVkIHRoZXJlOiBzY2hlZHVsaW5nIGV4aXN0cyBvbmx5IGJldHdlZW4gVmliZSBDb2RlcnMuXG4gKlxuICogQHBhcmFtIGFsbElzc3VlcyAtIEFsbCBvcGVuIGlzc3VlcyBpbiB0aGUgcmVwbywgd2l0aCBhbnkgaW4tZmxpZ2h0IG92ZXJsYXlcbiAqIEBwYXJhbSBpc3N1ZU51bWJlciAtIFRoZSBjYW5kaWRhdGUgdW5kZXIgY29uc2lkZXJhdGlvblxuICogQHBhcmFtIHdvcmtlclVzZXIgLSBUaGUgY3VycmVudCBob3N0J3MgR2l0SHViIGxvZ2luXG4gKiBAcGFyYW0gcHVzaENhcGFibGVBdXRob3JzIC0gVGhlIGFjY291bnRzIHRoZSBmbGVldCBvcGVyYXRlcywgZnJvbVxuICogICBgcmVzb2x2ZUZsZWV0TWFpbnRlbmFuY2VBdXRob3JTZXRgLiBORVZFUiBgY29uZmlnLmFsbG93ZWRBdXRob3JzYC5cbiAqIEByZXR1cm5zIFRydWUgd2hlbiB0aGUgZmxlZXQgYWxyZWFkeSBob2xkcyB0aGlzIGlzc3VlXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc0lzc3VlRmxlZXRBc3NpZ25lZChcbiAgYWxsSXNzdWVzOiByZWFkb25seSBGaWx0ZXJhYmxlSXNzdWVbXSxcbiAgaXNzdWVOdW1iZXI6IG51bWJlcixcbiAgd29ya2VyVXNlcjogc3RyaW5nLFxuICBwdXNoQ2FwYWJsZUF1dGhvcnM6IHJlYWRvbmx5IHN0cmluZ1tdID0gW10sXG4pOiBib29sZWFuIHtcbiAgY29uc3QgZmxlZXRBY2NvdW50cyA9IGZsZWV0QWNjb3VudFNldCh3b3JrZXJVc2VyLCBwdXNoQ2FwYWJsZUF1dGhvcnMpO1xuICByZXR1cm4gYWxsSXNzdWVzLnNvbWUoKGlzc3VlKSA9PlxuICAgIGlzc3VlLm51bWJlciA9PT0gaXNzdWVOdW1iZXIgJiZcbiAgICBpc3N1ZS5hc3NpZ25lZXMuc29tZSgoYSkgPT4gZmxlZXRBY2NvdW50cy5oYXMoYS50b0xvd2VyQ2FzZSgpKSlcbiAgKTtcbn1cblxuLyoqXG4gKiBGaWx0ZXIgYW5kIHNvcnQgaXNzdWVzIGJ5IGV4Y2x1ZGluZyBibG9ja2luZyBsYWJlbHMuXG4gKlxuICogRmlsdGVycyBvdXQ6XG4gKiAtIElzc3VlcyB3aXRoIGFzc2lnbmVlcyAoaW4gbXVsdGktd29ya2VyIHNldHVwcylcbiAqIC0gSXNzdWVzIHdpdGggYW55IGJsb2NraW5nIGxhYmVsIChuZWVkcy1odW1hbiwgcGxhbm5pbmcsIGV0Yy4pIOKAlCBuZXZlclxuICogICBgZmFpbGVkYCwgd2hpY2ggbm8gbG9uZ2VyIHBhcmtzIGFuIGlzc3VlIChJc3N1ZSAjNDE1OClcbiAqXG4gKiBTb3J0cyBieSBjcmVhdGVkQXQgYXNjZW5kaW5nIChvbGRlc3QgZmlyc3QpLlxuICpcbiAqIEBwYXJhbSBpc3N1ZXMgLSBJc3N1ZXMgdG8gZmlsdGVyXG4gKiBAcGFyYW0gbGFiZWxzIC0gTGFiZWwgY29uZmlndXJhdGlvbiBmb3IgZXhjbHVzaW9uXG4gKiBAcmV0dXJucyBGaWx0ZXJlZCBhbmQgc29ydGVkIGlzc3Vlc1xuICovXG5leHBvcnQgZnVuY3Rpb24gZmlsdGVyQW5kU29ydChcbiAgaXNzdWVzOiBGaWx0ZXJhYmxlSXNzdWVbXSxcbiAgbGFiZWxzOiBGaWx0ZXJMYWJlbHMsXG4pOiBGaWx0ZXJhYmxlSXNzdWVbXSB7XG4gIGNvbnN0IGJsb2NraW5nTGFiZWxzID0gbmV3IFNldChbXG4gICAgbGFiZWxzLm5lZWRzUmV2aXNpb25MYWJlbCxcbiAgICBsYWJlbHMucmVmaW5lSXNzdWVMYWJlbCxcbiAgICBsYWJlbHMucGxhbm5pbmdMYWJlbCxcbiAgICBsYWJlbHMucXVlc3Rpb25MYWJlbCxcbiAgICAvLyBJc3N1ZSAjMTQ3MCwgIzIwMzE6IG5lZWRzLWh1bWFuIOKAlCB3b3JrZXIgZXhwbGljaXRseSBoYW5kZWQgYmFjayB0byBhXG4gICAgLy8gaHVtYW47IG5ldmVyIHJlLXBpY2sgZHVyaW5nIGRpc2NvdmVyeS4gSXNzdWUgIzIwMzEgcmV0aXJlZCB0aGVcbiAgICAvLyBzdGFuZGFsb25lIGBuZWVkcy1jbGFyaWZpY2F0aW9uYCBsYWJlbCBhbmQgZm9sZGVkIHRoZSBjbGFyaWZpY2F0aW9uXG4gICAgLy8gaGFuZG9mZiBvbnRvIGBuZWVkcy1odW1hbmAuXG4gICAgbGFiZWxzLm5lZWRzSHVtYW5MYWJlbCxcbiAgXSk7XG5cbiAgcmV0dXJuIGlzc3Vlc1xuICAgIC5maWx0ZXIoKGlzc3VlKSA9PiB7XG4gICAgICBpZiAoaXNzdWUuYXNzaWduZWVzLmxlbmd0aCA+IDApIHJldHVybiBmYWxzZTtcbiAgICAgIGlmIChpc3N1ZS5sYWJlbHMuc29tZSgobCkgPT4gYmxvY2tpbmdMYWJlbHMuaGFzKGwpKSkgcmV0dXJuIGZhbHNlO1xuICAgICAgLy8gSXNzdWUgIzExMzQ6IHNraXAgbWlsZXN0b25lIHRyYWNraW5nIGlzc3Vlc1xuICAgICAgaWYgKGlzTWlsZXN0b25lVHJhY2tpbmdJc3N1ZShpc3N1ZSkpIHJldHVybiBmYWxzZTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0pXG4gICAgLnNvcnQoKGEsIGIpID0+IGEuY3JlYXRlZEF0LmxvY2FsZUNvbXBhcmUoYi5jcmVhdGVkQXQpKTtcbn1cblxuLyoqXG4gKiBGaWx0ZXIgaXNzdWVzIHRvIG9ubHkgaW5jbHVkZSB0aG9zZSBieSBhbGxvd2VkIGF1dGhvcnMuXG4gKlxuICogQHBhcmFtIGlzc3VlcyAtIElzc3VlcyB0byBmaWx0ZXJcbiAqIEBwYXJhbSBhbGxvd2VkQXV0aG9ycyAtIEF1dGhvcmlzZWQgR2l0SHViIHVzZXJuYW1lc1xuICogQHJldHVybnMgSXNzdWVzIGZyb20gYWxsb3dlZCBhdXRob3JzIG9ubHlcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpbHRlckJ5QWxsb3dlZEF1dGhvcnMoXG4gIGlzc3VlczogRmlsdGVyYWJsZUlzc3VlW10sXG4gIGFsbG93ZWRBdXRob3JzOiBzdHJpbmdbXSxcbik6IEZpbHRlcmFibGVJc3N1ZVtdIHtcbiAgY29uc3QgYXV0aG9yU2V0ID0gbmV3IFNldChhbGxvd2VkQXV0aG9ycy5tYXAoKGEpID0+IGEudG9Mb3dlckNhc2UoKSkpO1xuICByZXR1cm4gaXNzdWVzLmZpbHRlcigoaXNzdWUpID0+IGF1dGhvclNldC5oYXMoaXNzdWUuYXV0aG9yLnRvTG93ZXJDYXNlKCkpKTtcbn1cblxuLyoqXG4gKiBHZW5lcmF0ZSBmaWx0ZXIgZGlhZ25vc3RpY3MgZm9yIGxvZ2dpbmcuXG4gKlxuICogQHBhcmFtIGlzc3VlcyAtIElzc3VlcyB0byBkaWFnbm9zZVxuICogQHBhcmFtIGZhaWxlZExhYmVsIC0gTGFiZWwgZm9yIHBlcm1hbmVudGx5IGZhaWxlZCBpc3N1ZXNcbiAqIEBwYXJhbSBuZWVkc0h1bWFuTGFiZWwgLSBMYWJlbCBmb3IgaXNzdWVzIGhhbmRlZCBiYWNrIHRvIGEgaHVtYW4gKElzc3VlICMyMDMxKVxuICogQHJldHVybnMgRGlhZ25vc3RpYyBjb3VudHNcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldEZpbHRlckRpYWdub3N0aWNzKFxuICBpc3N1ZXM6IEZpbHRlcmFibGVJc3N1ZVtdLFxuICBmYWlsZWRMYWJlbDogc3RyaW5nLFxuICBuZWVkc0h1bWFuTGFiZWw6IHN0cmluZyxcbik6IEZpbHRlckRpYWdub3N0aWNzIHtcbiAgcmV0dXJuIHtcbiAgICB0b3RhbDogaXNzdWVzLmxlbmd0aCxcbiAgICBhc3NpZ25lZFRvT3RoZXJzOiBpc3N1ZXMuZmlsdGVyKChpKSA9PiBpLmFzc2lnbmVlcy5sZW5ndGggPiAwKS5sZW5ndGgsXG4gICAgd2l0aEZhaWxlZExhYmVsOlxuICAgICAgaXNzdWVzLmZpbHRlcigoaSkgPT4gaS5sYWJlbHMuaW5jbHVkZXMoZmFpbGVkTGFiZWwpKS5sZW5ndGgsXG4gICAgd2l0aE5lZWRzSHVtYW5MYWJlbDpcbiAgICAgIGlzc3Vlcy5maWx0ZXIoKGkpID0+IGkubGFiZWxzLmluY2x1ZGVzKG5lZWRzSHVtYW5MYWJlbCkpLmxlbmd0aCxcbiAgfTtcbn1cblxuLyoqXG4gKiBUaW1lbGluZSBldmVudCBmcm9tIEdpdEh1YiBBUEkuXG4gKi9cbmludGVyZmFjZSBUaW1lbGluZUV2ZW50IHtcbiAgZXZlbnQ6IHN0cmluZztcbiAgbGFiZWw/OiB7IG5hbWU6IHN0cmluZyB9O1xuICBjcmVhdGVkX2F0OiBzdHJpbmc7XG59XG5cbi8qKlxuICogQ2hlY2sgaWYgYW4gaXNzdWUgd2FzIHJlb3BlbmVkIGFmdGVyIGEgc3BlY2lmaWMgbGFiZWwgd2FzIGFwcGxpZWQuXG4gKlxuICogQHBhcmFtIHRpbWVsaW5lIC0gVGltZWxpbmUgZXZlbnRzIGZyb20gR2l0SHViIEFQSVxuICogQHBhcmFtIGxhYmVsTmFtZSAtIExhYmVsIHRvIGNoZWNrXG4gKiBAcmV0dXJucyBUcnVlIGlmIHJlb3BlbmVkIGFmdGVyIHRoZSBsYWJlbCB3YXMgYXBwbGllZFxuICovXG5leHBvcnQgZnVuY3Rpb24gd2FzUmVvcGVuZWRBZnRlckxhYmVsKFxuICB0aW1lbGluZTogVGltZWxpbmVFdmVudFtdLFxuICBsYWJlbE5hbWU6IHN0cmluZyxcbik6IGJvb2xlYW4ge1xuICBjb25zdCBsYXN0TGFiZWxlZCA9IHRpbWVsaW5lXG4gICAgLmZpbHRlcigoZSkgPT4gZS5ldmVudCA9PT0gXCJsYWJlbGVkXCIgJiYgZS5sYWJlbD8ubmFtZSA9PT0gbGFiZWxOYW1lKVxuICAgIC5tYXAoKGUpID0+IGUuY3JlYXRlZF9hdClcbiAgICAucG9wKCkgPz8gXCJcIjtcblxuICBjb25zdCBsYXN0UmVvcGVuZWQgPSB0aW1lbGluZVxuICAgIC5maWx0ZXIoKGUpID0+IGUuZXZlbnQgPT09IFwicmVvcGVuZWRcIilcbiAgICAubWFwKChlKSA9PiBlLmNyZWF0ZWRfYXQpXG4gICAgLnBvcCgpID8/IFwiXCI7XG5cbiAgcmV0dXJuIGxhc3RSZW9wZW5lZCAhPT0gXCJcIiAmJiBsYXN0TGFiZWxlZCAhPT0gXCJcIiAmJlxuICAgIGxhc3RSZW9wZW5lZCA+IGxhc3RMYWJlbGVkO1xufVxuXG4vKipcbiAqIEZpbmQgc3RhbGUgZmFpbHVyZSBsYWJlbHMgb24gYW4gaXNzdWUuXG4gKlxuICogSXNzdWUgIzIwMzE6IGBuZWVkcy1jbGFyaWZpY2F0aW9uYCB3YXMgcmV0aXJlZCDigJQgdGhlIHN0YWxlLWxhYmVsXG4gKiBjbGVhbnVwIG5vIGxvbmdlciB0b3VjaGVzIGl0LiBPbmx5IHRoZSBmYWlsdXJlIGxhYmVscyByZW1haW4gaW4gdGhlXG4gKiBzdGFsZSBzZXQuXG4gKlxuICogSXNzdWUgIzQxNTg6IGBmYWlsZWRgIGlzIGFsd2F5cyBzdGFsZS4gVGhlIHdvcmtlciBubyBsb25nZXIgYXBwbGllcyBpdCxcbiAqIGJlY2F1c2UgcGFya2luZyBhbiBhc3NpZ25lZCBpc3N1ZSBpcyBhIGZhaWx1cmUgb2YgdGhlIFZpYmUgQ29kZXIsIHNvIG9uZVxuICogc3RpbGwgb24gYW4gaXNzdWUgaXMgYSBsZWZ0b3ZlciB0byBzdHJpcC4gYGZhaWxlZC1vbmNlYCBpcyBzdGFsZSBvbmx5XG4gKiBvbmNlIHRoZSBpc3N1ZSB3YXMgcmVvcGVuZWQgYWZ0ZXIgaXQgd2FzIGFwcGxpZWQuXG4gKlxuICogQHBhcmFtIGlzc3VlTGFiZWxzIC0gQ3VycmVudCBsYWJlbHMgb24gdGhlIGlzc3VlXG4gKiBAcGFyYW0gdGltZWxpbmUgLSBUaW1lbGluZSBldmVudHMgZnJvbSBHaXRIdWIgQVBJXG4gKiBAcGFyYW0gZmFpbGVkTGFiZWwgLSBMYWJlbCBmb3IgcGVybWFuZW50bHkgZmFpbGVkIGlzc3Vlc1xuICogQHBhcmFtIGZhaWxlZE9uY2VMYWJlbCAtIExhYmVsIGZvciBmaXJzdC1mYWlsdXJlIGlzc3Vlc1xuICogQHJldHVybnMgQXJyYXkgb2Ygc3RhbGUgbGFiZWwgbmFtZXMgdGhhdCBzaG91bGQgYmUgcmVtb3ZlZFxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0U3RhbGVMYWJlbHNGb3JSZW9wZW5lZElzc3VlKFxuICBpc3N1ZUxhYmVsczogc3RyaW5nW10sXG4gIHRpbWVsaW5lOiBUaW1lbGluZUV2ZW50W10sXG4gIGZhaWxlZExhYmVsOiBzdHJpbmcsXG4gIGZhaWxlZE9uY2VMYWJlbDogc3RyaW5nLFxuKTogc3RyaW5nW10ge1xuICBjb25zdCBjaGVja0xhYmVscyA9IFtmYWlsZWRMYWJlbCwgZmFpbGVkT25jZUxhYmVsXTtcbiAgcmV0dXJuIGNoZWNrTGFiZWxzLmZpbHRlcigobGFiZWwpID0+XG4gICAgaXNzdWVMYWJlbHMuaW5jbHVkZXMobGFiZWwpICYmXG4gICAgKGxhYmVsID09PSBmYWlsZWRMYWJlbCB8fCB3YXNSZW9wZW5lZEFmdGVyTGFiZWwodGltZWxpbmUsIGxhYmVsKSlcbiAgKTtcbn1cblxuLyoqXG4gKiBDbGVhbiBzdGFsZSBsYWJlbHMgZnJvbSByZW9wZW5lZCBpc3N1ZXMuXG4gKlxuICogRm9yIGVhY2ggaXNzdWUgd2l0aCBhIGJsb2NraW5nIGxhYmVsLCBjaGVja3MgdGhlIEdpdEh1YiB0aW1lbGluZSBBUElcbiAqIHRvIHNlZSBpZiB0aGUgaXNzdWUgd2FzIHJlb3BlbmVkIGFmdGVyIHRoZSBsYWJlbCB3YXMgYXBwbGllZC4gSWYgc28sXG4gKiByZW1vdmVzIHRoZSBzdGFsZSBsYWJlbHMuXG4gKlxuICogSXNzdWUgIzE3ODU6IFJvdXRlcyB0aW1lbGluZSByZWFkcyB0aHJvdWdoIGBUaW1lbGluZUNhY2hlYCBzbyB0aGVcbiAqIGNvbGQtY2FsbC1wZXItaXRlcmF0aW9uIHBhdHRlcm4gKG9uZSBgZ2ggYXBpIC4uLi90aW1lbGluZWAgY2FsbCBwZXJcbiAqIGJsb2NrZWQgaXNzdWUgcGVyIGl0ZXJhdGlvbikgY29sbGFwc2VzIHRvIG9uZSByZWFkIGV2ZXJ5IFRUTCB3aW5kb3cuXG4gKiBXb3JrZXItaW5pdGlhdGVkIGxhYmVsIHJlbW92YWwgaW52YWxpZGF0ZXMgdGhlIGNhY2hlZCBlbnRyeSBzbyB0aGVcbiAqIG5leHQgaXRlcmF0aW9uIHNlZXMgZnJlc2ggZGF0YS5cbiAqXG4gKiBJc3N1ZSAjMjAzMTogYG5lZWRzLWNsYXJpZmljYXRpb25gIHJldGlyZWQg4oCUIG9ubHkgdGhlIGZhaWx1cmUgbGFiZWxzXG4gKiBhcmUgc3ViamVjdCB0byByZW9wZW5lZC1pc3N1ZSBzdGFsZSBjbGVhbnVwLlxuICpcbiAqIEBwYXJhbSBpc3N1ZXMgLSBJc3N1ZXMgdG8gY2hlY2tcbiAqIEBwYXJhbSByZXBvIC0gUmVwb3NpdG9yeSBpbiBcIm93bmVyL3JlcG9cIiBmb3JtYXRcbiAqIEBwYXJhbSBmYWlsZWRMYWJlbCAtIExhYmVsIGZvciBwZXJtYW5lbnRseSBmYWlsZWQgaXNzdWVzXG4gKiBAcGFyYW0gZmFpbGVkT25jZUxhYmVsIC0gTGFiZWwgZm9yIGZpcnN0LWZhaWx1cmUgaXNzdWVzXG4gKiBAcGFyYW0gZ2hDb21tYW5kRm4gLSBPcHRpb25hbCBnaCBjb21tYW5kIGZ1bmN0aW9uIGZvciB0ZXN0aW5nXG4gKiBAcGFyYW0gY2FjaGUgLSBPcHRpb25hbCB0aW1lbGluZSBjYWNoZSBmb3IgcmVhZC10aHJvdWdoXG4gKiBAcmV0dXJucyBVcGRhdGVkIGlzc3VlcyB3aXRoIHN0YWxlIGxhYmVscyByZW1vdmVkXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjbGVhblN0YWxlTGFiZWxzKFxuICBpc3N1ZXM6IEZpbHRlcmFibGVJc3N1ZVtdLFxuICByZXBvOiBzdHJpbmcsXG4gIGZhaWxlZExhYmVsOiBzdHJpbmcsXG4gIGZhaWxlZE9uY2VMYWJlbDogc3RyaW5nLFxuICBnaENvbW1hbmRGbjogKGFyZ3M6IHN0cmluZ1tdKSA9PiBQcm9taXNlPHN0cmluZz4gPSBydW5HaENvbW1hbmQsXG4gIGNhY2hlPzogVGltZWxpbmVDYWNoZSxcbik6IFByb21pc2U8RmlsdGVyYWJsZUlzc3VlW10+IHtcbiAgY29uc3QgYmxvY2tpbmdMYWJlbHMgPSBuZXcgU2V0KFtmYWlsZWRMYWJlbCwgZmFpbGVkT25jZUxhYmVsXSk7XG4gIGNvbnN0IHJlc3VsdCA9IFsuLi5pc3N1ZXNdO1xuXG4gIGZvciAobGV0IGkgPSAwOyBpIDwgcmVzdWx0Lmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgaXNzdWUgPSByZXN1bHRbaV0hO1xuICAgIGNvbnN0IGhhc0Jsb2NraW5nID0gaXNzdWUubGFiZWxzLnNvbWUoKGwpID0+IGJsb2NraW5nTGFiZWxzLmhhcyhsKSk7XG4gICAgaWYgKCFoYXNCbG9ja2luZykgY29udGludWU7XG5cbiAgICAvLyBJc3N1ZSAjNDE1ODogYSBsZWZ0b3ZlciBgZmFpbGVkYCBuZWVkcyBubyB0aW1lbGluZSB0byBiZSBzdGFsZSwgc29cbiAgICAvLyBhbiB1bnJlYWRhYmxlIHRpbWVsaW5lIG11c3Qgbm90IHN0cmFuZCB0aGUgaXNzdWUgYmVoaW5kIGl0LlxuICAgIGNvbnN0IHRpbWVsaW5lID0gYXdhaXQgZmV0Y2hUaW1lbGluZVdpdGhDYWNoZShcbiAgICAgIHJlcG8sXG4gICAgICBpc3N1ZS5udW1iZXIsXG4gICAgICBnaENvbW1hbmRGbixcbiAgICAgIGNhY2hlLFxuICAgICkgPz8gW107XG5cbiAgICBjb25zdCBzdGFsZUxhYmVscyA9IGdldFN0YWxlTGFiZWxzRm9yUmVvcGVuZWRJc3N1ZShcbiAgICAgIGlzc3VlLmxhYmVscyxcbiAgICAgIHRpbWVsaW5lIGFzIFRpbWVsaW5lRXZlbnRbXSxcbiAgICAgIGZhaWxlZExhYmVsLFxuICAgICAgZmFpbGVkT25jZUxhYmVsLFxuICAgICk7XG5cbiAgICBsZXQgbXV0YXRlZCA9IGZhbHNlO1xuICAgIGZvciAoY29uc3QgbGFiZWwgb2Ygc3RhbGVMYWJlbHMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IGdoQ29tbWFuZEZuKFtcbiAgICAgICAgICBcImlzc3VlXCIsXG4gICAgICAgICAgXCJlZGl0XCIsXG4gICAgICAgICAgU3RyaW5nKGlzc3VlLm51bWJlciksXG4gICAgICAgICAgXCItLXJlcG9cIixcbiAgICAgICAgICByZXBvLFxuICAgICAgICAgIFwiLS1yZW1vdmUtbGFiZWxcIixcbiAgICAgICAgICBsYWJlbCxcbiAgICAgICAgXSk7XG4gICAgICAgIG11dGF0ZWQgPSB0cnVlO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIE5vbi1mYXRhbCDigJQgY29udGludWVcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBXb3JrZXItaW5pdGlhdGVkIGxhYmVsIGNoYW5nZSBtdXN0IGludmFsaWRhdGUgdGhlIGNhY2hlZFxuICAgIC8vIHRpbWVsaW5lIHNvIHRoZSBuZXh0IHJlYWQgc2VlcyB0aGUgZnJlc2ggc3RhdGUuXG4gICAgaWYgKG11dGF0ZWQpIHtcbiAgICAgIGF3YWl0IGludmFsaWRhdGVUaW1lbGluZUNhY2hlKHJlcG8sIGlzc3VlLm51bWJlciwgY2FjaGUpO1xuICAgIH1cblxuICAgIGlmIChzdGFsZUxhYmVscy5sZW5ndGggPiAwKSB7XG4gICAgICBjb25zdCBzdGFsZVNldCA9IG5ldyBTZXQoc3RhbGVMYWJlbHMpO1xuICAgICAgcmVzdWx0W2ldID0ge1xuICAgICAgICAuLi5pc3N1ZSxcbiAgICAgICAgbGFiZWxzOiBpc3N1ZS5sYWJlbHMuZmlsdGVyKChsKSA9PiAhc3RhbGVTZXQuaGFzKGwpKSxcbiAgICAgIH07XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHJlc3VsdDtcbn1cbiJdLCJu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
// denoCacheMetadata=537670800894352395,2544555267235846962