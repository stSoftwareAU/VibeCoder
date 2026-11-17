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

/** The helper heads of Issue #5065: a return type holding an object type literal. */
const OBJECT_RETURN_HELPERS: Array<
  { label: string; head: string; tail: string }
> = [
  {
    label: "async function, Promise of an object type",
    head: "async function run(flag: boolean): Promise<{ ok: boolean }> {",
    tail: "}",
  },
  {
    label: "async arrow, Promise of an object type",
    head: "const run = async (flag: boolean): Promise<{ ok: boolean }> => {",
    tail: "};",
  },
  {
    label: "sync function, object type",
    head: "function run(flag: boolean): { ok: boolean } {",
    tail: "}",
  },
  {
    label: "re-wrapped across lines",
    head: `async function run(
  flag: boolean,
): Promise<{
  publishedBase: boolean;
  lines: string[];
}> {`,
    tail: "}",
  },
];

/** A fixture: the helper with `inner` as its body, then a test that only calls it. */
function helperFixture(
  head: string,
  tail: string,
  inner: string,
): { diff: string; testLine: number } {
  const body = `${head}\n${inner}\n${tail}\n\n` +
    `Deno.test("x", async () => {\n  await run(true);\n});\n`;
  const testLine =
    body.split("\n").findIndex((l) => l.startsWith("Deno.test(")) +
    1;
  return { diff: added("tests/runner_test.ts", body), testLine };
}

Deno.test("a helper whose return type holds an object type literal is judged by its body (Issue #5065)", () => {
  const asserting = `  const out = await exec(flag);
  assertEquals(out.ok, !flag);
  return out;`;
  const shapes: Array<[string, string]> = OBJECT_RETURN_HELPERS.map((
    h,
  ) => [h.label, helperFixture(h.head, h.tail, asserting).diff]);
  shapes.push([
    "nested generic and union",
    added(
      "tests/runner_test.ts",
      `function run(flag: boolean): Promise<Array<{ ok: boolean }>> | { ok: false } {
  const out = exec(flag);
  assertEquals(out.ok, !flag);
  return out;
}

Deno.test("x", async () => {
  await run(true);
});
`,
    ),
  ]);
  shapes.push([
    "function type inside the generic",
    added(
      "tests/runner_test.ts",
      `async function run(flag: boolean): Promise<(x: number) => { ok: boolean }> {
  const out = await exec(flag);
  assertEquals(out.ok, !flag);
  return out;
}

Deno.test("x", async () => {
  await run(true);
});
`,
    ),
  ]);
  shapes.push([
    "arrow with an expression body",
    added(
      "tests/runner_test.ts",
      `const run = (flag: boolean): { ok: boolean } => assertResult(flag);

Deno.test("x", async () => {
  await run(true);
});
`,
    ),
  ]);
  for (const [label, diff] of shapes) assertEquals(rules(diff), [], label);
});

Deno.test("a helper with an object return type that asserts nothing is still refused (Issue #5065)", () => {
  const bare = `  const out = await exec(flag);
  return out;`;
  for (const h of OBJECT_RETURN_HELPERS) {
    const { diff, testLine } = helperFixture(h.head, h.tail, bare);
    assertEquals(rules(diff), [["no-assertion", testLine]], h.label);
  }
});

