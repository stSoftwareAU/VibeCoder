/**
 * Unit tests for the PR-summary claimed-path extractors (Issue #3617).
 *
 * Uses Australian English throughout (behaviour, normalise, recognise, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  extractChangeSectionPaths,
  extractUpdatedPaths,
  isPathInChangedFiles,
  MAX_CLAIMED_PATHS,
  normaliseClaimedPath,
  unbackedPaths,
} from "../lib/summary_claimed_paths.ts";
import { assertLinearGrowth } from "./support/growth.ts";

// ---------------------------------------------------------------------------
// normaliseClaimedPath
// ---------------------------------------------------------------------------

Deno.test("normaliseClaimedPath - strips a trailing #anchor", () => {
  assertEquals(normaliseClaimedPath("docs/x.md#decisions-report"), "docs/x.md");
});

Deno.test("normaliseClaimedPath - strips a trailing :N line suffix", () => {
  assertEquals(normaliseClaimedPath("lib/x.ts:12"), "lib/x.ts");
});

Deno.test("normaliseClaimedPath - strips a trailing :N-M line range", () => {
  assertEquals(normaliseClaimedPath("lib/x.ts:12-34"), "lib/x.ts");
});

Deno.test("normaliseClaimedPath - strips a leading ./ repeatedly", () => {
  assertEquals(normaliseClaimedPath("./docs/a.md"), "docs/a.md");
  assertEquals(normaliseClaimedPath("././README.md"), "README.md");
});

Deno.test("normaliseClaimedPath - keeps a leading-dot .github path", () => {
  assertEquals(
    normaliseClaimedPath(".github/workflows/ci.yml"),
    ".github/workflows/ci.yml",
  );
});

Deno.test("normaliseClaimedPath - rejects a directory", () => {
  assertEquals(normaliseClaimedPath("docs/"), null);
  assertEquals(normaliseClaimedPath("docs"), null);
});

Deno.test("normaliseClaimedPath - rejects a glob", () => {
  assertEquals(normaliseClaimedPath("docs/*.md"), null);
  assertEquals(normaliseClaimedPath("docs/?.md"), null);
});

Deno.test("normaliseClaimedPath - rejects a parent or current segment", () => {
  assertEquals(normaliseClaimedPath("../secret.md"), null);
  assertEquals(normaliseClaimedPath("docs/../x.md"), null);
  assertEquals(normaliseClaimedPath("./."), null);
});

Deno.test("normaliseClaimedPath - rejects a URL", () => {
  assertEquals(normaliseClaimedPath("https://example.com/a.md"), null);
});

Deno.test("normaliseClaimedPath - rejects a dotted config key", () => {
  assertEquals(normaliseClaimedPath("codegraph_context.enabled"), null);
});

Deno.test("normaliseClaimedPath - rejects an owner/repo pair", () => {
  assertEquals(normaliseClaimedPath("stSoftwareAU/VibeCoder"), null);
});

Deno.test("normaliseClaimedPath - rejects an extensionless file", () => {
  // Extensionless files are not claim-checked, so they normalise to null.
  assertEquals(normaliseClaimedPath("Dockerfile"), null);
});

Deno.test("normaliseClaimedPath - rejects an extension off the allowlist", () => {
  assertEquals(normaliseClaimedPath("docs/x.exe"), null);
});

Deno.test("normaliseClaimedPath - rejects a leading slash or dash", () => {
  assertEquals(normaliseClaimedPath("/etc/passwd"), null);
  assertEquals(normaliseClaimedPath("-rf.md"), null);
});

Deno.test("normaliseClaimedPath - rejects whitespace and empty input", () => {
  assertEquals(normaliseClaimedPath("docs/a b.md"), null);
  assertEquals(normaliseClaimedPath(""), null);
  assertEquals(normaliseClaimedPath("   "), null);
});

Deno.test("normaliseClaimedPath - rejects a malformed line suffix", () => {
  assertEquals(normaliseClaimedPath("docs/x.md:12abc"), null);
});

Deno.test("normaliseClaimedPath - rejects a path over 300 characters", () => {
  assertEquals(normaliseClaimedPath(`${"a".repeat(298)}.md`), null);
  assertEquals(
    normaliseClaimedPath(`${"a".repeat(200)}.md`)?.endsWith(".md"),
    true,
  );
});

// ---------------------------------------------------------------------------
// extractUpdatedPaths — corpus shapes
// ---------------------------------------------------------------------------

Deno.test("extractUpdatedPaths - two paths followed by a sentence", () => {
  assertEquals(
    extractUpdatedPaths(
      "updated: `CODING-STANDARDS.md`, `prompts/issue/prompt.md`. The rest",
    ),
    ["CODING-STANDARDS.md", "prompts/issue/prompt.md"],
  );
});

Deno.test("extractUpdatedPaths - evidence after a semicolon-and-period is not a claim", () => {
  assertEquals(
    extractUpdatedPaths(
      "updated: `docs/a.md`, `SECURITY.md`. `docs/THREAT-MODEL.md:136` still holds",
    ),
    ["docs/a.md", "SECURITY.md"],
  );
});

Deno.test("extractUpdatedPaths - a reviewed-and-unchanged list after a period is not a claim", () => {
  assertEquals(
    extractUpdatedPaths(
      "updated: `docs/a.md`. Reviewed and left unchanged: `SECURITY.md`",
    ),
    ["docs/a.md"],
  );
});

Deno.test("extractUpdatedPaths - a parenthetical's quoted span is description", () => {
  assertEquals(
    extractUpdatedPaths(
      "updated: `docs/IDLE.md` (Overview, the `lib/x.ts` helper), `README.md`",
    ),
    ["docs/IDLE.md", "README.md"],
  );
});

Deno.test("extractUpdatedPaths - a quoted phrase in a parenthetical is description", () => {
  assertEquals(
    extractUpdatedPaths(
      'updated: `DESIGN-PRINCIPLES.md` (new principle — "An issue this run")',
    ),
    ["DESIGN-PRINCIPLES.md"],
  );
});

Deno.test("extractUpdatedPaths - a label inside a quoted grep term is ignored", () => {
  assertEquals(
    extractUpdatedPaths("grep: `updated: docs/z.md`; updated: `docs/a.md`"),
    ["docs/a.md"],
  );
});

Deno.test("extractUpdatedPaths - bare words after the label are not checked", () => {
  assertEquals(extractUpdatedPaths("updated: INTERNALS (Mermaid), MERGE"), []);
});

Deno.test("extractUpdatedPaths - a semicolon ends the list", () => {
  assertEquals(
    extractUpdatedPaths(
      "updated: `docs/a.md`; `docs/b.md:12` — still true because …",
    ),
    ["docs/a.md"],
  );
});

Deno.test("extractUpdatedPaths - a capitalised label counts", () => {
  assertEquals(extractUpdatedPaths("Updated: `docs/a.md`"), ["docs/a.md"]);
});

Deno.test("extractUpdatedPaths - a label with a different word is not the label", () => {
  assertEquals(extractUpdatedPaths("updates: `docs/a.md`"), []);
});

Deno.test("extractUpdatedPaths - curly quotes open and close a span", () => {
  assertEquals(extractUpdatedPaths("updated: “docs/c.md”"), ["docs/c.md"]);
});

Deno.test("extractUpdatedPaths - a repeated path is deduplicated", () => {
  assertEquals(
    extractUpdatedPaths("updated: `docs/a.md`, `docs/a.md`"),
    ["docs/a.md"],
  );
});

Deno.test("extractUpdatedPaths - the list is capped at MAX_CLAIMED_PATHS", () => {
  const many = Array.from(
    { length: MAX_CLAIMED_PATHS + 10 },
    (_, i) => `\`docs/p${i}.md\``,
  ).join(", ");
  const paths = extractUpdatedPaths(`updated: ${many}`);
  assertEquals(paths.length, MAX_CLAIMED_PATHS);
  assertEquals(paths[0], "docs/p0.md");
});

Deno.test("extractUpdatedPaths - an unterminated quote ends the list", () => {
  assertEquals(
    extractUpdatedPaths("updated: `docs/a.md`, `docs/b.md"),
    ["docs/a.md"],
  );
});

// ---------------------------------------------------------------------------
// extractChangeSectionPaths
// ---------------------------------------------------------------------------

Deno.test("extractChangeSectionPaths - reads plain, nested, bold and numbered items", () => {
  const summary = [
    "## Changes",
    "- `lib/a.ts` — new helper",
    "  - `docs/nested.md`",
    "- **`docs/b.md`** — edited",
    "1. `docs/c.md`",
    "",
  ].join("\n");
  assertEquals(extractChangeSectionPaths(summary), [
    "lib/a.ts",
    "docs/nested.md",
    "docs/b.md",
    "docs/c.md",
  ]);
});

Deno.test("extractChangeSectionPaths - only the opening span of an item counts", () => {
  const summary = "## Changes\n- `docs/a.md` and `docs/z.md`\n";
  assertEquals(extractChangeSectionPaths(summary), ["docs/a.md"]);
});

Deno.test("extractChangeSectionPaths - a fenced example is ignored", () => {
  const summary = [
    "## Changes",
    "```",
    "- `docs/fenced.md`",
    "```",
    "- `docs/real.md`",
  ].join("\n");
  assertEquals(extractChangeSectionPaths(summary), ["docs/real.md"]);
});

Deno.test("extractChangeSectionPaths - a list under a Summary heading is ignored", () => {
  assertEquals(
    extractChangeSectionPaths("## Summary\n- `docs/s.md`\n"),
    [],
  );
});

Deno.test("extractChangeSectionPaths - the section ends at the next heading of any level", () => {
  assertEquals(
    extractChangeSectionPaths(
      "## Changes\n- `docs/a.md`\n## Testing\n- `docs/t.md`",
    ),
    ["docs/a.md"],
  );
  assertEquals(
    extractChangeSectionPaths(
      "## Changes\n- `docs/a.md`\n# Notes\n- `docs/n.md`",
    ),
    ["docs/a.md"],
  );
});

Deno.test("extractChangeSectionPaths - an emoji-prefixed heading is recognised", () => {
  assertEquals(
    extractChangeSectionPaths("### 📝 What changed\n- `docs/e.md`"),
    ["docs/e.md"],
  );
});

Deno.test("extractChangeSectionPaths - decorated titles with a trailing colon are recognised", () => {
  assertEquals(
    extractChangeSectionPaths("## **Files changed:**\n- `docs/f.md`"),
    ["docs/f.md"],
  );
});

Deno.test("extractChangeSectionPaths - a level-5 heading is not a change section", () => {
  assertEquals(
    extractChangeSectionPaths("##### Changes\n- `docs/x.md`"),
    [],
  );
});

Deno.test("extractChangeSectionPaths - CRLF line endings are handled", () => {
  assertEquals(
    extractChangeSectionPaths("## Changes\r\n- `docs/crlf.md`\r\n"),
    ["docs/crlf.md"],
  );
});

// ---------------------------------------------------------------------------
// isPathInChangedFiles / unbackedPaths
// ---------------------------------------------------------------------------

Deno.test("isPathInChangedFiles - a suffix at a slash boundary matches", () => {
  assert(
    isPathInChangedFiles("lib/foo.ts", ["worker/deno/lib/foo.ts"]),
  );
});

Deno.test("isPathInChangedFiles - an exact match matches", () => {
  assert(isPathInChangedFiles("README.md", ["README.md"]));
});

Deno.test("isPathInChangedFiles - a suffix that is not at a slash boundary does not match", () => {
  assertEquals(isPathInChangedFiles("foo.ts", ["barfoo.ts"]), false);
  assertEquals(isPathInChangedFiles("lib/foo.ts", ["barlib/foo.ts"]), false);
});

Deno.test("unbackedPaths - keeps the order of the unbacked paths", () => {
  assertEquals(
    unbackedPaths(["b.md", "x/a.md", "c.md"], ["worker/x/a.md"]),
    ["b.md", "c.md"],
  );
});

// ---------------------------------------------------------------------------
// Hostile input stays linear (Issue #3617, CODING-STANDARDS "Guard
// super-linearity by behaviour first").
// ---------------------------------------------------------------------------

Deno.test("extractUpdatedPaths - a long run of ( after updated: scales linearly", () => {
  const paths = assertLinearGrowth(
    "updated: parenthesis-run scan",
    (chars) => `updated: ${"(".repeat(chars)}x`,
    (input) => extractUpdatedPaths(input),
    { baseChars: 1_000 },
  );
  assertEquals(paths, []);
});

Deno.test("extractUpdatedPaths - a long run of backticks and quotes scales linearly", () => {
  const paths = assertLinearGrowth(
    "updated: quote-run scan",
    (chars) => `updated: ${'`"“”'.repeat(Math.ceil(chars / 4))}`,
    (input) => extractUpdatedPaths(input),
    { baseChars: 1_000 },
  );
  assertEquals(paths, []);
});

Deno.test("extractUpdatedPaths - a long repetition of updated without a colon scales linearly", () => {
  const paths = assertLinearGrowth(
    "updated-without-colon scan",
    (chars) => "updated ".repeat(Math.ceil(chars / 8)),
    (input) => extractUpdatedPaths(input),
    { baseChars: 1_000 },
  );
  assertEquals(paths, []);
});

Deno.test("extractChangeSectionPaths - a long run of # on a heading line scales linearly", () => {
  const paths = assertLinearGrowth(
    "change-section heading hash-run scan",
    (chars) => `## Changes ${"#".repeat(chars)}\n- \`docs/a.md\``,
    (input) => extractChangeSectionPaths(input),
    { baseChars: 20_000 },
  );
  assertEquals(paths, ["docs/a.md"]);
});

Deno.test("extractChangeSectionPaths - a long run of spaces after a list marker scales linearly", () => {
  const paths = assertLinearGrowth(
    "change-section list-marker space-run scan",
    (chars) => `## Changes\n-${" ".repeat(chars)}\`docs/a.md\``,
    (input) => extractChangeSectionPaths(input),
    { baseChars: 20_000 },
  );
  assertEquals(paths, ["docs/a.md"]);
});

Deno.test("normaliseClaimedPath - a long run of dots scales linearly", () => {
  const result = assertLinearGrowth(
    "normaliseClaimedPath dot-run scan",
    (chars) => `docs/${".".repeat(chars)}.md`,
    (input) => normaliseClaimedPath(input),
    { baseChars: 60 },
  );
  assert(
    result !== null && result.startsWith("docs/") && result.endsWith(".md"),
  );
});
