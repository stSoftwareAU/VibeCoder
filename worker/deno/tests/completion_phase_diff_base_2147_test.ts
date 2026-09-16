/**
 * The screenshot gate's changed-file list is diffed against the branch's
 * real base on origin, never the stale local ref (Issue #2147).
 *
 * GRQ-AutoTrader#463: the run brought its branch forward onto origin/Develop,
 * the local Develop was stale, and `git diff --name-only Develop...HEAD`
 * listed 62 files including web/*.tsx for a 12-file Rust change — the
 * screenshot gate failed the run.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubClient } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const SHA = "96a7fa00c0ffee00c0ffee00c0ffee00c0ffee00";

function stubClient(posted: string[]): GitHubClient {
  return {
    getIssue: () => {
      throw new Error("stub");
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: () => Promise.resolve(),
    removeLabel: () => Promise.resolve(),
    postComment: (_r, _n, body) => {
      posted.push(body);
      return Promise.resolve(undefined);
    },
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };
}

/** A Rust-only change whose summary names no UI at all. */
async function makeRepo(): Promise<string> {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/docs/archive/pr-summaries`, { recursive: true });
  await Deno.writeTextFile(
    `${root}/docs/archive/pr-summaries/pr-summary-463.md`,
    "## Summary\n\nProve the execution role holds every permission the resource schemas name. Closes #463.\n",
  );
  return root;
}

/**
 * Drive completion with a git stub whose local base is stale.
 *
 * `originResolves` is whether `origin/Develop` exists in the clone; the
 * local `Develop` always does, and always carries the upstream web files.
 */
async function run(originResolves: boolean) {
  const repoPath = await makeRepo();
  const posted: string[] = [];
  const diffRefs: string[] = [];
  let prCreated = false;
  const ctx: IssueContext = {
    repo: "stSoftwareAU/GRQ-AutoTrader",
    issueNumber: 463,
    issueTitle: "infra: prove the execution role holds every permission",
    issueBody: "",
    issueLabels: ["enhancement", "low-priority"],
    issueComments: "",
    githubUser: "testbot",
    config: buildDefaultWorkerConfig(),
  };
  const state: PhaseState = {
    branchName: "issue-463-infra-prove",
    baseBranch: "Develop",
    defaultBranch: "Develop",
    repoPath,
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
  const deps = createMockDeps({
    github: {
      createClient: () => stubClient(posted),
      runGhCommand: (args: string[]) => {
        if (args[0] === "pr" && args[1] === "create") prCreated = true;
        return Promise.resolve(
          "https://github.com/stSoftwareAU/GRQ-AutoTrader/pull/900",
        );
      },
    },
    git: {
      runGitCommand: (cmdArgs: string[]) => {
        if (cmdArgs[0] === "rev-parse") {
          const missing = !originResolves &&
            cmdArgs.includes("origin/Develop^{commit}");
          return Promise.resolve({
            ok: true,
            value: {
              code: missing ? 1 : 0,
              stdout: missing ? "" : `${SHA}\n`,
              stderr: "",
            },
          });
        }
        if (cmdArgs[0] === "diff" && cmdArgs[1] === "--name-only") {
          const ref = cmdArgs[cmdArgs.length - 1]!;
          diffRefs.push(ref);
          if (ref.startsWith("origin/")) {
            return Promise.resolve({
              ok: true,
              value: {
                code: 0,
                stdout:
                  "crates/infra/src/permissions.rs\ndocs/archive/pr-summaries/pr-summary-463.md\n",
                stderr: "",
              },
            });
          }
          // The stale local base: everything upstream since it, web UI included.
          return Promise.resolve({
            ok: true,
            value: {
              code: 0,
              stdout:
                "crates/infra/src/permissions.rs\nweb/src/App.tsx\nweb/src/market/MarketIndicator.tsx\n",
              stderr: "",
            },
          });
        }
        return Promise.resolve({
          ok: true,
          value: { code: 0, stdout: "", stderr: "" },
        });
      },
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("none") }),
      findExistingPrForBranch: () =>
        Promise.resolve({ ok: false, error: new Error("none") }),
    },
  });
  const result = await workOnIssueCompletion(ctx, state, deps);
  await Deno.remove(repoPath, { recursive: true });
  return { result, posted, diffRefs, prCreated };
}

Deno.test("completion - every changed-file diff runs against origin/<base>, so a stale local base cannot make a Rust change a UI change (Issue #2147)", async () => {
  const { result, posted, diffRefs, prCreated } = await run(true);
  assertEquals(
    diffRefs.filter((r) => !r.startsWith("origin/")),
    [],
    `every name-only diff is against origin: ${JSON.stringify(diffRefs)}`,
  );
  assert(
    diffRefs.includes("origin/Develop...HEAD"),
    "the screenshot gate diffed against origin/Develop",
  );
  assertEquals(result.status, "continue", JSON.stringify(result));
  assert(
    !posted.some((p) => p.includes("Screenshot Evidence Required")),
    "a Rust-only change must not be gated on screenshots",
  );
  assert(prCreated, "the PR is created");
});

Deno.test("completion - a base origin does not carry falls back to the local ref (Issue #2147)", async () => {
  const { diffRefs } = await run(false);
  assert(
    diffRefs.includes("Develop...HEAD"),
    `the screenshot gate fell back to the local base: ${
      JSON.stringify(diffRefs)
    }`,
  );
  assertEquals(diffRefs.filter((r) => r.startsWith("origin/")), []);
});
