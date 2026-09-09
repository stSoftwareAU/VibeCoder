/**
 * The bump audit must never rewind published history (Issue #1714).
 *
 * `attemptBumpAudit` (Issue #1613) used to undo a `bump-deps.sh` bump with
 * `git reset --hard <beforeBumpSha>`, which also dropped every commit made
 * after the bump. Since the remediation loop commits and pushes its fix run
 * (Issue #1684) those later commits can already be on origin, so the reset
 * left the local branch BEHIND origin: `pushUnpushedCommits` then had
 * nothing to push and the PR was raised from a remote head that still
 * carried the bump the audit had just rejected.
 *
 * These tests replay that sequence against a real repository with a bare
 * origin, exactly as the worker's clone sees it: a bump commit, a pushed
 * remediation commit on top, a gate that still fails, and the audit. The
 * audit must undo the bump by moving history FORWARD (a revert), so the
 * pushed remediation commit stays an ancestor of HEAD and the branch is
 * ahead of origin — never behind it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { workOnIssueQualityGate } from "../lib/phases/quality_gate_remediation_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { runGitCommand } from "../lib/git_timeout.ts";
import type { BumpInfo } from "../lib/bump_deps.ts";

const BRANCH = "issue-1714-bump-audit";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: GIT_ENV,
  }).output();
  const stdout = new TextDecoder().decode(out.stdout);
  const stderr = new TextDecoder().decode(out.stderr);
  if (out.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${out.code}): ${stderr}`);
  }
  return stdout.trim();
}

async function commitFile(
  cwd: string,
  path: string,
  content: string,
  message: string,
): Promise<string> {
  await Deno.writeTextFile(`${cwd}/${path}`, content);
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-q", "-m", message);
  return await git(cwd, "rev-parse", "HEAD");
}

async function isAncestor(
  cwd: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const out = await new Deno.Command("git", {
    args: ["merge-base", "--is-ancestor", ancestor, descendant],
    cwd,
    stdout: "null",
    stderr: "null",
  }).output();
  return out.code === 0;
}

interface Scenario {
  root: string;
  clone: string;
  origin: string;
  /** HEAD before the bump commit — what `runBumpDeps` records. */
  beforeBumpSha: string;
  /** The bump commit itself. */
  bumpSha: string;
}

/**
 * Build the worker's view at the moment the audit runs, minus the
 * remediation commit (each test adds that itself so it can vary it):
 * origin with `main`, a clone on the issue branch with a substantive commit
 * followed by a `bump-deps.sh` bump commit, both pushed.
 */
async function buildScenario(): Promise<Scenario> {
  const root = await Deno.makeTempDir({ prefix: "vibe_1714_" });
  const origin = `${root}/origin.git`;
  const clone = `${root}/clone`;
  await Deno.mkdir(origin);
  await git(origin, "init", "-q", "--bare", "--initial-branch=main");

  const seed = `${root}/seed`;
  await Deno.mkdir(seed);
  await git(seed, "init", "-q", "--initial-branch=main");
  await commitFile(seed, "package.json", '{"dep":"1.0.0"}\n', "initial");
  await git(seed, "remote", "add", "origin", origin);
  await git(seed, "push", "-q", "origin", "main");

  await git(root, "clone", "-q", origin, clone);
  await git(clone, "checkout", "-q", "-b", BRANCH);
  const beforeBumpSha = await commitFile(
    clone,
    "feature.txt",
    "the substantive change\n",
    "feat: substantive change for issue #1714",
  );
  const bumpSha = await commitFile(
    clone,
    "package.json",
    '{"dep":"2.0.0"}\n',
    "chore: bump dependencies (issue #1714)",
  );
  await git(clone, "push", "-q", "-u", "origin", BRANCH);

  return { root, clone, origin, beforeBumpSha, bumpSha };
}

function makeContext(): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: 1714,
    issueTitle: "Bump audit rewinds published history",
    issueBody: "",
    issueLabels: ["bug"],
    issueComments: "",
    githubUser: "vibe-worker",
    config: buildDefaultWorkerConfig(),
  };
}

function makeState(
  repoPath: string,
  bumpInfo: BumpInfo,
): PhaseState {
  return {
    branchName: BRANCH,
    baseBranch: "main",
    defaultBranch: "main",
    repoPath,
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
    bumpInfo,
  };
}

function appliedBump(s: Scenario, withSha = true): BumpInfo {
  return {
    status: "applied",
    files: ["package.json"],
    output: "bumped dep 1.0.0 -> 2.0.0",
    ...(withSha ? { sha: s.bumpSha } : {}),
    beforeBumpSha: s.beforeBumpSha,
  };
}

interface RunOptions {
  /** Gate verdicts in order; the last one is reused once exhausted. */
  verdicts: boolean[];
  /** What the fix run does to the clone (the #1684 commit-and-push). */
  fixRun: (clone: string) => Promise<void>;
}

