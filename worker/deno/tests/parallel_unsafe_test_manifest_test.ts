/**
 * Issue #940: the parallel-unsafe manifest must be usable as an `--ignore`.
 *
 * The list lived in `parallel_safety_cap_test.ts` as a private set of bare
 * filenames, which was enough to cap the debt (#880) and useless to the gate:
 * `deno test --ignore=` wants paths relative to `worker/deno`, and a test
 * file cannot be imported by `lib/`. Moving it into a manifest is what lets
 * the unit suite split into a fast parallel pass and a serial one, taking the
 * stage from 42+ minutes to single digits.
 *
 * A manifest that the gate reads has failure modes the private set did not.
 * An entry naming a deleted file makes `--ignore` silently meaningless — the
 * same trap a stale `HOME_WORKDIR_ALLOWLIST` entry sprang on #805 and again
 * on #808. A bare filename with no `tests/` prefix matches nothing and the
 * mutator runs in the parallel pass anyway, which is the dangerous direction:
 * it shows up as intermittent red on unrelated work.
 *
 * `parallel_safety_cap_test.ts` guards what belongs in the list. This guards
 * that the list can do its new job.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  measuresWallClock,
  mutatesProcessState,
  PARALLEL_UNSAFE_TEST_FILES,
  parallelUnsafeIgnoreArg,
  PROCESS_STATE_MUTATOR_TEST_FILES,
  reachesInTestGraph,
  relativeImports,
  resolveFrom,
  SUBPROCESS_TIMING_TEST_FILES,
  WALL_CLOCK_TEST_FILES,
} from "../lib/parallel_unsafe_test_manifest.ts";
import {
  readTestSourceGraph,
  suiteFiles,
} from "./support/test_source_graph.ts";

const DENO_DIR = new URL("..", import.meta.url).pathname;

Deno.test("parallel-unsafe manifest - every path is relative to worker/deno (Issue #940)", () => {
  const wrong = PARALLEL_UNSAFE_TEST_FILES.filter((file) =>
    !file.startsWith("tests/") || !file.endsWith("_test.ts")
  );
  assertEquals(
    wrong,
    [],
    "`deno test --ignore=` resolves against worker/deno, so a bare filename " +
      "excludes nothing and the mutator races in the parallel pass:\n" +
      wrong.join("\n"),
  );
});

Deno.test("parallel-unsafe manifest - every listed file exists (Issue #940)", async () => {
  const missing: string[] = [];
  for (const file of PARALLEL_UNSAFE_TEST_FILES) {
    try {
      await Deno.stat(`${DENO_DIR}${file}`);
    } catch {
      missing.push(file);
    }
  }
  assertEquals(
    missing,
    [],
    "an entry naming a deleted file makes `--ignore` silently meaningless, " +
      "and puts a file in the serial pass that no longer exists: " +
      missing.join(", "),
  );
});

Deno.test("parallel-unsafe manifest - no category list holds a duplicate (Issue #940)", () => {
  // The union dedupes, so a repeated entry costs nothing at runtime — which
  // is exactly why it would sit there. It still means somebody added a file
  // that was already listed, and the next reader has to work out which of the
  // two the shrink-only cap is counting.
  for (
    const [name, list] of [
      ["PROCESS_STATE_MUTATOR_TEST_FILES", PROCESS_STATE_MUTATOR_TEST_FILES],
      ["WALL_CLOCK_TEST_FILES", WALL_CLOCK_TEST_FILES],
      ["PARALLEL_UNSAFE_TEST_FILES", PARALLEL_UNSAFE_TEST_FILES],
    ] as const
  ) {
    const seen = new Set<string>();
    const duplicated = list.filter((file) => {
      if (seen.has(file)) return true;
      seen.add(file);
      return false;
    });
    assertEquals(duplicated, [], `${name} lists these twice`);
  }
});

Deno.test("parallel-unsafe manifest - the ignore argument is well formed (Issue #940)", () => {
  const arg = parallelUnsafeIgnoreArg();
  assert(arg.length > 0, "an empty --ignore would exclude nothing");
  assertEquals(arg.split(",").length, PARALLEL_UNSAFE_TEST_FILES.length);
  assertEquals(arg.split(","), [...PARALLEL_UNSAFE_TEST_FILES]);
});

Deno.test("parallel-unsafe manifest - the ignore argument takes an injected list (Issue #940)", () => {
  // The seam the pass builder uses, so a test can vary the manifest without
  // touching the real one.
  assertEquals(
    parallelUnsafeIgnoreArg(["tests/a_test.ts", "tests/b_test.ts"]),
    "tests/a_test.ts,tests/b_test.ts",
  );
  assertEquals(parallelUnsafeIgnoreArg([]), "");
});

/**
 * A `Deno.<call>` source line, spelled in two pieces.
 *
 * `parallel_safety_cap_test.ts` classifies by source text, so writing either
 * call out in full would make this file look like a mutator and push it into
 * the serial pass. A test about the classifier is a poor reason to grow the
 * list the classifier caps.
 */
