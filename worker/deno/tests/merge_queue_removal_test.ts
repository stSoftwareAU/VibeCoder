/**
 * Tests for merge_queue_removal.ts — the merge-queue removal reader
 * (Issue #4424).
 *
 * Covers: the empty state, applicability to the current head (by commit oid,
 * and by date when the oid is absent), malformed responses naming the missing
 * field, reason normalisation, input validation before any `gh` call, and the
 * `readQueueRemoval` result shapes.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  describeQueueRemoval,
  MERGE_QUEUE_CHECK_NAME,
  parseQueueRemovalResponse,
  type QueueRemoval,
  queueRemovalAppliesToHead,
  readQueueRemoval,
} from "../lib/merge_queue_removal.ts";

const HEAD_SHA = "2f9c1d0e7b6a5948372615049382716051a4b3c2";
const OLD_SHA = "9e8d7c6b5a4938271605f4e3d2c1b0a998877665";
const HEAD_COMMITTED = "2026-10-20T08:00:00Z";
const REMOVED_AFTER = "2026-10-21T09:30:00Z";
const REMOVED_BEFORE = "2026-10-19T09:30:00Z";

/** A RemovedFromMergeQueueEvent node, with the given fields overridden. */
function removalNode(
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    __typename: "RemovedFromMergeQueueEvent",
    reason: "Failed group check",
    createdAt: REMOVED_AFTER,
    beforeCommit: { oid: OLD_SHA },
    ...fields,
  };
}

/** A `pullRequest` object shaped like the real response. */
function pullRequest(
  timelineNodes: unknown[] = [],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    headRefOid: HEAD_SHA,
    commits: { nodes: [{ commit: { committedDate: HEAD_COMMITTED } }] },
    timelineItems: { nodes: timelineNodes },
    ...overrides,
  };
}

/** A full `gh api graphql` response body around a `pullRequest` value. */
function response(pr: unknown): string {
  return JSON.stringify({ data: { repository: { pullRequest: pr } } });
}

/** A `gh` stand-in that records every call and answers with `raw`. */
function spyGh(raw: string): {
  fn: (args: string[]) => Promise<string>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const fn = (args: string[]) => {
    calls.push(args);
    return Promise.resolve(raw);
  };
  return { fn, calls };
}

function parseRemoval(raw: string): {
  removal: QueueRemoval | null;
  headSha: string;
  headCommittedAt: string | null;
} {
  return parseQueueRemovalResponse(raw);
}

Deno.test("empty nodes is the documented empty state with no removal", () => {
  const parsed = parseRemoval(response(pullRequest([])));
  assertEquals(parsed.removal, null);
  assertEquals(parsed.headSha, HEAD_SHA);
  assertEquals(parsed.headCommittedAt, HEAD_COMMITTED);
});

Deno.test("a removal whose beforeCommit equals the head applies", () => {
  const parsed = parseRemoval(
    response(pullRequest([removalNode({ beforeCommit: { oid: HEAD_SHA } })])),
  );
  assert(parsed.removal !== null);
  assertEquals(parsed.removal.beforeCommitOid, HEAD_SHA);
  assertEquals(
    queueRemovalAppliesToHead(
      parsed.removal,
      parsed.headSha,
      parsed.headCommittedAt,
    ),
    true,
  );
});

Deno.test("a removal recorded against a different oid does not apply once a fix is pushed", () => {
  // OLD_SHA is what the queue built; HEAD_SHA is the fix pushed afterwards.
  const parsed = parseRemoval(
    response(pullRequest([removalNode({ beforeCommit: { oid: OLD_SHA } })])),
  );
  assert(parsed.removal !== null);
  assertEquals(parsed.removal.beforeCommitOid, OLD_SHA);
  assertEquals(
    queueRemovalAppliesToHead(
      parsed.removal,
      parsed.headSha,
      parsed.headCommittedAt,
    ),
    false,
  );
});

Deno.test("beforeCommit oid comparison ignores case", () => {
  const removal: QueueRemoval = {
    reason: "Failed group check",
    removedAt: REMOVED_AFTER,
    beforeCommitOid: HEAD_SHA.toUpperCase(),
  };
  assertEquals(
    queueRemovalAppliesToHead(removal, HEAD_SHA, HEAD_COMMITTED),
    true,
  );
});

Deno.test("a null beforeCommit applies when the removal is at or after the head commit", () => {
  const parsed = parseRemoval(
    response(
      pullRequest([
        removalNode({ beforeCommit: null, createdAt: REMOVED_AFTER }),
      ]),
    ),
  );
  assert(parsed.removal !== null);
  assertEquals(parsed.removal.beforeCommitOid, null);
  assertEquals(
    queueRemovalAppliesToHead(
      parsed.removal,
      parsed.headSha,
      parsed.headCommittedAt,
    ),
    true,
  );
});

Deno.test("a null beforeCommit does not apply when the removal predates the head commit", () => {
  const parsed = parseRemoval(
    response(
      pullRequest([
        removalNode({ beforeCommit: null, createdAt: REMOVED_BEFORE }),
      ]),
    ),
  );
  assert(parsed.removal !== null);
  assertEquals(
    queueRemovalAppliesToHead(
      parsed.removal,
      parsed.headSha,
      parsed.headCommittedAt,
    ),
    false,
  );
});

