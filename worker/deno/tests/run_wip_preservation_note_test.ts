/**
 * Regression tests for the WIP release-comment note (Issue #3665).
 *
 * The note is posted on the TARGET repo's issue, where a bare `#47` or
 * `#4170` links to an unrelated issue. The note therefore must not cite a
 * fixed VibeCoder issue number. Each `wipNote` variant is driven through the
 * real `preserveRunWip` with git mocked, and checked for its wording, its
 * branch name (a positive control), and the absence of any `#<digits>`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert } from "@std/assert";
import {
  type PreservedRunWip,
  preserveRunWip,
} from "../lib/phases/run_wip_preservation.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { PhaseState } from "../lib/issue_worker_types.ts";

const BRANCH = "issue-branch-wip";
const REPO_PATH = "/tmp/test-repo";
const START_SHA = "abc1234def5678";

interface Scenario {
  /** Stdout of `git status --porcelain`. */
  statusStdout: string;
  /** Stdout of `git rev-list --count <start>..HEAD` — the checkpoint count. */
  checkpointCount: string;
  /** What `commitAndPushPending` resolves to. */
  commitResult: unknown;
}

function runScenario(scenario: Scenario): Promise<PreservedRunWip> {
  const state: PhaseState = {
    branchName: BRANCH,
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: REPO_PATH,
    clarityStatus: "assessed_clear",
    claudeOutput: "",
    executeStartTime: Date.now(),
    baselineQualityPassed: true,
    baselineQualityOutput: "",
    executeStartHeadSha: START_SHA,
  };
  const ok = (stdout: string) =>
    Promise.resolve({ ok: true, value: { code: 0, stdout, stderr: "" } });
  const deps = createMockDeps({
    git: {
      runGitCommand: ((args: string[]) => {
        if (args[0] === "status") return ok(scenario.statusStdout);
        if (args[0] === "rev-list") return ok(scenario.checkpointCount);
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
          return ok(BRANCH);
        }
        return ok("");
      }) as never,
      commitAndPushPending: (() =>
        Promise.resolve(scenario.commitResult)) as never,
    },
  });
  return preserveRunWip({
    state,
    deps,
    buildMessage: (dirtyFiles: number) =>
      `wip: preserve ${dirtyFiles} uncommitted file(s)`,
  });
}

/** The note must name the expected wording and the branch, and cite no `#<n>`. */
function assertTargetSafeNote(
  wipNote: string | undefined,
  expectedWording: string,
  mustContain: string[],
): void {
  assert(wipNote !== undefined, "wipNote must be defined for this variant");
  assert(
    wipNote.includes(expectedWording),
    `note must read "${expectedWording}": ${wipNote}`,
  );
  for (const text of mustContain) {
    assert(wipNote.includes(text), `note must contain "${text}": ${wipNote}`);
  }
  assert(
    !/#\d/.test(wipNote),
    `note must not cite a VibeCoder issue number (it lands on the target repo): ${wipNote}`,
  );
}

Deno.test("run_wip_preservation note - dirty tree pushed names the branch with no issue citation (Issue #3665)", async () => {
  const result = await runScenario({
    statusStdout: " M src/a.ts\n?? src/b.ts\n",
    checkpointCount: "0",
    commitResult: {
      ok: true,
      value: {
        committedNewChanges: true,
        commitsPushed: 1,
        finalUnpushedCount: 0,
        finalUnpushedSource: "remote-head",
      },
    },
  });
  assertTargetSafeNote(
    result.wipNote,
    "WIP preserved: committed and pushed to",
    [`'${BRANCH}'`],
  );
});

Deno.test("run_wip_preservation note - clean tree with checkpoint commits names the count and branch (Issue #3665)", async () => {
  const result = await runScenario({
    statusStdout: "",
    checkpointCount: "2",
    commitResult: undefined,
  });
  assertTargetSafeNote(
    result.wipNote,
    "2 checkpoint commits pushed to",
    [`'${BRANCH}'`],
  );
});

Deno.test("run_wip_preservation note - dirty tree already checkpointed names the branch with no issue citation (Issue #3665)", async () => {
  const result = await runScenario({
    statusStdout: " M src/a.ts\n?? src/b.ts\n",
    checkpointCount: "0",
    commitResult: {
      ok: true,
      value: {
        committedNewChanges: false,
        commitsPushed: 0,
        finalUnpushedCount: 0,
        finalUnpushedSource: "remote-head",
      },
    },
  });
  assertTargetSafeNote(
    result.wipNote,
    "WIP already checkpointed on",
    [`'${BRANCH}'`],
  );
});

Deno.test("run_wip_preservation note - failed preservation names the reason with no issue citation (Issue #3665)", async () => {
  const result = await runScenario({
    statusStdout: " M src/a.ts\n?? src/b.ts\n",
    checkpointCount: "0",
    commitResult: { ok: false, error: new Error("remote rejected the push") },
  });
  // The failure note states the reason, not the branch, so the positive
  // control here is the reason text.
  assertTargetSafeNote(
    result.wipNote,
    "WIP preservation failed (remote rejected the push)",
    [],
  );
});
