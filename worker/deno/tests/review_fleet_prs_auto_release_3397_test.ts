/**
 * Opt-in auto-release of issue-required test-change holds (Issue #3397).
 */
import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertThrows,
} from "@std/assert";
import {
  autoReleaseDecision,
  autoReleaseRepos,
  isAutoReleaseRepo,
  loadAutoReleaseRepos,
  quoteFound,
  resolveAutoRelease,
} from "../../../.claude/skills/review-fleet-prs/scripts/auto_release.ts";
import {
  decidePostOutcome,
  postedResult,
} from "../../../.claude/skills/review-fleet-prs/scripts/post.ts";
import { syncNeedsHumanLabel } from "../../../.claude/skills/review-fleet-prs/scripts/needs_human.ts";
import {
  decideOutcome,
  type FableReview,
  type LogRecord,
  parseFableReview,
  renderSummary,
  reviewBody,
  type TestChangeNote,
} from "../../../.claude/skills/review-fleet-prs/scripts/review_log.ts";

const pr = { repo: "acme/widgets", number: 42 };
const repos = ["acme/widgets"];
const CRITERION =
  "Tests cover an auto-release, and a hold kept because one entry lacks a quoted criterion.";

const review = (over: Partial<FableReview> = {}): FableReview => ({
  summary: "Looks right.",
  findings: [],
  testChanges: "meaningful",
  testChangeNotes: [],
  unrelatedIssues: [],
  ...over,
});

const note = (over: Partial<TestChangeNote> = {}): TestChangeNote => ({
  file: "a_test.ts",
  line: 7,
  change: "expects 3 instead of 2",
  kind: "expected-value",
  criterionQuote: CRITERION,
  failsWithoutChange: true,
  ...over,
});

const qualifying = (notes: TestChangeNote[] = [note()]) =>
  review({ testChangeNotes: notes });

interface FakeOpts {
  refs?: unknown[];
  throwOn?: "pr" | "issue";
  body?: string;
}

function fakeGh(opts: FakeOpts = {}) {
  const calls: string[][] = [];
  const run = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "pr") {
      if (opts.throwOn === "pr") return Promise.reject(new Error("boom"));
      return Promise.resolve(JSON.stringify({
        closingIssuesReferences: opts.refs ?? [{
          id: "I_1",
          number: 3416,
          repository: {
            id: "R_1",
            name: "widgets",
            owner: { id: "O_1", login: "acme" },
          },
          url: "https://example.com/i/3416",
        }],
      }));
    }
    if (args[0] === "issue") {
      if (opts.throwOn === "issue") return Promise.reject(new Error("boom"));
      return Promise.resolve(
        JSON.stringify({
          title: "T",
          body: opts.body ?? `Intro\n- ${CRITERION}`,
        }),
      );
    }
    return Promise.resolve("");
  };
  return { calls, run };
}

const decide = (r: FableReview, removed: string[] = [], g = fakeGh()) =>
  decidePostOutcome(pr, r, removed, repos, g.run);

Deno.test("opt-in off: no hold release and gh is never called", async () => {
  const g = fakeGh();
  const r = await decidePostOutcome(pr, qualifying(), [], [], g.run);
  assertEquals(r.outcome, "held");
  assertEquals(r.autoReleased, false);
  assertEquals(g.calls.length, 0);
});

Deno.test("decideOutcome: no opts equals empty opts", () => {
  const cases: [FableReview, string[]][] = [
    [review({ testChanges: "none" }), []],
    [review({ testChanges: "trivial" }), []],
    [review({ testChanges: "tightened" }), []],
    [review({ testChanges: "meaningful" }), []],
    [review({ findings: [{ file: "a", line: 1, problem: "p" }] }), []],
    [review({ testChanges: "none" }), ["x_test.ts"]],
  ];
  for (const [r, removed] of cases) {
    assertEquals(decideOutcome(r, removed), decideOutcome(r, removed, {}));
  }
  assertEquals(decideOutcome(review(), []), "held");
});

Deno.test("auto-release: qualifying notes on an opted-in repo are approved", async () => {
  const g = fakeGh();
  const r = qualifying();
  const res = await decide(r, [], g);
  assertEquals(res.outcome, "approved");
  assertEquals(res.autoReleased, true);
  assertEquals(res.autoReleaseReasons, []);

  const body = reviewBody("approved", r, [], [], { autoReleased: true });
  assert(body.includes("Auto-released"));
  assert(body.includes(CRITERION));
  assert(body.includes("`a_test.ts:7`"));

  const gh = fakeGh();
  await syncNeedsHumanLabel("approved", undefined, pr, gh.run);
  assertFalse(gh.calls.some((c) => c.includes("--add-label")));
});

