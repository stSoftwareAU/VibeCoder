/**
 * Test files that cannot run under `deno test --parallel` (Issue #940).
 *
 * The gate's `deno test` stage ran sequentially and took 42+ minutes on a
 * 10-core host against a 45-minute phase budget, so issues died in
 * `quality_gate` having changed nothing wrong (#805 twice, #808).
 * `--parallel` takes the same suite to 2m23s — an 18x win that could not be
 * taken, because parallel workers share one process environment and a test
 * that mutates it races whatever else is running:
 *
 * ```ts
 * // container_entrypoint_test.ts
 * Deno.env.set("VIBE_SCRATCH_DIR", hostScratch);
 * ```
 *
 * (The example has now moved twice. It was `commit_and_push_pending_test.ts`
 * setting `VIBE_RUN_ID` until #963 gave the run id an explicit parameter, then
 * `prompt_manager_test.ts` setting `VIBE_BASE_DIR` until #968 gave
 * `getPromptsDir` an injected environment lookup — which is the whole point of
 * the list going down.)
 *
 * Measured with `DENO_JOBS=4`: 48 failures, of which 32 were the pre-existing
 * pwsh failures and ~16 were genuine races.
 *
 * Issue #880 capped that debt so it could not grow. This module takes most of
 * the prize without waiting for the debt to be paid: the list moves out of the
 * test file and into a manifest the gate can read, so the unit suite runs in
 * two passes — everything not listed here under `--parallel`, then these files
 * serially, where mutating the process environment is safe again.
 *
 * Two corrections to #880's baseline had to come first, because a split that
 * rests on a wrong list is a gate that goes red on somebody else's change.
 *
 * The first: #880 grepped each suite's own source and stopped there.
 * `tests/support/repo_prompts.ts` deletes the prompt-directory variables and
 * calls `Deno.chdir(REPO_ROOT)` **at module scope**, so importing it is the
 * mutation; 35 suites import it and 33 of those contain no mutation of their
 * own. `tests/support/env.ts` is the second such helper. Following imports
 * across the `tests/` tree, and matching `Deno.env.delete` as well, takes the
 * list from 92 files to 135 — 43 suites that were already unsafe and would
 * have gone straight into the parallel pass. 39 of the 43 are hidden behind a
 * helper; the other 4 delete a variable rather than setting one.
 *
 * There turned out to be a second reason a file cannot share a machine, and
 * the first `--parallel` trial found it: six failures were ReDoS guards whose
 * budgets are wall-clock, beaten by their own workers rather than by any
 * change. {@link WALL_CLOCK_TEST_FILES} carries those. A third, narrower
 * reason showed up in the trial after: two suites that spawn something real —
 * a container runtime, `run.sh` — and then race it, which nine competing
 * workers win. {@link SUBPROCESS_TIMING_TEST_FILES} carries those two, with
 * the measurement that put them there.
 *
 * {@link PARALLEL_UNSAFE_TEST_FILES} is the union the gate actually ignores.
 *
 * Neither list is its own classification — {@link mutatesProcessState} and
 * {@link measuresWallClock} are. `parallel_safety_cap_test.ts` and
 * `parallel_unsafe_test_manifest_test.ts` fail when a list and its classifier
 * disagree in either direction, so a new mutator cannot quietly join the
 * parallel pass and a file that was cleaned up cannot linger in the serial one
 * (the trap a stale `HOME_WORKDIR_ALLOWLIST` entry sprang on #805 and again on
 * #808).
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

/**
 * Test files that mutate process-wide state (`Deno.env.set`, `Deno.chdir`).
 *
 * Paths are relative to `worker/deno`, the directory the gate runs
 * `deno test` from — the same convention as `INTEGRATION_TEST_FILES`.
 *
 * This list may **shrink, never grow** — with one exception, which is what
 * took it from 92 entries to 135 at the time it was written: correcting
 * the classifier. #880 grepped
 * each suite's own text, so a helper's mutation was invisible to every suite
 * that imported it. Forty-three files were already unsafe and are now named.
 * A new *test* still may not join them.
 *
 * To remove a file, take the value as a
 * parameter or an injected seam instead of mutating the process — most of the
 * code under test already accepts an `env` function for exactly this reason
 * (see `HostDiskMonitor`, `resolveDiskFloors`, `findIssuesByLabel`). Each file
 * removed is one more file that runs in the fast pass.
 */
