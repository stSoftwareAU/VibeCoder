/**
 * Tests for audit_hook.ts — the chokepoint hooks that journal GitHub
 * mutations (Issue #2380; coverage gap closed by Issue #3117).
 *
 * These WHAT-tests drive the two exported functions `auditGhMutation` and
 * `auditGitMutation` and assert on their observable effect — the journal
 * entries actually written — never on internal call order. The journal is
 * read back through the production `auditFilePath`/`loadEntries` helpers, so
 * the tests survive a refactor of how journalling is wired.
 *
 * Gating and identity used to be read straight off the process (`WORK_DIR`
 * set, `VIBE_AUDIT_DISABLED` unset, `WORKER_UNIQUE_ID`, `VIBE_RUN_ID`), so
 * each test had to set four environment variables and put them back — a
 * mutation that races every other test running at that moment and pinned this
 * file into the gate's serial pass (Issue #880). Issue #963 made all four
 * parameters, so each test now hands the hook a fixed map instead.
 *
 * Every injected value is a sentinel that exists in no real environment — the
 * temp `WORK_DIR`, `test-hook-worker`, `run-hook-1`, and a
 * `VIBE_AUDIT_DISABLED` that is only ever set in the map. A code path that
 * quietly fell back to `Deno.env.get` would resolve a different journal path,
 * a different run id, or the wrong gating verdict, and fail here rather than
 * pass on an ambient value.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  auditGhMutation,
  auditGitMutation,
  type AuditHookOptions,
} from "../lib/audit_hook.ts";
import {
  _resetAuditCaches,
  auditFilePath,
  loadEntries,
} from "../lib/audit_journal.ts";
import { envFrom } from "./support/env_lookup.ts";

/** Worker partition these tests journal under — a sentinel, not a real id. */
const WORKER_ID = "test-hook-worker";

/** Run id these tests expect on every entry — likewise a sentinel. */
const RUN_ID = "run-hook-1";

/**
 * Run `fn` with a fresh isolated audit environment.
 *
 * Builds a lookup carrying a unique temp `WORK_DIR`, a fixed worker/run id
 * for deterministic paths, and no `VIBE_AUDIT_DISABLED`; resets the
 * in-process journal caches; and passes `fn` both the resolved journal path
 * and the options to hand the hook. Optionally omits `WORK_DIR` so the inert
 * (gating-off) path can be exercised, or sets `VIBE_AUDIT_DISABLED`.
 */
async function withAuditEnv(
  fn: (journalPath: string, opts: AuditHookOptions) => Promise<void>,
  spec: { disabled?: boolean; noWorkDir?: boolean } = {},
): Promise<void> {
  const workDir = await Deno.makeTempDir();
  const env = envFrom({
    ...(spec.noWorkDir ? {} : { WORK_DIR: workDir }),
    ...(spec.disabled ? { VIBE_AUDIT_DISABLED: "1" } : {}),
    WORKER_UNIQUE_ID: WORKER_ID,
    VIBE_RUN_ID: RUN_ID,
  });
  const opts: AuditHookOptions = { env };
  _resetAuditCaches();
  // Resolve the journal path through the same lookup the hook will use.
  const journalPath = spec.noWorkDir
    ? `${workDir}/audit/never-written.jsonl`
    : auditFilePath({ env });
  await fn(journalPath, opts);
}

Deno.test("audit_hook - auditGhMutation journals a gh mutation", async () => {
  await withAuditEnv(async (journalPath, opts) => {
    await auditGhMutation(["issue", "close", "42"], 0, opts);

    const loaded = await loadEntries(journalPath);
    assert(loaded.ok, "journal file should exist after a mutation");
    if (!loaded.ok) return;
    assertEquals(loaded.value.length, 1, "exactly one entry written");
    const entry = loaded.value[0];
    assertEquals(entry?.verb, "issue-close");
    assertEquals(entry?.outcome, "success");
    assertEquals(entry?.exitCode, 0);
    assertEquals(entry?.target, "42");
    assertEquals(entry?.runId, RUN_ID);
  });
});

