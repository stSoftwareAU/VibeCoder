/**
 * Tests for audit_journal.ts — tamper-evident GitHub-mutation journal
 * (Issue #2380).
 *
 * Covers: writer correctness, hash-chain integrity, corruption detection,
 * and concurrent-write safety.
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  _resetAuditCaches,
  type AuditEntry,
  auditFilePath,
  computeEntryHash,
  loadEntries,
  recordMutation,
  verifyAllChains,
  verifyChain,
} from "../lib/audit_journal.ts";
import { anchorPath, rosterPath } from "../lib/audit_anchor.ts";

/** Build a fresh isolated journal location for a test. */
async function freshOpts(): Promise<
  { baseDir: string; workerId: string; date: string }
> {
  _resetAuditCaches();
  const baseDir = await Deno.makeTempDir();
  return { baseDir, workerId: "test-worker", date: "2026-05-29" };
}

Deno.test("audit_journal - recordMutation writes a chained entry", async () => {
  const opts = await freshOpts();
  const result = await recordMutation({
    runId: "run-1",
    repo: "org/repo",
    target: "123",
    verb: "issue-comment",
    outcome: "success",
    exitCode: 0,
    caller: "worker/deno/lib/pr_comments.ts",
  }, opts);

  assert(result.ok, "record should succeed");
  if (!result.ok) return;
  assertEquals(result.value.prevHash, "", "first entry chains from empty");
  assertEquals(result.value.verb, "issue-comment");
  assert(result.value.hash.length === 64, "SHA-256 hex is 64 chars");

  const path = auditFilePath(opts);
  const loaded = await loadEntries(path);
  assert(loaded.ok);
  if (!loaded.ok) return;
  assertEquals(loaded.value.length, 1);
  assertEquals(loaded.value[0]?.target, "123");
});

Deno.test("audit_journal - timestamp is auto-filled when absent", async () => {
  const opts = await freshOpts();
  const result = await recordMutation({
    runId: "run-1",
    verb: "git-push",
    outcome: "success",
  }, opts);
  assert(result.ok);
  if (!result.ok) return;
  // ISO 8601 timestamp present.
  assert(/^\d{4}-\d{2}-\d{2}T/.test(result.value.timestamp));
});

Deno.test("audit_journal - entries chain to the previous hash", async () => {
  const opts = await freshOpts();
  const first = await recordMutation(
    { runId: "r", verb: "issue-create", outcome: "success" },
    opts,
  );
  const second = await recordMutation(
    { runId: "r", verb: "pr-create", outcome: "success" },
    opts,
  );
  assert(first.ok && second.ok);
  if (!first.ok || !second.ok) return;
  assertEquals(
    second.value.prevHash,
    first.value.hash,
    "second entry links to first",
  );
});

Deno.test("audit_journal - verifyChain passes for an intact journal", async () => {
  const opts = await freshOpts();
  for (let i = 0; i < 5; i++) {
    await recordMutation(
      { runId: "r", verb: "label-create", target: `l${i}`, outcome: "success" },
      opts,
    );
  }
  const path = auditFilePath(opts);
  const result = await verifyChain(path);
  assert(result.ok);
  if (!result.ok) return;
  assertEquals(result.value.valid, true);
  assertEquals(result.value.count, 5);
});

Deno.test("audit_journal - verifyChain detects a corrupted entry", async () => {
  const opts = await freshOpts();
  for (let i = 0; i < 4; i++) {
    await recordMutation(
      { runId: "r", verb: "pr-merge", target: `${i}`, outcome: "success" },
      opts,
    );
  }
  const path = auditFilePath(opts);

  // Tamper with the second entry's verb without recomputing its hash.
  const content = await Deno.readTextFile(path);
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const tampered = JSON.parse(lines[1]!) as AuditEntry;
  tampered.verb = "issue-delete";
  lines[1] = JSON.stringify(tampered);
  await Deno.writeTextFile(path, lines.join("\n") + "\n");

  const result = await verifyChain(path);
  assert(result.ok);
  if (!result.ok) return;
  assertEquals(result.value.valid, false, "tampering must fail verification");
  assertEquals(result.value.brokenIndex, 1);
  assertEquals(result.value.reason, "hash mismatch");
});

