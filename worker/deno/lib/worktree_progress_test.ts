/**
 * Tests for the read-only working-tree progress probe (Issue #4294,
 * part of #4290).
 *
 * Every case drives the real probe against a real temporary git repo —
 * the fingerprint is only trustworthy if actual git state moves it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { runWithTimeout } from "./subprocess_timeout.ts";
import {
  compareWorktreeFingerprints,
  probeWorktreeFingerprint,
} from "./worktree_progress.ts";

/** Run a git command in `cwd`, failing loudly when it does not succeed. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runWithTimeout("git", args, { cwd, timeoutMs: 20_000 });
  if (!result.ok) {
    throw new Error(`git ${args.join(" ")} failed: ${result.error.message}`);
  }
  if (!result.value.success) {
    throw new Error(
      `git ${
        args.join(" ")
      } exited ${result.value.code}: ${result.value.stderr}`,
    );
  }
  return result.value.stdout;
}

/** Create a temp git repo with one committed file. Returns its path. */
async function makeRepo(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "worktree-progress-" });
  await git(dir, "init", "--quiet");
  await git(dir, "config", "user.email", "worker@example.com");
  await git(dir, "config", "user.name", "Vibe Worker");
  await git(dir, "config", "commit.gpgsign", "false");
  await Deno.writeTextFile(`${dir}/README.md`, "line one\nline two\n");
  await git(dir, "add", "README.md");
  await git(dir, "commit", "--quiet", "-m", "initial");
  return dir;
}

