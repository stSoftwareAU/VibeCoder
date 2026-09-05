/**
 * Issue #940: the gate's unit suite runs as two passes, and covers everything.
 *
 * One sequential `deno test` took 42+ minutes on a 10-core host against a
 * 45-minute phase budget, so issues died in `quality_gate` having changed
 * nothing wrong (#805 twice, #808). Splitting the suite — parallel-safe files
 * under `--parallel`, the #880 process-state mutators serially — takes most
 * of the 18x win now.
 *
 * A split has one dangerous failure mode, and it is the one that looks like a
 * success: a file that falls out of *both* passes stops running, the stage
 * gets faster, and nothing goes red. So the coverage assertion here is a
 * totality one — every `tests/*_test.ts` on disk is either not excluded from
 * the parallel pass or named by the serial pass, with the #907 integration
 * suites the only deliberate omission.
 *
 * The other assertions are about the verdict being readable. Two invocations
 * reported as one bare `deno tests FAILED` is worse than one, so each pass is
 * named with its own verdict and cost, including the pass that never ran.
 * And `DENO_JOBS` is bounded inside the container, where #4267's SIGKILLs
 * came from, and left alone on the host.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  CONTAINER_DENO_JOBS,
  CONTAINER_MARKER_VAR,
  formatPassDuration,
  integrationTestPass,
  serialPassFiles,
  summariseUnitTestPasses,
  type UnitTestPass,
  unitTestPasses,
  type UnitTestPassOutcome,
  unitTestStageVerdict,
} from "../lib/unit_test_passes.ts";
import { INTEGRATION_TEST_FILES } from "../lib/integration_test_manifest.ts";
import { PARALLEL_UNSAFE_TEST_FILES } from "../lib/parallel_unsafe_test_manifest.ts";

const TESTS_DIR = new URL(".", import.meta.url).pathname;

/** A host environment — no container marker, nothing to scrub. */
const HOST_ENV: Record<string, string> = { PATH: "/usr/bin", HOME: "/home/x" };

/** The gate's passes, built over the real manifests. */
function passes(
  env: Record<string, string> = HOST_ENV,
): readonly UnitTestPass[] {
  return unitTestPasses({ denoCmd: "/usr/bin/deno", env });
}

/** The `--ignore=` value a pass carries, split back into paths. */
function ignoredBy(pass: UnitTestPass): string[] {
  const arg = pass.args.find((a) => a.startsWith("--ignore="));
  return arg === undefined ? [] : arg.slice("--ignore=".length).split(",");
}

/** The bare file arguments a pass names (everything that is not a flag). */
function filesNamedBy(pass: UnitTestPass): string[] {
  return pass.args.filter((a) => a.endsWith("_test.ts") && !a.startsWith("-"));
}

/** Every `*_test.ts` in `tests/`, as manifest-shaped paths. */
async function testFilesOnDisk(): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(TESTS_DIR)) {
    if (entry.isFile && entry.name.endsWith("_test.ts")) {
      found.push(`tests/${entry.name}`);
    }
  }
  return found.sort();
}

Deno.test("unit passes - the suite runs as two passes, fast one first (Issue #940)", () => {
  const built = passes();
  assertEquals(built.length, 2);
  assertEquals(
    built.map((p) => p.label),
    ["parallel", "serial"],
    "the fast pass runs first so the common red is reported in minutes " +
      "rather than after the slow pass has also finished",
  );
});

Deno.test("unit passes - only the first pass carries --parallel (Issue #940)", () => {
  const [parallel, serial] = passes();
  assert(parallel!.args.includes("--parallel"));
  assertEquals(
    serial!.args.includes("--parallel"),
    false,
    "the serial pass exists because these files mutate shared process " +
      "state; running it with workers is the race it was split out to avoid",
  );
});

Deno.test("unit passes - the parallel pass ignores every process-state mutator (Issue #940)", () => {
  const ignored = new Set(ignoredBy(passes()[0]!));
  const leaked = PARALLEL_UNSAFE_TEST_FILES.filter((f) => !ignored.has(f));
  assertEquals(
    leaked,
    [],
    "these mutate the process environment or working directory and would " +
      "race under --parallel:\n" +
      leaked.join("\n"),
  );
});

