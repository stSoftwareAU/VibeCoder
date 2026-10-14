/**
 * Repo-owned, path-scoped review checklists (Issue #3594): the file parser,
 * the path-glob matcher, the reviewer section renderer and the reply-verdict
 * parser.
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  CHECKLIST_FILE_LIST_LIMIT,
  checklistGapFindings,
  checklistState,
  loadChecklistsFromText,
  matchesPathGlob,
  parseChecklistVerdicts,
  parseReviewChecklists,
  renderChecklistSection,
  REVIEW_CHECKLISTS_FILE,
} from "../lib/review_checklists.ts";

const GOOD = {
  checklists: [{ name: "Money", paths: ["src/money/**"], items: ["Decimal"] }],
};

// ---- parser ----------------------------------------------------------------

Deno.test("parseReviewChecklists accepts the documented shape", () => {
  assertEquals(parseReviewChecklists(JSON.stringify(GOOD)), GOOD);
  assertEquals(REVIEW_CHECKLISTS_FILE, "review-checklists.json");
  assert(CHECKLIST_FILE_LIST_LIMIT > 0);
});

Deno.test("parseReviewChecklists rejects each invalid shape with a descriptive message", () => {
  const withList = (c: unknown) => JSON.stringify({ checklists: [c] });
  const cases: Array<[string, string, string]> = [
    ["{not json", "not valid JSON", "bad JSON"],
    ["[]", "must be a JSON object", "array top level"],
    ['"x"', "must be a JSON object", "string top level"],
    ["null", "must be a JSON object", "null top level"],
    ["{}", '"checklists" array', "missing checklists"],
    ['{"checklists":{}}', '"checklists" array', "checklists not array"],
    [withList("x"), "checklists[0] must be an object", "entry not object"],
    [withList({ paths: ["a"], items: ["i"] }), '"name"', "missing name"],
    [withList({ name: " ", paths: ["a"], items: ["i"] }), '"name"', "blank"],
    [withList({ name: "n", paths: [], items: ["i"] }), '"paths"', "no paths"],
    [withList({ name: "n", paths: ["a"], items: [] }), '"items"', "no items"],
    [withList({ name: "n", paths: ["a"] }), '"items"', "items missing"],
    [withList({ name: "n", paths: [1], items: ["i"] }), "paths[0]", "path num"],
    [withList({ name: "n", paths: ["a"], items: [""] }), "items[0]", "item ''"],
    [withList({ name: "n", paths: ["a"], items: [null] }), "items[0]", "null"],
  ];
  for (const [text, message, label] of cases) {
    const err = assertThrows(
      () => parseReviewChecklists(text),
      Error,
      "",
      label,
    );
    assertStringIncludes(err.message, message, label);
  }
});

Deno.test("parseReviewChecklists names the offending checklist", () => {
  const err = assertThrows(() =>
    parseReviewChecklists(
      JSON.stringify({
        checklists: [
          GOOD.checklists[0],
          { name: "Release", paths: ["Cargo.toml"], items: [] },
        ],
      }),
    ), Error);
  assertStringIncludes(err.message, "checklists[1]");
  assertStringIncludes(err.message, "Release");
});

// ---- glob ------------------------------------------------------------------

Deno.test("matchesPathGlob: ** crosses directories, * does not", () => {
  assert(matchesPathGlob("src/**", "src/a/b/c.rs"));
  assert(matchesPathGlob("src/**", "src/a.rs"));
  assert(matchesPathGlob("src/*.rs", "src/a.rs"));
  assertFalse(matchesPathGlob("src/*.rs", "src/a/b.rs"));
  assertFalse(matchesPathGlob("*.rs", "src/a.rs"));
  assert(matchesPathGlob("**/*.rs", "src/a/b.rs"));
  assert(matchesPathGlob("src/a*/c.rs", "src/abc/c.rs"));
  assertFalse(matchesPathGlob("src/a*/c.rs", "src/ab/x/c.rs"));
});

Deno.test("matchesPathGlob: **/ also matches zero directories", () => {
  assert(matchesPathGlob("**/foo.rs", "foo.rs"));
  assert(matchesPathGlob("**/foo.rs", "a/foo.rs"));
  assert(matchesPathGlob("**/foo.rs", "a/b/foo.rs"));
  assertFalse(matchesPathGlob("**/foo.rs", "afoo.rs"));
  assertFalse(matchesPathGlob("**/foo.rs", "a/bfoo.rs"));
});

