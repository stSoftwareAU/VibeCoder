/**
 * The completion phase preserves a dirty tree on a branch that is AHEAD of
 * its base (Issue #1684).
 *
 * Issue #218's rescue only fires when the branch is LEVEL with base, so a
 * branch that already carried a commit got no rescue at all: on GRQ-health
 * the quality-fix agent's edits sat uncommitted, the PR was raised without
 * them, the pre-PR rebase was declined for that same dirty tree, and the next
 * `reset --hard` discarded the work.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { GitHubClient } from "../types.ts";
import { isWipCommitSubject } from "../lib/wip_markers.ts";

const BRANCH = "issue-1684-quality-fix";
const DIRTY =
  " M .github/workflows/gitleaks.yml\n M .github/workflows/bump-deps.yml\n";

function stubClient(): GitHubClient {
  return {
    getIssue: () => {
      throw new Error("stub");
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: () => Promise.resolve(),
    removeLabel: () => Promise.resolve(),
    postComment: () => Promise.resolve(undefined),
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };
}

interface AheadRun {
  commits: Array<{ branch: string; message: string }>;
  /** Whether the working tree was still dirty when the rebase guard looked. */
  dirtyAtRebase: boolean;
  errors: string[];
}

/**
 * Run the completion phase against a branch one commit AHEAD of base with a
 * dirty working tree.
 */
async function runCompletionAheadOfBase(
  options: { commitSucceeds: boolean },
): Promise<AheadRun> {
  const repoPath = await Deno.makeTempDir();
  const commits: Array<{ branch: string; message: string }> = [];
  const errors: string[] = [];
  let dirty = true;
  let dirtyAtRebase = true;

  const ctx: IssueContext = {
    repo: "org/repo",
    issueNumber: 1684,
    issueTitle: "Quality-fix agent edits are never committed",
    issueBody: "",
    issueLabels: ["bug"],
    issueComments: "",
    githubUser: "vibe-worker",
    config: buildDefaultWorkerConfig(),
  };
  const state: PhaseState = {
    branchName: BRANCH,
    baseBranch: "main",
    defaultBranch: "main",
    repoPath,
    clarityStatus: "not_assessed",
    claudeOutput: "the agent fixed the quality findings",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };

  const deps = createMockDeps({
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: ((message: string) => {
        errors.push(message);
      }) as never,
      debug: () => undefined,
    } as never,
    github: {
      createClient: () => stubClient(),
      runGhCommand: (() =>
        Promise.resolve("https://github.com/org/repo/pull/9")) as never,
    },
    pr: {
      findExistingPrForIssue: (() =>
        Promise.resolve({
          ok: false,
          error: new Error("No PR found"),
        })) as never,
    },
    git: {
      runGitCommand: ((args: string[]) => {
        const ok = (stdout: string) =>
          Promise.resolve({ ok: true, value: { code: 0, stdout, stderr: "" } });
        // One commit ahead of base — the shape #218's rescue never covers.
        if (args[0] === "rev-list") return ok("1\n");
        if (args[0] === "status") {
          // The rebase guard reads the tree after the rescue has run.
          dirtyAtRebase = dirty;
          return ok(dirty ? DIRTY : "");
        }
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
          return ok(BRANCH);
        }
        return ok("");
      }) as never,
      commitAndPushPending: ((branch: string, message: string) => {
        commits.push({ branch, message });
        if (!options.commitSucceeds) {
          return Promise.resolve({
            ok: false,
            error: new Error("pre-commit safety gate refused the commit"),
          });
        }
        dirty = false;
        return Promise.resolve({
          ok: true,
          value: {
            committedNewChanges: true,
            commitsPushed: 1,
            finalUnpushedCount: 0,
            finalUnpushedSource: "remote-head" as const,
          },
        });
      }) as never,
    },
  });

  await workOnIssueCompletion(ctx, state, deps);
  return { commits, dirtyAtRebase, errors };
}

Deno.test(
  "completion_phase - a dirty tree on a branch ahead of base is committed before the PR (Issue #1684)",
  async () => {
    const run = await runCompletionAheadOfBase({ commitSucceeds: true });

    assertEquals(run.commits.length, 1, "the work reaches the branch");
    assertEquals(run.commits[0]!.branch, BRANCH);
    assert(
      !isWipCommitSubject(run.commits[0]!.message),
      `work that ships in the PR is not parked WIP: ${run.commits[0]!.message}`,
    );
    assertEquals(
      run.dirtyAtRebase,
      false,
      "the rebase guard must no longer see a dirty tree",
    );
    assertEquals(run.errors, []);
  },
);

Deno.test(
  "completion_phase - work that cannot be committed is reported loudly, with the paths (Issue #1684)",
  async () => {
    const run = await runCompletionAheadOfBase({ commitSucceeds: false });

    assertEquals(run.commits.length, 1, "the rescue was attempted");
    assert(run.errors.length > 0, "a discarded change must be reported loudly");
    assertStringIncludes(run.errors[0]!, ".github/workflows/gitleaks.yml");
    assertStringIncludes(run.errors[0]!, ".github/workflows/bump-deps.yml");
  },
);
