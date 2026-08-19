/**
 * Tests for the coverage-gap scanner (Issue #2916, parent #2903).
 *
 * Covers the coverage-gap path end-to-end against a stubbed workspace:
 *   - `parseExportedFunctions` enumerates exported functions from both
 *     the Deno 2.x object-nodes shape and the older flat-array shape,
 *     normalises file URLs to repo-relative paths, and 0-based lines to
 *     1-based;
 *   - `symbolHasTest` is whole-word and rejects substring matches;
 *   - `isTestPath` recognises the test-file markers;
 *   - `findCoverageGaps` flags exported functions with no referencing
 *     test, ignores covered ones, skips functions declared in test files,
 *     and is best-effort on tooling failure;
 *   - `renderCoverageGaps` renders the prompt substitution, capped at
 *     `COVERAGE_GAP_RENDER_LIMIT` with the total count kept (Issue
 *     #3809 — an unbounded list is an arbitrarily long injected
 *     document).
 *
 * Both external interactions are stubbed (`denoDocFn`,
 * `collectTestSourcesFn`) so no subprocess runs and the "workspace" is
 * pure in-memory data.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  COVERAGE_GAP_RENDER_LIMIT,
  type CoverageGap,
  findCoverageGaps,
  isTestPath,
  parseExportedFunctions,
  renderCoverageGaps,
  symbolHasTest,
} from "../lib/coverage_gap_scanner.ts";

const WORK_DIR = "/tmp/repo";

/** Build a Deno 2.x object-nodes `deno doc --json` payload. */
function denoDocV2(
  decls: Array<{ name: string; file: string; line: number; kind?: string }>,
): string {
  const nodes: Record<string, { symbols: unknown[] }> = {};
  for (const d of decls) {
    const url = `file://${WORK_DIR}/${d.file}`;
    nodes[url] ??= { symbols: [] };
    nodes[url].symbols.push({
      name: d.name,
      declarations: [
        {
          location: { filename: url, line: d.line, col: 0 },
          declarationKind: "export",
          kind: d.kind ?? "function",
        },
      ],
    });
  }
  return JSON.stringify({ version: 2, nodes });
}

// ---------------------------------------------------------------------------
// parseExportedFunctions
// ---------------------------------------------------------------------------

Deno.test("parseExportedFunctions - object-nodes shape, relative path, 1-based line", () => {
  const json = denoDocV2([
    { name: "alpha", file: "lib/a.ts", line: 0 },
    { name: "beta", file: "lib/a.ts", line: 4 },
  ]);
  const fns = parseExportedFunctions(json, WORK_DIR);
  assertEquals(fns, [
    { symbol: "alpha", file: "lib/a.ts", line: 1 },
    { symbol: "beta", file: "lib/a.ts", line: 5 },
  ]);
});

Deno.test("parseExportedFunctions - flat-array shape", () => {
  const json = JSON.stringify([
    {
      name: "gamma",
      kind: "function",
      declarationKind: "export",
      location: { filename: `file://${WORK_DIR}/lib/g.ts`, line: 9 },
    },
  ]);
  const fns = parseExportedFunctions(json, WORK_DIR);
  assertEquals(fns, [{ symbol: "gamma", file: "lib/g.ts", line: 10 }]);
});

Deno.test("parseExportedFunctions - ignores non-function and non-export symbols", () => {
  const json = denoDocV2([
    { name: "MyClass", file: "lib/c.ts", line: 0, kind: "class" },
    { name: "pubFn", file: "lib/c.ts", line: 2, kind: "function" },
  ]);
  const fns = parseExportedFunctions(json, WORK_DIR);
  assertEquals(fns.map((f) => f.symbol), ["pubFn"]);
});

Deno.test("parseExportedFunctions - malformed JSON yields empty list", () => {
  assertEquals(parseExportedFunctions("not json", WORK_DIR), []);
  assertEquals(parseExportedFunctions("", WORK_DIR), []);
});

// ---------------------------------------------------------------------------
// symbolHasTest / isTestPath
// ---------------------------------------------------------------------------

Deno.test("symbolHasTest - whole-word match only", () => {
  assert(symbolHasTest("parse", "the parse(input) call"));
  assert(!symbolHasTest("parse", "parseAll(x) is unrelated"));
  assert(!symbolHasTest("parse", "no reference here"));
});

Deno.test("isTestPath - recognises common test markers", () => {
  assert(isTestPath("worker/deno/tests/foo_test.ts"));
  assert(isTestPath("src/foo.test.ts"));
  assert(isTestPath("e2e/foo.spec.ts"));
  assert(isTestPath("pkg/__tests__/foo.ts"));
  assert(isTestPath("cypress/e2e/login.cy.ts"));
  assert(!isTestPath("lib/foo.ts"));
});

