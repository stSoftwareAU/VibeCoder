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
import { auditChainVerifyCommand } from "../commands/audit_chain_verify.ts";
import {
  _resetAuditCaches,
  auditFilePath,
  recordMutation,
} from "../lib/audit_journal.ts";
import { anchorPath } from "../lib/audit_anchor.ts";
import type { WorkerConfig } from "../types.ts";

const CONFIG = {} as WorkerConfig;

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
