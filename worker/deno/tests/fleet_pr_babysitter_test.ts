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
import { createLogger } from "../lib/logger.ts";
import { type SyncPrBodyDeps } from "../lib/pr_body_sync.ts";
import { runGitCommand } from "../lib/git_timeout.ts";
import { buildIdempotencyMarker } from "../lib/pr_body.ts";
import {
  BABYSITTER_FILESYSTEM_KEY,
  BABYSITTER_PERMISSIONS_PROFILE,
  buildBabysitterSandboxArgs,
} from "../lib/fleet_babysitter_sandbox.ts";
import {
  babysitterRtkInstruction,
  buildRepairPrompt,
  cloneForRepair,
  eligibleAuthor,
  finishBabysitterRepair,
  reason,
  recoverTemporaryClones,
  requestedReviews,
  runRepairs,
  spawnBabysitterAgent,
  syncBabysitterPrBodyBeforeDismissal,
  validateAndCommit,
  waitForPushedHead,
  withBabysitterWriteScope,
} from "../commands/fleet_pr_babysitter.ts";

const syncLogger = createLogger({
  host: "fleet-pr-babysitter-test",
  write: () => {},
});

async function runGit(cwd: string, ...args: string[]): Promise<string> {
  const result = await runGitCommand(args, { cwd, timeoutSeconds: 10 });
  if (!result.ok) throw result.error;
  if (result.value.code !== 0) {
    throw new Error(result.value.stderr || result.value.stdout);
  }
  return result.value.stdout.trim();
}

async function makeBabysitterSyncFixture(): Promise<{
  path: string;
  beforeSha: string;
  headSha: string;
}> {
  const path = await Deno.makeTempDir({ prefix: "babysitter-pr-body-" });
  await runGit(path, "init", "-q");
  await runGit(path, "config", "user.name", "test");
  await runGit(path, "config", "user.email", "test@example.invalid");
  await Deno.mkdir(`${path}/docs/archive/pr-summaries`, { recursive: true });
  const summaryPath = `${path}/docs/archive/pr-summaries/pr-summary-4637.md`;
  await Deno.writeTextFile(
    summaryPath,
    "## Summary\n\nOld summary. Part of #4637.\n",
  );
  await runGit(path, "add", ".");
  await runGit(path, "commit", "-m", "old summary");
  const beforeSha = await runGit(path, "rev-parse", "HEAD");
  await Deno.writeTextFile(
    summaryPath,
    "## Summary\n\nRepaired summary. Closes #4637.\n",
  );
  await runGit(path, "add", ".");
  await runGit(path, "commit", "-m", "repair summary");
  const headSha = await runGit(path, "rev-parse", "HEAD");
  return { path, beforeSha, headSha };
}

function fakePrBodyService(
  options: {
    headSha: string;
    branch?: string;
    body: string;
    failEdit?: boolean;
    onEdit?: () => void;
  },
): { deps: SyncPrBodyDeps; getBody: () => string; edits: () => number } {
  let body = options.body;
  let editCount = 0;
  const deps: SyncPrBodyDeps = {
    runGhCommand: async (args) => {
      if (args[0] === "pr" && args[1] === "view") {
        return JSON.stringify({
          body,
          files: [
            { path: "docs/archive/pr-summaries/pr-summary-4637.md" },
          ],
          headRefOid: options.headSha,
          headRefName: options.branch ?? "issue-4637-review-fix",
        });
      }
      if (args[0] === "pr" && args[1] === "edit") {
        editCount++;
        if (options.failEdit) {
          throw new Error("simulated body publication failure");
        }
        const bodyFile = args[args.indexOf("--body-file") + 1];
        if (!bodyFile) throw new Error("missing --body-file");
        body = await Deno.readTextFile(bodyFile);
        options.onEdit?.();
        return "";
      }
      throw new Error(`unexpected gh command: ${args.join(" ")}`);
    },
    runGitCommand,
    logger: syncLogger,
  };
  return { deps, getBody: () => body, edits: () => editCount };
}

function babysitterBodySyncInput(
  path: string,
  beforeSha: string,
  branchName = "issue-4637-review-fix",
) {
  return {
    repo: "owner/repo",
    prNumber: 7,
    repoPath: path,
    beforeSha,
    workerName: "babysitter[bot]",
    githubUser: "babysitter[bot]",
    runId: "test-run",
    branchName,
  };
}