export const PROCESS_STATE_MUTATOR_TEST_FILES: readonly string[] = [
  "tests/best_practices_bucket_guides_consumer_test.ts",
  "tests/boy_scout_idle_tasks_test.ts",
  "tests/check_jenkins_access_command_test.ts",
  "tests/ci_failure_issue_test.ts",
  "tests/ci_log_provider_test.ts",
  "tests/ci_provider_jenkins_target_url_test.ts",
  "tests/container_image_hash_test.ts",
  "tests/container_image_provider_set_test.ts",
  "tests/create_all_idle_task_wrappers_command_test.ts",
  "tests/create_all_idle_task_wrappers_test.ts",
  "tests/default_branch_cache_test.ts",
  "tests/env_stub_test.ts",
  "tests/fetch_jenkins_log_command_test.ts",
  "tests/grill_me_run_stats_test.ts",
  "tests/idle_task_body_preview_limit_test.ts",
  "tests/idle_task_end_to_end_test.ts",
  "tests/idle_task_multi_worker_end_to_end_test.ts",
  "tests/idle_task_template_test.ts",
  "tests/jenkins_log_fetcher_test.ts",
  "tests/maybe_file_idle_task_test.ts",
  "tests/optional_feature_env_test.ts",
  "tests/outbound_fetch_bounds_test.ts",
  "tests/phase_run_stats_test.ts",
  "tests/planning_run_stats_test.ts",
  "tests/pr_failure_actions_test.ts",
  "tests/quorum_run_stats_test.ts",
  "tests/raise_all_idle_tasks_command_test.ts",
  "tests/raise_all_idle_tasks_test.ts",
  "tests/raise_boy_scout_idle_tasks_command_test.ts",
  "tests/raise_single_idle_task_test.ts",
  "tests/run_mode_test.ts",
  "tests/worker_cache_dir_test.ts",
];

/**
 * Test files that assert on a real elapsed wall-clock reading (Issue #940).
 *
 * The first `--parallel` trial of the split suite came back with eight
 * failures, and six of them were these:
 *
 * ```text
 * 500k alphanumeric run took 4936ms (budget 3000ms)
 * oversized input took 3022 ms (budget 2000 ms)
 * PEM-body near-miss run took 4656 ms (budget 2000 ms)
 * 256 KiB blob took 2557 ms (budget 2000 ms)
 * alphanumeric run: 16384 chars took 48 ms but 65536 chars (4.0x) took
 *   640 ms, over the 381 ms a linear rule allows
 * ```
 *
 * None is a race and none is a bug in the code under test. They are ReDoS
 * guards, and a ReDoS guard measures how long real work takes. Ten workers on
 * a ten-core host means the work takes longer, so the budget blows — and the
 * ratio assertions are no safer, because the two readings
 * `assertLinearGrowth` compares are taken at different contention levels.
 *
 * Intermittent red on unrelated work is the worst outcome a gate can have: it
 * teaches everyone to re-run rather than read the result. So these join the
 * serial pass, where the machine is theirs and the measurement means what it
 * says.
 *
 * The asymmetry here runs the opposite way to the integration manifest, and
 * that is why {@link measuresWallClock} can afford to be broad. A file wrongly
 * listed still runs, a second or two later than it might have. A file wrongly
 * left out goes red one run in five, on somebody else's change.
 */
