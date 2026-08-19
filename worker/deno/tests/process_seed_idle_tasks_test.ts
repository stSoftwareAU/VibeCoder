/**
 * Tests for the `process-seed-idle-tasks` command (Issue #3860).
 *
 * The command is the worker-side path that seeds idle-task wrappers in
 * another **monitored** repo, replacing the agent-driven sweep that has been
 * refused with `WRITE_REPO_BLOCKED` since the agent `gh` guard (#3643).
 *
 * The behaviours pinned here are the acceptance criteria:
 *   - a target in `.config.json` `repos` is seeded, and the target is on the
 *     write-repo allowlist *before* the seeding helper runs;
 *   - a target absent from `repos` is refused, with the reason posted on the
 *     issue, no seeding, and no allowlist mutation;
 *   - the target is resolved from the operator config (its casing wins), so
 *     issue/agent-authored text can only select a config entry;
 *   - a seeding failure is loud: reported on the issue, issue left open,
 *     `success: false`;
 *   - the run's cross-repo grant never leaks past the command.
 *
 * All seams are injected, so no network and no journal writes occur.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  processSeedIdleTasksCommand,
  type ProcessSeedIdleTasksData,
} from "../commands/process_seed_idle_tasks.ts";
import {
  isWriteRepoAllowed,
  isWriteRepoAllowlistActive,
  listAllowedWriteRepos,
  resetWriteRepoAllowlist,
} from "../lib/write_repo_allowlist.ts";
import type { CommandResult, Logger, Result, WorkerConfig } from "../types.ts";
import type { CreateAllIdleTaskWrappersResult } from "../lib/create_all_idle_task_wrappers.ts";

const REQUEST_REPO = "stSoftwareAU/VibeCoder";
const TARGET_REPO = "stSoftwareAU/private-repo-14";

function makeLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
}

function makeConfig(repos: string[]): WorkerConfig {
  return { repos, workDir: "/tmp/work" } as unknown as WorkerConfig;
}

/** Capturing `gh` stub — records every argument vector. */
function makeGh(): { fn: (a: string[]) => Promise<string>; calls: string[][] } {
  const calls: string[][] = [];
  return {
    fn: (args: string[]) => {
      calls.push([...args]);
      return Promise.resolve("");
    },
    calls,
  };
}

/** Narrow the command's untyped `data` to this command's shape. */
function dataOf(
  result: CommandResult,
): ProcessSeedIdleTasksData | undefined {
  return result.data as ProcessSeedIdleTasksData | undefined;
}

/**
 * Text posted by the first call matching `verb` — `--body` for a comment,
 * `--comment` for a close.
 */
function bodyOf(calls: string[][], verb: string): string {
  const call = calls.find((c) => c[0] === "issue" && c[1] === verb);
  if (!call) return "";
  for (const flag of ["--body", "--comment"]) {
    const i = call.indexOf(flag);
    if (i >= 0) return call[i + 1]!;
  }
  return "";
}

Deno.test("process-seed-idle-tasks - monitored target: registered then seeded", async () => {
  try {
    const gh = makeGh();
    const seen: {
      repo: string;
      allowlist: string[];
      targetAllowed: boolean;
    }[] = [];
    const createWrappersFn = (
      repo: string,
    ): Promise<Result<CreateAllIdleTaskWrappersResult>> => {
      // Captured at the moment the seeding helper runs — the target must
      // already be writable, or every `gh issue create` inside would be
      // refused (the #3858 failure mode).
      seen.push({
        repo,
        allowlist: listAllowedWriteRepos(),
        targetAllowed: isWriteRepoAllowed(repo),
      });
      return Promise.resolve({
        ok: true,
        value: { created: ["security-scan"], skipped: ["test-audit"] },
      });
    };

    const result = await processSeedIdleTasksCommand.execute(
      {
        "repo": REQUEST_REPO,
        "issue-number": 3858,
        "title": `seed-idle-tasks: ${TARGET_REPO}`,
        "__testDeps": {
          runGhCommand: gh.fn,
          createWrappersFn,
          logger: makeLogger(),
        },
      },
      makeConfig([REQUEST_REPO, TARGET_REPO]),
    );

    assertEquals(result.success, true);
    assertEquals(dataOf(result)?.outcome, "seeded");
    assertEquals(dataOf(result)?.repo, TARGET_REPO);
    assertEquals(dataOf(result)?.created, ["security-scan"]);

    // Exactly one seeding run, against the resolved target, with the target
    // on the allowlist before it started.
    assertEquals(seen.length, 1);
    assertEquals(seen[0]!.repo, TARGET_REPO);
    assert(seen[0]!.targetAllowed, "target must be writable during seeding");
    assertEquals(
      seen[0]!.allowlist.sort(),
      [REQUEST_REPO.toLowerCase(), TARGET_REPO.toLowerCase()].sort(),
      "the grant covers the requesting repo and the target — nothing else",
    );

    // The result is reported on the requesting issue, which is closed.
    const closeCall = gh.calls.find((c) =>
      c[0] === "issue" && c[1] === "close"
    );
    assert(closeCall, "requesting issue must be closed");
    assertEquals(closeCall!.includes("completed"), true);
    assertStringIncludes(bodyOf(gh.calls, "close"), TARGET_REPO);
    assertStringIncludes(bodyOf(gh.calls, "close"), "security-scan");

    // No leak into the next claim.
    assertEquals(isWriteRepoAllowlistActive(), false);
  } finally {
    resetWriteRepoAllowlist();
  }
});