function cleanTreeFinishDeps(
  headSha: string,
  service: ReturnType<typeof fakePrBodyService>,
  dismiss: () => Promise<void>,
) {
  return {
    renewalFailed: () => false,
    runCommand: async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "status") return "";
      if (command === "git" && args[0] === "rev-parse") return headSha;
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    },
    syncBodyDeps: service.deps,
    dismiss,
  };
}

const staleMarkerlessBody = "## Summary\n\nOld summary. Part of #4637.\n";

async function cleanupFixture(path: string): Promise<void> {
  await Deno.remove(path, { recursive: true });
}

Deno.test("a clean-tree babysitter retry repairs a marker-less stale body before dismissal", async () => {
  const fixture = await makeBabysitterSyncFixture();
  try {
    const service = fakePrBodyService({
      headSha: fixture.headSha,
      body: staleMarkerlessBody,
    });
    let dismissed = false;
    await syncBabysitterPrBodyBeforeDismissal(
      babysitterBodySyncInput(fixture.path, fixture.beforeSha),
      service.deps,
      () => {
        dismissed = true;
        return Promise.resolve();
      },
    );
    assertEquals(service.edits(), 1);
    assertStringIncludes(service.getBody(), "Repaired summary.");
    assertStringIncludes(service.getBody(), "Closes #4637");
    assertEquals(service.getBody().includes("Part of #4637"), false);
    assertEquals(dismissed, true);
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("the production clean-tree completion path syncs before review dismissal", async () => {
  const fixture = await makeBabysitterSyncFixture();
  try {
    const events: string[] = [];
    const service = fakePrBodyService({
      headSha: fixture.headSha,
      body: staleMarkerlessBody,
      onEdit: () => events.push("publish"),
    });
    await finishBabysitterRepair(
      "owner/repo",
      {
        ...pr,
        number: 7,
        headRefName: "issue-4637-review-fix",
        headRefOid: fixture.headSha,
      },
      fixture.path,
      "babysitter[bot]",
      [{ id: 1, state: "CHANGES_REQUESTED", user: { login: "reviewer" } }],
      cleanTreeFinishDeps(fixture.headSha, service, () => {
        events.push("dismiss");
        return Promise.resolve();
      }),
    );
    assertEquals(service.edits(), 1);
    assertEquals(events, ["publish", "dismiss"]);
    assertStringIncludes(service.getBody(), "Closes #4637");
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("a pushed fix syncs the legacy body from its original head before dismissal", async () => {
  const fixture = await makeBabysitterSyncFixture();
  try {
    const events: string[] = [];
    const service = fakePrBodyService({
      headSha: fixture.headSha,
      branch: "issue-4637-review-fix",
      body: `${staleMarkerlessBody}\n${buildIdempotencyMarker(4637)}`,
      onEdit: () => events.push("publish"),
    });
    const repairPr = {
      ...pr,
      number: 7,
      headRefName: "issue-4637-review-fix",
      headRefOid: fixture.beforeSha,
      reviewDecision: "CHANGES_REQUESTED",
    };
    const pushArgs: string[][] = [];
    await finishBabysitterRepair(
      "owner/repo",
      repairPr,
      fixture.path,
      "babysitter[bot]",
      [{ id: 1, state: "CHANGES_REQUESTED", user: { login: "reviewer" } }],
      {
        renewalFailed: () => false,
        runCommand: async (command, args) => {
          if (command === "git" && args[0] === "status") return " M summary";
          if (command === "git" && args[0] === "diff") return "";
          if (command === "gh" && args[0] === "api") return "12345";
          if (command === "git" && args[0] === "push") {
            pushArgs.push(args);
            events.push("push");
            return "";
          }
          if (command === "git" && args[0] === "rev-parse") {
            return fixture.headSha;
          }
          throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
        },
        readPr: async () => repairPr,
        validateAndCommit: async () => {
          events.push("commit");
        },
        syncBodyDeps: service.deps,
        dismiss: async () => {
          events.push("dismiss");
        },
      },
    );
    assertEquals(events, ["commit", "push", "publish", "dismiss"]);
    assert(pushArgs[0]?.some((arg) => arg.includes("issue-4637-review-fix")));
    assertStringIncludes(service.getBody(), "Closes #4637");
    assertEquals(service.getBody().includes("Part of #4637"), false);
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("a failed body publication keeps reviews open and a retry publishes before dismissal", async () => {
  const fixture = await makeBabysitterSyncFixture();
  try {
    const serviceOptions = {
      headSha: fixture.headSha,
      body: staleMarkerlessBody,
      failEdit: true,
    };
    const service = fakePrBodyService(serviceOptions);
    let dismissed = false;
    const repairPr = {
      ...pr,
      number: 7,
      headRefName: "issue-4637-review-fix",
      headRefOid: fixture.headSha,
    };
    await assertRejects(
      () =>
        finishBabysitterRepair(
          "owner/repo",
          repairPr,
          fixture.path,
          "babysitter[bot]",
          [{ id: 1, state: "CHANGES_REQUESTED", user: { login: "reviewer" } }],
          cleanTreeFinishDeps(fixture.headSha, service, () => {
            dismissed = true;
            return Promise.resolve();
          }),
        ),
      Error,
      "simulated body publication failure",
    );
    assertEquals(dismissed, false);
    assertEquals(service.getBody(), staleMarkerlessBody);

    serviceOptions.failEdit = false;
    await finishBabysitterRepair(
      "owner/repo",
      repairPr,
      fixture.path,
      "babysitter[bot]",
      [{ id: 1, state: "CHANGES_REQUESTED", user: { login: "reviewer" } }],
      cleanTreeFinishDeps(fixture.headSha, service, () => {
        dismissed = true;
        return Promise.resolve();
      }),
    );
    assertEquals(service.edits(), 2);
    assertStringIncludes(service.getBody(), "Closes #4637");
    assertEquals(dismissed, true);
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("an already-current PR body is harmless and does not need a second edit", async () => {
  const fixture = await makeBabysitterSyncFixture();
  try {
    const service = fakePrBodyService({
      headSha: fixture.headSha,
      body: staleMarkerlessBody,
    });
    const input = babysitterBodySyncInput(fixture.path, fixture.beforeSha);
    await syncBabysitterPrBodyBeforeDismissal(
      input,
      service.deps,
      async () => {},
    );
    const currentBody = service.getBody();
    await syncBabysitterPrBodyBeforeDismissal(
      input,
      service.deps,
      async () => {},
    );
    assertEquals(service.edits(), 1);
    assertEquals(service.getBody(), currentBody);
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("an unrelated marker-less PR is not adopted and can still dismiss its review", async () => {
  const fixture = await makeBabysitterSyncFixture();
  try {
    const unrelatedBody = "Human-authored description. Part of #4637.";
    const service = fakePrBodyService({
      headSha: fixture.headSha,
      branch: "feature/unrelated",
      body: unrelatedBody,
    });
    let dismissed = false;
    await syncBabysitterPrBodyBeforeDismissal(
      babysitterBodySyncInput(
        fixture.path,
        fixture.beforeSha,
        "feature/unrelated",
      ),
      service.deps,
      () => {
        dismissed = true;
        return Promise.resolve();
      },
    );
    assertEquals(service.edits(), 0);
    assertEquals(service.getBody(), unrelatedBody);
    assertEquals(dismissed, true);
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("a stale repair checkout cannot dismiss reviews after body sync skips", async () => {
  const fixture = await makeBabysitterSyncFixture();
  try {
    const service = fakePrBodyService({
      headSha: "0000000000000000000000000000000000000000",
      body: staleMarkerlessBody,
    });
    let dismissed = false;
    await assertRejects(
      () =>
        syncBabysitterPrBodyBeforeDismissal(
          babysitterBodySyncInput(fixture.path, fixture.beforeSha),
          service.deps,
          () => {
            dismissed = true;
            return Promise.resolve();
          },
        ),
      Error,
      "checkout is not the PR head",
    );
    assertEquals(service.edits(), 0);
    assertEquals(dismissed, false);
  } finally {
    await cleanupFixture(fixture.path);
  }
});

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
  statusCheckRollup: [{ conclusion: "SUCCESS" }],
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
    reason({ ...pr, mergeStateStatus: "BEHIND" }),
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
