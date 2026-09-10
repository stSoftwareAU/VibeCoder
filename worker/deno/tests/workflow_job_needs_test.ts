/**
 * Tests for workflow_job_needs.ts — recognising aggregator jobs from
 * `needs:` in a repo's workflow YAML (Issue #1878, part of #1861).
 *
 * The fixture mirrors the NEAT-AI-Backpropagation `ci.yml` shape that
 * caused the fault: a `ci-required` job named `CI Required Checks` that
 * needs every real job and runs `if: always()`. Every test parses real
 * YAML through `readWorkflowFiles` and calls the real functions.
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import { readWorkflowFiles } from "../lib/workflow_scan_common.ts";
import {
  buildJobNeedsMap,
  isDownstreamOfRedJob,
} from "../lib/workflow_job_needs.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The NEAT-AI-Backpropagation shape: an `if: always()` aggregator job. */
const AGGREGATOR_CI_YML = `name: CI
on:
  pull_request:
jobs:
  validation:
    name: Project Validation
    runs-on: ubuntu-latest
    steps:
      - run: echo validate
  quality:
    name: Quality
    runs-on: ubuntu-latest
    steps:
      - run: echo quality
  security:
    runs-on: ubuntu-latest
    steps:
      - run: echo security
  ci-required:
    name: CI Required Checks
    if: always()
    needs: [validation, quality, security]
    runs-on: ubuntu-latest
    steps:
      - run: echo gate
`;

/** Write `files` into a throwaway repo and parse them. */
async function parseWorkflows(
  files: Record<string, string>,
): Promise<Awaited<ReturnType<typeof readWorkflowFiles>>> {
  const dir = await Deno.makeTempDir({ prefix: "wf-job-needs-" });
  try {
    await Deno.mkdir(`${dir}/.github/workflows`, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      await Deno.writeTextFile(`${dir}/.github/workflows/${name}`, body);
    }
    return await readWorkflowFiles(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Parse the aggregator fixture and build its graph. */
async function aggregatorMap() {
  return buildJobNeedsMap(
    await parseWorkflows({ "ci.yml": AGGREGATOR_CI_YML }),
  );
}

// ---------------------------------------------------------------------------
// buildJobNeedsMap
// ---------------------------------------------------------------------------

Deno.test("buildJobNeedsMap - keys jobs by name: and resolves needs to display names", async () => {
  const map = await aggregatorMap();

  assertEquals(map.get("CI Required Checks"), [
    "Project Validation",
    "Quality",
    "security",
  ]);
  // A job with no `needs:` is still in the graph, with an empty list.
  assertEquals(map.get("Project Validation"), []);
});

Deno.test("buildJobNeedsMap - a job without name: is keyed by its id", async () => {
  const map = await parseWorkflows({
    "ci.yml": `name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
  gate:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: echo gate
`,
  }).then(buildJobNeedsMap);

  assertEquals(map.get("gate"), ["build"]);
  assert(map.has("build"));
});

Deno.test("buildJobNeedsMap - needs: as a bare string is one dependency", async () => {
  const map = await parseWorkflows({
    "ci.yml": `name: CI
on: [push]
jobs:
  validation:
    name: Project Validation
    runs-on: ubuntu-latest
    steps:
      - run: echo validate
  ci-required:
    name: CI Required Checks
    needs: validation
    runs-on: ubuntu-latest
    steps:
      - run: echo gate
`,
  }).then(buildJobNeedsMap);

  assertEquals(map.get("CI Required Checks"), ["Project Validation"]);
});

Deno.test("buildJobNeedsMap - unparseable YAML contributes nothing", async () => {
  const files = await parseWorkflows({
    "broken.yml": "jobs:\n  build:\n   - this: [is\n  not: yaml\n",
  });

  // The fixture really is unparseable — otherwise this asserts nothing.
  assertEquals(files.length, 1);
  assertEquals(files[0]?.parsed, null);
  assertEquals(buildJobNeedsMap(files).size, 0);
});

Deno.test("buildJobNeedsMap - no workflow files gives an empty map", () => {
  assertEquals(buildJobNeedsMap([]).size, 0);
});

// ---------------------------------------------------------------------------
// isDownstreamOfRedJob
// ---------------------------------------------------------------------------

Deno.test("isDownstreamOfRedJob - aggregator is skipped when a needed job is also red", async () => {
  const map = await aggregatorMap();

  assert(isDownstreamOfRedJob(
    "CI Required Checks",
    ["CI Required Checks", "Project Validation"],
    map,
  ));
});

Deno.test("isDownstreamOfRedJob - aggregator red alone is diagnosed normally", async () => {
  const map = await aggregatorMap();

  assertFalse(isDownstreamOfRedJob(
    "CI Required Checks",
    ["CI Required Checks"],
    map,
  ));
});

Deno.test("isDownstreamOfRedJob - the red needed job itself is never downstream", async () => {
  const map = await aggregatorMap();

  assertFalse(isDownstreamOfRedJob(
    "Project Validation",
    ["CI Required Checks", "Project Validation"],
    map,
  ));
});

Deno.test("isDownstreamOfRedJob - a check matching no job is a non-aggregator", async () => {
  const map = await aggregatorMap();

  assertFalse(isDownstreamOfRedJob(
    "Some External Check",
    ["Some External Check", "Project Validation"],
    map,
  ));
});

Deno.test("isDownstreamOfRedJob - a matrix-suffixed check name is unmatched, so not skipped", async () => {
  const map = await parseWorkflows({
    "ci.yml": `name: CI
on: [push]
jobs:
  build:
    name: Build
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
    runs-on: \${{ matrix.os }}
    steps:
      - run: echo build
  gate:
    name: Gate
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: echo gate
`,
  }).then(buildJobNeedsMap);

  assertFalse(isDownstreamOfRedJob(
    "Build (ubuntu-latest)",
    ["Build (ubuntu-latest)", "Gate"],
    map,
  ));
});

Deno.test("isDownstreamOfRedJob - follows needs transitively", async () => {
  const map = await parseWorkflows({
    "ci.yml": `name: CI
on: [push]
jobs:
  validation:
    name: Project Validation
    runs-on: ubuntu-latest
    steps:
      - run: echo validate
  gate:
    name: Gate
    needs: [validation]
    runs-on: ubuntu-latest
    steps:
      - run: echo gate
  ci-required:
    name: CI Required Checks
    needs: [gate]
    runs-on: ubuntu-latest
    steps:
      - run: echo required
`,
  }).then(buildJobNeedsMap);

  assert(isDownstreamOfRedJob(
    "CI Required Checks",
    ["CI Required Checks", "Project Validation"],
    map,
  ));
});

Deno.test("isDownstreamOfRedJob - a needs cycle terminates instead of looping", async () => {
  const map = await parseWorkflows({
    "ci.yml": `name: CI
on: [push]
jobs:
  a:
    needs: b
    runs-on: ubuntu-latest
    steps:
      - run: echo a
  b:
    needs: a
    runs-on: ubuntu-latest
    steps:
      - run: echo b
`,
  }).then(buildJobNeedsMap);

  assertFalse(isDownstreamOfRedJob("a", ["a"], map));
  assert(isDownstreamOfRedJob("a", ["a", "b"], map));
});
