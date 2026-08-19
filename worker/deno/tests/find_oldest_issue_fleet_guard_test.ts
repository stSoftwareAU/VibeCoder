/**
 * Regression tests for the #3138 fleet open-PR guard fix.
 *
 * Root cause: `find_oldest_issue` built the open-PR guard's fleet author
 * set from `allowedAuthors` only, so a sibling fleet login listed solely
 * in `fleetPrAuthors` was never queried and its open PR was invisible —
 * letting a second host raise a duplicate PR (Issue #3095). These tests
 * prove the guard now queries the union and blocks the duplicate, and
 * that the guard decision is logged for observability.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import { findOldestIssue } from "../lib/find_oldest_issue.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createDiagnostics } from "../lib/issue_finder_logger.ts";
import type { WorkerConfig } from "../types.ts";

const ALICE = { login: "alice" };

function createTestCache(): IssueCache {
  const dir = Deno.makeTempDirSync({ prefix: "fleet-guard-" });
  return new IssueCache(dir, 600);
}

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    // Issue #3874: the content-approval store must resolve from workDir, or
    // the integrity gate fails closed and blocks every candidate.
    workDir: Deno.makeTempDirSync({ prefix: "fleet-guard-workdir-" }),
    repos: ["owner/repo-a"],
    issueLabels: ["top-priority"],
    allowedAuthors: ["alice"],
    workOnLabel: "work-on",
    shuffleRepos: false,
    ...overrides,
  };
}

/** Author-aware mock: returns the sibling's open PR only for that author. */
function createMockGh(
  siblingLogin: string,
): (args: string[]) => Promise<string> {
  const issue = {
    number: 647,
    title: "Duplicate-prone chore",
    url: "https://github.com/owner/repo-a/issues/647",
    assignees: [],
    labels: [{ name: "work-on" }],
    createdAt: "2024-01-01T00:00:00Z",
    author: ALICE,
    milestone: null,
  };
  const siblingPr = {
    number: 648,
    title: "Duplicate-prone chore (#647)",
    baseRefName: "main",
    headRefName: "issue-647",
  };

  return (args: string[]): Promise<string> => {
    const command = args.join(" ");
    if (command.includes("issue list")) {
      return Promise.resolve(JSON.stringify([issue]));
    }
    if (command.includes("pr list")) {
      const authorIdx = args.indexOf("--author");
      const author = authorIdx >= 0 ? args[authorIdx + 1] : "";
      // Only the sibling has the open PR; every other author has none.
      if (author === siblingLogin) {
        return Promise.resolve(JSON.stringify([siblingPr]));
      }
      return Promise.resolve("[]");
    }
    if (command.includes("timeline")) {
      return Promise.resolve(
        JSON.stringify([
          { event: "labeled", label: { name: "work-on" }, actor: ALICE },
        ]),
      );
    }
    return Promise.resolve("[]");
  };
}

Deno.test(
  "findOldestIssue - sibling PR in fleet_pr_authors (not allowed_authors) blocks duplicate (Issue #3138)",
  async () => {
    const config = makeConfig({
      // stsvcbot is a fleet sibling but NOT in allowed_authors — the
      // exact #3095 blind-spot configuration.
      allowedAuthors: ["alice"],
      fleetPrAuthors: ["stsvcbot"],
    });
    const result = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: createMockGh("stsvcbot"),
      cache: createTestCache(),
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    // The sibling's open PR #648 must block issue #647 → nothing selectable.
    assertEquals(result.found, false);
  },
);

Deno.test(
  "findOldestIssue - without the sibling's open PR the issue is selectable (control)",
  async () => {
    const config = makeConfig({
      allowedAuthors: ["alice"],
      fleetPrAuthors: ["stsvcbot"],
    });
    // Sibling has no open PR here (mock keyed to a different login).
    const result = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: createMockGh("nobody"),
      cache: createTestCache(),
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    assertEquals(result.found, true);
    assertEquals(result.output.includes("647"), true);
  },
);

Deno.test(
  "findOldestIssue - logs the fleet-pr-guard decision with the sibling author (Issue #3138)",
  async () => {
    const config = makeConfig({
      allowedAuthors: ["alice"],
      fleetPrAuthors: ["stsvcbot"],
    });
    const diag = createDiagnostics({ enabled: false });
    await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: createMockGh("stsvcbot"),
      cache: createTestCache(),
      diagnostics: diag,
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    const guardLine = diag.getMessages().find((m) =>
      m.includes("fleet-pr-guard")
    );
    assertEquals(guardLine !== undefined, true);
    // The sibling must appear in the queried author breakdown.
    assertEquals(guardLine!.includes("stsvcbot"), true);
    assertEquals(guardLine!.includes("bot"), true);
    assertEquals(guardLine!.includes("alice"), true);
  },
);
