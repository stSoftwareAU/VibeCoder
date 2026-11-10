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
 * Measured with `DENO_JOBS=4`: 48 failures, ~16 of them genuine races. The
 * remainder were attributed to "the pre-existing pwsh failures". #971
 * re-measured that half on a host with PowerShell installed and found 18
 * test-side defects rather than 32 standing failures — a resolver bug in
 * `setup_ps1_test.ts` and two tests timing themselves — all fixed in #988.
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
 * workers win. {@link SUBPROCESS_TIMING_TEST_FILES} carries these suites, with
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
 */ /**
 * Test files that mutate process-wide state (`Deno.env.set`, `Deno.chdir`).
 *
 * Paths are relative to `worker/deno`, the directory the gate runs
 * `deno test` from — the same convention as `INTEGRATION_TEST_FILES`.
 *
 * This list may **shrink, never grow** — with one exception, which is what
 * took it from 92 entries to 135 at the time it was written: correcting
 * the classifier. #880 grepped
 * each suite's own text, so a helper's mutation was invisible to every suite
 * that imported it. Forty-three files were already unsafe and were named
 * then; the list has since been emptied (below).
 * A new *test* still may not join them.
 *
 * To remove a file, take the value as a
 * parameter or an injected seam instead of mutating the process — most of the
 * code under test already accepts an `env` function for exactly this reason
 * (see `HostDiskMonitor`, `resolveDiskFloors`, `findIssuesByLabel`). Each file
 * removed is one more file that runs in the fast pass.
 *
 * **It is now empty, and #944/#969 are done for this category.** The last
 * seven entries were all CI-log suites, and Issue #986 cleared them in one
 * step rather than by migration: four were the tests of an integration that
 * left the repository, and the other three read a vendor's credentials out
 * of the process environment only because they drove that vendor's client.
 * Driving the provider registry with a fake provider needs no credentials at
 * all, so the mutation had nothing left to do.
 *
 * An empty list is not an invitation. The classifier below still runs over
 * every suite, so a new mutator fails `parallel_safety_cap_test.ts` naming
 * itself, and re-adding an entry here to silence it is the thing this list
 * exists to prevent.
 */ export const PROCESS_STATE_MUTATOR_TEST_FILES = [];
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
 * Two entries left, and neither of them is a `claude_runner_*` suite any
 * more. The twenty-five that were took a clock instead (`lib/clock.ts`):
 * `RunClaudeOptions.clock` is what the runner reads time and arms its
 * watchdogs through, so a test drives the deadline rather than sleeping
 * through it. That was 108 s of the serial pass spent asleep against real
 * one- to four-second windows, and — the reason it had to go rather than
 * merely being slow — a watchdog woken late by a busy host reads exactly
 * like a watchdog that did not fire, which is how `claude_runner_kill_bound`
 * and `claude_runner_progress_extension_4296` produced four of PR #1170's
 * own failures. What is left genuinely measures: `growth_bound_test.ts` is
 * the ratio helper's own suite, whose last case has to time real quadratic
 * work on a real clock or it is testing nothing, and
 * `run_ps1_launcher_test.ts` times a launcher watchdog against a container
 * it spawns for real.
 *
 * The serial pass is not a cure, only a smaller dose, and PR #1170 is where
 * that ran out. Twelve ReDoS and scan-bound suites sat here and still went red
 * on `main`: an absolute millisecond budget reports a host 8% slower as a
 * correctness error, and the ratio assertion that replaced it read 30 ms
 * against 355 ms on a loaded laptop for work that is perfectly linear. A fleet
 * of unlike machines under unlike loads has no budget and no ratio that means
 * the same thing twice. All twelve now assert on what the code **produces**
 * for the same adversarial input — a super-linear pattern at those sizes never
 * returns, so the runner's own timeout is the detector — and they left this
 * list for the parallel pass. What remains here genuinely races a real clock:
 * the growth helper's own tests, a launcher watchdog timed against a real
 * container, and `plan_coverage_gate_bounds_1245_test.ts`, whose pattern
 * costs about twelve seconds on the largest input GitHub will accept — slow
 * enough to stall a planning close, but not slow enough to hang a test, so
 * the behavioural form has nothing to detect and the ratio is the only signal
 * (Issue #1245).
 *
 * The asymmetry here runs the opposite way to the integration manifest, and
 * that is why {@link measuresWallClock} can afford to be broad. A file wrongly
 * listed still runs, a second or two later than it might have. A file wrongly
 * left out goes red one run in five, on somebody else's change.
 */ export const WALL_CLOCK_TEST_FILES = [
  // Continuation-joining growth guard compares N and 4N without contention.
  "tests/ci_mutation_contract_test.ts",
  // The admin-only hand-off strips code fences and inline code spans from an
  // untrusted issue body before matching; only a growth measurement separates
  // that linear strip from a backtracking one on hostile backtick runs
  // (Issue #3295).
  "tests/admin_only_finding_test.ts",
  // The issue-routing classifier matches worker, product and marker patterns
  // against an untrusted issue body; only a growth measurement separates
  // those linear patterns from a backtracking one on hostile runs (#3741).
  "tests/issue_routing_classifier_test.ts",
  // The title normaliser runs a pattern over an untrusted draft title; only a
  // growth measurement separates it from a backtracking one (#3742).
  "tests/issue_routing_github_test.ts",
  // The closure-block render scans an agent-authored summary line by line for
  // the two review headings; only a growth measurement separates that scan
  // from the ambiguous `\s*:?\s*$` tail it deliberately does not copy (#2242).
  "tests/closure_verdict_test.ts",
  // The met-closure criterion extraction strips trailing separators from an
  // agent-written PR-summary entry with a backwards scan; only a growth
  // measurement (assertLinearGrowth) separates that linear strip from a
  // backtracking trailing-run regex (Issue #3766).
  "tests/closure_met_check_3766_test.ts",
  // The described-code-change path scan returns the right answer on a long
  // hostile line, only quadratically slowly — so only growth can pin it (#2826).
  "tests/described_code_change_test.ts",
  // The paired run-result scan reads a PR-summary line an agent writes; only
  // a growth measurement separates its linear separator scan from a
  // backtracking regex (Issue #3381).
  "tests/test_plan_recount_red_on_base_3381_test.ts",
  // The Test Plan recount reads agent-written prose for partial additions and
  // "now has N" totals; only a growth measurement separates its linear
  // scans from a quadratic one on a long hostile line (Issue #3740).
  "tests/test_plan_recount_partial_3740_test.ts",
  // The "Added N tests to `file`" partial-addition pattern reads agent-written
  // Test Plan prose; only a growth measurement separates its linear scan from
  // a backtracking one on a long hostile line (Issue #3983).
  "tests/test_plan_recount_added_n_to_3983_test.ts",
  // The change-request quote extractor scans reviewer-written text; only a
  // growth measurement separates its linear hand-written scanners from a
  // backtracking regex (#3244).
  "tests/change_request_quotes_3244_test.ts",
  // The cross-file anchor link scanner reads every docs Markdown line; only a
  // growth measurement separates its linear inline-link and code-span
  // patterns from the quadratic link regex it replaced (Issue #3337).
  "tests/cross_file_anchors_test.ts",
  // The grill-me stem strip walks a run of trailing punctuation an untrusted
  // commenter chooses the length of; only a growth measurement separates the
  // linear walk from the quadratic regex it replaced (#2183).
  "tests/grill_me_stall_guard_bounds_2183_test.ts",
  // The failure-category catch-all scans an untrusted run failure message (it
  // can quote agent-written PR-summary text); only a growth measurement
  // separates the linear `Error:(?!:)` test from a backtracking one
  // (Issue #3431).
  "tests/failure_diagnosis_bounds_3431_test.ts",
  // The transcript tee checks every string of a model-written stream-json
  // line against the raw redaction; only a growth measurement separates the
  // single forward cursor from a rescan per string (Issue #3826).
  "tests/agent_transcript_growth_3826_test.ts",
  "tests/growth_bound_test.ts",
  "tests/plan_coverage_gate_bounds_1245_test.ts",
  // The pre-commit safety gate's dotenv/config/secrets patterns scan a staged
  // path an untrusted commit can shape; only a growth measurement separates
  // the fixed, linear patterns from the quadratic ones they replaced
  // (Issue #3311).
  "tests/pre_commit_safety_test.ts",
  // The prompt-leak matcher scans one unbroken block per phrase, and only a
  // growth measurement can tell a linear scan from a quadratic one (#1463).
  // The PR-body tier-marker finder scans an untrusted PR body for an
  // unterminated marker prefix; only a growth measurement separates its linear
  // scan from a backtracking one (Issue #3403).
  "tests/pr_body_test.ts",
  "tests/prompt_leak_redaction_test.ts",
  // The result-placeholder gate's suffix and result-line regexes scan an
  // agent-written PR summary or reply, steered by an untrusted issue body;
  // only a growth measurement separates their linear scans from a quadratic
  // one (Issue #3248).
  "tests/result_placeholder_gate_test.ts",
  "tests/run_ps1_launcher_test.ts",
  // The not-planned-refs issue/hunk scanners read an untrusted PR body and
  // diff hunk; only a growth measurement separates their linear scans from
  // the quadratic patterns they replaced (Issue #3223).
  "tests/milestone_not_planned_refs_test.ts",
  // The rustc toolchain-gap detector reads agent-controlled cargo output
  // line by line; only a growth measurement separates its capped, anchored
  // scans from a backtracking pattern (Issue #3255).
  "tests/milestone_merge_gate_test.ts",
  // The per-repo sub-issue ref parser merges pages built from a hostile
  // `repository_url`; only a growth measurement separates its linear scan
  // from a backtracking one (Issue #3319).
  "tests/native_sub_issue_refs_test.ts",
  // The shared Markdown code-span splitter pairs backtick runs in untrusted
  // issue bodies and PR summaries; only a growth measurement separates its
  // linear pairing from the quadratic forward scan it replaced (Issue
  // #3313).
  "tests/markdown_code_spans_test.ts",
  // The release path's line-anchored clone-corrupt-repeat regex scans setup
  // failure messages that quote git output; only a growth measurement
  // separates it from a backtracking one (Issue #3446).
  "tests/clone_corrupt_repeat_growth_3446_test.ts",
  // The mutation runner's import-specifier scan reads test sources a PR
  // author writes; only a growth measurement separates its linear scan of an
  // unclosed specifier from a backtracking one (Issue #3393).
  "tests/mutation_runner_test.ts",
  // The shared Markdown logical-unit splitter groups the lines of untrusted
  // PR summaries; only a growth measurement separates its single linear pass
  // from a rescan per line (Issue #3356).
  "tests/markdown_logical_units_3356_test.ts",
  // The flowchart mixed-label scan walks agent-written Markdown a character
  // at a time; only a growth measurement separates that linear scan from a
  // backtracking one on hostile opener runs (Issue #3769).
  "tests/mermaid_validator_growth_3769_test.ts",
  // The security-fix gate's cited-test parsing scans diff lines an agent
  // (steered by an untrusted issue body) writes; only a growth measurement
  // separates its linear declaration scan from a backtracking one on an
  // unclosed quote run (Issue #3659).
  "tests/security_fix_gate_growth_test.ts",
  // The caller checks' definition and diff-header regexes run over untrusted
  // source lines and diffs; only a growth measurement separates their linear
  // patterns from a backtracking one (Issue #3779).
  "tests/caller_checks_3779_test.ts",
  // The egress allowlist validator matches host patterns against untrusted
  // config entries; only a growth measurement separates those linear
  // patterns from a backtracking one on hostile runs (#4045).
  "tests/egress_allowlist_test.ts",
  // A grandchild that holds the output pipes must not hold the call past its
  // timeout; only the elapsed time against the timeout shows the pipes were
  // cancelled rather than drained (Issue #4247).
  "tests/subprocess_timeout_test.ts",
  // Real SIGTERM-ignoring children exercise bounded kill completion at the
  // chokepoints; keep their elapsed assertions out of the parallel pass.
  "tests/subprocess_deadline_4247_test.ts",
  // The prose-scope lexer scans source a pull request changes. Only a growth
  // measurement separates its character loop from a super-linear one on a
  // long line of open brackets and quotes (Issue #4234).
  "tests/doc_prose_scope_lexer_test.ts"
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
 */ export function measuresWallClock(source) {
  const code = stripComments(source);
  if (GROWTH_HELPER.test(code)) return true;
  if (drivesRealDeadline(code)) return true;
  return REAL_CLOCK.test(code) && ELAPSED_BOUND.test(code);
}
/**
 * Whether any `runClaudeWith*` call in `code` sets a deadline and leaves it
 * on the real clock.
 *
 * Per call site, not per file. The first spelling asked only whether the
 * file mentioned a run *somewhere* and a deadline argument *somewhere*,
 * which was the right question while the only clock was the real one. Now
 * that `RunClaudeOptions.clock` exists, "a run with `timeoutSeconds`" and "a
 * run that will actually sleep for a second" are different facts, and only
 * the second belongs in the serial pass — so the arguments of each call are
 * read together with the call.
 *
 * A call whose options arrive through a spread cannot be read at its own
 * site, so it falls back to the file-wide question the first spelling asked:
 * a deadline named anywhere and no clock named anywhere is a real deadline.
 * The asymmetry runs the safe way — a file wrongly listed runs a second
 * later than it might, a file wrongly cleared goes red one run in five on
 * somebody else's change.
 */ function drivesRealDeadline(code) {
  for (const match of code.matchAll(REAL_DEADLINE_RUN)){
    const open = (match.index ?? 0) + match[0].length - 1;
    const args = balancedArgumentText(code, open);
    if (args === undefined) continue;
    const scope = SPREAD_ARG.test(args) ? code : args;
    if (!REAL_DEADLINE_ARG.test(scope)) continue;
    if (INJECTED_CLOCK_ARG.test(scope)) continue;
    return true;
  }
  return false;
}
/**
 * The text between the parenthesis at `openIndex` and its match.
 *
 * Nested brackets are balanced and string literals skipped, so a `)` inside
 * a prompt or a regex cannot end the argument list early. `undefined` when
 * the parenthesis never closes, which only a truncated source can produce.
 */ function balancedArgumentText(code, openIndex) {
  let depth = 0;
  let quote;
  for(let i = openIndex; i < code.length; i++){
    const char = code[i];
    if (quote !== undefined) {
      if (char === "\\") i++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") {
      depth--;
      if (depth === 0) return code.slice(openIndex + 1, i);
    }
  }
  return undefined;
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
 */ const REAL_DEADLINE_RUN = /runClaudeWith(?:Timeout|Retry)\(/g;
/** The deadline arguments that make such a run wall-clock bound. */ const REAL_DEADLINE_ARG = /\b(timeoutSeconds|killAfterSeconds)\s*:/;
/**
 * The seam that takes the deadline off the wall clock.
 *
 * `RunClaudeOptions.clock` (`lib/clock.ts`) is what the runner reads time
 * and arms its timers through, so a run that names one expires when the test
 * advances it and never a moment before. The suite then measures nothing,
 * sleeps for nothing, and belongs in the parallel pass with everything else.
 */ const INJECTED_CLOCK_ARG = /\bclock\s*[:,}]/;
/**
 * Options handed in through a spread, which the call site cannot resolve.
 *
 * `claude_runner_oom_terminal_test.ts` builds one `baseOptions` carrying the
 * deadline and spreads it into four runs; reading only each call's own text
 * would clear all four. Such a call is judged on the whole file instead.
 */ const SPREAD_ARG = /\.\.\./;
/**
 * The shared ratio helper, which does its callers' timing for them.
 *
 * Matched on the **import or the call**, never on the name alone. Issue #943
 * added a suite that reads `support/growth.ts` with `Deno.readTextFile` to
 * assert the audit prompt and the helper agree; matching the bare path
 * claimed it, and a test that never starts a clock does not need the serial
 * pass. Same asymmetry as the integration classifier: match the use, not the
 * mention.
 */ const GROWTH_HELPER = /from\s+"[^"\n]*support\/growth\.ts"|assertLinearGrowth\(/;
/** A reading of the real clock. */ const REAL_CLOCK = /performance\.now\(\)|Date\.now\(\)/;
/**
 * An elapsed value compared against a bound.
 *
 * The bound is any number, not only a millisecond-scale one. Issue #959
 * drained the `claude_runner_*` suites off `Deno.env`, which moved them out
 * of the mutator list and would have put them in the parallel pass — and they
 * assert `elapsedSeconds < 4` on a real `Date.now()` delta. A three-digit
 * minimum read that as "not a budget"; four seconds of slack shared with nine
 * other workers is the tightest budget in the tree.
 */ const ELAPSED_BOUND = /(took|elapsed|duration|spent|ms)\w*\s*<\s*[0-9_]+|<\s*[A-Z_]*BUDGET/;
/**
 * Test files that race a real subprocess against the clock (Issue #940).
 *
 * The other two categories are classifier-backed, because the signal is in
 * the source. These suites were found by running the split and reading what
 * broke, and no honest regex claims them: what makes them unsafe is that they
 * spawn something real and then depend on it being scheduled promptly.
 *
 * They failed under `--parallel` and passed in the same sequential run, so
 * the entry carries the measurement rather than a hunch. A reason is required
 * for the same purpose it is in `SCRIPT_READING_UNIT_TESTS`: an exemption
 * nobody had to justify is an exemption nobody can retire.
 */ export const SUBPROCESS_TIMING_TEST_FILES = new Map([
  [
    "tests/run_core_signal_cleanup_test.ts",
    "Real SIGINT/SIGTERM entrypoint and descendant cleanup. Full --parallel pass: both tests exceeded 1s (2.38s total); isolated: 887ms and 820ms. Process startup and graceful termination contend with parallel workers. Keep every assertion in the required serial pass."
  ],
  [
    "tests/container_containment_test.ts",
    "builds a real container and bounds `<runtime> volume create` with " + "QUERY_TIMEOUT_MS; under --parallel the create timed out in both " + "trials (`Could not create the throwaway volume …`, 30s), and passed " + "in the sequential run between them"
  ],
  [
    "tests/launcher_signal_readiness_test.ts",
    "spawns run.sh and signals it inside a deliberately narrow readiness " + "window (STUB_READY_DELAY); its own doc records a descheduled CI " + "runner losing exactly that race, and nine competing workers " + "deschedule it reliably (`the image was never built`)"
  ]
]);
/**
 * Every file that must stay out of the parallel pass.
 *
 * Three reasons, one list: a file that mutates shared process state races the
 * other workers, a file that measures wall-clock is beaten by them, and a
 * file that races a real subprocess loses when nine of them are competing for
 * the scheduler. All three run in the serial pass, so the gate needs the
 * union and nothing else.
 */ export const PARALLEL_UNSAFE_TEST_FILES = [
  ...new Set([
    ...PROCESS_STATE_MUTATOR_TEST_FILES,
    ...WALL_CLOCK_TEST_FILES,
    ...SUBPROCESS_TIMING_TEST_FILES.keys()
  ])
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
 */ /**
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
 */ export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
export function mutatesProcessState(source) {
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
 */ export function reachesInTestGraph(entry, sources, matches) {
  const seen = new Set();
  const pending = [
    entry
  ];
  while(pending.length > 0){
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    const source = sources.get(current);
    if (source === undefined) continue;
    if (matches(source)) return true;
    for (const specifier of relativeImports(source)){
      const resolved = resolveFrom(current, specifier);
      // Stay inside the test tree: see the note above.
      if (resolved.startsWith("tests/")) pending.push(resolved);
    }
  }
  return false;
}
/** The relative specifiers `source` imports, static and dynamic. */ export function relativeImports(source) {
  const found = [];
  for (const match of source.matchAll(/from\s+"(\.[^"\n]+)"/g)){
    found.push(match[1]);
  }
  for (const match of source.matchAll(/import\(\s*"(\.[^"\n]+)"/g)){
    found.push(match[1]);
  }
  return found;
}
/** `tests/a/b.ts` + `../c.ts` → `tests/c.ts`. */ export function resolveFrom(from, specifier) {
  const dir = from.slice(0, from.lastIndexOf("/"));
  const segments = [];
  for (const part of `${dir}/${specifier}`.split("/")){
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
 */ export function parallelUnsafeIgnoreArg(files = PARALLEL_UNSAFE_TEST_FILES) {
  return files.join(",");
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9wYXJhbGxlbF91bnNhZmVfdGVzdF9tYW5pZmVzdC50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFRlc3QgZmlsZXMgdGhhdCBjYW5ub3QgcnVuIHVuZGVyIGBkZW5vIHRlc3QgLS1wYXJhbGxlbGAgKElzc3VlICM5NDApLlxuICpcbiAqIFRoZSBnYXRlJ3MgYGRlbm8gdGVzdGAgc3RhZ2UgcmFuIHNlcXVlbnRpYWxseSBhbmQgdG9vayA0MisgbWludXRlcyBvbiBhXG4gKiAxMC1jb3JlIGhvc3QgYWdhaW5zdCBhIDQ1LW1pbnV0ZSBwaGFzZSBidWRnZXQsIHNvIGlzc3VlcyBkaWVkIGluXG4gKiBgcXVhbGl0eV9nYXRlYCBoYXZpbmcgY2hhbmdlZCBub3RoaW5nIHdyb25nICgjODA1IHR3aWNlLCAjODA4KS5cbiAqIGAtLXBhcmFsbGVsYCB0YWtlcyB0aGUgc2FtZSBzdWl0ZSB0byAybTIzcyDigJQgYW4gMTh4IHdpbiB0aGF0IGNvdWxkIG5vdCBiZVxuICogdGFrZW4sIGJlY2F1c2UgcGFyYWxsZWwgd29ya2VycyBzaGFyZSBvbmUgcHJvY2VzcyBlbnZpcm9ubWVudCBhbmQgYSB0ZXN0XG4gKiB0aGF0IG11dGF0ZXMgaXQgcmFjZXMgd2hhdGV2ZXIgZWxzZSBpcyBydW5uaW5nOlxuICpcbiAqIGBgYHRzXG4gKiAvLyBjb250YWluZXJfZW50cnlwb2ludF90ZXN0LnRzXG4gKiBEZW5vLmVudi5zZXQoXCJWSUJFX1NDUkFUQ0hfRElSXCIsIGhvc3RTY3JhdGNoKTtcbiAqIGBgYFxuICpcbiAqIChUaGUgZXhhbXBsZSBoYXMgbm93IG1vdmVkIHR3aWNlLiBJdCB3YXMgYGNvbW1pdF9hbmRfcHVzaF9wZW5kaW5nX3Rlc3QudHNgXG4gKiBzZXR0aW5nIGBWSUJFX1JVTl9JRGAgdW50aWwgIzk2MyBnYXZlIHRoZSBydW4gaWQgYW4gZXhwbGljaXQgcGFyYW1ldGVyLCB0aGVuXG4gKiBgcHJvbXB0X21hbmFnZXJfdGVzdC50c2Agc2V0dGluZyBgVklCRV9CQVNFX0RJUmAgdW50aWwgIzk2OCBnYXZlXG4gKiBgZ2V0UHJvbXB0c0RpcmAgYW4gaW5qZWN0ZWQgZW52aXJvbm1lbnQgbG9va3VwIOKAlCB3aGljaCBpcyB0aGUgd2hvbGUgcG9pbnQgb2ZcbiAqIHRoZSBsaXN0IGdvaW5nIGRvd24uKVxuICpcbiAqIE1lYXN1cmVkIHdpdGggYERFTk9fSk9CUz00YDogNDggZmFpbHVyZXMsIH4xNiBvZiB0aGVtIGdlbnVpbmUgcmFjZXMuIFRoZVxuICogcmVtYWluZGVyIHdlcmUgYXR0cmlidXRlZCB0byBcInRoZSBwcmUtZXhpc3RpbmcgcHdzaCBmYWlsdXJlc1wiLiAjOTcxXG4gKiByZS1tZWFzdXJlZCB0aGF0IGhhbGYgb24gYSBob3N0IHdpdGggUG93ZXJTaGVsbCBpbnN0YWxsZWQgYW5kIGZvdW5kIDE4XG4gKiB0ZXN0LXNpZGUgZGVmZWN0cyByYXRoZXIgdGhhbiAzMiBzdGFuZGluZyBmYWlsdXJlcyDigJQgYSByZXNvbHZlciBidWcgaW5cbiAqIGBzZXR1cF9wczFfdGVzdC50c2AgYW5kIHR3byB0ZXN0cyB0aW1pbmcgdGhlbXNlbHZlcyDigJQgYWxsIGZpeGVkIGluICM5ODguXG4gKlxuICogSXNzdWUgIzg4MCBjYXBwZWQgdGhhdCBkZWJ0IHNvIGl0IGNvdWxkIG5vdCBncm93LiBUaGlzIG1vZHVsZSB0YWtlcyBtb3N0IG9mXG4gKiB0aGUgcHJpemUgd2l0aG91dCB3YWl0aW5nIGZvciB0aGUgZGVidCB0byBiZSBwYWlkOiB0aGUgbGlzdCBtb3ZlcyBvdXQgb2YgdGhlXG4gKiB0ZXN0IGZpbGUgYW5kIGludG8gYSBtYW5pZmVzdCB0aGUgZ2F0ZSBjYW4gcmVhZCwgc28gdGhlIHVuaXQgc3VpdGUgcnVucyBpblxuICogdHdvIHBhc3NlcyDigJQgZXZlcnl0aGluZyBub3QgbGlzdGVkIGhlcmUgdW5kZXIgYC0tcGFyYWxsZWxgLCB0aGVuIHRoZXNlIGZpbGVzXG4gKiBzZXJpYWxseSwgd2hlcmUgbXV0YXRpbmcgdGhlIHByb2Nlc3MgZW52aXJvbm1lbnQgaXMgc2FmZSBhZ2Fpbi5cbiAqXG4gKiBUd28gY29ycmVjdGlvbnMgdG8gIzg4MCdzIGJhc2VsaW5lIGhhZCB0byBjb21lIGZpcnN0LCBiZWNhdXNlIGEgc3BsaXQgdGhhdFxuICogcmVzdHMgb24gYSB3cm9uZyBsaXN0IGlzIGEgZ2F0ZSB0aGF0IGdvZXMgcmVkIG9uIHNvbWVib2R5IGVsc2UncyBjaGFuZ2UuXG4gKlxuICogVGhlIGZpcnN0OiAjODgwIGdyZXBwZWQgZWFjaCBzdWl0ZSdzIG93biBzb3VyY2UgYW5kIHN0b3BwZWQgdGhlcmUuXG4gKiBgdGVzdHMvc3VwcG9ydC9yZXBvX3Byb21wdHMudHNgIGRlbGV0ZXMgdGhlIHByb21wdC1kaXJlY3RvcnkgdmFyaWFibGVzIGFuZFxuICogY2FsbHMgYERlbm8uY2hkaXIoUkVQT19ST09UKWAgKiphdCBtb2R1bGUgc2NvcGUqKiwgc28gaW1wb3J0aW5nIGl0IGlzIHRoZVxuICogbXV0YXRpb247IDM1IHN1aXRlcyBpbXBvcnQgaXQgYW5kIDMzIG9mIHRob3NlIGNvbnRhaW4gbm8gbXV0YXRpb24gb2YgdGhlaXJcbiAqIG93bi4gYHRlc3RzL3N1cHBvcnQvZW52LnRzYCBpcyB0aGUgc2Vjb25kIHN1Y2ggaGVscGVyLiBGb2xsb3dpbmcgaW1wb3J0c1xuICogYWNyb3NzIHRoZSBgdGVzdHMvYCB0cmVlLCBhbmQgbWF0Y2hpbmcgYERlbm8uZW52LmRlbGV0ZWAgYXMgd2VsbCwgdGFrZXMgdGhlXG4gKiBsaXN0IGZyb20gOTIgZmlsZXMgdG8gMTM1IOKAlCA0MyBzdWl0ZXMgdGhhdCB3ZXJlIGFscmVhZHkgdW5zYWZlIGFuZCB3b3VsZFxuICogaGF2ZSBnb25lIHN0cmFpZ2h0IGludG8gdGhlIHBhcmFsbGVsIHBhc3MuIDM5IG9mIHRoZSA0MyBhcmUgaGlkZGVuIGJlaGluZCBhXG4gKiBoZWxwZXI7IHRoZSBvdGhlciA0IGRlbGV0ZSBhIHZhcmlhYmxlIHJhdGhlciB0aGFuIHNldHRpbmcgb25lLlxuICpcbiAqIFRoZXJlIHR1cm5lZCBvdXQgdG8gYmUgYSBzZWNvbmQgcmVhc29uIGEgZmlsZSBjYW5ub3Qgc2hhcmUgYSBtYWNoaW5lLCBhbmRcbiAqIHRoZSBmaXJzdCBgLS1wYXJhbGxlbGAgdHJpYWwgZm91bmQgaXQ6IHNpeCBmYWlsdXJlcyB3ZXJlIFJlRG9TIGd1YXJkcyB3aG9zZVxuICogYnVkZ2V0cyBhcmUgd2FsbC1jbG9jaywgYmVhdGVuIGJ5IHRoZWlyIG93biB3b3JrZXJzIHJhdGhlciB0aGFuIGJ5IGFueVxuICogY2hhbmdlLiB7QGxpbmsgV0FMTF9DTE9DS19URVNUX0ZJTEVTfSBjYXJyaWVzIHRob3NlLiBBIHRoaXJkLCBuYXJyb3dlclxuICogcmVhc29uIHNob3dlZCB1cCBpbiB0aGUgdHJpYWwgYWZ0ZXI6IHR3byBzdWl0ZXMgdGhhdCBzcGF3biBzb21ldGhpbmcgcmVhbCDigJRcbiAqIGEgY29udGFpbmVyIHJ1bnRpbWUsIGBydW4uc2hgIOKAlCBhbmQgdGhlbiByYWNlIGl0LCB3aGljaCBuaW5lIGNvbXBldGluZ1xuICogd29ya2VycyB3aW4uIHtAbGluayBTVUJQUk9DRVNTX1RJTUlOR19URVNUX0ZJTEVTfSBjYXJyaWVzIHRoZXNlIHN1aXRlcywgd2l0aFxuICogdGhlIG1lYXN1cmVtZW50IHRoYXQgcHV0IHRoZW0gdGhlcmUuXG4gKlxuICoge0BsaW5rIFBBUkFMTEVMX1VOU0FGRV9URVNUX0ZJTEVTfSBpcyB0aGUgdW5pb24gdGhlIGdhdGUgYWN0dWFsbHkgaWdub3Jlcy5cbiAqXG4gKiBOZWl0aGVyIGxpc3QgaXMgaXRzIG93biBjbGFzc2lmaWNhdGlvbiDigJQge0BsaW5rIG11dGF0ZXNQcm9jZXNzU3RhdGV9IGFuZFxuICoge0BsaW5rIG1lYXN1cmVzV2FsbENsb2NrfSBhcmUuIGBwYXJhbGxlbF9zYWZldHlfY2FwX3Rlc3QudHNgIGFuZFxuICogYHBhcmFsbGVsX3Vuc2FmZV90ZXN0X21hbmlmZXN0X3Rlc3QudHNgIGZhaWwgd2hlbiBhIGxpc3QgYW5kIGl0cyBjbGFzc2lmaWVyXG4gKiBkaXNhZ3JlZSBpbiBlaXRoZXIgZGlyZWN0aW9uLCBzbyBhIG5ldyBtdXRhdG9yIGNhbm5vdCBxdWlldGx5IGpvaW4gdGhlXG4gKiBwYXJhbGxlbCBwYXNzIGFuZCBhIGZpbGUgdGhhdCB3YXMgY2xlYW5lZCB1cCBjYW5ub3QgbGluZ2VyIGluIHRoZSBzZXJpYWwgb25lXG4gKiAodGhlIHRyYXAgYSBzdGFsZSBgSE9NRV9XT1JLRElSX0FMTE9XTElTVGAgZW50cnkgc3ByYW5nIG9uICM4MDUgYW5kIGFnYWluIG9uXG4gKiAjODA4KS5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCBzcGVsbGluZyAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbiwgZXRjLilcbiAqL1xuXG4vKipcbiAqIFRlc3QgZmlsZXMgdGhhdCBtdXRhdGUgcHJvY2Vzcy13aWRlIHN0YXRlIChgRGVuby5lbnYuc2V0YCwgYERlbm8uY2hkaXJgKS5cbiAqXG4gKiBQYXRocyBhcmUgcmVsYXRpdmUgdG8gYHdvcmtlci9kZW5vYCwgdGhlIGRpcmVjdG9yeSB0aGUgZ2F0ZSBydW5zXG4gKiBgZGVubyB0ZXN0YCBmcm9tIOKAlCB0aGUgc2FtZSBjb252ZW50aW9uIGFzIGBJTlRFR1JBVElPTl9URVNUX0ZJTEVTYC5cbiAqXG4gKiBUaGlzIGxpc3QgbWF5ICoqc2hyaW5rLCBuZXZlciBncm93Kiog4oCUIHdpdGggb25lIGV4Y2VwdGlvbiwgd2hpY2ggaXMgd2hhdFxuICogdG9vayBpdCBmcm9tIDkyIGVudHJpZXMgdG8gMTM1IGF0IHRoZSB0aW1lIGl0IHdhcyB3cml0dGVuOiBjb3JyZWN0aW5nXG4gKiB0aGUgY2xhc3NpZmllci4gIzg4MCBncmVwcGVkXG4gKiBlYWNoIHN1aXRlJ3Mgb3duIHRleHQsIHNvIGEgaGVscGVyJ3MgbXV0YXRpb24gd2FzIGludmlzaWJsZSB0byBldmVyeSBzdWl0ZVxuICogdGhhdCBpbXBvcnRlZCBpdC4gRm9ydHktdGhyZWUgZmlsZXMgd2VyZSBhbHJlYWR5IHVuc2FmZSBhbmQgd2VyZSBuYW1lZFxuICogdGhlbjsgdGhlIGxpc3QgaGFzIHNpbmNlIGJlZW4gZW1wdGllZCAoYmVsb3cpLlxuICogQSBuZXcgKnRlc3QqIHN0aWxsIG1heSBub3Qgam9pbiB0aGVtLlxuICpcbiAqIFRvIHJlbW92ZSBhIGZpbGUsIHRha2UgdGhlIHZhbHVlIGFzIGFcbiAqIHBhcmFtZXRlciBvciBhbiBpbmplY3RlZCBzZWFtIGluc3RlYWQgb2YgbXV0YXRpbmcgdGhlIHByb2Nlc3Mg4oCUIG1vc3Qgb2YgdGhlXG4gKiBjb2RlIHVuZGVyIHRlc3QgYWxyZWFkeSBhY2NlcHRzIGFuIGBlbnZgIGZ1bmN0aW9uIGZvciBleGFjdGx5IHRoaXMgcmVhc29uXG4gKiAoc2VlIGBIb3N0RGlza01vbml0b3JgLCBgcmVzb2x2ZURpc2tGbG9vcnNgLCBgZmluZElzc3Vlc0J5TGFiZWxgKS4gRWFjaCBmaWxlXG4gKiByZW1vdmVkIGlzIG9uZSBtb3JlIGZpbGUgdGhhdCBydW5zIGluIHRoZSBmYXN0IHBhc3MuXG4gKlxuICogKipJdCBpcyBub3cgZW1wdHksIGFuZCAjOTQ0LyM5NjkgYXJlIGRvbmUgZm9yIHRoaXMgY2F0ZWdvcnkuKiogVGhlIGxhc3RcbiAqIHNldmVuIGVudHJpZXMgd2VyZSBhbGwgQ0ktbG9nIHN1aXRlcywgYW5kIElzc3VlICM5ODYgY2xlYXJlZCB0aGVtIGluIG9uZVxuICogc3RlcCByYXRoZXIgdGhhbiBieSBtaWdyYXRpb246IGZvdXIgd2VyZSB0aGUgdGVzdHMgb2YgYW4gaW50ZWdyYXRpb24gdGhhdFxuICogbGVmdCB0aGUgcmVwb3NpdG9yeSwgYW5kIHRoZSBvdGhlciB0aHJlZSByZWFkIGEgdmVuZG9yJ3MgY3JlZGVudGlhbHMgb3V0XG4gKiBvZiB0aGUgcHJvY2VzcyBlbnZpcm9ubWVudCBvbmx5IGJlY2F1c2UgdGhleSBkcm92ZSB0aGF0IHZlbmRvcidzIGNsaWVudC5cbiAqIERyaXZpbmcgdGhlIHByb3ZpZGVyIHJlZ2lzdHJ5IHdpdGggYSBmYWtlIHByb3ZpZGVyIG5lZWRzIG5vIGNyZWRlbnRpYWxzIGF0XG4gKiBhbGwsIHNvIHRoZSBtdXRhdGlvbiBoYWQgbm90aGluZyBsZWZ0IHRvIGRvLlxuICpcbiAqIEFuIGVtcHR5IGxpc3QgaXMgbm90IGFuIGludml0YXRpb24uIFRoZSBjbGFzc2lmaWVyIGJlbG93IHN0aWxsIHJ1bnMgb3ZlclxuICogZXZlcnkgc3VpdGUsIHNvIGEgbmV3IG11dGF0b3IgZmFpbHMgYHBhcmFsbGVsX3NhZmV0eV9jYXBfdGVzdC50c2AgbmFtaW5nXG4gKiBpdHNlbGYsIGFuZCByZS1hZGRpbmcgYW4gZW50cnkgaGVyZSB0byBzaWxlbmNlIGl0IGlzIHRoZSB0aGluZyB0aGlzIGxpc3RcbiAqIGV4aXN0cyB0byBwcmV2ZW50LlxuICovXG5leHBvcnQgY29uc3QgUFJPQ0VTU19TVEFURV9NVVRBVE9SX1RFU1RfRklMRVM6IHJlYWRvbmx5IHN0cmluZ1tdID0gW107XG5cbi8qKlxuICogVGVzdCBmaWxlcyB0aGF0IGFzc2VydCBvbiBhIHJlYWwgZWxhcHNlZCB3YWxsLWNsb2NrIHJlYWRpbmcgKElzc3VlICM5NDApLlxuICpcbiAqIFRoZSBmaXJzdCBgLS1wYXJhbGxlbGAgdHJpYWwgb2YgdGhlIHNwbGl0IHN1aXRlIGNhbWUgYmFjayB3aXRoIGVpZ2h0XG4gKiBmYWlsdXJlcywgYW5kIHNpeCBvZiB0aGVtIHdlcmUgdGhlc2U6XG4gKlxuICogYGBgdGV4dFxuICogNTAwayBhbHBoYW51bWVyaWMgcnVuIHRvb2sgNDkzNm1zIChidWRnZXQgMzAwMG1zKVxuICogb3ZlcnNpemVkIGlucHV0IHRvb2sgMzAyMiBtcyAoYnVkZ2V0IDIwMDAgbXMpXG4gKiBQRU0tYm9keSBuZWFyLW1pc3MgcnVuIHRvb2sgNDY1NiBtcyAoYnVkZ2V0IDIwMDAgbXMpXG4gKiAyNTYgS2lCIGJsb2IgdG9vayAyNTU3IG1zIChidWRnZXQgMjAwMCBtcylcbiAqIGFscGhhbnVtZXJpYyBydW46IDE2Mzg0IGNoYXJzIHRvb2sgNDggbXMgYnV0IDY1NTM2IGNoYXJzICg0LjB4KSB0b29rXG4gKiAgIDY0MCBtcywgb3ZlciB0aGUgMzgxIG1zIGEgbGluZWFyIHJ1bGUgYWxsb3dzXG4gKiBgYGBcbiAqXG4gKiBOb25lIGlzIGEgcmFjZSBhbmQgbm9uZSBpcyBhIGJ1ZyBpbiB0aGUgY29kZSB1bmRlciB0ZXN0LiBUaGV5IGFyZSBSZURvU1xuICogZ3VhcmRzLCBhbmQgYSBSZURvUyBndWFyZCBtZWFzdXJlcyBob3cgbG9uZyByZWFsIHdvcmsgdGFrZXMuIFRlbiB3b3JrZXJzIG9uXG4gKiBhIHRlbi1jb3JlIGhvc3QgbWVhbnMgdGhlIHdvcmsgdGFrZXMgbG9uZ2VyLCBzbyB0aGUgYnVkZ2V0IGJsb3dzIOKAlCBhbmQgdGhlXG4gKiByYXRpbyBhc3NlcnRpb25zIGFyZSBubyBzYWZlciwgYmVjYXVzZSB0aGUgdHdvIHJlYWRpbmdzXG4gKiBgYXNzZXJ0TGluZWFyR3Jvd3RoYCBjb21wYXJlcyBhcmUgdGFrZW4gYXQgZGlmZmVyZW50IGNvbnRlbnRpb24gbGV2ZWxzLlxuICpcbiAqIEludGVybWl0dGVudCByZWQgb24gdW5yZWxhdGVkIHdvcmsgaXMgdGhlIHdvcnN0IG91dGNvbWUgYSBnYXRlIGNhbiBoYXZlOiBpdFxuICogdGVhY2hlcyBldmVyeW9uZSB0byByZS1ydW4gcmF0aGVyIHRoYW4gcmVhZCB0aGUgcmVzdWx0LiBTbyB0aGVzZSBqb2luIHRoZVxuICogc2VyaWFsIHBhc3MsIHdoZXJlIHRoZSBtYWNoaW5lIGlzIHRoZWlycyBhbmQgdGhlIG1lYXN1cmVtZW50IG1lYW5zIHdoYXQgaXRcbiAqIHNheXMuXG4gKlxuICogVHdvIGVudHJpZXMgbGVmdCwgYW5kIG5laXRoZXIgb2YgdGhlbSBpcyBhIGBjbGF1ZGVfcnVubmVyXypgIHN1aXRlIGFueVxuICogbW9yZS4gVGhlIHR3ZW50eS1maXZlIHRoYXQgd2VyZSB0b29rIGEgY2xvY2sgaW5zdGVhZCAoYGxpYi9jbG9jay50c2ApOlxuICogYFJ1bkNsYXVkZU9wdGlvbnMuY2xvY2tgIGlzIHdoYXQgdGhlIHJ1bm5lciByZWFkcyB0aW1lIGFuZCBhcm1zIGl0c1xuICogd2F0Y2hkb2dzIHRocm91Z2gsIHNvIGEgdGVzdCBkcml2ZXMgdGhlIGRlYWRsaW5lIHJhdGhlciB0aGFuIHNsZWVwaW5nXG4gKiB0aHJvdWdoIGl0LiBUaGF0IHdhcyAxMDggcyBvZiB0aGUgc2VyaWFsIHBhc3Mgc3BlbnQgYXNsZWVwIGFnYWluc3QgcmVhbFxuICogb25lLSB0byBmb3VyLXNlY29uZCB3aW5kb3dzLCBhbmQg4oCUIHRoZSByZWFzb24gaXQgaGFkIHRvIGdvIHJhdGhlciB0aGFuXG4gKiBtZXJlbHkgYmVpbmcgc2xvdyDigJQgYSB3YXRjaGRvZyB3b2tlbiBsYXRlIGJ5IGEgYnVzeSBob3N0IHJlYWRzIGV4YWN0bHlcbiAqIGxpa2UgYSB3YXRjaGRvZyB0aGF0IGRpZCBub3QgZmlyZSwgd2hpY2ggaXMgaG93IGBjbGF1ZGVfcnVubmVyX2tpbGxfYm91bmRgXG4gKiBhbmQgYGNsYXVkZV9ydW5uZXJfcHJvZ3Jlc3NfZXh0ZW5zaW9uXzQyOTZgIHByb2R1Y2VkIGZvdXIgb2YgUFIgIzExNzAnc1xuICogb3duIGZhaWx1cmVzLiBXaGF0IGlzIGxlZnQgZ2VudWluZWx5IG1lYXN1cmVzOiBgZ3Jvd3RoX2JvdW5kX3Rlc3QudHNgIGlzXG4gKiB0aGUgcmF0aW8gaGVscGVyJ3Mgb3duIHN1aXRlLCB3aG9zZSBsYXN0IGNhc2UgaGFzIHRvIHRpbWUgcmVhbCBxdWFkcmF0aWNcbiAqIHdvcmsgb24gYSByZWFsIGNsb2NrIG9yIGl0IGlzIHRlc3Rpbmcgbm90aGluZywgYW5kXG4gKiBgcnVuX3BzMV9sYXVuY2hlcl90ZXN0LnRzYCB0aW1lcyBhIGxhdW5jaGVyIHdhdGNoZG9nIGFnYWluc3QgYSBjb250YWluZXJcbiAqIGl0IHNwYXducyBmb3IgcmVhbC5cbiAqXG4gKiBUaGUgc2VyaWFsIHBhc3MgaXMgbm90IGEgY3VyZSwgb25seSBhIHNtYWxsZXIgZG9zZSwgYW5kIFBSICMxMTcwIGlzIHdoZXJlXG4gKiB0aGF0IHJhbiBvdXQuIFR3ZWx2ZSBSZURvUyBhbmQgc2Nhbi1ib3VuZCBzdWl0ZXMgc2F0IGhlcmUgYW5kIHN0aWxsIHdlbnQgcmVkXG4gKiBvbiBgbWFpbmA6IGFuIGFic29sdXRlIG1pbGxpc2Vjb25kIGJ1ZGdldCByZXBvcnRzIGEgaG9zdCA4JSBzbG93ZXIgYXMgYVxuICogY29ycmVjdG5lc3MgZXJyb3IsIGFuZCB0aGUgcmF0aW8gYXNzZXJ0aW9uIHRoYXQgcmVwbGFjZWQgaXQgcmVhZCAzMCBtc1xuICogYWdhaW5zdCAzNTUgbXMgb24gYSBsb2FkZWQgbGFwdG9wIGZvciB3b3JrIHRoYXQgaXMgcGVyZmVjdGx5IGxpbmVhci4gQSBmbGVldFxuICogb2YgdW5saWtlIG1hY2hpbmVzIHVuZGVyIHVubGlrZSBsb2FkcyBoYXMgbm8gYnVkZ2V0IGFuZCBubyByYXRpbyB0aGF0IG1lYW5zXG4gKiB0aGUgc2FtZSB0aGluZyB0d2ljZS4gQWxsIHR3ZWx2ZSBub3cgYXNzZXJ0IG9uIHdoYXQgdGhlIGNvZGUgKipwcm9kdWNlcyoqXG4gKiBmb3IgdGhlIHNhbWUgYWR2ZXJzYXJpYWwgaW5wdXQg4oCUIGEgc3VwZXItbGluZWFyIHBhdHRlcm4gYXQgdGhvc2Ugc2l6ZXMgbmV2ZXJcbiAqIHJldHVybnMsIHNvIHRoZSBydW5uZXIncyBvd24gdGltZW91dCBpcyB0aGUgZGV0ZWN0b3Ig4oCUIGFuZCB0aGV5IGxlZnQgdGhpc1xuICogbGlzdCBmb3IgdGhlIHBhcmFsbGVsIHBhc3MuIFdoYXQgcmVtYWlucyBoZXJlIGdlbnVpbmVseSByYWNlcyBhIHJlYWwgY2xvY2s6XG4gKiB0aGUgZ3Jvd3RoIGhlbHBlcidzIG93biB0ZXN0cywgYSBsYXVuY2hlciB3YXRjaGRvZyB0aW1lZCBhZ2FpbnN0IGEgcmVhbFxuICogY29udGFpbmVyLCBhbmQgYHBsYW5fY292ZXJhZ2VfZ2F0ZV9ib3VuZHNfMTI0NV90ZXN0LnRzYCwgd2hvc2UgcGF0dGVyblxuICogY29zdHMgYWJvdXQgdHdlbHZlIHNlY29uZHMgb24gdGhlIGxhcmdlc3QgaW5wdXQgR2l0SHViIHdpbGwgYWNjZXB0IOKAlCBzbG93XG4gKiBlbm91Z2ggdG8gc3RhbGwgYSBwbGFubmluZyBjbG9zZSwgYnV0IG5vdCBzbG93IGVub3VnaCB0byBoYW5nIGEgdGVzdCwgc29cbiAqIHRoZSBiZWhhdmlvdXJhbCBmb3JtIGhhcyBub3RoaW5nIHRvIGRldGVjdCBhbmQgdGhlIHJhdGlvIGlzIHRoZSBvbmx5IHNpZ25hbFxuICogKElzc3VlICMxMjQ1KS5cbiAqXG4gKiBUaGUgYXN5bW1ldHJ5IGhlcmUgcnVucyB0aGUgb3Bwb3NpdGUgd2F5IHRvIHRoZSBpbnRlZ3JhdGlvbiBtYW5pZmVzdCwgYW5kXG4gKiB0aGF0IGlzIHdoeSB7QGxpbmsgbWVhc3VyZXNXYWxsQ2xvY2t9IGNhbiBhZmZvcmQgdG8gYmUgYnJvYWQuIEEgZmlsZSB3cm9uZ2x5XG4gKiBsaXN0ZWQgc3RpbGwgcnVucywgYSBzZWNvbmQgb3IgdHdvIGxhdGVyIHRoYW4gaXQgbWlnaHQgaGF2ZS4gQSBmaWxlIHdyb25nbHlcbiAqIGxlZnQgb3V0IGdvZXMgcmVkIG9uZSBydW4gaW4gZml2ZSwgb24gc29tZWJvZHkgZWxzZSdzIGNoYW5nZS5cbiAqL1xuZXhwb3J0IGNvbnN0IFdBTExfQ0xPQ0tfVEVTVF9GSUxFUzogcmVhZG9ubHkgc3RyaW5nW10gPSBbXG4gIC8vIENvbnRpbnVhdGlvbi1qb2luaW5nIGdyb3d0aCBndWFyZCBjb21wYXJlcyBOIGFuZCA0TiB3aXRob3V0IGNvbnRlbnRpb24uXG4gIFwidGVzdHMvY2lfbXV0YXRpb25fY29udHJhY3RfdGVzdC50c1wiLFxuICAvLyBUaGUgYWRtaW4tb25seSBoYW5kLW9mZiBzdHJpcHMgY29kZSBmZW5jZXMgYW5kIGlubGluZSBjb2RlIHNwYW5zIGZyb20gYW5cbiAgLy8gdW50cnVzdGVkIGlzc3VlIGJvZHkgYmVmb3JlIG1hdGNoaW5nOyBvbmx5IGEgZ3Jvd3RoIG1lYXN1cmVtZW50IHNlcGFyYXRlc1xuICAvLyB0aGF0IGxpbmVhciBzdHJpcCBmcm9tIGEgYmFja3RyYWNraW5nIG9uZSBvbiBob3N0aWxlIGJhY2t0aWNrIHJ1bnNcbiAgLy8gKElzc3VlICMzMjk1KS5cbiAgXCJ0ZXN0cy9hZG1pbl9vbmx5X2ZpbmRpbmdfdGVzdC50c1wiLFxuICAvLyBUaGUgaXNzdWUtcm91dGluZyBjbGFzc2lmaWVyIG1hdGNoZXMgd29ya2VyLCBwcm9kdWN0IGFuZCBtYXJrZXIgcGF0dGVybnNcbiAgLy8gYWdhaW5zdCBhbiB1bnRydXN0ZWQgaXNzdWUgYm9keTsgb25seSBhIGdyb3d0aCBtZWFzdXJlbWVudCBzZXBhcmF0ZXNcbiAgLy8gdGhvc2UgbGluZWFyIHBhdHRlcm5zIGZyb20gYSBiYWNrdHJhY2tpbmcgb25lIG9uIGhvc3RpbGUgcnVucyAoIzM3NDEpLlxuICBcInRlc3RzL2lzc3VlX3JvdXRpbmdfY2xhc3NpZmllcl90ZXN0LnRzXCIsXG4gIC8vIFRoZSB0aXRsZSBub3JtYWxpc2VyIHJ1bnMgYSBwYXR0ZXJuIG92ZXIgYW4gdW50cnVzdGVkIGRyYWZ0IHRpdGxlOyBvbmx5IGFcbiAgLy8gZ3Jvd3RoIG1lYXN1cmVtZW50IHNlcGFyYXRlcyBpdCBmcm9tIGEgYmFja3RyYWNraW5nIG9uZSAoIzM3NDIpLlxuICBcInRlc3RzL2lzc3VlX3JvdXRpbmdfZ2l0aHViX3Rlc3QudHNcIixcbiAgLy8gVGhlIGNsb3N1cmUtYmxvY2sgcmVuZGVyIHNjYW5zIGFuIGFnZW50LWF1dGhvcmVkIHN1bW1hcnkgbGluZSBieSBsaW5lIGZvclxuICAvLyB0aGUgdHdvIHJldmlldyBoZWFkaW5nczsgb25seSBhIGdyb3d0aCBtZWFzdXJlbWVudCBzZXBhcmF0ZXMgdGhhdCBzY2FuXG4gIC8vIGZyb20gdGhlIGFtYmlndW91cyBgXFxzKjo/XFxzKiRgIHRhaWwgaXQgZGVsaWJlcmF0ZWx5IGRvZXMgbm90IGNvcHkgKCMyMjQyKS5cbiAgXCJ0ZXN0cy9jbG9zdXJlX3ZlcmRpY3RfdGVzdC50c1wiLFxuICAvLyBUaGUgbWV0LWNsb3N1cmUgY3JpdGVyaW9uIGV4dHJhY3Rpb24gc3RyaXBzIHRyYWlsaW5nIHNlcGFyYXRvcnMgZnJvbSBhblxuICAvLyBhZ2VudC13cml0dGVuIFBSLXN1bW1hcnkgZW50cnkgd2l0aCBhIGJhY2t3YXJkcyBzY2FuOyBvbmx5IGEgZ3Jvd3RoXG4gIC8vIG1lYXN1cmVtZW50IChhc3NlcnRMaW5lYXJHcm93dGgpIHNlcGFyYXRlcyB0aGF0IGxpbmVhciBzdHJpcCBmcm9tIGFcbiAgLy8gYmFja3RyYWNraW5nIHRyYWlsaW5nLXJ1biByZWdleCAoSXNzdWUgIzM3NjYpLlxuICBcInRlc3RzL2Nsb3N1cmVfbWV0X2NoZWNrXzM3NjZfdGVzdC50c1wiLFxuICAvLyBUaGUgZGVzY3JpYmVkLWNvZGUtY2hhbmdlIHBhdGggc2NhbiByZXR1cm5zIHRoZSByaWdodCBhbnN3ZXIgb24gYSBsb25nXG4gIC8vIGhvc3RpbGUgbGluZSwgb25seSBxdWFkcmF0aWNhbGx5IHNsb3dseSDigJQgc28gb25seSBncm93dGggY2FuIHBpbiBpdCAoIzI4MjYpLlxuICBcInRlc3RzL2Rlc2NyaWJlZF9jb2RlX2NoYW5nZV90ZXN0LnRzXCIsXG4gIC8vIFRoZSBwYWlyZWQgcnVuLXJlc3VsdCBzY2FuIHJlYWRzIGEgUFItc3VtbWFyeSBsaW5lIGFuIGFnZW50IHdyaXRlczsgb25seVxuICAvLyBhIGdyb3d0aCBtZWFzdXJlbWVudCBzZXBhcmF0ZXMgaXRzIGxpbmVhciBzZXBhcmF0b3Igc2NhbiBmcm9tIGFcbiAgLy8gYmFja3RyYWNraW5nIHJlZ2V4IChJc3N1ZSAjMzM4MSkuXG4gIFwidGVzdHMvdGVzdF9wbGFuX3JlY291bnRfcmVkX29uX2Jhc2VfMzM4MV90ZXN0LnRzXCIsXG4gIC8vIFRoZSBUZXN0IFBsYW4gcmVjb3VudCByZWFkcyBhZ2VudC13cml0dGVuIHByb3NlIGZvciBwYXJ0aWFsIGFkZGl0aW9ucyBhbmRcbiAgLy8gXCJub3cgaGFzIE5cIiB0b3RhbHM7IG9ubHkgYSBncm93dGggbWVhc3VyZW1lbnQgc2VwYXJhdGVzIGl0cyBsaW5lYXJcbiAgLy8gc2NhbnMgZnJvbSBhIHF1YWRyYXRpYyBvbmUgb24gYSBsb25nIGhvc3RpbGUgbGluZSAoSXNzdWUgIzM3NDApLlxuICBcInRlc3RzL3Rlc3RfcGxhbl9yZWNvdW50X3BhcnRpYWxfMzc0MF90ZXN0LnRzXCIsXG4gIC8vIFRoZSBcIkFkZGVkIE4gdGVzdHMgdG8gYGZpbGVgXCIgcGFydGlhbC1hZGRpdGlvbiBwYXR0ZXJuIHJlYWRzIGFnZW50LXdyaXR0ZW5cbiAgLy8gVGVzdCBQbGFuIHByb3NlOyBvbmx5IGEgZ3Jvd3RoIG1lYXN1cmVtZW50IHNlcGFyYXRlcyBpdHMgbGluZWFyIHNjYW4gZnJvbVxuICAvLyBhIGJhY2t0cmFja2luZyBvbmUgb24gYSBsb25nIGhvc3RpbGUgbGluZSAoSXNzdWUgIzM5ODMpLlxuICBcInRlc3RzL3Rlc3RfcGxhbl9yZWNvdW50X2FkZGVkX25fdG9fMzk4M190ZXN0LnRzXCIsXG4gIC8vIFRoZSBjaGFuZ2UtcmVxdWVzdCBxdW90ZSBleHRyYWN0b3Igc2NhbnMgcmV2aWV3ZXItd3JpdHRlbiB0ZXh0OyBvbmx5IGFcbiAgLy8gZ3Jvd3RoIG1lYXN1cmVtZW50IHNlcGFyYXRlcyBpdHMgbGluZWFyIGhhbmQtd3JpdHRlbiBzY2FubmVycyBmcm9tIGFcbiAgLy8gYmFja3RyYWNraW5nIHJlZ2V4ICgjMzI0NCkuXG4gIFwidGVzdHMvY2hhbmdlX3JlcXVlc3RfcXVvdGVzXzMyNDRfdGVzdC50c1wiLFxuICAvLyBUaGUgY3Jvc3MtZmlsZSBhbmNob3IgbGluayBzY2FubmVyIHJlYWRzIGV2ZXJ5IGRvY3MgTWFya2Rvd24gbGluZTsgb25seSBhXG4gIC8vIGdyb3d0aCBtZWFzdXJlbWVudCBzZXBhcmF0ZXMgaXRzIGxpbmVhciBpbmxpbmUtbGluayBhbmQgY29kZS1zcGFuXG4gIC8vIHBhdHRlcm5zIGZyb20gdGhlIHF1YWRyYXRpYyBsaW5rIHJlZ2V4IGl0IHJlcGxhY2VkIChJc3N1ZSAjMzMzNykuXG4gIFwidGVzdHMvY3Jvc3NfZmlsZV9hbmNob3JzX3Rlc3QudHNcIixcbiAgLy8gVGhlIGdyaWxsLW1lIHN0ZW0gc3RyaXAgd2Fsa3MgYSBydW4gb2YgdHJhaWxpbmcgcHVuY3R1YXRpb24gYW4gdW50cnVzdGVkXG4gIC8vIGNvbW1lbnRlciBjaG9vc2VzIHRoZSBsZW5ndGggb2Y7IG9ubHkgYSBncm93dGggbWVhc3VyZW1lbnQgc2VwYXJhdGVzIHRoZVxuICAvLyBsaW5lYXIgd2FsayBmcm9tIHRoZSBxdWFkcmF0aWMgcmVnZXggaXQgcmVwbGFjZWQgKCMyMTgzKS5cbiAgXCJ0ZXN0cy9ncmlsbF9tZV9zdGFsbF9ndWFyZF9ib3VuZHNfMjE4M190ZXN0LnRzXCIsXG4gIC8vIFRoZSBmYWlsdXJlLWNhdGVnb3J5IGNhdGNoLWFsbCBzY2FucyBhbiB1bnRydXN0ZWQgcnVuIGZhaWx1cmUgbWVzc2FnZSAoaXRcbiAgLy8gY2FuIHF1b3RlIGFnZW50LXdyaXR0ZW4gUFItc3VtbWFyeSB0ZXh0KTsgb25seSBhIGdyb3d0aCBtZWFzdXJlbWVudFxuICAvLyBzZXBhcmF0ZXMgdGhlIGxpbmVhciBgRXJyb3I6KD8hOilgIHRlc3QgZnJvbSBhIGJhY2t0cmFja2luZyBvbmVcbiAgLy8gKElzc3VlICMzNDMxKS5cbiAgXCJ0ZXN0cy9mYWlsdXJlX2RpYWdub3Npc19ib3VuZHNfMzQzMV90ZXN0LnRzXCIsXG4gIC8vIFRoZSB0cmFuc2NyaXB0IHRlZSBjaGVja3MgZXZlcnkgc3RyaW5nIG9mIGEgbW9kZWwtd3JpdHRlbiBzdHJlYW0tanNvblxuICAvLyBsaW5lIGFnYWluc3QgdGhlIHJhdyByZWRhY3Rpb247IG9ubHkgYSBncm93dGggbWVhc3VyZW1lbnQgc2VwYXJhdGVzIHRoZVxuICAvLyBzaW5nbGUgZm9yd2FyZCBjdXJzb3IgZnJvbSBhIHJlc2NhbiBwZXIgc3RyaW5nIChJc3N1ZSAjMzgyNikuXG4gIFwidGVzdHMvYWdlbnRfdHJhbnNjcmlwdF9ncm93dGhfMzgyNl90ZXN0LnRzXCIsXG4gIFwidGVzdHMvZ3Jvd3RoX2JvdW5kX3Rlc3QudHNcIixcbiAgXCJ0ZXN0cy9wbGFuX2NvdmVyYWdlX2dhdGVfYm91bmRzXzEyNDVfdGVzdC50c1wiLFxuICAvLyBUaGUgcHJlLWNvbW1pdCBzYWZldHkgZ2F0ZSdzIGRvdGVudi9jb25maWcvc2VjcmV0cyBwYXR0ZXJucyBzY2FuIGEgc3RhZ2VkXG4gIC8vIHBhdGggYW4gdW50cnVzdGVkIGNvbW1pdCBjYW4gc2hhcGU7IG9ubHkgYSBncm93dGggbWVhc3VyZW1lbnQgc2VwYXJhdGVzXG4gIC8vIHRoZSBmaXhlZCwgbGluZWFyIHBhdHRlcm5zIGZyb20gdGhlIHF1YWRyYXRpYyBvbmVzIHRoZXkgcmVwbGFjZWRcbiAgLy8gKElzc3VlICMzMzExKS5cbiAgXCJ0ZXN0cy9wcmVfY29tbWl0X3NhZmV0eV90ZXN0LnRzXCIsXG4gIC8vIFRoZSBwcm9tcHQtbGVhayBtYXRjaGVyIHNjYW5zIG9uZSB1bmJyb2tlbiBibG9jayBwZXIgcGhyYXNlLCBhbmQgb25seSBhXG4gIC8vIGdyb3d0aCBtZWFzdXJlbWVudCBjYW4gdGVsbCBhIGxpbmVhciBzY2FuIGZyb20gYSBxdWFkcmF0aWMgb25lICgjMTQ2MykuXG4gIC8vIFRoZSBQUi1ib2R5IHRpZXItbWFya2VyIGZpbmRlciBzY2FucyBhbiB1bnRydXN0ZWQgUFIgYm9keSBmb3IgYW5cbiAgLy8gdW50ZXJtaW5hdGVkIG1hcmtlciBwcmVmaXg7IG9ubHkgYSBncm93dGggbWVhc3VyZW1lbnQgc2VwYXJhdGVzIGl0cyBsaW5lYXJcbiAgLy8gc2NhbiBmcm9tIGEgYmFja3RyYWNraW5nIG9uZSAoSXNzdWUgIzM0MDMpLlxuICBcInRlc3RzL3ByX2JvZHlfdGVzdC50c1wiLFxuICBcInRlc3RzL3Byb21wdF9sZWFrX3JlZGFjdGlvbl90ZXN0LnRzXCIsXG4gIC8vIFRoZSByZXN1bHQtcGxhY2Vob2xkZXIgZ2F0ZSdzIHN1ZmZpeCBhbmQgcmVzdWx0LWxpbmUgcmVnZXhlcyBzY2FuIGFuXG4gIC8vIGFnZW50LXdyaXR0ZW4gUFIgc3VtbWFyeSBvciByZXBseSwgc3RlZXJlZCBieSBhbiB1bnRydXN0ZWQgaXNzdWUgYm9keTtcbiAgLy8gb25seSBhIGdyb3d0aCBtZWFzdXJlbWVudCBzZXBhcmF0ZXMgdGhlaXIgbGluZWFyIHNjYW5zIGZyb20gYSBxdWFkcmF0aWNcbiAgLy8gb25lIChJc3N1ZSAjMzI0OCkuXG4gIFwidGVzdHMvcmVzdWx0X3BsYWNlaG9sZGVyX2dhdGVfdGVzdC50c1wiLFxuICBcInRlc3RzL3J1bl9wczFfbGF1bmNoZXJfdGVzdC50c1wiLFxuICAvLyBUaGUgbm90LXBsYW5uZWQtcmVmcyBpc3N1ZS9odW5rIHNjYW5uZXJzIHJlYWQgYW4gdW50cnVzdGVkIFBSIGJvZHkgYW5kXG4gIC8vIGRpZmYgaHVuazsgb25seSBhIGdyb3d0aCBtZWFzdXJlbWVudCBzZXBhcmF0ZXMgdGhlaXIgbGluZWFyIHNjYW5zIGZyb21cbiAgLy8gdGhlIHF1YWRyYXRpYyBwYXR0ZXJucyB0aGV5IHJlcGxhY2VkIChJc3N1ZSAjMzIyMykuXG4gIFwidGVzdHMvbWlsZXN0b25lX25vdF9wbGFubmVkX3JlZnNfdGVzdC50c1wiLFxuICAvLyBUaGUgcnVzdGMgdG9vbGNoYWluLWdhcCBkZXRlY3RvciByZWFkcyBhZ2VudC1jb250cm9sbGVkIGNhcmdvIG91dHB1dFxuICAvLyBsaW5lIGJ5IGxpbmU7IG9ubHkgYSBncm93dGggbWVhc3VyZW1lbnQgc2VwYXJhdGVzIGl0cyBjYXBwZWQsIGFuY2hvcmVkXG4gIC8vIHNjYW5zIGZyb20gYSBiYWNrdHJhY2tpbmcgcGF0dGVybiAoSXNzdWUgIzMyNTUpLlxuICBcInRlc3RzL21pbGVzdG9uZV9tZXJnZV9nYXRlX3Rlc3QudHNcIixcbiAgLy8gVGhlIHBlci1yZXBvIHN1Yi1pc3N1ZSByZWYgcGFyc2VyIG1lcmdlcyBwYWdlcyBidWlsdCBmcm9tIGEgaG9zdGlsZVxuICAvLyBgcmVwb3NpdG9yeV91cmxgOyBvbmx5IGEgZ3Jvd3RoIG1lYXN1cmVtZW50IHNlcGFyYXRlcyBpdHMgbGluZWFyIHNjYW5cbiAgLy8gZnJvbSBhIGJhY2t0cmFja2luZyBvbmUgKElzc3VlICMzMzE5KS5cbiAgXCJ0ZXN0cy9uYXRpdmVfc3ViX2lzc3VlX3JlZnNfdGVzdC50c1wiLFxuICAvLyBUaGUgc2hhcmVkIE1hcmtkb3duIGNvZGUtc3BhbiBzcGxpdHRlciBwYWlycyBiYWNrdGljayBydW5zIGluIHVudHJ1c3RlZFxuICAvLyBpc3N1ZSBib2RpZXMgYW5kIFBSIHN1bW1hcmllczsgb25seSBhIGdyb3d0aCBtZWFzdXJlbWVudCBzZXBhcmF0ZXMgaXRzXG4gIC8vIGxpbmVhciBwYWlyaW5nIGZyb20gdGhlIHF1YWRyYXRpYyBmb3J3YXJkIHNjYW4gaXQgcmVwbGFjZWQgKElzc3VlXG4gIC8vICMzMzEzKS5cbiAgXCJ0ZXN0cy9tYXJrZG93bl9jb2RlX3NwYW5zX3Rlc3QudHNcIixcbiAgLy8gVGhlIHJlbGVhc2UgcGF0aCdzIGxpbmUtYW5jaG9yZWQgY2xvbmUtY29ycnVwdC1yZXBlYXQgcmVnZXggc2NhbnMgc2V0dXBcbiAgLy8gZmFpbHVyZSBtZXNzYWdlcyB0aGF0IHF1b3RlIGdpdCBvdXRwdXQ7IG9ubHkgYSBncm93dGggbWVhc3VyZW1lbnRcbiAgLy8gc2VwYXJhdGVzIGl0IGZyb20gYSBiYWNrdHJhY2tpbmcgb25lIChJc3N1ZSAjMzQ0NikuXG4gIFwidGVzdHMvY2xvbmVfY29ycnVwdF9yZXBlYXRfZ3Jvd3RoXzM0NDZfdGVzdC50c1wiLFxuICAvLyBUaGUgbXV0YXRpb24gcnVubmVyJ3MgaW1wb3J0LXNwZWNpZmllciBzY2FuIHJlYWRzIHRlc3Qgc291cmNlcyBhIFBSXG4gIC8vIGF1dGhvciB3cml0ZXM7IG9ubHkgYSBncm93dGggbWVhc3VyZW1lbnQgc2VwYXJhdGVzIGl0cyBsaW5lYXIgc2NhbiBvZiBhblxuICAvLyB1bmNsb3NlZCBzcGVjaWZpZXIgZnJvbSBhIGJhY2t0cmFja2luZyBvbmUgKElzc3VlICMzMzkzKS5cbiAgXCJ0ZXN0cy9tdXRhdGlvbl9ydW5uZXJfdGVzdC50c1wiLFxuICAvLyBUaGUgc2hhcmVkIE1hcmtkb3duIGxvZ2ljYWwtdW5pdCBzcGxpdHRlciBncm91cHMgdGhlIGxpbmVzIG9mIHVudHJ1c3RlZFxuICAvLyBQUiBzdW1tYXJpZXM7IG9ubHkgYSBncm93dGggbWVhc3VyZW1lbnQgc2VwYXJhdGVzIGl0cyBzaW5nbGUgbGluZWFyIHBhc3NcbiAgLy8gZnJvbSBhIHJlc2NhbiBwZXIgbGluZSAoSXNzdWUgIzMzNTYpLlxuICBcInRlc3RzL21hcmtkb3duX2xvZ2ljYWxfdW5pdHNfMzM1Nl90ZXN0LnRzXCIsXG4gIC8vIFRoZSBmbG93Y2hhcnQgbWl4ZWQtbGFiZWwgc2NhbiB3YWxrcyBhZ2VudC13cml0dGVuIE1hcmtkb3duIGEgY2hhcmFjdGVyXG4gIC8vIGF0IGEgdGltZTsgb25seSBhIGdyb3d0aCBtZWFzdXJlbWVudCBzZXBhcmF0ZXMgdGhhdCBsaW5lYXIgc2NhbiBmcm9tIGFcbiAgLy8gYmFja3RyYWNraW5nIG9uZSBvbiBob3N0aWxlIG9wZW5lciBydW5zIChJc3N1ZSAjMzc2OSkuXG4gIFwidGVzdHMvbWVybWFpZF92YWxpZGF0b3JfZ3Jvd3RoXzM3NjlfdGVzdC50c1wiLFxuICAvLyBUaGUgc2VjdXJpdHktZml4IGdhdGUncyBjaXRlZC10ZXN0IHBhcnNpbmcgc2NhbnMgZGlmZiBsaW5lcyBhbiBhZ2VudFxuICAvLyAoc3RlZXJlZCBieSBhbiB1bnRydXN0ZWQgaXNzdWUgYm9keSkgd3JpdGVzOyBvbmx5IGEgZ3Jvd3RoIG1lYXN1cmVtZW50XG4gIC8vIHNlcGFyYXRlcyBpdHMgbGluZWFyIGRlY2xhcmF0aW9uIHNjYW4gZnJvbSBhIGJhY2t0cmFja2luZyBvbmUgb24gYW5cbiAgLy8gdW5jbG9zZWQgcXVvdGUgcnVuIChJc3N1ZSAjMzY1OSkuXG4gIFwidGVzdHMvc2VjdXJpdHlfZml4X2dhdGVfZ3Jvd3RoX3Rlc3QudHNcIixcbiAgLy8gVGhlIGNhbGxlciBjaGVja3MnIGRlZmluaXRpb24gYW5kIGRpZmYtaGVhZGVyIHJlZ2V4ZXMgcnVuIG92ZXIgdW50cnVzdGVkXG4gIC8vIHNvdXJjZSBsaW5lcyBhbmQgZGlmZnM7IG9ubHkgYSBncm93dGggbWVhc3VyZW1lbnQgc2VwYXJhdGVzIHRoZWlyIGxpbmVhclxuICAvLyBwYXR0ZXJucyBmcm9tIGEgYmFja3RyYWNraW5nIG9uZSAoSXNzdWUgIzM3NzkpLlxuICBcInRlc3RzL2NhbGxlcl9jaGVja3NfMzc3OV90ZXN0LnRzXCIsXG4gIC8vIFRoZSBlZ3Jlc3MgYWxsb3dsaXN0IHZhbGlkYXRvciBtYXRjaGVzIGhvc3QgcGF0dGVybnMgYWdhaW5zdCB1bnRydXN0ZWRcbiAgLy8gY29uZmlnIGVudHJpZXM7IG9ubHkgYSBncm93dGggbWVhc3VyZW1lbnQgc2VwYXJhdGVzIHRob3NlIGxpbmVhclxuICAvLyBwYXR0ZXJucyBmcm9tIGEgYmFja3RyYWNraW5nIG9uZSBvbiBob3N0aWxlIHJ1bnMgKCM0MDQ1KS5cbiAgXCJ0ZXN0cy9lZ3Jlc3NfYWxsb3dsaXN0X3Rlc3QudHNcIixcbiAgLy8gQSBncmFuZGNoaWxkIHRoYXQgaG9sZHMgdGhlIG91dHB1dCBwaXBlcyBtdXN0IG5vdCBob2xkIHRoZSBjYWxsIHBhc3QgaXRzXG4gIC8vIHRpbWVvdXQ7IG9ubHkgdGhlIGVsYXBzZWQgdGltZSBhZ2FpbnN0IHRoZSB0aW1lb3V0IHNob3dzIHRoZSBwaXBlcyB3ZXJlXG4gIC8vIGNhbmNlbGxlZCByYXRoZXIgdGhhbiBkcmFpbmVkIChJc3N1ZSAjNDI0NykuXG4gIFwidGVzdHMvc3VicHJvY2Vzc190aW1lb3V0X3Rlc3QudHNcIixcbiAgLy8gUmVhbCBTSUdURVJNLWlnbm9yaW5nIGNoaWxkcmVuIGV4ZXJjaXNlIGJvdW5kZWQga2lsbCBjb21wbGV0aW9uIGF0IHRoZVxuICAvLyBjaG9rZXBvaW50czsga2VlcCB0aGVpciBlbGFwc2VkIGFzc2VydGlvbnMgb3V0IG9mIHRoZSBwYXJhbGxlbCBwYXNzLlxuICBcInRlc3RzL3N1YnByb2Nlc3NfZGVhZGxpbmVfNDI0N190ZXN0LnRzXCIsXG4gIC8vIFRoZSBwcm9zZS1zY29wZSBsZXhlciBzY2FucyBzb3VyY2UgYSBwdWxsIHJlcXVlc3QgY2hhbmdlcy4gT25seSBhIGdyb3d0aFxuICAvLyBtZWFzdXJlbWVudCBzZXBhcmF0ZXMgaXRzIGNoYXJhY3RlciBsb29wIGZyb20gYSBzdXBlci1saW5lYXIgb25lIG9uIGFcbiAgLy8gbG9uZyBsaW5lIG9mIG9wZW4gYnJhY2tldHMgYW5kIHF1b3RlcyAoSXNzdWUgIzQyMzQpLlxuICBcInRlc3RzL2RvY19wcm9zZV9zY29wZV9sZXhlcl90ZXN0LnRzXCIsXG5dO1xuXG4vKipcbiAqIFdoZXRoZXIgYHNvdXJjZWAgYXNzZXJ0cyBvbiBhIHJlYWwgZWxhcHNlZCB3YWxsLWNsb2NrIHJlYWRpbmcuXG4gKlxuICogVHdvIHNoYXBlcyBjb3VudC4gUmVhZGluZyBhIHJlYWwgY2xvY2sgKGBwZXJmb3JtYW5jZS5ub3coKWAsIGBEYXRlLm5vdygpYClcbiAqIGFuZCBjb21wYXJpbmcgdGhlIGVsYXBzZWQgdmFsdWUgdG8gYSBib3VuZCBpcyB0aGUgb2J2aW91cyBvbmUuIFVzaW5nIHRoZVxuICogcmVwb3NpdG9yeSdzIG93biBgYXNzZXJ0TGluZWFyR3Jvd3RoYCBoZWxwZXIgaXMgdGhlIG90aGVyLCBhbmQgaXQgaGFzIHRvIGJlXG4gKiBtYXRjaGVkIHNlcGFyYXRlbHkgYmVjYXVzZSB0aGUgaGVscGVyIGRvZXMgdGhlIHRpbWluZyDigJQgdGhlIHRlc3QgZmlsZSB0aGF0XG4gKiBjYWxscyBpdCBuZXZlciB0b3VjaGVzIGEgY2xvY2sgaXRzZWxmLCB3aGljaCBpcyBleGFjdGx5IGhvd1xuICogYHNlY3JldF9yZWRhY3Rpb25fYm91bmRzX3Rlc3QudHNgIHdhcyBtaXNzZWQgb24gdGhlIGZpcnN0IHBhc3MuXG4gKlxuICogQSBkb21haW4gXCJidWRnZXRcIiDigJQgdG9rZW5zLCBzcGVuZCwgYSBwaGFzZSBkZWFkbGluZSBhZ2FpbnN0IGFuIGluamVjdGVkXG4gKiBjbG9jayDigJQgaXMgbm90IG1hdGNoZWQsIGFuZCBzaG91bGQgbm90IGJlOiB0aG9zZSBhcmUgdGhlIHRlc3RzIHRoYXQgdG9va1xuICogdGhlIHNlYW0gaW5zdGVhZCBvZiB0aGUgc3RvcHdhdGNoLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbWVhc3VyZXNXYWxsQ2xvY2soc291cmNlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgY29kZSA9IHN0cmlwQ29tbWVudHMoc291cmNlKTtcbiAgaWYgKEdST1dUSF9IRUxQRVIudGVzdChjb2RlKSkgcmV0dXJuIHRydWU7XG4gIGlmIChkcml2ZXNSZWFsRGVhZGxpbmUoY29kZSkpIHJldHVybiB0cnVlO1xuICByZXR1cm4gUkVBTF9DTE9DSy50ZXN0KGNvZGUpICYmIEVMQVBTRURfQk9VTkQudGVzdChjb2RlKTtcbn1cblxuLyoqXG4gKiBXaGV0aGVyIGFueSBgcnVuQ2xhdWRlV2l0aCpgIGNhbGwgaW4gYGNvZGVgIHNldHMgYSBkZWFkbGluZSBhbmQgbGVhdmVzIGl0XG4gKiBvbiB0aGUgcmVhbCBjbG9jay5cbiAqXG4gKiBQZXIgY2FsbCBzaXRlLCBub3QgcGVyIGZpbGUuIFRoZSBmaXJzdCBzcGVsbGluZyBhc2tlZCBvbmx5IHdoZXRoZXIgdGhlXG4gKiBmaWxlIG1lbnRpb25lZCBhIHJ1biAqc29tZXdoZXJlKiBhbmQgYSBkZWFkbGluZSBhcmd1bWVudCAqc29tZXdoZXJlKixcbiAqIHdoaWNoIHdhcyB0aGUgcmlnaHQgcXVlc3Rpb24gd2hpbGUgdGhlIG9ubHkgY2xvY2sgd2FzIHRoZSByZWFsIG9uZS4gTm93XG4gKiB0aGF0IGBSdW5DbGF1ZGVPcHRpb25zLmNsb2NrYCBleGlzdHMsIFwiYSBydW4gd2l0aCBgdGltZW91dFNlY29uZHNgXCIgYW5kIFwiYVxuICogcnVuIHRoYXQgd2lsbCBhY3R1YWxseSBzbGVlcCBmb3IgYSBzZWNvbmRcIiBhcmUgZGlmZmVyZW50IGZhY3RzLCBhbmQgb25seVxuICogdGhlIHNlY29uZCBiZWxvbmdzIGluIHRoZSBzZXJpYWwgcGFzcyDigJQgc28gdGhlIGFyZ3VtZW50cyBvZiBlYWNoIGNhbGwgYXJlXG4gKiByZWFkIHRvZ2V0aGVyIHdpdGggdGhlIGNhbGwuXG4gKlxuICogQSBjYWxsIHdob3NlIG9wdGlvbnMgYXJyaXZlIHRocm91Z2ggYSBzcHJlYWQgY2Fubm90IGJlIHJlYWQgYXQgaXRzIG93blxuICogc2l0ZSwgc28gaXQgZmFsbHMgYmFjayB0byB0aGUgZmlsZS13aWRlIHF1ZXN0aW9uIHRoZSBmaXJzdCBzcGVsbGluZyBhc2tlZDpcbiAqIGEgZGVhZGxpbmUgbmFtZWQgYW55d2hlcmUgYW5kIG5vIGNsb2NrIG5hbWVkIGFueXdoZXJlIGlzIGEgcmVhbCBkZWFkbGluZS5cbiAqIFRoZSBhc3ltbWV0cnkgcnVucyB0aGUgc2FmZSB3YXkg4oCUIGEgZmlsZSB3cm9uZ2x5IGxpc3RlZCBydW5zIGEgc2Vjb25kXG4gKiBsYXRlciB0aGFuIGl0IG1pZ2h0LCBhIGZpbGUgd3JvbmdseSBjbGVhcmVkIGdvZXMgcmVkIG9uZSBydW4gaW4gZml2ZSBvblxuICogc29tZWJvZHkgZWxzZSdzIGNoYW5nZS5cbiAqL1xuZnVuY3Rpb24gZHJpdmVzUmVhbERlYWRsaW5lKGNvZGU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBmb3IgKGNvbnN0IG1hdGNoIG9mIGNvZGUubWF0Y2hBbGwoUkVBTF9ERUFETElORV9SVU4pKSB7XG4gICAgY29uc3Qgb3BlbiA9IChtYXRjaC5pbmRleCA/PyAwKSArIG1hdGNoWzBdLmxlbmd0aCAtIDE7XG4gICAgY29uc3QgYXJncyA9IGJhbGFuY2VkQXJndW1lbnRUZXh0KGNvZGUsIG9wZW4pO1xuICAgIGlmIChhcmdzID09PSB1bmRlZmluZWQpIGNvbnRpbnVlO1xuICAgIGNvbnN0IHNjb3BlID0gU1BSRUFEX0FSRy50ZXN0KGFyZ3MpID8gY29kZSA6IGFyZ3M7XG4gICAgaWYgKCFSRUFMX0RFQURMSU5FX0FSRy50ZXN0KHNjb3BlKSkgY29udGludWU7XG4gICAgaWYgKElOSkVDVEVEX0NMT0NLX0FSRy50ZXN0KHNjb3BlKSkgY29udGludWU7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgcmV0dXJuIGZhbHNlO1xufVxuXG4vKipcbiAqIFRoZSB0ZXh0IGJldHdlZW4gdGhlIHBhcmVudGhlc2lzIGF0IGBvcGVuSW5kZXhgIGFuZCBpdHMgbWF0Y2guXG4gKlxuICogTmVzdGVkIGJyYWNrZXRzIGFyZSBiYWxhbmNlZCBhbmQgc3RyaW5nIGxpdGVyYWxzIHNraXBwZWQsIHNvIGEgYClgIGluc2lkZVxuICogYSBwcm9tcHQgb3IgYSByZWdleCBjYW5ub3QgZW5kIHRoZSBhcmd1bWVudCBsaXN0IGVhcmx5LiBgdW5kZWZpbmVkYCB3aGVuXG4gKiB0aGUgcGFyZW50aGVzaXMgbmV2ZXIgY2xvc2VzLCB3aGljaCBvbmx5IGEgdHJ1bmNhdGVkIHNvdXJjZSBjYW4gcHJvZHVjZS5cbiAqL1xuZnVuY3Rpb24gYmFsYW5jZWRBcmd1bWVudFRleHQoXG4gIGNvZGU6IHN0cmluZyxcbiAgb3BlbkluZGV4OiBudW1iZXIsXG4pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBsZXQgZGVwdGggPSAwO1xuICBsZXQgcXVvdGU6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgZm9yIChsZXQgaSA9IG9wZW5JbmRleDsgaSA8IGNvZGUubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBjaGFyID0gY29kZVtpXSE7XG4gICAgaWYgKHF1b3RlICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGlmIChjaGFyID09PSBcIlxcXFxcIikgaSsrO1xuICAgICAgZWxzZSBpZiAoY2hhciA9PT0gcXVvdGUpIHF1b3RlID0gdW5kZWZpbmVkO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChjaGFyID09PSAnXCInIHx8IGNoYXIgPT09IFwiJ1wiIHx8IGNoYXIgPT09IFwiYFwiKSB7XG4gICAgICBxdW90ZSA9IGNoYXI7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGNoYXIgPT09IFwiKFwiIHx8IGNoYXIgPT09IFwiW1wiIHx8IGNoYXIgPT09IFwie1wiKSBkZXB0aCsrO1xuICAgIGVsc2UgaWYgKGNoYXIgPT09IFwiKVwiIHx8IGNoYXIgPT09IFwiXVwiIHx8IGNoYXIgPT09IFwifVwiKSB7XG4gICAgICBkZXB0aC0tO1xuICAgICAgaWYgKGRlcHRoID09PSAwKSByZXR1cm4gY29kZS5zbGljZShvcGVuSW5kZXggKyAxLCBpKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn1cblxuLyoqXG4gKiBEcml2aW5nIHRoZSByZWFsIHJ1bm5lciwgd2hpY2ggaXMgdGhlIG90aGVyIHdheSB0byBkZXBlbmQgb24gdGhlIGNsb2NrLlxuICpcbiAqIGBydW5DbGF1ZGVXaXRoVGltZW91dGAgc3Bhd25zIGEgc3R1YiBhbmQgZW5mb3JjZXMgYHRpbWVvdXRTZWNvbmRzYCBhbmRcbiAqIGBraWxsQWZ0ZXJTZWNvbmRzYCBhZ2FpbnN0IHRoZSB3YWxsIGNsb2NrLCBzbyB0aGUgc3VpdGUgaXMgYXNzZXJ0aW5nIHdoYXRcbiAqIGhhcHBlbnMgaW5zaWRlIGEgcmVhbCBvbmUtIHRvIGZvdXItc2Vjb25kIHdpbmRvdy4gTm90aGluZyBpbiBpdCByZWFkcyBhXG4gKiBjbG9jayBpdHNlbGYsIHNvIG5laXRoZXIgb2YgdGhlIG90aGVyIHR3byBzaGFwZXMgc2VlcyBpdC5cbiAqXG4gKiBJc3N1ZSAjOTU5IGlzIHdoeSB0aGlzIGlzIGhlcmUuIEl0IGRyYWluZWQgZWxldmVuIGBjbGF1ZGVfcnVubmVyXypgIHN1aXRlc1xuICogb2ZmIGBEZW5vLmVudmAsIHdoaWNoIGlzIGV4YWN0bHkgdGhlIHJpZ2h0IGZpeCBhbmQgbW92ZWQgdGhlbSBvdXQgb2YgdGhlXG4gKiBtdXRhdG9yIGxpc3Qg4oCUIHN0cmFpZ2h0IGludG8gdGhlIHBhcmFsbGVsIHBhc3MsIHdoZXJlIGEgb25lLXNlY29uZCBidWRnZXRcbiAqIHNoYXJlZCB3aXRoIG5pbmUgd29ya2VycyBpcyBub3QgYSB0ZXN0IGJ1dCBhIGNvaW4gdG9zcy4gQm90aCBoYWx2ZXMgb2YgdGhlXG4gKiBzaWduYWwgYXJlIHJlcXVpcmVkOiBuYW1pbmcgYHRpbWVvdXRTZWNvbmRzYCBpbiBhIGNvbmZpZyBvYmplY3QgYSB0ZXN0XG4gKiBtZXJlbHkgaW5zcGVjdHMgaXMgbm90IHJ1bm5pbmcgYWdhaW5zdCBpdC5cbiAqL1xuY29uc3QgUkVBTF9ERUFETElORV9SVU4gPSAvcnVuQ2xhdWRlV2l0aCg/OlRpbWVvdXR8UmV0cnkpXFwoL2c7XG5cbi8qKiBUaGUgZGVhZGxpbmUgYXJndW1lbnRzIHRoYXQgbWFrZSBzdWNoIGEgcnVuIHdhbGwtY2xvY2sgYm91bmQuICovXG5jb25zdCBSRUFMX0RFQURMSU5FX0FSRyA9IC9cXGIodGltZW91dFNlY29uZHN8a2lsbEFmdGVyU2Vjb25kcylcXHMqOi87XG5cbi8qKlxuICogVGhlIHNlYW0gdGhhdCB0YWtlcyB0aGUgZGVhZGxpbmUgb2ZmIHRoZSB3YWxsIGNsb2NrLlxuICpcbiAqIGBSdW5DbGF1ZGVPcHRpb25zLmNsb2NrYCAoYGxpYi9jbG9jay50c2ApIGlzIHdoYXQgdGhlIHJ1bm5lciByZWFkcyB0aW1lXG4gKiBhbmQgYXJtcyBpdHMgdGltZXJzIHRocm91Z2gsIHNvIGEgcnVuIHRoYXQgbmFtZXMgb25lIGV4cGlyZXMgd2hlbiB0aGUgdGVzdFxuICogYWR2YW5jZXMgaXQgYW5kIG5ldmVyIGEgbW9tZW50IGJlZm9yZS4gVGhlIHN1aXRlIHRoZW4gbWVhc3VyZXMgbm90aGluZyxcbiAqIHNsZWVwcyBmb3Igbm90aGluZywgYW5kIGJlbG9uZ3MgaW4gdGhlIHBhcmFsbGVsIHBhc3Mgd2l0aCBldmVyeXRoaW5nIGVsc2UuXG4gKi9cbmNvbnN0IElOSkVDVEVEX0NMT0NLX0FSRyA9IC9cXGJjbG9ja1xccypbOix9XS87XG5cbi8qKlxuICogT3B0aW9ucyBoYW5kZWQgaW4gdGhyb3VnaCBhIHNwcmVhZCwgd2hpY2ggdGhlIGNhbGwgc2l0ZSBjYW5ub3QgcmVzb2x2ZS5cbiAqXG4gKiBgY2xhdWRlX3J1bm5lcl9vb21fdGVybWluYWxfdGVzdC50c2AgYnVpbGRzIG9uZSBgYmFzZU9wdGlvbnNgIGNhcnJ5aW5nIHRoZVxuICogZGVhZGxpbmUgYW5kIHNwcmVhZHMgaXQgaW50byBmb3VyIHJ1bnM7IHJlYWRpbmcgb25seSBlYWNoIGNhbGwncyBvd24gdGV4dFxuICogd291bGQgY2xlYXIgYWxsIGZvdXIuIFN1Y2ggYSBjYWxsIGlzIGp1ZGdlZCBvbiB0aGUgd2hvbGUgZmlsZSBpbnN0ZWFkLlxuICovXG5jb25zdCBTUFJFQURfQVJHID0gL1xcLlxcLlxcLi87XG5cbi8qKlxuICogVGhlIHNoYXJlZCByYXRpbyBoZWxwZXIsIHdoaWNoIGRvZXMgaXRzIGNhbGxlcnMnIHRpbWluZyBmb3IgdGhlbS5cbiAqXG4gKiBNYXRjaGVkIG9uIHRoZSAqKmltcG9ydCBvciB0aGUgY2FsbCoqLCBuZXZlciBvbiB0aGUgbmFtZSBhbG9uZS4gSXNzdWUgIzk0M1xuICogYWRkZWQgYSBzdWl0ZSB0aGF0IHJlYWRzIGBzdXBwb3J0L2dyb3d0aC50c2Agd2l0aCBgRGVuby5yZWFkVGV4dEZpbGVgIHRvXG4gKiBhc3NlcnQgdGhlIGF1ZGl0IHByb21wdCBhbmQgdGhlIGhlbHBlciBhZ3JlZTsgbWF0Y2hpbmcgdGhlIGJhcmUgcGF0aFxuICogY2xhaW1lZCBpdCwgYW5kIGEgdGVzdCB0aGF0IG5ldmVyIHN0YXJ0cyBhIGNsb2NrIGRvZXMgbm90IG5lZWQgdGhlIHNlcmlhbFxuICogcGFzcy4gU2FtZSBhc3ltbWV0cnkgYXMgdGhlIGludGVncmF0aW9uIGNsYXNzaWZpZXI6IG1hdGNoIHRoZSB1c2UsIG5vdCB0aGVcbiAqIG1lbnRpb24uXG4gKi9cbmNvbnN0IEdST1dUSF9IRUxQRVIgPVxuICAvZnJvbVxccytcIlteXCJcXG5dKnN1cHBvcnRcXC9ncm93dGhcXC50c1wifGFzc2VydExpbmVhckdyb3d0aFxcKC87XG5cbi8qKiBBIHJlYWRpbmcgb2YgdGhlIHJlYWwgY2xvY2suICovXG5jb25zdCBSRUFMX0NMT0NLID0gL3BlcmZvcm1hbmNlXFwubm93XFwoXFwpfERhdGVcXC5ub3dcXChcXCkvO1xuXG4vKipcbiAqIEFuIGVsYXBzZWQgdmFsdWUgY29tcGFyZWQgYWdhaW5zdCBhIGJvdW5kLlxuICpcbiAqIFRoZSBib3VuZCBpcyBhbnkgbnVtYmVyLCBub3Qgb25seSBhIG1pbGxpc2Vjb25kLXNjYWxlIG9uZS4gSXNzdWUgIzk1OVxuICogZHJhaW5lZCB0aGUgYGNsYXVkZV9ydW5uZXJfKmAgc3VpdGVzIG9mZiBgRGVuby5lbnZgLCB3aGljaCBtb3ZlZCB0aGVtIG91dFxuICogb2YgdGhlIG11dGF0b3IgbGlzdCBhbmQgd291bGQgaGF2ZSBwdXQgdGhlbSBpbiB0aGUgcGFyYWxsZWwgcGFzcyDigJQgYW5kIHRoZXlcbiAqIGFzc2VydCBgZWxhcHNlZFNlY29uZHMgPCA0YCBvbiBhIHJlYWwgYERhdGUubm93KClgIGRlbHRhLiBBIHRocmVlLWRpZ2l0XG4gKiBtaW5pbXVtIHJlYWQgdGhhdCBhcyBcIm5vdCBhIGJ1ZGdldFwiOyBmb3VyIHNlY29uZHMgb2Ygc2xhY2sgc2hhcmVkIHdpdGggbmluZVxuICogb3RoZXIgd29ya2VycyBpcyB0aGUgdGlnaHRlc3QgYnVkZ2V0IGluIHRoZSB0cmVlLlxuICovXG5jb25zdCBFTEFQU0VEX0JPVU5EID1cbiAgLyh0b29rfGVsYXBzZWR8ZHVyYXRpb258c3BlbnR8bXMpXFx3Klxccyo8XFxzKlswLTlfXSt8PFxccypbQS1aX10qQlVER0VULztcblxuLyoqXG4gKiBUZXN0IGZpbGVzIHRoYXQgcmFjZSBhIHJlYWwgc3VicHJvY2VzcyBhZ2FpbnN0IHRoZSBjbG9jayAoSXNzdWUgIzk0MCkuXG4gKlxuICogVGhlIG90aGVyIHR3byBjYXRlZ29yaWVzIGFyZSBjbGFzc2lmaWVyLWJhY2tlZCwgYmVjYXVzZSB0aGUgc2lnbmFsIGlzIGluXG4gKiB0aGUgc291cmNlLiBUaGVzZSBzdWl0ZXMgd2VyZSBmb3VuZCBieSBydW5uaW5nIHRoZSBzcGxpdCBhbmQgcmVhZGluZyB3aGF0XG4gKiBicm9rZSwgYW5kIG5vIGhvbmVzdCByZWdleCBjbGFpbXMgdGhlbTogd2hhdCBtYWtlcyB0aGVtIHVuc2FmZSBpcyB0aGF0IHRoZXlcbiAqIHNwYXduIHNvbWV0aGluZyByZWFsIGFuZCB0aGVuIGRlcGVuZCBvbiBpdCBiZWluZyBzY2hlZHVsZWQgcHJvbXB0bHkuXG4gKlxuICogVGhleSBmYWlsZWQgdW5kZXIgYC0tcGFyYWxsZWxgIGFuZCBwYXNzZWQgaW4gdGhlIHNhbWUgc2VxdWVudGlhbCBydW4sIHNvXG4gKiB0aGUgZW50cnkgY2FycmllcyB0aGUgbWVhc3VyZW1lbnQgcmF0aGVyIHRoYW4gYSBodW5jaC4gQSByZWFzb24gaXMgcmVxdWlyZWRcbiAqIGZvciB0aGUgc2FtZSBwdXJwb3NlIGl0IGlzIGluIGBTQ1JJUFRfUkVBRElOR19VTklUX1RFU1RTYDogYW4gZXhlbXB0aW9uXG4gKiBub2JvZHkgaGFkIHRvIGp1c3RpZnkgaXMgYW4gZXhlbXB0aW9uIG5vYm9keSBjYW4gcmV0aXJlLlxuICovXG5leHBvcnQgY29uc3QgU1VCUFJPQ0VTU19USU1JTkdfVEVTVF9GSUxFUzogUmVhZG9ubHlNYXA8c3RyaW5nLCBzdHJpbmc+ID1cbiAgbmV3IE1hcChbXG4gICAgW1xuICAgICAgXCJ0ZXN0cy9ydW5fY29yZV9zaWduYWxfY2xlYW51cF90ZXN0LnRzXCIsXG4gICAgICBcIlJlYWwgU0lHSU5UL1NJR1RFUk0gZW50cnlwb2ludCBhbmQgZGVzY2VuZGFudCBjbGVhbnVwLiBGdWxsIC0tcGFyYWxsZWwgcGFzczogYm90aCB0ZXN0cyBleGNlZWRlZCAxcyAoMi4zOHMgdG90YWwpOyBpc29sYXRlZDogODg3bXMgYW5kIDgyMG1zLiBQcm9jZXNzIHN0YXJ0dXAgYW5kIGdyYWNlZnVsIHRlcm1pbmF0aW9uIGNvbnRlbmQgd2l0aCBwYXJhbGxlbCB3b3JrZXJzLiBLZWVwIGV2ZXJ5IGFzc2VydGlvbiBpbiB0aGUgcmVxdWlyZWQgc2VyaWFsIHBhc3MuXCIsXG4gICAgXSxcbiAgICBbXG4gICAgICBcInRlc3RzL2NvbnRhaW5lcl9jb250YWlubWVudF90ZXN0LnRzXCIsXG4gICAgICBcImJ1aWxkcyBhIHJlYWwgY29udGFpbmVyIGFuZCBib3VuZHMgYDxydW50aW1lPiB2b2x1bWUgY3JlYXRlYCB3aXRoIFwiICtcbiAgICAgIFwiUVVFUllfVElNRU9VVF9NUzsgdW5kZXIgLS1wYXJhbGxlbCB0aGUgY3JlYXRlIHRpbWVkIG91dCBpbiBib3RoIFwiICtcbiAgICAgIFwidHJpYWxzIChgQ291bGQgbm90IGNyZWF0ZSB0aGUgdGhyb3dhd2F5IHZvbHVtZSDigKZgLCAzMHMpLCBhbmQgcGFzc2VkIFwiICtcbiAgICAgIFwiaW4gdGhlIHNlcXVlbnRpYWwgcnVuIGJldHdlZW4gdGhlbVwiLFxuICAgIF0sXG4gICAgW1xuICAgICAgXCJ0ZXN0cy9sYXVuY2hlcl9zaWduYWxfcmVhZGluZXNzX3Rlc3QudHNcIixcbiAgICAgIFwic3Bhd25zIHJ1bi5zaCBhbmQgc2lnbmFscyBpdCBpbnNpZGUgYSBkZWxpYmVyYXRlbHkgbmFycm93IHJlYWRpbmVzcyBcIiArXG4gICAgICBcIndpbmRvdyAoU1RVQl9SRUFEWV9ERUxBWSk7IGl0cyBvd24gZG9jIHJlY29yZHMgYSBkZXNjaGVkdWxlZCBDSSBcIiArXG4gICAgICBcInJ1bm5lciBsb3NpbmcgZXhhY3RseSB0aGF0IHJhY2UsIGFuZCBuaW5lIGNvbXBldGluZyB3b3JrZXJzIFwiICtcbiAgICAgIFwiZGVzY2hlZHVsZSBpdCByZWxpYWJseSAoYHRoZSBpbWFnZSB3YXMgbmV2ZXIgYnVpbHRgKVwiLFxuICAgIF0sXG4gIF0pO1xuXG4vKipcbiAqIEV2ZXJ5IGZpbGUgdGhhdCBtdXN0IHN0YXkgb3V0IG9mIHRoZSBwYXJhbGxlbCBwYXNzLlxuICpcbiAqIFRocmVlIHJlYXNvbnMsIG9uZSBsaXN0OiBhIGZpbGUgdGhhdCBtdXRhdGVzIHNoYXJlZCBwcm9jZXNzIHN0YXRlIHJhY2VzIHRoZVxuICogb3RoZXIgd29ya2VycywgYSBmaWxlIHRoYXQgbWVhc3VyZXMgd2FsbC1jbG9jayBpcyBiZWF0ZW4gYnkgdGhlbSwgYW5kIGFcbiAqIGZpbGUgdGhhdCByYWNlcyBhIHJlYWwgc3VicHJvY2VzcyBsb3NlcyB3aGVuIG5pbmUgb2YgdGhlbSBhcmUgY29tcGV0aW5nIGZvclxuICogdGhlIHNjaGVkdWxlci4gQWxsIHRocmVlIHJ1biBpbiB0aGUgc2VyaWFsIHBhc3MsIHNvIHRoZSBnYXRlIG5lZWRzIHRoZVxuICogdW5pb24gYW5kIG5vdGhpbmcgZWxzZS5cbiAqL1xuZXhwb3J0IGNvbnN0IFBBUkFMTEVMX1VOU0FGRV9URVNUX0ZJTEVTOiByZWFkb25seSBzdHJpbmdbXSA9IFtcbiAgLi4ubmV3IFNldChbXG4gICAgLi4uUFJPQ0VTU19TVEFURV9NVVRBVE9SX1RFU1RfRklMRVMsXG4gICAgLi4uV0FMTF9DTE9DS19URVNUX0ZJTEVTLFxuICAgIC4uLlNVQlBST0NFU1NfVElNSU5HX1RFU1RfRklMRVMua2V5cygpLFxuICBdKSxcbl0uc29ydCgpO1xuXG4vKipcbiAqIFdoZXRoZXIgYHNvdXJjZWAgbXV0YXRlcyBwcm9jZXNzLXdpZGUgc3RhdGUuXG4gKlxuICogYERlbm8uZW52LnNldGAsIGBEZW5vLmVudi5kZWxldGVgIGFuZCBgRGVuby5jaGRpcmAgYWxsIHdyaXRlIHN0YXRlIHNoYXJlZFxuICogYnkgZXZlcnkgcGFyYWxsZWwgd29ya2VyIGluIHRoZSBwcm9jZXNzLCBzbyBhIGZpbGUgdGhhdCBjYWxscyBhbnkgb2YgdGhlbVxuICogY2Fubm90IGJlIGluIHRoZSBwYXJhbGxlbCBwYXNzLiBSZWFkaW5nIHRoZSBlbnZpcm9ubWVudCBpcyBmaW5lIGFuZFxuICogZGVsaWJlcmF0ZWx5IG5vdCBtYXRjaGVkLlxuICpcbiAqIGBkZWxldGVgIHdhcyBtaXNzaW5nIGZyb20gdGhlICM4ODAgc3BlbGxpbmcsIGFuZCBmb3VyIHN1aXRlcyByZWFjaCBhXG4gKiBtdXRhdGlvbiBvbmx5IHRocm91Z2ggaXQg4oCUIGB0ZXN0cy9zdXBwb3J0L3JlcG9fcHJvbXB0cy50c2AsIHRoZSBoZWxwZXJcbiAqIHRoYXQgaGlkIDMzIG1vcmUsIG9wZW5zIGJ5IGRlbGV0aW5nIHRoZSBwcm9tcHQtZGlyZWN0b3J5IHZhcmlhYmxlcy5cbiAqXG4gKiBUaGlzIGlzIHRoZSBsZWFmIHByZWRpY2F0ZS4ge0BsaW5rIHJlYWNoZXNJblRlc3RHcmFwaH0gaXMgd2hhdCB0aGVcbiAqIG1hbmlmZXN0cyBhcmUgYWN0dWFsbHkgYnVpbHQgZnJvbSwgYmVjYXVzZSBhIGhlbHBlcidzIG11dGF0aW9uIGJlbG9uZ3MgdG9cbiAqIGV2ZXJ5IHRlc3QgdGhhdCBpbXBvcnRzIGl0LlxuICovXG4vKipcbiAqIGBzb3VyY2VgIHdpdGggaXRzIGNvbW1lbnRzIHJlbW92ZWQgKElzc3VlICM5NDApLlxuICpcbiAqIEJvdGggY2xhc3NpZmllcnMgbWF0Y2ggc291cmNlIHRleHQsIGFuZCBwcm9zZSBpcyBub3QgY29kZS4gSXNzdWUgIzk1NlxuICogZHJhaW5lZCBgY29uZmlnX3Rlc3QudHNgIGFuZCBmcmllbmRzIGJ5IGdpdmluZyBgbGliL2NvbmZpZy50c2AgYW4gaW5qZWN0ZWRcbiAqIGVudiBsb29rdXAsIGFuZCB0aGUgaGVscGVyIGl0IGhhbmRlZCB0aGVtIG9wZW5zOlxuICpcbiAqIGBgYHRzXG4gKiAvLyBUaGUgcmVwbGFjZW1lbnQgZm9yIGBEZW5vLmVudi5zZXRgOiBhIHRlc3QgdGhhdCBuZWVkcyBhIG1vZHVsZSB0byBzZWUg4oCmXG4gKiBgYGBcbiAqXG4gKiBNYXRjaGluZyB0aGF0IHNlbnRlbmNlIGNsYWltZWQgNDAtb2RkIHN1aXRlcyB3aG9zZSB3aG9sZSBwb2ludCBpcyB0aGF0IHRoZXlcbiAqIG5vIGxvbmdlciBtdXRhdGUgYW55dGhpbmcsIGFuZCB0aGUgZHJhaW4gd291bGQgdGhlbiBoYXZlIHJ1biBmb3JldmVyXG4gKiB3aXRob3V0IGV2ZXIgbW92aW5nIGEgZmlsZSBpbnRvIHRoZSBmYXN0IHBhc3MuIE5hbWluZyBhIHBhdHRlcm4gaW4gb3JkZXIgdG9cbiAqIHNheSBcImRvIG5vdCBkbyB0aGlzXCIgbXVzdCBub3QgY291bnQgYXMgZG9pbmcgaXQuXG4gKlxuICogQmxvY2sgY29tbWVudHMgZ28gd2hvbGUuIExpbmUgY29tbWVudHMgZ28gb25seSB3aGVyZSB0aGUgYC8vYCBkb2VzIG5vdFxuICogZm9sbG93IGEgY29sb24sIHNvIGEgYGh0dHBzOi8vYCBpbnNpZGUgYSBzdHJpbmcgbGl0ZXJhbCBpcyBub3QgbWlzdGFrZW4gZm9yXG4gKiBvbmUg4oCUIGxvc2luZyB0aGUgcmVzdCBvZiB0aGF0IGxpbmUgaXMgdGhlIGRhbmdlcm91cyBkaXJlY3Rpb24sIGJlY2F1c2UgaXRcbiAqIGNvdWxkIGhpZGUgYSByZWFsIG11dGF0aW9uLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3RyaXBDb21tZW50cyhzb3VyY2U6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBzb3VyY2VcbiAgICAucmVwbGFjZSgvXFwvXFwqW1xcc1xcU10qP1xcKlxcLy9nLCBcIiBcIilcbiAgICAucmVwbGFjZSgvKF58W146XSlcXC9cXC9bXlxcbl0qL2csIFwiJDFcIik7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtdXRhdGVzUHJvY2Vzc1N0YXRlKHNvdXJjZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiAvRGVub1xcLmVudlxcLihzZXR8ZGVsZXRlKXxEZW5vXFwuY2hkaXIvLnRlc3Qoc3RyaXBDb21tZW50cyhzb3VyY2UpKTtcbn1cblxuLyoqXG4gKiBXaGV0aGVyIGBlbnRyeWAgcmVhY2hlcyBgbWF0Y2hlc2AgdGhyb3VnaCBpdHMgb3duIHNvdXJjZSBvciBhIGhlbHBlciBpdFxuICogaW1wb3J0cyAoSXNzdWUgIzk0MCkuXG4gKlxuICogQSBwcmVkaWNhdGUgYXBwbGllZCB0byBvbmUgZmlsZSdzIG93biB0ZXh0IHN0b3BzIGF0IHRoZSBmaWxlLCBhbmQgdGhlXG4gKiA5Mi1lbnRyeSBiYXNlbGluZSBpdCBwcm9kdWNlZCB3YXMgc2hvcnQgYnkgNDMuXG4gKiBgdGVzdHMvc3VwcG9ydC9yZXBvX3Byb21wdHMudHNgIGRlbGV0ZXMgZXZlcnkgcHJvbXB0LWRpcmVjdG9yeSB2YXJpYWJsZSBhbmRcbiAqIGNhbGxzIGBEZW5vLmNoZGlyKFJFUE9fUk9PVClgICoqYXQgbW9kdWxlIHNjb3BlKiosIHNvIG1lcmVseSBpbXBvcnRpbmcgaXRcbiAqIG11dGF0ZXMgdGhlIHByb2Nlc3M7IDM1IHN1aXRlcyBpbXBvcnQgaXQgYW5kIDMzIG9mIHRoZW1cbiAqIGNvbnRhaW4gbm8gbXV0YXRpb24gb2YgdGhlaXIgb3duLiBVbmRlciBgLS1wYXJhbGxlbGAgdGhvc2UgMzMgd291bGRcbiAqIGhhdmUgbW92ZWQgdGhlIHdvcmtpbmcgZGlyZWN0b3J5IG91dCBmcm9tIHVuZGVyIG5pbmUgb3RoZXIgd29ya2Vycywgd2hpY2hcbiAqIGlzIHRoZSBpbnRlcm1pdHRlbnQgcmVkIHRoZSB3aG9sZSBzcGxpdCBleGlzdHMgdG8gYXZvaWQuXG4gKlxuICogVGhlIHdhbGsgc3RvcHMgYXQgdGhlIGB0ZXN0cy9gIGJvdW5kYXJ5IG9uIHB1cnBvc2UuIEEgc2hhcmVkIGhhcm5lc3MgdW5kZXJcbiAqIGB0ZXN0cy9zdXBwb3J0L2AgaXMgcGFydCBvZiB0aGUgdGVzdCB0aGF0IGltcG9ydHMgaXQuIGBsaWIvYCBpcyB0aGUgY29kZVxuICogdW5kZXIgdGVzdCwgYW5kIGZvbGxvd2luZyBpbnRvIGl0IGNsYWltcyA4MDYgb2YgdGhlIDEsMTk3IHN1aXRlcyDigJQgbW9zdGx5XG4gKiBiZWNhdXNlIHNvbWUgZnVuY3Rpb24gdGhleSBjYW4gcmVhY2ggaXMgKmFibGUqIHRvIHNldCBhIHZhcmlhYmxlLCBub3RcbiAqIGJlY2F1c2UgYW55dGhpbmcgZG9lcy4gVGhhdCBpcyBub3QgYSBjbGFzc2lmaWNhdGlvbiwgaXQgaXMgYSBzdXJyZW5kZXIuXG4gKlxuICogUHVyZSBvdmVyIGFuIGluamVjdGVkIHNvdXJjZSBtYXAgc28gaXQgY2FuIGJlIHRlc3RlZCB3aXRob3V0IGEgZml4dHVyZVxuICogdHJlZSwgYW5kIHNvIHRoZSBjb25mb3JtYW5jZSB0ZXN0cyBhbmQgdGhlIGdhdGUgYWdyZWUgYnkgY29uc3RydWN0aW9uLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVhY2hlc0luVGVzdEdyYXBoKFxuICBlbnRyeTogc3RyaW5nLFxuICBzb3VyY2VzOiBSZWFkb25seU1hcDxzdHJpbmcsIHN0cmluZz4sXG4gIG1hdGNoZXM6IChzb3VyY2U6IHN0cmluZykgPT4gYm9vbGVhbixcbik6IGJvb2xlYW4ge1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IHBlbmRpbmcgPSBbZW50cnldO1xuICB3aGlsZSAocGVuZGluZy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgY3VycmVudCA9IHBlbmRpbmcucG9wKCkhO1xuICAgIGlmIChzZWVuLmhhcyhjdXJyZW50KSkgY29udGludWU7XG4gICAgc2Vlbi5hZGQoY3VycmVudCk7XG4gICAgY29uc3Qgc291cmNlID0gc291cmNlcy5nZXQoY3VycmVudCk7XG4gICAgaWYgKHNvdXJjZSA9PT0gdW5kZWZpbmVkKSBjb250aW51ZTtcbiAgICBpZiAobWF0Y2hlcyhzb3VyY2UpKSByZXR1cm4gdHJ1ZTtcbiAgICBmb3IgKGNvbnN0IHNwZWNpZmllciBvZiByZWxhdGl2ZUltcG9ydHMoc291cmNlKSkge1xuICAgICAgY29uc3QgcmVzb2x2ZWQgPSByZXNvbHZlRnJvbShjdXJyZW50LCBzcGVjaWZpZXIpO1xuICAgICAgLy8gU3RheSBpbnNpZGUgdGhlIHRlc3QgdHJlZTogc2VlIHRoZSBub3RlIGFib3ZlLlxuICAgICAgaWYgKHJlc29sdmVkLnN0YXJ0c1dpdGgoXCJ0ZXN0cy9cIikpIHBlbmRpbmcucHVzaChyZXNvbHZlZCk7XG4gICAgfVxuICB9XG4gIHJldHVybiBmYWxzZTtcbn1cblxuLyoqIFRoZSByZWxhdGl2ZSBzcGVjaWZpZXJzIGBzb3VyY2VgIGltcG9ydHMsIHN0YXRpYyBhbmQgZHluYW1pYy4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWxhdGl2ZUltcG9ydHMoc291cmNlOiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGZvdW5kOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IG1hdGNoIG9mIHNvdXJjZS5tYXRjaEFsbCgvZnJvbVxccytcIihcXC5bXlwiXFxuXSspXCIvZykpIHtcbiAgICBmb3VuZC5wdXNoKG1hdGNoWzFdISk7XG4gIH1cbiAgZm9yIChjb25zdCBtYXRjaCBvZiBzb3VyY2UubWF0Y2hBbGwoL2ltcG9ydFxcKFxccypcIihcXC5bXlwiXFxuXSspXCIvZykpIHtcbiAgICBmb3VuZC5wdXNoKG1hdGNoWzFdISk7XG4gIH1cbiAgcmV0dXJuIGZvdW5kO1xufVxuXG4vKiogYHRlc3RzL2EvYi50c2AgKyBgLi4vYy50c2Ag4oaSIGB0ZXN0cy9jLnRzYC4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlRnJvbShmcm9tOiBzdHJpbmcsIHNwZWNpZmllcjogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgZGlyID0gZnJvbS5zbGljZSgwLCBmcm9tLmxhc3RJbmRleE9mKFwiL1wiKSk7XG4gIGNvbnN0IHNlZ21lbnRzOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IHBhcnQgb2YgYCR7ZGlyfS8ke3NwZWNpZmllcn1gLnNwbGl0KFwiL1wiKSkge1xuICAgIGlmIChwYXJ0ID09PSBcIlwiIHx8IHBhcnQgPT09IFwiLlwiKSBjb250aW51ZTtcbiAgICBpZiAocGFydCA9PT0gXCIuLlwiKSBzZWdtZW50cy5wb3AoKTtcbiAgICBlbHNlIHNlZ21lbnRzLnB1c2gocGFydCk7XG4gIH1cbiAgcmV0dXJuIHNlZ21lbnRzLmpvaW4oXCIvXCIpO1xufVxuXG4vKipcbiAqIFRoZSBgLS1pZ25vcmVgIHZhbHVlIHRoYXQga2VlcHMgdGhlc2UgZmlsZXMgb3V0IG9mIHRoZSBwYXJhbGxlbCBwYXNzLlxuICpcbiAqIE1hdGNoZXMgYGludGVncmF0aW9uVGVzdElnbm9yZUFyZygpYCBzbyB0aGUgdHdvIG1hbmlmZXN0cyBjb21wb3NlIGludG8gb25lXG4gKiBgLS1pZ25vcmVgIGFyZ3VtZW50LlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyYWxsZWxVbnNhZmVJZ25vcmVBcmcoXG4gIGZpbGVzOiByZWFkb25seSBzdHJpbmdbXSA9IFBBUkFMTEVMX1VOU0FGRV9URVNUX0ZJTEVTLFxuKTogc3RyaW5nIHtcbiAgcmV0dXJuIGZpbGVzLmpvaW4oXCIsXCIpO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FrRUMsR0FFRDs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FnQ0MsR0FDRCxPQUFPLE1BQU0sbUNBQXNELEVBQUUsQ0FBQztBQUV0RTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0E4REMsR0FDRCxPQUFPLE1BQU0sd0JBQTJDO0VBQ3RELDBFQUEwRTtFQUMxRTtFQUNBLDJFQUEyRTtFQUMzRSw0RUFBNEU7RUFDNUUscUVBQXFFO0VBQ3JFLGlCQUFpQjtFQUNqQjtFQUNBLDJFQUEyRTtFQUMzRSx1RUFBdUU7RUFDdkUseUVBQXlFO0VBQ3pFO0VBQ0EsNEVBQTRFO0VBQzVFLG1FQUFtRTtFQUNuRTtFQUNBLDRFQUE0RTtFQUM1RSx5RUFBeUU7RUFDekUsNkVBQTZFO0VBQzdFO0VBQ0EsMEVBQTBFO0VBQzFFLHNFQUFzRTtFQUN0RSxzRUFBc0U7RUFDdEUsaURBQWlEO0VBQ2pEO0VBQ0EseUVBQXlFO0VBQ3pFLCtFQUErRTtFQUMvRTtFQUNBLDJFQUEyRTtFQUMzRSxrRUFBa0U7RUFDbEUsb0NBQW9DO0VBQ3BDO0VBQ0EsNEVBQTRFO0VBQzVFLHFFQUFxRTtFQUNyRSxtRUFBbUU7RUFDbkU7RUFDQSw2RUFBNkU7RUFDN0UsNEVBQTRFO0VBQzVFLDJEQUEyRDtFQUMzRDtFQUNBLHlFQUF5RTtFQUN6RSx1RUFBdUU7RUFDdkUsOEJBQThCO0VBQzlCO0VBQ0EsNEVBQTRFO0VBQzVFLG9FQUFvRTtFQUNwRSxvRUFBb0U7RUFDcEU7RUFDQSwyRUFBMkU7RUFDM0UsMkVBQTJFO0VBQzNFLDREQUE0RDtFQUM1RDtFQUNBLDRFQUE0RTtFQUM1RSxzRUFBc0U7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
// denoCacheMetadata=5248501877194134049,900884733146378797