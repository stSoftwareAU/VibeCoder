/**
 * Tests for audit_journal.ts — tamper-evident GitHub-mutation journal
 * (Issue #2380).
 *
 * Covers: writer correctness, hash-chain integrity, corruption detection,
 * and concurrent-write safety.
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
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

  const forged = await Deno.readTextFile(path);

  // Contract change, Issue #361 (documented, not silently relaxed): this
  // used to assert the append FAILS. The invariant it protects — a forged
  // tail is never laundered into the anchor — is unchanged and is now
  // asserted directly: the file and its anchor are byte-for-byte as the
  // forger left them. What changed is that recording continues in a
  // quarantine segment instead of stopping dead, because refusing every
  // later append left the host mutating GitHub with no trail at all.
  const second = await recordMutation(
    { runId: "r", verb: "pr-create", outcome: "success" },
    opts,
  );
  assert(second.ok, "recording must continue rather than stop dead");
  assertEquals(
    await Deno.readTextFile(path),
    forged,
    "appending over a forged tail would launder it into the anchor",
  );
  assertStringIncludes(
    await Deno.readTextFile(path.replace(/\.jsonl$/, ".s1.jsonl")),
    "pr-create",
  );

  // And the forged journal still fails the sweep, as loudly as before.
  const swept = await verifyAllChains(opts.baseDir);
  assert(swept.ok);
  if (!swept.ok) return;
  assertEquals(swept.value.broken.filter((b) => b.path === path).length, 1);
});

// ---------------------------------------------------------------------------
// Quarantine on damage (Issue #361)
//
// Host GRQ-23, 2026-08-25: one torn line at entry 31 of the day's journal.
// Every subsequent gh/git mutation logged
//   [SECURITY] [AUDIT_JOURNAL_REFUSED] issue-comment: audit journal rewritten:
//   …/audit-worker-2026-08-25.jsonl entry 31 no longer carries the anchored
//   head hash
// and went unrecorded, while the worker carried on mutating GitHub. An audit
// trail that stops recording when it is damaged fails in exactly the wrong
// direction: the damage is in the past, the mutations it stops attesting are
// in the future.
// ---------------------------------------------------------------------------

Deno.test("audit_journal - a torn line does not stop the trail; recording moves to a quarantine segment (Issue #361)", async () => {
  const opts = await freshOpts();
  for (let i = 0; i < 3; i++) {
    assert(
      (await recordMutation({
        runId: `r${i}`,
        verb: "issue-comment",
        outcome: "success",
      }, opts)).ok,
    );
  }
  const path = auditFilePath(opts);

  // Tear the anchored head line, exactly as the host's entry 31 was torn:
  // "entry 31 no longer carries the anchored head hash". A half-written
  // final line is what an interrupted or interleaved append leaves behind.
  const lines = (await Deno.readTextFile(path)).split("\n").filter((l) =>
    l.trim().length > 0
  );
  const last = lines.length - 1;
  lines[last] = lines[last]!.slice(0, Math.floor(lines[last]!.length / 2));
  await Deno.writeTextFile(path, `${lines.join("\n")}\n`);
  const torn = await Deno.readTextFile(path);
  const anchorBefore = await Deno.readTextFile(anchorPath(path));
  _resetAuditCaches();

  const after = await recordMutation({
    runId: "after-tear",
    verb: "pr-merge",
    outcome: "success",
  }, opts);
  assert(
    after.ok,
    `the mutation must still be recorded, got: ${
      !after.ok && after.error.message
    }`,
  );

  // The torn journal is evidence: untouched, still anchored as it was.
  assertEquals(await Deno.readTextFile(path), torn);
  assertEquals(await Deno.readTextFile(anchorPath(path)), anchorBefore);

  // The segment beside it opens by recording what it displaced, and carries
  // the mutation — chained, anchored and verifiable in its own right.
  const segment = path.replace(/\.jsonl$/, ".s1.jsonl");
  const entries = await loadEntries(segment);
  assert(entries.ok);
  if (!entries.ok) return;
  assertEquals(entries.value.length, 2);
  assertEquals(entries.value[0]!.verb, "audit-journal-quarantined");
  assertEquals(entries.value[0]!.outcome, "error");
  assertEquals(entries.value[1]!.verb, "pr-merge");
  const segmentChain = await verifyChain(segment);
  assert(segmentChain.ok && segmentChain.value.valid);

  // The damage stays loud: the sweep still fails on the torn journal, and
  // the segment is not offered as a replacement for it.
  const swept = await verifyAllChains(opts.baseDir);
  assert(swept.ok);
  if (!swept.ok) return;
  assertEquals(swept.value.broken.filter((b) => b.path === path).length, 1);
  assertEquals(swept.value.broken.filter((b) => b.path === segment).length, 0);
});

Deno.test("audit_journal - a second run appends to the existing segment rather than opening another (Issue #361)", async () => {
  const opts = await freshOpts();
  assert(
    (await recordMutation({
      runId: "a",
      verb: "issue-create",
      outcome: "success",
    }, opts))
      .ok,
  );
  const path = auditFilePath(opts);
  await Deno.writeTextFile(path, "{ not json\n");
  _resetAuditCaches();

  for (const runId of ["b", "c"]) {
    assert(
      (await recordMutation(
        { runId, verb: "pr-create", outcome: "success" },
        opts,
      ))
        .ok,
    );
    _resetAuditCaches();
  }

  const entries = await loadEntries(path.replace(/\.jsonl$/, ".s1.jsonl"));
  assert(entries.ok);
  if (!entries.ok) return;
  // One quarantine note, then both mutations — not a fresh segment each time.
  assertEquals(entries.value.map((e) => e.runId).slice(1), ["b", "c"]);
  await Deno.stat(path.replace(/\.jsonl$/, ".s2.jsonl")).then(
    () => {
      throw new Error("a second segment should not have been opened");
    },
    () => {},
  );
});

Deno.test("audit_journal - a journal awaiting --adopt is not quarantined out from under the operator (Issue #361)", async () => {
  const opts = await freshOpts();
  assert(
    (await recordMutation({
      runId: "a",
      verb: "issue-create",
      outcome: "success",
    }, opts))
      .ok,
  );
  const path = auditFilePath(opts);
  await Deno.remove(anchorPath(path));
  _resetAuditCaches();

  // A missing anchor is the pre-#3712 case `audit-chain-verify --adopt`
  // exists for. Rolling it over would strand the chain the operator is
  // about to adopt, so this one still refuses.
  const blocked = await recordMutation({
    runId: "b",
    verb: "pr-create",
    outcome: "success",
  }, opts);
  assertEquals(blocked.ok, false);
  await Deno.stat(path.replace(/\.jsonl$/, ".s1.jsonl")).then(
    () => {
      throw new Error("no segment should have been opened");
    },
    () => {},
  );
});
