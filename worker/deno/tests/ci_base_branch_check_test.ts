/**
 * Tests for `readBaseBranchCheck` and `readCheckIdentity` (Issue #1880, parent
 * #1861; evidence states reworked by Issue #4680).
 *
 * The base-branch deferral spends no attempt and posts no `needs-human`, so
 * the reading behind it must be exact: the latest completed run of the same
 * check on the branch head decides, a run of a different workflow or app is
 * not evidence, a branch that never ran the check is `no-run` rather than red,
 * and a read that failed is `unavailable` rather than a quiet green.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type BaseBranchCheckEvidence,
  type CheckIdentity,
  readBaseBranchCheck,
  readCheckIdentity,
} from "../lib/ci_base_branch_check.ts";

const REPO = "org/repo";
const BRANCH = "develop";
const CHECK = "Project Validation";
const HEAD_SHA = "a".repeat(40);
const OLD_SHA = "b".repeat(40);
const CI_PATH = ".github/workflows/ci.yml";

/** The failing check as the PR carries it: a GitHub Actions job of ci.yml. */
const FAILING: CheckIdentity = {
  name: CHECK,
  appSlug: "github-actions",
  workflowPath: CI_PATH,
};

/** What one gh call answers with: a body, or an error to reject with. */
type Answer = string | Error;

/** Per-test answers. Anything not set takes the default shown on `route`. */
interface GhFixture {
  /** Body of `repos/{repo}/commits/{branch}` (the head SHA). */
  head?: Answer;
  /** Body of the check-runs endpoint. */
  runs?: Answer;
  /** Workflow path per workflow run id; unset ids answer {@link CI_PATH}. */
  paths?: Record<string, Answer>;
  /** Body of `repos/{repo}/check-runs/{id}`. */
  checkRun?: Answer;
  /** Body of `repos/{repo}/commits/{head}/pulls` (merged PR head SHAs). */
  pulls?: Answer;
  /** Tree SHA per commit SHA, from `repos/{repo}/commits/{sha}`. */
  trees?: Record<string, Answer>;
  /** Check-runs body per commit SHA, from `commits/{sha}/check-runs`. */
  commitRuns?: Record<string, Answer>;
}

/**
 * A `gh` runner that answers from `fixture` by endpoint and records each call.
 * An endpoint it does not know rejects, so an unplanned call fails the test.
 */
function ghStub(fixture: GhFixture, calls: string[][] = []) {
  return (args: string[]): Promise<string> => {
    calls.push(args);
    const endpoint = args[1] ?? "";
    const answer = route(endpoint, fixture);
    if (answer === undefined) {
      return Promise.reject(new Error(`unexpected gh call: ${endpoint}`));
    }
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(answer);
  };
}

/** Map an endpoint to its answer, or undefined when the test did not expect it. */
function route(endpoint: string, fixture: GhFixture): Answer | undefined {
  if (endpoint === `repos/${REPO}/commits/${BRANCH}`) {
    return fixture.head ?? `${HEAD_SHA}\n`;
  }
  if (endpoint === `repos/${REPO}/commits/${BRANCH}/check-runs?per_page=100`) {
    return fixture.runs ?? payload([]);
  }
  if (endpoint === `repos/${REPO}/commits/${HEAD_SHA}/pulls?per_page=5`) {
    return fixture.pulls;
  }
  const treeMatch = /^repos\/org\/repo\/commits\/([0-9a-f]{40})$/.exec(
    endpoint,
  );
  if (treeMatch !== null) return fixture.trees?.[treeMatch[1] ?? ""];
  const commitRunsMatch =
    /^repos\/org\/repo\/commits\/([0-9a-f]{40})\/check-runs\?per_page=100$/
      .exec(endpoint);
  if (commitRunsMatch !== null) {
    return fixture.commitRuns?.[commitRunsMatch[1] ?? ""];
  }
  const runMatch = /^repos\/org\/repo\/actions\/runs\/(\d+)$/.exec(endpoint);
  if (runMatch !== null) {
    const workflowRunId = runMatch[1] ?? "";
    return fixture.paths?.[workflowRunId] ?? `${CI_PATH}\n`;
  }
  if (endpoint.startsWith(`repos/${REPO}/check-runs/`)) {
    return fixture.checkRun;
  }
  return undefined;
}