Deno.test("probeWorktreeFingerprint - clean tree probed twice is unchanged", async () => {
  const dir = await makeRepo();
  try {
    const first = await probeWorktreeFingerprint(dir);
    const second = await probeWorktreeFingerprint(dir);

    assertEquals(first.ok, true);
    assertEquals(second.ok, true);
    assertEquals(first.digest, second.digest);

    const comparison = compareWorktreeFingerprints(first, second);
    assertEquals(comparison.outcome, "unchanged");
    assertEquals(
      comparison.unchangedForMs,
      second.takenAtMs - first.takenAtMs,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("probeWorktreeFingerprint - editing a tracked file advances the tree", async () => {
  const dir = await makeRepo();
  try {
    const before = await probeWorktreeFingerprint(dir);
    await Deno.writeTextFile(`${dir}/README.md`, "line one\nline two\nthree\n");
    const after = await probeWorktreeFingerprint(dir);

    assertNotEquals(before.digest, after.digest);
    const comparison = compareWorktreeFingerprints(before, after);
    assertEquals(comparison.outcome, "advanced");
    assertEquals(comparison.unchangedForMs, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("probeWorktreeFingerprint - a new untracked file advances the tree", async () => {
  const dir = await makeRepo();
  try {
    const before = await probeWorktreeFingerprint(dir);
    await Deno.writeTextFile(`${dir}/notes.txt`, "scratch\n");
    const after = await probeWorktreeFingerprint(dir);

    assertEquals(
      compareWorktreeFingerprints(before, after).outcome,
      "advanced",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("probeWorktreeFingerprint - a new file in a new untracked directory advances the tree", async () => {
  const dir = await makeRepo();
  try {
    await Deno.mkdir(`${dir}/pending`);
    await Deno.writeTextFile(`${dir}/pending/one.txt`, "first\n");
    const before = await probeWorktreeFingerprint(dir);

    // A second file inside an already-untracked directory: with git's
    // default `--untracked-files=normal` the directory collapses to one
    // entry and this edit would be invisible.
    await Deno.writeTextFile(`${dir}/pending/two.txt`, "second\n");
    const after = await probeWorktreeFingerprint(dir);

    assertEquals(
      compareWorktreeFingerprints(before, after).outcome,
      "advanced",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("probeWorktreeFingerprint - staging a file advances the tree", async () => {
  const dir = await makeRepo();
  try {
    await Deno.writeTextFile(`${dir}/notes.txt`, "scratch\n");
    const before = await probeWorktreeFingerprint(dir);
    await git(dir, "add", "notes.txt");
    const after = await probeWorktreeFingerprint(dir);

    assertEquals(
      compareWorktreeFingerprints(before, after).outcome,
      "advanced",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("probeWorktreeFingerprint - a new commit advances the tree", async () => {
  const dir = await makeRepo();
  try {
    await Deno.writeTextFile(`${dir}/notes.txt`, "scratch\n");
    await git(dir, "add", "notes.txt");
    const before = await probeWorktreeFingerprint(dir);
    await git(dir, "commit", "--quiet", "-m", "add notes");
    const after = await probeWorktreeFingerprint(dir);

    assertEquals(
      compareWorktreeFingerprints(before, after).outcome,
      "advanced",
    );
    assertNotEquals(before.head, after.head);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("probeWorktreeFingerprint - a repo with no commits still fingerprints", async () => {
  const dir = await Deno.makeTempDir({ prefix: "worktree-progress-empty-" });
  try {
    await git(dir, "init", "--quiet");
    const before = await probeWorktreeFingerprint(dir);
    assertEquals(before.ok, true);
    assertEquals(before.head, "");

    await Deno.writeTextFile(`${dir}/first.txt`, "hello\n");
    const after = await probeWorktreeFingerprint(dir);
    assertEquals(
      compareWorktreeFingerprints(before, after).outcome,
      "advanced",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("probeWorktreeFingerprint - a non-git directory is unknown, not unchanged", async () => {
  const dir = await Deno.makeTempDir({ prefix: "worktree-progress-plain-" });
  try {
    const first = await probeWorktreeFingerprint(dir);
    const second = await probeWorktreeFingerprint(dir);

    assertEquals(first.ok, false);
    assertEquals(first.digest, "");
    assert(first.reason.length > 0, "a failed probe must carry a reason");

    // Identical failed probes must NOT read as a stalled tree.
    assertEquals(
      compareWorktreeFingerprints(first, second).outcome,
      "unknown",
    );
    assertEquals(compareWorktreeFingerprints(first, second).unchangedForMs, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("probeWorktreeFingerprint - a missing directory is unknown, never throws", async () => {
  const probe = await probeWorktreeFingerprint("/no/such/checkout-4294");
  assertEquals(probe.ok, false);
  assertEquals(probe.digest, "");
});

Deno.test("probeWorktreeFingerprint - a probe timeout is unknown", async () => {
  const dir = await makeRepo();
  try {
    // Make git itself hang deterministically: `core.fsmonitor` points at a
    // sleeping hook, which `git status` blocks on. This exercises the real
    // runWithTimeout kill path rather than simulating it.
    const hook = `${dir}/slow-fsmonitor.sh`;
    await Deno.writeTextFile(hook, "#!/bin/sh\nsleep 2\n");
    await Deno.chmod(hook, 0o755);
    await git(dir, "config", "core.fsmonitor", hook);

    const probe = await probeWorktreeFingerprint(dir, { timeoutMs: 500 });
    assertEquals(probe.ok, false);
    assertEquals(probe.digest, "");
    assert(
      probe.reason.includes("timed out"),
      `expected a timeout reason, got: ${probe.reason}`,
    );

    await git(dir, "config", "--unset", "core.fsmonitor");
    const healthy = await probeWorktreeFingerprint(dir);
    assertEquals(healthy.ok, true);
    assertEquals(
      compareWorktreeFingerprints(probe, healthy).outcome,
      "unknown",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("probeWorktreeFingerprint - is read-only against a live checkout", async () => {
  const dir = await makeRepo();
  try {
    // A dirty tree with staged, unstaged and untracked entries — the shape
    // a live agent session leaves behind.
    await Deno.writeTextFile(`${dir}/README.md`, "line one\nedited\n");
    await Deno.writeTextFile(`${dir}/staged.txt`, "staged\n");
    await git(dir, "add", "staged.txt");
    await Deno.writeTextFile(`${dir}/untracked.txt`, "loose\n");

    // Capture the index straight after the reference status run: a plain
    // `git status` may itself refresh the index, so the probes must be the
    // only thing running between the two index reads.
    const statusBefore = await git(dir, "status", "--porcelain=v1");
    const indexBefore = await Deno.readFile(`${dir}/.git/index`);
    const indexStatBefore = await Deno.stat(`${dir}/.git/index`);

    await probeWorktreeFingerprint(dir);
    await probeWorktreeFingerprint(dir);

    const indexAfter = await Deno.readFile(`${dir}/.git/index`);
    const indexStatAfter = await Deno.stat(`${dir}/.git/index`);
    const statusAfter = await git(dir, "status", "--porcelain=v1");

    assertEquals(statusAfter, statusBefore);
    assertEquals(
      indexAfter.length,
      indexBefore.length,
      "the probe must not rewrite the git index",
    );
    assertEquals(
      indexAfter.every((byte, i) => byte === indexBefore[i]),
      true,
      "the probe must not mutate the git index",
    );
    assertEquals(
      indexStatAfter.mtime?.getTime(),
      indexStatBefore.mtime?.getTime(),
      "the probe must not touch the index mtime",
    );
    // No lock file left behind by a concurrent-safe probe.
    assertEquals(
      await Deno.stat(`${dir}/.git/index.lock`).then(() => true).catch(
        () => false,
      ),
      false,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("compareWorktreeFingerprints - never reports a negative unchanged span", () => {
  const anchor = {
    ok: true as const,
    digest: "abc123",
    head: "deadbeef",
    takenAtMs: 5_000,
    reason: "",
  };
  const earlier = { ...anchor, takenAtMs: 1_000 };

  const comparison = compareWorktreeFingerprints(anchor, earlier);
  assertEquals(comparison.outcome, "unchanged");
  assertEquals(comparison.unchangedForMs, 0);
});
