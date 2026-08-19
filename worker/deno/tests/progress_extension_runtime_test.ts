/**
 * Tests for the progress-extension wiring (Issue #4296, part of #4290).
 *
 * The rolling probe is driven against a real temporary git repo — a verdict
 * is only worth acting on if real git state moves it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { runWithTimeout } from "../lib/subprocess_timeout.ts";
import {
  buildProgressExtension,
  createRollingTreeProbe,
} from "../lib/progress_extension_runtime.ts";
import { probeWorktreeFingerprint } from "../lib/worktree_progress.ts";

/** Run a git command in `cwd`, failing loudly when it does not succeed. */
async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await runWithTimeout("git", args, { cwd, timeoutMs: 20_000 });
  if (!result.ok || !result.value.success) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}`);
  }
}

/** Create a temp git repo with one committed file. Returns its path. */
async function makeRepo(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "progress-extension-" });
  await git(dir, "init", "--quiet");
  await git(dir, "config", "user.email", "worker@example.com");
  await git(dir, "config", "user.name", "Vibe Worker");
  await git(dir, "config", "commit.gpgsign", "false");
  await Deno.writeTextFile(`${dir}/README.md`, "line one\n");
  await git(dir, "add", "README.md");
  await git(dir, "commit", "--quiet", "-m", "initial");
  return dir;
}

Deno.test("buildProgressExtension - disabled config yields no option at all", async () => {
  const dir = await makeRepo();
  try {
    assertEquals(
      await buildProgressExtension({ progressExtensionEnabled: false }, dir),
      undefined,
      "the runner must receive nothing, so the timeout is unchanged",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("buildProgressExtension - non-positive tunables refuse to extend", async () => {
  const dir = await makeRepo();
  try {
    assertEquals(
      await buildProgressExtension({
        progressExtensionEnabled: true,
        progressExtensionGrantSeconds: 0,
        progressExtensionStallSeconds: 300,
      }, dir),
      undefined,
    );
    assertEquals(
      await buildProgressExtension({
        progressExtensionEnabled: true,
        progressExtensionGrantSeconds: 900,
        progressExtensionStallSeconds: -1,
      }, dir),
      undefined,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("buildProgressExtension - enabled config carries the policy and a live probe", async () => {
  const dir = await makeRepo();
  try {
    const built = await buildProgressExtension({
      progressExtensionEnabled: true,
      progressExtensionGrantSeconds: 900,
      progressExtensionStallSeconds: 300,
    }, dir);

    assert(built, "an enabled config must produce the option");
    assertEquals(built.policy, {
      enabled: true,
      grantSeconds: 900,
      activityStallSeconds: 300,
    });
    // Nothing has changed since the baseline was taken before the run.
    assertEquals(await built.treeProbe(), "unchanged");
    await Deno.writeTextFile(`${dir}/new.ts`, "export const x = 1;\n");
    assertEquals(await built.treeProbe(), "advanced");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("createRollingTreeProbe - compares against the previous check, not the baseline", async () => {
  const dir = await makeRepo();
  try {
    const probe = createRollingTreeProbe(
      dir,
      await probeWorktreeFingerprint(dir),
    );

    await Deno.writeTextFile(`${dir}/a.ts`, "export const a = 1;\n");
    assertEquals(await probe(), "advanced");
    // The edit is now the baseline — a run that stops editing reads as
    // unchanged on the very next check, which is what kills a stalled run.
    assertEquals(await probe(), "unchanged");
    await Deno.writeTextFile(`${dir}/b.ts`, "export const b = 2;\n");
    assertEquals(await probe(), "advanced");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("createRollingTreeProbe - a directory that is not a repo reads as unknown", async () => {
  const dir = await Deno.makeTempDir({ prefix: "progress-extension-bare-" });
  try {
    const probe = createRollingTreeProbe(
      dir,
      await probeWorktreeFingerprint(dir),
    );
    assertEquals(
      await probe(),
      "unknown",
      "an unverifiable tree must never read as progress",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