Deno.test("auto-release: quote matches across different whitespace and case of the repo name", async () => {
  const quote = CRITERION.replace(" an auto-release,", "\n an  auto-release,");
  const g = fakeGh();
  const res = await decidePostOutcome(
    { repo: "Acme/Widgets", number: 42 },
    qualifying([note({ criterionQuote: quote })]),
    [],
    repos,
    g.run,
  );
  assertEquals(res.outcome, "approved");
});

Deno.test("hold kept when one of two entries lacks a criterion quote", async () => {
  const res = await decide(
    qualifying([
      note(),
      note({ file: "b_test.ts", criterionQuote: undefined }),
    ]),
  );
  assertEquals(res.outcome, "held");
  assertEquals(res.autoReleased, false);
  assertEquals(res.autoReleaseReasons, ["`b_test.ts:7`: no criterion quote"]);
  assertEquals(res.autoReleaseHeld, res.autoReleaseReasons);
});

Deno.test("hold kept when the quote is absent, too short, and comments are never fetched", async () => {
  const g = fakeGh();
  const absent = await decide(
    qualifying([
      note({ criterionQuote: "this sentence is nowhere in the issue" }),
    ]),
    [],
    g,
  );
  assertEquals(absent.outcome, "held");
  assertEquals(absent.autoReleaseReasons, [
    "`a_test.ts:7`: criterion quote not found in a linked issue",
  ]);

  const g2 = fakeGh({ body: "Must return exactly three" });
  const short = await decide(
    qualifying([note({ criterionQuote: "exactly three" })]),
    [],
    g2,
  );
  assertEquals(short.outcome, "held");
  assertFalse(
    quoteFound("four words only here", [{
      title: "",
      body: "four words only here",
    }]),
  );
  for (const c of [...g.calls, ...g2.calls]) {
    assertFalse(c.some((a) => a.includes("comments")));
  }
});

Deno.test("hold kept when no linked issue or gh fails", async () => {
  assertEquals(
    (await decide(qualifying(), [], fakeGh({ refs: [] }))).outcome,
    "held",
  );
  assertEquals(
    (await decide(qualifying(), [], fakeGh({ throwOn: "pr" }))).outcome,
    "held",
  );
  assertEquals(
    (await decide(qualifying(), [], fakeGh({ throwOn: "issue" }))).outcome,
    "held",
  );
});

Deno.test("hold reasons: fetch failures and missing links are named", async () => {
  assertEquals(
    (await decide(qualifying(), [], fakeGh({ refs: [] }))).autoReleaseReasons,
    ["no linked issue"],
  );
  assertEquals(
    (await decide(qualifying(), [], fakeGh({ throwOn: "pr" })))
      .autoReleaseReasons,
    ["linked issue fetch failed: boom"],
  );
  assertEquals(
    (await decide(qualifying(), [], fakeGh({ throwOn: "issue" })))
      .autoReleaseReasons,
    ["linked issue fetch failed: boom"],
  );
});

Deno.test("hold reasons: kind and fails-without are named", () => {
  const issues = [{ title: "T", body: CRITERION }];
  assertEquals(
    autoReleaseDecision(
      qualifying([note({ kind: "added-skip", failsWithoutChange: false })]),
      [],
      issues,
    ).reasons,
    [
      "`a_test.ts:7`: not a changed expected value",
      "`a_test.ts:7`: does not state the test fails without the change",
    ],
  );
});

Deno.test("hold kept for non-releasable kinds", async () => {
  for (
    const kind of [
      "removed-case",
      "added-skip",
      "weakened-assertion",
      "removed-file",
      "other",
      undefined,
    ] as const
  ) {
    const res = await decide(qualifying([note({ kind })]));
    assertEquals(res.outcome, "held", String(kind));
  }
});

Deno.test("hold kept when test files were removed", async () => {
  const res = await decide(qualifying(), ["gone_test.ts"]);
  assertEquals(res.outcome, "held");
});

Deno.test("failsWithoutChange: only a positive statement releases", () => {
  const issues = [{ title: "T", body: CRITERION }];
  const releases = (f: TestChangeNote["failsWithoutChange"]) =>
    autoReleaseDecision(
      qualifying([note({ failsWithoutChange: f })]),
      [],
      issues,
    ).release;
  assertFalse(releases(undefined));
  assertFalse(releases(false));
  assertFalse(releases(""));
  assertFalse(releases("No — passes without the change"));
  assertFalse(releases("unknown"));
  assertFalse(releases("no"));
  assertFalse(releases("No, it passes"));
  assertFalse(releases("false"));
  assert(releases("notably, it fails without the change"));
  assert(releases(true));
  assert(releases("Yes: fails on the base branch"));
});

Deno.test("findings on an opted-in repo are still changes_requested", async () => {
  const res = await decide(
    review({
      findings: [{ file: "a.ts", line: 1, problem: "bug" }],
      testChangeNotes: [note()],
    }),
  );
  assertEquals(res.outcome, "changes_requested");
  assertFalse(res.autoReleased);
});

