/**
 * Tests for the pull-request check-context derivation and its reconciliation
 * against the committed `main` ruleset (Issue #858).
 *
 * The hand-maintained list of required contexts drifted twice: once because
 * `validate` was never added, and again as CI grew jobs nobody added to the
 * ruleset. These tests hold the general rule instead of the two names — every
 * context a PR into `main` always reports is either required or carries a
 * recorded reason for not being.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";
import type { WorkflowFile } from "../lib/workflow_scan_common.ts";
import { readWorkflowFiles } from "../lib/workflow_scan_common.ts";
import {
  EXEMPT_CONTEXTS,
  MILESTONE_EXEMPT_CONTEXTS,
  pullRequestCheckContexts,
  reconcileRequiredContexts,
} from "../lib/pr_check_contexts.ts";
import {
  loadMainBranchRuleset,
  requiredContexts,
} from "../lib/main_branch_ruleset.ts";
import {
  loadMilestoneBranchRuleset,
  MILESTONE_BRANCH_RULESET_PATH,
} from "../lib/committed_rulesets.ts";

/** Build a parsed workflow file from YAML source. */
function workflow(name: string, yaml: string): WorkflowFile {
  return {
    path: `.github/workflows/${name}`,
    rawText: yaml,
    parsed: parseYaml(yaml),
    kind: "workflow",
  };
}

/** Repository root, resolved from this test's location. */
function repoRoot(): string {
  return decodeURIComponent(new URL("../../../", import.meta.url).pathname)
    .replace(/\/$/, "");
}

const SHARDED = `
name: Validate Scripts
on:
  pull_request:
    branches: [Develop, main, milestone/*]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps: []
  tests:
    name: validate (tests \${{ matrix.shard }}/4)
    strategy:
      matrix:
        shard: [1, 2, 3, 4]
    steps: []
  run-mode:
    name: validate (\${{ matrix.mode }})
    strategy:
      matrix:
        mode: [container, no-runtime]
    steps: []
`;

Deno.test("pullRequestCheckContexts - expands a matrix into one context per shard", () => {
  const contexts = pullRequestCheckContexts(
    [workflow("v.yml", SHARDED)],
    "main",
  )
    .map((c) => c.context);
  assertEquals(contexts, [
    "validate",
    "validate (tests 1/4)",
    "validate (tests 2/4)",
    "validate (tests 3/4)",
    "validate (tests 4/4)",
    "validate (container)",
    "validate (no-runtime)",
  ]);
});

Deno.test("pullRequestCheckContexts - names the workflow and job behind each context", () => {
  const derived = pullRequestCheckContexts(
    [workflow("v.yml", SHARDED)],
    "main",
  );
  const first = derived[0];
  assertEquals(first?.workflow, ".github/workflows/v.yml");
  assertEquals(first?.job, "validate");
});

Deno.test("pullRequestCheckContexts - skips a workflow that never runs on a main PR", () => {
  const pushOnly = `
name: Pages
on:
  push:
    branches: [Develop]
jobs:
  build:
    steps: []
`;
  const otherBranch = `
name: Elsewhere
on:
  pull_request:
    branches: [Develop]
jobs:
  elsewhere:
    steps: []
`;
  assertEquals(
    pullRequestCheckContexts(
      [workflow("pages.yml", pushOnly), workflow("other.yml", otherBranch)],
      "main",
    ),
    [],
  );
});

Deno.test("pullRequestCheckContexts - skips a path-filtered workflow", () => {
  // A path-filtered workflow does not report on every PR, so requiring one of
  // its contexts would leave the merge box waiting for ever.
  const filtered = `
name: Dependency Audit
on:
  pull_request:
    branches: [Develop, main]
    paths:
      - 'worker/deno/deno.lock'
jobs:
  deno-audit:
    name: Audit Deno dependencies
    steps: []
`;
  assertEquals(
    pullRequestCheckContexts([workflow("audit.yml", filtered)], "main"),
    [],
  );
});

Deno.test("pullRequestCheckContexts - an unresolvable job name fails loud", () => {
  const dynamic = `
name: Dynamic
on:
  pull_request:
    branches: [main]
jobs:
  build:
    name: build (\${{ github.event_name }})
    steps: []
`;
  assertThrows(
    () => pullRequestCheckContexts([workflow("dyn.yml", dynamic)], "main"),
    Error,
    "cannot be resolved",
  );
});

Deno.test("pullRequestCheckContexts - a matrix include/exclude fails loud", () => {
  const included = `
name: Matrix
on:
  pull_request:
    branches: [main]
jobs:
  build:
    name: build (\${{ matrix.os }})
    strategy:
      matrix:
        os: [linux]
        include:
          - os: macos
    steps: []
`;
  assertThrows(
    () => pullRequestCheckContexts([workflow("m.yml", included)], "main"),
    Error,
    "include/exclude",
  );
});

