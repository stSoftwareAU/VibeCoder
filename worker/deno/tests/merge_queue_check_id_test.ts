/**
 * Tests for the synthetic merge-queue check id (Issue #4424).
 *
 * The id is the only handle the CI-fix lane carries for a queue removal, so
 * it must be stable per head, distinct from every GitHub check id, and never
 * parse as one (a numeric or `suite-<n>` id would send a lookup to GitHub).
 *
 * Uses Australian English throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  isMergeQueueCheckId,
  MERGE_QUEUE_CHECK_ID_PREFIX,
  mergeQueueCheckId,
} from "../lib/merge_queue_check_id.ts";
import { parseCheckSuiteId } from "../lib/github_actions_log_fetcher.ts";

const HEAD_SHA = "abcdef0123456789abcdef0123456789abcdef01";

Deno.test("merge_queue_check_id - the prefix is 'merge-queue-'", () => {
  assertEquals(MERGE_QUEUE_CHECK_ID_PREFIX, "merge-queue-");
});

Deno.test("merge_queue_check_id - the id is the prefix and the first 12 head characters", () => {
  assertEquals(mergeQueueCheckId(HEAD_SHA), "merge-queue-abcdef012345");
});

Deno.test("merge_queue_check_id - a short head sha is used whole, not padded", () => {
  assertEquals(mergeQueueCheckId("abc"), "merge-queue-abc");
});

Deno.test("merge_queue_check_id - the id is stable for one head and changes with the head", () => {
  const next = `fedcba9876543210${"0".repeat(24)}`;
  assertEquals(mergeQueueCheckId(HEAD_SHA), mergeQueueCheckId(HEAD_SHA));
  assertNotEquals(mergeQueueCheckId(HEAD_SHA), mergeQueueCheckId(next));
});

Deno.test("merge_queue_check_id - isMergeQueueCheckId recognises the synthetic id", () => {
  assert(isMergeQueueCheckId(mergeQueueCheckId(HEAD_SHA)));
});

Deno.test("merge_queue_check_id - isMergeQueueCheckId rejects real GitHub check ids", () => {
  assertEquals(isMergeQueueCheckId("901"), false);
  assertEquals(isMergeQueueCheckId("suite-4347"), false);
  assertEquals(isMergeQueueCheckId(""), false);
});

Deno.test("merge_queue_check_id - the synthetic id never parses as a startup-suite id or a job id", () => {
  const id = mergeQueueCheckId(HEAD_SHA);
  assertEquals(parseCheckSuiteId(id), null);
  assert(Number.isNaN(Number(id)));
});
