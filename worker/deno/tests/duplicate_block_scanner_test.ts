/**
 * Tests for the duplicate-block pre-pass used by the duplicated-knowledge
 * idle-task scan (stSoftwareAU/VibeCoder#3609).
 *
 * Coverage:
 *   - `isScannablePath` — code files in, tests / vendored / non-code out.
 *   - `significantLines` — blank, comment-only, and punctuation-only lines
 *     are dropped; whitespace is collapsed; original line numbers survive.
 *   - `findDuplicateBlocksIn` — happy path (a block shared by two files),
 *     error/edge paths (no duplicates, below the window threshold, unicode,
 *     empty input), two copies inside one file, greedy extension of a long
 *     clone into a single block, and the `maxBlocks` cap.
 *   - `renderDuplicateBlocks` — the `(none)` sentinel and the rendered form.
 *   - `findDuplicateBlocks` — end-to-end with an injected collector, and the
 *     best-effort empty result when the collector throws.
 *
 * Australian English spelling used throughout (behaviour, normalise).
 */

import { assert, assertEquals } from "@std/assert";

import {
  type DuplicateBlock,
  findDuplicateBlocks,
  findDuplicateBlocksIn,
  isScannablePath,
  renderDuplicateBlocks,
  significantLines,
  type SourceFile,
} from "../lib/duplicate_block_scanner.ts";

/** A five-line body of real-looking logic (the minimum clone size). */
const BODY = [
  "const trimmed = value.trim();",
  "if (trimmed.length === 0) return null;",
  "const parsed = Number(trimmed);",
  "if (Number.isNaN(parsed)) return null;",
  "return Math.min(parsed, MAX);",
];

// ---------------------------------------------------------------------------
// isScannablePath
// ---------------------------------------------------------------------------

Deno.test("isScannablePath - code files are scanned", () => {
  assertEquals(isScannablePath("lib/parser.ts"), true);
  assertEquals(isScannablePath("src/main.py"), true);
  assertEquals(isScannablePath("scripts/deploy.sh"), true);
});

Deno.test("isScannablePath - test sources are excluded", () => {
  // Test scaffolding is structurally repetitive by nature — the prompt is
  // told to stay silent on it, so the pre-pass never surfaces it.
  assertEquals(isScannablePath("lib/parser_test.ts"), false);
  assertEquals(isScannablePath("tests/parser.ts"), false);
  assertEquals(isScannablePath("src/parser.spec.ts"), false);
});

Deno.test("isScannablePath - vendored, generated, and non-code paths are excluded", () => {
  assertEquals(isScannablePath("node_modules/left-pad/index.js"), false);
  assertEquals(isScannablePath("vendor/lib/thing.go"), false);
  assertEquals(isScannablePath("dist/bundle.min.js"), false);
  assertEquals(isScannablePath("README.md"), false);
  assertEquals(isScannablePath("deno.lock"), false);
});

// ---------------------------------------------------------------------------
// significantLines
// ---------------------------------------------------------------------------

Deno.test("significantLines - drops blank, comment-only, and punctuation-only lines", () => {
  const source = [
    "function add(a, b) {", // 1
    "", // 2 — blank
    "  // adds two numbers", // 3 — comment only
    "  return   a +  b;", // 4
    "}", // 5 — punctuation only
    "# shell-style comment", // 6
  ].join("\n");

  assertEquals(significantLines(source), [
    { text: "function add(a, b) {", line: 1 },
    { text: "return a + b;", line: 4 },
  ]);
});

Deno.test("significantLines - empty source yields no lines", () => {
  assertEquals(significantLines(""), []);
});

Deno.test("significantLines - preserves unicode content while collapsing whitespace", () => {
  assertEquals(significantLines('const msg = "café   ☕";'), [
    { text: 'const msg = "café ☕";', line: 1 },
  ]);
});

// ---------------------------------------------------------------------------
// findDuplicateBlocksIn — happy path
// ---------------------------------------------------------------------------

