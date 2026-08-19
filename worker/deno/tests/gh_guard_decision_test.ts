/**
 * Tests for gh_guard_decision.ts — the shared decision used by the agent-side
 * `gh` guard shim (Issue #3643).
 *
 * The worker's in-process controls (`write_repo_allowlist.ts`,
 * `worker_label_guard.ts`) only mediate `gh` calls made by the worker itself.
 * The agent subprocess runs unrestricted Bash with an inherited `GH_TOKEN`, so
 * its own `gh` writes never reached either control. These tests drive the
 * decision function that the shim re-enters for every agent `gh` invocation.
 *
 * WHAT-tests: each drives `evaluateGhCommand` with a real argument vector and
 * asserts on the verdict, never on how the verdict was reached.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  evaluateGhCommand,
  extractLabelValues,
} from "../lib/gh_guard_decision.ts";
import {
  isWriteRepoAllowlistActive,
  listAllowedWriteRepos,
  resetWriteRepoAllowlist,
  seedWriteRepoAllowlist,
} from "../lib/write_repo_allowlist.ts";
import { processSeedIdleTasksCommand } from "../commands/process_seed_idle_tasks.ts";
import type { Logger, WorkerConfig } from "../types.ts";

/** Silent logger for the sweep-boundary case (Issue #3860). */
function guardTestLogger(): Logger {
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

/** Context with the write-repo allowlist active for a single repo. */
const ACTIVE = {
  active: true,
  allowedRepos: ["stSoftwareAU/VibeCoder"],
} as const;

/** Context matching a run that never seeded the allowlist. */
const INACTIVE = { active: false, allowedRepos: [] } as const;

// ---------------------------------------------------------------------------
// Write-repo allowlist
// ---------------------------------------------------------------------------

Deno.test("gh-guard - refuses an off-allowlist cross-repo comment", () => {
  const decision = evaluateGhCommand(
    ["issue", "comment", "7", "-R", "other-owner/other-repo", "--body", "x"],
    ACTIVE,
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "WRITE_REPO_BLOCKED");
  assert(decision.reason?.includes("other-owner/other-repo"));
});

Deno.test("gh-guard - allows a write to a repo on the allowlist (case-insensitive)", () => {
  const decision = evaluateGhCommand(
    ["issue", "comment", "7", "-R", "stsoftwareau/vibecoder", "--body", "x"],
    ACTIVE,
  );
  assertEquals(decision.allowed, true);
});

Deno.test("gh-guard - allows a cwd-repo write with no explicit repo", () => {
  const decision = evaluateGhCommand(
    ["issue", "comment", "7", "--body", "x"],
    ACTIVE,
  );
  assertEquals(decision.allowed, true);
});

Deno.test("gh-guard - never blocks reads, even cross-repo", () => {
  for (
    const args of [
      ["issue", "view", "7", "-R", "other-owner/other-repo"],
      ["issue", "list", "-R", "other-owner/other-repo", "--label", "work-on"],
      ["api", "repos/other-owner/other-repo/issues"],
    ]
  ) {
    const decision = evaluateGhCommand(args, ACTIVE);
    assertEquals(decision.allowed, true, `expected read allowed: ${args}`);
  }
});

Deno.test("gh-guard - allowlist is inert when the run has not seeded it", () => {
  const decision = evaluateGhCommand(
    ["issue", "comment", "7", "-R", "other-owner/other-repo", "--body", "x"],
    INACTIVE,
  );
  assertEquals(decision.allowed, true);
});

Deno.test("gh-guard - refuses an off-allowlist gh api mutation", () => {
  const decision = evaluateGhCommand(
    ["api", "-X", "POST", "repos/other-owner/other-repo/issues", "-f", "t=x"],
    ACTIVE,
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "WRITE_REPO_BLOCKED");
});

// ---------------------------------------------------------------------------
// Reserved-label guard
// ---------------------------------------------------------------------------

Deno.test("gh-guard - refuses self-applying a reserved workflow label", () => {
  for (
    const args of [
      ["issue", "edit", "7", "--add-label", "top-priority"],
      ["issue", "edit", "7", "--add-label=work-on"],
      ["issue", "create", "--title", "t", "--body", "b", "-l", "best-model"],
      ["issue", "edit", "7", "--add-label", "security,question"],
      ["issue", "edit", "7", "--add-label", "Top-Priority"],
      [
        "api",
        "-X",
        "POST",
        "repos/stSoftwareAU/VibeCoder/issues/7/labels",
        "-f",
        "labels[]=planning",
      ],
    ]
  ) {
    const decision = evaluateGhCommand(args, ACTIVE);
    assertEquals(decision.allowed, false, `expected refusal: ${args}`);
    assertEquals(decision.marker, "WORKER_LABEL_REFUSED");
  }
});

Deno.test("gh-guard - reserved-label guard applies even when the allowlist is inert", () => {
  const decision = evaluateGhCommand(
    ["issue", "edit", "7", "--add-label", "top-priority"],
    INACTIVE,
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "WORKER_LABEL_REFUSED");
});

Deno.test("gh-guard - allows the scan templates' content labels", () => {
  const decision = evaluateGhCommand(
    [
      "issue",
      "create",
      "-R",
      "stSoftwareAU/VibeCoder",
      "--title",
      "finding",
      "--body",
      "b",
      "--label",
      "security,severity:high,confidence:high",
    ],
    ACTIVE,
  );
  assertEquals(decision.allowed, true);
});

Deno.test("gh-guard - allows listing issues by a reserved label (read, not a write)", () => {
  const decision = evaluateGhCommand(
    ["issue", "list", "--label", "top-priority"],
    ACTIVE,
  );
  assertEquals(decision.allowed, true);
});

// ---------------------------------------------------------------------------
// Unrecognised root commands — the config-alias channel (Issue #3866)
// ---------------------------------------------------------------------------

Deno.test("gh-guard - refuses an unrecognised root command (config alias)", () => {
  for (
    const args of [
      ["leak"],
      ["leak", "--body", "secrets"],
      ["co"],
      ["issue-comment", "7"],
    ]
  ) {
    const decision = evaluateGhCommand(args, ACTIVE);
    assertEquals(decision.allowed, false, `expected refusal: ${args}`);
    assertEquals(decision.marker, "GH_UNKNOWN_COMMAND");
    assert(decision.reason?.includes(args[0] ?? ""));
  }
});

Deno.test("gh-guard - refuses an unrecognised root even when the allowlist is inert", () => {
  const decision = evaluateGhCommand(["leak", "--body", "x"], INACTIVE);
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "GH_UNKNOWN_COMMAND");
});

