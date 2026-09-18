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
 * Files that cannot carry a browser surface (Issue #1909): systems and
 * scripting languages, documents, configuration and lock files. When every
 * changed file is one of these, the summary's vocabulary alone must not make
 * the change a UI change — NEAT-AI-Ockham#198 was a Rust pruning change whose
 * write-up said `color` (graph colouring) and `visual` (visual inspection),
 * and the completion phase demanded a browser screenshot of a repository
 * that has no browser surface, failing a 48-minute run.
 */
const NON_UI_FILE_EXTENSIONS =
  /\.(rs|go|py|rb|java|kt|swift|c|cc|cpp|h|hpp|cs|sh|bash|zsh|ps1|md|txt|toml|ya?ml|json|jsonc|lock|sql|csv|ini|cfg|proto)$/i;

/**
 * Whether the keyword fallback may apply: it is meaningless when the changed
 * files are known and none of them could hold a UI. An empty or unknown list
 * keeps the fallback, as before.
 */
export function keywordFallbackApplies(changedFiles: string[]): boolean {
  if (changedFiles.length === 0) return true;
  return !changedFiles.every((f) => NON_UI_FILE_EXTENSIONS.test(f));
}

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
  /**
   * Changed files whose patch is nothing but version stamps (Issue #2300);
   * they do not make the change a UI change.
   */
  versionBumpOnlyFiles?: string[];
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

/** Whether a path's extension marks it as a file that can carry a UI. */
export function isUiSourceFile(path: string): boolean {
  return UI_FILE_EXTENSIONS.test(path);
}

/**
 * A version as release tooling stamps it into a page: `1.1.28`, `v1.1.28`,
 * `?v=1.1.28`, `-v1.1.28`, with an optional pre-release or build suffix.
 */
const VERSION_TOKEN = /\bv?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?\b/g;

/**
 * Whether a file's patch changes nothing but version stamps (Issue #2300).
 *
 * GRQ-health's `update_version.sh` rewrites `index.html`, `sw.js` and
 * `dashboard.js` on every change — `?v=1.1.28` → `?v=1.1.30` — and the
 * repository's own quality check demands it, so every PR there touched
 * three UI files and the gate demanded a screenshot of a backend change
 * (GRQ-health#211, a 44-minute run failed at completion).
 *
 * Each removed line is paired with the added line in the same position; the
 * patch is a bump when every pair carries a version token and reads
 * identically once every token is masked. An added line with no partner, a
 * reworded line, a changed selector — anything else — is a real change, and
 * the file counts as it always has.
 */
export function isVersionBumpOnly(patch: string): boolean {
  const removed: string[] = [];
  const added: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("-")) removed.push(line.slice(1));
    else if (line.startsWith("+")) added.push(line.slice(1));
  }
  if (added.length === 0 || added.length !== removed.length) return false;
  const masked = (s: string) => s.replace(VERSION_TOKEN, "{version}");
  return added.every((after, i) => {
    const maskedAfter = masked(after);
    return maskedAfter !== after && maskedAfter === masked(removed[i] ?? "");
  });
}

/**
 * Detect whether a set of changes is UI-related.
 *
 * Checks three signals:
 * 1. Changed file extensions (CSS, HTML, JSX, TSX, Vue, Svelte, etc.)
 * 2. Issue labels containing UI-related keywords
 * 3. PR summary content containing UI-specific terms
 *
 * A changed file named in `versionBumpOnlyFiles` — one whose patch
 * {@link isVersionBumpOnly} accepted — is set aside from the first and
 * third signals (Issue #2300): it changed, but not in any way a screenshot
 * could show.
 */
export function detectUiChanges(
  prSummaryContent: string,
  issueLabels: string,
  changedFiles: string[],
  versionBumpOnlyFiles: ReadonlySet<string> = new Set(),
): boolean {
  const substantive = changedFiles.filter((f) => !versionBumpOnlyFiles.has(f));

  if (substantive.some((f) => UI_FILE_EXTENSIONS.test(f))) {
    return true;
  }

  if (UI_LABEL_PATTERN.test(issueLabels)) {
    return true;
  }

  // Issue #2300: a change that is nothing but version stamps has no UI to
  // show, whatever the summary says about the release.
  if (changedFiles.length > 0 && substantive.length === 0) return false;

  // Issue #1909: the keyword fallback only means something when a changed
  // file could carry a UI. A Rust/Go/Python/docs-only change is not one,
  // whatever its summary says.
  if (!keywordFallbackApplies(substantive)) return false;

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
    versionBumpOnlyFiles,
  } = options;

  if (skipScreenshotCheck) {
    return { valid: true, isUiChange: false, skipped: true };
  }

  const isUiChange = detectUiChanges(
    prSummaryContent,
    issueLabels,
    changedFiles,
    new Set(versionBumpOnlyFiles ?? []),
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
