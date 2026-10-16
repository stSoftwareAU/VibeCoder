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

/** One info or warn call, recorded for assertions. */
interface LogEntry {
  level: "info" | "warn";
  message: string;
  context: unknown;
}

/** A logger that records every info and warn call. */
function capturingLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    entries,
    logger: {
      ...logger,
      info: (message, context) => {
        entries.push({ level: "info", message, context });
      },
      warn: (message, context) => {
        entries.push({ level: "warn", message, context });
      },
    },
  };
}

function deps(
  opts: {
    head: string;
    remote: string;
    prUrl: string | undefined;
    gitCalls: string[][];
  },
  overrides: Partial<AdoptAgentPrDeps> = {},
): AdoptAgentPrDeps {
  return {
    findExistingPrForBranch: prLookup(opts.prUrl),
    runGhCommand: () => Promise.resolve(""),
    runGitCommand: gitFake(opts.gitCalls, {
      head: opts.head,
      remote: opts.remote,
    }),
    logger,
    ...overrides,
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
  const captured = capturingLogger();
  await adoptAgentRaisedPrBody(
    input(),
    deps(
      { head: SHA, remote: SHA, prUrl: undefined, gitCalls: [] },
      { logger: captured.logger },
    ),
    recordingSync(syncCalls),
  );

  assertEquals(syncCalls.length, 0);
  // The "no open PR" exit is an info line, not the unnumberable-URL warning.
  assert(
    captured.entries.some((e) =>
      e.level === "info" && e.message.includes("no open PR")
    ),
    `expected an info log naming "no open PR", got ${
      JSON.stringify(captured.entries)
    }`,
  );
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

/** Fake `git` whose `rev-parse` reports `revParse`; `ls-remote` prints nothing. */
function revParseFake(
  revParse: Result<GitCommandOutput>,
): (args: string[]) => Promise<Result<GitCommandOutput>> {
  return (args) => {
    if (args[0] === "rev-parse") return Promise.resolve(revParse);
    return Promise.resolve({
      ok: true,
      value: { code: 0, stdout: "", stderr: "" },
    });
  };
}

Deno.test("adoptAgentRaisedPrBody - Issue #3804: does not sync when rev-parse HEAD fails and the remote is empty", async () => {
  const syncCalls: SyncPrBodyInput[] = [];
  await adoptAgentRaisedPrBody(
    input(),
    deps(
      { head: SHA, remote: "", prUrl: PR_URL, gitCalls: [] },
      {
        runGitCommand: revParseFake({
          ok: false,
          error: new Error("fatal: not a git repository"),
        }),
      },
    ),
    recordingSync(syncCalls),
  );

  assertEquals(syncCalls.length, 0);
});

Deno.test("adoptAgentRaisedPrBody - Issue #3804: does not sync when rev-parse HEAD exits non-zero and the remote is empty", async () => {
  const syncCalls: SyncPrBodyInput[] = [];
  await adoptAgentRaisedPrBody(
    input(),
    deps(
      { head: SHA, remote: "", prUrl: PR_URL, gitCalls: [] },
      {
        runGitCommand: revParseFake({
          ok: true,
          value: { code: 128, stdout: "", stderr: "fatal" },
        }),
      },
    ),
    recordingSync(syncCalls),
  );

  assertEquals(syncCalls.length, 0);
});

Deno.test("adoptAgentRaisedPrBody - Issue #3804: an unnumberable PR URL is warned about and not synced", async () => {
  const syncCalls: SyncPrBodyInput[] = [];
  const captured = capturingLogger();
  await adoptAgentRaisedPrBody(
    input(),
    deps(
      {
        head: SHA,
        remote: SHA,
        prUrl: "https://github.com/o/r/pull/abc",
        gitCalls: [],
      },
      { logger: captured.logger },
    ),
    recordingSync(syncCalls),
  );

  assertEquals(syncCalls.length, 0);
  assert(
    captured.entries.some((e) =>
      e.level === "warn" && e.message.includes("could not read a PR number")
    ),
    `expected a warn naming the unreadable PR number, got ${
      JSON.stringify(captured.entries)
    }`,
  );
});

Deno.test("adoptAgentRaisedPrBody - Issue #3804: a throwing dependency resolves and is logged as a warning", async () => {
  const syncCalls: SyncPrBodyInput[] = [];
  const captured = capturingLogger();
  // Resolves (does not reject) — the test fails if the error escapes.
  await adoptAgentRaisedPrBody(
    input(),
    deps(
      { head: SHA, remote: SHA, prUrl: PR_URL, gitCalls: [] },
      {
        logger: captured.logger,
        findExistingPrForBranch: () => Promise.reject(new Error("gh exploded")),
      },
    ),
    recordingSync(syncCalls),
  );

  assertEquals(syncCalls.length, 0);
  assert(
    captured.entries.some((e) =>
      e.level === "warn" &&
      e.message.includes("Could not adopt") &&
      JSON.stringify(e.context).includes("gh exploded")
    ),
    `expected a warn carrying the error message, got ${
      JSON.stringify(captured.entries)
    }`,
  );
});

Deno.test("adoptAgentRaisedPrBody - Issue #3804: a blank checkout path makes no git call and no sync", async () => {
  const gitCalls: string[][] = [];
  const syncCalls: SyncPrBodyInput[] = [];
  await adoptAgentRaisedPrBody(
    input({ repoPath: "   " }),
    deps({ head: SHA, remote: SHA, prUrl: PR_URL, gitCalls }),
    recordingSync(syncCalls),
  );

  assertEquals(gitCalls, []);
  assertEquals(syncCalls.length, 0);
});
