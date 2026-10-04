/**
 * Removed-assertion gate: guards, skips and multi-line assertions (PR #3148
 * review, Issue #3131).
 *
 * The gate used to read the patch with `--unified=0` and count a removed
 * assertion as "moved" whenever the same text was re-added anywhere. So an
 * assertion re-added under a new `if false { … }`, behind
 * `if rows.len() > 1 { … }`, under Python `if False:` or into a Jest
 * `it.skip(` passed as moved, and an edit to an inner line of a wrapped
 * `assert!(` was never seen. Each test here builds a real git repository,
 * reads the patch with the gate's own `removedAssertionDiffArgs` (whole-file
 * context) and runs the real `findRemovedAssertions` /
 * `validateRemovedAssertions` over it — the evasion table both ways.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  findRemovedAssertions,
  type RemovedAssertion,
  removedAssertionDiffArgs,
  validateRemovedAssertions,
} from "../lib/removed_assertion_gate.ts";
import { assertLinearGrowth } from "./support/growth.ts";

/** A file's content on `main` and on the feature branch (`null` = absent). */
type FileVersions = Record<string, [string | null, string | null]>;

/**
 * Commit `before` on `main` and `after` on `feature` in a scratch repo, and
 * return the patch the gate reads (`removedAssertionDiffArgs`).
 */
