/**
 * Issue dependency resolution for parent/child relationships (Issue #484).
 *
 * This module provides TypeScript logic for detecting and resolving issue
 * dependencies, particularly ensuring parent issues are not worked on
 * before their child (sub) issues are completed.
 *
 * Key concepts:
 * - A "parent" issue is one that has sub-issues (children) listed via
 *   GitHub's task list syntax or sub-issues API.
 * - A parent issue should be blocked until all its children are closed.
 * - Forward dependencies ("Depends on #N") are handled by the existing
 *   dependency_checker.sh — this module focuses on reverse/parent-child
 *   relationships.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type { Result } from "../types.ts";

/**
 * Represents the state of a GitHub issue for dependency checking.
 */
export interface IssueState {
  number: number;
  state: "OPEN" | "CLOSED";
  title?: string;
}

/**
 * Normalise a raw GitHub `state` string into the binary OPEN/CLOSED used
 * for dependency and blocking checks.
 *
 * Only a literal `OPEN` (case-insensitive) counts as open. Every other value —
 * `CLOSED`, and crucially a pull request's `MERGED` — resolves to CLOSED.
 * A dependency reference can point at a PR number because issues and pull
 * requests share a single numbering space, and a merged PR is *satisfied*, not
 * outstanding. The previous `state === "CLOSED" ? "CLOSED" : "OPEN"` shape
 * mapped `MERGED` to OPEN, so a reference to a merged PR blocked the dependent
 * issue forever (Issue #3218, the #3204 wedge).
 *
 * @param raw - The raw `state` value from `gh issue view --json state`.
 * @returns `"OPEN"` only when the issue/PR is genuinely open, else `"CLOSED"`.
 */
export function normaliseIssueState(raw: string): "OPEN" | "CLOSED" {
  return raw.trim().toUpperCase() === "OPEN" ? "OPEN" : "CLOSED";
}

/**
 * Remove Markdown code spans (fenced blocks and inline code) from an issue
 * body before it is scanned for issue references.
 *
 * The dependency and sub-issue extractors look for phrases such as
 * `depends on #N`, `blocked by #N`, or `- [ ] #N`. When such a phrase appears
 * inside a *code example* — for instance the suggested-fix snippet a
 * scan-finding issue embeds — it is documentation, not a real relationship,
 * and must be ignored. VibeCoder#3204's fix example contained
 * `reasons: ["depends on #5"]`, which was otherwise parsed as a dependency on
 * #5 and blocked the issue forever (Issue #3218).
 *
 * Fenced blocks opened by a line beginning with three or more backticks or
 * tildes (optionally indented, with an optional info string) are dropped
 * through to the matching closing fence — or to the end of the body when the
 * fence is never closed (fail safe: never leak references out of a broken
 * block). Inline `` `code` `` spans on ordinary lines are stripped too.
 * Surrounding prose is preserved verbatim.
 *
 * @param body - The raw issue body text.
 * @returns The body with all code spans removed.
 */
export function stripCodeSpans(body: string): string {
  if (!body) return body;
  const out: string[] = [];
  // The fence character (`` ` `` or `~`) that opened the current block, or
  // null when not inside a fenced block.
  let fenceChar: string | null = null;
  for (const line of body.split("\n")) {
    const fenceMatch = line.trimStart().match(/^(`{3,}|~{3,})/);
    if (fenceChar === null) {
      if (fenceMatch) {
        // Opening fence — enter the block and drop the fence line itself.
        fenceChar = fenceMatch[1]![0]!;
        continue;
      }
      // Ordinary prose line — strip any inline code spans.
      out.push(line.replace(/`[^`\n]*`/g, ""));
    } else if (fenceMatch && fenceMatch[1]![0] === fenceChar) {
      // Closing fence of the same kind — leave the block, drop the fence line.
      fenceChar = null;
    }
    // Lines inside a fenced block are dropped entirely.
  }
  return out.join("\n");
}

/**
 * Result of checking whether a parent issue is blocked by open children.
 */
