/**
 * Pure dependency-chain promotion resolver (Issue #2493).
 *
 * When every `top-priority`/`work-on` candidate is dependency-blocked the
 * fleet currently falls through to a lower tier and works something the
 * humans did not ask for. The fix is to work the *chain* behind the blocked
 * issue at the blocked issue's own tier.
 *
 * This module is the decision core for that behaviour: given a snapshot of
 * the blocked candidates and the issues behind them, it decides which chain
 * members should be worked now and which chain roots the fleet cannot work
 * at all. Discovery wiring, logging and commenting live in the callers
 * (Issues #2494–#2496), never here — the resolver performs no I/O so it can
 * be reasoned about and tested as a pure function.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type { DependencyBlocker } from "./issue_dependencies.ts";
import { isFleetAuthor } from "./fleet_authors.ts";

/** Tier a blocked candidate was discovered at, and inherited by its chain. */
export type PromotionTier = "configured-label" | "work-on";

/** Why a chain root cannot be worked by the fleet. */
export type ChainRootReason =
  | "assigned"
  | "no-discovery-label"
  | "needs-human"
  | "cross-repo-unmonitored";

/** Identifies an issue across repositories. */
export interface ChainIssueRef {
  /** Repository in `owner/repo` form. */
  repo: string;
  /** Issue number. */
  number: number;
}

/** The slice of an issue the resolver needs to classify it. */
export interface ChainSnapshotIssue extends ChainIssueRef {
  /** Labels currently on the issue. */
  labels: string[];
  /** Logins currently assigned to the issue. */
  assignees: string[];
  /** Dependencies that still block the issue; empty means it is a root. */
  blockers: DependencyBlocker[];
}

/** A dependency-blocked candidate whose chain should be walked. */
export interface BlockedCandidate extends ChainIssueRef {
  /** Tier the candidate was discovered at; inherited by promoted members. */
  tier: PromotionTier;
  /** Dependencies blocking the candidate — the head of the chain. */
  blockers: DependencyBlocker[];
}

/** Everything the resolver needs; all of it already fetched by the caller. */
export interface ChainPromotionInput {
  /** Dependency-blocked candidates, highest tier first or in any order. */
  blocked: BlockedCandidate[];
  /** Snapshots of every chain member, keyed by {@link chainIssueKey}. */
  issues: Map<string, ChainSnapshotIssue>;
  /** Repositories the fleet monitors, in `owner/repo` form; matched case-insensitively. */
  monitoredRepos: Set<string>;
  /** Labels that make an issue discoverable (e.g. `bug`, `enhancement`). */
  discoveryLabels: string[];
  /** Label marking an issue as awaiting a human. */
  needsHumanLabel: string;
  /** Logins belonging to the fleet itself. */
  fleetAuthors: string[];
}

/** A chain member the fleet should work now, at the blocked issue's tier. */
export interface PromotedChainMember extends ChainIssueRef {
  /** Tier inherited from the blocked candidate that reached it. */
  tier: PromotionTier;
  /** The blocked candidate whose chain this member sits on. */
  promotedBy: ChainIssueRef;
}

/** A chain root the fleet is already working. */
export interface FleetWorkingRoot {
  /** The blocked candidate whose chain reached this root. */
  blocked: ChainIssueRef;
  /** The root itself. */
  root: ChainIssueRef;
  /** The fleet login assigned to the root, as written on the issue. */
  assignee: string;
}

/** A chain root the fleet cannot work. */
export interface UnworkableChainRoot {
  /** The blocked candidate whose chain reached this root. */
  blocked: ChainIssueRef;
  /** The root itself. */
  root: ChainIssueRef;
  /** Why the root is unworkable. */
  reason: ChainRootReason;
  /** The value that triggered the classification (login, repo, labels). */
  detail: string;
}

/** The resolver's verdict for one pass over the blocked candidates. */
export interface ChainPromotionResult {
  /** Chain members to work now, each emitted once at its highest tier. */
  promoted: PromotedChainMember[];
  /** Roots the fleet already has in hand — no action, no report. */
  fleetWorking: FleetWorkingRoot[];
  /** Roots nobody can move, one entry per blocked candidate that reached one. */
  unworkableRoots: UnworkableChainRoot[];
}

/**
 * Key for {@link ChainPromotionInput.issues}: `owner/repo#N`.
 *
 * Exported so callers build the snapshot map the same way the resolver reads
 * it — a mismatched key silently reads as an unknown root.
 */
export function chainIssueKey(repo: string, issueNumber: number): string {
  return `${repo}#${issueNumber}`;
}

