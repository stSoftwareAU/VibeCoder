/**
 * Tests for the versioned summary-facts schema (Issue #3534, part of #3396).
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  MAX_ENTRIES,
  MAX_ENTRY_CHARS,
  namedTestPaths,
  parseBranchOutcomes,
  reasonWordCount,
  validateBranchOutcomes,
} from "../lib/branch_outcomes_gate.ts";
import {
  MAX_FACTS_CHARS,
  MAX_FIELD_CHARS,
  MAX_PATH_CHARS,
  namedTestPathsFromFacts,
  parseSummaryFacts,
  renderBranchOutcomes,
  SUMMARY_FACTS_VERSION,
  type SummaryFacts,
} from "../lib/summary_facts.ts";
import { assertLinearGrowth } from "./support/growth.ts";

// deno-lint-ignore no-explicit-any
type Obj = any;

function valid(): Obj {
  return {
    version: 1,
    branchOutcomes: {
      noneAdded: false,
      entries: [
        {
          path: "worker/deno/lib/foo.ts",
          line: 10,
          endLine: 14,
          outcome: "rejects an empty name",
          test: "worker/deno/tests/foo_test.ts",
          testName: "foo rejects empty",
          flipWentRed: "failed before the guard was added",
        },
        {
          path: "worker/deno/lib/bar.ts",
          line: 20,
          outcome: "logs a warning",
          exempt: {
            kind: "untestable",
            reason: "only affects console output",
          },
        },
      ],
    },
  };
}

function parse(obj: unknown) {
  return parseSummaryFacts(JSON.stringify(obj));
}

function errorOf(raw: string | unknown): string {
  const result = typeof raw === "string" ? parseSummaryFacts(raw) : parse(raw);
  assert(!result.ok, "expected rejection");
  return result.error.message;
}

function mutate(fn: (facts: Obj) => void): Obj {
  const facts = valid();
  fn(facts);
  return facts;
}

function okFacts(obj: unknown): SummaryFacts {
  const result = parse(obj);
  assert(result.ok, result.ok ? "" : result.error.message);
  return result.value;
}

Deno.test("limits are pinned", () => {
  assertEquals(MAX_FACTS_CHARS, 100_000);
  assertEquals(MAX_FIELD_CHARS, 1_000);
  assertEquals(MAX_PATH_CHARS, 300);
  assertEquals(SUMMARY_FACTS_VERSION, 1);
});

Deno.test("reasonWordCount counts only words containing a letter", () => {
  assertEquals(reasonWordCount("only a test"), 3);
  assertEquals(reasonWordCount("1 2 3"), 0);
  assertEquals(reasonWordCount("a b"), 2);
});

Deno.test("happy path: valid facts parse and equal the input", () => {
  assertEquals(okFacts(valid()), valid());
});

Deno.test("happy path: out-of-scope, none, and endLine == line", () => {
  const oos = mutate((f) => {
    f.branchOutcomes.entries[1].exempt.kind = "out-of-scope";
  });
  assertEquals(okFacts(oos), oos);
  const none = { version: 1, branchOutcomes: { noneAdded: true, entries: [] } };
  assertEquals(okFacts(none), none as Obj);
  const same = mutate((f) => {
    f.branchOutcomes.entries[0].endLine = 10;
  });
  assertEquals(okFacts(same), same);
});

Deno.test("parse returns a fresh object with only known fields", () => {
  const input = valid();
  const result = parse(input);
  assert(result.ok);
  assertEquals(Object.keys(result.value), ["version", "branchOutcomes"]);
});

const E = "branchOutcomes.entries[0]";
const E1 = "branchOutcomes.entries[1]";

const rejections: Array<[string, string | unknown, string]> = [
  ["invalid JSON", "{not json", "facts: invalid JSON"],
  ["array top level", "[]", "facts: expected an object"],
  ["null top level", "null", "facts: expected an object"],
  [
    "version 2",
    mutate((f) => f.version = 2),
    "version: unsupported version (expected 1)",
  ],
  [
    "version string",
    mutate((f) => f.version = "1"),
    "version: unsupported version (expected 1)",
  ],
  [
    "unknown top-level key",
    mutate((f) => f.extra = 1),
    'facts["extra"]: unknown key',
  ],
  [
    "unknown branchOutcomes key",
    mutate((f) => f.branchOutcomes.extra = 1),
    'branchOutcomes["extra"]: unknown key',
  ],
  [
    "unknown entry key",
    mutate((f) => f.branchOutcomes.entries[0].extra = 1),
    `${E}["extra"]: unknown key`,
  ],
  [
    "unknown exempt key",
    mutate((f) => f.branchOutcomes.entries[1].exempt.extra = 1),
    `${E1}.exempt["extra"]: unknown key`,
  ],
  [
    "missing version",
    { branchOutcomes: valid().branchOutcomes },
    "version: required",
  ],
  [
    "missing entries",
    { version: 1, branchOutcomes: { noneAdded: true } },
    "branchOutcomes.entries: required",
  ],
  [
    "line as string",
    mutate((f) => f.branchOutcomes.entries[0].line = "10"),
    `${E}.line: expected a number`,
  ],
  [
    "noneAdded as string",
    mutate((f) => f.branchOutcomes.noneAdded = "false"),
    "branchOutcomes.noneAdded: expected a boolean",
  ],
  [
    "entries as object",
    mutate((f) => f.branchOutcomes.entries = {}),
    "branchOutcomes.entries: expected an array",
  ],
  [
    "outcome as number",
    mutate((f) => f.branchOutcomes.entries[0].outcome = 5),
    `${E}.outcome: expected a string`,
  ],
  [
    "entry as array",
    mutate((f) => f.branchOutcomes.entries[0] = []),
    `${E}: expected an object`,
  ],
  [
    "over-cap file (checked before parse)",
    "x".repeat(MAX_FACTS_CHARS + 1),
    "facts: exceeds 100000 chars",
  ],
  [
    "over-cap entries",
    mutate((f) => {
      f.branchOutcomes.entries = Array.from(
        { length: MAX_ENTRIES + 1 },
        () => valid().branchOutcomes.entries[0],
      );
    }),
    "branchOutcomes.entries: exceeds 100 entries",
  ],
  [
    "over-cap string",
    mutate((f) =>
      f.branchOutcomes.entries[0].outcome = "a".repeat(MAX_FIELD_CHARS + 1)
    ),
    `${E}.outcome: exceeds 1000 chars`,
  ],
  [
    "noneAdded true with entries",
    mutate((f) => f.branchOutcomes.noneAdded = true),
    "branchOutcomes.noneAdded: true requires no entries",
  ],
  [
    "noneAdded false with no entries",
    { version: 1, branchOutcomes: { noneAdded: false, entries: [] } },
    "branchOutcomes.noneAdded: false requires at least one entry",
  ],
  [
    "both shapes",
    mutate((f) =>
      f.branchOutcomes.entries[0].exempt = {
        kind: "untestable",
        reason: "a b c",
      }
    ),
    `${E}: give either test, testName and flipWentRed or exempt, not both`,
  ],
  [
    "neither shape",
    mutate((f) => {
      delete f.branchOutcomes.entries[1].exempt;
    }),
    `${E1}: give either test, testName and flipWentRed or exempt`,
  ],
  [
    "partial test shape",
    mutate((f) => delete f.branchOutcomes.entries[0].testName),
    `${E}.testName: required`,
  ],
  [
    "reason under 3 words",
    mutate((f) => f.branchOutcomes.entries[1].exempt.reason = "too short"),
    `${E1}.exempt.reason: needs at least 3 words`,
  ],
  [
    "non-test test path",
    mutate((f) => f.branchOutcomes.entries[0].test = "worker/deno/lib/foo.ts"),
    `${E}.test: not a test file path`,
  ],
  [
    "test without extension",
    mutate((f) =>
      f.branchOutcomes.entries[0].test = "worker/deno/tests/foo_test"
    ),
    `${E}.test: must end with a file extension`,
  ],
  [
    "dot-dot segment",
    mutate((f) => f.branchOutcomes.entries[0].path = "a/../b.ts"),
    `${E}.path: must not contain a .. segment`,
  ],
  [
    "leading slash",
    mutate((f) => f.branchOutcomes.entries[0].path = "/etc/b.ts"),
    `${E}.path: must be repo-relative`,
  ],
  [
    "empty segment",
    mutate((f) => f.branchOutcomes.entries[0].path = "a//b.ts"),
    `${E}.path: must not contain an empty segment`,
  ],
  [
    "trailing slash",
    mutate((f) => f.branchOutcomes.entries[0].path = "a/b/"),
    `${E}.path: must not contain an empty segment`,
  ],
  [
    "backtick in path",
    mutate((f) => f.branchOutcomes.entries[0].path = "a`b.ts"),
    `${E}.path: contains characters outside [A-Za-z0-9_.-/]`,
  ],
  [
    "space in path",
    mutate((f) => f.branchOutcomes.entries[0].path = "a b.ts"),
    `${E}.path: contains characters outside [A-Za-z0-9_.-/]`,
  ],
  [
    "over-cap path",
    mutate((f) =>
      f.branchOutcomes.entries[0].path = "a".repeat(MAX_PATH_CHARS + 1)
    ),
    `${E}.path: exceeds 300 chars`,
  ],
  [
    "dot-dot in test",
    mutate((f) => f.branchOutcomes.entries[0].test = "tests/../x_test.ts"),
    `${E}.test: must not contain a .. segment`,
  ],
  [
    "line 0",
    mutate((f) => f.branchOutcomes.entries[0].line = 0),
    `${E}.line: must be a positive integer`,
  ],
  [
    "line 1.5",
    mutate((f) => f.branchOutcomes.entries[0].line = 1.5),
    `${E}.line: must be a positive integer`,
  ],
  [
    "endLine below line",
    mutate((f) => f.branchOutcomes.entries[0].endLine = 9),
    `${E}.endLine: must not be less than line`,
  ],
  [
    "bad exempt kind",
    mutate((f) => f.branchOutcomes.entries[1].exempt.kind = "skip"),
    `${E1}.exempt.kind: must be "out-of-scope" or "untestable"`,
  ],
  [
    "newline in outcome",
    mutate((f) => f.branchOutcomes.entries[0].outcome = "a\nb"),
    `${E}.outcome: must be a single line`,
  ],
  [
    "U+2028 in outcome",
    mutate((f) => f.branchOutcomes.entries[0].outcome = "a\u2028b"),
    `${E}.outcome: must be a single line`,
  ],
  [
    "carriage return in reason",
    mutate((f) => f.branchOutcomes.entries[1].exempt.reason = "one two\rthree"),
    `${E1}.exempt.reason: must be a single line`,
  ],
  [
    "empty outcome",
    mutate((f) => f.branchOutcomes.entries[0].outcome = "  "),
    `${E}.outcome: must not be empty`,
  ],
];

for (const [name, input, expected] of rejections) {
  Deno.test(`rejects: ${name}`, () => {
    assertEquals(errorOf(input), expected);
  });
}

Deno.test("hostile key text is capped and quoted, never echoed raw", () => {
  const key = "\n" + "k".repeat(500);
  const message = errorOf({ ...valid(), [key]: 1 });
  assert(message.length < 200, message);
  assert(!message.includes("\n"), message);
});

Deno.test("refusal probes: the same input with the value made legal is accepted", () => {
  for (
    const legal of [
      (f: Obj) => f.branchOutcomes.entries[0].path = "a/b.ts",
      (f: Obj) => f.branchOutcomes.entries[0].path = "a/.b/c..d.ts",
      (f: Obj) => f.branchOutcomes.entries[0].test = "tests/x_test.ts",
      (f: Obj) =>
        f.branchOutcomes.entries[1].exempt.reason = "three whole words",
      (f: Obj) => f.branchOutcomes.entries[0].endLine = 10,
      (f: Obj) =>
        f.branchOutcomes.entries[0].path = "a".repeat(MAX_PATH_CHARS - 3) +
          ".ts",
      (f: Obj) =>
        f.branchOutcomes.entries[0].outcome = "a".repeat(MAX_FIELD_CHARS),
    ]
  ) {
    assert(parse(mutate(legal)).ok);
  }
});

Deno.test("rendered-entry cap: all fields at the cap are rejected, just under passes", () => {
  // Backtick runs grow when fenced, so fields at the cap overflow the entry.
  const big = (n: number, ch: string) => {
    const facts = valid();
    const e = facts.branchOutcomes.entries[0];
    e.outcome = ch.repeat(n);
    e.testName = ch.repeat(n);
    e.flipWentRed = ch.repeat(n);
    return facts;
  };
  assertEquals(
    errorOf(big(MAX_FIELD_CHARS, "`")),
    `${E}: rendered entry exceeds ${MAX_ENTRY_CHARS} chars`,
  );
  const under = parse(big(MAX_FIELD_CHARS, "o"));
  assert(under.ok);
  assert(renderBranchOutcomes(under.value).length < MAX_ENTRY_CHARS + 100);
});

Deno.test("render is deterministic and pinned", () => {
  const facts = okFacts(valid());
  assertEquals(renderBranchOutcomes(facts), renderBranchOutcomes(facts));
  assertEquals(
    renderBranchOutcomes(facts),
    "**Branch outcomes:**\n\n" +
      "- `worker/deno/lib/foo.ts:10-14` — `rejects an empty name` — " +
      "test `worker/deno/tests/foo_test.ts` (`foo rejects empty`) — " +
      "flip: `failed before the guard was added`\n" +
      "- `worker/deno/lib/bar.ts:20` — `logs a warning` — " +
      "exempt (untestable): only affects console output",
  );
  const oos = mutate((f) =>
    f.branchOutcomes.entries[1].exempt.kind = "out-of-scope"
  );
  assert(
    renderBranchOutcomes(okFacts(oos)).endsWith(
      "exempt (out of scope): only affects console output",
    ),
  );
  assertEquals(
    renderBranchOutcomes(
      okFacts({ version: 1, branchOutcomes: { noneAdded: true, entries: [] } }),
    ),
    "Branch outcomes: none added",
  );
});

Deno.test("round trip through parseBranchOutcomes and the gate", () => {
  const facts = okFacts(valid());
  const text = renderBranchOutcomes(facts);
  const record = parseBranchOutcomes(text);
  assertEquals(record.entries.length, facts.branchOutcomes.entries.length);
  assertEquals(namedTestPaths(record), namedTestPathsFromFacts(facts));
  assertEquals(namedTestPathsFromFacts(facts), [
    "worker/deno/tests/foo_test.ts",
  ]);

  const gate = validateBranchOutcomes({
    changedFiles: ["worker/deno/lib/foo.ts"],
    prSummaryContent: text,
    testsAtHead: new Set(["worker/deno/tests/foo_test.ts"]),
  });
  assertEquals(gate.problems, []);
  assert(gate.valid);
  assertEquals(gate.unreachedEntries, []);
});

Deno.test("round trip: exempt out-of-scope entry is not flagged", () => {
  const facts = okFacts(
    mutate((f) => f.branchOutcomes.entries[1].exempt.kind = "out-of-scope"),
  );
  const gate = validateBranchOutcomes({
    changedFiles: ["worker/deno/lib/foo.ts"],
    prSummaryContent: renderBranchOutcomes(facts),
    testsAtHead: new Set(["worker/deno/tests/foo_test.ts"]),
  });
  assertEquals(gate.problems, []);
});

Deno.test("round trip: none added", () => {
  const facts = okFacts({
    version: 1,
    branchOutcomes: { noneAdded: true, entries: [] },
  });
  const record = parseBranchOutcomes(renderBranchOutcomes(facts));
  assert(record.present);
  assert(record.noneDeclared);
  const gate = validateBranchOutcomes({
    changedFiles: ["worker/deno/lib/foo.ts"],
    prSummaryContent: renderBranchOutcomes(facts),
    testsAtHead: new Set(),
  });
  assert(gate.valid);
});

Deno.test("round trip: de-duplicates declared tests in first-seen order", () => {
  const facts = okFacts(mutate((f) => {
    const second = { ...f.branchOutcomes.entries[0], line: 30, endLine: 31 };
    const third = {
      ...f.branchOutcomes.entries[0],
      test: "worker/deno/tests/zed_test.ts",
    };
    f.branchOutcomes.entries.push(second, third);
  }));
  assertEquals(namedTestPathsFromFacts(facts), [
    "worker/deno/tests/foo_test.ts",
    "worker/deno/tests/zed_test.ts",
  ]);
});

function withText(text: string): Obj {
  return mutate((f) => {
    const e = f.branchOutcomes.entries[0];
    e.outcome = text;
    e.testName = text;
    e.flipWentRed = text;
    f.branchOutcomes.entries[1].outcome = text;
    f.branchOutcomes.entries[1].exempt.reason = `${text} and more words`;
  });
}

function assertSafeShape(rendered: string, entries: number) {
  const lines = rendered.split("\n");
  assertEquals(lines.length, entries + 2);
  for (const line of lines.slice(2)) assert(line.startsWith("- "), line);
  for (const line of lines) {
    assert(!line.startsWith("#"), line);
    assert(!line.startsWith("<"), line);
  }
}

Deno.test("hostile allowed strings render as single safe bullets", () => {
  for (
    const text of [
      "# Heading",
      "<!-- comment -->",
      "```",
      "a`b``c",
      "\u0085x\u0085",
      "\u0000x",
      "\ttabbed",
      "`leading",
      "trailing`",
    ]
  ) {
    const facts = okFacts(withText(text));
    const rendered = renderBranchOutcomes(facts);
    assertSafeShape(rendered, 2);
    const record = parseBranchOutcomes(rendered);
    assertEquals(record.entries.length, 2, text);
  }
});

Deno.test("backtick fence is one longer than the longest inner run", () => {
  const rendered = renderBranchOutcomes(okFacts(withText("a`b``c")));
  assert(rendered.includes("(```a`b``c```)"), rendered);
  const edge = renderBranchOutcomes(okFacts(withText("`x")));
  assert(edge.includes("(`` `x ``)"), edge);
});

Deno.test("renderer replaces control characters and line breaks with spaces", () => {
  const facts = valid() as SummaryFacts;
  const e = (facts.branchOutcomes.entries[0]) as Obj;
  e.outcome = "a\nb\r\nc\u2028d\u2029e\u0000f\u0085g\u007fh";
  e.testName = "x\ny";
  const rendered = renderBranchOutcomes(facts);
  assertSafeShape(rendered, 2);
  assert(rendered.includes("`a b  c d e f g h`"), rendered);
  assert(
    // deno-lint-ignore no-control-regex
    !/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/.test(rendered),
  );
});

Deno.test("renderer scales linearly on hostile backtick and control runs", () => {
  const run = (field: "outcome" | "testName") => (input: string) => {
    const facts = valid() as SummaryFacts;
    (facts.branchOutcomes.entries[0] as Obj)[field] = input;
    return renderBranchOutcomes(facts).length;
  };
  const ticks = (n: number) => "`".repeat(n) + "x";
  const ctrl = (n: number) => "\u0001".repeat(n) + "x";
  for (const build of [ticks, ctrl]) {
    const out = assertLinearGrowth(
      "renderBranchOutcomes",
      build,
      run("outcome"),
      { baseChars: 10_000 },
    );
    assert(out > 0);
  }
  assertLinearGrowth("renderBranchOutcomes testName", ticks, run("testName"), {
    baseChars: 10_000,
  });
});

Deno.test("parser scales linearly on a long run of path characters", () => {
  const build = (n: number) => "a".repeat(n);
  assertLinearGrowth(
    "parseSummaryFacts",
    build,
    (input) => parseSummaryFacts(input).ok,
    { baseChars: 10_000 },
  );
});

Deno.test("exempt reason renders as plain text that cannot open a span or comment", () => {
  const facts = okFacts(withText("<!-- open `tick"));
  const bullet = renderBranchOutcomes(facts).split("\n")[3]!;
  const reason = bullet.slice(bullet.indexOf("): ") + 3);
  assertEquals(reason, "&lt;!-- open 'tick and more words");
});
