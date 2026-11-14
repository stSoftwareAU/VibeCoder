/**
 * Shared helpers left in place after the automatic mutation check was retired
 * by Issue #5095. This module no longer generates mutants, parses diffs or
 * decides a verdict. It holds only the helpers that other checks still use:
 * the test-file rule ({@link isDenoTestFile}), exemption parsing
 * ({@link parseMutationExemptions}) and Markdown safety ({@link mdSafe}).
 *
 * Every pattern here is bounded or hand-scanned so a hostile line cannot cause
 * backtracking.
 *
 * Australian English spelling used throughout.
 */
/** Summary lines longer than this are ignored when reading exemptions. */
const MAX_SUMMARY_LINE_LENGTH = 2000;

const EXEMPT_MARKER = "exempt (untestable):";

// ---------------------------------------------------------------------------
// Test-file rule and exemptions
// ---------------------------------------------------------------------------

/**
 * The file-name rule only: true for `*_test.ts`, `*.test.ts` and friends. A
 * project's `test.include` in its deno.json also makes a file a test; that
 * config-aware rule is `isDenoTestPath` in deno_test_config.ts (Issue #4533).
 */
export function isDenoTestFile(file: string): boolean {
  const base = file.slice(file.lastIndexOf("/") + 1);
  return /(?:_test|\.test)\.[a-z]+$/.test(base);
}

const LOCATION_SEPARATORS = /[\s`'"()<>,]+/;
const DIGITS = /^\d{1,7}$/;

/**
 * Read `` `path:line` exempt (untestable): reason `` entries from a PR
 * summary. An empty reason is not an exemption.
 */
export function parseMutationExemptions(
  prSummary: string,
): Array<{ file: string; line: number; reason: string }> {
  const out: Array<{ file: string; line: number; reason: string }> = [];
  for (const line of prSummary.split("\n")) {
    if (line.length > MAX_SUMMARY_LINE_LENGTH) continue;
    const idx = line.toLowerCase().indexOf(EXEMPT_MARKER);
    if (idx < 0) continue;
    const reason = line.slice(idx + EXEMPT_MARKER.length).trim();
    if (reason === "") continue;
    for (let token of line.slice(0, idx).split(LOCATION_SEPARATORS)) {
      if (token.endsWith(":")) token = token.slice(0, -1);
      const colon = token.lastIndexOf(":");
      if (colon <= 0) continue;
      const num = token.slice(colon + 1);
      if (!DIGITS.test(num)) continue;
      out.push({ file: token.slice(0, colon), line: Number(num), reason });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Markdown safety
// ---------------------------------------------------------------------------

/** Strips backticks and line breaks so untrusted text is safe in Markdown. */
export function mdSafe(s: string): string {
  return s.replaceAll("`", "").replace(/[\r\n]+/g, " ");
}
