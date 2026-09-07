/**
 * Issue #1475: what the worker does with a token that lacks the `workflow`
 * OAuth scope — the flag's reading, the path test, and the issue heuristic.
 *
 * Australian English throughout (behaviour, organisation).
 */

import { assertEquals } from "@std/assert";
import {
  detectFailureCategory,
  isInfrastructureFailure,
} from "../lib/failure_diagnosis.ts";
import {
  issueLooksLikeWorkflowWork,
  isWorkflowPath,
  tokenHasWorkflowScope,
  WORKFLOW_SCOPE_ENV,
  workflowPathsIn,
} from "../lib/workflow_scope.ts";

const envOf = (vars: Record<string, string>) => (name: string) => vars[name];

Deno.test("tokenHasWorkflowScope - only an explicit 'false' means no scope (Issue #1475)", () => {
  assertEquals(
    tokenHasWorkflowScope(envOf({ [WORKFLOW_SCOPE_ENV]: "false" })),
    false,
  );
  assertEquals(
    tokenHasWorkflowScope(envOf({ [WORKFLOW_SCOPE_ENV]: " FALSE " })),
    false,
  );
  assertEquals(
    tokenHasWorkflowScope(envOf({ [WORKFLOW_SCOPE_ENV]: "true" })),
    true,
  );
  // Detection did not run, or the token is a GitHub App token: fail open.
  assertEquals(tokenHasWorkflowScope(envOf({})), true);
  assertEquals(
    tokenHasWorkflowScope(envOf({ [WORKFLOW_SCOPE_ENV]: "" })),
    true,
  );
});

Deno.test("isWorkflowPath - exactly the directory GitHub protects (Issue #1475)", () => {
  assertEquals(isWorkflowPath(".github/workflows/gitleaks.yml"), true);
  assertEquals(isWorkflowPath("./.github/workflows/ci.yml"), true);
  assertEquals(isWorkflowPath(".github\\workflows\\ci.yml"), true);
  assertEquals(
    isWorkflowPath(".github/workflows"),
    false,
    "the directory itself is not a file change",
  );
  assertEquals(isWorkflowPath(".github/CODEOWNERS"), false);
  assertEquals(isWorkflowPath(".github/actions/setup/action.yml"), false);
  assertEquals(isWorkflowPath("docs/.github/workflows/x.yml"), false);
  assertEquals(
    workflowPathsIn([
      "README.md",
      ".github/workflows/a.yml",
      "src/x.ts",
      ".github/workflows/b.yml",
    ]),
    [".github/workflows/a.yml", ".github/workflows/b.yml"],
  );
});

Deno.test("issueLooksLikeWorkflowWork - the two issues GRQ-25 lost, and some it must not skip (Issue #1475)", () => {
  assertEquals(
    issueLooksLikeWorkflowWork("Add Gitleaks Secrets Detection workflow", ""),
    true,
  );
  assertEquals(
    issueLooksLikeWorkflowWork("Add markdown lint workflow", undefined),
    true,
  );
  assertEquals(
    issueLooksLikeWorkflowWork("CI: pin GitHub Actions to SHAs", ""),
    true,
  );
  assertEquals(
    issueLooksLikeWorkflowWork(
      "Fix the release job",
      "The job in .github/workflows/release.yml times out",
    ),
    true,
  );
  assertEquals(
    issueLooksLikeWorkflowWork("Document the review workflow for humans", ""),
    true,
    "a cheap heuristic accepts this cost",
  );
  assertEquals(
    issueLooksLikeWorkflowWork("Fix a typo in README", "Just the README."),
    false,
  );
  assertEquals(
    issueLooksLikeWorkflowWork(
      "Speed up the scorer",
      "The action in the hot loop…",
    ),
    false,
  );
});

Deno.test("failure category - a workflow-scope block is infrastructure, not the issue's fault (Issue #1475)", () => {
  const category = detectFailureCategory(
    "Cannot push: the token lacks the 'workflow' scope and the branch changes .github/workflows/ci.yml",
  );
  assertEquals(category, "token_scope");
  assertEquals(isInfrastructureFailure(category), true);
});