Deno.test("unit passes - both passes exclude every integration test (Issue #940)", () => {
  // Issue #907 took these out of the gate because they cost ~12 of its ~36
  // minutes on every change, including changes that cannot reach them. A
  // two-pass rewrite is exactly the sort of edit that quietly puts them back.
  for (const pass of passes()) {
    const ignored = new Set(ignoredBy(pass));
    const missing = INTEGRATION_TEST_FILES.filter((f) => !ignored.has(f));
    assertEquals(
      missing,
      [],
      `the ${pass.label} pass does not exclude these integration suites:\n` +
        missing.join("\n"),
    );
    const named = filesNamedBy(pass).filter((f) =>
      INTEGRATION_TEST_FILES.includes(f)
    );
    assertEquals(
      named,
      [],
      `the ${pass.label} pass names these integration suites explicitly, ` +
        `which --ignore cannot undo:\n` + named.join("\n"),
    );
  }
});

Deno.test("unit passes - the serial pass names every mutator that is not an integration suite (Issue #940)", () => {
  const named = filesNamedBy(passes()[1]!);
  const expected = PARALLEL_UNSAFE_TEST_FILES.filter((f) =>
    !INTEGRATION_TEST_FILES.includes(f)
  );
  assertEquals(named, expected);
});

Deno.test("unit passes - a file that is both a mutator and an integration suite stays out (Issue #940)", () => {
  // `container_entrypoint_test.ts` is both. Naming it in the serial pass
  // would run in the gate the very suite #907 removed from it.
  const both = PARALLEL_UNSAFE_TEST_FILES.filter((f) =>
    INTEGRATION_TEST_FILES.includes(f)
  );
  assert(both.length > 0, "the overlap this guards must actually exist");
  assertEquals(
    serialPassFiles().filter((f) => both.includes(f)),
    [],
  );
});

Deno.test("unit passes - together they cover every unit test on disk (Issue #940)", async () => {
  // The dangerous regression, because it looks like a speed-up: a file
  // dropped from both passes stops running and nothing goes red.
  const ignoredByParallel = new Set(ignoredBy(passes()[0]!));
  const serialFiles = new Set(filesNamedBy(passes()[1]!));
  const integration = new Set(INTEGRATION_TEST_FILES);

  const uncovered = (await testFilesOnDisk()).filter((file) =>
    !integration.has(file) && ignoredByParallel.has(file) &&
    !serialFiles.has(file)
  );
  assertEquals(
    uncovered,
    [],
    "these run in neither pass, so they have silently stopped being " +
      "checked by the gate:\n" + uncovered.join("\n"),
  );
});

Deno.test("unit passes - the two passes do not overlap (Issue #940)", async () => {
  // Overlap is not a correctness bug, it is paid time: a file run twice is a
  // file run once in the pass that takes minutes.
  const ignoredByParallel = new Set(ignoredBy(passes()[0]!));
  const doubled = filesNamedBy(passes()[1]!).filter((f) =>
    !ignoredByParallel.has(f)
  );
  assertEquals(doubled, [], "run by both passes: " + doubled.join(", "));
  assert((await testFilesOnDisk()).length > 0, "the tests directory is read");
});

Deno.test("unit passes - both carry --no-check and the gate's permission set (Issue #940)", () => {
  // Issue #4347: the gate's own `deno check '**/*.ts'` already type-checks
  // tests/**, and building a second full program in parallel with it is the
  // memory spike quality.sh blames for the in-container SIGKILLs.
  for (const pass of passes()) {
    assert(pass.args.includes("--no-check"), `${pass.label} lost --no-check`);
    for (
      const flag of [
        "--allow-read",
        "--allow-env",
        "--allow-run",
        "--allow-write",
        "--allow-sys=hostname",
      ]
    ) {
      assert(pass.args.includes(flag), `${pass.label} lost ${flag}`);
    }
    assertEquals(pass.args[0], "/usr/bin/deno");
    assertEquals(pass.args[1], "test");
  }
});

Deno.test("unit passes - extra flags land before the permission set (Issue #940)", () => {
  // `deno task test:unit` adds `--frozen --lock=deno.lock`; the gate adds
  // none. Both must reach `deno test` as flags, not as file arguments.
  const built = unitTestPasses({
    denoCmd: "deno",
    env: HOST_ENV,
    extraArgs: ["--frozen", "--lock=deno.lock"],
  });
  for (const pass of built) {
    assertEquals(pass.args.slice(1, 4), [
      "test",
      "--frozen",
      "--lock=deno.lock",
    ]);
  }
});

