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
 * Gating is environment-driven (`WORK_DIR` set, `VIBE_AUDIT_DISABLED`
 * unset), so each test sets a unique temp `WORK_DIR` and restores every
 * touched env var in a `finally` to avoid leaking into sibling tests.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { auditGhMutation, auditGitMutation } from "../lib/audit_hook.ts";
import {
  _resetAuditCaches,
  auditFilePath,
  loadEntries,
} from "../lib/audit_journal.ts";

/** Env vars the hook gating / journal path depend on. */
const TOUCHED_ENV = [
  "WORK_DIR",
  "VIBE_AUDIT_DISABLED",
  "WORKER_UNIQUE_ID",
  "WORKER_NAME",
  "VIBE_RUN_ID",
] as const;

/** Snapshot the current values of the env vars we mutate. */
function snapshotEnv(): Map<string, string | undefined> {
  const snap = new Map<string, string | undefined>();
  for (const key of TOUCHED_ENV) snap.set(key, Deno.env.get(key));
  return snap;
}

/** Restore env vars from a snapshot taken by {@link snapshotEnv}. */
function restoreEnv(snap: Map<string, string | undefined>): void {
  for (const key of TOUCHED_ENV) {
    const value = snap.get(key);
    if (value === undefined) {
      Deno.env.delete(key);
    } else {
      Deno.env.set(key, value);
    }
  }
}

/**
 * Run `fn` with a fresh isolated audit environment.
 *
 * Sets a unique temp `WORK_DIR`, a fixed worker/run id for deterministic
 * paths, clears `VIBE_AUDIT_DISABLED`, resets the in-process journal caches,
 * and passes the resolved journal path to `fn`. Optionally suppresses the
 * `WORK_DIR` setting so the inert (gating-off) path can be exercised.
 */
async function withAuditEnv(
  fn: (journalPath: string) => Promise<void>,
  opts: { disabled?: boolean; noWorkDir?: boolean } = {},
): Promise<void> {
  const snap = snapshotEnv();
  try {
    const workDir = await Deno.makeTempDir();
    if (opts.noWorkDir) {
      Deno.env.delete("WORK_DIR");
    } else {
      Deno.env.set("WORK_DIR", workDir);
    }
    Deno.env.set("WORKER_UNIQUE_ID", "test-hook-worker");
    Deno.env.set("VIBE_RUN_ID", "run-hook-1");
    Deno.env.delete("WORKER_NAME");
    if (opts.disabled) {
      Deno.env.set("VIBE_AUDIT_DISABLED", "1");
    } else {
      Deno.env.delete("VIBE_AUDIT_DISABLED");
    }
    _resetAuditCaches();
    // Resolve the journal path under the same env the hook will use.
    const journalPath = opts.noWorkDir
      ? `${workDir}/audit/never-written.jsonl`
      : auditFilePath();
    await fn(journalPath);
  } finally {
    restoreEnv(snap);
  }
}

Deno.test("audit_hook - auditGhMutation journals a gh mutation", async () => {
  await withAuditEnv(async (journalPath) => {
    await auditGhMutation(["issue", "close", "42"], 0);

    const loaded = await loadEntries(journalPath);
    assert(loaded.ok, "journal file should exist after a mutation");
    if (!loaded.ok) return;
    assertEquals(loaded.value.length, 1, "exactly one entry written");
    const entry = loaded.value[0];
    assertEquals(entry?.verb, "issue-close");
    assertEquals(entry?.outcome, "success");
    assertEquals(entry?.exitCode, 0);
    assertEquals(entry?.target, "42");
    assertEquals(entry?.runId, "run-hook-1");
  });
});

Deno.test("audit_hook - non-zero exit records an error outcome", async () => {
  await withAuditEnv(async (journalPath) => {
    await auditGhMutation(["issue", "close", "42"], 1);

    const loaded = await loadEntries(journalPath);
    assert(loaded.ok);
    if (!loaded.ok) return;
    assertEquals(loaded.value.length, 1);
    assertEquals(loaded.value[0]?.outcome, "error");
    assertEquals(loaded.value[0]?.exitCode, 1);
  });
});

Deno.test("audit_hook - auditGhMutation ignores a read-only command", async () => {
  await withAuditEnv(async (journalPath) => {
    await auditGhMutation(["issue", "view", "42"], 0);

    // No mutation classified → no journal file should be created at all.
    const loaded = await loadEntries(journalPath);
    assertEquals(loaded.ok, false, "a non-mutation must not write an entry");
  });
});

Deno.test("audit_hook - VIBE_AUDIT_DISABLED makes the hook inert", async () => {
  await withAuditEnv(async (journalPath) => {
    await auditGhMutation(["issue", "close", "42"], 0);

    const loaded = await loadEntries(journalPath);
    assertEquals(loaded.ok, false, "disabled gating must not write");
  }, { disabled: true });
});

Deno.test("audit_hook - hook is inert when WORK_DIR is unset", async () => {
  await withAuditEnv(async (journalPath) => {
    // Must not throw even though there is no journal location.
    await auditGhMutation(["issue", "close", "42"], 0);
    await auditGitMutation(["push", "origin", "main"], 0);

    const loaded = await loadEntries(journalPath);
    assertEquals(loaded.ok, false, "no journal written without WORK_DIR");
  }, { noWorkDir: true });
});

Deno.test("audit_hook - auditGitMutation journals a git push", async () => {
  await withAuditEnv(async (journalPath) => {
    await auditGitMutation(["push", "origin", "feature-branch"], 0);

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
  await withAuditEnv(async (journalPath) => {
    await auditGitMutation(["status"], 0);

    const loaded = await loadEntries(journalPath);
    assertEquals(loaded.ok, false, "a local git command must not write");
  });
});
