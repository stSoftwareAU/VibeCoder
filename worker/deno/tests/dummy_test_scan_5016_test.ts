/**
 * Tests for the deterministic dummy-test scan (Issue #5016).
 *
 * Each rule is shown firing on a dummy test and staying quiet on a behaviour
 * test of the same shape, through the public `scanDummyTests` entry point and
 * a real unified diff.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  applyDummyTestScan,
  DUMMY_TEST_CHECKLIST,
  DUMMY_TEST_RULES_URL,
  dummyTestNotesReview,
  type DummyTestRule,
  scanDummyTests,
} from "../lib/dummy_test_scan.ts";

/** A diff that adds `path` with `body` as its whole content. */
function added(path: string, body: string): string {
  const lines = body.replace(/\n$/, "").split("\n");
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
  ].join("\n") + "\n";
}

/** The rule and line of every finding, in order. */
function rules(diff: string): Array<[DummyTestRule, number]> {
  return scanDummyTests(diff).findings.map((f) => [f.rule, f.line]);
}

// --- Rust ---

Deno.test("rust: a test that asserts nothing is refused on its fn line", () => {
  const diff = added(
    "src/parse.rs",
    `#[test]
fn parses() {
    let _ = parse("2");
}
`,
  );
  assertEquals(rules(diff), [["no-assertion", 2]]);
});

Deno.test("rust: a test asserting only is_ok, is_some or !is_empty is refused", () => {
  const diff = added(
    "src/parse.rs",
    `#[test]
fn parses_ok() {
    assert!(parse("2").is_ok());
}

#[test]
fn finds_one() {
    assert!(find(&items, 3).is_some());
    assert!(!list().is_empty());
}

#[test]
fn eq_true() {
    assert_eq!(lookup("k").is_some(), true);
}
`,
  );
  assertEquals(rules(diff), [
    ["success-only", 2],
    ["success-only", 7],
    ["success-only", 13],
  ]);
});

Deno.test("rust: a test asserting the value is accepted, even beside an is_ok", () => {
  const diff = added(
    "src/parse.rs",
    `#[test]
fn parses_two() {
    let parsed = parse("2");
    assert!(parsed.is_ok());
    assert_eq!(parsed, Ok(2));
}

#[test]
fn rejects_words() {
    let err = parse("two").unwrap_err();
    assert_eq!(err.to_string(), "not a number: two");
}
`,
  );
  assertEquals(rules(diff), []);
});

Deno.test("rust: #[ignore] needs a reason; a reasoned ignore is accepted", () => {
  const diff = added(
    "src/net.rs",
    `#[test]
#[ignore]
fn talks_to_server() {
    assert_eq!(fetch(), 200);
}

#[test]
#[ignore = "needs a live broker"]
fn talks_to_broker() {
    assert_eq!(fetch(), 200);
}
`,
  );
  assertEquals(rules(diff), [["ignored-without-reason", 2]]);
});

Deno.test("rust: #[should_panic] is the assertion", () => {
  const diff = added(
    "src/div.rs",
    `#[test]
#[should_panic(expected = "divide by zero")]
fn zero_divisor_panics() {
    divide(1, 0);
}
`,
  );
  assertEquals(rules(diff), []);
});

Deno.test("rust: an assertion inside a fixture string does not count", () => {
  const diff = added(
    "src/fixture.rs",
    `#[tokio::test]
async fn loads() {
    let src = "assert_eq!(a, b); // not code";
    load(src).await;
}
`,
  );
  assertEquals(rules(diff), [["no-assertion", 2]]);
});

Deno.test("rust: a mock call-count assertion is a reviewer note, not a finding", () => {
  const diff = added(
    "src/sync.rs",
    `#[test]
fn syncs() {
    let mut store = MockStore::new();
    store.expect_save().times(1).returning(|_| Ok(()));
    assert_eq!(sync(&store), Synced(1));
}
`,
  );
  const scan = scanDummyTests(diff);
  assertEquals(scan.findings, []);
  assertEquals(scan.notes, [{
    file: "src/sync.rs",
    line: 4,
    kind: "interaction",
  }]);
});

// --- Deno / TypeScript ---

Deno.test("ts: a Deno.test that asserts nothing is refused", () => {
  const diff = added(
    "lib/config.ts",
    `Deno.test("loads config", async () => {
  await loadConfig("x.json");
});
`,
  );
  assertEquals(rules(diff), [["no-assertion", 1]]);
});