Deno.test("matchesPathGlob: ? is exactly one non-slash character", () => {
  assert(matchesPathGlob("a?c", "abc"));
  assertFalse(matchesPathGlob("a?c", "ac"));
  assertFalse(matchesPathGlob("a?c", "abbc"));
  assertFalse(matchesPathGlob("a?c", "a/c"));
});

Deno.test("matchesPathGlob is case sensitive and treats other characters literally", () => {
  assertFalse(matchesPathGlob("CHANGELOG.md", "changelog.md"));
  assert(matchesPathGlob("CHANGELOG.md", "CHANGELOG.md"));
  assertFalse(matchesPathGlob("CHANGELOG.md", "CHANGELOGxmd"));
  assert(matchesPathGlob("a+b(c).rs", "a+b(c).rs"));
  assertFalse(matchesPathGlob("[ab].rs", "a.rs"));
  assert(matchesPathGlob("[ab].rs", "[ab].rs"));
});

Deno.test("matchesPathGlob normalises a leading ./ on the path", () => {
  assert(matchesPathGlob("src/**", "./src/a.rs"));
  assert(matchesPathGlob("Cargo.toml", "././Cargo.toml"));
});

Deno.test("matchesPathGlob: .. , // and leading / evasions never match", () => {
  // Each would match if the guard were absent.
  assertFalse(matchesPathGlob("src/**", "src/../etc/passwd"));
  assertFalse(matchesPathGlob("**/*.rs", "../outside/a.rs"));
  assertFalse(matchesPathGlob("**", "a/../b"));
  assertFalse(matchesPathGlob("src/**", "src//a.rs"));
  assertFalse(matchesPathGlob("**", "/etc/passwd"));
  assertFalse(matchesPathGlob("**", "./../x"));
  assertFalse(matchesPathGlob("src/**", "src/a/.."));
  // Unsafe globs match nothing either.
  assertFalse(matchesPathGlob("../**", "../a.rs"));
  assertFalse(matchesPathGlob("/src/**", "/src/a.rs"));
  assertFalse(matchesPathGlob("src//**", "src//a.rs"));
  // A name merely containing dots is fine.
  assert(matchesPathGlob("src/**", "src/..a/b.rs"));
});

Deno.test("matchesPathGlob: unsafe globs never match a safe path", () => {
  // Positive control, so the test cannot pass by everything being false.
  assert(matchesPathGlob("src/*.ts", "src/x.ts"));
  // A trailing empty segment is only reachable by a safe path because `**/`
  // matches zero directories: "src**/" would match "src" without the glob guard.
  assertFalse(matchesPathGlob("src**/", "src"));
  // Literal `..`, `//` and leading `/` cannot match a safe path anyway, so these
  // only pin the outcome rather than isolate the guard.
  assertFalse(matchesPathGlob("a/../b/*.ts", "b/x.ts"));
  assertFalse(matchesPathGlob("src//*.ts", "src/x.ts"));
  assertFalse(matchesPathGlob("/src/*.ts", "src/x.ts"));
});

Deno.test("matchesPathGlob: prefix-only and suffix-only patterns", () => {
  assert(matchesPathGlob("Cargo*", "Cargo.toml"));
  assertFalse(matchesPathGlob("Cargo*", "xCargo.toml"));
  assert(matchesPathGlob("*.toml", "Cargo.toml"));
  assertFalse(matchesPathGlob("*.toml", "Cargo.toml.bak"));
  assert(matchesPathGlob("**/*price*.rs", "src/x/unit_price_v2.rs"));
});

Deno.test("matchesPathGlob finishes hostile inputs and answers false", () => {
  const text = "a".repeat(5000);
  assertFalse(matchesPathGlob("*a*a*a*b", text));
  assertFalse(matchesPathGlob("**a**a**a**b", text));
  assertFalse(matchesPathGlob("**/a**/a**/a*b", text));
  assertFalse(matchesPathGlob("*a*a*a*a*a*a*a*a*b", text));
  // And still answers true when it should.
  assert(matchesPathGlob("*a*a*a*b", text + "b"));
});

// ---- loading ---------------------------------------------------------------

