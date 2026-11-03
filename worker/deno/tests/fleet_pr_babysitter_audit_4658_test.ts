/**
 * Tests for the babysitter's audit-journal location (Issue #4658).
 *
 * The host babysitter never sets `WORK_DIR`, so its repair pushes and
 * dismissals were never journalled. `ensureBabysitterAuditDir` points the
 * journal at the babysitter's own state directory instead. These tests drive
 * it through its injected environment seam, so the real process environment is
 * never written, and check both the variable it sets and that a mutation then
 * lands in that directory.
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals } from "@std/assert";
import { ensureBabysitterAuditDir } from "../commands/fleet_pr_babysitter.ts";
import { auditGitMutation, isAuditJournalEnabled } from "../lib/audit_hook.ts";
import {
  _resetAuditCaches,
  auditFilePath,
  loadEntries,
} from "../lib/audit_journal.ts";
import { rosterPath } from "../lib/audit_anchor.ts";
import { envFrom } from "./support/env_lookup.ts";

/**
 * An environment the test owns, with a recording setter in place of
 * `Deno.env.set`. `values` is read live by {@link envFrom}, so a write through
 * `setEnv` is visible to later lookups, as the process environment would be.
 */
function fakeProcessEnv(initial: Record<string, string> = {}) {
  const values: Record<string, string> = { ...initial };
  const sets: Array<[string, string]> = [];
  return {
    values,
    sets,
    setEnv: (name: string, value: string) => {
      values[name] = value;
      sets.push([name, value]);
    },
  };
}

/** Whether `path` exists on disk. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

Deno.test("ensureBabysitterAuditDir sets VIBE_AUDIT_DIR to its state directory's audit directory and creates it (Issue #4658)", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    const proc = fakeProcessEnv();
    const logged: string[] = [];
    const dir = await ensureBabysitterAuditDir(
      stateDir,
      envFrom(proc.values),
      proc.setEnv,
      (message) => logged.push(message),
    );
    assertEquals(dir, `${stateDir}/audit`);
    assertEquals(proc.values.VIBE_AUDIT_DIR, `${stateDir}/audit`);
    assertEquals(proc.sets, [["VIBE_AUDIT_DIR", `${stateDir}/audit`]]);
    assert((await Deno.stat(`${stateDir}/audit`)).isDirectory);
    assertEquals(logged, []);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("ensureBabysitterAuditDir leaves an existing VIBE_AUDIT_DIR alone (Issue #4658)", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    const proc = fakeProcessEnv({ VIBE_AUDIT_DIR: "/srv/elsewhere/audit" });
    const dir = await ensureBabysitterAuditDir(
      stateDir,
      envFrom(proc.values),
      proc.setEnv,
      () => {},
    );
    assertEquals(dir, undefined);
    assertEquals(proc.sets, []);
    assertEquals(proc.values.VIBE_AUDIT_DIR, "/srv/elsewhere/audit");
    assertEquals(await exists(`${stateDir}/audit`), false);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("ensureBabysitterAuditDir leaves WORK_DIR alone (Issue #4658)", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    const proc = fakeProcessEnv({ WORK_DIR: "/home/vibe/auto-issue-work" });
    const dir = await ensureBabysitterAuditDir(
      stateDir,
      envFrom(proc.values),
      proc.setEnv,
      () => {},
    );
    assertEquals(dir, undefined);
    assertEquals(proc.sets, []);
    assertEquals(proc.values.VIBE_AUDIT_DIR, undefined);
    assertEquals(await exists(`${stateDir}/audit`), false);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("ensureBabysitterAuditDir respects VIBE_AUDIT_DISABLED (Issue #4658)", async () => {
  for (const value of ["1", "true"]) {
    const stateDir = await Deno.makeTempDir();
    try {
      const proc = fakeProcessEnv({ VIBE_AUDIT_DISABLED: value });
      const dir = await ensureBabysitterAuditDir(
        stateDir,
        envFrom(proc.values),
        proc.setEnv,
        () => {},
      );
      assertEquals(dir, undefined, value);
      assertEquals(proc.sets, [], value);
      assertEquals(await exists(`${stateDir}/audit`), false, value);
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  }
});

Deno.test("ensureBabysitterAuditDir still sets VIBE_AUDIT_DIR when VIBE_AUDIT_DISABLED is 0 (Issue #4658)", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    const proc = fakeProcessEnv({ VIBE_AUDIT_DISABLED: "0" });
    const dir = await ensureBabysitterAuditDir(
      stateDir,
      envFrom(proc.values),
      proc.setEnv,
      () => {},
    );
    assertEquals(dir, `${stateDir}/audit`);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("ensureBabysitterAuditDir logs and sets nothing when the directory cannot be created (Issue #4658)", async () => {
  const root = await Deno.makeTempDir();
  try {
    // A regular file where the state directory should be: mkdir must fail.
    const blocker = `${root}/state`;
    await Deno.writeTextFile(blocker, "not a directory\n");
    const proc = fakeProcessEnv();
    const logged: string[] = [];
    const dir = await ensureBabysitterAuditDir(
      blocker,
      envFrom(proc.values),
      proc.setEnv,
      (message) => logged.push(message),
    );
    assertEquals(dir, undefined);
    assertEquals(proc.sets, []);
    assertEquals(logged.length, 1);
    const prefix = "[babysitter] audit journal directory not created: ";
    assert(logged[0]?.startsWith(prefix), logged[0]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("after start-up, a babysitter mutation is journalled under its state directory only (Issue #4658)", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    const proc = fakeProcessEnv({
      WORKER_UNIQUE_ID: "babysitter-host",
      VIBE_RUN_ID: "babysitter-run-4658",
    });
    await ensureBabysitterAuditDir(
      stateDir,
      envFrom(proc.values),
      proc.setEnv,
      () => {},
    );
    const env = envFrom(proc.values);
    assert(isAuditJournalEnabled(env), "journalling is on after start-up");

    _resetAuditCaches();
    await auditGitMutation(["push", "origin", "feature-branch"], 0, { env });

    const journalPath = auditFilePath({ env });
    assert(
      journalPath.startsWith(`${stateDir}/audit/`),
      `journal ${journalPath} should sit in the babysitter state directory`,
    );
    const loaded = await loadEntries(journalPath);
    assert(loaded.ok, "the mutation should be journalled");
    if (!loaded.ok) return;
    assertEquals(loaded.value.length, 1);
    assertEquals(loaded.value[0]?.verb, "git-push");
    // The roster is a sibling of the audit directory, so it too stays inside
    // the state directory.
    assert(await exists(rosterPath(`${stateDir}/audit`)));
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});