Deno.test("unit passes - DENO_JOBS is bounded inside the container (Issue #940)", () => {
  // #4267's SIGKILLs came from the container's memory ceiling. One worker
  // per core is fine on a laptop and is how a green suite becomes an OOM in
  // a memory-capped container.
  const [parallel, serial] = passes({
    ...HOST_ENV,
    [CONTAINER_MARKER_VAR]: "claude",
  });
  assertEquals(parallel!.env.DENO_JOBS, CONTAINER_DENO_JOBS);
  assertEquals(
    Object.hasOwn(serial!.env, "DENO_JOBS"),
    false,
    "the serial pass has no workers to bound",
  );
});

Deno.test("unit passes - the host keeps Deno's default worker count (Issue #940)", () => {
  // The host has neither the memory ceiling nor the SIGKILL history, and
  // capping it at four would throw away most of the win on a 10-core box.
  for (const pass of passes()) {
    assertEquals(
      Object.hasOwn(pass.env, "DENO_JOBS"),
      false,
      `${pass.label} pinned DENO_JOBS on a host run`,
    );
  }
});

Deno.test("unit passes - an operator's own DENO_JOBS wins (Issue #940)", () => {
  const [parallel] = passes({
    ...HOST_ENV,
    [CONTAINER_MARKER_VAR]: "claude",
    DENO_JOBS: "2",
  });
  assertEquals(
    parallel!.env.DENO_JOBS,
    "2",
    "the bound is a default, not a policy — an operator debugging a race " +
      "must be able to pin the count",
  );
});

Deno.test("unit passes - CONFIG_PATH is scrubbed from both passes (Issue #940)", () => {
  // Issue #891: the container exports it, thirty-three tests point
  // CONFIG_FILE at their own fixture, and setup.sh's guard fails them all.
  // The scrub has to survive the split, in both passes.
  for (
    const pass of passes({
      ...HOST_ENV,
      CONFIG_PATH: "/run-config/.config.json",
    })
  ) {
    assertEquals(
      Object.hasOwn(pass.env, "CONFIG_PATH"),
      false,
      `${pass.label} inherited the container's CONFIG_PATH`,
    );
    assertEquals(pass.env.PATH, "/usr/bin");
  }
});

Deno.test("unit passes - WORK_DIR is scrubbed from both passes (Issue #1098)", () => {
  // The container exports the live worker volume. Inherited, every suite that
  // drives the main loop without naming its own work directory shares the
  // running fleet's state files with three sibling test processes — the
  // idle-disagreement suites failed on a streak a sibling had reset, and the
  // operator's own state was overwritten with test timestamps.
  for (
    const pass of passes({
      ...HOST_ENV,
      WORK_DIR: "/home/vibe/auto-issue-work",
    })
  ) {
    assertEquals(
      Object.hasOwn(pass.env, "WORK_DIR"),
      false,
      `${pass.label} inherited the container's WORK_DIR`,
    );
    assertEquals(pass.env.PATH, "/usr/bin");
  }
});

Deno.test("unit passes - the caller's environment is not mutated (Issue #940)", () => {
  const base: Record<string, string> = {
    PATH: "/usr/bin",
    [CONTAINER_MARKER_VAR]: "claude",
  };
  passes(base);
  assertEquals(Object.hasOwn(base, "DENO_JOBS"), false);
});

Deno.test("unit passes - the manifests are injectable (Issue #940)", () => {
  // The seam that lets these assertions be about behaviour rather than about
  // ninety-seven particular filenames.
  const built = unitTestPasses({
    denoCmd: "deno",
    env: HOST_ENV,
    integrationFiles: ["tests/slow_test.ts"],
    parallelUnsafeFiles: ["tests/mutator_test.ts", "tests/slow_test.ts"],
  });
  assertEquals(ignoredBy(built[0]!), [
    "tests/slow_test.ts",
    "tests/mutator_test.ts",
    "tests/slow_test.ts",
  ]);
  assertEquals(filesNamedBy(built[1]!), ["tests/mutator_test.ts"]);
  assertEquals(ignoredBy(built[1]!), ["tests/slow_test.ts"]);
});

Deno.test("unit passes - the summary names each pass, its verdict and its cost (Issue #940)", () => {
  // A gate that says only "tests failed" across two invocations is worse
  // than one that says which.
  const built = passes();
  const lines = summariseUnitTestPasses([
    { pass: built[0]!, exitCode: 0, durationMs: 143_000 },
    { pass: built[1]!, exitCode: 1, durationMs: 61_000 },
  ]);
  assertEquals(lines.length, 2);
  assert(lines[0]!.startsWith("Deno tests [parallel]: PASSED in 2m23s"));
  assert(lines[1]!.startsWith("Deno tests [serial]: FAILED in 1m01s"));
  assert(
    lines[1]!.includes("mutate shared process state"),
    "the line must say what the failing pass covered",
  );
});

