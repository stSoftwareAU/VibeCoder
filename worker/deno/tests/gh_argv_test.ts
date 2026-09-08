/**
 * Tests for the shared `gh` argv classifier (Issue #1588).
 */

import { assertEquals } from "@std/assert";
import {
  classifyGhCall,
  ghCallKindOf,
  ghPositionalArgs,
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

Deno.test("gh_argv - ghPositionalArgs reads pflag shorthand groups", () => {
  // The group's value is the following token (`-iX POST` is `-i -X POST`).
  assertEquals(ghPositionalArgs(["api", "-iX", "POST", "graphql"]), [
    "api",
    "graphql",
  ]);
  // …or attached to the group itself.
  assertEquals(ghPositionalArgs(["api", "-iXPOST", "graphql"]), [
    "api",
    "graphql",
  ]);
  // A value-taking letter `normaliseGhArgs` does not expand is read here.
  assertEquals(ghPositionalArgs(["api", "-iq", ".data", "graphql"]), [
    "api",
    "graphql",
  ]);
  // An attached value in such a group consumes nothing further.
  assertEquals(ghPositionalArgs(["api", "-iq.data", "graphql"]), [
    "api",
    "graphql",
  ]);
  // An all-boolean group must not swallow the token after it.
  assertEquals(ghPositionalArgs(["api", "-is", "graphql"]), [
    "api",
    "graphql",
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
  assertEquals(
    classifyGhCall(["api", "-iX", "POST", "graphql"]),
    "api-graphql",
  );
  assertEquals(classifyGhCall(["api", "/repos/o/r/issues"]), "api-rest");
  assertEquals(
    classifyGhCall(["--paginate", "api", "/repos/o/r/issues"]),
    "api-rest",
  );
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

Deno.test("gh_argv - ghCallKindOf classifies already-parsed positionals", () => {
  assertEquals(ghCallKindOf(["api", "graphql"]), "api-graphql");
  assertEquals(ghCallKindOf(["api", "rate_limit"]), "api-rest");
  // `gh api` with no endpoint: not GraphQL, and it issues no request.
  assertEquals(ghCallKindOf(["api"]), "api-rest");
  assertEquals(ghCallKindOf(["issue", "list"]), "sub-command");
  assertEquals(ghCallKindOf([]), "unknown");
});