interface RunOutcome {
  status: string;
  reason?: string;
  handleIssueFailureCalled: boolean;
  gateRuns: number;
  warnings: string[];
}

async function runAudit(
  s: Scenario,
  state: PhaseState,
  opts: RunOptions,
): Promise<RunOutcome> {
  let gateRuns = 0;
  let handleIssueFailureCalled = false;
  const warnings: string[] = [];
  const deps = createMockDeps({
    quality: {
      runQualityGate: () => {
        const verdict = opts.verdicts[gateRuns] ??
          opts.verdicts[opts.verdicts.length - 1] ?? false;
        gateRuns++;
        return Promise.resolve({
          ok: true,
          value: {
            checks: [],
            summary: { text: verdict ? "passed" : "failed", passed: verdict },
            passed: verdict,
            output: verdict ? "all good" : "lint error",
          },
        });
      },
    },
    git: { runGitCommand },
    claude: {
      runClaudeWithRetry: (async () => {
        await opts.fixRun(s.clone);
        return {
          ok: true,
          value: { exitCode: 0, output: "fixed", timedOut: false },
        };
      }) as never,
    },
    github: {
      handleIssueFailure: (() => {
        handleIssueFailureCalled = true;
        return Promise.resolve({
          ok: true,
          value: {
            markedAsFailed: false,
            markedAsFailedOnce: true,
            failureCategory: "unknown",
            isInfrastructure: false,
          },
        });
      }) as never,
    },
  });
  const baseWarn = deps.logger.warn.bind(deps.logger);
  deps.logger.warn = ((msg: string, ctx?: unknown) => {
    warnings.push(msg);
    baseWarn(msg, ctx as never);
  }) as typeof deps.logger.warn;

  const result = await workOnIssueQualityGate(makeContext(), state, deps);
  return {
    status: result.status,
    reason: result.status === "failure" ? result.reason : undefined,
    handleIssueFailureCalled,
    gateRuns,
    warnings,
  };
}

/** The #1684 fix run: edit, commit and PUSH — the commit reaches origin. */
async function fixRunCommitsAndPushes(clone: string): Promise<string> {
  const sha = await commitFile(
    clone,
    "lint-fix.txt",
    "lint fixed\n",
    "fix: apply quality-gate fixes for issue #1714",
  );
  await git(clone, "push", "-q", "origin", BRANCH);
  return sha;
}

// =============================================================================
// The live scenario: bump, pushed remediation commit, gate still fails,
// audit exonerates the branch without the bump.
// =============================================================================

Deno.test(
  "bump audit - a pushed remediation commit survives the audit and the branch ends AHEAD of origin, not behind it (Issue #1714)",
  async () => {
    const s = await buildScenario();
    try {
      let fixSha = "";
      const state = makeState(s.clone, appliedBump(s));
      // Gate: fail (initial), fail (after fix run), pass (audit, no bump).
      const outcome = await runAudit(s, state, {
        verdicts: [false, false, true],
        fixRun: async (clone) => {
          fixSha = await fixRunCommitsAndPushes(clone);
        },
      });

      assertEquals(outcome.status, "continue", outcome.reason);
      assertEquals(state.bumpInfo?.status, "rejected_by_audit");
      assert(
        state.bumpInfo?.rejectionReason,
        "audit must still record why the bump was dropped",
      );
      assertEquals(outcome.gateRuns, 3);

      // The bump is gone from the tree the PR will carry ...
      assertEquals(
        await Deno.readTextFile(`${s.clone}/package.json`),
        '{"dep":"1.0.0"}\n',
        "audit must undo the bump's changes",
      );
      // ... and the substantive change is still there.
      assertEquals(
        await Deno.readTextFile(`${s.clone}/feature.txt`),
        "the substantive change\n",
      );

      // No rewind: the pushed remediation commit is still an ancestor of
      // HEAD, and so is the bump commit (history only moved forward).
      const head = await git(s.clone, "rev-parse", "HEAD");
      assert(
        await isAncestor(s.clone, fixSha, head),
        "the pushed remediation commit must remain in the branch's history",
      );
      assert(
        await isAncestor(s.clone, s.bumpSha, head),
        "history must move forward — the bump is reverted, not erased",
      );

      // The remote head must be an ancestor of local HEAD, so the branch is
      // AHEAD of origin and pushUnpushedCommits has the revert to push. Being
      // behind is exactly the #1714 failure: nothing to push, and the PR is
      // raised from a remote head that still carries the bump.
      const remoteHead = await git(s.clone, "rev-parse", `origin/${BRANCH}`);
      assert(
        await isAncestor(s.clone, remoteHead, head),
        `local HEAD ${head} must descend from origin/${BRANCH} ${remoteHead}`,
      );
      const behind = await git(
        s.clone,
        "rev-list",
        "--count",
        `HEAD..origin/${BRANCH}`,
      );
      assertEquals(behind, "0", "the branch must not be behind origin");
      const ahead = await git(
        s.clone,
        "rev-list",
        "--count",
        `origin/${BRANCH}..HEAD`,
      );
      assertEquals(ahead, "1", "exactly the audit's revert is unpushed");

      // The working tree is clean — the revert is a commit, not a dirty tree
      // the completion phase's rebase would decline.
      assertEquals(await git(s.clone, "status", "--porcelain"), "");
    } finally {
      await Deno.remove(s.root, { recursive: true });
    }
  },
);

