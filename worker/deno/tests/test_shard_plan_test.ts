/**
 * PR #1170: the CI shards run the unit suite, and only the unit suite.
 *
 * `.github/scripts/deno-test-shard.sh` used to build its own list with
 * `find tests -maxdepth 1 -name '*_test.ts'`, so the four `validate (tests
 * N/4)` legs — the checks that decide a merge — ran a suite nobody could run
 * locally: every integration suite `deno task test:unit` excludes (#907) was
 * in it, which is why each leg had to install PowerShell before it could
 * start, and the files listed as unable to share a process (#880, #940) ran
 * in the same invocation as everything else.
 *
 * The dangerous failure mode of fixing that is the one that looks like a
 * success: a file that falls out of *every* pass stops running, the gate gets
 * faster and nothing goes red. So the assertions below are totality ones —
 * across all four shards, every `tests/*_test.ts` on disk is run exactly once,
 * with the integration suites the only deliberate omission and named as such.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  serialPassFiles,
  shardTestFiles,
  testShardPlan,
} from "../lib/unit_test_passes.ts";
import { INTEGRATION_TEST_FILES } from "../lib/integration_test_manifest.ts";
import { PARALLEL_UNSAFE_TEST_FILES } from "../lib/parallel_unsafe_test_manifest.ts";

/** The shard count CI runs, and the one `validate-scripts.yml` names. */
const SHARDS = 4;

/** Every `tests/*_test.ts` on disk — what the shard script used to `find`. */
async function testFilesOnDisk(): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(new URL(".", import.meta.url))) {
    if (entry.isFile && entry.name.endsWith("_test.ts")) {
      files.push(`tests/${entry.name}`);
    }
  }
  return files.sort();
}

/** The real plan for every shard. */
async function allShards() {
  const testFiles = await testFilesOnDisk();
  return {
    testFiles,
    plans: Array.from(
      { length: SHARDS },
      (_, index) => testShardPlan({ testFiles, index, count: SHARDS }),
    ),
  };
}

Deno.test("test shard plan - no shard runs an integration suite (PR #1170)", async () => {
  const { plans } = await allShards();
  const integration = new Set(INTEGRATION_TEST_FILES);
  for (const [index, plan] of plans.entries()) {
    for (const file of [...plan.parallel, ...plan.serial]) {
      assert(
        !integration.has(file),
        `shard ${index} runs the integration suite ${file} — the merge gate ` +
          "is back to needing a provisioned pwsh",
      );
    }
  }
});

Deno.test("test shard plan - the parallel pass carries no parallel-unsafe file (PR #1170)", async () => {
  const { plans } = await allShards();
  const unsafe = new Set(PARALLEL_UNSAFE_TEST_FILES);
  for (const [index, plan] of plans.entries()) {
    for (const file of plan.parallel) {
      assert(
        !unsafe.has(file),
        `shard ${index} runs ${file} in the --parallel pass, and it is ` +
          "listed as unable to share a process",
      );
    }
  }
});

Deno.test("test shard plan - the serial pass is exactly the parallel-unsafe unit tests (PR #1170)", async () => {
  const { plans } = await allShards();
  const serial = plans.flatMap((plan) => [...plan.serial]).sort();
  assertEquals(serial, [...serialPassFiles()].sort());
});

Deno.test("test shard plan - every test file is run once, or named as excluded (PR #1170)", async () => {
  const { testFiles, plans } = await allShards();
  const run = plans.flatMap((plan) => [...plan.parallel, ...plan.serial]);
  assertEquals(
    run.length,
    new Set(run).size,
    "a file is run by more than one shard",
  );
  const accounted = [...new Set([...run, ...plans[0]!.integration])].sort();
  assertEquals(
    accounted,
    testFiles,
    "a test file is neither run by a shard nor named as an excluded " +
      "integration suite — it has silently stopped running",
  );
});

Deno.test("test shard plan - the integration list is reported whole, on every shard (PR #1170)", async () => {
  const { testFiles, plans } = await allShards();
  const expected = INTEGRATION_TEST_FILES.filter((f) => testFiles.includes(f));
  for (const plan of plans) {
    assertEquals(
      [...plan.integration].sort(),
      [...expected].sort(),
      "each shard must print the whole exclusion, so a reader of the CI log " +
        "sees what was left out rather than a quietly smaller suite",
    );
  }
});

Deno.test("test shard plan - the shards stay balanced (PR #1170)", async () => {
  const { plans } = await allShards();
  const sizes = plans.map((p) => p.parallel.length + p.serial.length);
  const spread = Math.max(...sizes) - Math.min(...sizes);
  assert(
    spread <= SHARDS,
    `shard sizes ${sizes.join(", ")} differ by ${spread}; the stride split ` +
      "should keep them within one file per pass",
  );
});

Deno.test("shardTestFiles - the split is a partition, whatever the input order", () => {
  const files = ["c.ts", "a.ts", "d.ts", "b.ts", "e.ts"];
  const shards = [0, 1, 2].map((i) => shardTestFiles(files, i, 3));
  assertEquals(shards[0], ["a.ts", "d.ts"]);
  assertEquals(shards[1], ["b.ts", "e.ts"]);
  assertEquals(shards[2], ["c.ts"]);
  assertEquals(shards.flat().sort(), [...files].sort());
});

Deno.test("shardTestFiles - a nonsensical shard fails loud", () => {
  assertThrows(() => shardTestFiles(["a.ts"], 0, 0), Error, "positive integer");
  assertThrows(() => shardTestFiles(["a.ts"], 4, 4), Error, "shard index");
  assertThrows(() => shardTestFiles(["a.ts"], -1, 2), Error, "shard index");
});

Deno.test("testShardPlan - the manifests are injectable, and drive the split", () => {
  const testFiles = ["tests/a_test.ts", "tests/b_test.ts", "tests/c_test.ts"];
  const plan = testShardPlan({
    testFiles,
    index: 0,
    count: 1,
    integrationFiles: ["tests/c_test.ts"],
    parallelUnsafeFiles: ["tests/b_test.ts"],
  });
  assertEquals(plan.parallel, ["tests/a_test.ts"]);
  assertEquals(plan.serial, ["tests/b_test.ts"]);
  assertEquals(plan.integration, ["tests/c_test.ts"]);
});

Deno.test("testShardPlan - a file that is both integration and parallel-unsafe runs nowhere in the gate", () => {
  // `run_ps1_launcher_test.ts` is exactly this: it spawns pwsh and it times
  // itself. Naming it in the serial pass would run in the merge gate the very
  // suite #907 took out of it.
  const plan = testShardPlan({
    testFiles: ["tests/both_test.ts"],
    index: 0,
    count: 1,
    integrationFiles: ["tests/both_test.ts"],
    parallelUnsafeFiles: ["tests/both_test.ts"],
  });
  assertEquals(plan.parallel, []);
  assertEquals(plan.serial, []);
  assertEquals(plan.integration, ["tests/both_test.ts"]);
});
