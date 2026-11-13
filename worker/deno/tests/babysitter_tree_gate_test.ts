/**
 * Tests for the babysitter tree gate (Issue #4930).
 *
 * Real temp git repositories and real git checkouts; the pre-push gate
 * itself is an injected fake that drives the git adapter, so no deno test,
 * markdownlint or ShellCheck run here. Nothing writes to a repository's `.git`
 * except through the temp repositories these tests create.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  BABYSITTER_GATE_BLOCKED_MARKER,
  type BabysitterTreeGateDeps,
  type BabysitterTreeGateOutcome,
  defaultCheckoutTree,
  hashFile,
  isGateInfrastructureResponse,
  MAX_FINGERPRINT_BYTES,
  runBabysitterTreeGate,
  withholdReady,
} from "../lib/babysitter_tree_gate.ts";
import { isBabysitterReady } from "../lib/babysitter_ready.ts";
import {
  agentClone,
  BAR_FAILURE,
  editFoo,
  FOO_FAILURE,
  git,
  mergeNewerBase,
} from "./support/babysitter_tree_fixture.ts";
import {
  defaultPrePushGit,
  PrePushGateInfrastructureError,
  type PrePushGit,
  runPrePushGate,
} from "../lib/pre_push_gate.ts";

type GateOptions = Parameters<typeof runPrePushGate>[0];
type GateResult = Awaited<ReturnType<typeof runPrePushGate>>;

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

Deno.test("worktree add checks the fork commit out into the temp root as a git checkout, then remove and prune clear it (#4930)", async () => {
  await fixture(async (repo, root) => {
    const head = await git(repo, "rev-parse", "HEAD");
    const realRoot = await Deno.realPath(root);
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
      seen.toplevel = await git(dest, "rev-parse", "--show-toplevel");
      seen.tracked = (await git(dest, "ls-files")).split("\n");
      seen.head = await git(dest, "rev-parse", "HEAD");
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
    assertEquals(
      seen.toplevel,
      `${realRoot}/vibe-deno-test-base/tree-1`,
    );
    assertEquals(seen.tracked, ["committed.txt", "gone.txt", "old.txt"]);
    assertEquals(seen.head, head);
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

/**
 * Runs the real pre-push gate through the adapter with only the command runner
 * faked. `unit` answers the deno test command in the checkout it runs in;
 * every other command passes and is recorded.
 */
async function realGate(
  clone: string,
  baseBranch: string | undefined,
  unit: (cwd: string | undefined) => { code: number; stderr?: string },
  markdownlintExit: number | ((command: string) => number) = 0,
) {
  const commands: string[] = [];
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    const outcome = await runBabysitterTreeGate(clone, baseBranch, {
      findMarkdownlint: () => Promise.resolve("/fake/markdownlint"),
      runner: (command, options) => {
        commands.push(command);
        const isUnit = command.startsWith("deno task test:unit");
        const isMarkdown = command.includes("/fake/markdownlint");
        const answer = isUnit ? unit(options.cwd) : {
          code: !isMarkdown
            ? 0
            : typeof markdownlintExit === "number"
            ? markdownlintExit
            : markdownlintExit(command),
        };
        return Promise.resolve({
          started: true,
          stdout: "",
          stderr: "",
          ...answer,
        });
      },
    });
    return { outcome, commands, warnings };
  } finally {
    console.warn = realWarn;
  }
}

Deno.test("an uncommitted new test file that fails blocks, naming the failing command, with no formatter or linter run (#4930)", async () => {
  await agentClone(
    (clone) =>
      Deno.writeTextFile(
        `${clone}/worker/deno/tests/new_test.ts`,
        "export {};\n",
      ),
    async (clone) => {
      const { outcome, commands } = await realGate(clone, "main", () => ({
        code: 1,
        stderr: "new works => ./tests/new_test.ts:3:6\n",
      }));

      assertEquals(outcome.kind, "blocked");
      assertStringIncludes(
        (outcome as { message: string }).message,
        "tests/new_test.ts",
      );
      assert(
        commands.some((c) => c.startsWith("deno task test:unit")),
        `the unit tests ran: ${commands}`,
      );
      assertEquals(
        commands.filter((c) => /deno (fmt|lint)/.test(c)),
        [],
      );
    },
  );
});

Deno.test("a test failing identically at the PR base is a warning, not a block (#4930)", async () => {
  await agentClone(editFoo, async (clone) => {
    const { outcome, warnings } = await realGate(clone, "main", () => ({
      code: 1,
      stderr: FOO_FAILURE,
    }));

    assertEquals(outcome.kind, "passed");
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0]!, "[PRE_PUSH_WARNING] deno test");
  });
});

Deno.test("a test that passes at the PR base but fails in the agent's tree blocks (#4930)", async () => {
  await agentClone(editFoo, async (clone) => {
    const { outcome, warnings } = await realGate(
      clone,
      "main",
      (cwd) =>
        Deno.readTextFileSync(`${cwd}/lib/foo.ts`).includes("= 1")
          ? { code: 0 }
          : { code: 1, stderr: FOO_FAILURE },
    );

    assertEquals(outcome.kind, "blocked");
    assertEquals(warnings, []);
  });
});

