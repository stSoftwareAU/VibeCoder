/**
 * Screenshot evidence validation for PR completion (Issue #1185).
 *
 * Detects UI-related changes from changed file extensions only (Issue
 * #2959). When UI changes are detected, validates that screenshot evidence
 * is present in the PR summary.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { findScreenshotReferences } from "./pr_evidence.ts";

/**
 * Extensions that make a changed file a UI file (Issue #2959). The issue
 * prompt states the same list up front (Issue #3019); a drift test pins them.
 */
export const UI_FILE_EXTENSIONS: readonly string[] = [
  "css",
  "scss",
  "sass",
  "less",
  "html",
  "htm",
  "jsx",
  "tsx",
  "vue",
  "svelte",
];

const UI_FILE_PATTERN = new RegExp(
  `\\.(${UI_FILE_EXTENSIONS.join("|")})$`,
  "i",
);

export interface ScreenshotValidationOptions {
  prSummaryContent: string;
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
  return UI_FILE_PATTERN.test(path);
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
 * One signal only (Issue #2959): a changed file whose extension is a UI
 * file extension (CSS, HTML, JSX, TSX, Vue, Svelte, etc.). Issue labels and
 * PR summary wording are deliberately ignored — a `lang:design` label or a
 * summary using UI-flavoured words such as "colour" or "modal" used to
 * demand a screenshot of a change with no browser surface at all.
 *
 * A changed file named in `versionBumpOnlyFiles` — one whose patch
 * {@link isVersionBumpOnly} accepted — is set aside first (Issue #2300): it
 * changed, but not in any way a screenshot could show.
 */
export function detectUiChanges(
  changedFiles: string[],
  versionBumpOnlyFiles: ReadonlySet<string> = new Set(),
): boolean {
  const substantive = changedFiles.filter((f) => !versionBumpOnlyFiles.has(f));
  return substantive.some((f) => UI_FILE_PATTERN.test(f));
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
    changedFiles,
    skipScreenshotCheck,
    versionBumpOnlyFiles,
  } = options;

  if (skipScreenshotCheck) {
    return { valid: true, isUiChange: false, skipped: true };
  }

  const isUiChange = detectUiChanges(
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
