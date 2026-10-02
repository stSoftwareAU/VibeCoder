/**
 * Milestone declared-dependency hold (Issue #3014).
 *
 * A milestone summary PR (head `milestone/*`, base the default branch)
 * assembles a set of sub-issues. Sub-issues can declare a forward dependency
 * in their body ("Depends on #N"), but nothing on the merge path checked that
 * the declared dependency had actually landed before the summary PR merged.
 * Two shapes of that gap were observed:
 *
 *   1. the declared dependency issue was still **open**, or
 *   2. it was **closed**, but assigned to a *different* milestone that is
 *      still open — its code only reaches the default branch once that other
 *      milestone's own summary PR merges, so it sits on a branch the current
 *      merge cannot see.
 *
 * This module detects both shapes so the merge can be held and explained.
 *
 * Deliberately does **not** import `./milestone_children_gate.ts` — that
 * module imports this one to layer the dependency hold onto its existing
 * open-children gate, and a reverse import would create a cycle.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { Result } from "../types.ts";
import { parseJsonArrayPages } from "./json_array_pages.ts";
import { extractDependencyReferences } from "./issue_dependencies.ts";
import { scrubUntrustedText } from "./prompt_delimiter.ts";

/** Injectable `gh` runner (same shape as milestone_children_gate.ts GhCommandFn). */
export type GhCommandFn = (args: string[]) => Promise<string>;

/** A milestone sub-issue's declared dependency that is not yet on the target branch. */
export interface PendingDependency {
  /** The milestone sub-issue that declares the dependency. */
  issueNumber: number;
  /** The dependency issue number (same repo). */
  dependencyNumber: number;
  /**
   * `open` — dependency issue still open; `unmerged-milestone` — closed, but
   * assigned to another milestone that is still open, so its work sits on an
   * unmerged milestone branch.
   */
  reason: "open" | "unmerged-milestone";
  /** Title of the other milestone, set only when reason is `unmerged-milestone`. */
  milestoneTitle?: string;
}

/** Options for {@link findPendingMilestoneDependencies}. */
export interface PendingDependencyOptions {
  /** Repository in `owner/repo` form. */
  repo: string;
  /** The milestone being assembled. */
  milestoneNumber: number;
  ghCommandFn: GhCommandFn;
}

/** Repo must be exactly `owner/repo` before it reaches an API path. */
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

interface RawIssue {
  number: number;
  body?: string;
  pull_request?: unknown;
}

/** Parse a `gh api --paginate` issues-list response, skipping PRs and junk. */
function parseMemberIssues(raw: string): RawIssue[] {
  const out: RawIssue[] = [];
  for (const item of parseJsonArrayPages(raw)) {
    if (!item || typeof item !== "object") continue;
    const record = item as RawIssue;
    if (!Number.isInteger(record.number)) continue;
    if ((record as { pull_request?: unknown }).pull_request !== undefined) {
      continue;
    }
    out.push({
      number: record.number,
      body: typeof record.body === "string" ? record.body : "",
    });
  }
  return out;
}

interface RawDependencyIssue {
  state?: unknown;
  milestone?: { number?: unknown; title?: unknown; state?: unknown } | null;
}

/** The result of looking up one dependency issue. */
type DependencyLookup =
  | { satisfied: true }
  | {
    satisfied: false;
    reason: "open" | "unmerged-milestone";
    milestoneTitle?: string;
  };

/**
 * Find every milestone sub-issue's declared dependency that has not yet
 * landed on the target (default) branch.
 */
