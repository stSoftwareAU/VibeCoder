/**
 * Tests for repo_checkout_path.ts — derives a repo's checkout root from
 * the parent work directory and its `owner/repo` slug (Issue #2880).
 */

import { assertEquals } from "@std/assert";
import { repoCheckoutPath } from "../lib/repo_checkout_path.ts";

Deno.test("repoCheckoutPath - appends the repo name to the work dir", () => {
  assertEquals(
    repoCheckoutPath(
      "/home/vibe/auto-issue-work",
      "stSoftwareAU/private-repo-14",
    ),
    "/home/vibe/auto-issue-work/private-repo-14",
  );
});

Deno.test("repoCheckoutPath - uses the last path segment of the slug", () => {
  // Defensive: any extra segments collapse to the final repo name.
  assertEquals(
    repoCheckoutPath("/work", "owner/group/repo"),
    "/work/repo",
  );
});

Deno.test("repoCheckoutPath - falls back to the slug when it has no slash", () => {
  assertEquals(repoCheckoutPath("/work", "repo"), "/work/repo");
});