// ---------------------------------------------------------------------------
// findCoverageGaps
// ---------------------------------------------------------------------------

Deno.test("findCoverageGaps - flags untested public functions, ignores covered ones", async () => {
  const docJson = denoDocV2([
    { name: "covered", file: "lib/a.ts", line: 0 },
    { name: "untested", file: "lib/a.ts", line: 5 },
  ]);
  const gaps = await findCoverageGaps({
    workDir: WORK_DIR,
    denoDocFn: () => Promise.resolve(docJson),
    collectTestSourcesFn: () =>
      Promise.resolve("Deno.test('x', () => { covered(); });"),
  });
  assertEquals(gaps, [{ symbol: "untested", file: "lib/a.ts", line: 6 }]);
});

Deno.test("findCoverageGaps - skips functions declared inside test files", async () => {
  const docJson = denoDocV2([
    { name: "helperInTest", file: "tests/util_test.ts", line: 0 },
  ]);
  const gaps = await findCoverageGaps({
    workDir: WORK_DIR,
    denoDocFn: () => Promise.resolve(docJson),
    collectTestSourcesFn: () => Promise.resolve(""),
  });
  assertEquals(gaps, []);
});

Deno.test("findCoverageGaps - best-effort: deno doc failure yields no gaps", async () => {
  const gaps = await findCoverageGaps({
    workDir: WORK_DIR,
    denoDocFn: () => Promise.reject(new Error("deno doc exploded")),
    collectTestSourcesFn: () => Promise.resolve(""),
  });
  assertEquals(gaps, []);
});

Deno.test("findCoverageGaps - no exported functions yields no gaps", async () => {
  const gaps = await findCoverageGaps({
    workDir: WORK_DIR,
    denoDocFn: () => Promise.resolve(denoDocV2([])),
    collectTestSourcesFn: () => Promise.resolve("anything"),
  });
  assertEquals(gaps, []);
});

// ---------------------------------------------------------------------------
// renderCoverageGaps
// ---------------------------------------------------------------------------

Deno.test("renderCoverageGaps - empty list renders the (none) sentinel", () => {
  assertEquals(renderCoverageGaps([]), "(none)");
});

Deno.test("renderCoverageGaps - renders file:line — symbol lines", () => {
  const gaps: CoverageGap[] = [
    { symbol: "untested", file: "lib/a.ts", line: 6 },
    { symbol: "alsoUntested", file: "lib/b.ts", line: 2 },
  ];
  assertEquals(
    renderCoverageGaps(gaps),
    "- lib/a.ts:6 — untested\n- lib/b.ts:2 — alsoUntested",
  );
});

// --- the rendered list is capped (Issue #3809) ---

/** `count` synthetic gaps, one per file, for the cap tests. */
function syntheticGaps(count: number): CoverageGap[] {
  return Array.from({ length: count }, (_, i) => ({
    symbol: `sym${i}`,
    file: `lib/f${i}.ts`,
    line: i + 1,
  }));
}

Deno.test("renderCoverageGaps - a list at the cap renders every gap and no truncation line", () => {
  const rendered = renderCoverageGaps(syntheticGaps(COVERAGE_GAP_RENDER_LIMIT));
  const lines = rendered.split("\n");
  assertEquals(lines.length, COVERAGE_GAP_RENDER_LIMIT);
  assertEquals(lines[0], "- lib/f0.ts:1 — sym0");
  assertEquals(rendered.includes("showing"), false);
});

Deno.test("renderCoverageGaps - an over-cap list keeps the top N and states the total", () => {
  const total = COVERAGE_GAP_RENDER_LIMIT + 7;
  const rendered = renderCoverageGaps(syntheticGaps(total));
  const lines = rendered.split("\n");

  // Top N in list order, plus one trailing truncation line.
  assertEquals(lines.length, COVERAGE_GAP_RENDER_LIMIT + 1);
  assertEquals(lines[0], "- lib/f0.ts:1 — sym0");
  assertEquals(
    lines[COVERAGE_GAP_RENDER_LIMIT - 1],
    `- lib/f${
      COVERAGE_GAP_RENDER_LIMIT - 1
    }.ts:${COVERAGE_GAP_RENDER_LIMIT} — ` +
      `sym${COVERAGE_GAP_RENDER_LIMIT - 1}`,
  );

  // The truncation is stated loudly, with both counts (Issue #3234).
  const last = lines[COVERAGE_GAP_RENDER_LIMIT] ?? "";
  assertStringIncludes(
    last,
    `showing ${COVERAGE_GAP_RENDER_LIMIT} of ${total}`,
  );

  // The dropped gaps are genuinely absent, not silently mangled.
  assertEquals(rendered.includes(`sym${total - 1}`), false);
});
