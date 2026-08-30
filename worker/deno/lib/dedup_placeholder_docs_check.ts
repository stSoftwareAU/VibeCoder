/**
 * Docs guard: a scan doc that lists the deterministic dedup placeholder must
 * list the semantic one beside it (Issue #541).
 *
 * Every judgement-bearing idle-task scan now receives **two** repo-wide dedup
 * lists — `{{KNOWN_OPEN_FINDING_IDS}}` (finding-id markers, Issue #539) and
 * `{{OPEN_ISSUE_TITLES}}` (all open issue titles, Issue #537). A scan doc that
 * enumerates only the first describes dedup as it behaved before that pair
 * existed, and the next template author copies the older, label-scoped shape —
 * the defect that let `github-actions-audit` re-file NEAT-AI-Rebase #64 over
 * the already-open #37.
 *
 * The check therefore fails loudly when a published doc names the first
 * placeholder without the second. `docs/archive/` is excluded: PR summaries are
 * a historical record and legitimately describe the one-list world.
 *
 * Enforced by this repository's own Deno test
 * (`worker/deno/tests/dedup_placeholder_docs_test.ts`), deliberately *not* by a
 * shared quality-gate check: the gate runs against every monitored repository,
 * and only this repository owns the scan prompts.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

/** The deterministic finding-id skip-list placeholder. */
export const DETERMINISTIC_PLACEHOLDER = "{{KNOWN_OPEN_FINDING_IDS}}";

/** The semantic all-open-issue-titles skip-list placeholder. */
export const SEMANTIC_PLACEHOLDER = "{{OPEN_ISSUE_TITLES}}";

/** Documentation subtrees excluded from the check. */
const EXCLUDED_PREFIXES = ["docs/archive/"];

/** Status of the dedup-placeholder documentation check. */
export type DedupPlaceholderDocsStatus = "PASSED" | "SKIPPED" | "FAILED";

/** A doc that names the deterministic placeholder but not the semantic one. */
export interface DedupPlaceholderViolation {
  /** Repo-relative path of the offending file. */
  file: string;
  /** 1-based line of the first deterministic-placeholder mention. */
  line: number;
}

/** Structured result of the dedup-placeholder documentation check. */
export interface DedupPlaceholderDocsResult {
  status: DedupPlaceholderDocsStatus;
  /** Human-readable output for a quality summary or test failure. */
  output: string;
  /** Docs naming the deterministic placeholder without the semantic one. */
  violations: DedupPlaceholderViolation[];
  /** Docs that name the deterministic placeholder at all. */
  filesScanned: number;
}

/**
 * Scan one document's content for the missing-semantic-placeholder defect.
 *
 * Returns `null` for a doc that never mentions `{{KNOWN_OPEN_FINDING_IDS}}` —
 * the rule only binds docs that enumerate the dedup placeholders at all — and
 * for a doc that names both. Exposed for unit-testing the rule without the
 * filesystem.
 */
export function scanDedupPlaceholderContent(
  relPath: string,
  content: string,
): DedupPlaceholderViolation | null {
  const index = content.indexOf(DETERMINISTIC_PLACEHOLDER);
  if (index === -1) return null;
  if (content.includes(SEMANTIC_PLACEHOLDER)) return null;
  const line = content.slice(0, index).split("\n").length;
  return { file: relPath, line };
}

/** Whether a repo-relative path is inside an excluded subtree. */
export function isExcludedDoc(relPath: string): boolean {
  return EXCLUDED_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

/**
 * Run the dedup-placeholder documentation check across a repository tree.
 *
 * SKIPPED when there is no `docs/` directory (e.g. invoked on a repo that has
 * none); PASSED when every doc naming the deterministic placeholder also names
 * the semantic one; FAILED with the offending files otherwise.
 */
export async function runDedupPlaceholderDocsCheck(
  rootDir: string,
): Promise<DedupPlaceholderDocsResult> {
  const files: string[] = [];
  try {
    const stat = await Deno.stat(`${rootDir}/docs`);
    if (!stat.isDirectory) return skipped("no docs directory found");
  } catch {
    return skipped("no docs directory found");
  }
  await walkDocs(`${rootDir}/docs`, "docs", files);
  files.sort();

  const violations: DedupPlaceholderViolation[] = [];
  let scanned = 0;
  for (const relPath of files) {
    let content: string;
    try {
      content = await Deno.readTextFile(`${rootDir}/${relPath}`);
    } catch {
      continue;
    }
    if (!content.includes(DETERMINISTIC_PLACEHOLDER)) continue;
    scanned++;
    const violation = scanDedupPlaceholderContent(relPath, content);
    if (violation) violations.push(violation);
  }

  if (violations.length === 0) {
    return {
      status: "PASSED",
      output: `dedup placeholder docs: PASSED (${scanned} doc(s) list both ` +
        `${DETERMINISTIC_PLACEHOLDER} and ${SEMANTIC_PLACEHOLDER})`,
      violations,
      filesScanned: scanned,
    };
  }

  const lines = [
    `dedup placeholder docs: FAILED (${violations.length} doc(s) list ` +
    `${DETERMINISTIC_PLACEHOLDER} without ${SEMANTIC_PLACEHOLDER})`,
    "",
    "Both dedup lists are repo-wide and every judgement-bearing scan receives",
    "both, so a doc that enumerates one must enumerate the other. See",
    "docs/IDLE-TASK-FRAMEWORK.md — 'Cross-label dedup'.",
    "",
    ...violations.map((v) => `  ${v.file}:${v.line} lists only the finding-id`),
  ];

  return {
    status: "FAILED",
    output: lines.join("\n"),
    violations,
    filesScanned: scanned,
  };
}

/** Collect every non-excluded `.md` file under a docs directory. */
async function walkDocs(
  absDir: string,
  relDir: string,
  acc: string[],
): Promise<void> {
  for await (const entry of Deno.readDir(absDir)) {
    const relPath = `${relDir}/${entry.name}`;
    if (entry.isDirectory) {
      if (isExcludedDoc(`${relPath}/`)) continue;
      await walkDocs(`${absDir}/${entry.name}`, relPath, acc);
    } else if (entry.isFile && entry.name.endsWith(".md")) {
      if (isExcludedDoc(relPath)) continue;
      acc.push(relPath);
    }
  }
}

/** Build a SKIPPED result with the given reason. */
function skipped(reason: string): DedupPlaceholderDocsResult {
  return {
    status: "SKIPPED",
    output: `dedup placeholder docs: SKIPPED (${reason})`,
    violations: [],
    filesScanned: 0,
  };
}