Deno.test("unit passes - a pass that never ran does not read as one that passed (Issue #940)", () => {
  const built = passes();
  const outcomes: UnitTestPassOutcome[] = [
    { pass: built[0]!, exitCode: 1, durationMs: 5_000 },
    { pass: built[1]!, exitCode: null, durationMs: null },
  ];
  const lines = summariseUnitTestPasses(outcomes);
  assert(lines[1]!.includes("NOT RUN"));
  assertEquals(lines[1]!.includes("PASSED"), false);
});

Deno.test("unit passes - durations read at the scale they occur (Issue #940)", () => {
  assertEquals(formatPassDuration(400), "0.4s");
  assertEquals(formatPassDuration(41_000), "41s");
  assertEquals(formatPassDuration(143_000), "2m23s");
  assertEquals(formatPassDuration(2_520_000), "42m00s");
});

Deno.test("unit passes - the integration task is derived from the manifest (Issue #940)", () => {
  // `test:integration` used to hand-list thirteen files where the manifest
  // holds twenty-seven, because #935 added fourteen the task never learnt
  // about. Deriving it removes the copy rather than correcting it.
  const pass = integrationTestPass({ denoCmd: "deno", env: HOST_ENV });
  assertEquals(filesNamedBy(pass), [...INTEGRATION_TEST_FILES]);
  assertEquals(pass.args.includes("--parallel"), false);
});

Deno.test("deno.json - test:unit derives its scope instead of hand-listing it (Issue #940)", async () => {
  // The acceptance criterion: a developer running the task by hand gets the
  // gate's behaviour, not a second list that drifts from it.
  const denoJson = JSON.parse(
    await Deno.readTextFile(`${TESTS_DIR}../deno.json`),
  ) as { tasks: Record<string, string> };
  const task = denoJson.tasks["test:unit"];
  assert(task, "deno.json must define a test:unit task");
  assertEquals(
    task.includes("--ignore="),
    false,
    "an inline --ignore list is the hand-maintained copy this replaced",
  );
  assert(
    task.includes("unit_test_runner.ts"),
    "test:unit must run the same two passes as the gate",
  );
  assert(
    denoJson.tasks["test:integration"]?.includes("unit_test_runner.ts"),
    "test:integration must read the same manifest, not a second list",
  );
  assert(
    denoJson.tasks.test?.startsWith("deno test "),
    "the unrestricted `test` task stays the explicit run-everything hatch",
  );
});

Deno.test("unit passes - the stage passes only when both passes pass (Issue #940)", () => {
  const [parallel, serial] = passes();
  assertEquals(
    unitTestStageVerdict([
      { pass: parallel!, exitCode: 0, durationMs: 1 },
      { pass: serial!, exitCode: 0, durationMs: 1 },
    ]),
    { status: "PASSED", failedPass: null },
  );
});

Deno.test("unit passes - either pass failing fails the stage, and it says which (Issue #940)", () => {
  // A single invocation could not get this wrong; two can — a loop that
  // reports the last pass's exit code turns a red suite green.
  const [parallel, serial] = passes();
  assertEquals(
    unitTestStageVerdict([
      { pass: parallel!, exitCode: 1, durationMs: 1 },
      { pass: serial!, exitCode: null, durationMs: null },
    ]),
    { status: "FAILED", failedPass: "parallel" },
  );
  assertEquals(
    unitTestStageVerdict([
      { pass: parallel!, exitCode: 0, durationMs: 1 },
      { pass: serial!, exitCode: 1, durationMs: 1 },
    ]),
    { status: "FAILED", failedPass: "serial" },
  );
});

Deno.test("unit passes - a stage that ran nothing has not passed (Issue #940)", () => {
  // The regression that looks like a speed-up: build zero passes, run
  // nothing, report green.
  const [parallel, serial] = passes();
  assertEquals(unitTestStageVerdict([]).status, "FAILED");
  assertEquals(
    unitTestStageVerdict([
      { pass: parallel!, exitCode: 0, durationMs: 1 },
      { pass: serial!, exitCode: null, durationMs: null },
    ]).status,
    "FAILED",
    "a pass that never ran cannot count towards the stage passing",
  );
});