// =============================================================================
// The other direction: the audit does NOT exonerate the branch. The audit's
// own revert must be undone, the pushed remediation commit must still be
// HEAD, and the failure is reported as before.
// =============================================================================

Deno.test(
  "bump audit - when quality still fails without the bump, the revert is undone and the pushed head is restored (Issue #1714)",
  async () => {
    const s = await buildScenario();
    try {
      let fixSha = "";
      const state = makeState(s.clone, appliedBump(s));
      const outcome = await runAudit(s, state, {
        verdicts: [false],
        fixRun: async (clone) => {
          fixSha = await fixRunCommitsAndPushes(clone);
        },
      });

      assertEquals(outcome.status, "failure");
      assertEquals(state.bumpInfo?.status, "applied");
      assertEquals(outcome.handleIssueFailureCalled, true);
      assertEquals(outcome.gateRuns, 3, "the audit rerun still happens");

      // HEAD is exactly the pushed remediation commit: the audit's revert is
      // gone, and nothing published was rewound.
      assertEquals(await git(s.clone, "rev-parse", "HEAD"), fixSha);
      assertEquals(
        await git(s.clone, "rev-parse", `origin/${BRANCH}`),
        fixSha,
      );
      // The bump is back in the tree, as the failure report expects.
      assertEquals(
        await Deno.readTextFile(`${s.clone}/package.json`),
        '{"dep":"2.0.0"}\n',
      );
      assertEquals(await git(s.clone, "status", "--porcelain"), "");
    } finally {
      await Deno.remove(s.root, { recursive: true });
    }
  },
);

// =============================================================================
// bumpInfo.sha missing: the bump commit is derived from beforeBumpSha.
// =============================================================================

Deno.test(
  "bump audit - without a recorded bump SHA the bump commit is derived from beforeBumpSha and still reverted forward (Issue #1714)",
  async () => {
    const s = await buildScenario();
    try {
      let fixSha = "";
      const state = makeState(s.clone, appliedBump(s, false));
      const outcome = await runAudit(s, state, {
        verdicts: [false, false, true],
        fixRun: async (clone) => {
          fixSha = await fixRunCommitsAndPushes(clone);
        },
      });

      assertEquals(outcome.status, "continue", outcome.reason);
      assertEquals(state.bumpInfo?.status, "rejected_by_audit");
      assertEquals(
        await Deno.readTextFile(`${s.clone}/package.json`),
        '{"dep":"1.0.0"}\n',
      );
      const head = await git(s.clone, "rev-parse", "HEAD");
      assert(await isAncestor(s.clone, fixSha, head));
      assertEquals(
        await git(s.clone, "rev-list", "--count", `HEAD..origin/${BRANCH}`),
        "0",
      );
    } finally {
      await Deno.remove(s.root, { recursive: true });
    }
  },
);

// =============================================================================
// The revert cannot apply cleanly (the fix run rewrote the bumped lines):
// the audit is skipped, the revert is aborted, and nothing is rewound.
// =============================================================================

Deno.test(
  "bump audit - a conflicting revert is aborted, the audit is skipped and the pushed head is untouched (Issue #1714)",
  async () => {
    const s = await buildScenario();
    try {
      let fixSha = "";
      const state = makeState(s.clone, appliedBump(s));
      const outcome = await runAudit(s, state, {
        // Even a passing audit verdict must not be reachable: the gate must
        // run only twice because the audit never gets to rerun it.
        verdicts: [false, false, true],
        fixRun: async (clone) => {
          fixSha = await commitFile(
            clone,
            "package.json",
            '{"dep":"2.0.1"}\n',
            "fix: pin the bumped dependency differently",
          );
          await git(clone, "push", "-q", "origin", BRANCH);
        },
      });

      assertEquals(outcome.status, "failure");
      assertEquals(outcome.gateRuns, 2, "audit rerun must be skipped");
      assertEquals(state.bumpInfo?.status, "applied");
      assertEquals(outcome.handleIssueFailureCalled, true);
      assert(
        outcome.warnings.some((w) => w.includes("bump audit")),
        "the skipped audit must be logged",
      );

      assertEquals(await git(s.clone, "rev-parse", "HEAD"), fixSha);
      assertEquals(
        await git(s.clone, "status", "--porcelain"),
        "",
        "the aborted revert must leave a clean tree",
      );
      assertEquals(
        await Deno.readTextFile(`${s.clone}/package.json`),
        '{"dep":"2.0.1"}\n',
      );
    } finally {
      await Deno.remove(s.root, { recursive: true });
    }
  },
);

