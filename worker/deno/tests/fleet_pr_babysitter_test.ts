import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  enforceGhWriteAllowlist,
  isWriteRepoAllowed,
  isWriteRepoAllowlistActive,
  WriteRepoBlockedError,
} from "../lib/write_repo_allowlist.ts";
import {
  BABYSITTER_FILESYSTEM_KEY,
  BABYSITTER_PERMISSIONS_PROFILE,
  buildBabysitterSandboxArgs,
} from "../lib/fleet_babysitter_sandbox.ts";
import {
  babysitterRtkInstruction,
  behindRefreshSkip,
  behindUpdateHeld,
  buildRepairPrompt,
  cloneForRepair,
  eligibleAuthor,
  reason,
  recoverTemporaryClones,
  requestedReviews,
  runRepairs,
  spawnBabysitterAgent,
  validateAndCommit,
  waitForPushedHead,
  withBabysitterWriteScope,
} from "../commands/fleet_pr_babysitter.ts";

Deno.test("failed clone is attempted once and preserves its original error", async () => {
  let attempts = 0;
  const timeout = new Error("clone timed out");
  await assertRejects(
    () =>
      cloneForRepair("owner/repo", "/tmp/clone", () => {
        attempts++;
        return Promise.reject(timeout);
      }),
    Error,
    "clone timed out",
  );
  assertEquals(attempts, 1);
});

Deno.test("babysitter supplies RTK guidance only when its probe succeeds", async () => {
  const present: Parameters<typeof babysitterRtkInstruction>[0] = async () => ({
    ok: true,
    value: {
      success: true,
      code: 0,
      stdout: "rtk 1",
      stderr: "",
      timedOut: false,
    },
  });
  const absent: Parameters<typeof babysitterRtkInstruction>[0] = async () => ({
    ok: false,
    error: new Error("missing"),
  });
  const instructions = await babysitterRtkInstruction(present);
  assert(instructions.includes("each command in a chain"));
  assert(instructions.includes("rtk recall"));
  assertEquals(await babysitterRtkInstruction(absent), "");
});

const pr = {
  state: "OPEN",
  number: 1,
  title: "fix",
  author: { login: "fleet" },
  headRefName: "feature",
  headRefOid: "abc",
  baseRefName: "main",
  isCrossRepository: false,
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
};
Deno.test("author filter permits an explicit PR without widening fleet scans", () => {
  assert(eligibleAuthor("VibeCoderST", ["vibecoderst"], false));
  assert(!eligibleAuthor("human", ["VibeCoderST"], false));
  assert(eligibleAuthor("human", ["VibeCoderST"], true));
});

Deno.test("babysitter selects only conflicts and failed CI", () => {
  assertEquals(reason(pr), null);
  assertEquals(
    reason({
      ...pr,
      mergeStateStatus: "BEHIND",
      statusCheckRollup: [{ status: "IN_PROGRESS" }],
    }),
    null,
  );
  assertEquals(
    reason({
      ...pr,
      mergeStateStatus: "BEHIND",
      autoMergeRequest: {},
      reviewDecision: "APPROVED",
    }),
    "branch behind base",
  );
  assertEquals(
    reason({ ...pr, reviewDecision: "CHANGES_REQUESTED" }),
    "requested review changes",
  );
  assertEquals(reason({ ...pr, mergeable: "CONFLICTING" }), "merge conflict");
  assertEquals(
    reason({ ...pr, statusCheckRollup: [{ conclusion: "FAILURE" }] }),
    "failed CI",
  );
  assertEquals(
    reason({ ...pr, statusCheckRollup: [{ conclusion: "CANCELLED" }] }),
    null,
  );
  assertEquals(
    reason({ ...pr, state: "CLOSED", mergeable: "CONFLICTING" }),
    null,
  );
  assertEquals(
    reason({ ...pr, isDraft: true, mergeable: "CONFLICTING" }),
    null,
  );
  assertEquals(
    reason({ ...pr, isCrossRepository: true, mergeable: "CONFLICTING" }),
    null,
  );
  assertEquals(
    reason({ ...pr, statusCheckRollup: null, mergeable: "CONFLICTING" }),
    null,
  );
});

