/**
 * Issue #1952: GitHub's own refusal text is a token-scope failure.
 *
 * The pre-push check (Issue #1475) can fail open — the launcher recorded no
 * verdict, or the diff could not answer — and the push then happens. GitHub
 * refuses it with its own words, which matched only the generic "Git push
 * failed" rule, so five recovery attempts ran against a refusal no rebase can
 * fix and the record lost the one actionable diagnosis.
 *
 * These tests drive the real predicates and `recoverFromPushRejection`.
 *
 * Australian English throughout (behaviour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  isWorkflowScopePushRefusal,
  recordedWorkflowScopeValue,
  tokenHasWorkflowScope,
  WORKFLOW_SCOPE_ENV,
  workflowScopePushRefusalMessage,
  workflowScopeState,
  workflowScopeVerdictFor,
} from "../lib/workflow_scope.ts";
import { detectFailureCategory } from "../lib/failure_diagnosis.ts";
import { recoverFromPushRejection } from "../lib/git_push_recovery.ts";
import { shouldRetryInfrastructureFailure } from "../lib/infra_retry.ts";
import type { PhaseState } from "../lib/issue_worker_types.ts";
import type { Logger } from "../types.ts";

/** GitHub's refusal to an OAuth App token, as it reaches git's stderr. */
const OAUTH_REFUSAL = [
  "remote: Permission to stSoftwareAU/VibeCoder.git denied.",
  "! [remote rejected] issue-1952 -> issue-1952 (refusing to allow an OAuth",
  "App to create or update workflow `.github/workflows/ci.yml` without",
  "`workflow` scope)",
  "error: failed to push some refs to 'https://github.com/stSoftwareAU/VibeCoder.git'",
].join("\n");

/** The fine-grained personal access token wording for the same refusal. */
const FINE_GRAINED_REFUSAL =
  "! [remote rejected] main -> main (refusing to allow a Personal Access " +
  "Token to create or update workflow `.github/workflows/release.yml` " +
  "without `workflows` permission)";

/** The GitHub App installation token wording. */
const APP_REFUSAL =
  "refusing to allow a GitHub App to create or update workflow " +
  "`.github/workflows/ci.yml` without `workflows` permission";

/** An ordinary non-fast-forward rejection, which recovery *can* fix. */
const STALE_BRANCH_REJECTION = [
  "! [rejected]        issue-1952 -> issue-1952 (fetch first)",
  "error: failed to push some refs to 'origin'",
  "hint: Updates were rejected because the remote contains work that you do",
  "hint: not have locally.",
].join("\n");

const envOf = (values: Record<string, string>) => (name: string) =>
  values[name];

Deno.test("isWorkflowScopePushRefusal - matches every GitHub refusal wording (Issue #1952)", () => {
  assertEquals(isWorkflowScopePushRefusal(OAUTH_REFUSAL), true);
  assertEquals(isWorkflowScopePushRefusal(FINE_GRAINED_REFUSAL), true);
  assertEquals(isWorkflowScopePushRefusal(APP_REFUSAL), true);
});

Deno.test("isWorkflowScopePushRefusal - an ordinary rejection is not one (Issue #1952)", () => {
  assertEquals(isWorkflowScopePushRefusal(STALE_BRANCH_REJECTION), false);
  assertEquals(isWorkflowScopePushRefusal(""), false);
  assertEquals(
    isWorkflowScopePushRefusal("the workflow file was updated successfully"),
    false,
  );
});

Deno.test("workflowScopePushRefusalMessage - names the scope, the fix, and that no retry ran (Issue #1952)", () => {
  const message = workflowScopePushRefusalMessage(OAUTH_REFUSAL);
  assertStringIncludes(message, "lacks the 'workflow' scope");
  assertStringIncludes(message, "gh auth refresh -s workflow");
  assertStringIncludes(message, "no rebase");
  assertEquals(detectFailureCategory(message), "token_scope");
});

Deno.test("detectFailureCategory - GitHub's raw refusal classifies as token_scope, not push_failure (Issue #1952)", () => {
  // The shape the completion phase produces when the push itself fails and
  // recovery is asked for: the generic "Git push failed" prefix used to win.
  const wrapped =
    `Git push failed and recovery unsuccessful: Push recovery step ` +
    `'retry-push' failed: ${OAUTH_REFUSAL}`;
  assertEquals(detectFailureCategory(wrapped), "token_scope");
  assertEquals(detectFailureCategory(FINE_GRAINED_REFUSAL), "token_scope");
  // Unrelated push failures keep their existing category.
  assertEquals(
    detectFailureCategory(`Git push failed: ${STALE_BRANCH_REJECTION}`),
    "push_failure",
  );
});