Deno.test("a null beforeCommit does not apply on an unparseable date", () => {
  const badRemoval: QueueRemoval = {
    reason: "Failed group check",
    removedAt: "not-a-date",
    beforeCommitOid: null,
  };
  assertEquals(
    queueRemovalAppliesToHead(badRemoval, HEAD_SHA, HEAD_COMMITTED),
    false,
  );

  const goodRemoval: QueueRemoval = {
    reason: "Failed group check",
    removedAt: REMOVED_AFTER,
    beforeCommitOid: null,
  };
  // An unparseable head commit date is not proof either.
  assertEquals(
    queueRemovalAppliesToHead(goodRemoval, HEAD_SHA, "not-a-date"),
    false,
  );
  assertEquals(queueRemovalAppliesToHead(goodRemoval, HEAD_SHA, null), false);
});

Deno.test("a response missing data.repository.pullRequest is rejected naming pullRequest", () => {
  assertThrows(
    () =>
      parseQueueRemovalResponse(JSON.stringify({ data: { repository: {} } })),
    Error,
    "pullRequest",
  );
});

Deno.test("a response missing headRefOid is rejected naming headRefOid", () => {
  assertThrows(
    () =>
      parseQueueRemovalResponse(
        response(pullRequest([], { headRefOid: undefined })),
      ),
    Error,
    "headRefOid",
  );
});

Deno.test("a response missing timelineItems.nodes is rejected naming nodes, not treated as empty", () => {
  assertThrows(
    () =>
      parseQueueRemovalResponse(
        response(pullRequest([], { timelineItems: {} })),
      ),
    Error,
    "timelineItems.nodes",
  );
});

Deno.test("a non-JSON response is rejected", () => {
  assertThrows(
    () => parseQueueRemovalResponse("<html>502</html>"),
    Error,
    "not JSON",
  );
});

Deno.test("a long multi-line reason is capped at 200 characters and made single-line", () => {
  const longReason = "Failed group check\n\nsee the logs\t" + "x".repeat(400);
  const parsed = parseRemoval(
    response(pullRequest([removalNode({ reason: longReason })])),
  );
  assert(parsed.removal !== null);
  const { reason } = parsed.removal;
  assert(reason.length <= 200, `reason is ${reason.length} characters`);
  assertEquals(/[\r\n\t]/.test(reason), false);
  assert(reason.startsWith("Failed group check see the logs"));
  assert(reason.endsWith("..."));
});

Deno.test("a null or blank reason is recorded as no reason recorded", () => {
  for (const reason of [null, "", "  \n\t "]) {
    const parsed = parseRemoval(
      response(pullRequest([removalNode({ reason })])),
    );
    assert(parsed.removal !== null);
    assertEquals(parsed.removal.reason, "no reason recorded");
  }
});

Deno.test("a non-string reason is rejected naming reason", () => {
  assertThrows(
    () =>
      parseQueueRemovalResponse(
        response(pullRequest([removalNode({ reason: 42 })])),
      ),
    Error,
    "reason",
  );
});

Deno.test("an invalid repo slug or PR number is rejected before any gh call", async () => {
  const cases: Array<[string, number]> = [
    ["not a slug", 42],
    ["owner/repo/extra", 42],
    ["owner/repo", 0],
    ["owner/repo", Number.NaN],
    ["owner/repo", -3],
    ["owner/repo", 1.5],
  ];
  for (const [repo, prNumber] of cases) {
    const { fn, calls } = spyGh(response(pullRequest([])));
    const result = await readQueueRemoval(repo, prNumber, fn);
    assertEquals(result.ok, false, `${repo} #${prNumber} should be refused`);
    assertEquals(calls.length, 0, `${repo} #${prNumber} made a gh call`);
  }
});

Deno.test("readQueueRemoval returns null when the removal is for an older head", async () => {
  const { fn, calls } = spyGh(
    response(
      pullRequest([removalNode({ beforeCommit: { oid: OLD_SHA } })]),
    ),
  );
  const result = await readQueueRemoval("octo/widgets", 42, fn);
  assertEquals(result, { ok: true, value: null });
  assertEquals(calls.length, 1);
});

Deno.test("readQueueRemoval returns the removal when it applies to the head", async () => {
  const { fn, calls } = spyGh(
    response(
      pullRequest([removalNode({ beforeCommit: { oid: HEAD_SHA } })]),
    ),
  );
  const result = await readQueueRemoval("octo/widgets", 42, fn);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assert(result.value !== null);
  assertEquals(result.value.beforeCommitOid, HEAD_SHA);
  assertEquals(result.value.reason, "Failed group check");

  assertEquals(calls.length, 1);
  const args = calls[0] ?? [];
  assertEquals(args.slice(0, 2), ["api", "graphql"]);
  assert(args.includes("owner=octo"));
  assert(args.includes("name=widgets"));
  assert(args.includes("number=42"));
});

Deno.test("readQueueRemoval reports a gh failure with the cause text", async () => {
  const fn = (_args: string[]) =>
    Promise.reject(new Error("HTTP 502 bad gateway"));
  const result = await readQueueRemoval("octo/widgets", 42, fn);
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertStringIncludes(result.error.message, "HTTP 502 bad gateway");
});

Deno.test("readQueueRemoval reports a malformed response naming the missing field", async () => {
  const { fn } = spyGh(JSON.stringify({ data: { repository: {} } }));
  const result = await readQueueRemoval("octo/widgets", 42, fn);
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertStringIncludes(result.error.message, "pullRequest");
});

Deno.test("describeQueueRemoval gives one line naming the reason and the time", () => {
  const removal: QueueRemoval = {
    reason: "Failed group check",
    removedAt: REMOVED_AFTER,
    beforeCommitOid: HEAD_SHA,
  };
  const line = describeQueueRemoval(removal);
  assertStringIncludes(
    line,
    `Removed from the merge queue (Failed group check) at ${REMOVED_AFTER}`,
  );
  assertEquals(/[\r\n]/.test(line), false);
  assertEquals(MERGE_QUEUE_CHECK_NAME, "merge queue");
});
