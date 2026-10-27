/**
 * Tests for the merge-queue `merge_group` coverage check (Issue #4424).
 *
 * The worker enables a merge queue on the default branch only when every
 * workflow reporting a required check also runs on `merge_group`. These tests
 * pin the pure verdict, the trigger recognition, and the remote reader that
 * feeds it through an injected `gh` stub.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";
import type { WorkflowFile } from "../lib/workflow_scan_common.ts";
import {
  checkMergeGroupCoverage,
  checkRepoMergeGroupCoverage,
  type MergeGroupCheck,
  readRemoteWorkflowFiles,
  workflowHasMergeGroupTrigger,
} from "../lib/merge_queue_workflows.ts";
import type { GhExec } from "../lib/repo_rulesets.ts";

const BRANCH = "main";
const REPO = "owner/repo";
const LISTING_PATH = "repos/owner/repo/contents/.github/workflows";

/** Build a parsed workflow file from YAML source. */
function workflow(name: string, yaml: string): WorkflowFile {
  return {
    path: `.github/workflows/${name}`,
    rawText: yaml,
    parsed: parseYaml(yaml),
    kind: "workflow",
  };
}

/** A workflow whose only job reports `validate` on every pull request. */
function validateWorkflow(name: string, on: string): WorkflowFile {
  return workflow(name, `on: ${on}\njobs:\n  validate:\n    steps: []\n`);
}

/** Narrow a verdict to `missing`, failing the test otherwise. */
function expectMissing(
  result: MergeGroupCheck,
): Extract<MergeGroupCheck, { status: "missing" }> {
  if (result.status !== "missing") {
    throw new Error(`expected missing, got ${JSON.stringify(result)}`);
  }
  return result;
}

/** Narrow a verdict to `unknown`, failing the test otherwise. */
function expectUnknown(
  result: MergeGroupCheck,
): Extract<MergeGroupCheck, { status: "unknown" }> {
  if (result.status !== "unknown") {
    throw new Error(`expected unknown, got ${JSON.stringify(result)}`);
  }
  return result;
}

/**
 * A `gh` stub that records every call. The handler may return output or
 * throw; a throw becomes a rejection, as the real executor's failure does.
 */
function ghStub(
  handler: (args: string[]) => string,
): { gh: GhExec; calls: string[][] } {
  const calls: string[][] = [];
  const gh: GhExec = async (args) => {
    calls.push([...args]);
    return handler(args);
  };
  return { gh, calls };
}

/** The JSON a `contents/.github/workflows` listing returns. */
function listingJson(entries: Array<{ name: string; type: string }>): string {
  return JSON.stringify(entries);
}

const CI_GATED_ON_PULL_REQUEST_ONLY = "on:\n  pull_request:\n" +
  "jobs:\n  validate:\n    steps: []\n";

Deno.test("workflowHasMergeGroupTrigger - recognises a string, an array, and a mapping key", () => {
  const recognised = [
    "on: merge_group",
    "on: [pull_request, merge_group]",
    "on:\n  pull_request:\n  merge_group:\n    types: [checks_requested]",
    "on:\n  merge_group:",
  ];
  for (const yaml of recognised) {
    assert(workflowHasMergeGroupTrigger(parseYaml(yaml)), yaml);
  }
});

Deno.test("workflowHasMergeGroupTrigger - does not mistake a look-alike trigger for merge_group", () => {
  const lookAlikes = [
    "on: [pull_request]",
    "on:\n  pull_request:\n  merge_group_x:",
    "on:\n  workflow_dispatch:",
    "on: merge_group_x",
    "name: no trigger block",
  ];
  for (const yaml of lookAlikes) {
    assertFalse(workflowHasMergeGroupTrigger(parseYaml(yaml)), yaml);
  }
  assertFalse(workflowHasMergeGroupTrigger(null));
});

Deno.test("checkMergeGroupCoverage - ok when the reporting workflow runs on merge_group", () => {
  const result = checkMergeGroupCoverage(
    [validateWorkflow("ci.yml", "[pull_request, merge_group]")],
    ["validate"],
    BRANCH,
  );
  assertEquals(result, { status: "ok" });
});

