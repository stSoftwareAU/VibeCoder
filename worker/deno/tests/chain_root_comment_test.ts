/**
 * Tests for the chain-root wording and its sanitisers (Issues #2496, #2535).
 *
 * #2535 retired the stand-alone chain-root comment; the sentence it wrote is
 * now the `dependency` gate's sentence in the held-issue gate comment. What
 * remains here is that sentence and the sanitising of the references and
 * logins it interpolates — values parsed out of issue bodies anyone can write.
 * The posting, dedup and trust guarantees live with the gate comment and are
 * pinned by `held_issue_gate_comment_test.ts`.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { reasonSentence, renderRef } from "../lib/chain_root_comment.ts";

const ROOT = renderRef({ repo: "owner/repo-b", number: 42 });

Deno.test("reasonSentence - names the assignee being waited on", () => {
  assertEquals(
    reasonSentence("assigned", ROOT, "alice"),
    "waiting on @alice, who is assigned to owner/repo-b#42",
  );
});

Deno.test("reasonSentence - says a root carries no discovery label", () => {
  assertEquals(
    reasonSentence("no-discovery-label", ROOT, "documentation"),
    "owner/repo-b#42 carries no discovery label, so the fleet will not pick it up",
  );
});

Deno.test("reasonSentence - says a root is needs-human", () => {
  assertEquals(
    reasonSentence("needs-human", ROOT, "needs-human"),
    "owner/repo-b#42 is `needs-human`",
  );
});

Deno.test("reasonSentence - says a cross-repo blocker is unmonitored", () => {
  assertEquals(
    reasonSentence(
      "cross-repo-unmonitored",
      renderRef({ repo: "other/repo", number: 9 }),
      "other/repo",
    ),
    "cross-repo blocker other/repo#9 is not monitored by this fleet",
  );
});

Deno.test("reasonSentence - strips markup from an implausible assignee login", () => {
  const sentence = reasonSentence(
    "assigned",
    ROOT,
    'alice" -->\n<!-- injected',
  );

  // Everything outside GitHub's login alphabet is dropped, so the crafted
  // markup cannot close a marker attribute or open a second comment.
  assertStringIncludes(sentence, "waiting on @alice----injected, who is");
  assertEquals(sentence.includes("<!--"), false);
  assertEquals(sentence.includes("-->"), false);
});

Deno.test("reasonSentence - names no mention when the assignee is unusable", () => {
  const sentence = reasonSentence("assigned", ROOT, "   ");

  assertEquals(
    sentence,
    "waiting on an unnamed account, who is assigned to owner/repo-b#42",
  );
});

Deno.test("renderRef - strips markup from a crafted repository reference", () => {
  // The reference is parsed out of an attacker-writable issue body and lands
  // inside a marker's `key="…"` attribute, so it keeps only the characters a
  // repository name may use — the quote that would close the attribute and
  // the `>` that would close the comment are both gone.
  assertEquals(
    renderRef({ repo: 'owner/repo" --> injected', number: 5 }),
    "owner/repo--injected#5",
  );
});