function denoCall(call: string): string {
  return `Deno.${call}`;
}

Deno.test("parallel-unsafe manifest - the classifier catches both mutations (Issue #940)", () => {
  assert(
    mutatesProcessState(denoCall('env.set("VIBE_RUN_ID", "abc");')),
    "setting an environment variable writes state every parallel worker shares",
  );
  assert(
    mutatesProcessState(denoCall("chdir(temp);")),
    "chdir moves the working directory out from under the other workers",
  );
});

Deno.test("parallel-unsafe manifest - reading the environment is parallel safe (Issue #940)", () => {
  // The asymmetry is the whole point: a file that only reads can run in the
  // fast pass, and wrongly claiming it would keep the serial pass large for
  // no reason.
  assertEquals(mutatesProcessState(denoCall('env.get("HOME");')), false);
  assertEquals(mutatesProcessState(denoCall("env.toObject();")), false);
  assertEquals(mutatesProcessState(denoCall("cwd();")), false);
});

/** Test files that assert on a real elapsed clock, helpers included. */
async function measuring(): Promise<string[]> {
  const sources = await readTestSourceGraph(DENO_DIR);
  return suiteFiles(sources).filter((file) =>
    // This file names the helper in its own prose and assertions.
    file !== "tests/parallel_unsafe_test_manifest_test.ts" &&
    reachesInTestGraph(file, sources, measuresWallClock)
  );
}

Deno.test("parallel-unsafe manifest - the union is exactly the two categories (Issue #940)", () => {
  // The gate ignores the union and nothing else, so a file in a category but
  // not the union runs in the parallel pass anyway.
  const union = new Set(PARALLEL_UNSAFE_TEST_FILES);
  const missing = [
    ...PROCESS_STATE_MUTATOR_TEST_FILES,
    ...WALL_CLOCK_TEST_FILES,
    ...SUBPROCESS_TIMING_TEST_FILES.keys(),
  ].filter((f) => !union.has(f)).sort();
  assertEquals(missing, [], "listed in a category but not in the union");
  assertEquals(
    PARALLEL_UNSAFE_TEST_FILES.length,
    new Set([
      ...PROCESS_STATE_MUTATOR_TEST_FILES,
      ...WALL_CLOCK_TEST_FILES,
      ...SUBPROCESS_TIMING_TEST_FILES.keys(),
    ]).size,
    "a file in both categories must appear once — the serial pass names " +
      "these explicitly, and a duplicate runs the suite twice",
  );
});

Deno.test("parallel-unsafe manifest - no wall-clock test is missing from it (Issue #940)", async () => {
  // Six of the eight failures in the first --parallel trial were ReDoS
  // budgets beaten by their own workers. A new one left off this list goes
  // red one run in five, on somebody else's change.
  const listed = new Set(WALL_CLOCK_TEST_FILES);
  const missing = (await measuring()).filter((f) => !listed.has(f));
  assertEquals(
    missing,
    [],
    "these assert on a real elapsed clock and would be beaten by the other " +
      "workers under --parallel — add them to WALL_CLOCK_TEST_FILES, or " +
      "take an injected clock instead of the stopwatch:\n" +
      missing.join("\n"),
  );
});

Deno.test("parallel-unsafe manifest - it holds nothing that stopped measuring (Issue #940)", async () => {
  // The stale direction. A file that took an injected clock belongs back in
  // the fast pass, and an entry left behind is the orphan #805 and #808 paid
  // four runs for.
  const found = new Set(await measuring());
  const stale = WALL_CLOCK_TEST_FILES.filter((f) => !found.has(f));
  assertEquals(
    stale,
    [],
    "these no longer assert on a real clock — remove them so they run in " +
      "the fast pass again:\n" + stale.join("\n"),
  );
});

Deno.test("parallel-unsafe manifest - the clock classifier matches both shapes (Issue #940)", () => {
  // The helper does its callers' timing, so a file that uses it never reads
  // a clock itself. Matching only the clock missed
  // secret_redaction_bounds_test.ts, one of the six measured failures.
  assert(
    measuresWallClock(
      "import { assertLinear" + 'Growth } from "./support/gro' + 'wth.ts";',
    ),
    "a caller of the shared ratio helper is measuring, clock or no clock",
  );
  assert(
    measuresWallClock(
      denoCall("chdirless(); const t = performance") +
        ".now();\nassert(took < 2_000);",
    ),
    "a real clock reading compared against a bound is measuring",
  );
});

Deno.test("parallel-unsafe manifest - a domain budget on an injected clock is not measuring (Issue #940)", () => {
  // Token budgets, spend ceilings and phase deadlines against an injected
  // clock are the tests that took the seam. Claiming them would push real
  // unit tests into the slow pass for nothing.
  assertEquals(
    measuresWallClock(
      "const budget = 10_000; assertEquals(spent < budget, true);",
    ),
    false,
  );
  assertEquals(measuresWallClock("assertEquals(tokenBudget, 4096);"), false);
});

