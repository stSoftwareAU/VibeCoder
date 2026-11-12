/**
 * Tests for the babysitter tree gate (Issue #4930).
 *
 * Real temp git repositories and real `git archive`/`tar`; the pre-push gate
 * itself is an injected fake that drives the git adapter, so no deno test,
 * markdownlint or ShellCheck run here. Nothing writes to a repository's `.git`
 * except through the temp repositories these tests create.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  BABYSITTER_GATE_BLOCKED_MARKER,
  type BabysitterTreeGateDeps,
  type BabysitterTreeGateOutcome,
  runBabysitterTreeGate,
  withholdReady,
} from "../lib/babysitter_tree_gate.ts";
import { isBabysitterReady } from "../lib/babysitter_ready.ts";
import {
  defaultPrePushGit,
  PrePushGateInfrastructureError,
  type PrePushGit,
  runPrePushGate,
} from "../lib/pre_push_gate.ts";

type GateOptions = Parameters<typeof runPrePushGate>[0];
type GateResult = Awaited<ReturnType<typeof runPrePushGate>>;

const decoder = new TextDecoder();

/** Runs real git in `cwd` and returns its trimmed stdout; throws on failure. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (out.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${decoder.decode(out.stderr)}`,
    );
  }
  return decoder.decode(out.stdout).trim();
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

/**
 * A committed repository holding `committed.txt`, `gone.txt` and `old.txt`, with
 * its own user config. Plus a temp root for the gate, removed afterwards.
 */
