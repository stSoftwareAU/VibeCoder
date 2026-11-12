/**
 * Tests for local_default_branch.ts — the default branch from `origin/HEAD`
 * (PR #5034 review). Uses Australian English throughout.
 */

import { assertEquals } from "@std/assert";
import { resolveLocalDefaultBranch } from "../lib/local_default_branch.ts";

async function git(cwd: string, ...args: string[]): Promise<void> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
}

/** A bare upstream with `trunk` seeded, and a clone of it. */
async function makeClone(root: string): Promise<string> {
  const upstream = `${root}/upstream.git`;
  const seed = `${root}/seed`;
  const clone = `${root}/clone`;
  await git(root, "init", "-q", "--bare", "-b", "trunk", upstream);
  await git(root, "clone", "-q", upstream, seed);
  await git(seed, "config", "user.email", "t@t");
  await git(seed, "config", "user.name", "t");
  await Deno.writeTextFile(`${seed}/README.md`, "seed\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "-qm", "seed");
  await git(seed, "push", "-q", "origin", "trunk");
  await git(root, "clone", "-q", upstream, clone);
  return clone;
}

Deno.test("resolveLocalDefaultBranch: returns the branch origin/HEAD points at, without the ref prefix", async () => {
  const root = await Deno.makeTempDir({ prefix: "local_default_" });
  try {
    const clone = await makeClone(root);
    assertEquals(await resolveLocalDefaultBranch({ cwd: clone }), "trunk");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("resolveLocalDefaultBranch: null when origin/HEAD is unset", async () => {
  const root = await Deno.makeTempDir({ prefix: "local_default_" });
  try {
    const clone = await makeClone(root);
    // Positive control: the same clone resolves before origin/HEAD is removed.
    assertEquals(await resolveLocalDefaultBranch({ cwd: clone }), "trunk");
    await git(clone, "remote", "set-head", "origin", "--delete");
    assertEquals(await resolveLocalDefaultBranch({ cwd: clone }), null);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("resolveLocalDefaultBranch: null outside a git repository", async () => {
  const dir = await Deno.makeTempDir({ prefix: "local_default_nogit_" });
  try {
    assertEquals(await resolveLocalDefaultBranch({ cwd: dir }), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveLocalDefaultBranch: null, not a throw, when git cannot run in the directory", async () => {
  const root = await Deno.makeTempDir({ prefix: "local_default_missing_" });
  const missing = `${root}/does-not-exist`;
  try {
    assertEquals(await resolveLocalDefaultBranch({ cwd: missing }), null);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
