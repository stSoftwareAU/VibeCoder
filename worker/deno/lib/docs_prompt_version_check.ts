/**
 * Quality gate check: published documentation must not reference a stale
 * prompt version (Issue #2286).
 *
 * The check walks the published documentation set — the root instruction
 * documents (`AGENTS.md`, `CODING-STANDARDS.md`, `DESIGN-PRINCIPLES.md`) and
 * every `.md` file under `docs/` except the
 * `docs/archive/pr-summaries/` historical record — and grepps each line
 * for references of the form `prompts/<type>/vN(.md)?`. For every match
 * the latest version on disk for `<type>` is looked up via
 * `getLatestVersion()` from `prompt_manager.ts`. The match fails the
 * check when `N < latest` unless one of two escape hatches applies:
 *
 *   1. The line contains a `<!-- pinned: ... -->` HTML comment marker —
 *      used when a specific historical version must be cited.
 *   2. The match is paired with the wording "from vN" before it, or
 *      "onward"/"onwards" after it, on the same line — the canonical way
 *      to refer to a behaviour introduced in a given version.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { getLatestVersion } from "./prompt_manager.ts";

/** Status of the docs prompt-version freshness check. */
export type DocsPromptVersionStatus = "PASSED" | "SKIPPED" | "FAILED";

/** A single stale-reference violation. */
export interface DocsPromptVersionViolation {
  /** Relative path of the offending file. */
  file: string;
  /** 1-based line number of the offending reference. */
  line: number;
  /** The prompt type that was referenced (e.g. `coding_guidelines`). */
  promptType: string;
  /** The version that was referenced (e.g. `v14`). */
  referencedVersion: string;
  /** The latest version currently on disk (e.g. `v25`). */
  latestVersion: string;
  /** The raw line content for context. */
  content: string;
}

/** Structured result of the docs prompt-version freshness check. */
export interface DocsPromptVersionResult {
  status: DocsPromptVersionStatus;
  /** Human-readable output for the quality gate summary. */
  output: string;
  /** All violations found (empty when status is PASSED). */
  violations: DocsPromptVersionViolation[];
  /** Number of files scanned. */
  filesScanned: number;
  /** Total references inspected (across all files, including exempt). */
  referencesScanned: number;
}

/**
 * Matches `prompts/<type>/vN` and `prompts/<type>/vN.md`, capturing the
 * type and the version number. The `<type>` segment is constrained to
 * the lowercase letters / underscore / hyphen used by the project's
 * prompt-directory naming convention.
 */
const PROMPT_VERSION_PATTERN = /prompts\/([a-z][a-z0-9_-]*)\/v(\d+)(?:\.md)?/g;

/** HTML comment marker that exempts a line from the freshness check. */
const PINNED_MARKER_PATTERN = /<!--\s*pinned\b[^>]*-->/;

/**
 * Determine whether a single match is exempt from the freshness check.
 *
 * The match is exempt when:
 *   - the host line carries a `<!-- pinned: ... -->` marker, OR
 *   - the word `from` appears immediately before the match on the same
 *     line (i.e. between the last whitespace/punctuation and the match),
 *     OR
 *   - the word `onward` or `onwards` appears immediately after the match
 *     on the same line.
 */
export function isMatchExempt(
  line: string,
  matchIndex: number,
  matchLength: number,
): boolean {
  if (PINNED_MARKER_PATTERN.test(line)) return true;

  // Inspect a small window before the match for the `from` keyword and
  // a small window after the match for `onward`/`onwards`. Markdown
  // backticks, brackets, parentheses, and punctuation are common
  // between the keyword and the path reference, so allow any
  // non-word characters between the keyword and the match.
  const before = line.slice(0, matchIndex);
  const after = line.slice(matchIndex + matchLength);

  if (/\bfrom\W*$/i.test(before)) return true;
  if (/^\W*onwards?\b/i.test(after)) return true;

  return false;
}

/**
 * Files / directories under `docs/` that are excluded from the scan.
 * The entire `docs/archive/` subtree is a historical record — both PR
 * summaries and audit documents legitimately cite old prompt versions.
 */
const DOCS_EXCLUDED_PREFIXES = ["docs/archive/"];

/**
 * Collect the set of files to scan for stale prompt-version references.
 *
 * Returns relative paths (relative to `rootDir`), sorted for deterministic
 * output. The set is the union of:
 *   - the root instruction documents `AGENTS.md`, `CODING-STANDARDS.md`, and
 *     `DESIGN-PRINCIPLES.md` (each when present), and
 *   - every `.md` file under `docs/` except the excluded prefixes.
 */
export async function collectDocsFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];

  for (
    const top of ["AGENTS.md", "CODING-STANDARDS.md", "DESIGN-PRINCIPLES.md"]
  ) {
    try {
      const stat = await Deno.stat(`${rootDir}/${top}`);
      if (stat.isFile) files.push(top);
    } catch { /* file not present — skip */ }
  }

  await walkDocs(`${rootDir}/docs`, "docs", files);

  files.sort();
  return files;
}

