/** Orchestration tests for the babysitter's retry, escalation and reconciliation (Issue #4656). */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  appendEvidence,
  appendTrackedPrs,
  assertRepairTreeSafe,
  attemptKey,
  BABYSITTER_CONTAINER_RESPONSE_FILE,
  BABYSITTER_RESPONSE_FILE,
  classifyBabysitterGitFailure,
  cloneForRepair,
  escalateStuckRepair,
  type EscalationRequest,
  fix,
  type FixDeps,
  observeTrackedPr,
  pendingPublicationStore,
  readOnlyReviewVerifier,
  readSharedBabysitterAttempts,
  reconcileTrackedPr,
  repairFailureIdentity,
  resetRepairCloneGitConfig,
  startBabysitterAgent,
} from "../commands/fleet_pr_babysitter.ts";
import {
  BabysitterFailure,
  babysitterRetryEligible,
  type BabysitterRetryRecord,
  listBabysitterRetryStates,
  saveBabysitterRetryState,
} from "../lib/babysitter_retry_state.ts";
import { ContainerRuntimeUnavailableError } from "../lib/container_runtime.ts";
import { BABYSITTER_AGENT_PERMISSIONS } from "../lib/fleet_babysitter_app.ts";
import {
  BABYSITTER_CLONE_MOUNT,
  BABYSITTER_TASK_FAILURE_EXIT_CODE,
  type BabysitterContainerDeps,
  runBabysitterRepairContainer,
} from "../lib/fleet_babysitter_container.ts";
import { babysitterHostCredentialPaths } from "../lib/fleet_babysitter_paths.ts";
import {
  fakeContainer,
  fakeTokenExchange,
  generateTestKeyPem,
  repairDirs,
  repairHost,
  repairPlan,
  type RuntimeSpawn,
  withTestKey,
} from "./fixtures/babysitter_container_fakes_4770.ts";
import { createLogger } from "../lib/logger.ts";
import { acquireBranchUpdateLock } from "../lib/pr_branch_lock.ts";
import type {
  ReviewVerificationInput,
  ReviewVerificationOutcome,
} from "../lib/babysitter_review_verifier.ts";

/** A verifier that judges every requested review fixed (Issue #4657). */
const allVerified = (
  input: ReviewVerificationInput,
): Promise<ReviewVerificationOutcome[]> =>
  Promise.resolve(
    input.reviews.map((review) => ({
      id: review.id,
      verified: true,
      reason: "fixed",
    })),
  );

const HEAD = "a".repeat(40);
const PUSHED = "b".repeat(40);
const REPO = "owner/repo";
const BOT = "babysitter[bot]";
const APP = { appId: "1", installationId: "1", privateKeyPath: "/unused" };

interface AgentScript {
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
function harness(
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
    mergeBase: () => Promise.resolve({ kind: "current" }),
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

Deno.test("fix resumes a failed publication without another agent session (PR #4779 review)", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    h.state.pr = basePr({
      reviewDecision: "CHANGES_REQUESTED",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
    });
    h.state.agents.push({ proposal: "Rewritten description." });
    h.state.editFailures = 1;
    await assertRejects(() => h.attempt(), Error, "edit failed");
    const store = pendingPublicationStore(
      stateDir,
      REPO,
      1,
      [{
        id: 10,
        state: "CHANGES_REQUESTED",
        user: { login: "reviewer" },
      }] as never,
    );
    assertEquals(await store.load(HEAD), {
      proposal: "Rewritten description.",
      pushed: false,
    });
    assertEquals(h.state.dismissals, 0);
    assertEquals(h.state.journalled.length, 1);
    await elapse(stateDir);
    await h.attempt();
    assertEquals(h.state.sessions, 1);
    assertEquals(h.state.pr.body, "Rewritten description.");
    assertEquals(h.state.dismissals, 1);
    assertEquals(h.state.journalled.length, 1);
    assertEquals(await store.load(HEAD), undefined);
  });
});

// Issue #4921: a failing check already red on the base is the base's failure
// to fix, so CI-fix defers the PR: no agent, no pushed commit, no charged attempt.
Deno.test("a failed-CI PR whose every failing check is red on the base is deferred, not repaired", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    const calls: Array<
      { repo: string; headSha: string; baseRef: string; rollup: unknown }
    > = [];
    h.deps.classifyBaseFailure = (options) => {
      calls.push({
        repo: options.repo,
        headSha: options.headSha,
        baseRef: options.baseRef,
        rollup: options.rollup,
      });
      return Promise.resolve({
        kind: "defer",
        checks: [{ name: "test", baseRunId: 7 }],
      });
    };
    h.state.changes = true;
    await h.attempt();
    assertEquals(h.state.sessions, 0);
    assertEquals(h.state.committed, false);
    assertEquals(h.state.pushed, 0);
    assertEquals(h.state.journalled, []);
    assertEquals(await records(stateDir), []);
    assertEquals(calls, [{
      repo: REPO,
      headSha: HEAD,
      baseRef: "main",
      rollup: [{ conclusion: "FAILURE" }],
    }]);
  });
});

Deno.test("a failed-CI PR not deferred by the base check still repairs, and the prompt forbids repairing a base-red check", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    h.deps.classifyBaseFailure = () =>
      Promise.resolve({
        kind: "repair",
        reason: `the base's run of "test" is green, not red`,
      });
    h.state.agents.push({});
    await h.attempt();
    assertEquals(h.state.sessions, 1);
    assertStringIncludes(
      h.state.prompts[0]!,
      "do not repair it in this PR",
    );
  });
});

Deno.test("a review repair never consults the base-failure classifier", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    h.state.pr = basePr({
      reviewDecision: "CHANGES_REQUESTED",
      statusCheckRollup: [{ conclusion: "SUCCESS", status: "COMPLETED" }],
    });
    let consulted = 0;
    h.deps.classifyBaseFailure = () => {
      consulted++;
      return Promise.reject(new Error("consulted for a review repair"));
    };
    h.state.agents.push({});
    h.state.changes = true;
    await h.attempt();
    assertEquals(consulted, 0);
    assertEquals(h.state.sessions, 1);
  });
});

async function withState<T>(
  action: (stateDir: string) => Promise<T>,
): Promise<T> {
  const root = await Deno.makeTempDir();
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return await action(`${root}/state`);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    await Deno.remove(root, { recursive: true });
  }
}

async function records(stateDir: string) {
  return await listBabysitterRetryStates(stateDir, REPO);
}

/** Make a cooldown elapse, the way waiting would. */
async function elapse(stateDir: string): Promise<void> {
  for (const record of await records(stateDir)) {
    await saveBabysitterRetryState(stateDir, {
      ...record,
      nextEligibleAt: "2000-01-01T00:00:00.000Z",
    });
  }
}

Deno.test("a push on another host resets the shared no-progress budget", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    await h.attempt();
    await elapse(stateDir);
    await h.attempt();
    assertEquals((await records(stateDir))[0]!.attempts.substantive, 2);
    const otherDir = `${stateDir}-other`;
    h.deps.stateDir = otherDir;
    h.state.changes = true;
    await h.attempt();
    h.deps.stateDir = stateDir;
    h.state.changes = false;
    h.state.committed = false;
    await elapse(stateDir);
    await h.attempt();
    assertEquals((await records(stateDir))[0]!.attempts.substantive, 1);
    assertEquals(h.state.escalations, 0);
  });
});

Deno.test("transient failure, cooldown, retry, checked repair, CI, review and merge observed", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    // 1. The provider ends the session: an infrastructure failure.
    h.state.agents.push({ code: 1, stderr: "stream disconnected" });
    await assertRejects(
      () => h.attempt(),
      Error,
      "exited with code 1",
    );
    let [record] = await records(stateDir);
    assertEquals(record!.blockerClass, "infrastructure");
    assertEquals(record!.attempts, { infrastructure: 1, substantive: 0 });
    assertEquals(h.state.markers.length, 0);
    assertEquals(h.state.locks, [], "the failed repair released its lock");

    // 2. Unchanged head, inside the cooldown: no session starts.
    await h.attempt();
    assertEquals(h.state.sessions, 1);

    // 3. After the cooldown the retry repairs and pushes.
    await elapse(stateDir);
    h.state.changes = true;
    await h.attempt();
    assertEquals(h.state.sessions, 2);
    assertEquals(h.state.pushed, 1);
    [record] = await records(stateDir);
    assertEquals(record!.reconciliation, "waiting-for-ci-review");
    assertEquals(record!.pushedHead, PUSHED);
    assertEquals(record!.attempts, { infrastructure: 1, substantive: 0 });
    assertEquals(h.state.markers.length, 1);
    assertEquals(h.state.locks, [], "waiting holds no repair lock");

    // 4. CI, independent review, hand-off, then merge observed. The
    // observation takes no GitHub client, so it cannot take a lock.
    const open = (over: Record<string, unknown>) =>
      basePr({ headRefOid: PUSHED, ...over }) as never;
    const observe = async (pr: never) => {
      await observeTrackedPr(stateDir, REPO, pr, false, false);
      return (await records(stateDir))[0]!;
    };
    assertEquals(
      (await observe(open({
        statusCheckRollup: [{ status: "IN_PROGRESS" }],
      }))).lastOutcome,
      "waiting-for-ci",
    );
    assertEquals(
      (await observe(open({
        statusCheckRollup: [{ conclusion: "SUCCESS", status: "COMPLETED" }],
        reviewDecision: "REVIEW_REQUIRED",
      }))).lastOutcome,
      "waiting-for-independent-review",
    );
    const handed = await observe(open({
      statusCheckRollup: [{ conclusion: "SUCCESS", status: "COMPLETED" }],
      reviewDecision: "APPROVED",
    }));
    assertEquals(handed.lastOutcome, "handed-to-auto-merge-owner");
    assertEquals(handed.reconciliation, "waiting-for-ci-review");
    assertEquals((await records(stateDir)).length, 1, "not merged yet");
    assertEquals(
      await observeTrackedPr(
        stateDir,
        REPO,
        open({ state: "MERGED", mergedAt: "2026-11-03T00:00:00Z" }),
        false,
        false,
      ),
      "merged",
    );
    assertEquals(await records(stateDir), []);
  });
});