Deno.test("without a base branch the same failing test blocks (#4930)", async () => {
  await agentClone(editFoo, async (clone) => {
    const { outcome, warnings } = await realGate(clone, undefined, () => ({
      code: 1,
      stderr: FOO_FAILURE,
    }));

    assertEquals(outcome.kind, "blocked");
    assertEquals(warnings, []);
  });
});

/** What a base that has moved on brings in: a red test and a markdown error. */
const RED_BASE: Record<string, string> = {
  "worker/deno/lib/bar.ts": "export const bar = 1;\n",
  "worker/deno/tests/bar_test.ts": "export {};\n",
  "BASE.md": "#Bad\n",
};

Deno.test("files an uncommitted merge brings in from a red base do not block the repair (#4930)", async () => {
  await agentClone(
    (clone) => mergeNewerBase(clone, RED_BASE),
    async (clone) => {
      const { outcome, commands } = await realGate(
        clone,
        "main",
        () => ({ code: 1, stderr: BAR_FAILURE }),
        1,
      );

      assertEquals(outcome.kind, "clean");
      assertEquals(commands, []);
    },
  );
});

Deno.test("a repair edit on top of an uncommitted merge is compared at the base commit it brings in (#4930)", async () => {
  await agentClone(async (clone) => {
    await mergeNewerBase(clone, RED_BASE);
    await Deno.writeTextFile(
      `${clone}/worker/deno/lib/bar.ts`,
      "export const bar = 2;\n",
    );
  }, async (clone) => {
    const { outcome, warnings } = await realGate(
      clone,
      "main",
      () => ({ code: 1, stderr: BAR_FAILURE }),
    );

    assertEquals(outcome.kind, "passed");
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0]!, "[PRE_PUSH_WARNING] deno test");
  });
});

Deno.test("a failure the repair adds on top of an uncommitted merge still blocks (#4930)", async () => {
  await agentClone(async (clone) => {
    await mergeNewerBase(clone, RED_BASE);
    await editFoo(clone);
    await Deno.writeTextFile(`${clone}/NOTES.md`, "#Bad\n");
  }, async (clone) => {
    const unit = (cwd: string | undefined) =>
      Deno.readTextFileSync(`${cwd}/lib/foo.ts`).includes("= 1")
        ? { code: 0 }
        : { code: 1, stderr: FOO_FAILURE };

    const testFailure = await realGate(clone, "main", unit);
    assertEquals(testFailure.outcome.kind, "blocked");
    assertStringIncludes(
      (testFailure.outcome as { message: string }).message,
      "tests/foo_test.ts",
    );

    await Deno.writeTextFile(
      `${clone}/worker/deno/lib/foo.ts`,
      "export const foo = 1;\n",
    );
    const markdownFailure = await realGate(clone, "main", unit, 1);
    assertEquals(markdownFailure.outcome.kind, "blocked");
    assertStringIncludes(
      (markdownFailure.outcome as { message: string }).message,
      "/fake/markdownlint",
    );
  });
});

Deno.test("a changed markdown file runs markdownlint and its failure blocks (#4930)", async () => {
  await agentClone(
    (clone) => Deno.writeTextFile(`${clone}/NOTES.md`, "#Bad\n"),
    async (clone) => {
      const passing = await realGate(clone, "main", () => ({ code: 0 }));
      assertEquals(passing.outcome.kind, "passed");
      assert(
        passing.commands.some((c) => c.includes("/fake/markdownlint")),
        `markdownlint ran: ${passing.commands}`,
      );

      const failing = await realGate(clone, "main", () => ({ code: 0 }), 1);
      assertEquals(failing.outcome.kind, "blocked");
      assertStringIncludes(
        (failing.outcome as { message: string }).message,
        "/fake/markdownlint",
      );
    },
  );
});

Deno.test("a changed markdown file with no markdownlint binary available is not a pass (#4930)", async () => {
  await agentClone(
    (clone) => Deno.writeTextFile(`${clone}/NOTES.md`, "#Bad\n"),
    async (clone) => {
      const commands: string[] = [];
      const outcome = await runBabysitterTreeGate(clone, "main", {
        findMarkdownlint: () => Promise.resolve(null),
        runner: (command) => {
          commands.push(command);
          return Promise.resolve({
            started: true,
            code: 0,
            stdout: "",
            stderr: "",
          });
        },
      });

      assertEquals(outcome.kind, "blocked", `commands run: ${commands}`);
      assertStringIncludes(
        (outcome as { message: string }).message,
        "markdownlint",
      );
    },
  );
});

