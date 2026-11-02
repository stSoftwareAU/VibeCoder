import { classifyPrBaseChange } from "../lib/pr_base_change_guard.ts";
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
  attemptKey,
  babysitterRtkInstruction,
  buildRepairPrompt,
  cancelledRunsToRerun,
  cloneForRepair,
  type CloneForRepairDeps,
  defaultRemoteUrl,
  eligibleAuthor,
  prBodyEditArgs,
  reason,
  recoverTemporaryClones,
  removeRepairDirs,
  requestedReviews,
  runRepairs,
  serialiseOnMirror,
  spawnBabysitterAgent,
  takePrBodyProposal,
  validateAndCommit,
  waitForPushedHead,
  withBabysitterWriteScope,
} from "../commands/fleet_pr_babysitter.ts";

/** Run a real git command for fixtures and for the injected runner in clone tests. */
async function runGitForTest(
  args: string[],
  options: { cwd?: string; timeoutSeconds?: number } = {},
): Promise<string> {
  const output = await new Deno.Command("git", {
    args,
    cwd: options.cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(output.stdout).trim();
  const stderr = new TextDecoder().decode(output.stderr).trim();
  if (!output.success) {
    throw new Error(`git ${args[0]} failed: ${stderr || stdout}`);
  }
  return stdout;
}

function fixtureGit(args: string[], cwd: string): Promise<string> {
  return runGitForTest(
    [
      "-c",
      "user.name=Babysitter Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd },
  );
}

async function commitFile(
  cwd: string,
  name: string,
  message: string,
): Promise<void> {
  await Deno.writeTextFile(`${cwd}/${name}`, `${message}\n`);
  await fixtureGit(["add", "-A"], cwd);
  await fixtureGit(["commit", "-q", "-m", message], cwd);
}

/** A local bare "upstream" with main (two commits) and feature (one more). */
async function makeUpstream(
  root: string,
): Promise<{ upstream: string; work: string }> {
  const work = `${root}/work`;
  const upstream = `${root}/upstream.git`;
  await Deno.mkdir(work);
  await fixtureGit(["init", "-q", "-b", "main"], work);
  await commitFile(work, "a.txt", "first");
  await commitFile(work, "b.txt", "second");
  await fixtureGit(["checkout", "-q", "-b", "feature"], work);
  await commitFile(work, "c.txt", "third");
  await fixtureGit(["checkout", "-q", "main"], work);
  await fixtureGit(["clone", "-q", "--bare", work, upstream], root);
  return { upstream, work };
}

async function withTempRoot(
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "babysitter-mirror-test-" });
  try {
    await run(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

Deno.test("failed clone is attempted once and preserves its original error", async () => {
  await withTempRoot(async (root) => {
    const calls: string[][] = [];
    const timeout = new Error("clone timed out");
    await assertRejects(
      () =>
        cloneForRepair("owner/repo", `${root}/clone`, {
          git: (args) => {
            calls.push(args);
            return Promise.reject(timeout);
          },
          remoteUrl: () => Promise.resolve("/tmp/upstream"),
          mirrorRoot: `${root}/mirrors`,
        }),
      Error,
      "clone timed out",
    );
    assertEquals(calls.filter((args) => args.includes("clone")).length, 1);
  });
});

Deno.test("first repair clones full history from a local mirror, with origin reset to GitHub", async () => {
  await withTempRoot(async (root) => {
    const { upstream } = await makeUpstream(root);
    const mirrorRoot = `${root}/mirrors`;
    const dir = `${root}/clone`;
    await cloneForRepair("owner/repo", dir, {
      remoteUrl: () => Promise.resolve(upstream),
      mirrorRoot,
    });
    assertEquals(
      await runGitForTest(["rev-list", "--count", "--all"], { cwd: dir }),
      await runGitForTest(["rev-list", "--count", "--all"], { cwd: upstream }),
    );
    await runGitForTest(["merge-base", "origin/main", "origin/feature"], {
      cwd: dir,
    });
    assertEquals(await exists(`${dir}/.git/objects/info/alternates`), false);
    assertEquals(
      await runGitForTest(["config", "remote.origin.url"], { cwd: dir }),
      upstream,
    );
    const mirror = `${mirrorRoot}/owner--repo.git`;
    assertEquals(
      await runGitForTest(["rev-parse", "--is-bare-repository"], {
        cwd: mirror,
      }),
      "true",
    );
  });
});

Deno.test("a later repair fetches into the mirror and clones from it, without a second bare clone", async () => {
  await withTempRoot(async (root) => {
    const { upstream, work } = await makeUpstream(root);
    const mirrorRoot = `${root}/mirrors`;
    const mirror = `${mirrorRoot}/owner--repo.git`;
    const calls: { args: string[]; cwd?: string }[] = [];
    const deps: CloneForRepairDeps = {
      git: (args, options) => {
        calls.push({ args, cwd: options?.cwd });
        return runGitForTest(args, options);
      },
      remoteUrl: () => Promise.resolve(upstream),
      mirrorRoot,
    };
    await cloneForRepair("owner/repo", `${root}/clone-1`, deps);
    await commitFile(work, "d.txt", "fourth");
    await fixtureGit(["push", "-q", upstream, "main"], work);
    const dir2 = `${root}/clone-2`;
    await cloneForRepair("owner/repo", dir2, deps);
    assertEquals(
      await runGitForTest(["log", "-1", "--format=%s", "origin/main"], {
        cwd: dir2,
      }),
      "fourth",
    );
    const fetchIndex = calls.findIndex((call) => call.args[0] === "fetch");
    assertEquals(calls[fetchIndex], {
      args: [
        "fetch",
        "--no-auto-maintenance",
        "--prune",
        upstream,
        "+refs/heads/*:refs/heads/*",
        "+refs/tags/*:refs/tags/*",
      ],
      cwd: mirror,
    });
    assertEquals(calls[fetchIndex + 1], {
      args: [
        "-c",
        "maintenance.autoDetach=false",
        "-c",
        "gc.autoDetach=false",
        "maintenance",
        "run",
        "--auto",
      ],
      cwd: mirror,
    });
    assertEquals(calls[fetchIndex + 2]?.args.slice(0, 3), [
      "clone",
      "--no-checkout",
      "--no-hardlinks",
    ]);
    assertEquals(
      calls.filter((call) =>
        call.args[0] === "clone" && call.args[1] === "--bare"
      ).length,
      1,
    );
  });
});

Deno.test("a clone keeps its full history after the mirror is deleted", async () => {
  await withTempRoot(async (root) => {
    const { upstream } = await makeUpstream(root);
    const mirrorRoot = `${root}/mirrors`;
    const dir = `${root}/clone`;
    await cloneForRepair("owner/repo", dir, {
      remoteUrl: () => Promise.resolve(upstream),
      mirrorRoot,
    });
    await Deno.remove(`${mirrorRoot}/owner--repo.git`, { recursive: true });
    await runGitForTest(["fsck"], { cwd: dir });
    assertEquals(
      await runGitForTest(["rev-list", "--count", "--all"], { cwd: dir }),
      "3",
    );
  });
});

/** Every regular file under a directory, found recursively. */
async function filesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) found.push(...await filesUnder(path));
    else if (entry.isFile) found.push(path);
  }
  return found;
}

Deno.test("the clone copies its objects, so no object file is hardlinked to the mirror", async () => {
  await withTempRoot(async (root) => {
    const { upstream } = await makeUpstream(root);
    const mirrorRoot = `${root}/mirrors`;
    const mirror = `${mirrorRoot}/owner--repo.git`;
    const dir = `${root}/clone`;
    await cloneForRepair("owner/repo", dir, {
      remoteUrl: () => Promise.resolve(upstream),
      mirrorRoot,
    });
    const mirrorObjects = await filesUnder(`${mirror}/objects`);
    assert(
      mirrorObjects.length > 0,
      "the mirror holds no object files to compare",
    );
    const cloneObjects = await filesUnder(`${dir}/.git/objects`);
    assert(cloneObjects.length > 0, "the clone holds no object files to check");
    for (const file of cloneObjects) {
      assertEquals((await Deno.stat(file)).nlink, 1, `${file} is hardlinked`);
    }
  });
});

Deno.test("a failed fetch keeps git's cause and leaves the mirror in place", async () => {
  await withTempRoot(async (root) => {
    const { upstream } = await makeUpstream(root);
    const mirrorRoot = `${root}/mirrors`;
    const mirror = `${mirrorRoot}/owner--repo.git`;
    const deps: CloneForRepairDeps = {
      remoteUrl: () => Promise.resolve(upstream),
      mirrorRoot,
    };
    await cloneForRepair("owner/repo", `${root}/clone-1`, deps);
    await Deno.rename(upstream, `${root}/upstream-moved.git`);
    await assertRejects(
      () => cloneForRepair("owner/repo", `${root}/clone-2`, deps),
      Error,
      "does not appear to be a git repository",
    );
    assert(await exists(mirror));
  });
});

Deno.test("a repository name that is not owner/name is refused before any git runs", async () => {
  await withTempRoot(async (root) => {
    const calls: string[][] = [];
    await assertRejects(
      () =>
        cloneForRepair("../x", `${root}/clone`, {
          git: (args) => {
            calls.push(args);
            return Promise.resolve("");
          },
          remoteUrl: () => Promise.resolve("/tmp/upstream"),
          mirrorRoot: `${root}/mirrors`,
        }),
      Error,
      "Invalid repository",
    );
    assertEquals(calls, []);
  });
});

Deno.test("concurrent repairs of one repo never mutate its mirror at the same time", async () => {
  await withTempRoot(async (root) => {
    const { upstream } = await makeUpstream(root);
    const calls: string[] = [];
    const deps: CloneForRepairDeps = {
      git: async (args, options) => {
        if (
          args[0] === "fetch" || (args[0] === "clone" && args[1] === "--bare")
        ) calls.push("mirror");
        if (args[0] === "remote") calls.push("set-url");
        return await runGitForTest(args, options);
      },
      remoteUrl: () => Promise.resolve(upstream),
      mirrorRoot: `${root}/mirrors`,
    };
    await Promise.all([
      cloneForRepair("owner/repo", `${root}/clone-a`, deps),
      cloneForRepair("owner/repo", `${root}/clone-b`, deps),
    ]);
    assertEquals(calls, ["mirror", "set-url", "mirror", "set-url"]);
    for (const dir of [`${root}/clone-a`, `${root}/clone-b`]) {
      assertEquals(
        await runGitForTest(["rev-list", "--count", "--all"], { cwd: dir }),
        "3",
      );
    }
  });
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
    {
      dir,
      scratch,
      prompt,
      agentToken,
      protectedPaths,
      codex: "/home/u/.vibe-coder/codex/0.164.0-aarch64-apple-darwin/codex",
    },
    (executable, options) => {
      calls.push({ executable, options });
      return {} as unknown as Deno.ChildProcess;
    },
  );
  const [call] = calls;
  assert(call);
  assertEquals(
    call.executable,
    "/home/u/.vibe-coder/codex/0.164.0-aarch64-apple-darwin/codex",
  );
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
      codex: "codex",
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
          codex: "codex",
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

// Issue #4671: a new review on an attempted head is new input, not a repeat.
Deno.test("a new change request on an attempted head gets its own attempt", () => {
  const review = (id: number) => ({
    id,
    state: "CHANGES_REQUESTED",
    user: { login: "reviewer[bot]" },
  });
  const first = attemptKey("owner/repo", 7, "abc", [review(10)]);
  assertEquals(first, attemptKey("owner/repo", 7, "abc", [review(10)]));
  assert(
    first !== attemptKey("owner/repo", 7, "abc", [review(10), review(12)]),
  );
  assertEquals(
    attemptKey("owner/repo", 7, "abc", [review(12), review(10)]),
    attemptKey("owner/repo", 7, "abc", [review(10), review(12)]),
  );
  assertEquals(attemptKey("owner/repo", 7, "abc", []), "owner--repo--7--abc");
});

// Issue #4668: a review asking for a description change could never be met,
// because the agent may not edit the PR; the runner applies its proposal.
Deno.test("a review repair may propose a PR description for the runner to apply", () => {
  const prompt = buildRepairPrompt(
    "requested review changes",
    1,
    "owner/repo",
    "",
  );
  assertStringIncludes(prompt, ".babysitter-pr-body");
});

Deno.test("the proposed PR description is taken out of the clone before commit", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/.babysitter-pr-body`, "New body\n");
    assertEquals(
      await takePrBodyProposal(dir, "Old body"),
      "New body",
    );
    await assertRejects(
      () => Deno.stat(`${dir}/.babysitter-pr-body`),
      Deno.errors.NotFound,
    );
    assertEquals(await takePrBodyProposal(dir, "Old body"), undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a proposed PR description keeps the closing references it dropped", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${dir}/.babysitter-pr-body`,
      "Rewritten summary. Fixes #12",
    );
    assertEquals(
      await takePrBodyProposal(
        dir,
        "Closes #5031\nfixes #12\nResolves other/repo#7\nSee #99",
      ),
      "Rewritten summary. Fixes #12\n\nCloses #5031\nResolves other/repo#7",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an empty or oversized PR description proposal is not applied", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/.babysitter-pr-body`, "  \n");
    assertEquals(await takePrBodyProposal(dir, "Old"), undefined);
    await Deno.writeTextFile(`${dir}/.babysitter-pr-body`, "x".repeat(65_537));
    await assertRejects(
      () => takePrBodyProposal(dir, "Old"),
      Error,
      "65536",
    );
    await assertRejects(
      () => Deno.stat(`${dir}/.babysitter-pr-body`),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// Issue #4677: CI is the gate, so a check this host cannot run is reported,
// not a reason to discard an otherwise complete repair.
Deno.test("a check the host cannot run is named but does not withhold readiness", () => {
  for (
    const why of ["failed CI", "requested review changes", "merge conflict"]
  ) {
    const prompt = buildRepairPrompt(why, 1, "owner/repo", "");
    assertStringIncludes(prompt, "name it in your final response");
    assertStringIncludes(
      prompt,
      "does not by itself withhold BABYSITTER_READY",
    );
  }
});

// Issue #4677: a resolved conflict was discarded over unrelated verifier
// findings (VibeCoder#4675); other feedback is out of a conflict's scope.
Deno.test("other open feedback does not withhold readiness from a resolved conflict", () => {
  const prompt = buildRepairPrompt("merge conflict", 1, "owner/repo", "");
  assertStringIncludes(
    prompt,
    "Other open feedback (reviews, verifier or bot comments) is out of scope for a conflict repair and does not withhold BABYSITTER_READY",
  );
});

// Issue #4684: cancelled CI is re-run, not handed to an agent to "fix".
Deno.test("only a head whose runs were cancelled and none failed is re-run", () => {
  const r = (id: number, status: string, conclusion: string | null) => ({
    id,
    status,
    conclusion,
  });
  assertEquals(
    cancelledRunsToRerun([
      r(1, "completed", "success"),
      r(2, "completed", "cancelled"),
      r(3, "completed", "cancelled"),
    ]),
    [2, 3],
  );
  assertEquals(
    cancelledRunsToRerun([
      r(1, "completed", "failure"),
      r(2, "completed", "cancelled"),
    ]),
    [],
  );
  assertEquals(
    cancelledRunsToRerun([
      r(1, "in_progress", null),
      r(2, "completed", "cancelled"),
    ]),
    [],
  );
  assertEquals(cancelledRunsToRerun([r(1, "completed", "success")]), []);
  assertEquals(cancelledRunsToRerun([]), []);
});

// Issue #4704: the description update went out as a raw PATCH with
// `-F body=@file`, which the base-change guard cannot read and so refuses.
Deno.test("the PR description update is not mistaken for a base change", () => {
  const args = prBodyEditArgs("owner/repo", 7, "/tmp/scratch/pr-body.md");
  assertEquals(classifyPrBaseChange(args, () => "New description"), undefined);
  // The route it replaces, for contrast: the guard fails closed on it.
  assertEquals(
    classifyPrBaseChange(
      [
        "api",
        "-X",
        "PATCH",
        "repos/owner/repo/pulls/7",
        "-F",
        "body=@/tmp/scratch/pr-body.md",
      ],
      () => "New description",
    )?.newBase,
    null,
  );
});

Deno.test("the PR description update passes the write allowlist for its repo only", async () => {
  await withBabysitterWriteScope("owner/repo", async () => {
    await enforceGhWriteAllowlist(
      prBodyEditArgs("owner/repo", 7, "/tmp/scratch/pr-body.md"),
    );
    await assertRejects(
      () =>
        enforceGhWriteAllowlist(
          prBodyEditArgs("other/repo", 7, "/tmp/scratch/pr-body.md"),
        ),
      WriteRepoBlockedError,
    );
  });
});

// Issue #4677: GRQ-AutoTrader#5056 was held twice by a macOS-only failure in
// a test the repair never touched; CI on the base is the arbiter.
Deno.test("a host-only failure in an unrelated check is named, not a blocker", () => {
  for (
    const why of ["failed CI", "requested review changes", "merge conflict"]
  ) {
    const prompt = buildRepairPrompt(why, 1, "owner/repo", "");
    assertStringIncludes(
      prompt,
      "unrelated to the files you changed and passes in CI on the base branch",
    );
  }
});

// Issue #4694: a check that reads commit history cannot see the uncommitted
// fix the agent is forbidden to commit (VibeCoder#4675, #4687).
Deno.test("a check that reads commit history does not withhold readiness", () => {
  for (
    const why of ["failed CI", "requested review changes", "merge conflict"]
  ) {
    const prompt = buildRepairPrompt(why, 1, "owner/repo", "");
    assertStringIncludes(prompt, "reads commit history");
  }
});

// Issue #4717: a CI repair fixed the failing checks, then held back over the
// verifier's unrelated findings; a later review repair handles reviews.
Deno.test("other open feedback does not withhold readiness from a CI repair", () => {
  const prompt = buildRepairPrompt("failed CI", 1, "owner/repo", "");
  assertStringIncludes(
    prompt,
    "Other open feedback (reviews, verifier or bot comments) is out of scope for a CI repair",
  );
});

// Issue #4713: a code fix left VibeCoder's archived PR summary stale, so CI's
// freshness gate failed and a second session existed only to refresh it.
Deno.test("a repair updates a CI-checked per-PR summary in the same fix", () => {
  for (
    const why of ["failed CI", "requested review changes", "merge conflict"]
  ) {
    const prompt = buildRepairPrompt(why, 1, "owner/repo", "");
    assertStringIncludes(prompt, "per-PR summary");
    assertStringIncludes(prompt, "in the same fix");
  }
});

// Issue #4720: GRQ-AutoTrader#5066's conflict stopped for an owner because the
// base had deliberately retired behaviour the PR used; the base already
// carries that decision, and conflicts are never handed to a human.
Deno.test("a conflict where the base retired behaviour follows the base, not a human", () => {
  const prompt = buildRepairPrompt("merge conflict", 1, "owner/repo", "");
  assertStringIncludes(prompt, "deliberately removed or replaced behaviour");
  assertStringIncludes(prompt, "follow the base");
  assertStringIncludes(prompt, "never leave a conflict for a human");
});

// Issue #4710: a clone still being written by the agent's leftover test
// processes could not be removed, and the error from `finally` replaced the
// repair's real outcome. Clean-up warns and leaves it for a later pass.
Deno.test("repair clean-up warns instead of throwing, and still removes the rest", async () => {
  const removed: string[] = [];
  const warnings: string[] = [];
  await removeRepairDirs(
    ["/tmp/clone", undefined, "/tmp/scratch"],
    (path) => {
      if (path === "/tmp/clone") {
        return Promise.reject(new Error("Directory not empty (os error 66)"));
      }
      removed.push(path);
      return Promise.resolve();
    },
    (message) => warnings.push(message),
  );
  assertEquals(removed, ["/tmp/scratch"]);
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0]!, "WARNING");
  assertStringIncludes(warnings[0]!, "/tmp/clone");
  assertStringIncludes(warnings[0]!, "Directory not empty");
});

Deno.test("defaultRemoteUrl follows gh's git_protocol, falling back to https with a warning", async () => {
  const asked: string[][] = [];
  const answer = (protocol: string) => (args: string[]) => {
    asked.push(args);
    return Promise.resolve(protocol);
  };
  assertEquals(
    await defaultRemoteUrl("owner/repo", answer("ssh\n")),
    "git@github.com:owner/repo.git",
  );
  assertEquals(asked, [["config", "get", "git_protocol", "-h", "github.com"]]);
  assertEquals(
    await defaultRemoteUrl("owner/repo", answer("https\n")),
    "https://github.com/owner/repo.git",
  );
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    assertEquals(
      await defaultRemoteUrl(
        "owner/repo",
        () => Promise.reject(new Error("gh is not logged in")),
      ),
      "https://github.com/owner/repo.git",
    );
  } finally {
    console.warn = originalWarn;
  }
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0]!, "gh is not logged in");
});

