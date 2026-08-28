/**
 * Tests for the fail-closed merge gates (Issue #3705).
 *
 * Two gates that previously failed open:
 *   1. zero check runs + zero commit statuses counted as "passed";
 *   2. `merge-if-checks-passed` accepted any `--repo` from any PR author.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type CiStatusResult,
  directMergePr,
  enforcePreMergeRequirements,
  type PreMergeGateFn,
} from "../lib/direct_merge.ts";
import type { Result } from "../types.ts";
import type { PRBranchStateBatchResult } from "../lib/pr_branch_state.ts";
import {
  authoriseDirectMerge,
  blockedReason,
  runMergeIfChecksPassed,
} from "../commands/merge_if_checks_passed.ts";
import { classifyMergeAttempt } from "../lib/merge_block_escalation.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Worker config with an explicit monitored-repo allowlist. */
function configWith(
  overrides: Partial<WorkerConfig> = {},
): WorkerConfig {
  return { ...buildDefaultWorkerConfig(), ...overrides };
}

/** CI status stub returning a fixed status. */
function ciStub(status: CiStatusResult["status"]) {
  return (): Promise<Result<CiStatusResult>> =>
    Promise.resolve({ ok: true, value: { status } });
}

/** Branch-state batch stub returning a fixed behindBy for the PR. */
function branchStub(behindBy: number) {
  return (
    _repo: string,
    prs: { number: number }[],
  ): Promise<PRBranchStateBatchResult> => {
    const states = new Map(
      prs.map((
        p,
      ) => [p.number, { aheadBy: 0, behindBy, mergeable: "MERGEABLE" }]),
    );
    return Promise.resolve({ ok: true, states, callCount: 1 });
  };
}

/** Head commit SHA a passing gate reports (Issue #3946). */
const HEAD_SHA = "2222222222222222222222222222222222222222";

const baseRefMock = (args: string[]): Promise<string> => {
  const key = args.join(" ");
  // Issue #4396: the milestone-base route gate reads rollup PRs and the
  // milestone state — answer "route open" (checked before the baseRefName
  // branch: the rollup query's --json list names that field too).
  if (key.includes("pr list") && key.includes("--head")) {
    return Promise.resolve("[]");
  }
  if (key.includes("/milestones?state=all")) {
    return Promise.resolve(
      JSON.stringify([{ number: 1, title: "x", state: "open" }]),
    );
  }
  // Issue #470: the gate reads both refs in one
  // `pr view --json baseRefName,headRefName` so the ahead/behind comparison
  // can be oriented base-to-head. The blast-radius guard still reads the base
  // alone with `--jq`, so answer that form with a bare branch name.
  if (key.includes("baseRefName")) {
    return Promise.resolve(
      key.includes("--jq") ? "milestone/x" : JSON.stringify({
        baseRefName: "milestone/x",
        headRefName: "issue-1-feature",
      }),
    );
  }
  return Promise.reject(new Error(`Unexpected: ${key}`));
};

/** gh runner answering the default-branch guard plus the merge call. */
function guardMock(onMerge: () => void) {
  return (args: string[]): Promise<string> => {
    const joined = args.join(" ");
    if (joined.includes("pr view") && joined.includes("baseRefName")) {
      return Promise.resolve("milestone/x");
    }
    if (joined.includes("default_branch")) return Promise.resolve("main");
    if (joined.includes("pr merge")) {
      onMerge();
      return Promise.resolve("Merged");
    }
    return Promise.reject(new Error(`Unexpected: ${joined}`));
  };
}

// ---------------------------------------------------------------------------
// SEC-2c6f8b410ad7 — zero checks must not count as "passed"
// ---------------------------------------------------------------------------

Deno.test("merge gate - blocks with no_checks when the head commit has no checks", async () => {
  const result = await enforcePreMergeRequirements(
    "owner/repo",
    42,
    baseRefMock,
    {},
    ciStub("no_checks"),
    branchStub(0),
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.allowed, false);
    assertEquals(result.value.reason, "no_checks");
  }
});

Deno.test("merge gate - allows no_checks only under the explicit operator override", async () => {
  const result = await enforcePreMergeRequirements(
    "owner/repo",
    42,
    baseRefMock,
    { allowNoChecks: true },
    ciStub("no_checks"),
    branchStub(0),
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.allowed, true);
  }
});

