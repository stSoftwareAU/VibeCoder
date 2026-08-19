import { MILESTONE_PRIORITY_VALUES } from "./milestone_priority.ts";

/**
 * Priority ordering and candidate ranking for issue selection (Issue #910).
 *
 * Replaces worker/shared/issue_priority.sh with type-safe TypeScript.
 * Handles candidate timestamp extraction, sorting, dependency blocking,
 * per-issue eligibility, and priority-based candidate selection.
 *
 * Priority order (highest first):
 *   1. configured-label  — top-priority discovery label (Issue #2022).
 *                          Legacy `help wanted` / `claude` labels remain
 *                          configurable for backward compatibility but
 *                          are no longer part of the hardwired set.
 *   2. work-on           — explicit work-on signal
 *   3. low-priority      — backlog
 *   4. idle-task         — worker-filed busywork, picked up only when
 *                          every other tier is empty (Issue #1961). The
 *                          single label the Vibe Coder may self-apply.
 *
 * Issue #1237: Supports configurable milestone priority via priority labels.
 * Within the same milestone, issues with priority-high are selected before
 * normal, and normal before priority-low. Cross-milestone ordering remains
 * globally oldest-first.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

/**
 * An issue candidate for selection.
 */
export interface IssueCandidate {
  /** Repository in "owner/repo" format */
  repo: string;
  /** Issue number */
  number: number;
  /** Issue URL */
  url: string;
  /** Issue title */
  title: string;
  /** Milestone title (empty string if no milestone) */
  milestone: string;
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** Zero-padded label index for priority ordering (configured-label only) */
  labelIndex: number;
  /** Source of the candidate */
  source: "configured-label" | "work-on" | "low-priority" | "idle-task";
  /**
   * Milestone priority derived from priority labels (Issue #1237).
   * Lower value = higher priority. Only affects ordering within the
   * same milestone — cross-milestone selection uses oldest-first.
   * Defaults to MILESTONE_PRIORITY_VALUES.normal (2) when absent.
   */
  milestonePriority?: number;
}

/**
 * Options for controlling candidate selection behaviour (Issue #1089).
 *
 * When randomisation is enabled, selection randomly picks from the top
 * candidates within the same priority tier instead of always choosing
 * the oldest. This reduces claim races when multiple workers scan
 * simultaneously.
 */
export interface SelectionOptions {
  /**
   * Random number generator returning a value in [0, 1).
   * Defaults to Math.random. Injectable for deterministic testing.
   */
  randomFn?: () => number;

  /**
   * Maximum number of top candidates (by age, oldest first) to include
   * in the random pool within a priority tier. Limits randomisation to
   * the N oldest candidates for fairness. Defaults to 3.
   *
   * Note (Issue #2773): when a `randomFn` is supplied,
   * `selectHighestPriority` now rotates fairly *by repo* within the
   * winning priority sub-tier rather than across the N oldest issues
   * globally, so this field no longer influences `selectHighestPriority`.
   * It still governs the standalone `selectOldestCandidate` helper, which
   * retains the original N-oldest-pool behaviour for backward
   * compatibility.
   */
  randomPoolSize?: number;

  /**
   * Resolve a repo's `nice` value (Issue #2773). Lower `nice` = higher
   * urgency: selection draws from the lowest-`nice` non-empty tier first,
   * only falling through to a higher-`nice` tier when no lower tier yields
   * a selectable candidate. Defaults to `() => 0`, so every repo shares a
   * single tier and existing callers are unaffected.
   */
  repoNice?: (repo: string) => number;
}

/**
 * Result of priority selection.
 */
