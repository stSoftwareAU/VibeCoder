/**
 * Test files that exercise the repository's own scripts (Issue #907).
 *
 * These copy a real `.sh` or `.ps1` into a temp directory, build a fake
 * `PATH` of stub binaries, spawn `bash` or `pwsh`, and assert on captured
 * output. That is integration testing — valuable, and nothing like the 16,600
 * unit tests beside them that finish in microseconds.
 *
 * They cost roughly **12 minutes of the gate's ~36**, and the gate runs on
 * every change. #891 opens with the consequence:
 *
 * > Found while implementing #836, whose diff touches only `prompts/**` and
 * > cannot reach any of this.
 *
 * A prompts-only change spent tens of minutes producing a verdict about
 * container plumbing it never touched — and the verdict was wrong, because
 * two of those tests failed on the container regardless of the change.
 *
 * Nobody expects a CloudFormation deployment to run on a spelling fix. This
 * is the same category, so the worker's gate skips them and CI runs them,
 * where sharding absorbs the cost and the environment is provisioned for it.
 *
 * The list is not the classification — {@link isIntegrationTestSource} is.
 * `integration_test_manifest_test.ts` fails when the two disagree in either
 * direction, so a new script-driving test cannot quietly join the gate's path
 * and a retired one cannot linger here unnoticed.
 *
 * That claim was only true of one idiom until Issue #935. The classifier
 * recognised `${REPO_ROOT}/setup.sh` and not
 * `new URL("../../../setup.sh", import.meta.url)`, so fourteen suites
 * driving `setup.sh`, `volume-init.sh` and the container entrypoint were
 * never claimed by it — and a conformance test comparing two lists cannot
 * report a disagreement about a file neither list mentions. Among them was
 * one that fails on a macOS host for reasons no change of its own could
 * affect, which two separate agents reported as "a pre-existing failure on
 * main" while working on something else.
 *
 * A file the classifier claims must now be placed deliberately: in this
 * list, or in {@link SCRIPT_READING_UNIT_TESTS} with a reason. Neither is
 * the failure.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

/**
 * Test files excluded from the gate's default suite.
 *
 * Paths are relative to `worker/deno`, the directory the gate runs `deno test`
 * from.
 */
export const INTEGRATION_TEST_FILES: readonly string[] = [
  "tests/container_provider_deepseek_test.ts",
  "tests/container_provider_set_test.ts",
  "tests/container_restart_backoff_test.ts",
  "tests/container_tools_example_docs_test.ts",
  "tests/container_tools_install_test.ts",
  "tests/first_run_script_test.ts",
  "tests/install_tools_test.ts",
  "tests/launcher_egress_probe_test.ts",
  "tests/launcher_parity_test.ts",
  // Issue #873: runs loop.sh in a sandbox to prove the operator's log-directory
  // override reaches the resolver and is written to.
  "tests/log_dir_launcher_test.ts",
  "tests/loop_supervisor_test.ts",
  "tests/run_ps1_launcher_test.ts",
  "tests/run_sh_launcher_test.ts",
  "tests/run_sh_upgrade_test.ts",
  "tests/setup_parity_test.ts",
  // Issue #935: these drive the same scripts through the second idiom for
  // naming them, `new URL("../../../<script>", import.meta.url)`, and so
  // were never classified or excluded.
  "tests/container_entrypoint_test.ts",
  "tests/container_store_prune_test.ts",
  "tests/container_tools_env_test.ts",
  "tests/host_config_path_test.ts",
  "tests/multi_provider_credentials_test.ts",
  "tests/next_release_tag_test.ts",
  "tests/secrets_mount_test.ts",
  "tests/setup_config_atomic_write_test.ts",
  "tests/setup_credential_provisioning_test.ts",
  "tests/setup_launchagent_prompt_test.ts",
  "tests/setup_lockfile_test.ts",
  "tests/setup_provider_credential_flow_test.ts",
  "tests/setup_provider_env_parse_test.ts",
  "tests/setup_ps1_test.ts",
  "tests/setup_token_transcript_cleanup_test.ts",
  "tests/setup_workdir_reminder_test.ts",
  "tests/volume_init_script_test.ts",
  // Issue #1384: runs the entrypoint over a work root laid out with
  // clones beside the worker's own state, then reads the mode bits back.
  "tests/work_root_group_grant_test.ts",
];