Deno.test("an old attempt file migrates to a bounded retry across a restart", async () => {
  await withState(async (stateDir) => {
    await Deno.mkdir(stateDir, { recursive: true });
    await Deno.writeTextFile(
      `${stateDir}/${attemptKey(REPO, 1, HEAD, [])}`,
      "failed CI\n",
    );
    const h = harness(stateDir);
    await h.attempt();
    assertEquals(h.state.sessions, 0, "the migrated cooldown defers the head");
    const [record] = await records(stateDir);
    assertEquals(record!.lastOutcome, "legacy-attempt");
    // A restarted process reads the saved v2 record rather than the file.
    await Deno.remove(`${stateDir}/${attemptKey(REPO, 1, HEAD, [])}`);
    await h.attempt();
    assertEquals(h.state.sessions, 0);
    await elapse(stateDir);
    h.state.changes = true;
    await h.attempt();
    assertEquals(h.state.sessions, 1, "retried without deleting any file");
    assertEquals(h.state.pushed, 1);
  });
});

Deno.test("two hosts contending: the loser starts no session and leaves no lock", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    const rival = await acquireBranchUpdateLock({
      repo: REPO,
      prNumber: 1,
      workerId: "rival-host",
      authorOptions: { fleetAuthors: [BOT] },
      ghCommandFn: h.gh,
      sleepFn: () => Promise.resolve(),
    });
    assert(rival.ok && rival.value.acquired);
    // The rival posted first, whatever the clock resolution.
    h.state.locks[0]!.created_at = new Date(Date.now() - 5_000).toISOString();
    await h.attempt();
    assertEquals(h.state.sessions, 0);
    assertEquals(h.state.locks.length, 1, "only the rival's lock remains");
    assertEquals(await records(stateDir), []);
  });
});

Deno.test("head movement defers, and a head that moves mid-repair spends no substantive budget", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    h.state.pr = basePr({ headRefOid: "c".repeat(40) }) as never;
    await h.attempt();
    assertEquals(h.state.sessions, 0);
    assertEquals(await records(stateDir), []);

    h.state.pr = basePr() as never;
    h.state.changes = true;
    const startAgent = h.deps.startAgent!;
    h.deps.startAgent = async (...args) => {
      const ran = await startAgent(...args);
      h.state.pr = basePr({ headRefOid: "d".repeat(40) }) as never;
      return ran;
    };
    await assertRejects(() => h.attempt(), Error, "PR changed during the fix");
    const [record] = await records(stateDir);
    assertEquals(record!.blockerClass, "race");
    assertEquals(record!.attempts, { infrastructure: 1, substantive: 0 });
    assertEquals(
      record!.nextAction,
      "re-read the current head and branch lock before retrying",
    );
    assertEquals(h.state.markers.length, 0);
    assertEquals(h.state.pushed, 0);
  });
});

const NATIVE_CHECK_FINDING =
  "**`quality.sh:20`**: The native check has not run.\n\n**Fix:** Run the native check.\n\nReview summary.";
const CLI_FINDING =
  "**`cli.ts:5`**: The CLI case fails.\n\n**Fix:** Fix the newly failing CLI case.\n\nNew summary.";

Deno.test("a newer change request landing mid-repair refuses the push as a race and the next pass repairs from it (Issue #4968)", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    h.state.pr = basePr({
      reviewDecision: "CHANGES_REQUESTED",
      statusCheckRollup: [{ conclusion: "SUCCESS", status: "COMPLETED" }],
    });
    h.state.reviewBody = NATIVE_CHECK_FINDING;
    h.state.changes = true;
    const startAgent = h.deps.startAgent!;
    h.deps.startAgent = async (...args) => {
      const ran = await startAgent(...args);
      h.state.reviewId++;
      h.state.reviewBody = CLI_FINDING;
      return ran;
    };
    await assertRejects(() => h.attempt(), Error, "PR changed during the fix");
    assertEquals(h.state.pushed, 0);
    assertEquals(h.state.dismissals, 0);
    assertEquals(h.state.markers.length, 0);
    const [race] = await records(stateDir);
    assertEquals(race!.blockerClass, "race");
    assertEquals(race!.attempts, { infrastructure: 1, substantive: 0 });

    h.deps.startAgent = startAgent;
    // The next pass clones the PR head afresh, so nothing is committed yet.
    h.state.committed = false;
    await elapse(stateDir);
    await h.attempt();
    assertEquals(h.state.sessions, 2);
    assertEquals(h.state.pushed, 1);
    assertEquals(h.state.dismissals, 1);
    const newIdentity = repairFailureIdentity("requested review changes", [{
      id: 11,
      state: "CHANGES_REQUESTED",
      user: { login: "reviewer" },
      body: CLI_FINDING,
    }]);
    const pushed = (await records(stateDir)).find((record) =>
      record.pushedHead === PUSHED
    );
    assertEquals(pushed?.failureIdentity, newIdentity);
  });
});

Deno.test("a newer change request with the same findings mid-repair still pushes (Issue #4968)", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    h.state.pr = basePr({
      reviewDecision: "CHANGES_REQUESTED",
      statusCheckRollup: [{ conclusion: "SUCCESS", status: "COMPLETED" }],
    });
    h.state.reviewBody = NATIVE_CHECK_FINDING;
    h.state.changes = true;
    const startAgent = h.deps.startAgent!;
    h.deps.startAgent = async (...args) => {
      const ran = await startAgent(...args);
      h.state.reviewId++;
      return ran;
    };
    await h.attempt();
    assertEquals(h.state.sessions, 1);
    assertEquals(h.state.pushed, 1);
  });
});

Deno.test("missing tools, a full disk, a timed-out fetch and a killed agent spend no substantive budget", async () => {
  const cases = [
    ["git failed: fatal: write error: No space left on device", "capability"],
    [
      "git failed: Failed to execute git fetch origin main: No such file or directory (os error 2)",
      "capability",
    ],
    [
      "git failed: TIMEOUT: git fetch origin main timed out after 60s (Issue #619)",
      "infrastructure",
    ],
    [
      "git failed: TIMEOUT: git push --end-of-options origin HEAD:refs/heads/x timed out after 60s (Issue #619)",
      "infrastructure",
    ],
  ] as const;
  for (const [message, expected] of cases) {
    await withState(async (stateDir) => {
      const h = harness(stateDir);
      const pushing = message.includes("git push");
      h.state.changes = pushing;
      h.state.runFailures.push({ match: pushing ? "push" : "fetch", message });
      await assertRejects(() => h.attempt(), Error, message);
      const [record] = await records(stateDir);
      assertEquals(record!.blockerClass, expected, message);
      assertEquals(record!.attempts.substantive, 0, message);
      assertEquals(record!.attempts.infrastructure, 1, message);
      assertEquals(h.state.markers.length, 0, message);
      assertEquals(h.state.locks, [], message);
      const eligibleAt = Date.parse(record!.nextEligibleAt!);
      assert(eligibleAt > Date.now(), message);
      assert(eligibleAt <= Date.now() + 2 * 60 * 60_000, message);
      h.state.runFailures = [];
      h.state.committed = false;
      await elapse(stateDir);
      h.state.changes = true;
      await h.attempt();
      assertEquals(h.state.sessions, pushing ? 2 : 1, message);
      assertEquals(h.state.pushed, 1, message);
    });
  }
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    h.state.agents.push({ code: 137 });
    await assertRejects(() => h.attempt(), Error, "with code 137");
    const [record] = await records(stateDir);
    assertEquals(record!.blockerClass, "infrastructure");
    assertEquals(record!.attempts, { infrastructure: 1, substantive: 0 });
    assertEquals(h.state.markers.length, 0, "no no-change marker is posted");
  });
});

Deno.test("an expired read token restarts the session and the repair continues", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    h.state.changes = true;
    h.state.agents.push({ code: 143, expiresInMs: 60_000 });
    await h.attempt();
    assertEquals(h.state.sessions, 2);
    assertStringIncludes(h.state.prompts[1]!, "previous read token expired");
    assertEquals(h.state.pushed, 1);
    assertEquals(
      (await records(stateDir))[0]!.reconciliation,
      "waiting-for-ci-review",
    );
  });
});

Deno.test("repeated no-progress persists evidence and escalates exactly once", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    for (let run = 1; run <= 3; run++) {
      await h.attempt(2);
      if (run === 1) assertEquals(h.state.escalations, 0);
      await elapse(stateDir);
    }
    const [record] = await records(stateDir);
    assertEquals(record!.attempts.substantive, 2);
    assertEquals(record!.evidence?.length, 2);
    assertStringIncludes(record!.evidence![0]!, "agent made no changes");
    assertEquals(record!.escalation?.issue, `${REPO}#900`);
    assertEquals(h.state.escalations, 1, "one incident, one escalation");
    assertStringIncludes(h.state.prompts[1]!, "agent made no changes");
    assertStringIncludes(h.state.prompts[1]!, "untrusted diagnostics");
    assertEquals(h.state.sessions, 2);
    assertEquals(record!.reconciliation, "repair-needed");
    assert(!record!.nextAction.includes("needs-human"));
  });
});

Deno.test("a failed escalation is retried on the next no-progress pass", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    h.state.escalateFails = 1;
    await h.attempt(1);
    assertEquals((await records(stateDir))[0]!.escalation, undefined);
    await elapse(stateDir);
    await h.attempt(1);
    assertEquals(h.state.escalations, 1);
    assertEquals(h.state.sessions, 1);
    assertEquals(h.state.markers.length, 1);
    assertEquals(
      (await records(stateDir))[0]!.escalation?.issue,
      `${REPO}#900`,
    );
  });
});

Deno.test("a non-zero container exit keeps the retry record and the repair's real error (Issue #4770)", async () => {
  await withTestKey(async (privateKeyPath) => {
    await withState(async (stateDir) => {
      const h = harness(stateDir, { markerFails: true });
      const spawns: RuntimeSpawn[] = [];
      h.deps.startAgent = productionAgent(
        privateKeyPath,
        fakeContainer(spawns, {
          onSpawn: () =>
            Promise.resolve({
              success: false,
              code: BABYSITTER_TASK_FAILURE_EXIT_CODE,
              stderr: "task-failure: invalid source",
              timedOut: false,
            }),
        }),
      );
      await assertRejects(
        () => h.attempt(),
        Error,
        `exited with code ${BABYSITTER_TASK_FAILURE_EXIT_CODE}: task-failure: invalid source`,
      );
      const [record] = await records(stateDir);
      assertEquals(record!.blockerClass, "code");
      assertEquals(record!.attempts, { infrastructure: 0, substantive: 1 });
      assertEquals(h.state.markers.length, 0);
      assert(record!.nextEligibleAt !== null);
    });
  });
});