Deno.test("loadChecklistsFromText maps text, null and read errors", () => {
  assertEquals(loadChecklistsFromText(null), { kind: "absent" });
  assertEquals(loadChecklistsFromText(JSON.stringify(GOOD)), {
    kind: "loaded",
    config: GOOD,
  });
  const bad = loadChecklistsFromText("{nope");
  assertEquals(bad.kind, "malformed");
  assertEquals(loadChecklistsFromText(null, "disk on fire"), {
    kind: "unreadable",
    reason: "disk on fire",
  });
  // A read error wins over any text.
  assertEquals(
    loadChecklistsFromText(JSON.stringify(GOOD), "boom").kind,
    "unreadable",
  );
});

// ---- rendering -------------------------------------------------------------

const POLICY = loadChecklistsFromText(JSON.stringify({
  checklists: [
    {
      name: "Money handling",
      paths: ["src/money/**", "**/*price*.rs", "**/*order*.rs"],
      items: [
        "Every money figure uses the Decimal/cents type, never f64",
        "Rounding is explicit and tested",
      ],
    },
    {
      name: "Release",
      paths: [".github/workflows/release*.yml", "Cargo.toml", "CHANGELOG.md"],
      items: ["CHANGELOG.md has an entry", "Version in Cargo.toml is bumped"],
    },
  ],
}));

Deno.test("renderChecklistSection lists name, matched files and every item for a matching path", () => {
  const out = renderChecklistSection(POLICY, [
    "src/money/fees.rs",
    "README.md",
  ]);
  assertStringIncludes(out, "Money handling");
  assertStringIncludes(out, "src/money/fees.rs");
  assertStringIncludes(
    out,
    "1. Every money figure uses the Decimal/cents type",
  );
  assertStringIncludes(out, "2. Rounding is explicit and tested");
  assertStringIncludes(out, "met");
  assertStringIncludes(out, "not applicable");
  assertStringIncludes(out, "`findings`");
  assertStringIncludes(out, "`checklist`");
  assertFalse(out.includes("README.md"));
  assertFalse(out.includes("Release"));
});

Deno.test("renderChecklistSection: GRQ-AutoTrader policy paths select the right checklists", () => {
  const has = (files: string[], name: string) =>
    renderChecklistSection(POLICY, files).includes(name);
  assert(has(["src/money/fees.rs"], "Money handling"));
  assert(has(["src/engine/unit_price.rs"], "Money handling"));
  assert(has(["crates/x/order_book.rs"], "Money handling"));
  assertFalse(has(["src/ui/button.rs"], "Money handling"));
  assertFalse(has(["src/ui/button.rs"], "Release"));
  assert(has([".github/workflows/release-prod.yml"], "Release"));
  assertFalse(has([".github/workflows/ci.yml"], "Release"));
  assert(has(["Cargo.toml"], "Release"));
  assert(has(["CHANGELOG.md"], "Release"));
  assertFalse(has(["docs/CHANGELOG.md"], "Release"));
  assertEquals(renderChecklistSection(POLICY, ["src/ui/button.rs"]), "");
});

Deno.test("renderChecklistSection caps the matched files shown at ten", () => {
  const files = Array.from({ length: 14 }, (_, i) => `src/money/f${i}.rs`);
  const out = renderChecklistSection(POLICY, files);
  assertStringIncludes(out, "src/money/f9.rs");
  assertFalse(out.includes("src/money/f10.rs"));
  assertStringIncludes(out, "and 4 more");
});

Deno.test("renderChecklistSection is empty when absent or when nothing matches", () => {
  assertEquals(renderChecklistSection({ kind: "absent" }, ["src/a.rs"]), "");
  assertEquals(renderChecklistSection({ kind: "absent" }, null), "");
  assertEquals(renderChecklistSection(POLICY, []), "");
});

Deno.test("renderChecklistSection: malformed and unreadable files are loud blocking sections", () => {
  for (const kind of ["malformed", "unreadable"] as const) {
    const out = renderChecklistSection(
      { kind, reason: "the-specific-reason" },
      ["README.md"],
    );
    assertStringIncludes(out, "the-specific-reason");
    assertStringIncludes(out, "BLOCKING");
    assertStringIncludes(out, "review-checklists.json");
    assertStringIncludes(out, "line 1");
    assertStringIncludes(out, '"no checklist"');
    // Same loudness whatever the changed files, even unknown.
    assertStringIncludes(
      renderChecklistSection({ kind, reason: "r" }, null),
      "BLOCKING",
    );
  }
});

