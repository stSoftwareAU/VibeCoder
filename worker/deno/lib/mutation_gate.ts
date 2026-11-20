/**
 * Shared helpers left in place after the automatic mutation check was retired
 * by Issue #5095. This module no longer generates mutants, parses diffs or
 * decides a verdict. It holds only the helpers that other checks still use:
 * the test-file rule ({@link isDenoTestFile}) and Markdown safety
 * ({@link mdSafe}).
 *
 * Every pattern here is bounded or hand-scanned so a hostile line cannot cause
 * backtracking.
 *
 * Australian English spelling used throughout.
 */
// ---------------------------------------------------------------------------
// Test-file rule
// ---------------------------------------------------------------------------

/**
 * The file-name rule only: true for `*_test.ts`, `*.test.ts` and friends. A
 * project's `test.include` in its deno.json can also make a file a test; this
 * check does not read that config.
 */
export function isDenoTestFile(file: string): boolean {
  const base = file.slice(file.lastIndexOf("/") + 1);
  return /(?:_test|\.test)\.[a-z]+$/.test(base);
}

// ---------------------------------------------------------------------------
// Markdown safety
// ---------------------------------------------------------------------------

/** Strips backticks and line breaks so untrusted text is safe in Markdown. */
export function mdSafe(s: string): string {
  return s.replaceAll("`", "").replace(/[\r\n]+/g, " ");
}