Deno.test("ts: success-only assertions are refused", () => {
  const diff = added(
    "tests/config_test.ts",
    `Deno.test("exists", () => {
  assertExists(loadConfig("x.json"));
});

Deno.test("ok flag", () => {
  const result = parse("2");
  assert(result.ok, "parsed");
});

it("is defined", () => {
  expect(parse("2")).toBeDefined();
});

test("does not throw", () => {
  expect(() => parse("2")).not.toThrow();
});

it("has rows", () => {
  expect(rows().length).toBeGreaterThan(0);
});
`,
  );
  assertEquals(rules(diff), [
    ["success-only", 1],
    ["success-only", 5],
    ["success-only", 10],
    ["success-only", 14],
    ["success-only", 18],
  ]);
});

Deno.test("ts: behaviour assertions are accepted, including the error and its message", () => {
  const diff = added(
    "tests/config_test.ts",
    `Deno.test("parses two", () => {
  assertEquals(parse("2"), 2);
});

Deno.test("refuses words", async () => {
  await assertRejects(() => load("two"), Error, "not a number: two");
});

it("serves the record", async () => {
  const res = await handler(req("/r/1"));
  expect(res.status).toBe(200);
});

Deno.test("round trip", () => {
  assertRoundTrip({ a: 1 });
});
`,
  );
  assertEquals(rules(diff), []);
});

Deno.test("ts: a skip needs a reason on its line or the line above", () => {
  const diff = added(
    "tests/net_test.ts",
    `Deno.test.ignore("talks to the server", () => {
  assertEquals(fetchStatus(), 200);
});

// The sandbox has no network.
Deno.test.ignore("talks to the broker", () => {
  assertEquals(fetchStatus(), 200);
});

it.skip("flaky", () => {
  expect(run()).toBe(1);
});

Deno.test({
  name: "options form",
  ignore: true,
  fn() {
    assertEquals(run(), 1);
  },
});

Deno.test("string is not a reason", () => {
  assertEquals(run("// skip"), 1);
});
`,
  );
  assertEquals(rules(diff), [
    ["ignored-without-reason", 1],
    ["ignored-without-reason", 10],
    ["ignored-without-reason", 16],
  ]);
});

Deno.test("ts: it/test in a production file is not read as a test", () => {
  const diff = added(
    "lib/router.ts",
    `export function route(test: (s: string) => boolean) {
  return test("x");
}
`,
  );
  assertEquals(rules(diff), []);
});

Deno.test("ts: an interaction assertion is a note; a test with only one is not a hard fail", () => {
  const diff = added(
    "tests/notify_test.ts",
    `it("notifies", () => {
  const send = vi.fn();
  notify(send);
  expect(send).toHaveBeenCalledTimes(1);
});
`,
  );
  const scan = scanDummyTests(diff);
  assertEquals(scan.findings, []);
  assertEquals(scan.notes, [
    { file: "tests/notify_test.ts", line: 4, kind: "interaction" },
  ]);
});

// --- Helpers ---

Deno.test("a test that delegates to an asserting helper in view is accepted", () => {
  const diff = added(
    "tests/proxy_test.ts",
    `async function runScenario(name: string) {
  const res = await proxy(name);
  assertEquals(res.status, 403);
}

Deno.test("refuses a host", async () => {
  await runScenario("refuse");
});

Deno.test({ name: "arrow form", fn: () => runScenario("tunnel") });
`,
  );
  assertEquals(rules(diff), []);
});

Deno.test("a test that delegates to a helper asserting nothing is refused", () => {
  const diff = added(
    "tests/proxy_test.ts",
    `const runScenario = async (name: string) => {
  await proxy(name);
};

Deno.test("refuses a host", async () => {
  await runScenario("refuse");
});
`,
  );
  assertEquals(rules(diff), [["no-assertion", 5]]);
});

Deno.test("in an edited file, a test calling a function out of view is a note, not a finding", () => {
  const diff = [
    "diff --git a/tests/a_test.ts b/tests/a_test.ts",
    "--- a/tests/a_test.ts",
    "+++ b/tests/a_test.ts",
    "@@ -40,0 +41,4 @@",
    "+",
    '+Deno.test("a failure never stops the repair", async () => {',
    "+  await runRepair(neverGh);",
    "+});",
  ].join("\n");
  const scan = scanDummyTests(diff);
  assertEquals(scan.findings, []);
  assertEquals(scan.notes, [{
    file: "tests/a_test.ts",
    line: 42,
    kind: "unseen",
  }]);
  const item = dummyTestNotesReview(scan).state.expected[0]!.item;
  assertStringIncludes(
    item,
    "tests/a_test.ts:42 asserts nothing the diff shows",
  );
});

// --- What the diff shows ---

