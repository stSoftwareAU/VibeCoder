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
        // `commit`/`checkout` otherwise spawn a detached
        // `git maintenance run --auto` that keeps writing into `.git` after
        // the awaited command returns, racing the recursive `Deno.remove`
        // below and failing it with "Directory not empty" (Issue #1135).
        "-c",
        "gc.auto=0",
        "-c",
        "maintenance.auto=false",
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

Deno.test("cannot tell: a Python `else:` assertion more than 400 lines below its `if` is reported", async () => {
  const body = Array.from({ length: 420 }, (_, i) => `        step(${i})`);
  const chain = (tail: string) =>
    src(
      "def test_rows():",
      "    if len(rows) > 5:",
      ...body,
      "    else:",
      "        assert a == b",
      `    ${tail}`,
    );
  const patch = await gatePatch({
    "tests/test_rows.py": [chain("done()"), chain("done(1)")],
  });
  assertEquals(texts(findRemovedAssertions(patch)), ["assert a == b"]);
});

Deno.test("no flag: a TS `} else {` more than 400 lines below its `if` is linked by brace", async () => {
  const body = Array.from({ length: 420 }, (_, i) => `    step(${i});`);
  const chain = (tail: string) =>
    src(
      'Deno.test("x", () => {',
      "  if (rows.length > 5) {",
      ...body,
      "  } else {",
      "    assertEquals(a, b);",
      "  }",
      `  ${tail}`,
      "});",
    );
  const patch = await gatePatch({
    "worker/deno/tests/foo_test.ts": [chain("done();"), chain("done(1);")],
  });
  assertEquals(findRemovedAssertions(patch), []);
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

Deno.test("cannot tell: an assertion line inside a carried-over template literal is reported even when moved", async () => {
  // A line that starts inside a multi-line string has no context the gate
  // can read, so a verbatim copy in another file does not vouch for it.
  const fixture = src("const fixture = `", "assertEquals(a, b);", "`;");
  const patch = await gatePatch({
    "worker/deno/tests/foo_test.ts": [
      fixture + 'Deno.test("x", () => {});\n',
      'Deno.test("x", () => {});\n',
    ],
    "worker/deno/tests/bar_test.ts": [
      'Deno.test("y", () => {});\n',
      'Deno.test("y", () => {});\n' + fixture,
    ],
  });
  assertEquals(texts(findRemovedAssertions(patch)), ["assertEquals(a, b);"]);
});

// --- A regex literal holding a backtick (PR #3148 review) -------------------

/**
 * The line from coding_guidelines_layers_2574_test.ts that opened a phantom
 * template literal and hid every guard, skip and inner-line edit below it.
 */
const BACKTICK_REGEX_HELPER = src(
  "function words(text: string): string[] {",
  '  return text.replace(/[*_`>]/g, " ").split(/\\s+/).filter(Boolean);',
  "}",
  "",
);

/** The Test Plan a careless agent writes: it names no removed assertion. */
const VAGUE_PLAN = "## Test Plan\n\n- edited a test\n";

Deno.test("regex: below `/[*_`>]/g`, an assertion wrapped in a multi-line `if (false) { }` is removed", async () => {
  const path = "worker/deno/tests/foo_test.ts";
  const patch = await gatePatch({
    [path]: [
      BACKTICK_REGEX_HELPER + src(
        'Deno.test("words", () => {',
        '  assertEquals(words("a b").length, 2);',
        "});",
      ),
      BACKTICK_REGEX_HELPER + src(
        'Deno.test("words", () => {',
        "  if (false) {",
        '    assertEquals(words("a b").length, 2);',
        "  }",
        "});",
      ),
    ],
  });
  assertEquals(texts(findRemovedAssertions(patch)), [
    'assertEquals(words("a b").length, 2);',
  ]);
  assertFalse(
    validateRemovedAssertions({
      changedFiles: [path],
      testDiff: patch,
      prSummaryContent: VAGUE_PLAN,
    }).valid,
  );
});

Deno.test("regex: below `/[*_`>]/g`, an inner-line edit of a wrapped `assertEquals(` is removed", async () => {
  const path = "worker/deno/tests/foo_test.ts";
  const wrapped = (expected: string) =>
    BACKTICK_REGEX_HELPER + src(
      'Deno.test("outcome", () => {',
      "  assertEquals(",
      "    decide(words(text)),",
      `    "${expected}",`,
      "  );",
      "});",
    );
  const patch = await gatePatch({
    [path]: [wrapped("failure"), wrapped("continue")],
  });
  assertEquals(texts(findRemovedAssertions(patch)), [
    'assertEquals( decide(words(text)), "failure", );',
  ]);
  assertFalse(
    validateRemovedAssertions({
      changedFiles: [path],
      testDiff: patch,
      prSummaryContent: VAGUE_PLAN,
    }).valid,
  );
});

Deno.test("regex: below `/[*_`>]/g`, an assertion moved into `Deno.test.ignore(` is removed", async () => {
  const path = "worker/deno/tests/foo_test.ts";
  const patch = await gatePatch({
    [path]: [
      BACKTICK_REGEX_HELPER + src(
        'Deno.test("words", () => {',
        '  assertEquals(words("a b").length, 2);',
        "});",
      ),
      BACKTICK_REGEX_HELPER + src(
        'Deno.test("words", () => {});',
        "",
        'Deno.test.ignore("words later", () => {',
        '  assertEquals(words("a b").length, 2);',
        "});",
      ),
    ],
  });
  assertEquals(texts(findRemovedAssertions(patch)), [
    'assertEquals(words("a b").length, 2);',
  ]);
  assertFalse(
    validateRemovedAssertions({
      changedFiles: [path],
      testDiff: patch,
      prSummaryContent: VAGUE_PLAN,
    }).valid,
  );
});

Deno.test("no flag: below `/[*_`>]/g`, an assertion moved to a live test in another file is moved", async () => {
  // The regex closes where it should: the lines after it are lexed as code,
  // so a plain move is matched with its context rather than failed closed.
  const patch = await gatePatch({
    "worker/deno/tests/foo_test.ts": [
      BACKTICK_REGEX_HELPER + src(
        'Deno.test("a", () => {',
        '  assertEquals(words("a b").length, 2);',
        "});",
      ),
      BACKTICK_REGEX_HELPER + src('Deno.test("a", () => {});'),
    ],
    "worker/deno/tests/bar_test.ts": [
      BACKTICK_REGEX_HELPER + src('Deno.test("b", () => {});'),
      BACKTICK_REGEX_HELPER + src(
        'Deno.test("b", () => {',
        '  assertEquals(words("a b").length, 2);',
        "});",
      ),
    ],
  });
  assertEquals(findRemovedAssertions(patch), []);
});

Deno.test("no flag: a division is not lexed as a regex literal", async () => {
  // `total / 2` follows an operand, so the `/` is division; lexing it as a
  // regex would blank `/ 2; const tick = ` and open the backtick below.
  const patch = await gatePatch({
    "worker/deno/tests/foo_test.ts": [
      src(
        'Deno.test("x", () => {',
        "  const half = total / 2; const note = `/`;",
        "  assertEquals(half, 1);",
        "});",
      ),
      src(
        'Deno.test("x", () => {',
        "  const half = total / 2; const note = `/`;",
        "  const spare = 0;",
        "  assertEquals(half, 1);",
        "});",
      ),
    ],
  });
  assertEquals(findRemovedAssertions(patch), []);
});

// --- An else / elif branch depends on the `if` head (PR #3148 review) -------

Deno.test("chain: a TS `} else {` assertion whose leading `if` condition changes is removed", async () => {
  const path = "worker/deno/tests/foo_test.ts";
  const chain = (condition: string) =>
    src(
      'Deno.test("x", () => {',
      `  if (${condition}) {`,
      "    skipped();",
      "  } else {",
      "    assertEquals(a, b);",
      "  }",
      "});",
    );
  const patch = await gatePatch({
    [path]: [chain("rows.length > 5"), chain("true")],
  });
  assertEquals(texts(findRemovedAssertions(patch)), ["assertEquals(a, b);"]);
  assertFalse(
    validateRemovedAssertions({
      changedFiles: [path],
      testDiff: patch,
      prSummaryContent: VAGUE_PLAN,
    }).valid,
  );
});

Deno.test("chain: a TS `} else if (…) {` assertion whose leading `if` condition changes is removed", async () => {
  const chain = (condition: string) =>
    src(
      'Deno.test("x", () => {',
      `  if (${condition}) {`,
      "    skipped();",
      "  } else if (ready) {",
      "    assertEquals(a, b);",
      "  }",
      "});",
    );
  const patch = await gatePatch({
    "worker/deno/tests/foo_test.ts": [
      chain("rows.length > 5"),
      chain(
        "rows.length > 0",
      ),
    ],
  });
  assertEquals(texts(findRemovedAssertions(patch)), ["assertEquals(a, b);"]);
});

Deno.test("chain: an unindented brace `} else {` is tied to its `if` by brace, not indentation", async () => {
  const chain = (condition: string) =>
    src(
      'Deno.test("x", () => {',
      `if (${condition}) {`,
      "skipped();",
      "} else {",
      "assertEquals(a, b);",
      "}",
      "});",
    );
  const patch = await gatePatch({
    "worker/deno/tests/foo_test.ts": [chain("rows.length > 5"), chain("true")],
  });
  assertEquals(texts(findRemovedAssertions(patch)), ["assertEquals(a, b);"]);
});

Deno.test("chain: a one-line TS `if … else` assertion whose `if` condition changes is removed", async () => {
  const chain = (condition: string) =>
    src(
      'Deno.test("x", () => {',
      `  if (${condition}) { skipped(); } else { assertEquals(a, b); }`,
      "});",
    );
  const patch = await gatePatch({
    "worker/deno/tests/foo_test.ts": [chain("rows.length > 5"), chain("true")],
  });
  assertEquals(findRemovedAssertions(patch).length, 1);
});

Deno.test("chain: a Python `elif` assertion whose leading `if` condition changes is removed", async () => {
  const path = "tests/test_rows.py";
  const chain = (condition: string) =>
    src(
      "def test_rows():",
      `    if ${condition}:`,
      "        skipped()",
      "    elif ready:",
      "        assert a == b",
    );
  const patch = await gatePatch({
    [path]: [chain("len(rows) > 5"), chain("True")],
  });
  assertEquals(texts(findRemovedAssertions(patch)), ["assert a == b"]);
  assertFalse(
    validateRemovedAssertions({
      changedFiles: [path],
      testDiff: patch,
      prSummaryContent: VAGUE_PLAN,
    }).valid,
  );
});

Deno.test("chain: a Python `else:` assertion whose leading `if` condition changes is removed", async () => {
  const chain = (condition: string) =>
    src(
      "def test_rows():",
      `    if ${condition}:`,
      "        skipped()",
      "    elif ready:",
      "        pass",
      "    else:",
      "        assert a == b",
    );
  const patch = await gatePatch({
    "tests/test_rows.py": [chain("len(rows) > 5"), chain("True")],
  });
  assertEquals(texts(findRemovedAssertions(patch)), ["assert a == b"]);
});

Deno.test("chain: a Rust match-arm assertion whose earlier arm becomes a catch-all is removed", async () => {
  const chain = (firstArm: string) =>
    src(
      "#[test]",
      "fn rows() {",
      "    match load() {",
      `        ${firstArm} => {}`,
      "        Some(row) => {",
      '            assert_eq!(row.name, "BBB");',
      "        }",
      "    }",
      "}",
    );
  const patch = await gatePatch({
    "tests/rows_test.rs": [chain("None"), chain("_")],
  });
  assertEquals(texts(findRemovedAssertions(patch)), [
    'assert_eq!(row.name, "BBB");',
  ]);
});

Deno.test("no flag: an edit inside the `if` branch body leaves the `else` assertion kept", async () => {
  const chain = (body: string) =>
    src(
      'Deno.test("x", () => {',
      "  if (rows.length > 5) {",
      `    ${body}`,
      "  } else {",
      "    assertEquals(a, b);",
      "  }",
      "});",
    );
  const patch = await gatePatch({
    "worker/deno/tests/foo_test.ts": [
      chain("skipped();"),
      chain("skipped(1);"),
    ],
  });
  assertEquals(findRemovedAssertions(patch), []);
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

// --- PR #3148 review: wrapped heads, template substitutions, closures -------

/** Whether the gate blocks `patch` under the vague Test Plan. */
const blocks = (path: string, patch: string) =>
  !validateRemovedAssertions({
    changedFiles: [path],
    testDiff: patch,
    prSummaryContent: VAGUE_PLAN,
  }).valid;

/** A `deno fmt`-wrapped `if (` guard over an assertion, condition given. */
const wrappedIfTest = (condition: string) =>
  src(
    'Deno.test("rows", () => {',
    "  const rows = load();",
    "  if (",
    `    ${condition} &&`,
    '    rows[0].name !== ""',
    "  ) {",
    '    assertEquals(rows[0].name, "AAA");',
    "  }",
    "});",
  );

Deno.test("wrapped head: a `deno fmt` multi-line `if (` condition loosened above an unchanged assertion is removed", async () => {
  const path = "worker/deno/tests/rows_test.ts";
  const patch = await gatePatch({
    [path]: [wrappedIfTest("rows.length > 5"), wrappedIfTest("false")],
  });
  assertEquals(texts(findRemovedAssertions(patch)), [
    'assertEquals(rows[0].name, "AAA");',
  ]);
  assert(blocks(path, patch));
});

Deno.test("wrapped head: a multi-line `if (` head above an unchanged `} else {` assertion is removed when it changes", async () => {
  const path = "worker/deno/tests/rows_test.ts";
  const chain = (condition: string) =>
    src(
      'Deno.test("rows", () => {',
      "  const rows = load();",
      "  if (",
      `    ${condition} &&`,
      '    rows[0].name !== ""',
      "  ) {",
      "    log(rows);",
      "  } else {",
      '    assertEquals(rows[0].name, "AAA");',
      "  }",
      "});",
    );
  const patch = await gatePatch({
    [path]: [chain("rows.length > 5"), chain("true ||")],
  });
  assertEquals(texts(findRemovedAssertions(patch)), [
    'assertEquals(rows[0].name, "AAA");',
  ]);
  assert(blocks(path, patch));
});

Deno.test("wrapped head: a rustfmt-wrapped `if a\\n && b\\n{` condition changed above an unchanged assertion is removed", async () => {
  const path = "tests/rows_test.rs";
  const rust = (condition: string) =>
    src(
      "#[test]",
      "fn rows_cover_aaa() {",
      "    let rows = load();",
      `    if ${condition}`,
      '        && rows[0].name != ""',
      "        && rows[1].name != rows[0].name",
      "    {",
      '        assert_eq!(rows[0].name, "AAA");',
      "    }",
      "}",
    );
  const patch = await gatePatch({
    [path]: [rust("rows.len() > 5"), rust("false")],
  });
  assertEquals(texts(findRemovedAssertions(patch)), [
    'assert_eq!(rows[0].name, "AAA");',
  ]);
  assert(blocks(path, patch));
});

Deno.test("wrapped head: a black-style `if (\\n cond\\n):` condition changed above an unchanged assertion is removed", async () => {
  const path = "tests/test_rows.py";
  const python = (condition: string) =>
    src(
      "def test_rows():",
      "    rows = load()",
      "    if (",
      `        ${condition}`,
      '        and rows[0].name != ""',
      "    ):",
      '        assert rows[0].name == "AAA"',
    );
  const patch = await gatePatch({
    [path]: [python("len(rows) > 5"), python("False")],
  });
  assertEquals(texts(findRemovedAssertions(patch)), [
    'assert rows[0].name == "AAA"',
  ]);
  assert(blocks(path, patch));
});

Deno.test("wrapped head: an id dropped from a multi-line `for (\\n const id of [ … ]\\n) {` head is removed", async () => {
  const path = "worker/deno/tests/admin_only_finding_test.ts";
  const loop = (...ids: string[]) =>
    src(
      'Deno.test("admin-only ids", () => {',
      "  for (",
      "    const id of [",
      ...ids.map((id) => `      "${id}",`),
      "    ]",
      "  ) {",
      "    assertEquals(isAdminOnly(id), true);",
      "  }",
      "});",
    );
  const patch = await gatePatch({
    [path]: [
      loop("SA-1", "SA-2", "SA-3", "SA-4"),
      loop("SA-1"),
    ],
  });
  assertEquals(texts(findRemovedAssertions(patch)), [
    "assertEquals(isAdminOnly(id), true);",
  ]);
  assert(blocks(path, patch));
});

Deno.test("wrapped head: an Allman `if (x)\\n{` condition changed above an unchanged assertion is removed", async () => {
  const path = "worker/deno/tests/rows_test.ts";
  const allman = (condition: string) =>
    src(
      'Deno.test("rows", () => {',
      `  if (${condition})`,
      "  {",
      '    assertEquals(rows[0].name, "AAA");',
      "  }",
      "});",
    );
  const patch = await gatePatch({
    [path]: [allman("rows.length > 5"), allman("false")],
  });
  assertEquals(texts(findRemovedAssertions(patch)), [
    'assertEquals(rows[0].name, "AAA");',
  ]);
});

Deno.test("no flag: an unchanged wrapped `if (` head is not reported when another line changes", async () => {
  const path = "worker/deno/tests/rows_test.ts";
  const patch = await gatePatch({
    [path]: [
      wrappedIfTest("rows.length > 5"),
      wrappedIfTest("rows.length > 5").replace("load()", "loadAll()"),
    ],
  });
  assertEquals(findRemovedAssertions(patch), []);
});

/**
 * Helpers that lose a lexer without `${…}` and arrow-regex handling: the
 * nested template from first_run_script_test.ts:251, and a regex literal
 * holding a backtick straight after `=>`.
 */
const LEXER_TRAPS: Record<string, string> = {
  "nested template in `${…}`": src(
    "function shellQuote(value: string): string {",
    "  return `'${value.replaceAll(\"'\", `'\\\\''`)}'`;",
    "}",
    "",
  ),
  "`=> /`/` regex": src(
    "const tick = (c: string) => /`/.test(c);",
    "",
  ),
};

/** A test below `helper`, then the same test with one context edit. */
const CONTEXT_EDITS: Record<string, [string, string]> = {
  "a `Deno.test.ignore(` rename": [
    src(
      'Deno.test("quote", () => {',
      '  assertEquals(shellQuote("a"), "\'a\'");',
      "});",
    ),
    src(
      'Deno.test.ignore("quote", () => {',
      '  assertEquals(shellQuote("a"), "\'a\'");',
      "});",
    ),
  ],
  "an inserted `return;`": [
    src(
      'Deno.test("quote", () => {',
      '  assertEquals(shellQuote("a"), "\'a\'");',
      "});",
    ),
    src(
      'Deno.test("quote", () => {',
      "  return;",
      '  assertEquals(shellQuote("a"), "\'a\'");',
      "});",
    ),
  ],
  "a guard condition change": [
    src(
      'Deno.test("quote", () => {',
      "  if (rows.length > 1) {",
      '    assertEquals(shellQuote("a"), "\'a\'");',
      "  }",
      "});",
    ),
    src(
      'Deno.test("quote", () => {',
      "  if (false) {",
      '    assertEquals(shellQuote("a"), "\'a\'");',
      "  }",
      "});",
    ),
  ],
};

for (const [trap, helper] of Object.entries(LEXER_TRAPS)) {
  for (const [edit, [before, after]] of Object.entries(CONTEXT_EDITS)) {
    Deno.test(`lexer: below a ${trap} helper, ${edit} around an unchanged assertion is removed`, async () => {
      const path = "worker/deno/tests/quote_test.ts";
      const patch = await gatePatch({
        [path]: [helper + before, helper + after],
      });
      assertEquals(texts(findRemovedAssertions(patch)), [
        'assertEquals(shellQuote("a"), "\'a\'");',
      ]);
      assert(blocks(path, patch));
    });
  }
}

for (const [trap, helper] of Object.entries(LEXER_TRAPS)) {
  Deno.test(`no flag: below a ${trap} helper, an assertion moved unguarded to another file is moved`, async () => {
    const body = src(
      'Deno.test("quote", () => {',
      '  assertEquals(shellQuote("a"), "\'a\'");',
      "});",
    );
    const patch = await gatePatch({
      "worker/deno/tests/quote_test.ts": [helper + body, helper],
      "worker/deno/tests/quote_more_test.ts": [null, body],
    });
    assertEquals(findRemovedAssertions(patch), []);
  });
}

/**
 * A regex literal after an `if (…)` head's `)` — read as a division by any
 * lexer that only looks one token back — whose backtick then opens a
 * template literal that never closes.
 */
const UNLEXABLE_HELPER = src(
  "function ticks(s: string): number {",
  "  if (s) /`/.test(s) && count();",
  "  return 0;",
  "}",
  "",
);

Deno.test("fail closed: when a side's lexer ends inside a string, an unchanged assertion below a changed guard is reported", async () => {
  const path = "worker/deno/tests/ticks_test.ts";
  const guarded = (condition: string) =>
    UNLEXABLE_HELPER + src(
      'Deno.test("ticks", () => {',
      `  if (${condition}) {`,
      '    assertEquals(ticks("a"), 1);',
      "  }",
      "});",
    );
  const patch = await gatePatch({
    [path]: [guarded("rows.length > 1"), guarded("false")],
  });
  assertEquals(texts(findRemovedAssertions(patch)), [
    'assertEquals(ticks("a"), 1);',
  ]);
  assert(blocks(path, patch));
});

Deno.test("fail closed: a side whose lexer ends inside a string is not reported when the file changes only above that point", async () => {
  const path = "worker/deno/tests/ticks_test.ts";
  const body = src(
    'Deno.test("ticks", () => {',
    '  assertEquals(ticks("a"), 1);',
    "});",
  );
  const patch = await gatePatch({
    [path]: [
      "const a = 1;\n" + UNLEXABLE_HELPER + body,
      "const a = 2;\n" + UNLEXABLE_HELPER + body,
    ],
  });
  assertEquals(findRemovedAssertions(patch), []);
});

Deno.test("no flag: a multi-line mock closure's `return` changing above unchanged assertions is not an early exit", async () => {
  const path = "worker/deno/tests/mint_test.ts";
  const mocked = (value: string) =>
    src(
      'Deno.test("mints a token", async () => {',
      "  const deps = mockDeps({ run: () => {",
      `    return ok(${value}); } });`,
      "  const fetchMock = async (url: string) => {",
      '    if (url.endsWith("/tokens")) {',
      `      return json(201, { token: ${value} });`,
      "    }",
      '    return Promise.reject(new Error("unexpected"));',
      "  };",
      "  const minted = await mint(deps, fetchMock);",
      '  assertEquals(minted, { token: "ghs_x", login: BOT });',
      "  assertEquals(deps.calls.length, 1);",
      "});",
    );
  const patch = await gatePatch({
    [path]: [mocked('""'), mocked('"x"')],
  });
  assertEquals(findRemovedAssertions(patch), []);
});

Deno.test("no flag: a `return` changed in an object method shorthand above unchanged assertions is not an early exit", async () => {
  const path = "worker/deno/tests/mint_test.ts";
  const mocked = (value: string) =>
    src(
      'Deno.test("mints a token", async () => {',
      "  const gh = {",
      "    async run(args: string[]) {",
      `      return ${value};`,
      "    },",
      "  };",
      "  assertEquals(await mint(gh), 1);",
      "});",
    );
  const patch = await gatePatch({
    [path]: [mocked('"a"'), mocked('"b"')],
  });
  assertEquals(findRemovedAssertions(patch), []);
});

Deno.test("no flag: a `return` changed in a closed nested Python `def` above an unchanged assertion is not an early exit", async () => {
  const path = "tests/test_mint.py";
  const nested = (value: string) =>
    src(
      "def test_mint():",
      "    def fake_run(args):",
      `        return ${value}`,
      "    result = mint(fake_run)",
      "    assert result == 1",
    );
  const patch = await gatePatch({
    [path]: [nested('"a"'), nested('"b"')],
  });
  assertEquals(findRemovedAssertions(patch), []);
});

Deno.test("exit: a `return` changed inside a closed multi-line `if` block still counts for the assertions after it", async () => {
  const path = "worker/deno/tests/foo_test.ts";
  const guarded = (exit: string) =>
    src(
      'Deno.test("x", () => {',
      "  const ready = setUp();",
      "  if (!ready.ok) {",
      `    ${exit}`,
      "  }",
      "  assertEquals(ready.code, 0);",
      "});",
    );
  const patch = await gatePatch({
    [path]: [guarded('log("not ready");'), guarded("return;")],
  });
  assertEquals(texts(findRemovedAssertions(patch)), [
    "assertEquals(ready.code, 0);",
  ]);
});

Deno.test("exit: a `return` after a closure closes on the same line (`}); return;`) still counts", async () => {
  const path = "worker/deno/tests/foo_test.ts";
  const after = (tail: string) =>
    src(
      'Deno.test("x", () => {',
      "  const off = listen(() => {",
      `    log("x"); });${tail}`,
      "  assertEquals(off.code, 0);",
      "});",
    );
  const patch = await gatePatch({
    [path]: [after(""), after(" return;")],
  });
  assertEquals(texts(findRemovedAssertions(patch)), [
    "assertEquals(off.code, 0);",
  ]);
});

Deno.test("growth: a long wrapped head and many template substitutions stay linear", () => {
  const removed = assertLinearGrowth(
    "removed-assertion wrapped-head scan",
    (chars) =>
      addedFilePatch(
        "if (\n" + "  a &&\n".repeat(chars / 40) + ") {\n" +
          "  `${`${x}`}` && assert(x);\n".repeat(chars / 40) + "}\n",
      ),
    (input) => findRemovedAssertions(input),
    { baseChars: 20_000 },
  );
  assertEquals(removed, []);
});

Deno.test("no flag: a fixture added to a wrapped `def test_…(\\n…\\n):` signature does not report its assertions", async () => {
  const path = "tests/test_rows.py";
  const signature = (...params: string[]) =>
    src(
      "def test_rows(",
      ...params.map((param) => `    ${param},`),
      "):",
      "    rows = load(db)",
      '    assert rows[0].name == "AAA"',
    );
  const patch = await gatePatch({
    [path]: [signature("db"), signature("db", "tmp_path")],
  });
  assertEquals(findRemovedAssertions(patch), []);
});
