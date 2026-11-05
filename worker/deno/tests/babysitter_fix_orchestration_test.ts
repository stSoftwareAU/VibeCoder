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
  attemptKey,
  classifyBabysitterGitFailure,
  cloneForRepair,
  escalateStuckRepair,
  type EscalationRequest,
  fix,
  type FixDeps,
  forwardAgentStderr,
  observeTrackedPr,
  pendingPublicationStore,
  readSharedBabysitterAttempts,
  reconcileTrackedPr,
  repairFailureIdentity,
} from "../commands/fleet_pr_babysitter.ts";
import {
  babysitterRetryEligible,
  type BabysitterRetryRecord,
  listBabysitterRetryStates,
  saveBabysitterRetryState,
} from "../lib/babysitter_retry_state.ts";
import { loadConfig } from "../lib/config.ts";
import { acquireBranchUpdateLock } from "../lib/pr_branch_lock.ts";

const HEAD = "a".repeat(40);
const PUSHED = "b".repeat(40);
const REPO = "owner/repo";
const BOT = "babysitter[bot]";
const APP = { appId: "1", installationId: "1", privateKeyPath: "/unused" };

interface AgentScript {
  code?: number;
  stderr?: string;
  signal?: string | null;
  response?: string;
  expiresInMs?: number;
  elapsedMs?: number;
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
    reviewId: 10,
    editFailures: 0,
    dismissals: 0,
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
    if (!await beforeSpawn()) return undefined;
    state.sessions++;
    await script.setupScratch?.(agentOptions.scratch);
    if (script.proposal) {
      await Deno.writeTextFile(
        `${agentOptions.dir}/.babysitter-pr-body`,
        script.proposal,
      );
    }
    state.prompts.push(agentOptions.prompt);
    if ((script.code ?? 0) === 0) {
      await Deno.writeTextFile(
        agentOptions.responseFile,
        script.response ?? "done\nBABYSITTER_READY\n",
      );
    }
    if (script.elapsedMs) {
      const now = Date.now();
      Date.now = () => now + script.elapsedMs!;
    }
    return {
      stderr: new ReadableStream({
        start(controller) {
          if (script.stderr) {
            controller.enqueue(new TextEncoder().encode(script.stderr));
          }
          controller.close();
        },
      }),
      status: Promise.resolve({
        success: (script.code ?? 0) === 0,
        code: script.code ?? 0,
        signal: script.signal ?? null,
      }),
      kill() {},
    } as unknown as Deno.ChildProcess;
  };
  const deps: FixDeps = {
    stateDir,
    run,
    clone: () => Promise.resolve(),
    mergeBase: () => Promise.resolve({ kind: "current" }),
    // This harness mocks the checkout; real publication gates are exercised by
    // fleet_pr_babysitter_validation_test.ts (Issue #4625).
    validate: () =>
      Promise.resolve({ status: "passed", head: PUSHED, gate: "ran" }),
    dismiss: () => {
      state.dismissals++;
      return Promise.resolve();
    },
    armAutoMerge: () => Promise.resolve(),
    startAgent,
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
    await elapse(stateDir);
    await h.attempt();
    assertEquals(h.state.sessions, 1);
    assertEquals(h.state.pr.body, "Rewritten description.");
    assertEquals(h.state.dismissals, 1);
    assertEquals(await store.load(HEAD), undefined);
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
    h.state.agents.push({ code: 1, signal: "SIGKILL" });
    await assertRejects(
      () => h.attempt(),
      Error,
      "agent exited unsuccessfully",
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
      const child = await startAgent(...args);
      h.state.pr = basePr({ headRefOid: "d".repeat(40) }) as never;
      return child;
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
    h.state.agents.push({ code: 143, signal: "SIGTERM", expiresInMs: 60_000 });
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

Deno.test("a failed marker write keeps the retry record and the repair's real error", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir, { markerFails: true });
    h.state.agents.push({ code: 1, stderr: "task failed: invalid source" });
    await assertRejects(
      () => h.attempt(),
      Error,
      "agent exited unsuccessfully with code 1",
    );
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

Deno.test("agent stderr preserves the symlink target and reports authentication", async () => {
  await withState(async (stateDir) => {
    const target = `${stateDir}/target`;
    await Deno.mkdir(stateDir, { recursive: true });
    await Deno.writeTextFile(target, "unchanged");
    const h = harness(stateDir);
    h.state.agents.push({
      code: 1,
      stderr: "HTTP 401 unauthorized",
      setupScratch: (scratch) =>
        Deno.symlink(target, `${scratch}/codex-stderr`),
    });
    await assertRejects(() => h.attempt(), Error, "authentication");
    assertStringIncludes(
      (await records(stateDir))[0]!.lastOutcome,
      "authentication",
    );
    assertEquals(await Deno.readTextFile(target), "unchanged");
  });
});

Deno.test("agent stderr forwards all chunks and retains a bounded tail", async () => {
  const chunks = [
    new Uint8Array(70_000).fill(65),
    new TextEncoder().encode("end"),
  ];
  const forwarded: Uint8Array[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const tail = await forwardAgentStderr(stream, (chunk) => {
    forwarded.push(chunk);
    return Promise.resolve();
  });
  assertEquals(forwarded, chunks);
  assertEquals(tail.length, 65_536);
  assert(tail.endsWith("end"));
});

Deno.test("an empty agent diagnostic retries and a reported retry-after is honoured", async () => {
  for (const stderr of ["", "HTTP 429 rate limit retry-after: 300"]) {
    await withState(async (stateDir) => {
      const h = harness(stateDir);
      const before = Date.now();
      h.state.agents.push({ code: 1, stderr });
      await assertRejects(() => h.attempt());
      const [record] = await records(stateDir);
      assertEquals(record!.attempts.substantive, 0);
      assertEquals(record!.blockerClass, "infrastructure");
      assertEquals(h.state.markers.length, 0);
      assert(
        Date.parse(record!.nextEligibleAt!) >=
          before + (stderr ? 300_000 : 60_000),
      );
    });
  }
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

Deno.test("repair identity and legacy attempt names follow the newest review", () => {
  const review = (id: number) => ({
    id,
    state: "CHANGES_REQUESTED",
    user: { login: "r" },
  });
  assertEquals(repairFailureIdentity("failed CI", [review(9)]), "failed CI");
  assertEquals(
    repairFailureIdentity("requested review changes", [review(3), review(9)]),
    "requested review changes:9",
  );
  assertEquals(attemptKey(REPO, 1, HEAD, []), `owner--repo--1--${HEAD}`);
  assertEquals(
    attemptKey(REPO, 1, HEAD, [review(3), review(9)]),
    `owner--repo--1--${HEAD}--review-9`,
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

Deno.test("runner budget exhaustion is substantive and reaches escalation", async () => {
  const realNow = Date.now;
  try {
    await withState(async (stateDir) => {
      const h = harness(stateDir);
      for (let i = 0; i < 3; i++) {
        h.state.agents.push({
          code: 143,
          signal: "SIGTERM",
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

Deno.test("green review incidents stop sessions after handoff until a new review", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    h.state.pr = basePr({
      reviewDecision: "CHANGES_REQUESTED",
      statusCheckRollup: [{ conclusion: "SUCCESS", status: "COMPLETED" }],
    });
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
    h.state.agents.push({ response: "new review diagnostic" });
    await assertRejects(() => h.attempt(3));
    assertEquals(h.state.sessions, 4);
    assertEquals(h.state.locks.length, 0);
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
  });
});

Deno.test("fix asks for the repository gate on the committed head as a separate account, with the loaded configs and the PR's base (Issue #4625)", async () => {
  await withState(async (stateDir) => {
    const h = harness(stateDir);
    const configPath = `${stateDir}-config.json`;
    await Deno.writeTextFile(
      configPath,
      JSON.stringify({
        repos: [REPO],
        repo_config: { [REPO]: { quality_command: "./check.sh" } },
      }),
    );
    const expected = (await loadConfig(configPath)).repoConfig;
    assertEquals(expected?.[REPO]?.qualityCommand, "./check.sh");
    const requests: Array<Parameters<NonNullable<FixDeps["validate"]>>[0]> = [];
    h.deps.validate = (request) => {
      requests.push(request);
      return Promise.resolve({ status: "passed", head: PUSHED, gate: "ran" });
    };
    h.state.changes = true;
    await fix(
      REPO,
      basePr() as never,
      [BOT],
      BOT,
      APP,
      configPath,
      h.gh,
      () => Promise.resolve(),
      3,
      h.deps,
    );
    await Deno.remove(configPath);
    assertEquals(requests.length, 1);
    assertEquals(requests[0]!.repo, REPO);
    assertEquals(requests[0]!.repoConfigs, expected);
    assertEquals(requests[0]!.requireSeparateAccount, true);
    assertEquals(requests[0]!.baseRef, "origin/main");
    assertEquals(h.state.pushed, 1);
  });
});

Deno.test("a paused failed-CI repair is handed off as a handoff, not as the auto-fix cap (Issue #4625)", async () => {
  const writes: string[] = [];
  const comments: Array<Record<string, unknown>> = [];
  const request: EscalationRequest = {
    repo: REPO,
    prNumber: 1,
    failureIdentity: "failed CI",
    record: tracked({ evidence: ["line one"] }),
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
    pause: "the host cannot run the repository checks",
  };
  await escalateStuckRepair(request);
  assertEquals(writes.length, 1);
  assertStringIncludes(writes[0]!, "babysitter-handoff:");
  assert(!writes[0]!.includes("auto-fix-cap:"));
});
