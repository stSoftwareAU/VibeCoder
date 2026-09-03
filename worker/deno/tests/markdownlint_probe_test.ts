/**
 * Issue #894: the markdownlint stage must not disable itself when it has
 * something to catch.
 *
 * `canRunBinary()` probed for a usable binary by running it with `--version`
 * and treating a non-zero exit as "not available". `markdownlint-cli2` has no
 * `--version` flag: it treats the argument as a **glob**, lints the repository
 * against `.markdownlint-cli2.jsonc`, and exits 1 when it finds a violation.
 *
 * So the probe failed precisely when the repository had a Markdown violation.
 * `detectMarkdownlintRunner()` returned null, the stage reported
 * `markdownlint: SKIPPED (markdownlint-cli2 not available)`, and `./quality.sh`
 * went green over it — absence of a failure marker reported as success, which
 * the standards forbid.
 *
 * The question the probe must answer is "does this binary exist and start",
 * not "does it exit zero". These tests pin that separation, because the two
 * are easy to conflate and the failure is silent when they are.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import { canRunBinary } from "../lib/markdownlint_check.ts";

/** A script exiting with `code`, standing in for a real runner. */
async function stub(dir: string, name: string, code: number): Promise<string> {
  const path = `${dir}/${name}`;
  await Deno.writeTextFile(path, `#!/bin/bash\nexit ${code}\n`);
  await Deno.chmod(path, 0o755);
  return path;
}

Deno.test("markdownlint probe - a runner exiting non-zero is still available (Issue #894)", async () => {
  // The regression: markdownlint-cli2 exits 1 on a violation, and the old
  // probe read that as "binary missing" — turning the stage off exactly when
  // it mattered.
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await canRunBinary(await stub(dir, "lint-fails", 1)), true);
    assertEquals(await canRunBinary(await stub(dir, "lint-fails-2", 2)), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("markdownlint probe - a runner exiting zero is available (Issue #894)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await canRunBinary(await stub(dir, "lint-ok", 0)), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("markdownlint probe - an absent binary is still absent (Issue #894)", async () => {
  // The fix must not report everything as available: a missing binary has to
  // stay missing, or the stage fails instead of skipping and the operator
  // learns nothing useful.
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await canRunBinary(`${dir}/definitely-not-here`), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("markdownlint probe - a present but unexecutable file is not a runner (Issue #894)", async () => {
  // Spawning is the signal that answers the question: this throws.
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/not-a-program`;
    await Deno.writeTextFile(path, "just text");
    await Deno.chmod(path, 0o644);
    assertEquals(await canRunBinary(path), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
