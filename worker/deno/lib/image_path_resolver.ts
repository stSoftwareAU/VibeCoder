/**
 * Image path resolver — soft-gate rewriting of broken in-repo image
 * references in a PR body (Issue #2229).
 *
 * `resolveImagePaths()` is a pure transform on a markdown body string. It
 * walks `![alt](path)` references, leaves external/absolute/already-correct
 * paths alone, and rewrites a broken relative path when there is exactly one
 * matching image file on disk (by basename, then a fuzzy fallback). Ambiguous
 * or unresolved references are reported as warnings and left unchanged.
 *
 * The function never moves files and never throws on missing files — it logs
 * via the returned warnings and continues.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** Image file extensions considered when matching candidates. */
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"];

/** Directories skipped by the default recursive file walker. */
const IGNORED_DIRS = new Set([".git", "node_modules", ".venv"]);

/** Markdown image syntax: `![alt](path)`. Mirrors findScreenshotReferences(). */
const IMAGE_PATTERN = /!\[[^\]]*\]\(([^)]+)\)/g;

/** A single path rewrite applied to the body. */
export interface PathRewrite {
  from: string;
  to: string;
}

/** A reference that could not be unambiguously rewritten. */
export interface PathResolutionWarning {
  path: string;
  reason: "no-candidate" | "ambiguous";
  candidates: string[];
}

/** Result of resolving image paths in a body. */
export interface ResolveImagePathsResult {
  body: string;
  rewrites: PathRewrite[];
  warnings: PathResolutionWarning[];
}

/** Return the final `/`-separated segment of a path. */
function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

/**
 * Determine whether a referenced path is external or absolute and so must be
 * left untouched (`http(s)://`, `data:`, protocol-relative `//`, or an
 * absolute filesystem path starting with `/`).
 */
function isExternalOrAbsolute(path: string): boolean {
  if (/^https?:\/\//i.test(path)) return true;
  if (/^data:/i.test(path)) return true;
  // Covers protocol-relative ("//host") and absolute ("/etc/...") paths.
  if (path.startsWith("/")) return true;
  return false;
}

/** Whether a path looks like an image file by extension. */
function isImageFile(path: string): boolean {
  const lower = path.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Compute candidate on-disk image files for a broken relative path.
 *
 * 1. Basename match — candidate has an identical basename.
 * 2. Fuzzy fallback (only if step 1 is empty): strip a leading `issue-NNN-`
 *    from the broken basename and retry the basename match.
 * 3. Suffix fallback (only if step 2 is empty): candidate basename ends with
 *    the stripped basename.
 */
function computeCandidates(brokenPath: string, imageFiles: string[]): string[] {
  const bn = basename(brokenPath);

  const exact = imageFiles.filter((f) => basename(f) === bn);
  if (exact.length > 0) return exact;

  const stripped = bn.replace(/^issue-\d+-/, "");
  if (stripped !== bn) {
    const fuzzy = imageFiles.filter((f) => basename(f) === stripped);
    if (fuzzy.length > 0) return fuzzy;
  }

  return imageFiles.filter((f) => basename(f).endsWith(stripped));
}

/**
 * Default file lister: recursively walk `root`, returning repo-relative paths
 * of every file, skipping ignored directories. Never throws — unreadable
 * directories are silently skipped.
 */
async function defaultListFiles(root: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string, rel: string): Promise<void> {
    let entries: AsyncIterable<Deno.DirEntry>;
    try {
      entries = Deno.readDir(dir);
    } catch {
      return;
    }
    try {
      for await (const entry of entries) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory) {
          if (IGNORED_DIRS.has(entry.name)) continue;
          await walk(`${dir}/${entry.name}`, childRel);
        } else if (entry.isFile) {
          results.push(childRel);
        }
      }
    } catch {
      // Stop walking this directory on error; keep what we have.
    }
  }

  await walk(root, "");
  return results;
}

/**
 * Walk `![alt](path)` references in a PR body and rewrite broken in-repo
 * relative image paths to a matching on-disk file, returning warnings for
 * ambiguous or unresolved cases.
 *
 * @param body - The PR body markdown.
 * @param repoPath - Repository root used to list candidate files.
 * @param options - Optional `listFilesFn` injection for testability.
 * @returns The (possibly) rewritten body plus rewrites and warnings.
 */
export async function resolveImagePaths(
  body: string,
  repoPath: string,
  options?: { listFilesFn?: (root: string) => Promise<string[]> },
): Promise<ResolveImagePathsResult> {
  const listFilesFn = options?.listFilesFn ?? defaultListFiles;
  const allFiles = await listFilesFn(repoPath);
  const existing = new Set(allFiles);
  const imageFiles = allFiles.filter(isImageFile);

  const rewrites: PathRewrite[] = [];
  const warnings: PathResolutionWarning[] = [];
  const rewriteMap = new Map<string, string>();
  const seen = new Set<string>();

  for (const match of body.matchAll(IMAGE_PATTERN)) {
    const path = match[1];
    if (!path || seen.has(path)) continue;
    seen.add(path);

    if (isExternalOrAbsolute(path)) continue;
    // Already points at a real file in the repo — nothing to do.
    if (existing.has(path)) continue;

    const candidates = computeCandidates(path, imageFiles);
    if (candidates.length === 0) {
      warnings.push({ path, reason: "no-candidate", candidates: [] });
    } else if (candidates.length > 1) {
      warnings.push({ path, reason: "ambiguous", candidates });
    } else {
      const to = candidates[0];
      if (to !== undefined) {
        rewrites.push({ from: path, to });
        rewriteMap.set(path, to);
      }
    }
  }

  let newBody = body;
  if (rewriteMap.size > 0) {
    newBody = body.replace(IMAGE_PATTERN, (full, path: string) => {
      const to = rewriteMap.get(path);
      return to ? full.replace(`(${path})`, `(${to})`) : full;
    });
  }

  return { body: newBody, rewrites, warnings };
}
