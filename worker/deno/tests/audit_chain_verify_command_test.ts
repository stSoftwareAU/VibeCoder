/**
 * Tests for the audit-chain-verify command (Issue #3712).
 *
 * The sweep is what turns `verifyChain` from an operator-only tool into a
 * scheduled check, so these tests pin the success/failure contract the
 * housekeeping step relies on.
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  auditChainVerifyCommand,
  type AuditChainVerifyData,
} from "../commands/audit_chain_verify.ts";
import {
  _resetAuditCaches,
  auditFilePath,
  recordMutation,
} from "../lib/audit_journal.ts";
import { anchorPath, rosterPath } from "../lib/audit_anchor.ts";
import type { WorkerConfig } from "../types.ts";

const CONFIG = {} as WorkerConfig;

/**
 * The command's typed payload. `Command.execute` is declared over the
 * registry's non-generic result, so the sweep data needs naming here for
 * the assertions to reach `broken` / `acknowledged`.
 */
function payload(data: unknown): AuditChainVerifyData {
  return data as AuditChainVerifyData;
}

/** Seed an isolated audit directory holding one journal of `n` entries. */
async function seedDir(n = 2): Promise<{ baseDir: string; path: string }> {
  _resetAuditCaches();
  const baseDir = await Deno.makeTempDir();
  const opts = { baseDir, workerId: "test-worker", date: "2026-08-02" };
  for (let i = 0; i < n; i++) {
    const result = await recordMutation({
      runId: `run-${i}`,
      verb: "issue-comment",
      outcome: "success",
    }, opts);
    assert(result.ok);
  }
  return { baseDir, path: auditFilePath(opts) };
}

Deno.test("audit-chain-verify - reports a clean sweep", async () => {
  const { baseDir } = await seedDir();
  const result = await auditChainVerifyCommand.execute({
    "base-dir": baseDir,
  }, CONFIG);
  assertEquals(result.success, true);
  assertStringIncludes(result.message, "audit chains OK: 1 verified");
});

Deno.test("audit-chain-verify - fails loud on a truncated journal", async () => {
  const { baseDir, path } = await seedDir(3);
  const lines = (await Deno.readTextFile(path)).split("\n").filter((l) =>
    l.trim().length > 0
  );
  await Deno.writeTextFile(path, `${lines[0]}\n`);

  const result = await auditChainVerifyCommand.execute({
    "base-dir": baseDir,
  }, CONFIG);
  assertEquals(result.success, false, "a broken chain must not report green");
  assertStringIncludes(result.message, "[SECURITY] [AUDIT_CHAIN_BROKEN]");
  assertStringIncludes(result.message, "truncated");
});

Deno.test("audit-chain-verify - fails loud on a deleted journal", async () => {
  const { baseDir, path } = await seedDir();
  await Deno.remove(path);

  const result = await auditChainVerifyCommand.execute({
    "base-dir": baseDir,
  }, CONFIG);
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "deleted");
});

Deno.test("audit-chain-verify - --adopt blesses a pre-anchor journal only", async () => {
  const { baseDir, path } = await seedDir();
  await Deno.remove(anchorPath(path));
  _resetAuditCaches();

  const result = await auditChainVerifyCommand.execute({
    "base-dir": baseDir,
    "adopt": true,
  }, CONFIG);
  assertEquals(result.success, true);
  assertStringIncludes(result.message, "adopted anchor for");
});

Deno.test("audit-chain-verify - --adopt refuses to bless a truncated journal", async () => {
  const { baseDir, path } = await seedDir(3);
  const lines = (await Deno.readTextFile(path)).split("\n").filter((l) =>
    l.trim().length > 0
  );
  await Deno.writeTextFile(path, `${lines[0]}\n`);
  _resetAuditCaches();

  const result = await auditChainVerifyCommand.execute({
    "base-dir": baseDir,
    "adopt": true,
  }, CONFIG);
  assertEquals(result.success, false, "--adopt must never bless tampering");
  assertStringIncludes(result.message, "truncated");
});