Deno.test("checkMergeGroupCoverage - missing when the workflow only runs on pull_request, naming file and context", () => {
  const result = expectMissing(
    checkMergeGroupCoverage(
      [workflow("ci.yml", CI_GATED_ON_PULL_REQUEST_ONLY)],
      ["validate"],
      BRANCH,
    ),
  );
  assertEquals(result.workflows, [".github/workflows/ci.yml"]);
  assertEquals(result.contexts, ["validate"]);
  assert(result.reason.includes(".github/workflows/ci.yml"), result.reason);
  assert(result.reason.includes('"validate"'), result.reason);
  assert(result.reason.includes("merge_group"), result.reason);
  assert(result.reason.includes("base_sha"), result.reason);
});

Deno.test("checkMergeGroupCoverage - names the gate's workflow when an aggregate gate reports the required context", () => {
  const ci = `on:
  pull_request:
jobs:
  build:
    uses: ./.github/workflows/build.yml
  gate:
    needs: build
    steps: []
`;
  const build = `on:
  workflow_call:
jobs:
  unit:
    steps: []
`;
  const files = [workflow("ci.yml", ci), workflow("build.yml", build)];

  const result = expectMissing(
    checkMergeGroupCoverage(files, ["unit"], BRANCH),
  );
  assertEquals(result.workflows, [".github/workflows/ci.yml"]);
  assertEquals(result.contexts, ["unit"]);

  // Once the gate's own workflow runs on merge_group, the same context is ok.
  const gated = [
    workflow(
      "ci.yml",
      ci.replace("on:\n  pull_request:", "on: [pull_request, merge_group]"),
    ),
    workflow("build.yml", build),
  ];
  assertEquals(checkMergeGroupCoverage(gated, ["unit"], BRANCH), {
    status: "ok",
  });
});

Deno.test("checkMergeGroupCoverage - missing when a required context has no derived entry (path-filtered)", () => {
  const pathFiltered = workflow(
    "slow.yml",
    "on:\n  pull_request:\n    paths: [src/**]\njobs:\n  slow:\n    steps: []\n",
  );
  const result = expectMissing(
    checkMergeGroupCoverage(
      [pathFiltered, validateWorkflow("ci.yml", "[pull_request, merge_group]")],
      ["slow"],
      BRANCH,
    ),
  );
  assertEquals(result.workflows, []);
  assertEquals(result.contexts, ["slow"]);
  assert(result.reason.includes('"slow"'), result.reason);
  assert(result.reason.includes("every pull request"), result.reason);
});

Deno.test("checkMergeGroupCoverage - de-duplicates and sorts the workflows and contexts it names", () => {
  const ci = workflow(
    "ci.yml",
    "on:\n  pull_request:\njobs:\n  validate:\n    steps: []\n  lint:\n    steps: []\n",
  );
  const result = expectMissing(
    checkMergeGroupCoverage([ci], ["validate", "lint", "validate"], BRANCH),
  );
  assertEquals(result.workflows, [".github/workflows/ci.yml"]);
  assertEquals(result.contexts, ["lint", "validate"]);
});

Deno.test("checkMergeGroupCoverage - unknown when two jobs share one context", () => {
  const result = expectUnknown(
    checkMergeGroupCoverage(
      [
        validateWorkflow("a.yml", "[pull_request, merge_group]"),
        validateWorkflow("b.yml", "[pull_request, merge_group]"),
      ],
      ["validate"],
      BRANCH,
    ),
  );
  assert(result.reason.includes('"validate"'), result.reason);
});

Deno.test("checkMergeGroupCoverage - ok with no required contexts, whatever the workflows", () => {
  assertEquals(
    checkMergeGroupCoverage(
      [workflow("ci.yml", CI_GATED_ON_PULL_REQUEST_ONLY)],
      [],
      BRANCH,
    ),
    { status: "ok" },
  );
});

Deno.test("readRemoteWorkflowFiles - a 404 listing is an empty set, and a required context is then missing", async () => {
  const { gh } = ghStub(() => {
    throw new Error("gh failed: Not Found (HTTP 404)");
  });
  const read = await readRemoteWorkflowFiles(REPO, gh);
  assertEquals(read, { ok: true, files: [] });

  const result = expectMissing(
    await checkRepoMergeGroupCoverage(REPO, BRANCH, ["validate"], gh),
  );
  assertEquals(result.contexts, ["validate"]);
  assertEquals(result.workflows, []);
});

Deno.test("readRemoteWorkflowFiles - a non-404 listing failure is unknown, naming the cause", async () => {
  const { gh } = ghStub(() => {
    throw new Error("gh failed: server error (HTTP 500)");
  });
  const read = await readRemoteWorkflowFiles(REPO, gh);
  assertFalse(read.ok);
  if (read.ok) return;
  assert(read.error.includes("HTTP 500"), read.error);

  const result = expectUnknown(
    await checkRepoMergeGroupCoverage(REPO, BRANCH, ["validate"], gh),
  );
  assert(result.reason.includes("HTTP 500"), result.reason);
});

