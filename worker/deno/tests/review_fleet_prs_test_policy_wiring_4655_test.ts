/**
 * The #4655 test-change policy wired into the skill's post and gate. Replaces
 * the #3397 opt-in auto-release tests: every repo gets the evidence review,
 * a head that moves during review is never approved, and a hold made under an
 * older policy is reviewed afresh once. Through the real functions, with a
 * fake `gh` shaped like the policy tests' (see test_change_policy_4655 tests).
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import {
  decidePostOutcome,
  headStillCurrent,
  type PostDecision,
  postedResult,
  type TestGatePr,
  type TestPolicyRecord,
} from "../../../.claude/skills/review-fleet-prs/scripts/post.ts";
import { syncNeedsHumanLabel } from "../../../.claude/skills/review-fleet-prs/scripts/needs_human.ts";
import type { RunGh } from "../../../.claude/skills/review-fleet-prs/scripts/needs_human.ts";
import {
  decideOutcome,
  type FableReview,
  HOLD_POLICY_MARKER_PREFIX,
  HOLD_POLICY_VERSION,
  holdPolicyFromBody,
  holdPolicyMarker,
  type LogRecord,
  parseFableReview,
  renderSummary,
  REVIEW_MARKER,
  reviewBody,
  type TestChangeNote,
  writeSummary,
} from "../../../.claude/skills/review-fleet-prs/scripts/review_log.ts";
import {
  policyReport,
  type Review,
  reviewedAtHead,
  type SearchPr,
  skipReason,
} from "../../../.claude/skills/review-fleet-prs/scripts/gate.ts";
import {
  type ApprovedTestChange,
  describeTestPolicy,
  type EffectiveTestPolicy,
  effectiveTestPolicy,
} from "../../../.claude/skills/review-fleet-prs/scripts/test_change_policy.ts";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
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

// A file's text, a directory, or a gh error for that path.
type Entry = string | "dir" | Error;

const CONTENTS: Record<string, Entry> = {
  "tests/retry_test.ts": "test('retries three times', () => {});\n",
  "tests/convert_fixed_test.ts": "test('converts at fixed rate', () => {});\n",
  "src/export.ts": "export function exportJson() {}\n",
};

interface Fx {
  // The head each successive `headRefOid` read sees; the last repeats.
  headOids?: string[];
  pr?: Record<string, unknown>;
  prError?: Error;
  // Extra files at the head commit.
  contents?: Record<string, Entry>;
  // Files at the base branch (the PR's base ref); empty by default.
  base?: Record<string, Entry>;
}

const BASE_BRANCH = "main";

// The head read is `gh pr view --json headRefOid,...`: the fields are one arg.
const isHeadRead = (args: string[]) =>
  args[0] === "pr" && args.some((a) => a.startsWith("headRefOid"));

function answer(args: string[], fx: Fx, headReads: number): string {
  if (args[0] === "pr") {
    if (fx.prError) throw fx.prError;
    if (isHeadRead(args)) {
      const heads = fx.headOids ?? [SHA];
      const oid = heads[Math.min(headReads - 1, heads.length - 1)]!;
      return JSON.stringify({
        headRefOid: oid,
        state: "OPEN",
        mergeStateStatus: "CLEAN",
        isDraft: false,
        mergeable: "MERGEABLE",
      });
    }
    return JSON.stringify(fx.pr ?? PR_VIEW);
  }
  const endpoint = args[1] ?? "";
  const issue = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(endpoint);
  if (issue) {
    if (issue[1] === "acme/widgets" && issue[2] === "3416") {
      return JSON.stringify(ISSUE_3416);
    }
    throw new Error("gh: Not Found (HTTP 404)");
  }
  const file = /^repos\/([^/]+\/[^/]+)\/contents\/(.+)\?ref=([^?&]+)$/.exec(
    endpoint,
  );
  if (file) {
    const path = file[2]!.split("/").map((s) => decodeURIComponent(s)).join(
      "/",
    );
    // The head is read at the commit; the base is read at its branch name.
    // Each ref sees only its own table (Issue #4655: gone coverage is checked
    // at the base as well as the head).
    const ref = decodeURIComponent(file[3]!);
    const table = ref === SHA
      ? { ...CONTENTS, ...fx.contents }
      : ref === BASE_BRANCH
      ? { ...fx.base }
      : {};
    const v = table[path];
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
  let headReads = 0;
  const runGh: RunGh = (args) => {
    calls.push(args);
    if (isHeadRead(args)) headReads++;
    try {
      return Promise.resolve(answer(args, fx, headReads));
    } catch (e) {
      return Promise.reject(e);
    }
  };
  return { calls, runGh };
}

// Records each gh call and answers with nothing (a label edit's reply).
function recorder() {
  const calls: string[][] = [];
  const run: RunGh = (args) => {
    calls.push(args);
    return Promise.resolve("");
  };
  return { calls, run };
}

const POLICY: EffectiveTestPolicy = effectiveTestPolicy({});

const gatePr = (over: Partial<TestGatePr> = {}): TestGatePr => ({
  repo: "acme/widgets",
  number: 42,
  headSha: SHA,
  baseRef: BASE_BRANCH,
  kind: "fleet",
  testChanges: { removed: [], edited: [] },
  ...over,
});

const review = (over: Partial<FableReview> = {}): FableReview => ({
  summary: "Looks right.",
  findings: [],
  testChanges: "meaningful",
  testChangeNotes: [],
  unrelatedIssues: [],
  checklist: [],
  ...over,
});

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

type Settled = Exclude<PostDecision, { retry: string }>;

// The decision, once it is not a retry.
function settled(d: PostDecision): Settled {
  if ("retry" in d) throw new Error(`unexpected retry: ${d.retry}`);
  return d;
}

async function decide(
  r: FableReview,
  opts: {
    pr?: Partial<TestGatePr>;
    fx?: Fx;
    policy?: EffectiveTestPolicy;
  } = {},
): Promise<{ d: PostDecision; calls: string[][] }> {
  const g = fakeGh(opts.fx);
  const pr = gatePr(opts.pr);
  const d = await decidePostOutcome(
    pr,
    r,
    pr.testChanges.removed,
    opts.policy ?? POLICY,
    g.runGh,
  );
  return { d, calls: g.calls };
}

const problems = (d: Settled) =>
  d.review.findings.map((f) => f.problem).join("\n");

// --- decideOutcome --------------------------------------------------------

Deno.test("HOLD_POLICY_VERSION is 2: the #4655 evidence-review policy", () => {
  assertEquals(HOLD_POLICY_VERSION, 2);
});

Deno.test("decideOutcome: a meaningful test change without a hold is approved (#4655)", () => {
  assertEquals(
    decideOutcome(review({ testChanges: "meaningful" }), ["tests/x_test.ts"]),
    "approved",
  );
});

Deno.test("decideOutcome: findings win over an owner hold", () => {
  assertEquals(
    decideOutcome(
      review({ findings: [{ file: "a.ts", line: 1, problem: "bug" }] }),
      [],
      { hold: true },
    ),
    "changes_requested",
  );
});

Deno.test("decideOutcome: hold true holds; a missing checklist item sends it back", () => {
  assertEquals(decideOutcome(review(), [], { hold: true }), "held");
  assertEquals(
    decideOutcome(
      review({
        checklist: [{
          checklist: "docs",
          item: "Docs updated",
          verdict: "missing",
          note: "",
        }],
      }),
      [],
      { hold: true },
    ),
    "changes_requested",
  );
});

// --- decidePostOutcome: approvals ----------------------------------------

Deno.test("approval: an obsolete test removed with coverage that survives, with testReview", async () => {
  const { d } = await decide(
    review({
      testChangeNotes: [note({
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
    }),
    {
      pr: {
        testChanges: { removed: ["tests/legacy_path_test.ts"], edited: [] },
      },
    },
  );
  const s = settled(d);
  assertEquals(s.outcome, "approved");
  assertEquals(s.testReview?.approved.length, 1);
  assertEquals(s.testReview?.approved[0]?.verification, "existing coverage");
});

Deno.test("approval: a brittle live-data test replaced by a hermetic one", async () => {
  const { d } = await decide(
    review({
      testChangeNotes: [note({
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
      })],
    }),
  );
  const s = settled(d);
  assertEquals(s.outcome, "approved");
  assertEquals(s.testReview?.approved[0]?.kind, "replaced");
});

Deno.test("approval: a deliberate behaviour reversal with a verbatim requirement quote", async () => {
  const { d } = await decide(review({ testChangeNotes: [note()] }));
  const s = settled(d);
  assertEquals(s.outcome, "approved");
  assert(s.testReview!.approved[0]!.requirement.includes(`"${REQUIRED}"`));
});

Deno.test("approval: genuinely removed functionality, a gone entry with the file absent at head", async () => {
  const { d } = await decide(
    review({
      testChangeNotes: [note({
        file: "tests/legacy_export_test.ts",
        kind: "removed-file",
        obsolete: "Checks the CSV export that issue 3416 removed.",
        remaining: undefined,
        coverage: [{ role: "gone", path: "tests/legacy_export_test.ts" }],
        requirementQuote: undefined,
        failsWithoutChange: undefined,
        verification: undefined,
      })],
    }),
    {
      pr: {
        testChanges: { removed: ["tests/legacy_export_test.ts"], edited: [] },
      },
      fx: { base: { "tests/legacy_export_test.ts": GONE_FILE } },
    },
  );
  assertEquals(settled(d).outcome, "approved");
});

const GONE_FILE = "test('exports csv', () => {});\n";
const GONE_NOTE = note({
  file: "tests/legacy_export_test.ts",
  kind: "removed-file",
  obsolete: "Checks the CSV export that issue 3416 removed.",
  remaining: undefined,
  coverage: [{ role: "gone", path: "tests/legacy_export_test.ts" }],
  requirementQuote: undefined,
  failsWithoutChange: undefined,
  verification: undefined,
});
const GONE_PR = {
  testChanges: { removed: ["tests/legacy_export_test.ts"], edited: [] },
};

Deno.test("approval: a gone path that exists at the base ref and not at head is approved; base read by branch, head by commit", async () => {
  const { d, calls } = await decide(review({ testChangeNotes: [GONE_NOTE] }), {
    pr: GONE_PR,
    fx: { base: { "tests/legacy_export_test.ts": GONE_FILE } },
  });
  assertEquals(settled(d).outcome, "approved");
  assert(calls.some((c) => c.some((a) => a.endsWith(`?ref=${BASE_BRANCH}`))));
  assert(calls.some((c) => c.some((a) => a.endsWith(`?ref=${SHA}`))));
});

Deno.test("never approved: a gone path absent at both the base ref and the head is changes_requested", async () => {
  const { d } = await decide(review({ testChangeNotes: [GONE_NOTE] }), {
    pr: GONE_PR,
    fx: { base: {} },
  });
  const s = settled(d);
  assertEquals(s.outcome, "changes_requested");
  assertStringIncludes(problems(s), "never existed at the base ref");
});

Deno.test("audit send-back (assess false): the review's own findings alone decide; gh is never called; no retry", async () => {
  const own = [{ file: "a.ts", line: 1, problem: "workflow bug" }];
  const input = review({ findings: own, testChanges: "none" });
  const removed = ["tests/x_test.ts"];
  const g = fakeGh({ prError: new Error("boom") });
  const d = settled(
    await decidePostOutcome(
      gatePr({ testChanges: { removed, edited: [] } }),
      input,
      removed,
      POLICY,
      g.runGh,
      { assess: false },
    ),
  );
  assertEquals(d.outcome, "changes_requested");
  assertEquals(d.review.findings, own);
  assertEquals(g.calls, []);
});

Deno.test("audit send-back default: the assessment runs, appends the no-note finding, and calls gh", async () => {
  const own = [{ file: "a.ts", line: 1, problem: "workflow bug" }];
  const removed = ["tests/x_test.ts"];
  const g = fakeGh();
  const d = settled(
    await decidePostOutcome(
      gatePr({ testChanges: { removed, edited: [] } }),
      review({ findings: own, testChanges: "none" }),
      removed,
      POLICY,
      g.runGh,
    ),
  );
  assertEquals(d.outcome, "changes_requested");
  assertEquals(d.review.findings.length, 2);
  assertStringIncludes(problems(d), "has no review note");
  assert(g.calls.length > 0);
});

Deno.test("approval: a Part of PR, whose governing issue comes only from the Part of line", async () => {
  const { d } = await decide(review({ testChangeNotes: [note()] }), {
    fx: {
      pr: {
        closingIssuesReferences: [],
        headRefName: "feature/retries",
        body: "Summary.\n\nPart of #3416\n",
      },
    },
  });
  const s = settled(d);
  assertEquals(s.outcome, "approved");
  assert(s.testReview!.approved[0]!.requirement.includes("#3416"));
});

Deno.test("approval: a test-only refactor (trivial) is approved and gh is never called", async () => {
  const { d, calls } = await decide(review({ testChanges: "trivial" }));
  assertEquals(settled(d).outcome, "approved");
  assertEquals(calls.length, 0);
});

Deno.test("approval: no test change at all: approved, no testReview, gh never called", async () => {
  const { d, calls } = await decide(review({ testChanges: "none" }));
  const s = settled(d);
  assertEquals(s.outcome, "approved");
  assertFalse("testReview" in s);
  assertFalse("hold" in s);
  assertEquals(calls, []);
});

Deno.test("approval: quote matches across different whitespace and case of the repo name", async () => {
  const { d } = await decide(
    review({
      testChangeNotes: [note({
        requirementQuote: REQUIRED.replace(" three", "\n  three  "),
      })],
    }),
    { pr: { repo: "Acme/Widgets" } },
  );
  assertEquals(settled(d).outcome, "approved");
});

// --- decidePostOutcome: never approved -----------------------------------

Deno.test("never approved: deleting a useful test whose coverage is absent at head", async () => {
  const { d } = await decide(
    review({
      testChangeNotes: [note({
        file: "tests/useful_test.ts",
        kind: "removed-file",
        obsolete: "Checked the retry count of a job that now fails fast.",
        remaining: "The retry test still runs three times.",
        coverage: [{
          role: "existing",
          path: "tests/missing_at_head_test.ts",
          name: "covers the retry",
        }],
        requirementQuote: undefined,
        failsWithoutChange: undefined,
        verification: undefined,
      })],
    }),
    { pr: { testChanges: { removed: ["tests/useful_test.ts"], edited: [] } } },
  );
  const s = settled(d);
  assertEquals(s.outcome, "changes_requested");
  assertStringIncludes(problems(s), "is absent at the head");
});

Deno.test("never approved: widening to a tautological assertion (weakened-assertion)", async () => {
  const { d } = await decide(
    review({ testChangeNotes: [note({ kind: "weakened-assertion" })] }),
  );
  const s = settled(d);
  assertEquals(s.outcome, "changes_requested");
  assertStringIncludes(problems(s), "is never accepted");
});

Deno.test("never approved: an added skip, whatever else the note says", async () => {
  const { d } = await decide(
    review({ testChangeNotes: [note({ kind: "added-skip" })] }),
  );
  const s = settled(d);
  assertEquals(s.outcome, "changes_requested");
  assertStringIncludes(problems(s), "is never accepted");
});

Deno.test("never approved: a reduced threshold", async () => {
  const { d } = await decide(
    review({
      testChangeNotes: [note({
        file: "tests/limit_test.ts",
        kind: "threshold-reduced",
      })],
    }),
  );
  const s = settled(d);
  assertEquals(s.outcome, "changes_requested");
  assertStringIncludes(problems(s), "is never accepted");
});

Deno.test("never approved: removing an uncovered negative case", async () => {
  const { d } = await decide(
    review({
      testChangeNotes: [note({
        file: "tests/negative_test.ts",
        kind: "removed-case",
        coverage: [],
        requirementQuote: undefined,
        failsWithoutChange: undefined,
        verification: undefined,
      })],
    }),
  );
  const s = settled(d);
  assertEquals(s.outcome, "changes_requested");
  assertStringIncludes(problems(s), "no coverage:");
});

Deno.test("never approved: missing evidence, an expected value with no verification", async () => {
  const { d } = await decide(
    review({ testChangeNotes: [note({ verification: "" })] }),
  );
  const s = settled(d);
  assertEquals(s.outcome, "changes_requested");
  assertStringIncludes(problems(s), "is not proof");
});

Deno.test("never approved: a failsWithoutChange that does not show the test fails", async () => {
  for (
    const f of [
      undefined,
      false,
      "",
      "No — passes without the change",
      "unknown",
      "no",
      "No, it passes",
      "false",
    ] as const
  ) {
    const { d } = await decide(
      review({ testChangeNotes: [note({ failsWithoutChange: f })] }),
    );
    const s = settled(d);
    assertEquals(s.outcome, "changes_requested", String(f));
    assertStringIncludes(
      problems(s),
      "not shown to fail without the code change",
    );
  }
  for (
    const f of [
      true,
      "notably, it fails without the change",
      "Yes: fails on the base branch",
    ] as const
  ) {
    const { d } = await decide(
      review({ testChangeNotes: [note({ failsWithoutChange: f })] }),
    );
    assertEquals(settled(d).outcome, "approved", String(f));
  }
});

Deno.test("never approved: a requirement quote absent from the linked issue, and comments never read", async () => {
  const { d, calls } = await decide(
    review({
      testChangeNotes: [note({
        requirementQuote: "this sentence is nowhere in the issue",
      })],
    }),
  );
  const s = settled(d);
  assertEquals(s.outcome, "changes_requested");
  assertStringIncludes(problems(s), "requirement quote is not found");
  for (const c of calls) assertFalse(c.some((a) => a.includes("comments")));
});

Deno.test("never approved: a removed test file with no review note", async () => {
  const { d } = await decide(review({ testChangeNotes: [] }), {
    pr: { testChanges: { removed: ["tests/orphan_test.ts"], edited: [] } },
  });
  const s = settled(d);
  assertEquals(s.outcome, "changes_requested");
  assertStringIncludes(problems(s), "has no review note");
});

Deno.test("never approved: no linked issue names the missing link", async () => {
  const { d } = await decide(review({ testChangeNotes: [note()] }), {
    fx: { pr: { closingIssuesReferences: [], headRefName: "x", body: "" } },
  });
  const s = settled(d);
  assertEquals(s.outcome, "changes_requested");
  assertStringIncludes(problems(s), "no usable governing issue");
});

Deno.test("never approved: an unjustified verdict", async () => {
  const { d } = await decide(
    review({ testChangeNotes: [note({ verdict: "unjustified" })] }),
  );
  const s = settled(d);
  assertEquals(s.outcome, "changes_requested");
  assertStringIncludes(problems(s), "unjustified");
});

Deno.test("never approved: an expected-value change with no requirement quote (carried over from #3397: a hold kept for a missing quote)", async () => {
  const { d } = await decide(
    review({
      testChangeNotes: [
        note(),
        note({ file: "tests/other_test.ts", requirementQuote: undefined }),
      ],
    }),
  );
  const s = settled(d);
  assertEquals(s.outcome, "changes_requested");
  assertStringIncludes(
    problems(s),
    "expected-value change needs a requirement quote",
  );
});

Deno.test("needs-human: an approval with no earlier record adds and removes nothing (carried over from #3397)", async () => {
  const run = recorder();
  const label = await syncNeedsHumanLabel(
    "approved",
    undefined,
    { repo: "acme/widgets", number: 42 },
    run.run,
  );
  assertEquals(label.addedNeedsHuman, false);
  assertEquals(run.calls, []);
});

// --- decidePostOutcome: owner holds, the override and retry --------------

Deno.test("owner verdict: held with the reasons, and no finding", async () => {
  const { d } = await decide(
    review({
      testChangeNotes: [note({
        verdict: "owner",
        ownerQuestion: "Should retries be configurable per job?",
        requirementQuote: undefined,
      })],
    }),
  );
  const s = settled(d);
  assertEquals(s.outcome, "held");
  assertEquals(s.hold?.override, false);
  assertEquals(s.hold?.reasons.length, 1);
  assertStringIncludes(s.hold!.reasons[0]!, "Should retries be configurable");
  assertEquals(s.review.findings, []);
});

Deno.test("hold-all override repo: every meaningful test change is held, gh never called", async () => {
  const policy = effectiveTestPolicy({
    pr_reviewer_test_hold_repos: ["Acme/Widgets"],
  });
  const { d, calls } = await decide(
    review({ testChangeNotes: [note()] }),
    { policy },
  );
  const s = settled(d);
  assertEquals(s.outcome, "held");
  assertEquals(s.hold, { reasons: [], override: true });
  assertEquals(calls, []);
});

Deno.test("hold-all override: findings still send the PR back", async () => {
  const policy = effectiveTestPolicy({
    pr_reviewer_test_hold_repos: ["acme/widgets"],
  });
  const { d } = await decide(
    review({
      findings: [{ file: "a.ts", line: 1, problem: "bug" }],
      testChangeNotes: [note()],
    }),
    { policy },
  );
  assertEquals(settled(d).outcome, "changes_requested");
});

Deno.test("hold-all override: a repo not listed still gets the evidence review", async () => {
  const policy = effectiveTestPolicy({
    pr_reviewer_test_hold_repos: ["acme/other"],
  });
  const { d, calls } = await decide(
    review({ testChangeNotes: [note()] }),
    { policy },
  );
  assertEquals(settled(d).outcome, "approved");
  assert(calls.length > 0);
});

Deno.test("retry: a failed PR view stops the decision; no outcome is produced", async () => {
  const { d } = await decide(
    review({ testChangeNotes: [note()] }),
    { fx: { prError: new Error("boom") } },
  );
  assert("retry" in d);
  assertStringIncludes(d.retry, "fetch failed");
  assertFalse("outcome" in d);
});

Deno.test("findings are appended, not mutated: the input review is left as it was", async () => {
  const input = review({
    testChangeNotes: [note({ kind: "added-skip" })],
  });
  const before = JSON.stringify(input);
  const { d } = await decide(input);
  const s = settled(d);
  assertEquals(s.outcome, "changes_requested");
  assertEquals(s.review.findings.length, 1);
  assertEquals(input.findings.length, 0);
  assertEquals(JSON.stringify(input), before);
});

Deno.test("findings in the review still win on an approved-looking test change", async () => {
  const { d } = await decide(
    review({
      findings: [{ file: "a.ts", line: 1, problem: "bug" }],
      testChangeNotes: [note()],
    }),
  );
  const s = settled(d);
  assertEquals(s.outcome, "changes_requested");
  assertEquals(s.review.findings[0]!.problem, "bug");
});

// --- headStillCurrent and the head moved during review --------------------

Deno.test("headStillCurrent: a moved head or a closed PR is refused with its now-state", async () => {
  const moved = fakeGh({ headOids: [OTHER] });
  assertEquals(
    await headStillCurrent(gatePr(), moved.runGh),
    { ok: false, reason: `now ${OTHER} OPEN` },
  );
  const closed: RunGh = () =>
    Promise.resolve(JSON.stringify({
      headRefOid: SHA,
      state: "CLOSED",
      isDraft: false,
      mergeable: "MERGEABLE",
    }));
  assertEquals(await headStillCurrent(gatePr(), closed), {
    ok: false,
    reason: `now ${SHA} CLOSED`,
  });
  const same = await headStillCurrent(gatePr(), fakeGh().runGh);
  assertEquals(same.ok, true);
});

Deno.test("head moved during review: an approval followed by a re-check at a moved head is refused", async () => {
  // The first read sees the reviewed head, the re-check after the decision
  // sees a new one: main must not post the approval.
  const g = fakeGh({ headOids: [SHA, OTHER] });
  const pr = gatePr();
  const before = await headStillCurrent(pr, g.runGh);
  assertEquals(before.ok, true);
  const d = settled(
    await decidePostOutcome(
      pr,
      review({ testChangeNotes: [note()] }),
      [],
      POLICY,
      g.runGh,
    ),
  );
  assertEquals(d.outcome, "approved");
  const after = await headStillCurrent(pr, g.runGh);
  assertEquals(after, { ok: false, reason: `now ${OTHER} OPEN` });
});

// --- reviewBody: the held, approved and sent-back bodies -----------------

Deno.test("reviewBody held (override): the owner line and the marker on a line of its own", () => {
  const body = reviewBody(
    "held",
    review({ testChanges: "meaningful" }),
    [],
    [],
    {
      hold: { reasons: [], override: true },
    },
  );
  assertStringIncludes(
    body,
    "Held for owner review: this repository holds every meaningful test change for the owner (pr_reviewer_test_hold_repos).",
  );
  assert(body.split("\n").includes(holdPolicyMarker()));
  assertStringIncludes(body, "then remove `needs-human`");
});

Deno.test("reviewBody held (owner question): the reasons are neutralised and the marker is on its own line", () => {
  const body = reviewBody(
    "held",
    review({ testChanges: "meaningful" }),
    [],
    [],
    {
      hold: {
        reasons: ["`a.ts:7`: should retries be <b>configurable</b>? @ops"],
        override: false,
      },
    },
  );
  assertStringIncludes(
    body,
    "Held for owner review: the intended product contract behind these test changes is unclear.",
  );
  assertStringIncludes(body, "- 'a.ts:7': should retries be");
  assertStringIncludes(body, "@\u200bops");
  assert(body.split("\n").includes(holdPolicyMarker()));
  assertFalse(body.includes("<b>"));
  assertFalse(body.includes("@ops"));
});

Deno.test("reviewBody approved: each reviewed change with its evidence, hostile text neutralised", () => {
  const change: ApprovedTestChange = {
    file: "tests/legacy_path_test.ts",
    line: 7,
    kind: "removed-file",
    obsolete: "Old `pin` <img src=x onerror=alert(1)> thanks @maintainer",
    remaining: "Still asserts the retry count.",
    coverage: ["existing: tests/retry_test.ts::retries three times"],
    requirement: `#3416 — "${REQUIRED}"`,
    verification: "existing coverage",
  };
  const body = reviewBody("approved", review(), [], [], {
    testReview: { approved: [change] },
  });
  assertStringIncludes(
    body,
    "Test changes reviewed against the approved test-change policy (Issue #4655): each is shown with the evidence the reviewer script verified at the head commit.",
  );
  assertStringIncludes(
    body,
    "- `tests/legacy_path_test.ts:7` (removed-file): obsolete: Old 'pin'",
  );
  assertStringIncludes(
    body,
    "coverage: existing: tests/retry_test.ts::retries three times",
  );
  assertStringIncludes(body, "verification: existing coverage");
  assertFalse(body.includes("<img"));
  assertFalse(body.includes("`pin`"));
  assertFalse(body.includes("@maintainer"));
  assertStringIncludes(body, "@\u200bmaintainer");
});

Deno.test("reviewBody approved: no evidence list without a testReview, and an empty one shows none", () => {
  assertFalse(
    reviewBody("approved", review({ summary: "ok" }), []).includes(
      "Test changes reviewed",
    ),
  );
  assertFalse(
    reviewBody("approved", review({ summary: "ok" }), [], [], {
      testReview: { approved: [] },
    }).includes("Test changes reviewed"),
  );
});

Deno.test("reviewBody changes_requested: findings and fixes; the notes only when there are any", () => {
  const f = { file: "a.ts", line: 3, problem: "off by one", fix: "use <=" };
  const withNotes = reviewBody(
    "changes_requested",
    review({ findings: [f] }),
    ["tests/gone_test.ts"],
  );
  assertStringIncludes(withNotes, "**`a.ts:3`**: off by one");
  assertStringIncludes(withNotes, "**Fix:** use <=");
  assertStringIncludes(withNotes, "Also note these changes to existing tests:");
  assertStringIncludes(withNotes, "`tests/gone_test.ts`: test file removed.");
  const bare = reviewBody("changes_requested", review({ findings: [f] }), []);
  assertFalse(bare.includes("Also note these changes"));
});

// --- the hold marker is read only as a whole line -------------------------

Deno.test("holdPolicyFromBody: a whole-line marker is read; a quoted or prose marker is not; absent is 1", () => {
  assertEquals(HOLD_POLICY_MARKER_PREFIX, "<!-- vibe-hold-policy v=");
  assertEquals(holdPolicyMarker(), "<!-- vibe-hold-policy v=2 -->");
  assertEquals(holdPolicyFromBody(holdPolicyMarker()), 2);
  assertEquals(holdPolicyFromBody(`Held.\n  ${holdPolicyMarker()}  \n`), 2);
  assertEquals(holdPolicyFromBody(undefined), 1);
  assertEquals(holdPolicyFromBody(""), 1);
  assertEquals(
    holdPolicyFromBody(
      "Held for owner review: this PR changes existing tests.",
    ),
    1,
  );
  // Quoted in a code span, or in the middle of a sentence: not the marker.
  assertEquals(
    holdPolicyFromBody("We quote `<!-- vibe-hold-policy v=2 -->` here."),
    1,
  );
  assertEquals(
    holdPolicyFromBody("The text <!-- vibe-hold-policy v=2 --> continues."),
    1,
  );
  assertEquals(
    holdPolicyFromBody("<!-- vibe-hold-policy v=2 --> and then prose"),
    1,
  );
  // A quoted v2 marker does not make a v1 hold current: only the whole line counts.
  assertEquals(
    holdPolicyFromBody(
      `Quoted: \`${holdPolicyMarker()}\`\n${holdPolicyMarker(1)}`,
    ),
    1,
  );
});

Deno.test("parseFableReview accepts new and old note shapes (carried over from #3397)", () => {
  const text = JSON.stringify({
    summary: "s",
    findings: [],
    testChanges: "meaningful",
    testChangeNotes: [
      note(),
      { file: "old.ts", line: 1, change: "old shape" },
    ],
  });
  const r = parseFableReview(text);
  assertEquals(r.testChangeNotes[0]?.kind, "expected-value");
  assertEquals(r.testChangeNotes[1]?.kind, undefined);
});

// --- gate: reviewedAtHead and skipReason ----------------------------------

const rv = (
  state: string,
  oid: string | null,
  body = "",
  login = "nleck",
): Review => ({
  author: { login },
  state,
  body,
  commit: oid === null ? null : { oid },
});

const HOLD_V1 =
  `Held for owner review: this PR changes existing tests.\n\nNo test changed.\n\nApprove to merge or request changes; then remove \`needs-human\`.\n\n_${REVIEW_MARKER}._`;

Deno.test("reviewedAtHead: a stale hold at the head (no marker, or v1) is not reviewed; the current hold is", () => {
  assertEquals(
    reviewedAtHead(
      [rv("COMMENTED", SHA, `Held.\n\n_${REVIEW_MARKER}._`)],
      "nleck",
      SHA,
    ),
    false,
  );
  assertEquals(
    reviewedAtHead([rv("COMMENTED", SHA, HOLD_V1)], "nleck", SHA),
    false,
  );
  assertEquals(
    reviewedAtHead(
      [rv("COMMENTED", SHA, `${holdPolicyMarker()}\n${REVIEW_MARKER}`)],
      "nleck",
      SHA,
    ),
    true,
  );
});

Deno.test("reviewedAtHead: an approval or a change request at the head counts", () => {
  assertEquals(reviewedAtHead([rv("APPROVED", SHA)], "nleck", SHA), true);
  assertEquals(
    reviewedAtHead([rv("CHANGES_REQUESTED", SHA)], "nleck", SHA),
    true,
  );
});

Deno.test("reviewedAtHead: the latest counted review at the head decides", () => {
  // A current hold, then an approval at the same head: reviewed.
  assertEquals(
    reviewedAtHead(
      [
        rv("COMMENTED", SHA, `${holdPolicyMarker()}\n${REVIEW_MARKER}`),
        rv("APPROVED", SHA),
      ],
      "nleck",
      SHA,
    ),
    true,
  );
  // An approval, then a stale hold at the same head: the hold is the latest.
  assertEquals(
    reviewedAtHead(
      [rv("APPROVED", SHA), rv("COMMENTED", SHA, HOLD_V1)],
      "nleck",
      SHA,
    ),
    false,
  );
});

const searchPr = (overrides: Partial<SearchPr> = {}): SearchPr => ({
  number: 42,
  title: "t",
  url: "https://github.com/acme/widgets/pull/42",
  isDraft: false,
  mergeable: "MERGEABLE",
  headRefOid: SHA,
  baseRefName: "main",
  repository: {
    nameWithOwner: "acme/widgets",
    defaultBranchRef: { name: "main" },
  },
  author: { login: "stservice" },
  commits: {
    nodes: [{
      commit: {
        statusCheckRollup: { state: "SUCCESS" },
        checkSuites: { nodes: [] },
      },
    }],
  },
  reviews: { nodes: [] },
  ...overrides,
} as SearchPr);

Deno.test("skipReason: a held review at the SAME head under policy 1 is not skipped (a replayed hold)", async () => {
  // A public PR held before #4655: the same head, the old hold text, no marker.
  const pr = searchPr({ reviews: { nodes: [rv("COMMENTED", SHA, HOLD_V1)] } });
  assertEquals(await skipReason(pr, "nleck"), null);
  // The current-policy hold at that head is still skipped.
  const current = searchPr({
    reviews: {
      nodes: [rv("COMMENTED", SHA, `${HOLD_V1}\n${holdPolicyMarker()}`)],
    },
  });
  assertEquals(await skipReason(current, "nleck"), "already-reviewed");
});

Deno.test("replay: a re-review of a policy-1 hold; a justified one is approved, and the label is removed only when the skill added it", async () => {
  const pr = searchPr({ reviews: { nodes: [rv("COMMENTED", SHA, HOLD_V1)] } });
  assertEquals(await skipReason(pr, "nleck"), null);

  // The gate's ready entry goes through the decision: approved.
  const g = fakeGh();
  const d = settled(
    await decidePostOutcome(
      gatePr({ headSha: SHA }),
      review({ testChangeNotes: [note()] }),
      [],
      POLICY,
      g.runGh,
    ),
  );
  assertEquals(d.outcome, "approved");

  // The skill had added needs-human on the earlier hold: the approval removes it.
  const added = recorder();
  const removal = await syncNeedsHumanLabel(
    d.outcome,
    { addedNeedsHuman: true } as LogRecord,
    { repo: "acme/widgets", number: 42 },
    added.run,
  );
  assertEquals(removal.addedNeedsHuman, false);
  assert(added.calls.some((c) => c.includes("--remove-label")));

  // A hold the skill did not add (a human's or security's): left alone.
  const human = recorder();
  await syncNeedsHumanLabel(
    d.outcome,
    { addedNeedsHuman: false } as LogRecord,
    { repo: "acme/widgets", number: 42 },
    human.run,
  );
  assertEquals(human.calls, []);

  // Sent back with the actual defect: the same label rule applies.
  const sentBack = settled(
    await decidePostOutcome(
      gatePr(),
      review({
        findings: [{ file: "a.ts", line: 2, problem: "still wrong" }],
      }),
      [],
      POLICY,
      fakeGh().runGh,
    ),
  );
  assertEquals(sentBack.outcome, "changes_requested");

  // A second pass once the new review is at the head: reconsidered once.
  const after = searchPr({
    reviews: {
      nodes: [
        rv("COMMENTED", SHA, HOLD_V1),
        rv("APPROVED", SHA),
      ],
    },
  });
  assertEquals(await skipReason(after, "nleck"), "already-reviewed");
});

// --- the policy and the summary exposed --------------------------------------

Deno.test("policyReport: the effective policy without the trusted logins, plus its description", () => {
  const policy = effectiveTestPolicy({
    pr_reviewer_test_hold_repos: ["a/b"],
    pr_reviewer_auto_release: ["c/d"],
    allowed_authors: ["x"],
  });
  assertEquals(policyReport(policy), {
    version: HOLD_POLICY_VERSION,
    mode: "evidence",
    holdAllRepos: ["a/b"],
    legacyAutoRelease: ["c/d"],
    description: describeTestPolicy(policy),
  });
  assertFalse("trustedLogins" in policyReport(policy));
});

Deno.test("postedResult: testPolicy when given; testChangesReviewed only when true; ownerHold only when non-empty", () => {
  const policy: TestPolicyRecord = {
    version: 2,
    mode: "evidence",
    holdAllRepos: [],
  };
  const approved = postedResult("approved", [], undefined, undefined, {
    testPolicy: policy,
    testChangesReviewed: true,
  }) as Record<string, unknown>;
  assertEquals(approved.testPolicy, policy);
  assertEquals(approved.testChangesReviewed, true);

  const plain = postedResult("approved", []) as Record<string, unknown>;
  assertFalse("testPolicy" in plain);
  assertFalse("testChangesReviewed" in plain);
  assertFalse("ownerHold" in plain);
  assertFalse("autoReleased" in plain);
  assertFalse("autoReleaseHeld" in plain);

  const notReviewed = postedResult("approved", [], undefined, undefined, {
    testChangesReviewed: false,
  }) as Record<string, unknown>;
  assertFalse("testChangesReviewed" in notReviewed);

  const held = postedResult("held", [], undefined, undefined, {
    ownerHold: ["why"],
  }) as Record<string, unknown>;
  assertEquals(held.ownerHold, ["why"]);
  const heldNone = postedResult("held", [], undefined, undefined, {
    ownerHold: [],
  }) as Record<string, unknown>;
  assertFalse("ownerHold" in heldNone);
});

const rec = (over: Partial<LogRecord>): LogRecord => ({
  at: "2026-09-27T11:00:00.000Z",
  repo: "o/r",
  number: 1,
  title: "t",
  url: "https://example.com/1",
  headSha: "abc",
  outcome: "approved",
  summary: "fine",
  findings: [],
  testChangeNotes: [],
  removedTests: [],
  ...over,
});

Deno.test("renderSummary marks reviewed approvals; old auto-released records still render", () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const open = new Set(["o/r#1", "o/r#2", "o/r#3"]);
  const reviewed = "(test changes reviewed)";
  const historical = "(auto-released: issue-required test change)";
  const md = renderSummary(
    [
      rec({ testChangesReviewed: true }),
      rec({ number: 2, autoReleased: true }),
      rec({ number: 3 }),
    ],
    open,
    now,
  );
  assertStringIncludes(md, reviewed);
  assertStringIncludes(md, historical);
  assertEquals(md.split(reviewed).length - 1, 1);
  assertEquals(md.split(historical).length - 1, 1);
});

// describeTestPolicy words the line "test-change policy v2: …"; the summary
// shows it capitalised, on its own line, after the Updated line (Issue #4655).
const shownPolicyLine = (line: string) =>
  line.charAt(0).toUpperCase() + line.slice(1);

Deno.test("renderSummary: the policy line appears, capitalised, after the Updated line when given", () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const line = describeTestPolicy(POLICY);
  const md = renderSummary([], new Set(), now, line);
  const lines = md.split("\n");
  const updated = lines.findIndex((l) => l.startsWith("Updated"));
  assertEquals(lines[updated + 1], shownPolicyLine(line));
  assert(line.startsWith("test-change policy v"));
  assertFalse(md.includes("Test-change policy:"));
  assertFalse(
    renderSummary([], new Set(), now).includes("test-change policy v"),
  );
  assertFalse(
    renderSummary([], new Set(), now).includes("Test-change policy v"),
  );
});

Deno.test("writeSummary writes the capitalised policy line into summary.md", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeSummary(
      dir,
      new Set(),
      new Date("2026-09-27T12:00:00.000Z"),
      describeTestPolicy(POLICY),
    );
    const md = await Deno.readTextFile(`${dir}/summary.md`);
    assert(
      md.split("\n").includes(shownPolicyLine(describeTestPolicy(POLICY))),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