Deno.test("a module-fetch outage in the unit tests is infrastructure, not blocked (#4930)", async () => {
  await agentClone(editFoo, async (clone) => {
    const { outcome } = await realGate(clone, "main", () => ({
      code: 1,
      stderr:
        "error: JSR package manifest for '@std/assert' failed to load. Import 'https://jsr.io/@std/assert/meta.json' failed.\n    at file:///x/tests/foo_test.ts:1:8\n",
    }));

    assertEquals(outcome.kind, "infrastructure");
    assertStringIncludes(
      (outcome as { message: string }).message,
      "JSR package manifest",
    );
  });
});

Deno.test("a conflict the agent resolves on top of an uncommitted merge is checked, and the base's own markdown is not (#4930)", async () => {
  // Both sides add docs/SHARED.md, so the merge stops with an unmerged index
  // entry, as mergeBaseForRepair leaves a conflicting PR.
  await agentClone(async (clone) => {
    await git(clone, "checkout", "-q", "-b", "newer-base");
    await Deno.mkdir(`${clone}/docs`);
    await Deno.writeTextFile(`${clone}/docs/SHARED.md`, "# Shared\n\nBase\n");
    await Deno.writeTextFile(`${clone}/docs/BASE.md`, "#Bad base heading\n");
    await git(clone, "add", "-A");
    await git(clone, "commit", "-q", "-m", "base moves on");
    await git(clone, "push", "-q", "--no-verify", "origin", "HEAD:main");
    await git(clone, "checkout", "-q", "main");
    await Deno.mkdir(`${clone}/docs`, { recursive: true });
    await Deno.writeTextFile(`${clone}/docs/SHARED.md`, "# Shared\n\nPR\n");
    await git(clone, "add", "-A");
    await git(clone, "commit", "-q", "-m", "PR change");
    const merge = await new Deno.Command("git", {
      args: ["merge", "--no-commit", "--no-ff", "refs/remotes/origin/main"],
      cwd: clone,
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).output();
    assertEquals(merge.code, 1, "the base merge conflicts on docs/SHARED.md");
    await Deno.writeTextFile(
      `${clone}/docs/SHARED.md`,
      "# Shared\n\nPR and base\n",
    );
  }, async (clone) => {
    const { outcome, commands } = await realGate(
      clone,
      "main",
      () => ({ code: 0 }),
      (command) => command.includes("BASE.md") ? 1 : 0,
    );

    assertEquals(outcome.kind, "passed", JSON.stringify(outcome));
    const markdown = commands.filter((c) => c.includes("/fake/markdownlint"));
    assert(
      markdown.some((c) => c.includes("docs/SHARED.md")),
      `the resolved conflict is linted: ${markdown}`,
    );
    assertEquals(markdown.filter((c) => c.includes("BASE.md")), []);
  });
});

Deno.test("an unreadable MERGE_HEAD is infrastructure, and the gate is not called (#4930)", async () => {
  await fixture(async (repo, root) => {
    await Deno.writeTextFile(`${repo}/committed.txt`, "changed\n");
    const { deps, calls } = depsFor(root, () => Promise.resolve(PASS), {
      git: (args, cwd) =>
        args.includes("MERGE_HEAD")
          ? Promise.resolve({ code: 128, stdout: "", stderr: "fatal: broken" })
          : defaultPrePushGit(args, cwd),
    });

    const outcome = await runBabysitterTreeGate(repo, "main", deps);

    assertEquals(outcome.kind, "infrastructure");
    assertStringIncludes(
      (outcome as { message: string }).message,
      "MERGE_HEAD failed (exit 128): fatal: broken",
    );
    assertEquals(calls.length, 0);
  });
});

Deno.test("files inside a new untracked directory are listed one by one (#4930)", async () => {
  await fixture(async (repo, root) => {
    await Deno.mkdir(`${repo}/sub/dir`, { recursive: true });
    await Deno.writeTextFile(`${repo}/sub/dir/new.txt`, "new\n");
    let logged: string[] = [];
    const { deps } = depsFor(root, async (opts) => {
      const out = await opts.git!(
        ["log", "--name-only", "-z", "HEAD", "--not", "--remotes"],
        opts.cwd,
      );
      logged = names(out.stdout);
      return PASS;
    });

    await runBabysitterTreeGate(repo, undefined, deps);

    assertEquals(logged, ["sub/dir/new.txt"]);
  });
});

Deno.test("the default temp root is a real directory the gate hands to the adapter, then removes (#4930)", async () => {
  await fixture(async (repo) => {
    await Deno.writeTextFile(`${repo}/fresh.txt`, "new\n");
    let common = "";
    const outcome = await runBabysitterTreeGate(repo, undefined, {
      gate: async (opts) => {
        const out = await opts.git!(
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          opts.cwd,
        );
        common = out.stdout.trim();
        assert((await Deno.stat(common)).isDirectory);
        return PASS;
      },
    });

    assertEquals(outcome.kind, "passed");
    assertStringIncludes(common, "babysitter-tree-gate-");
    assertEquals(await exists(common), false);
  });
});

Deno.test("a temp root already gone when the gate finishes is not a failure (#4930)", async () => {
  await fixture(async (repo, root) => {
    await Deno.writeTextFile(`${repo}/fresh.txt`, "new\n");
    const outcome = await runBabysitterTreeGate(repo, undefined, {
      makeTempDir: async () => root,
      gate: async () => {
        await Deno.remove(root, { recursive: true });
        return PASS;
      },
    });

    assertEquals(outcome.kind, "passed");
  });
});

Deno.test("a checkout of a missing commit fails, carrying git's exit code and stderr (#4930)", async () => {
  await fixture(async (repo, root) => {
    const dest = `${root}/base`;
    await Deno.mkdir(dest);

    const checkedOut = await defaultCheckoutTree(repo, "0".repeat(40), dest);

    assert(checkedOut.code !== 0, "a missing commit does not check out");
    assert(checkedOut.stderr.trim() !== "", "git's stderr is carried");
  });
});

Deno.test("an unreadable object directory fails the checkout before any repository is made (#4930)", async () => {
  await fixture(async (repo, root) => {
    const dest = `${root}/base`;
    await Deno.mkdir(dest);
    const calls: string[][] = [];

    const checkedOut = await defaultCheckoutTree(
      repo,
      await git(repo, "rev-parse", "HEAD"),
      dest,
      (args, cwd) => {
        calls.push(args);
        return args.includes("objects")
          ? Promise.resolve({ code: 128, stdout: "", stderr: "fatal: no" })
          : defaultPrePushGit(args, cwd);
      },
    );

    assertEquals(checkedOut.code, 128);
    assertStringIncludes(checkedOut.stderr, "object directory: fatal: no");
    assertEquals(await exists(`${dest}/.git`), false);
  });
});

Deno.test("a clone whose git directory lives elsewhere (an absolute object path) checks out too (#4930)", async () => {
  await fixture(async (_repo, root) => {
    const work = `${root}/work`;
    await git(root, "init", "-q", "--separate-git-dir", `${root}/gitdir`, work);
    await git(work, "config", "user.email", "tree-gate@example.invalid");
    await git(work, "config", "user.name", "Tree Gate Test");
    await git(work, "config", "commit.gpgsign", "false");
    await Deno.writeTextFile(`${work}/kept.txt`, "kept\n");
    await git(work, "add", "-A");
    await git(work, "commit", "-q", "-m", "kept");
    assert(
      (await git(work, "rev-parse", "--git-path", "objects")).startsWith("/"),
      "git prints this object directory as an absolute path",
    );
    const dest = `${root}/base`;
    await Deno.mkdir(dest);

    const checkedOut = await defaultCheckoutTree(
      work,
      await git(work, "rev-parse", "HEAD"),
      dest,
    );

    assertEquals(checkedOut, { code: 0, stderr: "" });
    assertEquals(await Deno.readTextFile(`${dest}/kept.txt`), "kept\n");
  });
});

Deno.test("a hooks path configured for git runs no hook in the baseline checkout (#4930)", async () => {
  await fixture(async (repo, root) => {
    const hooks = `${root}/hooks`;
    await Deno.mkdir(hooks);
    const ran = `${root}/hook-ran`;
    await Deno.writeTextFile(
      `${hooks}/post-checkout`,
      `#!/bin/sh\ntouch '${ran}'\n`,
    );
    await Deno.chmod(`${hooks}/post-checkout`, 0o755);
    const dest = `${root}/base`;
    await Deno.mkdir(dest);
    const head = await git(repo, "rev-parse", "HEAD");
    // The hooks path comes in as the outermost `-c`, ahead of the adapter's own,
    // so the test sets no process environment.
    const hooked: PrePushGit = (args, cwd) =>
      defaultPrePushGit(["-c", `core.hooksPath=${hooks}`, ...args], cwd);
    const checkedOut = await defaultCheckoutTree(repo, head, dest, hooked);

    assertEquals(checkedOut, { code: 0, stderr: "" });
    assertEquals(
      await exists(ran),
      false,
      "the post-checkout hook did not run",
    );
  });
});

/** Every path under `dir` with its size and mtime, to show nothing was written. */
async function snapshot(dir: string): Promise<string[]> {
  const entries: string[] = [];
  const walk = async (path: string): Promise<void> => {
    for await (const entry of Deno.readDir(path)) {
      const full = `${path}/${entry.name}`;
      const info = await Deno.lstat(full);
      entries.push(`${full} ${info.size} ${info.mtime?.getTime()}`);
      if (info.isDirectory) await walk(full);
    }
  };
  await walk(dir);
  return entries.sort();
}

Deno.test("the base commit of a depth-1 clone with a read-only .git checks out as a real git checkout, writing nothing to the clone (#4930)", async () => {
  // The container's clone: depth 1, its base reachable only from a
  // remote-tracking ref, and its .git mounted read-only.
  const top = await Deno.makeTempDir({ prefix: "tree-gate-shallow-4930-" });
  const clone = `${top}/clone`;
  try {
    await git(top, "init", "-q", "--bare", "-b", "main", `${top}/remote.git`);
    await git(top, "clone", "-q", `${top}/remote.git`, `${top}/seed`);
    const seed = `${top}/seed`;
    await git(seed, "config", "user.email", "tree-gate@example.invalid");
    await git(seed, "config", "user.name", "Tree Gate Test");
    await git(seed, "config", "commit.gpgsign", "false");
    await Deno.writeTextFile(`${seed}/a.txt`, "one\n");
    await git(seed, "add", "-A");
    await git(seed, "commit", "-q", "-m", "one");
    await Deno.writeTextFile(`${seed}/a.txt`, "base\n");
    await git(seed, "commit", "-q", "-am", "base");
    await git(seed, "push", "-q", "--no-verify", "origin", "HEAD:main");
    await git(seed, "checkout", "-q", "-b", "pr");
    await Deno.writeTextFile(`${seed}/pr.txt`, "pr\n");
    await git(seed, "add", "-A");
    await git(seed, "commit", "-q", "-m", "pr");
    await git(seed, "push", "-q", "--no-verify", "origin", "HEAD:pr");
    await git(
      top,
      "clone",
      "-q",
      "--depth",
      "1",
      "--branch",
      "pr",
      `file://${top}/remote.git`,
      clone,
    );
    await git(
      clone,
      "fetch",
      "-q",
      "--depth",
      "1",
      "origin",
      "main:refs/remotes/origin/main",
    );
    const base = await git(clone, "rev-parse", "refs/remotes/origin/main");
    await Deno.writeTextFile(`${clone}/a.txt`, "the agent's edit\n");
    const statusBefore = await git(clone, "status", "--porcelain");
    const gitDirBefore = await snapshot(`${clone}/.git`);
    await Deno.chmod(`${clone}/.git`, 0o555);
    const dest = `${top}/base`;
    await Deno.mkdir(dest);

    const checkedOut = await defaultCheckoutTree(clone, base, dest);

    assertEquals(checkedOut, { code: 0, stderr: "" });
    assertEquals(await Deno.readTextFile(`${dest}/a.txt`), "base\n");
    assertEquals(await git(dest, "rev-parse", "HEAD"), base);
    assertEquals(
      (await git(dest, "ls-files")).split("\n"),
      ["a.txt"],
      "the baseline is a git checkout a test can inspect",
    );
    assertEquals(await git(dest, "status", "--porcelain"), "");
    assertEquals(
      await git(dest, "log", "--format=%s"),
      "base",
      "the clone's shallow boundary is kept, so history reads as in the clone",
    );
    assertEquals(
      await snapshot(`${clone}/.git`),
      gitDirBefore,
      "the clone's .git is not written, even where the mount would allow it",
    );
    assertEquals(await git(clone, "status", "--porcelain"), statusBefore);
    assertEquals(
      await exists(`${dest}/.git/hooks`),
      false,
      "no template hooks",
    );
  } finally {
    await Deno.chmod(`${clone}/.git`, 0o755).catch(() => {});
    await Deno.remove(top, { recursive: true }).catch(() => {});
  }
});

/**
 * A clone of a bare remote whose `main` holds a Deno root with a real
 * `test:unit` task (`deno test`, no lock file) and a test that needs its
 * checkout to be a git repository and `foo` to be `wanted` (the PR #5091
 * review's reproduction). The agent's edit sets `foo` to 2, uncommitted.
 */
async function realDenoClone(
  wanted: number,
  body: (clone: string) => Promise<void>,
): Promise<void> {
  const top = await Deno.makeTempDir({ prefix: "tree-gate-deno-4930-" });
  try {
    const clone = `${top}/clone`;
    await git(top, "init", "-q", "--bare", "-b", "main", `${top}/remote.git`);
    await git(top, "clone", "-q", `${top}/remote.git`, clone);
    await git(clone, "config", "user.email", "tree-gate@example.invalid");
    await git(clone, "config", "user.name", "Tree Gate Test");
    await git(clone, "config", "commit.gpgsign", "false");
    await Deno.mkdir(`${clone}/worker/deno/lib`, { recursive: true });
    await Deno.mkdir(`${clone}/worker/deno/tests`, { recursive: true });
    await Deno.writeTextFile(
      `${clone}/worker/deno/deno.json`,
      JSON.stringify({
        lock: false,
        tasks: { "test:unit": "deno test --allow-read --allow-run" },
      }),
    );
    await Deno.writeTextFile(
      `${clone}/worker/deno/lib/foo.ts`,
      "export const foo = 1;\n",
    );
    await Deno.writeTextFile(
      `${clone}/worker/deno/tests/foo_test.ts`,
      [
        'import { foo } from "../lib/foo.ts";',
        'Deno.test("foo works in this checkout", async () => {',
        '  const out = await new Deno.Command("git", {',
        '    args: ["rev-parse", "--show-toplevel"],',
        '    stdout: "piped",',
        '    stderr: "piped",',
        "  }).output();",
        '  if (out.code !== 0) throw new Error("not a git checkout");',
        `  if (Number(foo) !== ${wanted}) throw new Error("regression");`,
        "});",
        "",
      ].join("\n"),
    );
    await git(clone, "add", "-A");
    await git(clone, "commit", "-q", "-m", "base");
    await git(clone, "push", "-q", "--no-verify", "origin", "HEAD:main");
    await Deno.writeTextFile(
      `${clone}/worker/deno/lib/foo.ts`,
      "export const foo = 2;\n",
    );
    await body(clone);
  } finally {
    await Deno.remove(top, { recursive: true }).catch(() => {});
  }
}

/** The real tree gate with real `deno test` runs; no markdown is changed. */
async function realDenoGate(clone: string) {
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    const outcome = await runBabysitterTreeGate(clone, "main", {
      findMarkdownlint: () => Promise.resolve(null),
    });
    return { outcome, warnings };
  } finally {
    console.warn = realWarn;
  }
}

