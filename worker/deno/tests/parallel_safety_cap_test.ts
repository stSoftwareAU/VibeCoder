/**
 * Issue #880: the parallel-safety debt is capped, not growing.
 *
 * The gate's `deno test` stage runs sequentially, which puts the suite at
 * 42+ minutes on a 10-core host against a 45-minute phase budget — so issues
 * die in `quality_gate` having changed nothing wrong (#805 twice, #808).
 * `--parallel` takes it to 2m23s, an 18x win that is sitting on the table.
 *
 * It cannot be taken yet. Parallel workers share the process environment, so
 * a test that mutates it races whatever else is running:
 *
 * ```ts
 * // commit_and_push_pending_test.ts
 * Deno.env.set("VIBE_RUN_ID", "vibe-test-trailer-abc123");
 * ```
 *
 * Measured with `DENO_JOBS=4`: 48 failures, of which 32 were the pre-existing
 * pwsh failures and ~16 were genuine races. Only a handful collided — the
 * rest of the files below are latent. Bounding the worker count reduces the
 * probability of a collision without removing it, which is the worst outcome
 * for a gate: intermittent red on unrelated work trains everyone to re-run
 * rather than read the result.
 *
 * So this test does not fix the 105 files. It **caps them**, so the debt
 * cannot grow while it is paid down. A new test that mutates process state
 * fails here with the alternative spelled out; each existing file removed
 * from the list is one step closer to enabling `--parallel`.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";

const TESTS_DIR = new URL(".", import.meta.url).pathname;

/**
 * Test files that mutate process-wide state (`Deno.env.set`, `Deno.chdir`).
 *
 * This list may **shrink, never grow**. To remove a file, take the value as a
 * parameter or an injected seam instead of mutating the process — most of the
 * code under test already accepts an `env` function for exactly this reason
 * (see `HostDiskMonitor`, `resolveDiskFloors`, `findIssuesByLabel`).
 */
const PROCESS_STATE_MUTATORS: ReadonlySet<string> = new Set([
  "agent_mcp_config_test.ts",
  "agent_progress_test.ts",
  "agent_provider_per_invocation_test.ts",
  "agent_run_termination_test.ts",
  "agent_transcript_test.ts",
  "audit_hook_test.ts",
  "baseline_quality_cache_test.ts",
  "best_practices_bucket_guides_consumer_test.ts",
  "branch_cleanup_test.ts",
  "bump_deps_phase_test.ts",
  "check_jenkins_access_command_test.ts",
  "ci_check_state_dir_test.ts",
  "ci_failure_issue_test.ts",
  "ci_log_provider_test.ts",
  "ci_provider_jenkins_target_url_test.ts",
  "claim_runway_config_test.ts",
  "clarity_assessment_test.ts",
  "claude_runner_cache_telemetry_4282_test.ts",
  "claude_runner_check_interval_4295_test.ts",
  "claude_runner_external_progress_508_test.ts",
  "claude_runner_invalid_session_id_204_test.ts",
  "claude_runner_invocation_budget_3648_test.ts",
  "claude_runner_kill_bound_test.ts",
  "claude_runner_killed_test.ts",
  "claude_runner_model_unavailable_fallback_test.ts",
  "claude_runner_oom_terminal_test.ts",
  "claude_runner_progress_extension_4296_test.ts",
  "claude_runner_rate_limit_fallback_test.ts",
  "claude_runner_stdin_prompt_test.ts",
  "claude_runner_test.ts",
  "claude_runner_usage_limit_test.ts",
  "commit_and_push_pending_test.ts",
  "config_test.ts",
  "container_entrypoint_test.ts",
  "container_image_selection_test.ts",
  "container_restart_backoff_test.ts",
  "deno_cache_guard_command_test.ts",
  "env_stub_test.ts",
  "escape_hatch_trusted_authors_test.ts",
  "fable_globally_disabled_cycle_test.ts",
  "fable_preflight_deepseek_gate_test.ts",
  "fable_preflight_provider_gate_test.ts",
  "fable_preflight_reroute_wiring_test.ts",
  "feature_availability_test.ts",
  "fetch_jenkins_log_command_test.ts",
  "first_run_verify_command_test.ts",
  "fleet_health_test.ts",
  "gh_guard_shim_test.ts",
  "gh_spawn_test.ts",
  "git_push_single_branch_clone_test.ts",
  "github_actions_audit_template_test.ts",
  "github_primary_quota_latch_test.ts",
  "grill_me_processor_test.ts",
  "host_escalation_test.ts",
  "jenkins_log_fetcher_test.ts",
  "milestone_health_cache_test.ts",
  "milestone_health_test.ts",
  "multi_provider_credentials_test.ts",
  "outbound_fetch_bounds_test.ts",
  "planning_processor_test.ts",
  "planning_run_stats_provider_test.ts",
  "pr_failure_actions_test.ts",
  "pr_maintenance_command_test.ts",
  "prompt_manager_test.ts",
  "push_moved_head_test.ts",
  "refinement_command_test.ts",
  "revision_command_test.ts",
  "run_core_production_deps_test.ts",
  "run_core_rate_limit_resume_test.ts",
  "run_entrypoint_test.ts",
  "run_housekeeping_test.ts",
  "run_id_test.ts",
  "self_heal_events_test.ts",
  "service_account_env_test.ts",
  "setup_agent_provider_gating_test.ts",
  "setup_container_runtime_install_test.ts",
  "setup_prerequisite_installer_test.ts",
  "setup_prerequisites_test.ts",
  "shell_helpers_test.ts",
  "spend_ceiling_3684_test.ts",
  "stale_workdir_command_test.ts",
  "terminal_title_command_test.ts",
  "timeout_extension_report_768_test.ts",
  "timeout_extension_telemetry_4298_test.ts",
  "trusted_review_bots_test.ts",
  "unpriced_spend_3870_test.ts",
  "work_volume_tiers_command_test.ts",
  "work_volume_tiers_test.ts",
  "worker_checkout_update_test.ts",
]);

/** Test files that mutate process-wide state right now. */
async function currentMutators(): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(TESTS_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    // This file names the pattern in its own prose and regex.
    if (entry.name === "parallel_safety_cap_test.ts") continue;
    const text = await Deno.readTextFile(`${TESTS_DIR}/${entry.name}`);
    if (/Deno\.env\.set|Deno\.chdir/.test(text)) found.push(entry.name);
  }
  return found.sort();
}

Deno.test("parallel safety - no new test mutates process-wide state (Issue #880)", async () => {
  const added = (await currentMutators()).filter((f) =>
    !PROCESS_STATE_MUTATORS.has(f)
  );
  assertEquals(
    added,
    [],
    "these test files mutate `Deno.env` or `chdir`, which races under " +
      "`deno test --parallel` and blocks an 18x speed-up of the quality " +
      "gate. Take the value as a parameter or an injected seam instead:\n" +
      added.join("\n"),
  );
});

Deno.test("parallel safety - the list holds no files that were cleaned up (Issue #880)", async () => {
  // An exemption that outlives what it exempts is how #805 lost two runs:
  // `HOME_WORKDIR_ALLOWLIST` kept an entry for a deleted file and failed the
  // gate. Shrinking this list is the goal, so a stale entry must be noticed.
  const current = new Set(await currentMutators());
  const stale = [...PROCESS_STATE_MUTATORS].filter((f) => !current.has(f))
    .sort();
  assertEquals(
    stale,
    [],
    "these files no longer mutate process state — remove them from " +
      "PROCESS_STATE_MUTATORS so the list stays an exact record:\n" +
      stale.join("\n"),
  );
});