/** One check run as the test wants it; unset fields take the shown defaults. */
interface RunSpec {
  /** Check-run id: the order runs are compared in. */
  id: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  /** Commit the run is for; defaults to the branch head. */
  headSha?: string;
  /** App slug; defaults to `github-actions`. `null` omits it. */
  app?: string | null;
  /** Workflow run id in the details URL; defaults to `id + 90000`. */
  workflowRunId?: number;
}

/**
 * Render one row exactly as `gh api … --jq` emits it: the shape the jq filter
 * in `readBaseBranchCheck` builds from the REST check-run object.
 */
function row(spec: RunSpec) {
  const workflowRunId = spec.workflowRunId ?? spec.id + 90000;
  return {
    id: spec.id,
    name: spec.name ?? CHECK,
    status: spec.status ?? "completed",
    conclusion: spec.conclusion ?? null,
    head_sha: spec.headSha ?? HEAD_SHA,
    app_slug: spec.app === undefined ? "github-actions" : spec.app,
    details_url:
      `https://github.com/org/repo/actions/runs/${workflowRunId}/job/${spec.id}`,
  };
}

/** Render a check-runs body in the `--jq` shape. */
function payload(runs: RunSpec[]): string {
  return JSON.stringify({ check_runs: runs.map(row) });
}

/** Assert the evidence is `unavailable` and its reason names `fragment`. */
function assertUnavailable(
  evidence: BaseBranchCheckEvidence,
  fragment: string,
) {
  assertEquals(evidence.state, "unavailable");
  if (evidence.state === "unavailable") {
    assertStringIncludes(evidence.reason, fragment);
  }
}

/** Read the base branch for {@link FAILING} with the given fixture. */
function read(fixture: GhFixture, calls: string[][] = []) {
  return readBaseBranchCheck({
    repo: REPO,
    branch: BRANCH,
    failing: FAILING,
    ghCommandFn: ghStub(fixture, calls),
  });
}

Deno.test("readBaseBranchCheck - latest completed run failed is red", async () => {
  const calls: string[][] = [];
  const evidence = await read({
    runs: payload([
      { id: 10, conclusion: "success" },
      { id: 22, conclusion: "failure" },
      { id: 30, name: "Other Check", conclusion: "success" },
    ]),
  }, calls);

  assertEquals(evidence, { state: "red", sha: HEAD_SHA, runId: 22 });
  // The branch, not a head SHA, is what was read for the runs.
  assertEquals(
    calls.some((args) =>
      args[1] === `repos/${REPO}/commits/${BRANCH}/check-runs?per_page=100`
    ),
    true,
  );
});

Deno.test("readBaseBranchCheck - a green re-run after an earlier failure is green", async () => {
  const evidence = await read({
    runs: payload([
      { id: 22, conclusion: "failure" },
      { id: 41, conclusion: "success" },
    ]),
  });

  assertEquals(evidence, {
    state: "green",
    sha: HEAD_SHA,
    runId: 41,
    conclusion: "success",
  });
});

Deno.test("readBaseBranchCheck - a known-good base (success) is green", async () => {
  const evidence = await read({
    runs: payload([{ id: 7, conclusion: "success" }]),
  });

  assertEquals(evidence, {
    state: "green",
    sha: HEAD_SHA,
    runId: 7,
    conclusion: "success",
  });
});

Deno.test("readBaseBranchCheck - a check the branch never ran is no-run", async () => {
  const evidence = await read({
    runs: payload([
      { id: 5, name: "Some Other Check", conclusion: "failure" },
    ]),
  });

  assertEquals(evidence, { state: "no-run" });
});

Deno.test("readBaseBranchCheck - a PR-only workflow with no base run is no-run", async () => {
  const evidence = await read({ runs: payload([]) });

  assertEquals(evidence, { state: "no-run" });
});

Deno.test("readBaseBranchCheck - an in-progress re-run does not hide the completed failure", async () => {
  const evidence = await read({
    runs: payload([
      { id: 22, conclusion: "failure" },
      { id: 99, status: "in_progress", conclusion: null },
    ]),
  });

  assertEquals(evidence, { state: "red", sha: HEAD_SHA, runId: 22 });
});

Deno.test("readBaseBranchCheck - cancelled, skipped, neutral, timed_out, action_required and stale are no-run, not green", async () => {
  for (
    const conclusion of [
      "cancelled",
      "skipped",
      "neutral",
      "timed_out",
      "action_required",
      "stale",
    ]
  ) {
    const evidence = await read({
      runs: payload([{ id: 12, conclusion }]),
    });
    assertEquals(evidence, { state: "no-run" }, `conclusion ${conclusion}`);
  }
});