Deno.test("findDuplicateBlocksIn - reports a block shared by two files", () => {
  const files: SourceFile[] = [
    { file: "lib/a.ts", content: ["const a = 1;", ...BODY].join("\n") },
    {
      file: "lib/b.ts",
      content: ["const b = 1;", "const c = 2;", ...BODY].join("\n"),
    },
  ];

  const blocks = findDuplicateBlocksIn(files);
  assertEquals(blocks.length, 1);
  const block = blocks[0] as DuplicateBlock;
  assertEquals(block.lineCount, 5);
  assertEquals(block.sites, [
    { file: "lib/a.ts", startLine: 2, endLine: 6 },
    { file: "lib/b.ts", startLine: 3, endLine: 7 },
  ]);
});

Deno.test("findDuplicateBlocksIn - indentation and comment differences do not break a clone", () => {
  const files: SourceFile[] = [
    { file: "lib/a.ts", content: BODY.join("\n") },
    {
      file: "lib/b.ts",
      content: BODY.map((
        l,
        i,
      ) => (i === 2 ? `    // note\n\t${l}` : `    ${l}`))
        .join("\n"),
    },
  ];

  const blocks = findDuplicateBlocksIn(files);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0]?.sites.length, 2);
});

// ---------------------------------------------------------------------------
// findDuplicateBlocksIn — silence
// ---------------------------------------------------------------------------

Deno.test("findDuplicateBlocksIn - no duplication reports nothing", () => {
  const files: SourceFile[] = [
    { file: "lib/a.ts", content: BODY.join("\n") },
    { file: "lib/b.ts", content: BODY.map((l) => `x${l}`).join("\n") },
  ];
  assertEquals(findDuplicateBlocksIn(files), []);
});

Deno.test("findDuplicateBlocksIn - a shared run shorter than the window is ignored", () => {
  const short = BODY.slice(0, 4);
  const files: SourceFile[] = [
    { file: "lib/a.ts", content: short.join("\n") },
    { file: "lib/b.ts", content: short.join("\n") },
  ];
  assertEquals(findDuplicateBlocksIn(files), []);
});

Deno.test("findDuplicateBlocksIn - empty input yields no blocks", () => {
  assertEquals(findDuplicateBlocksIn([]), []);
});

// ---------------------------------------------------------------------------
// findDuplicateBlocksIn — grouping behaviour
// ---------------------------------------------------------------------------

Deno.test("findDuplicateBlocksIn - two copies within one file are one block with two sites", () => {
  const content = [...BODY, "const separator = true;", ...BODY].join("\n");
  const blocks = findDuplicateBlocksIn([{ file: "lib/a.ts", content }]);

  assertEquals(blocks.length, 1);
  assertEquals(blocks[0]?.sites, [
    { file: "lib/a.ts", startLine: 1, endLine: 5 },
    { file: "lib/a.ts", startLine: 7, endLine: 11 },
  ]);
});

Deno.test("findDuplicateBlocksIn - a long clone is reported once, extended to its full length", () => {
  const long = [...BODY, ...BODY.map((l) => `const x = ${l}`)];
  const files: SourceFile[] = [
    { file: "lib/a.ts", content: long.join("\n") },
    { file: "lib/b.ts", content: long.join("\n") },
  ];

  const blocks = findDuplicateBlocksIn(files);
  // Ten identical lines are ONE finding, not six overlapping windows.
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0]?.lineCount, 10);
  assertEquals(blocks[0]?.sites, [
    { file: "lib/a.ts", startLine: 1, endLine: 10 },
    { file: "lib/b.ts", startLine: 1, endLine: 10 },
  ]);
});

Deno.test("findDuplicateBlocksIn - three copies are reported as three sites", () => {
  const files: SourceFile[] = ["a", "b", "c"].map((n) => ({
    file: `lib/${n}.ts`,
    content: BODY.join("\n"),
  }));
  const blocks = findDuplicateBlocksIn(files);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0]?.sites.map((s) => s.file), [
    "lib/a.ts",
    "lib/b.ts",
    "lib/c.ts",
  ]);
});

