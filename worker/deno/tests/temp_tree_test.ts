/**
 * Tests for the temp-tree teardown helper (Issue #1135).
 *
 * The behaviour under test is what teardown does when the tree does not come
 * away first time: it must retry briefly, say so when a retry was needed,
 * fail loudly when the tree outlasts the window — and never replace the
 * failure of the behaviour under test with its own.
 *
 * Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  listTree,
  REMOVAL_ATTEMPTS,
  removeTempTree,
  withTempDir,
} from "./support/temp_tree.ts";

/** Deps that fail the first `failures` removals, then succeed. */
function flakyRemove(failures: number) {
  let attempts = 0;
  const warnings: string[] = [];
  return {
    attemptsSoFar: () => attempts,
    warnings,
    deps: {
      remove: (_dir: string) => {
        attempts++;
        if (attempts <= failures) {
          return Promise.reject(
            new Error("Directory not empty (os error 39)"),
          );
        }
        return Promise.resolve();
      },
      list: () => Promise.resolve(["late-writer.tmp"]),
      sleep: () => Promise.resolve(),
      warn: (message: string) => {
        warnings.push(message);
      },
    },
  };
}

Deno.test("removeTempTree - removes a populated tree", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(`${dir}/nested/deeper`, { recursive: true });
  await Deno.writeTextFile(`${dir}/nested/deeper/file.txt`, "content");

  await removeTempTree(dir);

  assertEquals(await listTree(dir), []);
  await assertRejects(() => Deno.stat(dir), Deno.errors.NotFound);
});

Deno.test("removeTempTree - a tree that is already gone is the outcome teardown wanted", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.remove(dir);
  // No throw: the directory is gone, which is what the caller asked for.
  await removeTempTree(dir);
});

Deno.test("removeTempTree - a late writer costs a retry, and the retry is announced", async () => {
  const flaky = flakyRemove(2);

  await removeTempTree("/tmp/does-not-matter", flaky.deps);

  assertEquals(flaky.attemptsSoFar(), 3);
  assertEquals(flaky.warnings.length, 1, flaky.warnings.join("\n"));
  assert(
    flaky.warnings[0]!.includes("attempt 3"),
    flaky.warnings[0],
  );
  assert(
    flaky.warnings[0]!.includes("Directory not empty"),
    "the retry note carries the error it retried past",
  );
});

Deno.test("removeTempTree - a clean removal says nothing", async () => {
  const flaky = flakyRemove(0);

  await removeTempTree("/tmp/does-not-matter", flaky.deps);

  assertEquals(flaky.attemptsSoFar(), 1);
  assertEquals(flaky.warnings, []);
});

Deno.test("removeTempTree - a tree that outlasts the window fails loudly, as a teardown failure", async () => {
  const flaky = flakyRemove(Number.MAX_SAFE_INTEGER);

  const error = await assertRejects(
    () => removeTempTree("/tmp/wedged-tree", flaky.deps),
    Error,
  );

  assertEquals(flaky.attemptsSoFar(), REMOVAL_ATTEMPTS);
  // The reader must not spend an hour on the behaviour under test again.
  assert(error.message.includes("Teardown could not remove"), error.message);
  assert(
    error.message.includes("not a failure of the behaviour under test"),
    error.message,
  );
  // ...and it names what was still there, so the leak is investigable.
  assert(error.message.includes("late-writer.tmp"), error.message);
  assert(error.message.includes("/tmp/wedged-tree"), error.message);
});

Deno.test("withTempDir - hands out a directory and removes it afterwards", async () => {
  let seen = "";
  const value = await withTempDir(async (dir) => {
    seen = dir;
    await Deno.writeTextFile(`${dir}/marker`, "written");
    return "returned";
  });

  assertEquals(value, "returned");
  assert(seen.length > 0);
  await assertRejects(() => Deno.stat(seen), Deno.errors.NotFound);
});

Deno.test("withTempDir - a failing body keeps its own error and still cleans up", async () => {
  let seen = "";

  const error = await assertRejects(
    () =>
      withTempDir(async (dir) => {
        seen = dir;
        await Deno.writeTextFile(`${dir}/marker`, "written");
        throw new Error("the behaviour under test failed");
      }),
    Error,
  );

  // The failure the reader needs, not the teardown's.
  assertEquals(error.message, "the behaviour under test failed");
  await assertRejects(() => Deno.stat(seen), Deno.errors.NotFound);
});

Deno.test("listTree - names every entry relative to the root", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/a/b`, { recursive: true });
    await Deno.writeTextFile(`${dir}/a/b/c.txt`, "x");
    await Deno.writeTextFile(`${dir}/top.txt`, "y");

    assertEquals(await listTree(dir), ["a", "a/b", "a/b/c.txt", "top.txt"]);
  } finally {
    await removeTempTree(dir);
  }
});

Deno.test("listTree - a tree that has gone lists nothing rather than throwing", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.remove(dir);

  assertEquals(await listTree(dir), []);
});