Deno.test("an unterminated return type is a note, not a hang or a finding (Issue #5065)", () => {
  const file = "tests/runner_test.ts";
  const diff = added(
    file,
    "function run(flag: boolean): " + "<".repeat(50_000) + "\n" +
      `Deno.test("x", () => {\n  run(true);\n});\n`,
  );
  const scan = scanDummyTests(diff);
  assertEquals(scan.findings, []);
  assertEquals(scan.notes, [{ file, line: 2, kind: "unseen" }]);

  const spaced = added(
    file,
    "const run = (flag: boolean) =>" + " ".repeat(50_000) + "{\n" +
      `  assertEquals(exec(flag), 1);\n};\n\n` +
      `Deno.test("x", () => {\n  run(true);\n});\n`,
  );
  assertEquals(rules(spaced), []);
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

// --- Registration callbacks (Issue #5215) ---

const REGISTER_HELPER =
  `function register(name: string, fn: () => Promise<void>): void {
  Deno.test({ name, fn });
}
`;

Deno.test("a registration helper's asserting callback is accepted (Issue #5215)", () => {
  const diff = added(
    "tests/register_test.ts",
    `import { assertEquals } from "@std/assert";
${REGISTER_HELPER}register("observable result", async () => {
  assertEquals(await Promise.resolve(42), 42);
});
`,
  );
  const scan = scanDummyTests(diff);
  assertEquals(scan.findings, []);
  assertEquals(scan.notes, []);
});

Deno.test("a helper with the issue's options shape and an asserting callback is accepted (Issue #5215)", () => {
  const diff = added(
    "tests/ordinary_test.ts",
    `function testAsOrdinaryUser(
  name: string,
  fn: () => Promise<void>,
  alsoIgnore = false,
): void {
  Deno.test({ name, ignore: IS_WORKER_ACCOUNT || alsoIgnore, fn });
}

testAsOrdinaryUser("real shape", async () => {
  assertEquals(await Promise.resolve(42), 42);
});
`,
  );
  const scan = scanDummyTests(diff);
  assertEquals(scan.findings, []);
  assertEquals(scan.notes, []);
});

Deno.test("a registration helper's dummy call is refused on its call line, not the helper's (Issue #5215)", () => {
  const diff = added(
    "tests/register_test.ts",
    `import { assertEquals } from "@std/assert";
${REGISTER_HELPER}register("observable result", async () => {
  assertEquals(await Promise.resolve(42), 42);
});
register("dummy", async () => {
  await Promise.resolve(42);
});
`,
  );
  assertEquals(rules(diff), [["no-assertion", 8]]);
});

Deno.test("a named callback defined in view and asserting is accepted (Issue #5215)", () => {
  const diff = added(
    "tests/named_test.ts",
    `import { assertEquals } from "@std/assert";
async function checks(): Promise<void> {
  assertEquals(await Promise.resolve(42), 42);
}
Deno.test("named", checks);
Deno.test({ name: "named opts", fn: checks });
${REGISTER_HELPER}register("by name", checks);
`,
  );
  const scan = scanDummyTests(diff);
  assertEquals(scan.findings, []);
  assertEquals(scan.notes, []);
});

Deno.test("a named callback defined in view that asserts nothing is refused on each registration (Issue #5215)", () => {
  const diff = added(
    "tests/idle_test.ts",
    `async function idle(): Promise<void> {
  await Promise.resolve(42);
}
Deno.test("named", idle);
Deno.test({ name: "opts", fn: idle });
`,
  );
  assertEquals(rules(diff), [["no-assertion", 4], ["no-assertion", 5]]);
});

Deno.test("a callback not defined in view is a note, not a finding (Issue #5215)", () => {
  const file = "tests/imported_test.ts";
  const diff = added(
    file,
    `import { imported } from "./elsewhere.ts";
Deno.test("imported", imported);
Deno.test({ name: "opts", fn: imported });
`,
  );
  const scan = scanDummyTests(diff);
  assertEquals(scan.findings, []);
  assertEquals(scan.notes, [
    { file, line: 2, kind: "unseen" },
    { file, line: 3, kind: "unseen" },
  ]);
});

Deno.test("a registration helper whose calls are not in view is a note on its Deno.test line (Issue #5215)", () => {
  const file = "tests/register_test.ts";
  const scan = scanDummyTests(added(file, REGISTER_HELPER));
  assertEquals(scan.findings, []);
  assertEquals(scan.notes, [{ file, line: 2, kind: "unseen" }]);
});

Deno.test("an inline options callback is judged as before (Issue #5215)", () => {
  const dummy = added(
    "tests/options_test.ts",
    `Deno.test({ name: "x", fn: async () => {
  await Promise.resolve(1);
} });
`,
  );
  assertEquals(rules(dummy), [["no-assertion", 1]]);
  const asserting = added(
    "tests/options_test.ts",
    `Deno.test({ name: "x", fn: async () => {
  assertEquals(1, 1);
} });
`,
  );
  assertEquals(rules(asserting), []);
});

Deno.test("a registration helper call nested in another call is judged (Issue #5215)", () => {
  const diff = added(
    "tests/register_test.ts",
    `import { assertEquals } from "@std/assert";
${REGISTER_HELPER}register("observable result", async () => {
  assertEquals(await Promise.resolve(42), 42);
});
void Promise.resolve(register("nested dummy", async () => {
  await Promise.resolve(1);
}));
`,
  );
  assertEquals(rules(diff), [["no-assertion", 8]]);
});

Deno.test("a helper call directly inside a call's parentheses is judged (Issue #5215)", () => {
  const diff = added(
    "tests/register_test.ts",
    `import { assertEquals } from "@std/assert";
${REGISTER_HELPER}register("observable result", async () => {
  assertEquals(await Promise.resolve(42), 42);
});
wrap(register("wrapped dummy", async () => {
  await Promise.resolve(1);
}));
`,
  );
  assertEquals(rules(diff), [["no-assertion", 8]]);
});

Deno.test("a helper call passing a named callback that asserts nothing is refused on the call line (Issue #5215)", () => {
  const diff = added(
    "tests/by_name_test.ts",
    `async function idle(): Promise<void> {
  await Promise.resolve(42);
}
${REGISTER_HELPER}register("by name", idle);
`,
  );
  assertEquals(rules(diff), [["no-assertion", 7]]);
});

Deno.test("registration patterns stay linear on long hostile runs (Issue #5215)", () => {
  const file = "tests/hostile_test.ts";

  // A helper name then a long whitespace run and no `(`: no call in view.
  const noCall = scanDummyTests(
    added(file, REGISTER_HELPER + "register" + " ".repeat(50_000) + "x;\n"),
  );
  assertEquals(noCall.findings, []);
  assertEquals(noCall.notes, [{ file, line: 2, kind: "unseen" }]);

  // An options `fn:` property with a long whitespace run before an undefined name.
  const fnRun = scanDummyTests(
    added(
      file,
      `Deno.test({ name: "n", fn:${" ".repeat(50_000)}missing });\n`,
    ),
  );
  assertEquals(fnRun.findings, []);
  assertEquals(fnRun.notes, [{ file, line: 1, kind: "unseen" }]);

  // A long identifier run that the parameter pattern rejects, then the callback.
  const longParam = added(
    file,
    `function register(${
      "p".repeat(50_000)
    }!, fn: () => Promise<void>): void {\n  Deno.test({ name: "n", fn });\n}\nregister("x", async () => {\n  await Promise.resolve(1);\n});\n`,
  );
  assertEquals(rules(longParam), [["no-assertion", 4]]);
});

Deno.test("a trailing value after an inline callback is not read as the callback (Issue #5215)", () => {
  const file = "tests/timeout_test.ts";
  const dummy = scanDummyTests(added(
    file,
    `const TIMEOUT = 5000;
it("x", async () => {
  await run();
}, TIMEOUT);
`,
  ));
  assertEquals(dummy.findings.map((f) => [f.rule, f.line]), [[
    "no-assertion",
    2,
  ]]);
  assertEquals(dummy.notes, []);

  const asserting = scanDummyTests(added(
    file,
    `const TIMEOUT = 5000;
it("x", async () => {
  expect(await run()).toBe(3);
}, TIMEOUT);
`,
  ));
  assertEquals(asserting.findings, []);
  assertEquals(asserting.notes, []);
});

Deno.test("a callback passed as a property path is a note, not a finding (Issue #5215)", () => {
  const file = "tests/suite_test.ts";
  for (
    const line of [
      `Deno.test("x", suite.check);`,
      `Deno.test({ name: "x", fn: suite.check });`,
    ]
  ) {
    const scan = scanDummyTests(
      added(file, `import { suite } from "./suite.ts";\n${line}\n`),
    );
    assertEquals(scan.findings, [], line);
    assertEquals(scan.notes, [{ file, line: 2, kind: "unseen" }], line);
  }

  const helper = scanDummyTests(added(
    file,
    `import { suite } from "./suite.ts";
${REGISTER_HELPER}register("a", suite.check);
`,
  ));
  assertEquals(helper.findings, []);
  assertEquals(helper.notes, [{ file, line: 5, kind: "unseen" }]);
});

Deno.test("a long parameter list around many registrations stays linear (Issue #5215)", () => {
  const file = "tests/many_test.ts";
  const params = Array.from({ length: 3000 }, (_, k) => `p${k}: number`);
  const regs = Array.from(
    { length: 3000 },
    () => "  Deno.test({ name, fn });",
  );
  const diff = added(
    file,
    `function register(name: string, ${params.join(", ")}, fn: () => void) {\n${
      regs.join("\n")
    }\n}\nregister("a", ${
      "0, ".repeat(3000)
    }() => {\n  assertEquals(run(), 2);\n});\n`,
  );
  const started = performance.now();
  const scan = scanDummyTests(diff);
  const took = performance.now() - started;
  assertEquals(scan.findings, []);
  assertEquals(scan.notes, []);
  assertEquals(took < 2000, true, `took ${took} ms`);
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