Deno.test("findDuplicateBlocksIn - honours the maxBlocks cap, largest clone first", () => {
  const small = [
    "let p = 1;",
    "let q = 2;",
    "let r = 3;",
    "let s = 4;",
    "let t = 5;",
  ];
  const big = [...BODY, ...BODY.map((l) => `const y = ${l}`)];
  const files: SourceFile[] = [
    {
      file: "lib/a.ts",
      content: [...small, "const gap = 0;", ...big].join("\n"),
    },
    {
      file: "lib/b.ts",
      content: [...small, "const gap = 1;", ...big].join("\n"),
    },
  ];

  const capped = findDuplicateBlocksIn(files, { maxBlocks: 1 });
  assertEquals(capped.length, 1);
  // The larger clone outranks the smaller one.
  assertEquals(capped[0]?.lineCount, 10);
  assertEquals(findDuplicateBlocksIn(files).length, 2);
});

// ---------------------------------------------------------------------------
// renderDuplicateBlocks
// ---------------------------------------------------------------------------

Deno.test("renderDuplicateBlocks - empty list renders the (none) sentinel", () => {
  assertEquals(renderDuplicateBlocks([]), "(none)");
});

// Prompt v3 (Issue #3781) addresses candidates by index, so the renderer
// emits one indexed `<candidate>` element per block instead of a bullet.
Deno.test("renderDuplicateBlocks - renders one indexed candidate per block", () => {
  const rendered = renderDuplicateBlocks([
    {
      lineCount: 7,
      sites: [
        { file: "lib/a.ts", startLine: 10, endLine: 18 },
        { file: "lib/b.ts", startLine: 3, endLine: 11 },
      ],
    },
    {
      lineCount: 5,
      sites: [
        { file: "lib/c.ts", startLine: 1, endLine: 5 },
        { file: "lib/d.ts", startLine: 40, endLine: 44 },
      ],
    },
  ]);
  assertEquals(
    rendered,
    [
      '<candidate index="1" lines="7" site_count="2">',
      "<sites>lib/a.ts:10-18, lib/b.ts:3-11</sites>",
      "</candidate>",
      '<candidate index="2" lines="5" site_count="2">',
      "<sites>lib/c.ts:1-5, lib/d.ts:40-44</sites>",
      "</candidate>",
    ].join("\n"),
  );
});

// ---------------------------------------------------------------------------
// findDuplicateBlocks — async wrapper
// ---------------------------------------------------------------------------

Deno.test("findDuplicateBlocks - uses the injected collector", async () => {
  const blocks = await findDuplicateBlocks({
    workDir: "/tmp/repo",
    collectSourcesFn: () =>
      Promise.resolve([
        { file: "lib/a.ts", content: BODY.join("\n") },
        { file: "lib/b.ts", content: BODY.join("\n") },
      ]),
  });
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0]?.sites.length, 2);
});

Deno.test("findDuplicateBlocks - a collector failure yields no blocks (best effort)", async () => {
  const blocks = await findDuplicateBlocks({
    workDir: "/tmp/repo",
    collectSourcesFn: () => Promise.reject(new Error("unreadable")),
  });
  assertEquals(blocks, []);
});

Deno.test("findDuplicateBlocks - reads real files from a temporary workspace", async () => {
  const dir = await Deno.makeTempDir({ prefix: "dup-block-scan-" });
  try {
    await Deno.mkdir(`${dir}/lib`, { recursive: true });
    await Deno.writeTextFile(`${dir}/lib/a.ts`, BODY.join("\n"));
    await Deno.writeTextFile(`${dir}/lib/b.ts`, BODY.join("\n"));
    // A test file carrying the same block must NOT be surfaced.
    await Deno.writeTextFile(`${dir}/lib/c_test.ts`, BODY.join("\n"));

    const blocks = await findDuplicateBlocks({ workDir: dir });
    assertEquals(blocks.length, 1);
    assertEquals(blocks[0]?.sites.map((s) => s.file), [
      "lib/a.ts",
      "lib/b.ts",
    ]);
    assert(
      !renderDuplicateBlocks(blocks).includes("c_test.ts"),
      "test sources must never appear in the pre-pass output",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
