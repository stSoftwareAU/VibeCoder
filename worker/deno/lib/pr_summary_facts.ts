/**
 * PR summary facts file: load, validate and render into the PR summary
 * (Issue #3535, part of #3396).
 *
 * The agent may record the Branch outcomes block as structured JSON beside
 * the PR summary (`pr-summary-<N>.facts.json`). The worker validates it with
 * `parseSummaryFacts` and renders the list into the summary at the
 * `BRANCH_OUTCOMES_MARKER` (or appends it when the marker is absent).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import {
  parseSummaryFacts,
  renderBranchOutcomes,
  type SummaryFacts,
} from "./summary_facts.ts";

import { markdownLogicalUnits } from "./markdown_code_spans.ts";

/**
 * Render an unambiguous standalone root-manifest bump without predicting the
 * final version. Historical ancestors, release continuations, nested manifests
 * and examples keep their exact evidence. Newly generated archives use the
 * same durable wording directly.
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
    chunks[index * 2] = `${bump[1]}\`${
      bump[2]
    }\` updated for this change; the merged commit records the final version.`;
  }
  return chunks.join("");
}

/** Where the rendered Branch outcomes list belongs in the PR summary. */
export const BRANCH_OUTCOMES_MARKER = "<!-- vibe-branch-outcomes -->";

/** Repo-relative path of the facts file for an issue. */
export function prSummaryFactsPath(issueNumber: number): string {
  return `docs/archive/pr-summaries/pr-summary-${issueNumber}.facts.json`;
}

/**
 * Read the facts file. A missing file is `null`; any other read error is an
 * error, never treated as absent.
 */
export async function loadPrSummaryFacts(
  repoPath: string,
  issueNumber: number,
): Promise<Result<{ content: string; relativePath: string } | null>> {
  const relativePath = prSummaryFactsPath(issueNumber);
  try {
    const content = await Deno.readTextFile(`${repoPath}/${relativePath}`);
    return { ok: true, value: { content, relativePath } };
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return { ok: true, value: null };
    return {
      ok: false,
      error: new Error(
        `Failed to read PR summary facts at ${relativePath}: ${
          (err as Error).message
        }`,
      ),
    };
  }
}

/**
 * Put the rendered list into the summary: replace the first marker, else
 * append after the existing content.
 */
export function applyBranchOutcomesFacts(
  summaryContent: string,
  rendered: string,
): string {
  const index = summaryContent.indexOf(BRANCH_OUTCOMES_MARKER);
  if (index !== -1) {
    return summaryContent.slice(0, index) + rendered +
      summaryContent.slice(index + BRANCH_OUTCOMES_MARKER.length);
  }
  if (summaryContent.trim().length === 0) return rendered + "\n";
  return summaryContent.trimEnd() + "\n\n" + rendered + "\n";
}

/**
 * Text the PR-body digest is computed over. With no facts file it is the
 * summary unchanged, so existing PRs' digests stay stable.
 */
export function prSummaryDigestInput(
  summaryContent: string,
  factsContent: string | null,
): string {
  if (factsContent === null) return summaryContent;
  return summaryContent + "\n<!-- vibe-pr-summary-facts -->\n" + factsContent;
}

/** What the facts file amounts to for the completion phase. */
export type BranchOutcomesFactsOutcome =
  | { kind: "absent" }
  | {
    kind: "error";
    reason: string;
    relativePath: string;
    /** Raw facts text when it was read, null when it was unreadable. */
    content: string | null;
  }
  | {
    kind: "valid";
    relativePath: string;
    facts: SummaryFacts;
    rendered: string;
    content: string;
  };

/** Load, validate and render the facts file for an issue. */
export async function resolveBranchOutcomesFacts(
  repoPath: string,
  issueNumber: number,
): Promise<BranchOutcomesFactsOutcome> {
  const relativePath = prSummaryFactsPath(issueNumber);
  const loaded = await loadPrSummaryFacts(repoPath, issueNumber);
  if (!loaded.ok) {
    return {
      kind: "error",
      relativePath,
      content: null,
      reason:
        `Branch outcomes facts file ${relativePath} could not be read: ${loaded.error.message}`,
    };
  }
  if (loaded.value === null) return { kind: "absent" };
  const { content } = loaded.value;
  const parsed = parseSummaryFacts(content);
  if (!parsed.ok) {
    return {
      kind: "error",
      relativePath,
      content,
      reason:
        `Branch outcomes facts file ${relativePath} is invalid: ${parsed.error.message}`,
    };
  }
  return {
    kind: "valid",
    relativePath,
    facts: parsed.value,
    rendered: renderBranchOutcomes(parsed.value),
    content,
  };
}
