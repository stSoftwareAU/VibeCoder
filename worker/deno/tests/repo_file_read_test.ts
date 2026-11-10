/**
 * Tests for the repo file reader (Issue #4920).
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assertEquals, assertRejects } from "@std/assert";
import { readRepoFile } from "../lib/repo_file_read.ts";

Deno.test("readRepoFile: reads a regular file under the root", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/sub`);
    await Deno.writeTextFile(`${dir}/sub/a.txt`, "hello");
    assertEquals(await readRepoFile(dir, "sub/a.txt"), "hello");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readRepoFile: refuses a file symlink to an outside file", async () => {
  const outside = await Deno.makeTempDir();
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${outside}/secret.txt`, "outside");
    await Deno.symlink(`${outside}/secret.txt`, `${dir}/link.txt`);
    await assertRejects(() => readRepoFile(dir, "link.txt"));
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("readRepoFile: refuses a file under a symlinked parent directory", async () => {
  const outside = await Deno.makeTempDir();
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${outside}/secret.txt`, "outside");
    await Deno.symlink(outside, `${dir}/linked`);
    await assertRejects(() => readRepoFile(dir, "linked/secret.txt"));
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("readRepoFile: refuses parent-directory and absolute paths", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/a.txt`, "x");
    for (
      const bad of ["", "/etc/passwd", "../a.txt", "sub/../a.txt", "./a.txt"]
    ) {
      await assertRejects(() => readRepoFile(dir, bad), Error, "Refusing");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readRepoFile: refuses a file over the cap and accepts one at the cap", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/big.txt`, "12345");
    await assertRejects(
      () => readRepoFile(dir, "big.txt", 4),
      Error,
      "within the size cap",
    );
    await Deno.writeTextFile(`${dir}/edge.txt`, "1234");
    assertEquals(await readRepoFile(dir, "edge.txt", 4), "1234");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readRepoFile: a missing file propagates NotFound", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await assertRejects(
      () => readRepoFile(dir, "missing.txt"),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readRepoFile: a directory is refused", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/sub`);
    await assertRejects(() => readRepoFile(dir, "sub"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
