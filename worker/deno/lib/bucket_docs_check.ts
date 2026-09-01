/**
 * Docs guard: every per-language best-practice bucket must be documented in
 * `CODING-STANDARDS.md` (Issue #372).
 *
 * The language-specific rules live in `prompts/best_practices/buckets/` and
 * are injected only when a repository uses that language, so a reader of the
 * language-agnostic standard has no way to find them unless the standard
 * routes them there. Before this guard, `CODING-STANDARDS.md` mentioned the
 * bucket system nowhere at all — the Rust "prefer `?` over `unwrap()`" rule
 * was unfindable from the entry-point document.
 *
 * The check fails loudly when a bucket file exists with no link from the
 * standard, or when a bucket link in the standard does not resolve on disk —
 * so adding a new bucket without documenting it reddens CI.
 *
 * Enforced by this repository's own Deno test
 * (`worker/deno/tests/bucket_docs_test.ts`), deliberately *not* by a shared
 * quality-gate check: the gate runs against every monitored repository, and
 * only this repository owns the bucket guides.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

/** Directory holding the per-language bucket guides, relative to the root. */
export const BUCKETS_DIR = "prompts/best_practices/buckets";

/** Document that must route readers to the buckets. */
export const BUCKET_DOCS_FILE = "CODING-STANDARDS.md";

/** Status of the bucket-documentation check. */
export type BucketDocsStatus = "PASSED" | "SKIPPED" | "FAILED";

/** Structured result of the bucket-documentation check. */
export interface BucketDocsResult {
  status: BucketDocsStatus;
  /** Human-readable output for a quality summary or test failure. */
  output: string;
  /** Bucket names with no link from {@link BUCKET_DOCS_FILE}. */
  undocumented: string[];
  /** Bucket link targets in the document that do not resolve on disk. */
  brokenLinks: string[];
  /** Bucket guides found on disk. */
  bucketNames: string[];
}

/**
 * Bucket names from directory entry names: `rust.md` → `rust`.
 *
 * Non-Markdown entries are ignored, and the result is sorted so output is
 * stable regardless of directory-read order.
 */
export function bucketNamesFromEntries(entries: Iterable<string>): string[] {
  return [...entries]
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -".md".length))
    .sort();
}

/**
 * Buckets that the document does not link to.
 *
 * A bucket counts as documented only when the document carries its full
 * `prompts/best_practices/buckets/<name>.md` path — a bare mention of the
 * language name is not enough to route a reader there in one hop.
 */
export function findUndocumentedBuckets(
  bucketNames: readonly string[],
  content: string,
): string[] {
  return bucketNames.filter(
    (name) => !content.includes(`${BUCKETS_DIR}/${name}.md`),
  );
}

/**
 * Markdown link targets in the document that point inside {@link BUCKETS_DIR}.
 *
 * Duplicates are collapsed; anchors and query strings are stripped so
 * `buckets/rust.md#checks` resolves against the file on disk.
 */
export function findBucketLinkTargets(content: string): string[] {
  const pattern = new RegExp(`\\]\\(([^)\\s]*${BUCKETS_DIR}[^)\\s]*)\\)`, "g");
  const targets = new Set<string>();
  for (const match of content.matchAll(pattern)) {
    targets.add(match[1]!.replace(/[#?].*$/, ""));
  }
  return [...targets].sort();
}

/**
 * Run the bucket-documentation check across a repository tree.
 *
 * SKIPPED when the buckets directory or the document is absent (e.g. invoked
 * on a repo that has neither); PASSED when every bucket is linked and every
 * bucket link resolves; FAILED with the offending names otherwise.
 */
export async function runBucketDocsCheck(
  rootDir: string,
): Promise<BucketDocsResult> {
  const entries: string[] = [];
  try {
    for await (const entry of Deno.readDir(`${rootDir}/${BUCKETS_DIR}`)) {
      if (entry.isFile) entries.push(entry.name);
    }
  } catch {
    return skipped("no buckets directory found");
  }

  let content: string;
  try {
    content = await Deno.readTextFile(`${rootDir}/${BUCKET_DOCS_FILE}`);
  } catch {
    return skipped(`no ${BUCKET_DOCS_FILE} found`);
  }

  const bucketNames = bucketNamesFromEntries(entries);
  const undocumented = findUndocumentedBuckets(bucketNames, content);

  const brokenLinks: string[] = [];
  for (const target of findBucketLinkTargets(content)) {
    try {
      await Deno.stat(`${rootDir}/${target}`);
    } catch {
      brokenLinks.push(target);
    }
  }

  if (undocumented.length === 0 && brokenLinks.length === 0) {
    return {
      status: "PASSED",
      output:
        `bucket docs: PASSED (${bucketNames.length} bucket(s) documented in ${BUCKET_DOCS_FILE})`,
      undocumented,
      brokenLinks,
      bucketNames,
    };
  }

  const lines = [
    `bucket docs: FAILED (${undocumented.length} undocumented, ` +
    `${brokenLinks.length} broken link(s))`,
    "",
    `Every guide under ${BUCKETS_DIR}/ must be linked from`,
    `${BUCKET_DOCS_FILE} so a reader is routed to the language-specific`,
    "rules in one hop.",
    "",
    ...undocumented.map((name) =>
      `  undocumented bucket: ${BUCKETS_DIR}/${name}.md`
    ),
    ...brokenLinks.map((target) => `  link does not resolve: ${target}`),
  ];

  return {
    status: "FAILED",
    output: lines.join("\n"),
    undocumented,
    brokenLinks,
    bucketNames,
  };
}

/** Build a SKIPPED result with the given reason. */
function skipped(reason: string): BucketDocsResult {
  return {
    status: "SKIPPED",
    output: `bucket docs: SKIPPED (${reason})`,
    undocumented: [],
    brokenLinks: [],
    bucketNames: [],
  };
}
