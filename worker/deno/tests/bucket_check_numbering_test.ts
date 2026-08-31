/**
 * Tests for the bucket-guide check-numbering invariant (Issue #677).
 *
 * Every `prompts/best_practices/buckets/<bucket>.md` guide numbers its checks
 * as a single gapless `1..N` list, and findings cite those numbers ("check 16
 * covers the style rule — do not file both"). Inserting a check mid-list means
 * renumbering everything below it, and a slip there leaves two "check 18"s or
 * a hole where one used to be — a scan citing a number that no longer means
 * what it says.
 *
 * These tests exercise the parser with fixture Markdown (duplicates, gaps,
 * out-of-order, fenced code that merely looks numbered) and then sweep the
 * live guides. They assert structure, never prose, so a guide may be reworded
 * freely — the WHAT-vs-HOW rule from Issue #3115 that retired the old
 * prose-grep bucket tests.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  checkNumbersIn,
  findCheckNumberingIssues,
} from "../lib/bucket_check_numbering.ts";
import {
  bucketNamesFromEntries,
  BUCKETS_DIR,
} from "../lib/bucket_docs_check.ts";

/** Repo root, derived from this test file's location. */
const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

// --- checkNumbersIn ---

Deno.test("checkNumbersIn - collects the numbered check headings in order", () => {
  const guide = [
    "# Bucket: `demo`",
    "",
    "1. **First.** Does a thing.",
    "2. **Second.** Does another.",
    "",
    "## More",
    "",
    "3. **Third.** Does a third.",
  ].join("\n");
  assertEquals(checkNumbersIn(guide), [1, 2, 3]);
});

Deno.test("checkNumbersIn - ignores numbered lines inside fenced code", () => {
  const guide = [
    "1. **Only check.** Shows a snippet:",
    "",
    "   ```toml",
    "   2. not a check, just sample text",
    "   ```",
  ].join("\n");
  assertEquals(checkNumbersIn(guide), [1]);
});

Deno.test("checkNumbersIn - ignores ordinary numbered prose without a bold lead", () => {
  const guide = [
    "1. **Real check.** Applies always.",
    "",
    "Steps to reproduce:",
    "",
    "2. run the thing",
  ].join("\n");
  assertEquals(checkNumbersIn(guide), [1]);
});

Deno.test("checkNumbersIn - a guide with no checks yields none", () => {
  assertEquals(checkNumbersIn("# Bucket: `demo`\n\nProse only.\n"), []);
});

// --- findCheckNumberingIssues ---

Deno.test("findCheckNumberingIssues - a gapless 1..N sequence has no issues", () => {
  const guide = [
    "1. **One.** a",
    "2. **Two.** b",
    "3. **Three.** c",
  ].join("\n");
  assertEquals(findCheckNumberingIssues(guide), []);
});

Deno.test("findCheckNumberingIssues - a duplicated number is reported", () => {
  // The classic bad renumber: a check inserted without shifting the rest.
  const guide = [
    "1. **One.** a",
    "2. **Two.** b",
    "2. **Two again.** c",
  ].join("\n");
  const issues = findCheckNumberingIssues(guide);
  assertEquals(issues.length, 1);
  assert(
    issues[0]!.includes("expected 3, found 2"),
    `unexpected issue text: ${issues[0]}`,
  );
});

Deno.test("findCheckNumberingIssues - a skipped number is reported", () => {
  const guide = ["1. **One.** a", "3. **Three.** c"].join("\n");
  const issues = findCheckNumberingIssues(guide);
  assertEquals(issues.length, 1);
  assert(
    issues[0]!.includes("expected 2, found 3"),
    `unexpected issue text: ${issues[0]}`,
  );
});

Deno.test("findCheckNumberingIssues - a list not starting at 1 is reported", () => {
  // Every position is off by one, so every position is reported.
  const issues = findCheckNumberingIssues("2. **Two.** b\n3. **Three.** c\n");
  assertEquals(issues.length, 2);
  assert(
    issues[0]!.includes("expected 1, found 2"),
    `unexpected issue text: ${issues[0]}`,
  );
});

Deno.test("findCheckNumberingIssues - a guide with no checks has no issues", () => {
  assertEquals(findCheckNumberingIssues("Prose only.\n"), []);
});

// --- Regression guard against the live guides ---

Deno.test("bucket guides - every guide numbers its checks 1..N with no gaps", async () => {
  const entries: string[] = [];
  for await (const entry of Deno.readDir(`${REPO_ROOT}/${BUCKETS_DIR}`)) {
    if (entry.isFile) entries.push(entry.name);
  }
  const buckets = bucketNamesFromEntries(entries);
  assert(buckets.length >= 8, `expected the known buckets, got ${buckets}`);

  for (const bucket of buckets) {
    const path = `${REPO_ROOT}/${BUCKETS_DIR}/${bucket}.md`;
    const issues = findCheckNumberingIssues(await Deno.readTextFile(path));
    assertEquals(issues, [], `${bucket}.md: ${issues.join("; ")}`);
  }
});
