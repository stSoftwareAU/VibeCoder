/**
 * Stuck issue recovery — actions taken when detection determines an
 * issue's worker is no longer alive (Issues #471, #604, #632, #787,
 * #1452, #1454).
 *
 * Single responsibility: perform the side effects (unassign, comment,
 * close) required to free or finalise an issue. Detection predicates
 * live in stuck_detection.ts and storage operations in
 * heartbeat_storage.ts.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { verifyMergeLanded } from "./merge_landing.ts";
import { CLAIM_MARKER_PREFIX } from "./claim_issue.ts";
import { recordFaultEvent } from "./fault_tolerance_counters.ts";
import {
  CLEARED_MARKER_GRACE_SECONDS,
  clearHeartbeat,
  HEARTBEAT_MARKER_PREFIX,
  heartbeatFilePath,
  runGh,
  scanHeartbeatMarkers,
} from "./heartbeat_storage.ts";
import type { IssueCache } from "./issue_cache.ts";
import {
  fetchAllIssues,
  fetchClosedPRsByUser,
  fetchPRsForIssueByTitle,
  invalidateClosedPRsByUser,
  invalidatePRsForIssueByTitle,
} from "./issue_query.ts";
import { prTitleMatchesIssue } from "./pr_issue_linking.ts";
import { findOpenLinkedPR } from "./pr_linkage.ts";
import {
  classifyMarkers,
  type MarkerClassification,
  recordRecoveryDecision,
  type RecoveryDecision,
  type RecoverySource,
} from "./recovery_telemetry.ts";

// The grace window itself lives in heartbeat_storage.ts (Issue #3755) so
// the comment sweep shares one definition; re-exported here because this is
// where it has always been consumed from.
export { CLEARED_MARKER_GRACE_SECONDS };

/**
 * Decide whether a `skipped:cleared_marker` classification should actually
 * suppress recovery (Issue #1916).
 *
 * Returns `true` when the cleared marker is either:
 *   - from this same machine (the worker that cleared it is the one
 *     scanning now — preserves the Issue #1886 protection), or
 *   - recent: the issue's `updatedAt` is within the grace window
 *     (`CLEARED_MARKER_GRACE_SECONDS`), so the previous worker only
 *     just finished — do not race a still-completing peer.
 *
 * Otherwise returns `false`, meaning the caller should treat the cleared
 * marker as telemetry only and fall through to the standard
 * elapsed-vs-timeout decision. This unsticks issues re-assigned after a
 * previous successful clear (the symptom reported on this issue).
 *
 * `elapsedSinceUpdate` is `null` when the issue has no parsable
 * `updatedAt` — in that case the recency check cannot be made, so the
 * function returns `false` unless `sameMachine` matches. The caller then
 * resolves the decision via `skipped:invalid_updated_at` in its normal
 * elapsed-null path.
 */
export function shouldHonourClearedMarker(
  markerClass: MarkerClassification,
  thisMachineId: string | undefined,
  elapsedSinceUpdate: number | null,
): boolean {
  const sameMachine = thisMachineId !== undefined &&
    markerClass.latest !== null &&
    markerClass.latest.machineId === thisMachineId;
  if (sameMachine) return true;
  if (
    elapsedSinceUpdate !== null &&
    elapsedSinceUpdate <= CLEARED_MARKER_GRACE_SECONDS
  ) return true;
  return false;
}
import {
  hasOpenLinkedPR,
  isIssueStuck,
  parseHeartbeatFilename,
  parseISODate,
  type StuckIssueConfig,
} from "./stuck_detection.ts";

/**
 * Recover a stuck issue by unassigning the worker and posting a comment.
 *
 * `ghCommandFn` is injectable (defaulting to the module-level `runGh`) so the
 * three observable side effects — unassign, recovery comment, heartbeat clear —
 * can be asserted in tests without reaching the live GitHub API (Issue #3039).
 */
