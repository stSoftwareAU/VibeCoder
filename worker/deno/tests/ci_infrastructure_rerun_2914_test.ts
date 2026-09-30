/**
 * Tests for infrastructure-vs-code triage of red CI checks (Issue #2914).
 *
 * A PR whose only red checks are `cancelled` used to be invisible to the
 * CI-fix scan — nothing re-ran them, and the PR sat stuck forever. These
 * tests drive the real `findFailedCiChecks` against an injected `gh`
 * stub — no network — to confirm cancelled and never-started checks are
 * re-run directly (bounded once per head) and never handed to the
 * CI-fix agent, while a real failure still is.
 *
 * Uses Australian English throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type CiCheckScanOptions,
  findFailedCiChecks,
} from "../lib/pr_maintenance.ts";
import {
  classifyRedChecks,
  rerunInfrastructureChecks,
} from "../lib/ci_infrastructure_rerun.ts";
import { repoCheckoutPath } from "../lib/repo_checkout_path.ts";
import { fakeGithubGraphQL } from "./support/github_graphql_fake.ts";
import type { Logger } from "../types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO = "org/repo";
const PR_NUMBER = 42;
const HEAD_SHA = "a".repeat(40);
const HEAD_SHA_2 = "b".repeat(40);

/**
 * The NEAT-AI-Backpropagation `ci-required` shape: an `if: always()`
 * aggregator that needs `validation`, so it fails for real whenever that
 * job is cancelled.
 */
const CI_YML_WITH_AGGREGATOR = `name: CI
on:
  pull_request:
jobs:
  validation:
    name: Project Validation
    runs-on: ubuntu-latest
    steps:
      - run: echo validate
  ci-required:
    name: CI Required Checks
    if: always()
    needs: [validation]
    runs-on: ubuntu-latest
    steps:
      - run: echo gate
`;

/** A recording logger that also captures skipReasons and warn/info calls. */
function makeRecordingLogger(): Logger & {
  skips: string[];
  warns: string[];
  infos: string[];
  errors: string[];
} {
  const skips: string[] = [];
  const warns: string[] = [];
  const infos: string[] = [];
  const errors: string[] = [];
  return {
    skips,
    warns,
    infos,
    errors,
    info: (message: string) => void infos.push(message),
    warn: (message: string) => void warns.push(message),
    error: (message: string) => void errors.push(message),
    debug: () => {},
    security: () => {},
    skipReason: (code: string, details: string) =>
      void skips.push(`${code}: ${details}`),
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
}

/** A job table keyed by check-run/job id. */
interface JobRow {
  id: number;
  run_id: number;
  conclusion: string;
  steps: Array<{ name: string; conclusion: string }>;
}

/**
 * Read the `.conclusion == "…"` alternatives out of a `--jq` argument, the
 * way the real `gh api … --jq 'select(...)'` filter would see them — so a
 * stub honouring this actually exercises the conclusions the caller asked
 * for, rather than ignoring the filter and returning its own fixed list
 * (PR #2918 review: the bypassed filter let a reverted `RED_CHECK_CONCLUSIONS`
 * stay green here while the real #2914 regression returned).
 */
function jqConclusions(args: string[]): Set<string> | null {
  const jqIndex = args.indexOf("--jq");
  if (jqIndex === -1) return null;
  const clause = args[jqIndex + 1] ?? "";
  const wanted = new Set<string>();
  for (const m of clause.matchAll(/\.conclusion\s*==\s*"([^"]+)"/g)) {
    wanted.add(m[1] as string);
  }
  return wanted.size > 0 ? wanted : null;
}

/**
 * A `gh` stub modelling: `pr list` (one PR), `api graphql` failing (forces
 * REST fallback), the REST check-runs endpoint filtered by the `--jq`
 * clause the caller actually passed, `actions/jobs/<id>` from a job table,
 * `run rerun` recording, and `annotations` returning `[]`.
 */
