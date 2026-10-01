/**
 * The review log and summary of the review-fleet-prs skill (Issue #2678).
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  decideOutcome,
  type FableReview,
  type LogRecord,
  parseFableReview,
  parseLog,
  previousFindings,
  renderSummary,
  REVIEW_MARKER,
  reviewBody,
  sameIssueTitle,
  unrelatedIssueBody,
} from "../../../.claude/skills/review-fleet-prs/review_log.ts";

const review = (over: Partial<FableReview> = {}): FableReview => ({
  summary: "Looks right.",
  findings: [],
  testChanges: "none",
  testChangeNotes: [],
  unrelatedIssues: [],
  ...over,
});
const finding = { file: "a.ts", line: 3, problem: "off by one", fix: "use <=" };

Deno.test("parseFableReview accepts the reply JSON, even wrapped in prose, and rejects anything else", () => {
  const r = parseFableReview(
    'Here you go:\n{"summary":"ok","findings":[],"testChanges":"trivial"}',
  );
  assertEquals(r.testChanges, "trivial");
  assertEquals(r.testChangeNotes, []);
  assertThrows(() => parseFableReview("no json"));
  assertThrows(() => parseFableReview('{"summary":"ok"}'));
  assertThrows(() =>
    parseFableReview('{"summary":"ok","findings":[],"testChanges":"maybe"}')
  );
});

Deno.test("decideOutcome: findings send it back, meaningful or removed tests hold it, else approve", () => {
  assertEquals(decideOutcome(review(), []), "approved");
  assertEquals(
    decideOutcome(review({ testChanges: "trivial" }), []),
    "approved",
  );
  assertEquals(
    decideOutcome(review({ testChanges: "meaningful" }), []),
    "held",
  );
  assertEquals(
    decideOutcome(review({ testChanges: "tightened" }), []),
    "approved",
  );
  assertEquals(decideOutcome(review(), ["tests/x_test.ts"]), "held");
  assertEquals(
    decideOutcome(
      review({ findings: [finding], testChanges: "meaningful" }),
      [],
    ),
    "changes_requested",
  );
});

Deno.test("reviewBody: every body ends with the marker; change requests list each finding and its fix", () => {
  const sentBack = reviewBody(
    "changes_requested",
    review({ findings: [finding] }),
    [],
  );
  assert(sentBack.includes("`a.ts:3`"));
  assert(sentBack.includes("use <="));
  assert(sentBack.trimEnd().endsWith(`_${REVIEW_MARKER}._`));

  const held = reviewBody(
    "held",
    review({
      testChanges: "meaningful",
      testChangeNotes: [{ file: "t.ts", line: 9, change: "expected 2 now 3" }],
    }),
    ["tests/gone_test.ts"],
  );
  assert(held.startsWith("Held for owner review"));
  assert(held.includes("tests/gone_test.ts"));
  assert(held.includes("expected 2 now 3"));
  assert(reviewBody("approved", review(), []).includes(REVIEW_MARKER));
});

const unrelated = {
  title: "Search page renders the query unescaped",
  file: "web/search.ts",
  line: 12,
  body: "Cross-site scripting (class only): the query is echoed into HTML.",
};

Deno.test("parseFableReview: unrelatedIssues default to none, malformed ones are dropped, at most 3 are kept", () => {
  assertEquals(
    parseFableReview('{"summary":"ok","findings":[],"testChanges":"none"}')
      .unrelatedIssues,
    [],
  );
  const r = parseFableReview(JSON.stringify({
    summary: "ok",
    findings: [],
    testChanges: "none",
    unrelatedIssues: [
      unrelated,
      { title: "", body: "no title" },
      { title: "no body" },
      "not an object",
      { ...unrelated, title: "two" },
      { ...unrelated, title: "three" },
      { ...unrelated, title: "four" },
    ],
  }));
  assertEquals(r.unrelatedIssues.map((i) => i.title), [
    unrelated.title,
    "two",
    "three",
  ]);
});

Deno.test("decideOutcome: an unrelated issue never blocks or holds the PR", () => {
  assertEquals(
    decideOutcome(review({ unrelatedIssues: [unrelated] }), []),
    "approved",
  );
});

Deno.test("reviewBody lists the issues filed for problems outside the PR's scope", () => {
  const body = reviewBody(
    "approved",
    review({ unrelatedIssues: [unrelated] }),
    [],
    [
      {
        number: 42,
        url: "https://github.com/o/r/issues/42",
        title: unrelated.title,
      },
    ],
  );
  assert(body.includes("outside this PR's scope"));
  assert(body.includes("#42"));
  assert(body.trimEnd().endsWith(`_${REVIEW_MARKER}._`));
  assert(
    !reviewBody("approved", review(), []).includes("outside this PR's scope"),
  );
});

Deno.test("unrelatedIssueBody names the location and the PR it was found in", () => {
  const body = unrelatedIssueBody(unrelated, {
    repo: "o/r",
    number: 7,
    url: "https://github.com/o/r/pull/7",
  });
  assert(body.includes("`web/search.ts:12`"));
  assert(
    body.split("\n").some((l) =>
      l ===
        "Found while reviewing https://github.com/o/r/pull/7, but outside that PR's scope."
    ),
  );
  assert(body.includes(unrelated.body));
  assert(body.includes(REVIEW_MARKER));
});

Deno.test("sameIssueTitle ignores case, spacing and trailing punctuation only", () => {
  assert(
    sameIssueTitle("Search page renders XSS.", " search  page renders xss"),
  );
  assert(
    !sameIssueTitle("Search page renders XSS", "Search page renders XSS twice"),
  );
});

const record = (over: Partial<LogRecord>): LogRecord => ({
  at: "2026-09-27T10:00:00.000Z",
  repo: "o/r",
  number: 1,
  title: "Fix it",
  url: "https://github.com/o/r/pull/1",
  headSha: "a",
  outcome: "approved",
  summary: "fine",
  findings: [],
  testChangeNotes: [],
  removedTests: [],
  ...over,
});

Deno.test("previousFindings: only when the PR's latest review sent it back", () => {
  const sentBack = record({
    outcome: "changes_requested",
    findings: [finding],
  });
  assertEquals(previousFindings([sentBack], "o/r", 1), [finding]);
  assertEquals(
    previousFindings(
      [sentBack, record({ at: "2026-09-27T11:00:00.000Z" })],
      "o/r",
      1,
    ),
    [],
  );
  assertEquals(previousFindings([sentBack], "o/r", 2), []);
});

Deno.test("parseLog skips a torn last line", () => {
  const good = JSON.stringify(record({}));
  assertEquals(parseLog(`${good}\n{"at":"2026`).length, 1);
});

Deno.test("renderSummary: held and sent-back PRs show while open; a fix that was approved moves to approved", () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const records = [
    record({ number: 1, outcome: "held", summary: "changes a test" }),
    record({ number: 2, outcome: "changes_requested", findings: [finding] }),
    record({ number: 3, outcome: "changes_requested", findings: [finding] }),
    record({
      number: 3,
      at: "2026-09-27T11:00:00.000Z",
      outcome: "approved",
      summary: "fixed",
    }),
    record({ number: 4, outcome: "held" }), // closed since
    record({ number: 5, at: "2026-09-01T00:00:00.000Z" }), // too old
  ];
  const open = new Set(["o/r#1", "o/r#2", "o/r#3"]);
  const md = renderSummary(records, open, now);
  const section = (title: string) =>
    md.split("## ").find((s) => s.startsWith(title)) ?? "";

  assert(section("Waiting for you (1)").includes("o/r#1"));
  assert(section("Sent back to the fleet (1)").includes("o/r#2"));
  assert(section("Sent back to the fleet").includes("off by one"));
  assert(section("Approved, last 7 days (1)").includes("o/r#3"));
  assert(!md.includes("o/r#4]"));
  assert(!md.includes("o/r#5]"));
  assert(md.includes("Last 24 h: 1 approved, 2 sent back, 2 held for you."));
});