Deno.test("a failed marker write never replaces the repair's real error", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir, { markerFails: true });
    h.state.agents.push({
      codeFailure: "agent exited unsuccessfully with code 1",
    });
    await assertRejects(
      () => h.attempt(),
      Error,
      "agent exited unsuccessfully with code 1",
    );
    assert(h.state.markerAttempts > 0, "the marker write was attempted");
    const [record] = await records(stateDir);
    assertEquals(record!.blockerClass, "code");
    assertEquals(record!.attempts.substantive, 1);
    assertEquals(record!.lastOutcome, "repair-failed");
    assertEquals(record!.evidence?.length, 1);
    assertEquals(record!.unpublishedAttempts, 1);
    await elapse(stateDir);
    await h.attempt();
    assertEquals((await records(stateDir))[0]!.attempts.substantive, 2);
  });
});

Deno.test("provider and gh network failures do not spend repair attempts", async () => {
  for (
    const diagnostic of [
      "usage limit reached",
      "HTTP 429 rate limit",
      "stream disconnected",
    ]
  ) {
    await withState(async (stateDir) => {
      const h = harness(stateDir);
      h.state.agents.push({ code: 1, stderr: diagnostic });
      await assertRejects(() => h.attempt());
      const [record] = await records(stateDir);
      assertEquals(record!.blockerClass, "infrastructure");
      assertEquals(record!.attempts.substantive, 0);
      assertEquals(h.state.markers.length, 0);
      assert(record!.nextEligibleAt !== null);
    });
  }
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    h.state.runFailures.push({
      match: "gh pr view",
      message: "gh command failed (exit 1): error connecting to api.github.com",
    });
    await assertRejects(() => h.attempt());
    const [record] = await records(stateDir);
    assertEquals(record!.blockerClass, "infrastructure");
    assertEquals(record!.attempts.substantive, 0);
    assertEquals(h.state.markers.length, 0);
    assert(record!.nextEligibleAt !== null);
  });
});

Deno.test("container task failures spend substantive attempts while transient exits back off (Issue #4770)", async () => {
  for (
    const { code, stderr, blockerClass, substantive } of [
      {
        code: BABYSITTER_TASK_FAILURE_EXIT_CODE,
        stderr: "task-failure: invalid source",
        blockerClass: "code",
        substantive: 1,
      },
      {
        code: 1,
        stderr: "HTTP 429 rate limit",
        blockerClass: "infrastructure",
        substantive: 0,
      },
    ] as const
  ) {
    // The production startBabysitterAgent and runRepairProcess map the exit
    // code to a failure class; the harness stub does not decide it here.
    await withTestKey(async (privateKeyPath) => {
      await withState(async (stateDir) => {
        const h = harness(stateDir);
        const spawns: RuntimeSpawn[] = [];
        h.deps.startAgent = productionAgent(
          privateKeyPath,
          fakeContainer(spawns, {
            onSpawn: () =>
              Promise.resolve({
                success: false,
                code,
                stderr,
                timedOut: false,
              }),
          }),
        );
        const before = Date.now();
        await assertRejects(() => h.attempt());
        assertEquals(spawns.length, 1, `${code} ${stderr}`);
        const [record] = await records(stateDir);
        assertEquals(record!.attempts.substantive, substantive);
        assertEquals(record!.blockerClass, blockerClass);
        assertEquals(h.state.markers.length, substantive);
        assert(Date.parse(record!.nextEligibleAt!) >= before + 60_000);
      });
    });
  }
});

Deno.test("an expired read token restarts the real agent session, which starts again and the repair succeeds (Issue #4770)", async () => {
  await withTestKey(async (privateKeyPath) => {
    await withState(async (stateDir) => {
      const h = harness(stateDir);
      h.state.changes = true;
      const spawns: RuntimeSpawn[] = [];
      // The token expires two minutes and fifteen seconds out: the session
      // runs for fifteen seconds, and the expiry is inside the restart window.
      h.deps.startAgent = productionAgent(
        privateKeyPath,
        fakeContainer(spawns, {
          onSpawn: (spawn) => {
            if (spawns.length === 1) {
              return Promise.resolve({
                success: false,
                code: 143,
                stderr: "",
                timedOut: false,
              });
            }
            return Deno.writeTextFile(
              `${cloneMountedBy(spawn)}/${BABYSITTER_CONTAINER_RESPONSE_FILE}`,
              "done\nBABYSITTER_READY\n",
            ).then(() => OK_RUN);
          },
        }),
        2 * 60_000 + 15_000,
      );
      await h.attempt();
      assertEquals(spawns.length, 2, "both container spawns are recorded");
      assertEquals(h.state.pushed, 1);
      assertEquals(
        (await records(stateDir))[0]!.reconciliation,
        "waiting-for-ci-review",
      );
    });
  });
});

Deno.test("real human gates stay paused", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    h.state.pr = basePr({ labels: [{ name: "needs-human" }] }) as never;
    await h.attempt();
    assertEquals(h.state.sessions, 0);
    const pr = basePr({
      headRefOid: PUSHED,
      labels: [{ name: "needs-human" }],
      statusCheckRollup: [{ conclusion: "SUCCESS", status: "COMPLETED" }],
      reviewDecision: "APPROVED",
    }) as never;
    await saveBabysitterRetryState(stateDir, tracked());
    await observeTrackedPr(stateDir, REPO, pr, false, false);
    const [record] = await records(stateDir);
    assertEquals(record!.reconciliation, "owner-hold");
    assertEquals(record!.nextEligibleAt, null);
    assertEquals(record!.lastOutcome, "owner-hold");
  });
});

function tracked(
  over: Partial<BabysitterRetryRecord> = {},
): BabysitterRetryRecord {
  return {
    version: 2,
    repo: REPO,
    prNumber: 1,
    failureIdentity: "failed CI",
    observedHead: PUSHED,
    blockerClass: "unknown",
    lastOutcome: "pushed",
    attempts: { infrastructure: 0, substantive: 1 },
    nextEligibleAt: null,
    nextAction: "wait",
    pushedHead: PUSHED,
    reconciliation: "waiting-for-ci-review",
    ...over,
  };
}

Deno.test("hand-off honours drafts, cross-repository PRs, policy and dismissed reviews", () => {
  const green = [{ conclusion: "SUCCESS", status: "COMPLETED" }];
  const ready = (over: Record<string, unknown>) =>
    basePr({
      headRefOid: PUSHED,
      statusCheckRollup: green,
      reviewDecision: "APPROVED",
      ...over,
    }) as never;
  const now = Date.parse("2026-11-03T00:00:00Z");
  const outcome = (pr: never, skip = false) =>
    reconcileTrackedPr(pr, tracked(), now, skip);
  assertEquals(outcome(ready({})).lastOutcome, "handed-to-auto-merge-owner");
  assertEquals(outcome(ready({})).nextEligibleAt, "2026-11-03T00:05:00.000Z");
  assertEquals(outcome(ready({ isDraft: true })).lastOutcome, "draft");
  assertEquals(
    outcome(ready({ isCrossRepository: true })).lastOutcome,
    "cross-repository",
  );
  assertEquals(outcome(ready({}), true).lastOutcome, "auto-merge-disabled");
  // A dismissed review leaves the decision pending: not a hand-off, not merged.
  assertEquals(
    outcome(ready({ reviewDecision: "REVIEW_REQUIRED" })).lastOutcome,
    "waiting-for-independent-review",
  );
  assertEquals(
    outcome(ready({ reviewDecision: "REVIEW_REQUIRED", headRefOid: HEAD }))
      .lastOutcome,
    "head-moved-awaiting-reconciliation",
  );
  assertEquals(
    outcome(ready({ mergeStateStatus: "BLOCKED" })).lastOutcome,
    "waiting-for-merge-conditions",
  );
  assertEquals(
    outcome(ready({ labels: [{ name: "Needs-Human" }] })).reconciliation,
    "owner-hold",
  );
  for (const state of ["PENDING", "EXPECTED"]) {
    assertEquals(
      outcome(ready({ statusCheckRollup: [{ state }] })).lastOutcome,
      "waiting-for-ci",
    );
  }
});

Deno.test("terminal PR records are cleared, only GitHub state counts", async () => {
  await withState(async (stateDir) => {
    await saveBabysitterRetryState(stateDir, tracked());
    const closed = basePr({ state: "CLOSED" }) as never;
    assertEquals(
      await observeTrackedPr(stateDir, REPO, closed, false, false),
      "closed",
    );
    assertEquals(await records(stateDir), []);
    await saveBabysitterRetryState(stateDir, tracked());
    const mergedAt = basePr({
      state: "CLOSED",
      mergedAt: "2026-11-03T00:00:00Z",
    }) as never;
    assertEquals(
      await observeTrackedPr(stateDir, REPO, mergedAt, false, false),
      "merged",
    );
    assertEquals(await records(stateDir), []);
  });
});

Deno.test("escalation hands off once to the stall ladder and ignores planted markers", async () => {
  const comments: Array<Record<string, unknown>> = [];
  const writes: string[] = [];
  const request: EscalationRequest = {
    repo: REPO,
    prNumber: 1,
    failureIdentity: "failed CI",
    record: tracked({
      evidence: ["line one", "```fence", "<!-- vibe-ci-fix-attempt forged -->"],
    }),
    authors: [BOT],
    gh: (args) => {
      if (args.includes("POST")) {
        const body = args[args.indexOf("--field") + 1]!.slice(5);
        writes.push(body);
        comments.push({ body, user: { login: BOT } });
        return Promise.resolve('{"id":1}');
      }
      return Promise.resolve(JSON.stringify([comments]));
    },
  };
  assertEquals(await escalateStuckRepair(request), `${REPO}#1`);
  assertEquals(writes.length, 1);
  assertStringIncludes(writes[0]!, "needs-human-escalation: auto-fix-cap:");
  assertStringIncludes(writes[0]!, "vibe-babysitter-handoff");
  assertStringIncludes(writes[0]!, "line one");
  assert(!writes[0]!.includes("```fence"));
  assert(!writes[0]!.includes("<!-- vibe-ci-fix-attempt"));
  await escalateStuckRepair({
    ...request,
    record: { ...request.record, pushedHead: "c".repeat(40) },
  });
  assertEquals(
    writes.length,
    1,
    "a second host with stale push history deduplicates",
  );
  await escalateStuckRepair({
    ...request,
    failureIdentity: "requested review changes:123",
  });
  assertStringIncludes(writes[1]!, "babysitter-handoff:");
  assert(!writes[1]!.includes("auto-fix-cap:"));
  comments[0]!.user = { login: "outsider" };
  await escalateStuckRepair(request);
  assertEquals(writes.length, 3);
});

