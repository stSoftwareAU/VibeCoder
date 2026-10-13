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