Deno.test("readRemoteWorkflowFiles - a failed file read is unknown, naming the file and cause", async () => {
  const { gh } = ghStub((args) => {
    if (args[1] === LISTING_PATH) {
      return listingJson([{ name: "ci.yml", type: "file" }]);
    }
    throw new Error("gh failed: server error (HTTP 500)");
  });
  const read = await readRemoteWorkflowFiles(REPO, gh);
  assertFalse(read.ok);
  if (read.ok) return;
  assert(read.error.includes("ci.yml"), read.error);
  assert(read.error.includes("HTTP 500"), read.error);

  const result = expectUnknown(
    await checkRepoMergeGroupCoverage(REPO, BRANCH, ["validate"], gh),
  );
  assert(result.reason.includes("ci.yml"), result.reason);
});

Deno.test("readRemoteWorkflowFiles - more than 100 workflow files is a failure, never a partial read", async () => {
  const entries = Array.from({ length: 101 }, (_, i) => ({
    name: `w${i}.yml`,
    type: "file",
  }));
  const { gh, calls } = ghStub((args) => {
    if (args[1] === LISTING_PATH) return listingJson(entries);
    return "on: merge_group";
  });
  const read = await readRemoteWorkflowFiles(REPO, gh);
  assertFalse(read.ok);
  if (read.ok) return;
  assert(read.error.includes("101"), read.error);
  assertEquals(calls.length, 1, "no workflow file is fetched past the cap");

  const result = expectUnknown(
    await checkRepoMergeGroupCoverage(REPO, BRANCH, ["validate"], gh),
  );
  assert(result.reason.includes("101"), result.reason);
});

Deno.test("readRemoteWorkflowFiles - exactly 100 workflow files are read in full", async () => {
  const entries = Array.from({ length: 100 }, (_, i) => ({
    name: `w${i}.yml`,
    type: "file",
  }));
  const { gh, calls } = ghStub((args) => {
    if (args[1] === LISTING_PATH) return listingJson(entries);
    return "on: [pull_request, merge_group]";
  });
  const read = await readRemoteWorkflowFiles(REPO, gh);
  assert(read.ok);
  if (!read.ok) return;
  assertEquals(read.files.length, 100);
  assertEquals(calls.length, 101);
});

Deno.test("readRemoteWorkflowFiles - a hostile or non-workflow name is never fetched", async () => {
  const { gh, calls } = ghStub((args) => {
    if (args[1] === LISTING_PATH) {
      return listingJson([
        { name: "../x.yml", type: "file" },
        { name: "a b.yml", type: "file" },
        { name: "a..b.yml", type: "file" },
        { name: "sub", type: "dir" },
        { name: "ok.yml", type: "file" },
      ]);
    }
    return "on: [pull_request, merge_group]";
  });
  const read = await readRemoteWorkflowFiles(REPO, gh);
  assert(read.ok);
  if (!read.ok) return;

  assertEquals(read.files.map((f) => f.path), [".github/workflows/ok.yml"]);
  assertEquals(calls.length, 2, "only the listing and ok.yml are fetched");
  assertEquals(
    calls[1]?.[1],
    `repos/${REPO}/contents/.github/workflows/ok.yml`,
  );
  for (const call of calls) {
    const path = call[1] ?? "";
    assertFalse(path.includes("x.yml"), path);
    assertFalse(path.includes("a b"), path);
    assertFalse(path.includes("a..b"), path);
  }
});

Deno.test("readRemoteWorkflowFiles - an unparseable workflow is kept with parsed null", async () => {
  const { gh } = ghStub((args) => {
    if (args[1] === LISTING_PATH) {
      return listingJson([{ name: "broken.yml", type: "file" }]);
    }
    return "key: [unclosed\n";
  });
  const read = await readRemoteWorkflowFiles(REPO, gh);
  assert(read.ok);
  if (!read.ok) return;
  assertEquals(read.files[0]?.parsed, null);
  assertEquals(read.files[0]?.kind, "workflow");
});

Deno.test("readRemoteWorkflowFiles - an invalid repo slug is refused before any call", async () => {
  const { gh, calls } = ghStub(() => "[]");
  const read = await readRemoteWorkflowFiles("owner/repo;rm", gh);
  assertFalse(read.ok);
  assertEquals(calls.length, 0);
});