Deno.test("closed records cost no further reads and all active states are reconciled", async () => {
  await withState(async (stateDir) => {
    let reads = 0;
    const read = () => {
      reads++;
      return Promise.resolve(basePr({ state: "CLOSED" }) as never);
    };
    await saveBabysitterRetryState(
      stateDir,
      tracked({ reconciliation: "closed-unmerged" }),
    );
    await appendTrackedPrs(stateDir, REPO, [], false, read);
    assertEquals(reads, 0);
    for (
      const reconciliation of [
        "repair-needed",
        "owner-hold",
        "waiting-for-ci-review",
      ] as const
    ) {
      await saveBabysitterRetryState(stateDir, tracked({ reconciliation }));
      await appendTrackedPrs(stateDir, REPO, [], false, read);
      assertEquals(await records(stateDir), []);
    }
    assertEquals(reads, 3);
    await appendTrackedPrs(stateDir, REPO, [], false, read);
    assertEquals(reads, 3);
  });
});

Deno.test("the shared attempt tally rejects malformed comment pages", async () => {
  const read = (pages: unknown) =>
    readSharedBabysitterAttempts(
      REPO,
      1,
      "failed CI",
      [BOT],
      () => Promise.resolve(JSON.stringify(pages)),
    );
  const good = {
    id: 1,
    body: "hello",
    user: { login: BOT },
    created_at: "2026-11-03T00:00:00Z",
  };
  assertEquals(await read([[good]]), 0);
  await assertRejects(() => read({}), Error, "Invalid PR comment pages");
  await assertRejects(() => read([good]), Error, "Invalid PR comment pages");
  await assertRejects(() => read([[null]]), Error, "Invalid PR comment in");
  await assertRejects(() => read([["text"]]), Error, "Invalid PR comment in");
  await assertRejects(
    () => read([[{ ...good, id: 1.5 }]]),
    Error,
    "Malformed PR comment",
  );
  await assertRejects(
    () => read([[{ ...good, id: "1" }]]),
    Error,
    "Malformed PR comment",
  );
  await assertRejects(
    () => read([[{ ...good, user: null }]]),
    Error,
    "Malformed PR comment",
  );
  await assertRejects(
    () => read([[{ ...good, user: "bot" }]]),
    Error,
    "Malformed PR comment",
  );
  await assertRejects(
    () => read([[{ ...good, user: {} }]]),
    Error,
    "Malformed PR comment",
  );
  await assertRejects(
    () => read([[{ ...good, body: 5 }]]),
    Error,
    "Malformed PR comment",
  );
  await assertRejects(
    () => read([[{ ...good, created_at: 5 }]]),
    Error,
    "Malformed PR comment",
  );
});

Deno.test("repair identity falls back to review IDs only when bodies are unavailable", () => {
  const review = (id: number) => ({
    id,
    state: "CHANGES_REQUESTED",
    user: { login: "r" },
  });
  assertEquals(repairFailureIdentity("failed CI", [review(9)]), "failed CI");
  assert(
    repairFailureIdentity("requested review changes", [review(3)]) !==
      repairFailureIdentity("requested review changes", [review(9)]),
  );
  assertEquals(attemptKey(REPO, 1, HEAD, []), `owner--repo--1--${HEAD}`);
  assertEquals(
    attemptKey(REPO, 1, HEAD, [review(3), review(9)]),
    `owner--repo--1--${HEAD}--review-9`,
  );
});

Deno.test("review repair identity ignores ordering and IDs while retaining every reviewer and changed ask", () => {
  const review = (id: number, login: string, body: string) => ({
    id,
    user: { login },
    body,
    state: "CHANGES_REQUESTED",
  });
  const first = review(1, "Reviewer", "Fix the native case");
  const second = review(2, "Other", "Fix the exit status");
  const identity = (reviews: typeof first[]) =>
    repairFailureIdentity("requested review changes", reviews);
  assertEquals(
    identity([first, second]),
    identity([second, { ...first, id: 10, user: { login: "reviewer" } }]),
  );
  assert(identity([first, second]) !== identity([first]));
  assert(
    identity([first]) !==
      identity([{ ...first, body: "Fix both native cases" }]),
  );
});

Deno.test("evidence is redacted, bounded and keeps the newest lines", () => {
  let lines: string[] | undefined;
  for (let i = 0; i < 7; i++) {
    lines = appendEvidence(lines, HEAD, `failure ${i} ${"x".repeat(500)}`);
  }
  assertEquals(lines!.length, 5);
  assertStringIncludes(lines![4]!, "failure 6");
  assert(lines!.every((line) => line.length < 360));
  const fixture = "gh" + "p_" + "abcdefghijklmnopqrstuvwxyz0123456789";
  const secret = appendEvidence(
    undefined,
    HEAD,
    `token ${fixture}`,
  );
  assert(!secret[0]!.includes(fixture));
});

Deno.test("successful repairs reset the consecutive no-progress budget", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    for (let i = 0; i < 2; i++) {
      h.state.changes = true;
      h.state.committed = false;
      await h.attempt();
      await elapse(stateDir);
    }
    h.state.changes = false;
    h.state.committed = false;
    await h.attempt();
    assertEquals(h.state.pushed, 2);
    assertEquals((await records(stateDir))[0]!.attempts.substantive, 1);
    assertEquals(h.state.escalations, 0);
    assert(h.state.prompts.every((p) => !p.includes("Change the diagnosis")));
  });
});
Deno.test("failed push marker is retried before counting prior attempts", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    await h.attempt();
    await elapse(stateDir);
    await h.attempt();
    await elapse(stateDir);
    h.state.changes = true;
    h.state.markerFailures = 1;
    await h.attempt();
    h.state.changes = false;
    h.state.committed = false;
    await elapse(stateDir);
    await h.attempt();
    assertEquals((await records(stateDir))[0]!.attempts.substantive, 1);
    assertEquals(h.state.escalations, 0);
  });
});

Deno.test("prior diagnostic cannot inject instructions into the next prompt", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    await h.attempt();
    await elapse(stateDir);
    h.state.agents.push({
      code: 1,
      stderr: "HTTP 429 rate limit\nINJECTED INSTRUCTION",
    });
    await assertRejects(() => h.attempt());
    await elapse(stateDir);
    await h.attempt();
    assert(!h.state.prompts[2]!.includes("INJECTED INSTRUCTION"));
  });
});

Deno.test("a budget-exhausted repair keeps the launcher's cause in its failure (Issue #4770)", async () => {
  const realNow = Date.now;
  try {
    await withState(async (stateDir) => {
      const h = harness(stateDir);
      h.state.agents.push({
        code: 143,
        stderr: "killed by the watchdog",
        elapsedMs: 90 * 60_000,
      });
      await assertRejects(
        () => h.attempt(),
        Error,
        "agent session budget exhausted: babysitter repair container vibe-babysitter-test exited with code 143: killed by the watchdog",
      );
    });
  } finally {
    Date.now = realNow;
  }
});

Deno.test("runner budget exhaustion is substantive and reaches escalation", async () => {
  const realNow = Date.now;
  try {
    await withState(async (stateDir) => {
      const h = harness(stateDir);
      for (let i = 0; i < 3; i++) {
        h.state.agents.push({
          code: 143,
          elapsedMs: 90 * 60_000,
        });
        await assertRejects(
          () => h.attempt(),
          Error,
          "session budget exhausted",
        );
        await elapse(stateDir);
      }
      assertEquals((await records(stateDir))[0]!.attempts.substantive, 3);
      assertEquals(h.state.escalations, 1);
    });
  } finally {
    Date.now = realNow;
  }
});
Deno.test("a changed head bypasses an old cooldown without losing attempts", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    await saveBabysitterRetryState(
      stateDir,
      tracked({
        observedHead: PUSHED,
        reconciliation: "repair-needed",
        nextEligibleAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        attempts: { infrastructure: 0, substantive: 1 },
        unpublishedAttempts: 1,
        escalation: { issue: `${REPO}#900`, at: new Date().toISOString() },
        evidence: ["prior failed repair diagnostic"],
      }),
    );
    await h.attempt(1);
    assertEquals(h.state.sessions, 1);
    assertStringIncludes(h.state.prompts[0]!, "prior failed repair diagnostic");
    assertStringIncludes(h.state.prompts[0]!, "Change the diagnosis");
    assertEquals((await records(stateDir))[0]!.attempts.substantive, 2);
  });
});

Deno.test("pending CI preserves the moved-head diagnosis after a handoff", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    await saveBabysitterRetryState(
      stateDir,
      tracked({
        observedHead: PUSHED,
        attempts: { infrastructure: 0, substantive: 1 },
        unpublishedAttempts: 1,
        escalation: { issue: `${REPO}#900`, at: new Date().toISOString() },
        evidence: ["prior handoff diagnostic"],
      }),
    );
    await observeTrackedPr(
      stateDir,
      REPO,
      basePr({
        statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: null }],
      }) as never,
      false,
      false,
    );
    assert(
      babysitterRetryEligible((await records(stateDir))[0], Date.now(), HEAD),
    );
    await h.attempt(1);
    assertEquals(h.state.sessions, 1);
    assertStringIncludes(h.state.prompts[0]!, "Change the diagnosis");
    assertStringIncludes(h.state.prompts[0]!, "prior handoff diagnostic");
    await elapse(stateDir);
    await h.attempt(1);
    assertEquals(
      h.state.sessions,
      1,
      "only one new diagnosis on the moved head",
    );
  });
});

Deno.test("disk-full clone spends no substantive budget", async () => {
  for (
    const operation of [
      "clone",
      "fetch",
      "push",
      "diff",
      "add",
      "commit",
      "merge",
    ]
  ) {
    for (
      const message of [
        "git failed: fatal: write error: No space left on device",
        "git clone failed: Cloning into bare repository /tmp/mirror...\nfatal: write error: No space left on device",
        "git fetch failed: error: unable to create temporary file: No space left on device",
        "git failed: Failed to execute git fetch origin main: No such file or directory (os error 2)",
      ]
    ) {
      assertEquals(
        classifyBabysitterGitFailure([operation], new Error(message))
          .blockerClass,
        "capability",
      );
    }
  }
  for (const existing of [false, true]) {
    await withState(async (stateDir) => {
      const h = harness(stateDir);
      const mirrorRoot = `${stateDir}/mirrors`;
      if (existing) {
        await Deno.mkdir(`${mirrorRoot}/owner--repo.git`, { recursive: true });
      }
      const stderr = existing
        ? "TIMEOUT: git fetch --no-auto-maintenance --prune /tmp/upstream timed out after 1800s (Issue #619)"
        : "Cloning into bare repository /tmp/mirror...\nfatal: write error: No space left on device";
      h.deps.clone = (repo, dir) =>
        cloneForRepair(repo, dir, {
          mirrorRoot,
          remoteUrl: () => Promise.resolve("/tmp/upstream"),
          runGit: () => Promise.resolve({ success: false, stdout: "", stderr }),
        });
      await assertRejects(() => h.attempt(), Error, stderr);
      const [record] = await records(stateDir);
      assertEquals(
        record!.blockerClass,
        existing ? "infrastructure" : "capability",
      );
      assertEquals(record!.attempts.substantive, 0);
      assertEquals(h.state.markers.length, 0);
      assertEquals(h.state.sessions, 0);
    });
  }
});

