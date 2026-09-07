/**
 * Tests for the shared export tree walk (`worker/deno/lib/export_tree.ts`).
 *
 * The walk reports what it skipped rather than discarding it (Issue #1412): a
 * symlink is an input whose target path is content, so it must leave a trace
 * the export stages can act on instead of vanishing from the walk.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { listTreeFiles, walkTree } from "../lib/export_tree.ts";

async function fixtureTree(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "export_tree_" });
  await Deno.mkdir(`${root}/docs`);
  await Deno.mkdir(`${root}/.git`);
  await Deno.writeTextFile(`${root}/README.md`, "# Tree\n");
  await Deno.writeTextFile(`${root}/docs/USAGE.md`, "usage\n");
  await Deno.writeTextFile(`${root}/.git/HEAD`, "ref: refs/heads/main\n");
  return root;
}

Deno.test("export-tree - the walk reports files and the symlinks it did not follow", async () => {
  const root = await fixtureTree();
  try {
    await Deno.symlink("/home/somebody/secret.md", `${root}/docs/link.md`);
    await Deno.symlink("/etc", `${root}/etc-link`);

    const walked = await walkTree(root);
    assertEquals(walked.files, ["README.md", "docs/USAGE.md"]);
    assertEquals(walked.symlinks, ["docs/link.md", "etc-link"]);
    // A symlinked directory is never descended into.
    assert(!walked.files.some((f) => f.startsWith("etc-link/")));
    // `.git/` is never entered.
    assert(!walked.files.some((f) => f.startsWith(".git/")));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("export-tree - a tree with no symlinks reports none", async () => {
  const root = await fixtureTree();
  try {
    const walked = await walkTree(root);
    assertEquals(walked.symlinks, []);
    assertEquals(walked.files, ["README.md", "docs/USAGE.md"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("export-tree - listTreeFiles reports the walk's files and no symlink", async () => {
  const root = await fixtureTree();
  try {
    await Deno.symlink("README.md", `${root}/docs/link.md`);
    assertEquals(await listTreeFiles(root), ["README.md", "docs/USAGE.md"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("export-tree - walking a missing directory fails loud", async () => {
  const root = await Deno.makeTempDir({ prefix: "export_tree_" });
  await Deno.remove(root);
  // A missing tree must raise, never report an empty walk.
  await assertRejects(() => walkTree(root), Deno.errors.NotFound);
});