export interface ParentBlockedResult {
  isBlocked: boolean;
  openChildren: number[];
  closedChildren: number[];
  totalChildren: number;
}

/**
 * Dependency graph node for topological ordering.
 */
export interface DependencyNode {
  issueNumber: number;
  dependsOn: number[];
  childOf?: number;
  state: "OPEN" | "CLOSED";
}

/**
 * Result of resolving the work order for a set of issues.
 */
export interface WorkOrderResult {
  /** Issues ready to be worked on (no unmet dependencies) */
  ready: number[];
  /** Issues blocked by dependencies or open children */
  blocked: Array<{ issue: number; blockedBy: number[] }>;
  /** Issues that have circular dependencies (should not happen but handled) */
  circular: number[];
}

/**
 * Interface for fetching issue data — injectable for testing.
 */
export interface IssueFetcher {
  /** Get the state of an issue */
  getIssueState(repo: string, issueNumber: number): Promise<IssueState>;
  /** Get sub-issue numbers for a given issue */
  getSubIssues(repo: string, issueNumber: number): Promise<number[]>;
  /** Get the issue body text */
  getIssueBody(repo: string, issueNumber: number): Promise<string>;
}

/**
 * Extract sub-issue references from an issue body.
 *
 * Detects GitHub task list items that reference issues:
 * - `- [ ] #123` (unchecked task)
 * - `- [x] #123` (checked task)
 * - `- [ ] https://github.com/owner/repo/issues/123`
 *
 * @param body - The issue body text
 * @param repo - Optional repo in "owner/repo" format for URL matching
 * @returns Array of referenced issue numbers
 */
export function extractSubIssueReferences(
  body: string,
  repo?: string,
): number[] {
  if (!body) return [];

  // Issue #3218: ignore task-list / reference syntax quoted inside code
  // examples — an embedded snippet is documentation, not a sub-issue link.
  const scan = stripCodeSpans(body);

  const issueNumbers: Set<number> = new Set();

  // Match task list items with issue references: - [ ] #123 or - [x] #123
  const taskListPattern = /^-\s*\[[ xX]\]\s*#(\d+)/gm;
  let match: RegExpExecArray | null;
  while ((match = taskListPattern.exec(scan)) !== null) {
    const num = parseInt(match[1]!, 10);
    if (!isNaN(num)) {
      issueNumbers.add(num);
    }
  }

  // Match task list items with full GitHub URLs
  if (repo) {
    const escapedRepo = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const urlPattern = new RegExp(
      `^-\\s*\\[[ xX]\\]\\s*https://github\\.com/${escapedRepo}/issues/(\\d+)`,
      "gm",
    );
    while ((match = urlPattern.exec(scan)) !== null) {
      const num = parseInt(match[1]!, 10);
      if (!isNaN(num)) {
        issueNumbers.add(num);
      }
    }
  }

  // Also match "Sub-issues" section with plain #N references (common in parent issues)
  // Look for patterns like "Parent of #N" or "Sub-issue: #N"
  const parentOfPattern = /parent\s+of\s+#(\d+)/gi;
  while ((match = parentOfPattern.exec(scan)) !== null) {
    const num = parseInt(match[1]!, 10);
    if (!isNaN(num)) {
      issueNumbers.add(num);
    }
  }

  return [...issueNumbers].sort((a, b) => a - b);
}

/**
 * Check if an issue body contains a back-reference to a parent issue.
 *
 * Detects patterns like "Part of #123" or "Child of #123" that confirm the
 * issue is a genuine sub-issue of the parent. Without this, a task list item
 * like `- [ ] #747 body updated` would be wrongly treated as a blocking
 * sub-issue (see FLEET#1472).
 *
 * @param body - The child issue body text
 * @param parentNumber - The parent issue number to look for
 * @returns true if the body references the parent
 */
export function hasBackReference(body: string, parentNumber: number): boolean {
  if (!body) return false;
  const pattern = new RegExp(
    `(?:part\\s+of|child\\s+of)\\s+#${parentNumber}\\b`,
    "i",
  );
  return pattern.test(body);
}

