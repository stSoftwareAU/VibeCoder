/**
 * PR evidence handling for the Vibe Coder worker (Issue #915).
 *
 * Handles screenshot evidence processing, URL conversion, and
 * evidence validation for PR summaries.
 *
 * Replaces the evidence-related functions from worker/shared/pr_manager.sh.
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";

/** Default screenshot evidence directory relative to repo root. */
export const DEFAULT_SCREENSHOT_DIR = "docs/evidence";

/** Options for processing screenshot evidence. */
export interface ProcessEvidenceOptions {
  /** Path to the repository root */
  repoPath: string;
  /** GitHub owner/repo for generating raw content URLs */
  githubRepo?: string;
  /** Screenshot evidence directory (relative to repo root) */
  screenshotDir?: string;
  /** Function to run git commands (injectable for testing) */
  gitCommandFn?: (args: string[]) => Promise<string>;
  /** Function to upload screenshots (injectable for testing) */
  uploadFn?: (path: string) => Promise<Result<string, Error>>;
  /** ImgBB API key for screenshot uploads */
  imgbbApiKey?: string;
}

/** Result of evidence processing. */
export interface EvidenceProcessingResult {
  /** Updated PR summary content */
  content: string;
  /** Number of screenshots found */
  screenshotsFound: number;
  /** Number of screenshots uploaded to imgbb */
  screenshotsUploaded: number;
  /** Number of screenshots converted to GitHub URLs */
  screenshotsConverted: number;
  /** Number of screenshots that failed to upload */
  screenshotsFailed: number;
}

/**
 * Convert a relative screenshot path to a GitHub raw content URL (Issue #231).
 *
 * Using the commit SHA instead of a branch name ensures the URL remains valid
 * after the feature branch is merged and deleted.
 *
 * @param relativePath - Relative path to the screenshot
 * @param githubRepo - GitHub owner/repo (e.g., "stSoftwareAU/VibeCoder")
 * @param commitSha - Git commit SHA to use in the URL
 * @returns GitHub raw content URL
 */
export function convertScreenshotToGithubUrl(
  relativePath: string,
  githubRepo: string,
  commitSha: string,
): string {
  return `https://github.com/${githubRepo}/raw/${commitSha}/${relativePath}`;
}

/** Image file extensions recognised when rewriting in-repo evidence links. */
const RAW_URL_IMAGE_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
];

/** Markdown image syntax: `![alt](path)`. */
const RAW_URL_IMAGE_PATTERN = /!\[[^\]]*\]\(([^)]+)\)/g;

/** A single relative-to-raw-URL rewrite applied to a PR body. */
export interface EvidenceUrlConversion {
  from: string;
  to: string;
}

/** Result of converting in-repo evidence images to raw URLs. */
export interface ConvertEvidenceImagesResult {
  content: string;
  conversions: EvidenceUrlConversion[];
}

/** Options for {@link convertEvidenceImagesToRawUrls}. */
export interface ConvertEvidenceImagesOptions {
  /** Repository root used to confirm a referenced file exists on disk. */
  repoPath: string;
  /** GitHub owner/repo (e.g. "stSoftwareAU/VibeCoder"). */
  githubRepo: string;
  /** Commit SHA pinned into the raw URL so it survives branch deletion. */
  commitSha: string;
  /** Existence predicate (injectable for testing). */
  fileExistsFn?: (repoPath: string, relativePath: string) => Promise<boolean>;
}