export const WALL_CLOCK_TEST_FILES: readonly string[] = [
  "tests/agent_mcp_config_test.ts",
  "tests/agent_progress_test.ts",
  "tests/agent_provider_per_invocation_test.ts",
  "tests/agent_run_termination_test.ts",
  "tests/agent_transcript_test.ts",
  "tests/claude_runner_agent_binary_path_959_test.ts",
  "tests/claude_runner_check_interval_4295_test.ts",
  "tests/claude_runner_external_progress_508_test.ts",
  "tests/claude_runner_invalid_session_id_204_test.ts",
  "tests/claude_runner_invocation_budget_3648_test.ts",
  "tests/claude_runner_kill_bound_test.ts",
  "tests/claude_runner_killed_test.ts",
  "tests/claude_runner_model_unavailable_fallback_test.ts",
  "tests/claude_runner_oom_terminal_test.ts",
  "tests/claude_runner_progress_extension_4296_test.ts",
  "tests/claude_runner_rate_limit_fallback_test.ts",
  "tests/claude_runner_stdin_prompt_test.ts",
  "tests/claude_runner_test.ts",
  "tests/claude_runner_usage_limit_test.ts",
  "tests/claude_token_budget_test.ts",
  "tests/fable_globally_disabled_cycle_test.ts",
  "tests/fable_preflight_deepseek_gate_test.ts",
  "tests/fable_preflight_provider_gate_test.ts",
  "tests/fable_preflight_reroute_wiring_test.ts",
  "tests/growth_bound_test.ts",
  "tests/orphan_deps_suppression_scan_bounds_test.ts",
  "tests/orphan_deps_suppression_scan_cap_test.ts",
  "tests/orphan_deps_suppression_scan_caps_test.ts",
  "tests/orphan_deps_suppression_scan_test.ts",
  "tests/prompt_delimiter_test.ts",
  "tests/quorum_orchestrator_test.ts",
  "tests/regex_complexity_3942_test.ts",
  "tests/regex_complexity_dos_test.ts",
  "tests/regex_dos_3942_test.ts",
  "tests/run_ps1_launcher_test.ts",
  "tests/secret_redaction_bounds_test.ts",
  "tests/secret_redaction_redos_test.ts",
  "tests/secret_transform_redaction_test.ts",
  "tests/timeout_extension_report_768_test.ts",
  "tests/timeout_extension_telemetry_4298_test.ts",
];

/**
 * Whether `source` asserts on a real elapsed wall-clock reading.
 *
 * Two shapes count. Reading a real clock (`performance.now()`, `Date.now()`)
 * and comparing the elapsed value to a bound is the obvious one. Using the
 * repository's own `assertLinearGrowth` helper is the other, and it has to be
 * matched separately because the helper does the timing — the test file that
 * calls it never touches a clock itself, which is exactly how
 * `secret_redaction_bounds_test.ts` was missed on the first pass.
 *
 * A domain "budget" — tokens, spend, a phase deadline against an injected
 * clock — is not matched, and should not be: those are the tests that took
 * the seam instead of the stopwatch.
 */
export function measuresWallClock(source: string): boolean {
  const code = stripComments(source);
  if (GROWTH_HELPER.test(code)) return true;
  if (REAL_DEADLINE_RUN.test(code) && REAL_DEADLINE_ARG.test(code)) return true;
  return REAL_CLOCK.test(code) && ELAPSED_BOUND.test(code);
}

/**
 * Driving the real runner, which is the other way to depend on the clock.
 *
 * `runClaudeWithTimeout` spawns a stub and enforces `timeoutSeconds` and
 * `killAfterSeconds` against the wall clock, so the suite is asserting what
 * happens inside a real one- to four-second window. Nothing in it reads a
 * clock itself, so neither of the other two shapes sees it.
 *
 * Issue #959 is why this is here. It drained eleven `claude_runner_*` suites
 * off `Deno.env`, which is exactly the right fix and moved them out of the
 * mutator list — straight into the parallel pass, where a one-second budget
 * shared with nine workers is not a test but a coin toss. Both halves of the
 * signal are required: naming `timeoutSeconds` in a config object a test
 * merely inspects is not running against it.
 */
