/**
 * The babysitter's base-merge policy for repairs (Issue #4943): a repair
 * merges the PR's base only for a genuine conflict (GitHub reports
 * `CONFLICTING`). A behind-only PR is refreshed by the shared base-refresh
 * owner (Issue #4613), so a failed-CI or review repair must not merge it here.
 *
 * The harness copies the minimal in-memory GitHub, git and agent boundaries
 * from babysitter_fix_orchestration_test.ts, which does not export its own.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  BABYSITTER_RESPONSE_FILE,
  type BaseSync,
  fix,
  type FixDeps,
} from "../commands/fleet_pr_babysitter.ts";
import { BabysitterFailure } from "../lib/babysitter_retry_state.ts";
import { BABYSITTER_TASK_FAILURE_EXIT_CODE } from "../lib/fleet_babysitter_container.ts";

const HEAD = "a".repeat(40);
const PUSHED = "b".repeat(40);
const REPO = "owner/repo";
const BOT = "babysitter[bot]";
const APP = { appId: "1", installationId: "1", privateKeyPath: "/unused" };

interface AgentScript {
  code?: number;
  response?: string;
}

function basePr(over: Record<string, unknown> = {}) {
  return {
    state: "OPEN",
    number: 1,
    title: "fix",
    body: "Repair fixture",
    closingIssuesReferences: [],
    author: { login: "fleet" },
    headRefName: "feature",
    headRefOid: HEAD,
    baseRefName: "main",
    isCrossRepository: false,
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    statusCheckRollup: [{ conclusion: "FAILURE" }],
    labels: [],
    ...over,
  };
}

/** In-memory GitHub, git and agent boundaries around the real `fix()`. */
function harness(stateDir: string) {
  const state = {
    pr: basePr() as ReturnType<typeof basePr>,
    locks: [] as Array<
      { id: number; body: string; created_at: string; author: string }
    >,
    markers: [] as Array<Record<string, unknown>>,
    agents: [] as AgentScript[],
    prompts: [] as string[],
    sessions: 0,
    changes: false,
    committed: false,
    pushed: 0,
    reviewId: 10,
    /** Every base merge the babysitter asked the git boundary to make. */
    mergeBaseCalls: [] as Array<{ dir: string; baseRef: string }>,
    mergeBaseResult: { kind: "current" } as BaseSync,
    journalled: [] as Array<
      { repo: string; prNumber: number; headSha: string }
    >,
  };
  let nextId = 100;
  const gh = (args: string[]): Promise<string> => {
    const joined = args.join(" ");
    if (args[0] === "pr" && args[1] === "edit") return Promise.resolve("");
    if (joined.includes("pulls/1/reviews")) {
      return Promise.resolve(JSON.stringify([[{
        id: state.reviewId,
        body: undefined,
        state: "CHANGES_REQUESTED",
        user: { login: "reviewer" },
      }]]));
    }
    if (args[0] === "pr" && args[1] === "view") {
      if (args[args.indexOf("--json") + 1]?.includes("body")) {
        return Promise.resolve(JSON.stringify({
          ...state.pr,
          headRefOid: state.committed ? PUSHED : state.pr.headRefOid,
        }));
      }
      return Promise.resolve(JSON.stringify(state.pr));
    }
    if (args[0] === "issue" && args[1] === "comment") {
      const id = nextId++;
      state.locks.push({
        id,
        body: args[args.indexOf("--body") + 1]!,
        created_at: new Date().toISOString(),
        author: BOT,
      });
      return Promise.resolve(
        `https://github.com/${REPO}/issues/1#issuecomment-${id}`,
      );
    }
    if (joined.includes("issues/1/comments?per_page=100")) {
      return Promise.resolve(JSON.stringify(state.locks));
    }
    if (args.includes("DELETE")) {
      const id = Number(
        args.find((a) => /issues\/comments\/\d+$/.test(a))
          ?.split("/").at(-1),
      );
      state.locks = state.locks.filter((lock) => lock.id !== id);
      return Promise.resolve("");
    }
    if (
      args[0] === "api" && args[1] === `repos/${REPO}/issues/1/comments` &&
      args.includes("POST")
    ) {
      const comment = {
        id: nextId++,
        body: args[args.indexOf("--field") + 1]!.slice("body=".length),
        created_at: new Date().toISOString(),
        user: { login: BOT },
      };
      state.markers.push(comment);
      return Promise.resolve(JSON.stringify({ id: comment.id }));
    }
    if (
      args[0] === "api" && args[1] === `repos/${REPO}/issues/1/comments` &&
      args.includes("--slurp")
    ) return Promise.resolve(JSON.stringify([state.markers]));
    return Promise.reject(new Error(`unexpected gh call: ${joined}`));
  };
  const run: NonNullable<FixDeps["run"]> = (command, args) => {
    if (command === "gh" && args[1]?.includes("/actions/runs")) {
      return Promise.resolve("[]");
    }
    if (command === "gh" && args.includes("body")) return Promise.resolve("");
    if (command === "gh" && args[1]?.startsWith("users/")) {
      return Promise.resolve("12345");
    }
    if (command === "git" && args.includes("rev-parse")) {
      return Promise.resolve(state.committed ? PUSHED : HEAD);
    }
    if (command === "git" && args.includes("--porcelain")) {
      return Promise.resolve(state.changes ? " M file.ts" : "");
    }
    if (command === "git" && args[0] === "push") {
      state.pushed++;
      return Promise.resolve("");
    }
    return Promise.resolve("");
  };
  // Follows startBabysitterAgent's contract: false when beforeSpawn declines,
  // otherwise true with the agent's final message in the exchange.
  const startAgent: NonNullable<FixDeps["startAgent"]> = async (
    _app,
    _repo,
    agentOptions,
    beforeSpawn,
  ) => {
    const script = state.agents.shift() ?? { code: 0 };
    agentOptions.onTokenExpiry?.(new Date(Date.now() + 3_600_000));
    if (!await beforeSpawn()) return false;
    state.sessions++;
    state.prompts.push(agentOptions.prompt);
    const code = script.code ?? 0;
    if (code !== 0) {
      throw new BabysitterFailure(
        `babysitter repair container exited with code ${code}`,
        code === BABYSITTER_TASK_FAILURE_EXIT_CODE ? "code" : "infrastructure",
      );
    }
    await Deno.writeTextFile(
      `${agentOptions.exchange}/${BABYSITTER_RESPONSE_FILE}`,
      script.response ?? "done\nBABYSITTER_READY\n",
    );
    return true;
  };
  const deps: FixDeps = {
    stateDir,
    run,
    clone: () => Promise.resolve(),
    mergeBase: (dir: string, baseRef: string) => {
      state.mergeBaseCalls.push({ dir, baseRef });
      return Promise.resolve(state.mergeBaseResult);
    },
    dismiss: () => Promise.resolve(),
    verifyReviews: (input) =>
      Promise.resolve(input.reviews.map((review) => ({
        id: review.id,
        verified: true,
        reason: "fixed",
      }))),
    armAutoMerge: () => Promise.resolve(),
    startAgent,
    resetGitConfig: () => Promise.resolve(),
    assertTreeSafe: () => Promise.resolve(),
    journalAttempt: (attempt) => {
      state.journalled.push(attempt);
      return Promise.resolve();
    },
    commit: () => {
      state.committed = true;
      return Promise.resolve();
    },
    escalate: () => Promise.resolve(`${REPO}#900`),
  };
  const attempt = (max = 3) =>
    fix(
      REPO,
      basePr() as never,
      [BOT],
      BOT,
      APP,
      "/unused",
      gh,
      () => Promise.resolve(),
      max,
      deps,
    );
  return { state, deps, attempt };
}

