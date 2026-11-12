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
 * Two readers share this precedence. loadPrSummary reads the working tree.
 * loadCommittedPrSummary reads a commit and never consults the working tree
 * (Issue #4712), so a PR body built from it matches the pushed head.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import type { GitCommandOutput, runGitCommand } from "./git_timeout.ts";
import { markdownLogicalUnits } from "./markdown_code_spans.ts";

/** Result of loading a PR summary file. */
export interface PrSummaryResult {
  content: string;
  source: string;
}

/**
 * Candidate PR summary paths for an issue, in precedence order.
 *
 * Shared by the working-tree reader and the committed reader so the two
 * cannot drift apart.
 *
 * @param issueNumber - The issue number to look up
 * @returns Repo-relative paths; the first one with content wins
 */
export function prSummaryCandidatePaths(issueNumber: number): string[] {
  return [
    `docs/archive/pr-summaries/pr-summary-${issueNumber}.md`,
    `docs/pr-summary-${issueNumber}.md`,
    ".pr_summary",
  ];
}

/**
 * Load PR summary content from the repo work directory.
 *
 * Reads the working tree, so uncommitted edits and untracked files are seen.
 * Use {@link loadCommittedPrSummary} when the content must match a commit.
 *
 * Checks three file locations in precedence order and returns the
 * content from the first non-empty file found, with stale literal project-bump
 * statements omitted (Issue #4972; see {@link normaliseSummaryVersionBumps}).
 *
 * @param repoPath - Absolute path to the repo work directory
 * @param issueNumber - The issue number to look up
 * @returns Result with the summary content and source path, or empty content with "not_found"
 */
export async function loadPrSummary(
  repoPath: string,
  issueNumber: number,
): Promise<Result<PrSummaryResult>> {
  for (const relativePath of prSummaryCandidatePaths(issueNumber)) {
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

/**
 * Load PR summary content as committed at a commit (Issue #4712).
 *
 * The committed-at-a-sha counterpart of {@link loadPrSummary}. It reads
 * history through git and never consults the working tree, so uncommitted
 * edits, untracked files and deleted files cannot change the result. The
 * candidate order and version-bump normalisation match loadPrSummary.
 *
 * A failed object read is an error, not "no summary": the load fails loudly.
 *
 * @param repoPath - Absolute path to the repo work directory
 * @param issueNumber - The issue number to look up
 * @param sha - Full commit sha to read at; validated before it reaches git
 * @param runGit - The git runner (runGitCommand in production)
 * @returns Result with the summary content and source path, or empty content with "not_found"
 */
export async function loadCommittedPrSummary(
  repoPath: string,
  issueNumber: number,
  sha: string,
  runGit: typeof runGitCommand,
): Promise<Result<PrSummaryResult>> {
  if (!/^[0-9a-f]{40,64}$/.test(sha)) {
    return {
      ok: false,
      error: new Error(
        `Refusing to read PR summary: invalid commit sha ${
          JSON.stringify(sha)
        }`,
      ),
    };
  }

  for (const relativePath of prSummaryCandidatePaths(issueNumber)) {
    const listed = await runGit(
      ["ls-tree", "-z", "--name-only", sha, "--", relativePath],
      { cwd: repoPath },
    );
    if (!listed.ok || listed.value.code !== 0) {
      return {
        ok: false,
        error: committedReadError(relativePath, sha, listed),
      };
    }
    if (listed.value.stdout === "") continue;

    const shown = await runGit(["show", `${sha}:${relativePath}`], {
      cwd: repoPath,
    });
    if (!shown.ok || shown.value.code !== 0) {
      return {
        ok: false,
        error: committedReadError(relativePath, sha, shown),
      };
    }
    const content = shown.value.stdout;
    if (content.trim().length > 0) {
      return {
        ok: true,
        value: {
          content: normaliseSummaryVersionBumps(content),
          source: relativePath,
        },
      };
    }
  }

  return { ok: true, value: { content: "", source: "not_found" } };
}

/** Build the fail-loud error for a committed read that did not succeed. */
function committedReadError(
  relativePath: string,
  sha: string,
  result: Result<GitCommandOutput>,
): Error {
  const detail = result.ok
    ? result.value.stderr.trim().split("\n")[0] ||
      `git exited ${result.value.code}`
    : result.error.message;
  return new Error(
    `Failed to read PR summary at ${relativePath} in commit ${sha}: ${detail}`,
  );
}

/**
 * Omit stale literal version-bump lines from a PR summary (Issue #3954, Issue #4972).
 *
 * A line such as ``Version bump: `VERSION` 1.2.3 → 1.2.4`` in a Summary or
 * Test Plan scope is omitted, never replaced by an assertion. The diff and the
 * merged commit already record the version, and CI or deploy can change it
 * after the push, so no claim about the version is made in its place.
 *
 * Lines already worded without a literal version pair, dependency pins,
 * release evidence, changelog and migration text, and code blocks are untouched.
 *
 * @param content - Raw PR summary text (LF, CRLF or other line separators)
 * @returns The content with matching bump lines removed, separators preserved
 */
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
    // Omit the line and its trailing separator (the separator is absent on the
    // last line). Then, if the line sat between two blank lines, also omit the
    // following blank line so no two blank lines are left in a row.
    chunks[index * 2] = "";
    if (index * 2 + 1 < chunks.length) {
      chunks[index * 2 + 1] = "";
    }
    const following = index + 1;
    if (
      (index === 0 || lines[index - 1]!.trim() === "") &&
      following < lines.length && lines[following]!.trim() === ""
    ) {
      chunks[following * 2] = "";
      if (following * 2 + 1 < chunks.length) {
        chunks[following * 2 + 1] = "";
      }
    }
  }
  return chunks.join("");
}