function ghStub(opts: {
  redChecks: Array<{ id: number; name: string; conclusion: string }>;
  jobs: JobRow[];
  reruns: string[][];
  headRefOid?: string;
  rerunError?: (runId: string) => boolean;
}): (args: string[]) => Promise<string> {
  const { redChecks, jobs, reruns, headRefOid = HEAD_SHA, rerunError } = opts;
  return (args: string[]) => {
    const key = args.join(" ");
    if (key.includes("pr list")) {
      return Promise.resolve(JSON.stringify([
        {
          number: PR_NUMBER,
          headRefName: "issue-1-fix",
          headRefOid,
          baseRefName: "main",
        },
      ]));
    }
    if (key.includes("api graphql")) {
      // Force the REST fallback.
      return Promise.resolve("[]");
    }
    if (key.includes("check-runs") && !key.includes("annotations")) {
      // Honour the `--jq` clause the caller passed, mirroring what the
      // real jq `select(...)` would keep.
      const wanted = jqConclusions(args);
      const checks = wanted === null
        ? redChecks
        : redChecks.filter((check) => wanted.has(check.conclusion));
      return Promise.resolve(JSON.stringify(
        checks.map((check) => ({
          id: check.id,
          name: check.name,
          status: "completed",
          conclusion: check.conclusion,
        })),
      ));
    }
    const jobMatch = key.match(/actions\/jobs\/(\d+)/);
    if (jobMatch) {
      const id = Number(jobMatch[1]);
      const job = jobs.find((j) => j.id === id);
      if (job === undefined) {
        return Promise.reject(new Error(`no such job ${id}`));
      }
      return Promise.resolve(JSON.stringify(job));
    }
    if (key.startsWith("run rerun")) {
      reruns.push(args);
      const runId = args[2] ?? "";
      if (rerunError && rerunError(runId)) {
        return Promise.reject(new Error(`rerun refused for ${runId}`));
      }
      return Promise.resolve("");
    }
    if (key.includes("annotations")) return Promise.resolve("[]");
    return Promise.resolve("[]");
  };
}

/** Run the real scan against a throwaway state directory. */
async function scan(
  ghFn: (args: string[]) => Promise<string>,
  logger: Logger,
  stateDir: string,
) {
  const options: CiCheckScanOptions = {
    githubUser: "testbot",
    repos: [REPO],
    logger,
    isRepoAllowed: () => true,
    isAuthorisedCommenter: () => true,
    ghCommandFn: ghFn,
    stateDir,
  };
  const result = await findFailedCiChecks(options);
  assertEquals(result.ok, true);
  return result.ok ? result.value : null;
}

// ---------------------------------------------------------------------------
// findFailedCiChecks — scan-level tests
// ---------------------------------------------------------------------------

