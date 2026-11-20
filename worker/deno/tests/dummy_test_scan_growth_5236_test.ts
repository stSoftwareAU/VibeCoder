/**
 * Growth guards for the dummy-test scan (Issue #5236).
 *
 * The scan must cost time proportional to the diff for (1) one helper with
 * many assertion lines called by many one-line tests, and (2) many inline
 * `test(...)` registrations nested around one assertion. Output is also
 * pinned so the cheaper reading cannot change a verdict.
 *
 * Australian English throughout.
 */

import { assertEquals } from "@std/assert";
import { assertLinearGrowth } from "./support/growth.ts";
import { added } from "./support/new_file_diff.ts";
import {
  MAX_DUMMY_TEST_FINDINGS,
  scanDummyTests,
} from "../lib/dummy_test_scan.ts";

for (const kind of ["strong", "weak"] as const) {
  Deno.test(`a helper many tests call is read once per scan: ${kind}`, () => {
    const build = (chars: number): string => {
      const n = Math.max(1, Math.floor(chars / 70));
      const asserts = Array.from(
        { length: n },
        (_, k) =>
          kind === "strong"
            ? `  assertEquals(x, ${k});`
            : `  assertExists(x${k});`,
      );
      const tests = Array.from(
        { length: n },
        (_, k) => `Deno.test("t${k}", () => { probe(${k}); });`,
      );
      const source = `function probe(x: number) {\n${asserts.join("\n")}\n}\n` +
        tests.join("\n") + "\n";
      return added("tests/helper_test.ts", source);
    };
    const scan = assertLinearGrowth(
      "helper called by every test",
      build,
      scanDummyTests,
      { baseChars: 40000, repeats: 1 },
    );
    assertEquals(scan.notes, []);
    if (kind === "strong") {
      assertEquals(scan.findings, []);
    } else {
      assertEquals(scan.findings.length, MAX_DUMMY_TEST_FINDINGS);
      assertEquals(
        new Set(scan.findings.map((f) => f.rule)),
        new Set(["success-only"]),
      );
    }
  });
}

for (
  const inner of ["assertEquals(f(), 1);", "assert(ok);", "const v = 1;"]
) {
  Deno.test(`nested registrations are read once each: ${inner}`, () => {
    const build = (chars: number): string => {
      const n = Math.max(1, Math.floor(chars / 24));
      const open = Array.from({ length: n }, (_, k) => `test("t${k}", () => {`);
      const close = Array.from({ length: n }, () => `});`);
      const source = open.join("\n") + `\n  ${inner}\n` + close.join("\n") +
        "\n";
      return added("tests/nested_test.ts", source);
    };
    const scan = assertLinearGrowth(
      "nested registrations",
      build,
      scanDummyTests,
      { baseChars: 30000, repeats: 1 },
    );
    assertEquals(scan.notes, []);
    if (inner.startsWith("assertEquals")) {
      assertEquals(scan.findings, []);
    } else {
      assertEquals(scan.findings.length, MAX_DUMMY_TEST_FINDINGS);
      assertEquals(scan.findings[0]!.line, 1);
      assertEquals(
        new Set(scan.findings.map((f) => f.rule)),
        new Set([inner === "assert(ok);" ? "success-only" : "no-assertion"]),
      );
    }
  });
}

Deno.test("an inline body's calls are read where the registration's own paren meets a call", () => {
  const diff = [
    "diff --git a/tests/a_test.ts b/tests/a_test.ts",
    "--- a/tests/a_test.ts",
    "+++ b/tests/a_test.ts",
    "@@ -40,0 +41,3 @@",
    "+test(label(1), () => {",
    "+  const v = 1;",
    "+});",
  ].join("\n");
  const scan = scanDummyTests(diff);
  assertEquals(scan.findings, []);
  assertEquals(scan.notes, [
    { file: "tests/a_test.ts", line: 41, kind: "unseen" },
  ]);
  const control = scanDummyTests(diff.replace("test(label(1)", 'test("a"'));
  assertEquals(control.findings.map((f) => [f.rule, f.line]), [
    ["no-assertion", 41],
  ]);
  assertEquals(control.notes, []);
});

Deno.test("a call nested directly inside another call's arguments is not read as a call", () => {
  const body = (first: string) =>
    added(
      "tests/a_test.ts",
      [first, "test(g(f()), () => {", "  const v = 1;", "});"].join("\n"),
    );
  const quiet = scanDummyTests(
    body('function g(x: number) { assertEquals(x, 1); return "n"; }'),
  );
  assertEquals(quiet.findings, []);
  assertEquals(quiet.notes, []);
  const loud = scanDummyTests(
    body("function f() { assertEquals(2, 1); return 1; }"),
  );
  assertEquals(loud.findings.map((f) => [f.rule, f.line]), [
    ["no-assertion", 2],
  ]);
});

Deno.test("ignore and interaction markers are read through nested bodies", () => {
  const scan = scanDummyTests(added(
    "tests/n_test.ts",
    [
      'test("outer", () => {',
      '  test("inner", { ignore: true, fn: () => {} });',
      "  expect(spy).toHaveBeenCalled();",
      '  test("deep", () => {',
      "    assertEquals(f(), 1);",
      "  });",
      "});",
    ].join("\n"),
  ));
  assertEquals(
    scan.findings.map((f) => [f.rule, f.line]),
    [["ignored-without-reason", 2], ["no-assertion", 2]],
  );
  assertEquals(scan.notes, [
    { file: "tests/n_test.ts", line: 3, kind: "interaction" },
  ]);
});