Deno.test("local validation diagnostics spend the budget even in timeout paths", async () => {
  const message =
    "git failed: worker/deno/lib/git_timeout.ts:42: leftover conflict marker";
  for (
    const args of [["diff", "--check"], ["add", "-A"], [
      "-c",
      "user.name=bot",
      "commit",
    ], ["merge", "--no-commit"]]
  ) {
    assertEquals(
      classifyBabysitterGitFailure(args, new Error(message)).blockerClass,
      "code",
    );
  }
  assertEquals(
    classifyBabysitterGitFailure(
      ["fetch"],
      new Error("fatal: Could not resolve host: github.com"),
    ).blockerClass,
    "infrastructure",
  );
  assertEquals(
    classifyBabysitterGitFailure(["push"], new Error(message)).blockerClass,
    "infrastructure",
  );
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    h.state.changes = true;
    h.state.runFailures.push({ match: "diff --check", message });
    for (let i = 0; i < 2; i++) {
      await assertRejects(
        () => h.attempt(2),
        Error,
        "leftover conflict marker",
      );
      await elapse(stateDir);
    }
    await h.attempt(2);
    const [record] = await records(stateDir);
    assertEquals(record!.blockerClass, "code");
    assertEquals(record!.attempts.substantive, 2);
    assertEquals(h.state.markers.length, 2);
    assertEquals(h.state.escalations, 1);
    assertEquals(h.state.sessions, 2);
  });
});

Deno.test("reposted review findings retain the exhausted budget; a changed Fix gets a new incident", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    h.state.pr = basePr({
      reviewDecision: "CHANGES_REQUESTED",
      statusCheckRollup: [{ conclusion: "SUCCESS", status: "COMPLETED" }],
    });
    h.state.reviewBody =
      "**`quality.sh:20`**: The native check has not run.\n\n**Fix:** Run the native check.\n\nReview summary.";
    // No ready signal: leave the review outstanding, without dismissal calls.
    for (let i = 0; i < 3; i++) {
      h.state.agents.push({ response: "cannot complete this repair" });
      await assertRejects(() => h.attempt(3));
      await elapse(stateDir);
    }
    for (let i = 0; i < 5; i++) {
      await h.attempt(3);
      await elapse(stateDir);
    }
    assertEquals(h.state.sessions, 3);
    assertEquals(h.state.escalations, 1);
    h.state.reviewId++;
    h.state.reviewBody =
      "**`(earlier review)`**: Earlier finding 1 is not independently verified as fixed (the reviewer's verdict is partly: The code is fixed but validation is still missing.). Original finding: quality.sh:20 — The native check has not run.\n\n**Fix:** Run the native check.\n\nA different summary and checklist.";
    await h.attempt(3);
    assertEquals(h.state.sessions, 3, "a new review ID is not a new defect");
    assertEquals(h.state.escalations, 1);
    h.state.reviewBody = h.state.reviewBody.replace(
      "Run the native check.",
      "Fix the newly failing CLI case.",
    );
    h.state.reviewId++;
    h.state.agents.push({ response: "new review diagnostic" });
    await assertRejects(() => h.attempt(3));
    assertEquals(h.state.sessions, 4);
    assertEquals(h.state.locks.length, 0);
  });
});

Deno.test("no-ready diagnostics retain the cause, redact secrets and cannot declare their own failure class", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    const token = "gh" + "p_" + "a".repeat(36);
    h.state.agents.push({
      response: `Required native engine missing; needs-human token=${token} ${
        "x".repeat(3000)
      }`,
    });
    const error = await assertRejects(() => h.attempt(), Error);
    assertStringIncludes(error.message, "Required native engine missing");
    assert(!error.message.includes(token));
    assert(error.message.length < 2200);
    const [record] = await records(stateDir);
    assertEquals(record!.blockerClass, "code");
    assertStringIncludes(
      record!.evidence![0]!,
      "Required native engine missing",
    );
    assertEquals(h.state.pushed, 0);
    assertEquals(h.state.dismissals, 0);
  });
});

Deno.test("conflict incidents stay paused after handoff even past the cooldown", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    h.state.pr = basePr({ mergeable: "CONFLICTING" });
    await saveBabysitterRetryState(
      stateDir,
      tracked({
        failureIdentity: "merge conflict",
        observedHead: HEAD,
        attempts: { infrastructure: 0, substantive: 3 },
        escalation: { issue: `${REPO}#900`, at: new Date().toISOString() },
        reconciliation: "repair-needed",
      }),
    );
    for (let i = 0; i < 4; i++) {
      await elapse(stateDir);
      await h.attempt();
    }
    assertEquals(h.state.sessions, 0);
    assertEquals(h.state.locks.length, 0);
    assertEquals((await records(stateDir))[0]!.attempts.substantive, 3);
  });
});

Deno.test("mirror fetch timeout is infrastructure", () => {
  assertEquals(
    classifyBabysitterGitFailure(
      ["fetch"],
      new Error(
        "git fetch failed: TIMEOUT: git fetch --no-auto-maintenance --prune /tmp/upstream timed out after 1800s (Issue #619)",
      ),
    ).blockerClass,
    "infrastructure",
  );
});

Deno.test("git transport outages and maintenance timeout do not spend repair attempts", async () => {
  const messages = [
    "fatal: unable to access 'https://github.com/o/r': The requested URL returned error: 502",
    "fatal: unable to access 'https://github.com/o/r': The requested URL returned error: 503",
    "fatal: unable to access 'https://github.com/o/r': The requested URL returned error: 429",
    "Connection closed by 192.0.2.1 port 22\nfatal: Could not read from remote repository.",
    "kex_exchange_identification: Connection closed by remote host",
    "ssh: connect to host github.com port 22: Operation timed out",
    "fatal: unable to access repository: LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443",
    "fetch-pack: unexpected disconnect while reading sideband packet\nfatal: early EOF",
    "fatal: early EOF\nfatal: index-pack failed",
    "HTTP/2 stream 1 was not closed cleanly before end of the underlying stream",
    "an unfamiliar download failure",
  ];
  for (const operation of ["clone", "fetch", "push"]) {
    for (const message of messages) {
      assertEquals(
        classifyBabysitterGitFailure([operation], new Error(message))
          .blockerClass,
        "infrastructure",
      );
    }
  }
  for (
    const message of [
      "! [rejected] HEAD -> x (fetch first)",
      "! [rejected] HEAD -> x (non-fast-forward)",
    ]
  ) {
    assertEquals(
      classifyBabysitterGitFailure(["push"], new Error(message)).blockerClass,
      "race",
    );
    await withState(async (stateDir) => {
      const h = harness(stateDir);
      h.state.changes = true;
      h.state.runFailures.push({ match: "git push", message });
      await assertRejects(() => h.attempt());
      const [record] = await records(stateDir);
      assertEquals(record!.blockerClass, "race");
      assertEquals(record!.attempts.substantive, 0);
      assertEquals(h.state.markers.length, 0);
    });
  }
  for (
    const message of [
      "! [remote rejected] HEAD -> x (pre-receive hook declined)",
      "remote: error: GH013: Repository rule violations found",
    ]
  ) {
    assertEquals(
      classifyBabysitterGitFailure(["push"], new Error(message)).blockerClass,
      "code",
    );
  }
  const timeout =
    "TIMEOUT: git -c maintenance.autoDetach=false -c gc.autoDetach=false maintenance run --auto timed out after 1800s (Issue #619)";
  assertEquals(
    classifyBabysitterGitFailure([
      "-c",
      "maintenance.autoDetach=false",
      "maintenance",
      "run",
      "--auto",
    ], new Error(timeout)).blockerClass,
    "infrastructure",
  );
  for (const message of [...messages, timeout]) {
    await withState(async (stateDir) => {
      const h = harness(stateDir);
      const mirrorRoot = `${stateDir}/mirrors`;
      await Deno.mkdir(`${mirrorRoot}/owner--repo.git`, { recursive: true });
      h.deps.clone = (repo, dir) =>
        cloneForRepair(repo, dir, {
          mirrorRoot,
          remoteUrl: () => Promise.resolve("/tmp/upstream"),
          runGit: (args) =>
            Promise.resolve(
              args.includes("maintenance") || !message.startsWith("TIMEOUT:")
                ? { success: false, stdout: "", stderr: message }
                : { success: true, stdout: "", stderr: "" },
            ),
        });
      await assertRejects(() => h.attempt());
      const [record] = await records(stateDir);
      assertEquals(record!.blockerClass, "infrastructure");
      assertEquals(record!.attempts.substantive, 0);
      assertEquals(h.state.markers.length, 0);
    });
  }
  for (const operation of ["fetch", "push"]) {
    for (const message of messages) {
      await withState(async (stateDir) => {
        const h = harness(stateDir);
        h.state.changes = true;
        h.state.runFailures.push({ match: `git ${operation}`, message });
        await assertRejects(() => h.attempt());
        const [record] = await records(stateDir);
        assertEquals(record!.blockerClass, "infrastructure");
        assertEquals(record!.attempts.substantive, 0);
        assertEquals(h.state.markers.length, 0);
      });
    }
  }
});

Deno.test("stale conflict defers until GitHub recomputes mergeability", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    h.state.pr = basePr({ mergeable: "CONFLICTING" });
    await h.attempt();
    const [record] = await records(stateDir);
    assertEquals(
      record!.nextAction,
      "recheck mergeability after GitHub recomputes",
    );
    assert(Date.parse(record!.nextEligibleAt!) > Date.now());
    assert(Date.parse(record!.nextEligibleAt!) <= Date.now() + 5 * 60_000);
    await h.attempt();
    assertEquals(h.state.sessions, 0);
    assertEquals(h.state.journalled, [{
      repo: REPO,
      prNumber: 1,
      headSha: HEAD,
    }]);
  });
});

