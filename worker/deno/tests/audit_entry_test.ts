/**
 * Chain hashing for audit journal entries (Issue #2380, extracted #1074).
 *
 * The hash is what makes the journal tamper-evident and what the crash
 * recovery re-derives to tell a declared entry from a forged one, so the
 * properties it depends on are pinned here: same content, same digest,
 * whatever order the keys arrive in; different content or a different
 * predecessor, different digest.
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { type AuditMutation, computeEntryHash } from "../lib/audit_entry.ts";

/** A mutation with its timestamp already resolved. */
const MUTATION: AuditMutation & { timestamp: string } = {
  timestamp: "2026-09-05T00:49:12.000Z",
  runId: "run-1",
  repo: "org/repo",
  target: "123",
  verb: "issue-comment",
  outcome: "success",
  exitCode: 0,
  caller: "worker/deno/lib/pr_comments.ts",
};

Deno.test("audit_entry - the digest is a 64-character lowercase hex string", async () => {
  const hash = await computeEntryHash(MUTATION, "");
  assertEquals(hash.length, 64);
  assert(/^[0-9a-f]{64}$/.test(hash), `not lowercase hex: ${hash}`);
});

Deno.test("audit_entry - the same entry always hashes to the same value", async () => {
  assertEquals(
    await computeEntryHash(MUTATION, "abc"),
    await computeEntryHash({ ...MUTATION }, "abc"),
  );
});

Deno.test("audit_entry - key order does not change the digest", async () => {
  // The payload is canonicalised into a fixed field order, so an entry
  // rebuilt with its keys in another order is the same entry.
  const reordered = {
    caller: MUTATION.caller,
    outcome: MUTATION.outcome,
    verb: MUTATION.verb,
    exitCode: MUTATION.exitCode,
    target: MUTATION.target,
    repo: MUTATION.repo,
    runId: MUTATION.runId,
    timestamp: MUTATION.timestamp,
  };
  assertEquals(
    await computeEntryHash(reordered, ""),
    await computeEntryHash(MUTATION, ""),
  );
});

Deno.test("audit_entry - changing any field changes the digest", async () => {
  const base = await computeEntryHash(MUTATION, "");
  for (
    const altered of [
      { ...MUTATION, target: "124" },
      { ...MUTATION, verb: "pr-merge" },
      { ...MUTATION, outcome: "error" as const },
      { ...MUTATION, timestamp: "2026-09-05T00:49:13.000Z" },
    ]
  ) {
    assertNotEquals(
      await computeEntryHash(altered, ""),
      base,
      `an edit to ${JSON.stringify(altered)} left the digest unchanged`,
    );
  }
});

Deno.test("audit_entry - the predecessor is part of the digest", async () => {
  // This is the chain: the same entry after a different entry is a
  // different link, which is what makes an interior deletion detectable.
  assertNotEquals(
    await computeEntryHash(MUTATION, "aaa"),
    await computeEntryHash(MUTATION, "bbb"),
  );
});

Deno.test("audit_entry - an absent optional field is not an empty one", async () => {
  const { repo: _repo, ...withoutRepo } = MUTATION;
  assertNotEquals(
    await computeEntryHash(withoutRepo, ""),
    await computeEntryHash({ ...MUTATION, repo: "" }, ""),
  );
});