/** A source map for the import walk, spelled inline. */
function graph(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

Deno.test("parallel-unsafe manifest - a helper's mutation belongs to its importers (Issue #940)", () => {
  // The #880 baseline was short by forty-two files because it stopped at each
  // suite's own text. `tests/support/repo_prompts.ts` moves the working
  // directory at module scope, and thirty-two of its importers mutate nothing
  // themselves — every one of them would have raced nine other workers.
  const sources = graph({
    "tests/quiet_test.ts": 'import { withRepo } from "./support/helper.ts";',
    "tests/support/helper.ts": denoCall("chdir(REPO_ROOT);"),
  });
  assertEquals(
    mutatesProcessState(sources.get("tests/quiet_test.ts")!),
    false,
    "the suite's own text is clean — that is exactly why the grep missed it",
  );
  assert(
    reachesInTestGraph("tests/quiet_test.ts", sources, mutatesProcessState),
    "importing a helper that moves the working directory makes the suite " +
      "parallel-unsafe",
  );
});

Deno.test("parallel-unsafe manifest - the walk follows helpers of helpers (Issue #940)", () => {
  const sources = graph({
    "tests/a_test.ts": 'import { b } from "./support/b.ts";',
    "tests/support/b.ts": 'import { c } from "./nested/c.ts";',
    "tests/support/nested/c.ts": denoCall('env.set("X", "1");'),
  });
  assert(reachesInTestGraph("tests/a_test.ts", sources, mutatesProcessState));
});

Deno.test("parallel-unsafe manifest - the walk stops at the tests boundary (Issue #940)", () => {
  // Following into lib/ claims 806 of the 1,197 suites, almost all because
  // some reachable function is *able* to set a variable. That is not a
  // classification, and it would leave nothing in the parallel pass.
  const sources = graph({
    "tests/a_test.ts": 'import { thing } from "../lib/thing.ts";',
    "lib/thing.ts": denoCall('env.set("X", "1");'),
  });
  assertEquals(
    reachesInTestGraph("tests/a_test.ts", sources, mutatesProcessState),
    false,
  );
});

Deno.test("parallel-unsafe manifest - an import cycle terminates (Issue #940)", () => {
  const sources = graph({
    "tests/a_test.ts": 'import { b } from "./support/b.ts";',
    "tests/support/b.ts": 'import { a } from "../a_test.ts";',
  });
  assertEquals(
    reachesInTestGraph("tests/a_test.ts", sources, mutatesProcessState),
    false,
    "a cycle must terminate rather than hang the conformance test",
  );
});

Deno.test("parallel-unsafe manifest - both import forms are followed (Issue #940)", () => {
  assertEquals(
    relativeImports(
      'import { a } from "./x.ts";\nconst b = await import("../y.ts");\n' +
        'import { c } from "@std/assert";',
    ),
    ["./x.ts", "../y.ts"],
    "a bare specifier names a dependency, not a file in this tree",
  );
});

Deno.test("parallel-unsafe manifest - specifiers resolve against the importer (Issue #940)", () => {
  assertEquals(
    resolveFrom("tests/support/nested/c.ts", "../../a_test.ts"),
    "tests/a_test.ts",
  );
  assertEquals(
    resolveFrom("tests/a_test.ts", "./support/helper.ts"),
    "tests/support/helper.ts",
  );
  assertEquals(resolveFrom("tests/a_test.ts", "../lib/x.ts"), "lib/x.ts");
});

Deno.test("parallel-unsafe manifest - deleting a variable is a mutation (Issue #940)", () => {
  // #880's spelling had `set` and `chdir` but not `delete`, and
  // repo_prompts.ts opens by deleting five prompt-directory variables.
  assert(mutatesProcessState(denoCall('env.delete("PROMPTS_DIR");')));
});

Deno.test("parallel-unsafe manifest - every subprocess-timing entry gives its measurement (Issue #940)", () => {
  // No classifier claims these two: what makes them unsafe is that they
  // spawn something real and then depend on it being scheduled promptly.
  // An exemption nobody had to justify is one nobody can retire, so the
  // entry costs the evidence that put it there.
  assert(
    SUBPROCESS_TIMING_TEST_FILES.size > 0,
    "the category exists because two suites failed under --parallel and " +
      "passed sequentially in the same run",
  );
  for (const [file, reason] of SUBPROCESS_TIMING_TEST_FILES) {
    assert(reason.trim().length > 0, `${file} is listed with no reason`);
    assert(
      /--parallel|worker|schedul/.test(reason),
      `${file}'s reason must say why it cannot share the machine: ${reason}`,
    );
  }
});

Deno.test("parallel-unsafe manifest - every subprocess-timing entry names a real file (Issue #940)", async () => {
  const missing: string[] = [];
  for (const file of SUBPROCESS_TIMING_TEST_FILES.keys()) {
    try {
      await Deno.stat(`${DENO_DIR}${file}`);
    } catch {
      missing.push(file);
    }
  }
  assertEquals(
    missing,
    [],
    "a hand-placed entry has no classifier to notice it went stale: " +
      missing.join(", "),
  );
});
