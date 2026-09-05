/**
 * The file lists one CI shard runs, printed for `deno-test-shard.sh`
 * (PR #1170).
 *
 * The shard script used to build its own list with `find`, which is how the
 * merge gate came to run a different suite from the one `deno task test:unit`
 * runs: every integration suite was in it, and the parallel-unsafe files ran
 * alongside everything else. Shell cannot import the manifests, so it asks
 * for the split instead of guessing at it — {@link testShardPlan} is the same
 * partition {@link unitTestPasses} builds, from the same two manifests, so
 * there is no second copy to drift.
 *
 * Usage: `deno run --allow-read test_shard_files.ts <index> <count>`
 *
 * Output is one `<pass>\t<path>` line per file — `parallel`, `serial`, or
 * `integration` for the suites this shard deliberately leaves to the
 * `integration tests` job. A tab-separated stream is what a `while IFS=$'\t'
 * read` loop consumes without quoting hazards, and no test path contains a
 * tab.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { testShardPlan } from "./lib/unit_test_passes.ts";

/** The directory the gate and CI both run `deno test` from. */
const TESTS_DIR = new URL("./tests", import.meta.url);

/** Every `tests/*_test.ts`, the same set `find -maxdepth 1` produced. */
async function unitTestFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(TESTS_DIR)) {
    if (entry.isFile && entry.name.endsWith("_test.ts")) {
      files.push(`tests/${entry.name}`);
    }
  }
  return files;
}

/**
 * A required numeric argument.
 *
 * Fails loud rather than defaulting: a shard index that quietly became 0
 * would run shard 0's files four times and report nothing about the rest.
 */
function requireInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (value === undefined || !Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer, got ${value ?? "nothing"}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const index = requireInteger(Deno.args[0], "shard index");
  const count = requireInteger(Deno.args[1], "shard count");
  const plan = testShardPlan({
    testFiles: await unitTestFiles(),
    index,
    count,
  });
  const lines: string[] = [];
  for (const file of plan.parallel) lines.push(`parallel\t${file}`);
  for (const file of plan.serial) lines.push(`serial\t${file}`);
  for (const file of plan.integration) lines.push(`integration\t${file}`);
  // An empty plan prints nothing at all: one blank line would reach the
  // shell's read loop as a file with no pass, which is a failure there.
  if (lines.length > 0) console.log(lines.join("\n"));
}

if (import.meta.main) await main();