export interface SelectionResult {
  /** The selected candidate, or null if none */
  selected: IssueCandidate | null;
  /** All configured-label candidates found */
  labelCandidates: IssueCandidate[];
  /** All work-on candidates found */
  workOnCandidates: IssueCandidate[];
  /** Repos/milestones that have blocked configured-label issues */
  blockedEntries: Array<{ repo: string; milestone: string }>;
  /**
   * All low-priority candidates found (Issue #1725).
   *
   * Tier 3 — only selected when both `labelCandidates` is empty AND no
   * work-on candidate survives blocking suppression. The semantics are
   * "global": because callers collect candidates from every scanned repo
   * before invoking selection, a single configured-label or work-on
   * candidate in any repo will suppress all low-priority candidates
   * everywhere. Optional for backward compatibility — defaults to an
   * empty list.
   */
  lowPriorityCandidates?: IssueCandidate[];
  /**
   * All idle-task candidates found (Issue #1961).
   *
   * Tier 4 — strictly below `low-priority`. Only selected when every
   * other tier (configured-label, work-on, low-priority) is empty
   * across the entire scanned repo set. Optional for backward
   * compatibility — defaults to an empty list.
   */
  idleTaskCandidates?: IssueCandidate[];
  /**
   * Repos with at least one open work-on labelled issue that is *not
   * solely dependency-blocked* (Issue #2164, narrowed by Issue #2610).
   *
   * Used to suppress low-priority and idle-task candidates from these
   * repos. The low-priority label means "backlog work — picked up only
   * when no other eligible work exists" — a repo with a work-on issue
   * that is temporarily blocked for a serialisation reason (PR-blocked,
   * assigned to another worker, milestone-occupied) should not contribute
   * low-priority or idle-task work. Issue #2610: a repo whose only open
   * work-on issues are purely dependency-blocked is *excluded* from this
   * set, because suppressing the low-priority dependency that would
   * unblock the chain deadlocks the repo. Optional for backward
   * compatibility — defaults to an empty set.
   */
  reposWithOpenWorkOn?: ReadonlySet<string>;
  /**
   * Repos with at least one open low-priority labelled issue
   * (Issue #2164). Used to suppress idle-task candidates from these
   * repos — idle-task is strictly the lowest tier, so a repo with any
   * open low-priority issue should not contribute idle-task work.
   * Optional for backward compatibility — defaults to an empty set.
   */
  reposWithOpenLowPriority?: ReadonlySet<string>;
}

/**
 * Compare two candidates by priority, then milestone priority, then age.
 *
 * Ordering (lower sorts first = higher priority):
 *   1. labelIndex — lower = higher priority.
 *   2. milestone priority (Issue #1237) — only within the same non-empty
 *      milestone; cross-milestone and non-milestone ordering is age-based.
 *   3. createdAt — older first.
 */
function compareCandidates(a: IssueCandidate, b: IssueCandidate): number {
  if (a.labelIndex !== b.labelIndex) {
    return a.labelIndex - b.labelIndex;
  }
  if (
    a.milestone !== "" &&
    a.milestone === b.milestone &&
    (a.milestonePriority ?? MILESTONE_PRIORITY_VALUES.normal) !==
      (b.milestonePriority ?? MILESTONE_PRIORITY_VALUES.normal)
  ) {
    return (
      (a.milestonePriority ?? MILESTONE_PRIORITY_VALUES.normal) -
      (b.milestonePriority ?? MILESTONE_PRIORITY_VALUES.normal)
    );
  }
  return a.createdAt.localeCompare(b.createdAt);
}

/**
 * Select a candidate from a list, with optional randomisation within
 * equal-priority tiers (Issue #1089).
 *
 * Sorts by labelIndex (lower = higher priority), then by createdAt
 * (older = higher priority). When selection options are provided,
 * randomly picks from the top N oldest candidates within the highest
 * priority tier instead of always choosing the oldest.
 *
 * Retained unchanged for backward compatibility (Issue #2773 routes
 * `selectHighestPriority` through the repo-fair `selectFairWithinTier`
 * helper instead, but standalone callers of this function keep the
 * original N-oldest-pool semantics).
 *
 * @param candidates - Candidate list
 * @param options - Optional randomisation settings
 * @returns Selected candidate, or null if empty
 */
export function selectOldestCandidate(
  candidates: IssueCandidate[],
  options?: SelectionOptions,
): IssueCandidate | null {
  if (candidates.length === 0) return null;

  const sorted = [...candidates].sort(compareCandidates);

  // Without randomisation, return the top candidate deterministically
  if (!options?.randomFn) {
    return sorted[0] ?? null;
  }

  // Collect candidates in the highest priority tier (same labelIndex)
  const topCandidate = sorted[0]!;
  const topLabelIndex = topCandidate.labelIndex;
  const sameTier = sorted.filter((c) => c.labelIndex === topLabelIndex);

  // Limit the random pool to the top N oldest within this tier
  const poolSize = Math.min(
    options.randomPoolSize ?? 3,
    sameTier.length,
  );
  const pool = sameTier.slice(0, poolSize);

  // Randomly select from the pool
  const index = Math.floor(options.randomFn() * pool.length);
  return pool[index] ?? topCandidate;
}