Deno.test("audit-chain-verify - --json emits the machine-readable verdict", async () => {
  const { baseDir } = await seedDir();
  const result = await auditChainVerifyCommand.execute({
    "base-dir": baseDir,
    "json": true,
  }, CONFIG);
  assertEquals(result.success, true);
  const parsed = JSON.parse(result.message);
  assertEquals(parsed.checked, 1);
  assertEquals(parsed.broken, []);
});

Deno.test("audit-chain-verify - fails loud when a journal and its anchor were deleted together (Issue #3949)", async () => {
  const { baseDir, path } = await seedDir();
  await Deno.remove(path);
  await Deno.remove(anchorPath(path));
  _resetAuditCaches();

  const result = await auditChainVerifyCommand.execute({
    "base-dir": baseDir,
  }, CONFIG);
  assertEquals(
    result.success,
    false,
    "a pair-delete must not report a clean sweep",
  );
  assertStringIncludes(result.message, "[SECURITY] [AUDIT_CHAIN_BROKEN]");
  assert(!result.message.includes("audit chains OK"));
});

Deno.test("audit-chain-verify - fails loud when the audit directory was removed but the roster expects journals (Issue #3949)", async () => {
  const { baseDir } = await seedDir();
  await Deno.remove(baseDir, { recursive: true });
  _resetAuditCaches();

  const result = await auditChainVerifyCommand.execute({
    "base-dir": baseDir,
  }, CONFIG);
  assertEquals(
    result.success,
    false,
    "rm -rf of the audit directory must not report success",
  );
  assertStringIncludes(result.message, "[SECURITY] [AUDIT_CHAIN_BROKEN]");
});

Deno.test("audit-chain-verify - fails loud on complete erasure of the audit directory and roster (Issue #270)", async () => {
  const { baseDir } = await seedDir();
  await Deno.remove(baseDir, { recursive: true });
  await Deno.remove(rosterPath(baseDir));
  _resetAuditCaches();

  const result = await auditChainVerifyCommand.execute({
    "base-dir": baseDir,
  }, CONFIG);
  assertEquals(
    result.success,
    false,
    "deleting the audit directory and roster together must not report success",
  );
  assertStringIncludes(result.message, "[SECURITY] [AUDIT_CHAIN_BROKEN]");
});

// ---------------------------------------------------------------------------
// Acknowledged losses (Issue #359)
//
// Issue #337 had the housekeeping prune the worker's own audit directory.
// The fix stopped further losses but could not undo one, and the roster is
// append-only — so hosts swept before the fix logged three [SECURITY] lines
// on every worker start, for ever, with no exit but hand-editing the
// tamper-evidence file. A permanently-red alarm is a broken alarm: the next
// genuine deletion just adds a line nobody reads.
// ---------------------------------------------------------------------------

/** Delete the whole audit directory, leaving the roster sidecar behind. */
async function sweepAwayJournals(baseDir: string): Promise<void> {
  await Deno.remove(baseDir, { recursive: true });
  _resetAuditCaches();
}

Deno.test("audit-chain-verify - a swept audit directory fails until the loss is signed for (Issue #359)", async () => {
  const { baseDir, path } = await seedDir();
  const journal = path.slice(path.lastIndexOf("/") + 1);
  await sweepAwayJournals(baseDir);

  // Unacknowledged: loud, and the line now names the way out.
  const before = await auditChainVerifyCommand.execute({
    "base-dir": baseDir,
  }, CONFIG);
  assertEquals(before.success, false);
  assertStringIncludes(before.message, "[SECURITY] [AUDIT_CHAIN_BROKEN]");
  assertStringIncludes(before.message, "directory deleted");
  assertStringIncludes(before.message, "--acknowledge-loss");
  assertStringIncludes(before.message, journal);

  const signed = await auditChainVerifyCommand.execute({
    "base-dir": baseDir,
    "acknowledge-loss": journal,
    "reason": "pruned by the work-volume housekeeping (Issue #337)",
    "by": "nleck",
  }, CONFIG);
  assertEquals(signed.success, true);
  assertEquals(payload(signed.data).newlyAcknowledged, [journal]);

  // Acknowledged: green, but the loss is still named on every sweep.
  const after = await auditChainVerifyCommand.execute({
    "base-dir": baseDir,
  }, CONFIG);
  assertEquals(after.success, true);
  assertEquals(payload(after.data).broken.length, 0);
  assertEquals(payload(after.data).acknowledged.length, 1);
  assertStringIncludes(after.message, "[AUDIT_CHAIN_LOSS_ACKNOWLEDGED]");
  assertStringIncludes(after.message, "signed for by nleck");
  assertStringIncludes(after.message, "Issue #337");
  assertStringIncludes(after.message, "1 acknowledged as lost");

  await Deno.remove(baseDir, { recursive: true }).catch(() => {});
});

