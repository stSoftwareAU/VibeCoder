/**
 * Tests for `agent_pr_adoption.ts` — adopting an agent-raised PR on the run's
 * own branch at the completion phase's exit (Issue #3804).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type AdoptAgentPrDeps,
  type AdoptAgentPrInput,
  adoptAgentRaisedPrBody,
} from "../lib/agent_pr_adoption.ts";
import type {
  syncPrBodyFromSummary,
  SyncPrBodyInput,
} from "../lib/pr_body_sync.ts";
import type {
  GitCommandOptions,
  GitCommandOutput,
} from "../lib/git_timeout.ts";
import type { Logger, Result } from "../types.ts";

const noop = () => {};
const logger: Logger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  security: noop,
  skipReason: noop,
  timing: noop,
  scanSummary: noop,
  workerSummary: noop,
};

const REPO = "owner/repo";
const BRANCH = "issue-42-fix-thing";
const SHA = "abc1234def5678abc1234def5678abc1234def56";
const PR_URL = "https://github.com/owner/repo/pull/7";

function input(overrides: Partial<AdoptAgentPrInput> = {}): AdoptAgentPrInput {
  return {
    repo: REPO,
    branchName: BRANCH,
    repoPath: "/nonexistent/checkout",
    workerName: "worker-a",
    githubUser: "ghuser",
    runId: "run-1",
    ...overrides,
  };
}

/** Fake `git`: `rev-parse HEAD` gives `head`; `ls-remote` gives `remote`. */
function gitFake(
  gitCalls: string[][],
  opts: { head: string; remote: string },
) {
  return (
    args: string[],
    _options?: GitCommandOptions,
  ): Promise<Result<GitCommandOutput>> => {
    gitCalls.push(args);
    let stdout = "";
    if (args[0] === "rev-parse") stdout = `${opts.head}\n`;
    if (args[0] === "ls-remote" && opts.remote.length > 0) {
      stdout = `${opts.remote}\trefs/heads/${BRANCH}\n`;
    }
    return Promise.resolve({
      ok: true,
      value: { code: 0, stdout, stderr: "" },
    });
  };
}

/** Fake `findExistingPrForBranch`: an open PR at `url`, or none when undefined. */
function prLookup(url: string | undefined) {
  return (_repo: string, _branch: string): Promise<Result<string>> =>
    Promise.resolve(
      url === undefined
        ? { ok: false, error: new Error("no open PR for this branch") }
        : { ok: true, value: url },
    );
}

/** Records each sync call instead of touching GitHub. */
function recordingSync(calls: SyncPrBodyInput[]): typeof syncPrBodyFromSummary {
  return (input) => {
    calls.push(input);
    return Promise.resolve({
      ok: true,
      value: { status: "skipped", reason: "recorded" },
    });
  };
}

function deps(opts: {
  head: string;
  remote: string;
  prUrl: string | undefined;
  gitCalls: string[][];
}): AdoptAgentPrDeps {
  return {
    findExistingPrForBranch: prLookup(opts.prUrl),
    runGhCommand: () => Promise.resolve(""),
    runGitCommand: gitFake(opts.gitCalls, {
      head: opts.head,
      remote: opts.remote,
    }),
    logger,
  };
}

Deno.test("adoptAgentRaisedPrBody - Issue #3804: syncs the PR on the run's own branch once HEAD is pushed", async () => {
  const gitCalls: string[][] = [];
  const syncCalls: SyncPrBodyInput[] = [];
  await adoptAgentRaisedPrBody(
    input(),
    deps({ head: SHA, remote: SHA, prUrl: PR_URL, gitCalls }),
    recordingSync(syncCalls),
  );

  assertEquals(gitCalls, [
    ["rev-parse", "HEAD"],
    ["ls-remote", "origin", `refs/heads/${BRANCH}`],
  ]);
  assertEquals(syncCalls.length, 1);
  const call = syncCalls[0];
  assert(call, "expected one sync call");
  assertEquals(call.prNumber, 7);
  assertEquals(call.repo, REPO);
  assertEquals(call.branchName, BRANCH);
  assertEquals(call.adoptOnly, true);
  assertEquals(call.beforeSha, undefined);
});

Deno.test("adoptAgentRaisedPrBody - Issue #3804: does not adopt when HEAD differs from the pushed head", async () => {
  const syncCalls: SyncPrBodyInput[] = [];
  await adoptAgentRaisedPrBody(
    input(),
    deps({
      head: SHA,
      remote: "0000000000000000000000000000000000000000",
      prUrl: PR_URL,
      gitCalls: [],
    }),
    recordingSync(syncCalls),
  );

  assertEquals(syncCalls.length, 0);
});

Deno.test("adoptAgentRaisedPrBody - Issue #3804: skips a branch that is not a worker issue branch without any git call", async () => {
  const gitCalls: string[][] = [];
  const findCalls: string[] = [];
  const syncCalls: SyncPrBodyInput[] = [];
  const base = deps({ head: SHA, remote: SHA, prUrl: PR_URL, gitCalls });
  await adoptAgentRaisedPrBody(
    input({ branchName: "feature/x" }),
    {
      ...base,
      findExistingPrForBranch: (repo, branch) => {
        findCalls.push(branch);
        return prLookup(PR_URL)(repo, branch);
      },
    },
    recordingSync(syncCalls),
  );

  assertEquals(gitCalls, []);
  assertEquals(findCalls, []);
  assertEquals(syncCalls.length, 0);
});

Deno.test("adoptAgentRaisedPrBody - Issue #3804: does nothing when no open PR exists for the branch", async () => {
  const syncCalls: SyncPrBodyInput[] = [];
  await adoptAgentRaisedPrBody(
    input(),
    deps({ head: SHA, remote: SHA, prUrl: undefined, gitCalls: [] }),
    recordingSync(syncCalls),
  );

  assertEquals(syncCalls.length, 0);
});

Deno.test("adoptAgentRaisedPrBody - Issue #3804: does not sync when the branch is not pushed", async () => {
  const syncCalls: SyncPrBodyInput[] = [];
  await adoptAgentRaisedPrBody(
    input(),
    deps({ head: SHA, remote: "", prUrl: PR_URL, gitCalls: [] }),
    recordingSync(syncCalls),
  );

  assertEquals(syncCalls.length, 0);
});
