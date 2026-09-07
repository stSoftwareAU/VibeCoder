/**
 * Tests for case-insensitive `repos` de-duplication (Issue #1546).
 *
 * GitHub repository names are case-insensitive, so `owner/Repo` and
 * `owner/repo` name one repository. Listing both made every per-repository
 * scan run twice and let a worker's two slots race each other for the same
 * issue.
 */

import { assertEquals } from "@std/assert";
import { dedupeRepoSlugs, duplicateRepoSlugWarning } from "../lib/repo_slug.ts";

Deno.test("dedupeRepoSlugs - keeps a genuinely distinct list unchanged", () => {
  const result = dedupeRepoSlugs(["org/one", "org/two", "other/one"]);
  assertEquals(result.repos, ["org/one", "org/two", "other/one"]);
  assertEquals(result.duplicates, []);
});

Deno.test("dedupeRepoSlugs - drops a case-variant, keeping the first spelling", () => {
  const result = dedupeRepoSlugs([
    "stSoftwareAU/GRQ-Actual",
    "stSoftwareAU/GRQ-actual",
  ]);
  assertEquals(result.repos, ["stSoftwareAU/GRQ-Actual"]);
  assertEquals(result.duplicates, [
    { kept: "stSoftwareAU/GRQ-Actual", dropped: "stSoftwareAU/GRQ-actual" },
  ]);
});

Deno.test("dedupeRepoSlugs - owner casing counts too", () => {
  const result = dedupeRepoSlugs([
    "stsoftwareau/VibeCoder",
    "stSoftwareAU/VibeCoder",
  ]);
  assertEquals(result.repos, ["stsoftwareau/VibeCoder"]);
  assertEquals(result.duplicates.length, 1);
});

Deno.test("dedupeRepoSlugs - drops an exact duplicate as well", () => {
  const result = dedupeRepoSlugs(["org/one", "org/one"]);
  assertEquals(result.repos, ["org/one"]);
  assertEquals(result.duplicates, [{ kept: "org/one", dropped: "org/one" }]);
});

Deno.test("dedupeRepoSlugs - reports every later variant of the same repository", () => {
  const result = dedupeRepoSlugs(["org/a", "org/A", "ORG/a"]);
  assertEquals(result.repos, ["org/a"]);
  assertEquals(result.duplicates.length, 2);
  assertEquals(result.duplicates.map((d) => d.dropped), ["org/A", "ORG/a"]);
});

Deno.test("dedupeRepoSlugs - an empty list is empty, not an error", () => {
  const result = dedupeRepoSlugs([]);
  assertEquals(result.repos, []);
  assertEquals(result.duplicates, []);
});

Deno.test("dedupeRepoSlugs - surrounding whitespace does not hide a duplicate", () => {
  const result = dedupeRepoSlugs(["org/a", " org/A "]);
  assertEquals(result.repos, ["org/a"]);
  assertEquals(result.duplicates.length, 1);
});

Deno.test("duplicateRepoSlugWarning - names both spellings and why one was dropped", () => {
  const warning = duplicateRepoSlugWarning({
    kept: "stSoftwareAU/GRQ-Actual",
    dropped: "stSoftwareAU/GRQ-actual",
  });
  assertEquals(
    warning,
    'repos: "stSoftwareAU/GRQ-actual" duplicates "stSoftwareAU/GRQ-Actual" ' +
      "(GitHub repository names are case-insensitive) — ignoring the second",
  );
});

Deno.test("duplicateRepoSlugWarning - renders an untrusted spelling inert", () => {
  const warning = duplicateRepoSlugWarning({
    kept: "org/a",
    dropped: "org/a`rm -rf /`",
  });
  assertEquals(warning.includes("`"), false);
});
