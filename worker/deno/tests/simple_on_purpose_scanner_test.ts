/**
 * Tests for the report-only SIMPLE-ON-PURPOSE ledger (Issue #4027, group A).
 *
 * Unit tests inject `listFiles` and `readFile`, so they make no assumption
 * about the repository's history. The one test that runs the default lister
 * builds a throwaway `git init` directory.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  parseSimpleOnPurposeMarkers,
  renderSimpleOnPurposeReport,
  scanSimpleOnPurpose,
  type SimpleOnPurposeLedger,
  type SimpleOnPurposeMarker,
} from "../lib/simple_on_purpose_scanner.ts";

/** Scans in-memory files through the injected seams. */
function scanFiles(files: Record<string, string>) {
  return scanSimpleOnPurpose({
    repoPath: "/repo",
    listFiles: () => Promise.resolve(Object.keys(files)),
    readFile: (abs) => {
      const body = files[abs.slice("/repo/".length)];
      return body === undefined
        ? Promise.reject(new Error(`no fixture for ${abs}`))
        : Promise.resolve(body);
    },
  });
}

/** The single marker a snippet holds; fails the test when it holds none. */
function onlyMarker(markers: SimpleOnPurposeMarker[]): SimpleOnPurposeMarker {
  const [m] = markers;
  if (m === undefined) throw new Error("expected one marker");
  return m;
}

Deno.test("parse - em dash, hyphen and en dash all split the ceiling from the clause", () => {
  const text = [
    "// SIMPLE-ON-PURPOSE: one page — upgrade when a repo holds more than 200",
    "const a = 1;",
    "// SIMPLE-ON-PURPOSE: one page - upgrade when a repo holds more than 300",
    "const b = 2;",
    "// SIMPLE-ON-PURPOSE: one page – upgrade when a repo holds more than 400",
  ].join("\n");
  const markers = parseSimpleOnPurposeMarkers("lib/a.ts", text);
  assertEquals(markers.map((m) => m.ceiling), [
    "one page",
    "one page",
    "one page",
  ]);
  assertEquals(markers.map((m) => m.upgradeWhen), [
    "a repo holds more than 200",
    "a repo holds more than 300",
    "a repo holds more than 400",
  ]);
});

Deno.test("parse - path and 1-based line number are reported for the marker", () => {
  const text = [
    "const x = 1;",
    "const y = 2;",
    "",
    "// SIMPLE-ON-PURPOSE: c — upgrade when u",
  ]
    .join("\n");
  assertEquals(parseSimpleOnPurposeMarkers("lib/b.ts", text), [
    { path: "lib/b.ts", line: 4, ceiling: "c", upgradeWhen: "u" },
  ]);
});

Deno.test("parse - a marker with no upgrade clause has upgradeWhen null", () => {
  const m = onlyMarker(parseSimpleOnPurposeMarkers(
    "lib/c.ts",
    "// SIMPLE-ON-PURPOSE: a quadratic scan is fine here",
  ));
  assertEquals(m.ceiling, "a quadratic scan is fine here");
  assertEquals(m.upgradeWhen, null);
});

Deno.test("parse - an empty upgrade clause has upgradeWhen null", () => {
  const m = onlyMarker(
    parseSimpleOnPurposeMarkers(
      "lib/c.ts",
      "// SIMPLE-ON-PURPOSE: c — upgrade when:",
    ),
  );
  assertEquals(m.ceiling, "c");
  assertEquals(m.upgradeWhen, null);
});

Deno.test("parse - a malformed empty-body marker is reported, not thrown", () => {
  const markers = parseSimpleOnPurposeMarkers(
    "lib/d.ts",
    "// SIMPLE-ON-PURPOSE:\n",
  );
  assertEquals(markers, [{
    path: "lib/d.ts",
    line: 1,
    ceiling: "",
    upgradeWhen: null,
  }]);
});

Deno.test("parse - a wrong-case keyword is not a marker", () => {
  assertEquals(
    parseSimpleOnPurposeMarkers(
      "lib/e.ts",
      "// simple-on-purpose: x — upgrade when y",
    ),
    [],
  );
});

