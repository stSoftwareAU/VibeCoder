/**
 * Tests for the merge-stage reading behind conflict resolution (Issue #1048).
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";
import {
  hasAnyStage,
  parseUnmergedStages,
  resolveTowardsIncoming,
} from "../lib/merge_conflict_stages.ts";

/** `git ls-files -u` output for a plain content conflict (all three stages). */
const CONTENT_CONFLICT = [
  "100644 aaaaaaa 1\tshared.txt",
  "100644 bbbbbbb 2\tshared.txt",
  "100644 ccccccc 3\tshared.txt",
].join("\n");

/** The incoming branch deleted it; this branch modified it. */
const INCOMING_DELETED = [
  "100644 aaaaaaa 1\tlib/fleet_health.ts",
  "100644 bbbbbbb 2\tlib/fleet_health.ts",
].join("\n");

/** This branch deleted it; the incoming branch modified it. */
const OURS_DELETED = [
  "100644 aaaaaaa 1\tlib/fleet_health.ts",
  "100644 ccccccc 3\tlib/fleet_health.ts",
].join("\n");

Deno.test("parseUnmergedStages - reads which sides exist", () => {
  assertEquals(parseUnmergedStages(CONTENT_CONFLICT), {
    base: true,
    ours: true,
    theirs: true,
  });
  assertEquals(parseUnmergedStages(INCOMING_DELETED), {
    base: true,
    ours: true,
    theirs: false,
  });
  assertEquals(parseUnmergedStages(OURS_DELETED), {
    base: true,
    ours: false,
    theirs: true,
  });
});

Deno.test("parseUnmergedStages - an empty read reports no stages at all", () => {
  const stages = parseUnmergedStages("");
  assertEquals(stages, { base: false, ours: false, theirs: false });
  assertEquals(hasAnyStage(stages), false);
  assertEquals(hasAnyStage(parseUnmergedStages(CONTENT_CONFLICT)), true);
});

Deno.test("parseUnmergedStages - tolerates a path containing spaces", () => {
  assertEquals(
    parseUnmergedStages("100644 ccccccc 3\tdocs/my notes.md"),
    { base: false, ours: false, theirs: true },
  );
});

Deno.test("resolveTowardsIncoming - a deleted incoming side means delete", () => {
  assertEquals(
    resolveTowardsIncoming(parseUnmergedStages(INCOMING_DELETED)),
    "delete",
  );
});

Deno.test("resolveTowardsIncoming - an existing incoming side is checked out", () => {
  assertEquals(
    resolveTowardsIncoming(parseUnmergedStages(CONTENT_CONFLICT)),
    "take-incoming",
  );
  assertEquals(
    resolveTowardsIncoming(parseUnmergedStages(OURS_DELETED)),
    "take-incoming",
  );
});