Deno.test("with real deno test runs, a test that needs a git checkout and passes on the base still blocks the repair's regression (#4930)", async () => {
  // The base passes (foo is 1); the agent's foo = 2 fails with "regression".
  // An archive baseline has no .git, so it failed the same test at its git
  // prerequisite and the regression passed as base-owned (PR #5091 review).
  await realDenoClone(1, async (clone) => {
    const { outcome, warnings } = await realDenoGate(clone);

    assertEquals(outcome.kind, "blocked", JSON.stringify(outcome));
    assertStringIncludes(
      (outcome as { message: string }).message,
      "foo works in this checkout",
    );
    assertEquals(warnings, []);
  });
});

Deno.test("with real deno test runs, a test that fails the same way on the base checkout is still a warning (#4930)", async () => {
  // foo must be 3: the base (1) and the agent's tree (2) both fail with
  // "regression" in a real git checkout, so the failure is the base's.
  await realDenoClone(3, async (clone) => {
    const { outcome, warnings } = await realDenoGate(clone);

    assertEquals(outcome.kind, "passed", JSON.stringify(outcome));
    assertEquals(warnings.length, 1, warnings.join("\n"));
    assertStringIncludes(warnings[0]!, "[PRE_PUSH_WARNING] deno test");
  });
});

for (const config of ["deno.json", "deno.jsonc"]) {
  Deno.test(`an invalid ${config} blocks repair validation instead of dropping the unit tests (#4930)`, async () => {
    await agentClone(editFoo, async (clone) => {
      const path = `${clone}/worker/deno/${config}`;
      if (config === "deno.jsonc") {
        await git(clone, "mv", "worker/deno/deno.json", "worker/deno/deno.jsonc");
      }
      const deps: BabysitterTreeGateDeps = {
        runner: async () => ({
          started: true,
          code: 0,
          stdout: "checks passed",
          stderr: "",
        }),
      };
      const valid = await Deno.readTextFile(path);
      const allowed = await runBabysitterTreeGate(clone, "main", deps);
      assertEquals(allowed, {
        kind: "passed",
        checksRun: [config === "deno.json"
          ? "deno task test:unit 'tests/foo_test.ts'"
          : "deno task test:unit"],
      });

      await Deno.writeTextFile(path, '{"tasks":');
      const blocked = await runBabysitterTreeGate(clone, "main", deps);
      assertEquals(blocked.kind, "blocked", JSON.stringify(blocked));
      assertStringIncludes(
        (blocked as { message: string }).message,
        `cannot parse worker/deno/${config}`,
      );
      assertStringIncludes(
        (blocked as { message: string }).message,
        "unit tests were not checked",
      );

      await Deno.writeTextFile(path, valid);
      assertEquals(await runBabysitterTreeGate(clone, "main", deps), allowed);
    });
  });
}

