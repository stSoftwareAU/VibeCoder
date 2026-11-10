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
 * list, in {@link SCRIPT_READING_UNIT_TESTS} with a reason, or — since the
 * image began shipping `pwsh` (#1596) — in {@link IN_GATE_SCRIPT_SUITES}
 * with a reason, which is the gate running a script-driving suite on
 * purpose. None of the three is the failure; being in none of them is.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */ import { sourceProseLines } from "./doc_prose_scope.ts";
/**
 * Test files excluded from the gate's default suite.
 *
 * Paths are relative to `worker/deno`, the directory the gate runs `deno test`
 * from.
 */ export const INTEGRATION_TEST_FILES = [
  // Issue #1929: drives .github/scripts/detect-image-changes.sh against
  // throwaway git repositories, the same shape as
  // empty_array_expansion_check_test.ts below.
  "tests/shellcheck_gate_integration_test.ts",
  "tests/shellcheck_publication_test.ts",
  "tests/container_image_change_filter_test.ts",
  "tests/container_provider_deepseek_test.ts",
  "tests/container_provider_set_test.ts",
  "tests/container_restart_backoff_test.ts",
  "tests/container_tools_example_docs_test.ts",
  "tests/container_tools_install_test.ts",
  // Issue #1891: drives .github/scripts/check-empty-array-expansions.sh
  // against throwaway git repositories, the same shape as
  // next_release_tag_test.ts below.
  "tests/empty_array_expansion_check_test.ts",
  "tests/first_run_script_test.ts",
  // Issue #3369 (PR #3478 review): runs infra/cloudformation/test-floci.sh in a
  // throwaway tree under stub aws/curl binaries.
  "tests/issue_3369_floci_script_test.ts",
  // Issue #1594: runs container/install-toolchains.sh against fixture
  // fragments, the same shape as the provider-set suite above.
  "tests/install_toolchains_test.ts",
  "tests/install_tools_test.ts",
  // Issue #873: runs loop.sh in a sandbox to prove the operator's log-directory
  // override reaches the resolver and is written to.
  "tests/log_dir_launcher_test.ts",
  // Issue #4632: drives loop.sh's wedged-container recovery with unrelated
  // Virtualization VM processes, validating that the host process sweep is gone.
  "tests/loop_force_stop_container_test.ts",
  "tests/loop_supervisor_test.ts",
  // Issue #2855: spawns .claude/skills/review-fleet-prs/scripts/run.sh under
  // a stubbed PATH, the same shape as run_sh_launcher_test.ts below. It also
  // runs the old-path forwarding shim at the skill root (Issue #3299).
  "tests/review_fleet_prs_runner_test.ts",
  "tests/run_sh_launcher_test.ts",
  "tests/run_sh_upgrade_test.ts",
  "tests/setup_parity_test.ts",
  // Issue #935: these drive the same scripts through the second idiom for
  // naming them, `new URL("../../../<script>", import.meta.url)`, and so
  // were never classified or excluded.
  "tests/container_entrypoint_test.ts",
  "tests/container_store_prune_test.ts",
  "tests/container_tools_env_test.ts",
  // Issue #1656: stays here by decision, not by accident — 3s inside the
  // image, but nothing in the containment story turns on it being verified
  // locally, so it keeps the integration job's cover rather than the gate's.
  "tests/host_config_path_test.ts",
  "tests/multi_provider_credentials_test.ts",
  "tests/next_release_tag_test.ts",
  "tests/secrets_mount_test.ts",
  "tests/setup_config_atomic_write_test.ts",
  "tests/setup_credential_provisioning_test.ts",
  // Issue #2144: drives setup.sh's resolve_config_file under an ambient
  // CONFIG_PATH, the host variable that turned 40 cases of the setup_*
  // suites beside it red. Same shape, same script, same list.
  "tests/setup_config_env_test.ts",
  "tests/setup_launchagent_prompt_test.ts",
  "tests/setup_lockfile_test.ts",
  "tests/setup_provider_credential_flow_test.ts",
  "tests/setup_provider_env_parse_test.ts",
  // Issue #1656: green inside the image now that its two -ListRepos /
  // -AddRepo cases spawn with an explicit environment instead of the
  // runner's (the image's own CONFIG_PATH used to collide with the case's
  // CONFIG_FILE). Stays here by decision: 9s, and nothing in the
  // containment story turns on setup.ps1 being verified before the push.
  "tests/setup_ps1_test.ts",
  // Issue #4119: drives the real setup.ps1 update mode and setup.sh's config-exists path.
  "tests/setup_ps1_update_mode_test.ts",
  "tests/setup_sh_config_existed_test.ts",
  "tests/setup_token_transcript_cleanup_test.ts",
  "tests/setup_workdir_reminder_test.ts",
  "tests/volume_init_script_test.ts",
  // Issue #1384: runs the entrypoint over a work root laid out with
  // clones beside the worker's own state, then reads the mode bits back.
  "tests/work_root_group_grant_test.ts",
  // Issue #1445: reads the real entrypoint to pin that prompts stay on the
  // read-only checkout mount and are never staged into the writable copy.
  "tests/prompt_immutability_test.ts"
];
/**
 * Script-driving suites the gate runs anyway, and why (Issue #1598).
 *
 * The exclusion above is about a **prerequisite the gate cannot count on**,
 * not about the cost alone: a suite that needs `pwsh` fails on a host that
 * has none, for reasons no change of its own could affect. Issue #1596 baked
 * PowerShell 7 into the container image, so for the `run.ps1` launcher — the
 * Windows containment boundary — that prerequisite is now met wherever the
 * worker runs its gate, and #971's exclusion has outlived its reason.
 *
 * The three entries below cost about 97s of the gate on the image (76s, 15s
 * and 6s, measured serially inside the container at PowerShell 7.6.5). What
 * they buy is a verdict on `run.ps1` **before the push**, from the same gate
 * that decides everything else about the change. CI's cover was uneven:
 * `deno task test:run-mode` already ran two of them in the required
 * `validate (container)` / `validate (no-runtime)` legs, while
 * `launcher_egress_probe_test.ts` was only ever in the `integration tests`
 * job, which deliberately cannot block a merge.
 *
 * The `setup.ps1` suites stay excluded, by decision rather than by
 * default (Issue #1656): nothing in this repository's containment story
 * turns on them being verified locally, and they cost 12s of the gate for
 * that. They are green inside the image — the two cases that used to
 * inherit the runner's environment, and so met the image's own
 * `CONFIG_PATH` beside their `CONFIG_FILE`, now spawn with an explicit one.
 *
 * An entry here is a **named exception with a reason**, exactly as
 * {@link SCRIPT_READING_UNIT_TESTS} is: the classifier claims these files,
 * and being claimed means being placed deliberately in one of the three
 * lists rather than defaulting into any of them.
 *
 * Fail loud, never skip: `pwsh_suites_in_the_gate_test.ts` fails the gate on
 * a host without PowerShell rather than letting these suites report
 * "ignored" and the gate report green.
 */ export const IN_GATE_SCRIPT_SUITES = new Map([
  [
    "tests/launcher_harness_reclaim_stub_test.ts",
    "runs the real run.sh through the shared harness to prove host cache " + "reclaim is intercepted before it can delete host caches; 2.87s for " + "two launches, retained in the gate for test-host safety (Issue #4766)"
  ],
  [
    "tests/launcher_signal_readiness_test.ts",
    "runs run.sh through the shared harness to prove readiness records " + "are safe to signal; retains the required serial coverage and measured " + "scheduler-race reason in SUBPROCESS_TIMING_TEST_FILES (Issue #4766)"
  ],
  [
    "tests/run_ps1_launcher_test.ts",
    "drives run.ps1, the Windows containment boundary, against a stub " + "PATH; the image ships pwsh 7.6.8 (Issue #1596) so the gate can run " + "it — 76s, plus about 11s for Issue #4119's three release-notice " + "cases, in the serial pass because it times a launcher watchdog"
  ],
  [
    "tests/launcher_parity_test.ts",
    "compares the contract run.sh and run.ps1 keep, so a run.ps1 that " + "gains a host-execution path is caught before the push — 15s"
  ],
  [
    "tests/launcher_egress_probe_test.ts",
    "holds run.ps1's egress probe to the same behaviour as run.sh's " + "wherever PowerShell is installed — 6s"
  ],
  [
    "tests/launcher_toolchain_selfcheck_test.ts",
    "holds run.ps1 to run.sh's handling of an image that failed its " + "toolchain self-check (Issue #1956) — the rebuild a Windows host must " + "not skip; 17s"
  ]
]);
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
 */ export const SCRIPT_READING_UNIT_TESTS = new Map([
  [
    "tests/host_cache_reclaim_test.ts",
    "reads run.sh and run.ps1 with Deno.readTextFile to assert both " + "launchers start the host cache reclaim at the floor plus the cargo " + "build headroom (Issue #4540); it never spawns either one"
  ],
  [
    "tests/launcher_egress_selfcheck_test.ts",
    "reads run.sh and run.ps1 with Deno.readTextFile to assert both " + "launchers restate the egress self-check exit status and marker (Issue " + "#4048); it never spawns either one, and runs in milliseconds"
  ],
  [
    "tests/container_manifest_test.ts",
    "reads container/entrypoint.sh with Deno.readTextFile to assert its " + "seed directory matches the Containerfile; runs in 1.2s"
  ],
  [
    "tests/loop_checkout_refresh_test.ts",
    "reads loop.sh and loop.ps1 with Deno.readTextFile to assert both " + "supervisors pull their checkout at the end of every cycle (Issue " + "#1401); it never spawns either one, and runs in milliseconds"
  ],
  [
    "tests/loop_parity_test.ts",
    "reads loop.sh and loop.ps1 with Deno.readTextFile to compare the " + "supervision contract each one keeps (Issue #1403); it never spawns " + "either one, and runs in milliseconds"
  ],
  [
    "tests/loop_log_dir_test.ts",
    "reads loop.sh and loop.ps1 with Deno.readTextFile to assert both " + "supervisors ask `mod.ts log-dir` where their launch logs go (Issue " + "#1402); it never spawns either one, and runs in milliseconds"
  ],
  [
    "tests/container_build_probe_paths_test.ts",
    "reads .github/scripts/detect-image-changes.sh with Deno.readTextFile " + "to take the pull-request pathspecs the image build turns on (Issue " + "#1929); it never spawns the script, and runs in about a second"
  ],
  [
    "tests/workflow_definitions_test.ts",
    "reads .github/scripts/deno-test-shard.sh to assert the workflow and " + "the script agree on sharding; runs in 1.2s"
  ],
  [
    "tests/issue_3369_floci_workflow_test.ts",
    "stat()s infra/cloudformation/test-floci.sh for the executable bit; " + "never spawns it, and runs in milliseconds"
  ]
]);
/**
 * Whether `source` drives one of the repository's own scripts.
 *
 * The signal is deliberately narrow: constructing a repository script path,
 * or passing an imported shared-harness launcher descriptor to its launch
 * helper. Merely importing the harness's path or stub utilities does not
 * claim a test. A test that only spawns `git` is not caught either.
 *
 * Narrow because the cost of a false positive is real: a unit test wrongly
 * excluded stops running on every change, and nobody would notice. A false
 * negative merely leaves a slow test in the gate, which is visible.
 */ export function isIntegrationTestSource(source) {
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
  if (INTEGRATION_SOURCE_PATTERNS.some((pattern)=>pattern.test(source))) {
    return true;
  }
  // The shared harness owns the script path. Importing its helpers alone
  // does not run a script: require a launcher descriptor passed to a spawn.
  const rawLines = source.split("\n");
  const executable = sourceProseLines(source, "test.ts").lines.map((line, index)=>line.code.padEnd(rawLines[index].length)).join("\n");
  // ShellCheck integration suites explicitly require the host binary.
  if (/\bimport\s*\{[^}]*\brequireRealShellcheck\b[^}]*\}\s*from\s*["']\.\/support\/shellcheck_support\.ts["']/.test(source) && /\bawait\s+requireRealShellcheck\s*\(\s*\)/.test(executable)) return true;
  const names = new Set();
  for (const imported of executable.matchAll(/\bimport\s*\{([\w$\s,]+)\}\s*from\s*(["'])/g)){
    const specifierAt = imported.index + imported[0].length;
    if (!source.startsWith(`./fixtures/launcher_harness.ts${imported[2]}`, specifierAt)) continue;
    for (const name of imported[1].split(","))names.add(name.trim());
  }
  for (const call of executable.matchAll(/\b(runLauncher|spawnLauncher)\s*\([^,;()]+,\s*(BASH_LAUNCHER|POWERSHELL_LAUNCHER)\b/g)){
    if (names.has(call[1]) && names.has(call[2])) return true;
  }
  return false;
}
/** Path constructions that name a repository script. */ const INTEGRATION_SOURCE_PATTERNS = [
  // `${REPO_ROOT}/setup.sh`, and the shared harnesses built on it.
  /REPO_ROOT[^\n]*\.(sh|ps1)/,
  // `new URL("../../../setup.sh", import.meta.url)`.
  /new URL\(\s*"[^"\n]*\.(sh|ps1)"/
];
/** The `--ignore` value for the gate's `deno test` invocation. */ export function integrationTestIgnoreArg(files = INTEGRATION_TEST_FILES) {
  return files.join(",");
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9pbnRlZ3JhdGlvbl90ZXN0X21hbmlmZXN0LnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogVGVzdCBmaWxlcyB0aGF0IGV4ZXJjaXNlIHRoZSByZXBvc2l0b3J5J3Mgb3duIHNjcmlwdHMgKElzc3VlICM5MDcpLlxuICpcbiAqIFRoZXNlIGNvcHkgYSByZWFsIGAuc2hgIG9yIGAucHMxYCBpbnRvIGEgdGVtcCBkaXJlY3RvcnksIGJ1aWxkIGEgZmFrZVxuICogYFBBVEhgIG9mIHN0dWIgYmluYXJpZXMsIHNwYXduIGBiYXNoYCBvciBgcHdzaGAsIGFuZCBhc3NlcnQgb24gY2FwdHVyZWRcbiAqIG91dHB1dC4gVGhhdCBpcyBpbnRlZ3JhdGlvbiB0ZXN0aW5nIOKAlCB2YWx1YWJsZSwgYW5kIG5vdGhpbmcgbGlrZSB0aGUgMTYsNjAwXG4gKiB1bml0IHRlc3RzIGJlc2lkZSB0aGVtIHRoYXQgZmluaXNoIGluIG1pY3Jvc2Vjb25kcy5cbiAqXG4gKiBUaGV5IGNvc3Qgcm91Z2hseSAqKjEyIG1pbnV0ZXMgb2YgdGhlIGdhdGUncyB+MzYqKiwgYW5kIHRoZSBnYXRlIHJ1bnMgb25cbiAqIGV2ZXJ5IGNoYW5nZS4gIzg5MSBvcGVucyB3aXRoIHRoZSBjb25zZXF1ZW5jZTpcbiAqXG4gKiA+IEZvdW5kIHdoaWxlIGltcGxlbWVudGluZyAjODM2LCB3aG9zZSBkaWZmIHRvdWNoZXMgb25seSBgcHJvbXB0cy8qKmAgYW5kXG4gKiA+IGNhbm5vdCByZWFjaCBhbnkgb2YgdGhpcy5cbiAqXG4gKiBBIHByb21wdHMtb25seSBjaGFuZ2Ugc3BlbnQgdGVucyBvZiBtaW51dGVzIHByb2R1Y2luZyBhIHZlcmRpY3QgYWJvdXRcbiAqIGNvbnRhaW5lciBwbHVtYmluZyBpdCBuZXZlciB0b3VjaGVkIOKAlCBhbmQgdGhlIHZlcmRpY3Qgd2FzIHdyb25nLCBiZWNhdXNlXG4gKiB0d28gb2YgdGhvc2UgdGVzdHMgZmFpbGVkIG9uIHRoZSBjb250YWluZXIgcmVnYXJkbGVzcyBvZiB0aGUgY2hhbmdlLlxuICpcbiAqIE5vYm9keSBleHBlY3RzIGEgQ2xvdWRGb3JtYXRpb24gZGVwbG95bWVudCB0byBydW4gb24gYSBzcGVsbGluZyBmaXguIFRoaXNcbiAqIGlzIHRoZSBzYW1lIGNhdGVnb3J5LCBzbyB0aGUgd29ya2VyJ3MgZ2F0ZSBza2lwcyB0aGVtIGFuZCBDSSBydW5zIHRoZW0sXG4gKiB3aGVyZSBzaGFyZGluZyBhYnNvcmJzIHRoZSBjb3N0IGFuZCB0aGUgZW52aXJvbm1lbnQgaXMgcHJvdmlzaW9uZWQgZm9yIGl0LlxuICpcbiAqIFRoZSBsaXN0IGlzIG5vdCB0aGUgY2xhc3NpZmljYXRpb24g4oCUIHtAbGluayBpc0ludGVncmF0aW9uVGVzdFNvdXJjZX0gaXMuXG4gKiBgaW50ZWdyYXRpb25fdGVzdF9tYW5pZmVzdF90ZXN0LnRzYCBmYWlscyB3aGVuIHRoZSB0d28gZGlzYWdyZWUgaW4gZWl0aGVyXG4gKiBkaXJlY3Rpb24sIHNvIGEgbmV3IHNjcmlwdC1kcml2aW5nIHRlc3QgY2Fubm90IHF1aWV0bHkgam9pbiB0aGUgZ2F0ZSdzIHBhdGhcbiAqIGFuZCBhIHJldGlyZWQgb25lIGNhbm5vdCBsaW5nZXIgaGVyZSB1bm5vdGljZWQuXG4gKlxuICogVGhhdCBjbGFpbSB3YXMgb25seSB0cnVlIG9mIG9uZSBpZGlvbSB1bnRpbCBJc3N1ZSAjOTM1LiBUaGUgY2xhc3NpZmllclxuICogcmVjb2duaXNlZCBgJHtSRVBPX1JPT1R9L3NldHVwLnNoYCBhbmQgbm90XG4gKiBgbmV3IFVSTChcIi4uLy4uLy4uL3NldHVwLnNoXCIsIGltcG9ydC5tZXRhLnVybClgLCBzbyBmb3VydGVlbiBzdWl0ZXNcbiAqIGRyaXZpbmcgYHNldHVwLnNoYCwgYHZvbHVtZS1pbml0LnNoYCBhbmQgdGhlIGNvbnRhaW5lciBlbnRyeXBvaW50IHdlcmVcbiAqIG5ldmVyIGNsYWltZWQgYnkgaXQg4oCUIGFuZCBhIGNvbmZvcm1hbmNlIHRlc3QgY29tcGFyaW5nIHR3byBsaXN0cyBjYW5ub3RcbiAqIHJlcG9ydCBhIGRpc2FncmVlbWVudCBhYm91dCBhIGZpbGUgbmVpdGhlciBsaXN0IG1lbnRpb25zLiBBbW9uZyB0aGVtIHdhc1xuICogb25lIHRoYXQgZmFpbHMgb24gYSBtYWNPUyBob3N0IGZvciByZWFzb25zIG5vIGNoYW5nZSBvZiBpdHMgb3duIGNvdWxkXG4gKiBhZmZlY3QsIHdoaWNoIHR3byBzZXBhcmF0ZSBhZ2VudHMgcmVwb3J0ZWQgYXMgXCJhIHByZS1leGlzdGluZyBmYWlsdXJlIG9uXG4gKiBtYWluXCIgd2hpbGUgd29ya2luZyBvbiBzb21ldGhpbmcgZWxzZS5cbiAqXG4gKiBBIGZpbGUgdGhlIGNsYXNzaWZpZXIgY2xhaW1zIG11c3Qgbm93IGJlIHBsYWNlZCBkZWxpYmVyYXRlbHk6IGluIHRoaXNcbiAqIGxpc3QsIGluIHtAbGluayBTQ1JJUFRfUkVBRElOR19VTklUX1RFU1RTfSB3aXRoIGEgcmVhc29uLCBvciDigJQgc2luY2UgdGhlXG4gKiBpbWFnZSBiZWdhbiBzaGlwcGluZyBgcHdzaGAgKCMxNTk2KSDigJQgaW4ge0BsaW5rIElOX0dBVEVfU0NSSVBUX1NVSVRFU31cbiAqIHdpdGggYSByZWFzb24sIHdoaWNoIGlzIHRoZSBnYXRlIHJ1bm5pbmcgYSBzY3JpcHQtZHJpdmluZyBzdWl0ZSBvblxuICogcHVycG9zZS4gTm9uZSBvZiB0aGUgdGhyZWUgaXMgdGhlIGZhaWx1cmU7IGJlaW5nIGluIG5vbmUgb2YgdGhlbSBpcy5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCBzcGVsbGluZyAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbiwgZXRjLilcbiAqL1xuXG5pbXBvcnQgeyBzb3VyY2VQcm9zZUxpbmVzIH0gZnJvbSBcIi4vZG9jX3Byb3NlX3Njb3BlLnRzXCI7XG5cbi8qKlxuICogVGVzdCBmaWxlcyBleGNsdWRlZCBmcm9tIHRoZSBnYXRlJ3MgZGVmYXVsdCBzdWl0ZS5cbiAqXG4gKiBQYXRocyBhcmUgcmVsYXRpdmUgdG8gYHdvcmtlci9kZW5vYCwgdGhlIGRpcmVjdG9yeSB0aGUgZ2F0ZSBydW5zIGBkZW5vIHRlc3RgXG4gKiBmcm9tLlxuICovXG5leHBvcnQgY29uc3QgSU5URUdSQVRJT05fVEVTVF9GSUxFUzogcmVhZG9ubHkgc3RyaW5nW10gPSBbXG4gIC8vIElzc3VlICMxOTI5OiBkcml2ZXMgLmdpdGh1Yi9zY3JpcHRzL2RldGVjdC1pbWFnZS1jaGFuZ2VzLnNoIGFnYWluc3RcbiAgLy8gdGhyb3dhd2F5IGdpdCByZXBvc2l0b3JpZXMsIHRoZSBzYW1lIHNoYXBlIGFzXG4gIC8vIGVtcHR5X2FycmF5X2V4cGFuc2lvbl9jaGVja190ZXN0LnRzIGJlbG93LlxuICBcInRlc3RzL3NoZWxsY2hlY2tfZ2F0ZV9pbnRlZ3JhdGlvbl90ZXN0LnRzXCIsXG4gIFwidGVzdHMvc2hlbGxjaGVja19wdWJsaWNhdGlvbl90ZXN0LnRzXCIsXG4gIFwidGVzdHMvY29udGFpbmVyX2ltYWdlX2NoYW5nZV9maWx0ZXJfdGVzdC50c1wiLFxuICBcInRlc3RzL2NvbnRhaW5lcl9wcm92aWRlcl9kZWVwc2Vla190ZXN0LnRzXCIsXG4gIFwidGVzdHMvY29udGFpbmVyX3Byb3ZpZGVyX3NldF90ZXN0LnRzXCIsXG4gIFwidGVzdHMvY29udGFpbmVyX3Jlc3RhcnRfYmFja29mZl90ZXN0LnRzXCIsXG4gIFwidGVzdHMvY29udGFpbmVyX3Rvb2xzX2V4YW1wbGVfZG9jc190ZXN0LnRzXCIsXG4gIFwidGVzdHMvY29udGFpbmVyX3Rvb2xzX2luc3RhbGxfdGVzdC50c1wiLFxuICAvLyBJc3N1ZSAjMTg5MTogZHJpdmVzIC5naXRodWIvc2NyaXB0cy9jaGVjay1lbXB0eS1hcnJheS1leHBhbnNpb25zLnNoXG4gIC8vIGFnYWluc3QgdGhyb3dhd2F5IGdpdCByZXBvc2l0b3JpZXMsIHRoZSBzYW1lIHNoYXBlIGFzXG4gIC8vIG5leHRfcmVsZWFzZV90YWdfdGVzdC50cyBiZWxvdy5cbiAgXCJ0ZXN0cy9lbXB0eV9hcnJheV9leHBhbnNpb25fY2hlY2tfdGVzdC50c1wiLFxuICBcInRlc3RzL2ZpcnN0X3J1bl9zY3JpcHRfdGVzdC50c1wiLFxuICAvLyBJc3N1ZSAjMzM2OSAoUFIgIzM0NzggcmV2aWV3KTogcnVucyBpbmZyYS9jbG91ZGZvcm1hdGlvbi90ZXN0LWZsb2NpLnNoIGluIGFcbiAgLy8gdGhyb3dhd2F5IHRyZWUgdW5kZXIgc3R1YiBhd3MvY3VybCBiaW5hcmllcy5cbiAgXCJ0ZXN0cy9pc3N1ZV8zMzY5X2Zsb2NpX3NjcmlwdF90ZXN0LnRzXCIsXG4gIC8vIElzc3VlICMxNTk0OiBydW5zIGNvbnRhaW5lci9pbnN0YWxsLXRvb2xjaGFpbnMuc2ggYWdhaW5zdCBmaXh0dXJlXG4gIC8vIGZyYWdtZW50cywgdGhlIHNhbWUgc2hhcGUgYXMgdGhlIHByb3ZpZGVyLXNldCBzdWl0ZSBhYm92ZS5cbiAgXCJ0ZXN0cy9pbnN0YWxsX3Rvb2xjaGFpbnNfdGVzdC50c1wiLFxuICBcInRlc3RzL2luc3RhbGxfdG9vbHNfdGVzdC50c1wiLFxuICAvLyBJc3N1ZSAjODczOiBydW5zIGxvb3Auc2ggaW4gYSBzYW5kYm94IHRvIHByb3ZlIHRoZSBvcGVyYXRvcidzIGxvZy1kaXJlY3RvcnlcbiAgLy8gb3ZlcnJpZGUgcmVhY2hlcyB0aGUgcmVzb2x2ZXIgYW5kIGlzIHdyaXR0ZW4gdG8uXG4gIFwidGVzdHMvbG9nX2Rpcl9sYXVuY2hlcl90ZXN0LnRzXCIsXG4gIC8vIElzc3VlICM0NjMyOiBkcml2ZXMgbG9vcC5zaCdzIHdlZGdlZC1jb250YWluZXIgcmVjb3Zlcnkgd2l0aCB1bnJlbGF0ZWRcbiAgLy8gVmlydHVhbGl6YXRpb24gVk0gcHJvY2Vzc2VzLCB2YWxpZGF0aW5nIHRoYXQgdGhlIGhvc3QgcHJvY2VzcyBzd2VlcCBpcyBnb25lLlxuICBcInRlc3RzL2xvb3BfZm9yY2Vfc3RvcF9jb250YWluZXJfdGVzdC50c1wiLFxuICBcInRlc3RzL2xvb3Bfc3VwZXJ2aXNvcl90ZXN0LnRzXCIsXG4gIC8vIElzc3VlICMyODU1OiBzcGF3bnMgLmNsYXVkZS9za2lsbHMvcmV2aWV3LWZsZWV0LXBycy9zY3JpcHRzL3J1bi5zaCB1bmRlclxuICAvLyBhIHN0dWJiZWQgUEFUSCwgdGhlIHNhbWUgc2hhcGUgYXMgcnVuX3NoX2xhdW5jaGVyX3Rlc3QudHMgYmVsb3cuIEl0IGFsc29cbiAgLy8gcnVucyB0aGUgb2xkLXBhdGggZm9yd2FyZGluZyBzaGltIGF0IHRoZSBza2lsbCByb290IChJc3N1ZSAjMzI5OSkuXG4gIFwidGVzdHMvcmV2aWV3X2ZsZWV0X3Byc19ydW5uZXJfdGVzdC50c1wiLFxuICBcInRlc3RzL3J1bl9zaF9sYXVuY2hlcl90ZXN0LnRzXCIsXG4gIFwidGVzdHMvcnVuX3NoX3VwZ3JhZGVfdGVzdC50c1wiLFxuICBcInRlc3RzL3NldHVwX3Bhcml0eV90ZXN0LnRzXCIsXG4gIC8vIElzc3VlICM5MzU6IHRoZXNlIGRyaXZlIHRoZSBzYW1lIHNjcmlwdHMgdGhyb3VnaCB0aGUgc2Vjb25kIGlkaW9tIGZvclxuICAvLyBuYW1pbmcgdGhlbSwgYG5ldyBVUkwoXCIuLi8uLi8uLi88c2NyaXB0PlwiLCBpbXBvcnQubWV0YS51cmwpYCwgYW5kIHNvXG4gIC8vIHdlcmUgbmV2ZXIgY2xhc3NpZmllZCBvciBleGNsdWRlZC5cbiAgXCJ0ZXN0cy9jb250YWluZXJfZW50cnlwb2ludF90ZXN0LnRzXCIsXG4gIFwidGVzdHMvY29udGFpbmVyX3N0b3JlX3BydW5lX3Rlc3QudHNcIixcbiAgXCJ0ZXN0cy9jb250YWluZXJfdG9vbHNfZW52X3Rlc3QudHNcIixcbiAgLy8gSXNzdWUgIzE2NTY6IHN0YXlzIGhlcmUgYnkgZGVjaXNpb24sIG5vdCBieSBhY2NpZGVudCDigJQgM3MgaW5zaWRlIHRoZVxuICAvLyBpbWFnZSwgYnV0IG5vdGhpbmcgaW4gdGhlIGNvbnRhaW5tZW50IHN0b3J5IHR1cm5zIG9uIGl0IGJlaW5nIHZlcmlmaWVkXG4gIC8vIGxvY2FsbHksIHNvIGl0IGtlZXBzIHRoZSBpbnRlZ3JhdGlvbiBqb2IncyBjb3ZlciByYXRoZXIgdGhhbiB0aGUgZ2F0ZSdzLlxuICBcInRlc3RzL2hvc3RfY29uZmlnX3BhdGhfdGVzdC50c1wiLFxuICBcInRlc3RzL211bHRpX3Byb3ZpZGVyX2NyZWRlbnRpYWxzX3Rlc3QudHNcIixcbiAgXCJ0ZXN0cy9uZXh0X3JlbGVhc2VfdGFnX3Rlc3QudHNcIixcbiAgXCJ0ZXN0cy9zZWNyZXRzX21vdW50X3Rlc3QudHNcIixcbiAgXCJ0ZXN0cy9zZXR1cF9jb25maWdfYXRvbWljX3dyaXRlX3Rlc3QudHNcIixcbiAgXCJ0ZXN0cy9zZXR1cF9jcmVkZW50aWFsX3Byb3Zpc2lvbmluZ190ZXN0LnRzXCIsXG4gIC8vIElzc3VlICMyMTQ0OiBkcml2ZXMgc2V0dXAuc2gncyByZXNvbHZlX2NvbmZpZ19maWxlIHVuZGVyIGFuIGFtYmllbnRcbiAgLy8gQ09ORklHX1BBVEgsIHRoZSBob3N0IHZhcmlhYmxlIHRoYXQgdHVybmVkIDQwIGNhc2VzIG9mIHRoZSBzZXR1cF8qXG4gIC8vIHN1aXRlcyBiZXNpZGUgaXQgcmVkLiBTYW1lIHNoYXBlLCBzYW1lIHNjcmlwdCwgc2FtZSBsaXN0LlxuICBcInRlc3RzL3NldHVwX2NvbmZpZ19lbnZfdGVzdC50c1wiLFxuICBcInRlc3RzL3NldHVwX2xhdW5jaGFnZW50X3Byb21wdF90ZXN0LnRzXCIsXG4gIFwidGVzdHMvc2V0dXBfbG9ja2ZpbGVfdGVzdC50c1wiLFxuICBcInRlc3RzL3NldHVwX3Byb3ZpZGVyX2NyZWRlbnRpYWxfZmxvd190ZXN0LnRzXCIsXG4gIFwidGVzdHMvc2V0dXBfcHJvdmlkZXJfZW52X3BhcnNlX3Rlc3QudHNcIixcbiAgLy8gSXNzdWUgIzE2NTY6IGdyZWVuIGluc2lkZSB0aGUgaW1hZ2Ugbm93IHRoYXQgaXRzIHR3byAtTGlzdFJlcG9zIC9cbiAgLy8gLUFkZFJlcG8gY2FzZXMgc3Bhd24gd2l0aCBhbiBleHBsaWNpdCBlbnZpcm9ubWVudCBpbnN0ZWFkIG9mIHRoZVxuICAvLyBydW5uZXIncyAodGhlIGltYWdlJ3Mgb3duIENPTkZJR19QQVRIIHVzZWQgdG8gY29sbGlkZSB3aXRoIHRoZSBjYXNlJ3NcbiAgLy8gQ09ORklHX0ZJTEUpLiBTdGF5cyBoZXJlIGJ5IGRlY2lzaW9uOiA5cywgYW5kIG5vdGhpbmcgaW4gdGhlXG4gIC8vIGNvbnRhaW5tZW50IHN0b3J5IHR1cm5zIG9uIHNldHVwLnBzMSBiZWluZyB2ZXJpZmllZCBiZWZvcmUgdGhlIHB1c2guXG4gIFwidGVzdHMvc2V0dXBfcHMxX3Rlc3QudHNcIixcbiAgLy8gSXNzdWUgIzQxMTk6IGRyaXZlcyB0aGUgcmVhbCBzZXR1cC5wczEgdXBkYXRlIG1vZGUgYW5kIHNldHVwLnNoJ3MgY29uZmlnLWV4aXN0cyBwYXRoLlxuICBcInRlc3RzL3NldHVwX3BzMV91cGRhdGVfbW9kZV90ZXN0LnRzXCIsXG4gIFwidGVzdHMvc2V0dXBfc2hfY29uZmlnX2V4aXN0ZWRfdGVzdC50c1wiLFxuICBcInRlc3RzL3NldHVwX3Rva2VuX3RyYW5zY3JpcHRfY2xlYW51cF90ZXN0LnRzXCIsXG4gIFwidGVzdHMvc2V0dXBfd29ya2Rpcl9yZW1pbmRlcl90ZXN0LnRzXCIsXG4gIFwidGVzdHMvdm9sdW1lX2luaXRfc2NyaXB0X3Rlc3QudHNcIixcbiAgLy8gSXNzdWUgIzEzODQ6IHJ1bnMgdGhlIGVudHJ5cG9pbnQgb3ZlciBhIHdvcmsgcm9vdCBsYWlkIG91dCB3aXRoXG4gIC8vIGNsb25lcyBiZXNpZGUgdGhlIHdvcmtlcidzIG93biBzdGF0ZSwgdGhlbiByZWFkcyB0aGUgbW9kZSBiaXRzIGJhY2suXG4gIFwidGVzdHMvd29ya19yb290X2dyb3VwX2dyYW50X3Rlc3QudHNcIixcbiAgLy8gSXNzdWUgIzE0NDU6IHJlYWRzIHRoZSByZWFsIGVudHJ5cG9pbnQgdG8gcGluIHRoYXQgcHJvbXB0cyBzdGF5IG9uIHRoZVxuICAvLyByZWFkLW9ubHkgY2hlY2tvdXQgbW91bnQgYW5kIGFyZSBuZXZlciBzdGFnZWQgaW50byB0aGUgd3JpdGFibGUgY29weS5cbiAgXCJ0ZXN0cy9wcm9tcHRfaW1tdXRhYmlsaXR5X3Rlc3QudHNcIixcbl07XG5cbi8qKlxuICogU2NyaXB0LWRyaXZpbmcgc3VpdGVzIHRoZSBnYXRlIHJ1bnMgYW55d2F5LCBhbmQgd2h5IChJc3N1ZSAjMTU5OCkuXG4gKlxuICogVGhlIGV4Y2x1c2lvbiBhYm92ZSBpcyBhYm91dCBhICoqcHJlcmVxdWlzaXRlIHRoZSBnYXRlIGNhbm5vdCBjb3VudCBvbioqLFxuICogbm90IGFib3V0IHRoZSBjb3N0IGFsb25lOiBhIHN1aXRlIHRoYXQgbmVlZHMgYHB3c2hgIGZhaWxzIG9uIGEgaG9zdCB0aGF0XG4gKiBoYXMgbm9uZSwgZm9yIHJlYXNvbnMgbm8gY2hhbmdlIG9mIGl0cyBvd24gY291bGQgYWZmZWN0LiBJc3N1ZSAjMTU5NiBiYWtlZFxuICogUG93ZXJTaGVsbCA3IGludG8gdGhlIGNvbnRhaW5lciBpbWFnZSwgc28gZm9yIHRoZSBgcnVuLnBzMWAgbGF1bmNoZXIg4oCUIHRoZVxuICogV2luZG93cyBjb250YWlubWVudCBib3VuZGFyeSDigJQgdGhhdCBwcmVyZXF1aXNpdGUgaXMgbm93IG1ldCB3aGVyZXZlciB0aGVcbiAqIHdvcmtlciBydW5zIGl0cyBnYXRlLCBhbmQgIzk3MSdzIGV4Y2x1c2lvbiBoYXMgb3V0bGl2ZWQgaXRzIHJlYXNvbi5cbiAqXG4gKiBUaGUgdGhyZWUgZW50cmllcyBiZWxvdyBjb3N0IGFib3V0IDk3cyBvZiB0aGUgZ2F0ZSBvbiB0aGUgaW1hZ2UgKDc2cywgMTVzXG4gKiBhbmQgNnMsIG1lYXN1cmVkIHNlcmlhbGx5IGluc2lkZSB0aGUgY29udGFpbmVyIGF0IFBvd2VyU2hlbGwgNy42LjUpLiBXaGF0XG4gKiB0aGV5IGJ1eSBpcyBhIHZlcmRpY3Qgb24gYHJ1bi5wczFgICoqYmVmb3JlIHRoZSBwdXNoKiosIGZyb20gdGhlIHNhbWUgZ2F0ZVxuICogdGhhdCBkZWNpZGVzIGV2ZXJ5dGhpbmcgZWxzZSBhYm91dCB0aGUgY2hhbmdlLiBDSSdzIGNvdmVyIHdhcyB1bmV2ZW46XG4gKiBgZGVubyB0YXNrIHRlc3Q6cnVuLW1vZGVgIGFscmVhZHkgcmFuIHR3byBvZiB0aGVtIGluIHRoZSByZXF1aXJlZFxuICogYHZhbGlkYXRlIChjb250YWluZXIpYCAvIGB2YWxpZGF0ZSAobm8tcnVudGltZSlgIGxlZ3MsIHdoaWxlXG4gKiBgbGF1bmNoZXJfZWdyZXNzX3Byb2JlX3Rlc3QudHNgIHdhcyBvbmx5IGV2ZXIgaW4gdGhlIGBpbnRlZ3JhdGlvbiB0ZXN0c2BcbiAqIGpvYiwgd2hpY2ggZGVsaWJlcmF0ZWx5IGNhbm5vdCBibG9jayBhIG1lcmdlLlxuICpcbiAqIFRoZSBgc2V0dXAucHMxYCBzdWl0ZXMgc3RheSBleGNsdWRlZCwgYnkgZGVjaXNpb24gcmF0aGVyIHRoYW4gYnlcbiAqIGRlZmF1bHQgKElzc3VlICMxNjU2KTogbm90aGluZyBpbiB0aGlzIHJlcG9zaXRvcnkncyBjb250YWlubWVudCBzdG9yeVxuICogdHVybnMgb24gdGhlbSBiZWluZyB2ZXJpZmllZCBsb2NhbGx5LCBhbmQgdGhleSBjb3N0IDEycyBvZiB0aGUgZ2F0ZSBmb3JcbiAqIHRoYXQuIFRoZXkgYXJlIGdyZWVuIGluc2lkZSB0aGUgaW1hZ2Ug4oCUIHRoZSB0d28gY2FzZXMgdGhhdCB1c2VkIHRvXG4gKiBpbmhlcml0IHRoZSBydW5uZXIncyBlbnZpcm9ubWVudCwgYW5kIHNvIG1ldCB0aGUgaW1hZ2UncyBvd25cbiAqIGBDT05GSUdfUEFUSGAgYmVzaWRlIHRoZWlyIGBDT05GSUdfRklMRWAsIG5vdyBzcGF3biB3aXRoIGFuIGV4cGxpY2l0IG9uZS5cbiAqXG4gKiBBbiBlbnRyeSBoZXJlIGlzIGEgKipuYW1lZCBleGNlcHRpb24gd2l0aCBhIHJlYXNvbioqLCBleGFjdGx5IGFzXG4gKiB7QGxpbmsgU0NSSVBUX1JFQURJTkdfVU5JVF9URVNUU30gaXM6IHRoZSBjbGFzc2lmaWVyIGNsYWltcyB0aGVzZSBmaWxlcyxcbiAqIGFuZCBiZWluZyBjbGFpbWVkIG1lYW5zIGJlaW5nIHBsYWNlZCBkZWxpYmVyYXRlbHkgaW4gb25lIG9mIHRoZSB0aHJlZVxuICogbGlzdHMgcmF0aGVyIHRoYW4gZGVmYXVsdGluZyBpbnRvIGFueSBvZiB0aGVtLlxuICpcbiAqIEZhaWwgbG91ZCwgbmV2ZXIgc2tpcDogYHB3c2hfc3VpdGVzX2luX3RoZV9nYXRlX3Rlc3QudHNgIGZhaWxzIHRoZSBnYXRlIG9uXG4gKiBhIGhvc3Qgd2l0aG91dCBQb3dlclNoZWxsIHJhdGhlciB0aGFuIGxldHRpbmcgdGhlc2Ugc3VpdGVzIHJlcG9ydFxuICogXCJpZ25vcmVkXCIgYW5kIHRoZSBnYXRlIHJlcG9ydCBncmVlbi5cbiAqL1xuZXhwb3J0IGNvbnN0IElOX0dBVEVfU0NSSVBUX1NVSVRFUzogUmVhZG9ubHlNYXA8c3RyaW5nLCBzdHJpbmc+ID0gbmV3IE1hcChbXG4gIFtcbiAgICBcInRlc3RzL2xhdW5jaGVyX2hhcm5lc3NfcmVjbGFpbV9zdHViX3Rlc3QudHNcIixcbiAgICBcInJ1bnMgdGhlIHJlYWwgcnVuLnNoIHRocm91Z2ggdGhlIHNoYXJlZCBoYXJuZXNzIHRvIHByb3ZlIGhvc3QgY2FjaGUgXCIgK1xuICAgIFwicmVjbGFpbSBpcyBpbnRlcmNlcHRlZCBiZWZvcmUgaXQgY2FuIGRlbGV0ZSBob3N0IGNhY2hlczsgMi44N3MgZm9yIFwiICtcbiAgICBcInR3byBsYXVuY2hlcywgcmV0YWluZWQgaW4gdGhlIGdhdGUgZm9yIHRlc3QtaG9zdCBzYWZldHkgKElzc3VlICM0NzY2KVwiLFxuICBdLFxuICBbXG4gICAgXCJ0ZXN0cy9sYXVuY2hlcl9zaWduYWxfcmVhZGluZXNzX3Rlc3QudHNcIixcbiAgICBcInJ1bnMgcnVuLnNoIHRocm91Z2ggdGhlIHNoYXJlZCBoYXJuZXNzIHRvIHByb3ZlIHJlYWRpbmVzcyByZWNvcmRzIFwiICtcbiAgICBcImFyZSBzYWZlIHRvIHNpZ25hbDsgcmV0YWlucyB0aGUgcmVxdWlyZWQgc2VyaWFsIGNvdmVyYWdlIGFuZCBtZWFzdXJlZCBcIiArXG4gICAgXCJzY2hlZHVsZXItcmFjZSByZWFzb24gaW4gU1VCUFJPQ0VTU19USU1JTkdfVEVTVF9GSUxFUyAoSXNzdWUgIzQ3NjYpXCIsXG4gIF0sXG4gIFtcbiAgICBcInRlc3RzL3J1bl9wczFfbGF1bmNoZXJfdGVzdC50c1wiLFxuICAgIFwiZHJpdmVzIHJ1bi5wczEsIHRoZSBXaW5kb3dzIGNvbnRhaW5tZW50IGJvdW5kYXJ5LCBhZ2FpbnN0IGEgc3R1YiBcIiArXG4gICAgXCJQQVRIOyB0aGUgaW1hZ2Ugc2hpcHMgcHdzaCA3LjYuOCAoSXNzdWUgIzE1OTYpIHNvIHRoZSBnYXRlIGNhbiBydW4gXCIgK1xuICAgIFwiaXQg4oCUIDc2cywgcGx1cyBhYm91dCAxMXMgZm9yIElzc3VlICM0MTE5J3MgdGhyZWUgcmVsZWFzZS1ub3RpY2UgXCIgK1xuICAgIFwiY2FzZXMsIGluIHRoZSBzZXJpYWwgcGFzcyBiZWNhdXNlIGl0IHRpbWVzIGEgbGF1bmNoZXIgd2F0Y2hkb2dcIixcbiAgXSxcbiAgW1xuICAgIFwidGVzdHMvbGF1bmNoZXJfcGFyaXR5X3Rlc3QudHNcIixcbiAgICBcImNvbXBhcmVzIHRoZSBjb250cmFjdCBydW4uc2ggYW5kIHJ1bi5wczEga2VlcCwgc28gYSBydW4ucHMxIHRoYXQgXCIgK1xuICAgIFwiZ2FpbnMgYSBob3N0LWV4ZWN1dGlvbiBwYXRoIGlzIGNhdWdodCBiZWZvcmUgdGhlIHB1c2gg4oCUIDE1c1wiLFxuICBdLFxuICBbXG4gICAgXCJ0ZXN0cy9sYXVuY2hlcl9lZ3Jlc3NfcHJvYmVfdGVzdC50c1wiLFxuICAgIFwiaG9sZHMgcnVuLnBzMSdzIGVncmVzcyBwcm9iZSB0byB0aGUgc2FtZSBiZWhhdmlvdXIgYXMgcnVuLnNoJ3MgXCIgK1xuICAgIFwid2hlcmV2ZXIgUG93ZXJTaGVsbCBpcyBpbnN0YWxsZWQg4oCUIDZzXCIsXG4gIF0sXG4gIFtcbiAgICBcInRlc3RzL2xhdW5jaGVyX3Rvb2xjaGFpbl9zZWxmY2hlY2tfdGVzdC50c1wiLFxuICAgIFwiaG9sZHMgcnVuLnBzMSB0byBydW4uc2gncyBoYW5kbGluZyBvZiBhbiBpbWFnZSB0aGF0IGZhaWxlZCBpdHMgXCIgK1xuICAgIFwidG9vbGNoYWluIHNlbGYtY2hlY2sgKElzc3VlICMxOTU2KSDigJQgdGhlIHJlYnVpbGQgYSBXaW5kb3dzIGhvc3QgbXVzdCBcIiArXG4gICAgXCJub3Qgc2tpcDsgMTdzXCIsXG4gIF0sXG5dKTtcblxuLyoqXG4gKiBGaWxlcyB0aGUgY2xhc3NpZmllciBjbGFpbXMgdGhhdCBhcmUgKipub3QqKiBpbnRlZ3JhdGlvbiB0ZXN0cyAoSXNzdWUgIzkzNSkuXG4gKlxuICogQm90aCByZWFkIGEgcmVwb3NpdG9yeSBzY3JpcHQgYW5kIGFzc2VydCBvbiBpdHMgdGV4dCB3aXRob3V0IGV2ZXIgcnVubmluZ1xuICogaXQsIHNvIGJvdGggZmluaXNoIGluIGFib3V0IGEgc2Vjb25kLiBFeGNsdWRpbmcgdGhlbSB3b3VsZCB0YWtlIGEgcmVhbFxuICogdW5pdCB0ZXN0IG91dCBvZiB0aGUgZ2F0ZSDigJQgdGhlIGZhbHNlIHBvc2l0aXZlIHRoZSBjbGFzc2lmaWVyJ3MgZGVzaWduXG4gKiBub3RlIGNhbGxzIHRoZSBleHBlbnNpdmUgb25lLCBiZWNhdXNlIG5vYm9keSBub3RpY2VzIGEgdGVzdCB0aGF0IHF1aWV0bHlcbiAqIHN0b3BzIHJ1bm5pbmcuXG4gKlxuICogVGhlIGVudHJ5IGlzIHJlcXVpcmVkIHJhdGhlciB0aGFuIGluZmVycmVkOiBhIGZpbGUgdGhhdCBjb25zdHJ1Y3RzIGEgcGF0aFxuICogdG8gYSBzY3JpcHQgaGFzIHRvIGJlIHBsYWNlZCBpbiBvbmUgbGlzdCBvciB0aGUgb3RoZXIgZGVsaWJlcmF0ZWx5LCBzbyBhXG4gKiBzdWl0ZSB0aGF0IGxhdGVyIGdyb3dzIGEgc3Bhd24gY2Fubm90IGtlZXAgYSBcInJlYWRzIGl0IG9ubHlcIiBleGVtcHRpb24gaXRcbiAqIHNpbGVudGx5IG91dGdyZXcuXG4gKi9cbmV4cG9ydCBjb25zdCBTQ1JJUFRfUkVBRElOR19VTklUX1RFU1RTOiBSZWFkb25seU1hcDxzdHJpbmcsIHN0cmluZz4gPSBuZXcgTWFwKFtcbiAgW1xuICAgIFwidGVzdHMvaG9zdF9jYWNoZV9yZWNsYWltX3Rlc3QudHNcIixcbiAgICBcInJlYWRzIHJ1bi5zaCBhbmQgcnVuLnBzMSB3aXRoIERlbm8ucmVhZFRleHRGaWxlIHRvIGFzc2VydCBib3RoIFwiICtcbiAgICBcImxhdW5jaGVycyBzdGFydCB0aGUgaG9zdCBjYWNoZSByZWNsYWltIGF0IHRoZSBmbG9vciBwbHVzIHRoZSBjYXJnbyBcIiArXG4gICAgXCJidWlsZCBoZWFkcm9vbSAoSXNzdWUgIzQ1NDApOyBpdCBuZXZlciBzcGF3bnMgZWl0aGVyIG9uZVwiLFxuICBdLFxuICBbXG4gICAgXCJ0ZXN0cy9sYXVuY2hlcl9lZ3Jlc3Nfc2VsZmNoZWNrX3Rlc3QudHNcIixcbiAgICBcInJlYWRzIHJ1bi5zaCBhbmQgcnVuLnBzMSB3aXRoIERlbm8ucmVhZFRleHRGaWxlIHRvIGFzc2VydCBib3RoIFwiICtcbiAgICBcImxhdW5jaGVycyByZXN0YXRlIHRoZSBlZ3Jlc3Mgc2VsZi1jaGVjayBleGl0IHN0YXR1cyBhbmQgbWFya2VyIChJc3N1ZSBcIiArXG4gICAgXCIjNDA0OCk7IGl0IG5ldmVyIHNwYXducyBlaXRoZXIgb25lLCBhbmQgcnVucyBpbiBtaWxsaXNlY29uZHNcIixcbiAgXSxcbiAgW1xuICAgIFwidGVzdHMvY29udGFpbmVyX21hbmlmZXN0X3Rlc3QudHNcIixcbiAgICBcInJlYWRzIGNvbnRhaW5lci9lbnRyeXBvaW50LnNoIHdpdGggRGVuby5yZWFkVGV4dEZpbGUgdG8gYXNzZXJ0IGl0cyBcIiArXG4gICAgXCJzZWVkIGRpcmVjdG9yeSBtYXRjaGVzIHRoZSBDb250YWluZXJmaWxlOyBydW5zIGluIDEuMnNcIixcbiAgXSxcbiAgW1xuICAgIFwidGVzdHMvbG9vcF9jaGVja291dF9yZWZyZXNoX3Rlc3QudHNcIixcbiAgICBcInJlYWRzIGxvb3Auc2ggYW5kIGxvb3AucHMxIHdpdGggRGVuby5yZWFkVGV4dEZpbGUgdG8gYXNzZXJ0IGJvdGggXCIgK1xuICAgIFwic3VwZXJ2aXNvcnMgcHVsbCB0aGVpciBjaGVja291dCBhdCB0aGUgZW5kIG9mIGV2ZXJ5IGN5Y2xlIChJc3N1ZSBcIiArXG4gICAgXCIjMTQwMSk7IGl0IG5ldmVyIHNwYXducyBlaXRoZXIgb25lLCBhbmQgcnVucyBpbiBtaWxsaXNlY29uZHNcIixcbiAgXSxcbiAgW1xuICAgIFwidGVzdHMvbG9vcF9wYXJpdHlfdGVzdC50c1wiLFxuICAgIFwicmVhZHMgbG9vcC5zaCBhbmQgbG9vcC5wczEgd2l0aCBEZW5vLnJlYWRUZXh0RmlsZSB0byBjb21wYXJlIHRoZSBcIiArXG4gICAgXCJzdXBlcnZpc2lvbiBjb250cmFjdCBlYWNoIG9uZSBrZWVwcyAoSXNzdWUgIzE0MDMpOyBpdCBuZXZlciBzcGF3bnMgXCIgK1xuICAgIFwiZWl0aGVyIG9uZSwgYW5kIHJ1bnMgaW4gbWlsbGlzZWNvbmRzXCIsXG4gIF0sXG4gIFtcbiAgICBcInRlc3RzL2xvb3BfbG9nX2Rpcl90ZXN0LnRzXCIsXG4gICAgXCJyZWFkcyBsb29wLnNoIGFuZCBsb29wLnBzMSB3aXRoIERlbm8ucmVhZFRleHRGaWxlIHRvIGFzc2VydCBib3RoIFwiICtcbiAgICBcInN1cGVydmlzb3JzIGFzayBgbW9kLnRzIGxvZy1kaXJgIHdoZXJlIHRoZWlyIGxhdW5jaCBsb2dzIGdvIChJc3N1ZSBcIiArXG4gICAgXCIjMTQwMik7IGl0IG5ldmVyIHNwYXducyBlaXRoZXIgb25lLCBhbmQgcnVucyBpbiBtaWxsaXNlY29uZHNcIixcbiAgXSxcbiAgW1xuICAgIFwidGVzdHMvY29udGFpbmVyX2J1aWxkX3Byb2JlX3BhdGhzX3Rlc3QudHNcIixcbiAgICBcInJlYWRzIC5naXRodWIvc2NyaXB0cy9kZXRlY3QtaW1hZ2UtY2hhbmdlcy5zaCB3aXRoIERlbm8ucmVhZFRleHRGaWxlIFwiICtcbiAgICBcInRvIHRha2UgdGhlIHB1bGwtcmVxdWVzdCBwYXRoc3BlY3MgdGhlIGltYWdlIGJ1aWxkIHR1cm5zIG9uIChJc3N1ZSBcIiArXG4gICAgXCIjMTkyOSk7IGl0IG5ldmVyIHNwYXducyB0aGUgc2NyaXB0LCBhbmQgcnVucyBpbiBhYm91dCBhIHNlY29uZFwiLFxuICBdLFxuICBbXG4gICAgXCJ0ZXN0cy93b3JrZmxvd19kZWZpbml0aW9uc190ZXN0LnRzXCIsXG4gICAgXCJyZWFkcyAuZ2l0aHViL3NjcmlwdHMvZGVuby10ZXN0LXNoYXJkLnNoIHRvIGFzc2VydCB0aGUgd29ya2Zsb3cgYW5kIFwiICtcbiAgICBcInRoZSBzY3JpcHQgYWdyZWUgb24gc2hhcmRpbmc7IHJ1bnMgaW4gMS4yc1wiLFxuICBdLFxuICBbXG4gICAgXCJ0ZXN0cy9pc3N1ZV8zMzY5X2Zsb2NpX3dvcmtmbG93X3Rlc3QudHNcIixcbiAgICBcInN0YXQoKXMgaW5mcmEvY2xvdWRmb3JtYXRpb24vdGVzdC1mbG9jaS5zaCBmb3IgdGhlIGV4ZWN1dGFibGUgYml0OyBcIiArXG4gICAgXCJuZXZlciBzcGF3bnMgaXQsIGFuZCBydW5zIGluIG1pbGxpc2Vjb25kc1wiLFxuICBdLFxuXSk7XG5cbi8qKlxuICogV2hldGhlciBgc291cmNlYCBkcml2ZXMgb25lIG9mIHRoZSByZXBvc2l0b3J5J3Mgb3duIHNjcmlwdHMuXG4gKlxuICogVGhlIHNpZ25hbCBpcyBkZWxpYmVyYXRlbHkgbmFycm93OiBjb25zdHJ1Y3RpbmcgYSByZXBvc2l0b3J5IHNjcmlwdCBwYXRoLFxuICogb3IgcGFzc2luZyBhbiBpbXBvcnRlZCBzaGFyZWQtaGFybmVzcyBsYXVuY2hlciBkZXNjcmlwdG9yIHRvIGl0cyBsYXVuY2hcbiAqIGhlbHBlci4gTWVyZWx5IGltcG9ydGluZyB0aGUgaGFybmVzcydzIHBhdGggb3Igc3R1YiB1dGlsaXRpZXMgZG9lcyBub3RcbiAqIGNsYWltIGEgdGVzdC4gQSB0ZXN0IHRoYXQgb25seSBzcGF3bnMgYGdpdGAgaXMgbm90IGNhdWdodCBlaXRoZXIuXG4gKlxuICogTmFycm93IGJlY2F1c2UgdGhlIGNvc3Qgb2YgYSBmYWxzZSBwb3NpdGl2ZSBpcyByZWFsOiBhIHVuaXQgdGVzdCB3cm9uZ2x5XG4gKiBleGNsdWRlZCBzdG9wcyBydW5uaW5nIG9uIGV2ZXJ5IGNoYW5nZSwgYW5kIG5vYm9keSB3b3VsZCBub3RpY2UuIEEgZmFsc2VcbiAqIG5lZ2F0aXZlIG1lcmVseSBsZWF2ZXMgYSBzbG93IHRlc3QgaW4gdGhlIGdhdGUsIHdoaWNoIGlzIHZpc2libGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc0ludGVncmF0aW9uVGVzdFNvdXJjZShzb3VyY2U6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAvLyBCdWlsZGluZyBhIHBhdGggdG8gb25lIG9mIHRoZSByZXBvc2l0b3J5J3Mgb3duIHNoZWxsIG9yIFBvd2VyU2hlbGxcbiAgLy8gc2NyaXB0cyBpcyB0aGUgd2hvbGUgc2lnbmFsLiBTcGF3bmluZyBpcyBkZWxpYmVyYXRlbHkgbm90IHJlcXVpcmVkOlxuICAvLyBzZXZlcmFsIG9mIHRoZXNlIHN1aXRlcyBzcGF3biB0aHJvdWdoIGEgc2hhcmVkIGhhcm5lc3MgcmF0aGVyIHRoYW5cbiAgLy8gY2FsbGluZyBgRGVuby5Db21tYW5kYCB0aGVtc2VsdmVzLCBhbmQgcmVxdWlyaW5nIHRoZSBkaXJlY3QgY2FsbCBtaXNzZWRcbiAgLy8gZm91ciBvZiB0aGVtLlxuICAvL1xuICAvLyBUd28gaWRpb21zIGFyZSBpbiB1c2UgZm9yIG5hbWluZyB0aGUgc2NyaXB0LCBhbmQgSXNzdWUgIzkzNSBpcyB3aGF0IGl0XG4gIC8vIGNvc3QgdG8gcmVjb2duaXNlIG9ubHkgdGhlIGZpcnN0OiBmb3VydGVlbiBzdWl0ZXMgdGhhdCBkcml2ZSBgc2V0dXAuc2hgLFxuICAvLyBgdm9sdW1lLWluaXQuc2hgIGFuZCB0aGUgY29udGFpbmVyIGVudHJ5cG9pbnQgc3RheWVkIGluIHRoZSBnYXRlLFxuICAvLyBpbmNsdWRpbmcgb25lIHRoYXQgZmFpbHMgb24gYSBtYWNPUyBob3N0IGZvciByZWFzb25zIG5vIGNoYW5nZSBvZlxuICAvLyB0aGVpcnMgY291bGQgYWZmZWN0LlxuICAvL1xuICAvLyBUaGUgbWF0Y2ggaXMgb24gdGhlIHBhdGggKmNvbnN0cnVjdGlvbiosIG5ldmVyIG9uIHRoZSBuYW1lIGFsb25lIOKAlFxuICAvLyBzZXZlcmFsIG9mIHRoZXNlIGZpbGVzIGRpc2N1c3MgYHNldHVwLnNoYCBpbiB0aGVpciBkb2MgY29tbWVudHMsIGFuZFxuICAvLyBtYXRjaGluZyBiYXJlIHRleHQgd291bGQgZXhjbHVkZSB1bml0IHRlc3RzIHRoYXQgbWVyZWx5IG1lbnRpb24gYVxuICAvLyBzY3JpcHQuIFRoYXQgYXN5bW1ldHJ5IGlzIHRoZSB3aG9sZSBkZXNpZ246IGEgZmFsc2UgbmVnYXRpdmUgbGVhdmVzIGFcbiAgLy8gc2xvdyB0ZXN0IGluIHRoZSBnYXRlLCB3aGljaCBpcyB2aXNpYmxlLCB3aGlsZSBhIGZhbHNlIHBvc2l0aXZlIHN0b3BzIGFcbiAgLy8gdW5pdCB0ZXN0IHJ1bm5pbmcgb24gZXZlcnkgY2hhbmdlLCB3aGljaCBub2JvZHkgd291bGQgbm90aWNlLlxuICBpZiAoSU5URUdSQVRJT05fU09VUkNFX1BBVFRFUk5TLnNvbWUoKHBhdHRlcm4pID0+IHBhdHRlcm4udGVzdChzb3VyY2UpKSkge1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIC8vIFRoZSBzaGFyZWQgaGFybmVzcyBvd25zIHRoZSBzY3JpcHQgcGF0aC4gSW1wb3J0aW5nIGl0cyBoZWxwZXJzIGFsb25lXG4gIC8vIGRvZXMgbm90IHJ1biBhIHNjcmlwdDogcmVxdWlyZSBhIGxhdW5jaGVyIGRlc2NyaXB0b3IgcGFzc2VkIHRvIGEgc3Bhd24uXG4gIGNvbnN0IHJhd0xpbmVzID0gc291cmNlLnNwbGl0KFwiXFxuXCIpO1xuICBjb25zdCBleGVjdXRhYmxlID0gc291cmNlUHJvc2VMaW5lcyhzb3VyY2UsIFwidGVzdC50c1wiKS5saW5lcy5tYXAoKFxuICAgIGxpbmUsXG4gICAgaW5kZXgsXG4gICkgPT4gbGluZS5jb2RlLnBhZEVuZChyYXdMaW5lc1tpbmRleF0hLmxlbmd0aCkpLmpvaW4oXCJcXG5cIik7XG4gIC8vIFNoZWxsQ2hlY2sgaW50ZWdyYXRpb24gc3VpdGVzIGV4cGxpY2l0bHkgcmVxdWlyZSB0aGUgaG9zdCBiaW5hcnkuXG4gIGlmIChcbiAgICAvXFxiaW1wb3J0XFxzKlxce1tefV0qXFxicmVxdWlyZVJlYWxTaGVsbGNoZWNrXFxiW159XSpcXH1cXHMqZnJvbVxccypbXCInXVxcLlxcL3N1cHBvcnRcXC9zaGVsbGNoZWNrX3N1cHBvcnRcXC50c1tcIiddL1xuICAgICAgLnRlc3Qoc291cmNlKSAmJlxuICAgIC9cXGJhd2FpdFxccytyZXF1aXJlUmVhbFNoZWxsY2hlY2tcXHMqXFwoXFxzKlxcKS8udGVzdChleGVjdXRhYmxlKVxuICApIHJldHVybiB0cnVlO1xuICBjb25zdCBuYW1lcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBmb3IgKFxuICAgIGNvbnN0IGltcG9ydGVkIG9mIGV4ZWN1dGFibGUubWF0Y2hBbGwoXG4gICAgICAvXFxiaW1wb3J0XFxzKlxceyhbXFx3JFxccyxdKylcXH1cXHMqZnJvbVxccyooW1wiJ10pL2csXG4gICAgKVxuICApIHtcbiAgICBjb25zdCBzcGVjaWZpZXJBdCA9IGltcG9ydGVkLmluZGV4ICsgaW1wb3J0ZWRbMF0ubGVuZ3RoO1xuICAgIGlmIChcbiAgICAgICFzb3VyY2Uuc3RhcnRzV2l0aChcbiAgICAgICAgYC4vZml4dHVyZXMvbGF1bmNoZXJfaGFybmVzcy50cyR7aW1wb3J0ZWRbMl19YCxcbiAgICAgICAgc3BlY2lmaWVyQXQsXG4gICAgICApXG4gICAgKSBjb250aW51ZTtcbiAgICBmb3IgKGNvbnN0IG5hbWUgb2YgaW1wb3J0ZWRbMV0hLnNwbGl0KFwiLFwiKSkgbmFtZXMuYWRkKG5hbWUudHJpbSgpKTtcbiAgfVxuICBmb3IgKFxuICAgIGNvbnN0IGNhbGwgb2YgZXhlY3V0YWJsZS5tYXRjaEFsbChcbiAgICAgIC9cXGIocnVuTGF1bmNoZXJ8c3Bhd25MYXVuY2hlcilcXHMqXFwoW14sOygpXSssXFxzKihCQVNIX0xBVU5DSEVSfFBPV0VSU0hFTExfTEFVTkNIRVIpXFxiL2csXG4gICAgKVxuICApIHtcbiAgICBpZiAobmFtZXMuaGFzKGNhbGxbMV0hKSAmJiBuYW1lcy5oYXMoY2FsbFsyXSEpKSByZXR1cm4gdHJ1ZTtcbiAgfVxuICByZXR1cm4gZmFsc2U7XG59XG5cbi8qKiBQYXRoIGNvbnN0cnVjdGlvbnMgdGhhdCBuYW1lIGEgcmVwb3NpdG9yeSBzY3JpcHQuICovXG5jb25zdCBJTlRFR1JBVElPTl9TT1VSQ0VfUEFUVEVSTlM6IHJlYWRvbmx5IFJlZ0V4cFtdID0gW1xuICAvLyBgJHtSRVBPX1JPT1R9L3NldHVwLnNoYCwgYW5kIHRoZSBzaGFyZWQgaGFybmVzc2VzIGJ1aWx0IG9uIGl0LlxuICAvUkVQT19ST09UW15cXG5dKlxcLihzaHxwczEpLyxcbiAgLy8gYG5ldyBVUkwoXCIuLi8uLi8uLi9zZXR1cC5zaFwiLCBpbXBvcnQubWV0YS51cmwpYC5cbiAgL25ldyBVUkxcXChcXHMqXCJbXlwiXFxuXSpcXC4oc2h8cHMxKVwiLyxcbl07XG5cbi8qKiBUaGUgYC0taWdub3JlYCB2YWx1ZSBmb3IgdGhlIGdhdGUncyBgZGVubyB0ZXN0YCBpbnZvY2F0aW9uLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGludGVncmF0aW9uVGVzdElnbm9yZUFyZyhcbiAgZmlsZXM6IHJlYWRvbmx5IHN0cmluZ1tdID0gSU5URUdSQVRJT05fVEVTVF9GSUxFUyxcbik6IHN0cmluZyB7XG4gIHJldHVybiBmaWxlcy5qb2luKFwiLFwiKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0E0Q0MsR0FFRCxTQUFTLGdCQUFnQixRQUFRLHVCQUF1QjtBQUV4RDs7Ozs7Q0FLQyxHQUNELE9BQU8sTUFBTSx5QkFBNEM7RUFDdkQsc0VBQXNFO0VBQ3RFLGdEQUFnRDtFQUNoRCw2Q0FBNkM7RUFDN0M7RUFDQTtFQUNB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
// denoCacheMetadata=3840490120344926107,9895791313424930252