/** Whether a referenced path is external or absolute and must be left alone. */
function isExternalOrAbsolutePath(path: string): boolean {
  if (/^https?:\/\//i.test(path)) return true;
  if (/^data:/i.test(path)) return true;
  // Covers protocol-relative ("//host") and absolute ("/etc/...") paths.
  if (path.startsWith("/")) return true;
  return false;
}

/**
 * Whether a relative path escapes the repository root via a `..` segment
 * (Issue #3658).
 *
 * The existence check below stats `${repoPath}/${relativePath}`, so a traversal
 * segment would probe outside the repo and leak the probed path into the
 * published PR body. A `..` inside a filename (`shot..final.png`) is fine —
 * only a whole segment counts.
 */
function hasTraversalSegment(path: string): boolean {
  return path.split("/").includes("..");
}

/** Whether a path looks like an image file by extension (query/hash stripped). */
function isImageReference(path: string): boolean {
  const bare = path.split(/[?#]/)[0]?.toLowerCase() ?? "";
  return RAW_URL_IMAGE_EXTENSIONS.some((ext) => bare.endsWith(ext));
}

/** Default existence check: a regular file at `${repoPath}/${relativePath}`. */
async function defaultFileExists(
  repoPath: string,
  relativePath: string,
): Promise<boolean> {
  try {
    const info = await Deno.stat(`${repoPath}/${relativePath}`);
    return info.isFile;
  } catch {
    return false;
  }
}

/**
 * Rewrite in-repo relative evidence image references to absolute GitHub
 * raw-content URLs (Issue #2985).
 *
 * GitHub does not resolve relative image paths in pull-request descriptions,
 * so `![alt](docs/evidence/foo.png)` renders as a broken image even though the
 * same markdown renders correctly in a committed file. This walks every
 * `![alt](path)` reference and, for each relative image path that points at a
 * file committed in the repo, rewrites it to
 * `https://github.com/<repo>/raw/<sha>/<path>`. External, absolute, and
 * already-converted URLs are left untouched, and a missing file is left as-is
 * (the soft-gate `resolveImagePaths` reports those). Paths containing a `..`
 * segment are rejected before any filesystem access (Issue #3658).
 *
 * Pure transform on the body string — never moves files, never throws.
 *
 * @param body - The PR body markdown.
 * @param options - Repo path, GitHub repo, commit SHA, and existence predicate.
 * @returns The (possibly) rewritten body plus the list of conversions applied.
 */
export async function convertEvidenceImagesToRawUrls(
  body: string,
  options: ConvertEvidenceImagesOptions,
): Promise<ConvertEvidenceImagesResult> {
  if (!options.githubRepo || !options.commitSha) {
    return { content: body, conversions: [] };
  }

  const fileExistsFn = options.fileExistsFn ?? defaultFileExists;
  const conversions: EvidenceUrlConversion[] = [];
  const rewriteMap = new Map<string, string>();
  const seen = new Set<string>();

  for (const match of body.matchAll(RAW_URL_IMAGE_PATTERN)) {
    const path = match[1];
    if (!path || seen.has(path)) continue;
    seen.add(path);

    if (isExternalOrAbsolutePath(path)) continue;
    if (!isImageReference(path)) continue;

    const relativePath = path.replace(/^\.\//, "");
    // Reject traversal before any filesystem access (Issue #3658).
    if (hasTraversalSegment(relativePath)) continue;
    if (!(await fileExistsFn(options.repoPath, relativePath))) continue;

    const to = convertScreenshotToGithubUrl(
      relativePath,
      options.githubRepo,
      options.commitSha,
    );
    rewriteMap.set(path, to);
    conversions.push({ from: path, to });
  }

  let content = body;
  if (rewriteMap.size > 0) {
    content = body.replace(RAW_URL_IMAGE_PATTERN, (full, path: string) => {
      const to = rewriteMap.get(path);
      return to ? full.replace(`(${path})`, `(${to})`) : full;
    });
  }

  return { content, conversions };
}

/**
 * Find screenshot references in markdown content.
 *
 * Looks for markdown image syntax that references local screenshot files.
 *
 * @param content - Markdown content to search
 * @returns Array of referenced screenshot paths
 */
export function findScreenshotReferences(content: string): string[] {
  const imagePattern = /!\[[^\]]*\]\(([^)]+)\)/g;
  const paths: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = imagePattern.exec(content)) !== null) {
    const path = match[1];
    if (path && /screenshot|\.png|\.jpg|\.jpeg|evidence/i.test(path)) {
      paths.push(path);
    }
  }

  return paths;
}

/**
 * Validate that PR summary contains appropriate evidence for UI changes.
 *
 * Checks whether the PR summary for a UI-related change includes screenshot
 * references. If the change appears to be UI-related but no screenshots are
 * found, appends a warning (Issue #188).
 *
 * @param prSummaryContent - The PR summary markdown content
 * @param issueLabels - Comma-separated issue labels
 * @returns Result with updated content (ok=true if valid, ok=false if UI change without screenshots)
 */
