/**
 * Screenshot evidence validation for PR completion (Issue #1185).
 *
 * Detects UI-related changes from file extensions, issue labels, and
 * PR summary content. When UI changes are detected, validates that
 * screenshot evidence is present in the PR summary.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { findScreenshotReferences } from "./pr_evidence.ts";

const UI_FILE_EXTENSIONS =
  /\.(css|scss|sass|less|html|htm|jsx|tsx|vue|svelte)$/i;

const UI_LABEL_PATTERN = /\b(ui|frontend|css|visual|design|layout|style)\b/i;

/**
 * Individual UI keywords for content analysis.
 *
 * A single keyword match in PR summary content is insufficient — common words
 * like "visual", "color", or "chart" appear in non-UI contexts (e.g.,
 * "No visual changes", "benchmark chart"). We require at least two distinct
 * keyword matches to reduce false positives (Issue #1296).
 */
const UI_KEYWORDS = [
  "html",
  "chart",
  "css",
  "visual",
  "font",
  "colour",
  "color",
  "button",
  "modal",
  "dialog",
  "responsive",
  "stylesheet",
  "animation",
  "svg",
];

export interface ScreenshotValidationOptions {
  prSummaryContent: string;
  issueLabels: string;
  changedFiles: string[];
  repo: string;
  issueNumber: number;
  skipScreenshotCheck?: boolean;
}

export interface ScreenshotValidationResult {
  valid: boolean;
  isUiChange: boolean;
  skipped?: boolean;
  failureMessage?: string;
  /**
   * Evidence images committed on the branch that satisfied the gate when the
   * summary itself carried no reference (Issue #4355).
   */
  branchEvidence?: string[];
}

/** Where the agent is told to save screenshots (relative to the clone). */
export const EVIDENCE_DIR = "docs/evidence";

const EVIDENCE_IMAGE_PATTERN = /\.(png|jpe?g|gif|webp)$/i;

/**
 * Evidence images committed on the branch (Issue #4355): screenshots the
 * agent captured into `docs/evidence/` count as evidence even when a
 * resumed run left the summary without a reference to them — that is
 * exactly what happened on private-repo-10#831, where three real screenshots
 * sat on the branch while the gate failed the run for the summary text.
 */
export function findBranchEvidenceImages(changedFiles: string[]): string[] {
  const prefix = `${EVIDENCE_DIR}/`;
  return changedFiles.filter((f) =>
    f.startsWith(prefix) && EVIDENCE_IMAGE_PATTERN.test(f)
  );
}

/** Markdown section referencing branch evidence images, for the PR body. */
export function formatBranchEvidenceSection(images: string[]): string {
  if (images.length === 0) return "";
  const lines = images.map((path) => {
    const name = path.slice(path.lastIndexOf("/") + 1).replace(
      EVIDENCE_IMAGE_PATTERN,
      "",
    );
    return `![${name}](${path})`;
  });
  return `## Evidence\n\n${lines.join("\n\n")}\n\n`;
}

/**
 * Detect whether a set of changes is UI-related.
 *
 * Checks three signals:
 * 1. Changed file extensions (CSS, HTML, JSX, TSX, Vue, Svelte, etc.)
 * 2. Issue labels containing UI-related keywords
 * 3. PR summary content containing UI-specific terms
 */
export function detectUiChanges(
  prSummaryContent: string,
  issueLabels: string,
  changedFiles: string[],
): boolean {
  if (changedFiles.some((f) => UI_FILE_EXTENSIONS.test(f))) {
    return true;
  }

  if (UI_LABEL_PATTERN.test(issueLabels)) {
    return true;
  }

  // Require at least 2 distinct UI keyword matches in PR summary content
  // to reduce false positives from common words in non-UI contexts (Issue #1296).
  let uiKeywordMatchCount = 0;
  for (const keyword of UI_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`, "i").test(prSummaryContent)) {
      uiKeywordMatchCount++;
      if (uiKeywordMatchCount >= 2) {
        return true;
      }
    }
  }

  return false;
}

const SCREENSHOT_FAILURE_MESSAGE = `## Screenshot Evidence Required

This PR appears to contain UI-related changes but no screenshot evidence was found in the PR summary.

**To fix this on retry:**
1. Use \`browser_navigate\` to open a page showing the UI changes (serve local pages on 127.0.0.1)
2. Use \`browser_take_screenshot\` with an explicit \`filename\` under \`docs/evidence/\` (e.g. \`filename: "docs/evidence/issue-123-after.png"\`) — without \`filename\` the image lands outside the repository
3. Commit the file and reference it in your PR summary: \`![Description](docs/evidence/filename.png)\` — update an existing summary from an earlier attempt

Use Playwright MCP to capture screenshots as evidence for UI changes.`;

/**
 * Validate screenshot evidence for PR completion.
 *
 * When UI changes are detected and no screenshot references are found
 * in the PR summary, returns a failure result with instructions for
 * the retry attempt.
 */
export function validateScreenshotEvidence(
  options: ScreenshotValidationOptions,
): ScreenshotValidationResult {
  const {
    prSummaryContent,
    issueLabels,
    changedFiles,
    skipScreenshotCheck,
  } = options;

  if (skipScreenshotCheck) {
    return { valid: true, isUiChange: false, skipped: true };
  }

  const isUiChange = detectUiChanges(
    prSummaryContent,
    issueLabels,
    changedFiles,
  );

  if (!isUiChange) {
    return { valid: true, isUiChange: false };
  }

  const refs = findScreenshotReferences(prSummaryContent);
  if (refs.length > 0) {
    return { valid: true, isUiChange: true };
  }
  // Screenshots committed on the branch are evidence too (Issue #4355).
  const branchEvidence = findBranchEvidenceImages(changedFiles);
  if (branchEvidence.length > 0) {
    return { valid: true, isUiChange: true, branchEvidence };
  }

  return {
    valid: false,
    isUiChange: true,
    failureMessage: SCREENSHOT_FAILURE_MESSAGE,
  };
}