Deno.test("an infrastructure failure journals one failed attempt at the observed head", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    h.state.agents.push({ code: 1 });
    await assertRejects(
      () => h.attempt(),
      Error,
      "exited with code 1",
    );
    const [record] = await records(stateDir);
    assertEquals(record!.observedHead, HEAD);
    assertEquals(h.state.journalled, [{
      repo: REPO,
      prNumber: 1,
      headSha: HEAD,
    }]);
  });
});

Deno.test("a code failure journals one failed attempt and keeps the repair's real error (Issue #4770)", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    h.state.agents.push({
      codeFailure: "agent exited unsuccessfully with code 1",
    });
    await assertRejects(
      () => h.attempt(),
      Error,
      "agent exited unsuccessfully with code 1",
    );
    const [record] = await records(stateDir);
    assertEquals(record!.blockerClass, "code");
    assertEquals(h.state.journalled, [{
      repo: REPO,
      prNumber: 1,
      headSha: HEAD,
    }]);
  });
});

Deno.test("a no-push review repair dismisses the review without journalling failure", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    h.state.pr = basePr({
      reviewDecision: "CHANGES_REQUESTED",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
    });
    h.state.agents.push({ proposal: "Rewritten description." });
    await h.attempt();
    assertEquals(h.state.dismissals, 1);
    assertEquals(h.state.journalled, []);
  });
});

/** A verifier that could not judge: the outage shape the production verifier returns. */
const verifierOutage = (
  input: ReviewVerificationInput,
): Promise<ReviewVerificationOutcome[]> =>
  Promise.resolve(
    input.reviews.map((review) => ({
      id: review.id,
      verified: false,
      reason: "verifier unavailable: Claude CLI not found",
      unavailable: true,
    })),
  );

const reviewsFixture = [{
  id: 10,
  state: "CHANGES_REQUESTED",
  user: { login: "reviewer" },
}] as never;

Deno.test("a no-change review repair with a verifier outage is an infrastructure wait that re-verifies without the agent (PR #4849 review)", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    h.state.pr = basePr({
      reviewDecision: "CHANGES_REQUESTED",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
    });
    h.state.agents.push({ proposal: "Rewritten description." });
    h.deps.verifyReviews = verifierOutage;
    await assertRejects(
      () => h.attempt(),
      Error,
      "the review verifier was unavailable",
    );
    const [record] = await records(stateDir);
    assertEquals(record!.blockerClass, "infrastructure");
    assertEquals(record!.attempts.substantive, 0);
    assertEquals(record!.attempts.infrastructure, 1);
    assertEquals(record!.escalation, undefined);
    assertStringIncludes(record!.lastOutcome ?? "", "Claude CLI not found");
    assertEquals(h.state.dismissals, 0);
    assertEquals(h.state.escalations, 0);
    assertEquals(h.state.journalled.length, 1);
    const store = pendingPublicationStore(stateDir, REPO, 1, reviewsFixture);
    assertEquals(await store.load(HEAD), {
      proposal: "Rewritten description.",
      pushed: false,
    });

    // The host recovers: the next scan re-verifies and dismisses; no new agent.
    h.deps.verifyReviews = allVerified;
    await elapse(stateDir);
    await h.attempt();
    assertEquals(h.state.sessions, 1);
    assertEquals(h.state.dismissals, 1);
    assertEquals(await store.load(HEAD), undefined);
  });
});

Deno.test("a verifier outage on a resumed publication keeps the record and backs off without the agent (PR #4849 review)", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    h.state.pr = basePr({
      reviewDecision: "CHANGES_REQUESTED",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
    });
    h.state.agents.push({ proposal: "Rewritten description." });
    h.deps.verifyReviews = verifierOutage;
    await assertRejects(() => h.attempt(), Error, "verifier was unavailable");
    await elapse(stateDir);
    await assertRejects(() => h.attempt(), Error, "verifier was unavailable");
    assertEquals(h.state.sessions, 1);
    const [record] = await records(stateDir);
    assertEquals(record!.attempts.infrastructure, 2);
    assertEquals(record!.attempts.substantive, 0);
    const store = pendingPublicationStore(stateDir, REPO, 1, reviewsFixture);
    assertEquals((await store.load(HEAD))?.proposal, "Rewritten description.");
  });
});

Deno.test("the production verifier fails closed when its read-only token cannot be minted (PR #4849 review)", async () => {
  const verify = readOnlyReviewVerifier(
    { ...APP, privateKeyPath: "/nonexistent/app-key.pem" },
    REPO,
    "/unused",
  );
  const outcomes = await verify({
    repo: REPO,
    prNumber: 1,
    repoPath: "/unused",
    title: "fix",
    body: "body",
    baseRef: "origin/main",
    reviews: [{
      id: 10,
      body: "**`a.ts:1`**: problem\n\n**Fix:** fix it",
    }],
    timeoutSeconds: 1,
    logger: createLogger(),
  });
  assertEquals(outcomes.map((o) => [o.id, o.verified, o.unavailable]), [[
    10,
    false,
    true,
  ]]);
});

Deno.test("a no-change review repair the verifier judges not fixed is journalled as a failed repair (PR #4849 review)", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    h.state.pr = basePr({
      reviewDecision: "CHANGES_REQUESTED",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
    });
    h.state.agents.push({ proposal: "Rewritten description." });
    h.deps.verifyReviews = (input) =>
      Promise.resolve(input.reviews.map((review) => ({
        id: review.id,
        verified: false,
        reason: 'finding 1 verdict "not fixed": still open',
      })));
    await h.attempt();
    assertEquals(h.state.dismissals, 0);
    assertEquals(h.state.journalled, [{
      repo: REPO,
      prNumber: 1,
      headSha: HEAD,
    }]);
    const [record] = await records(stateDir);
    assertEquals(record!.blockerClass, "code");
    const store = pendingPublicationStore(stateDir, REPO, 1, reviewsFixture);
    assertEquals(await store.load(HEAD), undefined);
  });
});

Deno.test("an agent that makes no change journals one failed attempt", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    await h.attempt();
    assertEquals(h.state.sessions, 1);
    assertEquals(h.state.pushed, 0);
    assertEquals(h.state.journalled, [{
      repo: REPO,
      prNumber: 1,
      headSha: HEAD,
    }]);
  });
});

Deno.test("an owner-class failure journals nothing, as it is already a needs-human wait", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    h.deps.mergeBase = () =>
      Promise.reject(new Error("needs-human label is set by the owner"));
    await assertRejects(
      () => h.attempt(),
      Error,
      "needs-human label is set by the owner",
    );
    const [record] = await records(stateDir);
    assertEquals(record!.blockerClass, "owner");
    assertEquals(h.state.journalled, []);
  });
});

Deno.test("a successful push journals nothing", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    h.state.changes = true;
    await h.attempt();
    assertEquals(h.state.pushed, 1);
    assertEquals(h.state.journalled, []);
  });
});

Deno.test("a failure after a confirmed push journals nothing", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    h.state.changes = true;
    h.deps.dismiss = () => Promise.reject(new Error("dismissal failed"));
    await assertRejects(() => h.attempt(), Error, "dismissal failed");
    assertEquals(h.state.pushed, 1);
    const [record] = await records(stateDir);
    assertEquals(record!.reconciliation, "waiting-for-ci-review");
    assertEquals(h.state.journalled, []);
  });
});

// Issue #4770: every repair runs in the worker container, with no host
// fallback. The tests below drive the real startBabysitterAgent (with fake
// container deps and a fake token exchange) through fix().

const OK_RUN = { success: true, code: 0, stderr: "", timedOut: false };

/**
 * The production startBabysitterAgent as fix()'s startAgent, with fake
 * container deps. The App is the test key, since the token mint signs with it.
 */
function productionAgent(
  privateKeyPath: string,
  container: Partial<BabysitterContainerDeps>,
  tokenLifetimeMs?: number,
): NonNullable<FixDeps["startAgent"]> {
  return (_app, repo, options, beforeSpawn) =>
    startBabysitterAgent(
      { appId: "1", installationId: "1", privateKeyPath },
      repo,
      {
        ...options,
        fetchFn: fakeTokenExchange(
          {
            permissions: BABYSITTER_AGENT_PERMISSIONS,
            ...(tokenLifetimeMs === undefined ? {} : {
              expires_at: new Date(Date.now() + tokenLifetimeMs).toISOString(),
            }),
          },
          [],
        ),
        container,
      },
      beforeSpawn,
    );
}

/** The host clone directory that a container spawn mounts at the clone mount. */
function cloneMountedBy(spawn: RuntimeSpawn): string {
  const suffix = `:${BABYSITTER_CLONE_MOUNT}`;
  const mount = spawn.args.find((arg) => arg.endsWith(suffix));
  if (mount === undefined) throw new Error("the spawn mounts no clone");
  return mount.slice(0, -suffix.length);
}

/** Container deps for an agent that finishes: it writes its final message to the clone. */
function answeringContainer(
  spawns: RuntimeSpawn[],
): Partial<BabysitterContainerDeps> {
  return fakeContainer(spawns, {
    onSpawn: async (spawn) => {
      await Deno.writeTextFile(
        `${cloneMountedBy(spawn)}/${BABYSITTER_CONTAINER_RESPONSE_FILE}`,
        "done\nBABYSITTER_READY\n",
      );
      return OK_RUN;
    },
  });
}

Deno.test("a repair starts only the container runtime with babysitter-repair, never codex, an agent or quality.sh (Issue #4770)", async () => {
  await withTestKey(async (privateKeyPath) => {
    const dirs = await repairDirs();
    try {
      const spawns: RuntimeSpawn[] = [];
      const started = await startBabysitterAgent(
        { appId: "1", installationId: "1", privateKeyPath },
        REPO,
        {
          ...dirs,
          prompt: "repair",
          fetchFn: fakeTokenExchange(
            { permissions: BABYSITTER_AGENT_PERMISSIONS },
            [],
          ),
          container: fakeContainer(spawns),
        },
        () => Promise.resolve(true),
      );
      assertEquals(started, true);
      assertEquals(spawns.length, 1);
      for (const spawn of spawns) {
        assertEquals(spawn.runtime, "podman");
        const text = `${spawn.runtime} ${spawn.args.join(" ")}`;
        assert(!/\bcodex\b|quality\.sh/.test(text), text);
      }
      assert(spawns[0]!.args.includes("babysitter-repair"));
    } finally {
      await Deno.remove(dirs.root, { recursive: true });
    }
  });
});

