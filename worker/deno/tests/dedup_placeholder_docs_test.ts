/**
 * Tests for the dedup-placeholder documentation guard (Issue #541).
 *
 * Each rule is exercised against the stale shape it must catch and the
 * corrected shape it must accept, then the whole check runs against this
 * repository's real `docs/` tree — the regression that matters, since a scan
 * doc describing only the finding-id list teaches the next template author the
 * label-scoped pattern that re-filed NEAT-AI-Rebase #64 over the open #37.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  DETERMINISTIC_PLACEHOLDER,
  isExcludedDoc,
  runDedupPlaceholderDocsCheck,
  scanDedupPlaceholderContent,
  SEMANTIC_PLACEHOLDER,
} from "../lib/dedup_placeholder_docs_check.ts";

/** Repository root — tests run with `worker/deno` as the working directory. */
const ROOT = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");

Deno.test("dedup docs - a doc listing only the finding-id list fails", () => {
  const violation = scanDedupPlaceholderContent(
    "docs/EXAMPLE-SCAN.md",
    "- **Body:** the prompt with the two placeholders substituted —\n" +
      `  \`{{SUPPRESSED_IDS}}\` and \`${DETERMINISTIC_PLACEHOLDER}\`.\n`,
  );
  assert(violation !== null);
  assertEquals(violation.file, "docs/EXAMPLE-SCAN.md");
  assertEquals(violation.line, 2);
});

Deno.test("dedup docs - a doc listing both placeholders passes", () => {
  const violation = scanDedupPlaceholderContent(
    "docs/EXAMPLE-SCAN.md",
    `\`${DETERMINISTIC_PLACEHOLDER}\`, and \`${SEMANTIC_PLACEHOLDER}\` ` +
      "(both render `(none)` on the wrapper itself).",
  );
  assertEquals(violation, null);
});

Deno.test("dedup docs - a doc naming neither placeholder is out of scope", () => {
  assertEquals(
    scanDedupPlaceholderContent("docs/OVERVIEW.md", "No dedup lists here."),
    null,
  );
});

Deno.test("dedup docs - the archive is excluded, live docs are not", () => {
  assert(isExcludedDoc("docs/archive/pr-summaries/pr-summary-536.md"));
  assert(isExcludedDoc("docs/archive/"));
  assert(!isExcludedDoc("docs/SECURITY-SCAN.md"));
  assert(!isExcludedDoc("docs/audits/some-audit.md"));
});

Deno.test("dedup docs - a repo with no docs directory is SKIPPED", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const result = await runDedupPlaceholderDocsCheck(dir);
    assertEquals(result.status, "SKIPPED");
    assertEquals(result.violations, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("dedup docs - the check reports the offending file loudly", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/docs/archive/pr-summaries`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/docs/STALE-SCAN.md`,
      `Placeholders: \`${DETERMINISTIC_PLACEHOLDER}\`.\n`,
    );
    await Deno.writeTextFile(
      `${dir}/docs/FRESH-SCAN.md`,
      `Placeholders: \`${DETERMINISTIC_PLACEHOLDER}\`, ` +
        `\`${SEMANTIC_PLACEHOLDER}\`.\n`,
    );
    // The historical record legitimately describes the one-list world.
    await Deno.writeTextFile(
      `${dir}/docs/archive/pr-summaries/pr-summary-1.md`,
      `Placeholders: \`${DETERMINISTIC_PLACEHOLDER}\`.\n`,
    );

    const result = await runDedupPlaceholderDocsCheck(dir);
    assertEquals(result.status, "FAILED");
    assertEquals(result.violations.length, 1);
    assertEquals(result.violations[0]!.file, "docs/STALE-SCAN.md");
    assertEquals(result.filesScanned, 2);
    assertStringIncludes(result.output, "docs/STALE-SCAN.md");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("dedup docs - every published VibeCoder doc lists both lists", async () => {
  const result = await runDedupPlaceholderDocsCheck(ROOT);
  assertEquals(result.status, "PASSED", result.output);
  // The framework doc plus the scan docs that enumerate placeholders.
  assert(
    result.filesScanned >= 8,
    `expected at least 8 docs enumerating the dedup placeholders, ` +
      `found ${result.filesScanned}`,
  );
});