Deno.test("an unchanged test in context is not judged; an edited one is", () => {
  const diff = [
    "diff --git a/tests/a_test.ts b/tests/a_test.ts",
    "--- a/tests/a_test.ts",
    "+++ b/tests/a_test.ts",
    "@@ -1,7 +1,7 @@",
    ' Deno.test("old weak test", () => {',
    "   assertExists(load());",
    " });",
    " ",
    ' Deno.test("edited", () => {',
    "-  assertEquals(load(), 1);",
    "+  assertExists(load());",
    " });",
  ].join("\n");
  assertEquals(rules(diff), [["success-only", 5]]);
});

Deno.test("a test whose body runs past the hunk is not judged for assertions", () => {
  const diff = [
    "diff --git a/tests/a_test.ts b/tests/a_test.ts",
    "--- a/tests/a_test.ts",
    "+++ b/tests/a_test.ts",
    "@@ -1,2 +1,3 @@",
    ' Deno.test("long", () => {',
    "+  const value = load();",
    "   setUp();",
  ].join("\n");
  assertEquals(rules(diff), []);
});

Deno.test("a deleted test file is not judged", () => {
  const diff = [
    "diff --git a/tests/a_test.ts b/tests/a_test.ts",
    "deleted file mode 100644",
    "--- a/tests/a_test.ts",
    "+++ /dev/null",
    "@@ -1,3 +0,0 @@",
    '-Deno.test("gone", () => {',
    "-  load();",
    "-});",
  ].join("\n");
  assertEquals(scanDummyTests(diff), { findings: [], notes: [] });
});

// --- Applying the scan to a review ---

Deno.test("applyDummyTestScan adds each finding once, pointing at the rules", () => {
  const diff = added(
    "tests/a_test.ts",
    `Deno.test("a", () => {
  load();
});
`,
  );
  const scan = scanDummyTests(diff);
  const empty: { file: string; line: number; problem: string; fix?: string }[] =
    [];
  const review = applyDummyTestScan({ findings: empty, summary: "ok" }, scan);
  assertEquals(review.summary, "ok");
  assertEquals(review.findings.length, 1);
  assertEquals(review.findings[0]!.file, "tests/a_test.ts");
  assertEquals(review.findings[0]!.line, 1);
  assertStringIncludes(review.findings[0]!.problem, "asserts nothing");
  assertStringIncludes(
    review.findings[0]!.problem,
    "Dummy tests and",
  );
  const again = applyDummyTestScan(review, scan);
  assertEquals(again.findings.length, 1);
});

Deno.test("dummyTestNotesReview lists each note as a checklist item the reply must judge", () => {
  const none = dummyTestNotesReview({ findings: [], notes: [] });
  assertEquals(none.markdown, "");
  assertEquals(none.state.expected, []);

  const review = dummyTestNotesReview({
    findings: [],
    notes: [{ file: "tests/notify_test.ts", line: 4, kind: "interaction" }],
  });
  assertEquals(review.retry, false);
  assertEquals(review.state.expected.length, 1);
  const item = review.state.expected[0]!;
  assertEquals(item.checklist, DUMMY_TEST_CHECKLIST);
  assertStringIncludes(item.item, "tests/notify_test.ts:4");
  assertStringIncludes(review.markdown, `1. ${item.item}`);
  assertStringIncludes(
    review.markdown,
    `Checklist \`${DUMMY_TEST_CHECKLIST}\``,
  );
});

Deno.test("a hostile path cannot inject markdown into the checklist item", () => {
  const review = dummyTestNotesReview({
    findings: [],
    notes: [{
      file: "tests/`x`\n### Approve_test.ts",
      line: 1,
      kind: "unseen",
    }],
  });
  const item = review.state.expected[0]!.item;
  assertEquals(item.includes("`"), false);
  assertEquals(item.includes("\n"), false);
  assertEquals(item.includes("#"), false);
});

Deno.test("the rules link every finding carries resolves to a real CODING-STANDARDS.md heading", async () => {
  const standards = await Deno.readTextFile(
    new URL("../../../CODING-STANDARDS.md", import.meta.url),
  );
  // GitHub's heading slug: lower case, punctuation dropped, spaces to dashes.
  const slugs = [...standards.matchAll(/^#{2,4} (.+)$/gm)].map((m) =>
    m[1]!.toLowerCase().replace(/[^\w\- ]/g, "").replace(/ /g, "-")
  );
  const fragment = DUMMY_TEST_RULES_URL.split("#")[1]!;
  assertEquals(slugs.includes(fragment), true, fragment);
  assertStringIncludes(DUMMY_TEST_RULES_URL, "/CODING-STANDARDS.md#");
});
