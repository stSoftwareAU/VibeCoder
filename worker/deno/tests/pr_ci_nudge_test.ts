/**
 * Tests for pr_ci_nudge.ts — nudge CI to run on a PR (Issue #2099).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertRejects } from "@std/assert";
import { nudgeCi } from "../lib/pr_ci_nudge.ts";

const REPO = "owner/repo";
const PR_NUMBER = 42;
const HEAD_BRANCH = "feature/foo";
const HEAD_SHA = "abcdef1234567890";

/** Capture every command invocation. */
interface Call {
  cmd: "gh" | "git";
  args: string[];
}

function recorder(): {
  calls: Call[];
  gh: (args: string[]) => Promise<string>;
  git: (args: string[]) => Promise<string>;
} {
  const calls: Call[] = [];
  return {
    calls,
    gh: (args: string[]) => {
      calls.push({ cmd: "gh", args });
      // Stub the workflow_run lookup for the 'queued' path.
      if (args[0] === "api" && args[1]?.includes("actions/runs")) {
        return Promise.resolve(JSON.stringify({
          total_count: 1,
          workflow_runs: [
            {
              id: 7777,
              status: "queued",
              head_sha: HEAD_SHA,
              created_at: "2026-05-18T00:00:00Z",
            },
          ],
        }));
      }
      return Promise.resolve("");
    },
    git: (args: string[]) => {
      calls.push({ cmd: "git", args });
      return Promise.resolve("");
    },
  };
}

Deno.test("pr_ci_nudge - 'queued' path runs gh run rerun exactly once", async () => {
  const r = recorder();
  const result = await nudgeCi({
    repo: REPO,
    prNumber: PR_NUMBER,
    headBranch: HEAD_BRANCH,
    headSha: HEAD_SHA,
    status: "queued",
    ghCommandFn: r.gh,
    gitCommandFn: r.git,
  });
  if (!result.ok) throw new Error(`expected ok: ${result.error.message}`);
  assertEquals(result.value.action, "rerun");

  const rerunCalls = r.calls.filter((c) =>
    c.cmd === "gh" && c.args[0] === "run" && c.args[1] === "rerun"
  );
  assertEquals(rerunCalls.length, 1);
  const rerun = rerunCalls[0];
  if (rerun === undefined) throw new Error("expected rerun call");
  assertEquals(rerun.args.includes("7777"), true);
  assertEquals(rerun.args.includes("--repo"), true);
  assertEquals(rerun.args.includes(REPO), true);

  // No git activity for the queued path.
  assertEquals(r.calls.some((c) => c.cmd === "git"), false);
});

Deno.test("pr_ci_nudge - 'none' path creates exactly one empty commit and pushes", async () => {
  const r = recorder();
  const result = await nudgeCi({
    repo: REPO,
    prNumber: PR_NUMBER,
    headBranch: HEAD_BRANCH,
    headSha: HEAD_SHA,
    status: "none",
    ghCommandFn: r.gh,
    gitCommandFn: r.git,
  });
  if (!result.ok) throw new Error(`expected ok: ${result.error.message}`);
  assertEquals(result.value.action, "empty-commit");

  const commitCalls = r.calls.filter(
    (c) =>
      c.cmd === "git" && c.args[0] === "commit" &&
      c.args.includes("--allow-empty"),
  );
  assertEquals(commitCalls.length, 1);

  const pushCalls = r.calls.filter((c) =>
    c.cmd === "git" && c.args[0] === "push"
  );
  assertEquals(pushCalls.length, 1);

  // Commit message must identify the Vibe Coder as the nudge source.
  const commit = commitCalls[0];
  if (commit === undefined) throw new Error("expected commit call");
  const msgIdx = commit.args.indexOf("-m");
  const msg = commit.args[msgIdx + 1] ?? "";
  assertEquals(msg.toLowerCase().includes("nudge ci"), true);
  assertEquals(msg.toLowerCase().includes("vibe coder"), true);

  // The nudge does NOT call gh run rerun on the 'none' path.
  assertEquals(
    r.calls.some((c) =>
      c.cmd === "gh" && c.args[0] === "run" && c.args[1] === "rerun"
    ),
    false,
  );
});

Deno.test("pr_ci_nudge - 'started' input returns noop without invoking gh or git", async () => {
  const r = recorder();
  const result = await nudgeCi({
    repo: REPO,
    prNumber: PR_NUMBER,
    headBranch: HEAD_BRANCH,
    headSha: HEAD_SHA,
    status: "started",
    ghCommandFn: r.gh,
    gitCommandFn: r.git,
  });
  if (!result.ok) throw new Error(`expected ok: ${result.error.message}`);
  assertEquals(result.value.action, "noop");
  assertEquals(r.calls.length, 0);
});

