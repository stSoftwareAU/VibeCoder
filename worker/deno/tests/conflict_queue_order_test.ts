/**
 * Tests for conflict_queue_order.ts — the pure ordering the merge-conflict
 * fairness cursor applies (Issue #1111).
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assertEquals } from "@std/assert";
import {
  orderByPreference,
  preferredRepos,
} from "../lib/conflict_queue_order.ts";

Deno.test("orderByPreference - the cursor leads and everything else keeps its order", () => {
  const queue = ["a", "b", "c", "d"];
  assertEquals(orderByPreference(queue, (x) => x, ["c", "a"]), [
    "c",
    "a",
    "b",
    "d",
  ]);
  assertEquals(orderByPreference(queue, (x) => x, ["zz"]), queue);
  assertEquals(orderByPreference(queue, (x) => x, []), queue);
  assertEquals(orderByPreference(queue, (x) => x, undefined), queue);
  assertEquals(orderByPreference([], (x: string) => x, ["a"]), []);
});

Deno.test("orderByPreference - a repeated key keeps its first position", () => {
  assertEquals(
    orderByPreference(["a", "b", "c"], (x) => x, ["c", "b", "c"]),
    ["c", "b", "a"],
  );
});

Deno.test("orderByPreference - the input array is never mutated", () => {
  const queue = ["a", "b", "c"];
  orderByPreference(queue, (x) => x, ["c"]);
  assertEquals(queue, ["a", "b", "c"]);
});

Deno.test("preferredRepos - names each repository once, in cursor order", () => {
  assertEquals(
    preferredRepos(["org/beta#7", "org/alpha#1", "org/beta#9"]),
    ["org/beta", "org/alpha"],
  );
  assertEquals(preferredRepos(undefined), []);
  assertEquals(preferredRepos([]), []);
});

Deno.test("preferredRepos - a malformed key is dropped, not turned into a repo", () => {
  assertEquals(preferredRepos(["malformed", "#12", "org/ok#3"]), ["org/ok"]);
});
