/**
 * Tree-manifest discovery (Issue #4413).
 *
 * `findProjectManifests` moved out of `milestone_merge_gate.ts` so the
 * in-flight host-disk park can ask whether a checkout holds a cargo project.
 * These tests pin its search depth, the directories it never enters, the
 * per-toolchain coverage rule and its ordering, against temp trees removed
 * afterwards.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  findProjectManifests,
  isFile,
  MERGE_GATE_MAX_DEPTH,
} from "../lib/project_manifests.ts";
import * as mergeGate from "../lib/milestone_merge_gate.ts";

/** Build a temp tree from relative file paths, run `body`, then remove it. */
async function withTree(
  files: string[],
  body: (root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "project-manifests-4413-" });
  try {
    for (const file of files) {
      const path = `${root}/${file}`;
      await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.writeTextFile(path, "{}\n");
    }
    await body(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

/** Found projects as `kind:relative/dir` strings. */
function summarise(
  root: string,
  found: Awaited<ReturnType<typeof findProjectManifests>>,
): string[] {
  return found.map((p) => `${p.kind}:${p.dir.slice(root.length) || "/"}`);
}

Deno.test("isFile - true for a file, false for a directory or a missing path", async () => {
  await withTree(["a/file.txt"], async (root) => {
    assertEquals(await isFile(`${root}/a/file.txt`), true);
    assertEquals(await isFile(`${root}/a`), false);
    assertEquals(await isFile(`${root}/missing`), false);
  });
});

Deno.test("findProjectManifests - the merge gate re-exports the same function and depth", () => {
  assertEquals(mergeGate.findProjectManifests, findProjectManifests);
  assertEquals(mergeGate.MERGE_GATE_MAX_DEPTH, MERGE_GATE_MAX_DEPTH);
  assertEquals(MERGE_GATE_MAX_DEPTH, 2);
});

Deno.test("findProjectManifests - empty and missing trees hold no project", async () => {
  await withTree([], async (root) => {
    assertEquals(await findProjectManifests(root), []);
  });
  assertEquals(await findProjectManifests("/nonexistent-4413-tree"), []);
});

Deno.test("findProjectManifests - root deno.json and Cargo.toml are both reported with their manifests", async () => {
  await withTree(["deno.json", "Cargo.toml"], async (root) => {
    const found = await findProjectManifests(root);
    assertEquals(found, [
      { dir: root, manifest: `${root}/deno.json`, kind: "deno" },
      { dir: root, manifest: `${root}/Cargo.toml`, kind: "cargo" },
    ]);
  });
});

Deno.test("findProjectManifests - deno.json wins over deno.jsonc in the same directory", async () => {
  await withTree(["deno.json", "deno.jsonc"], async (root) => {
    const found = await findProjectManifests(root);
    assertEquals(found.map((p) => p.manifest), [`${root}/deno.json`]);
  });
  await withTree(["deno.jsonc"], async (root) => {
    const found = await findProjectManifests(root);
    assertEquals(found.map((p) => p.manifest), [`${root}/deno.jsonc`]);
  });
});

Deno.test("findProjectManifests - searches to depth 2 and no deeper", async () => {
  await withTree(
    ["a/deno.json", "b/c/Cargo.toml", "d/e/f/deno.json", "g/h/i/Cargo.toml"],
    async (root) => {
      assertEquals(summarise(root, await findProjectManifests(root)), [
        "deno:/a",
        "cargo:/b/c",
      ]);
    },
  );
});

Deno.test("findProjectManifests - never enters dot, vendored or build directories", async () => {
  const skipped = [
    ".git",
    ".hidden",
    "node_modules",
    "vendor",
    "target",
    "dist",
    "build",
  ];
  await withTree(
    [
      ...skipped.map((d) => `${d}/deno.json`),
      ...skipped.map((d) => `${d}/Cargo.toml`),
    ],
    async (root) => {
      assertEquals(await findProjectManifests(root), []);
    },
  );
  await withTree(["src/deno.json", "web/Cargo.toml"], async (root) => {
    assertEquals(summarise(root, await findProjectManifests(root)), [
      "deno:/src",
      "cargo:/web",
    ]);
  });
});

Deno.test("findProjectManifests - ignores files where a directory is expected", async () => {
  await withTree(["plain.txt", "a/deno.json"], async (root) => {
    assertEquals(summarise(root, await findProjectManifests(root)), [
      "deno:/a",
    ]);
  });
});

Deno.test("findProjectManifests - a manifest covers nested projects of its own toolchain only", async () => {
  await withTree(
    ["deno.json", "a/deno.json", "a/Cargo.toml", "b/Cargo.toml"],
    async (root) => {
      // Root Deno covers `a`'s Deno; Cargo is still discovered below it.
      assertEquals(summarise(root, await findProjectManifests(root)), [
        "deno:/",
        "cargo:/a",
        "cargo:/b",
      ]);
    },
  );
  await withTree(
    ["Cargo.toml", "a/Cargo.toml", "a/deno.json"],
    async (root) => {
      assertEquals(summarise(root, await findProjectManifests(root)), [
        "cargo:/",
        "deno:/a",
      ]);
    },
  );
});

Deno.test("findProjectManifests - stops descending once both toolchains are covered", async () => {
  await withTree(
    ["deno.json", "Cargo.toml", "a/deno.json", "a/Cargo.toml"],
    async (root) => {
      assertEquals(summarise(root, await findProjectManifests(root)), [
        "deno:/",
        "cargo:/",
      ]);
    },
  );
});

Deno.test("findProjectManifests - reports every sibling project in sorted order", async () => {
  await withTree(
    ["z/deno.json", "a/deno.json", "m/deno.json", "a/b/deno.jsonc"],
    async (root) => {
      assertEquals(summarise(root, await findProjectManifests(root)), [
        "deno:/a",
        "deno:/m",
        "deno:/z",
      ]);
    },
  );
  await withTree(["z/x/deno.json", "a/y/deno.json"], async (root) => {
    assertEquals(summarise(root, await findProjectManifests(root)), [
      "deno:/a/y",
      "deno:/z/x",
    ]);
  });
});

Deno.test("findProjectManifests - an unreadable subdirectory contributes nothing and does not throw", async () => {
  await withTree(["a/deno.json", "b/c/Cargo.toml"], async (root) => {
    await Deno.chmod(`${root}/b`, 0o000);
    try {
      try {
        for await (const _ of Deno.readDir(`${root}/b`)) break;
        return; // a privileged user reads any directory; nothing to pin
      } catch {
        // Unreadable, as the test needs.
      }
      const found = await findProjectManifests(root);
      assert(found.some((p) => p.dir === `${root}/a`));
      assertEquals(found.some((p) => p.kind === "cargo"), false);
    } finally {
      await Deno.chmod(`${root}/b`, 0o755);
    }
  });
});
