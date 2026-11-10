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
 */ import { maskMarkdownCode, stripMarkdownCode } from "./markdown_code_spans.ts";
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
 */ export function normaliseIssueState(raw) {
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
 * Delegates to the shared, paragraph-aware splitter in
 * `markdown_code_spans.ts` (Issue #3313): an inline span may wrap across a
 * line break within one paragraph, and a fence closes only on a later line
 * starting with the same character, a run at least as long as the opener's,
 * and no info string. An opener with no matching closer still drops
 * everything after it to the end of the body (fail safe: never leak
 * references out of a broken block). Surrounding prose is preserved
 * verbatim.
 *
 * @param body - The raw issue body text.
 * @returns The body with all code spans removed.
 */ export function stripCodeSpans(body) {
  if (!body) return body;
  return stripMarkdownCode(body);
}
/**
 * Blank fenced blocks and inline code spans with spaces of the same length.
 *
 * Unlike {@link stripCodeSpans}, every character stays in place, so a match
 * index in the masked text is the same index in the original. Callers that
 * need attribute text from a real marker use that index and then read the
 * original: stripping would also delete backticks inside the marker's own
 * attributes (Issue #3088).
 *
 * Delegates to the shared, paragraph-aware splitter in
 * `markdown_code_spans.ts` (Issue #3313) — see {@link stripCodeSpans} for the
 * fence and inline-span rules it applies.
 */ export function maskCodeSpans(body) {
  if (!body) return body;
  return maskMarkdownCode(body);
}
/**
 * Find `re` in `output`, ignoring a match that sits inside a fence or an
 * inline code span, and return the match against the original text.
 *
 * The probe runs on {@link maskCodeSpans} so a quoted template does not
 * count. The attributes are then read from the original at the same index,
 * which keeps backtick-quoted words inside a real marker's `reason`.
 */ export function execMarkerOutsideCode(output, re) {
  const probe = re.exec(maskCodeSpans(output));
  re.lastIndex = 0;
  if (!probe) return undefined;
  const at = re.exec(output.slice(probe.index));
  re.lastIndex = 0;
  if (!at || at.index !== 0) return undefined;
  return at;
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
 */ export function extractSubIssueReferences(body, repo) {
  if (!body) return [];
  // Issue #3218: ignore task-list / reference syntax quoted inside code
  // examples — an embedded snippet is documentation, not a sub-issue link.
  const scan = stripCodeSpans(body);
  const issueNumbers = new Set();
  // Match task list items with issue references: - [ ] #123 or - [x] #123
  const taskListPattern = /^-\s*\[[ xX]\]\s*#(\d+)/gm;
  let match;
  while((match = taskListPattern.exec(scan)) !== null){
    const num = parseInt(match[1], 10);
    if (!isNaN(num)) {
      issueNumbers.add(num);
    }
  }
  // Match task list items with full GitHub URLs
  if (repo) {
    const escapedRepo = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // The only interpolated value is the repo slug, escaped on the line above,
    // so it cannot inject regex syntax; every quantifier around it is anchored
    // on a literal and none is ambiguous (Issue #1274).
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    const urlPattern = new RegExp(`^-\\s*\\[[ xX]\\]\\s*https://github\\.com/${escapedRepo}/issues/(\\d+)`, "gm");
    while((match = urlPattern.exec(scan)) !== null){
      const num = parseInt(match[1], 10);
      if (!isNaN(num)) {
        issueNumbers.add(num);
      }
    }
  }
  // Also match "Sub-issues" section with plain #N references (common in parent issues)
  // Look for patterns like "Parent of #N" or "Sub-issue: #N"
  const parentOfPattern = /parent\s+of\s+#(\d+)/gi;
  while((match = parentOfPattern.exec(scan)) !== null){
    const num = parseInt(match[1], 10);
    if (!isNaN(num)) {
      issueNumbers.add(num);
    }
  }
  return [
    ...issueNumbers
  ].sort((a, b)=>a - b);
}
/**
 * Check if an issue body contains a back-reference to a parent issue.
 *
 * Detects the parent-link vocabulary the fleet actually writes — `Part of #N`,
 * `Child of #N`, `Parent: #N` and `Parent #N` — confirming the issue is a
 * genuine sub-issue of the parent. Without this confirmation, a task list item
 * like `- [ ] #747 body updated` would be wrongly treated as a blocking
 * sub-issue (see FLEET#1472).
 *
 * Issue #809: the pattern previously accepted only `part of` / `child of`.
 * Every child of #796 wrote `Parent: #796`, so the parent gate found no
 * children at all and the epic was claimed with four children still open. The
 * vocabulary now matches the one `listSubIssuesViaIssueList` already applies in
 * `planning_processor.ts`.
 *
 * The match stays anchored: `parent` must be followed directly by the
 * reference, so a passing mention such as "the parent of #100 is unclear" is
 * not a back-reference, and a word boundary on the number keeps `#100` from
 * matching `#1001`. Code spans are stripped first (Issue #3218) so a
 * `Parent: #N` quoted in a documentation snippet creates no child edge.
 *
 * Every whitespace run in the pattern is bounded (Issue #1274). `parent\s*:?\s*#`
 * put two unbounded whitespace quantifiers either side of an optional colon, so
 * the split between them was fully ambiguous: `Parent` + 65 000 spaces cost
 * 4.1 s in a single `matchAll`, and this body is a *referenced child issue's*,
 * fetched once per `- [ ] #N` line of the parent — a padded body per reference
 * multiplies that on the claim path. `stripCodeSpans` is no defence: it
 * preserves whitespace runs verbatim. Bounding each run at eight characters
 * caps the split at a constant while still matching every real spelling
 * (`Parent: #1`, `Parent:\n#1`, `Part  of #1`); no worker writes eight or more
 * spaces inside one of these links.
 *
 * @param body - The child issue body text
 * @param parentNumber - The parent issue number to look for
 * @returns true if the body references the parent
 */ export function hasBackReference(body, parentNumber) {
  if (!body) return false;
  const scan = stripCodeSpans(body);
  // A static pattern capturing the number, compared numerically — no dynamic
  // RegExp built from a caller-supplied value (ReDoS/injection risk).
  const parentLinkPattern = /\b(?:part\s{1,8}of|child\s{1,8}of|parent\s{0,8}:?)\s{0,8}#(\d+)\b/gi;
  for (const match of scan.matchAll(parentLinkPattern)){
    if (parseInt(match[1], 10) === parentNumber) return true;
  }
  return false;
}
/**
 * Extract forward dependency references, keeping the repo each one names.
 *
 * Detects patterns like:
 * - "Depends on #123" → `{ number: 123 }` (same repo)
 * - "Blocked by #123" → `{ number: 123 }`
 * - "Depends on owner/repo#123" → `{ repo: "owner/repo", number: 123 }`
 *
 * Issue #222: the cross-repo form previously matched nothing at all, so an
 * issue deferred on another repository's issue was never gated. It is now
 * carried through with its repo, because resolving `owner/repo#123` as if it
 * were this repo's #123 would gate on an unrelated issue.
 *
 * @param body - The issue body text.
 * @returns References in body order, de-duplicated.
 */ export function extractDependencyReferencesDetailed(body) {
  if (!body) return [];
  // Issue #3218: ignore dependency phrases quoted inside code examples — a
  // scan-finding's suggested-fix snippet is documentation, not a dependency.
  const scan = stripCodeSpans(body);
  const refs = [];
  const seen = new Set();
  const depPattern = /(?:depends\s+on|blocked\s+by)\s+([A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+)?#(\d+)/gi;
  let match;
  while((match = depPattern.exec(scan)) !== null){
    const num = parseInt(match[2], 10);
    if (isNaN(num)) continue;
    const repo = match[1];
    const key = `${(repo ?? "").toLowerCase()}#${num}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({
      ...repo ? {
        repo
      } : {},
      number: num
    });
  }
  return refs;
}
/**
 * Extract same-repo forward dependency references from an issue body.
 *
 * Detects patterns like:
 * - "Depends on #123"
 * - "Blocked by #123"
 *
 * A cross-repo reference (`Depends on owner/repo#123`) names an issue in
 * another repository and is deliberately **not** returned here — callers that
 * resolve dependencies across repos use
 * {@link extractDependencyReferencesDetailed}.
 *
 * @param body - The issue body text
 * @returns Array of dependency issue numbers (same-repo only)
 */ export function extractDependencyReferences(body) {
  const numbers = extractDependencyReferencesDetailed(body).filter((ref)=>ref.repo === undefined).map((ref)=>ref.number);
  return [
    ...new Set(numbers)
  ].sort((a, b)=>a - b);
}
/**
 * Build a case-insensitive, trimmed "is this the parent's own repo" test
 * (Issue #3319). Mirrors `isSameRepo` in `issue_finder_common.ts`'s
 * `isDependencyBlocked`.
 */ function childIsSameRepo(parentRepo) {
  const normalised = parentRepo.trim().toLowerCase();
  return (repo)=>repo.trim().toLowerCase() === normalised;
}
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
 * @returns Result containing blocked status and details. Issue #3321: a
 *   `getSubIssues` rejection (a lookup failure) propagates as `{ ok: false }`
 *   here, which `isDependencyBlocked` treats as blocked rather than
 *   claimable.
 */ export async function checkParentBlocked(fetcher, repo, issueNumber, openStateMap) {
  try {
    // Get sub-issues for this issue — each keeps its own repo (Issue #3319).
    const apiChildren = await fetcher.getSubIssues(repo, issueNumber);
    // Also check the issue body for task list references, but only include
    // those where the referenced issue links back (e.g. "Part of #parent").
    // Without this bi-directional check, plain checklist items like
    // "- [ ] #747 body updated" are wrongly treated as blocking sub-issues
    // (see FLEET#1472). Body-derived refs are always same-repo.
    const childMap = new Map();
    const childKey = (ref)=>`${ref.repo.trim().toLowerCase()}#${ref.number}`;
    for (const child of apiChildren)childMap.set(childKey(child), child);
    try {
      const body = await fetcher.getIssueBody(repo, issueNumber);
      const bodyRefs = extractSubIssueReferences(body, repo);
      for (const ref of bodyRefs){
        const candidate = {
          repo,
          number: ref
        };
        if (childMap.has(childKey(candidate))) continue; // Already confirmed via API
        try {
          const refBody = await fetcher.getIssueBody(repo, ref);
          if (hasBackReference(refBody, issueNumber)) {
            childMap.set(childKey(candidate), candidate);
          }
        } catch  {
        // Can't verify back-reference — do NOT assume it's a child
        }
      }
    } catch  {
    // If we can't get the body, continue with just sub-issues from API
    }
    const allChildren = [
      ...childMap.values()
    ];
    // No children at all — not blocked
    if (allChildren.length === 0) {
      return {
        ok: true,
        value: {
          isBlocked: false,
          openChildren: [],
          closedChildren: [],
          totalChildren: 0
        }
      };
    }
    // Check the state of each child
    const openChildren = [];
    const closedChildren = [];
    const sameRepo = childIsSameRepo(repo);
    for (const child of allChildren){
      // Issue #1808: prefer the cached open-state map, but only for a
      // same-repo child — the map is per-repository and a cross-repo
      // child's number has no meaning in it.
      if (sameRepo(child.repo) && openStateMap?.has(child.number)) {
        openChildren.push(child);
        continue;
      }
      try {
        const childState = await fetcher.getIssueState(child.repo, child.number);
        if (childState.state === "OPEN") {
          openChildren.push(child);
        } else {
          closedChildren.push(child);
        }
      } catch  {
        // If we can't check a child's state, assume it's open (fail closed
        // for parent blocking — we don't want to work on a parent if we
        // can't verify children are done)
        openChildren.push(child);
      }
    }
    const byRepoThenNumber = (a, b)=>{
      const repoCmp = a.repo.toLowerCase().localeCompare(b.repo.toLowerCase());
      return repoCmp !== 0 ? repoCmp : a.number - b.number;
    };
    return {
      ok: true,
      value: {
        isBlocked: openChildren.length > 0,
        openChildren: openChildren.sort(byRepoThenNumber),
        closedChildren: closedChildren.sort(byRepoThenNumber),
        totalChildren: allChildren.length
      }
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error))
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
 */ export async function buildDependencyGraph(fetcher, repo, issueNumbers) {
  const nodes = [];
  const issueSet = new Set(issueNumbers);
  for (const issueNumber of issueNumbers){
    const dependsOn = [];
    let childOf;
    try {
      // Check forward dependencies
      const body = await fetcher.getIssueBody(repo, issueNumber);
      const forwardDeps = extractDependencyReferences(body);
      // Only include dependencies within our issue set
      for (const dep of forwardDeps){
        if (issueSet.has(dep)) {
          dependsOn.push(dep);
        }
      }
      // Check if this issue is a child of any other issue in the set
      for (const potentialParent of issueNumbers){
        if (potentialParent === issueNumber) continue;
        try {
          const parentBody = await fetcher.getIssueBody(repo, potentialParent);
          const childRefs = extractSubIssueReferences(parentBody, repo);
          if (childRefs.includes(issueNumber)) {
            childOf = potentialParent;
            break;
          }
        } catch  {
        // Skip if we can't read parent body
        }
      }
      // Get issue state
      const state = await fetcher.getIssueState(repo, issueNumber);
      nodes.push({
        issueNumber,
        dependsOn,
        childOf,
        state: state.state
      });
    } catch  {
      // If we can't fetch data for an issue, add it with unknown state
      nodes.push({
        issueNumber,
        dependsOn: [],
        state: "OPEN"
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
 */ export function resolveWorkOrder(nodes) {
  const ready = [];
  const blocked = [];
  const circular = [];
  // Build lookup maps
  const nodeMap = new Map();
  const childrenMap = new Map();
  for (const node of nodes){
    nodeMap.set(node.issueNumber, node);
    if (node.childOf !== undefined) {
      const existing = childrenMap.get(node.childOf) ?? [];
      existing.push(node.issueNumber);
      childrenMap.set(node.childOf, existing);
    }
  }
  // Detect circular dependencies using DFS
  const visited = new Set();
  const inStack = new Set();
  function hasCycle(nodeNum) {
    if (inStack.has(nodeNum)) return true;
    if (visited.has(nodeNum)) return false;
    visited.add(nodeNum);
    inStack.add(nodeNum);
    const node = nodeMap.get(nodeNum);
    if (node) {
      for (const dep of node.dependsOn){
        if (hasCycle(dep)) return true;
      }
    }
    inStack.delete(nodeNum);
    return false;
  }
  for (const node of nodes){
    visited.clear();
    inStack.clear();
    if (hasCycle(node.issueNumber)) {
      circular.push(node.issueNumber);
    }
  }
  // Classify each open issue
  for (const node of nodes){
    // Skip closed issues
    if (node.state === "CLOSED") continue;
    // Skip circular dependencies
    if (circular.includes(node.issueNumber)) continue;
    const blockedBy = [];
    // Check forward dependencies — blocked if any dependency is still open
    for (const dep of node.dependsOn){
      const depNode = nodeMap.get(dep);
      if (depNode && depNode.state === "OPEN") {
        blockedBy.push(dep);
      }
    }
    // Check if this is a parent with open children
    const children = childrenMap.get(node.issueNumber) ?? [];
    for (const child of children){
      const childNode = nodeMap.get(child);
      if (childNode && childNode.state === "OPEN") {
        blockedBy.push(child);
      }
    }
    if (blockedBy.length > 0) {
      blocked.push({
        issue: node.issueNumber,
        blockedBy: blockedBy.sort((a, b)=>a - b)
      });
    } else {
      ready.push(node.issueNumber);
    }
  }
  return {
    ready: ready.sort((a, b)=>a - b),
    blocked,
    circular: circular.sort((a, b)=>a - b)
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
 */ /**
 * Build the "is blocked by" adjacency for a dependency graph: an edge A→B
 * means "A is blocked by B". Forward dependencies contribute A→dep; a
 * parent/child relationship contributes parent→child.
 */ function buildBlockingAdjacency(nodes) {
  const adjacency = new Map();
  const ensure = (n)=>{
    let set = adjacency.get(n);
    if (!set) {
      set = new Set();
      adjacency.set(n, set);
    }
    return set;
  };
  for (const node of nodes){
    const from = ensure(node.issueNumber);
    for (const dep of node.dependsOn){
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
export function detectDependencyCycles(nodes) {
  const adjacency = buildBlockingAdjacency(nodes);
  const onCycle = new Set();
  for (const start of adjacency.keys()){
    // DFS from `start`: it is on a cycle iff it can reach itself.
    const stack = [
      ...adjacency.get(start) ?? []
    ];
    const seen = new Set();
    while(stack.length > 0){
      const current = stack.pop();
      if (current === start) {
        onCycle.add(start);
        break;
      }
      if (seen.has(current)) continue;
      seen.add(current);
      for (const next of adjacency.get(current) ?? []){
        stack.push(next);
      }
    }
  }
  return [
    ...onCycle
  ].sort((a, b)=>a - b);
}
/**
 * Find a concrete cycle path through `start`, returning the ordered issue
 * numbers from `start` back towards `start` (the closing node is omitted —
 * e.g. a A→B→A cycle returns `[A, B]`). Returns `[start]` for a self-loop
 * and `[]` when `start` is not on any cycle. Used to render a human-readable
 * blocker message (Issue #2752).
 */ export function findCyclePath(nodes, start) {
  const adjacency = buildBlockingAdjacency(nodes);
  const path = [];
  const visited = new Set();
  const dfs = (node)=>{
    path.push(node);
    visited.add(node);
    for (const next of adjacency.get(node) ?? []){
      if (next === start) return true; // closed the loop back to start
      if (!visited.has(next) && dfs(next)) return true;
    }
    path.pop();
    visited.delete(node);
    return false;
  };
  for (const next of adjacency.get(start) ?? []){
    if (next === start) return [
      start
    ]; // self-loop
    if (dfs(next)) return [
      start,
      ...path
    ];
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
 */ export async function buildWorkOnDependencyGraph(fetcher, repo, issueNumbers) {
  const set = new Set(issueNumbers);
  const nodes = new Map();
  for (const n of issueNumbers){
    nodes.set(n, {
      issueNumber: n,
      dependsOn: [],
      state: "OPEN"
    });
  }
  for (const n of issueNumbers){
    const node = nodes.get(n);
    // Forward dependencies ("Depends on #N" / "Blocked by #N").
    try {
      const body = await fetcher.getIssueBody(repo, n);
      for (const dep of extractDependencyReferences(body)){
        if (set.has(dep) && !node.dependsOn.includes(dep)) {
          node.dependsOn.push(dep);
        }
      }
    } catch  {
    // Unreadable body — skip forward edges for this node.
    }
    // Parent/child edges: each genuine sub-issue is a child of `n`. The graph
    // is single-repo, so a cross-repo sub-issue with the same number as one
    // of this repo's nodes is not treated as that node's child (Issue
    // #3319).
    try {
      const children = await fetcher.getSubIssues(repo, n);
      const sameRepo = childIsSameRepo(repo);
      for (const child of children){
        if (!sameRepo(child.repo)) continue;
        if (!set.has(child.number)) continue;
        const childNode = nodes.get(child.number);
        if (childNode) childNode.childOf = n;
      }
    } catch  {
    // Unreadable sub-issues — skip parent edges for this node.
    }
  }
  return [
    ...nodes.values()
  ];
}
/**
 * Format a parent-blocked result as a human-readable message.
 *
 * @param issueNumber - The parent issue number
 * @param result - The blocked check result
 * @param repo - The parent's own repo (Issue #3319): a same-repo child
 *   renders as `#n`, a cross-repo child as `owner/repo#n`.
 * @returns Formatted message string
 */ export function formatParentBlockedMessage(issueNumber, result, repo) {
  if (!result.isBlocked) {
    if (result.totalChildren === 0) {
      return `Issue #${issueNumber} has no sub-issues — not blocked.`;
    }
    return `Issue #${issueNumber} — all ${result.totalChildren} sub-issues are closed. Ready to work on.`;
  }
  const sameRepo = childIsSameRepo(repo);
  const refLabel = (child)=>sameRepo(child.repo) ? `#${child.number}` : `${child.repo}#${child.number}`;
  const openRefs = result.openChildren.map(refLabel).join(", ");
  return `Issue #${issueNumber} is blocked by ${result.openChildren.length} open sub-issue(s): ${openRefs}. ` + `${result.closedChildren.length}/${result.totalChildren} sub-issues completed.`;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9pc3N1ZV9kZXBlbmRlbmNpZXMudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBJc3N1ZSBkZXBlbmRlbmN5IHJlc29sdXRpb24gZm9yIHBhcmVudC9jaGlsZCByZWxhdGlvbnNoaXBzIChJc3N1ZSAjNDg0KS5cbiAqXG4gKiBUaGlzIG1vZHVsZSBwcm92aWRlcyBUeXBlU2NyaXB0IGxvZ2ljIGZvciBkZXRlY3RpbmcgYW5kIHJlc29sdmluZyBpc3N1ZVxuICogZGVwZW5kZW5jaWVzLCBwYXJ0aWN1bGFybHkgZW5zdXJpbmcgcGFyZW50IGlzc3VlcyBhcmUgbm90IHdvcmtlZCBvblxuICogYmVmb3JlIHRoZWlyIGNoaWxkIChzdWIpIGlzc3VlcyBhcmUgY29tcGxldGVkLlxuICpcbiAqIEtleSBjb25jZXB0czpcbiAqIC0gQSBcInBhcmVudFwiIGlzc3VlIGlzIG9uZSB0aGF0IGhhcyBzdWItaXNzdWVzIChjaGlsZHJlbikgbGlzdGVkIHZpYVxuICogICBHaXRIdWIncyB0YXNrIGxpc3Qgc3ludGF4IG9yIHN1Yi1pc3N1ZXMgQVBJLlxuICogLSBBIHBhcmVudCBpc3N1ZSBzaG91bGQgYmUgYmxvY2tlZCB1bnRpbCBhbGwgaXRzIGNoaWxkcmVuIGFyZSBjbG9zZWQuXG4gKiAtIEZvcndhcmQgZGVwZW5kZW5jaWVzIChcIkRlcGVuZHMgb24gI05cIikgYXJlIGhhbmRsZWQgYnkgdGhlIGV4aXN0aW5nXG4gKiAgIGRlcGVuZGVuY3lfY2hlY2tlci5zaCDigJQgdGhpcyBtb2R1bGUgZm9jdXNlcyBvbiByZXZlcnNlL3BhcmVudC1jaGlsZFxuICogICByZWxhdGlvbnNoaXBzLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHNwZWxsaW5nIChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKVxuICovXG5cbmltcG9ydCB0eXBlIHsgUmVzdWx0IH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5pbXBvcnQgdHlwZSB7IFN1Yklzc3VlUmVmIH0gZnJvbSBcIi4vbmF0aXZlX3N1Yl9pc3N1ZXMudHNcIjtcbmltcG9ydCB7IG1hc2tNYXJrZG93bkNvZGUsIHN0cmlwTWFya2Rvd25Db2RlIH0gZnJvbSBcIi4vbWFya2Rvd25fY29kZV9zcGFucy50c1wiO1xuXG4vKipcbiAqIFJlcHJlc2VudHMgdGhlIHN0YXRlIG9mIGEgR2l0SHViIGlzc3VlIGZvciBkZXBlbmRlbmN5IGNoZWNraW5nLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIElzc3VlU3RhdGUge1xuICBudW1iZXI6IG51bWJlcjtcbiAgc3RhdGU6IFwiT1BFTlwiIHwgXCJDTE9TRURcIjtcbiAgdGl0bGU/OiBzdHJpbmc7XG4gIC8qKlxuICAgKiBUaGUgaXNzdWUncyBtaWxlc3RvbmUgdGl0bGUsIG9yIGBudWxsYCB3aGVuIGl0IGhhcyBub25lIChJc3N1ZSAjMjE3MykuXG4gICAqXG4gICAqIENhcnJpZWQgc28gdGhlIHNlbGVjdGlvbi10aW1lIGRlcGVuZGVuY3kgZ2F0ZSBjYW4gaG9sZCBhIGRlcGVuZGFudCB3aG9zZVxuICAgKiBjbG9zZWQgZGVwZW5kZW5jeSBzdGlsbCBzaXRzIGluIGFub3RoZXIgKm9wZW4qIG1pbGVzdG9uZSDigJQgdGhhdFxuICAgKiBkZXBlbmRlbmN5J3MgY29kZSBvbmx5IHJlYWNoZXMgdGhlIGRlZmF1bHQgYnJhbmNoIG9uY2UgaXRzIG1pbGVzdG9uZSdzXG4gICAqIGZpbmFsIFBSIG1lcmdlcy4gYHVuZGVmaW5lZGAgbWVhbnMgdGhlIGZldGNoZXIgZGlkIG5vdCByZXBvcnQgYSBtaWxlc3RvbmVcbiAgICogKGFuIG9sZGVyIGNhY2hlZCBlbnRyeSwgb3IgYSB0ZXN0IGZldGNoZXIpLCB3aGljaCByZWFkcyB0aGUgc2FtZSBhcyBcIm5vXG4gICAqIG1pbGVzdG9uZVwiOiBpdCBuZXZlciB0cmlnZ2VycyB0aGUgY3Jvc3MtbWlsZXN0b25lIGhvbGQuXG4gICAqL1xuICBtaWxlc3RvbmU/OiBzdHJpbmcgfCBudWxsO1xufVxuXG4vKipcbiAqIEEgZGVwZW5kZW5jeSB0aGF0IGJsb2NrcyBhIGNhbmRpZGF0ZSAoSXNzdWUgIzI0NzMpLlxuICpcbiAqIEV4dHJhY3RlZCBmcm9tIGEgY2FuZGlkYXRlJ3MgZGVwZW5kZW5jeSBncmFwaCBzbyB0aGUgY29sbGVjdG9yIGNhblxuICogY2xhc3NpZnkgd2hldGhlciB0aGUgYmxvY2tlciBpcyBzdGFsbGVkICh1bmNsYWltYWJsZSkgb3IgbWVyZWx5IGJ1c3kuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgRGVwZW5kZW5jeUJsb2NrZXIge1xuICAvKiogUmVwb3NpdG9yeSBjb250YWluaW5nIHRoZSBibG9ja2luZyBkZXBlbmRlbmN5LiAqL1xuICByZXBvOiBzdHJpbmc7XG4gIC8qKiBJc3N1ZSBudW1iZXIgb2YgdGhlIGJsb2NraW5nIGRlcGVuZGVuY3kuICovXG4gIG51bWJlcjogbnVtYmVyO1xuICAvKipcbiAgICogVHlwZSBvZiBkZXBlbmRlbmN5IHJlbGF0aW9uc2hpcC5cbiAgICpcbiAgICogLSBgY2hpbGRgIOKAlCBhbiBvcGVuIHN1Yi1pc3N1ZSBvZiB0aGUgY2FuZGlkYXRlLlxuICAgKiAtIGBkZXBlbmRzLW9uYCDigJQgYW4gb3BlbiAob3IgbWlsZXN0b25lLWhlbGQpIGZvcndhcmQgZGVwZW5kZW5jeS5cbiAgICogLSBgdW5yZWFkYWJsZS1jaGlsZHJlbmAgKElzc3VlICMzMzIxKSDigJQgdGhlIGNhbmRpZGF0ZSdzIG93biBzdWItaXNzdWVzXG4gICAqICAgY291bGQgbm90IGJlIHJlYWQgYXQgYWxsOyBgbnVtYmVyYCBpcyB0aGUgY2FuZGlkYXRlIGlzc3VlIGl0c2VsZiwgbm90XG4gICAqICAgYSBjaGlsZCwgc2luY2Ugbm8gY2hpbGQgbGlzdCBjb3VsZCBiZSBwcm9kdWNlZCB0byBuYW1lIG9uZS4gRmFpbHNcbiAgICogICBjbG9zZWQ6IHRyZWF0ZWQgYXMgYmxvY2tlZCByYXRoZXIgdGhhbiBjbGFpbWFibGUuXG4gICAqL1xuICBraW5kOiBcImNoaWxkXCIgfCBcImRlcGVuZHMtb25cIiB8IFwidW5yZWFkYWJsZS1jaGlsZHJlblwiO1xuICAvKipcbiAgICogVGhlIGRlcGVuZGVuY3kncyBtaWxlc3RvbmUgdGl0bGUgd2hlbiB0aGUgaG9sZCBpcyB0aGUgY3Jvc3MtbWlsZXN0b25lXG4gICAqIG9uZSAoSXNzdWUgIzIxNzMpOiB0aGUgZGVwZW5kZW5jeSBpcyAqY2xvc2VkKiwgYnV0IHNpdHMgaW4gYW5vdGhlclxuICAgKiBzdGlsbC1vcGVuIG1pbGVzdG9uZSwgc28gaXRzIGNvZGUgaGFzIG5vdCByZWFjaGVkIHRoZSBkZWZhdWx0IGJyYW5jaFxuICAgKiB5ZXQuIFJlY29yZGVkIHNvIGEgZ2F0ZSBjb21tZW50IGNhbiBuYW1lIHRoZSBtaWxlc3RvbmUgdGhlIGRlcGVuZGFudFxuICAgKiBpcyBhY3R1YWxseSB3YWl0aW5nIG9uIChJc3N1ZSAjMjUzNCkuXG4gICAqXG4gICAqIEFic2VudCBmb3IgZXZlcnkgb3RoZXIgYmxvY2tlciDigJQgYW4gb3BlbiBkZXBlbmRlbmN5LCBhbiBvcGVuIGNoaWxkLCBvclxuICAgKiBhIGRlcGVuZGVuY3kgc2F0aXNmaWVkIG9uIGNsb3NlIOKAlCBzbyBgdW5kZWZpbmVkYCByZWFkcyBhcyBcIm5vdCBhXG4gICAqIGNyb3NzLW1pbGVzdG9uZSBob2xkXCIsIG5ldmVyIGFzIFwibWlsZXN0b25lIHVua25vd25cIi5cbiAgICovXG4gIGhlbGRCeU1pbGVzdG9uZT86IHN0cmluZztcbn1cblxuLyoqXG4gKiBOb3JtYWxpc2UgYSByYXcgR2l0SHViIGBzdGF0ZWAgc3RyaW5nIGludG8gdGhlIGJpbmFyeSBPUEVOL0NMT1NFRCB1c2VkXG4gKiBmb3IgZGVwZW5kZW5jeSBhbmQgYmxvY2tpbmcgY2hlY2tzLlxuICpcbiAqIE9ubHkgYSBsaXRlcmFsIGBPUEVOYCAoY2FzZS1pbnNlbnNpdGl2ZSkgY291bnRzIGFzIG9wZW4uIEV2ZXJ5IG90aGVyIHZhbHVlIOKAlFxuICogYENMT1NFRGAsIGFuZCBjcnVjaWFsbHkgYSBwdWxsIHJlcXVlc3QncyBgTUVSR0VEYCDigJQgcmVzb2x2ZXMgdG8gQ0xPU0VELlxuICogQSBkZXBlbmRlbmN5IHJlZmVyZW5jZSBjYW4gcG9pbnQgYXQgYSBQUiBudW1iZXIgYmVjYXVzZSBpc3N1ZXMgYW5kIHB1bGxcbiAqIHJlcXVlc3RzIHNoYXJlIGEgc2luZ2xlIG51bWJlcmluZyBzcGFjZSwgYW5kIGEgbWVyZ2VkIFBSIGlzICpzYXRpc2ZpZWQqLCBub3RcbiAqIG91dHN0YW5kaW5nLiBUaGUgcHJldmlvdXMgYHN0YXRlID09PSBcIkNMT1NFRFwiID8gXCJDTE9TRURcIiA6IFwiT1BFTlwiYCBzaGFwZVxuICogbWFwcGVkIGBNRVJHRURgIHRvIE9QRU4sIHNvIGEgcmVmZXJlbmNlIHRvIGEgbWVyZ2VkIFBSIGJsb2NrZWQgdGhlIGRlcGVuZGVudFxuICogaXNzdWUgZm9yZXZlciAoSXNzdWUgIzMyMTgsIHRoZSAjMzIwNCB3ZWRnZSkuXG4gKlxuICogQHBhcmFtIHJhdyAtIFRoZSByYXcgYHN0YXRlYCB2YWx1ZSBmcm9tIGBnaCBpc3N1ZSB2aWV3IC0tanNvbiBzdGF0ZWAuXG4gKiBAcmV0dXJucyBgXCJPUEVOXCJgIG9ubHkgd2hlbiB0aGUgaXNzdWUvUFIgaXMgZ2VudWluZWx5IG9wZW4sIGVsc2UgYFwiQ0xPU0VEXCJgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXNlSXNzdWVTdGF0ZShyYXc6IHN0cmluZyk6IFwiT1BFTlwiIHwgXCJDTE9TRURcIiB7XG4gIHJldHVybiByYXcudHJpbSgpLnRvVXBwZXJDYXNlKCkgPT09IFwiT1BFTlwiID8gXCJPUEVOXCIgOiBcIkNMT1NFRFwiO1xufVxuXG4vKipcbiAqIFJlbW92ZSBNYXJrZG93biBjb2RlIHNwYW5zIChmZW5jZWQgYmxvY2tzIGFuZCBpbmxpbmUgY29kZSkgZnJvbSBhbiBpc3N1ZVxuICogYm9keSBiZWZvcmUgaXQgaXMgc2Nhbm5lZCBmb3IgaXNzdWUgcmVmZXJlbmNlcy5cbiAqXG4gKiBUaGUgZGVwZW5kZW5jeSBhbmQgc3ViLWlzc3VlIGV4dHJhY3RvcnMgbG9vayBmb3IgcGhyYXNlcyBzdWNoIGFzXG4gKiBgZGVwZW5kcyBvbiAjTmAsIGBibG9ja2VkIGJ5ICNOYCwgb3IgYC0gWyBdICNOYC4gV2hlbiBzdWNoIGEgcGhyYXNlIGFwcGVhcnNcbiAqIGluc2lkZSBhICpjb2RlIGV4YW1wbGUqIOKAlCBmb3IgaW5zdGFuY2UgdGhlIHN1Z2dlc3RlZC1maXggc25pcHBldCBhXG4gKiBzY2FuLWZpbmRpbmcgaXNzdWUgZW1iZWRzIOKAlCBpdCBpcyBkb2N1bWVudGF0aW9uLCBub3QgYSByZWFsIHJlbGF0aW9uc2hpcCxcbiAqIGFuZCBtdXN0IGJlIGlnbm9yZWQuIFZpYmVDb2RlciMzMjA0J3MgZml4IGV4YW1wbGUgY29udGFpbmVkXG4gKiBgcmVhc29uczogW1wiZGVwZW5kcyBvbiAjNVwiXWAsIHdoaWNoIHdhcyBvdGhlcndpc2UgcGFyc2VkIGFzIGEgZGVwZW5kZW5jeSBvblxuICogIzUgYW5kIGJsb2NrZWQgdGhlIGlzc3VlIGZvcmV2ZXIgKElzc3VlICMzMjE4KS5cbiAqXG4gKiBEZWxlZ2F0ZXMgdG8gdGhlIHNoYXJlZCwgcGFyYWdyYXBoLWF3YXJlIHNwbGl0dGVyIGluXG4gKiBgbWFya2Rvd25fY29kZV9zcGFucy50c2AgKElzc3VlICMzMzEzKTogYW4gaW5saW5lIHNwYW4gbWF5IHdyYXAgYWNyb3NzIGFcbiAqIGxpbmUgYnJlYWsgd2l0aGluIG9uZSBwYXJhZ3JhcGgsIGFuZCBhIGZlbmNlIGNsb3NlcyBvbmx5IG9uIGEgbGF0ZXIgbGluZVxuICogc3RhcnRpbmcgd2l0aCB0aGUgc2FtZSBjaGFyYWN0ZXIsIGEgcnVuIGF0IGxlYXN0IGFzIGxvbmcgYXMgdGhlIG9wZW5lcidzLFxuICogYW5kIG5vIGluZm8gc3RyaW5nLiBBbiBvcGVuZXIgd2l0aCBubyBtYXRjaGluZyBjbG9zZXIgc3RpbGwgZHJvcHNcbiAqIGV2ZXJ5dGhpbmcgYWZ0ZXIgaXQgdG8gdGhlIGVuZCBvZiB0aGUgYm9keSAoZmFpbCBzYWZlOiBuZXZlciBsZWFrXG4gKiByZWZlcmVuY2VzIG91dCBvZiBhIGJyb2tlbiBibG9jaykuIFN1cnJvdW5kaW5nIHByb3NlIGlzIHByZXNlcnZlZFxuICogdmVyYmF0aW0uXG4gKlxuICogQHBhcmFtIGJvZHkgLSBUaGUgcmF3IGlzc3VlIGJvZHkgdGV4dC5cbiAqIEByZXR1cm5zIFRoZSBib2R5IHdpdGggYWxsIGNvZGUgc3BhbnMgcmVtb3ZlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN0cmlwQ29kZVNwYW5zKGJvZHk6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmICghYm9keSkgcmV0dXJuIGJvZHk7XG4gIHJldHVybiBzdHJpcE1hcmtkb3duQ29kZShib2R5KTtcbn1cblxuLyoqXG4gKiBCbGFuayBmZW5jZWQgYmxvY2tzIGFuZCBpbmxpbmUgY29kZSBzcGFucyB3aXRoIHNwYWNlcyBvZiB0aGUgc2FtZSBsZW5ndGguXG4gKlxuICogVW5saWtlIHtAbGluayBzdHJpcENvZGVTcGFuc30sIGV2ZXJ5IGNoYXJhY3RlciBzdGF5cyBpbiBwbGFjZSwgc28gYSBtYXRjaFxuICogaW5kZXggaW4gdGhlIG1hc2tlZCB0ZXh0IGlzIHRoZSBzYW1lIGluZGV4IGluIHRoZSBvcmlnaW5hbC4gQ2FsbGVycyB0aGF0XG4gKiBuZWVkIGF0dHJpYnV0ZSB0ZXh0IGZyb20gYSByZWFsIG1hcmtlciB1c2UgdGhhdCBpbmRleCBhbmQgdGhlbiByZWFkIHRoZVxuICogb3JpZ2luYWw6IHN0cmlwcGluZyB3b3VsZCBhbHNvIGRlbGV0ZSBiYWNrdGlja3MgaW5zaWRlIHRoZSBtYXJrZXIncyBvd25cbiAqIGF0dHJpYnV0ZXMgKElzc3VlICMzMDg4KS5cbiAqXG4gKiBEZWxlZ2F0ZXMgdG8gdGhlIHNoYXJlZCwgcGFyYWdyYXBoLWF3YXJlIHNwbGl0dGVyIGluXG4gKiBgbWFya2Rvd25fY29kZV9zcGFucy50c2AgKElzc3VlICMzMzEzKSDigJQgc2VlIHtAbGluayBzdHJpcENvZGVTcGFuc30gZm9yIHRoZVxuICogZmVuY2UgYW5kIGlubGluZS1zcGFuIHJ1bGVzIGl0IGFwcGxpZXMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtYXNrQ29kZVNwYW5zKGJvZHk6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmICghYm9keSkgcmV0dXJuIGJvZHk7XG4gIHJldHVybiBtYXNrTWFya2Rvd25Db2RlKGJvZHkpO1xufVxuXG4vKipcbiAqIEZpbmQgYHJlYCBpbiBgb3V0cHV0YCwgaWdub3JpbmcgYSBtYXRjaCB0aGF0IHNpdHMgaW5zaWRlIGEgZmVuY2Ugb3IgYW5cbiAqIGlubGluZSBjb2RlIHNwYW4sIGFuZCByZXR1cm4gdGhlIG1hdGNoIGFnYWluc3QgdGhlIG9yaWdpbmFsIHRleHQuXG4gKlxuICogVGhlIHByb2JlIHJ1bnMgb24ge0BsaW5rIG1hc2tDb2RlU3BhbnN9IHNvIGEgcXVvdGVkIHRlbXBsYXRlIGRvZXMgbm90XG4gKiBjb3VudC4gVGhlIGF0dHJpYnV0ZXMgYXJlIHRoZW4gcmVhZCBmcm9tIHRoZSBvcmlnaW5hbCBhdCB0aGUgc2FtZSBpbmRleCxcbiAqIHdoaWNoIGtlZXBzIGJhY2t0aWNrLXF1b3RlZCB3b3JkcyBpbnNpZGUgYSByZWFsIG1hcmtlcidzIGByZWFzb25gLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZXhlY01hcmtlck91dHNpZGVDb2RlKFxuICBvdXRwdXQ6IHN0cmluZyxcbiAgcmU6IFJlZ0V4cCxcbik6IFJlZ0V4cEV4ZWNBcnJheSB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IHByb2JlID0gcmUuZXhlYyhtYXNrQ29kZVNwYW5zKG91dHB1dCkpO1xuICByZS5sYXN0SW5kZXggPSAwO1xuICBpZiAoIXByb2JlKSByZXR1cm4gdW5kZWZpbmVkO1xuICBjb25zdCBhdCA9IHJlLmV4ZWMob3V0cHV0LnNsaWNlKHByb2JlLmluZGV4KSk7XG4gIHJlLmxhc3RJbmRleCA9IDA7XG4gIGlmICghYXQgfHwgYXQuaW5kZXggIT09IDApIHJldHVybiB1bmRlZmluZWQ7XG4gIHJldHVybiBhdDtcbn1cblxuLyoqXG4gKiBSZXN1bHQgb2YgY2hlY2tpbmcgd2hldGhlciBhIHBhcmVudCBpc3N1ZSBpcyBibG9ja2VkIGJ5IG9wZW4gY2hpbGRyZW4uXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUGFyZW50QmxvY2tlZFJlc3VsdCB7XG4gIGlzQmxvY2tlZDogYm9vbGVhbjtcbiAgLyoqIE9wZW4gY2hpbGRyZW4sIGVhY2ggd2l0aCBpdHMgb3duIHJlcG8gKElzc3VlICMzMzE5OiBtYXkgYmUgY3Jvc3MtcmVwbykuICovXG4gIG9wZW5DaGlsZHJlbjogU3ViSXNzdWVSZWZbXTtcbiAgLyoqIENsb3NlZCBjaGlsZHJlbiwgZWFjaCB3aXRoIGl0cyBvd24gcmVwby4gKi9cbiAgY2xvc2VkQ2hpbGRyZW46IFN1Yklzc3VlUmVmW107XG4gIHRvdGFsQ2hpbGRyZW46IG51bWJlcjtcbn1cblxuLyoqXG4gKiBEZXBlbmRlbmN5IGdyYXBoIG5vZGUgZm9yIHRvcG9sb2dpY2FsIG9yZGVyaW5nLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIERlcGVuZGVuY3lOb2RlIHtcbiAgaXNzdWVOdW1iZXI6IG51bWJlcjtcbiAgZGVwZW5kc09uOiBudW1iZXJbXTtcbiAgY2hpbGRPZj86IG51bWJlcjtcbiAgc3RhdGU6IFwiT1BFTlwiIHwgXCJDTE9TRURcIjtcbn1cblxuLyoqXG4gKiBSZXN1bHQgb2YgcmVzb2x2aW5nIHRoZSB3b3JrIG9yZGVyIGZvciBhIHNldCBvZiBpc3N1ZXMuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgV29ya09yZGVyUmVzdWx0IHtcbiAgLyoqIElzc3VlcyByZWFkeSB0byBiZSB3b3JrZWQgb24gKG5vIHVubWV0IGRlcGVuZGVuY2llcykgKi9cbiAgcmVhZHk6IG51bWJlcltdO1xuICAvKiogSXNzdWVzIGJsb2NrZWQgYnkgZGVwZW5kZW5jaWVzIG9yIG9wZW4gY2hpbGRyZW4gKi9cbiAgYmxvY2tlZDogQXJyYXk8eyBpc3N1ZTogbnVtYmVyOyBibG9ja2VkQnk6IG51bWJlcltdIH0+O1xuICAvKiogSXNzdWVzIHRoYXQgaGF2ZSBjaXJjdWxhciBkZXBlbmRlbmNpZXMgKHNob3VsZCBub3QgaGFwcGVuIGJ1dCBoYW5kbGVkKSAqL1xuICBjaXJjdWxhcjogbnVtYmVyW107XG59XG5cbi8qKlxuICogSW50ZXJmYWNlIGZvciBmZXRjaGluZyBpc3N1ZSBkYXRhIOKAlCBpbmplY3RhYmxlIGZvciB0ZXN0aW5nLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIElzc3VlRmV0Y2hlciB7XG4gIC8qKiBHZXQgdGhlIHN0YXRlIG9mIGFuIGlzc3VlICovXG4gIGdldElzc3VlU3RhdGUocmVwbzogc3RyaW5nLCBpc3N1ZU51bWJlcjogbnVtYmVyKTogUHJvbWlzZTxJc3N1ZVN0YXRlPjtcbiAgLyoqXG4gICAqIEdldCBhbiBpc3N1ZSdzIHN1Yi1pc3N1ZXMsIGVhY2ggd2l0aCBpdHMgb3duIHJlcG8gKElzc3VlICMzMzE5KS4gQVxuICAgKiBuYXRpdmUgc3ViLWlzc3VlIGNhbiBsaXZlIGluIGEgZGlmZmVyZW50IHJlcG9zaXRvcnkgZnJvbSBpdHMgcGFyZW50LCBzb1xuICAgKiB0aGUgcmVwbyBpcyBjYXJyaWVkIHBlciBjaGlsZCByYXRoZXIgdGhhbiBhc3N1bWVkIHRvIGJlIHRoZSBwYXJlbnQncy5cbiAgICpcbiAgICogSXNzdWUgIzMzMjE6IHJlamVjdHMgb24gYSBsb29rdXAgZmFpbHVyZSDigJQgYSBmYWlsZWQgY2FsbCwgb3IgZW1wdHksXG4gICAqIHVucGFyc2VhYmxlIG9yIG5vbi1hcnJheSBvdXRwdXQg4oCUIGFuZCBtdXN0IG5ldmVyIGFuc3dlciBgW11gIGZvciBvbmUuXG4gICAqIGBbXWAgaXMgcmVzZXJ2ZWQgZm9yIGEgZ2VudWluZSBcInRoaXMgaXNzdWUgaGFzIG5vIHN1Yi1pc3N1ZXNcIiBhbnN3ZXI7XG4gICAqIGNvbmZsYXRpbmcgdGhlIHR3byBsZXQgYSBwYXJlbnQgYmUgY2xhaW1lZCB3aGlsZSBpdHMgY2hpbGRyZW4gd2VyZVxuICAgKiBtZXJlbHkgdW5yZWFkYWJsZS5cbiAgICovXG4gIGdldFN1Yklzc3VlcyhyZXBvOiBzdHJpbmcsIGlzc3VlTnVtYmVyOiBudW1iZXIpOiBQcm9taXNlPFN1Yklzc3VlUmVmW10+O1xuICAvKiogR2V0IHRoZSBpc3N1ZSBib2R5IHRleHQgKi9cbiAgZ2V0SXNzdWVCb2R5KHJlcG86IHN0cmluZywgaXNzdWVOdW1iZXI6IG51bWJlcik6IFByb21pc2U8c3RyaW5nPjtcbn1cblxuLyoqXG4gKiBFeHRyYWN0IHN1Yi1pc3N1ZSByZWZlcmVuY2VzIGZyb20gYW4gaXNzdWUgYm9keS5cbiAqXG4gKiBEZXRlY3RzIEdpdEh1YiB0YXNrIGxpc3QgaXRlbXMgdGhhdCByZWZlcmVuY2UgaXNzdWVzOlxuICogLSBgLSBbIF0gIzEyM2AgKHVuY2hlY2tlZCB0YXNrKVxuICogLSBgLSBbeF0gIzEyM2AgKGNoZWNrZWQgdGFzaylcbiAqIC0gYC0gWyBdIGh0dHBzOi8vZ2l0aHViLmNvbS9vd25lci9yZXBvL2lzc3Vlcy8xMjNgXG4gKlxuICogQHBhcmFtIGJvZHkgLSBUaGUgaXNzdWUgYm9keSB0ZXh0XG4gKiBAcGFyYW0gcmVwbyAtIE9wdGlvbmFsIHJlcG8gaW4gXCJvd25lci9yZXBvXCIgZm9ybWF0IGZvciBVUkwgbWF0Y2hpbmdcbiAqIEByZXR1cm5zIEFycmF5IG9mIHJlZmVyZW5jZWQgaXNzdWUgbnVtYmVyc1xuICovXG5leHBvcnQgZnVuY3Rpb24gZXh0cmFjdFN1Yklzc3VlUmVmZXJlbmNlcyhcbiAgYm9keTogc3RyaW5nLFxuICByZXBvPzogc3RyaW5nLFxuKTogbnVtYmVyW10ge1xuICBpZiAoIWJvZHkpIHJldHVybiBbXTtcblxuICAvLyBJc3N1ZSAjMzIxODogaWdub3JlIHRhc2stbGlzdCAvIHJlZmVyZW5jZSBzeW50YXggcXVvdGVkIGluc2lkZSBjb2RlXG4gIC8vIGV4YW1wbGVzIOKAlCBhbiBlbWJlZGRlZCBzbmlwcGV0IGlzIGRvY3VtZW50YXRpb24sIG5vdCBhIHN1Yi1pc3N1ZSBsaW5rLlxuICBjb25zdCBzY2FuID0gc3RyaXBDb2RlU3BhbnMoYm9keSk7XG5cbiAgY29uc3QgaXNzdWVOdW1iZXJzOiBTZXQ8bnVtYmVyPiA9IG5ldyBTZXQoKTtcblxuICAvLyBNYXRjaCB0YXNrIGxpc3QgaXRlbXMgd2l0aCBpc3N1ZSByZWZlcmVuY2VzOiAtIFsgXSAjMTIzIG9yIC0gW3hdICMxMjNcbiAgY29uc3QgdGFza0xpc3RQYXR0ZXJuID0gL14tXFxzKlxcW1sgeFhdXFxdXFxzKiMoXFxkKykvZ207XG4gIGxldCBtYXRjaDogUmVnRXhwRXhlY0FycmF5IHwgbnVsbDtcbiAgd2hpbGUgKChtYXRjaCA9IHRhc2tMaXN0UGF0dGVybi5leGVjKHNjYW4pKSAhPT0gbnVsbCkge1xuICAgIGNvbnN0IG51bSA9IHBhcnNlSW50KG1hdGNoWzFdISwgMTApO1xuICAgIGlmICghaXNOYU4obnVtKSkge1xuICAgICAgaXNzdWVOdW1iZXJzLmFkZChudW0pO1xuICAgIH1cbiAgfVxuXG4gIC8vIE1hdGNoIHRhc2sgbGlzdCBpdGVtcyB3aXRoIGZ1bGwgR2l0SHViIFVSTHNcbiAgaWYgKHJlcG8pIHtcbiAgICBjb25zdCBlc2NhcGVkUmVwbyA9IHJlcG8ucmVwbGFjZSgvWy4qKz9eJHt9KCl8W1xcXVxcXFxdL2csIFwiXFxcXCQmXCIpO1xuICAgIC8vIFRoZSBvbmx5IGludGVycG9sYXRlZCB2YWx1ZSBpcyB0aGUgcmVwbyBzbHVnLCBlc2NhcGVkIG9uIHRoZSBsaW5lIGFib3ZlLFxuICAgIC8vIHNvIGl0IGNhbm5vdCBpbmplY3QgcmVnZXggc3ludGF4OyBldmVyeSBxdWFudGlmaWVyIGFyb3VuZCBpdCBpcyBhbmNob3JlZFxuICAgIC8vIG9uIGEgbGl0ZXJhbCBhbmQgbm9uZSBpcyBhbWJpZ3VvdXMgKElzc3VlICMxMjc0KS5cbiAgICAvLyBub3NlbWdyZXA6IGphdmFzY3JpcHQubGFuZy5zZWN1cml0eS5hdWRpdC5kZXRlY3Qtbm9uLWxpdGVyYWwtcmVnZXhwLmRldGVjdC1ub24tbGl0ZXJhbC1yZWdleHBcbiAgICBjb25zdCB1cmxQYXR0ZXJuID0gbmV3IFJlZ0V4cChcbiAgICAgIGBeLVxcXFxzKlxcXFxbWyB4WF1cXFxcXVxcXFxzKmh0dHBzOi8vZ2l0aHViXFxcXC5jb20vJHtlc2NhcGVkUmVwb30vaXNzdWVzLyhcXFxcZCspYCxcbiAgICAgIFwiZ21cIixcbiAgICApO1xuICAgIHdoaWxlICgobWF0Y2ggPSB1cmxQYXR0ZXJuLmV4ZWMoc2NhbikpICE9PSBudWxsKSB7XG4gICAgICBjb25zdCBudW0gPSBwYXJzZUludChtYXRjaFsxXSEsIDEwKTtcbiAgICAgIGlmICghaXNOYU4obnVtKSkge1xuICAgICAgICBpc3N1ZU51bWJlcnMuYWRkKG51bSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gQWxzbyBtYXRjaCBcIlN1Yi1pc3N1ZXNcIiBzZWN0aW9uIHdpdGggcGxhaW4gI04gcmVmZXJlbmNlcyAoY29tbW9uIGluIHBhcmVudCBpc3N1ZXMpXG4gIC8vIExvb2sgZm9yIHBhdHRlcm5zIGxpa2UgXCJQYXJlbnQgb2YgI05cIiBvciBcIlN1Yi1pc3N1ZTogI05cIlxuICBjb25zdCBwYXJlbnRPZlBhdHRlcm4gPSAvcGFyZW50XFxzK29mXFxzKyMoXFxkKykvZ2k7XG4gIHdoaWxlICgobWF0Y2ggPSBwYXJlbnRPZlBhdHRlcm4uZXhlYyhzY2FuKSkgIT09IG51bGwpIHtcbiAgICBjb25zdCBudW0gPSBwYXJzZUludChtYXRjaFsxXSEsIDEwKTtcbiAgICBpZiAoIWlzTmFOKG51bSkpIHtcbiAgICAgIGlzc3VlTnVtYmVycy5hZGQobnVtKTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gWy4uLmlzc3VlTnVtYmVyc10uc29ydCgoYSwgYikgPT4gYSAtIGIpO1xufVxuXG4vKipcbiAqIENoZWNrIGlmIGFuIGlzc3VlIGJvZHkgY29udGFpbnMgYSBiYWNrLXJlZmVyZW5jZSB0byBhIHBhcmVudCBpc3N1ZS5cbiAqXG4gKiBEZXRlY3RzIHRoZSBwYXJlbnQtbGluayB2b2NhYnVsYXJ5IHRoZSBmbGVldCBhY3R1YWxseSB3cml0ZXMg4oCUIGBQYXJ0IG9mICNOYCxcbiAqIGBDaGlsZCBvZiAjTmAsIGBQYXJlbnQ6ICNOYCBhbmQgYFBhcmVudCAjTmAg4oCUIGNvbmZpcm1pbmcgdGhlIGlzc3VlIGlzIGFcbiAqIGdlbnVpbmUgc3ViLWlzc3VlIG9mIHRoZSBwYXJlbnQuIFdpdGhvdXQgdGhpcyBjb25maXJtYXRpb24sIGEgdGFzayBsaXN0IGl0ZW1cbiAqIGxpa2UgYC0gWyBdICM3NDcgYm9keSB1cGRhdGVkYCB3b3VsZCBiZSB3cm9uZ2x5IHRyZWF0ZWQgYXMgYSBibG9ja2luZ1xuICogc3ViLWlzc3VlIChzZWUgRkxFRVQjMTQ3MikuXG4gKlxuICogSXNzdWUgIzgwOTogdGhlIHBhdHRlcm4gcHJldmlvdXNseSBhY2NlcHRlZCBvbmx5IGBwYXJ0IG9mYCAvIGBjaGlsZCBvZmAuXG4gKiBFdmVyeSBjaGlsZCBvZiAjNzk2IHdyb3RlIGBQYXJlbnQ6ICM3OTZgLCBzbyB0aGUgcGFyZW50IGdhdGUgZm91bmQgbm9cbiAqIGNoaWxkcmVuIGF0IGFsbCBhbmQgdGhlIGVwaWMgd2FzIGNsYWltZWQgd2l0aCBmb3VyIGNoaWxkcmVuIHN0aWxsIG9wZW4uIFRoZVxuICogdm9jYWJ1bGFyeSBub3cgbWF0Y2hlcyB0aGUgb25lIGBsaXN0U3ViSXNzdWVzVmlhSXNzdWVMaXN0YCBhbHJlYWR5IGFwcGxpZXMgaW5cbiAqIGBwbGFubmluZ19wcm9jZXNzb3IudHNgLlxuICpcbiAqIFRoZSBtYXRjaCBzdGF5cyBhbmNob3JlZDogYHBhcmVudGAgbXVzdCBiZSBmb2xsb3dlZCBkaXJlY3RseSBieSB0aGVcbiAqIHJlZmVyZW5jZSwgc28gYSBwYXNzaW5nIG1lbnRpb24gc3VjaCBhcyBcInRoZSBwYXJlbnQgb2YgIzEwMCBpcyB1bmNsZWFyXCIgaXNcbiAqIG5vdCBhIGJhY2stcmVmZXJlbmNlLCBhbmQgYSB3b3JkIGJvdW5kYXJ5IG9uIHRoZSBudW1iZXIga2VlcHMgYCMxMDBgIGZyb21cbiAqIG1hdGNoaW5nIGAjMTAwMWAuIENvZGUgc3BhbnMgYXJlIHN0cmlwcGVkIGZpcnN0IChJc3N1ZSAjMzIxOCkgc28gYVxuICogYFBhcmVudDogI05gIHF1b3RlZCBpbiBhIGRvY3VtZW50YXRpb24gc25pcHBldCBjcmVhdGVzIG5vIGNoaWxkIGVkZ2UuXG4gKlxuICogRXZlcnkgd2hpdGVzcGFjZSBydW4gaW4gdGhlIHBhdHRlcm4gaXMgYm91bmRlZCAoSXNzdWUgIzEyNzQpLiBgcGFyZW50XFxzKjo/XFxzKiNgXG4gKiBwdXQgdHdvIHVuYm91bmRlZCB3aGl0ZXNwYWNlIHF1YW50aWZpZXJzIGVpdGhlciBzaWRlIG9mIGFuIG9wdGlvbmFsIGNvbG9uLCBzb1xuICogdGhlIHNwbGl0IGJldHdlZW4gdGhlbSB3YXMgZnVsbHkgYW1iaWd1b3VzOiBgUGFyZW50YCArIDY1IDAwMCBzcGFjZXMgY29zdFxuICogNC4xIHMgaW4gYSBzaW5nbGUgYG1hdGNoQWxsYCwgYW5kIHRoaXMgYm9keSBpcyBhICpyZWZlcmVuY2VkIGNoaWxkIGlzc3VlJ3MqLFxuICogZmV0Y2hlZCBvbmNlIHBlciBgLSBbIF0gI05gIGxpbmUgb2YgdGhlIHBhcmVudCDigJQgYSBwYWRkZWQgYm9keSBwZXIgcmVmZXJlbmNlXG4gKiBtdWx0aXBsaWVzIHRoYXQgb24gdGhlIGNsYWltIHBhdGguIGBzdHJpcENvZGVTcGFuc2AgaXMgbm8gZGVmZW5jZTogaXRcbiAqIHByZXNlcnZlcyB3aGl0ZXNwYWNlIHJ1bnMgdmVyYmF0aW0uIEJvdW5kaW5nIGVhY2ggcnVuIGF0IGVpZ2h0IGNoYXJhY3RlcnNcbiAqIGNhcHMgdGhlIHNwbGl0IGF0IGEgY29uc3RhbnQgd2hpbGUgc3RpbGwgbWF0Y2hpbmcgZXZlcnkgcmVhbCBzcGVsbGluZ1xuICogKGBQYXJlbnQ6ICMxYCwgYFBhcmVudDpcXG4jMWAsIGBQYXJ0ICBvZiAjMWApOyBubyB3b3JrZXIgd3JpdGVzIGVpZ2h0IG9yIG1vcmVcbiAqIHNwYWNlcyBpbnNpZGUgb25lIG9mIHRoZXNlIGxpbmtzLlxuICpcbiAqIEBwYXJhbSBib2R5IC0gVGhlIGNoaWxkIGlzc3VlIGJvZHkgdGV4dFxuICogQHBhcmFtIHBhcmVudE51bWJlciAtIFRoZSBwYXJlbnQgaXNzdWUgbnVtYmVyIHRvIGxvb2sgZm9yXG4gKiBAcmV0dXJucyB0cnVlIGlmIHRoZSBib2R5IHJlZmVyZW5jZXMgdGhlIHBhcmVudFxuICovXG5leHBvcnQgZnVuY3Rpb24gaGFzQmFja1JlZmVyZW5jZShib2R5OiBzdHJpbmcsIHBhcmVudE51bWJlcjogbnVtYmVyKTogYm9vbGVhbiB7XG4gIGlmICghYm9keSkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBzY2FuID0gc3RyaXBDb2RlU3BhbnMoYm9keSk7XG4gIC8vIEEgc3RhdGljIHBhdHRlcm4gY2FwdHVyaW5nIHRoZSBudW1iZXIsIGNvbXBhcmVkIG51bWVyaWNhbGx5IOKAlCBubyBkeW5hbWljXG4gIC8vIFJlZ0V4cCBidWlsdCBmcm9tIGEgY2FsbGVyLXN1cHBsaWVkIHZhbHVlIChSZURvUy9pbmplY3Rpb24gcmlzaykuXG4gIGNvbnN0IHBhcmVudExpbmtQYXR0ZXJuID1cbiAgICAvXFxiKD86cGFydFxcc3sxLDh9b2Z8Y2hpbGRcXHN7MSw4fW9mfHBhcmVudFxcc3swLDh9Oj8pXFxzezAsOH0jKFxcZCspXFxiL2dpO1xuICBmb3IgKGNvbnN0IG1hdGNoIG9mIHNjYW4ubWF0Y2hBbGwocGFyZW50TGlua1BhdHRlcm4pKSB7XG4gICAgaWYgKHBhcnNlSW50KG1hdGNoWzFdISwgMTApID09PSBwYXJlbnROdW1iZXIpIHJldHVybiB0cnVlO1xuICB9XG4gIHJldHVybiBmYWxzZTtcbn1cblxuLyoqIE9uZSBmb3J3YXJkIGRlcGVuZGVuY3kgcmVmZXJlbmNlLCB3aXRoIHRoZSByZXBvIGl0IG5hbWVzIChJc3N1ZSAjMjIyKS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgRGVwZW5kZW5jeVJlZmVyZW5jZSB7XG4gIC8qKiBgb3duZXIvcmVwb2Agd2hlbiB0aGUgcmVmZXJlbmNlIG5hbWVzIG9uZTsgYWJzZW50IGZvciBhIGJhcmUgYCNOYC4gKi9cbiAgcmVwbz86IHN0cmluZztcbiAgLyoqIFRoZSBkZXBlbmRlbmN5J3MgaXNzdWUgbnVtYmVyLiAqL1xuICBudW1iZXI6IG51bWJlcjtcbn1cblxuLyoqXG4gKiBFeHRyYWN0IGZvcndhcmQgZGVwZW5kZW5jeSByZWZlcmVuY2VzLCBrZWVwaW5nIHRoZSByZXBvIGVhY2ggb25lIG5hbWVzLlxuICpcbiAqIERldGVjdHMgcGF0dGVybnMgbGlrZTpcbiAqIC0gXCJEZXBlbmRzIG9uICMxMjNcIiDihpIgYHsgbnVtYmVyOiAxMjMgfWAgKHNhbWUgcmVwbylcbiAqIC0gXCJCbG9ja2VkIGJ5ICMxMjNcIiDihpIgYHsgbnVtYmVyOiAxMjMgfWBcbiAqIC0gXCJEZXBlbmRzIG9uIG93bmVyL3JlcG8jMTIzXCIg4oaSIGB7IHJlcG86IFwib3duZXIvcmVwb1wiLCBudW1iZXI6IDEyMyB9YFxuICpcbiAqIElzc3VlICMyMjI6IHRoZSBjcm9zcy1yZXBvIGZvcm0gcHJldmlvdXNseSBtYXRjaGVkIG5vdGhpbmcgYXQgYWxsLCBzbyBhblxuICogaXNzdWUgZGVmZXJyZWQgb24gYW5vdGhlciByZXBvc2l0b3J5J3MgaXNzdWUgd2FzIG5ldmVyIGdhdGVkLiBJdCBpcyBub3dcbiAqIGNhcnJpZWQgdGhyb3VnaCB3aXRoIGl0cyByZXBvLCBiZWNhdXNlIHJlc29sdmluZyBgb3duZXIvcmVwbyMxMjNgIGFzIGlmIGl0XG4gKiB3ZXJlIHRoaXMgcmVwbydzICMxMjMgd291bGQgZ2F0ZSBvbiBhbiB1bnJlbGF0ZWQgaXNzdWUuXG4gKlxuICogQHBhcmFtIGJvZHkgLSBUaGUgaXNzdWUgYm9keSB0ZXh0LlxuICogQHJldHVybnMgUmVmZXJlbmNlcyBpbiBib2R5IG9yZGVyLCBkZS1kdXBsaWNhdGVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZXh0cmFjdERlcGVuZGVuY3lSZWZlcmVuY2VzRGV0YWlsZWQoXG4gIGJvZHk6IHN0cmluZyxcbik6IERlcGVuZGVuY3lSZWZlcmVuY2VbXSB7XG4gIGlmICghYm9keSkgcmV0dXJuIFtdO1xuXG4gIC8vIElzc3VlICMzMjE4OiBpZ25vcmUgZGVwZW5kZW5jeSBwaHJhc2VzIHF1b3RlZCBpbnNpZGUgY29kZSBleGFtcGxlcyDigJQgYVxuICAvLyBzY2FuLWZpbmRpbmcncyBzdWdnZXN0ZWQtZml4IHNuaXBwZXQgaXMgZG9jdW1lbnRhdGlvbiwgbm90IGEgZGVwZW5kZW5jeS5cbiAgY29uc3Qgc2NhbiA9IHN0cmlwQ29kZVNwYW5zKGJvZHkpO1xuXG4gIGNvbnN0IHJlZnM6IERlcGVuZGVuY3lSZWZlcmVuY2VbXSA9IFtdO1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IGRlcFBhdHRlcm4gPVxuICAgIC8oPzpkZXBlbmRzXFxzK29ufGJsb2NrZWRcXHMrYnkpXFxzKyhbQS1aYS16MC05XVtBLVphLXowLTkuXy1dKlxcL1tBLVphLXowLTkuXy1dKyk/IyhcXGQrKS9naTtcbiAgbGV0IG1hdGNoOiBSZWdFeHBFeGVjQXJyYXkgfCBudWxsO1xuICB3aGlsZSAoKG1hdGNoID0gZGVwUGF0dGVybi5leGVjKHNjYW4pKSAhPT0gbnVsbCkge1xuICAgIGNvbnN0IG51bSA9IHBhcnNlSW50KG1hdGNoWzJdISwgMTApO1xuICAgIGlmIChpc05hTihudW0pKSBjb250aW51ZTtcbiAgICBjb25zdCByZXBvID0gbWF0Y2hbMV07XG4gICAgY29uc3Qga2V5ID0gYCR7KHJlcG8gPz8gXCJcIikudG9Mb3dlckNhc2UoKX0jJHtudW19YDtcbiAgICBpZiAoc2Vlbi5oYXMoa2V5KSkgY29udGludWU7XG4gICAgc2Vlbi5hZGQoa2V5KTtcbiAgICByZWZzLnB1c2goeyAuLi4ocmVwbyA/IHsgcmVwbyB9IDoge30pLCBudW1iZXI6IG51bSB9KTtcbiAgfVxuICByZXR1cm4gcmVmcztcbn1cblxuLyoqXG4gKiBFeHRyYWN0IHNhbWUtcmVwbyBmb3J3YXJkIGRlcGVuZGVuY3kgcmVmZXJlbmNlcyBmcm9tIGFuIGlzc3VlIGJvZHkuXG4gKlxuICogRGV0ZWN0cyBwYXR0ZXJucyBsaWtlOlxuICogLSBcIkRlcGVuZHMgb24gIzEyM1wiXG4gKiAtIFwiQmxvY2tlZCBieSAjMTIzXCJcbiAqXG4gKiBBIGNyb3NzLXJlcG8gcmVmZXJlbmNlIChgRGVwZW5kcyBvbiBvd25lci9yZXBvIzEyM2ApIG5hbWVzIGFuIGlzc3VlIGluXG4gKiBhbm90aGVyIHJlcG9zaXRvcnkgYW5kIGlzIGRlbGliZXJhdGVseSAqKm5vdCoqIHJldHVybmVkIGhlcmUg4oCUIGNhbGxlcnMgdGhhdFxuICogcmVzb2x2ZSBkZXBlbmRlbmNpZXMgYWNyb3NzIHJlcG9zIHVzZVxuICoge0BsaW5rIGV4dHJhY3REZXBlbmRlbmN5UmVmZXJlbmNlc0RldGFpbGVkfS5cbiAqXG4gKiBAcGFyYW0gYm9keSAtIFRoZSBpc3N1ZSBib2R5IHRleHRcbiAqIEByZXR1cm5zIEFycmF5IG9mIGRlcGVuZGVuY3kgaXNzdWUgbnVtYmVycyAoc2FtZS1yZXBvIG9ubHkpXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBleHRyYWN0RGVwZW5kZW5jeVJlZmVyZW5jZXMoYm9keTogc3RyaW5nKTogbnVtYmVyW10ge1xuICBjb25zdCBudW1iZXJzID0gZXh0cmFjdERlcGVuZGVuY3lSZWZlcmVuY2VzRGV0YWlsZWQoYm9keSlcbiAgICAuZmlsdGVyKChyZWYpID0+IHJlZi5yZXBvID09PSB1bmRlZmluZWQpXG4gICAgLm1hcCgocmVmKSA9PiByZWYubnVtYmVyKTtcbiAgcmV0dXJuIFsuLi5uZXcgU2V0KG51bWJlcnMpXS5zb3J0KChhLCBiKSA9PiBhIC0gYik7XG59XG5cbi8qKlxuICogT3B0aW9uYWwgcHJlLWJ1aWx0IGxvb2t1cCBvZiBjdXJyZW50bHktb3BlbiBpc3N1ZSBudW1iZXJzIGZvciBhXG4gKiBzaW5nbGUgcmVwb3NpdG9yeSAoSXNzdWUgIzE4MDgpLlxuICpcbiAqIFdoZW4gYSBjYWxsZXIgYWxyZWFkeSBob2xkcyB0aGUgY2FjaGVkIGBmZXRjaEFsbElzc3Vlc2AgcmVzdWx0IGZvclxuICogdGhlIHJlcG8sIGl0IGNhbiBkZXJpdmUgdGhpcyBtYXAgb25jZSBhbmQgcGFzcyBpdCB0b1xuICogYGNoZWNrUGFyZW50QmxvY2tlZGAgc28gcGVyLWNoaWxkIGBnZXRJc3N1ZVN0YXRlYCBjYWxscyBjb2xsYXBzZSB0b1xuICogbG9jYWwgbWFwIHJlYWRzLiBJc3N1ZSBudW1iZXJzIGFic2VudCBmcm9tIHRoZSBtYXAgYXJlIGxvb2tlZCB1cFxuICogdmlhIHRoZSByZWd1bGFyIHBlci1pc3N1ZSBmYWxsYmFjay5cbiAqL1xuZXhwb3J0IHR5cGUgT3Blbklzc3VlU3RhdGVNYXAgPSBNYXA8bnVtYmVyLCBcIk9QRU5cIj47XG5cbi8qKlxuICogQnVpbGQgYSBjYXNlLWluc2Vuc2l0aXZlLCB0cmltbWVkIFwiaXMgdGhpcyB0aGUgcGFyZW50J3Mgb3duIHJlcG9cIiB0ZXN0XG4gKiAoSXNzdWUgIzMzMTkpLiBNaXJyb3JzIGBpc1NhbWVSZXBvYCBpbiBgaXNzdWVfZmluZGVyX2NvbW1vbi50c2Anc1xuICogYGlzRGVwZW5kZW5jeUJsb2NrZWRgLlxuICovXG5mdW5jdGlvbiBjaGlsZElzU2FtZVJlcG8ocGFyZW50UmVwbzogc3RyaW5nKTogKHJlcG86IHN0cmluZykgPT4gYm9vbGVhbiB7XG4gIGNvbnN0IG5vcm1hbGlzZWQgPSBwYXJlbnRSZXBvLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICByZXR1cm4gKHJlcG86IHN0cmluZykgPT4gcmVwby50cmltKCkudG9Mb3dlckNhc2UoKSA9PT0gbm9ybWFsaXNlZDtcbn1cblxuLyoqXG4gKiBDaGVjayB3aGV0aGVyIGEgcGFyZW50IGlzc3VlIGlzIGJsb2NrZWQgYnkgb3BlbiBjaGlsZCBpc3N1ZXMuXG4gKlxuICogQSBwYXJlbnQgaXNzdWUgaXMgYmxvY2tlZCBpZiBpdCBoYXMgc3ViLWlzc3VlcyBhbmQgYW55IG9mIHRoZW0gYXJlIHN0aWxsIG9wZW4uXG4gKiBUaGlzIGltcGxlbWVudHMgdGhlIGNvcmUgcmVxdWlyZW1lbnQgb2YgSXNzdWUgIzQ4NDogcGFyZW50IGlzc3VlcyBzaG91bGQgbm90XG4gKiBiZSB3b3JrZWQgb24gYmVmb3JlIGNoaWxkIGlzc3VlcyBhcmUgY29tcGxldGVkLlxuICpcbiAqIEBwYXJhbSBmZXRjaGVyIC0gSW5qZWN0YWJsZSBpc3N1ZSBkYXRhIGZldGNoZXJcbiAqIEBwYXJhbSByZXBvIC0gUmVwb3NpdG9yeSBpbiBcIm93bmVyL3JlcG9cIiBmb3JtYXRcbiAqIEBwYXJhbSBpc3N1ZU51bWJlciAtIFRoZSBpc3N1ZSBudW1iZXIgdG8gY2hlY2tcbiAqIEBwYXJhbSBvcGVuU3RhdGVNYXAgLSBPcHRpb25hbCBjYWNoZWQgb3Blbi1zdGF0ZSBtYXAgKElzc3VlICMxODA4KS5cbiAqICAgV2hlbiBzdXBwbGllZCwgY2hpbGQgaXNzdWVzIHByZXNlbnQgaW4gdGhlIG1hcCBhcmUgcmVzb2x2ZWRcbiAqICAgd2l0aG91dCBhIHBlci1pc3N1ZSBgZ2V0SXNzdWVTdGF0ZWAgY2FsbC4gQ2hpbGRyZW4gYWJzZW50IGZyb21cbiAqICAgdGhlIG1hcCBmYWxsIGJhY2sgdG8gdGhlIGZldGNoZXIgKGNsb3NlZCAvIG5vdC15ZXQtbG9hZGVkIHBhdGgpLlxuICogQHJldHVybnMgUmVzdWx0IGNvbnRhaW5pbmcgYmxvY2tlZCBzdGF0dXMgYW5kIGRldGFpbHMuIElzc3VlICMzMzIxOiBhXG4gKiAgIGBnZXRTdWJJc3N1ZXNgIHJlamVjdGlvbiAoYSBsb29rdXAgZmFpbHVyZSkgcHJvcGFnYXRlcyBhcyBgeyBvazogZmFsc2UgfWBcbiAqICAgaGVyZSwgd2hpY2ggYGlzRGVwZW5kZW5jeUJsb2NrZWRgIHRyZWF0cyBhcyBibG9ja2VkIHJhdGhlciB0aGFuXG4gKiAgIGNsYWltYWJsZS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNoZWNrUGFyZW50QmxvY2tlZChcbiAgZmV0Y2hlcjogSXNzdWVGZXRjaGVyLFxuICByZXBvOiBzdHJpbmcsXG4gIGlzc3VlTnVtYmVyOiBudW1iZXIsXG4gIG9wZW5TdGF0ZU1hcD86IE9wZW5Jc3N1ZVN0YXRlTWFwLFxuKTogUHJvbWlzZTxSZXN1bHQ8UGFyZW50QmxvY2tlZFJlc3VsdD4+IHtcbiAgdHJ5IHtcbiAgICAvLyBHZXQgc3ViLWlzc3VlcyBmb3IgdGhpcyBpc3N1ZSDigJQgZWFjaCBrZWVwcyBpdHMgb3duIHJlcG8gKElzc3VlICMzMzE5KS5cbiAgICBjb25zdCBhcGlDaGlsZHJlbiA9IGF3YWl0IGZldGNoZXIuZ2V0U3ViSXNzdWVzKHJlcG8sIGlzc3VlTnVtYmVyKTtcblxuICAgIC8vIEFsc28gY2hlY2sgdGhlIGlzc3VlIGJvZHkgZm9yIHRhc2sgbGlzdCByZWZlcmVuY2VzLCBidXQgb25seSBpbmNsdWRlXG4gICAgLy8gdGhvc2Ugd2hlcmUgdGhlIHJlZmVyZW5jZWQgaXNzdWUgbGlua3MgYmFjayAoZS5nLiBcIlBhcnQgb2YgI3BhcmVudFwiKS5cbiAgICAvLyBXaXRob3V0IHRoaXMgYmktZGlyZWN0aW9uYWwgY2hlY2ssIHBsYWluIGNoZWNrbGlzdCBpdGVtcyBsaWtlXG4gICAgLy8gXCItIFsgXSAjNzQ3IGJvZHkgdXBkYXRlZFwiIGFyZSB3cm9uZ2x5IHRyZWF0ZWQgYXMgYmxvY2tpbmcgc3ViLWlzc3Vlc1xuICAgIC8vIChzZWUgRkxFRVQjMTQ3MikuIEJvZHktZGVyaXZlZCByZWZzIGFyZSBhbHdheXMgc2FtZS1yZXBvLlxuICAgIGNvbnN0IGNoaWxkTWFwID0gbmV3IE1hcDxzdHJpbmcsIFN1Yklzc3VlUmVmPigpO1xuICAgIGNvbnN0IGNoaWxkS2V5ID0gKHJlZjogU3ViSXNzdWVSZWYpID0+XG4gICAgICBgJHtyZWYucmVwby50cmltKCkudG9Mb3dlckNhc2UoKX0jJHtyZWYubnVtYmVyfWA7XG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiBhcGlDaGlsZHJlbikgY2hpbGRNYXAuc2V0KGNoaWxkS2V5KGNoaWxkKSwgY2hpbGQpO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGJvZHkgPSBhd2FpdCBmZXRjaGVyLmdldElzc3VlQm9keShyZXBvLCBpc3N1ZU51bWJlcik7XG4gICAgICBjb25zdCBib2R5UmVmcyA9IGV4dHJhY3RTdWJJc3N1ZVJlZmVyZW5jZXMoYm9keSwgcmVwbyk7XG4gICAgICBmb3IgKGNvbnN0IHJlZiBvZiBib2R5UmVmcykge1xuICAgICAgICBjb25zdCBjYW5kaWRhdGU6IFN1Yklzc3VlUmVmID0geyByZXBvLCBudW1iZXI6IHJlZiB9O1xuICAgICAgICBpZiAoY2hpbGRNYXAuaGFzKGNoaWxkS2V5KGNhbmRpZGF0ZSkpKSBjb250aW51ZTsgLy8gQWxyZWFkeSBjb25maXJtZWQgdmlhIEFQSVxuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IHJlZkJvZHkgPSBhd2FpdCBmZXRjaGVyLmdldElzc3VlQm9keShyZXBvLCByZWYpO1xuICAgICAgICAgIGlmIChoYXNCYWNrUmVmZXJlbmNlKHJlZkJvZHksIGlzc3VlTnVtYmVyKSkge1xuICAgICAgICAgICAgY2hpbGRNYXAuc2V0KGNoaWxkS2V5KGNhbmRpZGF0ZSksIGNhbmRpZGF0ZSk7XG4gICAgICAgICAgfVxuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAvLyBDYW4ndCB2ZXJpZnkgYmFjay1yZWZlcmVuY2Ug4oCUIGRvIE5PVCBhc3N1bWUgaXQncyBhIGNoaWxkXG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIElmIHdlIGNhbid0IGdldCB0aGUgYm9keSwgY29udGludWUgd2l0aCBqdXN0IHN1Yi1pc3N1ZXMgZnJvbSBBUElcbiAgICB9XG5cbiAgICBjb25zdCBhbGxDaGlsZHJlbiA9IFsuLi5jaGlsZE1hcC52YWx1ZXMoKV07XG5cbiAgICAvLyBObyBjaGlsZHJlbiBhdCBhbGwg4oCUIG5vdCBibG9ja2VkXG4gICAgaWYgKGFsbENoaWxkcmVuLmxlbmd0aCA9PT0gMCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IHRydWUsXG4gICAgICAgIHZhbHVlOiB7XG4gICAgICAgICAgaXNCbG9ja2VkOiBmYWxzZSxcbiAgICAgICAgICBvcGVuQ2hpbGRyZW46IFtdLFxuICAgICAgICAgIGNsb3NlZENoaWxkcmVuOiBbXSxcbiAgICAgICAgICB0b3RhbENoaWxkcmVuOiAwLFxuICAgICAgICB9LFxuICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyBDaGVjayB0aGUgc3RhdGUgb2YgZWFjaCBjaGlsZFxuICAgIGNvbnN0IG9wZW5DaGlsZHJlbjogU3ViSXNzdWVSZWZbXSA9IFtdO1xuICAgIGNvbnN0IGNsb3NlZENoaWxkcmVuOiBTdWJJc3N1ZVJlZltdID0gW107XG4gICAgY29uc3Qgc2FtZVJlcG8gPSBjaGlsZElzU2FtZVJlcG8ocmVwbyk7XG5cbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIGFsbENoaWxkcmVuKSB7XG4gICAgICAvLyBJc3N1ZSAjMTgwODogcHJlZmVyIHRoZSBjYWNoZWQgb3Blbi1zdGF0ZSBtYXAsIGJ1dCBvbmx5IGZvciBhXG4gICAgICAvLyBzYW1lLXJlcG8gY2hpbGQg4oCUIHRoZSBtYXAgaXMgcGVyLXJlcG9zaXRvcnkgYW5kIGEgY3Jvc3MtcmVwb1xuICAgICAgLy8gY2hpbGQncyBudW1iZXIgaGFzIG5vIG1lYW5pbmcgaW4gaXQuXG4gICAgICBpZiAoc2FtZVJlcG8oY2hpbGQucmVwbykgJiYgb3BlblN0YXRlTWFwPy5oYXMoY2hpbGQubnVtYmVyKSkge1xuICAgICAgICBvcGVuQ2hpbGRyZW4ucHVzaChjaGlsZCk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgY2hpbGRTdGF0ZSA9IGF3YWl0IGZldGNoZXIuZ2V0SXNzdWVTdGF0ZShcbiAgICAgICAgICBjaGlsZC5yZXBvLFxuICAgICAgICAgIGNoaWxkLm51bWJlcixcbiAgICAgICAgKTtcbiAgICAgICAgaWYgKGNoaWxkU3RhdGUuc3RhdGUgPT09IFwiT1BFTlwiKSB7XG4gICAgICAgICAgb3BlbkNoaWxkcmVuLnB1c2goY2hpbGQpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGNsb3NlZENoaWxkcmVuLnB1c2goY2hpbGQpO1xuICAgICAgICB9XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gSWYgd2UgY2FuJ3QgY2hlY2sgYSBjaGlsZCdzIHN0YXRlLCBhc3N1bWUgaXQncyBvcGVuIChmYWlsIGNsb3NlZFxuICAgICAgICAvLyBmb3IgcGFyZW50IGJsb2NraW5nIOKAlCB3ZSBkb24ndCB3YW50IHRvIHdvcmsgb24gYSBwYXJlbnQgaWYgd2VcbiAgICAgICAgLy8gY2FuJ3QgdmVyaWZ5IGNoaWxkcmVuIGFyZSBkb25lKVxuICAgICAgICBvcGVuQ2hpbGRyZW4ucHVzaChjaGlsZCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgYnlSZXBvVGhlbk51bWJlciA9IChhOiBTdWJJc3N1ZVJlZiwgYjogU3ViSXNzdWVSZWYpID0+IHtcbiAgICAgIGNvbnN0IHJlcG9DbXAgPSBhLnJlcG8udG9Mb3dlckNhc2UoKS5sb2NhbGVDb21wYXJlKGIucmVwby50b0xvd2VyQ2FzZSgpKTtcbiAgICAgIHJldHVybiByZXBvQ21wICE9PSAwID8gcmVwb0NtcCA6IGEubnVtYmVyIC0gYi5udW1iZXI7XG4gICAgfTtcblxuICAgIHJldHVybiB7XG4gICAgICBvazogdHJ1ZSxcbiAgICAgIHZhbHVlOiB7XG4gICAgICAgIGlzQmxvY2tlZDogb3BlbkNoaWxkcmVuLmxlbmd0aCA+IDAsXG4gICAgICAgIG9wZW5DaGlsZHJlbjogb3BlbkNoaWxkcmVuLnNvcnQoYnlSZXBvVGhlbk51bWJlciksXG4gICAgICAgIGNsb3NlZENoaWxkcmVuOiBjbG9zZWRDaGlsZHJlbi5zb3J0KGJ5UmVwb1RoZW5OdW1iZXIpLFxuICAgICAgICB0b3RhbENoaWxkcmVuOiBhbGxDaGlsZHJlbi5sZW5ndGgsXG4gICAgICB9LFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IgOiBuZXcgRXJyb3IoU3RyaW5nKGVycm9yKSksXG4gICAgfTtcbiAgfVxufVxuXG4vKipcbiAqIEJ1aWxkIGEgZGVwZW5kZW5jeSBncmFwaCBmb3IgYSBzZXQgb2YgaXNzdWVzLlxuICpcbiAqIENvbnN0cnVjdHMgYSBncmFwaCB0aGF0IGluY2x1ZGVzIGJvdGggZm9yd2FyZCBkZXBlbmRlbmNpZXMgKFwiRGVwZW5kcyBvbiAjTlwiKVxuICogYW5kIHBhcmVudC9jaGlsZCByZWxhdGlvbnNoaXBzLiBUaGlzIGVuYWJsZXMgdG9wb2xvZ2ljYWwgb3JkZXJpbmcgdG9cbiAqIGRldGVybWluZSB3aGljaCBpc3N1ZXMgY2FuIGJlIHdvcmtlZCBvbiBmaXJzdC5cbiAqXG4gKiBAcGFyYW0gZmV0Y2hlciAtIEluamVjdGFibGUgaXNzdWUgZGF0YSBmZXRjaGVyXG4gKiBAcGFyYW0gcmVwbyAtIFJlcG9zaXRvcnkgaW4gXCJvd25lci9yZXBvXCIgZm9ybWF0XG4gKiBAcGFyYW0gaXNzdWVOdW1iZXJzIC0gVGhlIGlzc3VlIG51bWJlcnMgdG8gYW5hbHlzZVxuICogQHJldHVybnMgQXJyYXkgb2YgZGVwZW5kZW5jeSBub2Rlc1xuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gYnVpbGREZXBlbmRlbmN5R3JhcGgoXG4gIGZldGNoZXI6IElzc3VlRmV0Y2hlcixcbiAgcmVwbzogc3RyaW5nLFxuICBpc3N1ZU51bWJlcnM6IG51bWJlcltdLFxuKTogUHJvbWlzZTxEZXBlbmRlbmN5Tm9kZVtdPiB7XG4gIGNvbnN0IG5vZGVzOiBEZXBlbmRlbmN5Tm9kZVtdID0gW107XG4gIGNvbnN0IGlzc3VlU2V0ID0gbmV3IFNldChpc3N1ZU51bWJlcnMpO1xuXG4gIGZvciAoY29uc3QgaXNzdWVOdW1iZXIgb2YgaXNzdWVOdW1iZXJzKSB7XG4gICAgY29uc3QgZGVwZW5kc09uOiBudW1iZXJbXSA9IFtdO1xuICAgIGxldCBjaGlsZE9mOiBudW1iZXIgfCB1bmRlZmluZWQ7XG5cbiAgICB0cnkge1xuICAgICAgLy8gQ2hlY2sgZm9yd2FyZCBkZXBlbmRlbmNpZXNcbiAgICAgIGNvbnN0IGJvZHkgPSBhd2FpdCBmZXRjaGVyLmdldElzc3VlQm9keShyZXBvLCBpc3N1ZU51bWJlcik7XG4gICAgICBjb25zdCBmb3J3YXJkRGVwcyA9IGV4dHJhY3REZXBlbmRlbmN5UmVmZXJlbmNlcyhib2R5KTtcblxuICAgICAgLy8gT25seSBpbmNsdWRlIGRlcGVuZGVuY2llcyB3aXRoaW4gb3VyIGlzc3VlIHNldFxuICAgICAgZm9yIChjb25zdCBkZXAgb2YgZm9yd2FyZERlcHMpIHtcbiAgICAgICAgaWYgKGlzc3VlU2V0LmhhcyhkZXApKSB7XG4gICAgICAgICAgZGVwZW5kc09uLnB1c2goZGVwKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBDaGVjayBpZiB0aGlzIGlzc3VlIGlzIGEgY2hpbGQgb2YgYW55IG90aGVyIGlzc3VlIGluIHRoZSBzZXRcbiAgICAgIGZvciAoY29uc3QgcG90ZW50aWFsUGFyZW50IG9mIGlzc3VlTnVtYmVycykge1xuICAgICAgICBpZiAocG90ZW50aWFsUGFyZW50ID09PSBpc3N1ZU51bWJlcikgY29udGludWU7XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBwYXJlbnRCb2R5ID0gYXdhaXQgZmV0Y2hlci5nZXRJc3N1ZUJvZHkocmVwbywgcG90ZW50aWFsUGFyZW50KTtcbiAgICAgICAgICBjb25zdCBjaGlsZFJlZnMgPSBleHRyYWN0U3ViSXNzdWVSZWZlcmVuY2VzKHBhcmVudEJvZHksIHJlcG8pO1xuICAgICAgICAgIGlmIChjaGlsZFJlZnMuaW5jbHVkZXMoaXNzdWVOdW1iZXIpKSB7XG4gICAgICAgICAgICBjaGlsZE9mID0gcG90ZW50aWFsUGFyZW50O1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAvLyBTa2lwIGlmIHdlIGNhbid0IHJlYWQgcGFyZW50IGJvZHlcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBHZXQgaXNzdWUgc3RhdGVcbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZmV0Y2hlci5nZXRJc3N1ZVN0YXRlKHJlcG8sIGlzc3VlTnVtYmVyKTtcblxuICAgICAgbm9kZXMucHVzaCh7XG4gICAgICAgIGlzc3VlTnVtYmVyLFxuICAgICAgICBkZXBlbmRzT24sXG4gICAgICAgIGNoaWxkT2YsXG4gICAgICAgIHN0YXRlOiBzdGF0ZS5zdGF0ZSxcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gSWYgd2UgY2FuJ3QgZmV0Y2ggZGF0YSBmb3IgYW4gaXNzdWUsIGFkZCBpdCB3aXRoIHVua25vd24gc3RhdGVcbiAgICAgIG5vZGVzLnB1c2goe1xuICAgICAgICBpc3N1ZU51bWJlcixcbiAgICAgICAgZGVwZW5kc09uOiBbXSxcbiAgICAgICAgc3RhdGU6IFwiT1BFTlwiLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIG5vZGVzO1xufVxuXG4vKipcbiAqIFJlc29sdmUgdGhlIHdvcmsgb3JkZXIgZm9yIGEgc2V0IG9mIGlzc3VlcyBiYXNlZCBvbiB0aGVpciBkZXBlbmRlbmNpZXMuXG4gKlxuICogVXNlcyB0b3BvbG9naWNhbCBzb3J0IHRvIGRldGVybWluZSB3aGljaCBpc3N1ZXMgYXJlIHJlYWR5IHRvIHdvcmsgb24sXG4gKiB3aGljaCBhcmUgYmxvY2tlZCwgYW5kIHdoaWNoIGhhdmUgY2lyY3VsYXIgZGVwZW5kZW5jaWVzLlxuICpcbiAqIElzc3VlcyBhcmUgXCJyZWFkeVwiIGlmOlxuICogMS4gQWxsIHRoZWlyIGZvcndhcmQgZGVwZW5kZW5jaWVzIGFyZSBjbG9zZWRcbiAqIDIuIFRoZXkgYXJlIG5vdCBhIHBhcmVudCB3aXRoIG9wZW4gY2hpbGRyZW5cbiAqIDMuIFRoZXkgYXJlIE9QRU4gKGNsb3NlZCBpc3N1ZXMgYXJlIGV4Y2x1ZGVkKVxuICpcbiAqIEBwYXJhbSBub2RlcyAtIERlcGVuZGVuY3kgZ3JhcGggbm9kZXNcbiAqIEByZXR1cm5zIFdvcmsgb3JkZXIgcmVzdWx0IHdpdGggcmVhZHksIGJsb2NrZWQsIGFuZCBjaXJjdWxhciBpc3N1ZXNcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVXb3JrT3JkZXIobm9kZXM6IERlcGVuZGVuY3lOb2RlW10pOiBXb3JrT3JkZXJSZXN1bHQge1xuICBjb25zdCByZWFkeTogbnVtYmVyW10gPSBbXTtcbiAgY29uc3QgYmxvY2tlZDogQXJyYXk8eyBpc3N1ZTogbnVtYmVyOyBibG9ja2VkQnk6IG51bWJlcltdIH0+ID0gW107XG4gIGNvbnN0IGNpcmN1bGFyOiBudW1iZXJbXSA9IFtdO1xuXG4gIC8vIEJ1aWxkIGxvb2t1cCBtYXBzXG4gIGNvbnN0IG5vZGVNYXAgPSBuZXcgTWFwPG51bWJlciwgRGVwZW5kZW5jeU5vZGU+KCk7XG4gIGNvbnN0IGNoaWxkcmVuTWFwID0gbmV3IE1hcDxudW1iZXIsIG51bWJlcltdPigpO1xuXG4gIGZvciAoY29uc3Qgbm9kZSBvZiBub2Rlcykge1xuICAgIG5vZGVNYXAuc2V0KG5vZGUuaXNzdWVOdW1iZXIsIG5vZGUpO1xuICAgIGlmIChub2RlLmNoaWxkT2YgIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3QgZXhpc3RpbmcgPSBjaGlsZHJlbk1hcC5nZXQobm9kZS5jaGlsZE9mKSA/PyBbXTtcbiAgICAgIGV4aXN0aW5nLnB1c2gobm9kZS5pc3N1ZU51bWJlcik7XG4gICAgICBjaGlsZHJlbk1hcC5zZXQobm9kZS5jaGlsZE9mLCBleGlzdGluZyk7XG4gICAgfVxuICB9XG5cbiAgLy8gRGV0ZWN0IGNpcmN1bGFyIGRlcGVuZGVuY2llcyB1c2luZyBERlNcbiAgY29uc3QgdmlzaXRlZCA9IG5ldyBTZXQ8bnVtYmVyPigpO1xuICBjb25zdCBpblN0YWNrID0gbmV3IFNldDxudW1iZXI+KCk7XG5cbiAgZnVuY3Rpb24gaGFzQ3ljbGUobm9kZU51bTogbnVtYmVyKTogYm9vbGVhbiB7XG4gICAgaWYgKGluU3RhY2suaGFzKG5vZGVOdW0pKSByZXR1cm4gdHJ1ZTtcbiAgICBpZiAodmlzaXRlZC5oYXMobm9kZU51bSkpIHJldHVybiBmYWxzZTtcblxuICAgIHZpc2l0ZWQuYWRkKG5vZGVOdW0pO1xuICAgIGluU3RhY2suYWRkKG5vZGVOdW0pO1xuXG4gICAgY29uc3Qgbm9kZSA9IG5vZGVNYXAuZ2V0KG5vZGVOdW0pO1xuICAgIGlmIChub2RlKSB7XG4gICAgICBmb3IgKGNvbnN0IGRlcCBvZiBub2RlLmRlcGVuZHNPbikge1xuICAgICAgICBpZiAoaGFzQ3ljbGUoZGVwKSkgcmV0dXJuIHRydWU7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaW5TdGFjay5kZWxldGUobm9kZU51bSk7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgZm9yIChjb25zdCBub2RlIG9mIG5vZGVzKSB7XG4gICAgdmlzaXRlZC5jbGVhcigpO1xuICAgIGluU3RhY2suY2xlYXIoKTtcbiAgICBpZiAoaGFzQ3ljbGUobm9kZS5pc3N1ZU51bWJlcikpIHtcbiAgICAgIGNpcmN1bGFyLnB1c2gobm9kZS5pc3N1ZU51bWJlcik7XG4gICAgfVxuICB9XG5cbiAgLy8gQ2xhc3NpZnkgZWFjaCBvcGVuIGlzc3VlXG4gIGZvciAoY29uc3Qgbm9kZSBvZiBub2Rlcykge1xuICAgIC8vIFNraXAgY2xvc2VkIGlzc3Vlc1xuICAgIGlmIChub2RlLnN0YXRlID09PSBcIkNMT1NFRFwiKSBjb250aW51ZTtcblxuICAgIC8vIFNraXAgY2lyY3VsYXIgZGVwZW5kZW5jaWVzXG4gICAgaWYgKGNpcmN1bGFyLmluY2x1ZGVzKG5vZGUuaXNzdWVOdW1iZXIpKSBjb250aW51ZTtcblxuICAgIGNvbnN0IGJsb2NrZWRCeTogbnVtYmVyW10gPSBbXTtcblxuICAgIC8vIENoZWNrIGZvcndhcmQgZGVwZW5kZW5jaWVzIOKAlCBibG9ja2VkIGlmIGFueSBkZXBlbmRlbmN5IGlzIHN0aWxsIG9wZW5cbiAgICBmb3IgKGNvbnN0IGRlcCBvZiBub2RlLmRlcGVuZHNPbikge1xuICAgICAgY29uc3QgZGVwTm9kZSA9IG5vZGVNYXAuZ2V0KGRlcCk7XG4gICAgICBpZiAoZGVwTm9kZSAmJiBkZXBOb2RlLnN0YXRlID09PSBcIk9QRU5cIikge1xuICAgICAgICBibG9ja2VkQnkucHVzaChkZXApO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIENoZWNrIGlmIHRoaXMgaXMgYSBwYXJlbnQgd2l0aCBvcGVuIGNoaWxkcmVuXG4gICAgY29uc3QgY2hpbGRyZW4gPSBjaGlsZHJlbk1hcC5nZXQobm9kZS5pc3N1ZU51bWJlcikgPz8gW107XG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiBjaGlsZHJlbikge1xuICAgICAgY29uc3QgY2hpbGROb2RlID0gbm9kZU1hcC5nZXQoY2hpbGQpO1xuICAgICAgaWYgKGNoaWxkTm9kZSAmJiBjaGlsZE5vZGUuc3RhdGUgPT09IFwiT1BFTlwiKSB7XG4gICAgICAgIGJsb2NrZWRCeS5wdXNoKGNoaWxkKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoYmxvY2tlZEJ5Lmxlbmd0aCA+IDApIHtcbiAgICAgIGJsb2NrZWQucHVzaCh7XG4gICAgICAgIGlzc3VlOiBub2RlLmlzc3VlTnVtYmVyLFxuICAgICAgICBibG9ja2VkQnk6IGJsb2NrZWRCeS5zb3J0KChhLCBiKSA9PiBhIC0gYiksXG4gICAgICB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgcmVhZHkucHVzaChub2RlLmlzc3VlTnVtYmVyKTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4ge1xuICAgIHJlYWR5OiByZWFkeS5zb3J0KChhLCBiKSA9PiBhIC0gYiksXG4gICAgYmxvY2tlZCxcbiAgICBjaXJjdWxhcjogY2lyY3VsYXIuc29ydCgoYSwgYikgPT4gYSAtIGIpLFxuICB9O1xufVxuXG4vKipcbiAqIERldGVjdCB3aGljaCBpc3N1ZXMgbGllIG9uIGEgZGVwZW5kZW5jeS9wYXJlbnQgY3ljbGUgKElzc3VlICMyNzUyKS5cbiAqXG4gKiBBIGN5Y2xlIGV4aXN0cyB3aGVuIGFuIGlzc3VlICh0cmFuc2l0aXZlbHkpIGJsb2NrcyBpdHNlbGYg4oCUIGUuZy5cbiAqIEEgZGVwZW5kcyBvbiBCIGFuZCBCIGRlcGVuZHMgb24gQSAoQeKGkkLihpJBKSwgb3IgYSBwYXJlbnQvY2hpbGQgbG9vcC5cbiAqIFRoZSBibG9ja2luZyBlZGdlcyBhcmU6XG4gKiAgIC0gZm9yd2FyZCBkZXBlbmRlbmN5OiBgQS5kZXBlbmRzT25gIGluY2x1ZGVzIEIgIOKHkiAgQeKGkkIgKFwiQSBibG9ja2VkIGJ5IEJcIilcbiAqICAgLSBwYXJlbnQvY2hpbGQ6ICAgICAgIGBCLmNoaWxkT2YgPT09IEFgICAgICAgICAg4oeSICBB4oaSQiAoXCJBIGJsb2NrZWQgYnkgQlwiKVxuICpcbiAqIFJldHVybnMgb25seSB0aGUgaXNzdWVzIHRoYXQgZ2VudWluZWx5IHNpdCAqb24qIGEgY3ljbGUgKHRob3NlIHRoYXQgY2FuXG4gKiByZWFjaCB0aGVtc2VsdmVzIHRocm91Z2ggdGhlIGJsb2NraW5nIGVkZ2VzKS4gQW4gaXNzdWUgdGhhdCBtZXJlbHkgcG9pbnRzXG4gKiAqaW50byogYSBjeWNsZSB3aXRob3V0IGJlaW5nIHBhcnQgb2YgaXQgaXMgbm90IGZsYWdnZWQuIEFuIGFjeWNsaWMgZ3JhcGhcbiAqIHJldHVybnMgYW4gZW1wdHkgYXJyYXkuXG4gKlxuICogQHBhcmFtIG5vZGVzIC0gRGVwZW5kZW5jeSBncmFwaCBub2Rlc1xuICogQHJldHVybnMgU29ydGVkIGlzc3VlIG51bWJlcnMgdGhhdCBwYXJ0aWNpcGF0ZSBpbiBhIGN5Y2xlXG4gKi9cbi8qKlxuICogQnVpbGQgdGhlIFwiaXMgYmxvY2tlZCBieVwiIGFkamFjZW5jeSBmb3IgYSBkZXBlbmRlbmN5IGdyYXBoOiBhbiBlZGdlIEHihpJCXG4gKiBtZWFucyBcIkEgaXMgYmxvY2tlZCBieSBCXCIuIEZvcndhcmQgZGVwZW5kZW5jaWVzIGNvbnRyaWJ1dGUgQeKGkmRlcDsgYVxuICogcGFyZW50L2NoaWxkIHJlbGF0aW9uc2hpcCBjb250cmlidXRlcyBwYXJlbnTihpJjaGlsZC5cbiAqL1xuZnVuY3Rpb24gYnVpbGRCbG9ja2luZ0FkamFjZW5jeShcbiAgbm9kZXM6IERlcGVuZGVuY3lOb2RlW10sXG4pOiBNYXA8bnVtYmVyLCBTZXQ8bnVtYmVyPj4ge1xuICBjb25zdCBhZGphY2VuY3kgPSBuZXcgTWFwPG51bWJlciwgU2V0PG51bWJlcj4+KCk7XG4gIGNvbnN0IGVuc3VyZSA9IChuOiBudW1iZXIpOiBTZXQ8bnVtYmVyPiA9PiB7XG4gICAgbGV0IHNldCA9IGFkamFjZW5jeS5nZXQobik7XG4gICAgaWYgKCFzZXQpIHtcbiAgICAgIHNldCA9IG5ldyBTZXQ8bnVtYmVyPigpO1xuICAgICAgYWRqYWNlbmN5LnNldChuLCBzZXQpO1xuICAgIH1cbiAgICByZXR1cm4gc2V0O1xuICB9O1xuXG4gIGZvciAoY29uc3Qgbm9kZSBvZiBub2Rlcykge1xuICAgIGNvbnN0IGZyb20gPSBlbnN1cmUobm9kZS5pc3N1ZU51bWJlcik7XG4gICAgZm9yIChjb25zdCBkZXAgb2Ygbm9kZS5kZXBlbmRzT24pIHtcbiAgICAgIGZyb20uYWRkKGRlcCk7XG4gICAgICBlbnN1cmUoZGVwKTtcbiAgICB9XG4gICAgaWYgKG5vZGUuY2hpbGRPZiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAvLyBUaGUgcGFyZW50IGlzIGJsb2NrZWQgYnkgdGhpcyBjaGlsZC5cbiAgICAgIGVuc3VyZShub2RlLmNoaWxkT2YpLmFkZChub2RlLmlzc3VlTnVtYmVyKTtcbiAgICAgIGVuc3VyZShub2RlLmlzc3VlTnVtYmVyKTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gYWRqYWNlbmN5O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZGV0ZWN0RGVwZW5kZW5jeUN5Y2xlcyhub2RlczogRGVwZW5kZW5jeU5vZGVbXSk6IG51bWJlcltdIHtcbiAgY29uc3QgYWRqYWNlbmN5ID0gYnVpbGRCbG9ja2luZ0FkamFjZW5jeShub2Rlcyk7XG5cbiAgY29uc3Qgb25DeWNsZSA9IG5ldyBTZXQ8bnVtYmVyPigpO1xuICBmb3IgKGNvbnN0IHN0YXJ0IG9mIGFkamFjZW5jeS5rZXlzKCkpIHtcbiAgICAvLyBERlMgZnJvbSBgc3RhcnRgOiBpdCBpcyBvbiBhIGN5Y2xlIGlmZiBpdCBjYW4gcmVhY2ggaXRzZWxmLlxuICAgIGNvbnN0IHN0YWNrID0gWy4uLihhZGphY2VuY3kuZ2V0KHN0YXJ0KSA/PyBbXSldO1xuICAgIGNvbnN0IHNlZW4gPSBuZXcgU2V0PG51bWJlcj4oKTtcbiAgICB3aGlsZSAoc3RhY2subGVuZ3RoID4gMCkge1xuICAgICAgY29uc3QgY3VycmVudCA9IHN0YWNrLnBvcCgpITtcbiAgICAgIGlmIChjdXJyZW50ID09PSBzdGFydCkge1xuICAgICAgICBvbkN5Y2xlLmFkZChzdGFydCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgaWYgKHNlZW4uaGFzKGN1cnJlbnQpKSBjb250aW51ZTtcbiAgICAgIHNlZW4uYWRkKGN1cnJlbnQpO1xuICAgICAgZm9yIChjb25zdCBuZXh0IG9mIGFkamFjZW5jeS5nZXQoY3VycmVudCkgPz8gW10pIHtcbiAgICAgICAgc3RhY2sucHVzaChuZXh0KTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gWy4uLm9uQ3ljbGVdLnNvcnQoKGEsIGIpID0+IGEgLSBiKTtcbn1cblxuLyoqXG4gKiBGaW5kIGEgY29uY3JldGUgY3ljbGUgcGF0aCB0aHJvdWdoIGBzdGFydGAsIHJldHVybmluZyB0aGUgb3JkZXJlZCBpc3N1ZVxuICogbnVtYmVycyBmcm9tIGBzdGFydGAgYmFjayB0b3dhcmRzIGBzdGFydGAgKHRoZSBjbG9zaW5nIG5vZGUgaXMgb21pdHRlZCDigJRcbiAqIGUuZy4gYSBB4oaSQuKGkkEgY3ljbGUgcmV0dXJucyBgW0EsIEJdYCkuIFJldHVybnMgYFtzdGFydF1gIGZvciBhIHNlbGYtbG9vcFxuICogYW5kIGBbXWAgd2hlbiBgc3RhcnRgIGlzIG5vdCBvbiBhbnkgY3ljbGUuIFVzZWQgdG8gcmVuZGVyIGEgaHVtYW4tcmVhZGFibGVcbiAqIGJsb2NrZXIgbWVzc2FnZSAoSXNzdWUgIzI3NTIpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZmluZEN5Y2xlUGF0aChcbiAgbm9kZXM6IERlcGVuZGVuY3lOb2RlW10sXG4gIHN0YXJ0OiBudW1iZXIsXG4pOiBudW1iZXJbXSB7XG4gIGNvbnN0IGFkamFjZW5jeSA9IGJ1aWxkQmxvY2tpbmdBZGphY2VuY3kobm9kZXMpO1xuICBjb25zdCBwYXRoOiBudW1iZXJbXSA9IFtdO1xuICBjb25zdCB2aXNpdGVkID0gbmV3IFNldDxudW1iZXI+KCk7XG5cbiAgY29uc3QgZGZzID0gKG5vZGU6IG51bWJlcik6IGJvb2xlYW4gPT4ge1xuICAgIHBhdGgucHVzaChub2RlKTtcbiAgICB2aXNpdGVkLmFkZChub2RlKTtcbiAgICBmb3IgKGNvbnN0IG5leHQgb2YgYWRqYWNlbmN5LmdldChub2RlKSA/PyBbXSkge1xuICAgICAgaWYgKG5leHQgPT09IHN0YXJ0KSByZXR1cm4gdHJ1ZTsgLy8gY2xvc2VkIHRoZSBsb29wIGJhY2sgdG8gc3RhcnRcbiAgICAgIGlmICghdmlzaXRlZC5oYXMobmV4dCkgJiYgZGZzKG5leHQpKSByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgcGF0aC5wb3AoKTtcbiAgICB2aXNpdGVkLmRlbGV0ZShub2RlKTtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH07XG5cbiAgZm9yIChjb25zdCBuZXh0IG9mIGFkamFjZW5jeS5nZXQoc3RhcnQpID8/IFtdKSB7XG4gICAgaWYgKG5leHQgPT09IHN0YXJ0KSByZXR1cm4gW3N0YXJ0XTsgLy8gc2VsZi1sb29wXG4gICAgaWYgKGRmcyhuZXh0KSkgcmV0dXJuIFtzdGFydCwgLi4ucGF0aF07XG4gIH1cbiAgcmV0dXJuIFtdO1xufVxuXG4vKipcbiAqIEJ1aWxkIGEgZGVwZW5kZW5jeSBncmFwaCBvdmVyIGEgZml4ZWQgc2V0IG9mIGlzc3VlcyBmb3IgY3ljbGUgZGV0ZWN0aW9uXG4gKiAoSXNzdWUgIzI3NTIpLlxuICpcbiAqIFVubGlrZSB7QGxpbmsgYnVpbGREZXBlbmRlbmN5R3JhcGh9LCB0aGlzIGZldGNoZXMgZWFjaCBub2RlIGF0IG1vc3Qgb25jZVxuICogKG9uZSBib2R5IHJlYWQgZm9yIGZvcndhcmQgZGVwZW5kZW5jaWVzLCBvbmUgc3ViLWlzc3VlcyByZWFkIGZvclxuICogcGFyZW50L2NoaWxkIGVkZ2VzKSDigJQgTyhuKSBjYWxscyByYXRoZXIgdGhhbiBPKG7Csikg4oCUIGFuZCBvbmx5IHJlY29yZHNcbiAqIGVkZ2VzIHdob3NlIGVuZHBvaW50cyBhcmUgYm90aCBpbiBgaXNzdWVOdW1iZXJzYC4gU3RhdGUgaXMgbm90IG5lZWRlZCBmb3JcbiAqIHN0cnVjdHVyYWwgY3ljbGUgZGV0ZWN0aW9uLCBzbyBldmVyeSBub2RlIGlzIHJlY29yZGVkIGFzIGBPUEVOYC5cbiAqXG4gKiBAcGFyYW0gZmV0Y2hlciAtIEluamVjdGFibGUgaXNzdWUgZGF0YSBmZXRjaGVyXG4gKiBAcGFyYW0gcmVwbyAtIFJlcG9zaXRvcnkgaW4gXCJvd25lci9yZXBvXCIgZm9ybWF0XG4gKiBAcGFyYW0gaXNzdWVOdW1iZXJzIC0gVGhlIGlzc3VlIG51bWJlcnMgdG8gYW5hbHlzZVxuICogQHJldHVybnMgRGVwZW5kZW5jeSBub2RlcyByZWFkeSBmb3Ige0BsaW5rIGRldGVjdERlcGVuZGVuY3lDeWNsZXN9XG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBidWlsZFdvcmtPbkRlcGVuZGVuY3lHcmFwaChcbiAgZmV0Y2hlcjogSXNzdWVGZXRjaGVyLFxuICByZXBvOiBzdHJpbmcsXG4gIGlzc3VlTnVtYmVyczogbnVtYmVyW10sXG4pOiBQcm9taXNlPERlcGVuZGVuY3lOb2RlW10+IHtcbiAgY29uc3Qgc2V0ID0gbmV3IFNldChpc3N1ZU51bWJlcnMpO1xuICBjb25zdCBub2RlcyA9IG5ldyBNYXA8bnVtYmVyLCBEZXBlbmRlbmN5Tm9kZT4oKTtcbiAgZm9yIChjb25zdCBuIG9mIGlzc3VlTnVtYmVycykge1xuICAgIG5vZGVzLnNldChuLCB7IGlzc3VlTnVtYmVyOiBuLCBkZXBlbmRzT246IFtdLCBzdGF0ZTogXCJPUEVOXCIgfSk7XG4gIH1cblxuICBmb3IgKGNvbnN0IG4gb2YgaXNzdWVOdW1iZXJzKSB7XG4gICAgY29uc3Qgbm9kZSA9IG5vZGVzLmdldChuKSE7XG5cbiAgICAvLyBGb3J3YXJkIGRlcGVuZGVuY2llcyAoXCJEZXBlbmRzIG9uICNOXCIgLyBcIkJsb2NrZWQgYnkgI05cIikuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGJvZHkgPSBhd2FpdCBmZXRjaGVyLmdldElzc3VlQm9keShyZXBvLCBuKTtcbiAgICAgIGZvciAoY29uc3QgZGVwIG9mIGV4dHJhY3REZXBlbmRlbmN5UmVmZXJlbmNlcyhib2R5KSkge1xuICAgICAgICBpZiAoc2V0LmhhcyhkZXApICYmICFub2RlLmRlcGVuZHNPbi5pbmNsdWRlcyhkZXApKSB7XG4gICAgICAgICAgbm9kZS5kZXBlbmRzT24ucHVzaChkZXApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBVbnJlYWRhYmxlIGJvZHkg4oCUIHNraXAgZm9yd2FyZCBlZGdlcyBmb3IgdGhpcyBub2RlLlxuICAgIH1cblxuICAgIC8vIFBhcmVudC9jaGlsZCBlZGdlczogZWFjaCBnZW51aW5lIHN1Yi1pc3N1ZSBpcyBhIGNoaWxkIG9mIGBuYC4gVGhlIGdyYXBoXG4gICAgLy8gaXMgc2luZ2xlLXJlcG8sIHNvIGEgY3Jvc3MtcmVwbyBzdWItaXNzdWUgd2l0aCB0aGUgc2FtZSBudW1iZXIgYXMgb25lXG4gICAgLy8gb2YgdGhpcyByZXBvJ3Mgbm9kZXMgaXMgbm90IHRyZWF0ZWQgYXMgdGhhdCBub2RlJ3MgY2hpbGQgKElzc3VlXG4gICAgLy8gIzMzMTkpLlxuICAgIHRyeSB7XG4gICAgICBjb25zdCBjaGlsZHJlbiA9IGF3YWl0IGZldGNoZXIuZ2V0U3ViSXNzdWVzKHJlcG8sIG4pO1xuICAgICAgY29uc3Qgc2FtZVJlcG8gPSBjaGlsZElzU2FtZVJlcG8ocmVwbyk7XG4gICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIGNoaWxkcmVuKSB7XG4gICAgICAgIGlmICghc2FtZVJlcG8oY2hpbGQucmVwbykpIGNvbnRpbnVlO1xuICAgICAgICBpZiAoIXNldC5oYXMoY2hpbGQubnVtYmVyKSkgY29udGludWU7XG4gICAgICAgIGNvbnN0IGNoaWxkTm9kZSA9IG5vZGVzLmdldChjaGlsZC5udW1iZXIpO1xuICAgICAgICBpZiAoY2hpbGROb2RlKSBjaGlsZE5vZGUuY2hpbGRPZiA9IG47XG4gICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBVbnJlYWRhYmxlIHN1Yi1pc3N1ZXMg4oCUIHNraXAgcGFyZW50IGVkZ2VzIGZvciB0aGlzIG5vZGUuXG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIFsuLi5ub2Rlcy52YWx1ZXMoKV07XG59XG5cbi8qKlxuICogRm9ybWF0IGEgcGFyZW50LWJsb2NrZWQgcmVzdWx0IGFzIGEgaHVtYW4tcmVhZGFibGUgbWVzc2FnZS5cbiAqXG4gKiBAcGFyYW0gaXNzdWVOdW1iZXIgLSBUaGUgcGFyZW50IGlzc3VlIG51bWJlclxuICogQHBhcmFtIHJlc3VsdCAtIFRoZSBibG9ja2VkIGNoZWNrIHJlc3VsdFxuICogQHBhcmFtIHJlcG8gLSBUaGUgcGFyZW50J3Mgb3duIHJlcG8gKElzc3VlICMzMzE5KTogYSBzYW1lLXJlcG8gY2hpbGRcbiAqICAgcmVuZGVycyBhcyBgI25gLCBhIGNyb3NzLXJlcG8gY2hpbGQgYXMgYG93bmVyL3JlcG8jbmAuXG4gKiBAcmV0dXJucyBGb3JtYXR0ZWQgbWVzc2FnZSBzdHJpbmdcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdFBhcmVudEJsb2NrZWRNZXNzYWdlKFxuICBpc3N1ZU51bWJlcjogbnVtYmVyLFxuICByZXN1bHQ6IFBhcmVudEJsb2NrZWRSZXN1bHQsXG4gIHJlcG86IHN0cmluZyxcbik6IHN0cmluZyB7XG4gIGlmICghcmVzdWx0LmlzQmxvY2tlZCkge1xuICAgIGlmIChyZXN1bHQudG90YWxDaGlsZHJlbiA9PT0gMCkge1xuICAgICAgcmV0dXJuIGBJc3N1ZSAjJHtpc3N1ZU51bWJlcn0gaGFzIG5vIHN1Yi1pc3N1ZXMg4oCUIG5vdCBibG9ja2VkLmA7XG4gICAgfVxuICAgIHJldHVybiBgSXNzdWUgIyR7aXNzdWVOdW1iZXJ9IOKAlCBhbGwgJHtyZXN1bHQudG90YWxDaGlsZHJlbn0gc3ViLWlzc3VlcyBhcmUgY2xvc2VkLiBSZWFkeSB0byB3b3JrIG9uLmA7XG4gIH1cblxuICBjb25zdCBzYW1lUmVwbyA9IGNoaWxkSXNTYW1lUmVwbyhyZXBvKTtcbiAgY29uc3QgcmVmTGFiZWwgPSAoY2hpbGQ6IFN1Yklzc3VlUmVmKSA9PlxuICAgIHNhbWVSZXBvKGNoaWxkLnJlcG8pID8gYCMke2NoaWxkLm51bWJlcn1gIDogYCR7Y2hpbGQucmVwb30jJHtjaGlsZC5udW1iZXJ9YDtcbiAgY29uc3Qgb3BlblJlZnMgPSByZXN1bHQub3BlbkNoaWxkcmVuLm1hcChyZWZMYWJlbCkuam9pbihcIiwgXCIpO1xuICByZXR1cm4gYElzc3VlICMke2lzc3VlTnVtYmVyfSBpcyBibG9ja2VkIGJ5ICR7cmVzdWx0Lm9wZW5DaGlsZHJlbi5sZW5ndGh9IG9wZW4gc3ViLWlzc3VlKHMpOiAke29wZW5SZWZzfS4gYCArXG4gICAgYCR7cmVzdWx0LmNsb3NlZENoaWxkcmVuLmxlbmd0aH0vJHtyZXN1bHQudG90YWxDaGlsZHJlbn0gc3ViLWlzc3VlcyBjb21wbGV0ZWQuYDtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7OztDQWdCQyxHQUlELFNBQVMsZ0JBQWdCLEVBQUUsaUJBQWlCLFFBQVEsMkJBQTJCO0FBMEQvRTs7Ozs7Ozs7Ozs7Ozs7Q0FjQyxHQUNELE9BQU8sU0FBUyxvQkFBb0IsR0FBVztFQUM3QyxPQUFPLElBQUksSUFBSSxHQUFHLFdBQVcsT0FBTyxTQUFTLFNBQVM7QUFDeEQ7QUFFQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0F1QkMsR0FDRCxPQUFPLFNBQVMsZUFBZSxJQUFZO0VBQ3pDLElBQUksQ0FBQyxNQUFNLE9BQU87RUFDbEIsT0FBTyxrQkFB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
// denoCacheMetadata=5878302331507755467,11569006162358183649