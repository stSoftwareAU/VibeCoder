/**
 * Orchestrated Codex roles run with the container as their sandbox
 * (Issue #4356), and the worker keeps the manager and reviewer read-only.
 *
 * Codex's own `--sandbox` needs bubblewrap and a fresh procfs mount. The
 * agent container has no bubblewrap, and even with it installed the
 * container's masked `/proc` makes the kernel refuse the mount, so every
 * shell call a sandboxed role made failed and no role could read or edit
 * the checkout. The fix keeps the CLI out of its sandbox for every role and
 * enforces "read-only" in the worker: the checkout is snapshotted before a
 * read-only call and anything the call changed is put back.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import { buildCodexArgs } from "../lib/codex_executor.ts";
import { assertRoleSupported } from "../lib/orchestration/capabilities.ts";
import {
  restoreCheckout,
  snapshotCheckout,
} from "../lib/orchestration/read_only_guard.ts";

const ROLES = ["manager", "executor", "reviewer"] as const;
const SESSION = "44444444-4356-4356-4356-444444444444";

/**
 * Flags `codex exec resume --help` lists (CLI 0.164.0). Written here so the
 * test does not spawn Codex. `--sandbox` is not among them (Issue #4333).
 */
const RESUME_ACCEPTED_FLAGS = new Set([
  "-c",
  "--config",
  "--last",
  "--all",
  "--enable",
  "--disable",
  "-i",
  "--image",
  "--strict-config",
  "-m",
  "--model",
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--worktree",
  "--thread-source",
  "--cyber-access-program",
  "--skip-git-repo-check",
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
  "--output-schema",
  "--json",
  "-o",
  "--output-last-message",
  "-h",
  "--help",
]);

Deno.test("orchestrated Codex roles never ask the CLI for its bubblewrap sandbox (Issue #4356)", () => {
  for (const role of ROLES) {
    for (const resumeSessionId of [undefined, SESSION]) {
      const args = buildCodexArgs({
        prompt: "brief",
        orchestrationRole: role,
        resumeSessionId,
      });
      const where = `${role}${resumeSessionId ? " (resumed)" : ""}`;
      assert(
        args.includes("--dangerously-bypass-approvals-and-sandbox"),
        `${where}: the container must be the sandbox`,
      );
      assertFalse(args.includes("--sandbox"), `${where}: --sandbox passed`);
      assertFalse(
        args.some((arg) => arg.includes("sandbox_mode=")),
        `${where}: sandbox_mode set`,
      );
      assert(
        args.includes("features.multi_agent=false"),
        `${where}: delegation must stay off`,
      );
      if (resumeSessionId) {
        for (const arg of args.filter((a) => a.startsWith("-"))) {
          assert(RESUME_ACCEPTED_FLAGS.has(arg), `resume rejects ${arg}`);
        }
      }
    }
  }
});

Deno.test("Codex can still carry every orchestration role (Issue #4356)", () => {
  const selection = { provider: "codex", model: "gpt-5", effort: "high" };
  for (const role of ["manager", "executor", "spec_reviewer"] as const) {
    assertEquals(
      assertRoleSupported(selection as never, role, ["Edit", "Write"]),
      undefined,
      role,
    );
  }
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(
      `git ${args.join(" ")}: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
  return new TextDecoder().decode(out.stdout).trim();
}

/** A repo with one commit and executor work left uncommitted in it. */
async function repoWithExecutorWork(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "read-only-guard-4356-" });
  await git(dir, "init", "-q");
  // CI runners have no global identity (see the fixture rule in memory).
  await git(dir, "config", "user.name", "Test");
  await git(dir, "config", "user.email", "test@example.com");
  await Deno.writeTextFile(`${dir}/kept.txt`, "base\n");
  await Deno.writeTextFile(`${dir}/doomed.txt`, "base\n");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "base");
  // Uncommitted executor work the reviewer must not lose.
  await Deno.writeTextFile(`${dir}/kept.txt`, "executor edit\n");
  await Deno.writeTextFile(`${dir}/executor-new.txt`, "new\n");
  await git(dir, "add", "executor-new.txt");
  return dir;
}

Deno.test("a read-only call that edits, adds, deletes and commits is put back exactly (Issue #4356)", async () => {
  const dir = await repoWithExecutorWork();
  try {
    const headBefore = await git(dir, "rev-parse", "HEAD");
    const statusBefore = await git(dir, "status", "--porcelain");
    const snap = await snapshotCheckout(dir);
    assert(snap.ok, snap.ok ? "" : snap.error.message);

    // The "reviewer" misbehaves every way it can.
    await Deno.writeTextFile(`${dir}/kept.txt`, "reviewer edit\n");
    await Deno.remove(`${dir}/doomed.txt`);
    await Deno.writeTextFile(`${dir}/reviewer-new.txt`, "stray\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "reviewer commit");

    const restored = await restoreCheckout(snap.value);
    assert(restored.ok, restored.ok ? "" : restored.error.message);
    assertEquals(restored.value.changed, true);

    assertEquals(await git(dir, "rev-parse", "HEAD"), headBefore);
    assertEquals(await git(dir, "status", "--porcelain"), statusBefore);
    assertEquals(await Deno.readTextFile(`${dir}/kept.txt`), "executor edit\n");
    assertEquals(await Deno.readTextFile(`${dir}/doomed.txt`), "base\n");
    assertEquals(await Deno.readTextFile(`${dir}/executor-new.txt`), "new\n");
    assertFalse(
      await Deno.stat(`${dir}/reviewer-new.txt`).then(() => true, () => false),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a read-only call that only reads leaves the checkout and reports no change (Issue #4356)", async () => {
  const dir = await repoWithExecutorWork();
  try {
    const statusBefore = await git(dir, "status", "--porcelain");
    const snap = await snapshotCheckout(dir);
    assert(snap.ok);
    await Deno.readTextFile(`${dir}/kept.txt`);
    const restored = await restoreCheckout(snap.value);
    assert(restored.ok);
    assertEquals(restored.value.changed, false);
    assertEquals(await git(dir, "status", "--porcelain"), statusBefore);
    assertEquals(await Deno.readTextFile(`${dir}/kept.txt`), "executor edit\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("snapshotting a directory that is not a checkout fails instead of pretending (Issue #4356)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "read-only-guard-4356-" });
  try {
    const snap = await snapshotCheckout(dir);
    assertFalse(snap.ok);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