async function fixture(
  body: (repo: string, root: string) => Promise<void>,
): Promise<void> {
  const repo = await Deno.makeTempDir({ prefix: "tree-gate-repo-4930-" });
  const root = await Deno.makeTempDir({ prefix: "tree-gate-root-4930-" });
  try {
    await git(repo, "init", "-q");
    await git(repo, "config", "user.email", "tree-gate@example.invalid");
    await git(repo, "config", "user.name", "Tree Gate Test");
    await git(repo, "config", "commit.gpgsign", "false");
    for (const name of ["committed.txt", "gone.txt", "old.txt"]) {
      await Deno.writeTextFile(`${repo}/${name}`, `${name}\n`);
    }
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "init");
    await body(repo, root);
  } finally {
    await Deno.remove(repo, { recursive: true }).catch(() => {});
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

/** Deps that hand the gate our temp root and record what the gate was given. */
function depsFor(
  root: string,
  gate: (opts: GateOptions) => Promise<GateResult>,
  extra: Partial<BabysitterTreeGateDeps> = {},
): { deps: BabysitterTreeGateDeps; calls: GateOptions[] } {
  const calls: GateOptions[] = [];
  return {
    calls,
    deps: {
      makeTempDir: async () => root,
      gate: async (opts) => {
        calls.push(opts);
        return await gate(opts);
      },
      ...extra,
    },
  };
}

const PASS: GateResult = { ok: true, value: { checksRun: [] } };

/** Split the NUL-joined output of an adapter call into names. */
function names(stdout: string): string[] {
  return stdout.split("\0").filter((p) => p !== "");
}

Deno.test("a clean tree is clean and never calls the gate (#4930)", async () => {
  await fixture(async (repo, root) => {
    const { deps, calls } = depsFor(root, async () => PASS);

    const outcome = await runBabysitterTreeGate(repo, "main", deps);

    assertEquals(outcome, { kind: "clean" });
    assertEquals(calls.length, 0);
  });
});

Deno.test("a tree holding only the agent's scratch files is clean (#4930)", async () => {
  await fixture(async (repo, root) => {
    await Deno.writeTextFile(`${repo}/.babysitter-response`, "x\n");
    await Deno.writeTextFile(`${repo}/.babysitter-pr-body`, "x\n");
    const { deps, calls } = depsFor(root, async () => PASS);

    const outcome = await runBabysitterTreeGate(repo, undefined, deps);

    assertEquals(outcome, { kind: "clean" });
    assertEquals(calls.length, 0);
  });
});

Deno.test("modified, deleted, renamed and untracked paths reach the gate, scratch files do not (#4930)", async () => {
  await fixture(async (repo, root) => {
    await Deno.writeTextFile(`${repo}/committed.txt`, "changed\n");
    await Deno.remove(`${repo}/gone.txt`);
    await git(repo, "mv", "old.txt", "renamed.txt");
    await Deno.writeTextFile(`${repo}/fresh.txt`, "new\n");
    await Deno.writeTextFile(`${repo}/.babysitter-response`, "x\n");
    await Deno.writeTextFile(`${repo}/.babysitter-pr-body`, "x\n");
    let logged: string[] = [];
    const { deps } = depsFor(root, async (opts) => {
      const out = await opts.git!(
        [
          "log",
          "--diff-merges=dense-combined",
          "--name-only",
          "-z",
          "--format=",
          "--diff-filter=d",
          "HEAD",
          "--not",
          "--remotes",
        ],
        opts.cwd,
      );
      logged = names(out.stdout).sort();
      return PASS;
    });

    const outcome = await runBabysitterTreeGate(repo, undefined, deps);

    assertEquals(outcome.kind, "passed");
    assertEquals(logged, [
      "committed.txt",
      "fresh.txt",
      "gone.txt",
      "old.txt",
      "renamed.txt",
    ]);
  });
});

Deno.test("the gate's ls-files lists untracked and new paths as tracked (#4930)", async () => {
  await fixture(async (repo, root) => {
    await Deno.writeTextFile(`${repo}/fresh.txt`, "new\n");
    await git(repo, "mv", "old.txt", "renamed.txt");
    let tracked: string[] = [];
    const { deps } = depsFor(root, async (opts) => {
      const out = await opts.git!(["ls-files", "-z"], opts.cwd);
      tracked = names(out.stdout);
      return PASS;
    });

    await runBabysitterTreeGate(repo, undefined, deps);

    assert(tracked.includes("committed.txt"), `committed kept: ${tracked}`);
    assert(tracked.includes("fresh.txt"), `untracked listed: ${tracked}`);
    assert(tracked.includes("renamed.txt"), `new rename listed: ${tracked}`);
  });
});

Deno.test("git-common-dir resolves to the temp root and the repo gets no worktrees dir (#4930)", async () => {
  await fixture(async (repo, root) => {
    await Deno.writeTextFile(`${repo}/fresh.txt`, "new\n");
    let common = "";
    const { deps } = depsFor(root, async (opts) => {
      const out = await opts.git!(
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        opts.cwd,
      );
      assertEquals(out.code, 0);
      common = out.stdout.trim();
      return PASS;
    });

    await runBabysitterTreeGate(repo, undefined, deps);

    assertEquals(common, root);
    assertEquals(await exists(`${repo}/.git/worktrees`), false);
  });
});

Deno.test("worktree add extracts the fork commit into the temp root, then remove and prune clear it (#4930)", async () => {
  await fixture(async (repo, root) => {
    const head = await git(repo, "rev-parse", "HEAD");
    await Deno.writeTextFile(`${repo}/committed.txt`, "uncommitted edit\n");
    await Deno.writeTextFile(`${repo}/fresh.txt`, "new\n");
    const seen: Record<string, unknown> = {};
    const { deps } = depsFor(root, async (opts) => {
      const dest = `${root}/vibe-deno-test-base/tree-1`;
      const add = await opts.git!(
        ["worktree", "add", "--detach", dest, head],
        opts.cwd,
      );
      seen.addCode = add.code;
      seen.committed = await Deno.readTextFile(`${dest}/committed.txt`);
      seen.freshPresent = await exists(`${dest}/fresh.txt`);
      const removed = await opts.git!(
        ["worktree", "remove", "--force", dest],
        opts.cwd,
      );
      seen.removeCode = removed.code;
      seen.destGone = !(await exists(dest));
      const pruned = await opts.git!(["worktree", "prune"], opts.cwd);
      seen.pruneCode = pruned.code;
      return PASS;
    });

    const outcome = await runBabysitterTreeGate(repo, undefined, deps);

    assertEquals(outcome.kind, "passed");
    assertEquals(seen.addCode, 0);
    assertEquals(seen.committed, "committed.txt\n");
    assertEquals(seen.freshPresent, false);
    assertEquals(seen.removeCode, 0);
    assertEquals(seen.destGone, true);
    assertEquals(seen.pruneCode, 0);
    assertEquals(await exists(`${repo}/.git/worktrees`), false);
  });
});

Deno.test("a worktree add or remove outside the temp root is refused (#4930)", async () => {
  await fixture(async (repo, root) => {
    const head = await git(repo, "rev-parse", "HEAD");
    await Deno.writeTextFile(`${repo}/fresh.txt`, "new\n");
    const outside = `${repo}/.git/vibe-escape-4930`;
    const seen: Record<string, number> = {};
    const { deps } = depsFor(root, async (opts) => {
      seen.add = (await opts.git!(
        ["worktree", "add", "--detach", outside, head],
        opts.cwd,
      )).code;
      seen.traversal = (await opts.git!(
        ["worktree", "add", "--detach", `${root}/../vibe-escape-4930`, head],
        opts.cwd,
      )).code;
      seen.remove = (await opts.git!(
        ["worktree", "remove", "--force", outside],
        opts.cwd,
      )).code;
      return PASS;
    });

    await runBabysitterTreeGate(repo, undefined, deps);

    assertEquals(seen.add, 1);
    assertEquals(seen.traversal, 1);
    assertEquals(seen.remove, 1);
    assertEquals(await exists(outside), false);
  });
});

Deno.test("the gate is given the pre-push stdin, shellcheckOnly and no baseline unless one is named (#4930)", async () => {
  await fixture(async (repo, root) => {
    await Deno.writeTextFile(`${repo}/fresh.txt`, "new\n");
    const head = await git(repo, "rev-parse", "HEAD");
    const withBase = depsFor(root, async () => PASS);
    await runBabysitterTreeGate(repo, "main", withBase.deps);
    const withoutBase = depsFor(root, async () => PASS);
    await runBabysitterTreeGate(repo, undefined, withoutBase.deps);

    const first = withBase.calls[0]!;
    assertEquals(
      first.stdin,
      `refs/heads/babysitter-tree ${head} refs/heads/babysitter-tree ${head}\n`,
    );
    assertEquals(first.cwd, repo);
    assertEquals(first.preFlightCommands, []);
    assertEquals(first.shellcheckOnly, true);
    assertEquals(first.baselineBranch, "main");
    assertEquals(withoutBase.calls.length, 1);
    assertEquals("baselineBranch" in withoutBase.calls[0]!, false);
  });
});

Deno.test("gate results map to passed, infrastructure and blocked (#4930)", async () => {
  await fixture(async (repo, root) => {
    await Deno.writeTextFile(`${repo}/fresh.txt`, "new\n");
    const cases: Array<[string, () => Promise<GateResult>]> = [
      ["ok", async () => ({ ok: true, value: { checksRun: ["deno test a"] } })],
      [
        "infrastructure",
        async () => ({
          ok: false,
          error: new PrePushGateInfrastructureError("git ls-files failed"),
        }),
      ],
      [
        "blocked",
        async () => ({
          ok: false,
          error: new Error("deno test failed: a_test.ts"),
        }),
      ],
    ];
    const outcomes: BabysitterTreeGateOutcome[] = [];
    for (const [, gate] of cases) {
      const { deps } = depsFor(root, gate);
      outcomes.push(await runBabysitterTreeGate(repo, undefined, deps));
    }

    assertEquals(outcomes[0], { kind: "passed", checksRun: ["deno test a"] });
    assertEquals(outcomes[1], {
      kind: "infrastructure",
      message: "git ls-files failed",
    });
    assertEquals(outcomes[2], {
      kind: "blocked",
      message: "deno test failed: a_test.ts",
    });
  });
});

Deno.test("a gate that throws is infrastructure, never a pass, and the temp root is removed (#4930)", async () => {
  await fixture(async (repo, root) => {
    await Deno.writeTextFile(`${repo}/fresh.txt`, "new\n");
    const { deps } = depsFor(root, async () => {
      throw new Error("gate exploded");
    });

    const outcome = await runBabysitterTreeGate(repo, undefined, deps);

    assertEquals(outcome, { kind: "infrastructure", message: "gate exploded" });
    assertEquals(await exists(root), false);
  });
});

Deno.test("a failing status is infrastructure with git's stderr, and the gate is not called (#4930)", async () => {
  const fakeGit: PrePushGit = async () => ({
    code: 128,
    stdout: "",
    stderr: "fatal: not a git repository",
  });
  const calls: GateOptions[] = [];
  const outcome = await runBabysitterTreeGate("/nonexistent-4930", undefined, {
    git: fakeGit,
    gate: async (opts) => {
      calls.push(opts);
      return PASS;
    },
  });

  assertEquals(outcome.kind, "infrastructure");
  assertStringIncludes(
    (outcome as { message: string }).message,
    "fatal: not a git repository",
  );
  assertEquals(calls.length, 0);
});

Deno.test("a directory that is not a repository is infrastructure (#4930)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tree-gate-norepo-4930-" });
  try {
    const calls: GateOptions[] = [];
    const outcome = await runBabysitterTreeGate(dir, undefined, {
      gate: async (opts) => {
        calls.push(opts);
        return PASS;
      },
    });

    assertEquals(outcome.kind, "infrastructure");
    assertEquals(calls.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a blocked message is redacted and capped at 1500 characters, keeping its head (#4930)", async () => {
  await fixture(async (repo, root) => {
    await Deno.writeTextFile(`${repo}/fresh.txt`, "new\n");
    const token = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    const { deps } = depsFor(root, async () => ({
      ok: false,
      error: new Error(`deno test failed: token ${token}\n${"x".repeat(3000)}`),
    }));

    const outcome = await runBabysitterTreeGate(repo, undefined, deps);

    assertEquals(outcome.kind, "blocked");
    const message = (outcome as { message: string }).message;
    assert(!message.includes(token), "token must be redacted");
    assert(message.startsWith("deno test failed: token "));
    assertEquals(Array.from(message).length, 1500);
  });
});

Deno.test("a check that leaves a new untracked file behind turns a pass into blocked (#4930)", async () => {
  await fixture(async (repo, root) => {
    await Deno.writeTextFile(`${repo}/fresh.txt`, "new\n");
    const { deps } = depsFor(root, async () => {
      await Deno.writeTextFile(`${repo}/stray.txt`, "left by a check\n");
      return PASS;
    });

    const outcome = await runBabysitterTreeGate(repo, undefined, deps);

    assertEquals(outcome.kind, "blocked");
    const message = (outcome as { message: string }).message;
    assertEquals(
      message,
      "the checks changed the working tree: stray.txt",
    );
  });
});

Deno.test("checks that change nothing keep a pass (#4930)", async () => {
  await fixture(async (repo, root) => {
    await Deno.writeTextFile(`${repo}/fresh.txt`, "new\n");
    const { deps } = depsFor(root, async () => PASS);

    const outcome = await runBabysitterTreeGate(repo, undefined, deps);

    assertEquals(outcome, { kind: "passed", checksRun: [] });
  });
});

Deno.test("a check failure with a stray file keeps the gate's own outcome (#4930)", async () => {
  await fixture(async (repo, root) => {
    await Deno.writeTextFile(`${repo}/fresh.txt`, "new\n");
    const failures: Array<[GateResult, BabysitterTreeGateOutcome]> = [
      [
        { ok: false, error: new Error("deno test failed: a_test.ts") },
        { kind: "blocked", message: "deno test failed: a_test.ts" },
      ],
      [
        {
          ok: false,
          error: new PrePushGateInfrastructureError("git ls-files failed"),
        },
        { kind: "infrastructure", message: "git ls-files failed" },
      ],
    ];
    for (const [gateResult, expected] of failures) {
      const { deps } = depsFor(root, async () => {
        await Deno.writeTextFile(`${repo}/stray.txt`, "left by a check\n");
        return gateResult;
      });
      const outcome = await runBabysitterTreeGate(repo, undefined, deps);
      assertEquals(outcome, expected);
      await Deno.remove(`${repo}/stray.txt`);
    }
  });
});

Deno.test("a failed re-read of the tree after the checks is infrastructure (#4930)", async () => {
  await fixture(async (repo, root) => {
    await Deno.writeTextFile(`${repo}/fresh.txt`, "new\n");
    let statusCalls = 0;
    const flaky: PrePushGit = async (args, cwd) => {
      if (args[0] === "--no-optional-locks") {
        statusCalls++;
        if (statusCalls === 2) {
          return { code: 128, stdout: "", stderr: "fatal: index locked" };
        }
      }
      return await defaultPrePushGit(args, cwd);
    };
    const { deps } = depsFor(root, async () => PASS, { git: flaky });

    const outcome = await runBabysitterTreeGate(repo, undefined, deps);

    assertEquals(statusCalls, 2);
    assertEquals(outcome.kind, "infrastructure");
    assertStringIncludes(
      (outcome as { message: string }).message,
      "fatal: index locked",
    );
  });
});

Deno.test("withholdReady drops the trailing READY line and keeps the cause first (#4930)", () => {
  const outcome = {
    kind: "blocked" as const,
    message: "deno test failed: a_test.ts",
  };

  const result = withholdReady("done\nBABYSITTER_READY\n", outcome);

  assertEquals(
    result,
    `${BABYSITTER_GATE_BLOCKED_MARKER} pre-push checks failed: deno test failed: a_test.ts\n\ndone`,
  );
  assertEquals(isBabysitterReady(result), false);
});

Deno.test("withholdReady of output that is only READY leaves no ready line (#4930)", () => {
  const outcome = {
    kind: "infrastructure" as const,
    message: "git ls-files failed",
  };

  const result = withholdReady("BABYSITTER_READY", outcome);

  assertEquals(
    result,
    `${BABYSITTER_GATE_BLOCKED_MARKER} pre-push checks could not run: git ls-files failed\n\n`,
  );
  assertEquals(isBabysitterReady(result), false);
});

Deno.test("withholdReady neutralises the READY text inside the message (#4930)", () => {
  const outcome = {
    kind: "blocked" as const,
    message: "the BABYSITTER_READY line was named by the check",
  };

  const result = withholdReady("ok\nBABYSITTER_READY", outcome);

  assertEquals(
    result,
    `${BABYSITTER_GATE_BLOCKED_MARKER} pre-push checks failed: the ready marker line was named by the check\n\nok`,
  );
  assertEquals(result.includes("BABYSITTER_READY"), false);
  assertEquals(isBabysitterReady(result), false);
});

Deno.test("withholdReady adds only the marker to output without READY (#4930)", () => {
  const outcome = {
    kind: "blocked" as const,
    message: "markdownlint failed",
  };
  const output = "FINAL MESSAGE\nsecond line\n";

  const result = withholdReady(output, outcome);

  assertEquals(
    result,
    `${BABYSITTER_GATE_BLOCKED_MARKER} pre-push checks failed: markdownlint failed\n\n${output}`,
  );
  assertEquals(isBabysitterReady(result), false);
});