Deno.test("audit_journal - verifyChain detects a deleted interior entry", async () => {
  const opts = await freshOpts();
  for (let i = 0; i < 4; i++) {
    await recordMutation(
      { runId: "r", verb: "issue-close", target: `${i}`, outcome: "success" },
      opts,
    );
  }
  const path = auditFilePath(opts);

  // Remove the second entry — the chain linkage of entry 2 (now index 1)
  // no longer matches the surviving previous hash.
  const content = await Deno.readTextFile(path);
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  lines.splice(1, 1);
  await Deno.writeTextFile(path, lines.join("\n") + "\n");

  const result = await verifyChain(path);
  assert(result.ok);
  if (!result.ok) return;
  assertEquals(result.value.valid, false);
  assertEquals(result.value.reason, "prevHash linkage mismatch");
});

Deno.test("audit_journal - concurrent writes stay consistent and ordered", async () => {
  const opts = await freshOpts();
  const writes = Array.from({ length: 20 }, (_, i) =>
    recordMutation(
      {
        runId: "r",
        verb: "git-push",
        target: `branch-${i}`,
        outcome: "success",
      },
      opts,
    ));
  const results = await Promise.all(writes);
  assert(results.every((r) => r.ok), "all concurrent writes succeed");

  const path = auditFilePath(opts);
  const loaded = await loadEntries(path);
  assert(loaded.ok);
  if (!loaded.ok) return;
  assertEquals(loaded.value.length, 20, "no entry lost under concurrency");

  const verified = await verifyChain(path);
  assert(verified.ok);
  if (!verified.ok) return;
  assertEquals(
    verified.value.valid,
    true,
    "chain intact after concurrent writes",
  );
});

Deno.test("audit_journal - verifyChain errors on a missing file", async () => {
  _resetAuditCaches();
  const result = await verifyChain("/nonexistent/audit/file.jsonl");
  assertEquals(result.ok, false);
});

Deno.test("audit_journal - computeEntryHash is deterministic and order-independent", async () => {
  const a = await computeEntryHash(
    {
      timestamp: "2026-05-29T00:00:00.000Z",
      runId: "r",
      verb: "pr-create",
      outcome: "success",
    },
    "",
  );
  const b = await computeEntryHash(
    {
      outcome: "success",
      verb: "pr-create",
      runId: "r",
      timestamp: "2026-05-29T00:00:00.000Z",
    },
    "",
  );
  assertEquals(a, b, "hash independent of object key order");

  const c = await computeEntryHash(
    {
      timestamp: "2026-05-29T00:00:00.000Z",
      runId: "r",
      verb: "pr-merge",
      outcome: "success",
    },
    "",
  );
  assert(a !== c, "different payload yields a different hash");
});

// ---------------------------------------------------------------------------
// Issue #3949 — pair-delete, directory-delete and post-anchor append
// ---------------------------------------------------------------------------

Deno.test("audit_journal - verifyAllChains reports a journal deleted together with its anchor (Issue #3949)", async () => {
  const opts = await freshOpts();
  for (let i = 0; i < 2; i++) {
    const result = await recordMutation(
      { runId: "r", verb: "issue-comment", target: `${i}`, outcome: "success" },
      opts,
    );
    assert(result.ok);
  }
  const path = auditFilePath(opts);

  // The simplest tampering there is: remove the journal AND its anchor.
  await Deno.remove(path);
  await Deno.remove(anchorPath(path));
  _resetAuditCaches();

  const swept = await verifyAllChains(opts.baseDir);
  assert(swept.ok);
  if (!swept.ok) return;
  assertEquals(
    swept.value.broken.length,
    1,
    "a pair-delete must be a broken chain, not an empty sweep",
  );
  assert(
    (swept.value.broken[0]?.reason ?? "").includes("roster"),
    `reason should name the roster, got: ${swept.value.broken[0]?.reason}`,
  );
});

Deno.test("audit_journal - verifyAllChains reports a removed audit directory when the roster is non-empty (Issue #3949)", async () => {
  const opts = await freshOpts();
  const result = await recordMutation(
    { runId: "r", verb: "git-push", outcome: "success" },
    opts,
  );
  assert(result.ok);

  // rm -rf of the whole audit directory. The roster lives outside it.
  await Deno.remove(opts.baseDir, { recursive: true });
  _resetAuditCaches();

  const swept = await verifyAllChains(opts.baseDir);
  assert(swept.ok);
  if (!swept.ok) return;
  assert(
    swept.value.broken.length >= 1,
    "a deleted audit directory must not verify as a clean, empty sweep",
  );
});

