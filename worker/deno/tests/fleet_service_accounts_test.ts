/**
 * Regression tests for the `service_accounts` fleet blind spot (Issue #209).
 *
 * Incident: a host listed its siblings (`VibeCoderST`, `stservice`) under
 * `service_accounts` only and left `fleet_pr_authors` unset. The two keys
 * fed different things — `service_accounts` reached the identity guard
 * alone, while every PR guard resolved its author set from
 * `fleet_pr_authors` — so a sibling's open PR neither blocked a claim nor
 * counted as already merged. The worker claimed an issue three minutes
 * after a sibling opened a PR for it and duplicated ten minutes of work.
 *
 * These tests prove the fix end to end: the resolvers union
 * `serviceAccounts`, `loadConfig` folds the two keys into one effective
 * sibling list, and a sibling configured only under `service_accounts`
 * blocks the issue it has an open PR for.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  isFleetAuthor,
  isHumanAuthoredPr,
  resolveEffectiveFleetPrAuthors,
  resolveFleetMaintenanceAuthorSet,
  resolveFleetPrAuthorSet,
} from "../lib/fleet_authors.ts";
import {
  formatFleetConfigValidation,
  validateFleetConfig,
} from "../lib/fleet_config_validation.ts";
import { loadConfig } from "../lib/config.ts";
import { findOldestIssue } from "../lib/find_oldest_issue.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import type { ConfigFile } from "../types.ts";

const HOST = "VibeCoderST";
const SIBLING = "stservice";
const ALICE = { login: "alice" };

// --- Resolvers ---------------------------------------------------------------

Deno.test("resolveFleetPrAuthorSet - a service-account-only sibling is fleet-owned (Issue #209)", () => {
  const result = resolveFleetPrAuthorSet({
    githubUser: HOST,
    allowedAuthors: ["nleck"],
    fleetPrAuthors: [],
    serviceAccounts: [SIBLING],
  });
  assertEquals(result.includes(SIBLING), true);
});

Deno.test("resolveFleetMaintenanceAuthorSet - a service-account-only sibling is push-capable (Issue #209)", () => {
  // The blocking guard classifies by the push-capable set: outside it, a
  // sibling's PR is read as "a human's" and never defers issue pickup.
  const result = resolveFleetMaintenanceAuthorSet({
    githubUser: HOST,
    allowedAuthors: ["nleck"],
    fleetPrAuthors: [],
    serviceAccounts: [SIBLING],
  });
  assertEquals(result, [HOST, SIBLING]);
  assertEquals(isHumanAuthoredPr(SIBLING, result), false);
});

Deno.test("resolveFleetMaintenanceAuthorSet - service accounts dedupe against fleet_pr_authors", () => {
  const result = resolveFleetMaintenanceAuthorSet({
    githubUser: HOST,
    fleetPrAuthors: ["stservice", "sibling2"],
    serviceAccounts: ["STSERVICE", "  ", HOST],
  });
  assertEquals(result, [HOST, "stservice", "sibling2"]);
});

Deno.test("resolveFleetMaintenanceAuthorSet - stays a subset of the fleet-owned set with service accounts", () => {
  const input = {
    githubUser: HOST,
    allowedAuthors: ["nleck"],
    fleetPrAuthors: [],
    serviceAccounts: [SIBLING, HOST],
  };
  const owned = resolveFleetPrAuthorSet(input).map((a) => a.toLowerCase());
  for (const login of resolveFleetMaintenanceAuthorSet(input)) {
    assertEquals(owned.includes(login.toLowerCase()), true);
  }
});

Deno.test("resolveEffectiveFleetPrAuthors - unions, trims and dedupes both keys", () => {
  assertEquals(
    resolveEffectiveFleetPrAuthors(["Sibling1", ""], ["  sibling1  ", "svc"]),
    ["Sibling1", "svc"],
  );
  assertEquals(resolveEffectiveFleetPrAuthors([], []), []);
  assertEquals(resolveEffectiveFleetPrAuthors([], [SIBLING]), [SIBLING]);
});

// --- loadConfig folds the two keys into one effective list -------------------

async function withTempConfig(
  config: ConfigFile,
  fn: (configPath: string) => Promise<void>,
): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  const configPath = `${tempDir}/.config.json`;
  await Deno.writeTextFile(configPath, JSON.stringify(config));
  try {
    await fn(configPath);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

Deno.test("loadConfig - service_accounts join the effective fleet_pr_authors (Issue #209)", async () => {
  // The incident configuration verbatim: siblings under service_accounts,
  // no fleet_pr_authors key at all.
  await withTempConfig({
    repos: ["owner/repo-a"],
    allowed_authors: ["nleck"],
    service_accounts: [HOST, SIBLING],
  }, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(isFleetAuthor(SIBLING, config.fleetPrAuthors), true);
    // service_accounts keeps its own meaning for the identity guard.
    assertEquals(config.serviceAccounts, [HOST, SIBLING]);
  });
});

Deno.test("loadConfig - configured fleet_pr_authors survive the union without duplicates", async () => {
  await withTempConfig({
    repos: ["owner/repo-a"],
    fleet_pr_authors: ["sibling-a"],
    service_accounts: ["Sibling-A", SIBLING],
  }, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.fleetPrAuthors, ["sibling-a", SIBLING]);
  });
});

// --- Startup log names the effective set ------------------------------------

Deno.test("validateFleetConfig - effective set covers a service-account-only sibling (Issue #209)", () => {
  const result = validateFleetConfig({
    githubUser: HOST,
    allowedAuthors: ["nleck"],
    fleetPrAuthors: [],
    serviceAccounts: [HOST, SIBLING],
  });
  assertEquals(isFleetAuthor(SIBLING, result.effectiveAuthors), true);
  // The host's own login is not a sibling, so it never warns.
  assertEquals(result.missingFromAllowed, [SIBLING]);
});

Deno.test("formatFleetConfigValidation - names the effective author set even when warning (Issue #209)", () => {
  const result = validateFleetConfig({
    githubUser: HOST,
    allowedAuthors: ["nleck"],
    fleetPrAuthors: [],
    serviceAccounts: [HOST, SIBLING],
  });
  const lines = formatFleetConfigValidation(result);
  assertStringIncludes(lines[0]!, "[fleet-config] effective-authors=");
  assertStringIncludes(lines[0]!, SIBLING);
});

// --- End to end: the sibling's open PR blocks the issue ----------------------

/** Author-aware mock: only `siblingLogin` has the open PR for issue #187. */
function createMockGh(
  siblingLogin: string,
): (args: string[]) => Promise<string> {
  const issue = {
    number: 187,
    title: "best.json drops the winner",
    url: "https://github.com/owner/repo-a/issues/187",
    assignees: [],
    labels: [{ name: "work-on" }],
    createdAt: "2026-08-21T03:50:00Z",
    author: ALICE,
    milestone: null,
  };
  const siblingPr = {
    number: 188,
    title: "best.json drops the winner (#187)",
    baseRefName: "main",
    headRefName: "issue-187-best-json-drops",
  };

  return (args: string[]): Promise<string> => {
    const command = args.join(" ");
    if (command.includes("issue list")) {
      return Promise.resolve(JSON.stringify([issue]));
    }
    if (command.includes("pr list")) {
      const authorIdx = args.indexOf("--author");
      const author = authorIdx >= 0 ? args[authorIdx + 1] : "";
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
  "findOldestIssue - sibling in service_accounts only still blocks the duplicate (Issue #209)",
  async () => {
    await withTempConfig({
      repos: ["owner/repo-a"],
      allowed_authors: ["alice"],
      service_accounts: [HOST, SIBLING],
    }, async (configPath) => {
      const config = await loadConfig(configPath);
      const result = await findOldestIssue({
        ...config,
        issueLabels: ["top-priority"],
        workOnLabel: "work-on",
        shuffleRepos: false,
        // Issue #3874: the content-approval store must resolve from workDir.
        workDir: Deno.makeTempDirSync({ prefix: "issue-209-workdir-" }),
      }, {
        githubUser: HOST,
        ghCommandFn: createMockGh(SIBLING),
        cache: new IssueCache(
          Deno.makeTempDirSync({ prefix: "issue-209-cache-" }),
          600,
        ),
        selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
      });

      // PR #188 belongs to the fleet, so issue #187 is not selectable.
      assertEquals(result.found, false);
    });
  },
);

Deno.test(
  "findOldestIssue - control: with no sibling PR the issue is selectable",
  async () => {
    await withTempConfig({
      repos: ["owner/repo-a"],
      allowed_authors: ["alice"],
      service_accounts: [HOST, SIBLING],
    }, async (configPath) => {
      const config = await loadConfig(configPath);
      const result = await findOldestIssue({
        ...config,
        issueLabels: ["top-priority"],
        workOnLabel: "work-on",
        shuffleRepos: false,
        workDir: Deno.makeTempDirSync({ prefix: "issue-209-workdir-" }),
      }, {
        githubUser: HOST,
        ghCommandFn: createMockGh("nobody"),
        cache: new IssueCache(
          Deno.makeTempDirSync({ prefix: "issue-209-cache-" }),
          600,
        ),
        selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
      });

      assertEquals(result.found, true);
      assertEquals(result.output.includes("187"), true);
    });
  },
);