Deno.test("an unreadable primary Deno config cannot fall through to a secondary config and pass (#4930)", async () => {
  await agentClone(editFoo, async (clone) => {
    const path = `${clone}/worker/deno/deno.json`;
    const valid = await Deno.readTextFile(path);
    await Deno.writeTextFile(`${clone}/worker/deno/deno.jsonc`, valid);
    const deps: BabysitterTreeGateDeps = {
      runner: async () => ({
        started: true,
        code: 0,
        stdout: "checks passed",
        stderr: "",
      }),
    };
    assertEquals(await runBabysitterTreeGate(clone, "main", deps), {
      kind: "passed",
      checksRun: ["deno task test:unit"],
    });

    await Deno.remove(path);
    await Deno.mkdir(path);
    const blocked = await runBabysitterTreeGate(clone, "main", deps);
    assertEquals(blocked.kind, "blocked", JSON.stringify(blocked));
    assertStringIncludes(
      (blocked as { message: string }).message,
      "cannot read worker/deno/deno.json",
    );
    await Deno.remove(path);
    await Deno.writeTextFile(path, valid);
    assertEquals(await runBabysitterTreeGate(clone, "main", deps), {
      kind: "passed",
      checksRun: ["deno task test:unit"],
    });
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
    const token = `ghp_${"x7Q".repeat(12)}`;
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

Deno.test("same-path untracked edits made by passing checks block the push (#4930)", async () => {
  await fixture(async (repo, root) => {
    await Deno.writeTextFile(`${repo}/fresh.txt`, "agent content\\n");
    const { deps } = depsFor(root, async () => {
      await Deno.writeTextFile(
        `${repo}/fresh.txt`,
        "check overwrote agent content\\n",
      );
      return PASS;
    });

    const outcome = await runBabysitterTreeGate(repo, undefined, deps);

    assertEquals(outcome, {
      kind: "blocked",
      message: "the checks changed the working tree: fresh.txt",
    });
  });
});

Deno.test("same-path tracked edits made by passing checks block the push (#4930)", async () => {
  await fixture(async (repo, root) => {
    await Deno.writeTextFile(`${repo}/committed.txt`, "agent edit\\n");
    const { deps } = depsFor(root, async () => {
      await Deno.writeTextFile(`${repo}/committed.txt`, "check edit\\n");
      return PASS;
    });

    const outcome = await runBabysitterTreeGate(repo, undefined, deps);

    assertEquals(outcome, {
      kind: "blocked",
      message: "the checks changed the working tree: committed.txt",
    });
  });
});

Deno.test("a changed staged blob is blocked even with identical status and worktree bytes (#4930)", async () => {
  await fixture(async (repo, root) => {
    await Deno.writeTextFile(`${repo}/committed.txt`, "staged before\\n");
    await git(repo, "add", "committed.txt");
    await Deno.writeTextFile(`${repo}/committed.txt`, "working content\\n");
    const beforeStatus = await git(repo, "status", "--porcelain");
    const { deps } = depsFor(root, async () => {
      await Deno.writeTextFile(`${repo}/committed.txt`, "staged by check\\n");
      await git(repo, "add", "committed.txt");
      await Deno.writeTextFile(`${repo}/committed.txt`, "working content\\n");
      return PASS;
    });

    const outcome = await runBabysitterTreeGate(repo, undefined, deps);

    assertEquals(await git(repo, "status", "--porcelain"), beforeStatus);
    assertEquals(
      await Deno.readTextFile(`${repo}/committed.txt`),
      "working content\\n",
    );
    assertEquals(outcome, {
      kind: "blocked",
      message: "the checks changed the working tree: committed.txt",
    });
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

/** Commits `files` (path to text) to the fixture repository. */
async function commitFiles(
  repo: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await Deno.mkdir(
      `${repo}/${path.split("/").slice(0, -1).join("/") || "."}`,
      {
        recursive: true,
      },
    );
    await Deno.writeTextFile(`${repo}/${path}`, text);
  }
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "add files");
}

Deno.test("a file replaced by a directory at the same path is not an outage and a clean check passes (#4930)", async () => {
  await fixture(async (repo, root) => {
    await Deno.remove(`${repo}/gone.txt`);
    await Deno.mkdir(`${repo}/gone.txt`);
    await Deno.writeTextFile(`${repo}/gone.txt/inner.txt`, "inner\n");
    const { deps } = depsFor(root, async () => PASS);

    const outcome = await runBabysitterTreeGate(repo, undefined, deps);

    assertEquals(outcome, { kind: "passed", checksRun: [] });
  });
});

Deno.test("a directory replaced by a file at the same path is not an outage (#4930)", async () => {
  await fixture(async (repo, root) => {
    await commitFiles(repo, { "d/a": "a\n" });
    await Deno.remove(`${repo}/d`, { recursive: true });
    await Deno.writeTextFile(`${repo}/d`, "now a file\n");
    const { deps } = depsFor(root, async () => PASS);

    const outcome = await runBabysitterTreeGate(repo, undefined, deps);

    assertEquals(outcome, { kind: "passed", checksRun: [] });
  });
});

Deno.test("a check that rewrites the file now at a swapped path still blocks (#4930)", async () => {
  await fixture(async (repo, root) => {
    await commitFiles(repo, { "d/a": "a\n" });
    await Deno.remove(`${repo}/d`, { recursive: true });
    await Deno.writeTextFile(`${repo}/d`, "agent file\n");
    const { deps } = depsFor(root, async () => {
      await Deno.writeTextFile(`${repo}/d`, "check rewrote it\n");
      return PASS;
    });

    const outcome = await runBabysitterTreeGate(repo, undefined, deps);

    assertEquals(outcome, {
      kind: "blocked",
      message: "the checks changed the working tree: d",
    });
  });
});

Deno.test("a submodule pointer in the tree and a nested repository are not an outage (#4930)", async () => {
  await fixture(async (repo, root) => {
    const sha = (await git(repo, "rev-parse", "HEAD")).trim();
    await git(
      repo,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${sha},sub`,
    );
    await Deno.mkdir(`${repo}/sub`);
    await Deno.mkdir(`${repo}/nested`);
    await git(`${repo}/nested`, "init", "-q");
    const { deps } = depsFor(root, async () => PASS);

    const outcome = await runBabysitterTreeGate(repo, undefined, deps);

    assertEquals(outcome, { kind: "passed", checksRun: [] });
  });
});

Deno.test("a dirty file over the size limit blocks, naming it (#4930)", async () => {
  await fixture(async (repo, root) => {
    const file = await Deno.open(`${repo}/huge.bin`, {
      write: true,
      create: true,
    });
    await file.truncate(MAX_FINGERPRINT_BYTES + 1);
    file.close();
    const { deps, calls } = depsFor(root, async () => PASS);

    const outcome = await runBabysitterTreeGate(repo, undefined, deps);

    assertEquals(outcome.kind, "blocked");
    assertStringIncludes((outcome as { message: string }).message, "huge.bin");
    assertEquals(calls.length, 0);
  });
});

Deno.test("hashing stops at the byte limit even when the file grew after its size was read (#4930)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tree-gate-hash-4930-" });
  try {
    await Deno.writeTextFile(`${dir}/f`, "0123456789");
    assertEquals(
      (await hashFile(`${dir}/f`, "f", 10)).length,
      64,
    );
    let message = "";
    try {
      await hashFile(`${dir}/f`, "f", 9);
    } catch (error) {
      message = (error as Error).message;
    }
    assertStringIncludes(message, "f is larger than the 9-byte limit");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a tracked directory replaced by a symlink out of the clone blocks without reading through it (#4930)", async () => {
  await fixture(async (repo, root) => {
    await commitFiles(repo, { "sub/f": "tracked\n" });
    const outside = await Deno.makeTempDir({
      prefix: "tree-gate-outside-4930-",
    });
    try {
      await Deno.writeTextFile(`${outside}/f`, "outside the clone\n");
      await Deno.remove(`${repo}/sub`, { recursive: true });
      await Deno.symlink(outside, `${repo}/sub`);
      const { deps, calls } = depsFor(root, async () => PASS);

      const outcome = await runBabysitterTreeGate(repo, undefined, deps);

      assertEquals(outcome.kind, "blocked");
      assertStringIncludes(
        (outcome as { message: string }).message,
        "sub/f resolves outside the clone",
      );
      assertEquals(calls.length, 0);
    } finally {
      await Deno.remove(outside, { recursive: true });
    }
  });
});

Deno.test("an untracked file the gate cannot open blocks, it is not an infrastructure outage (#4930)", async () => {
  await fixture(async (repo, root) => {
    await Deno.writeTextFile(`${repo}/locked.txt`, "secret\n");
    await Deno.chmod(`${repo}/locked.txt`, 0o000);
    // A superuser reads a mode-000 file, so the shape cannot be made unreadable.
    try {
      (await Deno.open(`${repo}/locked.txt`)).close();
      return;
    } catch {
      // Unreadable, as the test needs.
    }
    const { deps, calls } = depsFor(root, async () => PASS);

    const outcome = await runBabysitterTreeGate(repo, undefined, deps);

    assertEquals(outcome.kind, "blocked");
    assertStringIncludes(
      (outcome as { message: string }).message,
      "locked.txt",
    );
    assertEquals(calls.length, 0);
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

Deno.test("withholdReady neutralises a gate marker a check's message quotes (#4930)", () => {
  const result = withholdReady("ok\nBABYSITTER_READY", {
    kind: "blocked",
    message:
      `a test printed ${BABYSITTER_GATE_BLOCKED_MARKER} pre-push checks could not run: x`,
  });

  assertEquals(result.split(BABYSITTER_GATE_BLOCKED_MARKER).length - 1, 1);
  assert(
    result.startsWith(
      `${BABYSITTER_GATE_BLOCKED_MARKER} pre-push checks failed:`,
    ),
  );
  assertEquals(isGateInfrastructureResponse(result), false);
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

Deno.test("only a withheld infrastructure response is recognised as a gate outage (#4930)", () => {
  const infrastructure = withholdReady("done\nBABYSITTER_READY\n", {
    kind: "infrastructure",
    message: "module fetch failed",
  });
  const blocked = withholdReady("done\nBABYSITTER_READY\n", {
    kind: "blocked",
    message: "deno test failed",
  });

  assertEquals(isGateInfrastructureResponse(infrastructure), true);
  assertEquals(isGateInfrastructureResponse(blocked), false);
  assertEquals(isGateInfrastructureResponse("done\nBABYSITTER_READY\n"), false);
  assertEquals(
    isGateInfrastructureResponse(
      `agent text\n${BABYSITTER_GATE_BLOCKED_MARKER} pre-push checks could not run: x`,
    ),
    false,
  );
});
