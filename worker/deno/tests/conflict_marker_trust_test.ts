/**
 * Tests for conflict_marker_trust.ts (Issue #1247, SEC-1216-06).
 *
 * The partition carries the whole security property of the merge-conflict
 * marker readers, and its two output halves mean different things: a comment
 * attributed to an outsider is *discarded*, while one that cannot be
 * attributed at all is *counted*, so a caller whose marker suppresses a
 * destructive action can refuse rather than proceed.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assertEquals } from "@std/assert";
import {
  conflictCommentAuthor,
  partitionConflictComments,
} from "../lib/conflict_marker_trust.ts";

const FLEET = ["vibe-bot", "Vibe-Sibling"];

function comment(body: string, login?: string): unknown {
  return login === undefined ? { body } : { body, user: { login } };
}

Deno.test("conflictCommentAuthor - reads the REST user.login shape", () => {
  assertEquals(
    conflictCommentAuthor({ user: { login: " vibe-bot " } }),
    "vibe-bot",
  );
  assertEquals(conflictCommentAuthor({ user: { login: "" } }), undefined);
  assertEquals(conflictCommentAuthor({ user: null }), undefined);
  assertEquals(conflictCommentAuthor({ author: "vibe-bot" }), undefined);
  assertEquals(conflictCommentAuthor(null), undefined);
  assertEquals(conflictCommentAuthor("a string"), undefined);
});

Deno.test("partitionConflictComments - keeps the fleet's own, discards outsiders", () => {
  const mine = comment("attempt 1", "vibe-bot");
  const sibling = comment("attempt 2", "vibe-sibling");
  const result = partitionConflictComments(
    [mine, comment("planted", "drive-by"), sibling],
    FLEET,
  );

  // Case-insensitive: GitHub logins are, so the sibling matches.
  assertEquals(result.trusted, [mine, sibling]);
  // An outsider is attributed — to an outsider — so it is not unattributable.
  assertEquals(result.unattributable, 0);
});

Deno.test("partitionConflictComments - a comment with no author is unattributable", () => {
  const result = partitionConflictComments(
    [comment("ghost"), comment("mine", "vibe-bot"), null, 42],
    FLEET,
  );

  assertEquals(result.trusted, [comment("mine", "vibe-bot")]);
  // The ghost comment, plus the two malformed entries.
  assertEquals(result.unattributable, 3);
});

Deno.test("partitionConflictComments - no fleet identity makes everything unattributable", () => {
  // The distinction that matters: with nothing to compare against, a genuine
  // fleet claim is indistinguishable from a planted one, so the caller must
  // not read the empty `trusted` list as "no claim exists".
  const result = partitionConflictComments(
    [comment("mine", "vibe-bot"), comment("planted", "drive-by")],
    [],
  );

  assertEquals(result.trusted, []);
  assertEquals(result.unattributable, 2);
});

Deno.test("partitionConflictComments - an empty thread is neither trusted nor unattributable", () => {
  assertEquals(partitionConflictComments([], FLEET), {
    trusted: [],
    unattributable: 0,
  });
  assertEquals(partitionConflictComments([], []), {
    trusted: [],
    unattributable: 0,
  });
});
