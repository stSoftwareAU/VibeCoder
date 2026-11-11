/**
 * Shared in-memory harness for the babysitter `fix()` tests (Issue #4943):
 * the GitHub, git and agent boundaries around the real `fix()`. Extracted from
 * babysitter_fix_orchestration_test.ts so babysitter_base_merge_policy_4943_test.ts
 * reuses it instead of copying it. Not a test module (no `_test` suffix), so
 * `deno test` never collects it on its own.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert } from "@std/assert";
import {
  BABYSITTER_RESPONSE_FILE,
  type BaseSync,
  type EscalationRequest,
  fix,
  type FixDeps,
} from "../../commands/fleet_pr_babysitter.ts";
import { BabysitterFailure } from "../../lib/babysitter_retry_state.ts";
import { BABYSITTER_TASK_FAILURE_EXIT_CODE } from "../../lib/fleet_babysitter_container.ts";
import type {
  ReviewVerificationInput,
  ReviewVerificationOutcome,
} from "../../lib/babysitter_review_verifier.ts";

/** A verifier that judges every requested review fixed (Issue #4657). */
export const allVerified = (
  input: ReviewVerificationInput,
): Promise<ReviewVerificationOutcome[]> =>
  Promise.resolve(
    input.reviews.map((review) => ({
      id: review.id,
      verified: true,
      reason: "fixed",
    })),
  );

export const HEAD = "a".repeat(40);
export const PUSHED = "b".repeat(40);
export const REPO = "owner/repo";
export const BOT = "babysitter[bot]";
export const APP = {
  appId: "1",
  installationId: "1",
  privateKeyPath: "/unused",
};

export interface AgentScript {
  code?: number;
  stderr?: string;
  response?: string;
  expiresInMs?: number;
  elapsedMs?: number;
  /** Throws this message as a code-class failure, as a repair the agent failed would. */
  codeFailure?: string;
  setupScratch?: (scratch: string) => Promise<void>;
  proposal?: string;
}

export function basePr(over: Record<string, unknown> = {}) {
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
export function harness(
  stateDir: string,
  options: { markerFails?: boolean } = {},
) {
  const state = {
    pr: basePr() as ReturnType<typeof basePr>,
    locks: [] as Array<
      { id: number; body: string; created_at: string; author: string }
    >,
    markers: [] as Array<Record<string, unknown>>,
    issues: [] as string[][],
    agents: [] as AgentScript[],
    prompts: [] as string[],
    sessions: 0,
    runFailures: [] as Array<{ match: string; message: string }>,
    changes: false,
    committed: false,
    pushed: 0,
    escalations: 0,
    escalateFails: 0,
    markerFailures: 0,
    markerAttempts: 0,
    reviewId: 10,
    reviewBody: undefined as string | undefined,
    editFailures: 0,
    dismissals: 0,
    journalled: [] as Array<
      { repo: string; prNumber: number; headSha: string }
    >,
    /** Every base merge the babysitter asked the git boundary to make. */
    mergeBaseCalls: [] as Array<{ dir: string; baseRef: string }>,
    mergeBaseResult: { kind: "current" } as BaseSync,
    /** Every host command the git/gh boundary was asked to run (Issue #4770). */
    commands: [] as string[],
  };
  let nextId = 100;
  const gh = (args: string[]): Promise<string> => {
    const joined = args.join(" ");
    if (args[0] === "pr" && args[1] === "edit") {
      if (state.editFailures-- > 0) {
        return Promise.reject(new Error("edit failed"));
      }
      return Deno.readTextFile(args[args.indexOf("--body-file") + 1]!).then(
        (body) => {
          state.pr.body = body;
          return "";
        },
      );
    }
    if (joined.includes("pulls/1/reviews")) {
      return Promise.resolve(
        JSON.stringify([[{
          id: state.reviewId,
          body: state.reviewBody,
          state: "CHANGES_REQUESTED",
          user: { login: "reviewer" },
        }]]),
      );
    }
    if (args[0] === "pr" && args[1] === "view") {
      if (args[args.indexOf("--json") + 1]?.includes("body")) {
        for (const failure of state.runFailures) {
          if (`gh ${joined}`.includes(failure.match)) {
            return Promise.reject(new Error(failure.message));
          }
        }
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
      state.markerAttempts++;
      if (state.markerFailures > 0) {
        state.markerFailures--;
        return Promise.reject(new Error("marker write 502"));
      }
      if (options.markerFails) {
        return Promise.reject(new Error("marker write 502"));
      }
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
    const joined = `${command} ${args.join(" ")}`;
    state.commands.push(joined);
    for (const failure of state.runFailures) {
      if (joined.includes(failure.match)) {
        return Promise.reject(new Error(failure.message));
      }
    }
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
  // The stub follows startBabysitterAgent's contract: false when beforeSpawn
  // declines, otherwise true with the agent's final message in the exchange.
  // Mirror the container wrapper's error text and existing retry classifier.
  const startAgent: NonNullable<FixDeps["startAgent"]> = async (
    _app,
    _repo,
    agentOptions,
    beforeSpawn,
  ) => {
    const script = state.agents.shift() ?? { code: 0 };
    agentOptions.onTokenExpiry?.(
      new Date(Date.now() + (script.expiresInMs ?? 3_600_000)),
    );
    if (!await beforeSpawn()) return false;
    state.sessions++;
    await script.setupScratch?.(agentOptions.scratch);
    if (script.proposal) {
      await Deno.writeTextFile(
        `${agentOptions.dir}/.babysitter-pr-body`,
        script.proposal,
      );
    }
    state.prompts.push(agentOptions.prompt);
    if (script.elapsedMs) {
      const now = Date.now();
      Date.now = () => now + script.elapsedMs!;
    }
    if (script.codeFailure !== undefined) {
      throw new BabysitterFailure(script.codeFailure, "code");
    }
    const code = script.code ?? 0;
    if (code !== 0) {
      const message =
        `babysitter repair container vibe-babysitter-test exited with code ${code}${
          script.stderr ? `: ${script.stderr}` : ""
        }; if the worker image predates the babysitter-repair mode, relaunch with ./run.sh to rebuild it`;
      throw new BabysitterFailure(
        message,
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
    dismiss: () => {
      state.dismissals++;
      return Promise.resolve();
    },
    verifyReviews: allVerified,
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
    escalate: (request: EscalationRequest) => {
      if (state.escalateFails > 0) {
        state.escalateFails--;
        return Promise.reject(new Error("escalation provider down"));
      }
      state.escalations++;
      assert(request.record.evidence?.length);
      return Promise.resolve(`${REPO}#900`);
    },
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
  return { state, gh, deps, attempt };
}
