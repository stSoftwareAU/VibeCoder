/**
 * Tests for the per-repo sub-issue ref helpers in `native_sub_issues.ts`
 * (Issue #3319).
 *
 * A native sub-issue can live in a different repository from its parent, and
 * a parent can have more than 100 children, so `parseNativeSubIssueRefPages`
 * / `fetchNativeSubIssueRefs` replace the single-page, parent-repo-only
 * helpers for every path that must resolve children against their *own*
 * repo.
 *
 * Coverage:
 *   - parseNativeSubIssueRefPages: multi-page merge, repo taken from
 *     `repository_url`, fallback to `parentRepo`, cross-page dedupe, a
 *     malformed line throwing, and a hostile `repository_url` scaling
 *     linearly rather than backtracking.
 *   - fetchNativeSubIssueRefs: the `gh` argv shape (`per_page=100`,
 *     `--paginate`, `--jq`), invalid-input short-circuiting, and a `gh`
 *     failure propagating rather than being swallowed.
 *
 * The file is registered in `WALL_CLOCK_TEST_FILES` so it runs in the serial
 * pass.
 *
 * Australian English spelling used throughout.
 */

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  fetchNativeSubIssueRefs,
  parseNativeSubIssueRefPages,
} from "../lib/native_sub_issues.ts";
import { assertLinearGrowth } from "./support/growth.ts";

// ---------------------------------------------------------------------------
// parseNativeSubIssueRefPages
// ---------------------------------------------------------------------------

Deno.test("parseNativeSubIssueRefPages - merges two page lines into one sorted list", () => {
  const page1 = JSON.stringify([
    { number: 102, repository_url: "https://api.github.com/repos/owner/repo" },
  ]);
  const page2 = JSON.stringify([
    { number: 101, repository_url: "https://api.github.com/repos/owner/repo" },
  ]);
  const refs = parseNativeSubIssueRefPages(`${page1}\n${page2}`, "owner/repo");
  assertEquals(refs, [
    { repo: "owner/repo", number: 101 },
    { repo: "owner/repo", number: 102 },
  ]);
});

Deno.test("parseNativeSubIssueRefPages - takes the repo from repository_url", () => {
  const payload = JSON.stringify([
    { number: 5, repository_url: "https://api.github.com/repos/other/lib" },
  ]);
  const refs = parseNativeSubIssueRefPages(payload, "owner/repo");
  assertEquals(refs, [{ repo: "other/lib", number: 5 }]);
});

Deno.test("parseNativeSubIssueRefPages - falls back to parentRepo when repository_url is missing, null or malformed", () => {
  const payload = JSON.stringify([
    { number: 1 },
    { number: 2, repository_url: null },
    { number: 3, repository_url: "not-a-url" },
  ]);
  const refs = parseNativeSubIssueRefPages(payload, "owner/repo");
  assertEquals(refs, [
    { repo: "owner/repo", number: 1 },
    { repo: "owner/repo", number: 2 },
    { repo: "owner/repo", number: 3 },
  ]);
});

Deno.test("parseNativeSubIssueRefPages - dedupes the same repo#number across pages, case-insensitive on repo", () => {
  const page1 = JSON.stringify([
    { number: 7, repository_url: "https://api.github.com/repos/Owner/Repo" },
  ]);
  const page2 = JSON.stringify([
    { number: 7, repository_url: "https://api.github.com/repos/owner/repo" },
  ]);
  const refs = parseNativeSubIssueRefPages(`${page1}\n${page2}`, "owner/repo");
  // First-seen spelling is kept.
  assertEquals(refs, [{ repo: "Owner/Repo", number: 7 }]);
});

Deno.test("parseNativeSubIssueRefPages - a malformed line throws", () => {
  assertThrows(() => parseNativeSubIssueRefPages("not json", "owner/repo"));
});

Deno.test("parseNativeSubIssueRefPages - a hostile repository_url scales linearly and falls back to the parent repo", () => {
  const refs = assertLinearGrowth(
    "repository_url parse over a slash-heavy URL",
    (chars) =>
      JSON.stringify([{
        number: 9,
        repository_url: "/repos/" + "a/".repeat(Math.ceil(chars / 2)) + "x",
      }]),
    (payload) => parseNativeSubIssueRefPages(payload, "owner/repo"),
    { baseChars: 10_000 },
  );
  assertEquals(refs, [{ repo: "owner/repo", number: 9 }]);
});

// ---------------------------------------------------------------------------
// fetchNativeSubIssueRefs
// ---------------------------------------------------------------------------

Deno.test("fetchNativeSubIssueRefs - queries the paginated sub_issues endpoint with a jq filter", async () => {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    return Promise.resolve(
      JSON.stringify([
        {
          number: 5,
          repository_url: "https://api.github.com/repos/owner/repo",
        },
      ]),
    );
  };

  const refs = await fetchNativeSubIssueRefs("owner/repo", 1, gh);

  assertEquals(refs, [{ repo: "owner/repo", number: 5 }]);
  assertEquals(calls.length, 1);
  const argv = calls[0]!;
  assertEquals(argv[0], "api");
  assertEquals(argv[1]?.includes("per_page=100"), true);
  assertEquals(argv.includes("--paginate"), true);
  assertEquals(argv.includes("--jq"), true);
});

Deno.test("fetchNativeSubIssueRefs - invalid repo slug returns [] without calling gh", async () => {
  let called = false;
  const gh = (_args: string[]): Promise<string> => {
    called = true;
    return Promise.resolve("[]");
  };

  assertEquals(await fetchNativeSubIssueRefs("bad", 1, gh), []);
  assertEquals(called, false);
});

Deno.test("fetchNativeSubIssueRefs - issue number 0 returns [] without calling gh", async () => {
  let called = false;
  const gh = (_args: string[]): Promise<string> => {
    called = true;
    return Promise.resolve("[]");
  };

  assertEquals(await fetchNativeSubIssueRefs("owner/repo", 0, gh), []);
  assertEquals(called, false);
});

Deno.test("fetchNativeSubIssueRefs - a throwing gh propagates the throw", async () => {
  const gh = (_args: string[]): Promise<string> =>
    Promise.reject(new Error("network down"));

  await assertRejects(() => fetchNativeSubIssueRefs("owner/repo", 1, gh));
});
