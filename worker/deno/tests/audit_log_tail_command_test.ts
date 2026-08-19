/**
 * Tests for the audit-log-tail command (Issue #2380).
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals } from "@std/assert";
import { auditLogTailCommand } from "../commands/audit_log_tail.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  _resetAuditCaches,
  auditFilePath,
  recordMutation,
} from "../lib/audit_journal.ts";

const defaultConfig = buildDefaultWorkerConfig();

async function seedJournal(): Promise<
  { baseDir: string; workerId: string; date: string; path: string }
> {
  _resetAuditCaches();
  const baseDir = await Deno.makeTempDir();
  const opts = { baseDir, workerId: "tail-worker", date: "2026-05-29" };
  for (let i = 0; i < 3; i++) {
    await recordMutation(
      {
        runId: "r",
        verb: "issue-comment",
        target: `${i}`,
        outcome: "success",
        exitCode: 0,
      },
      opts,
    );
  }
  return { ...opts, path: auditFilePath(opts) };
}

Deno.test("audit-log-tail - pretty-prints entries", async () => {
  const { baseDir, workerId, date } = await seedJournal();
  const result = await auditLogTailCommand.execute(
    { "base-dir": baseDir, "worker-id": workerId, date },
    defaultConfig,
  );
  assertEquals(result.success, true);
  assert(result.message.includes("3 entries"));
  assert(result.message.includes("issue-comment"));
});

Deno.test("audit-log-tail - --limit returns the trailing entries", async () => {
  const { baseDir, workerId, date } = await seedJournal();
  const result = await auditLogTailCommand.execute(
    { "base-dir": baseDir, "worker-id": workerId, date, limit: 1 },
    defaultConfig,
  );
  assertEquals(result.success, true);
  const data = result.data as { entries: unknown[] };
  assertEquals(data.entries.length, 1);
});

Deno.test("audit-log-tail - --verify reports an intact chain", async () => {
  const { baseDir, workerId, date } = await seedJournal();
  const result = await auditLogTailCommand.execute(
    { "base-dir": baseDir, "worker-id": workerId, date, verify: true },
    defaultConfig,
  );
  assertEquals(result.success, true);
  assert(result.message.includes("chain OK"));
});

Deno.test("audit-log-tail - --verify fails on a tampered chain", async () => {
  const { baseDir, workerId, date, path } = await seedJournal();
  // Corrupt the first entry.
  const lines = (await Deno.readTextFile(path)).split("\n").filter((l) =>
    l.trim().length > 0
  );
  const obj = JSON.parse(lines[0]!);
  obj.verb = "pr-merge";
  lines[0] = JSON.stringify(obj);
  await Deno.writeTextFile(path, lines.join("\n") + "\n");

  const result = await auditLogTailCommand.execute(
    { "base-dir": baseDir, "worker-id": workerId, date, verify: true },
    defaultConfig,
  );
  assertEquals(result.success, false);
  assert(result.message.includes("chain BROKEN"));
});

Deno.test("audit-log-tail - reports error when journal is missing", async () => {
  _resetAuditCaches();
  const result = await auditLogTailCommand.execute(
    { file: "/nonexistent/audit/none.jsonl" },
    defaultConfig,
  );
  assertEquals(result.success, false);
  assert(result.message.includes("not found"));
});
