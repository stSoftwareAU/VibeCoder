/**
 * Integration test for tier 2b self-scheduling through `findOldestIssue`
 * (Issue #505).
 *
 * The acceptance criterion is end-to-end: an auto-filed worker diagnostic
 * is selected for work with no human touching a label, and the same
 * diagnostic is invisible to the scan once the feature is switched off.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import { findOldestIssue } from "../lib/find_oldest_issue.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { formatIdleInversionBody } from "../lib/idle_inversion_streak.ts";
import { SELF_DIAGNOSTIC_REPO } from "../lib/self_diagnostic_provenance.ts";
import type { WorkerConfig } from "../types.ts";

const WORKER_LOGIN = "vibe-bot";

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    workDir: Deno.makeTempDirSync({ prefix: "self-diag-workdir-" }),
    repos: [SELF_DIAGNOSTIC_REPO],
    issueLabels: ["top-priority"],
    allowedAuthors: ["alice"],
    workOnLabel: "work-on",
    lowPriorityLabel: "low-priority",
    failedLabel: "failed",
    failedOnceLabel: "failed-once",
    refineIssueLabel: "refine-issue",
    planningLabel: "planning",
    questionLabel: "question",
    needsRevisionLabel: "needs-revision",
    needsHumanLabel: "needs-human",
    shuffleRepos: false,
    ...overrides,
  };
}

/** The auto-filed diagnostic, exactly as `idle_inversion_streak.ts` files it. */
const DIAGNOSTIC = {
  number: 39,
  title: "fix: idle-inversion on stSoftwareAU/NEAT-AI-Rebase",
  url: `https://github.com/${SELF_DIAGNOSTIC_REPO}/issues/39`,
  assignees: [],
  labels: [],
  createdAt: "2026-08-26T00:00:00Z",
  author: { login: WORKER_LOGIN },
  milestone: null,
  body: formatIdleInversionBody({
    repo: "stSoftwareAU/NEAT-AI-Rebase",
    consecutiveCycles: 3,
    claimable: 26,
    detail: "census detail",
  }),
};

function createMockGh(): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    const command = args.join(" ");
    if (command.includes("issue list")) {
      // Only the unlabelled diagnostic exists — no label tier can match it.
      return Promise.resolve(
        command.includes("--label") ? "[]" : JSON.stringify([DIAGNOSTIC]),
      );
    }
    return Promise.resolve("[]");
  };
}

Deno.test("findOldestIssue - selects an auto-filed diagnostic with no human label", async () => {
  const result = await findOldestIssue(makeConfig(), {
    githubUser: WORKER_LOGIN,
    ghCommandFn: createMockGh(),
    cache: new IssueCache(
      Deno.makeTempDirSync({ prefix: "self-diag-cache-" }),
      600,
    ),
  });

  assertEquals(result.found, true);
  assert(
    result.output.startsWith(`${SELF_DIAGNOSTIC_REPO}|39|`),
    `expected the diagnostic to be selected, got ${result.output}`,
  );
});

Deno.test("findOldestIssue - the diagnostic is invisible when self-scheduling is off", async () => {
  const result = await findOldestIssue(
    makeConfig({ selfScheduleDiagnosticsEnabled: false }),
    {
      githubUser: WORKER_LOGIN,
      ghCommandFn: createMockGh(),
      cache: new IssueCache(
        Deno.makeTempDirSync({ prefix: "self-diag-cache-off-" }),
        600,
      ),
    },
  );

  assertEquals(result.found, false);
});
