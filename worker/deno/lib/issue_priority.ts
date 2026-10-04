import { MILESTONE_PRIORITY_VALUES } from "./milestone_priority.ts";
import { workStreamKey } from "./work_stream.ts";
import type { UnworkableChainRoot } from "./dependency_chain_promotion.ts";

/**
 * Priority ordering and candidate ranking for issue selection (Issue #910).
 *
 * Replaces worker/shared/issue_priority.sh with type-safe TypeScript.
 * Handles candidate timestamp extraction, sorting, dependency blocking,
 * per-issue eligibility, and priority-based candidate selection.
 *
 * Priority order (highest first). This order is **fleet-global** — it is the
 * outermost grouping, and a repo's `nice` value orders repos *within* a tier
 * rather than around it (Issue #1063):
 *   1. configured-label  — top-priority discovery label (Issue #2022).
 *                          Legacy `help wanted` / `claude` labels remain
 *                          configurable for backward compatibility but
 *                          are no longer part of the hardwired set.
 *   1b. close-out        — a leftover in a started, fleet-viable milestone
 *                          (Issue #2009). Lifted after top-priority and
 *                          before work-on so a started milestone is
 *                          finished before another branch is opened.
 *   2. work-on           — explicit work-on signal
 *   2b. self-diagnostic  — an auto-filed worker diagnostic the worker
 *                          scheduled itself (Issue #505). Below both
 *                          human-scheduled tiers, above the backlog: a
 *                          fault in the machine that does the work outranks
 *                          backlog, but never outranks a human's intent.
 *                          Carries no label — provenance alone makes it
 *                          claimable.
 *   3. low-priority      — backlog
 *   4. idle-task         — worker-filed busywork, picked up only when
 *                          every other tier is empty (Issue #1961). The
 *                          single label the Vibe Coder may self-apply.
 *
 * Conflict-redo (Issue #3034): once the tier ladder above has picked a repo,
 * an issue in that repo re-queued by merge-conflict abandon-and-redo (whose
 * redo has not yet raised a PR) is worked next, ahead of every other
 * candidate in that repo — regardless of its own tier. It never displaces
 * another repo's winner, and week-pace (Issue #1885) still refuses a
 * low-priority/idle-task redo exactly as it refuses those tiers today.
 *
 * Issue #1063: `nice` is a tie-breaker *within* a priority band, never a band
 * of its own. Urgency is expressed by the label; `nice` shapes throughput
 * between repos that are equally urgent. So a `top-priority` issue in a
 * `nice: -15` repo is selected ahead of a `work-on` issue in a `nice: -20`
 * repo, while two `top-priority` issues are ordered by their repos' `nice`.
 * Issue #2773 had briefly inverted this by wrapping a `nice` partition around
 * the tier ladder, which let another repo's routine backlog outrank an
 * urgency signal.
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
  source:
    | "configured-label"
    | "work-on"
    /** Issue #505: self-scheduled auto-filed worker diagnostic. */
    | "self-diagnostic"
    | "low-priority"
    | "idle-task";
  /**
   * Milestone priority derived from priority labels (Issue #1237).
   * Lower value = higher priority. Only affects ordering within the
   * same milestone — cross-milestone selection uses oldest-first.
   * Defaults to MILESTONE_PRIORITY_VALUES.normal (2) when absent.
   */
  milestonePriority?: number;
  /**
   * The dependency-blocked issue whose chain lifted this candidate into a
   * higher tier (Issue #2495). Absent for every candidate discovered on its
   * own label. `source` is deliberately *not* rewritten, so the scan log
   * still names the label the issue actually carries.
   */
  promotedBy?: { repo: string; number: number };
  /**
   * Set when the issue was re-queued by merge-conflict abandon-and-redo and its
   * redo has not yet raised a PR (Issue #3034). `restartedAt` is the trusted
   * restart claim's ISO time. Selection makes a redo the next pickup in its repo.
   */
  conflictRedo?: { restartedAt: string };
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
   * Resolve a repo's `nice` value (Issue #2773). Lower `nice` = worked
   * sooner. Issue #1063: `nice` orders repos *within* a label tier — the
   * label tier is decided first across the whole fleet, and only its
   * candidates are then drawn from their lowest-`nice` repos. Defaults to
   * `() => 0`, so every repo shares a single tier and existing callers are
   * unaffected.
   */
  repoNice?: (repo: string) => number;

  /**
   * True when the weekly Claude quota will not last (Issue #1885).
   *
   * While engaged, no `low-priority` (tier 3) or `idle-task` (tier 4)
   * candidate is claimed, so the quota left in the seven-day window goes to
   * `top-priority` and `work-on` work. Tiers 1, 2 and 2b are untouched.
   * Defaults to `false` — an unknown or failed budget reading never refuses
   * work, so pickup is exactly as it was.
   */
  weekPaceEngaged?: boolean;
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
   * All self-scheduled worker-diagnostic candidates found (Issue #505).
   *
   * Tier 2b — below both human-scheduled tiers (`configured-label`,
   * `work-on`) and above `low-priority`. These carry no label: they are
   * claimable on provenance alone (see
   * `collect_self_diagnostic_candidates.ts`). Optional for backward
   * compatibility — defaults to an empty list, which is exactly the
   * behaviour before self-scheduling existed.
   */
  selfDiagnosticCandidates?: IssueCandidate[];
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
   * Repos with at least one open low-priority issue that is not waiting
   * on a human (Issues #2164, #2751). Used to suppress idle-task
   * candidates from these repos — idle-task is strictly the lowest tier.
   * An issue carrying a handoff label (`failed`, `refine-issue`,
   * `planning`, `question`, `needs-revision`, `needs-human`) or a
   * non-fleet assignee does not count; dependency-blocked, PR-blocked
   * and fleet-assigned issues still do.
   * Optional for backward compatibility — defaults to an empty set.
   */
  reposWithOpenLowPriority?: ReadonlySet<string>;
  /**
   * Started, fleet-viable milestones whose leftover issues should be
   * selected after `top-priority` and before `work-on` (Issue #2009).
   *
   * Keyed by {@link workStreamKey}. Presence means the milestone has
   * already started (at least one closed child) and every remaining
   * open non-tracking issue is an admitted candidate. Optional — an
   * absent or empty map leaves today's tier order unchanged.
   */
  closeOutMilestones?: ReadonlyMap<string, MilestoneCloseOut>;
  /**
   * Chain roots the fleet cannot work (Issue #2495), as classified by
   * `resolveChainPromotions`. Selection ignores them — they are carried
   * here so the caller can report a chain nobody can move. Absent when no
   * candidate was dependency-blocked this scan.
   */
  unworkableChainRoots?: UnworkableChainRoot[];
}

/**
 * A started, fleet-viable milestone that selection should close out
 * before opening another work stream (Issue #2009).
 */
export interface MilestoneCloseOut {
  /** Open non-tracking issues still admitted in this milestone. */
  remainingViable: number;
}

/**
 * An open issue considered when deciding whether a milestone is
 * fleet-viable (Issue #2009).
 */
export interface CloseOutOpenIssue {
  repo: string;
  number: number;
  milestone: string;
  /** True when this is the milestone's tracking issue, not real work. */
  tracking?: boolean;
}

/**
 * Build the close-out map for {@link selectHighestPriority} (Issue #2009).
 *
 * A milestone is close-out eligible only when it is started *and*
 * fleet-viable: every remaining open non-tracking issue appears among
 * the admitted candidates. A leftover `needs-human`, dependency-blocked
 * or otherwise skipped issue means the fleet cannot finish the
 * milestone, so the rule does not apply.
 *
 * @param openIssues - Open issues that still belong to a milestone
 * @param candidates - Candidates the existing gates have already admitted
 * @param startedKeys - `workStreamKey`s of milestones with closed children
 * @returns Map of started, fleet-viable milestones
 */
export function buildCloseOutMilestones(
  openIssues: readonly CloseOutOpenIssue[],
  candidates: readonly IssueCandidate[],
  startedKeys: ReadonlySet<string>,
): Map<string, MilestoneCloseOut> {
  const result = new Map<string, MilestoneCloseOut>();
  if (startedKeys.size === 0) return result;

  const openByKey = new Map<string, Set<number>>();
  for (const issue of openIssues) {
    if (issue.milestone === "" || issue.tracking) continue;
    const key = workStreamKey(issue.repo, issue.milestone);
    if (!startedKeys.has(key)) continue;
    const numbers = openByKey.get(key);
    if (numbers) numbers.add(issue.number);
    else openByKey.set(key, new Set([issue.number]));
  }

  const admittedByKey = new Map<string, Set<number>>();
  for (const candidate of candidates) {
    if (candidate.milestone === "") continue;
    const key = workStreamKey(candidate.repo, candidate.milestone);
    if (!startedKeys.has(key)) continue;
    const numbers = admittedByKey.get(key);
    if (numbers) numbers.add(candidate.number);
    else admittedByKey.set(key, new Set([candidate.number]));
  }

  for (const [key, open] of openByKey) {
    const admitted = admittedByKey.get(key);
    if (!admitted || admitted.size === 0 || admitted.size !== open.size) {
      continue;
    }
    let extra = false;
    for (const number of admitted) {
      if (!open.has(number)) {
        extra = true;
        break;
      }
    }
    if (extra) continue;
    result.set(key, { remainingViable: admitted.size });
  }
  return result;
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
 * Pick the oldest-restarted conflict-redo candidate in `repo` from `pool`
 * (Issue #3034), or null when none. Used to lift a merge-conflict
 * abandon-and-redo issue to the front of its repo once that repo has
 * already won its tier — it never decides *which* repo wins.
 *
 * @param repo - Repo to search within
 * @param pool - Candidates to search (any tier)
 * @returns The oldest-restarted redo in `repo`, or null
 */
function pickConflictRedo(
  repo: string,
  pool: readonly IssueCandidate[],
): IssueCandidate | null {
  const redos = pool.filter(
    (c) => c.repo === repo && c.conflictRedo !== undefined,
  );
  if (redos.length === 0) return null;

  const sorted = [...redos].sort((a, b) => {
    const diff = Date.parse(a.conflictRedo!.restartedAt) -
      Date.parse(b.conflictRedo!.restartedAt);
    return diff !== 0 ? diff : compareCandidates(a, b);
  });
  return sorted[0] ?? null;
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
    const chosen = sorted[0]!;
    return pickConflictRedo(chosen.repo, candidates) ?? chosen;
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
  const chosen = sameTier.find((c) => c.repo === chosenRepo) ?? sorted[0]!;
  // Issue #3034: once a repo has won the tier, its oldest-restarted
  // merge-conflict redo (if any) is the next pickup ahead of same-repo peers.
  return pickConflictRedo(chosen.repo, candidates) ?? chosen;
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
 *      repo, fair rotation across equal repos when a `randomFn` is injected,
 *      and — Issue #3034 — a merge-conflict redo ahead of same-repo peers);
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
 * Select the candidate from a single label tier, ordering repos by `nice`
 * ascending within it (Issue #1063).
 *
 * `nice` is a tie-breaker inside a priority band: the tier is narrowed to the
 * candidates in its lowest-`nice` repos, and {@link selectFairWithinTier}
 * rotates fairly across those equal repos.
 *
 * `labelIndex` is honoured *ahead of* `nice`: it distinguishes distinct
 * configured discovery labels (and encodes the tier itself — 0..N
 * configured-label, 99 work-on, 150 self-diagnostic, 199 low-priority, 299
 * idle-task), so a second-choice label in a low-`nice` repo must not outrank
 * the first-choice label in a higher-`nice` one.
 *
 * @param candidates - Candidates of a single label tier
 * @param repoNice - Resolver for a repo's `nice` value
 * @param options - Optional randomisation settings
 * @returns Selected candidate, or null if the tier is empty
 */
function selectAcrossNiceTiers(
  candidates: IssueCandidate[],
  repoNice: (repo: string) => number,
  options?: SelectionOptions,
): IssueCandidate | null {
  if (candidates.length === 0) return null;

  // Narrow to the winning label sub-tier, then to the lowest `nice` within
  // it. Both are plain minimums over the candidates — no composite key and
  // nothing to decode back.
  const bestLabelIndex = Math.min(...candidates.map((c) => c.labelIndex));
  const bestLabel = candidates.filter((c) => c.labelIndex === bestLabelIndex);

  const bestNice = Math.min(...bestLabel.map((c) => repoNice(c.repo)));
  const winning = bestLabel.filter((c) => repoNice(c.repo) === bestNice);

  return selectFairWithinTier(winning, options);
}

/**
 * Select the highest priority candidate.
 *
 * Priority rules — the label tier is the **outermost** grouping, applied
 * across the whole fleet (Issue #1063):
 * 1. Configured-label issues (highest priority)
 * 2. Work-on candidates from repos whose configured-label search succeeded
 *    (repos with search failures are excluded — we cannot be sure there
 *    isn't a higher-priority configured-label issue there). Blocked
 *    configured-label issues suppress work-on in the same repo+milestone.
 * 2b. Self-scheduled worker diagnostics (Issue #505) — auto-filed
 *    diagnostics about the worker itself, claimable on provenance rather
 *    than on a label. Chosen only when tiers 1 and 2 produce no selectable
 *    candidate, and always ahead of the backlog.
 * 3. Low-priority candidates (Issue #1725) — only chosen when tiers 1, 2
 *    and 2b produce no selectable candidate across every scanned repo.
 * 4. Idle-task candidates (Issue #1961, #2812) — a *fleet-global* floor,
 *    strictly below every real-work tier in every repo. Only chosen when no
 *    monitored repo has a selectable configured-label / work-on /
 *    low-priority candidate.
 *
 * Issue #1063: within each tier, {@link selectAcrossNiceTiers} orders repos
 * by `nice` ascending — a lower-`nice` repo is drained before a higher-`nice`
 * one *of the same tier*. `nice` no longer wraps the tier ladder (as it did
 * under Issue #2773), because a repo's routine backlog must not outrank
 * another repo's urgency signal.
 *
 * Issue #2812's guarantee is unchanged and now falls out of the tier order
 * directly: `idle-task` is the last tier considered, so it is reached only
 * when no real work is selectable anywhere in any `nice` tier.
 *
 * Issue #1885: when `options.weekPaceEngaged` is set, tiers 3 and 4 are not
 * considered at all this scan — the weekly Claude quota is projected to run
 * out before it resets, so what is left of it goes to `top-priority` and
 * `work-on` work rather than to backlog and busywork.
 *
 * Issue #2009: after tier 1 and before tier 2, leftovers that belong to a
 * started, fleet-viable milestone are lifted into a close-out band. The
 * band only re-orders candidates the existing gates have already admitted;
 * it never outranks `top-priority`, and week-pace still drops tiers 3 and
 * 4 so a low-priority close-out is not claimed while the quota is short.
 *
 * Issue #3034: once the ladder above has picked a repo, a merge-conflict
 * abandon-and-redo candidate in *that* repo (one whose redo has not yet
 * raised a PR) is returned instead of the ladder's own winner, so the redo
 * is the next pickup in its repo ahead of every other candidate there —
 * including `top-priority`. A redo never changes *which* repo wins: it is
 * only consulted after the ladder has committed to one, so it can never
 * displace another repo's candidate. Redo candidates are also exempt from
 * the `reposWithOpenWorkOn` / `reposWithOpenLowPriority` suppression rules
 * above: the suppressor is other pending work in the same repo, and a redo
 * must not wait behind it while its conflict window keeps running — the
 * base keeps moving underneath it. Week-pace still drops low-priority/
 * idle-task redos from consideration exactly as it drops those tiers
 * (Issue #1885).
 *
 * @param result - Selection result with all candidates and metadata
 * @returns Selected candidate, or null if none eligible
 */
export function selectHighestPriority(
  result: SelectionResult,
  options?: SelectionOptions,
): IssueCandidate | null {
  // Default `() => 0` keeps every repo in a single `nice` tier, so callers
  // that supply no resolver are unaffected.
  const repoNice = options?.repoNice ?? (() => 0);

  const labelCandidates = result.labelCandidates;
  const workOnCandidates = result.workOnCandidates;
  // Issue #505: tier 2b — self-scheduled worker diagnostics. Never
  // suppressed by `reposWithOpenWorkOn`: the tier order below already keeps
  // every human-scheduled candidate ahead of them, and the collector runs
  // the same PR/milestone/dependency gates, so the one-PR-per-work-stream
  // guarantee holds without a second suppression rule.
  const selfDiagnosticCandidates = result.selfDiagnosticCandidates ?? [];
  const lowPriorityCandidates = result.lowPriorityCandidates ?? [];
  const idleTaskCandidates = result.idleTaskCandidates ?? [];
  const {
    blockedEntries,
    reposWithOpenWorkOn,
    reposWithOpenLowPriority,
    closeOutMilestones,
  } = result;

  // Issue #2164: a repo with a *suppressing* open work-on issue must not
  // contribute low-priority or idle-task candidates. A repo with an open
  // low-priority issue not waiting on a human (Issue #2751) must not
  // contribute idle-task candidates. The label `low-priority` means
  // "backlog work — picked up only when no other eligible work exists";
  // a repo with a PR-blocked or assigned work-on issue still has "other
  // work" pending and should wait rather than pick backlog.
  //
  // Issue #2610: `reposWithOpenWorkOn` deliberately *excludes* repos
  // whose only open work-on issues are purely dependency-blocked. Such a
  // dependency is frequently a low-priority issue in the same repo, so
  // suppressing it would deadlock the repo. Those repos' low-priority
  // backlog stays eligible here so the dependency chain can be worked.
  //
  // Issue #3034: a conflict-redo candidate is exempt from both suppression
  // rules above. The suppressor here is other pending work in the same
  // repo, and a redo must not wait behind it while its conflict window
  // keeps running — the base keeps moving underneath it.
  const eligibleLowPriority =
    reposWithOpenWorkOn && reposWithOpenWorkOn.size > 0
      ? lowPriorityCandidates.filter((c) =>
        c.conflictRedo !== undefined || !reposWithOpenWorkOn.has(c.repo)
      )
      : lowPriorityCandidates;
  const eligibleIdleTask = (() => {
    let list = idleTaskCandidates;
    if (reposWithOpenWorkOn && reposWithOpenWorkOn.size > 0) {
      list = list.filter((c) =>
        c.conflictRedo !== undefined || !reposWithOpenWorkOn.has(c.repo)
      );
    }
    if (reposWithOpenLowPriority && reposWithOpenLowPriority.size > 0) {
      list = list.filter((c) =>
        c.conflictRedo !== undefined || !reposWithOpenLowPriority.has(c.repo)
      );
    }
    return list;
  })();

  // Priority 2: PR-blocked configured-label issues suppress work-on in the
  // same repo+milestone. Applied before the tier walk so a suppressed work-on
  // cannot hold the tier against a lower tier elsewhere in the fleet. A
  // dependency-blocked one no longer lands here (Issue #2563): its wait is
  // its own, not its stream's.
  const eligibleWorkOn = blockedEntries.length > 0
    ? workOnCandidates.filter((candidate) =>
      !blockedEntries.some(
        (blocked) =>
          blocked.repo === candidate.repo &&
          blocked.milestone === candidate.milestone,
      )
    )
    : workOnCandidates;

  // The fleet-global tier ladder (Issue #1063). Each tier is drained across
  // every repo — ordered by `nice` within the tier — before the next tier is
  // considered, so an urgency label anywhere outranks routine work anywhere.
  //
  //   1  configured-label  →  1b close-out (Issue #2009)
  //   →  2  work-on  →  2b self-diagnostic
  //   →  3  low-priority   →  4  idle-task (fleet-global floor, Issue #2812)
  //
  // Issue #1885: while the weekly Claude quota is projected to run out before
  // its window resets, the last two tiers are dropped from the ladder
  // entirely, so the quota that remains is spent on urgency signals rather
  // than on backlog and busywork. Tiers 1, 2 and 2b are never gated — the
  // point is to redirect the remaining quota, never to stop working.
  const weekPaceEngaged = options?.weekPaceEngaged === true;

  // The ladder itself, unchanged from before Issue #3034 (extracted so the
  // conflict-redo lift below can be applied once to whichever tier wins).
  const selectFromTierLadder = (): IssueCandidate | null => {
    const selectedLabel = selectAcrossNiceTiers(
      labelCandidates,
      repoNice,
      options,
    );
    if (selectedLabel) return selectedLabel;

    // Issue #2009: finish a started, fleet-viable milestone before opening
    // another. Drawn from the raw lower-tier lists so a same-repo unstarted
    // work-on (the #2164 suppressor) cannot hide the leftover that would
    // close the started stream. `nice` does not apply — close-out is a
    // band of its own, not a within-tier tie-break.
    const closeOutSelected = selectCloseOutCandidate(
      [
        ...eligibleWorkOn,
        ...selfDiagnosticCandidates,
        ...(weekPaceEngaged ? [] : lowPriorityCandidates),
        ...(weekPaceEngaged ? [] : idleTaskCandidates),
      ],
      closeOutMilestones,
    );
    if (closeOutSelected) return closeOutSelected;

    const tiers: IssueCandidate[][] = [
      eligibleWorkOn,
      selfDiagnosticCandidates,
      ...(weekPaceEngaged ? [] : [eligibleLowPriority, eligibleIdleTask]),
    ];

    for (const tier of tiers) {
      const selected = selectAcrossNiceTiers(tier, repoNice, options);
      if (selected) return selected;
    }
    return null;
  };

  const winner = selectFromTierLadder();
  if (!winner) return null;

  // Issue #3034: once the ladder has chosen a repo, that repo's
  // oldest-restarted merge-conflict redo (if any) is the next pickup —
  // ahead of every other candidate in the repo, including the winner
  // itself. It never displaces another repo's winner, and week-pace
  // deliberately excludes low-priority/idle-task redos from the pool here
  // (Issue #1885) by omitting those lists when engaged.
  const redoPool = [
    ...labelCandidates,
    ...eligibleWorkOn,
    ...selfDiagnosticCandidates,
    ...(weekPaceEngaged ? [] : eligibleLowPriority),
    ...(weekPaceEngaged ? [] : eligibleIdleTask),
  ];
  return pickConflictRedo(winner.repo, redoPool) ?? winner;
}

/**
 * Pick the leftover that finishes the closest started milestone
 * (Issue #2009).
 *
 * Order: fewest remaining viable issues, then in-milestone
 * `priority-high` / `priority-low`, then oldest. `nice` and
 * `randomFn` are deliberately ignored — rotating away from the
 * milestone that is about to close would recreate the drift this
 * band exists to prevent.
 */
function selectCloseOutCandidate(
  candidates: readonly IssueCandidate[],
  closeOutMilestones: ReadonlyMap<string, MilestoneCloseOut> | undefined,
): IssueCandidate | null {
  if (!closeOutMilestones || closeOutMilestones.size === 0) return null;

  const closeOut = candidates.filter((candidate) =>
    candidate.milestone !== "" &&
    closeOutMilestones.has(workStreamKey(candidate.repo, candidate.milestone))
  );
  if (closeOut.length === 0) return null;

  const normal = MILESTONE_PRIORITY_VALUES.normal;
  const sorted = [...closeOut].sort((a, b) => {
    const remainingA = closeOutMilestones.get(
      workStreamKey(a.repo, a.milestone),
    )?.remainingViable ?? Number.POSITIVE_INFINITY;
    const remainingB = closeOutMilestones.get(
      workStreamKey(b.repo, b.milestone),
    )?.remainingViable ?? Number.POSITIVE_INFINITY;
    if (remainingA !== remainingB) return remainingA - remainingB;
    if (
      a.milestone !== "" &&
      a.milestone === b.milestone &&
      (a.milestonePriority ?? normal) !== (b.milestonePriority ?? normal)
    ) {
      return (a.milestonePriority ?? normal) - (b.milestonePriority ?? normal);
    }
    return a.createdAt.localeCompare(b.createdAt);
  });
  return sorted[0] ?? null;
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