export async function recoverStuckIssue(
  workDir: string,
  repo: string,
  issueNumber: number,
  githubUser: string,
  stuckIssueTimeout: number,
  ghCommandFn?: (args: string[]) => Promise<string>,
): Promise<Result<void>> {
  const ghFn = ghCommandFn ?? runGh;

  // Step 1: Unassign the worker
  await ghFn([
    "issue",
    "edit",
    String(issueNumber),
    "--repo",
    repo,
    "--remove-assignee",
    githubUser,
  ]);

  // Step 2: Post a recovery comment
  const minutes = Math.floor(stuckIssueTimeout / 60);
  const commentBody =
    `Automatic recovery: this issue was unassigned from \`${githubUser}\` because the worker appears to have stopped responding (no heartbeat for over ${minutes} minutes). The issue is now available to be picked up again on the next scan cycle.

---

Self-healing recovery (Issue #471)`;

  await ghFn([
    "issue",
    "comment",
    String(issueNumber),
    "--repo",
    repo,
    "--body",
    commentBody,
  ]);

  // Step 3: Clear the heartbeat file
  await clearHeartbeat(workDir, repo, issueNumber);

  return { ok: true, value: undefined };
}

/**
 * Scan for and recover all stuck heartbeat issues.
 *
 * Scans workDir for heartbeat files exceeding the timeout.
 */
export async function detectAndRecoverStuckHeartbeats(
  config: StuckIssueConfig,
  githubUser: string,
  nowFn: () => number = () => Math.floor(Date.now() / 1000),
  options: {
    /**
     * Treat EVERY heartbeat file as a dead run's leftover (Issue #4241).
     *
     * In container mode the environment guarantees one worker per
     * container, so a heartbeat file present at start-up cannot belong to
     * a live run — but on the durable vibe-work volume it also no longer
     * dies with its writer, and an age-gated sweep left a dead
     * container's young heartbeat suppressing recovery for hours
     * (observed live: #4207 wedged under
     * `skipped:has_local_heartbeat`). Ownership logic is unnecessary
     * where single-instance is structural; the sweep is the whole story.
     */
    sweepAllHeartbeats?: boolean;
    /** Injectable gh runner, forwarded to the per-issue recovery. */
    ghCommandFn?: (args: string[]) => Promise<string>;
  } = {},
): Promise<number> {
  let recoveredCount = 0;

  try {
    for await (const entry of Deno.readDir(config.workDir)) {
      if (!entry.isFile || !entry.name.startsWith(".heartbeat_")) continue;

      const parsed = parseHeartbeatFilename(entry.name);
      if (!parsed) continue;

      const stuck = options.sweepAllHeartbeats === true ||
        await isIssueStuck(
          config.workDir,
          parsed.repo,
          parsed.issueNumber,
          config.stuckIssueTimeout,
          nowFn,
        );
      if (stuck) {
        const result = await recoverStuckIssue(
          config.workDir,
          parsed.repo,
          parsed.issueNumber,
          githubUser,
          config.stuckIssueTimeout,
          options.ghCommandFn,
        );
        if (result.ok) recoveredCount++;
      }
    }
  } catch {
    // Directory doesn't exist or scan failed — non-fatal
  }

  return recoveredCount;
}

/**
 * Evaluate one assigned issue against the recovery criteria, emit a
 * structured `RecoveryDecisionEvent` describing the inputs that were
 * considered, and return the decision (Issue #1884).
 *
 * Performs all read-only checks (local heartbeat present, open PR
 * linked, marker classification, elapsed-since-update). Mutations
 * (unassign, comment) remain in the caller so the side-effect order
 * is unchanged.
 */