async function gatePatch(files: FileVersions): Promise<string> {
  const dir = await Deno.makeTempDir();
  const run = async (args: string[]) => {
    const out = await new Deno.Command("git", {
      args: [
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=Test",
        ...args,
      ],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (out.code !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed: ${new TextDecoder().decode(out.stderr)}`,
      );
    }
    return new TextDecoder().decode(out.stdout);
  };
  const write = async (versionIndex: 0 | 1) => {
    for (const [path, versions] of Object.entries(files)) {
      const content = versions[versionIndex];
      const full = `${dir}/${path}`;
      if (content === null) {
        await Deno.remove(full).catch(() => {});
        continue;
      }
      await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.writeTextFile(full, content);
    }
  };
  try {
    await run(["init", "-q", "-b", "main"]);
    await write(0);
    await run(["add", "-A"]);
    await run(["commit", "-q", "--allow-empty", "-m", "base"]);
    await run(["checkout", "-q", "-b", "feature"]);
    await write(1);
    await run(["add", "-A"]);
    await run(["commit", "-q", "--allow-empty", "-m", "change"]);
    return await run(removedAssertionDiffArgs("main"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** The removed assertions' display texts. */
const texts = (removed: RemovedAssertion[]) => removed.map((a) => a.text);

/** Lines joined with a trailing newline. */
const src = (...lines: string[]) => lines.join("\n") + "\n";

// --- The reviewer's four guard / skip cases ---------------------------------

const RUST_BEFORE = src(
  "#[test]",
  "fn rows_cover_bbb() {",
  "    let rows = load();",
  '    assert_eq!(rows[0].name, "BBB");',
  "}",
);

Deno.test("guard: a Rust assertion re-added inside a multi-line `if false { }` is removed, not moved", async () => {
  const patch = await gatePatch({
    "tests/rows_test.rs": [
      RUST_BEFORE,
      src(
        "#[test]",
        "fn rows_cover_bbb() {",
        "    let rows = load();",
        "    if false {",
        '        assert_eq!(rows[0].name, "BBB");',
        "    }",
        "}",
      ),
    ],
  });
  assertEquals(texts(findRemovedAssertions(patch)), [
    'assert_eq!(rows[0].name, "BBB");',
  ]);
  const result = validateRemovedAssertions({
    changedFiles: ["tests/rows_test.rs"],
    testDiff: patch,
    prSummaryContent: "## Test Plan\n\n- edited a test\n",
  });
  assertFalse(result.valid);
});

Deno.test("guard: a Rust assertion moved behind `if rows.len() > 1 { }` is removed, not moved", async () => {
  const patch = await gatePatch({
    "tests/rows_test.rs": [
      RUST_BEFORE,
      src(
        "#[test]",
        "fn rows_cover_bbb() {",
        "    let rows = load();",
        "    if rows.len() > 1 {",
        '        assert_eq!(rows[0].name, "BBB");',
        "    }",
        "}",
      ),
    ],
  });
  assertEquals(texts(findRemovedAssertions(patch)), [
    'assert_eq!(rows[0].name, "BBB");',
  ]);
});

Deno.test("guard: a Python assertion re-added under `if False:` is removed, not moved", async () => {
  const patch = await gatePatch({
    "tests/test_total.py": [
      src(
        "def test_total():",
        "    total = compute()",
        "    assert total == 5",
      ),
      src(
        "def test_total():",
        "    total = compute()",
        "    if False:",
        "        assert total == 5",
      ),
    ],
  });
  assertEquals(texts(findRemovedAssertions(patch)), ["assert total == 5"]);
});

Deno.test("skip: a Jest assertion moved into a new `it.skip(` is removed, not moved", async () => {
  const patch = await gatePatch({
    "src/widget.test.ts": [
      src(
        'it("adds", () => {',
        "  const a = add(0, 1);",
        "  expect(a).toBe(1);",
        "});",
      ),
      src(
        'it("adds", () => {',
        "  const a = add(0, 1);",
        "});",
        "",
        'it.skip("adds one", () => {',
        "  const a = add(0, 1);",
        "  expect(a).toBe(1);",
        "});",
      ),
    ],
  });
  assertEquals(texts(findRemovedAssertions(patch)), ["expect(a).toBe(1);"]);
});

// --- Further guards, skips and exits (closing the class) --------------------

Deno.test("guard: an unindented brace guard is still seen (brace stack, not just indentation)", async () => {
  const patch = await gatePatch({
    "worker/deno/tests/foo_test.ts": [
      src('Deno.test("x", () => {', "assertEquals(a, b);", "});"),
      src(
        'Deno.test("x", () => {',
        "if (false) {",
        "assertEquals(a, b);",
        "}",
        "});",
      ),
    ],
  });
  assertEquals(texts(findRemovedAssertions(patch)), ["assertEquals(a, b);"]);
});

Deno.test("guard: an assertion moved into a `.forEach(` callback is removed, not moved", async () => {
  const patch = await gatePatch({
    "worker/deno/tests/foo_test.ts": [
      src('Deno.test("x", () => {', "  assertEquals(rows.length, 2);", "});"),
      src(
        'Deno.test("x", () => {',
        "  rows.forEach(() => {",
        "    assertEquals(rows.length, 2);",
        "  });",
        "});",
      ),
    ],
  });
  assertEquals(texts(findRemovedAssertions(patch)), [
    "assertEquals(rows.length, 2);",
  ]);
});

Deno.test("skip: an assertion moved into a new `#[ignore]` Rust test is removed, not moved", async () => {
  const patch = await gatePatch({
    "tests/rows_test.rs": [
      RUST_BEFORE,
      src(
        "#[test]",
        "fn rows_cover_bbb() {",
        "    let rows = load();",
        "}",
        "",
        "#[test]",
        "#[ignore]",
        "fn rows_cover_bbb_later() {",
        "    let rows = load();",
        '    assert_eq!(rows[0].name, "BBB");',
        "}",
      ),
    ],
  });
  assertEquals(texts(findRemovedAssertions(patch)), [
    'assert_eq!(rows[0].name, "BBB");',
  ]);
});

Deno.test("skip: an assertion moved under `@pytest.mark.skip` is removed, not moved", async () => {
  const patch = await gatePatch({
    "tests/test_total.py": [
      src("def test_total():", "    assert total() == 5"),
      src(
        "def test_total():",
        "    pass",
        "",
        "",
        '@pytest.mark.skip(reason="later")',
        "def test_total_later():",
        "    assert total() == 5",
      ),
    ],
  });
  assertEquals(texts(findRemovedAssertions(patch)), ["assert total() == 5"]);
});

Deno.test("skip: an assertion under a Deno.test object that gains `ignore: true` is removed", async () => {
  const patch = await gatePatch({
    "worker/deno/tests/foo_test.ts": [
      src(
        "Deno.test({",
        '  name: "x",',
        "  fn() {",
        "    assertEquals(a, b);",
        "  },",
        "});",
      ),
      src(
        "Deno.test({",
        '  name: "x",',
        "  ignore: true,",
        "  fn() {",
        "    assertEquals(a, b);",
        "  },",
        "});",
      ),
    ],
  });
  assertEquals(texts(findRemovedAssertions(patch)), ["assertEquals(a, b);"]);
});

Deno.test("exit: an early `return` added above an unchanged assertion makes it removed", async () => {
  const patch = await gatePatch({
    "worker/deno/tests/foo_test.ts": [
      src(
        'Deno.test("x", () => {',
        "  const ready = setUp();",
        "  assertEquals(ready.code, 0);",
        "});",
      ),
      src(
        'Deno.test("x", () => {',
        "  const ready = setUp();",
        "  if (!ready.ok) return;",
        "  assertEquals(ready.code, 0);",
        "});",
      ),
    ],
  });
  assertEquals(texts(findRemovedAssertions(patch)), [
    "assertEquals(ready.code, 0);",
  ]);
});

Deno.test("comment: an assertion moved inside a block comment is removed, not moved", async () => {
  const patch = await gatePatch({
    "worker/deno/tests/foo_test.ts": [
      src('Deno.test("x", () => {', "  assertEquals(a, b);", "});"),
      src(
        'Deno.test("x", () => {',
        "  /*",
        "  assertEquals(a, b);",
        "  */",
        "});",
      ),
    ],
  });
  assertEquals(texts(findRemovedAssertions(patch)), ["assertEquals(a, b);"]);
});

Deno.test("count: deleting one of two identical assertions is removed (one copy cannot vouch for two)", async () => {
  const patch = await gatePatch({
    "worker/deno/tests/foo_test.ts": [
      src(
        'Deno.test("x", () => {',
        "  assertEquals(next(), 1);",
        "  assertEquals(next(), 1);",
        "});",
      ),
      src('Deno.test("x", () => {', "  assertEquals(next(), 1);", "});"),
    ],
  });
  assertEquals(texts(findRemovedAssertions(patch)), [
    "assertEquals(next(), 1);",
  ]);
});

Deno.test("dead code: an assertion moved into a helper function that is not a test is removed", async () => {
  const patch = await gatePatch({
    "worker/deno/tests/foo_test.ts": [
      src('Deno.test("x", () => {', "  assertEquals(total(), 5);", "});"),
      src(
        'Deno.test("x", () => {',
        "  run();",
        "});",
        "",
        "function neverCalled() {",
        "  assertEquals(total(), 5);",
        "}",
      ),
    ],
  });
  assertEquals(texts(findRemovedAssertions(patch)), [
    "assertEquals(total(), 5);",
  ]);
});

Deno.test("no flag: an assertion moved between Rust `#[tokio::test]` and Python `test_` functions' peers counts as moved", async () => {
  const patch = await gatePatch({
    "tests/async_test.rs": [
      src(
        "#[tokio::test]",
        "async fn first() {",
        "    assert!(ready().await);",
        "}",
      ),
      src(
        "#[tokio::test]",
        "async fn first() {",
        "}",
        "",
        "#[tokio::test]",
        "async fn second() {",
        "    assert!(ready().await);",
        "}",
      ),
    ],
    "tests/test_total.py": [
      src("def test_a():", "    assert total() == 5"),
      src(
        "def test_a():",
        "    pass",
        "",
        "",
        "def test_b():",
        "    assert total() == 5",
      ),
    ],
  });
  assertEquals(findRemovedAssertions(patch), []);
});

// --- Multi-line assertions: an inner-line edit is seen ----------------------

Deno.test("multi-line: a Rust `assert!(` whose inner `.any(` predicate loses a condition is removed", async () => {
  const before = src(
    "#[test]",
    "fn every_day_has_a_bbb_row() {",
    "    for day in days() {",
    "        assert!(",
    '            report["decisions"]',
    "                .as_array()",
    "                .unwrap()",
    "                .iter()",
    '                .any(|row| row["symbol"] == "BBB" && row["trading_date"] == day.as_str()),',
    '            "no row for {day}: {report}"',
    "        );",
    "    }",
    "}",
  );
  const after = before.replace('row["symbol"] == "BBB" && ', "");
  const patch = await gatePatch({ "tests/report_test.rs": [before, after] });

  const removed = findRemovedAssertions(patch);
  assertEquals(removed.length, 1);
  assert(removed[0]!.text.startsWith("assert!("));
  assert(removed[0]!.text.includes('row["symbol"] == "BBB"'));

  const result = validateRemovedAssertions({
    changedFiles: ["tests/report_test.rs"],
    testDiff: patch,
    prSummaryContent: "## Test Plan\n\n- edited a test\n",
  });
  assertFalse(result.valid);
});

Deno.test("multi-line: a `deno fmt`-wrapped assertEquals whose expected-value line changes is removed", async () => {
  const before = src(
    'Deno.test("completion fails", async () => {',
    "  const outcome = await run();",
    "  assertEquals(",
    "    outcome.status,",
    '    "failure",',
    "  );",
    "});",
  );
  const after = before.replace('"failure"', '"continue"');
  const patch = await gatePatch({
    "worker/deno/tests/completion_test.ts": [before, after],
  });
  assertEquals(texts(findRemovedAssertions(patch)), [
    'assertEquals( outcome.status, "failure", );',
  ]);
  const result = validateRemovedAssertions({
    changedFiles: ["worker/deno/tests/completion_test.ts"],
    testDiff: patch,
    prSummaryContent:
      '## Test Plan\n\n- Removed `assertEquals(outcome.status, "failure")` — ' +
      "#3131 makes the run continue\n",
  });
  assert(result.valid, result.problems.join("; "));
});

// --- Negative cases: what must NOT be reported ------------------------------

Deno.test("no flag: an assertion genuinely moved, unguarded, to another test still counts as moved", async () => {
  const patch = await gatePatch({
    "tests/rows_test.rs": [
      RUST_BEFORE,
      src(
        "#[test]",
        "fn rows_load() {",
        "    let rows = load();",
        "}",
        "",
        "#[test]",
        "fn rows_cover_bbb() {",
        "    let rows = load();",
        '    assert_eq!(rows[0].name, "BBB");',
        "}",
      ),
    ],
  });
  assertEquals(findRemovedAssertions(patch), []);
});

Deno.test("no flag: an assertion moved, unguarded, to another test file still counts as moved", async () => {
  const patch = await gatePatch({
    "worker/deno/tests/a_test.ts": [
      src('Deno.test("a", () => {', "  assertEquals(total(), 5);", "});"),
      src('Deno.test("a", () => {', "  run();", "});"),
    ],
    "worker/deno/tests/b_test.ts": [
      null,
      src('Deno.test("b", () => {', "  assertEquals(total(), 5);", "});"),
    ],
  });
  assertEquals(findRemovedAssertions(patch), []);
});

Deno.test("no flag: an unchanged multi-line assertion beside an unrelated edit is not reported", async () => {
  const patch = await gatePatch({
    "tests/report_test.rs": [
      src(
        "#[test]",
        "fn report() {",
        "    let report = build();",
        "    assert!(",
        '        report.rows.iter().any(|row| row.symbol == "BBB"),',
        '        "no BBB row: {report:?}"',
        "    );",
        "}",
      ),
      src(
        "#[test]",
        "fn report() {",
        "    let report = build_with_defaults();",
        "    assert!(",
        '        report.rows.iter().any(|row| row.symbol == "BBB"),',
        '        "no BBB row: {report:?}"',
        "    );",
        "}",
      ),
    ],
  });
  assertEquals(findRemovedAssertions(patch), []);
});

Deno.test("no flag: an assertion inside an unchanged guard is not reported when another line changes", async () => {
  const patch = await gatePatch({
    "tests/test_total.py": [
      src(
        "def test_total():",
        "    total = compute()",
        "    if total is not None:",
        "        assert total == 5",
      ),
      src(
        "def test_total():",
        "    total = compute(strict=True)",
        "    if total is not None:",
        "        assert total == 5",
      ),
    ],
  });
  assertEquals(findRemovedAssertions(patch), []);
});

Deno.test("no flag: re-wrapping and renaming the enclosing test does not report its assertions", async () => {
  const patch = await gatePatch({
    "worker/deno/tests/foo_test.ts": [
      src(
        'Deno.test("old name", () => {',
        "  assertEquals(result.code, 0);",
        "});",
      ),
      src(
        'Deno.test("new name", () => {',
        "  assertEquals(",
        "    result.code,",
        "    0,",
        "  );",
        "});",
      ),
    ],
  });
  assertEquals(findRemovedAssertions(patch), []);
});

Deno.test("no flag: a `return` inside a same-line closure above an assertion is not an early exit", async () => {
  const patch = await gatePatch({
    "worker/deno/tests/foo_test.ts": [
      src('Deno.test("x", () => {', "  assertEquals(a, b);", "});"),
      src(
        'Deno.test("x", () => {',
        "  const pick = (x: number) => { return x; };",
        "  assertEquals(a, b);",
        "});",
      ),
    ],
  });
  assertEquals(findRemovedAssertions(patch), []);
});

Deno.test("no flag: assertion-like text inside a string literal is not an assertion", async () => {
  const patch = await gatePatch({
    "worker/deno/tests/foo_test.ts": [
      src(
        'Deno.test("x", () => {',
        '  const sample = "assertEquals(old, 1)";',
        "  assertEquals(sample.length, 20);",
        "});",
      ),
      src(
        'Deno.test("x", () => {',
        '  const sample = "assertEquals(new, 1)";',
        "  assertEquals(sample.length, 20);",
        "});",
      ),
    ],
  });
  assertEquals(findRemovedAssertions(patch), []);
});

// --- Fail loud when the gate cannot tell ------------------------------------

Deno.test("cannot tell: an assertion whose brackets never close is reported when the file changes after it", async () => {
  const filler = Array.from({ length: 250 }, (_, i) => `  // line ${i}`);
  const patch = await gatePatch({
    "worker/deno/tests/foo_test.ts": [
      src("assertEquals(a,", ...filler, "const tail = 1;"),
      src("assertEquals(a,", ...filler, "const tail = 2;"),
    ],
  });
  assertEquals(texts(findRemovedAssertions(patch)), ["assertEquals(a,"]);
});

Deno.test("cannot tell: a removed assertion the lexer hides is still reported by the raw-line backstop", () => {
  // A regex literal holding a backtick makes the lexer open a template
  // literal, so the assertion below it is blanked from the lexed scan.
  const diff = [
    "diff --git a/worker/deno/tests/foo_test.ts b/worker/deno/tests/foo_test.ts",
    "index 111..222 100644",
    "--- a/worker/deno/tests/foo_test.ts",
    "+++ b/worker/deno/tests/foo_test.ts",
    "@@ -1,3 +1,2 @@",
    " const tick = /`/;",
    "-assertEquals(a, b);",
    " run();",
    "",
  ].join("\n");
  assertEquals(texts(findRemovedAssertions(diff)), ["assertEquals(a, b);"]);
});

// --- Linear time on hostile input (ReDoS / nesting guidance) ----------------

/** A test-file patch whose new side is `body`, all lines added. */
const addedFilePatch = (body: string) =>
  [
    "diff --git a/worker/deno/tests/x_test.ts b/worker/deno/tests/x_test.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/worker/deno/tests/x_test.ts",
    "@@ -0,0 +1 @@",
    ...body.split("\n").map((line) => "+" + line),
    "",
  ].join("\n");

Deno.test("growth: deep nesting with an assertion at every level stays linear", () => {
  const removed = assertLinearGrowth(
    "removed-assertion nesting scan",
    (chars) => addedFilePatch("if (x) {\nassert(x);\n".repeat(chars / 20)),
    (input) => findRemovedAssertions(input),
    { baseChars: 20_000 },
  );
  assertEquals(removed, []);
});

Deno.test("growth: one long line of open brackets and quotes stays linear", () => {
  const removed = assertLinearGrowth(
    "removed-assertion long-line scan",
    (chars) =>
      addedFilePatch("assertEquals(" + "([{'\"`".repeat(chars / 6) + "\nx"),
    (input) => findRemovedAssertions(input),
    { baseChars: 20_000 },
  );
  assertEquals(removed, []);
});

Deno.test("growth: many assertions after many early exits stay linear", () => {
  const removed = assertLinearGrowth(
    "removed-assertion exit scan",
    (chars) =>
      addedFilePatch(
        "  if (a) return;\n".repeat(chars / 40) +
          "  assertEquals(a, b);\n".repeat(chars / 40),
      ),
    (input) => findRemovedAssertions(input),
    { baseChars: 20_000 },
  );
  assertEquals(removed, []);
});
