/**
 * Tests for assertNever exhaustiveness guard (Issue #2168).
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { assertNever } from "../lib/assert_never.ts";

Deno.test("assertNever - throws with the offending value embedded in the message", () => {
  // Cast through unknown because a well-typed caller can never reach this
  // branch — the runtime behaviour matters when JSON from an external
  // source carries an unexpected tag.
  const stray = "surprise" as unknown as never;
  const err = assertThrows(() => assertNever(stray), Error);
  assert(
    err.message.includes("surprise"),
    `expected message to embed the value, got: ${err.message}`,
  );
  assert(
    err.message.startsWith("Unreachable:"),
    `expected "Unreachable:" prefix, got: ${err.message}`,
  );
});

Deno.test("assertNever - serialises object values via JSON.stringify", () => {
  const stray = { kind: "ghost" } as unknown as never;
  const err = assertThrows(() => assertNever(stray), Error);
  assert(
    err.message.includes('"kind":"ghost"'),
    `expected JSON-serialised value in message, got: ${err.message}`,
  );
});

Deno.test("assertNever - is usable as a default branch returning never", () => {
  type Tag = { kind: "a" } | { kind: "b" };
  function describe(t: Tag): string {
    switch (t.kind) {
      case "a":
        return "alpha";
      case "b":
        return "bravo";
      default:
        return assertNever(t);
    }
  }
  assertEquals(describe({ kind: "a" }), "alpha");
  assertEquals(describe({ kind: "b" }), "bravo");

  // Smuggle an unknown tag past the type-checker to confirm the
  // runtime guard fires.
  const stray = { kind: "c" } as unknown as Tag;
  assertThrows(() => describe(stray), Error, "Unreachable:");
});