async function emitDecision(args: {
  source: RecoverySource;
  config: StuckIssueConfig;
  repo: string;
  issue: { number: number; updatedAt: string; title: string };
  /**
   * The assignee under evaluation — `githubUser` for the own-account path,
   * or another account when recovering a cross-account leak (Issue #2671).
   */
  assignee: string;
  /** True when `assignee` is a different account than the scanning worker. */
  crossAccount: boolean;
  timeoutSeconds: number;
  now: number;
  ghFn: (args: string[]) => Promise<string>;
  cache?: IssueCache;
}): Promise<RecoveryDecision> {
  const {
    source,
    config,
    repo,
    issue,
    assignee,
    crossAccount,
    timeoutSeconds,
    now,
    ghFn,
    cache,
  } = args;

  // Local heartbeat — fastest check, fail closed on stat error.
  let localHeartbeatPresent = false;
  try {
    await Deno.stat(heartbeatFilePath(config.workDir, repo, issue.number));
    localHeartbeatPresent = true;
  } catch {
    // No heartbeat file — proceed.
  }

  // Open linked PR (Issues #1452, #1887, #1924). `findOpenLinkedPR`
  // checks four signals (title match, closing reference, cross-
  // reference, worker comment); any one is sufficient. The check costs
  // one GraphQL round-trip per cache miss, and the worker has been
  // observed exhausting the 5000-point/hour GraphQL quota every cycle.
  //
  // Issue #1924: skip the GraphQL call when `localHeartbeatPresent` is
  // true. The presence of a local heartbeat already determines the
  // decision (`skipped:has_local_heartbeat` — see the branch below),
  // so the linkage value would not change the outcome. The previous
  // implementation called it unconditionally for telemetry parity; we
  // now record `localHeartbeatPresent` in the event and leave
  // `linkedOpenPR` null on this path, which the consumer can interpret
  // as "not checked — heartbeat short-circuited the decision".
  let linkedOpenPR: string | null = null;
  if (!localHeartbeatPresent) {
    try {
      const linked = await findOpenLinkedPR(
        repo,
        issue.number,
        ghFn,
        cache,
        assignee,
      );
      if (linked) {
        linkedOpenPR = `${repo}#${linked.number}`;
      }
    } catch (err) {
      recordFaultEvent(
        "catch_block_warning",
        `findOpenLinkedPR failed in ${source} for ${repo}#${issue.number}: ${err}`,
      );
    }
  }

  // Heartbeat markers (Issue #1454). Issue #3164: only honour markers from
  // fleet accounts so a forged heartbeat from a non-fleet commenter cannot
  // suppress recovery.
  const markers = await scanHeartbeatMarkers(
    repo,
    issue.number,
    ghFn,
    config.fleetAuthors,
  );
  const markerClass = classifyMarkers(
    markers,
    config.machineId,
    now,
    timeoutSeconds,
  );

  // Elapsed since the issue's last update.
  const updatedEpoch = parseISODate(issue.updatedAt);
  const elapsedSinceUpdate = isNaN(updatedEpoch) ? null : now - updatedEpoch;

  // Decide which path applies — order matches the historical control
  // flow so behaviour is preserved.
  let decision: RecoveryDecision;
  if (localHeartbeatPresent) {
    decision = "skipped:has_local_heartbeat";
  } else if (linkedOpenPR !== null) {
    decision = "skipped:open_pr";
  } else if (
    markerClass.skip.skip &&
    !(
      markerClass.skip.decision === "skipped:cleared_marker" &&
      !shouldHonourClearedMarker(
        markerClass,
        config.machineId,
        elapsedSinceUpdate,
      )
    )
  ) {
    decision = markerClass.skip.decision;
  } else if (elapsedSinceUpdate === null) {
    decision = "skipped:invalid_updated_at";
  } else if (elapsedSinceUpdate <= timeoutSeconds) {
    decision = "skipped:within_threshold";
  } else {
    decision = "recovered";
  }

  recordRecoveryDecision({
    source,
    issue: `${repo}#${issue.number}`,
    assignee,
    elapsedSinceUpdate,
    markerState: markerClass.state,
    markerMachineId: markerClass.latest?.machineId ?? null,
    markerEpoch: markerClass.latest?.epoch ?? null,
    linkedOpenPR,
    localHeartbeatPresent,
    crossAccount,
    decision,
  });

  return decision;
}

/**
 * A single assignee on an issue evaluated for recovery. For the
 * own-account path `assignee === githubUser` and `crossAccount` is false;
 * for a cross-account leak (Issue #2671) `assignee` is another account that
 * has left worker marker evidence on the issue.
 */
interface RecoveryCandidate {
  number: number;
  updatedAt: string;
  title: string;
  assignee: string;
  crossAccount: boolean;
}