/**
 * Files the classifier claims that are **not** integration tests (Issue #935).
 *
 * Both read a repository script and assert on its text without ever running
 * it, so both finish in about a second. Excluding them would take a real
 * unit test out of the gate — the false positive the classifier's design
 * note calls the expensive one, because nobody notices a test that quietly
 * stops running.
 *
 * The entry is required rather than inferred: a file that constructs a path
 * to a script has to be placed in one list or the other deliberately, so a
 * suite that later grows a spawn cannot keep a "reads it only" exemption it
 * silently outgrew.
 */
export const SCRIPT_READING_UNIT_TESTS: ReadonlyMap<string, string> = new Map([
  [
    "tests/container_manifest_test.ts",
    "reads container/entrypoint.sh with Deno.readTextFile to assert its " +
    "seed directory matches the Containerfile; runs in 1.2s",
  ],
  [
    "tests/loop_checkout_refresh_test.ts",
    "reads loop.sh and loop.ps1 with Deno.readTextFile to assert both " +
    "supervisors pull their checkout at the end of every cycle (Issue " +
    "#1401); it never spawns either one, and runs in milliseconds",
  ],
  [
    "tests/workflow_definitions_test.ts",
    "reads .github/scripts/deno-test-shard.sh to assert the workflow and " +
    "the script agree on sharding; runs in 1.2s",
  ],
]);

/**
 * Whether `source` drives one of the repository's own scripts.
 *
 * The signal is deliberately narrow: reading a `.sh` or `.ps1` **from the
 * repository root** and spawning it. A test that merely spawns `git` is not
 * caught — plenty of those exist and they are fast — and a test that reads a
 * script without running it is not caught either.
 *
 * Narrow because the cost of a false positive is real: a unit test wrongly
 * excluded stops running on every change, and nobody would notice. A false
 * negative merely leaves a slow test in the gate, which is visible.
 */
export function isIntegrationTestSource(source: string): boolean {
  // Building a path to one of the repository's own shell or PowerShell
  // scripts is the whole signal. Spawning is deliberately not required:
  // several of these suites spawn through a shared harness rather than
  // calling `Deno.Command` themselves, and requiring the direct call missed
  // four of them.
  //
  // Two idioms are in use for naming the script, and Issue #935 is what it
  // cost to recognise only the first: fourteen suites that drive `setup.sh`,
  // `volume-init.sh` and the container entrypoint stayed in the gate,
  // including one that fails on a macOS host for reasons no change of
  // theirs could affect.
  //
  // The match is on the path *construction*, never on the name alone —
  // several of these files discuss `setup.sh` in their doc comments, and
  // matching bare text would exclude unit tests that merely mention a
  // script. That asymmetry is the whole design: a false negative leaves a
  // slow test in the gate, which is visible, while a false positive stops a
  // unit test running on every change, which nobody would notice.
  return INTEGRATION_SOURCE_PATTERNS.some((pattern) => pattern.test(source));
}

/** Path constructions that name a repository script. */
const INTEGRATION_SOURCE_PATTERNS: readonly RegExp[] = [
  // `${REPO_ROOT}/setup.sh`, and the shared harnesses built on it.
  /REPO_ROOT[^\n]*\.(sh|ps1)/,
  // `new URL("../../../setup.sh", import.meta.url)`.
  /new URL\(\s*"[^"\n]*\.(sh|ps1)"/,
];

/** The `--ignore` value for the gate's `deno test` invocation. */
export function integrationTestIgnoreArg(
  files: readonly string[] = INTEGRATION_TEST_FILES,
): string {
  return files.join(",");
}
