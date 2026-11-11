/**
 * The CI-fix scan on a draft PR (Issue #4951): a red check whose `needs:` were
 * all skipped cannot pass on a draft and is not handed to the CI fixer; one
 * with a need that ran is a real failure and is.
 *
 * Drives the real `findFailedCiChecks` against an on-disk clone fixture and an
 * injected `gh` stub whose `check-runs` answer follows the `--jq` conclusion it
 * is asked for, as GitHub's would.
 *
 * Uses Australian English throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { findFailedCiChecks } from "../lib/pr_maintenance.ts";
import { repoCheckoutPath } from "../lib/repo_checkout_path.ts";
import type { Logger } from "../types.ts";

const REPO = "org/repo";

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

function recordingLogger(skips: string[]): Logger {
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

/** One PR; `skipped` names the head's skipped checks, the aggregator is red. */
function ghStub(
  isDraft: boolean,
  skipped: string[] | "unreadable",
): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    const key = args.join(" ");
    if (key.includes("pr list")) {
      return Promise.resolve(JSON.stringify([{
        number: 42,
        headRefName: "issue-1-fix",
        headRefOid: "oid-42",
        baseRefName: "main",
        isDraft,
      }]));
    }
    if (key.includes("annotations")) return Promise.resolve("[]");
    if (key.includes("check-runs")) {
      if (key.includes('.conclusion == "skipped"')) {
        if (skipped === "unreadable") {
          return Promise.reject(new Error("check-runs read failed"));
        }
        return Promise.resolve(JSON.stringify(
          skipped.map((name, i) => ({
            id: 100 + i,
            name,
            status: "completed",
            conclusion: "skipped",
          })),
        ));
      }
      return Promise.resolve(JSON.stringify([{
        id: 900,
        name: "CI Required Checks",
        status: "completed",
        conclusion: "failure",
      }]));
    }
    return Promise.resolve("[]");
  };
}

async function scan(
  isDraft: boolean,
  skipped: string[] | "unreadable",
  skips: string[],
) {
  const workDir = await Deno.makeTempDir({ prefix: "ci-draft-4951-" });
  try {
    const checkout = repoCheckoutPath(workDir, REPO);
    await Deno.mkdir(`${checkout}/.github/workflows`, { recursive: true });
    await Deno.writeTextFile(`${checkout}/.github/workflows/ci.yml`, CI_YML);
    const result = await findFailedCiChecks({
      githubUser: "testbot",
      repos: [REPO],
      logger: recordingLogger(skips),
      isRepoAllowed: () => true,
      isAuthorisedCommenter: () => true,
      ghCommandFn: ghStub(isDraft, skipped),
      workDir,
      stateDir: `${workDir}/.ci_state`,
    });
    assertEquals(result.ok, true);
    return result.ok ? result.value : null;
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
}

Deno.test("findFailedCiChecks - a draft's red check whose needs were all skipped is not returned (Issue #4951)", async () => {
  const skips: string[] = [];
  const found = await scan(true, ["Project Validation", "Quality"], skips);
  assertEquals(found, null);
  assert(
    skips.some((s) => s.startsWith("draft-by-design-ci: ")),
    `expected a draft-by-design-ci skip, got ${JSON.stringify(skips)}`,
  );
});

Deno.test("findFailedCiChecks - a draft's red check with a need that ran is returned (Issue #4951)", async () => {
  const skips: string[] = [];
  const found = await scan(true, ["Project Validation"], skips);
  assert(found !== null, "a need ran, so the failure is real");
  assertEquals(found.checkName, "CI Required Checks");
});

Deno.test("findFailedCiChecks - the same red check on a ready PR is returned though its needs were skipped (Issue #4951 positive control)", async () => {
  const found = await scan(false, ["Project Validation", "Quality"], []);
  assert(found !== null, "only a draft's skipped needs excuse the failure");
  assertEquals(found.checkName, "CI Required Checks");
});

Deno.test("findFailedCiChecks - a draft's red check is kept when the skipped checks cannot be read (Issue #4951)", async () => {
  const found = await scan(true, "unreadable", []);
  assert(found !== null, "a failed read must not hide a failure");
  assertEquals(found.checkName, "CI Required Checks");
});
