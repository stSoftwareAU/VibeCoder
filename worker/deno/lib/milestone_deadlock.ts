/**
 * Pure detector for cross-milestone dependency deadlocks (Issue #2829).
 *
 * The Issue #2173 hold in `isDependencyBlocked` keeps an open issue H waiting
 * while a closed dependency D sits in a *different*, still-open milestone B.
 * When some open issue in B depends on H — directly or through a chain — B
 * cannot close until H lands, and H cannot land until B closes: neither
 * milestone ever finishes.
 *
 * ```mermaid
 * flowchart LR
 *   H["held H (milestone A)"] -- depends on --> D["closed D (milestone B)"]
 *   I["open I (milestone B)"] -- depends on, transitively --> H
 *   D -. B stays open until I lands .-> I
 * ```
 *
 * This module derives the held set from issue data alone and reports at most
 * one deadlock per blocked milestone. No I/O.
 */

/** An open issue and the issue numbers it depends on. */
export interface DeadlockOpenIssue {
  number: number;
  /** Milestone title, or `null` when the issue has none. */
  milestone: string | null;
  dependsOn: readonly number[];
}

/** A closed issue that some open issue depends on. */
export interface DeadlockClosedDependency {
  number: number;
  /** Milestone title, or `null` when the issue has none. */
  milestone: string | null;
}

/** The issue data the detector reads. */
export interface MilestoneDependencyGraph {
  openIssues: readonly DeadlockOpenIssue[];
  closedDependencies: readonly DeadlockClosedDependency[];
  /** Titles of the repository's open milestones. */
  openMilestones: ReadonlySet<string>;
}

/** One deadlocked milestone. */
export interface MilestoneDeadlock {
  /** The still-open milestone whose closed issue holds `heldIssue`. */
  milestone: string;
  /** The open issue held by the cross-milestone hold. */
  heldIssue: number;
  /** The closed dependency in `milestone` that holds `heldIssue`. */
  closedDependency: number;
  /** Open issues in `milestone` that depend on `heldIssue`, ascending. */
  blockingOpenIssues: number[];
}

interface HeldPair {
  heldIssue: number;
  closedDependency: number;
  milestone: string;
}

/**
 * Find every milestone deadlocked by the cross-milestone dependency hold.
 *
 * Results are sorted by milestone title; when several held issues deadlock
 * the same milestone, the lowest held issue (then lowest dependency) is named.
 */
export function detectMilestoneDeadlocks(
  graph: MilestoneDependencyGraph,
): MilestoneDeadlock[] {
  const dependants = buildDependantIndex(graph.openIssues);
  const milestoneOf = new Map<number, string | null>(
    graph.openIssues.map((issue) => [issue.number, issue.milestone]),
  );

  const results = new Map<string, MilestoneDeadlock>();
  for (const pair of findHeldPairs(graph)) {
    if (results.has(pair.milestone)) continue;
    const blocking = [...collectDependants(pair.heldIssue, dependants)]
      .filter((n) => milestoneOf.get(n) === pair.milestone)
      .sort((a, b) => a - b);
    if (blocking.length === 0) continue;
    results.set(pair.milestone, { ...pair, blockingOpenIssues: blocking });
  }
  return [...results.values()].sort((a, b) =>
    a.milestone < b.milestone ? -1 : a.milestone > b.milestone ? 1 : 0
  );
}

/**
 * Held pairs, mirroring the Issue #2173 hold: a closed dependency carrying a
 * milestone that differs from the dependant's (`""` when it has none) and is
 * still open. Sorted so the per-milestone pick is deterministic.
 */
function findHeldPairs(graph: MilestoneDependencyGraph): HeldPair[] {
  const closedMilestone = new Map<number, string | null>(
    graph.closedDependencies.map((dep) => [dep.number, dep.milestone]),
  );
  const pairs: HeldPair[] = [];
  for (const issue of graph.openIssues) {
    for (const dep of new Set(issue.dependsOn)) {
      const milestone = closedMilestone.get(dep);
      if (
        milestone && milestone !== (issue.milestone ?? "") &&
        graph.openMilestones.has(milestone)
      ) {
        pairs.push({
          heldIssue: issue.number,
          closedDependency: dep,
          milestone,
        });
      }
    }
  }
  return pairs.sort((a, b) =>
    a.heldIssue - b.heldIssue || a.closedDependency - b.closedDependency
  );
}

/** Map each issue number to the open issues that directly depend on it. */
function buildDependantIndex(
  openIssues: readonly DeadlockOpenIssue[],
): Map<number, number[]> {
  const index = new Map<number, number[]>();
  for (const issue of openIssues) {
    for (const dep of issue.dependsOn) {
      const list = index.get(dep) ?? [];
      list.push(issue.number);
      index.set(dep, list);
    }
  }
  return index;
}

/** Every open issue that depends on `root`, directly or transitively.
 * The visited set makes a dependency cycle terminate; `root` is excluded. */
function collectDependants(
  root: number,
  dependants: Map<number, number[]>,
): Set<number> {
  const visited = new Set<number>([root]);
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop() as number;
    for (const next of dependants.get(current) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      stack.push(next);
    }
  }
  visited.delete(root);
  return visited;
}