export async function findPendingMilestoneDependencies(
  options: PendingDependencyOptions,
): Promise<Result<PendingDependency[]>> {
  const { repo, milestoneNumber, ghCommandFn } = options;

  if (!REPO_PATTERN.test(repo)) {
    return { ok: false, error: new Error(`Invalid repo: ${repo}`) };
  }
  if (!Number.isInteger(milestoneNumber) || milestoneNumber <= 0) {
    return {
      ok: false,
      error: new Error(`Invalid milestone number: ${milestoneNumber}`),
    };
  }

  let members: RawIssue[];
  try {
    const raw = await ghCommandFn([
      "api",
      "--paginate",
      `repos/${repo}/issues?milestone=${milestoneNumber}&state=all&per_page=100`,
    ]);
    members = parseMemberIssues(raw);
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `Failed to read declared dependencies of milestone #${milestoneNumber} in ` +
          `${repo}: ${err instanceof Error ? err.message : String(err)}`,
      ),
    };
  }

  const memberNumbers = new Set(members.map((m) => m.number));
  const dependencyLookupCache = new Map<number, DependencyLookup>();

  const pending: PendingDependency[] = [];

  const sortedMembers = [...members].sort((a, b) => a.number - b.number);
  for (const member of sortedMembers) {
    const deps = extractDependencyReferences(member.body ?? "");
    for (const dep of deps) {
      if (dep === member.number) continue;
      if (memberNumbers.has(dep)) continue;

      let lookup = dependencyLookupCache.get(dep);
      if (lookup === undefined) {
        try {
          lookup = await lookupDependency(
            repo,
            dep,
            milestoneNumber,
            ghCommandFn,
          );
        } catch (err) {
          return {
            ok: false,
            error: new Error(
              `Failed to read declared dependency #${dep} of milestone ` +
                `#${milestoneNumber} in ${repo}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
            ),
          };
        }
        dependencyLookupCache.set(dep, lookup);
      }

      if (!lookup.satisfied) {
        pending.push({
          issueNumber: member.number,
          dependencyNumber: dep,
          reason: lookup.reason,
          ...(lookup.milestoneTitle !== undefined
            ? { milestoneTitle: lookup.milestoneTitle }
            : {}),
        });
      }
    }
  }

  pending.sort((a, b) =>
    a.issueNumber - b.issueNumber || a.dependencyNumber - b.dependencyNumber
  );

  return { ok: true, value: pending };
}

/** Look up a single dependency issue and classify whether it is satisfied. */
async function lookupDependency(
  repo: string,
  dependencyNumber: number,
  milestoneNumber: number,
  ghCommandFn: GhCommandFn,
): Promise<DependencyLookup> {
  const raw = await ghCommandFn([
    "api",
    `repos/${repo}/issues/${dependencyNumber}`,
  ]);
  const parsed = JSON.parse(raw) as RawDependencyIssue;

  if (parsed.state === "open") {
    return { satisfied: false, reason: "open" };
  }
  if (parsed.state !== "closed") {
    throw new Error(
      `unexpected state "${
        String(parsed.state)
      }" for issue #${dependencyNumber}`,
    );
  }

  const milestone = parsed.milestone;
  if (
    milestone &&
    typeof milestone === "object" &&
    milestone.state === "open" &&
    milestone.number !== milestoneNumber
  ) {
    return {
      satisfied: false,
      reason: "unmerged-milestone",
      milestoneTitle: typeof milestone.title === "string"
        ? milestone.title
        : "",
    };
  }

  return { satisfied: true };
}

/**
 * One-line list item text used by both the body section and the block
 * comment, e.g. "#1963 depends on #1961 (still open)" or "#1963 depends on
 * #1810 (closed, but its milestone 'X' is still open, so its work is not
 * merged yet)".
 */
export function describePendingDependency(dep: PendingDependency): string {
  if (dep.reason === "open") {
    return `#${dep.issueNumber} depends on #${dep.dependencyNumber} (still open)`;
  }
  const title = scrubUntrustedText(dep.milestoneTitle ?? "");
  return `#${dep.issueNumber} depends on #${dep.dependencyNumber} ` +
    `(closed, but its milestone '${title}' is still open, so its work is not merged yet)`;
}

/**
 * Markdown section for the summary-PR body. Returns "" when pending is
 * empty.
 */
export function renderPendingDependenciesSection(
  pending: PendingDependency[],
): string {
  if (pending.length === 0) return "";
  const list = pending.map((dep) => `- ${describePendingDependency(dep)}`).join(
    "\n",
  );
  return [
    "### ⏸️ Held: pending dependencies",
    "",
    "This summary PR must not merge until every declared dependency below is " +
    "merged into the target branch. The worker re-checks before merging.",
    "",
    list,
  ].join("\n");
}

/** Hidden marker for the idempotent merge-block comment. */
export const PENDING_DEPENDENCIES_BLOCK_MARKER =
  "<!-- milestone-pending-dependencies-merge-block -->";

/**
 * The explanatory PR comment posted when the merge is held; starts with the
 * marker line.
 */
export function renderPendingDependenciesBlockComment(
  milestoneTitle: string,
  pending: PendingDependency[],
): string {
  const list = pending.map((dep) => `- ${describePendingDependency(dep)}`).join(
    "\n",
  );
  return [
    PENDING_DEPENDENCIES_BLOCK_MARKER,
    `Auto-merge held: milestone '${
      scrubUntrustedText(milestoneTitle)
    }' has sub-issues whose declared dependencies are not merged yet (Issue #3014)`,
    "",
    list,
    "",
    "The worker re-checks every scan and merges once they land. A human may " +
    "merge by hand if a cross-milestone dependency cycle makes that impossible.",
  ].join("\n");
}