Deno.test("findFailedCiChecks - all cancelled checks are re-run, not handed to CI-fix, bounded once per head", async () => {
  const stateDir = await Deno.makeTempDir({ prefix: "ci-infra-" });
  try {
    const reruns: string[][] = [];
    const logger = makeRecordingLogger();
    const ghFn = ghStub({
      redChecks: [
        { id: 1, name: "Job A", conclusion: "cancelled" },
        { id: 2, name: "Job B", conclusion: "cancelled" },
        { id: 3, name: "Job C", conclusion: "cancelled" },
      ],
      jobs: [
        { id: 1, run_id: 900, conclusion: "cancelled", steps: [] },
        { id: 2, run_id: 900, conclusion: "cancelled", steps: [] },
        { id: 3, run_id: 901, conclusion: "cancelled", steps: [] },
      ],
      reruns,
    });

    const found = await scan(ghFn, logger, stateDir);
    assertEquals(found, null);
    assertEquals(reruns.length, 2);
    const rerunRunIds = reruns.map((r) => r[2]).sort();
    assertEquals(rerunRunIds, ["900", "901"]);
    for (const r of reruns) {
      assertEquals(r, ["run", "rerun", r[2] as string, "--repo", REPO]);
    }
    assert(logger.skips.some((s) => s.startsWith("ci-cancelled: ")));

    // Second scan, same stateDir and head — no further reruns.
    const reruns2: string[][] = [];
    const logger2 = makeRecordingLogger();
    const ghFn2 = ghStub({
      redChecks: [
        { id: 1, name: "Job A", conclusion: "cancelled" },
        { id: 2, name: "Job B", conclusion: "cancelled" },
        { id: 3, name: "Job C", conclusion: "cancelled" },
      ],
      jobs: [
        { id: 1, run_id: 900, conclusion: "cancelled", steps: [] },
        { id: 2, run_id: 900, conclusion: "cancelled", steps: [] },
        { id: 3, run_id: 901, conclusion: "cancelled", steps: [] },
      ],
      reruns: reruns2,
    });
    const found2 = await scan(ghFn2, logger2, stateDir);
    assertEquals(found2, null);
    assertEquals(reruns2.length, 0);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("findFailedCiChecks - a never-started failure (zero steps) is re-run, not handed to CI-fix", async () => {
  const stateDir = await Deno.makeTempDir({ prefix: "ci-infra-" });
  try {
    const reruns: string[][] = [];
    const logger = makeRecordingLogger();
    const ghFn = ghStub({
      redChecks: [
        { id: 10, name: "Never Started", conclusion: "failure" },
      ],
      jobs: [
        { id: 10, run_id: 950, conclusion: "failure", steps: [] },
      ],
      reruns,
    });

    const found = await scan(ghFn, logger, stateDir);
    assertEquals(found, null);
    assertEquals(reruns.length, 1);
    assertEquals(reruns[0], ["run", "rerun", "950", "--repo", REPO]);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("findFailedCiChecks - a real failure is returned to the CI-fix lane and never re-run", async () => {
  const stateDir = await Deno.makeTempDir({ prefix: "ci-infra-" });
  try {
    const reruns: string[][] = [];
    const logger = makeRecordingLogger();
    const ghFn = ghStub({
      redChecks: [
        { id: 20, name: "Real Failure", conclusion: "failure" },
      ],
      jobs: [
        {
          id: 20,
          run_id: 960,
          conclusion: "failure",
          steps: [{ name: "run tests", conclusion: "failure" }],
        },
      ],
      reruns,
    });

    const found = await scan(ghFn, logger, stateDir);
    assertEquals(found?.checkName, "Real Failure");
    assertEquals(found?.checkId, "20");
    assertEquals(reruns.length, 0);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("findFailedCiChecks - a real failure's run is not re-run even when a cancelled check shares it; a cancelled check in another run is", async () => {
  const stateDir = await Deno.makeTempDir({ prefix: "ci-infra-" });
  try {
    const reruns: string[][] = [];
    const logger = makeRecordingLogger();
    const ghFn = ghStub({
      redChecks: [
        { id: 30, name: "Real Failure", conclusion: "failure" },
        { id: 31, name: "Cancelled In Same Run", conclusion: "cancelled" },
        { id: 32, name: "Cancelled Elsewhere", conclusion: "cancelled" },
      ],
      jobs: [
        {
          id: 30,
          run_id: 900,
          conclusion: "failure",
          steps: [{ name: "run tests", conclusion: "failure" }],
        },
        { id: 31, run_id: 900, conclusion: "cancelled", steps: [] },
        { id: 32, run_id: 901, conclusion: "cancelled", steps: [] },
      ],
      reruns,
    });

    const found = await scan(ghFn, logger, stateDir);
    assertEquals(found?.checkName, "Real Failure");
    assertEquals(reruns.length, 1);
    assertEquals(reruns[0], ["run", "rerun", "901", "--repo", REPO]);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("findFailedCiChecks - a new head sha re-runs again (bound is per head)", async () => {
  const stateDir = await Deno.makeTempDir({ prefix: "ci-infra-" });
  try {
    const reruns: string[][] = [];
    const logger = makeRecordingLogger();
    const ghFn = ghStub({
      redChecks: [{ id: 1, name: "Job A", conclusion: "cancelled" }],
      jobs: [{ id: 1, run_id: 900, conclusion: "cancelled", steps: [] }],
      reruns,
      headRefOid: HEAD_SHA,
    });
    await scan(ghFn, logger, stateDir);
    assertEquals(reruns.length, 1);

    const reruns2: string[][] = [];
    const logger2 = makeRecordingLogger();
    const ghFn2 = ghStub({
      redChecks: [{ id: 1, name: "Job A", conclusion: "cancelled" }],
      jobs: [{ id: 1, run_id: 900, conclusion: "cancelled", steps: [] }],
      reruns: reruns2,
      headRefOid: HEAD_SHA_2,
    });
    await scan(ghFn2, logger2, stateDir);
    assertEquals(reruns2.length, 1);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("findFailedCiChecks - a rerun that throws is logged at warn, and the next scan tries again", async () => {
  const stateDir = await Deno.makeTempDir({ prefix: "ci-infra-" });
  try {
    const reruns: string[][] = [];
    const logger = makeRecordingLogger();
    const ghFn = ghStub({
      redChecks: [{ id: 1, name: "Job A", conclusion: "cancelled" }],
      jobs: [{ id: 1, run_id: 900, conclusion: "cancelled", steps: [] }],
      reruns,
      rerunError: () => true,
    });

    const found = await scan(ghFn, logger, stateDir);
    assertEquals(found, null);
    assertEquals(reruns.length, 1);
    assert(logger.warns.some((w) => w.includes("Could not re-run")));

    // No marker was written on total failure — the next scan tries again.
    const reruns2: string[][] = [];
    const logger2 = makeRecordingLogger();
    const ghFn2 = ghStub({
      redChecks: [{ id: 1, name: "Job A", conclusion: "cancelled" }],
      jobs: [{ id: 1, run_id: 900, conclusion: "cancelled", steps: [] }],
      reruns: reruns2,
    });
    const found2 = await scan(ghFn2, logger2, stateDir);
    assertEquals(found2, null);
    assertEquals(reruns2.length, 1);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("findFailedCiChecks - a cancelled check is re-run via the batched GraphQL path, not only the REST fallback", async () => {
  // Regression for the PR #2918 review: every other test here forces the
  // GraphQL call to fail so `buildFailedCheckRunsLookup` falls back to
  // REST, which never exercises `RED_CHECK_CONCLUSIONS` flowing through
  // `fetchFailedCheckRunsBatch` → `rollupToFailedCheckRuns` on the
  // production path. This drives a real (successful) GraphQL rollup with
  // an uppercase `CANCELLED` check run instead.
  const stateDir = await Deno.makeTempDir({ prefix: "ci-infra-gql-" });
  try {
    const reruns: string[][] = [];
    const logger = makeRecordingLogger();
    const { gh: graphqlGh } = fakeGithubGraphQL({
      owner: "org",
      name: "repo",
      pullRequests: {
        [PR_NUMBER]: {
          headOid: HEAD_SHA,
          rollupState: "FAILURE",
          contexts: [{
            kind: "checkRun",
            databaseId: 1,
            name: "Job A",
            status: "COMPLETED",
            conclusion: "CANCELLED",
          }],
        },
      },
    });
    const jobs: JobRow[] = [
      { id: 1, run_id: 900, conclusion: "cancelled", steps: [] },
    ];
    const ghFn = (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (key.includes("pr list")) {
        return Promise.resolve(JSON.stringify([{
          number: PR_NUMBER,
          headRefName: "issue-1-fix",
          headRefOid: HEAD_SHA,
          baseRefName: "main",
        }]));
      }
      if (key.includes("api graphql")) return graphqlGh(args);
      const jobMatch = key.match(/actions\/jobs\/(\d+)/);
      if (jobMatch) {
        const id = Number(jobMatch[1]);
        const job = jobs.find((j) => j.id === id);
        if (job === undefined) {
          return Promise.reject(new Error(`no such job ${id}`));
        }
        return Promise.resolve(JSON.stringify(job));
      }
      if (key.startsWith("run rerun")) {
        reruns.push(args);
        return Promise.resolve("");
      }
      if (key.includes("annotations")) return Promise.resolve("[]");
      return Promise.resolve("[]");
    };

    const found = await scan(ghFn, logger, stateDir);
    assertEquals(found, null);
    assertEquals(reruns.length, 1);
    assertEquals(reruns[0], ["run", "rerun", "900", "--repo", REPO]);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("findFailedCiChecks - a cancelled job plus its same-run aggregator is re-run once, not stranded", async () => {
  // Regression for the PR #2918 review: the aggregator ran and failed for
  // real (non-zero steps), so classifyRedChecks used to put its run id in
  // codeRunIds — which made rerunInfrastructureChecks skip the cancelled
  // job's run "left for the CI-fix fix-push" — while the #1878 aggregator
  // filter separately dropped the aggregator itself. Neither lane acted.
  const workDir = await Deno.makeTempDir({ prefix: "ci-infra-agg-" });
  const stateDir = await Deno.makeTempDir({ prefix: "ci-infra-agg-state-" });
  try {
    const checkout = repoCheckoutPath(workDir, REPO);
    await Deno.mkdir(`${checkout}/.github/workflows`, { recursive: true });
    await Deno.writeTextFile(
      `${checkout}/.github/workflows/ci.yml`,
      CI_YML_WITH_AGGREGATOR,
    );

    const reruns: string[][] = [];
    const logger = makeRecordingLogger();
    const skips = logger.skips;
    const ghFn = ghStub({
      redChecks: [
        { id: 1, name: "Project Validation", conclusion: "cancelled" },
        { id: 2, name: "CI Required Checks", conclusion: "failure" },
      ],
      jobs: [
        { id: 1, run_id: 900, conclusion: "cancelled", steps: [] },
        {
          id: 2,
          run_id: 900,
          conclusion: "failure",
          steps: [{ name: "echo gate", conclusion: "failure" }],
        },
      ],
      reruns,
    });

    const options: CiCheckScanOptions = {
      githubUser: "testbot",
      repos: [REPO],
      logger,
      isRepoAllowed: () => true,
      isAuthorisedCommenter: () => true,
      ghCommandFn: ghFn,
      workDir,
      stateDir,
    };
    const result = await findFailedCiChecks(options);
    assertEquals(result.ok, true);
    const found = result.ok ? result.value : null;

    // Neither check is stranded: the run is re-run once, and nothing is
    // handed to the CI-fix agent for a job that ran none of the repo's code.
    assertEquals(found, null);
    assertEquals(reruns.length, 1);
    assertEquals(reruns[0], ["run", "rerun", "900", "--repo", REPO]);
    assert(skips.some((s) => s.startsWith("ci-cancelled: ")));
    assert(skips.some((s) => s.includes("CI Required Checks (aggregator)")));
  } finally {
    await Deno.remove(workDir, { recursive: true });
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("findFailedCiChecks - a same-run real failure the aggregator does not need is never re-run alongside it", async () => {
  // Regression for the PR #2918 review: the second aggregator pass used
  // to delete the aggregator's run id from `codeRunIds` unconditionally,
  // even though `Lint` — a genuine failure the aggregator does not
  // `need` — shares that same run. That stripped the run's protection
  // and re-ran it, wasting an Actions run and racing the CI-fix fix-push
  // that `Lint` was about to trigger.
  const workDir = await Deno.makeTempDir({ prefix: "ci-infra-agg2-" });
  const stateDir = await Deno.makeTempDir({ prefix: "ci-infra-agg2-state-" });
  try {
    const checkout = repoCheckoutPath(workDir, REPO);
    await Deno.mkdir(`${checkout}/.github/workflows`, { recursive: true });
    await Deno.writeTextFile(
      `${checkout}/.github/workflows/ci.yml`,
      CI_YML_WITH_AGGREGATOR,
    );

    const reruns: string[][] = [];
    const logger = makeRecordingLogger();
    const ghFn = ghStub({
      redChecks: [
        { id: 1, name: "Project Validation", conclusion: "cancelled" },
        { id: 2, name: "Lint", conclusion: "failure" },
        { id: 3, name: "CI Required Checks", conclusion: "failure" },
      ],
      jobs: [
        { id: 1, run_id: 900, conclusion: "cancelled", steps: [] },
        {
          id: 2,
          run_id: 900,
          conclusion: "failure",
          steps: [{ name: "run lint", conclusion: "failure" }],
        },
        {
          id: 3,
          run_id: 900,
          conclusion: "failure",
          steps: [{ name: "echo gate", conclusion: "failure" }],
        },
      ],
      reruns,
    });

    const options: CiCheckScanOptions = {
      githubUser: "testbot",
      repos: [REPO],
      logger,
      isRepoAllowed: () => true,
      isAuthorisedCommenter: () => true,
      ghCommandFn: ghFn,
      workDir,
      stateDir,
    };
    const result = await findFailedCiChecks(options);
    assertEquals(result.ok, true);
    const found = result.ok ? result.value : null;

    // The run is left alone — Lint is a genuine failure sharing it — and
    // Lint itself is handed to the CI-fix lane.
    assertEquals(reruns.length, 0);
    assertEquals(found?.checkName, "Lint");
  } finally {
    await Deno.remove(workDir, { recursive: true });
    await Deno.remove(stateDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// classifyRedChecks — direct unit tests
// ---------------------------------------------------------------------------

Deno.test("classifyRedChecks - cancelled check whose job lookup throws is infrastructure with runId null, and warns", async () => {
  const logger = makeRecordingLogger();
  const ghFn = (_args: string[]) => Promise.reject(new Error("boom"));
  const result = await classifyRedChecks({
    repo: REPO,
    checks: [{
      id: 1,
      name: "Job A",
      status: "completed",
      conclusion: "cancelled",
    }],
    ghCommandFn: ghFn,
    logger,
  });
  assertEquals(result.code, []);
  assertEquals(result.infrastructure.length, 1);
  assertEquals(result.infrastructure[0]?.reason, "cancelled");
  assertEquals(result.infrastructure[0]?.runId, null);
  assert(logger.warns.some((w) => w.includes("Job A")));
});

Deno.test("classifyRedChecks - failing check whose job lookup throws stays on the code route", async () => {
  const logger = makeRecordingLogger();
  const ghFn = (_args: string[]) => Promise.reject(new Error("boom"));
  const result = await classifyRedChecks({
    repo: REPO,
    checks: [{
      id: 2,
      name: "Job B",
      status: "completed",
      conclusion: "failure",
    }],
    ghCommandFn: ghFn,
    logger,
  });
  assertEquals(result.infrastructure, []);
  assertEquals(result.code.length, 1);
  assertEquals(result.code[0]?.name, "Job B");
});

// ---------------------------------------------------------------------------
// rerunInfrastructureChecks — direct unit test for the head-sha guard
// ---------------------------------------------------------------------------

Deno.test("rerunInfrastructureChecks - refuses an invalid head sha and reruns nothing", async () => {
  const logger = makeRecordingLogger();
  const stateDir = await Deno.makeTempDir({ prefix: "ci-infra-direct-" });
  try {
    const reruns: string[][] = [];
    const ghFn = (args: string[]) => {
      reruns.push(args);
      return Promise.resolve("");
    };
    const result = await rerunInfrastructureChecks({
      repo: REPO,
      prNumber: PR_NUMBER,
      headSha: "not-a-sha",
      infrastructure: [{
        id: 1,
        name: "Job A",
        reason: "cancelled",
        runId: 900,
      }],
      codeRunIds: new Set(),
      stateDir,
      ghCommandFn: ghFn,
      logger,
    });
    assertEquals(result, []);
    assertEquals(reruns.length, 0);
    assert(logger.warns.length > 0);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});
