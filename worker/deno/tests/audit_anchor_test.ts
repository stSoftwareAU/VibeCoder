/**
 * Tests for the audit-journal chain anchor (Issue #3712).
 *
 * The hash chain alone only detects interior edits — a truncated tail or an
 * outright deletion still verifies clean. The anchor persists the record
 * count and head hash outside the journal file so both are detectable.
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  _resetAuditCaches,
  adoptAnchor,
  auditFilePath,
  recordMutation,
  verifyAllChains,
  verifyChain,
} from "../lib/audit_journal.ts";
import { anchorPath, readAnchor, rosterSeenPath } from "../lib/audit_anchor.ts";

/** Build a fresh isolated journal location for a test. */
async function freshOpts(): Promise<
  { baseDir: string; workerId: string; date: string }
> {
  _resetAuditCaches();
  const baseDir = await Deno.makeTempDir();
  return { baseDir, workerId: "test-worker", date: "2026-08-02" };
}

/** Append `n` entries to the journal described by `opts`. */
async function seed(
  opts: { baseDir: string; workerId: string; date: string },
  n: number,
): Promise<string> {
  for (let i = 0; i < n; i++) {
    const result = await recordMutation({
      runId: `run-${i}`,
      verb: "issue-comment",
      outcome: "success",
    }, opts);
    assert(result.ok, `seed entry ${i} should record`);
  }
  return auditFilePath(opts);
}

Deno.test("audit_anchor - recordMutation persists count and head hash", async () => {
  const opts = await freshOpts();
  const path = await seed(opts, 3);

  const anchor = await readAnchor(path);
  assert(anchor, "anchor should exist after appends");
  assertEquals(anchor.count, 3);
  assertEquals(anchor.headHash.length, 64);

  // The anchor lives outside the journal file itself.
  assert(
    anchorPath(path) !== path,
    "anchor must be a separate file from the journal",
  );
});

Deno.test("audit_anchor - verifyChain detects a truncated tail", async () => {
  const opts = await freshOpts();
  const path = await seed(opts, 4);

  const lines = (await Deno.readTextFile(path)).split("\n").filter((l) =>
    l.trim().length > 0
  );
  // Drop the last two entries — the surviving prefix chains perfectly.
  await Deno.writeTextFile(path, `${lines.slice(0, 2).join("\n")}\n`);

  const result = await verifyChain(path);
  assert(result.ok);
  if (!result.ok) return;
  assertEquals(result.value.valid, false, "truncation must not verify clean");
  assertStringIncludes(result.value.reason ?? "", "truncated");
});

Deno.test("audit_anchor - verifyChain detects an outright deletion", async () => {
  const opts = await freshOpts();
  const path = await seed(opts, 2);
  await Deno.remove(path);

  const result = await verifyChain(path);
  assert(result.ok, "a deleted journal with an anchor is tampering, not IO");
  if (!result.ok) return;
  assertEquals(result.value.valid, false);
  assertStringIncludes(result.value.reason ?? "", "deleted");
});

Deno.test("audit_anchor - verifyChain reports a missing anchor", async () => {
  const opts = await freshOpts();
  const path = await seed(opts, 2);
  await Deno.remove(anchorPath(path));

  const result = await verifyChain(path);
  assert(result.ok);
  if (!result.ok) return;
  assertEquals(result.value.valid, false, "no anchor is not a clean result");
  assertStringIncludes(result.value.reason ?? "", "anchor");
});

Deno.test("audit_anchor - verifyChain passes for an intact anchored journal", async () => {
  const opts = await freshOpts();
  const path = await seed(opts, 3);

  const result = await verifyChain(path);
  assert(result.ok);
  if (!result.ok) return;
  assertEquals(result.value.valid, true);
  assertEquals(result.value.count, 3);
});

Deno.test("audit_anchor - a deleted journal is not treated as a fresh chain", async () => {
  const opts = await freshOpts();
  const path = await seed(opts, 2);
  await Deno.remove(path);
  _resetAuditCaches();

  const result = await recordMutation({
    runId: "run-after-delete",
    verb: "issue-comment",
    outcome: "success",
  }, opts);

  assertEquals(result.ok, false, "appending onto a deleted chain must fail");
  if (result.ok) return;
  assertStringIncludes(result.error.message, "anchor");
  assertEquals(
    await Deno.readTextFile(path).catch(() => ""),
    "",
    "no fresh chain should have been started",
  );
});

