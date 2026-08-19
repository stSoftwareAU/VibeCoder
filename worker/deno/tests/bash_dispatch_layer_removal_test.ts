/**
 * Guard tests for Issue #3500 — remove the vestigial bash dispatch layer.
 *
 * The worker main loop is fully delegated to the Deno `run-core` command, so
 * the old bash work-execution dispatch layer is unreachable at runtime:
 *   - `execute_workflow_priority()` in worker/run_core.sh has no live caller.
 *   - The `work_on_issue*` / `process_issue_*` dispatch functions in
 *     worker/issue_worker.sh are superseded by Deno equivalents wired via
 *     worker/deno/lib/run_core_production_deps.ts.
 *
 * Both bash drivers have since been deleted outright — run_core.sh in #3504
 * and issue_worker.sh in #3661 — so these tests assert their absence, check
 * the remaining shell bridges still parse, and confirm the Deno replacements
 * are wired. They mirror the removal-guard pattern in
 * obsolete_scripts_removal_test.ts.
 *
 * Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";

const repoRoot = new URL("../../../", import.meta.url).pathname;

// The superseded work-execution dispatch functions removed from
// issue_worker.sh in Issue #3500.
const REMOVED_ISSUE_WORKER_FUNCTIONS = [
  "work_on_issue",
  "work_on_issue_setup_branch",
  "work_on_issue_clarity_phase",
  "work_on_issue_execute_claude",
  "work_on_issue_handle_no_changes",
  "work_on_issue_quality_gate",
  "work_on_issue_completion",
  "process_issue_planning",
  "process_issue_refinement",
  "process_issue_question",
  "process_issue_grill_me",
  "process_issue_revision",
  "assess_issue_clarity",
  "work_on_spelling_failure",
  "work_on_ci_failure",
  "work_on_pr_feedback",
];

Deno.test("dispatch removal - execute_workflow_priority is gone with run_core.sh", async () => {
  // Issue #3504 deleted worker/run_core.sh entirely, so execute_workflow_priority
  // is gone a fortiori — assert the file's absence (a stronger guarantee than
  // the original source-grep, which can no longer run).
  let exists = true;
  try {
    await Deno.stat(`${repoRoot}worker/run_core.sh`);
  } catch {
    exists = false;
  }
  assertEquals(
    exists,
    false,
    "worker/run_core.sh should have been removed (Issue #3504)",
  );
});

Deno.test("dispatch removal - superseded functions gone with issue_worker.sh", async () => {
  // Issue #3661 (SEC-bfdd5fa86313) deleted worker/issue_worker.sh entirely, so
  // every function in REMOVED_ISSUE_WORKER_FUNCTIONS is gone a fortiori —
  // assert the file's absence, a stronger guarantee than the original
  // source-grep (which can no longer run). The list is retained above as the
  // record of what the bash layer used to dispatch.
  assert(REMOVED_ISSUE_WORKER_FUNCTIONS.length > 0);
  let exists = true;
  try {
    await Deno.stat(`${repoRoot}worker/issue_worker.sh`);
  } catch {
    exists = false;
  }
  assertEquals(
    exists,
    false,
    "worker/issue_worker.sh should have been removed (Issue #3661)",
  );
});

Deno.test("dispatch removal - remaining shell bridges still parse", async () => {
  // Both bash drivers are gone (run_core.sh #3504, issue_worker.sh #3661);
  // parse-check the shell files that remain shipped.
  for (
    const script of [
      "worker/shared/deno_bridge.sh",
      "worker/shared/config_defaults.sh",
    ]
  ) {
    const cmd = new Deno.Command("bash", {
      args: ["-n", `${repoRoot}${script}`],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stderr } = await cmd.output();
    assertEquals(
      code,
      0,
      `${script} failed bash -n syntax check: ${
        new TextDecoder().decode(stderr)
      }`,
    );
  }
});

Deno.test("dispatch removal - Deno work/process replacements are registered", async () => {
  // The Deno replacements for the removed bash dispatch layer must exist as
  // live modules; import failures here prove a "superseded" bash function was
  // deleted without a wired Deno equivalent.
  const workOnIssue = await import("../lib/issue_worker.ts");
  assert(
    typeof workOnIssue.workOnIssue === "function",
    "workOnIssue must be exported by lib/issue_worker.ts",
  );

  const planning = await import("../lib/planning_processor.ts");
  assert(typeof planning.processIssuePlanning === "function");

  const refinement = await import("../lib/refinement_processor.ts");
  assert(typeof refinement.processIssueRefinement === "function");

  const question = await import("../lib/question_processor.ts");
  assert(typeof question.processIssueQuestion === "function");

  const spelling = await import("../lib/pr_spelling_processor.ts");
  assert(typeof spelling.processSpellingFailure === "function");

  const ci = await import("../lib/pr_ci_processor.ts");
  assert(typeof ci.processCiFailure === "function");

  const feedback = await import("../lib/pr_feedback_processor.ts");
  assert(typeof feedback.processPrFeedback === "function");
});
