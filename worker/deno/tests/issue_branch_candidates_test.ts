/**
 * Tests for issue-number-keyed branch candidates (Issue #220).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  belongsToIssue,
  issueBranchPatterns,
  mostRecentBranch,
  parseLsRemoteHeads,
  preferredIssueBranch,
} from "../lib/issue_branch_candidates.ts";

// ---------------------------------------------------------------------------
// parseLsRemoteHeads
// ---------------------------------------------------------------------------

Deno.test("issue branch candidates - parses ls-remote head lines", () => {
  const stdout = [
    "abc1234567890abcdef1234567890abcdef123456\trefs/heads/issue-220-one",
    "def1234567890abcdef1234567890abcdef123456\trefs/heads/issue-220-two",
  ].join("\n") + "\n";

  assertEquals(parseLsRemoteHeads(stdout), [
    {
      sha: "abc1234567890abcdef1234567890abcdef123456",
      branch: "issue-220-one",
    },
    {
      sha: "def1234567890abcdef1234567890abcdef123456",
      branch: "issue-220-two",
    },
  ]);
});

Deno.test("issue branch candidates - ignores tags, blanks and malformed lines", () => {
  const stdout = [
    "",
    "not a ref line",
    "abc1234567890abcdef1234567890abcdef123456\trefs/tags/v1.0.0",
    "abc1234567890abcdef1234567890abcdef123456\trefs/heads/issue-220-ok",
  ].join("\n");

  assertEquals(parseLsRemoteHeads(stdout), [
    {
      sha: "abc1234567890abcdef1234567890abcdef123456",
      branch: "issue-220-ok",
    },
  ]);
});

// ---------------------------------------------------------------------------
// belongsToIssue — the number is the identity, not the title slug
// ---------------------------------------------------------------------------

Deno.test("issue branch candidates - branch identity keys on the issue number", () => {
  assertEquals(belongsToIssue("issue-220-any-old-title", 220), true);
  assertEquals(belongsToIssue("issue-220", 220), true);
  // A neighbouring issue whose number merely starts with the same digits.
  assertEquals(belongsToIssue("issue-2200-other", 220), false);
  assertEquals(belongsToIssue("issue-22-other", 220), false);
  // Namespaced branches are not the worker's naming convention.
  assertEquals(belongsToIssue("wip/issue-220-x", 220), false);
  assertEquals(belongsToIssue("main", 220), false);
});

Deno.test("issue branch candidates - patterns cover the number and the persisted branch", () => {
  assertEquals(issueBranchPatterns(220), ["issue-220", "issue-220-*"]);
  assertEquals(issueBranchPatterns(220, "legacy-branch-name"), [
    "issue-220",
    "issue-220-*",
    "legacy-branch-name",
  ]);
  // A persisted branch already covered by the number patterns is not repeated.
  assertEquals(issueBranchPatterns(220, "issue-220-old-slug"), [
    "issue-220",
    "issue-220-*",
  ]);
});

// ---------------------------------------------------------------------------
// preferredIssueBranch
// ---------------------------------------------------------------------------

const OLD = { branch: "issue-220-old-title", sha: "a".repeat(40) };
const NEW = { branch: "issue-220-new-title", sha: "b".repeat(40) };

Deno.test("issue branch candidates - the persisted branch wins over the title slug", () => {
  const chosen = preferredIssueBranch([OLD, NEW], {
    persistedBranch: OLD.branch,
    titleBranch: NEW.branch,
  });
  assertEquals(chosen?.branch, OLD.branch);
});

Deno.test("issue branch candidates - the title-derived branch is used when no state persists", () => {
  const chosen = preferredIssueBranch([OLD, NEW], { titleBranch: NEW.branch });
  assertEquals(chosen?.branch, NEW.branch);
});

Deno.test("issue branch candidates - a single candidate is chosen whatever its name", () => {
  const chosen = preferredIssueBranch([OLD], {
    titleBranch: "issue-220-a-completely-different-slug",
  });
  assertEquals(chosen?.branch, OLD.branch);
});

Deno.test("issue branch candidates - ambiguity is left to the caller", () => {
  assertEquals(
    preferredIssueBranch([OLD, NEW], { titleBranch: "issue-220-third-slug" }),
    null,
  );
  assertEquals(preferredIssueBranch([], { titleBranch: NEW.branch }), null);
});

Deno.test("issue branch candidates - a persisted branch that no longer exists falls through", () => {
  const chosen = preferredIssueBranch([NEW], {
    persistedBranch: "issue-220-deleted",
    titleBranch: NEW.branch,
  });
  assertEquals(chosen?.branch, NEW.branch);
});

// ---------------------------------------------------------------------------
// mostRecentBranch
// ---------------------------------------------------------------------------

Deno.test("issue branch candidates - the most recently pushed candidate wins", () => {
  const chosen = mostRecentBranch([
    { ...OLD, committedAtEpochSec: 1_700_000_000 },
    { ...NEW, committedAtEpochSec: 1_700_009_999 },
  ]);
  assertEquals(chosen?.branch, NEW.branch);
});

Deno.test("issue branch candidates - ties break by name so the choice is deterministic", () => {
  const chosen = mostRecentBranch([
    { ...NEW, committedAtEpochSec: 1_700_000_000 },
    { ...OLD, committedAtEpochSec: 1_700_000_000 },
  ]);
  assertEquals(chosen?.branch, NEW.branch); // "issue-220-new…" < "issue-220-old…"
  assertEquals(mostRecentBranch([]), null);
});