/**
 * Fetch the set of comment-author logins on an issue that have posted a
 * worker claim (`CLAIM_LOCK`) or heartbeat (`VIBE_CODER_HEARTBEAT`) marker
 * (Issue #2671).
 *
 * This is the evidence that an assignee from another account is itself a
 * worker — and therefore safe to auto-unassign — rather than a human
 * teammate. Returns an empty set on any API/parse failure, so a fetch
 * error simply yields "no cross-account evidence" and leaves the
 * own-account recovery path untouched.
 */
async function fetchMarkerAuthors(
  repo: string,
  issueNumber: number,
  ghFn: (args: string[]) => Promise<string>,
): Promise<Set<string>> {
  const authors = new Set<string>();
  let json: string;
  try {
    json = await ghFn([
      "api",
      `repos/${repo}/issues/${issueNumber}/comments`,
      "--jq",
      "[.[] | {body: .body, login: .user.login}]",
    ]);
  } catch (err) {
    recordFaultEvent(
      "catch_block_warning",
      `fetchMarkerAuthors failed for ${repo}#${issueNumber}: ${err}`,
    );
    return authors;
  }
  if (!json) return authors;
  let comments: unknown;
  try {
    comments = JSON.parse(json);
  } catch (err) {
    recordFaultEvent(
      "catch_block_warning",
      `fetchMarkerAuthors parse failed for ${repo}#${issueNumber}: ${err}`,
    );
    return authors;
  }
  if (!Array.isArray(comments)) return authors;
  for (const c of comments as Array<Record<string, unknown>>) {
    if (!c || typeof c.body !== "string" || typeof c.login !== "string") {
      continue;
    }
    if (
      c.body.includes(CLAIM_MARKER_PREFIX) ||
      c.body.includes(HEARTBEAT_MARKER_PREFIX)
    ) {
      authors.add(c.login);
    }
  }
  return authors;
}

/**
 * Build the list of assignees to evaluate for recovery across a repo's
 * open issues (Issue #2671).
 *
 * Always includes the scanning worker's own account (unchanged behaviour).
 * Additionally includes any *other* assignee that has posted worker claim
 * or heartbeat markers on the issue — evidence that the assignment was
 * leaked by a worker on another account.
 *
 * Comment-fetch cost is bounded: comments are only fetched for issues that
 * have a non-self assignee **and** are already past the staleness threshold
 * on `updatedAt`. Assignees with no marker evidence (e.g. human teammates)
 * are never returned and so continue to block pickup.
 */
async function buildRecoveryCandidates(
  repo: string,
  allIssues: ReadonlyArray<
    { number: number; title: string; assignees: string[]; updatedAt?: string }
  >,
  githubUser: string,
  now: number,
  timeoutSeconds: number,
  ghFn: (args: string[]) => Promise<string>,
): Promise<RecoveryCandidate[]> {
  const candidates: RecoveryCandidate[] = [];
  for (const i of allIssues) {
    const updatedAt = i.updatedAt ?? "";
    const assignees = i.assignees ?? [];

    // Own-account assignment — always a candidate (unchanged behaviour).
    if (assignees.includes(githubUser)) {
      candidates.push({
        number: i.number,
        updatedAt,
        title: i.title,
        assignee: githubUser,
        crossAccount: false,
      });
    }

    // Cross-account assignees (Issue #2671). Cheap pre-check first: skip
    // issues with no other assignee, and skip those still within the
    // staleness threshold, so comments are only fetched when recovery is
    // actually plausible.
    const others = assignees.filter((a) => a !== githubUser);
    if (others.length === 0) continue;
    const updatedEpoch = parseISODate(updatedAt);
    const elapsed = isNaN(updatedEpoch) ? null : now - updatedEpoch;
    if (elapsed === null || elapsed <= timeoutSeconds) continue;

    const markerAuthors = await fetchMarkerAuthors(repo, i.number, ghFn);
    if (markerAuthors.size === 0) continue;
    for (const other of others) {
      if (markerAuthors.has(other)) {
        candidates.push({
          number: i.number,
          updatedAt,
          title: i.title,
          assignee: other,
          crossAccount: true,
        });
      }
    }
  }
  return candidates;
}

