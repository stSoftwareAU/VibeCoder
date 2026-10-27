/**
 * Tests for `lib/merge_queue_runtime.ts` (Issue #4424): the merge-queue rule
 * read, its input allowlist, the ten-minute memo, and the production builder.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";
import {
  _resetMergeQueueMemo,
  isBaseMergeQueued,
  makeIsMergeQueueBase,
  resolveBaseMergeQueued,
} from "../lib/merge_queue_runtime.ts";

const REPO = "org/repo";
const BASE = "main";
const TTL_MS = 10 * 60 * 1000;

/** gh stub answering the rules endpoint with the given rule type list. */
function ghRules(
  types: string,
  calls: string[][] = [],
): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    calls.push(args);
    return Promise.resolve(types);
  };
}

// ---------------------------------------------------------------------------
// isBaseMergeQueued — the rule read
// ---------------------------------------------------------------------------

Deno.test("isBaseMergeQueued - true when the rules include a merge_queue rule", async () => {
  const result = await isBaseMergeQueued(
    REPO,
    BASE,
    ghRules("pull_request,merge_queue,required_status_checks\n"),
  );
  assertEquals(result, true);
});

Deno.test("isBaseMergeQueued - false when the rules carry no merge_queue rule", async () => {
  const result = await isBaseMergeQueued(
    REPO,
    BASE,
    ghRules("pull_request,required_status_checks\n"),
  );
  assertEquals(result, false);
});

Deno.test("isBaseMergeQueued - false when the base has no rules at all", async () => {
  const result = await isBaseMergeQueued(REPO, BASE, ghRules("\n"));
  assertEquals(result, false);
});

Deno.test("isBaseMergeQueued - a merge_queue substring in another rule name is not a match", async () => {
  const result = await isBaseMergeQueued(
    REPO,
    BASE,
    ghRules("not_merge_queue_like\n"),
  );
  assertEquals(result, false);
});

Deno.test("isBaseMergeQueued - reads the rules endpoint for the encoded base", async () => {
  const calls: string[][] = [];
  await isBaseMergeQueued(REPO, "release/v1-beta", ghRules("", calls));
  assertEquals(calls, [[
    "api",
    `repos/${REPO}/rules/branches/release%2Fv1-beta`,
    "--jq",
    '[.[] | .type] | join(",")',
  ]]);
});

Deno.test("isBaseMergeQueued - null when the lookup fails", async () => {
  const result = await isBaseMergeQueued(
    REPO,
    BASE,
    () => Promise.reject(new Error("HTTP 403")),
  );
  assertEquals(result, null);
});

Deno.test("isBaseMergeQueued - invalid repo slug returns null without calling gh", async () => {
  const calls: string[][] = [];
  const result = await isBaseMergeQueued(
    "org/repo;rm -rf",
    BASE,
    ghRules("merge_queue", calls),
  );
  assertEquals(result, null);
  assertEquals(calls.length, 0);
});

Deno.test("isBaseMergeQueued - invalid branch name returns null without calling gh", async () => {
  const calls: string[][] = [];
  const result = await isBaseMergeQueued(
    REPO,
    "../etc/passwd",
    ghRules("merge_queue", calls),
  );
  assertEquals(result, null);
  assertEquals(calls.length, 0);
});

// ---------------------------------------------------------------------------
// resolveBaseMergeQueued — the ten-minute memo
// ---------------------------------------------------------------------------

/** Lookup stub that counts its reads and answers `answer` each time. */
function countingLookup(answer: boolean | null) {
  const reads = { count: 0 };
  const fn = (_repo: string, _base: string) => {
    reads.count++;
    return Promise.resolve(answer);
  };
  return { reads, fn };
}

const NEVER_GH = (_args: string[]): Promise<string> =>
  Promise.reject(new Error("gh must not be called"));