Deno.test("readBaseBranchCheck - the latest run wins even when an earlier head run was green", async () => {
  const evidence = await read({
    runs: payload([
      { id: 10, conclusion: "success" },
      { id: 20, conclusion: "cancelled" },
    ]),
  });

  assertEquals(evidence, { state: "no-run" });
});

Deno.test("readBaseBranchCheck - an unrecognised conclusion is unavailable, never green", async () => {
  const evidence = await read({
    runs: payload([{ id: 14, conclusion: "startup_failure" }]),
  });

  assertUnavailable(evidence, "concluded startup_failure");
});

Deno.test("readBaseBranchCheck - a run on an older sha only is stale, not red", async () => {
  const evidence = await read({
    runs: payload([{ id: 22, conclusion: "failure", headSha: OLD_SHA }]),
  });

  assertEquals(evidence, {
    state: "stale",
    evidenceSha: OLD_SHA,
    baseSha: HEAD_SHA,
  });
});

Deno.test("readBaseBranchCheck - a same-named check from another workflow path is not evidence", async () => {
  const calls: string[][] = [];
  const evidence = await readBaseBranchCheck({
    repo: REPO,
    branch: BRANCH,
    failing: { ...FAILING, workflowPath: ".github/workflows/pr.yml" },
    ghCommandFn: ghStub({
      runs: payload([
        { id: 50, conclusion: "success", workflowRunId: 9050 },
      ]),
      paths: { "9050": ".github/workflows/base.yml\n" },
    }, calls),
  });

  assertEquals(evidence, { state: "no-run" });
  // The candidate's workflow was read, so the path check did run.
  assertEquals(
    calls.some((args) => args[1] === `repos/${REPO}/actions/runs/9050`),
    true,
  );
});

Deno.test("readBaseBranchCheck - a same-named check from another app is not evidence", async () => {
  const evidence = await read({
    runs: payload([
      { id: 50, conclusion: "success", app: "some-other-ci" },
    ]),
  });

  assertEquals(evidence, { state: "no-run" });
});

Deno.test("readBaseBranchCheck - an unresolved failing identity is unavailable and reads nothing", async () => {
  const calls: string[][] = [];
  const evidence = await readBaseBranchCheck({
    repo: REPO,
    branch: BRANCH,
    failing: { name: CHECK, appSlug: null, workflowPath: null },
    ghCommandFn: ghStub(
      { runs: payload([{ id: 1, conclusion: "failure" }]) },
      calls,
    ),
  });

  assertUnavailable(evidence, "unresolved");
  assertEquals(calls.length, 0);
});

Deno.test("readBaseBranchCheck - a GitHub Actions failing check with no workflow path is unavailable and reads nothing", async () => {
  const calls: string[][] = [];
  const evidence = await readBaseBranchCheck({
    repo: REPO,
    branch: BRANCH,
    failing: { name: CHECK, appSlug: "github-actions", workflowPath: null },
    ghCommandFn: ghStub({
      runs: payload([{ id: 1, conclusion: "success" }]),
    }, calls),
  });

  assertUnavailable(evidence, "no workflow path");
  assertEquals(calls.length, 0);
});

Deno.test("readBaseBranchCheck - malformed JSON is unavailable, never green or red", async () => {
  const evidence = await read({ runs: "not json at all" });

  assertUnavailable(evidence, "Failed to parse check runs");
});

Deno.test("readBaseBranchCheck - a payload with no check_runs array is unavailable", async () => {
  const evidence = await read({
    runs: JSON.stringify({ message: "Not Found" }),
  });

  assertUnavailable(evidence, "no check_runs array");
});

Deno.test("readBaseBranchCheck - an API failure on the check runs is unavailable", async () => {
  const evidence = await read({
    runs: new Error("HTTP 404: Not Found"),
  });

  assertUnavailable(evidence, "Failed to read check runs");
});

Deno.test("readBaseBranchCheck - a failed head read is unavailable and reads no runs", async () => {
  const calls: string[][] = [];
  const evidence = await read({
    head: new Error("HTTP 404: Not Found"),
  }, calls);

  assertUnavailable(evidence, "Failed to read head");
  assertEquals(calls.length, 1);
});

Deno.test("readBaseBranchCheck - a head that is not a commit SHA is unavailable", async () => {
  const evidence = await read({ head: "main\n" });

  assertUnavailable(evidence, "not a commit SHA");
});

