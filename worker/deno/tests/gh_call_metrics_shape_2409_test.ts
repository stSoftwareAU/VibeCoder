/**
 * Which call *shapes* spend the GraphQL quota (Issue #2409).
 *
 * The fleet was exhausting its GitHub quota ~25 minutes into every hour. The
 * metrics could say `pr-list=135` a cycle and `issue-scanning=110`, but not
 * which `pr list` — by author? by head branch? closed? — so the largest
 * consumers could only be guessed at from the code. A shape is the
 * sub-command plus its flag **names**: enough to tell the listings apart,
 * and never an argument value, which can be a repository, a search string or
 * a body. The one exception is the `--json` field list — identifiers the
 * worker wrote, which tell a state check from a content read.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  classifyGhShape,
  formatGhCallShapesSummary,
  recordGhCall,
  resetGhCallMetrics,
} from "../lib/gh_call_metrics.ts";

Deno.test("classifyGhShape - the sub-command and its flag names, sorted, with no subject values (Issue #2409)", () => {
  assertEquals(
    classifyGhShape([
      "pr",
      "list",
      "--repo",
      "org/private-repo",
      "--state",
      "closed",
      "--author",
      "some-user",
      "--json",
      "number,title",
      "--limit",
      "100",
    ]),
    "pr list --author --json=number,title --limit --repo --state",
  );
});

Deno.test("classifyGhShape - the same listing for a different repo and author is the same shape (Issue #2409)", () => {
  const a = classifyGhShape(["pr", "list", "--repo", "o/a", "--author", "x"]);
  const b = classifyGhShape(["pr", "list", "--author", "y", "--repo", "o/b"]);
  assertEquals(a, b);
});

Deno.test("classifyGhShape - `--flag=value` and short flags keep the name and drop the value (Issue #2409)", () => {
  assertEquals(
    classifyGhShape(["issue", "list", "--label=secret-label", "-R", "o/r"]),
    "issue list --label -R",
  );
});

Deno.test("classifyGhShape - a REST path is reduced to its route, never the repository or number (Issue #2409)", () => {
  assertEquals(
    classifyGhShape([
      "api",
      "repos/org/private-repo/issues/128/timeline",
      "--paginate",
    ]),
    "api repos/:owner/:repo/issues/:n/timeline --paginate",
  );
});

Deno.test("classifyGhShape - nothing a caller passes as a value can reach the shape (Issue #2409)", () => {
  const shape = classifyGhShape([
    "issue",
    "create",
    "--title",
    "TOKEN=hunter2hunter2", // gitleaks:allow fake fixture, not a real key
    "--body",
    "a body with --looks-like-a-flag inside it",
  ]);
  assert(!shape.includes("hunter2"), shape);
  assert(!shape.includes("looks-like"), shape);
  assertEquals(shape, "issue create --body --title");
});

Deno.test("formatGhCallShapesSummary - the busiest GraphQL shapes first, capped (Issue #2409)", () => {
  resetGhCallMetrics();
  for (let i = 0; i < 5; i++) {
    recordGhCall(["pr", "list", "--repo", `o/r${i}`, "--author", "bot"]);
  }
  for (let i = 0; i < 2; i++) recordGhCall(["issue", "view", String(i)]);
  // REST is a different quota and is not what this line is for.
  recordGhCall(["api", "repos/o/r/issues/1/timeline"]);

  const line = formatGhCallShapesSummary(1);
  assertStringIncludes(line, "graphql-shapes:");
  assertStringIncludes(line, "5×[pr list --author --repo]");
  assert(!line.includes("issue view"), "capped at the top one");
  assert(!line.includes("timeline"), "REST calls are not GraphQL spend");
  resetGhCallMetrics();
});

Deno.test("formatGhCallShapesSummary - a cycle with no GraphQL call still logs one well-formed line (Issue #2409)", () => {
  resetGhCallMetrics();
  assertEquals(formatGhCallShapesSummary(), "graphql-shapes: none");
});

// Part 5: `issue view --json --repo` was the largest steady consumer (38–101 a
// cycle) and the shape could not say *which* issue view — the dependency
// check's state read, or the content read — because the field list is a value.
// Field names are GraphQL identifiers the worker itself writes, so they are
// safe to show; anything that is not a bare identifier is not shown.
Deno.test("classifyGhShape - the --json field list tells one listing from another (Issue #2409)", () => {
  assertEquals(
    classifyGhShape([
      "issue",
      "view",
      "128",
      "--repo",
      "o/r",
      "--json",
      "state",
    ]),
    "issue view --json=state --repo",
  );
  assertEquals(
    classifyGhShape([
      "issue",
      "view",
      "128",
      "--repo",
      "o/r",
      "--json",
      "title,body,labels",
    ]),
    "issue view --json=title,body,labels --repo",
  );
  assertEquals(
    classifyGhShape(["pr", "list", "--json=number,title", "--repo", "o/r"]),
    "pr list --json=number,title --repo",
  );
});

Deno.test("classifyGhShape - a --json value that is not a list of bare identifiers is never shown (Issue #2409)", () => {
  for (
    const value of [
      "title,TOKEN=hunter2hunter2", // gitleaks:allow fake fixture, not a real key
      "org/private-repo",
      "a b",
      "",
      "x".repeat(200),
    ]
  ) {
    const shape = classifyGhShape(["issue", "view", "1", "--json", value]);
    assertEquals(shape, "issue view --json", value.slice(0, 20));
  }
});

Deno.test("classifyGhShape - only --json is ever expanded: every other flag's value stays out (Issue #2409)", () => {
  assertEquals(
    classifyGhShape([
      "pr",
      "list",
      "--author",
      "bot",
      "--search",
      "in:title secret",
      "--json",
      "number",
    ]),
    "pr list --author --json=number --search",
  );
});
