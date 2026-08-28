/**
 * Tests for the bucket-documentation guard (Issue #372).
 *
 * `CODING-STANDARDS.md` carries the language-agnostic rules; the
 * language-specific rules live in `prompts/best_practices/buckets/` and are
 * injected only for repositories using that language. The standard must route
 * a reader to those guides, otherwise a rule such as the Rust "prefer `?` over
 * `unwrap()`" is unfindable from the entry-point document.
 *
 * Covers:
 *   - bucket-name derivation from directory entries,
 *   - undocumented-bucket detection and link-target extraction,
 *   - fixture runs for PASSED / FAILED / SKIPPED,
 *   - the live repository tree passes (the regression this guard prevents:
 *     adding a ninth bucket without documenting it).
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  BUCKET_DOCS_FILE,
  bucketNamesFromEntries,
  BUCKETS_DIR,
  findBucketLinkTargets,
  findUndocumentedBuckets,
  runBucketDocsCheck,
} from "../lib/bucket_docs_check.ts";

// --- bucketNamesFromEntries ---

Deno.test("bucketNamesFromEntries - strips the extension and sorts", () => {
  assertEquals(
    bucketNamesFromEntries(["rust.md", "java.md", "general.md"]),
    ["general", "java", "rust"],
  );
});

Deno.test("bucketNamesFromEntries - ignores non-Markdown entries", () => {
  assertEquals(
    bucketNamesFromEntries(["rust.md", "README", "notes.txt"]),
    ["rust"],
  );
});

Deno.test("bucketNamesFromEntries - empty directory yields no buckets", () => {
  assertEquals(bucketNamesFromEntries([]), []);
});

// --- findUndocumentedBuckets ---

Deno.test("findUndocumentedBuckets - a linked bucket is documented", () => {
  const content = `See [rust](${BUCKETS_DIR}/rust.md) for the Rust rules.\n`;
  assertEquals(findUndocumentedBuckets(["rust"], content), []);
});

Deno.test("findUndocumentedBuckets - a bare language mention is not enough", () => {
  // Naming the language without its path leaves the reader nowhere to go.
  assertEquals(
    findUndocumentedBuckets(["rust"], "Rust code must avoid unwrap().\n"),
    ["rust"],
  );
});

Deno.test("findUndocumentedBuckets - reports only the missing buckets", () => {
  const content = `[rust](${BUCKETS_DIR}/rust.md) and ${BUCKETS_DIR}/java.md\n`;
  assertEquals(
    findUndocumentedBuckets(["java", "rust", "terraform"], content),
    ["terraform"],
  );
});

Deno.test("findUndocumentedBuckets - no buckets means nothing to document", () => {
  assertEquals(findUndocumentedBuckets([], ""), []);
});

// --- findBucketLinkTargets ---

Deno.test("findBucketLinkTargets - collects targets and drops duplicates", () => {
  const content = [
    `[dir](${BUCKETS_DIR}/)`,
    `[rust](${BUCKETS_DIR}/rust.md)`,
    `[again](${BUCKETS_DIR}/rust.md)`,
    "[unrelated](docs/EXTENDING.md)",
  ].join("\n");
  assertEquals(findBucketLinkTargets(content), [
    `${BUCKETS_DIR}/`,
    `${BUCKETS_DIR}/rust.md`,
  ]);
});

Deno.test("findBucketLinkTargets - strips anchors from the target", () => {
  assertEquals(
    findBucketLinkTargets(`[checks](${BUCKETS_DIR}/rust.md#checks)`),
    [`${BUCKETS_DIR}/rust.md`],
  );
});

Deno.test("findBucketLinkTargets - content without bucket links yields none", () => {
  assertEquals(findBucketLinkTargets("[docs](docs/EXTENDING.md)\n"), []);
});

// --- runBucketDocsCheck against fixtures ---

async function makeFixture(
  buckets: string[],
  standards: string | null,
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "bucket_docs_" });
  await Deno.mkdir(`${dir}/${BUCKETS_DIR}`, { recursive: true });
  for (const bucket of buckets) {
    await Deno.writeTextFile(
      `${dir}/${BUCKETS_DIR}/${bucket}.md`,
      `# Bucket: \`${bucket}\`\n`,
    );
  }
  if (standards !== null) {
    await Deno.writeTextFile(`${dir}/${BUCKET_DOCS_FILE}`, standards);
  }
  return dir;
}

Deno.test("runBucketDocsCheck - every bucket linked and resolving passes", async () => {
  const dir = await makeFixture(
    ["rust", "java"],
    `[rust](${BUCKETS_DIR}/rust.md) [java](${BUCKETS_DIR}/java.md)\n`,
  );
  try {
    const result = await runBucketDocsCheck(dir);
    assertEquals(result.status, "PASSED", result.output);
    assertEquals(result.bucketNames, ["java", "rust"]);
    assertEquals(result.undocumented, []);
    assertEquals(result.brokenLinks, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runBucketDocsCheck - a new undocumented bucket fails", async () => {
  const dir = await makeFixture(
    ["rust", "zig"],
    `[rust](${BUCKETS_DIR}/rust.md)\n`,
  );
  try {
    const result = await runBucketDocsCheck(dir);
    assertEquals(result.status, "FAILED");
    assertEquals(result.undocumented, ["zig"]);
    assertStringIncludes(result.output, `${BUCKETS_DIR}/zig.md`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runBucketDocsCheck - a link to a removed bucket fails", async () => {
  const dir = await makeFixture(
    ["rust"],
    `[rust](${BUCKETS_DIR}/rust.md) [gone](${BUCKETS_DIR}/cobol.md)\n`,
  );
  try {
    const result = await runBucketDocsCheck(dir);
    assertEquals(result.status, "FAILED");
    assertEquals(result.brokenLinks, [`${BUCKETS_DIR}/cobol.md`]);
    assertStringIncludes(result.output, "link does not resolve");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runBucketDocsCheck - SKIPPED without a buckets directory", async () => {
  const dir = await Deno.makeTempDir({ prefix: "bucket_docs_" });
  try {
    const result = await runBucketDocsCheck(dir);
    assertEquals(result.status, "SKIPPED");
    assertStringIncludes(result.output, "no buckets directory");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runBucketDocsCheck - SKIPPED without the standards document", async () => {
  const dir = await makeFixture(["rust"], null);
  try {
    const result = await runBucketDocsCheck(dir);
    assertEquals(result.status, "SKIPPED");
    assertStringIncludes(result.output, BUCKET_DOCS_FILE);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- Regression guard against the actual repository ---

const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

Deno.test("bucket docs - every live bucket is documented and its link resolves", async () => {
  const result = await runBucketDocsCheck(REPO_ROOT);
  assertEquals(result.status, "PASSED", result.output);
  assert(
    result.bucketNames.length >= 8,
    `expected at least the eight known buckets, found ${result.bucketNames.length}`,
  );
});