// Issue #4613: a behind PR is refreshed only when it is otherwise ready to merge.
Deno.test("a behind PR is refreshed only when armed and review-satisfied, whatever its checks say", () => {
  const behind = { ...pr, mergeStateStatus: "BEHIND" };
  const armed = { ...behind, autoMergeRequest: {} };
  // Not armed yet: left alone until it is.
  assertEquals(reason({ ...behind, reviewDecision: "APPROVED" }), null);
  // Armed but a review is still required.
  assertEquals(
    reason({ ...armed, reviewDecision: "REVIEW_REQUIRED" }),
    null,
  );
  // Armed and approved with a check running or queued: the rollup cannot say
  // whether it is required, so it does not hold the refresh.
  for (const check of [{ status: "IN_PROGRESS" }, { status: "QUEUED" }]) {
    assertEquals(
      reason({
        ...armed,
        reviewDecision: "APPROVED",
        statusCheckRollup: [check],
      }),
      "branch behind base",
    );
  }
  // A null request is not armed; a null decision needs no review.
  assertEquals(
    reason({ ...behind, autoMergeRequest: null, reviewDecision: "APPROVED" }),
    null,
  );
  assertEquals(
    reason({ ...armed, reviewDecision: null }),
    "branch behind base",
  );
  // Armed and approved but not behind: nothing to refresh.
  assertEquals(
    reason({ ...armed, mergeStateStatus: "CLEAN", reviewDecision: "APPROVED" }),
    null,
  );
  // Armed and no review required.
  assertEquals(reason({ ...armed, reviewDecision: "" }), "branch behind base");
});

const readyInFlight = {
  ...pr,
  number: 2,
  mergeStateStatus: "CLEAN",
  autoMergeRequest: {},
  reviewDecision: "APPROVED",
};
const behindCandidate = {
  ...pr,
  number: 1,
  mergeStateStatus: "BEHIND",
  autoMergeRequest: {},
  reviewDecision: "APPROVED",
};

Deno.test("behind PR waits for an armed, up-to-date PR on its base that is in flight", () => {
  assertEquals(
    behindUpdateHeld(behindCandidate, [behindCandidate, readyInFlight]),
    2,
  );
  // A check still running, or no review required, keeps it in flight.
  assertEquals(
    behindUpdateHeld(behindCandidate, [
      behindCandidate,
      { ...readyInFlight, statusCheckRollup: [{ status: "IN_PROGRESS" }] },
    ]),
    2,
  );
  assertEquals(
    behindUpdateHeld(behindCandidate, [
      behindCandidate,
      { ...readyInFlight, reviewDecision: "" },
    ]),
    2,
  );
});

Deno.test("behindUpdateHeld ignores PRs on other bases", () => {
  assertEquals(
    behindUpdateHeld(behindCandidate, [
      behindCandidate,
      { ...readyInFlight, baseRefName: "release" },
    ]),
    null,
  );
});

Deno.test("behindUpdateHeld ignores drafts, needs-human PRs and the PR itself", () => {
  assertEquals(
    behindUpdateHeld(behindCandidate, [
      behindCandidate,
      { ...readyInFlight, isDraft: true },
    ]),
    null,
  );
  assertEquals(
    behindUpdateHeld(behindCandidate, [
      behindCandidate,
      { ...readyInFlight, labels: [{ name: "needs-human" }] },
    ]),
    null,
  );
  assertEquals(behindUpdateHeld(behindCandidate, [behindCandidate]), null);
  // The PR itself is never its own blocker, even when it would qualify.
  assertEquals(behindUpdateHeld(readyInFlight, [readyInFlight]), null);
  assertEquals(
    behindUpdateHeld(behindCandidate, [
      behindCandidate,
      { ...readyInFlight, state: "CLOSED" },
    ]),
    null,
  );
  assertEquals(
    behindUpdateHeld(behindCandidate, [
      behindCandidate,
      { ...readyInFlight, mergeable: "CONFLICTING" },
    ]),
    null,
  );
});

Deno.test("behindUpdateHeld ignores PRs awaiting review or arming", () => {
  assertEquals(
    behindUpdateHeld(behindCandidate, [
      behindCandidate,
      { ...readyInFlight, reviewDecision: "REVIEW_REQUIRED" },
    ]),
    null,
  );
  assertEquals(
    behindUpdateHeld(behindCandidate, [
      behindCandidate,
      { ...readyInFlight, autoMergeRequest: undefined },
    ]),
    null,
  );
});

Deno.test("behindUpdateHeld ignores PRs with failed checks or that are themselves behind", () => {
  assertEquals(
    behindUpdateHeld(behindCandidate, [
      behindCandidate,
      { ...readyInFlight, statusCheckRollup: [{ conclusion: "FAILURE" }] },
    ]),
    null,
  );
  assertEquals(
    behindUpdateHeld(behindCandidate, [
      behindCandidate,
      { ...readyInFlight, mergeStateStatus: "BEHIND" },
    ]),
    null,
  );
});

