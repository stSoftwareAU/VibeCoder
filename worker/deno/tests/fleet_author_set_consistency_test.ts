/**
 * Tests for the fleet PR-author single source of truth (Issue #4024).
 *
 * The #4023 stall was not a typo in one author list — it was two
 * independently-maintained author sets with nothing detecting their
 * divergence. These tests lock in the invariant, as narrowed by #4076 and
 * made intent-aware by #4079:
 *
 *   The maintenance set is the fleet-owned set minus the trusted humans
 *   (`allowed_authors`), and nothing else — so every open PR
 *   `getBlockingPRForIssue()` can return is either maintained or a
 *   trusted human's.
 *
 * They cover the shared resolver, the per-iteration divergence warning,
 * the blocking-PR log line (with `inMaintenanceSet` both ways), and the
 * non-fatality of the check.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import {
  compareFleetAuthorSets,
  resolveFleetAuthors,
  resolveFleetMaintenanceAuthorSet,
  resolveFleetPrAuthorSet,
} from "../lib/fleet_authors.ts";
import { findOldestIssue } from "../lib/find_oldest_issue.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createDiagnostics } from "../lib/issue_finder_logger.ts";
import type { WorkerConfig } from "../types.ts";

const ALICE = { login: "alice" };
const HOST = "bot";
const SIBLING = "stsvcbot";

// ---------------------------------------------------------------------------
// resolveFleetPrAuthorSet — the single source of truth
// ---------------------------------------------------------------------------

Deno.test("resolveFleetPrAuthorSet - unions host, allowed and sibling logins", () => {
  const result = resolveFleetPrAuthorSet({
    githubUser: HOST,
    allowedAuthors: ["alice"],
    fleetPrAuthors: [SIBLING],
  });
  assertEquals(result, [HOST, "alice", SIBLING]);
});

Deno.test("resolveFleetPrAuthorSet - omitted lists default to empty", () => {
  assertEquals(resolveFleetPrAuthorSet({ githubUser: HOST }), [HOST]);
});

Deno.test("resolveFleetPrAuthorSet - matches resolveFleetAuthors for the same inputs", () => {
  const input = {
    githubUser: HOST,
    allowedAuthors: ["alice", " "],
    fleetPrAuthors: [SIBLING, "ALICE"],
  };
  assertEquals(
    resolveFleetPrAuthorSet(input),
    resolveFleetAuthors(HOST, [...input.allowedAuthors], [
      ...input.fleetPrAuthors,
    ]),
  );
});

// ---------------------------------------------------------------------------
// compareFleetAuthorSets — the self-checking invariant
// ---------------------------------------------------------------------------

Deno.test("compareFleetAuthorSets - identical sets do not diverge", () => {
  const result = compareFleetAuthorSets([HOST, SIBLING], [SIBLING, HOST]);
  assertEquals(result.diverged, false);
  assertEquals(result.missingFromMaintenance, []);
  assertEquals(result.missingFromBlocking, []);
});

Deno.test("compareFleetAuthorSets - names authors missing from the maintenance set", () => {
  const result = compareFleetAuthorSets([HOST, "alice", SIBLING], [HOST]);
  assertEquals(result.diverged, true);
  assertEquals(result.missingFromMaintenance, ["alice", SIBLING]);
  assertEquals(result.missingFromBlocking, []);
});

Deno.test("compareFleetAuthorSets - names authors missing from the blocking set", () => {
  const result = compareFleetAuthorSets([HOST], [HOST, SIBLING]);
  assertEquals(result.diverged, true);
  assertEquals(result.missingFromBlocking, [SIBLING]);
});

Deno.test("compareFleetAuthorSets - matches case-insensitively and ignores blanks", () => {
  const result = compareFleetAuthorSets(["Bot", "  "], ["bot"]);
  assertEquals(result.diverged, false);
});

// ---------------------------------------------------------------------------
// The post-#4076 cross-set invariant (Issue #4079)
//
//   The maintenance set is the fleet-owned set minus the trusted humans,
//   and nothing else.
//
// Asserted against the real config shapes the two resolvers produce, so a
// mismatch between the check's exclusion list and the actual
// `allowed_authors` split is caught even when the unit cases pass.
// ---------------------------------------------------------------------------

Deno.test(
  "maintenance set is the fleet-owned set minus trusted humans, and nothing else (Issue #4079)",
  () => {
    const inputs = [
      { githubUser: HOST },
      { githubUser: HOST, allowedAuthors: ["alice"] },
      { githubUser: HOST, fleetPrAuthors: [SIBLING] },
      {
        githubUser: HOST,
        allowedAuthors: ["alice"],
        fleetPrAuthors: [SIBLING],
      },
      // A login trusted *and* operated by the fleet stays in both sets.
      {
        githubUser: HOST,
        allowedAuthors: ["alice", SIBLING],
        fleetPrAuthors: [SIBLING],
      },
      // Blank/duplicate entries as they arrive from a hand-edited config.
      {
        githubUser: HOST,
        allowedAuthors: ["  ", "ALICE", "alice"],
        fleetPrAuthors: [` ${SIBLING} `, ""],
      },
    ];
    for (const input of inputs) {
      const owned = resolveFleetPrAuthorSet(input);
      const maintenance = resolveFleetMaintenanceAuthorSet(input);
      // 1. Declaring `allowed_authors` as the expected delta silences the
      //    warning for every real config shape.
      const aware = compareFleetAuthorSets(owned, maintenance, {
        expectedMaintenanceExclusions: input.allowedAuthors ?? [],
      });
      assertEquals(
        aware.diverged,
        false,
        `unexpected divergence for ${JSON.stringify(input)}: ${
          JSON.stringify(aware)
        }`,
      );
      // 2. The raw delta is *exactly* the trusted humans the fleet does not
      //    also operate — nothing else may go missing.
      const raw = compareFleetAuthorSets(owned, maintenance);
      const maintained = new Set(maintenance.map((a) => a.toLowerCase()));
      const expectedDelta = resolveFleetPrAuthorSet({
        githubUser: "",
        allowedAuthors: input.allowedAuthors ?? [],
      }).filter((a) => !maintained.has(a.toLowerCase()));
      assertEquals(raw.missingFromMaintenance, expectedDelta);
      assertEquals(raw.missingFromBlocking, []);
    }
  },
);

// ---------------------------------------------------------------------------
// findOldestIssue — per-iteration divergence warning and blocking-PR line
// ---------------------------------------------------------------------------

function createTestCache(): IssueCache {
  const dir = Deno.makeTempDirSync({ prefix: "fleet-author-set-" });
  return new IssueCache(dir, 600);
}

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    // The content-approval store must resolve from workDir, or the
    // integrity gate fails closed and blocks every candidate (#3874).
    workDir: Deno.makeTempDirSync({ prefix: "fleet-author-set-workdir-" }),
    repos: ["owner/repo-a"],
    issueLabels: [],
    allowedAuthors: ["alice"],
    fleetPrAuthors: [SIBLING],
    workOnLabel: "work-on",
    shuffleRepos: false,
    ...overrides,
  };
}

/**
 * Mock `gh` where the sibling fleet account owns one open PR (#103)
 * targeting the default branch — the shape that blocks a non-milestone
 * `work-on` issue.
 */