Deno.test("readBaseBranchCheck - a workflow path that cannot be read is unavailable", async () => {
  const evidence = await read({
    runs: payload([{ id: 22, conclusion: "failure", workflowRunId: 9022 }]),
    paths: { "9022": new Error("HTTP 404: Not Found") },
  });

  assertUnavailable(evidence, "Failed to resolve workflow");
});

Deno.test("readCheckIdentity - resolves name, app and workflow path from the check run", async () => {
  const calls: string[][] = [];
  const result = await readCheckIdentity({
    repo: REPO,
    checkRunId: "22",
    checkName: CHECK,
    ghCommandFn: ghStub({
      checkRun: JSON.stringify({
        name: CHECK,
        app_slug: "github-actions",
        details_url: "https://github.com/org/repo/actions/runs/9022/job/22",
      }),
      paths: { "9022": `${CI_PATH}\n` },
    }, calls),
  });

  assertEquals(result, {
    ok: true,
    value: { name: CHECK, appSlug: "github-actions", workflowPath: CI_PATH },
  });
  assertEquals(
    calls.some((args) => args[1] === `repos/${REPO}/check-runs/22`),
    true,
  );
});

Deno.test("readCheckIdentity - a check from a non-Actions app has no workflow path", async () => {
  const calls: string[][] = [];
  const result = await readCheckIdentity({
    repo: REPO,
    checkRunId: "23",
    checkName: CHECK,
    ghCommandFn: ghStub({
      checkRun: JSON.stringify({
        name: CHECK,
        app_slug: "some-other-ci",
        details_url: "https://ci.example.com/builds/9023",
      }),
    }, calls),
  });

  assertEquals(result, {
    ok: true,
    value: { name: CHECK, appSlug: "some-other-ci", workflowPath: null },
  });
  assertEquals(calls.length, 1);
});

Deno.test("readCheckIdentity - a non-numeric check-run id is refused without a call", async () => {
  const calls: string[][] = [];
  const result = await readCheckIdentity({
    repo: REPO,
    checkRunId: "merge_group-123",
    checkName: CHECK,
    ghCommandFn: ghStub({}, calls),
  });

  assertEquals(result.ok, false);
  assertStringIncludes(
    !result.ok ? result.error.message : "",
    "is not numeric",
  );
  assertEquals(calls.length, 0);
});

Deno.test("readCheckIdentity - a check run with a different name is an error", async () => {
  const result = await readCheckIdentity({
    repo: REPO,
    checkRunId: "22",
    checkName: CHECK,
    ghCommandFn: ghStub({
      checkRun: JSON.stringify({
        name: "Something Else",
        app_slug: "github-actions",
        details_url: "https://github.com/org/repo/actions/runs/9022/job/22",
      }),
    }),
  });

  assertEquals(result.ok, false);
  assertStringIncludes(
    !result.ok ? result.error.message : "",
    `is "Something Else", not "${CHECK}"`,
  );
});

Deno.test("readCheckIdentity - a check run with no app slug is an error, never a null identity", async () => {
  const result = await readCheckIdentity({
    repo: REPO,
    checkRunId: "22",
    checkName: CHECK,
    ghCommandFn: ghStub({
      checkRun: JSON.stringify({
        name: CHECK,
        app_slug: null,
        details_url: "https://github.com/org/repo/actions/runs/9022/job/22",
      }),
    }),
  });

  assertEquals(result.ok, false);
  assertStringIncludes(
    !result.ok ? result.error.message : "",
    "has no app slug",
  );
});

// ---------------------------------------------------------------------------
// Pinning the request shapes and edge cases (Issue #4680)
// ---------------------------------------------------------------------------

Deno.test("readBaseBranchCheck - the check-runs call shapes app slug and details URL through --jq", async () => {
  const calls: string[][] = [];
  await read({ runs: payload([{ id: 1, conclusion: "success" }]) }, calls);

  const call = calls.find((args) =>
    args[1] === `repos/${REPO}/commits/${BRANCH}/check-runs?per_page=100`
  );
  assertEquals(call?.[2], "--jq");
  assertStringIncludes(call?.[3] ?? "", "app_slug: .app.slug");
  assertStringIncludes(call?.[3] ?? "", "details_url");
  assertStringIncludes(call?.[3] ?? "", "head_sha");
});

