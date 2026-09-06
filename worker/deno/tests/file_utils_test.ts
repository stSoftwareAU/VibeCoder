/**
 * Tests for the file utilities module.
 *
 * Migrated from tests/atomic-write.bats (Issue #901).
 * Issue #693: Atomic file write utilities for state and cache files.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  appendNoFollow,
  atomicWrite,
  readTextFileNoFollow,
  safeReadFile,
} from "../lib/file_utils.ts";

// Helper to create a temporary directory for each test
async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "file_utils_test_" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

// =============================================================================
// atomicWrite
// =============================================================================

Deno.test("file_utils - atomicWrite creates file with content", async () => {
  await withTempDir(async (dir) => {
    const target = `${dir}/test.txt`;
    const result = await atomicWrite({
      targetFile: target,
      content: "hello world",
    });
    assertEquals(result.ok, true);

    const content = await Deno.readTextFile(target);
    assertEquals(content, "hello world");
  });
});

Deno.test("file_utils - atomicWrite replaces existing file", async () => {
  await withTempDir(async (dir) => {
    const target = `${dir}/test.txt`;
    await Deno.writeTextFile(target, "original");

    const result = await atomicWrite({
      targetFile: target,
      content: "replaced",
    });
    assertEquals(result.ok, true);

    const content = await Deno.readTextFile(target);
    assertEquals(content, "replaced");
  });
});

Deno.test("file_utils - atomicWrite writes empty content", async () => {
  await withTempDir(async (dir) => {
    const target = `${dir}/empty.txt`;
    const result = await atomicWrite({
      targetFile: target,
      content: "",
    });
    assertEquals(result.ok, true);

    const content = await Deno.readTextFile(target);
    assertEquals(content, "");
  });
});

Deno.test("file_utils - atomicWrite fails when directory does not exist", async () => {
  const result = await atomicWrite({
    targetFile: "/nonexistent/dir/file.txt",
    content: "test",
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "does not exist");
  }
});

Deno.test("file_utils - atomicWrite sets file permissions", async () => {
  await withTempDir(async (dir) => {
    const target = `${dir}/perms.txt`;
    const result = await atomicWrite({
      targetFile: target,
      content: "secret",
      mode: 0o600,
    });
    assertEquals(result.ok, true);

    const stat = await Deno.stat(target);
    // On POSIX, check mode bits (mask with 0o777 for permission bits only)
    if (Deno.build.os !== "windows") {
      assertEquals((stat.mode ?? 0) & 0o777, 0o600);
    }
  });
});

Deno.test("file_utils - atomicWrite custom permissions", async () => {
  await withTempDir(async (dir) => {
    const target = `${dir}/custom.txt`;
    const result = await atomicWrite({
      targetFile: target,
      content: "data",
      mode: 0o644,
    });
    assertEquals(result.ok, true);

    const stat = await Deno.stat(target);
    if (Deno.build.os !== "windows") {
      assertEquals((stat.mode ?? 0) & 0o777, 0o644);
    }
  });
});

Deno.test("file_utils - atomicWrite preserves multiline content", async () => {
  await withTempDir(async (dir) => {
    const target = `${dir}/multi.txt`;
    const multiline = "line1\nline2\nline3\n";
    const result = await atomicWrite({
      targetFile: target,
      content: multiline,
    });
    assertEquals(result.ok, true);

    const content = await Deno.readTextFile(target);
    assertEquals(content, multiline);
  });
});

Deno.test("file_utils - atomicWrite no temp file left on success", async () => {
  await withTempDir(async (dir) => {
    const target = `${dir}/clean.txt`;
    await atomicWrite({ targetFile: target, content: "data" });

    // Check no .tmp files remain
    for await (const entry of Deno.readDir(dir)) {
      assertEquals(entry.name.includes(".tmp."), false);
    }
  });
});

// =============================================================================
// atomicWrite — Issue #2348 regression tests
// =============================================================================

Deno.test(
  "file_utils - atomicWrite ignores a symlink pre-positioned at the legacy predictable temp path",
  async () => {
    // Regression for Issue #2348. The old implementation used a fully
    // predictable temp filename `${target}.tmp.${pid}`. If a co-located
    // user could pre-create that path as a symlink, the worker's write
    // would follow it and clobber the symlink target. With the fix, the
    // temp filename uses a kernel-random UUID suffix so the legacy
    // predictable path is never touched.
    if (Deno.build.os === "windows") return;
    await withTempDir(async (dir) => {
      const target = `${dir}/state.json`;
      const decoyVictim = `${dir}/victim.txt`;
      await Deno.writeTextFile(decoyVictim, "original-victim-content");

      // Pre-position the old predictable temp path as a symlink to a
      // file the worker has no business writing. If atomicWrite still
      // used the predictable name, this symlink would be followed.
      const legacyTmp = `${target}.tmp.${Deno.pid}`;
      await Deno.symlink(decoyVictim, legacyTmp);

      const result = await atomicWrite({
        targetFile: target,
        content: "new-state",
      });
      assertEquals(result.ok, true);

      // The decoy victim must be untouched.
      const victim = await Deno.readTextFile(decoyVictim);
      assertEquals(victim, "original-victim-content");

      // The real target must have the new content.
      const got = await Deno.readTextFile(target);
      assertEquals(got, "new-state");

      // The pre-positioned symlink must still exist — atomicWrite did
      // not interact with the legacy predictable path at all.
      const lstat = await Deno.lstat(legacyTmp);
      assertEquals(lstat.isSymlink, true);
    });
  },
);

Deno.test(
  "file_utils - atomicWrite produces a 0o600 file without a permission window",
  async () => {
    // Regression for Issue #2348. The old implementation wrote content
    // with Deno.writeTextFile (default mode subject to umask) and only
    // afterwards ran chmod, opening a brief window where sensitive
    // content existed at a wider mode than requested. With the fix, the
    // file is opened with createNew + mode: 0o600 up front.
    if (Deno.build.os === "windows") return;
    await withTempDir(async (dir) => {
      const target = `${dir}/secret.txt`;
      const result = await atomicWrite({
        targetFile: target,
        content: "top-secret",
        mode: 0o600,
      });
      assertEquals(result.ok, true);

      const stat = await Deno.stat(target);
      assertEquals((stat.mode ?? 0) & 0o777, 0o600);
    });
  },
);

Deno.test(
  "file_utils - atomicWrite supports concurrent writes to the same target",
  async () => {
    // The old predictable name (.tmp.<pid>) collided when the same
    // process attempted two concurrent atomicWrite calls. The random
    // UUID suffix removes the collision, so concurrent writers all
    // succeed and the final content is whichever rename ran last.
    await withTempDir(async (dir) => {
      const target = `${dir}/race.txt`;
      const results = await Promise.all([
        atomicWrite({ targetFile: target, content: "A" }),
        atomicWrite({ targetFile: target, content: "B" }),
        atomicWrite({ targetFile: target, content: "C" }),
      ]);
      for (const r of results) {
        assertEquals(r.ok, true);
      }
      const got = await Deno.readTextFile(target);
      assertEquals(["A", "B", "C"].includes(got), true);
    });
  },
);

Deno.test(
  "file_utils - atomicWrite leaves no temp files behind even with a symlink decoy present",
  async () => {
    if (Deno.build.os === "windows") return;
    await withTempDir(async (dir) => {
      const target = `${dir}/clean.txt`;
      const decoy = `${dir}/decoy.txt`;
      await Deno.writeTextFile(decoy, "decoy");
      await Deno.symlink(decoy, `${target}.tmp.${Deno.pid}`);

      const result = await atomicWrite({
        targetFile: target,
        content: "data",
      });
      assertEquals(result.ok, true);

      // The fix removes the predictable-name path entirely. No
      // `*.tmp.<uuid>` file should be left over from the new path either.
      let tmpCount = 0;
      for await (const entry of Deno.readDir(dir)) {
        if (entry.name.startsWith("clean.txt.tmp.")) {
          // Only the pre-positioned decoy symlink should remain.
          tmpCount++;
          assertEquals(entry.name, `clean.txt.tmp.${Deno.pid}`);
        }
      }
      assertEquals(tmpCount, 1);
    });
  },
);

// =============================================================================
// safeReadFile
// =============================================================================

Deno.test("file_utils - safeReadFile reads existing file", async () => {
  await withTempDir(async (dir) => {
    const target = `${dir}/read.txt`;
    await Deno.writeTextFile(target, "content here");

    const result = await safeReadFile(target);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value, "content here");
    }
  });
});

Deno.test("file_utils - safeReadFile returns empty string for missing file", async () => {
  const result = await safeReadFile("/nonexistent/file.txt");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, "");
  }
});

Deno.test("file_utils - safeReadFile reads empty file", async () => {
  await withTempDir(async (dir) => {
    const target = `${dir}/empty.txt`;
    await Deno.writeTextFile(target, "");

    const result = await safeReadFile(target);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value, "");
    }
  });
});

// =============================================================================
// appendNoFollow (Issue #1239)
// =============================================================================

Deno.test("appendNoFollow - appends to a regular file, creating it 0600", async () => {
  await withTempDir(async (dir) => {
    const target = `${dir}/log.json`;
    const first = await appendNoFollow({ targetFile: target, content: "a\n" });
    assert(first.ok, "first append succeeded");
    const second = await appendNoFollow({ targetFile: target, content: "b\n" });
    assert(second.ok, "second append succeeded");

    assertEquals(await Deno.readTextFile(target), "a\nb\n");
    if (Deno.build.os !== "windows") {
      assertEquals((await Deno.lstat(target)).mode! & 0o777, 0o600);
    }
  });
});

Deno.test("appendNoFollow - refuses a symlink at the target path", async () => {
  await withTempDir(async (dir) => {
    const victim = `${dir}/victim`;
    await Deno.writeTextFile(victim, "original");
    const link = `${dir}/link`;
    await Deno.symlink(victim, link);

    const result = await appendNoFollow({ targetFile: link, content: "x\n" });
    assert(!result.ok, "a symlink target is refused");
    assertStringIncludes(result.error.message, "symlink");
    assertEquals(await Deno.readTextFile(victim), "original");
  });
});

Deno.test("appendNoFollow - refuses a hard link and a non-regular target", async () => {
  await withTempDir(async (dir) => {
    const original = `${dir}/original`;
    await Deno.writeTextFile(original, "original\n");
    const hard = `${dir}/hard`;
    await Deno.link(original, hard);

    const linked = await appendNoFollow({ targetFile: hard, content: "x\n" });
    assert(!linked.ok, "a hard-linked target is refused");
    assertStringIncludes(linked.error.message, "hard link");
    assertEquals(await Deno.readTextFile(original), "original\n");

    const asDir = `${dir}/subdir`;
    await Deno.mkdir(asDir);
    const directory = await appendNoFollow({
      targetFile: asDir,
      content: "x\n",
    });
    assert(!directory.ok, "a directory target is refused");
    assertStringIncludes(directory.error.message, "not a regular file");
  });
});

// =============================================================================
// readTextFileNoFollow (Issue #1234)
// =============================================================================

Deno.test("readTextFileNoFollow - reads a regular file", async () => {
  await withTempDir(async (dir) => {
    const target = `${dir}/.gitignore`;
    await Deno.writeTextFile(target, "node_modules/\n");

    const result = await readTextFileNoFollow(target);
    assert(result.ok, "a regular file is read");
    assertEquals(result.value, "node_modules/\n");
  });
});

Deno.test("readTextFileNoFollow - reports an absent file as null", async () => {
  await withTempDir(async (dir) => {
    const result = await readTextFileNoFollow(`${dir}/absent`);
    assert(result.ok, "an absent file is not an error");
    assertEquals(result.value, null);
  });
});

Deno.test("readTextFileNoFollow - refuses a symlink, a hard link and a directory", async () => {
  await withTempDir(async (dir) => {
    const victim = `${dir}/victim`;
    await Deno.writeTextFile(victim, "secret\n");

    const link = `${dir}/link`;
    await Deno.symlink(victim, link);
    const symlinked = await readTextFileNoFollow(link);
    assert(!symlinked.ok, "a symlink target is refused");
    assertStringIncludes(symlinked.error.message, "symlink");

    const hard = `${dir}/hard`;
    await Deno.link(victim, hard);
    const hardLinked = await readTextFileNoFollow(hard);
    assert(!hardLinked.ok, "a hard-linked target is refused");
    assertStringIncludes(hardLinked.error.message, "hard link");

    const asDir = `${dir}/subdir`;
    await Deno.mkdir(asDir);
    const directory = await readTextFileNoFollow(asDir);
    assert(!directory.ok, "a directory target is refused");
    assertStringIncludes(directory.error.message, "not a regular file");
  });
});
