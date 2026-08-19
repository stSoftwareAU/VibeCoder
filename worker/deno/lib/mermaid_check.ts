/**
 * Quality gate check: every Mermaid block in repo Markdown is well-formed
 * (Issue #1683).
 *
 * Wraps `mermaid_validator.ts` so the quality gate can scan every `.md`
 * file in the repository in one go and report failures with file path,
 * opening-fence line number, and diagram type. Closes the gap that let
 * Issue #1663 ship — `mermaid_validator.ts` was only used in a single
 * regression test, so a syntax error in any other Markdown file would
 * still pass through.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import {
  type MermaidFileFailure,
  validateMermaidFile,
} from "./mermaid_validator.ts";

/** Status of the mermaid check. */
export type MermaidCheckStatus = "PASSED" | "SKIPPED" | "FAILED";

/** Structured result of running the mermaid check. */
export interface MermaidCheckResult {
  status: MermaidCheckStatus;
  /** Human-readable output for the quality gate summary. */
  output: string;
  /** All failures encountered (empty when status is PASSED). */
  failures: MermaidFileFailure[];
  /** Number of `.md` files scanned. */
  filesScanned: number;
  /** Total number of mermaid blocks validated across all files. */
  blocksScanned: number;
}

/** Directories that are never scanned (build artefacts, vendored code). */
const SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "_site",
  "vendor",
  ".jekyll-cache",
]);

/**
 * Relative path prefixes whose Markdown is intentionally invalid and must not
 * fail the repo-wide Mermaid gate.
 *
 * Target repos (e.g. FLEET Issue #3275) keep a known-bad diagram under
 * `test/fixtures/mermaid/` so their CI self-regression can assert the gate
 * still rejects it (`--expect-invalid`). Scanning that fixture here would
 * forever file baseline-carryover trackers (#3315 / #3328) for a deliberate
 * failure — the same path the target CI already excludes from its change-
 * scoped Mermaid lint.
 */
const SKIP_MARKDOWN_PREFIXES = [
  "test/fixtures/mermaid/",
];

/** Markdown file extension. */
const MARKDOWN_EXT_PATTERN = /\.md$/;

/**
 * True when `relPath` is a known-bad Mermaid fixture that must be skipped by
 * the full-tree quality-gate scan.
 */
export function isSkippedMermaidFixturePath(relPath: string): boolean {
  const normalised = relPath.replaceAll("\\", "/");
  return SKIP_MARKDOWN_PREFIXES.some((prefix) =>
    normalised === prefix.slice(0, -1) || normalised.startsWith(prefix)
  );
}

/**
 * Recursively collect every `.md` file under `rootDir`.
 *
 * Skips `.git`, `node_modules`, and other build/vendor directories, plus
 * intentional known-bad Mermaid fixtures. Returns paths relative to
 * `rootDir`, sorted for deterministic output.
 */
export async function collectMarkdownFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];
  await walkMarkdown(rootDir, "", files);
  return files.sort();
}

async function walkMarkdown(
  absDir: string,
  relDir: string,
  acc: string[],
): Promise<void> {
  let entries: AsyncIterable<Deno.DirEntry>;
  try {
    entries = Deno.readDir(absDir);
  } catch {
    return;
  }

  for await (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const absPath = `${absDir}/${entry.name}`;
    const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      // Skip the whole known-bad fixture tree so we never even open it.
      if (isSkippedMermaidFixturePath(`${relPath}/`)) continue;
      await walkMarkdown(absPath, relPath, acc);
    } else if (entry.isFile && MARKDOWN_EXT_PATTERN.test(entry.name)) {
      if (isSkippedMermaidFixturePath(relPath)) continue;
      acc.push(relPath);
    }
  }
}

/**
 * Run the mermaid check across every `.md` file in `rootDir`.
 *
 * - Scans recursively, skipping common build/vendor directories.
 * - Validates every Mermaid block found.
 * - Returns SKIPPED when no `.md` files exist, PASSED when none fail,
 *   FAILED otherwise.
 */
export async function runMermaidCheck(
  rootDir: string,
): Promise<MermaidCheckResult> {
  const files = await collectMarkdownFiles(rootDir);
  if (files.length === 0) {
    return {
      status: "SKIPPED",
      output: "mermaid: SKIPPED (no .md files found)",
      failures: [],
      filesScanned: 0,
      blocksScanned: 0,
    };
  }

  const failures: MermaidFileFailure[] = [];
  let blocksScanned = 0;
  for (const relPath of files) {
    const absPath = `${rootDir}/${relPath}`;
    const result = await validateMermaidFile(absPath, relPath);
    if (!result.ok) {
      failures.push({
        file: relPath,
        startLine: 0,
        type: "",
        error: result.error.message,
      });
      continue;
    }
    failures.push(...result.value);
    // Block count is implicit in the validator; recompute for the summary.
    blocksScanned += await countMermaidBlocksInFile(absPath);
  }

  if (failures.length === 0) {
    return {
      status: "PASSED",
      output:
        `mermaid: PASSED (${files.length} file(s), ${blocksScanned} block(s) checked)`,
      failures: [],
      filesScanned: files.length,
      blocksScanned,
    };
  }

  const lines = [
    `mermaid: FAILED (${failures.length} block(s) failed in ${files.length} file(s) scanned)`,
    "",
    "Mermaid blocks with syntax errors:",
    ...failures.map((f) =>
      `  ${f.file}:${f.startLine} (${f.type || "no-declaration"}): ${f.error}`
    ),
    "",
    "Fix the offending blocks or remove them. The validator lives in " +
    "worker/deno/lib/mermaid_validator.ts (Issue #1683).",
  ];

  return {
    status: "FAILED",
    output: lines.join("\n"),
    failures,
    filesScanned: files.length,
    blocksScanned,
  };
}

/**
 * Count `mermaid` fenced blocks in a markdown file. Helper for summary
 * stats only — the validation pass already enumerates blocks via
 * `extractMermaidBlocks`, but we recount cheaply rather than threading
 * the count back through the validator API.
 */
async function countMermaidBlocksInFile(absPath: string): Promise<number> {
  let content: string;
  try {
    content = await Deno.readTextFile(absPath);
  } catch {
    return 0;
  }
  let count = 0;
  for (const line of content.split("\n")) {
    if (/^\s*```mermaid\s*$/.test(line)) count++;
  }
  return count;
}
