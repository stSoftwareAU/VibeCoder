/**
 * Tests for the structured JSON union (Issue #1968).
 *
 * The union exists because two branches that each append a slice to
 * `docs/audits/lib-sweep-coverage.json` conflict *inside* the appended object,
 * so no concatenation of the two hunks is valid JSON. These tests cover the
 * shape that actually occurs, the insertions this merge keeps, and every
 * refusal — a deletion, a conflicting edit, and a file whose formatting the
 * union would not reproduce.
 *
 * Uses Australian English throughout (behaviour, serialised, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  jsonEquals,
  unionJsonInsertions,
} from "../lib/json_insertion_union.ts";

/** The merged document, failing the test when the union refused. */
function merged(base: string, ours: string, theirs: string): string {
  const result = unionJsonInsertions(base, ours, theirs);
  assert(result.ok, `union refused: ${!result.ok && result.error}`);
  return result.value;
}

/** The refusal reason, failing the test when the union resolved. */
function refusal(base: string, ours: string, theirs: string): string {
  const result = unionJsonInsertions(base, ours, theirs);
  assert(!result.ok, "expected the union to refuse");
  return result.error;
}

/** A ledger of `slices`, written the way the real one is. */
function ledger(slices: Array<Record<string, unknown>>): string {
  return JSON.stringify({ parent: 1209, slices }, null, 2) + "\n";
}

const SEED = { issue: 1910, chunk: "12z", paths: ["worker/deno/lib/a.ts"] };
const OURS_SLICE = {
  issue: 1940,
  chunk: "top-up-1940",
  paths: ["worker/deno/lib/gemini_token_usage.ts"],
};
const THEIRS_SLICE = {
  issue: 1943,
  chunk: "top-up-1943",
  paths: ["worker/deno/lib/other_new.ts"],
};

Deno.test("unionJsonInsertions - two appended ledger slices both survive", () => {
  const text = merged(
    ledger([SEED]),
    ledger([SEED, OURS_SLICE]),
    ledger([SEED, THEIRS_SLICE]),
  );

  assertEquals(JSON.parse(text), {
    parent: 1209,
    // The base branch's slice first, then the PR branch's.
    slices: [SEED, THEIRS_SLICE, OURS_SLICE],
  });
  assertEquals(text, ledger([SEED, THEIRS_SLICE, OURS_SLICE]));
});

Deno.test("unionJsonInsertions - an entry both sides added is kept once", () => {
  const text = merged(
    ledger([SEED]),
    ledger([SEED, THEIRS_SLICE]),
    ledger([SEED, THEIRS_SLICE]),
  );

  assertEquals(JSON.parse(text), {
    parent: 1209,
    slices: [SEED, THEIRS_SLICE],
  });
});

Deno.test("unionJsonInsertions - an entry both sides added at different points is still kept once", () => {
  // Rendering one side of a conflict also carries the other side's cleanly
  // merged insertions, which can sit at a different anchor. The entry is the
  // same entry, so it lands once.
  const base = '{\n  "entries": [\n    "a",\n    "b"\n  ]\n}\n';
  const ours = '{\n  "entries": [\n    "X",\n    "a",\n    "b"\n  ]\n}\n';
  const theirs = '{\n  "entries": [\n    "a",\n    "X",\n    "b"\n  ]\n}\n';

  assertEquals(JSON.parse(merged(base, ours, theirs)), {
    entries: ["a", "X", "b"],
  });
});

Deno.test("unionJsonInsertions - a document too deep to re-serialise is refused, not thrown", () => {
  // `JSON.parse` accepts documents `JSON.stringify` cannot walk. The union
  // must hand that back as a reason, never crash the conflict pass.
  const deep = (n: number) => "[".repeat(n) + "]".repeat(n);
  const base = "[\n  1\n]\n";
  const result = unionJsonInsertions(base, deep(60000), deep(60000));

  assert(!result.ok, "expected a refusal rather than a thrown error");
});

Deno.test("unionJsonInsertions - insertions keep their position relative to the base", () => {
  const base = '{\n  "entries": [\n    "b"\n  ]\n}\n';
  const ours = '{\n  "entries": [\n    "a",\n    "b"\n  ]\n}\n';
  const theirs = '{\n  "entries": [\n    "b",\n    "c"\n  ]\n}\n';

  assertEquals(JSON.parse(merged(base, ours, theirs)), {
    entries: ["a", "b", "c"],
  });
});

Deno.test("unionJsonInsertions - a key only one side added is kept", () => {
  const base = '{\n  "a": 1\n}\n';
  const ours = '{\n  "a": 1,\n  "b": 2\n}\n';
  const theirs = '{\n  "a": 1,\n  "c": 3\n}\n';

  assertEquals(JSON.parse(merged(base, ours, theirs)), { a: 1, b: 2, c: 3 });
});