/**
 * Select a candidate from a single priority tier with fair, per-repo
 * rotation (Issue #2773).
 *
 * Replaces the "N-oldest-globally" pool bias of `selectOldestCandidate`
 * (which starves fresh work in repos that share a tier with an
 * old-backlog repo). The algorithm:
 *
 *   1. Sort by {@link compareCandidates}.
 *   2. Restrict to the winning priority sub-tier (lowest `labelIndex`).
 *   3. Group that sub-tier by repo and pick a repo via the injected
 *      `randomFn` — so equal-priority candidates rotate fairly across
 *      repos rather than always resolving to the globally-oldest issue.
 *   4. Within the chosen repo, return the oldest-first candidate
 *      (milestone priority + age, per {@link compareCandidates}).
 *
 * With no `randomFn`, returns the globally-best candidate
 * (`sorted[0]`) — identical to `selectOldestCandidate`'s deterministic
 * path, preserving parity for callers that do not inject one.
 *
 * @param candidates - Candidates within a single `nice` tier
 * @param options - Optional randomisation settings
 * @returns Selected candidate, or null if empty
 */
export function selectFairWithinTier(
  candidates: IssueCandidate[],
  options?: SelectionOptions,
): IssueCandidate | null {
  if (candidates.length === 0) return null;

  const sorted = [...candidates].sort(compareCandidates);

  // Deterministic path: identical to selectOldestCandidate (parity).
  if (!options?.randomFn) {
    return sorted[0] ?? null;
  }

  // Winning priority sub-tier — candidates sharing the lowest labelIndex.
  const topLabelIndex = sorted[0]!.labelIndex;
  const sameTier = sorted.filter((c) => c.labelIndex === topLabelIndex);

  // Distinct repos in oldest-first order of first appearance, so the
  // index→repo mapping is stable and deterministically testable.
  const repos: string[] = [];
  for (const c of sameTier) {
    if (!repos.includes(c.repo)) repos.push(c.repo);
  }

  // Fairly pick a repo, then take the oldest-first candidate within it.
  const repoIndex = Math.floor(options.randomFn() * repos.length);
  const chosenRepo = repos[repoIndex] ?? repos[0]!;
  return sameTier.find((c) => c.repo === chosenRepo) ?? sorted[0]!;
}

/**
 * Sort candidates by createdAt (oldest first) and return all.
 *
 * Used for workflows that return all matching issues (refinement, planning,
 * question answering).
 *
 * @param candidates - Candidates to sort
 * @returns Sorted candidates
 */
