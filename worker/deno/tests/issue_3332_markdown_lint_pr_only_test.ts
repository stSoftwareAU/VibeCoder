/**
 * Regression test for Issue #3332: this repo's own `markdown-lint.yml`
 * must gate the pull request only, never re-run on a push to the default
 * branch (`Develop`).
 *
 * `markdownlint` is a required status check, so every merge into
 * `Develop` used to re-run the very check that already gated the PR — a
 * duplicate run with no enforcement value that burns CI minutes and can
 * leave a red tick on the default branch (see `docs/MERGE.md` — "No
 * post-merge re-run of required checks").
 *
 * The check runs this repo's own `scanWorkflowTriggers` pre-filer — the
 * same code that files `BP-TRIGGER-*` findings against other repos (Issue
 * #2587) — over the real `.github/workflows` tree, so the repo is held to
 * the standard it audits others against (Issue #3239: each repo enforces
 * its own gate). It fails against the unfixed tree, which carried
 * `push: branches: [Develop, main]`.
 *
 * Scope: `markdown-lint.yml` only; `validate-scripts.yml` carried the same
 * finding and was fixed under Issue #3333.
 *
 * Australian English throughout (behaviour, organisation, authorised).
 */

import { assert, assertEquals } from "@std/assert";
import { classifyWorkflow } from "../lib/workflow_classifier.ts";
import { scanWorkflowTriggers } from "../lib/workflow_trigger_scanner.ts";
import { readWorkflowFiles } from "../lib/workflow_scan_common.ts";

/** Repository root — three levels up from `worker/deno/tests/`. */
const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

const WORKFLOW_PATH = ".github/workflows/markdown-lint.yml";

/** This repo's default branch (`CONTRIBUTING.md` — "Branching"). */
const DEFAULT_BRANCH = "Develop";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

Deno.test(
  "markdown-lint.yml does not re-run on push to Develop (Issue #3332)",
  async () => {
    const files = await readWorkflowFiles(REPO_ROOT);
    const workflow = files.find((f) => f.path === WORKFLOW_PATH);
    assert(workflow, `expected to read ${WORKFLOW_PATH}`);

    // The scanner only flags high-confidence test/lint workflows, so a
    // reclassification would silently make this guard vacuous.
    const classification = classifyWorkflow(workflow.parsed);
    assertEquals(
      [classification.category, classification.confidence],
      ["test", "high"],
      `${WORKFLOW_PATH} must still classify as a high-confidence test ` +
        "workflow for this guard to mean anything",
    );

    const findings = scanWorkflowTriggers(files, {
      defaultBranch: DEFAULT_BRANCH,
    });
    assertEquals(
      findings.filter((f) => f.workflowPath === WORKFLOW_PATH).map((f) =>
        f.findingId
      ),
      [],
      `${WORKFLOW_PATH} is a required status check — it must gate the PR ` +
        `only, not re-run on every push to \`${DEFAULT_BRANCH}\` ` +
        "(Issue #3332)",
    );
  },
);

Deno.test(
  "markdown-lint.yml still gates Develop, main and milestone/* PRs (Issue #3332)",
  async () => {
    const files = await readWorkflowFiles(REPO_ROOT);
    const workflow = files.find((f) => f.path === WORKFLOW_PATH);
    assert(workflow, `expected to read ${WORKFLOW_PATH}`);
    assert(isRecord(workflow.parsed), `${WORKFLOW_PATH} must parse as a map`);

    const onBlock = workflow.parsed["on"] ?? workflow.parsed["true"];
    assert(isRecord(onBlock), `${WORKFLOW_PATH} must have an \`on:\` map`);

    const pullRequest = onBlock["pull_request"];
    assert(
      isRecord(pullRequest),
      "dropping the push trigger must not drop the pull_request trigger",
    );
    const branches = pullRequest["branches"];
    assert(Array.isArray(branches), "pull_request must filter branches");
    for (const expected of ["Develop", "main", "milestone/*"]) {
      assertEquals(
        branches.includes(expected),
        true,
        `pull_request.branches must keep \`${expected}\` (Issues #3360, ` +
          `#3940); got: ${JSON.stringify(branches)}`,
      );
    }
  },
);
