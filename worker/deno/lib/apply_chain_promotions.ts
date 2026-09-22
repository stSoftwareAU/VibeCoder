/**
 * Discovery-side wiring for dependency-chain promotion (Issue #2495).
 *
 * The pure resolver (`dependency_chain_promotion.ts`, Issue #2493) decides
 * *which* chain members should be worked now. This module is the seam
 * between that decision and `findOldestIssue`: it builds the resolver's
 * snapshot from the open-issue lists discovery has already fetched, then
 * moves each promoted candidate out of its own tier and into the tier of
 * the blocked issue waiting on it.
 *
 * A promoted candidate is otherwise untouched — same repo, same labels,
 * same `source`, so `nice` and the scan log still describe the issue as it
 * actually is. Only its rank changes. The worker cannot apply
 * `top-priority` itself (label security strips it), so the promotion lives
 * in memory for the length of one scan.
 *
 * Like the resolver, this module performs no I/O.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import {
  type BlockedCandidate,
  chainIssueKey,
  type ChainIssueRef,
  type ChainSnapshotIssue,
  type FleetWorkingRoot,
  resolveChainPromotions,
  type UnworkableChainRoot,
} from "./dependency_chain_promotion.ts";
import type { DependencyBlocker } from "./issue_dependencies.ts";
import { extractDependencyReferencesDetailed } from "./issue_dependencies.ts";
import type { FilterableIssue } from "./issue_filter.ts";
import type { IssueCandidate } from "./issue_priority.ts";

/** The candidate lists promotion can move a candidate between. */
export interface ChainPromotionTiers {
  /** Tier 1 — configured-label candidates. */
  labelCandidates: IssueCandidate[];
  /** Tier 2 — work-on candidates. */
  workOnCandidates: IssueCandidate[];
  /** Tier 3 — low-priority candidates. */
  lowPriorityCandidates: IssueCandidate[];
  /** Tier 4 — idle-task candidates. */
  idleTaskCandidates: IssueCandidate[];
}

/** Everything the resolver needs, in the shapes discovery already holds. */
export interface ChainPromotionRequest {
  /** Dependency-blocked configured-label / work-on candidates. */
  blocked: BlockedCandidate[];
  /** Open issues per repo, keyed as `config.repos` spells the repo. */
  issuesByRepo: ReadonlyMap<string, FilterableIssue[]>;
  /** Repositories the fleet monitors, in `owner/repo` form. */
  monitoredRepos: readonly string[];
  /** Labels that make an issue discoverable. */
  discoveryLabels: readonly string[];
  /** Label marking an issue as awaiting a human. */
  needsHumanLabel: string;
  /** Logins belonging to the fleet itself. */
  fleetAuthors: readonly string[];
}

/** One candidate that changed tier, and the blocked issue that lifted it. */
export interface ChainPromotion {
  /** The candidate, carrying its new `promotedBy`. */
  candidate: IssueCandidate;
  /** The dependency-blocked issue whose chain it sits on. */
  promotedBy: ChainIssueRef;
}

/** The tiers after promotion, plus what the resolver found along the way. */
export interface ChainPromotionOutcome extends ChainPromotionTiers {
  /** One entry per candidate actually moved; empty when nothing moved. */
  promotions: ChainPromotion[];
  /** Chain roots the fleet is already working. */
  fleetWorking: FleetWorkingRoot[];
  /** Chain roots nobody can move. */
  unworkableRoots: UnworkableChainRoot[];
}

