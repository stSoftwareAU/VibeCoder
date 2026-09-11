/**
 * Tests for the CI-fix scan's aggregator filtering (Issue #1878, part of
 * #1861).
 *
 * Regression: the NEAT-AI-Backpropagation `ci-required` job
 * (`name: CI Required Checks`, `needs: [validation, quality, …]`,
 * `if: always()`) is red whenever any needed job is red. The scan handed
 * it to the CI-fix processor, which earned it a failure signature and a
 * stock PR comment about a job that ran none of the repo's code.
 *
 * Every test drives the real `findFailedCiChecks` against a real
 * on-disk clone fixture and an injected `gh` stub — no network.
 *
 * Uses Australian English throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type CiCheckScanOptions,
  findFailedCiChecks,
} from "../lib/pr_maintenance.ts";
import { repoCheckoutPath } from "../lib/repo_checkout_path.ts";
import type { Logger } from "../types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO = "org/repo";
const PR_NUMBER = 42;

/** The NEAT-AI-Backpropagation `ci.yml` shape. */
const CI_YML = `name: CI
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
  ci-required:
    name: CI Required Checks
    if: always()
    needs: [validation, quality]
    runs-on: ubuntu-latest
    steps:
      - run: echo gate
`;

/** Records every `skipReason` line the scan emitted. */
function makeRecordingLogger(skips: string[]): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    security: noop,
    skipReason: (code: string, details: string) =>
      void skips.push(`${code}: ${details}`),
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

/** A `gh` stub for one PR whose failed check runs are `checks`. */
function ghStub(
  checks: Array<{ id: number; name: string }>,
): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    const key = args.join(" ");
    if (key.includes("pr list")) {
      return Promise.resolve(JSON.stringify([
        {
          number: PR_NUMBER,
          headRefName: "issue-1-fix",
          baseRefName: "main",
        },
      ]));
    }
    if (key.includes("check-runs") && !key.includes("annotations")) {
      return Promise.resolve(JSON.stringify(
        checks.map((check) => ({
          ...check,
          status: "completed",
          conclusion: "failure",
        })),
      ));
    }
    if (key.includes("annotations")) return Promise.resolve("[]");
    return Promise.resolve("[]");
  };
}

/**
 * Run the scan against a throwaway work directory.
 *
 * `withClone` writes the fixture workflow into the clone the scan reads
 * (`<workDir>/<repo>`); omitting it models a host with no clone.
 */
async function scan(
  checks: Array<{ id: number; name: string }>,
  withClone: boolean | "clone-without-workflows",
  skips: string[] = [],
) {
  const workDir = await Deno.makeTempDir({ prefix: "ci-aggregator-" });
  try {
    if (withClone === "clone-without-workflows") {
      await Deno.mkdir(repoCheckoutPath(workDir, REPO), { recursive: true });
    } else if (withClone) {
      const checkout = repoCheckoutPath(workDir, REPO);
      await Deno.mkdir(`${checkout}/.github/workflows`, { recursive: true });
      await Deno.writeTextFile(`${checkout}/.github/workflows/ci.yml`, CI_YML);
    }
    const options: CiCheckScanOptions = {
      githubUser: "testbot",
      repos: [REPO],
      logger: makeRecordingLogger(skips),
      isRepoAllowed: () => true,
      isAuthorisedCommenter: () => true,
      ghCommandFn: ghStub(checks),
      workDir,
      stateDir: `${workDir}/.ci_state`,
    };
    const result = await findFailedCiChecks(options);
    assertEquals(result.ok, true);
    return result.ok ? result.value : null;
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("findFailedCiChecks - drops the aggregator and returns the real failure", async () => {
  const skips: string[] = [];
  const found = await scan(
    [
      { id: 900, name: "CI Required Checks" },
      { id: 901, name: "Project Validation" },
    ],
    true,
    skips,
  );

  assertEquals(found?.checkName, "Project Validation");
  assertEquals(found?.checkId, "901");
  assertEquals(skips.length, 1);
  assert(skips[0]?.startsWith("aggregator-check: "));
  assert(skips[0]?.includes("CI Required Checks"));
});

Deno.test("findFailedCiChecks - the sibling failing check names ride along for the processor", async () => {
  const found = await scan(
    [
      { id: 900, name: "CI Required Checks" },
      { id: 901, name: "Project Validation" },
    ],
    true,
  );

  assertEquals(found?.siblingFailedCheckNames, [
    "CI Required Checks",
    "Project Validation",
  ]);
});

Deno.test("findFailedCiChecks - an aggregator red on its own is still diagnosed", async () => {
  const skips: string[] = [];
  const found = await scan(
    [{ id: 900, name: "CI Required Checks" }],
    true,
    skips,
  );

  assertEquals(found?.checkName, "CI Required Checks");
  assertEquals(skips, []);
});

Deno.test("findFailedCiChecks - no clone means no filtering", async () => {
  const found = await scan(
    [
      { id: 900, name: "CI Required Checks" },
      { id: 901, name: "Project Validation" },
    ],
    false,
  );

  // Without workflow YAML to read, the first failure is returned exactly
  // as it was before Issue #1878.
  assertEquals(found?.checkName, "CI Required Checks");
});

Deno.test("findFailedCiChecks - a clone with no workflows filters nothing", async () => {
  const found = await scan(
    [
      { id: 900, name: "CI Required Checks" },
      { id: 901, name: "Project Validation" },
    ],
    "clone-without-workflows",
  );

  assertEquals(found?.checkName, "CI Required Checks");
});