Deno.test("unionJsonInsertions - two sides that edited the same entry are refused", () => {
  // Array items are matched by value, not by position, so an entry one side
  // rewrote is an item the base had that no longer appears. That is a
  // judgement — which rewrite wins — and the union does not make it.
  const withPath = (paths: string[]) => ({ ...SEED, paths });
  const reason = refusal(
    ledger([SEED]),
    ledger([withPath(["worker/deno/lib/a.ts", "worker/deno/lib/ours.ts"])]),
    ledger([withPath(["worker/deno/lib/a.ts", "worker/deno/lib/theirs.ts"])]),
  );

  assertStringIncludes(reason, "$.slices");
  assertStringIncludes(reason, "not two pure insertions");
});

Deno.test("unionJsonInsertions - a deleted array item is refused, never silently restored", () => {
  const reason = refusal(
    ledger([SEED, THEIRS_SLICE]),
    ledger([SEED]),
    ledger([SEED, THEIRS_SLICE, OURS_SLICE]),
  );

  assertStringIncludes(reason, "not two pure insertions");
});

Deno.test("unionJsonInsertions - a deleted key is refused", () => {
  const reason = refusal(
    '{\n  "a": 1,\n  "b": 2\n}\n',
    '{\n  "a": 1\n}\n',
    '{\n  "a": 1,\n  "b": 3\n}\n',
  );

  assertStringIncludes(reason, "deleted on one side");
});

Deno.test("unionJsonInsertions - a value both sides changed differently is refused", () => {
  const reason = refusal(
    '{\n  "parent": 1209\n}\n',
    '{\n  "parent": 1610\n}\n',
    '{\n  "parent": 1968\n}\n',
  );

  assertStringIncludes(reason, "$.parent");
  assertStringIncludes(reason, "two different values");
});

Deno.test("unionJsonInsertions - a value only one side changed takes that side", () => {
  const text = merged(
    '{\n  "parent": 1209\n}\n',
    '{\n  "parent": 1209\n}\n',
    '{\n  "parent": 1968\n}\n',
  );

  assertEquals(JSON.parse(text), { parent: 1968 });
});

Deno.test("unionJsonInsertions - text that is not JSON is refused, naming the side", () => {
  assertStringIncludes(
    refusal("{", '{\n  "a": 1\n}\n', '{\n  "a": 1\n}\n'),
    "the base side is not valid JSON",
  );
  assertStringIncludes(
    refusal('{\n  "a": 1\n}\n', "{ nope", '{\n  "a": 1\n}\n'),
    "the ours side is not valid JSON",
  );
  assertStringIncludes(
    refusal('{\n  "a": 1\n}\n', '{\n  "a": 1\n}\n', "{ nope"),
    "the theirs side is not valid JSON",
  );
});

Deno.test("unionJsonInsertions - a base that would be reformatted is refused", () => {
  // A hand-compacted array: re-serialising it would rewrite a line neither
  // side touched, so the union declines rather than reformatting the file.
  const base = '{\n  "entries": ["a"]\n}\n';
  const reason = refusal(
    base,
    '{\n  "entries": ["a", "b"]\n}\n',
    '{\n  "entries": ["a", "c"]\n}\n',
  );

  assertStringIncludes(reason, "does not round-trip");
});

Deno.test("unionJsonInsertions - a tab-indented base is refused rather than respaced", () => {
  const base = '{\n\t"entries": [\n\t\t"a"\n\t]\n}\n';
  const reason = refusal(base, base, base);

  assertStringIncludes(reason, "not indented with spaces");
});

Deno.test("unionJsonInsertions - a base with no trailing newline keeps none", () => {
  const text = merged(
    '{\n  "entries": [\n    "a"\n  ]\n}',
    '{\n  "entries": [\n    "a",\n    "b"\n  ]\n}',
    '{\n  "entries": [\n    "a"\n  ]\n}',
  );

  assertEquals(text.endsWith("}"), true, "no newline was invented");
  assertEquals(JSON.parse(text), { entries: ["a", "b"] });
});

Deno.test("jsonEquals - compares structurally, ignoring key order", () => {
  assertEquals(jsonEquals({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }), true);
  assertEquals(jsonEquals({ a: 1 }, { a: 1, b: 2 }), false);
  assertEquals(jsonEquals([1, 2], [2, 1]), false);
  assertEquals(jsonEquals(null, null), true);
  assertEquals(jsonEquals(null, 0), false);
  assertEquals(jsonEquals("1", 1), false);
});