Deno.test("renderChecklistSection never lets a reason break out of its line or code span", () => {
  const hostile = `line1\nline2\r\n\`\`\`\n## injected heading\n${
    "x".repeat(900)
  }`;
  for (const kind of ["malformed", "unreadable"] as const) {
    const out = renderChecklistSection({ kind, reason: hostile }, null);
    const reasonLine = out.split("\n").find((l) => l.includes("line1"))!;
    assert(reasonLine.includes("line2"));
    assertFalse(reasonLine.includes("```"));
    assertFalse(out.split("\n").some((l) => l.startsWith("## injected")));
    assert(reasonLine.length < 500);
  }
});

Deno.test("renderChecklistSection: a loaded config with an unknown changed-file list is not-checked and blocking", () => {
  const out = renderChecklistSection(POLICY, null);
  assertStringIncludes(out, "NOT checked");
  assertStringIncludes(out, "BLOCKING");
  assertStringIncludes(out, "review-checklists.json");
  assertFalse(out.includes("Every money figure"));
});

// ---- verdicts --------------------------------------------------------------

Deno.test("parseChecklistVerdicts accepts valid entries and defaults", () => {
  assertEquals(parseChecklistVerdicts(undefined), []);
  assertEquals(parseChecklistVerdicts(null), []);
  assertEquals(parseChecklistVerdicts([]), []);
  assertEquals(
    parseChecklistVerdicts([
      { checklist: "M", item: "i", verdict: "met", note: "n" },
      { checklist: "M", item: "j", verdict: "missing" },
      { checklist: "M", item: "k", verdict: "not applicable", note: "" },
    ]).map((v) => [v.verdict, v.note]),
    [["met", "n"], ["missing", ""], ["not applicable", ""]],
  );
});

Deno.test("parseChecklistVerdicts rejects each bad shape naming the problem", () => {
  const ok = { checklist: "M", item: "i", verdict: "met", note: "n" };
  const bad: Array<[unknown, string]> = [
    ["nope", "not an array"],
    [{}, "not an array"],
    [["x"], "not an object"],
    [[null], "not an object"],
    [[{ ...ok, checklist: "" }], '"checklist"'],
    [[{ ...ok, item: 3 }], '"item"'],
    [[{ ...ok, verdict: "maybe" }], "verdict"],
    [[{ ...ok, verdict: undefined }], "verdict"],
    [[{ ...ok, verdict: "MET" }], "verdict"],
    [[ok, { ...ok, note: 5 }], "note"],
  ];
  for (const [value, message] of bad) {
    const err = assertThrows(() => parseChecklistVerdicts(value), Error);
    assertStringIncludes(err.message, message);
  }
});

// ---- added after the pre-PR verifier review of #3594 -------------------------

Deno.test("parseReviewChecklists reports the JSON parser's own message for bad JSON", () => {
  const text = "{not json";
  let expected = "";
  try {
    JSON.parse(text);
  } catch (error) {
    expected = (error as Error).message;
  }
  const err = assertThrows(() => parseReviewChecklists(text), Error);
  assertEquals(
    err.message,
    `${REVIEW_CHECKLISTS_FILE} is not valid JSON: ${expected}`,
  );
});

Deno.test("parseReviewChecklists rejects a path glob that can never match, naming the checklist and index", () => {
  for (const glob of ["/src/money/**", "src/money/", "src//a", "../x/**", ""]) {
    const text = JSON.stringify({
      checklists: [{ name: "Money", paths: ["src/ok/**", glob], items: ["i"] }],
    });
    const err = assertThrows(() => parseReviewChecklists(text), Error);
    assertStringIncludes(err.message, '("Money")');
    assertStringIncludes(err.message, "paths[1]");
  }
  // Loaded as malformed, so the brief carries the BLOCKING section instead of
  // silently skipping the checklist.
  const load = loadChecklistsFromText(JSON.stringify({
    checklists: [{
      name: "Money",
      paths: ["/src/money/**", "src/money/"],
      items: ["i"],
    }],
  }));
  assertEquals(load.kind, "malformed");
  assertStringIncludes(
    renderChecklistSection(load, ["src/money/a.rs"]),
    "BLOCKING",
  );
});

Deno.test("parseReviewChecklists accepts a leading ./ on a glob, and the matcher applies it", () => {
  const config = parseReviewChecklists(JSON.stringify({
    checklists: [{ name: "Money", paths: ["./src/money/**"], items: ["i"] }],
  }));
  assertEquals(config.checklists[0]!.paths, ["./src/money/**"]);
  assert(matchesPathGlob("./src/money/**", "src/money/a.rs"));
});

