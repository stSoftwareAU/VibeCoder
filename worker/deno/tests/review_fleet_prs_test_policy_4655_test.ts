/**
 * The test-change policy (Issue #4655): config, the governing issues a PR
 * is held to, and the per-note evidence checks, through the real functions
 * and a fake `gh`.
 *
 * The fake's reply shapes were copied from observed `gh` output:
 * - `gh pr view 4639 -R stSoftwareAU/VibeCoder --json closingIssuesReferences,headRefName,body`
 *   gives `closingIssuesReferences` (an array, empty on that PR), `headRefName`
 *   and `body`; a merged PR (#4742, closing #4613) gives each reference as
 *   `{id, number, repository: {id, name, owner: {id, login}}, url}`.
 * - `gh api repos/stSoftwareAU/VibeCoder/issues/4655 --jq '{title, state,
 *   user: .user.login, author_association}'` gives `author_association`
 *   `MEMBER` and a login under `user`; the raw API nests it as `user.login`,
 *   which is the shape the fake returns.
 * - A contents response is `{type, encoding: "base64", content, ...}`; a
 *   directory is an array.
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertThrows,
} from "@std/assert";
import {
  HOLD_POLICY_VERSION,
  type TestChangeNote,
} from "../../../.claude/skills/review-fleet-prs/scripts/review_log.ts";
import type { RunGh } from "../../../.claude/skills/review-fleet-prs/scripts/needs_human.ts";
import {
  type AssessedPr,
  assessTestChanges,
  describeTestPolicy,
  type EffectiveTestPolicy,
  effectiveTestPolicy,
  loadTestPolicy,
  normaliseWs,
  quoteFound,
  resolveGoverningIssues,
  type TestChangeAssessment,
  testModeFor,
} from "../../../.claude/skills/review-fleet-prs/scripts/test_change_policy.ts";

const SHA = "a".repeat(40);
const REQUIRED = "Retries must run three times before the job is marked failed";
const ISSUE_BODY =
  `Acceptance:\n- ${REQUIRED}.\n- The old two-retry default is gone.`;

const ISSUE_3416 = {
  title: "Retry policy",
  body: ISSUE_BODY,
  state: "open",
  user: { login: "nleck" },
  author_association: "MEMBER",
};

const DEFAULT_ISSUES: Record<string, Record<string, unknown> | Error> = {
  "acme/widgets#3416": ISSUE_3416,
};

// A file's text; a directory; or a gh error for that path.
type Entry = string | "dir" | Error;

const DEFAULT_CONTENTS: Record<string, Entry> = {
  "tests/retry_test.ts": "test('retries three times', () => {});\n",
  "tests/convert_fixed_test.ts": "test('converts at fixed rate', () => {});\n",
  "src/export.ts": "export function exportJson() {}\n",
};

const PR_VIEW = {
  closingIssuesReferences: [{
    id: "I_kwDOexample",
    number: 3416,
    repository: {
      id: "R_kgDOexample",
      name: "widgets",
      owner: { id: "MDEyOk9yZ2FuaXphdGlvbjE=", login: "acme" },
    },
    url: "https://github.com/acme/widgets/issues/3416",
  }],
  headRefName: "feature/retries",
  body: "Closes #3416",
};

interface Fx {
  pr?: Record<string, unknown>;
  prError?: Error;
  issues?: Record<string, Record<string, unknown> | Error>;
  contents?: Record<string, Entry>;
}

function answer(args: string[], fx: Fx): string {
  if (args[0] === "pr") {
    if (fx.prError) throw fx.prError;
    return JSON.stringify(fx.pr ?? PR_VIEW);
  }
  const endpoint = args[1] ?? "";
  const issue = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(endpoint);
  if (issue) {
    const issues = { ...DEFAULT_ISSUES, ...fx.issues };
    const v = issues[`${issue[1]}#${issue[2]}`];
    if (v === undefined) throw new Error("gh: Not Found (HTTP 404)");
    if (v instanceof Error) throw v;
    return JSON.stringify(v);
  }
  const file = /^repos\/([^/]+\/[^/]+)\/contents\/(.+)\?ref=([0-9a-f]+)$/.exec(
    endpoint,
  );
  if (file) {
    const path = file[2]!.split("/").map((s) => decodeURIComponent(s)).join(
      "/",
    );
    const contents = { ...DEFAULT_CONTENTS, ...fx.contents };
    const v = contents[path];
    if (v === undefined) throw new Error("gh: Not Found (HTTP 404)");
    if (v instanceof Error) throw v;
    if (v === "dir") {
      return JSON.stringify([{ type: "file", name: "x", path }]);
    }
    return JSON.stringify({
      type: "file",
      encoding: "base64",
      content: `${btoa(v)}\n`,
      path,
    });
  }
  throw new Error(`unexpected gh call: ${args.join(" ")}`);
}

function fakeGh(fx: Fx = {}) {
  const calls: string[][] = [];
  const runGh: RunGh = (args) => {
    calls.push(args);
    try {
      return Promise.resolve(answer(args, fx));
    } catch (e) {
      return Promise.reject(e);
    }
  };
  return { calls, runGh };
}

const contentsCalls = (calls: string[][]) =>
  calls.filter((c) => c[0] === "api" && (c[1] ?? "").includes("/contents/"));

const POLICY: EffectiveTestPolicy = effectiveTestPolicy({});

const PR: AssessedPr = {
  repo: "acme/widgets",
  number: 42,
  headSha: SHA,
  kind: "fleet",
  testChanges: { removed: [], edited: [] },
};

const note = (over: Partial<TestChangeNote> = {}): TestChangeNote => ({
  file: "tests/retry_test.ts",
  line: 7,
  change: "expects 3 retries instead of 2",
  kind: "expected-value",
  verdict: "justified",
  obsolete: "The old default of two retries.",
  remaining: "Asserts the new default of three retries.",
  coverage: [{
    role: "existing",
    path: "tests/retry_test.ts",
    name: "retries three times",
  }],
  requirementQuote: REQUIRED,
  failsWithoutChange: "fails on the base branch with two retries",
  verification: "reverted the default to 2; the test failed",
  ...over,
});

async function assess(
  notes: TestChangeNote[],
  opts: {
    fx?: Fx;
    pr?: Partial<AssessedPr>;
    testChanges?: "none" | "trivial" | "tightened" | "meaningful";
    policy?: EffectiveTestPolicy;
  } = {},
): Promise<{ result: TestChangeAssessment; calls: string[][] }> {
  const g = fakeGh(opts.fx);
  const result = await assessTestChanges(
    { ...PR, ...opts.pr },
    { testChanges: opts.testChanges ?? "meaningful", testChangeNotes: notes },
    opts.policy ?? POLICY,
    g.runGh,
  );
  return { result, calls: g.calls };
}

// The finding that names the probed rule is present.
function assertFinding(r: TestChangeAssessment, fragment: string) {
  assert(
    r.findings.some((f) => f.problem.includes(fragment)),
    `no finding containing "${fragment}": ${JSON.stringify(r.findings)}`,
  );
}

// The same note with only the probed field made legal passes every check.
function assertApproved(r: TestChangeAssessment) {
  assertEquals(r.findings, []);
  assertEquals(r.retry, undefined);
  assertEquals(r.approved.length, 1, JSON.stringify(r));
}

// ----- configuration -------------------------------------------------------

Deno.test("policy defaults: evidence review for every repo, nothing held or trusted", () => {
  assertEquals(effectiveTestPolicy({}), {
    version: HOLD_POLICY_VERSION,
    mode: "evidence",
    holdAllRepos: [],
    legacyAutoRelease: [],
    trustedLogins: [],
  });
  assertEquals(
    effectiveTestPolicy({ pr_reviewer_test_hold_repos: null }).holdAllRepos,
    [],
  );
});

Deno.test("policy: pr_reviewer_test_hold_repos is the owner override list", () => {
  const p = effectiveTestPolicy({
    pr_reviewer_test_hold_repos: ["acme/widgets"],
  });
  assertEquals(p.holdAllRepos, ["acme/widgets"]);
  assertEquals(p.mode, "evidence");
});

Deno.test("policy: a malformed hold list throws with the exact message", () => {
  const message =
    'pr_reviewer_test_hold_repos must be an array of "owner/repo" strings';
  for (const bad of ["acme/widgets", [1], ["noslash"], [""], { 0: "a/b" }]) {
    const e = assertThrows(
      () => effectiveTestPolicy({ pr_reviewer_test_hold_repos: bad }),
      Error,
    );
    assertEquals(e.message, message);
  }
});

Deno.test("policy: a legacy auto-release list is ignored and reported", () => {
  const p = effectiveTestPolicy({ pr_reviewer_auto_release: ["c/d"] });
  assertEquals(p.legacyAutoRelease, ["c/d"]);
  assertEquals(p.holdAllRepos, []);
  assertEquals(p.mode, "evidence");
  assertEquals(testModeFor(p, "c/d"), "evidence");
  // Malformed is reported as empty, never thrown: it is ignored anyway.
  assertEquals(
    effectiveTestPolicy({ pr_reviewer_auto_release: ["x"] }).legacyAutoRelease,
    [],
  );
});

Deno.test("policy: trusted logins come from the three lists, non-strings skipped", () => {
  const p = effectiveTestPolicy({
    allowed_authors: ["alice", 3, "bob"],
    authorized_commenters: ["carol", "alice"],
    pr_reviewers: "not-a-list",
  });
  assertEquals(p.trustedLogins, ["alice", "bob", "carol"]);
  assertEquals(
    effectiveTestPolicy({ pr_reviewers: ["dave"] }).trustedLogins,
    ["dave"],
  );
});

Deno.test("loadTestPolicy: a missing file is the defaults; other read errors rethrow", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(
      await loadTestPolicy(`${dir}/missing.json`),
      effectiveTestPolicy({}),
    );
    await assertRejects(() => loadTestPolicy(dir));
    const f = `${dir}/config.json`;
    await Deno.writeTextFile(
      f,
      JSON.stringify({
        pr_reviewer_test_hold_repos: ["acme/widgets"],
        allowed_authors: ["nleck"],
      }),
    );
    const p = await loadTestPolicy(f);
    assertEquals(p.holdAllRepos, ["acme/widgets"]);
    assertEquals(p.trustedLogins, ["nleck"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("testModeFor: hold-all only for a listed repo, case-insensitively", () => {
  const p = effectiveTestPolicy({
    pr_reviewer_test_hold_repos: ["Acme/Widgets"],
  });
  assertEquals(testModeFor(p, "acme/widgets"), "hold-all");
  assertEquals(testModeFor(p, "ACME/WIDGETS"), "hold-all");
  assertEquals(testModeFor(p, "acme/other"), "evidence");
});

Deno.test("describeTestPolicy: one line, none when empty", () => {
  assertEquals(
    describeTestPolicy(effectiveTestPolicy({})),
    `test-change policy v${HOLD_POLICY_VERSION}: evidence review; owner-hold repos: none; ignored legacy pr_reviewer_auto_release: none`,
  );
  assertEquals(
    describeTestPolicy(effectiveTestPolicy({
      pr_reviewer_test_hold_repos: ["a/b"],
      pr_reviewer_auto_release: ["c/d"],
    })),
    `test-change policy v${HOLD_POLICY_VERSION}: evidence review; owner-hold repos: a/b; ignored legacy pr_reviewer_auto_release: c/d`,
  );
});

Deno.test("quoteFound: plain substring after whitespace normalisation, no word minimum", () => {
  const issues = [{ title: "T", body: "Must return\n  exactly three" }];
  assert(quoteFound("exactly  three", issues));
  assert(quoteFound("T", issues));
  assertFalse(quoteFound("", issues));
  assertFalse(quoteFound("   ", issues));
  assertFalse(quoteFound("exactly four", issues));
  assertEquals(normaliseWs("  a \n b  "), "a b");
});

// ----- governing issues ----------------------------------------------------

const FLEET = { repo: "acme/widgets", number: 42, kind: "fleet" as const };
const DEPENDABOT = { ...FLEET, kind: "dependabot" as const };
const TRUST = { trustedLogins: [] as string[] };

Deno.test("governing issues: closing reference, read with title and body only", async () => {
  const g = fakeGh();
  const r = await resolveGoverningIssues(FLEET, TRUST, g.runGh);
  assertEquals(r.problems, []);
  assertEquals(r.issues, [{
    repo: "acme/widgets",
    number: 3416,
    title: "Retry policy",
    body: ISSUE_BODY,
    source: "closing",
  }]);
  assertEquals(g.calls[0], [
    "pr",
    "view",
    "42",
    "-R",
    "acme/widgets",
    "--json",
    "closingIssuesReferences,headRefName,body",
  ]);
  assertEquals(g.calls[1], ["api", "repos/acme/widgets/issues/3416"]);
  assertFalse(g.calls.some((c) => c.join(" ").includes("comments")));
});

Deno.test("governing issues: the worker's issue from an issue- branch is fleet-only", async () => {
  const fx: Fx = {
    pr: {
      closingIssuesReferences: [],
      headRefName: "issue-4655-reviewer-approve",
      body: "",
    },
    issues: { "acme/widgets#4655": { ...ISSUE_3416, title: "Owner review" } },
  };
  const fleet = await resolveGoverningIssues(FLEET, TRUST, fakeGh(fx).runGh);
  assertEquals(fleet.issues.map((i) => [i.number, i.source]), [[
    4655,
    "worker-branch",
  ]]);

  const g = fakeGh(fx);
  const dep = await resolveGoverningIssues(DEPENDABOT, TRUST, g.runGh);
  assertEquals(dep.issues, []);
  assertFalse(g.calls.some((c) => (c[1] ?? "").includes("issues/4655")));
});

Deno.test("governing issues: an anchored Part of line counts; prose and other repos do not", async () => {
  const anchored = await resolveGoverningIssues(
    FLEET,
    TRUST,
    fakeGh({
      pr: {
        closingIssuesReferences: [],
        headRefName: "feature/x",
        body: "Summary.\r\n\r\nPart of #3416.\r\nMore text.",
      },
    }).runGh,
  );
  assertEquals(anchored.issues.map((i) => [i.number, i.source]), [[
    3416,
    "part-of",
  ]]);

  const g = fakeGh({
    pr: {
      closingIssuesReferences: [],
      headRefName: "feature/x",
      body: "This change is Part of #3416 of the plan.",
    },
  });
  const prose = await resolveGoverningIssues(FLEET, TRUST, g.runGh);
  assertEquals(prose.issues, []);
  assertEquals(prose.problems, []);
  assertEquals(g.calls.length, 1);

  const g2 = fakeGh({
    pr: {
      closingIssuesReferences: [],
      headRefName: "feature/x",
      body: "Part of other/repo#9",
    },
  });
  const other = await resolveGoverningIssues(FLEET, TRUST, g2.runGh);
  assertEquals(other.issues, []);
  assert(
    other.problems.some((p) => p.includes("Part of other/repo#9 is ignored")),
  );
  assertFalse(g2.calls.some((c) => (c[1] ?? "").includes("other/repo")));
});

Deno.test("governing issues: an untrusted author is rejected by a problem", async () => {
  const r = await resolveGoverningIssues(
    FLEET,
    TRUST,
    fakeGh({
      issues: {
        "acme/widgets#3416": {
          ...ISSUE_3416,
          user: { login: "stranger" },
          author_association: "NONE",
        },
      },
    }).runGh,
  );
  assertEquals(r.issues, []);
  assert(
    r.problems.some((p) =>
      p.includes("acme/widgets#3416 is not by a trusted author")
    ),
  );
});

Deno.test("governing issues: a pull request is rejected even with a trusted author", async () => {
  const r = await resolveGoverningIssues(
    FLEET,
    TRUST,
    fakeGh({
      issues: {
        "acme/widgets#3416": {
          ...ISSUE_3416,
          pull_request: {
            url: "https://api.github.com/repos/acme/widgets/pulls/3416",
          },
        },
      },
    }).runGh,
  );
  assertEquals(r.issues, []);
  assert(r.problems.some((p) => p.includes("is a pull request")));
});

Deno.test("governing issues: a [bot] login is trusted only through trustedLogins", async () => {
  const bot = {
    issues: {
      "acme/widgets#3416": {
        ...ISSUE_3416,
        user: { login: "renovate[bot]" },
        author_association: "NONE",
      },
    },
  };
  const trusted = await resolveGoverningIssues(
    FLEET,
    { trustedLogins: ["Renovate"] },
    fakeGh(bot).runGh,
  );
  assertEquals(trusted.issues.map((i) => i.number), [3416]);
  const untrusted = await resolveGoverningIssues(
    FLEET,
    TRUST,
    fakeGh(bot).runGh,
  );
  assertEquals(untrusted.issues, []);
});

Deno.test("governing issues: a failed PR view or issue read is a fetch failed problem", async () => {
  const pr = await resolveGoverningIssues(
    FLEET,
    TRUST,
    fakeGh({
      prError: new Error("HTTP 502: Bad Gateway\nsecond line"),
    }).runGh,
  );
  assertEquals(pr.issues, []);
  assertEquals(pr.problems.length, 1);
  assert(pr.problems[0]!.startsWith("fetch failed:"));
  assert(pr.problems[0]!.includes("HTTP 502: Bad Gateway"));
  assertFalse(pr.problems[0]!.includes("second line"));

  const issue = await resolveGoverningIssues(
    FLEET,
    TRUST,
    fakeGh({
      issues: { "acme/widgets#3416": new Error("HTTP 500: Server Error") },
    }).runGh,
  );
  assertEquals(issue.issues, []);
  assert(issue.problems.some((p) => p.startsWith("fetch failed:")));

  // A missing issue is a problem that is not a fetch failure: a retry would
  // never end for a link that points nowhere.
  const missing = await resolveGoverningIssues(
    FLEET,
    TRUST,
    fakeGh({
      issues: { "acme/widgets#3416": new Error("gh: Not Found (HTTP 404)") },
    }).runGh,
  );
  assertEquals(missing.issues, []);
  assertFalse(missing.problems.some((p) => p.startsWith("fetch failed:")));
});

Deno.test("governing issues: a hostile body of repeated Part of text returns quickly with no issues", async () => {
  const g = fakeGh({
    pr: {
      closingIssuesReferences: [],
      headRefName: "feature/x",
      body: "Part of ".repeat(200000),
    },
  });
  const r = await resolveGoverningIssues(FLEET, TRUST, g.runGh);
  assertEquals(r.issues, []);
  assertEquals(r.problems, []);
  assertEquals(g.calls.length, 1);
});

Deno.test("governing issues: at most five are read, and invalid input is refused without gh", async () => {
  const refs = [1, 2, 3, 4, 5, 6].map((n) => ({
    number: n,
    repository: { name: "widgets", owner: { login: "acme" } },
  }));
  const g = fakeGh({
    pr: { closingIssuesReferences: refs, headRefName: "x", body: "" },
  });
  await resolveGoverningIssues(FLEET, TRUST, g.runGh);
  assertEquals(g.calls.filter((c) => c[0] === "api").length, 5);

  const bad = fakeGh();
  const r = await resolveGoverningIssues(
    { repo: "not a repo", number: 42, kind: "fleet" },
    TRUST,
    bad.runGh,
  );
  assertEquals(r.issues, []);
  assertEquals(bad.calls, []);
});

// ----- assessment ----------------------------------------------------------

Deno.test("assessment: trivial or none with no removed file is not applicable and gh is never called", async () => {
  for (const testChanges of ["none", "trivial"] as const) {
    const { result, calls } = await assess([note()], { testChanges });
    assertEquals(result, {
      checked: false,
      findings: [],
      ownerReasons: [],
      approved: [],
    });
    assertEquals(calls, []);
  }
});

Deno.test("approval: an obsolete test removed with coverage that survives", async () => {
  const { result } = await assess(
    [note({
      file: "tests/legacy_path_test.ts",
      kind: "removed-file",
      obsolete: "Checks the legacy path that issue 3416 deleted.",
      remaining: "The new path is covered by the retry test.",
      coverage: [{
        role: "existing",
        path: "tests/retry_test.ts",
        name: "retries three times",
      }],
      requirementQuote: undefined,
      failsWithoutChange: undefined,
      verification: undefined,
    })],
    {
      pr: {
        testChanges: { removed: ["tests/legacy_path_test.ts"], edited: [] },
      },
    },
  );
  assertApproved(result);
  assertEquals(result.approved[0]!.coverage, [
    "existing: tests/retry_test.ts::retries three times",
  ]);
  assertEquals(result.approved[0]!.verification, "existing coverage");
  assert(result.approved[0]!.requirement.includes("#3416"));
});

Deno.test("approval: a brittle live-data test replaced by a hermetic one, with verification", async () => {
  const { result } = await assess([note({
    file: "tests/convert_live_test.ts",
    kind: "replaced",
    obsolete: "Asserted a live exchange rate that drifts every day.",
    remaining: "Asserts the conversion at a fixed rate fixture.",
    coverage: [{
      role: "replacement",
      path: "tests/convert_fixed_test.ts",
      name: "converts at fixed rate",
    }],
    requirementQuote: undefined,
    failsWithoutChange:
      "yes: the fixed-rate test fails on the base with the rate applied twice",
    verification: "reverted the rate fix; 2 tests failed",
  })]);
  assertApproved(result);
  assertEquals(result.approved[0]!.kind, "replaced");
});

Deno.test("approval: a deliberate behaviour reversal with a verbatim requirement quote", async () => {
  const { result } = await assess([note()]);
  assertApproved(result);
  assert(result.approved[0]!.requirement.includes(`"${REQUIRED}"`));
  assertEquals(result.ownerReasons, []);
});

Deno.test("approval: genuinely removed functionality with a gone entry (file absent at head)", async () => {
  const { result } = await assess([note({
    file: "tests/legacy_export_test.ts",
    kind: "removed-file",
    obsolete: "Checks the CSV export that issue 3416 removed.",
    remaining: undefined,
    coverage: [{ role: "gone", path: "tests/legacy_export_test.ts" }],
    requirementQuote: undefined,
    failsWithoutChange: undefined,
    verification: undefined,
  })], {
    pr: {
      testChanges: { removed: ["tests/legacy_export_test.ts"], edited: [] },
    },
  });
  assertApproved(result);
  assertEquals(result.approved[0]!.coverage, [
    "gone: tests/legacy_export_test.ts",
  ]);
});

Deno.test("approval: genuinely removed symbol with a gone entry (file present, symbol absent)", async () => {
  const { result } = await assess([note({
    file: "src/export_test.ts",
    kind: "removed-case",
    obsolete: "Checked exportCsv, which issue 3416 removed.",
    remaining: undefined,
    coverage: [{ role: "gone", path: "src/export.ts", name: "exportCsv" }],
    requirementQuote: undefined,
    failsWithoutChange: undefined,
    verification: undefined,
  })]);
  assertApproved(result);
});

Deno.test("approval: a Part of PR whose governing issue comes only from the Part of line", async () => {
  const { result } = await assess([note()], {
    fx: {
      pr: {
        closingIssuesReferences: [],
        headRefName: "feature/retries",
        body: "Summary.\n\nPart of #3416\n",
      },
    },
  });
  assertApproved(result);
  assert(result.approved[0]!.requirement.includes("#3416"));
});

Deno.test("approval: a meaningful test refactor with existing coverage", async () => {
  const { result } = await assess([note({
    file: "tests/helpers_test.ts",
    kind: "other",
    obsolete: "Duplicated fixture setup, now a shared helper.",
    remaining: "The same three assertions still run.",
    requirementQuote: undefined,
    failsWithoutChange: undefined,
    verification: undefined,
  })]);
  assertApproved(result);
  assertEquals(result.approved[0]!.verification, "existing coverage");
});

Deno.test("negative: deleting a useful test whose coverage is not at head", async () => {
  const removedNote = (coverage: TestChangeNote["coverage"]) =>
    note({
      file: "tests/useful_test.ts",
      kind: "removed-file",
      obsolete: "Checked the rule that is now enforced elsewhere.",
      remaining: "The rule still holds.",
      coverage,
      requirementQuote: undefined,
      failsWithoutChange: undefined,
      verification: undefined,
    });
  const pr = { testChanges: { removed: ["tests/useful_test.ts"], edited: [] } };

  const absent = await assess(
    [removedNote([{
      role: "existing",
      path: "tests/moved_test.ts",
      name: "covers the rule",
    }])],
    { pr },
  );
  assertFinding(
    absent.result,
    "coverage tests/moved_test.ts::covers the rule is absent at the head",
  );
  assertApproved(
    (await assess(
      [removedNote([{
        role: "existing",
        path: "tests/retry_test.ts",
        name: "retries three times",
      }])],
      { pr },
    )).result,
  );

  const self = await assess(
    [removedNote([{ role: "existing", path: "tests/useful_test.ts" }])],
    { pr },
  );
  assertFinding(
    self.result,
    "coverage tests/useful_test.ts is a removed test file",
  );
  assertEquals(
    contentsCalls(self.calls).filter((c) =>
      (c[1] ?? "").includes("useful_test")
    ),
    [],
  );
});

Deno.test("negative: a named test that is not in the file at head", async () => {
  const { result } = await assess([note({
    coverage: [{
      role: "existing",
      path: "tests/retry_test.ts",
      name: "retries four times",
    }],
  })]);
  assertFinding(
    result,
    "coverage name tests/retry_test.ts::retries four times is not in the file at the head",
  );
  assertApproved((await assess([note()])).result);
});

Deno.test("negative: widening a range to a weakened assertion is never accepted", async () => {
  const { result } = await assess([note({ kind: "weakened-assertion" })]);
  assertFinding(result, "never accepted as a test change");
  assertEquals(result.approved, []);
  assertApproved((await assess([note({ kind: "expected-value" })])).result);
});

Deno.test("negative: an expected-value widening without verification is not proof", async () => {
  const { result } = await assess([note({ verification: undefined })]);
  assertFinding(result, "a boolean or vacuous claim is not proof");
  assertApproved(
    (await assess([
      note({ verification: "reverted the widening; the test failed" }),
    ])).result,
  );
});

Deno.test("negative: an added skip is never accepted, whatever else it says", async () => {
  const { result } = await assess([note({ kind: "added-skip" })]);
  assertFinding(result, "never accepted as a test change");
  assertApproved((await assess([note({ kind: "other" })])).result);
});

Deno.test("negative: a removed negative case with no coverage", async () => {
  const removedCase = (coverage: TestChangeNote["coverage"]) =>
    note({
      kind: "removed-case",
      obsolete: "Checked the negative case that issue 3416 dropped.",
      remaining: "The positive path is still covered.",
      coverage,
      requirementQuote: undefined,
      failsWithoutChange: undefined,
      verification: undefined,
    });
  const { result } = await assess([removedCase([])]);
  assertFinding(result, "no coverage:");
  assertApproved(
    (await assess([removedCase([{
      role: "existing",
      path: "tests/retry_test.ts",
      name: "retries three times",
    }])])).result,
  );
});

Deno.test("negative: a reduced threshold is never accepted", async () => {
  const { result } = await assess([note({ kind: "threshold-reduced" })]);
  assertFinding(result, "never accepted as a test change");
  assertApproved((await assess([note({ kind: "other" })])).result);
});

Deno.test("negative: missing obsolete statement", async () => {
  const { result } = await assess([note({ obsolete: undefined })]);
  assertFinding(result, "no obsolete statement");
  assertApproved((await assess([note()])).result);
});

Deno.test("negative: no verdict, and an unjustified verdict", async () => {
  const none = await assess([note({ verdict: undefined })]);
  assertFinding(none.result, "no justified verdict");
  assertApproved((await assess([note()])).result);

  const unjustified = await assess([note({ verdict: "unjustified" })]);
  assertFinding(unjustified.result, "verdict is unjustified");
  assertApproved((await assess([note({ verdict: "justified" })])).result);
});

Deno.test("negative: a bare boolean verification is not proof", async () => {
  const { result } = await assess([note({
    verification: true as unknown as string,
  })]);
  assertFinding(result, "a boolean or vacuous claim is not proof");
  assertApproved(
    (await assess([
      note({ verification: "reverted the default; the test failed" }),
    ])).result,
  );
});

Deno.test("negative: a removed test file with no review note", async () => {
  const pr = { testChanges: { removed: ["tests/gone_test.ts"], edited: [] } };
  const none = await assess([], { pr });
  assertEquals(none.result.findings.length, 1);
  assertEquals(none.result.findings[0]!.file, "tests/gone_test.ts");
  assertFinding(none.result, "removed test file has no review note");

  const legal = await assess([note({
    file: "tests/gone_test.ts",
    kind: "removed-file",
    coverage: [{
      role: "existing",
      path: "tests/retry_test.ts",
      name: "retries three times",
    }],
    requirementQuote: undefined,
    failsWithoutChange: undefined,
    verification: undefined,
  })], { pr });
  assertApproved(legal.result);
});

Deno.test("negative: a requirement quote not found in a linked issue", async () => {
  const { result } = await assess([note({
    requirementQuote: "a sentence that is nowhere in the issue at all",
  })]);
  assertFinding(result, "requirement quote is not found in a linked issue");
  assertApproved((await assess([note({ requirementQuote: REQUIRED })])).result);
});

Deno.test("negative: an expected-value change without a requirement quote", async () => {
  const { result } = await assess([note({ requirementQuote: undefined })]);
  assertFinding(result, "expected-value change needs a requirement quote");
  assertApproved((await assess([note({ requirementQuote: REQUIRED })])).result);
});

Deno.test("negative: no usable governing issue", async () => {
  const { result } = await assess([
    note({ requirementQuote: undefined, kind: "other" }),
  ], {
    fx: {
      pr: {
        closingIssuesReferences: [],
        headRefName: "feature/x",
        body: "Nothing.",
      },
    },
  });
  assertFinding(
    result,
    'no usable governing issue: link the issue this change serves with "Closes #N"',
  );
  assertApproved(
    (await assess([note({ requirementQuote: undefined, kind: "other" })]))
      .result,
  );
});

Deno.test("negative: an owner verdict is a comment-only reason, and needs a question", async () => {
  const withQuestion = await assess([note({
    verdict: "owner",
    ownerQuestion: "Should the default stay at two retries for customers?",
  })]);
  assertEquals(withQuestion.result.findings, []);
  assertEquals(withQuestion.result.approved, []);
  assertEquals(withQuestion.result.ownerReasons, [
    "`tests/retry_test.ts:7`: Should the default stay at two retries for customers?",
  ]);

  const without = await assess([
    note({ verdict: "owner", ownerQuestion: undefined }),
  ]);
  assertFinding(without.result, "owner verdict without a question");
  assertEquals(without.result.ownerReasons, []);
  assertEquals(
    (await assess([
      note({ verdict: "owner", ownerQuestion: "Keep two retries?" }),
    ]))
      .result.ownerReasons.length,
    1,
  );
});

Deno.test("retry: a non-404 gh error on a contents read stops the assessment", async () => {
  const { result } = await assess([note()], {
    fx: {
      contents: {
        "tests/retry_test.ts": new Error(
          "gh: Server Error (HTTP 500)\nmore detail",
        ),
      },
    },
  });
  assertEquals(result.checked, true);
  assertEquals(result.findings, []);
  assertEquals(result.approved, []);
  assert(result.retry?.includes("HTTP 500"));
  assertFalse(result.retry?.includes("more detail"));

  // With the file readable the same note is approved.
  assertApproved((await assess([note()])).result);
});

Deno.test("retry: a failed PR view stops the assessment, naming the fetch", async () => {
  const { result } = await assess([note()], {
    fx: { prError: new Error("HTTP 502: Bad Gateway") },
  });
  assertEquals(result.findings, []);
  assert(result.retry?.startsWith("fetch failed:"));
});

Deno.test("negative: a coverage path that escapes the repo is refused without a gh call", async () => {
  for (const bad of ["../x", "/etc/passwd", "a//b", "a/../b"]) {
    const { result, calls } = await assess([note({
      coverage: [{ role: "existing", path: bad, name: "retries three times" }],
    })]);
    assertFinding(
      result,
      `coverage path ${bad} is not an allowed repo-relative path`,
    );
    assertEquals(contentsCalls(calls), [], bad);
    assertApproved((await assess([note()])).result);
  }
});

Deno.test("negative: a head commit id that is not 40 hex characters", async () => {
  const { result, calls } = await assess([note()], {
    pr: { headSha: "ABC123" },
  });
  assertFinding(result, "not a full 40-character sha");
  assertEquals(contentsCalls(calls), []);
  assertApproved((await assess([note()])).result);
});