Deno.test("gh-guard - allows every real gh root command it gates", () => {
  for (
    const args of [
      ["issue", "list"],
      ["pr", "view", "7"],
      ["api", "repos/stSoftwareAU/VibeCoder"],
      ["auth", "status"],
      ["label", "list"],
      ["release", "list"],
      ["run", "list"],
      ["search", "issues", "test"],
      ["cache", "list"],
      ["workflow", "list"],
      ["repo", "view"],
      ["status"],
      ["help"],
      ["version"],
      ["extension", "list"],
    ]
  ) {
    const decision = evaluateGhCommand(args, ACTIVE);
    assertEquals(decision.allowed, true, `expected allowed: ${args}`);
  }
});

Deno.test("gh-guard - allows a bare gh with no root command", () => {
  for (const args of [[], ["--version"], ["--help"]]) {
    const decision = evaluateGhCommand(args, ACTIVE);
    assertEquals(decision.allowed, true, `expected allowed: ${args}`);
  }
});

Deno.test("gh-guard - root recognition is exact: a case variant is not a gh command", () => {
  // `gh` matches its own commands case-sensitively, so `ISSUE` is a name a
  // config alias is free to claim — recognising roots case-insensitively
  // would reopen the channel this check closes.
  const decision = evaluateGhCommand(["ISSUE", "list"], ACTIVE);
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "GH_UNKNOWN_COMMAND");
});

// ---------------------------------------------------------------------------
// Label extraction
// ---------------------------------------------------------------------------

Deno.test("gh-guard - extracts label values from every supported flag form", () => {
  assertEquals(
    extractLabelValues([
      "issue",
      "edit",
      "7",
      "--add-label",
      "a,b",
      "--label=c",
      "-l",
      "d",
      "-f",
      "labels[]=e",
      "--field=labels=f",
      "--body",
      "not-a-label",
    ]),
    ["a", "b", "c", "d", "e", "f"],
  );
});

Deno.test("gh-guard - extracts nothing when no label flag is present", () => {
  assertEquals(
    extractLabelValues(["issue", "comment", "7", "--body", "hello"]),
    [],
  );
});