function normalise(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Build the resolver's issue snapshot from the open-issue lists.
 *
 * A snapshot's `blockers` are the issue's own open `Depends on` references
 * (`extractDependencyReferencesDetailed`). A reference whose target is
 * absent from its repo's open list is already closed and is dropped; a
 * reference into a repo the scan holds no list for is *kept*, because a
 * dependency nobody could read must never be assumed closed.
 */
function buildSnapshots(
  issuesByRepo: ReadonlyMap<string, FilterableIssue[]>,
  canonicalRepo: (repo: string) => string,
): Map<string, ChainSnapshotIssue> {
  const openByRepo = new Map<string, Set<number>>();
  for (const [repo, issues] of issuesByRepo) {
    openByRepo.set(normalise(repo), new Set(issues.map((i) => i.number)));
  }

  const snapshots = new Map<string, ChainSnapshotIssue>();
  for (const [repo, issues] of issuesByRepo) {
    for (const issue of issues) {
      const blockers: DependencyBlocker[] = [];
      for (const dep of extractDependencyReferencesDetailed(issue.body ?? "")) {
        const depRepo = canonicalRepo(dep.repo ?? repo);
        const open = openByRepo.get(normalise(depRepo));
        if (open && !open.has(dep.number)) continue;
        blockers.push({
          repo: depRepo,
          number: dep.number,
          kind: "depends-on",
        });
      }
      snapshots.set(chainIssueKey(repo, issue.number), {
        repo,
        number: issue.number,
        labels: issue.labels,
        assignees: issue.assignees,
        blockers,
      });
    }
  }
  return snapshots;
}

/** Remove and return the candidate for `ref`, or `undefined` if absent. */
function takeCandidate(
  lists: IssueCandidate[][],
  ref: ChainIssueRef,
): IssueCandidate | undefined {
  const key = normalise(ref.repo);
  for (const list of lists) {
    const index = list.findIndex(
      (c) => c.number === ref.number && normalise(c.repo) === key,
    );
    if (index >= 0) return list.splice(index, 1)[0];
  }
  return undefined;
}

/**
 * Promote the workable dependencies of every dependency-blocked candidate
 * into the blocked candidate's own tier.
 *
 * The tier ladder itself is untouched: a promoted candidate simply appears
 * in a higher list, so lower tiers keep running exactly as before when
 * nothing is promoted. A promoted issue that is not a candidate at any tier
 * — unlabelled, assigned, or filtered out by an earlier gate — is left
 * alone; promotion changes rank, never eligibility.
 *
 * @param tiers - The candidate lists, after every local gate has run.
 * @param request - The blocked candidates and the open-issue snapshot.
 * @returns The tiers after promotion, with the resolver's findings.
 */
export function applyChainPromotions(
  tiers: ChainPromotionTiers,
  request: ChainPromotionRequest,
): ChainPromotionOutcome {
  const labelCandidates = [...tiers.labelCandidates];
  const workOnCandidates = [...tiers.workOnCandidates];
  const lowPriorityCandidates = [...tiers.lowPriorityCandidates];
  const idleTaskCandidates = [...tiers.idleTaskCandidates];
  const empty: ChainPromotionOutcome = {
    labelCandidates,
    workOnCandidates,
    lowPriorityCandidates,
    idleTaskCandidates,
    promotions: [],
    fleetWorking: [],
    unworkableRoots: [],
  };
  // Nothing is blocked, so nothing can be promoted — skip the snapshot
  // build entirely, which is the common case on every healthy scan.
  if (request.blocked.length === 0) return empty;

  // GitHub renders the same repo as `Owner/Repo` or `owner/repo`, and the
  // resolver keys its snapshot map on the string it is handed. Canonicalise
  // every repo to the monitored spelling so a differently-cased body
  // reference cannot silently miss the snapshot it names.
  const monitoredByKey = new Map(
    request.monitoredRepos.map((repo) => [normalise(repo), repo]),
  );
  const canonicalRepo = (repo: string): string =>
    monitoredByKey.get(normalise(repo)) ?? repo;

  const resolved = resolveChainPromotions({
    blocked: request.blocked.map((b) => ({
      ...b,
      repo: canonicalRepo(b.repo),
      blockers: b.blockers.map((d) => ({ ...d, repo: canonicalRepo(d.repo) })),
    })),
    issues: buildSnapshots(request.issuesByRepo, canonicalRepo),
    monitoredRepos: new Set(request.monitoredRepos),
    discoveryLabels: [...request.discoveryLabels],
    needsHumanLabel: request.needsHumanLabel,
    fleetAuthors: [...request.fleetAuthors],
  });

  const promotions: ChainPromotion[] = [];
  for (const member of resolved.promoted) {
    const destination = member.tier === "configured-label"
      ? labelCandidates
      : workOnCandidates;
    // The destination is never a source: a candidate already at the target
    // tier has nothing to gain from being moved into it.
    const sources = member.tier === "configured-label"
      ? [workOnCandidates, lowPriorityCandidates, idleTaskCandidates]
      : [lowPriorityCandidates, idleTaskCandidates];
    const candidate = takeCandidate(sources, member);
    if (candidate === undefined) continue;
    const promoted: IssueCandidate = {
      ...candidate,
      promotedBy: { ...member.promotedBy },
    };
    destination.push(promoted);
    promotions.push({ candidate: promoted, promotedBy: member.promotedBy });
  }

  return {
    labelCandidates,
    workOnCandidates,
    lowPriorityCandidates,
    idleTaskCandidates,
    promotions,
    fleetWorking: resolved.fleetWorking,
    unworkableRoots: resolved.unworkableRoots,
  };
}