Deno.test("audit-chain-verify - the acknowledgement is recorded in the hash chain, not only the roster (Issue #359)", async () => {
  const { baseDir, path } = await seedDir();
  const journal = path.slice(path.lastIndexOf("/") + 1);
  await sweepAwayJournals(baseDir);

  const signed = await auditChainVerifyCommand.execute({
    "base-dir": baseDir,
    "acknowledge-loss": journal,
    "reason": "swept by Issue #337",
    "by": "nleck",
  }, CONFIG);
  assertEquals(signed.success, true);

  // A fresh journal now exists carrying the acknowledgement as a chained,
  // anchored entry — so "who silenced this alarm" is answerable from the
  // audit trail itself, not from a sidecar a forger could write alone.
  const names: string[] = [];
  for await (const item of Deno.readDir(baseDir)) {
    if (item.isFile && item.name.endsWith(".jsonl")) names.push(item.name);
  }
  assertEquals(names.length, 1);
  const chained = await Deno.readTextFile(`${baseDir}/${names[0]}`);
  assertStringIncludes(chained, "audit-loss-acknowledged");
  assertStringIncludes(chained, journal);
  assertStringIncludes(chained, "nleck");
  assertStringIncludes(chained, "swept by Issue #337");

  await Deno.remove(baseDir, { recursive: true }).catch(() => {});
});

Deno.test("audit-chain-verify - a journal still on disk can never be acknowledged (Issue #359)", async () => {
  const { baseDir, path } = await seedDir(3);
  const journal = path.slice(path.lastIndexOf("/") + 1);

  // Truncate the journal: a real tamper signal, and exactly the case an
  // acknowledgement must never be able to silence.
  const lines = (await Deno.readTextFile(path)).split("\n").filter((l) =>
    l.trim().length > 0
  );
  await Deno.writeTextFile(path, `${lines.slice(0, 1).join("\n")}\n`);
  _resetAuditCaches();

  const refused = await auditChainVerifyCommand.execute({
    "base-dir": baseDir,
    "acknowledge-loss": journal,
    "reason": "trying to bless a truncation",
    "by": "attacker",
  }, CONFIG);
  assertEquals(refused.success, false);
  assertStringIncludes(refused.message, "[AUDIT_CHAIN_LOSS_NOT_ACKNOWLEDGED]");
  assertStringIncludes(refused.message, "still on disk");

  // And the sweep is as broken as it was before the attempt.
  const swept = await auditChainVerifyCommand.execute({
    "base-dir": baseDir,
  }, CONFIG);
  assertEquals(swept.success, false);
  assertStringIncludes(swept.message, "[SECURITY] [AUDIT_CHAIN_BROKEN]");

  await Deno.remove(baseDir, { recursive: true }).catch(() => {});
});

Deno.test("audit-chain-verify - a journal that was never rostered cannot be pre-acknowledged (Issue #359)", async () => {
  const { baseDir } = await seedDir();

  const refused = await auditChainVerifyCommand.execute({
    "base-dir": baseDir,
    "acknowledge-loss": "audit-worker-2099-01-01.jsonl",
    "reason": "silencing something that never existed",
    "by": "attacker",
  }, CONFIG);
  assertEquals(refused.success, false);
  assertStringIncludes(refused.message, "not on the roster");

  await Deno.remove(baseDir, { recursive: true }).catch(() => {});
});

