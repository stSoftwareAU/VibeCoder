/**
 * Tests for the array utilities module.
 *
 * Migrated from tests/array-utils.bats and tests/shuffle-repos-config.bats (Issue #901).
 * Issue #271: Randomise repo scan order for fair work distribution.
 * Issue #435: Conditional shuffle based on configuration.
 */

import { assertEquals } from "@std/assert";
import { maybeShuffleRepos, shuffleArray } from "../lib/array_utils.ts";

// =============================================================================
// shuffleArray
// =============================================================================

Deno.test("array_utils - shuffleArray returns empty array for empty input", () => {
  const result = shuffleArray([]);
  assertEquals(result, []);
});

Deno.test("array_utils - shuffleArray returns single element unchanged", () => {
  const result = shuffleArray(["only"]);
  assertEquals(result, ["only"]);
});

Deno.test("array_utils - shuffleArray preserves all elements", () => {
  const input = ["a", "b", "c", "d", "e"];
  const result = shuffleArray(input);
  assertEquals(result.length, input.length);
  assertEquals(result.sort(), [...input].sort());
});

Deno.test("array_utils - shuffleArray does not modify the original array", () => {
  const input = ["a", "b", "c", "d", "e"];
  const original = [...input];
  shuffleArray(input);
  assertEquals(input, original);
});

Deno.test("array_utils - shuffleArray produces different orderings over many runs", () => {
  // With 5 elements, probability of same order is 1/120.
  // Running 10 times makes accidental same-order extremely unlikely.
  const input = ["repo1", "repo2", "repo3", "repo4", "repo5"];
  let differentCount = 0;

  for (let i = 0; i < 10; i++) {
    const result = shuffleArray(input);
    if (result.join(",") !== input.join(",")) {
      differentCount++;
    }
  }

  // At least some runs should produce a different order
  assertEquals(differentCount > 0, true);
});

Deno.test("array_utils - shuffleArray works with numbers", () => {
  const input = [1, 2, 3, 4, 5];
  const result = shuffleArray(input);
  assertEquals(result.length, 5);
  assertEquals(result.sort((a, b) => a - b), [1, 2, 3, 4, 5]);
});

// =============================================================================
// maybeShuffleRepos
// =============================================================================

Deno.test("array_utils - maybeShuffleRepos returns empty array for empty input", () => {
  const result = maybeShuffleRepos({ repos: [] });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, []);
  }
});

Deno.test("array_utils - maybeShuffleRepos preserves order when shuffle is false", () => {
  const repos = ["org/repo1", "org/repo2", "org/repo3"];
  const result = maybeShuffleRepos({ repos, shuffle: false });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, ["org/repo1", "org/repo2", "org/repo3"]);
  }
});

Deno.test("array_utils - maybeShuffleRepos shuffles by default", () => {
  const repos = ["a", "b", "c", "d", "e", "f", "g", "h"];
  let differentCount = 0;

  for (let i = 0; i < 10; i++) {
    const result = maybeShuffleRepos({ repos });
    if (result.ok && result.value.join(",") !== repos.join(",")) {
      differentCount++;
    }
  }

  assertEquals(differentCount > 0, true);
});

Deno.test("array_utils - maybeShuffleRepos preserves all repos regardless of shuffle", () => {
  const repos = ["org/repo1", "org/repo2", "org/repo3"];

  const shuffled = maybeShuffleRepos({ repos, shuffle: true });
  assertEquals(shuffled.ok, true);
  if (shuffled.ok) {
    assertEquals(shuffled.value.sort(), [...repos].sort());
  }

  const unshuffled = maybeShuffleRepos({ repos, shuffle: false });
  assertEquals(unshuffled.ok, true);
  if (unshuffled.ok) {
    assertEquals(unshuffled.value.sort(), [...repos].sort());
  }
});

Deno.test("array_utils - maybeShuffleRepos returns new array (not reference to input)", () => {
  const repos = ["org/repo1", "org/repo2"];
  const result = maybeShuffleRepos({ repos, shuffle: false });
  assertEquals(result.ok, true);
  if (result.ok) {
    // Verify it's a different array reference (mutating result won't affect input)
    result.value.push("extra");
    assertEquals(repos.length, 2); // Original unmodified
  }
});

Deno.test("array_utils - maybeShuffleRepos single repo returns that repo", () => {
  const result = maybeShuffleRepos({ repos: ["org/solo"], shuffle: true });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, ["org/solo"]);
  }
});