Deno.test("behindRefreshSkip holds a behind PR for an in-flight PR and queues one per base", () => {
  const queued = new Set<string>();
  const behindToo = { ...behindCandidate, number: 3 };
  // A repair that is not a behind refresh is never skipped, nor queued.
  assertEquals(
    behindRefreshSkip(
      "o/r",
      behindCandidate,
      "failed CI",
      [readyInFlight],
      queued,
    ),
    null,
  );
  assertEquals(queued.size, 0);
  // Held by the in-flight PR #2; nothing is queued.
  const held = behindRefreshSkip(
    "o/r",
    behindCandidate,
    "branch behind base",
    [behindCandidate, readyInFlight],
    queued,
  );
  assertStringIncludes(held ?? "", "#2 on main is ready");
  assertEquals(queued.size, 0);
  // Nothing in flight: the first goes ahead and takes the base ...
  const prs = [behindCandidate, behindToo];
  assertEquals(
    behindRefreshSkip(
      "o/r",
      behindCandidate,
      "branch behind base",
      prs,
      queued,
    ),
    null,
  );
  assertEquals([...queued], ["o/r#main"]);
  // ... so the second waits for the next pass.
  const second = behindRefreshSkip(
    "o/r",
    behindToo,
    "branch behind base",
    prs,
    queued,
  );
  assertStringIncludes(second ?? "", "already has a branch update queued");
  // Another repository's base is separate.
  assertEquals(
    behindRefreshSkip("o/other", behindToo, "branch behind base", prs, queued),
    null,
  );
});