Deno.test("parse - a keyword inside a string or mid-line is not a marker", () => {
  const text = [
    'const fixture = "// SIMPLE-ON-PURPOSE: x — upgrade when y";',
    "const a = 1; // SIMPLE-ON-PURPOSE: x — upgrade when y",
    "  prose that mentions SIMPLE-ON-PURPOSE: here",
  ].join("\n");
  assertEquals(parseSimpleOnPurposeMarkers("lib/f.ts", text), []);
});

Deno.test("parse - a wrapped marker reads as one marker and keeps the first line", () => {
  const text = [
    "const x = 1;",
    "// SIMPLE-ON-PURPOSE: native sub-issue counts only — upgrade when",
    "// an inversion alert names a task-list-only parent.",
    "const y = 2;",
  ].join("\n");
  assertEquals(parseSimpleOnPurposeMarkers("lib/g.ts", text), [
    {
      path: "lib/g.ts",
      line: 2,
      ceiling: "native sub-issue counts only",
      upgradeWhen: "an inversion alert names a task-list-only parent.",
    },
  ]);
});

Deno.test("parse - a continuation stops at the next marker, which stays its own marker", () => {
  const text = [
    "// SIMPLE-ON-PURPOSE: first ceiling",
    "// SIMPLE-ON-PURPOSE: second — upgrade when second fires",
  ].join("\n");
  const markers = parseSimpleOnPurposeMarkers("lib/h.ts", text);
  assertEquals(markers.map((m) => [m.line, m.ceiling, m.upgradeWhen]), [
    [1, "first ceiling", null],
    [2, "second", "second fires"],
  ]);
});

Deno.test("parse - a complete single-line marker followed by unrelated comment lines keeps only its own clause", () => {
  const text = [
    "# SIMPLE-ON-PURPOSE: 2-space names, 4-space keys, single-line Type — upgrade when a template uses flow-style, anchors, multi-line or tab-indented parameters",
    "# The awk below walks only the Parameters: block of the template.",
    '# Prints "<Name><TAB><Type>" for each SSM-typed parameter.',
    "ssm_parameters() {",
  ].join("\n");
  const m = onlyMarker(parseSimpleOnPurposeMarkers("infra/t.sh", text));
  assertEquals(m.line, 1);
  assertEquals(m.ceiling, "2-space names, 4-space keys, single-line Type");
  assertEquals(
    m.upgradeWhen,
    "a template uses flow-style, anchors, multi-line or tab-indented parameters",
  );
});

Deno.test("parse - a clause-less marker does not borrow an unrelated next line's upgrade when", () => {
  const text = [
    "// SIMPLE-ON-PURPOSE: a quadratic scan is fine here",
    "// Note: we will upgrade when the corpus grows.",
    "// an unrelated comment line",
  ].join("\n");
  const m = onlyMarker(parseSimpleOnPurposeMarkers("lib/k.ts", text));
  assertEquals(m.ceiling, "a quadratic scan is fine here");
  assertEquals(m.upgradeWhen, null);
});

Deno.test("parse - a clause-less marker does not absorb an unrelated comment line with no clause", () => {
  const text = [
    "// SIMPLE-ON-PURPOSE: fixed buffer",
    "// Unrelated note about the buffer.",
  ].join("\n");
  const m = onlyMarker(parseSimpleOnPurposeMarkers("lib/m.ts", text));
  assertEquals(m.ceiling, "fixed buffer");
  assertEquals(m.upgradeWhen, null);
});

Deno.test("parse - a clause-less marker joins a next line that starts with upgrade when", () => {
  const text = [
    "// SIMPLE-ON-PURPOSE: fixed buffer",
    "// upgrade when inputs exceed 64 KiB",
    "const x = 1;",
  ].join("\n");
  const m = onlyMarker(parseSimpleOnPurposeMarkers("lib/n.ts", text));
  assertEquals(m.ceiling, "fixed buffer");
  assertEquals(m.upgradeWhen, "inputs exceed 64 KiB");
});

