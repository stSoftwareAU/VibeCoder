/**
 * Tests for pages_liquid_check.ts (Issue #1601).
 *
 * Covers:
 *   - splitFrontMatter / alreadyWrapped / wrapBody / preprocessForLiquid
 *     (faithful translation of wrap_pr_summary_raw.rb behaviour)
 *   - collectPublishedMarkdownFiles
 *   - runPagesLiquidCheck happy-path (clean file)
 *   - runPagesLiquidCheck FAILED path (unclosed `{% if %}` flagged by parser)
 *   - runPagesLiquidCheck PASSED path for files with inline `{% raw %}`
 *     markers when the raw block is correctly balanced
 *   - runPagesLiquidCheck SKIPPED path when toolchain is unavailable
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  alreadyWrapped,
  collectPublishedMarkdownFiles,
  type DetectLiquidParser,
  type LiquidParser,
  type PagesLiquidError,
  preprocessForLiquid,
  runPagesLiquidCheck,
  splitFrontMatter,
  wrapBody,
} from "../lib/pages_liquid_check.ts";

// =============================================================================
// splitFrontMatter
// =============================================================================

Deno.test("splitFrontMatter - returns empty front-matter for body-only content", () => {
  const [front, body] = splitFrontMatter("# Heading\n\ntext\n");
  assertEquals(front, "");
  assertEquals(body, "# Heading\n\ntext\n");
});

Deno.test("splitFrontMatter - extracts standard front-matter block", () => {
  const content =
    '---\nlayout: default\ntitle: "Foo"\n---\n# Heading\n\ntext\n';
  const [front, body] = splitFrontMatter(content);
  assertEquals(front, '---\nlayout: default\ntitle: "Foo"\n---\n');
  assertEquals(body, "# Heading\n\ntext\n");
});

Deno.test("splitFrontMatter - leaves --- inside body untouched", () => {
  // No leading front-matter even though `---` appears later.
  const content = "Body starts here\n---\nhrule\n";
  const [front, body] = splitFrontMatter(content);
  assertEquals(front, "");
  assertEquals(body, content);
});

// =============================================================================
// alreadyWrapped
// =============================================================================

Deno.test("alreadyWrapped - false for body with no raw markers", () => {
  assertEquals(alreadyWrapped("plain markdown body\n"), false);
});

Deno.test("alreadyWrapped - true when {% raw %} appears anywhere", () => {
  assertEquals(alreadyWrapped("text\n{% raw %}snippet{% endraw %}\n"), true);
});

Deno.test("alreadyWrapped - true when only {% endraw %} appears", () => {
  // Defensive: any inline raw marker (even just the closing tag) means
  // we must NOT wrap, because nesting is unsupported.
  assertEquals(alreadyWrapped("text\n{% endraw %}\n"), true);
});

// =============================================================================
// wrapBody
// =============================================================================

Deno.test("wrapBody - wraps body with newline-padded raw markers", () => {
  assertEquals(
    wrapBody("body line one\nbody line two\n"),
    "{% raw %}\nbody line one\nbody line two\n{% endraw %}\n",
  );
});

Deno.test("wrapBody - trims leading and trailing blank lines before wrapping", () => {
  assertEquals(
    wrapBody("\n\nbody\n\n\n"),
    "{% raw %}\nbody\n{% endraw %}\n",
  );
});

// =============================================================================
// preprocessForLiquid (matches the Ruby pipeline)
// =============================================================================

Deno.test("preprocessForLiquid - clean file gets wrapped", () => {
  const out = preprocessForLiquid("# Hello\n\n{% if x %}{% endif %}\n");
  assertEquals(
    out,
    "{% raw %}\n# Hello\n\n{% if x %}{% endif %}\n{% endraw %}\n",
  );
});

Deno.test("preprocessForLiquid - file with inline raw markers passes through unchanged", () => {
  const original =
    "# Hello\n\nUse `{% raw %}{% if x %}{% endraw %}` in prose.\n";
  assertEquals(preprocessForLiquid(original), original);
});

Deno.test("preprocessForLiquid - is idempotent", () => {
  const once = preprocessForLiquid("# Hello\n\nbody\n");
  // Once wrapped, the file now contains {% raw %} markers, so the
  // already_wrapped? branch kicks in and a second pass is a no-op.
  assertEquals(preprocessForLiquid(once), once);
});

Deno.test("preprocessForLiquid - preserves front-matter outside the wrap", () => {
  const content =
    "---\nlayout: default\n---\n# Hello\n\nbody with {% if x %}\n";
  assertEquals(
    preprocessForLiquid(content),
    "---\nlayout: default\n---\n{% raw %}\n# Hello\n\nbody with {% if x %}\n{% endraw %}\n",
  );
});

// =============================================================================
// collectPublishedMarkdownFiles
// =============================================================================

Deno.test("collectPublishedMarkdownFiles - returns relevant root + docs files", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "pages_liquid_collect_" });
  try {
    await Deno.writeTextFile(`${tmp}/AGENTS.md`, "agents\n");
    await Deno.writeTextFile(`${tmp}/README.md`, "readme\n");
    // SECURITY.md deliberately missing — should not be reported as missing
    await Deno.mkdir(`${tmp}/docs`);
    await Deno.writeTextFile(`${tmp}/docs/OVERVIEW.md`, "overview\n");
    await Deno.mkdir(`${tmp}/docs/sub`);
    await Deno.writeTextFile(`${tmp}/docs/sub/nested.md`, "nested\n");
    // Unrelated files should be ignored
    await Deno.writeTextFile(`${tmp}/CHANGELOG.md`, "changelog\n");
    await Deno.writeTextFile(`${tmp}/docs/notes.txt`, "not markdown\n");

    const files = await collectPublishedMarkdownFiles(tmp);

    assertEquals(files, [
      "AGENTS.md",
      "README.md",
      "docs/OVERVIEW.md",
      "docs/sub/nested.md",
    ]);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("collectPublishedMarkdownFiles - empty when no published files exist", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "pages_liquid_empty_" });
  try {
    const files = await collectPublishedMarkdownFiles(tmp);
    assertEquals(files, []);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

// =============================================================================
// runPagesLiquidCheck — uses an injected fake parser so the test does
// not depend on a Ruby/Liquid toolchain. The fake captures the
// (post-preprocessing) content it was asked to parse, and returns
// configured errors. This lets us assert that:
//   - The orchestrator hands the parser the wrapped content.
//   - PASSED / FAILED / SKIPPED states are reported correctly.
// =============================================================================

interface FakeParserCapture {
  invocations: Array<Array<{ path: string; content: string }>>;
}

function makeFakeParser(
  errors: PagesLiquidError[],
  capture: FakeParserCapture,
): LiquidParser {
  return (files) => {
    capture.invocations.push(files.map((f) => ({ ...f })));
    return Promise.resolve(errors);
  };
}

function fakeDetect(parser: LiquidParser | null): DetectLiquidParser {
  return () => Promise.resolve(parser);
}

Deno.test("runPagesLiquidCheck - happy path: clean file passes after wrapping", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "pages_liquid_happy_" });
  try {
    await Deno.writeTextFile(`${tmp}/AGENTS.md`, "# Agents\n\nbody\n");
    const capture: FakeParserCapture = { invocations: [] };
    const result = await runPagesLiquidCheck(tmp, {
      detectParser: fakeDetect(makeFakeParser([], capture)),
    });

    assertEquals(result.status, "PASSED");
    assertEquals(result.filesChecked, 1);
    assertEquals(result.errors.length, 0);
    assertStringIncludes(result.output, "pages-liquid: PASSED");

    // Confirm the parser actually received the wrapped content.
    assertEquals(capture.invocations.length, 1);
    const passed = capture.invocations[0]!;
    assertEquals(passed.length, 1);
    assertEquals(passed[0]!.path, "AGENTS.md");
    assertStringIncludes(passed[0]!.content, "{% raw %}");
    assertStringIncludes(passed[0]!.content, "{% endraw %}");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("runPagesLiquidCheck - FAILED when parser reports unclosed {% if %}", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "pages_liquid_fail_" });
  try {
    // File has inline {% raw %} so the wrap step is skipped — leaving
    // an unbalanced {% if %} for Liquid to choke on. This mirrors the
    // exact regression class from #1599.
    const broken =
      "# Heading\n\nUse `{% raw %}` to escape Liquid in prose.\n\n{% if foo %} oh no\n";
    await Deno.writeTextFile(`${tmp}/AGENTS.md`, broken);

    const capture: FakeParserCapture = { invocations: [] };
    const fakeError: PagesLiquidError = {
      file: "AGENTS.md",
      message: "Liquid syntax error (line 5): 'if' tag was never closed",
    };
    const result = await runPagesLiquidCheck(tmp, {
      detectParser: fakeDetect(makeFakeParser([fakeError], capture)),
    });

    assertEquals(result.status, "FAILED");
    assertEquals(result.errors.length, 1);
    assertEquals(result.errors[0]!.file, "AGENTS.md");
    assertStringIncludes(result.output, "pages-liquid: FAILED");
    assertStringIncludes(result.output, "AGENTS.md");
    assertStringIncludes(result.output, "'if' tag was never closed");
    // Sanity: parser saw the un-wrapped content (because already_wrapped? was true).
    const passed = capture.invocations[0]!;
    assertEquals(passed.length, 1);
    assertEquals(passed[0]!.content, broken);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("runPagesLiquidCheck - PASSED when inline raw markers correctly enclose Liquid", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "pages_liquid_passthrough_" });
  try {
    // Properly balanced: {% if %} sits inside an inline {% raw %} block.
    const passthrough =
      "# Heading\n\n{% raw %}{% if foo %}body{% endif %}{% endraw %}\n";
    await Deno.writeTextFile(`${tmp}/AGENTS.md`, passthrough);

    const capture: FakeParserCapture = { invocations: [] };
    const result = await runPagesLiquidCheck(tmp, {
      detectParser: fakeDetect(makeFakeParser([], capture)),
    });

    assertEquals(result.status, "PASSED");
    assertEquals(result.filesChecked, 1);

    // Wrap is skipped — parser sees the original content unchanged.
    const passed = capture.invocations[0]!;
    assertEquals(passed[0]!.content, passthrough);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("runPagesLiquidCheck - SKIPPED when no toolchain is detected", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "pages_liquid_skip_" });
  try {
    await Deno.writeTextFile(`${tmp}/AGENTS.md`, "# Agents\n\nbody\n");
    const result = await runPagesLiquidCheck(tmp, {
      detectParser: fakeDetect(null),
    });

    assertEquals(result.status, "SKIPPED");
    assertEquals(result.errors.length, 0);
    assertEquals(result.filesChecked, 0);
    assertStringIncludes(result.output, "pages-liquid: SKIPPED");
    assert(result.skipReason);
    assertStringIncludes(result.skipReason!, "Ruby");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("runPagesLiquidCheck - SKIPPED when no published files exist", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "pages_liquid_nofiles_" });
  try {
    // Even with a working toolchain, no files = nothing to check.
    const capture: FakeParserCapture = { invocations: [] };
    const result = await runPagesLiquidCheck(tmp, {
      detectParser: fakeDetect(makeFakeParser([], capture)),
    });

    assertEquals(result.status, "SKIPPED");
    assertEquals(capture.invocations.length, 0);
    assertStringIncludes(result.output, "no published Markdown files");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("runPagesLiquidCheck - file list override is honoured", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "pages_liquid_override_" });
  try {
    await Deno.writeTextFile(`${tmp}/AGENTS.md`, "agents\n");
    await Deno.writeTextFile(`${tmp}/SECURITY.md`, "security\n");

    const capture: FakeParserCapture = { invocations: [] };
    const result = await runPagesLiquidCheck(tmp, {
      detectParser: fakeDetect(makeFakeParser([], capture)),
      files: ["SECURITY.md"],
    });

    assertEquals(result.status, "PASSED");
    assertEquals(result.filesChecked, 1);
    assertEquals(capture.invocations[0]!.length, 1);
    assertEquals(capture.invocations[0]![0]!.path, "SECURITY.md");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