const REAL_DEADLINE_RUN = /await runClaudeWith(Timeout|Retry)\(/;

/** The deadline arguments that make such a run wall-clock bound. */
const REAL_DEADLINE_ARG = /\b(timeoutSeconds|killAfterSeconds)\s*:/;

/**
 * The shared ratio helper, which does its callers' timing for them.
 *
 * Matched on the **import or the call**, never on the name alone. Issue #943
 * added a suite that reads `support/growth.ts` with `Deno.readTextFile` to
 * assert the audit prompt and the helper agree; matching the bare path
 * claimed it, and a test that never starts a clock does not need the serial
 * pass. Same asymmetry as the integration classifier: match the use, not the
 * mention.
 */
const GROWTH_HELPER =
  /from\s+"[^"\n]*support\/growth\.ts"|assertLinearGrowth\(/;

/** A reading of the real clock. */
const REAL_CLOCK = /performance\.now\(\)|Date\.now\(\)/;

/**
 * An elapsed value compared against a bound.
 *
 * The bound is any number, not only a millisecond-scale one. Issue #959
 * drained the `claude_runner_*` suites off `Deno.env`, which moved them out
 * of the mutator list and would have put them in the parallel pass — and they
 * assert `elapsedSeconds < 4` on a real `Date.now()` delta. A three-digit
 * minimum read that as "not a budget"; four seconds of slack shared with nine
 * other workers is the tightest budget in the tree.
 */
const ELAPSED_BOUND =
  /(took|elapsed|duration|spent|ms)\w*\s*<\s*[0-9_]+|<\s*[A-Z_]*BUDGET/;

/**
 * Test files that race a real subprocess against the clock (Issue #940).
 *
 * The other two categories are classifier-backed, because the signal is in
 * the source. These two were found by running the split and reading what
 * broke, and no honest regex claims them: what makes them unsafe is that they
 * spawn something real and then depend on it being scheduled promptly.
 *
 * Both failed under `--parallel` and passed in the same sequential run, so
 * the entry carries the measurement rather than a hunch. A reason is required
 * for the same purpose it is in `SCRIPT_READING_UNIT_TESTS`: an exemption
 * nobody had to justify is an exemption nobody can retire.
 */
export const SUBPROCESS_TIMING_TEST_FILES: ReadonlyMap<string, string> =
  new Map([
    [
      "tests/container_containment_test.ts",
      "builds a real container and bounds `<runtime> volume create` with " +
      "QUERY_TIMEOUT_MS; under --parallel the create timed out in both " +
      "trials (`Could not create the throwaway volume …`, 30s), and passed " +
      "in the sequential run between them",
    ],
    [
      "tests/launcher_signal_readiness_test.ts",
      "spawns run.sh and signals it inside a deliberately narrow readiness " +
      "window (STUB_READY_DELAY); its own doc records a descheduled CI " +
      "runner losing exactly that race, and nine competing workers " +
      "deschedule it reliably (`the image was never built`)",
    ],
  ]);

/**
 * Every file that must stay out of the parallel pass.
 *
 * Three reasons, one list: a file that mutates shared process state races the
 * other workers, a file that measures wall-clock is beaten by them, and a
 * file that races a real subprocess loses when nine of them are competing for
 * the scheduler. All three run in the serial pass, so the gate needs the
 * union and nothing else.
 */
export const PARALLEL_UNSAFE_TEST_FILES: readonly string[] = [
  ...new Set([
    ...PROCESS_STATE_MUTATOR_TEST_FILES,
    ...WALL_CLOCK_TEST_FILES,
    ...SUBPROCESS_TIMING_TEST_FILES.keys(),
  ]),
].sort();

