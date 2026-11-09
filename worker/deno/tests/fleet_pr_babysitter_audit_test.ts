import { assert, assertEquals } from "@std/assert";
import {
  ensureBabysitterAuditDir,
  prepareBabysitterStartUp,
} from "../commands/fleet_pr_babysitter.ts";
import { auditGitMutation, isAuditJournalEnabled } from "../lib/audit_hook.ts";
import {
  _resetAuditCaches,
  auditFilePath,
  loadEntries,
} from "../lib/audit_journal.ts";
import { rosterPath } from "../lib/audit_anchor.ts";

function fakeEnvironment(initial: Record<string, string> = {}) {
  const values = { ...initial };
  const writes: Array<[string, string]> = [];
  return {
    values,
    writes,
    env: (name: string) => values[name],
    setEnv: (name: string, value: string) => {
      values[name] = value;
      writes.push([name, value]);
    },
  };
}

Deno.test("babysitter startup journals mutations in its own state directory", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const process = fakeEnvironment({
      WORKER_UNIQUE_ID: "babysitter-host",
      VIBE_RUN_ID: "babysitter-run",
    });
    await prepareBabysitterStartUp(
      "/home/babysitter",
      dir,
      process.env,
      process.setEnv,
    );
    const env = process.env;
    assertEquals(process.values.VIBE_AUDIT_DIR, `${dir}/audit`);
    assert(isAuditJournalEnabled(env));
    _resetAuditCaches();
    await auditGitMutation(["push", "origin", "feature-branch"], 0, {
      env,
    });
    const path = auditFilePath({ env });
    assert(path.startsWith(`${dir}/audit/`));
    const entries = await loadEntries(path);
    assert(entries.ok);
    if (entries.ok) {
      assertEquals(entries.value.map((entry) => entry.verb), ["git-push"]);
    }
    assert((await Deno.stat(rosterPath(`${dir}/audit`))).isFile);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("babysitter audit setup preserves existing locations and disabled mode", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const configured = fakeEnvironment({ VIBE_AUDIT_DIR: "/srv/audit" });
    assertEquals(
      await ensureBabysitterAuditDir(dir, configured.env, configured.setEnv),
      undefined,
    );
    assertEquals(configured.writes, []);
    for (const disabled of ["1", "true"]) {
      const process = fakeEnvironment({ VIBE_AUDIT_DISABLED: disabled });
      assertEquals(
        await ensureBabysitterAuditDir(dir, process.env, process.setEnv),
        undefined,
      );
      assertEquals(process.writes, []);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