Deno.test("cleanup removes abandoned clones but preserves live and unrelated directories", async () => {
  const root = await Deno.makeTempDir();
  try {
    const dead = `${root}/fleet-pr-babysitter-99999999-abcdef`;
    const live = `${root}/fleet-pr-babysitter-${Deno.pid}-abcdef`;
    const unrelated = `${root}/fleet-pr-babysitter-unrelated`;
    for (const path of [dead, live, unrelated]) await Deno.mkdir(path);
    await recoverTemporaryClones(root);
    const names = (await Array.fromAsync(Deno.readDir(root))).map((entry) =>
      entry.name
    );
    assertEquals(
      names.sort(),
      [
        `fleet-pr-babysitter-${Deno.pid}-abcdef`,
        "fleet-pr-babysitter-unrelated",
      ].sort(),
    );
    assert((await Deno.stat(live)).isDirectory);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("babysitter stages resolved merge files and refuses conflict markers", async () => {
  const dir = await Deno.makeTempDir();
  const git = async (...args: string[]) =>
    await new Deno.Command("git", {
      args,
      cwd: dir,
      stdout: "null",
      stderr: "null",
    }).output();
  try {
    assert((await git("init")).success);
    assert((await git("config", "user.name", "Test")).success);
    assert((await git("config", "user.email", "test@example.invalid")).success);
    await Deno.writeTextFile(`${dir}/file.txt`, "original\n");
    assert((await git("add", ".")).success);
    assert((await git("commit", "-m", "initial")).success);
    assert((await git("checkout", "-b", "other")).success);
    await Deno.writeTextFile(`${dir}/file.txt`, "other\n");
    assert((await git("commit", "-am", "other")).success);
    assert((await git("checkout", "-")).success);
    await Deno.writeTextFile(`${dir}/file.txt`, "feature\n");
    assert((await git("commit", "-am", "feature")).success);
    assert(!(await git("merge", "--no-commit", "other")).success);
    await assertRejects(
      () =>
        validateAndCommit(dir, 123, { login: "test-app[bot]", id: "12345" }),
      Error,
      "git failed",
    );
    await Deno.writeTextFile(`${dir}/file.txt`, "feature and other\n");
    await validateAndCommit(dir, 123, { login: "test-app[bot]", id: "12345" });
    assert((await git("diff", "--quiet", "HEAD")).success);
    assert((await git("rev-parse", "HEAD^2")).success);
    const author = await new Deno.Command("git", {
      args: ["show", "-s", "--format=%an <%ae>", "HEAD"],
      cwd: dir,
    }).output();
    assertEquals(
      new TextDecoder().decode(author.stdout).trim(),
      "test-app[bot] <12345+test-app[bot]@users.noreply.github.com>",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repairs run in parallel within the limit and failures do not block others", async () => {
  let active = 0;
  let peak = 0;
  const completed: number[] = [];
  const tasks = [0, 1, 2].map((id) => ({
    key: String(id),
    version: "head",
    run: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      completed.push(id);
      if (id === 0) throw new Error("repair failed");
    },
  }));
  await assertRejects(() => runRepairs(tasks, 2), AggregateError);
  assertEquals(peak, 2);
  assertEquals(completed.sort(), [0, 1, 2]);
});

Deno.test("only each reviewer's current changes request remains actionable", () => {
  assertEquals(
    requestedReviews([
      { id: 1, state: "CHANGES_REQUESTED", user: { login: "alice" } },
      { id: 2, state: "COMMENTED", user: { login: "alice" } },
      { id: 3, state: "CHANGES_REQUESTED", user: { login: "bob" } },
      { id: 4, state: "APPROVED", user: { login: "BOB" } },
    ]).map((review) => review.id),
    [1],
  );
});

Deno.test("long repairs do not prevent new PR discovery", async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => release = resolve);
  const completed: string[] = [];
  let scans = 0;
  const first = {
    key: "one",
    version: "a",
    run: async () => {
      await waiting;
      completed.push("one");
    },
  };
  const second = {
    key: "two",
    version: "a",
    run: async () => {
      completed.push("two");
      release();
    },
  };
  await runRepairs([first], 2, () => {
    scans++;
    return Promise.resolve([first, second]);
  }, 5);
  assertEquals(completed, ["two", "one"]);
  assertEquals(scans, 1);
});

Deno.test("review dismissal waits for GitHub to report the pushed head", async () => {
  let reads = 0;
  assertEquals(
    await waitForPushedHead(
      () => Promise.resolve(++reads < 3 ? "old" : "new"),
      "new",
      4,
      1,
    ),
    true,
  );
  assertEquals(
    await waitForPushedHead(() => Promise.resolve("other"), "new", 2, 1),
    false,
  );
});

Deno.test("parallel babysitter repairs restrict writes to their own repository", async () => {
  const results = await Promise.all(
    ["org/one", "org/two"].map((repo) =>
      withBabysitterWriteScope(repo, async () => {
        await Promise.resolve();
        assert(isWriteRepoAllowlistActive());
        assert(isWriteRepoAllowed(repo));
        assert(!isWriteRepoAllowed(repo === "org/one" ? "org/two" : "org/one"));
        await enforceGhWriteAllowlist([
          "api",
          "-X",
          "POST",
          `repos/${repo}/issues/1/comments`,
          "-f",
          "body=lock",
        ]);
        await assertRejects(() =>
          enforceGhWriteAllowlist([
            "api",
            "-X",
            "PUT",
            "repos/org/unrelated/pulls/1/update-branch",
          ]), WriteRepoBlockedError);
        return repo;
      })
    ),
  );
  assertEquals(results, ["org/one", "org/two"]);
});

Deno.test("codex agent gets its own read-only token instead of the runner's GH_TOKEN", () => {
  const runnerToken = "runner-write-token";
  const agentToken = "agent-read-only-token";
  const scratch = "/tmp/babysitter-scratch";
  const dir = "/tmp/babysitter-clone";
  const prompt = "Fix conflicts on PR #1";
  const protectedPaths = [
    "/home/u/.vibe-coder/fleet-pr-babysitter",
    "/home/u/.vibe-coder/fleet-pr-babysitter.private-key.pem",
  ];
  const calls: {
    executable: string;
    options: Deno.CommandOptions & { timeoutMs: number };
  }[] = [];
  spawnBabysitterAgent(
    { dir, scratch, prompt, agentToken, protectedPaths },
    (executable, options) => {
      calls.push({ executable, options });
      return {} as unknown as Deno.ChildProcess;
    },
  );
  const [call] = calls;
  assert(call);
  assertEquals(call.executable, "codex");
  const env = call.options.env as Record<string, string>;
  assertEquals(env.GH_TOKEN, agentToken);
  assert(env.GH_TOKEN !== runnerToken);
  assertEquals(env, {
    TMPDIR: scratch,
    XDG_CACHE_HOME: scratch,
    GH_TOKEN: agentToken,
  });
  assertEquals(call.options.timeoutMs, 90 * 60_000);
  assertEquals(call.options.args, [
    "exec",
    "-c",
    'approval_policy="never"',
    ...buildBabysitterSandboxArgs({ dir, scratch, protectedPaths }),
    "--cd",
    dir,
    "--output-last-message",
    `${dir}/.babysitter-response`,
    prompt,
  ]);
  assertEquals(call.options.stdin, "null");
  assertEquals(call.options.stdout, "inherit");
  assertEquals(call.options.stderr, "inherit");
});

Deno.test("codex agent is not given the workspace-write sandbox and cannot read the credential paths", () => {
  const keyPath = "/home/u/.vibe-coder/fleet-pr-babysitter.private-key.pem";
  const protectedPaths = [
    "/home/u/.vibe-coder/fleet-pr-babysitter",
    keyPath,
  ];
  const calls: string[][] = [];
  spawnBabysitterAgent(
    {
      dir: "/tmp/babysitter-clone",
      scratch: "/tmp/babysitter-scratch",
      prompt: "Fix conflicts on PR #1",
      agentToken: "agent-read-only-token",
      protectedPaths,
    },
    (_executable, options) => {
      calls.push(options.args as string[]);
      return {} as unknown as Deno.ChildProcess;
    },
  );
  const [args] = calls;
  assert(args);
  assert(!args.includes("--sandbox"));
  assert(!args.includes("workspace-write"));
  assert(
    args.includes(`default_permissions="${BABYSITTER_PERMISSIONS_PROFILE}"`),
  );
  for (const path of protectedPaths) {
    assert(
      args.some((arg) =>
        arg.startsWith(`${BABYSITTER_FILESYSTEM_KEY}={ `) &&
        arg.includes(`${JSON.stringify(path)} = "none"`)
      ),
      `missing none override for ${path}`,
    );
    assert(
      !args.some((arg) =>
        arg.includes(`${JSON.stringify(path)} = "read"`) ||
        arg.includes(`${JSON.stringify(path)} = "write"`)
      ),
      `credential path ${path} is readable or writable`,
    );
  }
  assert(protectedPaths.includes(keyPath));
});

Deno.test("codex agent refuses to start without protected credential paths", () => {
  let spawned = false;
  assertThrows(
    () =>
      spawnBabysitterAgent(
        {
          dir: "/tmp/babysitter-clone",
          scratch: "/tmp/babysitter-scratch",
          prompt: "Fix conflicts on PR #1",
          agentToken: "agent-read-only-token",
          protectedPaths: [],
        },
        () => {
          spawned = true;
          return {} as unknown as Deno.ChildProcess;
        },
      ),
    Error,
  );
  assertEquals(spawned, false);
});

// Shift left (Issue #4610): a babysitter push that CI then rejects costs a CI
// run and another repair. Every repair re-runs the relevant local checks
// before it reports ready.
Deno.test("a CI repair must reproduce the failing step locally and see it pass before reporting ready", () => {
  const prompt = buildRepairPrompt("failed CI", 5016, "owner/repo", "");
  assertStringIncludes(prompt, "same command the workflow runs");
  assertStringIncludes(prompt, "confirm it passes before");
  assertStringIncludes(prompt, "quality.sh");
  assert(!prompt.includes("GitHub CI runs those checks"));
});

Deno.test("a review repair runs the local checks covering the changed files", () => {
  const prompt = buildRepairPrompt(
    "requested review changes",
    1,
    "owner/repo",
    "",
  );
  assertStringIncludes(prompt, "formatter, linter, type or compile check");
  assertStringIncludes(prompt, "confirm they pass before");
});

Deno.test("a conflict repair still checks the packages it touched, not the whole suite", () => {
  const prompt = buildRepairPrompt("merge conflict", 1, "owner/repo", "");
  assertStringIncludes(prompt, "formatter, linter, type or compile check");
  assertStringIncludes(prompt, "full regression suite");
  assertStringIncludes(prompt, "BABYSITTER_READY");
});

// Owner rule 2026-11-01: the babysitter honours needs-human.
Deno.test("a PR labelled needs-human is never a babysitter candidate", () => {
  const pr = {
    state: "OPEN",
    number: 1,
    title: "t",
    author: { login: "fleet" },
    headRefName: "h",
    headRefOid: "a",
    baseRefName: "main",
    isCrossRepository: false,
    isDraft: false,
    mergeable: "CONFLICTING",
    mergeStateStatus: "DIRTY",
    reviewDecision: null,
    statusCheckRollup: [{ conclusion: "FAILURE" }],
    labels: [{ name: "needs-human" }],
  };
  assertEquals(reason(pr), null);
  assertEquals(reason({ ...pr, labels: [] }), "merge conflict");
});