/**
 * Whether `source` mutates process-wide state.
 *
 * `Deno.env.set`, `Deno.env.delete` and `Deno.chdir` all write state shared
 * by every parallel worker in the process, so a file that calls any of them
 * cannot be in the parallel pass. Reading the environment is fine and
 * deliberately not matched.
 *
 * `delete` was missing from the #880 spelling, and four suites reach a
 * mutation only through it — `tests/support/repo_prompts.ts`, the helper
 * that hid 33 more, opens by deleting the prompt-directory variables.
 *
 * This is the leaf predicate. {@link reachesInTestGraph} is what the
 * manifests are actually built from, because a helper's mutation belongs to
 * every test that imports it.
 */
/**
 * `source` with its comments removed (Issue #940).
 *
 * Both classifiers match source text, and prose is not code. Issue #956
 * drained `config_test.ts` and friends by giving `lib/config.ts` an injected
 * env lookup, and the helper it handed them opens:
 *
 * ```ts
 * // The replacement for `Deno.env.set`: a test that needs a module to see …
 * ```
 *
 * Matching that sentence claimed 40-odd suites whose whole point is that they
 * no longer mutate anything, and the drain would then have run forever
 * without ever moving a file into the fast pass. Naming a pattern in order to
 * say "do not do this" must not count as doing it.
 *
 * Block comments go whole. Line comments go only where the `//` does not
 * follow a colon, so a `https://` inside a string literal is not mistaken for
 * one — losing the rest of that line is the dangerous direction, because it
 * could hide a real mutation.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

export function mutatesProcessState(source: string): boolean {
  return /Deno\.env\.(set|delete)|Deno\.chdir/.test(stripComments(source));
}

/**
 * Whether `entry` reaches `matches` through its own source or a helper it
 * imports (Issue #940).
 *
 * A predicate applied to one file's own text stops at the file, and the
 * 92-entry baseline it produced was short by 43.
 * `tests/support/repo_prompts.ts` deletes every prompt-directory variable and
 * calls `Deno.chdir(REPO_ROOT)` **at module scope**, so merely importing it
 * mutates the process; 35 suites import it and 33 of them
 * contain no mutation of their own. Under `--parallel` those 33 would
 * have moved the working directory out from under nine other workers, which
 * is the intermittent red the whole split exists to avoid.
 *
 * The walk stops at the `tests/` boundary on purpose. A shared harness under
 * `tests/support/` is part of the test that imports it. `lib/` is the code
 * under test, and following into it claims 806 of the 1,197 suites — mostly
 * because some function they can reach is *able* to set a variable, not
 * because anything does. That is not a classification, it is a surrender.
 *
 * Pure over an injected source map so it can be tested without a fixture
 * tree, and so the conformance tests and the gate agree by construction.
 */
export function reachesInTestGraph(
  entry: string,
  sources: ReadonlyMap<string, string>,
  matches: (source: string) => boolean,
): boolean {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const source = sources.get(current);
    if (source === undefined) continue;
    if (matches(source)) return true;
    for (const specifier of relativeImports(source)) {
      const resolved = resolveFrom(current, specifier);
      // Stay inside the test tree: see the note above.
      if (resolved.startsWith("tests/")) pending.push(resolved);
    }
  }
  return false;
}

/** The relative specifiers `source` imports, static and dynamic. */
export function relativeImports(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/from\s+"(\.[^"\n]+)"/g)) {
    found.push(match[1]!);
  }
  for (const match of source.matchAll(/import\(\s*"(\.[^"\n]+)"/g)) {
    found.push(match[1]!);
  }
  return found;
}

/** `tests/a/b.ts` + `../c.ts` → `tests/c.ts`. */
export function resolveFrom(from: string, specifier: string): string {
  const dir = from.slice(0, from.lastIndexOf("/"));
  const segments: string[] = [];
  for (const part of `${dir}/${specifier}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}

/**
 * The `--ignore` value that keeps these files out of the parallel pass.
 *
 * Matches `integrationTestIgnoreArg()` so the two manifests compose into one
 * `--ignore` argument.
 */
export function parallelUnsafeIgnoreArg(
  files: readonly string[] = PARALLEL_UNSAFE_TEST_FILES,
): string {
  return files.join(",");
}