Deno.test("config: isAutoReleaseRepo, autoReleaseRepos and loadAutoReleaseRepos", async () => {
  assert(isAutoReleaseRepo(["Acme/Widgets"], "acme/widgets"));
  assertFalse(isAutoReleaseRepo(["acme/other"], "acme/widgets"));
  assertEquals(autoReleaseRepos({}), []);
  assertEquals(autoReleaseRepos({ pr_reviewer_auto_release: null }), []);
  assertEquals(autoReleaseRepos({ pr_reviewer_auto_release: ["a/b"] }), [
    "a/b",
  ]);
  for (const bad of ["x", [1], ["noslash"]]) {
    assertThrows(
      () => autoReleaseRepos({ pr_reviewer_auto_release: bad }),
      Error,
      "pr_reviewer_auto_release",
    );
  }
  const dir = await Deno.makeTempDir();
  try {
    const f = `${dir}/config.json`;
    await Deno.writeTextFile(
      f,
      JSON.stringify({ pr_reviewer_auto_release: ["a/b"] }),
    );
    assertEquals(await loadAutoReleaseRepos(f), ["a/b"]);
    assertEquals(await loadAutoReleaseRepos(`${dir}/missing.json`), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("renderSummary marks an auto-released approval only", () => {
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
  const now = new Date("2026-09-27T12:00:00.000Z");
  const open = new Set(["o/r#1", "o/r#2"]);
  const marker = "(auto-released: issue-required test change)";
  assert(
    renderSummary([rec({ autoReleased: true })], open, now).includes(marker),
  );
  assertFalse(renderSummary([rec({ number: 2 })], open, now).includes(marker));
});

Deno.test("postedResult: autoReleased appears only when true", () => {
  assertEquals(
    (postedResult("approved", [], undefined, undefined, true) as Record<
      string,
      unknown
    >)
      .autoReleased,
    true,
  );
  assertFalse("autoReleased" in postedResult("approved", []));
});

Deno.test("postedResult: autoReleaseHeld appears only when given", () => {
  const held = postedResult("held", [], undefined, undefined, false, ["why"]);
  assertEquals((held as Record<string, unknown>).autoReleaseHeld, ["why"]);
  assertFalse("autoReleaseHeld" in postedResult("held", []));
});

Deno.test("decidePostOutcome: autoReleaseHeld only for an opted-in held PR", async () => {
  const held = await decide(qualifying([note({ criterionQuote: undefined })]));
  assertEquals(held.outcome, "held");
  assertEquals(held.autoReleaseHeld, ["`a_test.ts:7`: no criterion quote"]);

  const off = await decidePostOutcome(pr, qualifying(), [], [], fakeGh().run);
  assertEquals(off.outcome, "held");
  assertFalse("autoReleaseHeld" in off);

  const approved = await decide(qualifying());
  assertEquals(approved.outcome, "approved");
  assertFalse("autoReleaseHeld" in approved);
});

Deno.test("parseFableReview accepts new and old note shapes", () => {
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

Deno.test("autoReleaseDecision names each whole-review reason", () => {
  const issues = [{ title: "T", body: CRITERION }];
  assertEquals(
    autoReleaseDecision(
      review({
        findings: [{ file: "a.ts", line: 1, problem: "bug" }],
        testChangeNotes: [note()],
      }),
      [],
      issues,
    ),
    { release: false, reasons: ["review has findings"] },
  );
  assertEquals(
    autoReleaseDecision(
      review({ testChanges: "trivial", testChangeNotes: [note()] }),
      [],
      issues,
    ),
    { release: false, reasons: ["test changes are not meaningful"] },
  );
  assertEquals(
    autoReleaseDecision(review({ testChangeNotes: [] }), [], issues),
    { release: false, reasons: ["no test change notes"] },
  );
  for (const none of [undefined, []]) {
    assertEquals(autoReleaseDecision(qualifying(), [], none).reasons, [
      "no linked issue could be read",
      "`a_test.ts:7`: criterion quote not found in a linked issue",
    ]);
  }
});

Deno.test("loadAutoReleaseRepos rethrows a read error other than NotFound", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await assertRejects(() => loadAutoReleaseRepos(dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("opted-in repo with no hold: no release and gh is never called", async () => {
  const g = fakeGh();
  const r = review({ testChanges: "none", testChangeNotes: [] });
  assertEquals(await resolveAutoRelease(pr, r, [], repos, g.run), {
    release: false,
    reasons: ["no hold"],
  });
  assertEquals(g.calls, []);
  const res = await decide(r, [], g);
  assertEquals(res.outcome, "approved");
  assertFalse(res.autoReleased);
  assertEquals(res.autoReleaseHeld, undefined);
  assertEquals(g.calls, []);
});