Deno.test("audit-chain-verify - an acknowledgement without a reason is refused (Issue #359)", async () => {
  const { baseDir, path } = await seedDir();
  const journal = path.slice(path.lastIndexOf("/") + 1);
  await sweepAwayJournals(baseDir);

  for (
    const args of [
      { "base-dir": baseDir, "acknowledge-loss": journal },
      { "base-dir": baseDir, "acknowledge-loss": journal, "reason": "   " },
    ]
  ) {
    const refused = await auditChainVerifyCommand.execute(args, CONFIG);
    assertEquals(refused.success, false);
    assertStringIncludes(refused.message, "--reason");
  }

  // Nothing was written, so the alarm still sounds.
  const swept = await auditChainVerifyCommand.execute({
    "base-dir": baseDir,
  }, CONFIG);
  assertEquals(swept.success, false);

  await Deno.remove(baseDir, { recursive: true }).catch(() => {});
});

Deno.test("audit-chain-verify - acknowledging one journal leaves the others loud (Issue #359)", async () => {
  _resetAuditCaches();
  const baseDir = await Deno.makeTempDir();
  const paths: string[] = [];
  for (const date of ["2026-08-21", "2026-08-22", "2026-08-23"]) {
    const opts = { baseDir, workerId: "worker", date };
    const result = await recordMutation({
      runId: "run",
      verb: "issue-comment",
      outcome: "success",
    }, opts);
    assert(result.ok);
    paths.push(auditFilePath(opts));
  }
  await sweepAwayJournals(baseDir);
  const names = paths.map((p) => p.slice(p.lastIndexOf("/") + 1));

  const signed = await auditChainVerifyCommand.execute({
    "base-dir": baseDir,
    "acknowledge-loss": names[0]!,
    "reason": "Issue #337",
    "by": "nleck",
  }, CONFIG);
  // The one journal is signed for — and the run is still red, because two
  // unexplained losses remain. Signing for one loss must never green the
  // sweep on behalf of the others.
  assertEquals(payload(signed.data).newlyAcknowledged, [names[0]]);
  assertEquals(signed.success, false);

  const swept = await auditChainVerifyCommand.execute({
    "base-dir": baseDir,
  }, CONFIG);
  assertEquals(swept.success, false);
  assertEquals(payload(swept.data).acknowledged.length, 1);
  assertEquals(payload(swept.data).broken.length, 2);
  for (const name of names.slice(1)) {
    assertStringIncludes(swept.message, name);
  }

  await Deno.remove(baseDir, { recursive: true }).catch(() => {});
});

Deno.test("audit-chain-verify - a torn roster line is repaired and named, not a failed sweep (Issue #1202)", async () => {
  const { baseDir } = await seedDir();
  // A writer killed part-way through a roster append: unterminated and
  // unparseable, the one shape a short write can leave.
  await Deno.writeTextFile(rosterPath(baseDir), '{"journal":"audit-te', {
    append: true,
  });

  const swept = await auditChainVerifyCommand.execute({
    "base-dir": baseDir,
  }, CONFIG);
  assertEquals(swept.success, true, swept.message);
  assertStringIncludes(swept.message, "[SECURITY] [AUDIT_ROSTER_RECOVERED]");
  assertStringIncludes(swept.message, "a torn roster line discarded");
  const repaired = payload(swept.data).rosterRepaired;
  assert(repaired, "the repair must reach the typed payload");
  assertEquals(
    await Deno.readTextFile(repaired.preservedAs),
    '{"journal":"audit-te',
  );

  await Deno.remove(baseDir, { recursive: true }).catch(() => {});
});