Deno.test("merge gate - override does not skip the branch-freshness requirement", async () => {
  const result = await enforcePreMergeRequirements(
    "owner/repo",
    42,
    baseRefMock,
    { allowNoChecks: true },
    ciStub("no_checks"),
    branchStub(4),
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.allowed, false);
    assertEquals(result.value.reason, "behind_target");
  }
});

Deno.test("direct_merge - directMergePr does not merge an unverified PR", async () => {
  let merged = false;
  const gate: PreMergeGateFn = (_repo, _pr, _gh, options) =>
    Promise.resolve(
      options?.allowNoChecks
        // Issue #3946: an allowed outcome names the SHA its checks were read
        // for, so directMergePr can pin the merge to it.
        ? { ok: true, value: { allowed: true, headSha: HEAD_SHA } }
        : { ok: true, value: { allowed: false, reason: "no_checks" } },
    );

  const result = await directMergePr(
    "owner/repo",
    42,
    guardMock(() => {
      merged = true;
    }),
    gate,
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.merged, false);
    assertEquals(result.value.blocked, "no_checks");
  }
  assertEquals(merged, false);
});

Deno.test("direct_merge - directMergePr merges an unverified PR when allowNoChecks is set", async () => {
  let merged = false;
  const gate: PreMergeGateFn = (_repo, _pr, _gh, options) =>
    Promise.resolve(
      options?.allowNoChecks
        // Issue #3946: an allowed outcome names the SHA its checks were read
        // for, so directMergePr can pin the merge to it.
        ? { ok: true, value: { allowed: true, headSha: HEAD_SHA } }
        : { ok: true, value: { allowed: false, reason: "no_checks" } },
    );

  const result = await directMergePr(
    "owner/repo",
    42,
    guardMock(() => {
      merged = true;
    }),
    gate,
    { allowNoChecks: true },
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.merged, true);
  }
  assertEquals(merged, true);
});

Deno.test("merge gate - no_checks escalates to a human rather than waiting", () => {
  assertEquals(classifyMergeAttempt({ kind: "no_checks" }), "escalate");
});

Deno.test("blockedReason - maps no_checks to its stable string", () => {
  assertEquals(blockedReason("no_checks"), "no_checks");
});

// ---------------------------------------------------------------------------
// SEC-85f2a071cde3 — allowlist and author gating on merge-if-checks-passed
// ---------------------------------------------------------------------------

/** gh runner answering the identity + PR-author lookups. */
function authMock(workerLogin: string, prAuthor: string) {
  return (args: string[]): Promise<string> => {
    const joined = args.join(" ");
    if (joined.includes("api user")) return Promise.resolve(`${workerLogin}\n`);
    if (joined.includes("author")) return Promise.resolve(`${prAuthor}\n`);
    return Promise.reject(new Error(`Unexpected: ${joined}`));
  };
}

Deno.test("authoriseDirectMerge - refuses a repo outside the monitored allowlist", async () => {
  let ghCalled = false;
  const result = await authoriseDirectMerge(
    "attacker/private",
    42,
    configWith({ repos: ["org/monitored"] }),
    (args) => {
      ghCalled = true;
      return Promise.reject(new Error(`Unexpected: ${args.join(" ")}`));
    },
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "monitored-repo allowlist");
  }
  // The allowlist short-circuits before any GitHub call is made.
  assertEquals(ghCalled, false);
});

Deno.test("authoriseDirectMerge - refuses a PR authored by someone else", async () => {
  const result = await authoriseDirectMerge(
    "org/monitored",
    42,
    configWith({ repos: ["org/monitored"] }),
    authMock("vibe-worker", "outsider"),
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "not authored by this worker");
  }
});

Deno.test("authoriseDirectMerge - allows a worker-authored PR in a monitored repo", async () => {
  const result = await authoriseDirectMerge(
    "org/monitored",
    42,
    configWith({ repos: ["org/monitored"] }),
    authMock("vibe-worker", "vibe-worker"),
  );
  assertEquals(result.ok, true);
});

Deno.test("authoriseDirectMerge - allows a configured sibling fleet author", async () => {
  const result = await authoriseDirectMerge(
    "org/monitored",
    42,
    configWith({
      repos: ["org/monitored"],
      fleetPrAuthors: ["vibe-worker-2"],
    }),
    authMock("vibe-worker", "vibe-worker-2"),
  );
  assertEquals(result.ok, true);
});