Deno.test("audit_journal - verifyAllChains still treats an absent directory with no roster as clean (Issue #3949)", async () => {
  _resetAuditCaches();
  const ghost = `${await Deno.makeTempDir()}/never-created`;
  const swept = await verifyAllChains(ghost);
  assert(swept.ok);
  if (!swept.ok) return;
  assertEquals(swept.value.checked, 0);
  assertEquals(swept.value.broken, []);
});

Deno.test("audit_journal - verifyAllChains reports complete erasure of the audit directory and roster (Issue #270)", async () => {
  const opts = await freshOpts();
  const result = await recordMutation(
    { runId: "r", verb: "git-push", outcome: "success" },
    opts,
  );
  assert(result.ok);

  // The hole #3949 left open: delete the journal directory AND the roster
  // together. Without a third witness this reads as a clean empty sweep.
  await Deno.remove(opts.baseDir, { recursive: true });
  await Deno.remove(rosterPath(opts.baseDir));
  _resetAuditCaches();

  const swept = await verifyAllChains(opts.baseDir);
  assert(swept.ok);
  if (!swept.ok) return;
  assert(
    swept.value.broken.length >= 1,
    "deleting the audit directory and roster together must not verify as a clean, empty sweep",
  );
  assert(
    (swept.value.broken[0]?.reason ?? "").includes("erasure") ||
      (swept.value.broken[0]?.reason ?? "").includes("roster"),
    `reason should name the complete erasure, got: ${
      swept.value.broken[0]?.reason
    }`,
  );
});

Deno.test("audit_journal - verifyChain flags entries appended past the anchor (Issue #3949)", async () => {
  const opts = await freshOpts();
  const first = await recordMutation(
    { runId: "r", verb: "issue-create", outcome: "success" },
    opts,
  );
  assert(first.ok);
  if (!first.ok) return;
  const path = auditFilePath(opts);

  // Forge a correctly-chained entry after the anchored head, without
  // updating the anchor — previously accepted as valid.
  const forgedPayload = {
    timestamp: "2026-05-29T23:59:59.000Z",
    runId: "forged",
    verb: "pr-merge" as const,
    outcome: "success" as const,
  };
  const forgedHash = await computeEntryHash(forgedPayload, first.value.hash);
  const forged = {
    ...forgedPayload,
    prevHash: first.value.hash,
    hash: forgedHash,
  };
  await Deno.writeTextFile(path, `${JSON.stringify(forged)}\n`, {
    append: true,
  });

  const result = await verifyChain(path);
  assert(result.ok);
  if (!result.ok) return;
  assertEquals(
    result.value.valid,
    false,
    "unanchored tail entries must not verify clean",
  );
  assert(
    (result.value.reason ?? "").includes("past the anchor"),
    `reason should name the post-anchor append, got: ${result.value.reason}`,
  );
});

Deno.test("audit_journal - recordMutation refuses to extend a journal with unanchored tail entries (Issue #3949)", async () => {
  const opts = await freshOpts();
  const first = await recordMutation(
    { runId: "r", verb: "issue-create", outcome: "success" },
    opts,
  );
  assert(first.ok);
  if (!first.ok) return;
  const path = auditFilePath(opts);

  const forgedPayload = {
    timestamp: "2026-05-29T23:59:59.000Z",
    runId: "forged",
    verb: "pr-merge" as const,
    outcome: "success" as const,
  };
  const forgedHash = await computeEntryHash(forgedPayload, first.value.hash);
  await Deno.writeTextFile(
    path,
    `${
      JSON.stringify({
        ...forgedPayload,
        prevHash: first.value.hash,
        hash: forgedHash,
      })
    }\n`,
    { append: true },
  );
  _resetAuditCaches();

  // A fresh process appending must not silently re-anchor the forged tail.
  const second = await recordMutation(
    { runId: "r", verb: "pr-create", outcome: "success" },
    opts,
  );
  assertEquals(
    second.ok,
    false,
    "appending over a forged tail would launder it into the anchor",
  );
});
