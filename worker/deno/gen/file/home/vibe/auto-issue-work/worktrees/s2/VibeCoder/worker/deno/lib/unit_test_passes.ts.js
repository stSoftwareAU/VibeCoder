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
 * `INTEGRATION_TEST_FILES` (#907), which CI runs where the environment is
 * provisioned for them. The three `run.ps1` launcher suites are the named
 * exception (#1598): the image ships PowerShell 7 (#1596), so the gate's own
 * environment provides what they need and `IN_GATE_SCRIPT_SUITES` keeps them
 * in the passes rather than in the exclusion.
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
 * Both passes run with a BUILT environment rather than the worker's own
 * (Issue #1281): the suite is repository-supplied code, so
 * {@link testStageEnv} applies the same allowlist every other
 * repository-controlled spawn gets.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */ import { INTEGRATION_TEST_FILES, integrationTestIgnoreArg } from "./integration_test_manifest.ts";
import { PARALLEL_UNSAFE_TEST_FILES, parallelUnsafeIgnoreArg } from "./parallel_unsafe_test_manifest.ts";
import { buildUntrustedCommandEnv } from "./untrusted_command_env.ts";
import { normaliseTestPath } from "./unit_test_time_budget.ts";
import { CONTAINER_IMAGE_STAMP_ENV, runningInContainerImage } from "./container_stamp.ts";
/**
 * The variable the container image exports and no host run has (#4269).
 *
 * `fleet_health.ts` and `optional_feature_env.ts` already read exactly this
 * to tell the two apart; a third spelling of "am I in the container" would
 * be a third thing to keep in step. So this is an alias for
 * {@linkcode CONTAINER_IMAGE_STAMP_ENV} rather than its own string literal
 * (Issue #1493): the name stays for the callers that import it, the
 * definition lives in `container_stamp.ts`.
 */ export const CONTAINER_MARKER_VAR = CONTAINER_IMAGE_STAMP_ENV;
/**
 * Names the suite genuinely needs beyond `ALLOWED_ENV_NAMES` (Issue #1281).
 *
 * The base allowlist covers finding and running tools — `PATH`, `HOME`,
 * `TMPDIR`, `DENO_DIR`, locale. These are the extras this particular
 * repository-controlled command has a reason for, and every one of them is a
 * switch or a path, never a credential:
 *
 * - `DENO_JOBS` — an operator debugging a race pins the worker count, and the
 *   container bound below is only a default. Dropped, that override would be
 *   silently replaced by the bound.
 * - `VIBE_IMAGE_AGENT_PROVIDERS` is deliberately NOT here (Issue #4328). The
 *   image stamp tells container from host (#4269), and the suite is written to
 *   run as a host run, as CI does. Forwarded from the worker's container, it
 *   makes provider-availability checks throw for providers the test never
 *   asked about ("did not install the codex coding-agent provider"). The
 *   container bound on `DENO_JOBS` is decided from the parent environment
 *   `unitTestPasses` is given, not from this child environment, so withholding
 *   the stamp here does not lift that bound.
 * - The opt-in switches (`RUN_INTEGRATION_TESTS`, `VIBE_PWSH`,
 *   `VIBE_CONTAINMENT_REQUIRED`, `VIBE_CONTAINMENT_IMAGE`,
 *   `VIBE_GHOSTCOMMIT_LIVE_VISION`, `VIBE_GHOSTCOMMIT_VISION_DRIVER`) —
 *   each turns a suite's SKIP into a real run. Dropping them would not fail
 *   the gate; it would quietly shrink it, which is worse.
 * - `XDG_RUNTIME_DIR` — where `container_containment_test.ts` looks for the
 *   rootless Podman socket.
 * - `PATHEXT` — how `tests/support/pwsh.ts` resolves an executable on Windows.
 *
 * Adding a name here is a decision about what repository-supplied test code
 * may read, so keep it short and say why.
 */ export const TEST_STAGE_EXTRA_ENV_NAMES = [
  "DENO_JOBS",
  "RUN_INTEGRATION_TESTS",
  "VIBE_PWSH",
  "VIBE_CONTAINMENT_REQUIRED",
  "VIBE_CONTAINMENT_IMAGE",
  "VIBE_GHOSTCOMMIT_LIVE_VISION",
  "VIBE_GHOSTCOMMIT_VISION_DRIVER",
  "XDG_RUNTIME_DIR",
  "PATHEXT"
];
/**
 * Parallel workers allowed inside the container.
 *
 * Four is the count the `DENO_JOBS=4` trial recorded in #880 was measured
 * at, and it leaves headroom under the container's memory ceiling. The host,
 * which has neither the ceiling nor the SIGKILL history, keeps Deno's
 * default of one worker per core.
 */ export const CONTAINER_DENO_JOBS = "4";
/**
 * The environment the `deno test` stage runs with (Issue #1281).
 *
 * BUILT from an allowlist, never inherited — the same rule
 * `untrusted_command_env.ts` states for every other repository-controlled
 * spawn, and for the same reason. The suite is repository-supplied code: it
 * includes the `*_test.ts` files the coding agent added or edited during this
 * run, and the gate runs it before the work is pushed. Handed the worker's
 * whole environment it could read `GH_TOKEN`, the provider credentials
 * `credential_preflight.ts` exports into the process, and the worker-only
 * secrets `agent_env.ts` denies to every agent child by name.
 *
 * This replaced a two-name denylist (`CONFIG_PATH`, `WORK_DIR`) that scrubbed
 * no credential at all. Those two are still absent — nothing puts them on the
 * allowlist — so the reasons they were dropped in the first place still hold:
 *
 * - `CONFIG_PATH` (#891): the container exports
 *   `/home/vibe/.vibe-coder/run-config/.config.json`, thirty-three tests point
 *   `CONFIG_FILE` at their own fixture in a temp directory, and `setup.sh`'s
 *   guard — rightly — fails them all on `CONFIG_FILE and CONFIG_PATH are both
 *   set and name different files`. A gate that fails on its own container
 *   teaches everyone to re-run rather than read.
 * - `WORK_DIR` (#1098): the container exports the live worker volume, and
 *   production surfaces still read it (`audit_journal.ts`,
 *   `agent_mcp_config.ts`, `deepseek_env.ts`). The gate has no business
 *   handing the running fleet's state directory to four parallel test workers.
 *
 * The allowlist covers both without naming either, and covers the next
 * credential nobody has added yet — which a denylist cannot.
 */ export function testStageEnv(base) {
  return buildUntrustedCommandEnv({
    source: base,
    extraNames: TEST_STAGE_EXTRA_ENV_NAMES
  });
}
/** The permission set both passes run with. */ const TEST_PERMISSION_FLAGS = [
  "--allow-read",
  "--allow-env",
  "--allow-run",
  "--allow-write",
  "--allow-sys=hostname"
];
/**
 * The reporter both passes run with (Issue #2430).
 *
 * `deno test --reporter` takes one of `pretty`, `dot`, `junit`, `tap`. None
 * is silent on a green run, but `dot` is the quietest — one character per
 * test against `pretty`'s line per test — and it is the only quiet one that
 * keeps a failure intact.
 */ export const TEST_REPORTER_FLAG = "--reporter=dot";
/**
 * The stage transcript one finished pass contributes.
 *
 * Nothing when the pass passed or never ran: `dot` still prints a dot per
 * test and an `ok | N passed` line, and {@link summariseUnitTestPasses}
 * already reports the pass's verdict and cost. Everything when it failed —
 * the failing test's name, its assertion message and its stack trace all
 * belong in front of the reader.
 */ export function unitTestPassTranscript(label, exitCode, output) {
  if (exitCode === 0 || exitCode === null) return [];
  return [
    `=== deno tests: ${label} pass ===`,
    output
  ];
}
/** The JUnit report path and flag for one pass, when a directory is given. */ function junitFor(junitDir, label) {
  if (junitDir === undefined) return {
    flag: [],
    field: {}
  };
  const junitPath = `${junitDir}/${label}.xml`;
  return {
    flag: [
      `--junit-path=${junitPath}`
    ],
    field: {
      junitPath
    }
  };
}
/**
 * The files the serial pass names explicitly.
 *
 * A file can be both a mutator and an integration suite —
 * `container_entrypoint_test.ts` is — and naming it here would run in the
 * gate the very suites #907 took out of it.
 */ export function serialPassFiles(parallelUnsafeFiles = PARALLEL_UNSAFE_TEST_FILES, integrationFiles = INTEGRATION_TEST_FILES) {
  const excluded = new Set(integrationFiles);
  return parallelUnsafeFiles.filter((file)=>!excluded.has(file));
}
/**
 * `test`, the caller's extra flags, and the flags every pass shares.
 */ function commonTestArgs(extraArgs) {
  // The gate's own `deno check '**/*.ts'` stage type-checks the whole graph
  // including tests/**, so `deno test` need not build a second full
  // TypeScript program (Issue #4347). In parallel mode both used to start
  // together and miss the shared cache — the memory spike quality.sh blames
  // for the in-container SIGKILLs.
  // Issue #2430: the gate's output is quoted back into prompts, and `pretty`
  // spends ~23,000 lines saying that a test passed. `dot` is the quietest
  // reporter `deno test` accepts that still prints a failure in full — name,
  // assertion message, diff and stack trace. It follows the permission set so
  // `extraArgs` keep the position `test:unit` expects.
  return [
    "test",
    ...extraArgs,
    "--no-check",
    ...TEST_PERMISSION_FLAGS,
    TEST_REPORTER_FLAG
  ];
}
/** The parallel pass's environment: the container bounds `DENO_JOBS`. */ function parallelPassEnv(options, env) {
  const parallelEnv = {
    ...env
  };
  // An operator's own DENO_JOBS wins; the bound is only a default.
  if (runningInContainerImage((name)=>options.env[name]) && parallelEnv.DENO_JOBS === undefined) {
    parallelEnv.DENO_JOBS = CONTAINER_DENO_JOBS;
  }
  return parallelEnv;
}
/**
 * The two passes the unit suite runs as, in order.
 *
 * Order matters: the fast pass runs first, so the common failure is reported
 * in minutes rather than after the slow pass has finished.
 */ export function unitTestPasses(options) {
  const integrationFiles = options.integrationFiles ?? INTEGRATION_TEST_FILES;
  const parallelUnsafeFiles = options.parallelUnsafeFiles ?? PARALLEL_UNSAFE_TEST_FILES;
  const extraArgs = options.extraArgs ?? [];
  const serialFiles = serialPassFiles(parallelUnsafeFiles, integrationFiles);
  const env = testStageEnv(options.env);
  const common = commonTestArgs(extraArgs);
  // Issue #907: the suites that copy the repository's own `.sh`/`.ps1` into
  // a temp tree, stub a PATH and spawn them are integration tests. They cost
  // ~12 of the gate's ~36 minutes and ran on every change, including changes
  // that cannot reach them — #891 was found exactly that way, by a diff
  // touching only `prompts/**`. CI runs them, where sharding absorbs the
  // cost; the worker's gate does not. Both passes exclude them — except the
  // `run.ps1` launcher suites, which the manifest keeps out of this list
  // because the image provisions their interpreter (#1596, #1598).
  const integrationIgnore = integrationTestIgnoreArg(integrationFiles);
  const parallelIgnore = [
    integrationIgnore,
    parallelUnsafeIgnoreArg(parallelUnsafeFiles)
  ].filter((part)=>part.length > 0).join(",");
  const parallelEnv = parallelPassEnv(options, env);
  const parallelJunit = junitFor(options.junitDir, "parallel");
  const serialJunit = junitFor(options.junitDir, "serial");
  return [
    {
      label: "parallel",
      description: `every unit test except ${parallelUnsafeFiles.length} that race or ` + `measure under --parallel (#880, #940) and ` + `${integrationFiles.length} integration suites (#907)`,
      args: [
        options.denoCmd,
        ...common,
        ...parallelJunit.flag,
        "--parallel",
        ...parallelIgnore.length > 0 ? [
          `--ignore=${parallelIgnore}`
        ] : []
      ],
      env: parallelEnv,
      ...parallelJunit.field
    },
    {
      label: "serial",
      description: `${serialFiles.length} tests that mutate shared process state or ` + `assert on a real clock, run one at a time`,
      args: [
        options.denoCmd,
        ...common,
        ...serialJunit.flag,
        ...integrationIgnore.length > 0 ? [
          `--ignore=${integrationIgnore}`
        ] : [],
        ...serialFiles
      ],
      env,
      ...serialJunit.field
    }
  ];
}
/**
 * The unit passes over a hand-picked list of test files (Issue #2642).
 *
 * An agent that runs `deno test` over every file its grep matched also runs
 * the integration suites the gate deliberately excludes — the launcher suites
 * alone cost minutes. This intersects the list with the unit scope: an
 * integration suite is left out and named, a parallel-unsafe file runs in the
 * serial pass, and everything else runs under `--parallel`, exactly as the
 * gate would run it.
 */ export function targetedUnitTestPasses(options, files) {
  const integrationFiles = options.integrationFiles ?? INTEGRATION_TEST_FILES;
  const integration = new Set(integrationFiles);
  const serialSet = new Set(serialPassFiles(options.parallelUnsafeFiles ?? PARALLEL_UNSAFE_TEST_FILES, integrationFiles));
  const requested = [
    ...new Set(files.map(normaliseTestPath))
  ];
  const skippedIntegration = requested.filter((f)=>integration.has(f));
  const unit = requested.filter((f)=>!integration.has(f));
  const serial = unit.filter((f)=>serialSet.has(f));
  const parallel = unit.filter((f)=>!serialSet.has(f));
  const common = commonTestArgs(options.extraArgs ?? []);
  const env = testStageEnv(options.env);
  const passes = [];
  if (parallel.length > 0) {
    const junit = junitFor(options.junitDir, "parallel");
    passes.push({
      label: "parallel",
      description: `${parallel.length} requested parallel-safe unit test file(s)`,
      args: [
        options.denoCmd,
        ...common,
        ...junit.flag,
        "--parallel",
        ...parallel
      ],
      env: parallelPassEnv(options, env),
      ...junit.field
    });
  }
  if (serial.length > 0) {
    const junit = junitFor(options.junitDir, "serial");
    passes.push({
      label: "serial",
      description: `${serial.length} requested parallel-unsafe unit test file(s)`,
      args: [
        options.denoCmd,
        ...common,
        ...junit.flag,
        ...serial
      ],
      env,
      ...junit.field
    });
  }
  return {
    passes,
    skippedIntegration
  };
}
/**
 * The stage's verdict over the passes so far.
 *
 * The pair is one check, so the bar for `PASSED` is every pass green — a
 * single invocation could not get this wrong, and two can: a loop that
 * reports the last pass's code, or one that treats a pass that never ran as
 * a pass that passed, both turn a red suite green. An empty list is `FAILED`
 * for the same reason, because a stage that ran nothing has proved nothing.
 */ export function unitTestStageVerdict(outcomes) {
  const failed = outcomes.find((o)=>o.exitCode !== null && o.exitCode !== 0);
  if (failed !== undefined) {
    return {
      status: "FAILED",
      failedPass: failed.pass.label
    };
  }
  const complete = outcomes.length > 0 && outcomes.every((o)=>o.exitCode === 0);
  return {
    status: complete ? "PASSED" : "FAILED",
    failedPass: null
  };
}
/** `2m23s`, `41s`, `0.4s` — whichever reads best at that scale. */ export function formatPassDuration(durationMs) {
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
 */ export function summariseUnitTestPasses(outcomes) {
  return outcomes.map((outcome)=>{
    const label = `Deno tests [${outcome.pass.label}]`;
    if (outcome.exitCode === null) {
      return `${label}: NOT RUN (an earlier pass failed) — ${outcome.pass.description}`;
    }
    const verdict = outcome.exitCode === 0 ? "PASSED" : "FAILED";
    const cost = outcome.durationMs === null ? "" : ` in ${formatPassDuration(outcome.durationMs)}`;
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
 */ export function integrationTestPass(options) {
  const files = options.integrationFiles ?? INTEGRATION_TEST_FILES;
  return {
    label: "integration",
    description: `${files.length} suites that copy a repository script into a temp ` + `tree and spawn it (#907), run one at a time`,
    args: [
      options.denoCmd,
      "test",
      ...options.extraArgs ?? [],
      "--no-check",
      ...TEST_PERMISSION_FLAGS,
      ...files
    ],
    env: testStageEnv(options.env)
  };
}
/**
 * One CI shard's share of `files` (PR #1170).
 *
 * The stride split — every `count`-th file from a sorted list — is what
 * `.github/scripts/deno-test-shard.sh` has always used, and it is kept
 * because it is deterministic and needs no state: shard `index` on any
 * machine, at any time, picks the same files. Sorting first is what makes
 * that true, so it is done here rather than trusted to the caller.
 */ export function shardTestFiles(files, index, count) {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`shard count must be a positive integer, got ${count}`);
  }
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error(`shard index must be 0..${count - 1}, got ${index}`);
  }
  return [
    ...files
  ].sort().filter((_, i)=>i % count === index);
}
/**
 * The CI shard's passes, built from the same manifests as `test:unit`.
 *
 * CI used to run `find tests -maxdepth 1 -name '*_test.ts'` and hand the
 * whole sorted list to one `deno test`, so the gate that decides a merge and
 * the gate a developer runs before pushing were two different suites over two
 * different scopes. The merge gate carried the 27 integration suites #907
 * took out of the unit suite — which is why every shard job had to install
 * `pwsh` before it could start — and it ran the {@link PARALLEL_UNSAFE_TEST_FILES}
 * in the same invocation as everything else, so the split those files exist
 * for was only ever honoured on a developer's machine.
 *
 * The partition here is {@link unitTestPasses}' partition, taken from the
 * manifests rather than restated: parallel-safe unit tests, then
 * {@link serialPassFiles}, with the integration suites excluded from both and
 * reported so the exclusion is visible. Sharding is applied inside each pass
 * so the two stay balanced across the matrix independently — a shard that
 * drew every serial file would be the slowest job by minutes.
 */ export function testShardPlan(options) {
  const integrationFiles = options.integrationFiles ?? INTEGRATION_TEST_FILES;
  const parallelUnsafeFiles = options.parallelUnsafeFiles ?? PARALLEL_UNSAFE_TEST_FILES;
  const integration = new Set(integrationFiles);
  const serial = new Set(serialPassFiles(parallelUnsafeFiles, integrationFiles));
  const known = [
    ...options.testFiles
  ].sort();
  return {
    parallel: shardTestFiles(known.filter((file)=>!integration.has(file) && !serial.has(file)), options.index, options.count),
    serial: shardTestFiles(known.filter((file)=>serial.has(file)), options.index, options.count),
    integration: known.filter((file)=>integration.has(file))
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi91bml0X3Rlc3RfcGFzc2VzLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogVGhlIGdhdGUncyB1bml0IHN1aXRlLCBhcyB0d28gYGRlbm8gdGVzdGAgcGFzc2VzIChJc3N1ZSAjOTQwKS5cbiAqXG4gKiBPbmUgc2VxdWVudGlhbCBgZGVubyB0ZXN0YCB0b29rIDQyKyBtaW51dGVzIG9uIGEgMTAtY29yZSBob3N0IGFnYWluc3QgYVxuICogNDUtbWludXRlIHBoYXNlIGJ1ZGdldCwgc28gaXNzdWVzIGRpZWQgaW4gYHF1YWxpdHlfZ2F0ZWAgaGF2aW5nIGNoYW5nZWRcbiAqIG5vdGhpbmcgd3JvbmcgKCM4MDUgdHdpY2UsICM4MDgpLiBgLS1wYXJhbGxlbGAgcnVucyB0aGUgc2FtZSBzdWl0ZSBpblxuICogbWludXRlcywgYnV0IDE0NCBmaWxlcyBjYW5ub3Qgc2hhcmUgYSBtYWNoaW5lOiAxMTYgbXV0YXRlIHRoZSBwcm9jZXNzXG4gKiBlbnZpcm9ubWVudCBvciB3b3JraW5nIGRpcmVjdG9yeSBhbmQgcmFjZSBlYWNoIG90aGVyICgjODgwKSwgNDAgYXJlIGJvdW5kXG4gKiB0byBhIHdhbGwtY2xvY2sgcmVhZGluZyB0aGVpciBvd24gd29ya2VycyBiZWF0LCBhbmQgMiByYWNlIGEgcmVhbFxuICogc3VicHJvY2Vzcy5cbiAqXG4gKiBTbyB0aGUgc3VpdGUgcnVucyB0d2ljZSwgb3ZlciBkaXNqb2ludCBoYWx2ZXMgb2YgdGhlIHNhbWUgc2NvcGU6XG4gKlxuICogMS4gKipwYXJhbGxlbCoqIOKAlCBldmVyeXRoaW5nIGV4Y2VwdCB0aGUgaW50ZWdyYXRpb24gc3VpdGVzICgjOTA3KSBhbmQgdGhlXG4gKiAgICBmaWxlcyB0aGF0IGNhbm5vdCBzaGFyZSBhIG1hY2hpbmUgKCM4ODAsICM5NDApLCB1bmRlciBgLS1wYXJhbGxlbGAuXG4gKiAyLiAqKnNlcmlhbCoqIOKAlCBleGFjdGx5IHRob3NlIGZpbGVzLCBubyBgLS1wYXJhbGxlbGAsIHdoZXJlIG11dGF0aW5nIHRoZVxuICogICAgcHJvY2VzcyBlbnZpcm9ubWVudCBpcyBzYWZlIGFnYWluIGFuZCBhIHN0b3B3YXRjaCBtZWFucyBzb21ldGhpbmcuXG4gKlxuICogVGhlIGhhbHZlcyBhcmUgYnVpbHQgZnJvbSB0aGUgdHdvIG1hbmlmZXN0cyByYXRoZXIgdGhhbiB3cml0dGVuIG91dCwgc29cbiAqIGRyb3BwaW5nIGEgZmlsZSBmcm9tIGBQQVJBTExFTF9VTlNBRkVfVEVTVF9GSUxFU2AgbW92ZXMgaXQgZnJvbSB0aGUgc2xvd1xuICogcGFzcyB0byB0aGUgZmFzdCBvbmUgYW5kIG5vdGhpbmcgZWxzZSBoYXMgdG8gY2hhbmdlLiBCb3RoIHBhc3NlcyBleGNsdWRlXG4gKiBgSU5URUdSQVRJT05fVEVTVF9GSUxFU2AgKCM5MDcpLCB3aGljaCBDSSBydW5zIHdoZXJlIHRoZSBlbnZpcm9ubWVudCBpc1xuICogcHJvdmlzaW9uZWQgZm9yIHRoZW0uIFRoZSB0aHJlZSBgcnVuLnBzMWAgbGF1bmNoZXIgc3VpdGVzIGFyZSB0aGUgbmFtZWRcbiAqIGV4Y2VwdGlvbiAoIzE1OTgpOiB0aGUgaW1hZ2Ugc2hpcHMgUG93ZXJTaGVsbCA3ICgjMTU5NiksIHNvIHRoZSBnYXRlJ3Mgb3duXG4gKiBlbnZpcm9ubWVudCBwcm92aWRlcyB3aGF0IHRoZXkgbmVlZCBhbmQgYElOX0dBVEVfU0NSSVBUX1NVSVRFU2Aga2VlcHMgdGhlbVxuICogaW4gdGhlIHBhc3NlcyByYXRoZXIgdGhhbiBpbiB0aGUgZXhjbHVzaW9uLlxuICpcbiAqIFRoYXQgZXhjbHVzaW9uIHVzZWQgdG8gYmUgZGVzY3JpYmVkIGhlcmUgYXMgd2hhdCBcImtlZXBzIHRoZSAzMiBwcmUtZXhpc3RpbmdcbiAqIHB3c2ggZmFpbHVyZXMgb3V0IG9mIHRoZSB2ZXJkaWN0XCIuIFRoZXJlIGFyZSBubyBzdWNoIGZhaWx1cmVzIHRvIGtlZXAgb3V0LFxuICogYW5kIGRlc2NyaWJpbmcgdGhlIHNwbGl0IHRoYXQgd2F5IGlzIHdoYXQgbWFkZSBhIHN0YW5kaW5nIHJlZCBzb3VuZCBsaWtlIGFcbiAqIHByb3BlcnR5IG9mIHRoZSBnYXRlLiAjOTcxIHJlLW1lYXN1cmVkIHRob3NlIHN1aXRlcyBvbiBhIGhvc3Qgd2l0aFxuICogUG93ZXJTaGVsbCBpbnN0YWxsZWQgYW5kIGZvdW5kIHRlc3Qtc2lkZSBkZWZlY3RzLCBub3QgYSBzdGFuZGluZyBmYWlsdXJlIOKAlFxuICogY2hpZWZseSBgc2V0dXBfcHMxX3Rlc3QudHNgIHJlc29sdmluZyBgcHdzaGAgYWdhaW5zdCB0aGUgZGV2ZWxvcGVyJ3Mgb3duXG4gKiBgUEFUSGAgYW5kIHRoZW4gc3Bhd25pbmcgaXQgd2l0aCBgY2xlYXJFbnY6IHRydWVgIGFuZFxuICogYFBBVEg6IFwiL3Vzci9iaW46L2JpblwiYCDigJQgYWxsIGZpeGVkIGluICM5ODguIFRoZSBzdWl0ZXMgYXJlIGV4Y2x1ZGVkIGJlY2F1c2VcbiAqIHRoZXkgbmVlZCBhIHByb3Zpc2lvbmVkIGVudmlyb25tZW50LCBuZXZlciBiZWNhdXNlIHRoZXkgYXJlIGV4cGVjdGVkIHRvIGZhaWwuXG4gKlxuICogYERFTk9fSk9CU2AgaXMgYm91bmRlZCB0byB7QGxpbmsgQ09OVEFJTkVSX0RFTk9fSk9CU30gaW5zaWRlIHRoZSBjb250YWluZXJcbiAqIGFuZCBsZWZ0IGF0IERlbm8ncyBkZWZhdWx0IG9uIHRoZSBob3N0LiBUaGUgY29udGFpbmVyIGhhcyBhIG1lbW9yeSBjZWlsaW5nXG4gKiBhbmQgYSBTSUdLSUxMIGhpc3RvcnkgKCM0MjY3KTsgYW4gdW5ib3VuZGVkIHdvcmtlciBjb3VudCBpcyBob3cgYSBncmVlblxuICogc3VpdGUgYmVjb21lcyBhbiBPT00uIEFuIG9wZXJhdG9yIHdobyBzZXRzIGBERU5PX0pPQlNgIHRoZW1zZWx2ZXMgd2lucyDigJRcbiAqIHRoZSBib3VuZCBpcyBhIGRlZmF1bHQsIG5vdCBhIHBvbGljeS5cbiAqXG4gKiBCb3RoIHBhc3NlcyBydW4gd2l0aCBhIEJVSUxUIGVudmlyb25tZW50IHJhdGhlciB0aGFuIHRoZSB3b3JrZXIncyBvd25cbiAqIChJc3N1ZSAjMTI4MSk6IHRoZSBzdWl0ZSBpcyByZXBvc2l0b3J5LXN1cHBsaWVkIGNvZGUsIHNvXG4gKiB7QGxpbmsgdGVzdFN0YWdlRW52fSBhcHBsaWVzIHRoZSBzYW1lIGFsbG93bGlzdCBldmVyeSBvdGhlclxuICogcmVwb3NpdG9yeS1jb250cm9sbGVkIHNwYXduIGdldHMuXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggc3BlbGxpbmcgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pXG4gKi9cblxuaW1wb3J0IHtcbiAgSU5URUdSQVRJT05fVEVTVF9GSUxFUyxcbiAgaW50ZWdyYXRpb25UZXN0SWdub3JlQXJnLFxufSBmcm9tIFwiLi9pbnRlZ3JhdGlvbl90ZXN0X21hbmlmZXN0LnRzXCI7XG5pbXBvcnQge1xuICBQQVJBTExFTF9VTlNBRkVfVEVTVF9GSUxFUyxcbiAgcGFyYWxsZWxVbnNhZmVJZ25vcmVBcmcsXG59IGZyb20gXCIuL3BhcmFsbGVsX3Vuc2FmZV90ZXN0X21hbmlmZXN0LnRzXCI7XG5pbXBvcnQgeyBidWlsZFVudHJ1c3RlZENvbW1hbmRFbnYgfSBmcm9tIFwiLi91bnRydXN0ZWRfY29tbWFuZF9lbnYudHNcIjtcbmltcG9ydCB7IG5vcm1hbGlzZVRlc3RQYXRoIH0gZnJvbSBcIi4vdW5pdF90ZXN0X3RpbWVfYnVkZ2V0LnRzXCI7XG5pbXBvcnQge1xuICBDT05UQUlORVJfSU1BR0VfU1RBTVBfRU5WLFxuICBydW5uaW5nSW5Db250YWluZXJJbWFnZSxcbn0gZnJvbSBcIi4vY29udGFpbmVyX3N0YW1wLnRzXCI7XG5cbi8qKlxuICogVGhlIHZhcmlhYmxlIHRoZSBjb250YWluZXIgaW1hZ2UgZXhwb3J0cyBhbmQgbm8gaG9zdCBydW4gaGFzICgjNDI2OSkuXG4gKlxuICogYGZsZWV0X2hlYWx0aC50c2AgYW5kIGBvcHRpb25hbF9mZWF0dXJlX2Vudi50c2AgYWxyZWFkeSByZWFkIGV4YWN0bHkgdGhpc1xuICogdG8gdGVsbCB0aGUgdHdvIGFwYXJ0OyBhIHRoaXJkIHNwZWxsaW5nIG9mIFwiYW0gSSBpbiB0aGUgY29udGFpbmVyXCIgd291bGRcbiAqIGJlIGEgdGhpcmQgdGhpbmcgdG8ga2VlcCBpbiBzdGVwLiBTbyB0aGlzIGlzIGFuIGFsaWFzIGZvclxuICoge0BsaW5rY29kZSBDT05UQUlORVJfSU1BR0VfU1RBTVBfRU5WfSByYXRoZXIgdGhhbiBpdHMgb3duIHN0cmluZyBsaXRlcmFsXG4gKiAoSXNzdWUgIzE0OTMpOiB0aGUgbmFtZSBzdGF5cyBmb3IgdGhlIGNhbGxlcnMgdGhhdCBpbXBvcnQgaXQsIHRoZVxuICogZGVmaW5pdGlvbiBsaXZlcyBpbiBgY29udGFpbmVyX3N0YW1wLnRzYC5cbiAqL1xuZXhwb3J0IGNvbnN0IENPTlRBSU5FUl9NQVJLRVJfVkFSID0gQ09OVEFJTkVSX0lNQUdFX1NUQU1QX0VOVjtcblxuLyoqXG4gKiBOYW1lcyB0aGUgc3VpdGUgZ2VudWluZWx5IG5lZWRzIGJleW9uZCBgQUxMT1dFRF9FTlZfTkFNRVNgIChJc3N1ZSAjMTI4MSkuXG4gKlxuICogVGhlIGJhc2UgYWxsb3dsaXN0IGNvdmVycyBmaW5kaW5nIGFuZCBydW5uaW5nIHRvb2xzIOKAlCBgUEFUSGAsIGBIT01FYCxcbiAqIGBUTVBESVJgLCBgREVOT19ESVJgLCBsb2NhbGUuIFRoZXNlIGFyZSB0aGUgZXh0cmFzIHRoaXMgcGFydGljdWxhclxuICogcmVwb3NpdG9yeS1jb250cm9sbGVkIGNvbW1hbmQgaGFzIGEgcmVhc29uIGZvciwgYW5kIGV2ZXJ5IG9uZSBvZiB0aGVtIGlzIGFcbiAqIHN3aXRjaCBvciBhIHBhdGgsIG5ldmVyIGEgY3JlZGVudGlhbDpcbiAqXG4gKiAtIGBERU5PX0pPQlNgIOKAlCBhbiBvcGVyYXRvciBkZWJ1Z2dpbmcgYSByYWNlIHBpbnMgdGhlIHdvcmtlciBjb3VudCwgYW5kIHRoZVxuICogICBjb250YWluZXIgYm91bmQgYmVsb3cgaXMgb25seSBhIGRlZmF1bHQuIERyb3BwZWQsIHRoYXQgb3ZlcnJpZGUgd291bGQgYmVcbiAqICAgc2lsZW50bHkgcmVwbGFjZWQgYnkgdGhlIGJvdW5kLlxuICogLSBgVklCRV9JTUFHRV9BR0VOVF9QUk9WSURFUlNgIGlzIGRlbGliZXJhdGVseSBOT1QgaGVyZSAoSXNzdWUgIzQzMjgpLiBUaGVcbiAqICAgaW1hZ2Ugc3RhbXAgdGVsbHMgY29udGFpbmVyIGZyb20gaG9zdCAoIzQyNjkpLCBhbmQgdGhlIHN1aXRlIGlzIHdyaXR0ZW4gdG9cbiAqICAgcnVuIGFzIGEgaG9zdCBydW4sIGFzIENJIGRvZXMuIEZvcndhcmRlZCBmcm9tIHRoZSB3b3JrZXIncyBjb250YWluZXIsIGl0XG4gKiAgIG1ha2VzIHByb3ZpZGVyLWF2YWlsYWJpbGl0eSBjaGVja3MgdGhyb3cgZm9yIHByb3ZpZGVycyB0aGUgdGVzdCBuZXZlclxuICogICBhc2tlZCBhYm91dCAoXCJkaWQgbm90IGluc3RhbGwgdGhlIGNvZGV4IGNvZGluZy1hZ2VudCBwcm92aWRlclwiKS4gVGhlXG4gKiAgIGNvbnRhaW5lciBib3VuZCBvbiBgREVOT19KT0JTYCBpcyBkZWNpZGVkIGZyb20gdGhlIHBhcmVudCBlbnZpcm9ubWVudFxuICogICBgdW5pdFRlc3RQYXNzZXNgIGlzIGdpdmVuLCBub3QgZnJvbSB0aGlzIGNoaWxkIGVudmlyb25tZW50LCBzbyB3aXRoaG9sZGluZ1xuICogICB0aGUgc3RhbXAgaGVyZSBkb2VzIG5vdCBsaWZ0IHRoYXQgYm91bmQuXG4gKiAtIFRoZSBvcHQtaW4gc3dpdGNoZXMgKGBSVU5fSU5URUdSQVRJT05fVEVTVFNgLCBgVklCRV9QV1NIYCxcbiAqICAgYFZJQkVfQ09OVEFJTk1FTlRfUkVRVUlSRURgLCBgVklCRV9DT05UQUlOTUVOVF9JTUFHRWAsXG4gKiAgIGBWSUJFX0dIT1NUQ09NTUlUX0xJVkVfVklTSU9OYCwgYFZJQkVfR0hPU1RDT01NSVRfVklTSU9OX0RSSVZFUmApIOKAlFxuICogICBlYWNoIHR1cm5zIGEgc3VpdGUncyBTS0lQIGludG8gYSByZWFsIHJ1bi4gRHJvcHBpbmcgdGhlbSB3b3VsZCBub3QgZmFpbFxuICogICB0aGUgZ2F0ZTsgaXQgd291bGQgcXVpZXRseSBzaHJpbmsgaXQsIHdoaWNoIGlzIHdvcnNlLlxuICogLSBgWERHX1JVTlRJTUVfRElSYCDigJQgd2hlcmUgYGNvbnRhaW5lcl9jb250YWlubWVudF90ZXN0LnRzYCBsb29rcyBmb3IgdGhlXG4gKiAgIHJvb3RsZXNzIFBvZG1hbiBzb2NrZXQuXG4gKiAtIGBQQVRIRVhUYCDigJQgaG93IGB0ZXN0cy9zdXBwb3J0L3B3c2gudHNgIHJlc29sdmVzIGFuIGV4ZWN1dGFibGUgb24gV2luZG93cy5cbiAqXG4gKiBBZGRpbmcgYSBuYW1lIGhlcmUgaXMgYSBkZWNpc2lvbiBhYm91dCB3aGF0IHJlcG9zaXRvcnktc3VwcGxpZWQgdGVzdCBjb2RlXG4gKiBtYXkgcmVhZCwgc28ga2VlcCBpdCBzaG9ydCBhbmQgc2F5IHdoeS5cbiAqL1xuZXhwb3J0IGNvbnN0IFRFU1RfU1RBR0VfRVhUUkFfRU5WX05BTUVTOiByZWFkb25seSBzdHJpbmdbXSA9IFtcbiAgXCJERU5PX0pPQlNcIixcbiAgXCJSVU5fSU5URUdSQVRJT05fVEVTVFNcIixcbiAgXCJWSUJFX1BXU0hcIixcbiAgXCJWSUJFX0NPTlRBSU5NRU5UX1JFUVVJUkVEXCIsXG4gIFwiVklCRV9DT05UQUlOTUVOVF9JTUFHRVwiLFxuICBcIlZJQkVfR0hPU1RDT01NSVRfTElWRV9WSVNJT05cIixcbiAgXCJWSUJFX0dIT1NUQ09NTUlUX1ZJU0lPTl9EUklWRVJcIixcbiAgXCJYREdfUlVOVElNRV9ESVJcIixcbiAgXCJQQVRIRVhUXCIsXG5dO1xuXG4vKipcbiAqIFBhcmFsbGVsIHdvcmtlcnMgYWxsb3dlZCBpbnNpZGUgdGhlIGNvbnRhaW5lci5cbiAqXG4gKiBGb3VyIGlzIHRoZSBjb3VudCB0aGUgYERFTk9fSk9CUz00YCB0cmlhbCByZWNvcmRlZCBpbiAjODgwIHdhcyBtZWFzdXJlZFxuICogYXQsIGFuZCBpdCBsZWF2ZXMgaGVhZHJvb20gdW5kZXIgdGhlIGNvbnRhaW5lcidzIG1lbW9yeSBjZWlsaW5nLiBUaGUgaG9zdCxcbiAqIHdoaWNoIGhhcyBuZWl0aGVyIHRoZSBjZWlsaW5nIG5vciB0aGUgU0lHS0lMTCBoaXN0b3J5LCBrZWVwcyBEZW5vJ3NcbiAqIGRlZmF1bHQgb2Ygb25lIHdvcmtlciBwZXIgY29yZS5cbiAqL1xuZXhwb3J0IGNvbnN0IENPTlRBSU5FUl9ERU5PX0pPQlMgPSBcIjRcIjtcblxuLyoqXG4gKiBUaGUgZW52aXJvbm1lbnQgdGhlIGBkZW5vIHRlc3RgIHN0YWdlIHJ1bnMgd2l0aCAoSXNzdWUgIzEyODEpLlxuICpcbiAqIEJVSUxUIGZyb20gYW4gYWxsb3dsaXN0LCBuZXZlciBpbmhlcml0ZWQg4oCUIHRoZSBzYW1lIHJ1bGVcbiAqIGB1bnRydXN0ZWRfY29tbWFuZF9lbnYudHNgIHN0YXRlcyBmb3IgZXZlcnkgb3RoZXIgcmVwb3NpdG9yeS1jb250cm9sbGVkXG4gKiBzcGF3biwgYW5kIGZvciB0aGUgc2FtZSByZWFzb24uIFRoZSBzdWl0ZSBpcyByZXBvc2l0b3J5LXN1cHBsaWVkIGNvZGU6IGl0XG4gKiBpbmNsdWRlcyB0aGUgYCpfdGVzdC50c2AgZmlsZXMgdGhlIGNvZGluZyBhZ2VudCBhZGRlZCBvciBlZGl0ZWQgZHVyaW5nIHRoaXNcbiAqIHJ1biwgYW5kIHRoZSBnYXRlIHJ1bnMgaXQgYmVmb3JlIHRoZSB3b3JrIGlzIHB1c2hlZC4gSGFuZGVkIHRoZSB3b3JrZXInc1xuICogd2hvbGUgZW52aXJvbm1lbnQgaXQgY291bGQgcmVhZCBgR0hfVE9LRU5gLCB0aGUgcHJvdmlkZXIgY3JlZGVudGlhbHNcbiAqIGBjcmVkZW50aWFsX3ByZWZsaWdodC50c2AgZXhwb3J0cyBpbnRvIHRoZSBwcm9jZXNzLCBhbmQgdGhlIHdvcmtlci1vbmx5XG4gKiBzZWNyZXRzIGBhZ2VudF9lbnYudHNgIGRlbmllcyB0byBldmVyeSBhZ2VudCBjaGlsZCBieSBuYW1lLlxuICpcbiAqIFRoaXMgcmVwbGFjZWQgYSB0d28tbmFtZSBkZW55bGlzdCAoYENPTkZJR19QQVRIYCwgYFdPUktfRElSYCkgdGhhdCBzY3J1YmJlZFxuICogbm8gY3JlZGVudGlhbCBhdCBhbGwuIFRob3NlIHR3byBhcmUgc3RpbGwgYWJzZW50IOKAlCBub3RoaW5nIHB1dHMgdGhlbSBvbiB0aGVcbiAqIGFsbG93bGlzdCDigJQgc28gdGhlIHJlYXNvbnMgdGhleSB3ZXJlIGRyb3BwZWQgaW4gdGhlIGZpcnN0IHBsYWNlIHN0aWxsIGhvbGQ6XG4gKlxuICogLSBgQ09ORklHX1BBVEhgICgjODkxKTogdGhlIGNvbnRhaW5lciBleHBvcnRzXG4gKiAgIGAvaG9tZS92aWJlLy52aWJlLWNvZGVyL3J1bi1jb25maWcvLmNvbmZpZy5qc29uYCwgdGhpcnR5LXRocmVlIHRlc3RzIHBvaW50XG4gKiAgIGBDT05GSUdfRklMRWAgYXQgdGhlaXIgb3duIGZpeHR1cmUgaW4gYSB0ZW1wIGRpcmVjdG9yeSwgYW5kIGBzZXR1cC5zaGAnc1xuICogICBndWFyZCDigJQgcmlnaHRseSDigJQgZmFpbHMgdGhlbSBhbGwgb24gYENPTkZJR19GSUxFIGFuZCBDT05GSUdfUEFUSCBhcmUgYm90aFxuICogICBzZXQgYW5kIG5hbWUgZGlmZmVyZW50IGZpbGVzYC4gQSBnYXRlIHRoYXQgZmFpbHMgb24gaXRzIG93biBjb250YWluZXJcbiAqICAgdGVhY2hlcyBldmVyeW9uZSB0byByZS1ydW4gcmF0aGVyIHRoYW4gcmVhZC5cbiAqIC0gYFdPUktfRElSYCAoIzEwOTgpOiB0aGUgY29udGFpbmVyIGV4cG9ydHMgdGhlIGxpdmUgd29ya2VyIHZvbHVtZSwgYW5kXG4gKiAgIHByb2R1Y3Rpb24gc3VyZmFjZXMgc3RpbGwgcmVhZCBpdCAoYGF1ZGl0X2pvdXJuYWwudHNgLFxuICogICBgYWdlbnRfbWNwX2NvbmZpZy50c2AsIGBkZWVwc2Vla19lbnYudHNgKS4gVGhlIGdhdGUgaGFzIG5vIGJ1c2luZXNzXG4gKiAgIGhhbmRpbmcgdGhlIHJ1bm5pbmcgZmxlZXQncyBzdGF0ZSBkaXJlY3RvcnkgdG8gZm91ciBwYXJhbGxlbCB0ZXN0IHdvcmtlcnMuXG4gKlxuICogVGhlIGFsbG93bGlzdCBjb3ZlcnMgYm90aCB3aXRob3V0IG5hbWluZyBlaXRoZXIsIGFuZCBjb3ZlcnMgdGhlIG5leHRcbiAqIGNyZWRlbnRpYWwgbm9ib2R5IGhhcyBhZGRlZCB5ZXQg4oCUIHdoaWNoIGEgZGVueWxpc3QgY2Fubm90LlxuICovXG5leHBvcnQgZnVuY3Rpb24gdGVzdFN0YWdlRW52KFxuICBiYXNlOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxuKTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB7XG4gIHJldHVybiBidWlsZFVudHJ1c3RlZENvbW1hbmRFbnYoe1xuICAgIHNvdXJjZTogYmFzZSxcbiAgICBleHRyYU5hbWVzOiBURVNUX1NUQUdFX0VYVFJBX0VOVl9OQU1FUyxcbiAgfSk7XG59XG5cbi8qKiBUaGUgcGVybWlzc2lvbiBzZXQgYm90aCBwYXNzZXMgcnVuIHdpdGguICovXG5jb25zdCBURVNUX1BFUk1JU1NJT05fRkxBR1M6IHJlYWRvbmx5IHN0cmluZ1tdID0gW1xuICBcIi0tYWxsb3ctcmVhZFwiLFxuICBcIi0tYWxsb3ctZW52XCIsXG4gIFwiLS1hbGxvdy1ydW5cIixcbiAgXCItLWFsbG93LXdyaXRlXCIsXG4gIFwiLS1hbGxvdy1zeXM9aG9zdG5hbWVcIixcbl07XG5cbi8qKlxuICogVGhlIHJlcG9ydGVyIGJvdGggcGFzc2VzIHJ1biB3aXRoIChJc3N1ZSAjMjQzMCkuXG4gKlxuICogYGRlbm8gdGVzdCAtLXJlcG9ydGVyYCB0YWtlcyBvbmUgb2YgYHByZXR0eWAsIGBkb3RgLCBganVuaXRgLCBgdGFwYC4gTm9uZVxuICogaXMgc2lsZW50IG9uIGEgZ3JlZW4gcnVuLCBidXQgYGRvdGAgaXMgdGhlIHF1aWV0ZXN0IOKAlCBvbmUgY2hhcmFjdGVyIHBlclxuICogdGVzdCBhZ2FpbnN0IGBwcmV0dHlgJ3MgbGluZSBwZXIgdGVzdCDigJQgYW5kIGl0IGlzIHRoZSBvbmx5IHF1aWV0IG9uZSB0aGF0XG4gKiBrZWVwcyBhIGZhaWx1cmUgaW50YWN0LlxuICovXG5leHBvcnQgY29uc3QgVEVTVF9SRVBPUlRFUl9GTEFHID0gXCItLXJlcG9ydGVyPWRvdFwiO1xuXG4vKipcbiAqIFRoZSBzdGFnZSB0cmFuc2NyaXB0IG9uZSBmaW5pc2hlZCBwYXNzIGNvbnRyaWJ1dGVzLlxuICpcbiAqIE5vdGhpbmcgd2hlbiB0aGUgcGFzcyBwYXNzZWQgb3IgbmV2ZXIgcmFuOiBgZG90YCBzdGlsbCBwcmludHMgYSBkb3QgcGVyXG4gKiB0ZXN0IGFuZCBhbiBgb2sgfCBOIHBhc3NlZGAgbGluZSwgYW5kIHtAbGluayBzdW1tYXJpc2VVbml0VGVzdFBhc3Nlc31cbiAqIGFscmVhZHkgcmVwb3J0cyB0aGUgcGFzcydzIHZlcmRpY3QgYW5kIGNvc3QuIEV2ZXJ5dGhpbmcgd2hlbiBpdCBmYWlsZWQg4oCUXG4gKiB0aGUgZmFpbGluZyB0ZXN0J3MgbmFtZSwgaXRzIGFzc2VydGlvbiBtZXNzYWdlIGFuZCBpdHMgc3RhY2sgdHJhY2UgYWxsXG4gKiBiZWxvbmcgaW4gZnJvbnQgb2YgdGhlIHJlYWRlci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHVuaXRUZXN0UGFzc1RyYW5zY3JpcHQoXG4gIGxhYmVsOiBzdHJpbmcsXG4gIGV4aXRDb2RlOiBudW1iZXIgfCBudWxsLFxuICBvdXRwdXQ6IHN0cmluZyxcbik6IHN0cmluZ1tdIHtcbiAgaWYgKGV4aXRDb2RlID09PSAwIHx8IGV4aXRDb2RlID09PSBudWxsKSByZXR1cm4gW107XG4gIHJldHVybiBbYD09PSBkZW5vIHRlc3RzOiAke2xhYmVsfSBwYXNzID09PWAsIG91dHB1dF07XG59XG5cbi8qKiBPbmUgYGRlbm8gdGVzdGAgaW52b2NhdGlvbiwgcmVhZHkgdG8gc3Bhd24uICovXG5leHBvcnQgaW50ZXJmYWNlIFVuaXRUZXN0UGFzcyB7XG4gIC8qKiBTaG9ydCBpZGVudGlmaWVyIHVzZWQgaW4gdGhlIHN0YWdlJ3MgcmVwb3J0ZWQgb3V0cHV0LiAqL1xuICBsYWJlbDogc3RyaW5nO1xuICAvKiogT25lIGxpbmUgc2F5aW5nIHdoYXQgdGhpcyBwYXNzIGNvdmVycywgZm9yIHRoZSBvcGVyYXRvci4gKi9cbiAgZGVzY3JpcHRpb246IHN0cmluZztcbiAgLyoqIFRoZSBmdWxsIGFyZ3VtZW50IHZlY3RvciwgYGRlbm9gIGluY2x1ZGVkLiAqL1xuICBhcmdzOiByZWFkb25seSBzdHJpbmdbXTtcbiAgLyoqIFRoZSBlbnZpcm9ubWVudCB0aGlzIHBhc3MgcnVucyB3aXRoLiAqL1xuICBlbnY6IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG4gIC8qKlxuICAgKiBXaGVyZSB0aGUgcGFzcyB3cml0ZXMgaXRzIEpVbml0IHJlcG9ydCwgZm9yIHRoZSB0aW1lIGJ1ZGdldFxuICAgKiAoSXNzdWUgIzI2NDIpLiBBYnNlbnQgd2hlbiB0aGUgY2FsbGVyIGFza2VkIGZvciBubyByZXBvcnQuXG4gICAqL1xuICBqdW5pdFBhdGg/OiBzdHJpbmc7XG59XG5cbi8qKiBJbnB1dHMgZm9yIHtAbGluayB1bml0VGVzdFBhc3Nlc30uICovXG5leHBvcnQgaW50ZXJmYWNlIFVuaXRUZXN0UGFzc09wdGlvbnMge1xuICAvKiogVGhlIHJlc29sdmVkIGBkZW5vYCBleGVjdXRhYmxlLiAqL1xuICBkZW5vQ21kOiBzdHJpbmc7XG4gIC8qKiBUaGUgYW1iaWVudCBlbnZpcm9ubWVudCwgbm9ybWFsbHkgYERlbm8uZW52LnRvT2JqZWN0KClgLiAqL1xuICBlbnY6IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG4gIC8qKlxuICAgKiBGbGFncyBpbnNlcnRlZCBzdHJhaWdodCBhZnRlciBgdGVzdGAsIGJlZm9yZSB0aGUgcGVybWlzc2lvbiBzZXQuIFRoZVxuICAgKiBgdGVzdDp1bml0YCB0YXNrIHVzZXMgdGhpcyBmb3IgYC0tZnJvemVuIC0tbG9jaz1kZW5vLmxvY2tgOyB0aGUgZ2F0ZVxuICAgKiBwYXNzZXMgbm9uZS5cbiAgICovXG4gIGV4dHJhQXJncz86IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogVGhlIG1hbmlmZXN0cywgaW5qZWN0ZWQgc28gYSB0ZXN0IGNhbiB2YXJ5IHRoZW0uICovXG4gIGludGVncmF0aW9uRmlsZXM/OiByZWFkb25seSBzdHJpbmdbXTtcbiAgcGFyYWxsZWxVbnNhZmVGaWxlcz86IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKipcbiAgICogQSBkaXJlY3RvcnkgZm9yIGVhY2ggcGFzcydzIEpVbml0IHJlcG9ydCAoSXNzdWUgIzI2NDIpOiB0aGUgcGFzcyB3cml0ZXNcbiAgICogYDxqdW5pdERpcj4vPGxhYmVsPi54bWxgLCB3aGljaCB0aGUgdGltZSBidWRnZXQgcmVhZHMgYmFjay5cbiAgICovXG4gIGp1bml0RGlyPzogc3RyaW5nO1xufVxuXG4vKiogVGhlIEpVbml0IHJlcG9ydCBwYXRoIGFuZCBmbGFnIGZvciBvbmUgcGFzcywgd2hlbiBhIGRpcmVjdG9yeSBpcyBnaXZlbi4gKi9cbmZ1bmN0aW9uIGp1bml0Rm9yKFxuICBqdW5pdERpcjogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBsYWJlbDogc3RyaW5nLFxuKTogeyBmbGFnOiBzdHJpbmdbXTsgZmllbGQ6IHsganVuaXRQYXRoPzogc3RyaW5nIH0gfSB7XG4gIGlmIChqdW5pdERpciA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBmbGFnOiBbXSwgZmllbGQ6IHt9IH07XG4gIGNvbnN0IGp1bml0UGF0aCA9IGAke2p1bml0RGlyfS8ke2xhYmVsfS54bWxgO1xuICByZXR1cm4geyBmbGFnOiBbYC0tanVuaXQtcGF0aD0ke2p1bml0UGF0aH1gXSwgZmllbGQ6IHsganVuaXRQYXRoIH0gfTtcbn1cblxuLyoqXG4gKiBUaGUgZmlsZXMgdGhlIHNlcmlhbCBwYXNzIG5hbWVzIGV4cGxpY2l0bHkuXG4gKlxuICogQSBmaWxlIGNhbiBiZSBib3RoIGEgbXV0YXRvciBhbmQgYW4gaW50ZWdyYXRpb24gc3VpdGUg4oCUXG4gKiBgY29udGFpbmVyX2VudHJ5cG9pbnRfdGVzdC50c2AgaXMg4oCUIGFuZCBuYW1pbmcgaXQgaGVyZSB3b3VsZCBydW4gaW4gdGhlXG4gKiBnYXRlIHRoZSB2ZXJ5IHN1aXRlcyAjOTA3IHRvb2sgb3V0IG9mIGl0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2VyaWFsUGFzc0ZpbGVzKFxuICBwYXJhbGxlbFVuc2FmZUZpbGVzOiByZWFkb25seSBzdHJpbmdbXSA9IFBBUkFMTEVMX1VOU0FGRV9URVNUX0ZJTEVTLFxuICBpbnRlZ3JhdGlvbkZpbGVzOiByZWFkb25seSBzdHJpbmdbXSA9IElOVEVHUkFUSU9OX1RFU1RfRklMRVMsXG4pOiByZWFkb25seSBzdHJpbmdbXSB7XG4gIGNvbnN0IGV4Y2x1ZGVkID0gbmV3IFNldChpbnRlZ3JhdGlvbkZpbGVzKTtcbiAgcmV0dXJuIHBhcmFsbGVsVW5zYWZlRmlsZXMuZmlsdGVyKChmaWxlKSA9PiAhZXhjbHVkZWQuaGFzKGZpbGUpKTtcbn1cblxuLyoqXG4gKiBgdGVzdGAsIHRoZSBjYWxsZXIncyBleHRyYSBmbGFncywgYW5kIHRoZSBmbGFncyBldmVyeSBwYXNzIHNoYXJlcy5cbiAqL1xuZnVuY3Rpb24gY29tbW9uVGVzdEFyZ3MoZXh0cmFBcmdzOiByZWFkb25seSBzdHJpbmdbXSk6IHN0cmluZ1tdIHtcbiAgLy8gVGhlIGdhdGUncyBvd24gYGRlbm8gY2hlY2sgJyoqLyoudHMnYCBzdGFnZSB0eXBlLWNoZWNrcyB0aGUgd2hvbGUgZ3JhcGhcbiAgLy8gaW5jbHVkaW5nIHRlc3RzLyoqLCBzbyBgZGVubyB0ZXN0YCBuZWVkIG5vdCBidWlsZCBhIHNlY29uZCBmdWxsXG4gIC8vIFR5cGVTY3JpcHQgcHJvZ3JhbSAoSXNzdWUgIzQzNDcpLiBJbiBwYXJhbGxlbCBtb2RlIGJvdGggdXNlZCB0byBzdGFydFxuICAvLyB0b2dldGhlciBhbmQgbWlzcyB0aGUgc2hhcmVkIGNhY2hlIOKAlCB0aGUgbWVtb3J5IHNwaWtlIHF1YWxpdHkuc2ggYmxhbWVzXG4gIC8vIGZvciB0aGUgaW4tY29udGFpbmVyIFNJR0tJTExzLlxuICAvLyBJc3N1ZSAjMjQzMDogdGhlIGdhdGUncyBvdXRwdXQgaXMgcXVvdGVkIGJhY2sgaW50byBwcm9tcHRzLCBhbmQgYHByZXR0eWBcbiAgLy8gc3BlbmRzIH4yMywwMDAgbGluZXMgc2F5aW5nIHRoYXQgYSB0ZXN0IHBhc3NlZC4gYGRvdGAgaXMgdGhlIHF1aWV0ZXN0XG4gIC8vIHJlcG9ydGVyIGBkZW5vIHRlc3RgIGFjY2VwdHMgdGhhdCBzdGlsbCBwcmludHMgYSBmYWlsdXJlIGluIGZ1bGwg4oCUIG5hbWUsXG4gIC8vIGFzc2VydGlvbiBtZXNzYWdlLCBkaWZmIGFuZCBzdGFjayB0cmFjZS4gSXQgZm9sbG93cyB0aGUgcGVybWlzc2lvbiBzZXQgc29cbiAgLy8gYGV4dHJhQXJnc2Aga2VlcCB0aGUgcG9zaXRpb24gYHRlc3Q6dW5pdGAgZXhwZWN0cy5cbiAgcmV0dXJuIFtcbiAgICBcInRlc3RcIixcbiAgICAuLi5leHRyYUFyZ3MsXG4gICAgXCItLW5vLWNoZWNrXCIsXG4gICAgLi4uVEVTVF9QRVJNSVNTSU9OX0ZMQUdTLFxuICAgIFRFU1RfUkVQT1JURVJfRkxBRyxcbiAgXTtcbn1cblxuLyoqIFRoZSBwYXJhbGxlbCBwYXNzJ3MgZW52aXJvbm1lbnQ6IHRoZSBjb250YWluZXIgYm91bmRzIGBERU5PX0pPQlNgLiAqL1xuZnVuY3Rpb24gcGFyYWxsZWxQYXNzRW52KFxuICBvcHRpb25zOiBVbml0VGVzdFBhc3NPcHRpb25zLFxuICBlbnY6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXG4pOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHtcbiAgY29uc3QgcGFyYWxsZWxFbnYgPSB7IC4uLmVudiB9O1xuICAvLyBBbiBvcGVyYXRvcidzIG93biBERU5PX0pPQlMgd2luczsgdGhlIGJvdW5kIGlzIG9ubHkgYSBkZWZhdWx0LlxuICBpZiAoXG4gICAgcnVubmluZ0luQ29udGFpbmVySW1hZ2UoKG5hbWUpID0+IG9wdGlvbnMuZW52W25hbWVdKSAmJlxuICAgIHBhcmFsbGVsRW52LkRFTk9fSk9CUyA9PT0gdW5kZWZpbmVkXG4gICkge1xuICAgIHBhcmFsbGVsRW52LkRFTk9fSk9CUyA9IENPTlRBSU5FUl9ERU5PX0pPQlM7XG4gIH1cbiAgcmV0dXJuIHBhcmFsbGVsRW52O1xufVxuXG4vKipcbiAqIFRoZSB0d28gcGFzc2VzIHRoZSB1bml0IHN1aXRlIHJ1bnMgYXMsIGluIG9yZGVyLlxuICpcbiAqIE9yZGVyIG1hdHRlcnM6IHRoZSBmYXN0IHBhc3MgcnVucyBmaXJzdCwgc28gdGhlIGNvbW1vbiBmYWlsdXJlIGlzIHJlcG9ydGVkXG4gKiBpbiBtaW51dGVzIHJhdGhlciB0aGFuIGFmdGVyIHRoZSBzbG93IHBhc3MgaGFzIGZpbmlzaGVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdW5pdFRlc3RQYXNzZXMoXG4gIG9wdGlvbnM6IFVuaXRUZXN0UGFzc09wdGlvbnMsXG4pOiByZWFkb25seSBVbml0VGVzdFBhc3NbXSB7XG4gIGNvbnN0IGludGVncmF0aW9uRmlsZXMgPSBvcHRpb25zLmludGVncmF0aW9uRmlsZXMgPz8gSU5URUdSQVRJT05fVEVTVF9GSUxFUztcbiAgY29uc3QgcGFyYWxsZWxVbnNhZmVGaWxlcyA9IG9wdGlvbnMucGFyYWxsZWxVbnNhZmVGaWxlcyA/P1xuICAgIFBBUkFMTEVMX1VOU0FGRV9URVNUX0ZJTEVTO1xuICBjb25zdCBleHRyYUFyZ3MgPSBvcHRpb25zLmV4dHJhQXJncyA/PyBbXTtcbiAgY29uc3Qgc2VyaWFsRmlsZXMgPSBzZXJpYWxQYXNzRmlsZXMocGFyYWxsZWxVbnNhZmVGaWxlcywgaW50ZWdyYXRpb25GaWxlcyk7XG4gIGNvbnN0IGVudiA9IHRlc3RTdGFnZUVudihvcHRpb25zLmVudik7XG5cbiAgY29uc3QgY29tbW9uID0gY29tbW9uVGVzdEFyZ3MoZXh0cmFBcmdzKTtcblxuICAvLyBJc3N1ZSAjOTA3OiB0aGUgc3VpdGVzIHRoYXQgY29weSB0aGUgcmVwb3NpdG9yeSdzIG93biBgLnNoYC9gLnBzMWAgaW50b1xuICAvLyBhIHRlbXAgdHJlZSwgc3R1YiBhIFBBVEggYW5kIHNwYXduIHRoZW0gYXJlIGludGVncmF0aW9uIHRlc3RzLiBUaGV5IGNvc3RcbiAgLy8gfjEyIG9mIHRoZSBnYXRlJ3MgfjM2IG1pbnV0ZXMgYW5kIHJhbiBvbiBldmVyeSBjaGFuZ2UsIGluY2x1ZGluZyBjaGFuZ2VzXG4gIC8vIHRoYXQgY2Fubm90IHJlYWNoIHRoZW0g4oCUICM4OTEgd2FzIGZvdW5kIGV4YWN0bHkgdGhhdCB3YXksIGJ5IGEgZGlmZlxuICAvLyB0b3VjaGluZyBvbmx5IGBwcm9tcHRzLyoqYC4gQ0kgcnVucyB0aGVtLCB3aGVyZSBzaGFyZGluZyBhYnNvcmJzIHRoZVxuICAvLyBjb3N0OyB0aGUgd29ya2VyJ3MgZ2F0ZSBkb2VzIG5vdC4gQm90aCBwYXNzZXMgZXhjbHVkZSB0aGVtIOKAlCBleGNlcHQgdGhlXG4gIC8vIGBydW4ucHMxYCBsYXVuY2hlciBzdWl0ZXMsIHdoaWNoIHRoZSBtYW5pZmVzdCBrZWVwcyBvdXQgb2YgdGhpcyBsaXN0XG4gIC8vIGJlY2F1c2UgdGhlIGltYWdlIHByb3Zpc2lvbnMgdGhlaXIgaW50ZXJwcmV0ZXIgKCMxNTk2LCAjMTU5OCkuXG4gIGNvbnN0IGludGVncmF0aW9uSWdub3JlID0gaW50ZWdyYXRpb25UZXN0SWdub3JlQXJnKGludGVncmF0aW9uRmlsZXMpO1xuXG4gIGNvbnN0IHBhcmFsbGVsSWdub3JlID0gW1xuICAgIGludGVncmF0aW9uSWdub3JlLFxuICAgIHBhcmFsbGVsVW5zYWZlSWdub3JlQXJnKHBhcmFsbGVsVW5zYWZlRmlsZXMpLFxuICBdLmZpbHRlcigocGFydCkgPT4gcGFydC5sZW5ndGggPiAwKS5qb2luKFwiLFwiKTtcblxuICBjb25zdCBwYXJhbGxlbEVudiA9IHBhcmFsbGVsUGFzc0VudihvcHRpb25zLCBlbnYpO1xuXG4gIGNvbnN0IHBhcmFsbGVsSnVuaXQgPSBqdW5pdEZvcihvcHRpb25zLmp1bml0RGlyLCBcInBhcmFsbGVsXCIpO1xuICBjb25zdCBzZXJpYWxKdW5pdCA9IGp1bml0Rm9yKG9wdGlvbnMuanVuaXREaXIsIFwic2VyaWFsXCIpO1xuICByZXR1cm4gW1xuICAgIHtcbiAgICAgIGxhYmVsOiBcInBhcmFsbGVsXCIsXG4gICAgICBkZXNjcmlwdGlvbjpcbiAgICAgICAgYGV2ZXJ5IHVuaXQgdGVzdCBleGNlcHQgJHtwYXJhbGxlbFVuc2FmZUZpbGVzLmxlbmd0aH0gdGhhdCByYWNlIG9yIGAgK1xuICAgICAgICBgbWVhc3VyZSB1bmRlciAtLXBhcmFsbGVsICgjODgwLCAjOTQwKSBhbmQgYCArXG4gICAgICAgIGAke2ludGVncmF0aW9uRmlsZXMubGVuZ3RofSBpbnRlZ3JhdGlvbiBzdWl0ZXMgKCM5MDcpYCxcbiAgICAgIGFyZ3M6IFtcbiAgICAgICAgb3B0aW9ucy5kZW5vQ21kLFxuICAgICAgICAuLi5jb21tb24sXG4gICAgICAgIC4uLnBhcmFsbGVsSnVuaXQuZmxhZyxcbiAgICAgICAgXCItLXBhcmFsbGVsXCIsXG4gICAgICAgIC4uLihwYXJhbGxlbElnbm9yZS5sZW5ndGggPiAwID8gW2AtLWlnbm9yZT0ke3BhcmFsbGVsSWdub3JlfWBdIDogW10pLFxuICAgICAgXSxcbiAgICAgIGVudjogcGFyYWxsZWxFbnYsXG4gICAgICAuLi5wYXJhbGxlbEp1bml0LmZpZWxkLFxuICAgIH0sXG4gICAge1xuICAgICAgbGFiZWw6IFwic2VyaWFsXCIsXG4gICAgICBkZXNjcmlwdGlvbjpcbiAgICAgICAgYCR7c2VyaWFsRmlsZXMubGVuZ3RofSB0ZXN0cyB0aGF0IG11dGF0ZSBzaGFyZWQgcHJvY2VzcyBzdGF0ZSBvciBgICtcbiAgICAgICAgYGFzc2VydCBvbiBhIHJlYWwgY2xvY2ssIHJ1biBvbmUgYXQgYSB0aW1lYCxcbiAgICAgIGFyZ3M6IFtcbiAgICAgICAgb3B0aW9ucy5kZW5vQ21kLFxuICAgICAgICAuLi5jb21tb24sXG4gICAgICAgIC4uLnNlcmlhbEp1bml0LmZsYWcsXG4gICAgICAgIC4uLihpbnRlZ3JhdGlvbklnbm9yZS5sZW5ndGggPiAwXG4gICAgICAgICAgPyBbYC0taWdub3JlPSR7aW50ZWdyYXRpb25JZ25vcmV9YF1cbiAgICAgICAgICA6IFtdKSxcbiAgICAgICAgLi4uc2VyaWFsRmlsZXMsXG4gICAgICBdLFxuICAgICAgZW52LFxuICAgICAgLi4uc2VyaWFsSnVuaXQuZmllbGQsXG4gICAgfSxcbiAgXTtcbn1cblxuLyoqIFdoYXQge0BsaW5rIHRhcmdldGVkVW5pdFRlc3RQYXNzZXN9IHJ1bnMsIGFuZCB3aGF0IGl0IGxlZnQgb3V0LiAqL1xuZXhwb3J0IGludGVyZmFjZSBUYXJnZXRlZFVuaXRUZXN0UGxhbiB7XG4gIC8qKiBUaGUgcGFzc2VzIHRvIHJ1biDigJQgb25seSB0aG9zZSB3aXRoIGF0IGxlYXN0IG9uZSByZXF1ZXN0ZWQgZmlsZS4gKi9cbiAgcGFzc2VzOiByZWFkb25seSBVbml0VGVzdFBhc3NbXTtcbiAgLyoqIFJlcXVlc3RlZCBmaWxlcyBsZWZ0IG91dCBiZWNhdXNlIHRoZXkgYXJlIGludGVncmF0aW9uIHN1aXRlcyAoIzkwNykuICovXG4gIHNraXBwZWRJbnRlZ3JhdGlvbjogcmVhZG9ubHkgc3RyaW5nW107XG59XG5cbi8qKlxuICogVGhlIHVuaXQgcGFzc2VzIG92ZXIgYSBoYW5kLXBpY2tlZCBsaXN0IG9mIHRlc3QgZmlsZXMgKElzc3VlICMyNjQyKS5cbiAqXG4gKiBBbiBhZ2VudCB0aGF0IHJ1bnMgYGRlbm8gdGVzdGAgb3ZlciBldmVyeSBmaWxlIGl0cyBncmVwIG1hdGNoZWQgYWxzbyBydW5zXG4gKiB0aGUgaW50ZWdyYXRpb24gc3VpdGVzIHRoZSBnYXRlIGRlbGliZXJhdGVseSBleGNsdWRlcyDigJQgdGhlIGxhdW5jaGVyIHN1aXRlc1xuICogYWxvbmUgY29zdCBtaW51dGVzLiBUaGlzIGludGVyc2VjdHMgdGhlIGxpc3Qgd2l0aCB0aGUgdW5pdCBzY29wZTogYW5cbiAqIGludGVncmF0aW9uIHN1aXRlIGlzIGxlZnQgb3V0IGFuZCBuYW1lZCwgYSBwYXJhbGxlbC11bnNhZmUgZmlsZSBydW5zIGluIHRoZVxuICogc2VyaWFsIHBhc3MsIGFuZCBldmVyeXRoaW5nIGVsc2UgcnVucyB1bmRlciBgLS1wYXJhbGxlbGAsIGV4YWN0bHkgYXMgdGhlXG4gKiBnYXRlIHdvdWxkIHJ1biBpdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRhcmdldGVkVW5pdFRlc3RQYXNzZXMoXG4gIG9wdGlvbnM6IFVuaXRUZXN0UGFzc09wdGlvbnMsXG4gIGZpbGVzOiByZWFkb25seSBzdHJpbmdbXSxcbik6IFRhcmdldGVkVW5pdFRlc3RQbGFuIHtcbiAgY29uc3QgaW50ZWdyYXRpb25GaWxlcyA9IG9wdGlvbnMuaW50ZWdyYXRpb25GaWxlcyA/PyBJTlRFR1JBVElPTl9URVNUX0ZJTEVTO1xuICBjb25zdCBpbnRlZ3JhdGlvbiA9IG5ldyBTZXQoaW50ZWdyYXRpb25GaWxlcyk7XG4gIGNvbnN0IHNlcmlhbFNldCA9IG5ldyBTZXQoc2VyaWFsUGFzc0ZpbGVzKFxuICAgIG9wdGlvbnMucGFyYWxsZWxVbnNhZmVGaWxlcyA/PyBQQVJBTExFTF9VTlNBRkVfVEVTVF9GSUxFUyxcbiAgICBpbnRlZ3JhdGlvbkZpbGVzLFxuICApKTtcbiAgY29uc3QgcmVxdWVzdGVkID0gWy4uLm5ldyBTZXQoZmlsZXMubWFwKG5vcm1hbGlzZVRlc3RQYXRoKSldO1xuICBjb25zdCBza2lwcGVkSW50ZWdyYXRpb24gPSByZXF1ZXN0ZWQuZmlsdGVyKChmKSA9PiBpbnRlZ3JhdGlvbi5oYXMoZikpO1xuICBjb25zdCB1bml0ID0gcmVxdWVzdGVkLmZpbHRlcigoZikgPT4gIWludGVncmF0aW9uLmhhcyhmKSk7XG4gIGNvbnN0IHNlcmlhbCA9IHVuaXQuZmlsdGVyKChmKSA9PiBzZXJpYWxTZXQuaGFzKGYpKTtcbiAgY29uc3QgcGFyYWxsZWwgPSB1bml0LmZpbHRlcigoZikgPT4gIXNlcmlhbFNldC5oYXMoZikpO1xuXG4gIGNvbnN0IGNvbW1vbiA9IGNvbW1vblRlc3RBcmdzKG9wdGlvbnMuZXh0cmFBcmdzID8/IFtdKTtcbiAgY29uc3QgZW52ID0gdGVzdFN0YWdlRW52KG9wdGlvbnMuZW52KTtcbiAgY29uc3QgcGFzc2VzOiBVbml0VGVzdFBhc3NbXSA9IFtdO1xuICBpZiAocGFyYWxsZWwubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IGp1bml0ID0ganVuaXRGb3Iob3B0aW9ucy5qdW5pdERpciwgXCJwYXJhbGxlbFwiKTtcbiAgICBwYXNzZXMucHVzaCh7XG4gICAgICBsYWJlbDogXCJwYXJhbGxlbFwiLFxuICAgICAgZGVzY3JpcHRpb246XG4gICAgICAgIGAke3BhcmFsbGVsLmxlbmd0aH0gcmVxdWVzdGVkIHBhcmFsbGVsLXNhZmUgdW5pdCB0ZXN0IGZpbGUocylgLFxuICAgICAgYXJnczogW1xuICAgICAgICBvcHRpb25zLmRlbm9DbWQsXG4gICAgICAgIC4uLmNvbW1vbixcbiAgICAgICAgLi4uanVuaXQuZmxhZyxcbiAgICAgICAgXCItLXBhcmFsbGVsXCIsXG4gICAgICAgIC4uLnBhcmFsbGVsLFxuICAgICAgXSxcbiAgICAgIGVudjogcGFyYWxsZWxQYXNzRW52KG9wdGlvbnMsIGVudiksXG4gICAgICAuLi5qdW5pdC5maWVsZCxcbiAgICB9KTtcbiAgfVxuICBpZiAoc2VyaWFsLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBqdW5pdCA9IGp1bml0Rm9yKG9wdGlvbnMuanVuaXREaXIsIFwic2VyaWFsXCIpO1xuICAgIHBhc3Nlcy5wdXNoKHtcbiAgICAgIGxhYmVsOiBcInNlcmlhbFwiLFxuICAgICAgZGVzY3JpcHRpb246XG4gICAgICAgIGAke3NlcmlhbC5sZW5ndGh9IHJlcXVlc3RlZCBwYXJhbGxlbC11bnNhZmUgdW5pdCB0ZXN0IGZpbGUocylgLFxuICAgICAgYXJnczogW29wdGlvbnMuZGVub0NtZCwgLi4uY29tbW9uLCAuLi5qdW5pdC5mbGFnLCAuLi5zZXJpYWxdLFxuICAgICAgZW52LFxuICAgICAgLi4uanVuaXQuZmllbGQsXG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIHsgcGFzc2VzLCBza2lwcGVkSW50ZWdyYXRpb24gfTtcbn1cblxuLyoqIFdoYXQgb25lIHBhc3MgZGlkLiAqL1xuZXhwb3J0IGludGVyZmFjZSBVbml0VGVzdFBhc3NPdXRjb21lIHtcbiAgLyoqIFRoZSBwYXNzIGl0IGRlc2NyaWJlcy4gKi9cbiAgcGFzczogVW5pdFRlc3RQYXNzO1xuICAvKipcbiAgICogVGhlIHBhc3MncyBleGl0IGNvZGUsIG9yIGBudWxsYCB3aGVuIGl0IG5ldmVyIHJhbiBiZWNhdXNlIGFuIGVhcmxpZXJcbiAgICogcGFzcyBoYWQgYWxyZWFkeSBmYWlsZWQuXG4gICAqL1xuICBleGl0Q29kZTogbnVtYmVyIHwgbnVsbDtcbiAgLyoqIFdhbGwgdGltZSBpbiBtaWxsaXNlY29uZHMsIG9yIGBudWxsYCB3aGVuIHRoZSBwYXNzIG5ldmVyIHJhbi4gKi9cbiAgZHVyYXRpb25NczogbnVtYmVyIHwgbnVsbDtcbn1cblxuLyoqIFdoYXQgdGhlIGBkZW5vIHRlc3RzYCBzdGFnZSByZXBvcnRzIGZvciB0aGUgcGFpci4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgVW5pdFRlc3RTdGFnZVZlcmRpY3Qge1xuICAvKiogYFBBU1NFRGAgb25seSB3aGVuIGV2ZXJ5IHBhc3MgcmFuIGFuZCBldmVyeSBwYXNzIGV4aXRlZCAwLiAqL1xuICBzdGF0dXM6IFwiUEFTU0VEXCIgfCBcIkZBSUxFRFwiO1xuICAvKiogVGhlIGxhYmVsIG9mIHRoZSBwYXNzIHRoYXQgZmFpbGVkLCBvciBgbnVsbGAgd2hlbiBub25lIGRpZC4gKi9cbiAgZmFpbGVkUGFzczogc3RyaW5nIHwgbnVsbDtcbn1cblxuLyoqXG4gKiBUaGUgc3RhZ2UncyB2ZXJkaWN0IG92ZXIgdGhlIHBhc3NlcyBzbyBmYXIuXG4gKlxuICogVGhlIHBhaXIgaXMgb25lIGNoZWNrLCBzbyB0aGUgYmFyIGZvciBgUEFTU0VEYCBpcyBldmVyeSBwYXNzIGdyZWVuIOKAlCBhXG4gKiBzaW5nbGUgaW52b2NhdGlvbiBjb3VsZCBub3QgZ2V0IHRoaXMgd3JvbmcsIGFuZCB0d28gY2FuOiBhIGxvb3AgdGhhdFxuICogcmVwb3J0cyB0aGUgbGFzdCBwYXNzJ3MgY29kZSwgb3Igb25lIHRoYXQgdHJlYXRzIGEgcGFzcyB0aGF0IG5ldmVyIHJhbiBhc1xuICogYSBwYXNzIHRoYXQgcGFzc2VkLCBib3RoIHR1cm4gYSByZWQgc3VpdGUgZ3JlZW4uIEFuIGVtcHR5IGxpc3QgaXMgYEZBSUxFRGBcbiAqIGZvciB0aGUgc2FtZSByZWFzb24sIGJlY2F1c2UgYSBzdGFnZSB0aGF0IHJhbiBub3RoaW5nIGhhcyBwcm92ZWQgbm90aGluZy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHVuaXRUZXN0U3RhZ2VWZXJkaWN0KFxuICBvdXRjb21lczogcmVhZG9ubHkgVW5pdFRlc3RQYXNzT3V0Y29tZVtdLFxuKTogVW5pdFRlc3RTdGFnZVZlcmRpY3Qge1xuICBjb25zdCBmYWlsZWQgPSBvdXRjb21lcy5maW5kKChvKSA9PiBvLmV4aXRDb2RlICE9PSBudWxsICYmIG8uZXhpdENvZGUgIT09IDApO1xuICBpZiAoZmFpbGVkICE9PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4geyBzdGF0dXM6IFwiRkFJTEVEXCIsIGZhaWxlZFBhc3M6IGZhaWxlZC5wYXNzLmxhYmVsIH07XG4gIH1cbiAgY29uc3QgY29tcGxldGUgPSBvdXRjb21lcy5sZW5ndGggPiAwICYmXG4gICAgb3V0Y29tZXMuZXZlcnkoKG8pID0+IG8uZXhpdENvZGUgPT09IDApO1xuICByZXR1cm4geyBzdGF0dXM6IGNvbXBsZXRlID8gXCJQQVNTRURcIiA6IFwiRkFJTEVEXCIsIGZhaWxlZFBhc3M6IG51bGwgfTtcbn1cblxuLyoqIGAybTIzc2AsIGA0MXNgLCBgMC40c2Ag4oCUIHdoaWNoZXZlciByZWFkcyBiZXN0IGF0IHRoYXQgc2NhbGUuICovXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0UGFzc0R1cmF0aW9uKGR1cmF0aW9uTXM6IG51bWJlcik6IHN0cmluZyB7XG4gIGNvbnN0IHNlY29uZHMgPSBkdXJhdGlvbk1zIC8gMTAwMDtcbiAgaWYgKHNlY29uZHMgPCAxMCkgcmV0dXJuIGAke3NlY29uZHMudG9GaXhlZCgxKX1zYDtcbiAgY29uc3Qgd2hvbGUgPSBNYXRoLnJvdW5kKHNlY29uZHMpO1xuICBpZiAod2hvbGUgPCA2MCkgcmV0dXJuIGAke3dob2xlfXNgO1xuICByZXR1cm4gYCR7TWF0aC5mbG9vcih3aG9sZSAvIDYwKX1tJHtTdHJpbmcod2hvbGUgJSA2MCkucGFkU3RhcnQoMiwgXCIwXCIpfXNgO1xufVxuXG4vKipcbiAqIFRoZSBwZXItcGFzcyB2ZXJkaWN0IGxpbmVzLlxuICpcbiAqIFR3byBpbnZvY2F0aW9ucyByZXBvcnRlZCBhcyBvbmUgYGRlbm8gdGVzdHMgRkFJTEVEYCBpcyB3b3JzZSB0aGFuIG9uZSwgc29cbiAqIGV2ZXJ5IHBhc3MgZ2V0cyBhIGxpbmUgbmFtaW5nIGl0c2VsZiwgaXRzIHZlcmRpY3QsIHdoYXQgaXQgY29zdCBhbmQgd2hhdCBpdFxuICogY292ZXJlZCDigJQgaW5jbHVkaW5nIHRoZSBwYXNzIHRoYXQgbmV2ZXIgcmFuLCB3aGljaCB3b3VsZCBvdGhlcndpc2UgbG9va1xuICogbGlrZSBhIHBhc3MgdGhhdCBwYXNzZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdW1tYXJpc2VVbml0VGVzdFBhc3NlcyhcbiAgb3V0Y29tZXM6IHJlYWRvbmx5IFVuaXRUZXN0UGFzc091dGNvbWVbXSxcbik6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIG91dGNvbWVzLm1hcCgob3V0Y29tZSkgPT4ge1xuICAgIGNvbnN0IGxhYmVsID0gYERlbm8gdGVzdHMgWyR7b3V0Y29tZS5wYXNzLmxhYmVsfV1gO1xuICAgIGlmIChvdXRjb21lLmV4aXRDb2RlID09PSBudWxsKSB7XG4gICAgICByZXR1cm4gYCR7bGFiZWx9OiBOT1QgUlVOIChhbiBlYXJsaWVyIHBhc3MgZmFpbGVkKSDigJQgJHtvdXRjb21lLnBhc3MuZGVzY3JpcHRpb259YDtcbiAgICB9XG4gICAgY29uc3QgdmVyZGljdCA9IG91dGNvbWUuZXhpdENvZGUgPT09IDAgPyBcIlBBU1NFRFwiIDogXCJGQUlMRURcIjtcbiAgICBjb25zdCBjb3N0ID0gb3V0Y29tZS5kdXJhdGlvbk1zID09PSBudWxsXG4gICAgICA/IFwiXCJcbiAgICAgIDogYCBpbiAke2Zvcm1hdFBhc3NEdXJhdGlvbihvdXRjb21lLmR1cmF0aW9uTXMpfWA7XG4gICAgcmV0dXJuIGAke2xhYmVsfTogJHt2ZXJkaWN0fSR7Y29zdH0g4oCUICR7b3V0Y29tZS5wYXNzLmRlc2NyaXB0aW9ufWA7XG4gIH0pO1xufVxuXG4vKipcbiAqIFRoZSB0aGlyZCBzbGljZSBvZiB0aGUgc2FtZSBwYXJ0aXRpb246IHRoZSBpbnRlZ3JhdGlvbiBzdWl0ZXMgKElzc3VlICM5NDApLlxuICpcbiAqIGBkZW5vIHRhc2sgdGVzdDppbnRlZ3JhdGlvbmAgY2FycmllZCBpdHMgb3duIGhhbmQtdHlwZWQgbGlzdCwgYW5kIGl0IGhhZFxuICogYWxyZWFkeSBkcmlmdGVkIOKAlCB0aGlydGVlbiBmaWxlcyB3aGVyZSB0aGUgbWFuaWZlc3QgaG9sZHMgdHdlbnR5LXNldmVuLFxuICogYmVjYXVzZSAjOTM1IGFkZGVkIGZvdXJ0ZWVuIHRoZSB0YXNrIHdhcyBuZXZlciB1cGRhdGVkIGZvci4gRGVyaXZpbmcgaXRcbiAqIGZyb20gYElOVEVHUkFUSU9OX1RFU1RfRklMRVNgIHJlbW92ZXMgdGhlIHNlY29uZCBjb3B5IHJhdGhlciB0aGFuXG4gKiBjb3JyZWN0aW5nIGl0LCBzbyB0aGUgZXNjYXBlIGhhdGNoIGFuZCB0aGUgZ2F0ZSdzIGV4Y2x1c2lvbiBjYW5ub3QgZGlzYWdyZWVcbiAqIGFib3V0IHdoYXQgYW4gaW50ZWdyYXRpb24gdGVzdCBpcy5cbiAqXG4gKiBTZXJpYWwsIGxpa2UgdGhlIGdhdGUncyBzZWNvbmQgcGFzczogc2V2ZXJhbCBvZiB0aGVzZSBzcGF3biBzY3JpcHRzIHRoYXRcbiAqIHdyaXRlIHRvIHNoYXJlZCB0ZW1wIHBhdGhzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaW50ZWdyYXRpb25UZXN0UGFzcyhcbiAgb3B0aW9uczogVW5pdFRlc3RQYXNzT3B0aW9ucyxcbik6IFVuaXRUZXN0UGFzcyB7XG4gIGNvbnN0IGZpbGVzID0gb3B0aW9ucy5pbnRlZ3JhdGlvbkZpbGVzID8/IElOVEVHUkFUSU9OX1RFU1RfRklMRVM7XG4gIHJldHVybiB7XG4gICAgbGFiZWw6IFwiaW50ZWdyYXRpb25cIixcbiAgICBkZXNjcmlwdGlvbjpcbiAgICAgIGAke2ZpbGVzLmxlbmd0aH0gc3VpdGVzIHRoYXQgY29weSBhIHJlcG9zaXRvcnkgc2NyaXB0IGludG8gYSB0ZW1wIGAgK1xuICAgICAgYHRyZWUgYW5kIHNwYXduIGl0ICgjOTA3KSwgcnVuIG9uZSBhdCBhIHRpbWVgLFxuICAgIGFyZ3M6IFtcbiAgICAgIG9wdGlvbnMuZGVub0NtZCxcbiAgICAgIFwidGVzdFwiLFxuICAgICAgLi4uKG9wdGlvbnMuZXh0cmFBcmdzID8/IFtdKSxcbiAgICAgIFwiLS1uby1jaGVja1wiLFxuICAgICAgLi4uVEVTVF9QRVJNSVNTSU9OX0ZMQUdTLFxuICAgICAgLi4uZmlsZXMsXG4gICAgXSxcbiAgICBlbnY6IHRlc3RTdGFnZUVudihvcHRpb25zLmVudiksXG4gIH07XG59XG5cbi8qKlxuICogT25lIENJIHNoYXJkJ3Mgc2hhcmUgb2YgYGZpbGVzYCAoUFIgIzExNzApLlxuICpcbiAqIFRoZSBzdHJpZGUgc3BsaXQg4oCUIGV2ZXJ5IGBjb3VudGAtdGggZmlsZSBmcm9tIGEgc29ydGVkIGxpc3Qg4oCUIGlzIHdoYXRcbiAqIGAuZ2l0aHViL3NjcmlwdHMvZGVuby10ZXN0LXNoYXJkLnNoYCBoYXMgYWx3YXlzIHVzZWQsIGFuZCBpdCBpcyBrZXB0XG4gKiBiZWNhdXNlIGl0IGlzIGRldGVybWluaXN0aWMgYW5kIG5lZWRzIG5vIHN0YXRlOiBzaGFyZCBgaW5kZXhgIG9uIGFueVxuICogbWFjaGluZSwgYXQgYW55IHRpbWUsIHBpY2tzIHRoZSBzYW1lIGZpbGVzLiBTb3J0aW5nIGZpcnN0IGlzIHdoYXQgbWFrZXNcbiAqIHRoYXQgdHJ1ZSwgc28gaXQgaXMgZG9uZSBoZXJlIHJhdGhlciB0aGFuIHRydXN0ZWQgdG8gdGhlIGNhbGxlci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNoYXJkVGVzdEZpbGVzKFxuICBmaWxlczogcmVhZG9ubHkgc3RyaW5nW10sXG4gIGluZGV4OiBudW1iZXIsXG4gIGNvdW50OiBudW1iZXIsXG4pOiByZWFkb25seSBzdHJpbmdbXSB7XG4gIGlmICghTnVtYmVyLmlzSW50ZWdlcihjb3VudCkgfHwgY291bnQgPCAxKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBzaGFyZCBjb3VudCBtdXN0IGJlIGEgcG9zaXRpdmUgaW50ZWdlciwgZ290ICR7Y291bnR9YCk7XG4gIH1cbiAgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKGluZGV4KSB8fCBpbmRleCA8IDAgfHwgaW5kZXggPj0gY291bnQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYHNoYXJkIGluZGV4IG11c3QgYmUgMC4uJHtjb3VudCAtIDF9LCBnb3QgJHtpbmRleH1gKTtcbiAgfVxuICByZXR1cm4gWy4uLmZpbGVzXS5zb3J0KCkuZmlsdGVyKChfLCBpKSA9PiBpICUgY291bnQgPT09IGluZGV4KTtcbn1cblxuLyoqIFdoYXQgb25lIENJIHNoYXJkIHJ1bnMsIGFuZCB3aGF0IGl0IGRlbGliZXJhdGVseSBkb2VzIG5vdC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgVGVzdFNoYXJkUGxhbiB7XG4gIC8qKiBUaGlzIHNoYXJkJ3MgcGFyYWxsZWwtc2FmZSB1bml0IHRlc3RzLCBmb3Igb25lIGAtLXBhcmFsbGVsYCBydW4uICovXG4gIHBhcmFsbGVsOiByZWFkb25seSBzdHJpbmdbXTtcbiAgLyoqIFRoaXMgc2hhcmQncyBwYXJhbGxlbC11bnNhZmUgdW5pdCB0ZXN0cywgZm9yIG9uZSBzZXJpYWwgcnVuLiAqL1xuICBzZXJpYWw6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKipcbiAgICogRXZlcnkgaW50ZWdyYXRpb24gc3VpdGUgaW4gYHRlc3RGaWxlc2Ag4oCUIG5vdCB0aGlzIHNoYXJkJ3Mgc2hhcmUsIHRoZVxuICAgKiB3aG9sZSBzZXQuIFRoZSBzaGFyZCBwcmludHMgaXQgc28gYSByZWFkZXIgb2YgdGhlIENJIGxvZyBjYW4gc2VlIHdoYXRcbiAgICogdGhlIGdhdGUgbGVmdCBvdXQgYW5kIHdoaWNoIGpvYiB0b29rIGl0LCByYXRoZXIgdGhhbiBpbmZlcnJpbmcgYVxuICAgKiBzaWxlbnRseSBzaHJ1bmtlbiBzdWl0ZSBmcm9tIGEgZmFsbGluZyBmaWxlIGNvdW50LlxuICAgKi9cbiAgaW50ZWdyYXRpb246IHJlYWRvbmx5IHN0cmluZ1tdO1xufVxuXG4vKiogSW5wdXRzIGZvciB7QGxpbmsgdGVzdFNoYXJkUGxhbn0uICovXG5leHBvcnQgaW50ZXJmYWNlIFRlc3RTaGFyZFBsYW5PcHRpb25zIHtcbiAgLyoqIEV2ZXJ5IGB0ZXN0cy8qX3Rlc3QudHNgIG9uIGRpc2ssIGluIGFueSBvcmRlci4gKi9cbiAgdGVzdEZpbGVzOiByZWFkb25seSBzdHJpbmdbXTtcbiAgLyoqIDAtYmFzZWQgc2hhcmQgbnVtYmVyLiAqL1xuICBpbmRleDogbnVtYmVyO1xuICAvKiogVG90YWwgc2hhcmRzLiAqL1xuICBjb3VudDogbnVtYmVyO1xuICAvKiogVGhlIG1hbmlmZXN0cywgaW5qZWN0ZWQgc28gYSB0ZXN0IGNhbiB2YXJ5IHRoZW0uICovXG4gIGludGVncmF0aW9uRmlsZXM/OiByZWFkb25seSBzdHJpbmdbXTtcbiAgcGFyYWxsZWxVbnNhZmVGaWxlcz86IHJlYWRvbmx5IHN0cmluZ1tdO1xufVxuXG4vKipcbiAqIFRoZSBDSSBzaGFyZCdzIHBhc3NlcywgYnVpbHQgZnJvbSB0aGUgc2FtZSBtYW5pZmVzdHMgYXMgYHRlc3Q6dW5pdGAuXG4gKlxuICogQ0kgdXNlZCB0byBydW4gYGZpbmQgdGVzdHMgLW1heGRlcHRoIDEgLW5hbWUgJypfdGVzdC50cydgIGFuZCBoYW5kIHRoZVxuICogd2hvbGUgc29ydGVkIGxpc3QgdG8gb25lIGBkZW5vIHRlc3RgLCBzbyB0aGUgZ2F0ZSB0aGF0IGRlY2lkZXMgYSBtZXJnZSBhbmRcbiAqIHRoZSBnYXRlIGEgZGV2ZWxvcGVyIHJ1bnMgYmVmb3JlIHB1c2hpbmcgd2VyZSB0d28gZGlmZmVyZW50IHN1aXRlcyBvdmVyIHR3b1xuICogZGlmZmVyZW50IHNjb3Blcy4gVGhlIG1lcmdlIGdhdGUgY2FycmllZCB0aGUgMjcgaW50ZWdyYXRpb24gc3VpdGVzICM5MDdcbiAqIHRvb2sgb3V0IG9mIHRoZSB1bml0IHN1aXRlIOKAlCB3aGljaCBpcyB3aHkgZXZlcnkgc2hhcmQgam9iIGhhZCB0byBpbnN0YWxsXG4gKiBgcHdzaGAgYmVmb3JlIGl0IGNvdWxkIHN0YXJ0IOKAlCBhbmQgaXQgcmFuIHRoZSB7QGxpbmsgUEFSQUxMRUxfVU5TQUZFX1RFU1RfRklMRVN9XG4gKiBpbiB0aGUgc2FtZSBpbnZvY2F0aW9uIGFzIGV2ZXJ5dGhpbmcgZWxzZSwgc28gdGhlIHNwbGl0IHRob3NlIGZpbGVzIGV4aXN0XG4gKiBmb3Igd2FzIG9ubHkgZXZlciBob25vdXJlZCBvbiBhIGRldmVsb3BlcidzIG1hY2hpbmUuXG4gKlxuICogVGhlIHBhcnRpdGlvbiBoZXJlIGlzIHtAbGluayB1bml0VGVzdFBhc3Nlc30nIHBhcnRpdGlvbiwgdGFrZW4gZnJvbSB0aGVcbiAqIG1hbmlmZXN0cyByYXRoZXIgdGhhbiByZXN0YXRlZDogcGFyYWxsZWwtc2FmZSB1bml0IHRlc3RzLCB0aGVuXG4gKiB7QGxpbmsgc2VyaWFsUGFzc0ZpbGVzfSwgd2l0aCB0aGUgaW50ZWdyYXRpb24gc3VpdGVzIGV4Y2x1ZGVkIGZyb20gYm90aCBhbmRcbiAqIHJlcG9ydGVkIHNvIHRoZSBleGNsdXNpb24gaXMgdmlzaWJsZS4gU2hhcmRpbmcgaXMgYXBwbGllZCBpbnNpZGUgZWFjaCBwYXNzXG4gKiBzbyB0aGUgdHdvIHN0YXkgYmFsYW5jZWQgYWNyb3NzIHRoZSBtYXRyaXggaW5kZXBlbmRlbnRseSDigJQgYSBzaGFyZCB0aGF0XG4gKiBkcmV3IGV2ZXJ5IHNlcmlhbCBmaWxlIHdvdWxkIGJlIHRoZSBzbG93ZXN0IGpvYiBieSBtaW51dGVzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdGVzdFNoYXJkUGxhbihvcHRpb25zOiBUZXN0U2hhcmRQbGFuT3B0aW9ucyk6IFRlc3RTaGFyZFBsYW4ge1xuICBjb25zdCBpbnRlZ3JhdGlvbkZpbGVzID0gb3B0aW9ucy5pbnRlZ3JhdGlvbkZpbGVzID8/IElOVEVHUkFUSU9OX1RFU1RfRklMRVM7XG4gIGNvbnN0IHBhcmFsbGVsVW5zYWZlRmlsZXMgPSBvcHRpb25zLnBhcmFsbGVsVW5zYWZlRmlsZXMgPz9cbiAgICBQQVJBTExFTF9VTlNBRkVfVEVTVF9GSUxFUztcbiAgY29uc3QgaW50ZWdyYXRpb24gPSBuZXcgU2V0KGludGVncmF0aW9uRmlsZXMpO1xuICBjb25zdCBzZXJpYWwgPSBuZXcgU2V0KFxuICAgIHNlcmlhbFBhc3NGaWxlcyhwYXJhbGxlbFVuc2FmZUZpbGVzLCBpbnRlZ3JhdGlvbkZpbGVzKSxcbiAgKTtcbiAgY29uc3Qga25vd24gPSBbLi4ub3B0aW9ucy50ZXN0RmlsZXNdLnNvcnQoKTtcbiAgcmV0dXJuIHtcbiAgICBwYXJhbGxlbDogc2hhcmRUZXN0RmlsZXMoXG4gICAgICBrbm93bi5maWx0ZXIoKGZpbGUpID0+ICFpbnRlZ3JhdGlvbi5oYXMoZmlsZSkgJiYgIXNlcmlhbC5oYXMoZmlsZSkpLFxuICAgICAgb3B0aW9ucy5pbmRleCxcbiAgICAgIG9wdGlvbnMuY291bnQsXG4gICAgKSxcbiAgICBzZXJpYWw6IHNoYXJkVGVzdEZpbGVzKFxuICAgICAga25vd24uZmlsdGVyKChmaWxlKSA9PiBzZXJpYWwuaGFzKGZpbGUpKSxcbiAgICAgIG9wdGlvbnMuaW5kZXgsXG4gICAgICBvcHRpb25zLmNvdW50LFxuICAgICksXG4gICAgaW50ZWdyYXRpb246IGtub3duLmZpbHRlcigoZmlsZSkgPT4gaW50ZWdyYXRpb24uaGFzKGZpbGUpKSxcbiAgfTtcbn1cbiJdLCJuYW1lcyI6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
// denoCacheMetadata=6342224918186286088,17946282283942642024