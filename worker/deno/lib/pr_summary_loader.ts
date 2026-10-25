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
import { markdownLogicalUnits } from "./markdown_code_spans.ts";

/** Result of loading a PR summary file. */
export interface PrSummaryResult {
  content: string;
  source: string;
}

/**
 * Load PR summary content from the repo work directory.
 *
 * Checks three file locations in precedence order and returns the
 * content from the first non-empty file found, with standalone project-bump
 * statements normalised to durable wording.
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
        return {
          ok: true,
          value: {
            content: normaliseSummaryVersionBumps(content),
            source: relativePath,
          },
        };
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

export function normaliseSummaryVersionBumps(content: string): string {
  const chunks = content.split(/(\r\n|[\n\r\u2028\u2029])/);
  const lines = chunks.filter((_, index) => index % 2 === 0);
  const units = markdownLogicalUnits(lines);
  const headings: Array<{ level: number; name: string }> = [];
  const enterHeading = (level: number, name: string) => {
    while (headings.length && headings[headings.length - 1]!.level >= level) {
      headings.pop();
    }
    headings.push({ level, name: name.trim().toLowerCase() });
  };
  for (let u = 0; u < units.length; u++) {
    const unit = units[u]!;
    const index = unit.lines[0]!;
    const line = lines[index]!;
    if (/^(?: {4}| *\t)/.test(line)) continue;
    if (unit.kind === "heading") {
      // Count the bounded ATX prefix and trim in separate linear scans; a lazy
      // name capture next to trailing whitespace is quadratic on long input.
      const prefix = /^ {0,3}#{1,6}(?:[ \t]|$)/.exec(line);
      if (!prefix) continue;
      const level = prefix[0].trim().length;
      let name = line.slice(prefix[0].length).trim();
      let end = name.length;
      while (end > 0 && name[end - 1] === "#") end--;
      if (end > 0 && /\s/.test(name[end - 1]!)) {
        name = name.slice(0, end).trimEnd();
      }
      enterHeading(level, name);
      continue;
    }
    const next = units[u + 1];
    if (
      unit.kind === "paragraph" && next?.kind === "break" &&
      next.lines[0] === unit.lines[unit.lines.length - 1]! + 1
    ) {
      const underline = lines[next.lines[0]!]!.trim();
      if (/^(?:=+|-+)$/.test(underline)) {
        enterHeading(underline[0] === "=" ? 1 : 2, unit.text);
        u++;
        continue;
      }
    }
    if (
      (unit.kind !== "paragraph" && unit.kind !== "list-item") ||
      unit.lines.length !== 1 || headings.some(({ level, name }) =>
        name !== "summary" && name !== "test plan" &&
        !(level === 1 && name === "pr summary")
      )
    ) {
      continue;
    }
    const bump = line.match(
      /^( {0,3}(?:[-*] +)?(?:\*\*)?Version bump:(?:\*\*)? +)`(VERSION|Cargo\.toml|package\.json|deno\.jsonc?)` +`?v?\d+\.\d+\.\d+`? *(?:→|->) *`?v?\d+\.\d+\.\d+`?\.? *$/i,
    );
    if (!bump) {
      continue;
    }
    chunks[index * 2] = `${bump[1]}\`${
      bump[2]
    }\` updated for this change; the merged commit records the final version.`;
  }
  return chunks.join("");
}