Deno.test("pullRequestCheckContexts - a reusable-workflow job fails loud", () => {
  const reusable = `
name: Reusable
on:
  pull_request:
    branches: [main]
jobs:
  call:
    uses: ./.github/workflows/other.yml
`;
  assertThrows(
    () => pullRequestCheckContexts([workflow("r.yml", reusable)], "main"),
    Error,
    "reusable",
  );
});

Deno.test("reconcileRequiredContexts - a context CI reports and the ruleset omits is missing", () => {
  const derived = pullRequestCheckContexts(
    [workflow("v.yml", SHARDED)],
    "main",
  );
  const result = reconcileRequiredContexts(
    ["validate (tests 1/4)"],
    derived,
    [{ context: "validate (container)", reason: "deliberately advisory" }],
  );
  assert(result.missing.includes("validate"));
  assert(!result.missing.includes("validate (container)"), "exempt stays out");
  assertEquals(result.phantom, []);
  assertEquals(result.staleExemptions, []);
});

Deno.test("reconcileRequiredContexts - a required context nothing reports is phantom", () => {
  const derived = pullRequestCheckContexts(
    [workflow("v.yml", SHARDED)],
    "main",
  );
  const result = reconcileRequiredContexts(
    derived.map((d) => d.context).concat("ghost"),
    derived,
    [],
  );
  assertEquals(result.missing, []);
  assertEquals(result.phantom, ["ghost"]);
});

Deno.test("reconcileRequiredContexts - an exemption for a vanished job is stale", () => {
  const derived = pullRequestCheckContexts(
    [workflow("v.yml", SHARDED)],
    "main",
  );
  const result = reconcileRequiredContexts(
    derived.map((d) => d.context),
    derived,
    [{ context: "deleted-job", reason: "gone" }],
  );
  assertEquals(result.staleExemptions, ["deleted-job"]);
});

Deno.test("EXEMPT_CONTEXTS - every exemption records why it is not required", () => {
  for (const entry of EXEMPT_CONTEXTS) {
    assert(entry.context.length > 0);
    assert(
      entry.reason.length > 20,
      `${entry.context} needs a reason, got "${entry.reason}"`,
    );
  }
});

Deno.test("this repository - every PR check on main is required or exempt", async () => {
  const files = await readWorkflowFiles(repoRoot());
  const derived = pullRequestCheckContexts(files, "main");
  assert(derived.length > 0, "no PR check contexts derived from the workflows");
  const required = requiredContexts(await loadMainBranchRuleset());
  const result = reconcileRequiredContexts(required, derived);
  assertEquals(
    result.missing,
    [],
    `these checks run on every main PR but are not required: ${
      result.missing.join(", ")
    }`,
  );
  assertEquals(
    result.phantom,
    [],
    `these contexts are required but nothing reports them: ${
      result.phantom.join(", ")
    }`,
  );
  assertEquals(
    result.staleExemptions,
    [],
    `these exemptions name a check that no longer exists: ${
      result.staleExemptions.join(", ")
    }`,
  );
});

Deno.test("this repository - every PR check on a milestone branch is required or exempt", async () => {
  // The milestone branch is where a multi-PR feature is assembled, so its
  // ruleset is reconciled against the workflows exactly as `main`'s is
  // (Issue #1073). Any branch under `milestone/` derives the same contexts.
  const files = await readWorkflowFiles(repoRoot());
  const derived = pullRequestCheckContexts(files, "milestone/example");
  assert(derived.length > 0, "no PR check contexts derived from the workflows");
  const required = requiredContexts(
    await loadMilestoneBranchRuleset(),
    MILESTONE_BRANCH_RULESET_PATH,
  );
  const result = reconcileRequiredContexts(
    required,
    derived,
    MILESTONE_EXEMPT_CONTEXTS,
  );
  assertEquals(
    result.missing,
    [],
    `these checks run on every milestone PR but are not required: ${
      result.missing.join(", ")
    }`,
  );
  assertEquals(
    result.phantom,
    [],
    `these contexts are required but nothing reports them: ${
      result.phantom.join(", ")
    }`,
  );
  assertEquals(
    result.staleExemptions,
    [],
    `these exemptions name a check that no longer exists: ${
      result.staleExemptions.join(", ")
    }`,
  );
});

Deno.test("MILESTONE_EXEMPT_CONTEXTS - the resurrection check is not exempt there", () => {
  // It is exempt on `main`, where its `if:` never fires, and required on a
  // milestone branch, where it reports on every PR (Issue #1048).
  const exempt = MILESTONE_EXEMPT_CONTEXTS.map((e) => e.context);
  assert(!exempt.includes("milestone-resurrection"), exempt.join(", "));
  assert(
    EXEMPT_CONTEXTS.map((e) => e.context).includes("milestone-resurrection"),
  );
  for (const entry of MILESTONE_EXEMPT_CONTEXTS) {
    assert(
      entry.reason.length > 20,
      `${entry.context} needs a reason, got "${entry.reason}"`,
    );
  }
});
