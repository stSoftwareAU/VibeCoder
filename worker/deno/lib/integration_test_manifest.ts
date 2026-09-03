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
  "tests/launcher_parity_test.ts",
  "tests/loop_supervisor_test.ts",
  "tests/run_ps1_launcher_test.ts",
  "tests/run_sh_launcher_test.ts",
  "tests/run_sh_upgrade_test.ts",
  "tests/setup_parity_test.ts",
];

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
  // Referencing one of the repository's own shell or PowerShell scripts is
  // the whole signal. Spawning is deliberately not required: several of these
  // suites spawn through a shared harness rather than calling `Deno.Command`
  // themselves, and requiring the direct call missed four of them.
  return /REPO_ROOT[^\n]*\.(sh|ps1)/.test(source);
}

/** The `--ignore` value for the gate's `deno test` invocation. */
export function integrationTestIgnoreArg(
  files: readonly string[] = INTEGRATION_TEST_FILES,
): string {
  return files.join(",");
}