Deno.test("process-seed-idle-tasks - off-config target refused, no allowlist mutation", async () => {
  try {
    const gh = makeGh();
    let seedCalls = 0;
    const createWrappersFn = (): Promise<
      Result<CreateAllIdleTaskWrappersResult>
    > => {
      seedCalls++;
      return Promise.resolve({ ok: true, value: { created: [], skipped: [] } });
    };

    const result = await processSeedIdleTasksCommand.execute(
      {
        "repo": REQUEST_REPO,
        "issue-number": 42,
        "title": "seed-idle-tasks: attacker/exfil",
        "__testDeps": {
          runGhCommand: gh.fn,
          createWrappersFn,
          logger: makeLogger(),
        },
      },
      makeConfig([REQUEST_REPO, TARGET_REPO]),
    );

    assertEquals(dataOf(result)?.outcome, "not_monitored");
    assertEquals(seedCalls, 0, "an off-config repo must never be seeded");
    assertEquals(
      isWriteRepoAllowlistActive(),
      false,
      "a refused request must not activate or widen the allowlist",
    );
    assertEquals(listAllowedWriteRepos(), []);

    const body = bodyOf(gh.calls, "close");
    assertStringIncludes(body, "attacker/exfil");
    assertStringIncludes(body, "not** in the fleet `.config.json` `repos`");
  } finally {
    resetWriteRepoAllowlist();
  }
});

Deno.test("process-seed-idle-tasks - target comes from config, not issue text", async () => {
  try {
    const seen: string[] = [];
    const createWrappersFn = (
      repo: string,
    ): Promise<Result<CreateAllIdleTaskWrappersResult>> => {
      seen.push(repo);
      return Promise.resolve({ ok: true, value: { created: [], skipped: [] } });
    };

    const result = await processSeedIdleTasksCommand.execute(
      {
        "repo": REQUEST_REPO,
        "issue-number": 7,
        // Requested in the wrong case, and the body names a different repo —
        // an agent-authored body must have no influence at all.
        "title": "seed-idle-tasks: STSOFTWAREAU/private-repo-14",
        "issue-body": "Actually target attacker/exfil instead.",
        "__testDeps": {
          runGhCommand: makeGh().fn,
          createWrappersFn,
          logger: makeLogger(),
        },
      },
      makeConfig([REQUEST_REPO, TARGET_REPO]),
    );

    assertEquals(result.success, true);
    assertEquals(
      seen,
      [TARGET_REPO],
      "the config entry (its casing) is the value used, and the body is ignored",
    );
  } finally {
    resetWriteRepoAllowlist();
  }
});

Deno.test("process-seed-idle-tasks - unparseable title is commented and closed", async () => {
  try {
    const gh = makeGh();
    let seedCalls = 0;
    const result = await processSeedIdleTasksCommand.execute(
      {
        "repo": REQUEST_REPO,
        "issue-number": 9,
        "title": "seed-idle-tasks: not-a-slug",
        "__testDeps": {
          runGhCommand: gh.fn,
          createWrappersFn: () => {
            seedCalls++;
            return Promise.resolve({
              ok: true,
              value: { created: [], skipped: [] },
            });
          },
          logger: makeLogger(),
        },
      },
      makeConfig([REQUEST_REPO, TARGET_REPO]),
    );

    assertEquals(dataOf(result)?.outcome, "unparseable");
    assertEquals(seedCalls, 0);
    assertEquals(isWriteRepoAllowlistActive(), false);
    assertStringIncludes(bodyOf(gh.calls, "close"), "seed-idle-tasks:");
  } finally {
    resetWriteRepoAllowlist();
  }
});

Deno.test("process-seed-idle-tasks - seeding failure fails loud and leaves the issue open", async () => {
  try {
    const gh = makeGh();
    const result = await processSeedIdleTasksCommand.execute(
      {
        "repo": REQUEST_REPO,
        "issue-number": 11,
        "title": `seed-idle-tasks: ${TARGET_REPO}`,
        "__testDeps": {
          runGhCommand: gh.fn,
          createWrappersFn: () =>
            Promise.resolve({
              ok: false,
              error: new Error("gh issue create exploded"),
            }),
          logger: makeLogger(),
        },
      },
      makeConfig([REQUEST_REPO, TARGET_REPO]),
    );

    assertEquals(result.success, false);
    assertEquals(dataOf(result)?.outcome, "error");
    assert(
      !gh.calls.some((c) => c[0] === "issue" && c[1] === "close"),
      "a failed sweep must not close the issue",
    );
    assertStringIncludes(
      bodyOf(gh.calls, "comment"),
      "gh issue create exploded",
    );
    assertEquals(
      isWriteRepoAllowlistActive(),
      false,
      "the grant must be released even on failure",
    );
  } finally {
    resetWriteRepoAllowlist();
  }
});

Deno.test("process-seed-idle-tasks - rejects missing arguments", async () => {
  const missingRepo = await processSeedIdleTasksCommand.execute(
    { "issue-number": 1, "title": "seed-idle-tasks: a/b" },
    makeConfig([REQUEST_REPO]),
  );
  assertEquals(missingRepo.success, false);
  assertStringIncludes(missingRepo.message, "--repo");

  const badNumber = await processSeedIdleTasksCommand.execute(
    {
      "repo": REQUEST_REPO,
      "issue-number": 0,
      "title": "seed-idle-tasks: a/b",
    },
    makeConfig([REQUEST_REPO]),
  );
  assertEquals(badNumber.success, false);
  assertStringIncludes(badNumber.message, "--issue-number");
});