Deno.test("matchesPathGlob: `**/` matches only after a position the prefix reached", () => {
  // The prefix `x` never matches, so a later `/` must not let `**/` start.
  assertFalse(matchesPathGlob("x**/y", "a/y"));
  assert(matchesPathGlob("a**/y", "a/b/y"));
});

// ---- load state and gap findings (PR #3695 review) -------------------------

Deno.test("checklistState: every load that cannot be applied carries a problem; absent and non-matching carry none", () => {
  for (const kind of ["malformed", "unreadable", "fetch_failed"] as const) {
    const st = checklistState({ kind, reason: "boom" }, ["a.rs"]);
    assertStringIncludes(st.problem ?? "", "boom");
    assertEquals(st.expected, []);
  }
  assertStringIncludes(
    checklistState(POLICY, null).problem ?? "",
    "unavailable or truncated",
  );
  assertEquals(checklistState({ kind: "absent" }, null), {
    problem: null,
    expected: [],
  });
  assertEquals(checklistState(POLICY, ["README.md"]), {
    problem: null,
    expected: [],
  });
});

Deno.test("checklistState: expected holds exactly the items the section renders, one per item of each matched checklist", () => {
  const st = checklistState(POLICY, ["src/money/fees.rs", "Cargo.toml"]);
  assertEquals(st.problem, null);
  assertEquals(st.expected.length, 4);
  const section = renderChecklistSection(POLICY, [
    "src/money/fees.rs",
    "Cargo.toml",
  ]);
  for (const e of st.expected) {
    assertStringIncludes(section, e.item);
    assertStringIncludes(section, e.checklist);
  }
});

Deno.test("renderChecklistSection renders a failed fetch as a blocking problem, never as no checklist", () => {
  const out = renderChecklistSection(
    { kind: "fetch_failed", reason: "HTTP 502" },
    ["a.rs"],
  );
  assertStringIncludes(out, "could not be read");
  assertStringIncludes(out, "BLOCKING");
});

Deno.test("checklistGapFindings: none when every expected item has a verdict or nothing applies", () => {
  const verdict = (checklist: string, item: string) => ({
    checklist,
    item,
    verdict: "met" as const,
    note: "",
  });
  const st = checklistState(POLICY, ["src/money/fees.rs"]);
  assertEquals(
    checklistGapFindings(
      st,
      st.expected.map((e) => verdict(e.checklist, e.item)),
    ),
    [],
  );
  assertEquals(checklistGapFindings({ problem: null, expected: [] }, []), []);
});

Deno.test("checklistGapFindings: a problem and unreported items are each a blocking finding on the checklist file", () => {
  const both = checklistGapFindings({
    problem: "the file is malformed",
    expected: [{ checklist: "A", item: "one" }],
  }, []);
  assertEquals(both.length, 2);
  for (const f of both) {
    assertEquals(f.file, "review-checklists.json");
    assertEquals(f.line, 1);
    assert(f.fix.length > 0);
  }
  assertStringIncludes(both[0]!.problem, "the file is malformed");
  assertStringIncludes(both[1]!.problem, "1 of 1");
});

Deno.test("checklistGapFindings: a verdict for another checklist's identically worded item does not cover this one, and a long gap list is capped", () => {
  const same = checklistGapFindings({
    problem: null,
    expected: [{ checklist: "A", item: "x" }, { checklist: "B", item: "x" }],
  }, [{ checklist: "A", item: "x", verdict: "met", note: "" }]);
  assertEquals(same.length, 1);
  assertStringIncludes(same[0]!.problem, "1 of 2");
  assertStringIncludes(same[0]!.problem, '"B"');

  const many = checklistGapFindings({
    problem: null,
    expected: Array.from(
      { length: 9 },
      (_, i) => ({ checklist: "C", item: `i${i}` }),
    ),
  }, []);
  assertStringIncludes(many[0]!.problem, "9 of 9");
  assertStringIncludes(many[0]!.problem, "and 4 more");
  assert(!many[0]!.problem.includes("i8"));
});

Deno.test("checklistGapFindings: hostile text cannot carry markup or a mention", () => {
  const out = checklistGapFindings({
    problem: "<b>x</b> @octocat",
    expected: [{ checklist: "n@me", item: "<script>" }],
  }, []);
  for (const f of out) {
    assert(!/[<>]/.test(f.problem), f.problem);
    assert(!f.problem.includes("@octocat"), f.problem);
  }
});
