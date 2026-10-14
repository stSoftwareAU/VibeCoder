/**
 * Fake `gh` for tests of callers of `routeIssueCreation` (Issue #3691).
 *
 * Duplicate searches (`issue list` / `pr list`) answer an empty JSON array and
 * a permission check answers `WRITE`; every other call (the `issue create`
 * the test cares about) is handed to `onOther`.
 */

import type { IssueRoutingContext } from "../../lib/issue_routing.ts";

export const ROUTING_NOW = Date.parse("2026-10-14T00:00:00Z");

/** A routing context that allows the given repositories. */
export function routingContext(
  allowedRepos: readonly string[],
  over: Partial<IssueRoutingContext> = {},
): IssueRoutingContext {
  return {
    vibeCoderRepo: "stSoftwareAU/VibeCoder",
    allowedRepos,
    dryRun: false,
    recentlyClosedDays: 30,
    nowMs: ROUTING_NOW,
    ...over,
  };
}

/** Wrap `onOther` so searches see no duplicates and permission is WRITE. */
export function routingFakeGh(
  onOther: (args: string[]) => Promise<string> | string,
  permission = "WRITE",
): (args: string[]) => Promise<string> {
  return async (args) => {
    if (
      (args[0] === "issue" || args[0] === "pr") && args[1] === "list"
    ) return "[]";
    if (args[0] === "repo" && args[1] === "view") return permission;
    return await onOther(args);
  };
}