async function walkDocs(
  absDir: string,
  relDir: string,
  acc: string[],
): Promise<void> {
  // Deno.readDir() returns the iterable synchronously but defers the
  // actual readdir() syscall until iteration, so a non-existent
  // directory throws on the first `for await` rather than at
  // assignment. Probe up-front with Deno.stat() so callers do not see
  // a NotFound on a perfectly normal "no docs/ directory" case.
  try {
    const stat = await Deno.stat(absDir);
    if (!stat.isDirectory) return;
  } catch {
    return;
  }

  for await (const entry of Deno.readDir(absDir)) {
    const absPath = `${absDir}/${entry.name}`;
    const relPath = `${relDir}/${entry.name}`;
    if (entry.isDirectory) {
      // Skip excluded subtrees outright so we never recurse into the
      // ~hundreds of PR-summary archive files.
      if (DOCS_EXCLUDED_PREFIXES.some((p) => `${relPath}/`.startsWith(p))) {
        continue;
      }
      await walkDocs(absPath, relPath, acc);
    } else if (entry.isFile && entry.name.endsWith(".md")) {
      if (DOCS_EXCLUDED_PREFIXES.some((p) => relPath.startsWith(p))) {
        continue;
      }
      acc.push(relPath);
    }
  }
}

/**
 * Scan a single file's content for stale prompt-version references.
 *
 * Exposed for unit-testing the matching/exemption logic in isolation
 * from the filesystem.
 */
export async function scanContent(
  relPath: string,
  content: string,
  promptsDir: string,
): Promise<{ violations: DocsPromptVersionViolation[]; references: number }> {
  // Cache latest-version lookups so a file with many references to the
  // same prompt type only pays the directory-read cost once.
  const latestCache = new Map<string, string | null>();
  const violations: DocsPromptVersionViolation[] = [];
  let references = 0;

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    PROMPT_VERSION_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PROMPT_VERSION_PATTERN.exec(line)) !== null) {
      references++;
      const promptType = match[1]!;
      const referencedNumber = parseInt(match[2]!, 10);
      const referencedVersion = `v${referencedNumber}`;
      const matchIndex = match.index;
      const matchLength = match[0].length;

      if (isMatchExempt(line, matchIndex, matchLength)) continue;

      let latestVersion = latestCache.get(promptType) ?? null;
      if (latestVersion === null && !latestCache.has(promptType)) {
        const result = await getLatestVersion(promptType, promptsDir);
        latestVersion = result.ok ? result.value : null;
        latestCache.set(promptType, latestVersion);
      }

      // Unknown prompt type — leave it alone. A typo or a deliberate
      // reference to a prompt that does not (yet) exist is not the
      // concern of this check. The existing prompt placeholder
      // validation covers known-template structural issues.
      if (latestVersion === null) continue;

      const latestNumber = parseInt(latestVersion.replace(/^v/, ""), 10);
      if (referencedNumber < latestNumber) {
        violations.push({
          file: relPath,
          line: i + 1,
          promptType,
          referencedVersion,
          latestVersion,
          content: line.trim(),
        });
      }
    }
  }

  return { violations, references };
}

/**
 * Run the docs prompt-version freshness check across the repository.
 *
 * SKIPPED when no documentation files are present (e.g. invoked on a
 * non-VibeCoder repo); PASSED when no stale references are found;
 * FAILED with a list of offending references otherwise.
 */
export async function runDocsPromptVersionCheck(
  rootDir: string,
): Promise<DocsPromptVersionResult> {
  const files = await collectDocsFiles(rootDir);
  if (files.length === 0) {
    return {
      status: "SKIPPED",
      output: "docs prompt versions: SKIPPED (no documentation files found)",
      violations: [],
      filesScanned: 0,
      referencesScanned: 0,
    };
  }

  const promptsDir = `${rootDir}/prompts`;
  try {
    const stat = await Deno.stat(promptsDir);
    if (!stat.isDirectory) {
      return {
        status: "SKIPPED",
        output: "docs prompt versions: SKIPPED (no prompts/ directory)",
        violations: [],
        filesScanned: 0,
        referencesScanned: 0,
      };
    }
  } catch {
    return {
      status: "SKIPPED",
      output: "docs prompt versions: SKIPPED (no prompts/ directory)",
      violations: [],
      filesScanned: 0,
      referencesScanned: 0,
    };
  }

  const violations: DocsPromptVersionViolation[] = [];
  let references = 0;
  for (const relPath of files) {
    let content: string;
    try {
      content = await Deno.readTextFile(`${rootDir}/${relPath}`);
    } catch {
      continue;
    }
    const { violations: fileViolations, references: fileRefs } =
      await scanContent(relPath, content, promptsDir);
    references += fileRefs;
    violations.push(...fileViolations);
  }

  if (violations.length === 0) {
    return {
      status: "PASSED",
      output:
        `docs prompt versions: PASSED (${files.length} file(s), ${references} reference(s) checked)`,
      violations: [],
      filesScanned: files.length,
      referencesScanned: references,
    };
  }

  const lines = [
    `docs prompt versions: FAILED (${violations.length} stale reference(s) in ${files.length} file(s) scanned)`,
    "",
    "Stale prompt-version references — replace `prompts/<type>/vN[.md]` with",
    "the directory-only form `prompts/<type>/` or use the wording",
    '"from vN onward". Use a `<!-- pinned: reason -->` marker on the same',
    "line only when a specific historical version must be cited.",
    "",
    ...violations.map((v) =>
      `  ${v.file}:${v.line} references prompts/${v.promptType}/${v.referencedVersion}` +
      ` (latest is ${v.latestVersion}): ${v.content}`
    ),
  ];

  return {
    status: "FAILED",
    output: lines.join("\n"),
    violations,
    filesScanned: files.length,
    referencesScanned: references,
  };
}