Deno.test("host-specific gh protocol takes precedence over the global protocol", async () => {
  const gh = (args: string[]) =>
    Promise.resolve(args.includes("-h") ? "ssh\n" : "https\n");
  assertEquals(
    await defaultRemoteUrl("owner/repo", gh),
    "git@github.com:owner/repo.git",
  );
});

Deno.test("an existing mirror fetches from the newly resolved URL", async () => {
  await withTempRoot(async (root) => {
    const { upstream, work } = await makeUpstream(root);
    const mirrorRoot = `${root}/mirrors`;
    const deps: CloneForRepairDeps = {
      remoteUrl: () => Promise.resolve(upstream),
      mirrorRoot,
    };
    await cloneForRepair("owner/repo", `${root}/clone-1`, deps);
    const mirror = `${mirrorRoot}/owner--repo.git`;
    await runGitForTest(["remote", "set-url", "origin", `${root}/stale.git`], {
      cwd: mirror,
    });
    await commitFile(work, "new.txt", "new history");
    await fixtureGit(["push", "-q", upstream, "main"], work);
    await cloneForRepair("owner/repo", `${root}/clone-2`, deps);
    assertEquals(
      await runGitForTest(["rev-parse", "main"], { cwd: `${root}/clone-2` }),
      await runGitForTest(["rev-parse", "main"], { cwd: upstream }),
    );
    assertEquals(
      await runGitForTest(["config", "remote.origin.url"], {
        cwd: `${root}/clone-2`,
      }),
      upstream,
    );
  });
});