/**
 * Detect assigned issues with no local heartbeat file (Issue #632).
 *
 * Queries GitHub for open issues assigned to the worker across all configured
 * repos. For each issue with no heartbeat that has been assigned longer than
 * assignedNoHeartbeatTimeout, unassigns and posts a recovery comment.
 *
 * Skips issues with an open linked PR (Issue #1452) — the worker is
 * legitimately waiting on review/merge, not crashed.
 */
export async function detectAssignedWithoutHeartbeat(
  config: StuckIssueConfig,
  githubUser: string,
  nowFn: () => number = () => Math.floor(Date.now() / 1000),
  ghCommandFn?: (args: string[]) => Promise<string>,
  cache?: IssueCache,
): Promise<number> {
  const ghFn = ghCommandFn ?? runGh;
  let recoveredCount = 0;
  if (!config.repos.length) return 0;

  for (const repo of config.repos) {
    // Issue #1787: read through `fetchAllIssues` so this scan shares
    // the iteration-scoped `issues_all` cache. Filter locally by
    // assignee — the cache contains every open issue's assignees.
    let allIssues;
    try {
      allIssues = await fetchAllIssues(repo, cache, 100, ghFn);
    } catch (err) {
      recordFaultEvent(
        "catch_block_warning",
        `fetchAllIssues failed in detectAssignedWithoutHeartbeat for ${repo}: ${err}`,
      );
      continue;
    }
    const now = nowFn();
    const candidates = await buildRecoveryCandidates(
      repo,
      allIssues,
      githubUser,
      now,
      config.assignedNoHeartbeatTimeout,
      ghFn,
    );

    let repoMutated = false;

    for (const candidate of candidates) {
      const decision = await emitDecision({
        source: "detectAssignedWithoutHeartbeat",
        config,
        repo,
        issue: candidate,
        assignee: candidate.assignee,
        crossAccount: candidate.crossAccount,
        timeoutSeconds: config.assignedNoHeartbeatTimeout,
        now,
        ghFn,
        cache,
      });
      if (decision !== "recovered") continue;

      // Unassign
      await ghFn([
        "issue",
        "edit",
        String(candidate.number),
        "--repo",
        repo,
        "--remove-assignee",
        candidate.assignee,
      ]);

      // Post recovery comment / audit note
      const minutes = Math.floor(config.assignedNoHeartbeatTimeout / 60);
      const comment = candidate.crossAccount
        ? `Automatic cross-account recovery: this issue was unassigned from \`${candidate.assignee}\` by machine \`${
          config.machineId ?? "unknown"
        }\` because that account left worker claim/heartbeat markers but has no active heartbeat (assigned over ${minutes} minutes ago). The marker evidence shows a worker — not a human — held this assignment, so it is safe to recover. The issue is now available to be picked up again.

---

Cross-account assigned-without-heartbeat recovery (Issues #632, #2671)`
        : `Automatic recovery: this issue was unassigned from \`${candidate.assignee}\` because the worker has no active heartbeat for this issue (assigned over ${minutes} minutes ago with no heartbeat recorded). This likely means the worker crashed between claiming the issue and starting work. The issue is now available to be picked up again.

---

Assigned-without-heartbeat recovery (Issue #632)`;

      await ghFn([
        "issue",
        "comment",
        String(candidate.number),
        "--repo",
        repo,
        "--body",
        comment,
      ]);

      recoveredCount++;
      repoMutated = true;
      // Issue #1797: drop per-issue title-search caches so any
      // follow-up PR scan in the same iteration sees the unassigned
      // state.
      if (cache) {
        await invalidatePRsForIssueByTitle(
          cache,
          repo,
          candidate.number,
          "open",
        );
      }
    }

    // Issue #1797: assignee mutation invalidates the shared
    // `issues_all` cache so subsequent scans within the iteration
    // do not re-process the same issue.
    if (repoMutated && cache) {
      await cache.invalidate(repo, "issues_all");
    }
  }

  return recoveredCount;
}

/**
 * Scan GitHub for stale assignments from other workers (Issue #604).
 *
 * Complements the local heartbeat mechanism by checking for issues
 * assigned to the shared worker username with no recent activity.
 *
 * Skips issues with an open linked PR (Issue #1452) — the worker is
 * legitimately waiting on review/merge, not crashed.
 */