Deno.test("audit-chain-verify - a half-formed acknowledgement line is a tamper signal, not a silencer (Issue #359)", async () => {
  const { baseDir, path } = await seedDir();
  const journal = path.slice(path.lastIndexOf("/") + 1);
  await sweepAwayJournals(baseDir);

  // No reason, no operator: it matches neither roster line shape, so the
  // roster read must fail loud rather than read it as an expectation line.
  await Deno.writeTextFile(
    rosterPath(baseDir),
    `${JSON.stringify({ journal, acknowledgedAt: "2026-08-25T00:00:00Z" })}\n`,
    { append: true },
  );

  const swept = await auditChainVerifyCommand.execute({
    "base-dir": baseDir,
  }, CONFIG);
  assertEquals(swept.success, false);
  assertStringIncludes(swept.message, "unexpected shape");

  await Deno.remove(baseDir, { recursive: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Signing for damage to a journal that is still on disk (Issue #491)
// ---------------------------------------------------------------------------

/**
 * Break the chain the way the cross-process race did: rewrite one entry's
 * `prevHash` so it points back past its predecessor. The file stays
 * well-formed JSONL, exactly as the ten GRQ-23 journals are.
 */
async function orphanHead(path: string): Promise<void> {
  const lines = (await Deno.readTextFile(path)).split("\n").filter((l) =>
    l.trim().length > 0
  );
  const entry = JSON.parse(lines[2]!);
  entry.prevHash = JSON.parse(lines[0]!).hash;
  lines[2] = JSON.stringify(entry);
  await Deno.writeTextFile(path, `${lines.join("\n")}\n`);
}

Deno.test("audit-chain-verify - a present but broken journal offers the damage remedy (Issue #491)", async () => {
  const { baseDir, path } = await seedDir(4);
  await orphanHead(path);

  const result = await auditChainVerifyCommand.execute({
    "base-dir": baseDir,
  }, CONFIG);
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "prevHash linkage mismatch");
  assertStringIncludes(result.message, "--acknowledge-damage");
  // The loss command would refuse this journal, so it must not be offered.
  assert(
    !result.message.includes("--acknowledge-loss"),
    "a corrupt journal must not be pointed at the loss command",
  );
});

Deno.test("audit-chain-verify - damage stays loud until it is signed for (Issue #491)", async () => {
  const { baseDir, path } = await seedDir(4);
  await orphanHead(path);
  const journal = path.slice(path.lastIndexOf("/") + 1);

  const before = await auditChainVerifyCommand.execute({
    "base-dir": baseDir,
  }, CONFIG);
  assertEquals(before.success, false);

  const signed = await auditChainVerifyCommand.execute({
    "base-dir": baseDir,
    "acknowledge-damage": journal,
    "reason": "cross-process append race, fixed in #491",
    "by": "operator",
  }, CONFIG);
  assertEquals(signed.success, true, signed.message);

  const after = await auditChainVerifyCommand.execute({
    "base-dir": baseDir,
  }, CONFIG);
  assertEquals(after.success, true, after.message);
  assertStringIncludes(after.message, "AUDIT_CHAIN_DAMAGE_ACKNOWLEDGED");
  assertStringIncludes(after.message, "acknowledged as damaged");
  assertStringIncludes(after.message, "cross-process append race");
});

Deno.test("audit-chain-verify - the damage journal is never repaired (Issue #491)", async () => {
  const { baseDir, path } = await seedDir(4);
  await orphanHead(path);
  const before = await Deno.readTextFile(path);

  const signed = await auditChainVerifyCommand.execute({
    "base-dir": baseDir,
    "acknowledge-damage": path.slice(path.lastIndexOf("/") + 1),
    "reason": "accounted for",
    "by": "operator",
  }, CONFIG);
  assertEquals(signed.success, true, signed.message);

  assertEquals(
    await Deno.readTextFile(path),
    before,
    "the damaged journal is evidence and must not be touched",
  );
});

Deno.test("audit-chain-verify - a signature does not cover later edits (Issue #491)", async () => {
  const { baseDir, path } = await seedDir(4);
  await orphanHead(path);

  const signed = await auditChainVerifyCommand.execute({
    "base-dir": baseDir,
    "acknowledge-damage": path.slice(path.lastIndexOf("/") + 1),
    "reason": "accounted for",
    "by": "operator",
  }, CONFIG);
  assertEquals(signed.success, true, signed.message);

  // Anything at all changing in the file must bring the alarm back: a
  // signature that survived edits would launder every future forgery.
  const lines = (await Deno.readTextFile(path)).split("\n").filter((l) =>
    l.trim().length > 0
  );
  await Deno.writeTextFile(path, `${lines.slice(0, 3).join("\n")}\n`);

  const after = await auditChainVerifyCommand.execute({
    "base-dir": baseDir,
  }, CONFIG);
  assertEquals(after.success, false, "an edited journal must fail again");
  assertStringIncludes(after.message, "no longer applies");
  assertStringIncludes(after.message, "changed since it was signed for");
});

Deno.test("audit-chain-verify - a journal that verifies cannot be pre-signed (Issue #491)", async () => {
  const { baseDir, path } = await seedDir(3);

  const result = await auditChainVerifyCommand.execute({
    "base-dir": baseDir,
    "acknowledge-damage": path.slice(path.lastIndexOf("/") + 1),
    "reason": "nothing wrong with it",
    "by": "operator",
  }, CONFIG);
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "AUDIT_CHAIN_DAMAGE_NOT_ACKNOWLEDGED");
  assertStringIncludes(result.message, "its chain verifies");
});

Deno.test("audit-chain-verify - a missing journal cannot be signed for as damage (Issue #491)", async () => {
  const { baseDir, path } = await seedDir(2);
  const journal = path.slice(path.lastIndexOf("/") + 1);
  await Deno.remove(path);

  const result = await auditChainVerifyCommand.execute({
    "base-dir": baseDir,
    "acknowledge-damage": journal,
    "reason": "it is gone",
    "by": "operator",
  }, CONFIG);
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "it is not on disk");
  assertStringIncludes(result.message, "--acknowledge-loss");
});

Deno.test("audit-chain-verify - damage cannot be signed for without a reason (Issue #491)", async () => {
  const { baseDir, path } = await seedDir(4);
  await orphanHead(path);
  const journal = path.slice(path.lastIndexOf("/") + 1);

  for (
    const args of [
      { "base-dir": baseDir, "acknowledge-damage": journal },
      { "base-dir": baseDir, "acknowledge-damage": journal, "reason": "   " },
    ]
  ) {
    const result = await auditChainVerifyCommand.execute(args, CONFIG);
    assertEquals(result.success, false);
    assertStringIncludes(result.message, "--acknowledge-damage needs --reason");
  }
});

Deno.test("audit-chain-verify - a damage signature does not silence a deleted journal (Issue #491)", async () => {
  const { baseDir, path } = await seedDir(4);
  await orphanHead(path);
  const journal = path.slice(path.lastIndexOf("/") + 1);

  const signed = await auditChainVerifyCommand.execute({
    "base-dir": baseDir,
    "acknowledge-damage": journal,
    "reason": "accounted for",
    "by": "operator",
  }, CONFIG);
  assertEquals(signed.success, true, signed.message);

  // Now delete the journal and its anchor outright. The damage signature
  // covers corruption, never erasure — the sweep must go red again.
  await Deno.remove(path);
  await Deno.remove(anchorPath(path));

  const after = await auditChainVerifyCommand.execute({
    "base-dir": baseDir,
  }, CONFIG);
  assertEquals(after.success, false, "erasure must not inherit the signature");
  assertStringIncludes(after.message, "pair deleted");
});

Deno.test("audit-chain-verify - the damage signature is recorded in the hash chain (Issue #491)", async () => {
  const { baseDir, path } = await seedDir(4);
  await orphanHead(path);
  const journal = path.slice(path.lastIndexOf("/") + 1);

  const signed = await auditChainVerifyCommand.execute({
    "base-dir": baseDir,
    "acknowledge-damage": journal,
    "reason": "cross-process append race",
    "by": "the operator",
  }, CONFIG);
  assertEquals(signed.success, true, signed.message);

  // The act is chained somewhere in the directory — in a healthy journal,
  // never in the damaged one, which is never written to again.
  let found = false;
  for await (const item of Deno.readDir(baseDir)) {
    if (!item.isFile || !/^audit-.*\.jsonl$/.test(item.name)) continue;
    const body = await Deno.readTextFile(`${baseDir}/${item.name}`);
    if (body.includes("audit-damage-acknowledged")) {
      found = true;
      assert(
        item.name !== journal,
        "the damaged journal must never be appended to",
      );
    }
  }
  assert(found, "the signature must be chained, not only in the roster");

  const roster = await Deno.readTextFile(rosterPath(baseDir));
  assertStringIncludes(roster, '"kind":"damage"');
});