Deno.test("workflowScopeState - the launcher's verdict is granted, absent or unknown (Issue #1952)", () => {
  assertEquals(
    workflowScopeState(envOf({ [WORKFLOW_SCOPE_ENV]: "true" })),
    "granted",
  );
  assertEquals(
    workflowScopeState(envOf({ [WORKFLOW_SCOPE_ENV]: " FALSE " })),
    "absent",
  );
  assertEquals(workflowScopeState(envOf({})), "unknown");
  assertEquals(
    workflowScopeState(envOf({ [WORKFLOW_SCOPE_ENV]: "" })),
    "unknown",
  );
  // The pre-#1952 boolean keeps its fail-open contract.
  assertEquals(tokenHasWorkflowScope(envOf({})), true);
  assertEquals(
    tokenHasWorkflowScope(envOf({ [WORKFLOW_SCOPE_ENV]: "false" })),
    false,
  );
});

Deno.test({
  name:
    "recoverFromPushRejection - stops on the workflow-scope refusal without running git (Issue #1952)",
  permissions: { read: true, write: true, run: true },
  async fn() {
    // A directory that is not a git repository: any git command run here
    // fails with git's "not a git repository" wording, so a recovery that
    // reached the rebase could not report the scope instead.
    const cwd = await Deno.makeTempDir();
    try {
      const result = await recoverFromPushRejection(
        "issue-1952-workflow",
        { cwd },
        OAUTH_REFUSAL,
      );
      assertEquals(result.ok, false);
      const message = result.ok ? "" : result.error.message;
      assertStringIncludes(message, "lacks the 'workflow' scope");
      assertEquals(
        message.includes("pull --rebase"),
        false,
        "no rebase may be attempted against a refusal no rebase can fix",
      );
      assertEquals(detectFailureCategory(message), "token_scope");
    } finally {
      await Deno.remove(cwd, { recursive: true });
    }
  },
});

Deno.test("shouldRetryInfrastructureFailure - a missing scope is not retried in-process (Issue #1952)", async () => {
  const warnings: string[] = [];
  const logger = {
    info: () => {},
    warn: (message: string) => warnings.push(message),
    error: () => {},
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  } as unknown as Logger;
  const state = {} as PhaseState;

  assertEquals(
    await shouldRetryInfrastructureFailure(
      "completion",
      workflowScopePushRefusalMessage(OAUTH_REFUSAL),
      state,
      logger,
      { backoffMs: 0 },
    ),
    false,
    "no backoff grants a scope — the failure stands after one attempt",
  );
  assertEquals(state.infraRetryCounts, undefined, "no retry was counted");
  assertEquals(warnings.some((w) => w.includes("not transient")), true);

  // An ordinary push failure keeps its one bounded retry (Issue #1550).
  assertEquals(
    await shouldRetryInfrastructureFailure(
      "completion",
      `Git push failed: ${STALE_BRANCH_REJECTION}`,
      state,
      logger,
      { backoffMs: 0 },
    ),
    true,
  );
});

Deno.test("workflowScopeVerdictFor - every detection outcome records a verdict, or says it could not (Issue #1952)", () => {
  assertEquals(
    workflowScopeVerdictFor({
      ok: true,
      hasWorkflowScope: true,
      isAppAuth: false,
    }),
    "granted",
  );
  assertEquals(
    workflowScopeVerdictFor({
      ok: true,
      hasWorkflowScope: false,
      isAppAuth: false,
    }),
    "absent",
  );
  // A GitHub App installation token has no OAuth scopes to read, and was
  // fail-open before #1475 — recorded, not left to guesswork.
  assertEquals(
    workflowScopeVerdictFor({
      ok: true,
      hasWorkflowScope: false,
      isAppAuth: true,
    }),
    "granted",
  );
  // Detection that could not run is not a pass.
  assertEquals(workflowScopeVerdictFor({ ok: false }), "unknown");

  assertEquals(recordedWorkflowScopeValue("granted"), "true");
  assertEquals(recordedWorkflowScopeValue("absent"), "false");
  assertEquals(recordedWorkflowScopeValue("unknown"), undefined);

  // Round trip: what the launcher records is what the run reads back.
  for (const state of ["granted", "absent"] as const) {
    const recorded = recordedWorkflowScopeValue(state);
    assertEquals(
      workflowScopeState(envOf(
        recorded === undefined ? {} : { [WORKFLOW_SCOPE_ENV]: recorded },
      )),
      state,
    );
  }
});