Deno.test("audit_anchor - a truncated journal is not silently extended", async () => {
  const opts = await freshOpts();
  const path = await seed(opts, 3);
  const lines = (await Deno.readTextFile(path)).split("\n").filter((l) =>
    l.trim().length > 0
  );
  await Deno.writeTextFile(path, `${lines[0]}\n`);
  _resetAuditCaches();

  const result = await recordMutation({
    runId: "run-after-truncate",
    verb: "issue-comment",
    outcome: "success",
  }, opts);

  assertEquals(result.ok, false, "appending onto a truncated chain must fail");
});

Deno.test("audit_anchor - adoptAnchor recovers a pre-anchor journal", async () => {
  const opts = await freshOpts();
  const path = await seed(opts, 2);
  await Deno.remove(anchorPath(path));
  _resetAuditCaches();

  // Without an anchor the append is refused …
  const blocked = await recordMutation({
    runId: "blocked",
    verb: "issue-comment",
    outcome: "success",
  }, opts);
  assertEquals(blocked.ok, false);

  // … until the operator explicitly adopts the existing chain.
  const adopted = await adoptAnchor(path);
  assert(adopted.ok, "adoptAnchor should succeed on an intact journal");
  if (!adopted.ok) return;
  assertEquals(adopted.value.count, 2);
  _resetAuditCaches();

  const after = await recordMutation({
    runId: "after-adopt",
    verb: "issue-comment",
    outcome: "success",
  }, opts);
  assert(after.ok, "appends resume once the anchor is adopted");

  const verified = await verifyChain(path);
  assert(verified.ok);
  if (!verified.ok) return;
  assertEquals(verified.value.valid, true);
});

Deno.test("audit_anchor - adoptAnchor refuses a broken chain", async () => {
  const opts = await freshOpts();
  const path = await seed(opts, 2);
  await Deno.remove(anchorPath(path));
  const lines = (await Deno.readTextFile(path)).split("\n").filter((l) =>
    l.trim().length > 0
  );
  const tampered = JSON.parse(lines[1] ?? "{}");
  tampered.verb = "pr-merge";
  await Deno.writeTextFile(path, `${lines[0]}\n${JSON.stringify(tampered)}\n`);

  const adopted = await adoptAnchor(path);
  assertEquals(adopted.ok, false, "a tampered chain must not be adoptable");
});

Deno.test("audit_anchor - verifyAllChains sweeps every journal in the directory", async () => {
  const opts = await freshOpts();
  await seed(opts, 2);
  const other = { ...opts, workerId: "other-worker" };
  const otherPath = await seed(other, 2);
  await Deno.remove(otherPath);

  const swept = await verifyAllChains(opts.baseDir);
  assert(swept.ok);
  if (!swept.ok) return;
  assertEquals(swept.value.checked, 2, "both chains are inspected");
  assertEquals(swept.value.broken.length, 1, "the deleted journal is flagged");
  assertStringIncludes(swept.value.broken[0]?.path ?? "", "other-worker");
});

Deno.test("audit_anchor - verifyAllChains reports a clean sweep", async () => {
  const opts = await freshOpts();
  await seed(opts, 1);

  const swept = await verifyAllChains(opts.baseDir);
  assert(swept.ok);
  if (!swept.ok) return;
  assertEquals(swept.value.checked, 1);
  assertEquals(swept.value.broken.length, 0);
});

Deno.test("audit_anchor - verifyAllChains tolerates a missing audit directory", async () => {
  const swept = await verifyAllChains("/nonexistent/vibe-audit-dir");
  assert(swept.ok, "an absent audit dir is not a tamper signal");
  if (!swept.ok) return;
  assertEquals(swept.value.checked, 0);
  assertEquals(swept.value.broken.length, 0);
});

Deno.test("audit_anchor - recordMutation persists a last-known-non-empty roster marker (Issue #270)", async () => {
  const opts = await freshOpts();
  await seed(opts, 1);
  const stat = await Deno.stat(rosterSeenPath(opts.baseDir));
  assert(
    stat.isFile,
    "a non-empty roster must leave a third witness beside the pair",
  );
});