Deno.test("audit_hook - non-zero exit records an error outcome", async () => {
  await withAuditEnv(async (journalPath, opts) => {
    await auditGhMutation(["issue", "close", "42"], 1, opts);

    const loaded = await loadEntries(journalPath);
    assert(loaded.ok);
    if (!loaded.ok) return;
    assertEquals(loaded.value.length, 1);
    assertEquals(loaded.value[0]?.outcome, "error");
    assertEquals(loaded.value[0]?.exitCode, 1);
  });
});

Deno.test("audit_hook - auditGhMutation ignores a read-only command", async () => {
  await withAuditEnv(async (journalPath, opts) => {
    await auditGhMutation(["issue", "view", "42"], 0, opts);

    // No mutation classified → no journal file should be created at all.
    const loaded = await loadEntries(journalPath);
    assertEquals(loaded.ok, false, "a non-mutation must not write an entry");
  });
});

Deno.test("audit_hook - VIBE_AUDIT_DISABLED makes the hook inert", async () => {
  await withAuditEnv(async (journalPath, opts) => {
    await auditGhMutation(["issue", "close", "42"], 0, opts);

    const loaded = await loadEntries(journalPath);
    assertEquals(loaded.ok, false, "disabled gating must not write");
  }, { disabled: true });
});

Deno.test("audit_hook - hook is inert when WORK_DIR is unset", async () => {
  await withAuditEnv(async (journalPath, opts) => {
    // Must not throw even though there is no journal location.
    await auditGhMutation(["issue", "close", "42"], 0, opts);
    await auditGitMutation(["push", "origin", "main"], 0, opts);

    const loaded = await loadEntries(journalPath);
    assertEquals(loaded.ok, false, "no journal written without WORK_DIR");
  }, { noWorkDir: true });
});

Deno.test("audit_hook - auditGitMutation journals a git push", async () => {
  await withAuditEnv(async (journalPath, opts) => {
    await auditGitMutation(["push", "origin", "feature-branch"], 0, opts);

    const loaded = await loadEntries(journalPath);
    assert(loaded.ok);
    if (!loaded.ok) return;
    assertEquals(loaded.value.length, 1);
    assertEquals(loaded.value[0]?.verb, "git-push");
    assertEquals(loaded.value[0]?.target, "feature-branch");
    assertEquals(loaded.value[0]?.outcome, "success");
  });
});

Deno.test("audit_hook - auditGitMutation ignores a non-push git command", async () => {
  await withAuditEnv(async (journalPath, opts) => {
    await auditGitMutation(["status"], 0, opts);

    const loaded = await loadEntries(journalPath);
    assertEquals(loaded.ok, false, "a local git command must not write");
  });
});

Deno.test("audit_hook - an explicit run id overrides the environment (Issue #963)", async () => {
  // The run id is the join key between the GitHub timeline and the worker
  // logs, so the hook must stamp the value it was handed — not one it went
  // looking for. Both candidates are sentinels, so whichever the entry
  // carries names where it came from.
  await withAuditEnv(async (journalPath, opts) => {
    await auditGhMutation(["issue", "close", "42"], 0, {
      ...opts,
      runId: "run-hook-explicit-963",
    });

    const loaded = await loadEntries(journalPath);
    assert(loaded.ok, "journal file should exist after a mutation");
    if (!loaded.ok) return;
    assertEquals(loaded.value[0]?.runId, "run-hook-explicit-963");
  });
});

Deno.test("audit_hook - the journal path follows the injected worker identity (Issue #963)", async () => {
  // The partition is per worker, and the worker id used to come off the
  // process. Proving it follows the injected lookup is what makes the
  // path this file asserts against the hook's own, not a coincidence.
  await withAuditEnv(async (journalPath, opts) => {
    await auditGitMutation(["push", "origin", "feature-branch"], 0, opts);

    assert(
      journalPath.includes(`/audit-${WORKER_ID}-`),
      `expected the injected worker id in the journal path, got: ${journalPath}`,
    );
    const loaded = await loadEntries(journalPath);
    assert(loaded.ok, "the hook wrote to the path the injected lookup names");
  });
});