/**
 * Silence the babysitter's console output, and hand back every stderr line
 * (console.warn) it wrote while the action ran, so the base-refresh diagnostics
 * can be asserted.
 */
async function withConsole<T>(
  action: (stateDir: string, lines: string[]) => Promise<T>,
): Promise<T> {
  const root = await Deno.makeTempDir();
  const lines: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = () => {};
  console.warn = (...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  };
  console.error = () => {};
  try {
    return await action(`${root}/state`, lines);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    await Deno.remove(root, { recursive: true });
  }
}

const baseRefreshLines = (lines: string[]) =>
  lines.filter((line) => line.includes("[base-refresh]"));

Deno.test("a failed-CI repair on a behind-only (MERGEABLE) PR does not merge the base and still runs the agent (Issue #4943)", async () => {
  await withConsole(async (stateDir, lines) => {
    const h = harness(stateDir);
    h.state.pr = basePr({ mergeable: "MERGEABLE" });
    h.state.changes = true;
    await h.attempt();
    assertEquals(h.state.mergeBaseCalls, []);
    assertEquals(h.state.sessions, 1);
    assertEquals(h.state.prompts.length, 1);
    assert(
      !h.state.prompts[0]!.includes("has already merged the latest"),
      "the prompt must not claim a merged base",
    );
    const skipped = baseRefreshLines(lines).filter((line) =>
      line.includes("source=babysitter-repair") &&
      line.includes("outcome=base-merge-skipped")
    );
    assertEquals(skipped.length, 1, lines.join("\n"));
  });
});

Deno.test("a requested-review-changes repair on a behind-only (MERGEABLE) PR does not merge the base (Issue #4943)", async () => {
  await withConsole(async (stateDir, lines) => {
    const h = harness(stateDir);
    h.state.pr = basePr({
      mergeable: "MERGEABLE",
      reviewDecision: "CHANGES_REQUESTED",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
    });
    await h.attempt();
    assertEquals(h.state.mergeBaseCalls, []);
    assertEquals(h.state.sessions, 1);
    assert(
      !h.state.prompts[0]!.includes("has already merged the latest"),
      "the prompt must not claim a merged base",
    );
    assertEquals(
      baseRefreshLines(lines).filter((line) =>
        line.includes("outcome=base-merge-skipped")
      ).length,
      1,
      lines.join("\n"),
    );
  });
});

Deno.test("a conflicting PR merges the base once, and a conflicted merge still reaches the agent (Issue #4943)", async () => {
  await withConsole(async (stateDir, lines) => {
    const h = harness(stateDir);
    h.state.pr = basePr({ mergeable: "CONFLICTING" });
    h.state.mergeBaseResult = { kind: "conflicted" };
    await h.attempt();
    assertEquals(h.state.mergeBaseCalls.length, 1);
    assertEquals(h.state.mergeBaseCalls[0]!.baseRef, "main");
    assertEquals(h.state.sessions, 1);
    assertStringIncludes(
      h.state.prompts[0]!,
      "has already merged the latest main",
    );
    const allowed = baseRefreshLines(lines).filter((line) =>
      line.includes("source=babysitter-repair") &&
      line.includes("outcome=base-merge-allowed")
    );
    assertEquals(allowed.length, 1, lines.join("\n"));
  });
});