/**
 * Extract forward dependency references from an issue body.
 *
 * Detects patterns like:
 * - "Depends on #123"
 * - "Blocked by #123"
 * - "Depends on owner/repo#123" (cross-repo, returns just the number)
 *
 * @param body - The issue body text
 * @returns Array of dependency issue numbers (same-repo only)
 */
export function extractDependencyReferences(body: string): number[] {
  if (!body) return [];

  // Issue #3218: ignore dependency phrases quoted inside code examples — a
  // scan-finding's suggested-fix snippet is documentation, not a dependency.
  const scan = stripCodeSpans(body);

  const issueNumbers: Set<number> = new Set();

  // Match "depends on #N" or "blocked by #N" (case-insensitive)
  const depPattern = /(?:depends\s+on|blocked\s+by)\s+#(\d+)/gi;
  let match: RegExpExecArray | null;
  while ((match = depPattern.exec(scan)) !== null) {
    const num = parseInt(match[1]!, 10);
    if (!isNaN(num)) {
      issueNumbers.add(num);
    }
  }

  return [...issueNumbers].sort((a, b) => a - b);
}

/**
 * Optional pre-built lookup of currently-open issue numbers for a
 * single repository (Issue #1808).
 *
 * When a caller already holds the cached `fetchAllIssues` result for
 * the repo, it can derive this map once and pass it to
 * `checkParentBlocked` so per-child `getIssueState` calls collapse to
 * local map reads. Issue numbers absent from the map are looked up
 * via the regular per-issue fallback.
 */
export type OpenIssueStateMap = Map<number, "OPEN">;

/**
 * Check whether a parent issue is blocked by open child issues.
 *
 * A parent issue is blocked if it has sub-issues and any of them are still open.
 * This implements the core requirement of Issue #484: parent issues should not
 * be worked on before child issues are completed.
 *
 * @param fetcher - Injectable issue data fetcher
 * @param repo - Repository in "owner/repo" format
 * @param issueNumber - The issue number to check
 * @param openStateMap - Optional cached open-state map (Issue #1808).
 *   When supplied, child issues present in the map are resolved
 *   without a per-issue `getIssueState` call. Children absent from
 *   the map fall back to the fetcher (closed / not-yet-loaded path).
 * @returns Result containing blocked status and details
 */