Deno.test("readBaseBranchCheck - a non-Actions check with no workflow path is read by app, not refused", async () => {
  const calls: string[][] = [];
  const evidence = await readBaseBranchCheck({
    repo: REPO,
    branch: BRANCH,
    failing: { name: CHECK, appSlug: "some-other-ci", workflowPath: null },
    ghCommandFn: ghStub({
      runs: payload([{ id: 9, conclusion: "failure", app: "some-other-ci" }]),
    }, calls),
  });

  assertEquals(evidence, { state: "red", sha: HEAD_SHA, runId: 9 });
});

Deno.test("readBaseBranchCheck - a check-runs body that is JSON but not an object is unavailable", async () => {
  assertUnavailable(await read({ runs: "null" }), "not an object");
  assertUnavailable(await read({ runs: "42" }), "not an object");
});

Deno.test("readCheckIdentity - the check-run call shapes name, app slug and details URL through --jq", async () => {
  const calls: string[][] = [];
  await readCheckIdentity({
    repo: REPO,
    checkRunId: "23",
    checkName: CHECK,
    ghCommandFn: ghStub({
      checkRun: JSON.stringify({
        name: CHECK,
        app_slug: "some-other-ci",
        details_url: null,
      }),
    }, calls),
  });

  assertEquals(calls[0]?.[1], `repos/${REPO}/check-runs/23`);
  assertEquals(calls[0]?.[2], "--jq");
  assertEquals(calls[0]?.[3], "{name, app_slug: .app.slug, details_url}");
});

// ---------------------------------------------------------------------------
// Tree-equivalent evidence for a PR-only workflow (Issue #4680)
// ---------------------------------------------------------------------------

const PR_HEAD = "c".repeat(40);
const OTHER_PR_HEAD = "d".repeat(40);
const TREE = "e".repeat(40);
const OTHER_TREE = "f".repeat(40);

/** A fixture where the merged PR's head has the same tree as the base head. */
function prOnlyFixture(
  prRuns: RunSpec[],
  overrides: GhFixture = {},
): GhFixture {
  return {
    runs: payload([]),
    pulls: JSON.stringify([{ head_sha: PR_HEAD }]),
    trees: { [HEAD_SHA]: `${TREE}\n`, [PR_HEAD]: `${TREE}\n` },
    commitRuns: {
      [PR_HEAD]: payload(prRuns.map((run) => ({ headSha: PR_HEAD, ...run }))),
    },
    ...overrides,
  };
}

Deno.test("readBaseBranchCheck - a PR-only check red on the merged PR's identical tree is red, bound to that commit", async () => {
  const evidence = await read(
    prOnlyFixture([{ id: 70, conclusion: "failure" }]),
  );

  assertEquals(evidence, {
    state: "red",
    sha: PR_HEAD,
    runId: 70,
    treeEquivalentTo: HEAD_SHA,
  });
});

Deno.test("readBaseBranchCheck - a PR-only check green on the merged PR's identical tree is green", async () => {
  const evidence = await read(
    prOnlyFixture([{ id: 70, conclusion: "success" }]),
  );

  assertEquals(evidence, {
    state: "green",
    sha: PR_HEAD,
    runId: 70,
    conclusion: "success",
    treeEquivalentTo: HEAD_SHA,
  });
});

Deno.test("readBaseBranchCheck - the newest run on the identical tree wins", async () => {
  const evidence = await read(
    prOnlyFixture([
      { id: 70, conclusion: "failure" },
      { id: 75, conclusion: "success" },
    ]),
  );

  assertEquals(evidence.state, "green");
});

Deno.test("readBaseBranchCheck - a merged PR whose tree differs is not evidence", async () => {
  const evidence = await read(
    prOnlyFixture([{ id: 70, conclusion: "failure" }], {
      trees: { [HEAD_SHA]: TREE, [PR_HEAD]: OTHER_TREE },
    }),
  );

  assertEquals(evidence, { state: "no-run" });
});

Deno.test("readBaseBranchCheck - a same-named check from another workflow on the identical tree is not evidence", async () => {
  const evidence = await read(
    prOnlyFixture([{ id: 70, conclusion: "failure", workflowRunId: 555 }], {
      paths: { "555": ".github/workflows/codeql.yml" },
    }),
  );

  assertEquals(evidence, { state: "no-run" });
});

