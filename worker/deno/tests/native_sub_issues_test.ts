/**
 * Tests for native_sub_issues.ts (Issue #2900).
 *
 * The auto-milestone path must derive a planning run's sub-issues from the
 * parent's *native* GitHub sub-issue links, not only from text-extracted URLs.
 * These tests exercise the real fetch/parse helpers against mock gh output.
 *
 * Coverage:
 *   - parseNativeSubIssueNumbers: happy path, dedup/sort, malformed input,
 *     non-array body, entries missing/invalid `number`.
 *   - fetchNativeSubIssueNumbers: happy path hits the sub_issues endpoint,
 *     invalid repo / issue number short-circuit (no gh call), gh throw is
 *     swallowed to an empty list.
 *
 * Australian English spelling used throughout.
 */

import { assertEquals } from "@std/assert";
import {
  fetchNativeSubIssueNumbers,
  parseNativeSubIssueNumbers,
} from "../lib/native_sub_issues.ts";

// ---------------------------------------------------------------------------
// parseNativeSubIssueNumbers
// ---------------------------------------------------------------------------

Deno.test("parseNativeSubIssueNumbers — extracts numbers from a valid array", () => {
  const raw = JSON.stringify([
    { number: 1419, title: "a" },
    { number: 1420, title: "b" },
    { number: 1424, title: "c" },
  ]);
  assertEquals(parseNativeSubIssueNumbers(raw), [1419, 1420, 1424]);
});

Deno.test("parseNativeSubIssueNumbers — de-duplicates and sorts ascending", () => {
  const raw = JSON.stringify([
    { number: 30 },
    { number: 10 },
    { number: 30 },
    { number: 20 },
  ]);
  assertEquals(parseNativeSubIssueNumbers(raw), [10, 20, 30]);
});

Deno.test("parseNativeSubIssueNumbers — ignores entries without a valid number", () => {
  const raw = JSON.stringify([
    { number: 5 },
    { title: "no number" },
    { number: "12" },
    { number: -3 },
    { number: 7.5 },
    null,
    42,
    { number: 6 },
  ]);
  assertEquals(parseNativeSubIssueNumbers(raw), [5, 6]);
});

Deno.test("parseNativeSubIssueNumbers — malformed JSON yields empty array", () => {
  assertEquals(parseNativeSubIssueNumbers("not json"), []);
  assertEquals(parseNativeSubIssueNumbers(""), []);
});

Deno.test("parseNativeSubIssueNumbers — non-array body yields empty array", () => {
  assertEquals(parseNativeSubIssueNumbers(JSON.stringify({ number: 1 })), []);
  assertEquals(parseNativeSubIssueNumbers("[]"), []);
});

// ---------------------------------------------------------------------------
// fetchNativeSubIssueNumbers
// ---------------------------------------------------------------------------

Deno.test("fetchNativeSubIssueNumbers — queries the sub_issues endpoint and returns numbers", async () => {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    return Promise.resolve(
      JSON.stringify([{ number: 1419 }, { number: 1424 }]),
    );
  };

  const result = await fetchNativeSubIssueNumbers(
    "example-org/private-repo-32",
    1418,
    gh,
  );

  assertEquals(result, [1419, 1424]);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]?.[0], "api");
  assertEquals(
    calls[0]?.[1],
    "repos/example-org/private-repo-32/issues/1418/sub_issues?per_page=100",
  );
});

Deno.test("fetchNativeSubIssueNumbers — invalid repo short-circuits without a gh call", async () => {
  let called = false;
  const gh = (_args: string[]): Promise<string> => {
    called = true;
    return Promise.resolve("[]");
  };

  assertEquals(await fetchNativeSubIssueNumbers("not-a-repo", 1, gh), []);
  assertEquals(called, false);
});

Deno.test("fetchNativeSubIssueNumbers — non-positive issue number short-circuits", async () => {
  let called = false;
  const gh = (_args: string[]): Promise<string> => {
    called = true;
    return Promise.resolve("[]");
  };

  assertEquals(await fetchNativeSubIssueNumbers("o/r", 0, gh), []);
  assertEquals(await fetchNativeSubIssueNumbers("o/r", -5, gh), []);
  assertEquals(called, false);
});

Deno.test("fetchNativeSubIssueNumbers — gh failure is swallowed to an empty list", async () => {
  const gh = (_args: string[]): Promise<string> =>
    Promise.reject(new Error("network down"));

  assertEquals(await fetchNativeSubIssueNumbers("o/r", 1418, gh), []);
});