export function validatePrEvidence(
  prSummaryContent: string,
  issueLabels: string,
): Result<string, string> {
  let isUiChange = false;

  // Check issue labels for UI-related keywords (word boundaries to avoid
  // false positives like "build" matching "ui" — Issue #1296)
  if (/\b(ui|frontend|css|visual|design|layout|style)\b/i.test(issueLabels)) {
    isUiChange = true;
  }

  // Check PR summary content for strongly UI-specific keywords (Issue #311).
  // Uses word boundaries and requires at least two distinct UI keywords to
  // reduce false positives from common words in non-UI contexts (Issue #1296).
  if (!isUiChange) {
    const uiKeywords = [
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
    let matchCount = 0;
    for (const keyword of uiKeywords) {
      if (new RegExp(`\\b${keyword}\\b`, "i").test(prSummaryContent)) {
        matchCount++;
        if (matchCount >= 2) {
          isUiChange = true;
          break;
        }
      }
    }
  }

  if (isUiChange) {
    const refs = findScreenshotReferences(prSummaryContent);
    if (refs.length === 0) {
      const warning =
        `\n\n> **Screenshot evidence not provided**: This appears to be a UI-related change but no screenshots were included. For UI changes, use Playwright MCP to capture screenshots as evidence: \`browser_navigate\` to open a relevant URL, then \`browser_take_screenshot\` to save to \`docs/evidence/\`.`;
      return { ok: false, error: prSummaryContent + warning };
    }
  }

  return { ok: true, value: prSummaryContent };
}

/**
 * List screenshot files in a directory.
 *
 * @param dirPath - Path to the screenshot directory
 * @returns Array of file paths
 */
export async function listScreenshotFiles(dirPath: string): Promise<string[]> {
  const files: string[] = [];
  try {
    for await (const entry of Deno.readDir(dirPath)) {
      if (
        entry.isFile &&
        /\.(png|jpg|jpeg)$/i.test(entry.name)
      ) {
        files.push(`${dirPath}/${entry.name}`);
      }
    }
  } catch {
    // Directory doesn't exist or is unreadable
  }
  return files;
}

/**
 * Process screenshot evidence and update PR summary (Issue #231).
 *
 * 1. Finds all screenshots in the evidence directory
 * 2. Either uploads to imgbb or converts to GitHub raw URLs
 * 3. Returns updated PR summary with proper image URLs
 *
 * @param prSummaryContent - The PR summary content
 * @param options - Processing options
 * @returns Evidence processing result
 */
export async function processScreenshotEvidence(
  prSummaryContent: string,
  options: ProcessEvidenceOptions,
): Promise<EvidenceProcessingResult> {
  const screenshotDir = `${options.repoPath}/${
    options.screenshotDir ?? DEFAULT_SCREENSHOT_DIR
  }`;
  let updatedContent = prSummaryContent;
  let screenshotsFound = 0;
  let screenshotsUploaded = 0;
  let screenshotsConverted = 0;
  let screenshotsFailed = 0;

  const files = await listScreenshotFiles(screenshotDir);

  if (files.length === 0) {
    return {
      content: updatedContent,
      screenshotsFound: 0,
      screenshotsUploaded: 0,
      screenshotsConverted: 0,
      screenshotsFailed: 0,
    };
  }

  screenshotsFound = files.length;

  // Get commit SHA for GitHub raw URLs
  let commitSha = "";
  if (options.githubRepo && options.gitCommandFn) {
    try {
      commitSha = (await options.gitCommandFn([
        "-C",
        options.repoPath,
        "rev-parse",
        "HEAD",
      ])).trim();
    } catch {
      // Cannot get commit SHA
    }
  }

  const evidenceDir = options.screenshotDir ?? DEFAULT_SCREENSHOT_DIR;

  for (const screenshotPath of files) {
    const filename = screenshotPath.split("/").pop() ?? "";
    const relativePath = `${evidenceDir}/${filename}`;
    let targetUrl = "";

    // Try imgbb upload first
    if (options.imgbbApiKey && options.uploadFn) {
      const uploadResult = await options.uploadFn(screenshotPath);
      if (uploadResult.ok) {
        targetUrl = uploadResult.value;
        screenshotsUploaded++;
      } else {
        screenshotsFailed++;
      }
    }

    // Fall back to GitHub raw URL
    if (!targetUrl && options.githubRepo && commitSha) {
      targetUrl = convertScreenshotToGithubUrl(
        relativePath,
        options.githubRepo,
        commitSha,
      );
      screenshotsConverted++;
    }

    if (targetUrl) {
      // Replace local paths with the target URL
      updatedContent = updatedContent.replaceAll(relativePath, targetUrl);
      updatedContent = updatedContent.replaceAll(screenshotPath, targetUrl);
    }
  }

  // Add status notes
  if (screenshotsFound > 0) {
    if (options.imgbbApiKey && screenshotsFailed > 0) {
      updatedContent +=
        `\n\n> **Note**: ${screenshotsFailed} screenshot(s) could not be uploaded automatically. Check the \`${evidenceDir}/\` directory for local copies.`;
    } else if (!options.imgbbApiKey && screenshotsConverted === 0) {
      updatedContent +=
        `\n\n> **Note**: Screenshots have been captured to \`${evidenceDir}/\`. To include them in this PR, you can:\n> 1. Set \`VIBE_IMGBB_API_KEY\` for automatic uploads (get a free key from https://api.imgbb.com/)\n> 2. Manually upload screenshots via the GitHub web interface\n> 3. View screenshots locally in the repository`;
    }
  }

  return {
    content: updatedContent,
    screenshotsFound,
    screenshotsUploaded,
    screenshotsConverted,
    screenshotsFailed,
  };
}