Deno.test("a token restart reuses the scratch: the real container repair runs twice on one scratch, and the snapshot is removed after each session (Issue #4770)", async () => {
  const host = repairHost();
  const dirs = await repairDirs();
  try {
    const spawns: RuntimeSpawn[] = [];
    const deps = fakeContainer(spawns, { host });
    const input = {
      baseDir: host.baseDir,
      clone: dirs.dir,
      scratch: dirs.scratch,
      privateKeyPath: `${host.root}/app-key.pem`,
      token: "ghs_restart_token",
    };
    await runBabysitterRepairContainer(input, deps);
    await runBabysitterRepairContainer(input, deps);
    assertEquals(spawns.length, 2);
    await assertRejects(
      () => Deno.stat(`${dirs.scratch}/workspace`),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(host.root, { recursive: true });
    await Deno.remove(dirs.root, { recursive: true });
  }
});

Deno.test("a missing container runtime or worker image stops the repair before any spawn, as a capability gap (Issue #4770)", async () => {
  const cases = [
    {
      container: { onPath: () => Promise.resolve(false) },
      message: "container runtime is not on PATH",
    },
    {
      container: { imageExists: () => Promise.resolve(false) },
      message: "the worker image is not built",
    },
    {
      container: {
        buildPlan: () =>
          Promise.reject(new ContainerRuntimeUnavailableError("linux", [])),
      },
      message: "No supported container runtime is available",
    },
  ] as const;
  for (const { container, message } of cases) {
    await withTestKey(async (privateKeyPath) => {
      await withState(async (stateDir) => {
        const h = harness(stateDir);
        h.state.changes = true;
        const spawns: RuntimeSpawn[] = [];
        h.deps.startAgent = productionAgent(privateKeyPath, {
          ...fakeContainer(spawns),
          ...container,
        });
        await assertRejects(() => h.attempt(), Error, message);
        const [record] = await records(stateDir);
        assertEquals(record!.blockerClass, "capability", message);
        assertEquals(spawns.length, 0, message);
        assertEquals(h.state.pushed, 0, message);
        assertEquals(h.state.committed, false, message);
      });
    });
  }
});

Deno.test("an egress startup failure aborts fix before any repair spawn or push (Issue #4770)", async () => {
  await withTestKey(async (privateKeyPath) => {
    await withState(async (stateDir) => {
      const h = harness(stateDir);
      h.state.changes = true;
      const spawns: RuntimeSpawn[] = [];
      const host = repairHost();
      try {
        const plan = await repairPlan(host, "egress-failure");
        plan.egressEnforced = true;
        h.deps.startAgent = productionAgent(privateKeyPath, {
          ...fakeContainer(spawns, { host }),
          buildPlan: () => Promise.resolve(plan),
          startSidecar: () =>
            Promise.reject(new Error("egress proxy startup failed")),
          stopSidecar: () => Promise.resolve([]),
        });
        await assertRejects(
          () => h.attempt(),
          Error,
          "egress proxy startup failed",
        );
        assertEquals(spawns.length, 0);
        assertEquals(h.state.pushed, 0);
        assertEquals(h.state.committed, false);
      } finally {
        await Deno.remove(host.root, { recursive: true });
      }
    });
  });
});

Deno.test("a non-zero container exit fails the repair with its code, stderr and the rebuild hint, and pushes nothing (Issue #4770)", async () => {
  await withTestKey(async (privateKeyPath) => {
    await withState(async (stateDir) => {
      const h = harness(stateDir);
      h.state.changes = true;
      const spawns: RuntimeSpawn[] = [];
      h.deps.startAgent = productionAgent(
        privateKeyPath,
        fakeContainer(spawns, {
          onSpawn: () =>
            Promise.resolve({
              success: false,
              code: 3,
              stderr: "boom",
              timedOut: false,
            }),
        }),
      );
      const error = await assertRejects(
        () => h.attempt(),
        Error,
        "exited with code 3",
      );
      assertStringIncludes(error.message, "boom");
      assertStringIncludes(error.message, "./run.sh");
      assertEquals(spawns.length, 1);
      assertEquals(h.state.pushed, 0);
      assertEquals(h.state.committed, false);
      const [record] = await records(stateDir);
      assertEquals(record!.blockerClass, "infrastructure");
    });
  });
});

Deno.test("the repair container gets no App key, host credential mount or GitHub App env, only the base env and GH_TOKEN (Issue #4770)", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  const dirs = await repairDirs();
  try {
    const home = `${root}/home`;
    const keyPath = `${home}/.vibe-coder/fleet-pr-babysitter.private-key.pem`;
    await Deno.mkdir(`${home}/.vibe-coder`, { recursive: true });
    await Deno.writeTextFile(keyPath, await generateTestKeyPem());
    // The host environment the process would see, including the App, gh and
    // SSH variables that the repair must never receive.
    const hostEnv: Record<string, string> = {
      PATH: "/usr/bin:/bin",
      HOME: home,
      USER: "vibe",
      LOGNAME: "vibe",
      TMPDIR: "/tmp",
      DOCKER_HOST: "unix:///var/run/docker.sock",
      XDG_RUNTIME_DIR: "/run/user/1000",
      CONTAINER_HOST: "unix:///run/podman.sock",
      GITHUB_APP_ID: "123",
      GITHUB_APP_INSTALLATION_ID: "456",
      GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
      GITHUB_TOKEN: "ghs_RUNNER_WRITE",
      GH_TOKEN: "ghs_RUNNER_WRITE",
      GH_CONFIG_DIR: `${home}/.config/gh`,
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      SSH_KEY_PATH: `${home}/.ssh/id_ed25519`,
      VIBE_AUDIT_DIR: `${home}/audit`,
    };
    const hostPaths = await babysitterHostCredentialPaths(
      `${home}/.config.json`,
      home,
      (name) => hostEnv[name],
    );
    const spawns: RuntimeSpawn[] = [];
    await startBabysitterAgent(
      { appId: "1", installationId: "1", privateKeyPath: keyPath },
      REPO,
      {
        ...dirs,
        prompt: "repair",
        fetchFn: fakeTokenExchange(
          { permissions: BABYSITTER_AGENT_PERMISSIONS },
          [],
        ),
        container: fakeContainer(spawns, {
          env: (name) => hostEnv[name],
          // The real plan mounts the gh credential directory read-only.
          extraRunArgs: [
            "--volume",
            `${home}/.vibe-coder/credentials/gh:/home/vibe/.vibe-coder/credentials/gh:ro`,
          ],
        }),
      },
      () => Promise.resolve(true),
    );
    assertEquals(spawns.length, 1);
    const [spawn] = spawns;
    const volumes: string[] = [];
    for (let i = 0; i < spawn!.args.length; i++) {
      if (spawn!.args[i] === "--volume") volumes.push(spawn!.args[i + 1]!);
    }
    assert(volumes.length > 0);
    const forbidden = [
      keyPath,
      `${home}/.vibe-coder`,
      `${home}/.config/gh`,
      ...hostPaths,
    ];
    for (const volume of volumes) {
      const parts = volume.split(":");
      const source = parts[0]!;
      const target = parts[1]!;
      for (const path of forbidden) {
        assert(
          source !== path && !source.startsWith(`${path}/`),
          `mount ${volume} exposes ${path}`,
        );
      }
      assert(
        !target.endsWith("/credentials/gh"),
        `mount ${volume} binds the gh credential directory`,
      );
    }
    assert(!spawn!.args.some((arg) => arg.includes(keyPath)));
    // The environment is the launcher's base allowlist plus the agent's token.
    assertEquals(Object.keys(spawn!.env).sort(), [
      "CONTAINER_HOST",
      "DOCKER_HOST",
      "GH_TOKEN",
      "HOME",
      "LOGNAME",
      "PATH",
      "TMPDIR",
      "USER",
      "XDG_RUNTIME_DIR",
    ]);
    assertEquals(spawn!.env.GH_TOKEN, "ghs_agent_token");
    for (
      const name of [
        "GITHUB_APP_ID",
        "GITHUB_APP_INSTALLATION_ID",
        "GITHUB_APP_PRIVATE_KEY_PATH",
        "GITHUB_TOKEN",
        "GH_CONFIG_DIR",
        "SSH_AUTH_SOCK",
        "SSH_KEY_PATH",
        "VIBE_AUDIT_DIR",
      ]
    ) {
      assert(!(name in spawn!.env), name);
      assert(
        !spawn!.args.some((arg) => arg === name || arg.startsWith(`${name}=`)),
        name,
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(dirs.root, { recursive: true });
  }
});

Deno.test("the repair container mounts the clone's .git read-only over the writable clone (PR #4941 review)", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  const dirs = await repairDirs();
  try {
    const keyPath = `${root}/key.pem`;
    await Deno.writeTextFile(keyPath, await generateTestKeyPem());
    const spawns: RuntimeSpawn[] = [];
    await startBabysitterAgent(
      { appId: "1", installationId: "1", privateKeyPath: keyPath },
      REPO,
      {
        ...dirs,
        prompt: "repair",
        fetchFn: fakeTokenExchange(
          { permissions: BABYSITTER_AGENT_PERMISSIONS },
          [],
        ),
        container: fakeContainer(spawns, {}),
      },
      () => Promise.resolve(true),
    );
    assertEquals(spawns.length, 1);
    const volumes: string[] = [];
    spawns[0]!.args.forEach((arg, i) => {
      if (spawns[0]!.args[i - 1] === "--volume") volumes.push(arg);
    });
    const clone = volumes.findIndex((v) =>
      v.endsWith(`:${BABYSITTER_CLONE_MOUNT}`)
    );
    assert(clone >= 0, "control: the clone itself is mounted writable");
    const hostClone = volumes[clone]!.slice(
      0,
      -`:${BABYSITTER_CLONE_MOUNT}`.length,
    );
    // The nested mount must follow the clone mount, or the runtime applies it first and the writable clone mount hides it.
    assertEquals(
      volumes.indexOf(`${hostClone}/.git:${BABYSITTER_CLONE_MOUNT}/.git:ro`),
      clone + 1,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(dirs.root, { recursive: true });
  }
});

Deno.test("the agent's final message is read from the clone into the exchange, and removed from the clone (Issue #4770)", async () => {
  await withTestKey(async (privateKeyPath) => {
    const dirs = await repairDirs();
    try {
      const spawns: RuntimeSpawn[] = [];
      const started = await startBabysitterAgent(
        { appId: "1", installationId: "1", privateKeyPath },
        REPO,
        {
          ...dirs,
          prompt: "repair",
          fetchFn: fakeTokenExchange(
            { permissions: BABYSITTER_AGENT_PERMISSIONS },
            [],
          ),
          container: fakeContainer(spawns, {
            onSpawn: async (spawn) => {
              await Deno.writeTextFile(
                `${
                  cloneMountedBy(spawn)
                }/${BABYSITTER_CONTAINER_RESPONSE_FILE}`,
                "Done.\nBABYSITTER_READY\n",
              );
              return OK_RUN;
            },
          }),
        },
        () => Promise.resolve(true),
      );
      assertEquals(started, true);
      assertEquals(
        await Deno.readTextFile(`${dirs.exchange}/${BABYSITTER_RESPONSE_FILE}`),
        "Done.\nBABYSITTER_READY\n",
      );
      assertEquals(
        await Deno.readTextFile(`${dirs.scratch}/prompt.md`),
        "repair",
      );
      await assertRejects(
        () => Deno.lstat(`${dirs.dir}/${BABYSITTER_CONTAINER_RESPONSE_FILE}`),
        Deno.errors.NotFound,
      );
    } finally {
      await Deno.remove(dirs.root, { recursive: true });
    }
  });
});

Deno.test("a completion response planted as a symlink is refused and removed from the clone, and nothing is read (Issue #4770)", async () => {
  await withTestKey(async (privateKeyPath) => {
    const dirs = await repairDirs();
    const secretRoot = await Deno.makeTempDir();
    try {
      const secret = `${secretRoot}/secret.txt`;
      await Deno.writeTextFile(secret, "SECRET-TOKEN-4770");
      const spawns: RuntimeSpawn[] = [];
      const error = await assertRejects(
        () =>
          startBabysitterAgent(
            { appId: "1", installationId: "1", privateKeyPath },
            REPO,
            {
              ...dirs,
              prompt: "repair",
              fetchFn: fakeTokenExchange(
                { permissions: BABYSITTER_AGENT_PERMISSIONS },
                [],
              ),
              container: fakeContainer(spawns, {
                onSpawn: async (spawn) => {
                  await Deno.symlink(
                    secret,
                    `${
                      cloneMountedBy(spawn)
                    }/${BABYSITTER_CONTAINER_RESPONSE_FILE}`,
                  );
                  return OK_RUN;
                },
              }),
            },
            () => Promise.resolve(true),
          ),
        Error,
        "refused unsafe agent output",
      );
      assert(!error.message.includes("SECRET-TOKEN-4770"));
      assert(!error.message.includes("did not write"));
      await assertRejects(
        () => Deno.lstat(`${dirs.dir}/${BABYSITTER_CONTAINER_RESPONSE_FILE}`),
        Deno.errors.NotFound,
      );
      assertEquals(
        await Deno.readTextFile(secret),
        "SECRET-TOKEN-4770",
        "the link target is untouched",
      );
    } finally {
      await Deno.remove(secretRoot, { recursive: true });
      await Deno.remove(dirs.root, { recursive: true });
    }
  });
});

Deno.test("a symlinked completion response stops the repair before any push (Issue #4770)", async () => {
  await withTestKey(async (privateKeyPath) => {
    await withState(async (stateDir) => {
      const h = harness(stateDir);
      h.state.changes = true;
      const spawns: RuntimeSpawn[] = [];
      h.deps.startAgent = productionAgent(
        privateKeyPath,
        fakeContainer(spawns, {
          onSpawn: async (spawn) => {
            await Deno.symlink(
              "/etc/hosts",
              `${cloneMountedBy(spawn)}/${BABYSITTER_CONTAINER_RESPONSE_FILE}`,
            );
            return OK_RUN;
          },
        }),
      );
      await assertRejects(
        () => h.attempt(),
        Error,
        "refused unsafe agent output",
      );
      assertEquals(h.state.pushed, 0);
      assertEquals(h.state.committed, false);
    });
  });
});

Deno.test("a repair whose container writes no completion response is reported as not written, and pushes nothing (Issue #4770)", async () => {
  await withTestKey(async (privateKeyPath) => {
    await withState(async (stateDir) => {
      const h = harness(stateDir);
      h.state.changes = true;
      const spawns: RuntimeSpawn[] = [];
      h.deps.startAgent = productionAgent(
        privateKeyPath,
        fakeContainer(spawns),
      );
      await assertRejects(
        () => h.attempt(),
        Error,
        "agent did not write its completion response",
      );
      assertEquals(spawns.length, 1);
      assertEquals(h.state.pushed, 0);
    });
  });
});

Deno.test("a lock renewal failure aborts the signal given to the agent before publication (Issue #4770)", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    h.state.changes = true;
    let onRenewalError: ((message: string) => void) | undefined;
    h.deps.startLockRenewal = (options) => {
      onRenewalError = options.onError;
      return { stop() {} };
    };
    let signal: AbortSignal | undefined;
    h.deps.startAgent = async (_app, _repo, options) => {
      signal = options.signal;
      assertEquals(signal?.aborted, false);
      onRenewalError!("Failed to renew PR lock comment 1 on owner/repo: down");
      assert(signal?.aborted === true, "the renewal failure aborts the agent");
      // What the container's kill looks like to the wrapper: a failed exit.
      throw new BabysitterFailure(
        "babysitter repair container vibe-babysitter-test exited with code 137",
        "infrastructure",
      );
    };
    await assertRejects(
      () => h.attempt(),
      BabysitterFailure,
      "PR lock renewal failed; agent stopped before publication",
    );
    assert(signal?.aborted === true);
    assertEquals(h.state.pushed, 0);
  });
});