export async function recoverStaleGithubAssignments(
  config: StuckIssueConfig,
  githubUser: string,
  nowFn: () => number = () => Math.floor(Date.now() / 1000),
  ghCommandFn?: (args: string[]) => Promise<string>,
  cache?: IssueCache,
): Promise<number> {
  const ghFn = ghCommandFn ?? runGh;
  let recoveredCount = 0;
  if (!config.repos.length) return 0;

  for (const repo of config.repos) {
    // Issue #1787: route through the shared `issues_all` cache so this
    // scan does not issue an extra `gh issue list` per iteration.
    let allIssues;
    try {
      allIssues = await fetchAllIssues(repo, cache, 100, ghFn);
    } catch (err) {
      recordFaultEvent(
        "catch_block_warning",
        `fetchAllIssues failed in recoverStaleGithubAssignments for ${repo}: ${err}`,
      );
      continue;
    }
    const now = nowFn();
    const candidates = await buildRecoveryCandidates(
      repo,
      allIssues,
      githubUser,
      now,
      config.staleAssignmentTimeout,
      ghFn,
    );

    let repoMutated = false;

    for (const candidate of candidates) {
      const decision = await emitDecision({
        source: "recoverStaleGithubAssignments",
        config,
        repo,
        issue: candidate,
        assignee: candidate.assignee,
        crossAccount: candidate.crossAccount,
        timeoutSeconds: config.staleAssignmentTimeout,
        now,
        ghFn,
        cache,
      });
      if (decision !== "recovered") continue;

      // Unassign
      await ghFn([
        "issue",
        "edit",
        String(candidate.number),
        "--repo",
        repo,
        "--remove-assignee",
        candidate.assignee,
      ]);

      const hours = Math.floor(config.staleAssignmentTimeout / 3600);
      const comment = candidate.crossAccount
        ? `Automatic cross-account recovery: this issue was unassigned from \`${candidate.assignee}\` by machine \`${
          config.machineId ?? "unknown"
        }\` because that account left worker claim/heartbeat markers but no worker appears to be actively working on it (no activity for over ${hours} hours). The marker evidence shows a worker — not a human — held this assignment, so it is safe to recover. The issue is now available to be picked up again.

---

Cross-account stale assignment recovery (Issues #604, #2671)`
        : `Automatic recovery: this issue was unassigned from \`${candidate.assignee}\` because no worker appears to be actively working on it (no activity for over ${hours} hours). The issue is now available to be picked up again.

---

Multi-worker stale assignment recovery (Issue #604)`;

      await ghFn([
        "issue",
        "comment",
        String(candidate.number),
        "--repo",
        repo,
        "--body",
        comment,
      ]);

      recoveredCount++;
      repoMutated = true;
      if (cache) {
        await invalidatePRsForIssueByTitle(
          cache,
          repo,
          candidate.number,
          "open",
        );
      }
    }

    if (repoMutated && cache) {
      await cache.invalidate(repo, "issues_all");
    }
  }

  return recoveredCount;
}

/**
 * Detect assigned issues with closed PRs (Issue #787).
 *
 * For each assigned open issue without a heartbeat:
 *   1. If a merged PR exists → close the issue and unassign
 *   2. If only closed-not-merged PRs exist → unassign so issue can be retried
 *   3. If an open PR exists → skip (work is in progress)
 */