// ---------------------------------------------------------------------------
// Agent boundary during a worker-side seeding sweep (Issue #3860)
//
// The worker-side sweep grants *itself* write access to another monitored
// repo. The agent subprocess must gain nothing: its allowlist is baked from
// the run's own `ctx.repo` at spawn time, and the sweep's grant is released
// before any agent could be spawned. These are the tripwires for the
// dangerous failure direction — the fix eroding the #3311 / #3643 boundary.
// ---------------------------------------------------------------------------

Deno.test("gh-guard - agent allowlist stays ctx.repo-only when a sweep is requested", async () => {
  try {
    // The standard pipeline seeds the claimed issue's own repo (issue_worker).
    seedWriteRepoAllowlist("stSoftwareAU/VibeCoder");
    const bakedAtSpawn = listAllowedWriteRepos();
    assertEquals(bakedAtSpawn, ["stsoftwareau/vibecoder"]);

    // The agent asks for the very sweep #3858 requested. It is still refused.
    const decision = evaluateGhCommand(
      [
        "issue",
        "create",
        "--repo",
        "stSoftwareAU/private-repo-14",
        "--title",
        "Idle task: security scan",
        "--body",
        "x",
      ],
      { active: isWriteRepoAllowlistActive(), allowedRepos: bakedAtSpawn },
    );
    assertEquals(decision.allowed, false);
    assertEquals(decision.marker, "WRITE_REPO_BLOCKED");
    assert(decision.reason?.includes("stSoftwareAU/private-repo-14"));

    // Running the worker-side sweep does not widen what a later spawn bakes.
    const result = await processSeedIdleTasksCommand.execute(
      {
        "repo": "stSoftwareAU/VibeCoder",
        "issue-number": 3858,
        "title": "seed-idle-tasks: stSoftwareAU/private-repo-14",
        "__testDeps": {
          runGhCommand: () => Promise.resolve(""),
          logger: guardTestLogger(),
          createWrappersFn: () =>
            Promise.resolve({
              ok: true,
              value: { created: ["security-scan"], skipped: [] },
            }),
        },
      },
      {
        repos: ["stSoftwareAU/VibeCoder", "stSoftwareAU/private-repo-14"],
      } as unknown as WorkerConfig,
    );
    assertEquals(result.success, true);
    assertEquals(
      isWriteRepoAllowlistActive(),
      false,
      "the sweep's cross-repo grant must not survive into a later spawn",
    );
    assertEquals(listAllowedWriteRepos(), []);
  } finally {
    resetWriteRepoAllowlist();
  }
});

// ---------------------------------------------------------------------------
// Unrecognised root commands — the config-alias channel (Issue #3866)
// ---------------------------------------------------------------------------

Deno.test("gh-guard - refuses a root command it does not recognise", () => {
  const decision = evaluateGhCommand(["leak-it", "1", "--body", "x"], ACTIVE);
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "GH_UNKNOWN_COMMAND");
  assert(decision.reason?.includes("leak-it"));
});

Deno.test("gh-guard - refuses an unrecognised root even with the allowlist inert", () => {
  const decision = evaluateGhCommand(["leak-it"], INACTIVE);
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "GH_UNKNOWN_COMMAND");
});

Deno.test("gh-guard - still allows every genuine gh root command", () => {
  for (
    const args of [
      ["issue", "view", "7"],
      ["pr", "list"],
      ["api", "repos/stSoftwareAU/VibeCoder/issues"],
      ["label", "list"],
      ["auth", "status"],
      ["search", "issues", "test"],
      ["repo", "view"],
      ["run", "list"],
      ["workflow", "list"],
      ["release", "list"],
      ["cache", "list"],
      ["ruleset", "list"],
      ["secret", "list"],
      ["variable", "list"],
      ["config", "get", "editor"],
      ["status"],
      ["help"],
      ["version"],
      // gh's own built-in command aliases.
      ["cs", "list"],
      ["ext", "list"],
      ["at", "verify", "artefact.tgz"],
    ]
  ) {
    const decision = evaluateGhCommand(args, ACTIVE);
    assertEquals(decision.allowed, true, `expected allowed: ${args}`);
  }
});

Deno.test("gh-guard - allows an invocation that names no command at all", () => {
  assertEquals(evaluateGhCommand([], ACTIVE).allowed, true);
  assertEquals(evaluateGhCommand(["--version"], ACTIVE).allowed, true);
});
