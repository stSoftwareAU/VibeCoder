/**
 * Tests for the shared `gh` argv classifier (Issue #1588).
 */

import { assertEquals } from "@std/assert";
import {
  classifyGhCall,
  ghPositionalArgs,
  isApiGraphQLCall,
} from "../lib/gh_argv.ts";

Deno.test("gh_argv - ghPositionalArgs drops flags and their values", () => {
  assertEquals(ghPositionalArgs(["issue", "list", "--repo", "o/r"]), [
    "issue",
    "list",
  ]);
  // A value-taking flag never donates its value to the positional list.
  assertEquals(ghPositionalArgs(["api", "-f", "query=…", "graphql"]), [
    "api",
    "graphql",
  ]);
  // `--flag=value` is a single token and consumes nothing after it.
  assertEquals(ghPositionalArgs(["api", "--jq=.data", "graphql"]), [
    "api",
    "graphql",
  ]);
  // A boolean flag consumes nothing either.
  assertEquals(ghPositionalArgs(["api", "--paginate", "graphql"]), [
    "api",
    "graphql",
  ]);
  // `--` ends flag processing.
  assertEquals(ghPositionalArgs(["run", "--", "--not-a-flag"]), [
    "run",
    "--not-a-flag",
  ]);
});

Deno.test("gh_argv - ghPositionalArgs handles empty and flag-only argv", () => {
  assertEquals(ghPositionalArgs([]), []);
  assertEquals(ghPositionalArgs(["--version"]), []);
  // A trailing value-taking flag with no value left to consume.
  assertEquals(ghPositionalArgs(["api", "-f"]), ["api"]);
});

Deno.test("gh_argv - classifyGhCall names the budget each invocation spends", () => {
  assertEquals(classifyGhCall(["api", "graphql", "-f", "q=1"]), "api-graphql");
  assertEquals(classifyGhCall(["api", "-f", "q=1", "graphql"]), "api-graphql");
  assertEquals(classifyGhCall(["api", "/repos/o/r/issues"]), "api-rest");
  assertEquals(classifyGhCall(["api", "/search/issues?q=graphql"]), "api-rest");
  assertEquals(
    classifyGhCall(["api", "repos/o/r/labels", "--jq", "graphql"]),
    "api-rest",
  );
  assertEquals(
    classifyGhCall(["issue", "list", "--limit", "500"]),
    "sub-command",
  );
  assertEquals(classifyGhCall(["search", "issues", "graphql"]), "sub-command");
  assertEquals(classifyGhCall([]), "unknown");
  assertEquals(classifyGhCall(["--version"]), "unknown");
});

Deno.test("gh_argv - isApiGraphQLCall is true only for an explicit api graphql", () => {
  assertEquals(isApiGraphQLCall(["api", "graphql"]), true);
  assertEquals(isApiGraphQLCall(["api", "rate_limit"]), false);
  assertEquals(isApiGraphQLCall(["issue", "list"]), false);
});
