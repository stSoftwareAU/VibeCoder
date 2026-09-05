/**
 * The gate's unit suite, as two `deno test` passes (Issue #940).
 *
 * One sequential `deno test` took 42+ minutes on a 10-core host against a
 * 45-minute phase budget, so issues died in `quality_gate` having changed
 * nothing wrong (#805 twice, #808). `--parallel` runs the same suite in
 * minutes, but 144 files cannot share a machine: 116 mutate the process
 * environment or working directory and race each other (#880), 40 are bound
 * to a wall-clock reading their own workers beat, and 2 race a real
 * subprocess.
 *
 * So the suite runs twice, over disjoint halves of the same scope:
 *
 * 1. **parallel** — everything except the integration suites (#907) and the
 *    files that cannot share a machine (#880, #940), under `--parallel`.
 * 2. **serial** — exactly those files, no `--parallel`, where mutating the
 *    process environment is safe again and a stopwatch means something.
 *
 * The halves are built from the two manifests rather than written out, so
 * dropping a file from `PARALLEL_UNSAFE_TEST_FILES` moves it from the slow
 * pass to the fast one and nothing else has to change. Both passes exclude
 * `INTEGRATION_TEST_FILES` (#907): every suite that spawns `pwsh` is an
 * integration suite, and CI runs those where the environment is provisioned
 * for them.
 *
 * That exclusion used to be described here as what "keeps the 32 pre-existing
 * pwsh failures out of the verdict". There are no such failures to keep out,
 * and describing the split that way is what made a standing red sound like a
 * property of the gate. #971 re-measured those suites on a host with
 * PowerShell installed and found test-side defects, not a standing failure —
 * chiefly `setup_ps1_test.ts` resolving `pwsh` against the developer's own
 * `PATH` and then spawning it with `clearEnv: true` and
 * `PATH: "/usr/bin:/bin"` — all fixed in #988. The suites are excluded because
 * they need a provisioned environment, never because they are expected to fail.
 *
 * `DENO_JOBS` is bounded to {@link CONTAINER_DENO_JOBS} inside the container
 * and left at Deno's default on the host. The container has a memory ceiling
 * and a SIGKILL history (#4267); an unbounded worker count is how a green
 * suite becomes an OOM. An operator who sets `DENO_JOBS` themselves wins —
 * the bound is a default, not a policy.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import {
  INTEGRATION_TEST_FILES,
  integrationTestIgnoreArg,
} from "./integration_test_manifest.ts";
import {
  PARALLEL_UNSAFE_TEST_FILES,
  parallelUnsafeIgnoreArg,
} from "./parallel_unsafe_test_manifest.ts";

/**
 * Ambient variables the container sets that the Deno suite must not inherit
 * (Issue #891).
 *
 * The container exports
 * `CONFIG_PATH=/home/vibe/.vibe-coder/run-config/.config.json`. Thirty-three
 * tests set their own `CONFIG_FILE` in a temp directory and then die on
 * `setup.sh`'s guard:
 *
 * ```text
 * ERROR: CONFIG_FILE and CONFIG_PATH are both set and name different files
 * ```
 *
 * The guard is right — two different config files named at once is a real
 * misconfiguration — and the tests are right to point at their own fixture.
 * What is wrong is the gate handing the suite an ambient variable that has
 * nothing to do with the change under test, so `deno tests FAILED` reported
 * the container rather than the code. A gate that fails on its own
 * environment teaches everyone to ignore it, which is the real cost.
 *
 * `WORK_DIR` is the same class (Issue #1098). The container exports the live
 * worker volume, and `runCoreLoop` falls back to it for the state a run must
 * keep across restarts — so every suite that drives the loop without naming
 * its own work directory read and wrote the running fleet's
 * `idle_disagreement_streak.json`. Under `--parallel` that is one file shared
 * by four worker processes: the idle-disagreement suites watched their streak
 * reset mid-run by a sibling process and failed, deterministically green on
 * their own, and the operator's real streak state was overwritten with test
 * timestamps. Scrubbed, the loop keeps that state in memory for the life of
 * the test, which is its documented behaviour for a caller with no volume.
 */
const SCRUBBED_TEST_VARS: readonly string[] = ["CONFIG_PATH", "WORK_DIR"];

/**
 * The variable the container image exports and no host run has (#4269).
 *
 * `fleet_health.ts` and `optional_feature_env.ts` already read exactly this
 * to tell the two apart; a third spelling of "am I in the container" would
 * be a third thing to keep in step.
 */
export const CONTAINER_MARKER_VAR = "VIBE_IMAGE_AGENT_PROVIDERS";