Deno.test("authoriseDirectMerge - fails closed when the author lookup errors", async () => {
  const result = await authoriseDirectMerge(
    "org/monitored",
    42,
    configWith({ repos: ["org/monitored"] }),
    (args) =>
      args.join(" ").includes("api user")
        ? Promise.resolve("vibe-worker")
        : Promise.reject(new Error("network error")),
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "could not confirm its author");
  }
});

Deno.test("authoriseDirectMerge - fails closed when the worker login cannot be resolved", async () => {
  const result = await authoriseDirectMerge(
    "org/monitored",
    42,
    configWith({ repos: ["org/monitored"] }),
    () => Promise.reject(new Error("gh auth expired")),
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "GitHub login");
  }
});

Deno.test("merge-if-checks-passed - never merges a PR in an unmonitored repo", async () => {
  let mergeCalled = false;
  const result = await runMergeIfChecksPassed(
    { repo: "attacker/private", pr: 42 },
    configWith({ repos: ["org/monitored"] }),
    {
      ghCommandFn: () => Promise.reject(new Error("no gh call expected")),
      directMergeFn: () => {
        mergeCalled = true;
        return Promise.resolve({ ok: true, value: { merged: true } });
      },
    },
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "monitored-repo allowlist");
  assertEquals(mergeCalled, false);
});

Deno.test("merge-if-checks-passed - never merges a PR authored by someone else", async () => {
  let mergeCalled = false;
  const result = await runMergeIfChecksPassed(
    { repo: "org/monitored", pr: 42 },
    configWith({ repos: ["org/monitored"] }),
    {
      ghCommandFn: authMock("vibe-worker", "outsider"),
      directMergeFn: () => {
        mergeCalled = true;
        return Promise.resolve({ ok: true, value: { merged: true } });
      },
    },
  );
  assertEquals(result.success, false);
  assertEquals(mergeCalled, false);
});

Deno.test("merge-if-checks-passed - merges an authorised PR", async () => {
  const result = await runMergeIfChecksPassed(
    { repo: "org/monitored", pr: 42 },
    configWith({ repos: ["org/monitored"] }),
    {
      ghCommandFn: authMock("vibe-worker", "vibe-worker"),
      directMergeFn: () =>
        Promise.resolve({ ok: true, value: { merged: true } }),
    },
  );
  assertEquals(result.success, true);
  assertEquals(result.data?.merged, true);
});

Deno.test("merge-if-checks-passed - reports the no_checks deferral reason", async () => {
  const result = await runMergeIfChecksPassed(
    { repo: "org/monitored", pr: 42 },
    configWith({ repos: ["org/monitored"] }),
    {
      ghCommandFn: authMock("vibe-worker", "vibe-worker"),
      directMergeFn: () =>
        Promise.resolve({
          ok: true,
          value: { merged: false, blocked: "no_checks" },
        }),
    },
  );
  assertEquals(result.success, true);
  assertEquals(result.data?.reason, "no_checks");
});

Deno.test("merge-if-checks-passed - passes the --allow-no-checks override through to the merge", async () => {
  let seen: boolean | undefined;
  await runMergeIfChecksPassed(
    { repo: "org/monitored", pr: 42, "allow-no-checks": true },
    configWith({ repos: ["org/monitored"] }),
    {
      ghCommandFn: authMock("vibe-worker", "vibe-worker"),
      directMergeFn: (_repo, _pr, _gh, _gate, options) => {
        seen = options?.allowNoChecks;
        return Promise.resolve({ ok: true, value: { merged: true } });
      },
    },
  );
  assertEquals(seen, true);
});

Deno.test("merge-if-checks-passed - defaults the override to off", async () => {
  let seen: boolean | undefined;
  await runMergeIfChecksPassed(
    { repo: "org/monitored", pr: 42 },
    configWith({ repos: ["org/monitored"] }),
    {
      ghCommandFn: authMock("vibe-worker", "vibe-worker"),
      directMergeFn: (_repo, _pr, _gh, _gate, options) => {
        seen = options?.allowNoChecks;
        return Promise.resolve({ ok: true, value: { merged: true } });
      },
    },
  );
  assertEquals(seen, false);
});