function createMockGh(): (args: string[]) => Promise<string> {
  const issues = [
    {
      number: 700,
      title: "First blocked chore",
      url: "https://github.com/owner/repo-a/issues/700",
      assignees: [],
      labels: [{ name: "work-on" }],
      createdAt: "2024-01-01T00:00:00Z",
      author: ALICE,
      milestone: null,
    },
    {
      number: 701,
      title: "Second blocked chore",
      url: "https://github.com/owner/repo-a/issues/701",
      assignees: [],
      labels: [{ name: "work-on" }],
      createdAt: "2024-01-02T00:00:00Z",
      author: ALICE,
      milestone: null,
    },
  ];
  const siblingPr = {
    number: 103,
    title: "Blocked chore (#700)",
    baseRefName: "main",
    headRefName: "issue-700",
  };

  return (args: string[]): Promise<string> => {
    const command = args.join(" ");
    if (command.includes("issue list")) {
      return Promise.resolve(JSON.stringify(issues));
    }
    if (command.includes("pr list")) {
      const authorIdx = args.indexOf("--author");
      const author = authorIdx >= 0 ? args[authorIdx + 1] : "";
      if (author === SIBLING) {
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

async function runFinder(maintenanceAuthors?: string[]) {
  const diag = createDiagnostics({ enabled: false, write: () => {} });
  const result = await findOldestIssue(makeConfig(), {
    githubUser: HOST,
    ghCommandFn: createMockGh(),
    cache: createTestCache(),
    diagnostics: diag,
    maintenanceAuthors,
    selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
  });
  return { result, messages: diag.getMessages() };
}

Deno.test(
  "findOldestIssue - warns once when the blocking and maintenance author sets diverge (Issues #4024/#4079)",
  async () => {
    // Maintenance covers the host only — the sibling blocks work that no
    // scan would ever maintain. `alice` is a trusted human, so her absence
    // is the intended #4076 delta and is not reported (Issue #4079).
    const { messages } = await runFinder([HOST]);

    const warnings = messages.filter((m) =>
      m.includes("fleet-author-set-divergence")
    );
    assertEquals(warnings.length, 1);
    const warning = warnings[0] ?? "";
    assertEquals(
      warning.includes("missing-from-maintenance=stsvcbot"),
      true,
    );
    assertEquals(warning.includes("alice"), false);
    assertEquals(warning.includes("missing-from-blocking=(none)"), true);
  },
);

Deno.test(
  "findOldestIssue - the push-capable maintenance set warns nothing (Issue #4079)",
  async () => {
    // The production shape after #4076: the maintenance scans see the host
    // plus `fleet_pr_authors`, never `allowed_authors`. That must be silent
    // — a permanently-firing warning trains operators to ignore it.
    const { messages } = await runFinder(
      resolveFleetMaintenanceAuthorSet({
        githubUser: HOST,
        allowedAuthors: ["alice"],
        fleetPrAuthors: [SIBLING],
      }),
    );
    assertEquals(
      messages.some((m) => m.includes("fleet-author-set-divergence")),
      false,
    );
  },
);

Deno.test(
  "findOldestIssue - no divergence warning when the two sets agree (Issue #4024)",
  async () => {
    const { messages } = await runFinder([HOST, "alice", SIBLING]);
    assertEquals(
      messages.some((m) => m.includes("fleet-author-set-divergence")),
      false,
    );
  },
);

Deno.test(
  "findOldestIssue - divergence is non-fatal: the iteration completes normally (Issue #4024)",
  async () => {
    const { result, messages } = await runFinder([HOST]);
    // The warning fired …
    assertEquals(
      messages.some((m) => m.includes("fleet-author-set-divergence")),
      true,
    );
    // … and the scan still produced its normal result (both work-on
    // issues are PR-blocked, so nothing is selectable) rather than throwing.
    assertEquals(result.found, false);
    assertEquals(result.summary, "No eligible issues found");
  },
);

Deno.test(
  "findOldestIssue - blocking PR outside the maintenance set logs in-maintenance-set=false (Issue #4024)",
  async () => {
    const { messages } = await runFinder([HOST]);

    const lines = messages.filter((m) => m.includes("pr-blocks-work-on"));
    assertEquals(lines.length, 1);
    const line = lines[0] ?? "";
    assertEquals(line.includes("repo=owner/repo-a"), true);
    assertEquals(line.includes("pr=#103"), true);
    assertEquals(line.includes(`author=${SIBLING}`), true);
    assertEquals(line.includes("base=main"), true);
    // Both work-on issues the PR deferred appear on the one line.
    assertEquals(line.includes("blocked-issues=#700,#701"), true);
    assertEquals(line.includes("in-maintenance-set=false"), true);
  },
);

Deno.test(
  "findOldestIssue - blocking PR inside the maintenance set logs in-maintenance-set=true (Issue #4024)",
  async () => {
    const { messages } = await runFinder([HOST, "alice", SIBLING]);

    const line = messages.find((m) => m.includes("pr-blocks-work-on"));
    assertEquals(line !== undefined, true);
    assertEquals(line!.includes("in-maintenance-set=true"), true);
  },
);

Deno.test(
  "findOldestIssue - defaults the maintenance set to the blocking set when unwired (Issue #4024)",
  async () => {
    const { messages } = await runFinder();
    assertEquals(
      messages.some((m) => m.includes("fleet-author-set-divergence")),
      false,
    );
    const line = messages.find((m) => m.includes("pr-blocks-work-on"));
    assertEquals(line!.includes("in-maintenance-set=true"), true);
  },
);

// ---------------------------------------------------------------------------
// Architectural guard — no module builds its own PR-author list
// ---------------------------------------------------------------------------

Deno.test(
  "fleet PR-author consumers all resolve through the shared helper (Issues #4024/#4076)",
  async () => {
    // Issue #4076: the resolver a consumer must use depends on what it does
    // with the PRs it finds — defer to them, or act on them.
    const consumers = [
      // Blocking guard: defers to a PR, so it keeps the wider fleet-owned set.
      { path: "lib/find_oldest_issue.ts", helper: "resolveFleetPrAuthorSet" },
      // Maintenance scans: claim, push, comment and merge — push-capable set.
      {
        path: "lib/pr_maintenance.ts",
        helper: "resolveFleetMaintenanceAuthorSet",
      },
      {
        path: "lib/pr_ci_nudge_scan.ts",
        helper: "resolveFleetMaintenanceAuthorSet",
      },
    ];
    for (const { path, helper } of consumers) {
      const source = await Deno.readTextFile(
        new URL(`../${path}`, import.meta.url),
      );
      assertEquals(
        source.includes(`${helper}(`),
        true,
        `${path} must resolve its PR-author set via ${helper}`,
      );
      assertEquals(
        source.includes('from "./fleet_authors.ts"'),
        true,
        `${path} must import the shared fleet-author module`,
      );
      // No hand-rolled union of the configured author lists.
      assertEquals(
        /\[\s*githubUser\s*,/.test(source),
        false,
        `${path} must not build its own author list`,
      );
      assertEquals(
        source.includes("resolveFleetAuthors("),
        false,
        `${path} must call the named helper, not the low-level resolver`,
      );
      // A scan that acts on PRs must not gain a wider-set call site
      // (Issue #4076) — that is exactly how #4074 adopted a human's PR.
      if (helper === "resolveFleetMaintenanceAuthorSet") {
        assertEquals(
          source.includes("resolveFleetPrAuthorSet("),
          false,
          `${path} acts on the PRs it finds and must never resolve the ` +
            `wider fleet-owned set`,
        );
      }
    }
  },
);