export function sortCandidatesByAge(
  candidates: IssueCandidate[],
): IssueCandidate[] {
  return [...candidates].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Order all candidates by `nice` tier ascending, placing the
 * dispatch-consumed first candidate per within-tier fairness (Issue #2775).
 *
 * The label-based finders (`findIssuesByLabel`,
 * `findPlanningIssuesWithFallback`) emit candidates newline-delimited and
 * their consumers take the **first** line. Previously that first line was the
 * globally-oldest issue across repos, which reproduced the same starvation
 * bias #2773 fixed for Priority 2. This helper restores `nice`-correctness:
 *
 *   1. Partition candidates by their repo's resolved `nice` value.
 *   2. Walk the `nice` tiers ascending (lower `nice` = worked sooner).
 *   3. Within each tier, the **first** emitted candidate is the within-tier
 *      fair choice from {@link selectFairWithinTier} (oldest-first within a
 *      repo, fair rotation across equal repos when a `randomFn` is injected);
 *      the remainder follow oldest-first so the all-results consumers still
 *      get a sensible order.
 *
 * Reuses the #2773 shared helper rather than re-deriving the fairness logic.
 * With the default `repoNice` (`() => 0`) every repo shares one tier, so the
 * output matches the previous oldest-first behaviour — except equal repos
 * rotate fairly when a `randomFn` is supplied.
 *
 * @param candidates - Candidates to order
 * @param options - Optional selection settings (`repoNice`, `randomFn`)
 * @returns All candidates, `nice`-tier ascending with the fair choice first
 */
export function orderCandidatesByNiceTier(
  candidates: IssueCandidate[],
  options?: SelectionOptions,
): IssueCandidate[] {
  if (candidates.length === 0) return [];

  const repoNice = options?.repoNice ?? (() => 0);

  // Partition by resolved `nice` value, preserving insertion for stability.
  const byNice = new Map<number, IssueCandidate[]>();
  for (const c of candidates) {
    const nice = repoNice(c.repo);
    const tier = byNice.get(nice);
    if (tier) tier.push(c);
    else byNice.set(nice, [c]);
  }

  const ordered: IssueCandidate[] = [];
  for (const nice of [...byNice.keys()].sort((a, b) => a - b)) {
    const tier = byNice.get(nice)!;
    const first = selectFairWithinTier(tier, options);
    if (first) ordered.push(first);
    for (const c of sortCandidatesByAge(tier)) {
      if (c !== first) ordered.push(c);
    }
  }
  return ordered;
}

/**
 * Select the highest priority candidate.
 *
 * Priority rules:
 * 1. Configured-label issues (highest priority)
 * 2. Work-on candidates from repos whose configured-label search succeeded
 *    (repos with search failures are excluded — we cannot be sure there
 *    isn't a higher-priority configured-label issue there). Blocked
 *    configured-label issues suppress work-on in the same repo+milestone.
 * 3. Low-priority candidates (Issue #1725) — only chosen when tiers 1 and
 *    2 produce no selectable candidate across every scanned repo.
 * 4. Idle-task candidates (Issue #1961, #2812) — a *fleet-global* floor,
 *    strictly below every real-work tier across *all* `nice` tiers. Only
 *    chosen when no monitored repo in any `nice` tier has a selectable
 *    configured-label / work-on / low-priority candidate.
 *
 * Issue #2812: `idle-task` is lifted out of the per-`nice`-tier ordering so
 * a low-`nice` repo's idle-task can never be selected ahead of a
 * higher-`nice` repo's real work. The real-work tiers (1–3) keep the #2773
 * `nice` tiering exactly; only `idle-task` becomes a global floor. This is
 * implemented as two passes over the `nice` tiers: the first pass excludes
 * idle-task entirely (real work only); the second pass — reached only when
 * the first selects nothing anywhere — admits idle-task, draining the
 * lowest-`nice` tier with an eligible idle-task candidate first.
 *
 * @param result - Selection result with all candidates and metadata
 * @returns Selected candidate, or null if none eligible
 */
export function selectHighestPriority(
  result: SelectionResult,
  options?: SelectionOptions,
): IssueCandidate | null {
  // Issue #2773: `nice` is the outermost grouping for real work. Partition
  // candidates by their repo's resolved `nice` value and run the tier logic
  // restricted to one `nice` tier at a time, ascending. The first tier that
  // yields a selectable candidate wins, so a lower-`nice` repo is always
  // drained before any higher-`nice` repo is reached. Default `() => 0`
  // keeps every repo in a single tier (backward compatible).
  const repoNice = options?.repoNice ?? (() => 0);

  const niceValues = [
    ...new Set(
      [
        ...result.labelCandidates,
        ...result.workOnCandidates,
        ...(result.lowPriorityCandidates ?? []),
        ...(result.idleTaskCandidates ?? []),
      ].map((c) => repoNice(c.repo)),
    ),
  ].sort((a, b) => a - b);

  // Pass 1 (Issue #2812): real-work tiers only (configured-label > work-on >
  // low-priority), `nice`-tiered. idle-task is excluded so it can never be
  // selected while any `nice` tier still has selectable real work.
  for (const nice of niceValues) {
    const selected = selectWithinNiceTier(
      result,
      nice,
      repoNice,
      false,
      options,
    );
    if (selected) return selected;
  }

  // Pass 2 (Issue #2812): no real work anywhere — idle-task is now the
  // fleet-global floor. Drain the lowest-`nice` tier with an eligible
  // idle-task candidate first.
  for (const nice of niceValues) {
    const selected = selectWithinNiceTier(
      result,
      nice,
      repoNice,
      true,
      options,
    );
    if (selected) return selected;
  }
  return null;
}

/**
 * Run the priority-tier selection (configured-label > work-on >
 * low-priority > idle-task, with the Issue #2164 / #2610 suppression)
 * restricted to candidates whose repo resolves to a single `nice` value
 * (Issue #2773). Repo-level suppression sets and blocked entries are
 * applied unchanged — they are keyed by repo, so they only affect the
 * restricted candidates that belong to this tier.
 *
 * Issue #2812: when `includeIdleTask` is false the idle-task tier is
 * treated as empty, so this tier yields a candidate only from real work
 * (configured-label / work-on / low-priority). `selectHighestPriority`
 * runs a first pass with `includeIdleTask = false` across every `nice`
 * tier, making idle-task a fleet-global floor rather than a per-tier one.
 */
function selectWithinNiceTier(
  result: SelectionResult,
  nice: number,
  repoNice: (repo: string) => number,
  includeIdleTask: boolean,
  options?: SelectionOptions,
): IssueCandidate | null {
  const inTier = (c: IssueCandidate) => repoNice(c.repo) === nice;

  const labelCandidates = result.labelCandidates.filter(inTier);
  const workOnCandidates = result.workOnCandidates.filter(inTier);
  const lowPriorityCandidates = (result.lowPriorityCandidates ?? []).filter(
    inTier,
  );
  const idleTaskCandidates = includeIdleTask
    ? (result.idleTaskCandidates ?? []).filter(inTier)
    : [];
  const {
    blockedEntries,
    reposWithOpenWorkOn,
    reposWithOpenLowPriority,
  } = result;

  // Issue #2164: a repo with a *suppressing* open work-on issue must not
  // contribute low-priority or idle-task candidates. A repo with any open
  // low-priority issue must not contribute idle-task candidates. The
  // label `low-priority` means "backlog work — picked up only when no
  // other eligible work exists"; a repo with a PR-blocked or assigned
  // work-on issue still has "other work" pending and should wait rather
  // than pick backlog.
  //
  // Issue #2610: `reposWithOpenWorkOn` deliberately *excludes* repos
  // whose only open work-on issues are purely dependency-blocked. Such a
  // dependency is frequently a low-priority issue in the same repo, so
  // suppressing it would deadlock the repo. Those repos' low-priority
  // backlog stays eligible here so the dependency chain can be worked.
  const eligibleLowPriority =
    reposWithOpenWorkOn && reposWithOpenWorkOn.size > 0
      ? lowPriorityCandidates.filter((c) => !reposWithOpenWorkOn.has(c.repo))
      : lowPriorityCandidates;
  const eligibleIdleTask = (() => {
    let list = idleTaskCandidates;
    if (reposWithOpenWorkOn && reposWithOpenWorkOn.size > 0) {
      list = list.filter((c) => !reposWithOpenWorkOn.has(c.repo));
    }
    if (reposWithOpenLowPriority && reposWithOpenLowPriority.size > 0) {
      list = list.filter((c) => !reposWithOpenLowPriority.has(c.repo));
    }
    return list;
  })();

  // Priority 1: Configured-label candidates
  if (labelCandidates.length > 0) {
    return selectFairWithinTier(labelCandidates, options);
  }

  const eligibleWorkOn = workOnCandidates;

  // Priority 2: Blocked configured-label issues suppress work-on in same repo+milestone
  if (blockedEntries.length > 0) {
    const unblockedWorkOn = eligibleWorkOn.filter((candidate) => {
      return !blockedEntries.some(
        (blocked) =>
          blocked.repo === candidate.repo &&
          blocked.milestone === candidate.milestone,
      );
    });

    if (unblockedWorkOn.length > 0) {
      return selectFairWithinTier(unblockedWorkOn, options);
    }

    // No work-on survived suppression — fall through to tier 3 then tier 4
    // (applying the Issue #2164 repo-level suppression).
    return (
      selectFairWithinTier(eligibleLowPriority, options) ??
        selectFairWithinTier(eligibleIdleTask, options)
    );
  }

  // Priority 2 (cont.): Work-on candidates from repos with successful searches
  if (eligibleWorkOn.length > 0) {
    return selectFairWithinTier(eligibleWorkOn, options);
  }

  // Priority 3: Low-priority candidates (Issue #1725).
  // Only reached when no configured-label and no work-on candidates exist
  // across every scanned repo. Issue #2164: candidates from repos with
  // any open work-on issue are filtered out of `eligibleLowPriority`
  // above, so a temporarily-blocked work-on issue in repo A no longer
  // allows a low-priority issue in the same repo to slip through.
  if (eligibleLowPriority.length > 0) {
    return selectFairWithinTier(eligibleLowPriority, options);
  }

  // Priority 4: Idle-task candidates (Issue #1961) — strictly last.
  return selectFairWithinTier(eligibleIdleTask, options);
}

/**
 * Format a candidate as a pipe-delimited string for shell output.
 *
 * Format: repo|number|url|milestoneTitle|title
 *
 * @param candidate - The candidate to format
 * @returns Pipe-delimited string
 */
export function formatCandidateOutput(candidate: IssueCandidate): string {
  return `${candidate.repo}|${candidate.number}|${candidate.url}|${candidate.milestone}|${candidate.title}`;
}