/**
 * Parallel workers allowed inside the container.
 *
 * Four is the count the `DENO_JOBS=4` trial recorded in #880 was measured
 * at, and it leaves headroom under the container's memory ceiling. The host,
 * which has neither the ceiling nor the SIGKILL history, keeps Deno's
 * default of one worker per core.
 */
export const CONTAINER_DENO_JOBS = "4";

/** The environment the `deno test` stage runs with. */
export function testStageEnv(
  base: Record<string, string>,
): Record<string, string> {
  const env = { ...base };
  for (const name of SCRUBBED_TEST_VARS) delete env[name];
  return env;
}

/** The permission set both passes run with. */
const TEST_PERMISSION_FLAGS: readonly string[] = [
  "--allow-read",
  "--allow-env",
  "--allow-run",
  "--allow-write",
  "--allow-sys=hostname",
];

/** One `deno test` invocation, ready to spawn. */
export interface UnitTestPass {
  /** Short identifier used in the stage's reported output. */
  label: string;
  /** One line saying what this pass covers, for the operator. */
  description: string;
  /** The full argument vector, `deno` included. */
  args: readonly string[];
  /** The environment this pass runs with. */
  env: Record<string, string>;
}

/** Inputs for {@link unitTestPasses}. */
export interface UnitTestPassOptions {
  /** The resolved `deno` executable. */
  denoCmd: string;
  /** The ambient environment, normally `Deno.env.toObject()`. */
  env: Record<string, string>;
  /**
   * Flags inserted straight after `test`, before the permission set. The
   * `test:unit` task uses this for `--frozen --lock=deno.lock`; the gate
   * passes none.
   */
  extraArgs?: readonly string[];
  /** The manifests, injected so a test can vary them. */
  integrationFiles?: readonly string[];
  parallelUnsafeFiles?: readonly string[];
}

/**
 * The files the serial pass names explicitly.
 *
 * A file can be both a mutator and an integration suite —
 * `container_entrypoint_test.ts` is — and naming it here would run in the
 * gate the very suites #907 took out of it.
 */
export function serialPassFiles(
  parallelUnsafeFiles: readonly string[] = PARALLEL_UNSAFE_TEST_FILES,
  integrationFiles: readonly string[] = INTEGRATION_TEST_FILES,
): readonly string[] {
  const excluded = new Set(integrationFiles);
  return parallelUnsafeFiles.filter((file) => !excluded.has(file));
}

/**
 * The two passes the unit suite runs as, in order.
 *
 * Order matters: the fast pass runs first, so the common failure is reported
 * in minutes rather than after the slow pass has finished.
 */
export function unitTestPasses(
  options: UnitTestPassOptions,
): readonly UnitTestPass[] {
  const integrationFiles = options.integrationFiles ?? INTEGRATION_TEST_FILES;
  const parallelUnsafeFiles = options.parallelUnsafeFiles ??
    PARALLEL_UNSAFE_TEST_FILES;
  const extraArgs = options.extraArgs ?? [];
  const serialFiles = serialPassFiles(parallelUnsafeFiles, integrationFiles);
  const env = testStageEnv(options.env);

  // The gate's own `deno check '**/*.ts'` stage type-checks the whole graph
  // including tests/**, so `deno test` need not build a second full
  // TypeScript program (Issue #4347). In parallel mode both used to start
  // together and miss the shared cache — the memory spike quality.sh blames
  // for the in-container SIGKILLs.
  const common = ["test", ...extraArgs, "--no-check", ...TEST_PERMISSION_FLAGS];

  // Issue #907: the suites that copy the repository's own `.sh`/`.ps1` into
  // a temp tree, stub a PATH and spawn them are integration tests. They cost
  // ~12 of the gate's ~36 minutes and ran on every change, including changes
  // that cannot reach them — #891 was found exactly that way, by a diff
  // touching only `prompts/**`. CI runs them, where sharding absorbs the
  // cost; the worker's gate does not. Both passes exclude them.
  const integrationIgnore = integrationTestIgnoreArg(integrationFiles);

  const parallelIgnore = [
    integrationIgnore,
    parallelUnsafeIgnoreArg(parallelUnsafeFiles),
  ].filter((part) => part.length > 0).join(",");

  const parallelEnv = { ...env };
  // An operator's own DENO_JOBS wins; the bound is only a default.
  if (
    options.env[CONTAINER_MARKER_VAR] !== undefined &&
    parallelEnv.DENO_JOBS === undefined
  ) {
    parallelEnv.DENO_JOBS = CONTAINER_DENO_JOBS;
  }

  return [
    {
      label: "parallel",
      description:
        `every unit test except ${parallelUnsafeFiles.length} that race or ` +
        `measure under --parallel (#880, #940) and ` +
        `${integrationFiles.length} integration suites (#907)`,
      args: [
        options.denoCmd,
        ...common,
        "--parallel",
        ...(parallelIgnore.length > 0 ? [`--ignore=${parallelIgnore}`] : []),
      ],
      env: parallelEnv,
    },
    {
      label: "serial",
      description:
        `${serialFiles.length} tests that mutate shared process state or ` +
        `assert on a real clock, run one at a time`,
      args: [
        options.denoCmd,
        ...common,
        ...(integrationIgnore.length > 0
          ? [`--ignore=${integrationIgnore}`]
          : []),
        ...serialFiles,
      ],
      env,
    },
  ];
}