/** Higher wins when two blocked candidates share a chain member. */
function tierRank(tier: PromotionTier): number {
  return tier === "configured-label" ? 1 : 0;
}

function normalise(value: string): string {
  return value.trim().toLowerCase();
}

function ref(repo: string, issueNumber: number): ChainIssueRef {
  return { repo, number: issueNumber };
}

/**
 * Walk the dependency chain behind each blocked candidate and decide what the
 * fleet should do about it.
 *
 * Each chain is walked breadth-first with a visited set seeded with the
 * blocked candidate itself, so a cycle terminates and promotes nothing on the
 * cycle (cycle *reporting* remains Issue #2752's job). A member that is
 * itself still blocked is walked *through* — never promoted, never classified
 * — and the walk continues to its own blockers until it reaches roots.
 *
 * Roots are classified in a fixed order: unmonitored repo, `needs-human`,
 * fleet assignee, other assignee, missing discovery label, otherwise promoted.
 * A blocker with no snapshot is skipped rather than classified — the caller
 * could not read it, and a partial view must not become a confident verdict.
 */
export function resolveChainPromotions(
  input: ChainPromotionInput,
): ChainPromotionResult {
  const discovery = new Set(input.discoveryLabels.map(normalise));
  const needsHuman = normalise(input.needsHumanLabel);
  // GitHub renders the same repo as `Owner/Repo` or `owner/repo`; a casing
  // mismatch here would report a monitored repo as unreachable and silently
  // drop its whole subtree, so match it the way every other string is matched.
  const monitored = new Set([...input.monitoredRepos].map(normalise));

  const promoted = new Map<string, PromotedChainMember>();
  const fleetWorking: FleetWorkingRoot[] = [];
  const unworkableRoots: UnworkableChainRoot[] = [];

  for (const blocked of input.blocked) {
    const blockedRef = ref(blocked.repo, blocked.number);
    const visited = new Set<string>([
      chainIssueKey(blocked.repo, blocked.number),
    ]);
    const queue: DependencyBlocker[] = [...blocked.blockers];

    // Index cursor rather than `shift()` so the walk stays O(n) on long chains.
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const next = queue[cursor];
      if (next === undefined) continue;
      const key = chainIssueKey(next.repo, next.number);
      if (visited.has(key)) continue;
      visited.add(key);

      const rootRef = ref(next.repo, next.number);

      // A blocker the fleet does not monitor cannot be worked or walked past.
      if (!monitored.has(normalise(next.repo))) {
        unworkableRoots.push({
          blocked: blockedRef,
          root: rootRef,
          reason: "cross-repo-unmonitored",
          detail: next.repo,
        });
        continue;
      }

      // No snapshot means the caller could not read it; stay silent.
      const snapshot = input.issues.get(key);
      if (!snapshot) continue;

      // Still blocked: walk through it, but never promote or classify it.
      if (snapshot.blockers.length > 0) {
        queue.push(...snapshot.blockers);
        continue;
      }

      const labels = snapshot.labels.map(normalise);

      if (labels.includes(needsHuman)) {
        unworkableRoots.push({
          blocked: blockedRef,
          root: rootRef,
          reason: "needs-human",
          detail: input.needsHumanLabel,
        });
        continue;
      }

      const fleetAssignee = snapshot.assignees.find((a) =>
        isFleetAuthor(a, input.fleetAuthors)
      );
      if (fleetAssignee !== undefined) {
        // The fleet already has it — nothing to promote and nothing to report.
        fleetWorking.push({
          blocked: blockedRef,
          root: rootRef,
          assignee: fleetAssignee,
        });
        continue;
      }

      const humanAssignee = snapshot.assignees[0];
      if (humanAssignee !== undefined) {
        unworkableRoots.push({
          blocked: blockedRef,
          root: rootRef,
          reason: "assigned",
          detail: humanAssignee,
        });
        continue;
      }

      if (!labels.some((label) => discovery.has(label))) {
        unworkableRoots.push({
          blocked: blockedRef,
          root: rootRef,
          reason: "no-discovery-label",
          detail: snapshot.labels.join(", "),
        });
        continue;
      }

      const existing = promoted.get(key);
      if (existing && tierRank(existing.tier) >= tierRank(blocked.tier)) {
        continue;
      }
      promoted.set(key, {
        repo: next.repo,
        number: next.number,
        tier: blocked.tier,
        promotedBy: blockedRef,
      });
    }
  }

  return { promoted: [...promoted.values()], fleetWorking, unworkableRoots };
}