Deno.test("a later repair prunes deleted branches and fetches new tags into the clone", async () => {
  await withTempRoot(async (root) => {
    const { upstream, work } = await makeUpstream(root);
    const deps: CloneForRepairDeps = {
      remoteUrl: () => Promise.resolve(upstream),
      mirrorRoot: `${root}/mirrors`,
    };
    await cloneForRepair("owner/repo", `${root}/clone-1`, deps);
    await fixtureGit(["push", "-q", upstream, "--delete", "feature"], work);
    // A tag on a commit no branch reaches is only fetched by the tag refspec.
    await fixtureGit(["checkout", "-q", "--detach", "main"], work);
    await commitFile(work, "e.txt", "tagged only");
    await fixtureGit(["tag", "v1"], work);
    await fixtureGit(["push", "-q", upstream, "v1"], work);
    const dir2 = `${root}/clone-2`;
    await cloneForRepair("owner/repo", dir2, deps);
    const branches = await runGitForTest(
      ["for-each-ref", "--format=%(refname)", "refs/remotes/origin"],
      { cwd: dir2 },
    );
    assert(!branches.includes("origin/feature"), branches);
    assertEquals(
      await runGitForTest(["tag", "--list"], { cwd: dir2 }),
      "v1",
    );
  });
});

Deno.test("a stale partial download is cleared before the first download", async () => {
  await withTempRoot(async (root) => {
    const { upstream } = await makeUpstream(root);
    const mirrorRoot = `${root}/mirrors`;
    await Deno.mkdir(`${mirrorRoot}/owner--repo.git.tmp/objects`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${mirrorRoot}/owner--repo.git.tmp/objects/stale`,
      "left by an interrupted download",
    );
    await cloneForRepair("owner/repo", `${root}/clone`, {
      remoteUrl: () => Promise.resolve(upstream),
      mirrorRoot,
    });
    assertEquals(await exists(`${mirrorRoot}/owner--repo.git.tmp`), false);
    assertEquals(
      await runGitForTest(["rev-list", "--count", "--all"], {
        cwd: `${root}/clone`,
      }),
      "3",
    );
  });
});

Deno.test("the mirror root exists before the bare clone starts", async () => {
  await withTempRoot(async (root) => {
    const { upstream } = await makeUpstream(root);
    const mirrorRoot = `${root}/not/yet/created`;
    await cloneForRepair("owner/repo", `${root}/clone`, {
      git: async (args, options) => {
        if (args[0] === "clone" && args[1] === "--bare") {
          assert(
            await exists(mirrorRoot),
            "the mirror root must exist before the bare clone",
          );
        }
        return runGitForTest(args, options);
      },
      remoteUrl: () => Promise.resolve(upstream),
      mirrorRoot,
    });
    assert(await exists(`${mirrorRoot}/owner--repo.git`));
  });
});

Deno.test("every network git call is bounded by the 30-minute clone timeout", async () => {
  await withTempRoot(async (root) => {
    const { upstream } = await makeUpstream(root);
    const calls: { args: string[]; timeoutSeconds?: number }[] = [];
    const deps: CloneForRepairDeps = {
      git: (args, options) => {
        calls.push({ args, timeoutSeconds: options?.timeoutSeconds });
        return runGitForTest(args, options);
      },
      remoteUrl: () => Promise.resolve(upstream),
      mirrorRoot: `${root}/mirrors`,
    };
    await cloneForRepair("owner/repo", `${root}/clone-1`, deps);
    await cloneForRepair("owner/repo", `${root}/clone-2`, deps);
    const timed = calls.filter((call) =>
      ["clone", "fetch"].includes(call.args[0]!)
    );
    // Bare clone, local clone, fetch, local clone.
    assertEquals(timed.length, 4);
    for (const call of timed) {
      assertEquals(call.timeoutSeconds, 30 * 60, call.args.join(" "));
    }
  });
});

Deno.test("a call that arrives while another is queued still waits for the running work", async () => {
  const starts: string[] = [];
  const a = Promise.withResolvers<void>();
  const b = Promise.withResolvers<void>();
  const first = serialiseOnMirror("test-mirror", async () => {
    starts.push("a");
    await a.promise;
  });
  const second = serialiseOnMirror("test-mirror", async () => {
    starts.push("b");
    await b.promise;
  });
  await Promise.resolve();
  assertEquals(starts, ["a"]);
  a.resolve();
  await first;
  await Promise.resolve();
  assertEquals(starts, ["a", "b"]);
  const third = serialiseOnMirror("test-mirror", () => {
    starts.push("c");
    return Promise.resolve();
  });
  await Promise.resolve();
  assertEquals(starts, ["a", "b"]);
  b.resolve();
  await Promise.all([second, third]);
  assertEquals(starts, ["a", "b", "c"]);
});
