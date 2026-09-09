/**
 * The quality-gate remediation phase commits what its fix run edited
 * (Issue #1684).
 *
 * Observed twice on GRQ-health: the fix agent edited two workflow files, the
 * rerun logged "Quality gate passed attempt=2", and nothing ever committed
 * the edit. The PR carried the tree that had FAILED attempt 1, the pre-PR
 * rebase was declined because of those same files, and the next
 * `reset --hard` threw the fix away.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueQualityGate } from "../lib/phases/quality_gate_remediation_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { CheckResult } from "../lib/quality_helpers.ts";

const BRANCH = "issue-1684-quality-fix";

function makeContext(): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: 1684,
    issueTitle: "Quality-fix agent edits are never committed",
    issueBody: "",
    issueLabels: ["bug"],
    issueComments: "",
    githubUser: "vibe-worker",
    config: buildDefaultWorkerConfig(),
  };
}

function makeState(): PhaseState {
  return {
    branchName: BRANCH,
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/issue-1684",
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
}

function gateResult(passed: boolean, checks: CheckResult[]) {
  return Promise.resolve({
    ok: true as const,
    value: {
      checks,
      summary: { text: passed ? "passed" : "failed", passed },
      passed,
      output: "quality output",
    },
  });
}

interface Harness {
  /** Quality-gate verdicts, in order; the last is reused if exhausted. */
  verdicts: boolean[];
  /** Porcelain status the working tree reports before any commit. */
  dirtyStatus: string;
  /** Does the fix run dirty the tree? */
  fixEditsFiles?: boolean;
  /** Does `commitAndPushPending` succeed? */
  commitSucceeds?: boolean;
}

interface HarnessRun {
  status: string;
  reason?: string;
  commits: Array<{ branch: string; message: string }>;
  /** Attempt numbers logged as a pass. */
  passLogs: number[];
  /** Quality-gate invocations. */
  gateRuns: number;
}

async function runPhase(options: Harness): Promise<HarnessRun> {
  const commits: Array<{ branch: string; message: string }> = [];
  const passLogs: number[] = [];
  let gateRuns = 0;
  // The tree starts dirty unless the fix run is what dirties it.
  let dirty = options.fixEditsFiles !== true;

  const deps = createMockDeps({
    logger: {
      info: ((message: string, fields?: Record<string, unknown>) => {
        if (message === "Quality gate passed") {
          passLogs.push(Number(fields?.attempt));
        }
      }) as never,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as never,
    quality: {
      runQualityGate: (() => {
        const verdict = options.verdicts[gateRuns] ??
          options.verdicts[options.verdicts.length - 1] ?? true;
        gateRuns++;
        return gateResult(
          verdict,
          verdict
            ? [{ name: "deno tests", status: "PASSED" }]
            : [{ name: "deno tests", status: "FAILED" }],
        );
      }) as never,
      collectDiffableGateFindings: (() => Promise.resolve([])) as never,
    },
    claude: {
      runClaudeWithRetry: (() => {
        if (options.fixEditsFiles) dirty = true;
        return Promise.resolve({ ok: true, value: { output: "fixed" } });
      }) as never,
    },
    git: {
      runGitCommand: ((args: string[]) => {
        const ok = (stdout: string) =>
          Promise.resolve({ ok: true, value: { code: 0, stdout, stderr: "" } });
        if (args[0] === "status") return ok(dirty ? options.dirtyStatus : "");
        return ok("");
      }) as never,
      commitAndPushPending: ((branch: string, message: string) => {
        commits.push({ branch, message });
        if (options.commitSucceeds === false) {
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

  const result = await workOnIssueQualityGate(makeContext(), makeState(), deps);
  return {
    status: result.status,
    reason: "reason" in result ? result.reason : undefined,
    commits,
    passLogs,
    gateRuns,
  };
}

Deno.test(
  "quality gate - a fix run that leaves a modified file produces a commit before the loop continues (Issue #1684)",
  async () => {
    const run = await runPhase({
      verdicts: [false, true],
      dirtyStatus:
        " M .github/workflows/gitleaks.yml\n M .github/workflows/bump-deps.yml\n",
      fixEditsFiles: true,
    });

    assertEquals(run.status, "continue");
    assertEquals(run.gateRuns, 2, "the gate is rerun after the fix");
    assertEquals(run.commits.length, 1, "the fix run's edits are committed");
    assertEquals(run.commits[0]!.branch, BRANCH);
    assertStringIncludes(run.commits[0]!.message, "quality-gate fixes");
    assert(
      !run.commits[0]!.message.startsWith("wip:"),
      "a quality fix is finished work, not parked WIP",
    );
    assertEquals(run.passLogs, [2]);
  },
);

Deno.test(
  "quality gate - a pass on a tree that could not be committed is a failure naming the paths (Issue #1684)",
  async () => {
    const run = await runPhase({
      verdicts: [true],
      dirtyStatus: " M .github/workflows/gitleaks.yml\n",
      commitSucceeds: false,
    });

    assertEquals(run.status, "failure");
    assertStringIncludes(run.reason ?? "", ".github/workflows/gitleaks.yml");
    assertStringIncludes(run.reason ?? "", "not the branch head");
    assertEquals(
      run.passLogs,
      [],
      "'Quality gate passed' must not be logged over uncommitted work",
    );
  },
);

Deno.test(
  "quality gate - a dirty tree at the pass verdict is committed, so the verdict describes the branch (Issue #1684)",
  async () => {
    const run = await runPhase({
      verdicts: [true],
      dirtyStatus: " M worker/deno/lib/a.ts\n",
    });

    assertEquals(run.status, "continue");
    assertEquals(run.commits.length, 1);
    assertStringIncludes(run.commits[0]!.message, "quality gate verified");
    assertEquals(run.passLogs, [1]);
  },
);

Deno.test(
  "quality gate - worker-owned state files alone are not treated as uncommitted work (Issue #1661)",
  async () => {
    const run = await runPhase({
      verdicts: [true],
      dirtyStatus: "?? .heartbeat_org_repo_1684\n?? .vibe_default_branch\n",
    });

    assertEquals(run.status, "continue");
    assertEquals(run.commits.length, 0, "worker state is never committed here");
    assertEquals(run.passLogs, [1]);
  },
);