Deno.test("readBaseBranchCheck - a run on the identical tree that is cancelled gives no verdict", async () => {
  const evidence = await read(
    prOnlyFixture([{ id: 70, conclusion: "cancelled" }]),
  );

  assertEquals(evidence, { state: "no-run" });
});

Deno.test("readBaseBranchCheck - a run recorded for another commit than the merged PR head is ignored", async () => {
  const evidence = await read(
    prOnlyFixture([{ id: 70, conclusion: "failure", headSha: OLD_SHA }]),
  );

  assertEquals(evidence, { state: "no-run" });
});

Deno.test("readBaseBranchCheck - the newest run across several identical-tree PR heads wins", async () => {
  const evidence = await read(
    prOnlyFixture([{ id: 70, conclusion: "failure" }], {
      pulls: JSON.stringify([
        { head_sha: PR_HEAD },
        { head_sha: OTHER_PR_HEAD },
        { head_sha: HEAD_SHA },
        { head_sha: "not-a-sha" },
      ]),
      trees: {
        [HEAD_SHA]: TREE,
        [PR_HEAD]: TREE,
        [OTHER_PR_HEAD]: TREE,
      },
      commitRuns: {
        [PR_HEAD]: payload([{
          id: 70,
          conclusion: "failure",
          headSha: PR_HEAD,
        }]),
        [OTHER_PR_HEAD]: payload([
          { id: 80, conclusion: "success", headSha: OTHER_PR_HEAD },
        ]),
      },
    }),
  );

  assertEquals(evidence.state, "green");
  assertEquals(evidence.state === "green" && evidence.runId, 80);
});

Deno.test("readBaseBranchCheck - a head-run verdict is never replaced by tree-equivalent evidence", async () => {
  const calls: string[][] = [];
  const evidence = await read(
    prOnlyFixture([{ id: 70, conclusion: "success" }], {
      runs: payload([{ id: 5, conclusion: "failure" }]),
    }),
    calls,
  );

  assertEquals(evidence, { state: "red", sha: HEAD_SHA, runId: 5 });
  assertEquals(calls.some((args) => args[1]?.includes("/pulls")), false);
});

Deno.test("readBaseBranchCheck - an unreadable tree lookup keeps the reading unverified", async () => {
  const noRun = await read(
    prOnlyFixture([{ id: 70, conclusion: "failure" }], {
      trees: { [HEAD_SHA]: new Error("boom") },
    }),
  );
  assertEquals(noRun, { state: "no-run" });

  const stale = await read(
    prOnlyFixture([{ id: 70, conclusion: "failure" }], {
      runs: payload([{ id: 3, conclusion: "failure", headSha: OLD_SHA }]),
      pulls: new Error("no pulls"),
    }),
  );
  assertEquals(stale, {
    state: "stale",
    evidenceSha: OLD_SHA,
    baseSha: HEAD_SHA,
  });
});

Deno.test("readBaseBranchCheck - malformed pulls, tree and run bodies keep the reading unverified", async () => {
  const bad: GhFixture[] = [
    { pulls: "{}" },
    { pulls: "not json" },
    { trees: { [HEAD_SHA]: "nonsense", [PR_HEAD]: TREE } },
    { trees: { [HEAD_SHA]: TREE, [PR_HEAD]: "nonsense" } },
    { commitRuns: { [PR_HEAD]: "not json" } },
  ];
  for (const overrides of bad) {
    const evidence = await read(
      prOnlyFixture([{ id: 70, conclusion: "failure" }], overrides),
    );
    assertEquals(evidence, { state: "no-run" });
  }
});

Deno.test("readBaseBranchCheck - at most five merged PR heads are requested", async () => {
  const calls: string[][] = [];
  await read(prOnlyFixture([{ id: 70, conclusion: "failure" }]), calls);

  const call = calls.find((args) => args[1]?.includes("/pulls"));
  assertEquals(call?.[1], `repos/${REPO}/commits/${HEAD_SHA}/pulls?per_page=5`);
  assertEquals(call?.[3], "[.[] | {head_sha: .head.sha}]");
});

Deno.test("readBaseBranchCheck - a cancelled head run leaves the identical-tree evidence to decide", async () => {
  const evidence = await read(
    prOnlyFixture([{ id: 70, conclusion: "failure" }], {
      runs: payload([{ id: 5, conclusion: "cancelled" }]),
    }),
  );

  assertEquals(evidence, {
    state: "red",
    sha: PR_HEAD,
    runId: 70,
    treeEquivalentTo: HEAD_SHA,
  });
});