export async function detectAssignedWithClosedPr(
  config: StuckIssueConfig,
  githubUser: string,
  planningLabel = "planning",
  ghCommandFn?: (args: string[]) => Promise<string>,
  cache?: IssueCache,
): Promise<number> {
  const ghFn = ghCommandFn ?? runGh;
  let recoveredCount = 0;
  if (!config.repos.length) return 0;

  for (const repo of config.repos) {
    // Issue #1787: route through `fetchAllIssues` so this scan reuses
    // the iteration-scoped `issues_all` cache instead of issuing a
    // separate `gh issue list --assignee` call. Filter locally by
    // assignee — the cache contains every open issue's assignees.
    let allIssues;
    try {
      allIssues = await fetchAllIssues(repo, cache, 100, ghFn);
    } catch (err) {
      recordFaultEvent(
        "catch_block_warning",
        `fetchAllIssues failed in detectAssignedWithClosedPR for ${repo}: ${err}`,
      );
      continue;
    }

    const issues = allIssues
      .filter((i) => i.assignees.includes(githubUser))
      .map((i) => ({
        number: i.number,
        title: i.title,
        labels: i.labels.map((name) => ({ name })),
      }));

    // Issue #1809: fetch the repo-wide closed-PR list once per repo and
    // filter locally per issue. Replaces the previous N+1 per-issue
    // `gh pr list --search` calls.
    let closedPrsForRepo: Awaited<ReturnType<typeof fetchClosedPRsByUser>> = [];
    try {
      closedPrsForRepo = await fetchClosedPRsByUser(
        repo,
        githubUser,
        100,
        cache,
        ghFn,
      );
    } catch (err) {
      recordFaultEvent(
        "catch_block_warning",
        `fetchClosedPRsByUser failed in detectAssignedWithClosedPR for ${repo}: ${err}`,
      );
      closedPrsForRepo = [];
    }

    let repoMutated = false;

    for (const issue of issues) {
      if (issue.labels?.some((l) => l.name === planningLabel)) {
        continue;
      }
      // Skip if there is a local heartbeat
      const hbPath = heartbeatFilePath(config.workDir, repo, issue.number);
      try {
        await Deno.stat(hbPath);
        continue;
      } catch {
        // No heartbeat — continue checking
      }

      // Check for open PRs — shared helper (Issue #1452)
      if (await hasOpenLinkedPR(repo, issue.number, ghFn, cache, githubUser)) {
        continue;
      }

      // Issue #1797: route the per-issue merged-PR lookup through
      // `fetchPRsForIssueByTitle` so multiple scans within the same
      // iteration share a `prs_title_merged_${issueNumber}` cache. This
      // also covers merged PRs authored by humans, which the previous
      // worker-author-only cache shape missed.
      let mergedMatches: Awaited<ReturnType<typeof fetchPRsForIssueByTitle>> =
        [];
      try {
        mergedMatches = await fetchPRsForIssueByTitle(
          repo,
          issue.number,
          "merged",
          cache,
          ghFn,
        );
      } catch (err) {
        recordFaultEvent(
          "catch_block_warning",
          `fetchPRsForIssueByTitle(merged) failed for ${repo}#${issue.number}: ${err}`,
        );
        mergedMatches = [];
      }
      const mergedPrNumber = mergedMatches[0] ? mergedMatches[0].number : 0;

      if (mergedPrNumber > 0) {
        // Check if merged PR predates current assignment (Issue #563)
        const mergedAtJson = await ghFn([
          "pr",
          "view",
          String(mergedPrNumber),
          "--repo",
          repo,
          "--json",
          "mergedAt",
        ]);
        const assignedAtJson = await ghFn([
          "api",
          `repos/${repo}/issues/${issue.number}/timeline`,
          "--jq",
          `[.[] | select(.event == "assigned" and .assignee.login == "${githubUser}")] | last | .created_at // empty`,
        ]);

        let isStale = false;
        if (mergedAtJson && assignedAtJson) {
          try {
            const mergedAt = JSON.parse(mergedAtJson).mergedAt || "";
            if (mergedAt && assignedAtJson && mergedAt < assignedAtJson) {
              isStale = true;
            }
          } catch { /* ignore */ }
        }

        if (isStale) {
          // Stale previous attempt — unassign only
          await ghFn([
            "issue",
            "comment",
            String(issue.number),
            "--repo",
            repo,
            "--body",
            `Self-healing: found merged PR #${mergedPrNumber} but it predates the current assignment — treating as stale previous attempt. Unassigning so this issue can be picked up again.\n\n---\n\nClosed-PR self-healing (Issue #787)`,
          ]);
          await ghFn([
            "issue",
            "edit",
            String(issue.number),
            "--repo",
            repo,
            "--remove-assignee",
            githubUser,
          ]);
          recoveredCount++;
          repoMutated = true;
          // Issue #1797: invalidate per-issue title-search caches so a
          // follow-up scan in the same iteration sees the fresh state.
          if (cache) {
            await invalidatePRsForIssueByTitle(
              cache,
              repo,
              issue.number,
              "open",
            );
            await invalidatePRsForIssueByTitle(
              cache,
              repo,
              issue.number,
              "merged",
            );
            await invalidatePRsForIssueByTitle(
              cache,
              repo,
              issue.number,
              "closed",
            );
          }
          continue;
        }

        // A merged PR is not a landed change (Issue #4396): the orphaned
        // #3329/#3349 were re-closed here on the strength of PRs that had
        // merged into a rolled-up milestone branch. Verify the landing;
        // an orphaned merge leaves the issue open and unassigned for a
        // fresh attempt.
        const landing = await verifyMergeLanded(repo, mergedPrNumber, ghFn);
        if (!landing.landed) {
          console.warn(
            `Self-healing: merged PR #${mergedPrNumber} for ${repo}#${issue.number} did not land — ${landing.detail}; leaving the issue open (Issue #4396)`,
          );
          await ghFn([
            "issue",
            "edit",
            String(issue.number),
            "--repo",
            repo,
            "--remove-assignee",
            githubUser,
          ]);
          recoveredCount++;
          continue;
        }

        // Work is done — close issue and unassign
        await ghFn([
          "issue",
          "close",
          String(issue.number),
          "--repo",
          repo,
          "--comment",
          `Automatically closed — PR #${mergedPrNumber} has already been merged for this issue.\n\n---\n\nClosed-PR self-healing (Issue #787)`,
        ]);
        await ghFn([
          "issue",
          "edit",
          String(issue.number),
          "--repo",
          repo,
          "--remove-assignee",
          githubUser,
        ]);
        recoveredCount++;
        repoMutated = true;
        if (cache) {
          await invalidatePRsForIssueByTitle(cache, repo, issue.number, "open");
          await invalidatePRsForIssueByTitle(
            cache,
            repo,
            issue.number,
            "merged",
          );
          await invalidatePRsForIssueByTitle(
            cache,
            repo,
            issue.number,
            "closed",
          );
        }
        continue;
      }

      // Issue #1809: filter the repo-wide closed-PR list locally
      // instead of issuing a per-issue `gh pr list --search`. Match the
      // worker title conventions and exclude merged PRs (those would
      // have been handled by the merged-state branch above).
      const notMerged = closedPrsForRepo.filter((pr) =>
        prTitleMatchesIssue(pr.title, issue.number) && !pr.mergedAt
      );
      if (notMerged.length > 0) {
        await ghFn([
          "issue",
          "comment",
          String(issue.number),
          "--repo",
          repo,
          "--body",
          `Self-healing: found ${notMerged.length} closed (not merged) PR(s) for this issue with no open PR and no active worker. Unassigning so this issue can be picked up again.\n\n---\n\nClosed-PR self-healing (Issue #787)`,
        ]);
        await ghFn([
          "issue",
          "edit",
          String(issue.number),
          "--repo",
          repo,
          "--remove-assignee",
          githubUser,
        ]);
        recoveredCount++;
        repoMutated = true;
        if (cache) {
          await invalidatePRsForIssueByTitle(cache, repo, issue.number, "open");
          await invalidatePRsForIssueByTitle(
            cache,
            repo,
            issue.number,
            "merged",
          );
          await invalidatePRsForIssueByTitle(
            cache,
            repo,
            issue.number,
            "closed",
          );
          // Issue #1809: drop the shared closed-PR list so a follow-up
          // scan in the same iteration sees the freshly mutated state.
          await invalidateClosedPRsByUser(repo, githubUser, cache);
        }
      }
    }

    // Issue #1797: if any issue was closed/unassigned in this repo, drop
    // the shared `issues_all` cache so a follow-up scan sees the
    // mutated state instead of the stale assignee list.
    if (repoMutated && cache) {
      await cache.invalidate(repo, "issues_all");
    }
  }

  return recoveredCount;
}
