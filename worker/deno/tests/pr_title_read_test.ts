/**
 * Tests for the PR-title read behind the Graft query (Issue #2103).
 *
 * The `gh` stub here is a **fake of the API's own rules** rather than an
 * assertion on the request text: it resolves `pr view <n> --repo <r> --json
 * title` against a small PR table, answers `--jq .title` with the bare title
 * and anything else with the JSON object, and refuses a request it cannot
 * resolve the way `gh` does. A read asking the wrong way round therefore
 * receives a truthfully wrong answer and the test goes red, which pinning the
 * argv text could never do (CODING-STANDARDS.md — "fake the external service,
 * do not assert the request").
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { prTitleForGraftQuery, readPrTitle } from "../lib/pr_title_read.ts";
import type { Logger } from "../types.ts";

const REPO = "org/repo";
const TITLE = "Fix the date parser";

/** The PRs the fake holds: `owner/repo` → number → title. */
type PrTable = Record<string, Record<number, string>>;

/**
 * A `gh` fake modelling `gh pr view`.
 *
 * @param prs - The pull requests this fake knows about
 * @returns A `gh` runner that answers only well-formed `pr view` reads
 */
function ghFake(prs: PrTable): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    if (args[0] !== "pr" || args[1] !== "view") {
      return Promise.reject(
        new Error(`gh: unknown command ${args.slice(0, 2).join(" ")}`),
      );
    }
    const number = Number(args[2]);
    const repoIndex = args.indexOf("--repo");
    const repo = repoIndex < 0 ? undefined : args[repoIndex + 1];
    if (!Number.isInteger(number) || repo === undefined) {
      return Promise.reject(
        new Error("gh: pr view needs a PR number and --repo"),
      );
    }
    const title = prs[repo]?.[number];
    if (title === undefined) {
      return Promise.reject(
        new Error(`gh: could not resolve to a PullRequest: ${repo}#${number}`),
      );
    }
    const jsonIndex = args.indexOf("--json");
    const fields = jsonIndex < 0
      ? []
      : (args[jsonIndex + 1] ?? "").split(",").map((f) => f.trim());
    if (!fields.includes("title")) {
      // Real `gh` answers with the fields that were asked for — and only those.
      return Promise.resolve(args.includes("--jq") ? "null\n" : "{}\n");
    }
    const jqIndex = args.indexOf("--jq");
    return Promise.resolve(
      jqIndex >= 0 && args[jqIndex + 1] === ".title"
        ? `${title}\n`
        : `${JSON.stringify({ title })}\n`,
    );
  };
}

/** A logger that records only what it was warned about. */
function warningLogger(warnings: string[]): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: (message: string) => warnings.push(message),
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

Deno.test("readPrTitle - reads the titled PR the caller named", async () => {
  const gh = ghFake({ [REPO]: { 42: TITLE }, "org/other": { 42: "Not this" } });

  const result = await readPrTitle(REPO, 42, gh);

  assert(result.ok);
  assertEquals(result.value, TITLE);
});

Deno.test("readPrTitle - a PR the API cannot resolve is a failed Result", async () => {
  const gh = ghFake({ [REPO]: { 42: TITLE } });

  const result = await readPrTitle(REPO, 99, gh);

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "org/repo#99");
    assertStringIncludes(result.error.message, "could not resolve");
  }
});

Deno.test("readPrTitle - an untitled PR is a failure, never an empty title", async () => {
  // A blank answer would otherwise hand Graft a query missing half its terms.
  const gh = ghFake({ [REPO]: { 42: "   " } });

  const result = await readPrTitle(REPO, 42, gh);

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "returned nothing");
  }
});

Deno.test("readPrTitle - a throwing gh is reported, not swallowed", async () => {
  const result = await readPrTitle(
    REPO,
    42,
    () => Promise.reject(new Error("gh: HTTP 403")),
  );

  assertEquals(result.ok, false);
  if (!result.ok) assertStringIncludes(result.error.message, "gh: HTTP 403");
});

Deno.test("prTitleForGraftQuery - returns the title and warns about nothing", async () => {
  const warnings: string[] = [];

  const title = await prTitleForGraftQuery({
    repo: REPO,
    prNumber: 42,
    gh: ghFake({ [REPO]: { 42: TITLE } }),
    logger: warningLogger(warnings),
  });

  assertEquals(title, TITLE);
  assertEquals(warnings, []);
});

Deno.test("prTitleForGraftQuery - a failed read is warned about and dropped", async () => {
  const warnings: string[] = [];

  const title = await prTitleForGraftQuery({
    repo: REPO,
    prNumber: 99,
    gh: ghFake({ [REPO]: { 42: TITLE } }),
    logger: warningLogger(warnings),
  });

  // Dropped, not fatal and not silent — the bundle is an accelerator.
  assertEquals(title, undefined);
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0] ?? "", "missing the PR title");
});