Deno.test("parse - a clause-less marker ending in a hyphen or a comma joins the next line", () => {
  const text = [
    "# SIMPLE-ON-PURPOSE: flat keys only -",
    "# nested maps — upgrade when a repo needs them",
    "# SIMPLE-ON-PURPOSE: flat keys only,",
    "# nested maps — upgrade when a repo needs them",
  ].join("\n");
  assertEquals(
    parseSimpleOnPurposeMarkers("lib/p.sh", text).map((
      m,
    ) => [m.line, m.ceiling, m.upgradeWhen]),
    [
      [1, "flat keys only - nested maps", "a repo needs them"],
      [3, "flat keys only, nested maps", "a repo needs them"],
    ],
  );
});

Deno.test("parse - a dash-ended marker joins at most five continuation lines, however many follow", () => {
  const lines = ["// SIMPLE-ON-PURPOSE: head —"];
  for (let n = 1; n <= 1000; n++) lines.push(`// piece ${n} —`);
  const m = onlyMarker(
    parseSimpleOnPurposeMarkers("lib/o.ts", lines.join("\n")),
  );
  assertEquals(
    m.ceiling,
    "head — piece 1 — piece 2 — piece 3 — piece 4 — piece 5",
  );
  assertEquals(m.upgradeWhen, null);
});

Deno.test("parse - the real test-floci.sh marker keeps its own clause and does not borrow the awk comment lines", () => {
  // Copied verbatim from infra/cloudformation/test-floci.sh lines 117-121.
  const text = [
    "# --- Per-template helpers ----------------------------------------------------",
    "# SIMPLE-ON-PURPOSE: 2-space names, 4-space keys, single-line Type — upgrade when a template uses flow-style, anchors, multi-line or tab-indented parameters",
    "# The awk below walks only the Parameters: block of the template.",
    '# Prints "<Name><TAB><Type>" for each SSM-typed parameter.',
    "ssm_parameters() {",
  ].join("\n");
  const m = onlyMarker(parseSimpleOnPurposeMarkers("infra/cloudformation/test-floci.sh", text));
  assertEquals(m.line, 2);
  assertEquals(m.ceiling, "2-space names, 4-space keys, single-line Type");
  assertEquals(
    m.upgradeWhen,
    "a template uses flow-style, anchors, multi-line or tab-indented parameters",
  );
});

Deno.test("parse - a wrapped marker with an empty upgrade when still joins the next line, then stops", () => {
  const text = [
    "// SIMPLE-ON-PURPOSE: c — upgrade when:",
    "// the condition continues here.",
    "// an unrelated comment line",
  ].join("\n");
  const m = onlyMarker(parseSimpleOnPurposeMarkers("lib/l.ts", text));
  assertEquals(m.ceiling, "c");
  assertEquals(m.upgradeWhen, "the condition continues here.");
});

Deno.test("parse - hash, block, jsdoc, dash, semicolon and HTML comment openers", () => {
  const text = [
    "# SIMPLE-ON-PURPOSE: one shard — upgrade when shards exceed 8",
    "/* SIMPLE-ON-PURPOSE: fixed buffer — upgrade when inputs exceed 64 KiB */",
    " * SIMPLE-ON-PURPOSE: jsdoc style — upgrade when x",
    "-- SIMPLE-ON-PURPOSE: sql style — upgrade when y",
    "; SIMPLE-ON-PURPOSE: lisp style — upgrade when z",
    "<!-- SIMPLE-ON-PURPOSE: html style — upgrade when w -->",
  ].join("\n");
  assertEquals(
    parseSimpleOnPurposeMarkers("lib/i.ts", text).map((
      m,
    ) => [m.line, m.ceiling, m.upgradeWhen]),
    [
      [1, "one shard", "shards exceed 8"],
      [2, "fixed buffer", "inputs exceed 64 KiB"],
      [3, "jsdoc style", "x"],
      [4, "sql style", "y"],
      [5, "lisp style", "z"],
      [6, "html style", "w"],
    ],
  );
});

Deno.test("parse - a block comment's ` * ` continuation lines join the marker, a `*/` line ends it", () => {
  const text = [
    "/* SIMPLE-ON-PURPOSE: wraps here —",
    " * upgrade when the block grows */",
    "const z = 0;",
  ].join("\n");
  const m = onlyMarker(parseSimpleOnPurposeMarkers("lib/j.ts", text));
  assertEquals(m.ceiling, "wraps here");
  assertEquals(m.upgradeWhen, "the block grows");
});