Deno.test("pr_ci_nudge - 'queued' returns failure when no workflow_run is found", async () => {
  const calls: Call[] = [];
  const gh = (args: string[]) => {
    calls.push({ cmd: "gh", args });
    if (args[0] === "api" && args[1]?.includes("actions/runs")) {
      return Promise.resolve(
        JSON.stringify({ total_count: 0, workflow_runs: [] }),
      );
    }
    return Promise.resolve("");
  };
  const git = (args: string[]) => {
    calls.push({ cmd: "git", args });
    return Promise.resolve("");
  };

  const result = await nudgeCi({
    repo: REPO,
    prNumber: PR_NUMBER,
    headBranch: HEAD_BRANCH,
    headSha: HEAD_SHA,
    status: "queued",
    ghCommandFn: gh,
    gitCommandFn: git,
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.error.message.toLowerCase().includes("no queued"),
      true,
    );
  }
});

Deno.test("pr_ci_nudge - 'queued' propagates errors from gh run rerun", async () => {
  const gh = (args: string[]) => {
    if (args[0] === "api" && args[1]?.includes("actions/runs")) {
      return Promise.resolve(JSON.stringify({
        total_count: 1,
        workflow_runs: [{ id: 1, status: "queued", head_sha: HEAD_SHA }],
      }));
    }
    if (args[0] === "run" && args[1] === "rerun") {
      return Promise.reject(new Error("rerun failed: HTTP 403"));
    }
    return Promise.resolve("");
  };
  const git = (_args: string[]) => Promise.resolve("");

  const result = await nudgeCi({
    repo: REPO,
    prNumber: PR_NUMBER,
    headBranch: HEAD_BRANCH,
    headSha: HEAD_SHA,
    status: "queued",
    ghCommandFn: gh,
    gitCommandFn: git,
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.includes("403"), true);
  }
});

Deno.test("pr_ci_nudge - 'none' returns failure when git push errors", async () => {
  const gh = (_args: string[]) => Promise.resolve("");
  const git = (args: string[]) => {
    if (args[0] === "push") {
      return Promise.reject(new Error("push rejected: non-fast-forward"));
    }
    return Promise.resolve("");
  };

  const result = await nudgeCi({
    repo: REPO,
    prNumber: PR_NUMBER,
    headBranch: HEAD_BRANCH,
    headSha: HEAD_SHA,
    status: "none",
    ghCommandFn: gh,
    gitCommandFn: git,
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.toLowerCase().includes("push"), true);
  }
});

// Issue #2568: the `default` branch now routes through the `assertNever`
// exhaustiveness guard. A value that bypasses the type system (e.g. an
// `as any` cast or JSON deserialised from an untrusted source) is treated as
// a programming error and throws, rather than returning a graceful
// `ok: false` Result. This replaces the previous "returns ok: false"
// expectation — the compile-time guarantee is the point of the change.
Deno.test("pr_ci_nudge - throws on unknown status values (assertNever guard)", async () => {
  const r = recorder();
  await assertRejects(
    () =>
      nudgeCi({
        repo: REPO,
        prNumber: PR_NUMBER,
        headBranch: HEAD_BRANCH,
        headSha: HEAD_SHA,
        // deno-lint-ignore no-explicit-any
        status: "bogus" as any,
        ghCommandFn: r.gh,
        gitCommandFn: r.git,
      }),
    Error,
    "Unreachable",
  );
});

Deno.test("pr_ci_nudge - 'none' path checks out the head branch before committing", async () => {
  const r = recorder();
  const result = await nudgeCi({
    repo: REPO,
    prNumber: PR_NUMBER,
    headBranch: HEAD_BRANCH,
    headSha: HEAD_SHA,
    status: "none",
    ghCommandFn: r.gh,
    gitCommandFn: r.git,
  });
  if (!result.ok) throw new Error(`expected ok: ${result.error.message}`);

  const gitCalls = r.calls.filter((c) => c.cmd === "git");
  const checkoutIdx = gitCalls.findIndex(
    (c) => c.args[0] === "checkout" && c.args.includes(HEAD_BRANCH),
  );
  const commitIdx = gitCalls.findIndex(
    (c) => c.args[0] === "commit" && c.args.includes("--allow-empty"),
  );
  const pushIdx = gitCalls.findIndex((c) => c.args[0] === "push");

  // checkout must happen before commit, and commit before push.
  assertEquals(checkoutIdx >= 0 && checkoutIdx < commitIdx, true);
  assertEquals(commitIdx < pushIdx, true);
});
