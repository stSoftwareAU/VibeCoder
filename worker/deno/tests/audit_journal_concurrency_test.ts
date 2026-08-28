/**
 * Concurrent writers must not break the audit chain (Issue #491).
 *
 * The append lock used to be a `Map` of promises, which orders callers
 * inside one Deno process and nothing else. The audit journal lives on a
 * shared volume and every child `deno` command inherits `VIBE_RUN_ID`, so
 * a child writer appended under the same run id with its own cached view
 * of the chain head — orphaning the head hash in 10 of 14 journals on
 * GRQ-23.
 *
 * These tests spawn real processes. Two in-process callers would have
 * passed against the old code and proved nothing.
 */

import { assert, assertEquals } from "@std/assert";
import {
  _resetAuditCaches,
  auditFilePath,
  loadEntries,
  recordMutation,
  verifyChain,
} from "../lib/audit_journal.ts";

/** Absolute path of the module under test, for the child processes. */
const MODULE = new URL("../lib/audit_journal.ts", import.meta.url).href;

/** A child that appends `count` entries to the journal in `baseDir`. */
const CHILD = `
import { recordMutation } from ${JSON.stringify(MODULE)};
const [baseDir, tag, count] = Deno.args;
for (let i = 0; i < Number(count); i++) {
  const result = await recordMutation({
    runId: "shared-run-id",
    verb: "api-patch",
    target: tag + "-" + i,
    outcome: "success",
    caller: "concurrency-test",
  }, { baseDir });
  if (!result.ok) {
    console.error(result.error.message);
    Deno.exit(1);
  }
}
`;

/** Run one child writer to completion. */
async function spawnWriter(
  script: string,
  baseDir: string,
  tag: string,
  count: number,
): Promise<{ code: number; stderr: string }> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      script,
      baseDir,
      tag,
      String(count),
    ],
    stdout: "null",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stderr: new TextDecoder().decode(output.stderr),
  };
}

Deno.test("audit journal - concurrent processes leave a verifiable chain", async () => {
  _resetAuditCaches();
  const dir = await Deno.makeTempDir({ prefix: "audit-concurrency-" });
  const script = `${dir}/writer.ts`;
  await Deno.writeTextFile(script, CHILD);
  const baseDir = `${dir}/audit`;
  await Deno.mkdir(baseDir, { recursive: true });

  try {
    const perWriter = 12;
    const results = await Promise.all([
      spawnWriter(script, baseDir, "alpha", perWriter),
      spawnWriter(script, baseDir, "beta", perWriter),
      spawnWriter(script, baseDir, "gamma", perWriter),
    ]);
    for (const result of results) {
      assertEquals(result.code, 0, `child failed: ${result.stderr}`);
    }

    const journal = auditFilePath({ baseDir });
    const verified = await verifyChain(journal);
    assert(verified.ok, "verifyChain should read the journal");
    assertEquals(
      verified.value.reason,
      undefined,
      `chain broke: ${verified.value.reason}`,
    );
    assert(verified.value.valid, "three concurrent writers broke the chain");

    // Every append survived: a lock that dropped writes would also produce
    // a chain that verifies.
    const entries = await loadEntries(journal);
    assert(entries.ok);
    assertEquals(entries.value.length, perWriter * 3);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("audit journal - a child writer does not orphan this process's head", async () => {
  _resetAuditCaches();
  const dir = await Deno.makeTempDir({ prefix: "audit-stale-head-" });
  const script = `${dir}/writer.ts`;
  await Deno.writeTextFile(script, CHILD);
  const baseDir = `${dir}/audit`;
  await Deno.mkdir(baseDir, { recursive: true });

  try {
    // This is the exact GRQ-23 sequence: this process appends and would
    // once have cached the head; another process appends a burst; then
    // this process appends again on top of its own stale view.
    const first = await recordMutation({
      runId: "shared-run-id",
      verb: "api-patch",
      target: "before",
      outcome: "success",
      caller: "concurrency-test",
    }, { baseDir });
    assert(first.ok, "first append should succeed");

    const child = await spawnWriter(script, baseDir, "burst", 6);
    assertEquals(child.code, 0, `child failed: ${child.stderr}`);

    const second = await recordMutation({
      runId: "shared-run-id",
      verb: "api-patch",
      target: "after",
      outcome: "success",
      caller: "concurrency-test",
    }, { baseDir });
    assert(second.ok, "second append should succeed");

    const journal = auditFilePath({ baseDir });
    const entries = await loadEntries(journal);
    assert(entries.ok);
    assertEquals(entries.value.length, 8);

    // The tail must chain onto the child's last entry, not back past it.
    const tail = entries.value[7];
    const previous = entries.value[6];
    assertEquals(tail?.target, "after");
    assertEquals(tail?.prevHash, previous?.hash);

    const verified = await verifyChain(journal);
    assert(verified.ok);
    assert(verified.value.valid, `chain broke: ${verified.value.reason}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