Deno.test("scan - a markdown file is not scanned, so its prose marker is not counted", async () => {
  const reads: string[] = [];
  const result = await scanSimpleOnPurpose({
    repoPath: "/repo",
    listFiles: () => Promise.resolve(["docs/GUIDE.md", "lib/a.ts"]),
    readFile: (abs) => {
      reads.push(abs);
      return Promise.resolve("// SIMPLE-ON-PURPOSE: x — upgrade when y\n");
    },
  });
  assert(result.ok);
  assertEquals(reads, ["/repo/lib/a.ts"]);
  assertEquals(result.value.markers.map((m) => m.path), ["lib/a.ts"]);
});

Deno.test("scan - an HTML comment marker in a non-Markdown file is listed, the same marker in Markdown is not", async () => {
  const marker = "<!-- SIMPLE-ON-PURPOSE: x — upgrade when y -->\n";
  const result = await scanFiles({
    "docs/page.html": marker,
    "docs/page.md": marker,
  });
  assert(result.ok);
  assertEquals(result.value.markers.map((m) => m.path), ["docs/page.html"]);
});

Deno.test("scan - binary and oversized text is skipped, not failed", async () => {
  const result = await scanFiles({
    "lib/bin.ts": "// SIMPLE-ON-PURPOSE: x — upgrade when y\n\u0000",
    "lib/big.ts": "// SIMPLE-ON-PURPOSE: x — upgrade when y\n" +
      "x".repeat(1024 * 1024),
    "lib/ok.ts": "// SIMPLE-ON-PURPOSE: x — upgrade when y",
  });
  assert(result.ok);
  assertEquals(result.value.markers.map((m) => m.path), ["lib/ok.ts"]);
});

Deno.test("scan - markers are sorted by path then line and flagged ones collected", async () => {
  const result = await scanFiles({
    "lib/b.ts":
      "// SIMPLE-ON-PURPOSE: b2\n// SIMPLE-ON-PURPOSE: b3 — upgrade when x",
    "lib/a.ts": "// SIMPLE-ON-PURPOSE: a1 — upgrade when y",
  });
  assert(result.ok);
  assertEquals(result.value.markers.map((m) => `${m.path}:${m.line}`), [
    "lib/a.ts:1",
    "lib/b.ts:1",
    "lib/b.ts:2",
  ]);
  assertEquals(
    result.value.missingUpgradeWhen.map((m) => `${m.path}:${m.line}`),
    [
      "lib/b.ts:1",
    ],
  );
});

Deno.test("scan - a listing failure returns ok:false with the cause", async () => {
  const result = await scanSimpleOnPurpose({
    repoPath: "/repo",
    listFiles: () => Promise.reject(new Error("git exploded on listing")),
  });
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertStringIncludes(result.error, "git exploded on listing");
});

Deno.test("scan - a read failure returns ok:false naming the file and the cause", async () => {
  const result = await scanSimpleOnPurpose({
    repoPath: "/repo",
    listFiles: () => Promise.resolve(["lib/a.ts"]),
    readFile: () => Promise.reject(new Error("EACCES: permission denied")),
  });
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertStringIncludes(result.error, "lib/a.ts");
  assertStringIncludes(result.error, "permission denied");
});

