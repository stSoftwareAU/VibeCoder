/**
 * Tests for which issue a PR title refers to (Issues #106, #319).
 *
 * The failure these encode: PR #212, a PR for issue #209, permanently blocked
 * #178, #184, #187, #188 and #209 alike because its title mentions all of
 * those numbers — one as another repository's issue, one as a pull request.
 * A merged PR never leaves the blocking set (Issue #3151), so #187 and #188
 * sat unclaimable for over a day under a skip reason that reads as a
 * "cooldown" that had long since passed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  prTitleMatchesIssue,
  prTitleReferencesIssue,
} from "../lib/pr_title_issue_ref.ts";

/** PR #212's real title, verbatim. */
const PR_212 =
  "Sibling fleet accounts listed only under service_accounts are invisible " +
  "to every PR guard: stservice's open PR #188 did not block VibeCoderST " +
  "claiming NEAT-AI-Lamarck#187 3 min later (and #178/#184 earlier) " +
  "(Issue #209)";

// ===========================================================================
// Issue #319 — the real title
// ===========================================================================

Deno.test("#319 - PR #212 refers to issue 209 and to nothing else it merely mentions", () => {
  assert(prTitleReferencesIssue(PR_212, 209), "its own issue still matches");
  assert(
    !prTitleReferencesIssue(PR_212, 187),
    "NEAT-AI-Lamarck#187 is another repository's issue",
  );
  assert(
    !prTitleReferencesIssue(PR_212, 188),
    "'open PR #188' is a pull request, not this repo's issue 188",
  );
});

Deno.test("#319 - a bare cross-reference in the same title still blocks", () => {
  // "(and #178/#184 earlier)" — bare, unqualified. The guard would rather
  // over-match a human's unconventional title than allow a duplicate PR, so
  // these deliberately still match. Narrowing them needs more than a title.
  assert(prTitleReferencesIssue(PR_212, 178));
  assert(prTitleReferencesIssue(PR_212, 184));
});

// ===========================================================================
// Repo-qualified references
// ===========================================================================

Deno.test("#319 - another repository's issue never matches", () => {
  for (
    const title of [
      "Fix the graft path (NEAT-AI-Lamarck#187)",
      "Port the guard from stSoftwareAU/GRQ#187",
      "Mirror of neat_core#187",
      "Follow-up to repo.name#187",
    ]
  ) {
    assertEquals(prTitleReferencesIssue(title, 187), false, title);
  }
});

Deno.test("#319 - a delimited reference still matches even next to a qualified one", () => {
  const title = "Port the fix from OtherRepo#187 (Issue #187)";
  assert(
    prTitleReferencesIssue(title, 187),
    "the canonical delimited form is a positive identification",
  );
});

// ===========================================================================
// Pull-request references
// ===========================================================================

Deno.test("#319 - a pull-request reference never matches", () => {
  for (
    const title of [
      "stservice's open PR #188 did not block the claim",
      "Reverts pull #188",
      "Supersedes pull request #188",
      "supersedes pr #188",
    ]
  ) {
    assertEquals(prTitleReferencesIssue(title, 188), false, title);
  }
});

Deno.test("#319 - 'PR' inside another word does not suppress a real reference", () => {
  // The qualifier is the word before the hash, not a substring anywhere.
  assert(prTitleReferencesIssue("Fix the REPR handling for #188", 188));
});

// ===========================================================================
// Behaviour preserved from before the fix
// ===========================================================================

Deno.test("#319 - the worker's own title convention still blocks", () => {
  for (
    const title of [
      "Do the thing (Issue #42)",
      "Do the thing (#42)",
      "[#42] Do the thing",
      "[Issue #42] Do the thing",
    ]
  ) {
    assert(prTitleReferencesIssue(title, 42), title);
  }
});

Deno.test("#319 - a bare unqualified reference still blocks a duplicate PR", () => {
  assert(prTitleReferencesIssue("Fix #42 properly", 42));
  assert(prTitleReferencesIssue("Closes #42", 42));
  assert(prTitleReferencesIssue("Work on #42", 42));
});

Deno.test("#319 - a longer number is not a match", () => {
  // The pre-existing guarantee: issue #42 must not match #421.
  assertEquals(prTitleReferencesIssue("Fix #421 properly", 42), false);
  assertEquals(prTitleReferencesIssue("Fix (Issue #421)", 42), false);
});

Deno.test("#319 - a title with no reference at all matches nothing", () => {
  assertEquals(prTitleReferencesIssue("Tidy the README", 42), false);
  assertEquals(prTitleReferencesIssue("", 42), false);
});

// ===========================================================================
// prTitleMatchesIssue is unchanged by the move (Issue #106)
// ===========================================================================

Deno.test("#106 - prTitleMatchesIssue accepts paren and bracket styles, rejects prefixes", () => {
  for (
    const title of [
      "Do the thing (#42)",
      "Do the thing (Issue #42)",
      "Do the thing (issue #42)",
      "[#42] Do the thing",
      "[Issue #42] Do the thing",
      "[issue #42] Do the thing",
    ]
  ) {
    assertEquals(prTitleMatchesIssue(title, 42), true, title);
  }
  for (
    const title of ["Do the thing (#142)", "[#142] Do the thing", "Fix #42"]
  ) {
    assertEquals(prTitleMatchesIssue(title, 42), false, title);
  }
});
