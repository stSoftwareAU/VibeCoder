/**
 * Existing callers of changed functions (Issue #3779): the definition and
 * diff parsers, the caller collection against real git in a temporary clone,
 * the verdict parser, the gap findings, and linear growth on hostile input.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  CALLER_VERDICTS,
  type CallerCheckState,
  callerGapFindings,
  type CallerVerdict,
  collectCallerChecks,
  definitionName,
  enclosingDefinitions,
  indexDefinitions,
  MAX_CALLERS_PER_SYMBOL,
  MAX_SYMBOLS_SEARCHED,
  parseCallerVerdicts,
  parseDiffChangedLines,
  renderCallerCheckSection,
} from "../lib/caller_checks.ts";
import { assertLinearGrowth } from "./support/growth.ts";
import { git, gitOk, setupGitRepoFixture } from "./support/git_repo_fixture.ts";

// ---- definitionName ---------------------------------------------------------

Deno.test("definitionName names a definition in each supported language", () => {
  const cases: Array<[string, string]> = [
    ["export function sharedHelper(x: number): number {", "sharedHelper"],
    ["export default async function handler() {", "handler"],
    ["function* walkTree(node) {", "walkTree"],
    ["function deploy {", "deploy"],
    ["build_all() {", "build_all"],
    ["export const fmtMoney = (x: number) => x.toFixed(2);", "fmtMoney"],
    ["export const add: Fn = async (a) => a;", "add"],
    ["let callback = function () {", "callback"],
    ["  private async load(id: string): Promise<void> {", "load"],
    ["  render(x: number): void {", "render"],
    ["pub(crate) async fn fetch_row(id: u32) -> Row {", "fetch_row"],
    ['unsafe extern "C" fn native_call() {', "native_call"],
    ["async def fetch(url):", "fetch"],
    ["def compute(x):", "compute"],
    ["func (s *Store) Save(item Item) error {", "Save"],
    ["func Helper() {", "Helper"],
  ];
  for (const [line, name] of cases) {
    assertEquals(definitionName(line), name, `line: ${line}`);
  }
});

Deno.test("definitionName rejects control words, short names and ordinary calls", () => {
  const cases = [
    "if (x) {",
    "for (const k of ks) {",
    "while (more) {",
    "} else {",
    "constructor(x) {",
    "foo(bar);",
    "const a = 2;",
    "return foo(x);",
    "  return x + 1;",
    "const total = 3;",
    "ab() {",
    "export const a = 2;",
  ];
  for (const line of cases) {
    assertEquals(definitionName(line), null, `line: ${line}`);
  }
});

Deno.test("definitionName rejects every control word that can name a definition", () => {
  for (const word of [
    "switch",
    "catch",
    "return",
    "function",
    "else",
    "try",
    "with",
    "elif",
    "until",
    "case",
    "select",
    "new",
    "await",
    "typeof",
  ]) {
    assertEquals(definitionName(`${word} (x) {`), null, `word: ${word}`);
  }
});

// ---- indexDefinitions and enclosingDefinitions -------------------------------

const NESTED = [
  "function outer(): void {", // 1
  "  const inner = () => {", // 2
  "    work();", // 3
  "  };", // 4
  "  other();", // 5
  "}", // 6
];

Deno.test("enclosingDefinitions yields a closure and the function around it", () => {
  const defs = indexDefinitions(NESTED);
  assertEquals(
    enclosingDefinitions(defs, NESTED, 3),
    [{ name: "inner", line: 2 }, { name: "outer", line: 1 }],
  );
});

Deno.test("enclosingDefinitions yields only the outer function after a deeper closure has ended", () => {
  const defs = indexDefinitions(NESTED);
  assertEquals(enclosingDefinitions(defs, NESTED, 5), [
    { name: "outer", line: 1 },
  ]);
});

Deno.test("enclosingDefinitions yields the function whose signature line changed", () => {
  const defs = indexDefinitions(NESTED);
  assertEquals(enclosingDefinitions(defs, NESTED, 1), [
    { name: "outer", line: 1 },
  ]);
  assertEquals(enclosingDefinitions(defs, NESTED, 2)[0], {
    name: "inner",
    line: 2,
  });
});

// ---- parseDiffChangedLines ---------------------------------------------------

const DIFF = [
  "diff --git a/lib/a.ts b/lib/a.ts",
  "index 1111111..2222222 100644",
  "--- a/lib/a.ts",
  "+++ b/lib/a.ts",
  "@@ -3,0 +4,2 @@ context",
  "+x",
  "+y",
  "@@ -10 +12 @@",
  "-old",
  "+new",
  "@@ -20,2 +30,0 @@",
  "-gone",
  "-gone2",
  "@@ -1,0 +6 @@",
  "+++ b/fake.ts",
  "diff --git a/gone.ts b/gone.ts",
  "--- a/gone.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-z",
  "diff --git a/spaced name.ts b/spaced name.ts",
  "--- a/spaced name.ts",
  "+++ b/spaced name.ts\t",
  "@@ -1 +1 @@",
  "-a",
  "+b",
  'diff --git a/"caf\\303\\251.ts" b/"caf\\303\\251.ts"',
  '--- "a/caf\\303\\251.ts"',
  '+++ "b/caf\\303\\251.ts"',
  "@@ -1 +1,2 @@",
  "-q",
  "+r",
  "+s",
  "",
].join("\n");

Deno.test("parseDiffChangedLines reads ranges, deletion anchors, deleted files and tab-ended names", () => {
  const { files, unparsed } = parseDiffChangedLines(DIFF);
  assertEquals(
    [...(files.get("lib/a.ts") ?? [])].sort((a, b) => a - b),
    [4, 5, 6, 12, 30],
  );
  assertEquals(files.get("spaced name.ts"), [1]);
  assert(
    !files.has("fake.ts"),
    "an added line that starts with +++ is content",
  );
  assert(!files.has("gone.ts"), "a deleted file has no new lines");
  assertEquals(unparsed, 1, "a quoted path is counted, not parsed");
});

Deno.test("parseDiffChangedLines reads an empty diff as no files", () => {
  const { files, unparsed } = parseDiffChangedLines("");
  assertEquals(files.size, 0);
  assertEquals(unparsed, 0);
});

// ---- hostile input stays linear -------------------------------------------

const HOSTILE_DEFINITION_INPUTS: Array<[string, (n: number) => string]> = [
  ["function keyword", (n) => `function${" ".repeat(n)}!`],
  ["const arrow", (n) => `const a${" ".repeat(n)}!`],
  ["const type annotation", (n) => `const a:${"x".repeat(n)}!`],
  ["rust modifiers", (n) => `${"async ".repeat(n)}!`],
  ["python async", (n) => `async${" ".repeat(n)}!`],
  ["go receiver", (n) => `func (${"a".repeat(n)}!`],
  ["bash name", (n) => `${"a".repeat(n)} !`],
  ["class modifiers", (n) => `${"static ".repeat(n)}!`],
  ["method without modifier", (n) => `f(${"x".repeat(n)}!`],
];

for (const [label, build] of HOSTILE_DEFINITION_INPUTS) {
  Deno.test(`definitionName stays linear on hostile input: ${label}`, () => {
    const result = assertLinearGrowth(
      `definitionName, ${label}`,
      build,
      definitionName,
      { baseChars: 10_000 },
    );
    assertEquals(result, null);
  });
}

const HOSTILE_DIFF_INPUTS: Array<[string, (n: number) => string]> = [
  ["hunk new count", (n) => `+++ b/x.ts\n@@ -1 +${"1".repeat(n)}!\n`],
  ["hunk old count", (n) => `+++ b/x.ts\n@@ -1,${"1".repeat(n)}!\n`],
  ["header tab run", (n) => `+++ b/x.ts${"\t".repeat(n)}!\n`],
];

for (const [label, build] of HOSTILE_DIFF_INPUTS) {
  Deno.test(`parseDiffChangedLines stays linear on hostile input: ${label}`, () => {
    const result = assertLinearGrowth(
      `parseDiffChangedLines, ${label}`,
      build,
      parseDiffChangedLines,
      { baseChars: 10_000 },
    );
    assertEquals(result.unparsed, 0);
  });
}

// ---- collectCallerChecks against real git -----------------------------------

async function commitFiles(
  clone: string,
  files: Record<string, string>,
  message: string,
): Promise<string> {
  for (const [path, text] of Object.entries(files)) {
    if (path.includes("/")) {
      await Deno.mkdir(`${clone}/${path.slice(0, path.lastIndexOf("/"))}`, {
        recursive: true,
      });
    }
    await Deno.writeTextFile(`${clone}/${path}`, text);
  }
  await gitOk(["add", "-A"], clone);
  await gitOk(["commit", "-q", "-m", message], clone);
  return (await gitOk(["rev-parse", "HEAD"], clone)).trim();
}

const HELPER_BASE =
  "export function sharedHelper(x: number): number {\n  return x;\n}\n";
const HELPER_HEAD =
  "export function sharedHelper(x: number): number {\n  return x + 1;\n}\n";

Deno.test("collectCallerChecks lists exactly the existing caller line, not imports, tests, docs, comments or in-diff lines", async () => {
  const fx = await setupGitRepoFixture("issue-3779-");
  try {
    const base = await commitFiles(fx.clone, {
      "lib/helper.ts": HELPER_BASE,
      "lib/caller_a.ts":
        'import { sharedHelper } from "./helper.ts";\nexport const viaA = sharedHelper(1);\n// sharedHelper is documented here\n',
      "tests/helper_test.ts":
        'import { sharedHelper } from "../lib/helper.ts";\nsharedHelper(2);\n',
      "docs/x.md": "sharedHelper is described here.\n",
    }, "base");
    const head = await commitFiles(fx.clone, {
      "lib/helper.ts": HELPER_HEAD,
      "lib/caller_b.ts":
        'import { sharedHelper } from "./helper.ts";\nexport const viaB = sharedHelper(3);\n',
    }, "head");
    const r = await collectCallerChecks(git, fx.clone, base, head);
    assert(r.ok, JSON.stringify(r));
    assertEquals(r.state, {
      expected: [{
        symbol: "sharedHelper",
        definedAt: "lib/helper.ts:1",
        caller: "lib/caller_a.ts:2",
      }],
      notes: [],
    });
  } finally {
    await fx.cleanup();
  }
});

Deno.test("collectCallerChecks skips a bare name in a multi-line import or export list, but not a real call", async () => {
  const fx = await setupGitRepoFixture("issue-3779-bare-");
  try {
    const base = await commitFiles(fx.clone, {
      "lib/helper.ts": HELPER_BASE,
      "lib/lists.ts": [
        "import {",
        "  sharedHelper,",
        '} from "./helper.ts";',
        "export {",
        "  type sharedHelper,",
        "};",
        "export const viaLists = sharedHelper(1);",
        "",
      ].join("\n"),
    }, "base");
    const head = await commitFiles(fx.clone, {
      "lib/helper.ts": HELPER_HEAD,
    }, "head");
    const r = await collectCallerChecks(git, fx.clone, base, head);
    assert(r.ok, JSON.stringify(r));
    assertEquals(r.state.expected, [{
      symbol: "sharedHelper",
      definedAt: "lib/helper.ts:1",
      caller: "lib/lists.ts:7",
    }]);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("collectCallerChecks lists at most ten callers and notes the rest", async () => {
  const fx = await setupGitRepoFixture("issue-3779-cap-");
  try {
    const many = Array.from(
      { length: 12 },
      (_, i) => `export const c${i + 1} = sharedHelper(${i + 1});\n`,
    ).join("");
    const base = await commitFiles(fx.clone, {
      "lib/helper.ts": HELPER_BASE,
      "lib/many.ts": many,
    }, "base");
    const head = await commitFiles(fx.clone, {
      "lib/helper.ts": HELPER_HEAD,
    }, "head");
    const r = await collectCallerChecks(git, fx.clone, base, head);
    assert(r.ok, JSON.stringify(r));
    assertEquals(r.state.expected.length, MAX_CALLERS_PER_SYMBOL);
    assertEquals(
      r.state.expected.map((e) => e.caller),
      Array.from(
        { length: MAX_CALLERS_PER_SYMBOL },
        (_, i) => `lib/many.ts:${i + 1}`,
      ),
    );
    assertEquals(r.state.notes, [
      "2 more caller(s) of `sharedHelper` not listed",
    ]);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("collectCallerChecks notes the changed functions it stopped searching at the cap", async () => {
  const fx = await setupGitRepoFixture("issue-3779-unsearched-");
  try {
    // One more changed function than the search cap, none of them called.
    const names = Array.from(
      { length: MAX_SYMBOLS_SEARCHED + 1 },
      (_, i) => `fn${String(i + 1).padStart(2, "0")}`,
    );
    const body = (v: number) =>
      names.map((n) =>
        `export function ${n}(x: number): number {\n  return x + ${v};\n}\n`
      ).join("");
    const base = await commitFiles(fx.clone, {
      "lib/funcs.ts": body(0),
    }, "base");
    const head = await commitFiles(fx.clone, {
      "lib/funcs.ts": body(1),
    }, "head");
    const r = await collectCallerChecks(git, fx.clone, base, head);
    assert(r.ok, JSON.stringify(r));
    assertEquals(r.state.expected, []);
    assertEquals(r.state.notes, [
      "1 more changed function(s) were not searched for callers",
    ]);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("collectCallerChecks lists nothing when the change touches only tests and docs", async () => {
  const fx = await setupGitRepoFixture("issue-3779-docs-");
  try {
    const base = await commitFiles(fx.clone, {
      "lib/helper.ts": HELPER_BASE,
      "tests/helper_test.ts": "sharedHelper(2);\n",
      "docs/x.md": "old\n",
    }, "base");
    const head = await commitFiles(fx.clone, {
      "tests/helper_test.ts": "sharedHelper(3);\n",
      "docs/x.md": "new\n",
    }, "head");
    const r = await collectCallerChecks(git, fx.clone, base, head);
    assertEquals(r, { ok: true, state: { expected: [], notes: [] } });
  } finally {
    await fx.cleanup();
  }
});

Deno.test("collectCallerChecks fails with git's own cause when a sha does not resolve", async () => {
  const fx = await setupGitRepoFixture("issue-3779-bad-");
  try {
    await commitFiles(fx.clone, {
      "lib/helper.ts": HELPER_BASE,
    }, "base");
    const head = await commitFiles(fx.clone, {
      "lib/helper.ts": HELPER_HEAD,
    }, "head");
    const bad = "0123456789abcdef0123456789abcdef01234567";
    const real = await git(
      ["diff", "-U0", "--no-color", "--no-ext-diff", `${bad}...${head}`],
      fx.clone,
    );
    const cause = real.stderr.split("\n").map((l) => l.trim()).find((l) =>
      l !== ""
    )!;
    const r = await collectCallerChecks(git, fx.clone, bad, head);
    assertEquals(r.ok, false);
    if (!r.ok) {
      assertStringIncludes(r.reason, "git diff failed");
      assertStringIncludes(r.reason, cause.slice(0, 40));
    }
  } finally {
    await fx.cleanup();
  }
});

Deno.test("collectCallerChecks reports a git that cannot be spawned as not checked", async () => {
  const r = await collectCallerChecks(
    () => Promise.resolve(null),
    "/nonexistent",
    "a",
    "b",
  );
  assertEquals(r.ok, false);
  if (!r.ok) assertStringIncludes(r.reason, "could not be spawned");
});

// ---- rendering --------------------------------------------------------------

Deno.test("renderCallerCheckSection is empty when there is nothing to check", () => {
  assertEquals(
    renderCallerCheckSection({ expected: [], notes: [] }, "0123456789ab"),
    [],
  );
});

Deno.test("renderCallerCheckSection instructs a verdict per caller and fences the list", () => {
  const lines = renderCallerCheckSection(
    {
      expected: [{
        symbol: "sharedHelper",
        definedAt: "lib/helper.ts:1",
        caller: "lib/caller.ts:2",
      }],
      notes: ["2 more caller(s) of `sharedHelper` not listed"],
    },
    "0123456789ab",
  );
  const text = lines.join("\n");
  assertStringIncludes(text, "### Existing callers of changed functions");
  assertStringIncludes(text, "`callers` array");
  assertStringIncludes(
    text,
    "Add a `callers` key to the reply JSON the brief asks for (beside `checklist`), holding one entry per caller below: {...}.",
  );
  assertStringIncludes(text, "BLOCKING");
  const label = text.indexOf("Existing callers to report:");
  const item = text.indexOf(
    "- `sharedHelper` (defined at `lib/helper.ts:1`): caller `lib/caller.ts:2`",
  );
  const end = text.indexOf("END UNTRUSTED USER CONTENT");
  assert(label > 0 && item > label && item < end, "the list is fenced");
  assert(
    text.indexOf("`callers` array") < label,
    "the instruction sits outside the fence",
  );
  assertStringIncludes(text, "- Note: 2 more caller(s)");
});

// ---- parseCallerVerdicts ----------------------------------------------------

const VERDICT: CallerVerdict = {
  symbol: "sharedHelper",
  caller: "lib/caller.ts:2",
  verdict: "unchanged",
  note: "reads only the sign",
};

Deno.test("CALLER_VERDICTS is exactly unchanged, changed and tested, regressed", () => {
  assertEquals(CALLER_VERDICTS, ["unchanged", "changed and tested", "regressed"]);
});

Deno.test("parseCallerVerdicts accepts an absent list and each valid verdict", () => {
  assertEquals(parseCallerVerdicts(undefined), []);
  assertEquals(parseCallerVerdicts(null), []);
  assertEquals(
    parseCallerVerdicts(
      CALLER_VERDICTS.map((verdict) => ({ ...VERDICT, verdict })),
    ).map((v) => v.verdict),
    [...CALLER_VERDICTS],
  );
});

Deno.test("parseCallerVerdicts rejects a non-array, a non-object, a missing field or a bad verdict, naming the index", () => {
  const rejects: Array<[unknown, string]> = [
    ["nope", "not an array"],
    [[VERDICT, "junk"], "callers[1] is not an object"],
    [[{ ...VERDICT, symbol: "" }], 'callers[0] lacks a non-empty "symbol"'],
    [[{ ...VERDICT, note: undefined }], 'callers[0] lacks a non-empty "note"'],
    [[{ ...VERDICT, verdict: "probably" }], "callers[0] has verdict"],
  ];
  for (const [value, message] of rejects) {
    let thrown: unknown = null;
    try {
      parseCallerVerdicts(value);
    } catch (error) {
      thrown = error;
    }
    assert(thrown instanceof Error, `expected a throw for ${message}`);
    assertStringIncludes((thrown as Error).message, message);
  }
});

// ---- callerGapFindings ------------------------------------------------------

const STATE: CallerCheckState = {
  expected: [{
    symbol: "sharedHelper",
    definedAt: "lib/helper.ts:1",
    caller: "lib/caller.ts:2",
  }],
  notes: [],
};

Deno.test("callerGapFindings: a missing verdict is one finding naming the caller", () => {
  const f = callerGapFindings(STATE, []);
  assertEquals(f.length, 1);
  assertEquals(f[0]!.file, "lib/helper.ts");
  assertEquals(f[0]!.line, 1);
  assertStringIncludes(f[0]!.problem, "lib/caller.ts:2");
  assertStringIncludes(f[0]!.problem, "sharedHelper");
});

Deno.test("callerGapFindings: a verdict for each caller leaves no finding", () => {
  assertEquals(callerGapFindings(STATE, [VERDICT]), []);
});

Deno.test("callerGapFindings: a verdict for a different caller does not satisfy the expectation", () => {
  const f = callerGapFindings(STATE, [{
    ...VERDICT,
    caller: "lib/other.ts:9",
  }]);
  assertEquals(f.length, 1);
  assertStringIncludes(f[0]!.problem, "lib/caller.ts:2");
});

Deno.test("callerGapFindings: the match ignores backticks, case and a leading ./", () => {
  assertEquals(
    callerGapFindings(STATE, [{
      ...VERDICT,
      symbol: "`sharedHelper`",
      caller: "./LIB/caller.ts:2",
    }]),
    [],
  );
});

Deno.test("callerGapFindings: a regressed verdict is a finding on the caller's file and line, with the note", () => {
  const f = callerGapFindings(STATE, [{
    ...VERDICT,
    verdict: "regressed",
    note: "drops the sign",
  }]);
  assertEquals(f.length, 1);
  assertEquals(f[0]!.file, "lib/caller.ts");
  assertEquals(f[0]!.line, 2);
  assertStringIncludes(f[0]!.problem, "regresses under the changed result");
  assertStringIncludes(f[0]!.problem, "drops the sign");
  assertStringIncludes(f[0]!.fix, "add a test");
});

Deno.test("callerGapFindings: a regressed verdict for an unexpected caller is still a finding", () => {
  const f = callerGapFindings({ expected: [], notes: [] }, [{
    ...VERDICT,
    caller: "lib/elsewhere.ts:40",
    verdict: "regressed",
  }]);
  assertEquals(f.map((x) => [x.file, x.line]), [["lib/elsewhere.ts", 40]]);
});

Deno.test("callerGapFindings: unchanged and changed-and-tested verdicts are never findings", () => {
  assertEquals(
    callerGapFindings(STATE, [{
      ...VERDICT,
      verdict: "changed and tested",
      note: "lib/caller_test.ts exercises it",
    }]),
    [],
  );
});