export async function checkParentBlocked(
  fetcher: IssueFetcher,
  repo: string,
  issueNumber: number,
  openStateMap?: OpenIssueStateMap,
): Promise<Result<ParentBlockedResult>> {
  try {
    // Get sub-issues for this issue
    const subIssueNumbers = await fetcher.getSubIssues(repo, issueNumber);

    // Also check the issue body for task list references, but only include
    // those where the referenced issue links back (e.g. "Part of #parent").
    // Without this bi-directional check, plain checklist items like
    // "- [ ] #747 body updated" are wrongly treated as blocking sub-issues
    // (see FLEET#1472).
    const childSet = new Set(subIssueNumbers);

    try {
      const body = await fetcher.getIssueBody(repo, issueNumber);
      const bodyRefs = extractSubIssueReferences(body, repo);
      for (const ref of bodyRefs) {
        if (childSet.has(ref)) continue; // Already confirmed via API
        try {
          const refBody = await fetcher.getIssueBody(repo, ref);
          if (hasBackReference(refBody, issueNumber)) {
            childSet.add(ref);
          }
        } catch {
          // Can't verify back-reference — do NOT assume it's a child
        }
      }
    } catch {
      // If we can't get the body, continue with just sub-issues from API
    }

    const allChildNumbers = [...childSet];

    // No children at all — not blocked
    if (allChildNumbers.length === 0) {
      return {
        ok: true,
        value: {
          isBlocked: false,
          openChildren: [],
          closedChildren: [],
          totalChildren: 0,
        },
      };
    }

    // Check the state of each child
    const openChildren: number[] = [];
    const closedChildren: number[] = [];

    for (const childNumber of allChildNumbers) {
      // Issue #1808: prefer the cached open-state map. A hit means
      // the child is currently open; a miss means it is either
      // closed or absent from the open-issues snapshot, so we
      // delegate to the fetcher to confirm.
      if (openStateMap?.has(childNumber)) {
        openChildren.push(childNumber);
        continue;
      }
      try {
        const childState = await fetcher.getIssueState(repo, childNumber);
        if (childState.state === "OPEN") {
          openChildren.push(childNumber);
        } else {
          closedChildren.push(childNumber);
        }
      } catch {
        // If we can't check a child's state, assume it's open (fail closed
        // for parent blocking — we don't want to work on a parent if we
        // can't verify children are done)
        openChildren.push(childNumber);
      }
    }

    return {
      ok: true,
      value: {
        isBlocked: openChildren.length > 0,
        openChildren: openChildren.sort((a, b) => a - b),
        closedChildren: closedChildren.sort((a, b) => a - b),
        totalChildren: allChildNumbers.length,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Build a dependency graph for a set of issues.
 *
 * Constructs a graph that includes both forward dependencies ("Depends on #N")
 * and parent/child relationships. This enables topological ordering to
 * determine which issues can be worked on first.
 *
 * @param fetcher - Injectable issue data fetcher
 * @param repo - Repository in "owner/repo" format
 * @param issueNumbers - The issue numbers to analyse
 * @returns Array of dependency nodes
 */
export async function buildDependencyGraph(
  fetcher: IssueFetcher,
  repo: string,
  issueNumbers: number[],
): Promise<DependencyNode[]> {
  const nodes: DependencyNode[] = [];
  const issueSet = new Set(issueNumbers);

  for (const issueNumber of issueNumbers) {
    const dependsOn: number[] = [];
    let childOf: number | undefined;

    try {
      // Check forward dependencies
      const body = await fetcher.getIssueBody(repo, issueNumber);
      const forwardDeps = extractDependencyReferences(body);

      // Only include dependencies within our issue set
      for (const dep of forwardDeps) {
        if (issueSet.has(dep)) {
          dependsOn.push(dep);
        }
      }

      // Check if this issue is a child of any other issue in the set
      for (const potentialParent of issueNumbers) {
        if (potentialParent === issueNumber) continue;

        try {
          const parentBody = await fetcher.getIssueBody(repo, potentialParent);
          const childRefs = extractSubIssueReferences(parentBody, repo);
          if (childRefs.includes(issueNumber)) {
            childOf = potentialParent;
            break;
          }
        } catch {
          // Skip if we can't read parent body
        }
      }

      // Get issue state
      const state = await fetcher.getIssueState(repo, issueNumber);

      nodes.push({
        issueNumber,
        dependsOn,
        childOf,
        state: state.state,
      });
    } catch {
      // If we can't fetch data for an issue, add it with unknown state
      nodes.push({
        issueNumber,
        dependsOn: [],
        state: "OPEN",
      });
    }
  }

  return nodes;
}

/**
 * Resolve the work order for a set of issues based on their dependencies.
 *
 * Uses topological sort to determine which issues are ready to work on,
 * which are blocked, and which have circular dependencies.
 *
 * Issues are "ready" if:
 * 1. All their forward dependencies are closed
 * 2. They are not a parent with open children
 * 3. They are OPEN (closed issues are excluded)
 *
 * @param nodes - Dependency graph nodes
 * @returns Work order result with ready, blocked, and circular issues
 */
export function resolveWorkOrder(nodes: DependencyNode[]): WorkOrderResult {
  const ready: number[] = [];
  const blocked: Array<{ issue: number; blockedBy: number[] }> = [];
  const circular: number[] = [];

  // Build lookup maps
  const nodeMap = new Map<number, DependencyNode>();
  const childrenMap = new Map<number, number[]>();

  for (const node of nodes) {
    nodeMap.set(node.issueNumber, node);
    if (node.childOf !== undefined) {
      const existing = childrenMap.get(node.childOf) ?? [];
      existing.push(node.issueNumber);
      childrenMap.set(node.childOf, existing);
    }
  }

  // Detect circular dependencies using DFS
  const visited = new Set<number>();
  const inStack = new Set<number>();

  function hasCycle(nodeNum: number): boolean {
    if (inStack.has(nodeNum)) return true;
    if (visited.has(nodeNum)) return false;

    visited.add(nodeNum);
    inStack.add(nodeNum);

    const node = nodeMap.get(nodeNum);
    if (node) {
      for (const dep of node.dependsOn) {
        if (hasCycle(dep)) return true;
      }
    }

    inStack.delete(nodeNum);
    return false;
  }

  for (const node of nodes) {
    visited.clear();
    inStack.clear();
    if (hasCycle(node.issueNumber)) {
      circular.push(node.issueNumber);
    }
  }

  // Classify each open issue
  for (const node of nodes) {
    // Skip closed issues
    if (node.state === "CLOSED") continue;

    // Skip circular dependencies
    if (circular.includes(node.issueNumber)) continue;

    const blockedBy: number[] = [];

    // Check forward dependencies — blocked if any dependency is still open
    for (const dep of node.dependsOn) {
      const depNode = nodeMap.get(dep);
      if (depNode && depNode.state === "OPEN") {
        blockedBy.push(dep);
      }
    }

    // Check if this is a parent with open children
    const children = childrenMap.get(node.issueNumber) ?? [];
    for (const child of children) {
      const childNode = nodeMap.get(child);
      if (childNode && childNode.state === "OPEN") {
        blockedBy.push(child);
      }
    }

    if (blockedBy.length > 0) {
      blocked.push({
        issue: node.issueNumber,
        blockedBy: blockedBy.sort((a, b) => a - b),
      });
    } else {
      ready.push(node.issueNumber);
    }
  }

  return {
    ready: ready.sort((a, b) => a - b),
    blocked,
    circular: circular.sort((a, b) => a - b),
  };
}

/**
 * Detect which issues lie on a dependency/parent cycle (Issue #2752).
 *
 * A cycle exists when an issue (transitively) blocks itself — e.g.
 * A depends on B and B depends on A (A→B→A), or a parent/child loop.
 * The blocking edges are:
 *   - forward dependency: `A.dependsOn` includes B  ⇒  A→B ("A blocked by B")
 *   - parent/child:       `B.childOf === A`         ⇒  A→B ("A blocked by B")
 *
 * Returns only the issues that genuinely sit *on* a cycle (those that can
 * reach themselves through the blocking edges). An issue that merely points
 * *into* a cycle without being part of it is not flagged. An acyclic graph
 * returns an empty array.
 *
 * @param nodes - Dependency graph nodes
 * @returns Sorted issue numbers that participate in a cycle
 */
/**
 * Build the "is blocked by" adjacency for a dependency graph: an edge A→B
 * means "A is blocked by B". Forward dependencies contribute A→dep; a
 * parent/child relationship contributes parent→child.
 */
function buildBlockingAdjacency(
  nodes: DependencyNode[],
): Map<number, Set<number>> {
  const adjacency = new Map<number, Set<number>>();
  const ensure = (n: number): Set<number> => {
    let set = adjacency.get(n);
    if (!set) {
      set = new Set<number>();
      adjacency.set(n, set);
    }
    return set;
  };

  for (const node of nodes) {
    const from = ensure(node.issueNumber);
    for (const dep of node.dependsOn) {
      from.add(dep);
      ensure(dep);
    }
    if (node.childOf !== undefined) {
      // The parent is blocked by this child.
      ensure(node.childOf).add(node.issueNumber);
      ensure(node.issueNumber);
    }
  }

  return adjacency;
}

export function detectDependencyCycles(nodes: DependencyNode[]): number[] {
  const adjacency = buildBlockingAdjacency(nodes);

  const onCycle = new Set<number>();
  for (const start of adjacency.keys()) {
    // DFS from `start`: it is on a cycle iff it can reach itself.
    const stack = [...(adjacency.get(start) ?? [])];
    const seen = new Set<number>();
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === start) {
        onCycle.add(start);
        break;
      }
      if (seen.has(current)) continue;
      seen.add(current);
      for (const next of adjacency.get(current) ?? []) {
        stack.push(next);
      }
    }
  }

  return [...onCycle].sort((a, b) => a - b);
}

/**
 * Find a concrete cycle path through `start`, returning the ordered issue
 * numbers from `start` back towards `start` (the closing node is omitted —
 * e.g. a A→B→A cycle returns `[A, B]`). Returns `[start]` for a self-loop
 * and `[]` when `start` is not on any cycle. Used to render a human-readable
 * blocker message (Issue #2752).
 */
export function findCyclePath(
  nodes: DependencyNode[],
  start: number,
): number[] {
  const adjacency = buildBlockingAdjacency(nodes);
  const path: number[] = [];
  const visited = new Set<number>();

  const dfs = (node: number): boolean => {
    path.push(node);
    visited.add(node);
    for (const next of adjacency.get(node) ?? []) {
      if (next === start) return true; // closed the loop back to start
      if (!visited.has(next) && dfs(next)) return true;
    }
    path.pop();
    visited.delete(node);
    return false;
  };

  for (const next of adjacency.get(start) ?? []) {
    if (next === start) return [start]; // self-loop
    if (dfs(next)) return [start, ...path];
  }
  return [];
}

/**
 * Build a dependency graph over a fixed set of issues for cycle detection
 * (Issue #2752).
 *
 * Unlike {@link buildDependencyGraph}, this fetches each node at most once
 * (one body read for forward dependencies, one sub-issues read for
 * parent/child edges) — O(n) calls rather than O(n²) — and only records
 * edges whose endpoints are both in `issueNumbers`. State is not needed for
 * structural cycle detection, so every node is recorded as `OPEN`.
 *
 * @param fetcher - Injectable issue data fetcher
 * @param repo - Repository in "owner/repo" format
 * @param issueNumbers - The issue numbers to analyse
 * @returns Dependency nodes ready for {@link detectDependencyCycles}
 */
export async function buildWorkOnDependencyGraph(
  fetcher: IssueFetcher,
  repo: string,
  issueNumbers: number[],
): Promise<DependencyNode[]> {
  const set = new Set(issueNumbers);
  const nodes = new Map<number, DependencyNode>();
  for (const n of issueNumbers) {
    nodes.set(n, { issueNumber: n, dependsOn: [], state: "OPEN" });
  }

  for (const n of issueNumbers) {
    const node = nodes.get(n)!;

    // Forward dependencies ("Depends on #N" / "Blocked by #N").
    try {
      const body = await fetcher.getIssueBody(repo, n);
      for (const dep of extractDependencyReferences(body)) {
        if (set.has(dep) && !node.dependsOn.includes(dep)) {
          node.dependsOn.push(dep);
        }
      }
    } catch {
      // Unreadable body — skip forward edges for this node.
    }

    // Parent/child edges: each genuine sub-issue is a child of `n`.
    try {
      const children = await fetcher.getSubIssues(repo, n);
      for (const child of children) {
        if (!set.has(child)) continue;
        const childNode = nodes.get(child);
        if (childNode) childNode.childOf = n;
      }
    } catch {
      // Unreadable sub-issues — skip parent edges for this node.
    }
  }

  return [...nodes.values()];
}

/**
 * Format a parent-blocked result as a human-readable message.
 *
 * @param issueNumber - The parent issue number
 * @param result - The blocked check result
 * @returns Formatted message string
 */
export function formatParentBlockedMessage(
  issueNumber: number,
  result: ParentBlockedResult,
): string {
  if (!result.isBlocked) {
    if (result.totalChildren === 0) {
      return `Issue #${issueNumber} has no sub-issues — not blocked.`;
    }
    return `Issue #${issueNumber} — all ${result.totalChildren} sub-issues are closed. Ready to work on.`;
  }

  const openRefs = result.openChildren.map((n) => `#${n}`).join(", ");
  return `Issue #${issueNumber} is blocked by ${result.openChildren.length} open sub-issue(s): ${openRefs}. ` +
    `${result.closedChildren.length}/${result.totalChildren} sub-issues completed.`;
}