Deno.test("a lock renewal failure kills the repair container, so the fix fails with the race failure (Issue #4770)", async () => {
  await withTestKey(async (privateKeyPath) => {
    await withState(async (stateDir) => {
      const h = harness(stateDir);
      h.state.changes = true;
      let onRenewalError: ((message: string) => void) | undefined;
      h.deps.startLockRenewal = (options) => {
        onRenewalError = options.onError;
        return { stop() {} };
      };
      const spawns: RuntimeSpawn[] = [];
      let markKilled!: () => void;
      const killed = new Promise<void>((resolve) => markKilled = resolve);
      const ok = { success: true, code: 0, stderr: "", timedOut: false };
      h.deps.startAgent = productionAgent(
        privateKeyPath,
        fakeContainer(spawns, {
          onSpawn: (spawn) => {
            if (spawn.args[0] === "kill") {
              markKilled();
              return Promise.resolve(ok);
            }
            // The repair runs until the renewal failure aborts it. The
            // fallback timer stops a missing kill from hanging the test.
            onRenewalError!(
              "Failed to renew PR lock comment 1 on owner/repo: down",
            );
            return new Promise((resolve) => {
              const timer = setTimeout(() => resolve(ok), 5_000);
              killed.then(() => {
                clearTimeout(timer);
                resolve({
                  success: false,
                  code: 137,
                  stderr: "",
                  timedOut: false,
                });
              });
            });
          },
        }),
      );
      await assertRejects(
        () => h.attempt(),
        BabysitterFailure,
        "PR lock renewal failed; agent stopped before publication",
      );
      const name = spawns[0]!.args[spawns[0]!.args.indexOf("--name") + 1];
      assert(
        spawns.some((spawn) =>
          spawn.args[0] === "kill" && spawn.args[1] === name
        ),
        `the abort kills the container by name: ${JSON.stringify(spawns)}`,
      );
      assertEquals(h.state.pushed, 0);
    });
  });
});

Deno.test("a successful repair runs no host quality.sh or codex (Issue #4770)", async () => {
  await withTestKey(async (privateKeyPath) => {
    await withState(async (stateDir) => {
      const h = harness(stateDir);
      h.state.changes = true;
      const spawns: RuntimeSpawn[] = [];
      h.deps.startAgent = productionAgent(
        privateKeyPath,
        answeringContainer(spawns),
      );
      await h.attempt();
      assertEquals(h.state.pushed, 1);
      assertEquals(spawns.map((spawn) => spawn.runtime), ["podman"]);
      const commands = [
        ...h.state.commands,
        ...spawns.map((spawn) => `${spawn.runtime} ${spawn.args.join(" ")}`),
      ];
      for (const command of commands) {
        assert(!command.includes("quality.sh"), command);
        assert(!/(^|[\s/])codex(\s|$)/.test(command), command);
      }
    });
  });
});

Deno.test("fix replaces agent-controlled git config before host publication (Issue #4770)", async () => {
  await withTestKey(async (privateKeyPath) => {
    await withState(async (stateDir) => {
      const h = harness(stateDir);
      h.state.changes = true;
      const spawns: RuntimeSpawn[] = [];
      h.deps.startAgent = productionAgent(
        privateKeyPath,
        answeringContainer(spawns),
      );
      let safeConfig = "";
      h.deps.resetGitConfig = async (dir, repo) => {
        await Deno.mkdir(`${dir}/.git`, { recursive: true });
        const configPath = `${dir}/.git/config`;
        await Deno.writeTextFile(
          configPath,
          "[core]\n\tsshCommand = /host/agent-command\n" +
            '[filter "owned"]\n\tclean = /host/agent-command\n' +
            "[diff]\n\texternal = /host/agent-command\n",
        );
        await resetRepairCloneGitConfig(dir, repo, {
          gh: () => Promise.resolve("https\n"),
        });
        safeConfig = await Deno.readTextFile(configPath);
      };
      await h.attempt();
      assert(
        safeConfig.includes("https://github.com/owner/repo.git"),
      );
      assert(!safeConfig.includes("/host/agent-command"));
      assertEquals(h.state.pushed, 1);
    });
  });
});

Deno.test("fix refuses a nested repository before finish runs host Git", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    const marker = `${stateDir}/nested-command`;
    h.deps.resetGitConfig = async (dir) => {
      await Deno.mkdir(`${dir}/nested/.git`, { recursive: true });
      await Deno.writeTextFile(
        `${dir}/nested/.git/config`,
        `[core]\n\tfsmonitor = touch ${marker}\n`,
      );
    };
    h.deps.assertTreeSafe = assertRepairTreeSafe;
    await assertRejects(() => h.attempt(), Error, "nested .git");
    assert(
      !h.state.commands.some((command) => command.includes("--porcelain")),
    );
    assertEquals(h.state.committed, false);
    assertEquals(h.state.pushed, 0);
    await assertRejects(() => Deno.stat(marker), Deno.errors.NotFound);
  });
});