/** What one pass did. */
export interface UnitTestPassOutcome {
  /** The pass it describes. */
  pass: UnitTestPass;
  /**
   * The pass's exit code, or `null` when it never ran because an earlier
   * pass had already failed.
   */
  exitCode: number | null;
  /** Wall time in milliseconds, or `null` when the pass never ran. */
  durationMs: number | null;
}

/** What the `deno tests` stage reports for the pair. */
export interface UnitTestStageVerdict {
  /** `PASSED` only when every pass ran and every pass exited 0. */
  status: "PASSED" | "FAILED";
  /** The label of the pass that failed, or `null` when none did. */
  failedPass: string | null;
}

/**
 * The stage's verdict over the passes so far.
 *
 * The pair is one check, so the bar for `PASSED` is every pass green — a
 * single invocation could not get this wrong, and two can: a loop that
 * reports the last pass's code, or one that treats a pass that never ran as
 * a pass that passed, both turn a red suite green. An empty list is `FAILED`
 * for the same reason, because a stage that ran nothing has proved nothing.
 */
export function unitTestStageVerdict(
  outcomes: readonly UnitTestPassOutcome[],
): UnitTestStageVerdict {
  const failed = outcomes.find((o) => o.exitCode !== null && o.exitCode !== 0);
  if (failed !== undefined) {
    return { status: "FAILED", failedPass: failed.pass.label };
  }
  const complete = outcomes.length > 0 &&
    outcomes.every((o) => o.exitCode === 0);
  return { status: complete ? "PASSED" : "FAILED", failedPass: null };
}

/** `2m23s`, `41s`, `0.4s` — whichever reads best at that scale. */
export function formatPassDuration(durationMs: number): string {
  const seconds = durationMs / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole}s`;
  return `${Math.floor(whole / 60)}m${String(whole % 60).padStart(2, "0")}s`;
}

/**
 * The per-pass verdict lines.
 *
 * Two invocations reported as one `deno tests FAILED` is worse than one, so
 * every pass gets a line naming itself, its verdict, what it cost and what it
 * covered — including the pass that never ran, which would otherwise look
 * like a pass that passed.
 */
export function summariseUnitTestPasses(
  outcomes: readonly UnitTestPassOutcome[],
): string[] {
  return outcomes.map((outcome) => {
    const label = `Deno tests [${outcome.pass.label}]`;
    if (outcome.exitCode === null) {
      return `${label}: NOT RUN (an earlier pass failed) — ${outcome.pass.description}`;
    }
    const verdict = outcome.exitCode === 0 ? "PASSED" : "FAILED";
    const cost = outcome.durationMs === null
      ? ""
      : ` in ${formatPassDuration(outcome.durationMs)}`;
    return `${label}: ${verdict}${cost} — ${outcome.pass.description}`;
  });
}

/**
 * The third slice of the same partition: the integration suites (Issue #940).
 *
 * `deno task test:integration` carried its own hand-typed list, and it had
 * already drifted — thirteen files where the manifest holds twenty-seven,
 * because #935 added fourteen the task was never updated for. Deriving it
 * from `INTEGRATION_TEST_FILES` removes the second copy rather than
 * correcting it, so the escape hatch and the gate's exclusion cannot disagree
 * about what an integration test is.
 *
 * Serial, like the gate's second pass: several of these spawn scripts that
 * write to shared temp paths.
 */
export function integrationTestPass(
  options: UnitTestPassOptions,
): UnitTestPass {
  const files = options.integrationFiles ?? INTEGRATION_TEST_FILES;
  return {
    label: "integration",
    description:
      `${files.length} suites that copy a repository script into a temp ` +
      `tree and spawn it (#907), run one at a time`,
    args: [
      options.denoCmd,
      "test",
      ...(options.extraArgs ?? []),
      "--no-check",
      ...TEST_PERMISSION_FLAGS,
      ...files,
    ],
    env: testStageEnv(options.env),
  };
}
