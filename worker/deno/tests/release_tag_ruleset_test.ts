/**
 * Tests for the checked-in release-tag ruleset payload
 * (`infra/rulesets/release-tags.json`, Issue #869).
 *
 * Frozen hosts pull code by release tag, so a released tag must never be
 * deletable or movable. The payload is the source of truth for the tag
 * ruleset applied to `stSoftwareAU/VibeCoder`; these tests hold it to the
 * invariants that make it worth having:
 *
 * - deletion, moving (both directions) and force-pushing are blocked;
 * - creating a new release tag is **not** blocked — `release-tag.yml` mints
 *   the next patch on every merge, and a hand-minted `1.1.0` must succeed;
 * - enforcement is active with no bypass actors, so even the release
 *   workflow's scoped `contents: write` grant cannot delete or move a tag.
 *
 * The `update` assertion is the regression test for the gap found while
 * verifying this work: a ruleset carrying only `deletion` and
 * `non_fast_forward` still let `git push --force <newer-sha>:refs/tags/1.0.49`
 * through, because re-pointing a tag *forward* is a fast-forward update.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  loadReleaseTagRuleset,
  parseTagRuleset,
  refIsProtected,
  refPatternMatches,
  ruleTypes,
} from "../lib/release_tag_ruleset.ts";

/** Release tags this repository actually mints, all of which must be protected. */
const PROTECTED_REFS = [
  "refs/tags/1.0.49", // one of the 31 mutable pre-1.0.50 releases
  "refs/tags/1.0.53",
  "refs/tags/1.2.9",
  "refs/tags/v1.1.0", // the v-prefixed form the tagging rules allow
  "refs/tags/1.0.10",
];

/** Refs the ruleset must leave alone. */
const UNPROTECTED_REFS = [
  "refs/heads/main", // a branch, not a tag
  "refs/heads/milestone/863-immutable-releases",
  "refs/tags/1.0.0-rc1", // pre-release
  "refs/tags/1.0.0+build.5", // build metadata
  "refs/tags/latest", // moving name
];

Deno.test("release-tags ruleset - targets tags with active enforcement", async () => {
  const ruleset = await loadReleaseTagRuleset();
  assertEquals(ruleset.target, "tag");
  assertEquals(ruleset.enforcement, "active");
});

Deno.test("release-tags ruleset - blocks deletion, moving and force-pushing", async () => {
  const ruleset = await loadReleaseTagRuleset();
  const types = ruleTypes(ruleset);
  for (const required of ["deletion", "non_fast_forward", "update"]) {
    assert(
      types.includes(required),
      `missing rule "${required}" — a released tag could be ${
        required === "deletion" ? "deleted" : "moved"
      }; rules are ${types.join(", ")}`,
    );
  }
});

Deno.test("release-tags ruleset - never blocks minting a new release tag", async () => {
  const ruleset = await loadReleaseTagRuleset();
  assertEquals(
    ruleTypes(ruleset).includes("creation"),
    false,
    "a creation rule would stop release-tag.yml minting the next patch (Issue #808)",
  );
});

Deno.test("release-tags ruleset - grants no bypass actor", async () => {
  const ruleset = await loadReleaseTagRuleset();
  assertEquals(
    ruleset.bypass_actors,
    [],
    "a bypass actor would let the compromised token the ruleset defends against " +
      "delete or move a tag anyway",
  );
});

Deno.test("release-tags ruleset - protects the release tags this repository mints", async () => {
  const ruleset = await loadReleaseTagRuleset();
  for (const ref of PROTECTED_REFS) {
    assert(
      refIsProtected(ruleset, ref),
      `${ref} is not covered by the ruleset`,
    );
  }
});

Deno.test("release-tags ruleset - leaves branches and non-release tags alone", async () => {
  const ruleset = await loadReleaseTagRuleset();
  for (const ref of UNPROTECTED_REFS) {
    assertEquals(
      refIsProtected(ruleset, ref),
      false,
      `${ref} should not be covered by a release-tag ruleset`,
    );
  }
});

Deno.test("release-tags ruleset - a malformed payload fails loud", () => {
  assertThrows(
    () => parseTagRuleset("{ not json"),
    Error,
    "not valid JSON",
  );
  assertThrows(
    () =>
      parseTagRuleset(
        JSON.stringify({ name: "x", target: "tag", enforcement: "active" }),
      ),
    Error,
    "rules",
  );
  assertThrows(
    () =>
      parseTagRuleset(
        JSON.stringify({
          name: "x",
          target: "tag",
          enforcement: "active",
          bypass_actors: [],
          rules: [{ type: "deletion" }],
          conditions: { ref_name: { include: [], exclude: "no" } },
        }),
      ),
    Error,
    "conditions.ref_name",
  );
});

Deno.test("release-tags ruleset - a missing payload fails loud", async () => {
  const empty = await Deno.makeTempDir();
  await assertRejects(
    () => loadReleaseTagRuleset(empty),
    Deno.errors.NotFound,
  );
  await Deno.remove(empty);
});

Deno.test("release-tags ruleset - ref patterns match GitHub's fnmatch classes", () => {
  // The include pattern the payload actually ships.
  const release = "refs/tags/[0-9]*.[0-9]*.[0-9]*";
  assert(refPatternMatches(release, "refs/tags/1.0.49"));
  assert(refPatternMatches(release, "refs/tags/10.20.30"));
  assertEquals(refPatternMatches(release, "refs/tags/latest"), false);
  assertEquals(refPatternMatches(release, "refs/tags/v1.0.0"), false);
  // A negated class, and a range that excludes the character.
  assert(refPatternMatches("refs/tags/[!0-9]*", "refs/tags/latest"));
  assertEquals(
    refPatternMatches("refs/tags/[!0-9]*", "refs/tags/1.0.0"),
    false,
  );
  assertEquals(refPatternMatches("refs/tags/[a-c]", "refs/tags/d"), false);
  // An unclosed bracket is a literal bracket, not a class.
  assert(refPatternMatches("refs/tags/[x", "refs/tags/[x"));
  assertEquals(refPatternMatches("refs/tags/[x", "refs/tags/x"), false);
  // `**` spans separators, `*` does not.
  assert(refPatternMatches("refs/heads/**", "refs/heads/milestone/863"));
  assertEquals(
    refPatternMatches("refs/heads/*", "refs/heads/milestone/863"),
    false,
  );
});

Deno.test("release-tags ruleset - ref matching honours fnmatch wildcards", () => {
  const ruleset = parseTagRuleset(
    JSON.stringify({
      name: "test",
      target: "tag",
      enforcement: "active",
      bypass_actors: [],
      conditions: {
        ref_name: {
          include: ["refs/tags/release/*", "refs/tags/v?.0"],
          exclude: ["refs/tags/release/*-*"],
        },
      },
      rules: [{ type: "deletion" }],
    }),
  );
  // `*` stays inside one segment, so a nested ref is not swept in.
  assert(refIsProtected(ruleset, "refs/tags/release/9"));
  assertEquals(refIsProtected(ruleset, "refs/tags/release/9/1"), false);
  // An exclude beats an include.
  assertEquals(refIsProtected(ruleset, "refs/tags/release/9-rc1"), false);
  // `?` matches exactly one character.
  assert(refIsProtected(ruleset, "refs/tags/v2.0"));
  assertEquals(refIsProtected(ruleset, "refs/tags/v22.0"), false);
});