Deno.test("scan - the default lister reads git-tracked files only", async () => {
  const dir = await Deno.makeTempDir({ prefix: "simple-on-purpose-" });
  try {
    const run = (args: string[]) =>
      new Deno.Command("git", {
        args,
        cwd: dir,
        stdout: "null",
        stderr: "null",
      }).output();
    await run(["init", "-q"]);
    await Deno.writeTextFile(
      `${dir}/tracked.ts`,
      "// SIMPLE-ON-PURPOSE: t — upgrade when u\n",
    );
    await Deno.writeTextFile(
      `${dir}/untracked.ts`,
      "// SIMPLE-ON-PURPOSE: n — upgrade when u\n",
    );
    await run(["add", "tracked.ts"]);
    const result = await scanSimpleOnPurpose({ repoPath: dir });
    assert(result.ok);
    assertEquals(result.value.markers.map((m) => m.path), ["tracked.ts"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("render - shows path:line, ceiling, condition and the flagged section", () => {
  const ledger: SimpleOnPurposeLedger = {
    markers: [
      {
        path: "lib/a.ts",
        line: 12,
        ceiling: "one page",
        upgradeWhen: "a repo holds more than 200",
      },
      {
        path: "lib/b.ts",
        line: 3,
        ceiling: "no clause here",
        upgradeWhen: null,
      },
    ],
    missingUpgradeWhen: [{
      path: "lib/b.ts",
      line: 3,
      ceiling: "no clause here",
      upgradeWhen: null,
    }],
  };
  const out = renderSimpleOnPurposeReport(ledger, "FOOTER-LINE");
  assertStringIncludes(out, "report-only ledger");
  assertStringIncludes(out, "Markers: 2. Missing an `upgrade when` clause: 1.");
  assertStringIncludes(out, "## Markers missing an `upgrade when` clause");
  assertStringIncludes(out, "- lib/b.ts:3: no clause here");
  assertStringIncludes(
    out,
    "| lib/a.ts:12 | one page | a repo holds more than 200 |",
  );
  assertStringIncludes(out, "| lib/b.ts:3 | no clause here | (missing) |");
  assertStringIncludes(out, "FOOTER-LINE");
});

Deno.test("render - zero markers says so plainly and has no table", () => {
  const out = renderSimpleOnPurposeReport({
    markers: [],
    missingUpgradeWhen: [],
  });
  assertStringIncludes(out, "No `SIMPLE-ON-PURPOSE` markers were found");
  assertEquals(out.includes("| Location |"), false);
});

Deno.test("render - escapes pipes, backslashes, backticks and newlines in a cell", () => {
  const marker: SimpleOnPurposeMarker = {
    path: "lib/a.ts",
    line: 1,
    ceiling: "a | b",
    upgradeWhen: "line one\nline two `code` \\ end",
  };
  const out = renderSimpleOnPurposeReport({
    markers: [marker],
    missingUpgradeWhen: [],
  });
  assertStringIncludes(
    out,
    "| lib/a.ts:1 | a \\| b | line one line two \\`code\\` \\\\ end |",
  );
});

Deno.test("render - a cell longer than 300 characters is truncated with an ellipsis", () => {
  const marker: SimpleOnPurposeMarker = {
    path: "lib/a.ts",
    line: 1,
    ceiling: "c",
    upgradeWhen: "a".repeat(400),
  };
  const out = renderSimpleOnPurposeReport({
    markers: [marker],
    missingUpgradeWhen: [],
  });
  assertStringIncludes(out, `${"a".repeat(299)}…`);
  assertEquals(out.includes("a".repeat(300)), false);
});

Deno.test("regex hostility - a long run of spaces and dashes before a rejecting character", () => {
  const text = `// SIMPLE-ON-PURPOSE: ${"-".repeat(200_000)}${
    " ".repeat(200_000)
  }x`;
  const m = onlyMarker(parseSimpleOnPurposeMarkers("lib/h.ts", text));
  assertEquals(m.upgradeWhen, null);
  assertEquals(m.ceiling.endsWith("x"), true);
});

Deno.test("regex hostility - a long space run after the clause keeps the condition exact", () => {
  const text = `// SIMPLE-ON-PURPOSE: c — upgrade when${" ".repeat(200_000)}x`;
  const m = onlyMarker(parseSimpleOnPurposeMarkers("lib/i.ts", text));
  assertEquals(m.ceiling, "c");
  assertEquals(m.upgradeWhen, "x");
});

Deno.test("regex hostility - a near-miss clause repeated many times yields no clause", () => {
  const text = `// SIMPLE-ON-PURPOSE: ${"upgrade ".repeat(50_000)}whe!`;
  const m = onlyMarker(parseSimpleOnPurposeMarkers("lib/j.ts", text));
  assertEquals(m.upgradeWhen, null);
});
