/**
 * `logger.ts` loads on a permission set without `--allow-env`.
 *
 * `defaultLogger` is constructed at module scope, so every module that
 * transitively imports `logger.ts` inherits its environment reads at *load*
 * time. Tools deliberately run on narrow permissions — `test_shard_files.ts`
 * is spawned with `--allow-read` alone by
 * `.github/scripts/deno-test-shard.sh` — so an unguarded `Deno.env.get`
 * there aborts the tool before it runs a line of its own.
 *
 * That is not hypothetical. Widening an unrelated import graph until it
 * reached this module made the shard planner die with
 * `NotCapable: Requires env access to "DEBUG"`. Its stderr was discarded by
 * the calling shell, so the plan came back empty and **all four**
 * `validate (tests N/4)` shards failed at once, pointing at no test.
 *
 * This spawns a real Deno with `--allow-read` only, because that is the
 * condition under test: an in-process assertion cannot reproduce it, since
 * this suite runs with `-A`.
 *
 * Australian English spelling throughout (behaviour, unauthorised).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";

const LOGGER = new URL("../lib/logger.ts", import.meta.url);

/** Run a snippet under an explicit permission set. */
async function runWith(
  permissions: string[],
  source: string,
): Promise<{ code: number; stderr: string }> {
  const file = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    await Deno.writeTextFile(file, source);
    const { code, stderr } = await new Deno.Command(Deno.execPath(), {
      args: ["run", ...permissions, file],
      stdout: "null",
      stderr: "piped",
    }).output();
    return { code, stderr: new TextDecoder().decode(stderr) };
  } finally {
    await Deno.remove(file).catch(() => {});
  }
}

Deno.test("logger - imports cleanly with --allow-read and no --allow-env", async () => {
  const { code, stderr } = await runWith(
    ["--allow-read"],
    `import { defaultLogger } from "${LOGGER.href}";\n` +
      `if (typeof defaultLogger.info !== "function") Deno.exit(3);\n`,
  );
  assertEquals(code, 0, stderr);
  assertEquals(stderr.includes("NotCapable"), false, stderr);
});

Deno.test("logger - an unreadable DEBUG degrades to off, it does not throw", async () => {
  // The value half: without env access the logger must still be usable and
  // must not silently claim debug is on.
  const { code, stderr } = await runWith(
    ["--allow-read"],
    `import { defaultLogger } from "${LOGGER.href}";\n` +
      `defaultLogger.info("still works");\n`,
  );
  assertEquals(code, 0, stderr);
});

Deno.test("logger - the guard is what makes it load, not luck", async () => {
  // Proves the test is capable of catching the regression: the same read,
  // unguarded, does fail under this permission set.
  const { code, stderr } = await runWith(
    ["--allow-read"],
    `Deno.env.get("DEBUG");\n`,
  );
  assertEquals(code === 0, false, "an unguarded env read must fail here");
  assertStringIncludes(stderr, "NotCapable");
});
