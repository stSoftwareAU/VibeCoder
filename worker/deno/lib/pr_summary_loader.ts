/**
 * PR summary file loader — reads PR summary content from the repo work directory.
 *
 * Issue #1186: Loads PR summary files in precedence order to use as the
 * primary PR body content during the completion phase.
 *
 * File precedence (Issue #2173 reordered to prefer the canonical archive
 * location now that PR summaries are written there directly):
 *   1. docs/archive/pr-summaries/pr-summary-{issueNumber}.md (canonical)
 *   2. docs/pr-summary-{issueNumber}.md (legacy loose location)
 *   3. .pr_summary (legacy root-level fallback)
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";

/** Result of loading a PR summary file. */
export interface PrSummaryResult {
  content: string;
  source: string;
}

/**
 * Load PR summary content from the repo work directory.
 *
 * Checks three file locations in precedence order and returns the
 * content from the first non-empty file found.
 *
 * @param repoPath - Absolute path to the repo work directory
 * @param issueNumber - The issue number to look up
 * @returns Result with the summary content and source path, or empty content with "not_found"
 */
export async function loadPrSummary(
  repoPath: string,
  issueNumber: number,
): Promise<Result<PrSummaryResult>> {
  const candidates = [
    `docs/archive/pr-summaries/pr-summary-${issueNumber}.md`,
    `docs/pr-summary-${issueNumber}.md`,
    ".pr_summary",
  ];

  for (const relativePath of candidates) {
    const fullPath = `${repoPath}/${relativePath}`;
    try {
      const content = await Deno.readTextFile(fullPath);
      if (content.trim().length > 0) {
        return { ok: true, value: { content, source: relativePath } };
      }
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        return {
          ok: false,
          error: new Error(
            `Failed to read PR summary at ${relativePath}: ${
              (err as Error).message
            }`,
          ),
        };
      }
    }
  }

  return { ok: true, value: { content: "", source: "not_found" } };
}
