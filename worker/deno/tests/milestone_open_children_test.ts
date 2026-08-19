/**
 * Tests for the authoritative milestone open-children lookup (Issue #3908).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  fetchAuthoritativeOpenChildren,
  formatChildNumbers,
  isMilestoneTrackingTitle,
} from "../lib/milestone_open_children.ts";

/** Build a gh stub serving a milestone object and its open-child list. */
function makeGh(
  milestone: unknown,
  children: unknown,
): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    const key = args.join(" ");
    if (key.includes("/issues?")) {
      if (children instanceof Error) return Promise.reject(children);
      return Promise.resolve(JSON.stringify(children));
    }
    if (milestone instanceof Error) return Promise.reject(milestone);
    return Promise.resolve(
      typeof milestone === "string" ? milestone : JSON.stringify(milestone),
    );
  };
}

Deno.test("fetchAuthoritativeOpenChildren - reports zero for a genuinely complete milestone", async () => {
  const result = await fetchAuthoritativeOpenChildren(
    "owner/repo",
    53,
    makeGh({ number: 53, title: "scan", open_issues: 0 }, []),
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.openCount, 0);
  assertEquals(result.value.rawOpenIssues, 0);
  assertEquals(result.value.childListAvailable, true);
});

Deno.test("fetchAuthoritativeOpenChildren - counts open non-tracking children (Issue #3908)", async () => {
  const result = await fetchAuthoritativeOpenChildren(
    "owner/repo",
    53,
    makeGh({ number: 53, open_issues: 3 }, [
      { number: 3876, title: "Fix the parser" },
      { number: 3875, title: "Add the guard" },
      { number: 3877, title: "Merge milestone 'scan' to main" },
    ]),
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  // 3 open children minus the one tracker = 2 authoritative open children.
  assertEquals(result.value.openCount, 2);
  assertEquals(result.value.children.map((c) => c.number), [3875, 3876]);
  assertEquals(result.value.trackers.map((c) => c.number), [3877]);
});

Deno.test("fetchAuthoritativeOpenChildren - a lone open tracker is not an open child (Issue #3214)", async () => {
  const result = await fetchAuthoritativeOpenChildren(
    "owner/repo",
    53,
    makeGh({ number: 53, open_issues: 1 }, [
      { number: 3895, title: "Merge milestone 'scan' to main" },
    ]),
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.openCount, 0);
  assertEquals(result.value.rawOpenIssues, 1);
});

Deno.test("fetchAuthoritativeOpenChildren - an open child PR vetoes too (Issue #3906)", async () => {
  const result = await fetchAuthoritativeOpenChildren(
    "owner/repo",
    53,
    makeGh({ number: 53, open_issues: 1 }, [
      { number: 3901, title: "Fix the parser", pull_request: { url: "..." } },
    ]),
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.openCount, 1);
  assertEquals(result.value.children[0]?.isPullRequest, true);
});

Deno.test("fetchAuthoritativeOpenChildren - takes the larger of the two fresh readings", async () => {
  // open_issues lags at 0 while the fresh child list already shows one open
  // child: the conservative reading wins.
  const result = await fetchAuthoritativeOpenChildren(
    "owner/repo",
    53,
    makeGh({ number: 53, open_issues: 0 }, [
      { number: 3880, title: "Still open" },
    ]),
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.openCount, 1);
});

Deno.test("fetchAuthoritativeOpenChildren - fails loud when the milestone fetch fails", async () => {
  const result = await fetchAuthoritativeOpenChildren(
    "owner/repo",
    53,
    makeGh(new Error("gh: 502 Bad Gateway"), []),
  );
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertStringIncludes(result.error.message, "502 Bad Gateway");
  assertStringIncludes(result.error.message, "owner/repo");
});

Deno.test("fetchAuthoritativeOpenChildren - fails loud on a malformed milestone payload", async () => {
  const result = await fetchAuthoritativeOpenChildren(
    "owner/repo",
    53,
    makeGh("[]", []),
  );
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertStringIncludes(result.error.message, "milestone object");
});

Deno.test("fetchAuthoritativeOpenChildren - fails loud when open_issues is missing", async () => {
  const result = await fetchAuthoritativeOpenChildren(
    "owner/repo",
    53,
    makeGh({ number: 53, title: "scan" }, []),
  );
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertStringIncludes(result.error.message, "open_issues");
});

Deno.test("fetchAuthoritativeOpenChildren - degrades conservatively when the child list fails", async () => {
  const result = await fetchAuthoritativeOpenChildren(
    "owner/repo",
    53,
    makeGh({ number: 53, open_issues: 2 }, new Error("gh: rate limited")),
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.childListAvailable, false);
  assertStringIncludes(result.value.childListError ?? "", "rate limited");
  // Trackers cannot be excluded without titles — the raw count stands.
  assertEquals(result.value.openCount, 2);
});

Deno.test("fetchAuthoritativeOpenChildren - queries the milestone and its open children fresh", async () => {
  const calls: string[] = [];
  const gh = (args: string[]) => {
    calls.push(args.join(" "));
    if (args.join(" ").includes("/issues?")) return Promise.resolve("[]");
    return Promise.resolve(JSON.stringify({ number: 7, open_issues: 0 }));
  };
  await fetchAuthoritativeOpenChildren("owner/repo", 7, gh);
  assertEquals(calls.length, 2);
  assertStringIncludes(calls[0]!, "api repos/owner/repo/milestones/7");
  assertStringIncludes(calls[1]!, "milestone=7");
  assertStringIncludes(calls[1]!, "state=open");
});

Deno.test("formatChildNumbers - renders numbers or 'none'", () => {
  assertEquals(formatChildNumbers([]), "none");
  assertEquals(formatChildNumbers([{ number: 1 }, { number: 2 }]), "#1, #2");
});

Deno.test("isMilestoneTrackingTitle - still matches the tracking shape after the move", () => {
  assertEquals(
    isMilestoneTrackingTitle("Merge milestone 'v1.0' to main"),
    true,
  );
  assertEquals(isMilestoneTrackingTitle("Add login page"), false);
});