Deno.test("resolveBaseMergeQueued - a second read within the TTL is served from the memo", async () => {
  _resetMergeQueueMemo();
  const { reads, fn } = countingLookup(true);
  let clock = 1_000;
  const now = () => clock;
  const first = await resolveBaseMergeQueued(REPO, BASE, NEVER_GH, {
    isBaseMergeQueuedFn: fn,
    now,
  });
  clock += TTL_MS - 1;
  const second = await resolveBaseMergeQueued(REPO, BASE, NEVER_GH, {
    isBaseMergeQueuedFn: fn,
    now,
  });
  assertEquals(first, true);
  assertEquals(second, true);
  assertEquals(reads.count, 1);
});

Deno.test("resolveBaseMergeQueued - the memo expires once the TTL has passed", async () => {
  _resetMergeQueueMemo();
  const { reads, fn } = countingLookup(true);
  let clock = 1_000;
  const now = () => clock;
  await resolveBaseMergeQueued(REPO, BASE, NEVER_GH, {
    isBaseMergeQueuedFn: fn,
    now,
  });
  clock += TTL_MS + 1;
  await resolveBaseMergeQueued(REPO, BASE, NEVER_GH, {
    isBaseMergeQueuedFn: fn,
    now,
  });
  assertEquals(reads.count, 2);
});

Deno.test("resolveBaseMergeQueued - a queue enabled after the first read is seen once the memo expires", async () => {
  _resetMergeQueueMemo();
  let queued = false;
  const fn = (_repo: string, _base: string) => Promise.resolve(queued);
  let clock = 1_000;
  const now = () => clock;
  const before = await resolveBaseMergeQueued(REPO, BASE, NEVER_GH, {
    isBaseMergeQueuedFn: fn,
    now,
  });
  queued = true;
  clock += TTL_MS + 1;
  const after = await resolveBaseMergeQueued(REPO, BASE, NEVER_GH, {
    isBaseMergeQueuedFn: fn,
    now,
  });
  assertEquals(before, false);
  assertEquals(after, true);
});

Deno.test("resolveBaseMergeQueued - a null read is not memoised, so the next call reads again", async () => {
  _resetMergeQueueMemo();
  const { reads, fn } = countingLookup(null);
  const now = () => 1_000;
  const first = await resolveBaseMergeQueued(REPO, BASE, NEVER_GH, {
    isBaseMergeQueuedFn: fn,
    now,
  });
  const second = await resolveBaseMergeQueued(REPO, BASE, NEVER_GH, {
    isBaseMergeQueuedFn: fn,
    now,
  });
  assertEquals(first, null);
  assertEquals(second, null);
  assertEquals(reads.count, 2);
});

Deno.test("resolveBaseMergeQueued - the memo is keyed per repo and base", async () => {
  _resetMergeQueueMemo();
  const { reads, fn } = countingLookup(false);
  const now = () => 1_000;
  await resolveBaseMergeQueued(REPO, BASE, NEVER_GH, {
    isBaseMergeQueuedFn: fn,
    now,
  });
  await resolveBaseMergeQueued(REPO, "milestone/v2", NEVER_GH, {
    isBaseMergeQueuedFn: fn,
    now,
  });
  await resolveBaseMergeQueued("org/other", BASE, NEVER_GH, {
    isBaseMergeQueuedFn: fn,
    now,
  });
  assertEquals(reads.count, 3);
});

// ---------------------------------------------------------------------------
// makeIsMergeQueueBase — the production dep
// ---------------------------------------------------------------------------

Deno.test("makeIsMergeQueueBase - resolves true for a queued base through the given gh runner", async () => {
  _resetMergeQueueMemo();
  const calls: string[][] = [];
  const dep = makeIsMergeQueueBase(ghRules("merge_queue", calls));
  assertEquals(await dep(REPO, BASE), true);
  assertEquals(calls.length, 1);
});

Deno.test("makeIsMergeQueueBase - false when the base is not queued", async () => {
  _resetMergeQueueMemo();
  const dep = makeIsMergeQueueBase(ghRules("required_status_checks"));
  assertEquals(await dep(REPO, BASE), false);
});

Deno.test("makeIsMergeQueueBase - a failed lookup reads as not queued", async () => {
  _resetMergeQueueMemo();
  const dep = makeIsMergeQueueBase(() => Promise.reject(new Error("boom")));
  assertEquals(await dep(REPO, BASE), false);
});
