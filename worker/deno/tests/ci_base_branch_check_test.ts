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
