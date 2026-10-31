/**
 * Tests for pr_branch_preparation.ts — shared PR branch helpers (Issue #1458).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  preparePrBranch,
  readPrResponseMessage,
} from "../lib/pr_branch_preparation.ts";
import type { GitDeps } from "../lib/issue_worker_wiring.ts";
import type { Logger } from "../types.ts";
import {
  commitFile,
  git,
  gitOk,
  setupGitRepoFixture,
} from "./support/git_repo_fixture.ts";

function makeSilentLogger(): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

// ---------------------------------------------------------------------------
// preparePrBranch
// ---------------------------------------------------------------------------

Deno.test("preparePrBranch - operates on the requested branch and fetches before pulling", async () => {
  const calls: string[][] = [];
  const runGitCommand = ((args: string[]) => {
    calls.push(args);
    return Promise.resolve({
      ok: true as const,
      value: { code: 0, stdout: "", stderr: "" },
    });
  }) as unknown as GitDeps["runGitCommand"];

  // Completes without throwing — the observable success outcome.
  await preparePrBranch("feature-branch", {
    logger: makeSilentLogger(),
    git: { runGitCommand },
    cwd: "/tmp/repo",
  });

  // Real contract: every git invocation operates on the requested branch,
  // so preparation cannot silently act on the wrong ref.
  for (const call of calls) {
    assertEquals(
      call.includes("feature-branch") ||
        call.includes("refs/heads/feature-branch"),
      true,
      `git invocation ${JSON.stringify(call)} should target feature-branch`,
    );
  }

  // Where order genuinely matters, assert the relationship rather than pinning
  // absolute indices or an exact call count: the branch must be fetched before
  // it is pulled. Adding an unrelated git step (e.g. a rev-parse guard) or
  // swapping `checkout` for `git switch` leaves this assertion intact.
  const verbs = calls.map((call) => call[0]);
  assert(verbs.includes("fetch"), "expected a fetch invocation");
  // Issue #4530: with a fetched tip the branch is checked out *at* it, so the
  // fetch must precede a `checkout -B <branch> FETCH_HEAD`, not a pull.
  const reset = calls.findIndex((call) =>
    call[0] === "checkout" && call.includes("-B")
  );
  assert(reset >= 0, "expected a checkout -B invocation");
  assertEquals(calls[reset]?.at(-1), "FETCH_HEAD");
  assert(verbs.indexOf("fetch") < reset, "fetch must precede the checkout");
  assert(!verbs.includes("pull"), "no pull once the branch is at the tip");
});

Deno.test("preparePrBranch - a transient fetch failure is tolerated (checkout and pull still run) (Issue #4376)", async () => {
  const calls: string[][] = [];
  const runGitCommand = ((args: string[]) => {
    calls.push(args);
    if (args[0] === "fetch") {
      return Promise.resolve({
        ok: true as const,
        value: { code: 1, stdout: "", stderr: "remote rejected" },
      });
    }
    return Promise.resolve({
      ok: true as const,
      value: { code: 0, stdout: "", stderr: "" },
    });
  }) as unknown as GitDeps["runGitCommand"];

  const outcome = await preparePrBranch("feature-branch", {
    logger: makeSilentLogger(),
    git: { runGitCommand },
    cwd: "/tmp/repo",
  });
  assertEquals(outcome.ok, true);
  assertEquals(calls.length, 3, "checkout and pull still attempted");
});

// ---------------------------------------------------------------------------
// Issue #4530: every PR pass starts from origin's head of the PR branch
// ---------------------------------------------------------------------------

function realGit(): GitDeps["runGitCommand"] {
  return (async (args: string[], opts?: { cwd?: string }) => {
    const r = await git(args, opts?.cwd ?? ".");
    return { ok: true as const, value: r };
  }) as unknown as GitDeps["runGitCommand"];
}

function capturingLogger(warnings: { msg: string; ctx: unknown }[]): Logger {
  const logger = makeSilentLogger();
  logger.warn = ((msg: string, ctx?: unknown) => {
    warnings.push({ msg, ctx });
  }) as Logger["warn"];
  return logger;
}

Deno.test("preparePrBranch - a local branch that diverged from origin is reset onto origin's tip and the dropped commits are warned about by SHA (Issue #4530)", async () => {
  const fx = await setupGitRepoFixture("issue-4530-");
  try {
    // Origin's PR branch, and the clone's local copy of it at the same commit.
    await gitOk(["checkout", "-b", "pr-branch"], fx.clone);
    await commitFile(fx.clone, "a.txt", "a\n", "first");
    await gitOk(["push", "-u", "origin", "pr-branch"], fx.clone);
    // The unpushed local merge-like commit the issue describes.
    const stale = await commitFile(fx.clone, "local.txt", "x\n", "unpushed");
    // Someone else advances origin's branch, so local and origin diverge.
    const other = `${fx.root}/other`;
    await gitOk(["clone", fx.remote, other], fx.root);
    await gitOk(["config", "user.email", "o@example.com"], other);
    await gitOk(["config", "user.name", "Other"], other);
    await gitOk(["checkout", "pr-branch"], other);
    const tip = await commitFile(other, "remote.txt", "r\n", "reviewed head");
    await gitOk(["push", "origin", "pr-branch"], other);
    // The pass is run from a different branch, as a shared clone often is.
    await gitOk(["checkout", "main"], fx.clone);

    const warnings: { msg: string; ctx: unknown }[] = [];
    const outcome = await preparePrBranch("pr-branch", {
      logger: capturingLogger(warnings),
      git: { runGitCommand: realGit() },
      cwd: fx.clone,
    });

    assertEquals(outcome.ok, true);
    assertEquals(
      (await gitOk(["rev-parse", "HEAD"], fx.clone)).trim(),
      tip,
      "HEAD must be the fetched tip, not the stale local commit",
    );
    assertEquals(
      (await gitOk(["rev-parse", "refs/heads/pr-branch"], fx.clone)).trim(),
      tip,
    );
    const dropped = warnings.find((w) => w.msg.includes("Discarding local"));
    assert(dropped !== undefined, "expected a warning naming the dropped work");
    assertEquals(
      (dropped.ctx as { shas: string[] }).shas,
      [stale],
      "the warning must name exactly the unpushed commit",
    );
  } finally {
    await fx.cleanup();
  }
});

Deno.test("preparePrBranch - a local branch that is merely behind origin is fast-forwarded without a discard warning (Issue #4530)", async () => {
  const fx = await setupGitRepoFixture("issue-4530-behind-");
  try {
    await gitOk(["checkout", "-b", "pr-branch"], fx.clone);
    await commitFile(fx.clone, "a.txt", "a\n", "first");
    await gitOk(["push", "-u", "origin", "pr-branch"], fx.clone);
    const tip = await commitFile(fx.clone, "b.txt", "b\n", "second");
    await gitOk(["push", "origin", "pr-branch"], fx.clone);
    await gitOk(["reset", "--hard", "HEAD~1"], fx.clone);

    const warnings: { msg: string; ctx: unknown }[] = [];
    const outcome = await preparePrBranch("pr-branch", {
      logger: capturingLogger(warnings),
      git: { runGitCommand: realGit() },
      cwd: fx.clone,
    });

    assertEquals(outcome.ok, true);
    assertEquals((await gitOk(["rev-parse", "HEAD"], fx.clone)).trim(), tip);
    assertEquals(
      warnings.filter((w) => w.msg.includes("Discarding local")).length,
      0,
    );
  } finally {
    await fx.cleanup();
  }
});

Deno.test("preparePrBranch - a branch with no local copy is created at origin's tip (Issue #4530)", async () => {
  const fx = await setupGitRepoFixture("issue-4530-new-");
  try {
    await gitOk(["checkout", "-b", "pr-branch"], fx.clone);
    const tip = await commitFile(fx.clone, "a.txt", "a\n", "first");
    await gitOk(["push", "-u", "origin", "pr-branch"], fx.clone);
    await gitOk(["checkout", "main"], fx.clone);
    await gitOk(["branch", "-D", "pr-branch"], fx.clone);
    assertEquals(
      (await git(["rev-parse", "--verify", "refs/heads/pr-branch"], fx.clone))
        .code !== 0,
      true,
      "fixture: no local pr-branch",
    );

    const warnings: { msg: string; ctx: unknown }[] = [];
    const outcome = await preparePrBranch("pr-branch", {
      logger: capturingLogger(warnings),
      git: { runGitCommand: realGit() },
      cwd: fx.clone,
    });

    assertEquals(outcome.ok, true);
    assertEquals((await gitOk(["rev-parse", "HEAD"], fx.clone)).trim(), tip);
    assertEquals(
      warnings.filter((w) => w.msg.includes("Discarding")).length,
      0,
    );
  } finally {
    await fx.cleanup();
  }
});

Deno.test("preparePrBranch - a failed fetch falls back to the local branch and a best-effort pull, and checks nothing out at FETCH_HEAD (Issue #4530)", async () => {
  const calls: string[][] = [];
  const runGitCommand = ((args: string[]) => {
    calls.push(args);
    return Promise.resolve({
      ok: true as const,
      value: args[0] === "fetch"
        ? { code: 1, stdout: "", stderr: "remote rejected" }
        : { code: 0, stdout: "", stderr: "" },
    });
  }) as unknown as GitDeps["runGitCommand"];

  await preparePrBranch("feature-branch", {
    logger: makeSilentLogger(),
    git: { runGitCommand },
    cwd: "/tmp/repo",
  });

  assertEquals(
    calls.map((c) => c[0]),
    ["fetch", "checkout", "pull"],
  );
  assert(
    !calls.some((c) => c.includes("FETCH_HEAD")),
    "a stale FETCH_HEAD from an earlier fetch must never be used",
  );
});

Deno.test("preparePrBranch - a branch that no longer exists on origin is reported (branch_missing) and nothing else runs (Issue #4376)", async () => {
  const calls: string[][] = [];
  const runGitCommand = ((args: string[]) => {
    calls.push(args);
    if (args[0] === "fetch") {
      return Promise.resolve({
        ok: true as const,
        value: {
          code: 128,
          stdout: "",
          stderr:
            "fatal: couldn't find remote ref issue-4297-fix-shutdown-reconcile-progress-extensions-with-th",
        },
      });
    }
    return Promise.resolve({
      ok: true as const,
      value: { code: 0, stdout: "", stderr: "" },
    });
  }) as unknown as GitDeps["runGitCommand"];

  const outcome = await preparePrBranch(
    "issue-4297-fix-shutdown-reconcile-progress-extensions-with-th",
    {
      logger: makeSilentLogger(),
      git: { runGitCommand },
      cwd: "/tmp/repo",
    },
  );
  assertEquals(outcome.ok, false);
  if (!outcome.ok) assertEquals(outcome.reason, "branch_missing");
  assertEquals(calls.length, 1, "no checkout/pull on a branch that is gone");
});

Deno.test("preparePrBranch - a checkout failure is reported (checkout_failed): the agent must not run on the wrong branch (Issue #4376)", async () => {
  const calls: string[][] = [];
  const runGitCommand = ((args: string[]) => {
    calls.push(args);
    if (args[0] === "checkout") {
      return Promise.resolve({
        ok: false as const,
        error: new Error("pathspec not found"),
      });
    }
    return Promise.resolve({
      ok: true as const,
      value: { code: 0, stdout: "", stderr: "" },
    });
  }) as unknown as GitDeps["runGitCommand"];

  const outcome = await preparePrBranch("feature-branch", {
    logger: makeSilentLogger(),
    git: { runGitCommand },
    cwd: "/tmp/repo",
  });
  assertEquals(outcome.ok, false);
  if (!outcome.ok) assertEquals(outcome.reason, "checkout_failed");
  assertEquals(
    calls.map((c) => c[0]),
    ["fetch", "rev-list", "checkout"],
    "no pull after a failed checkout",
  );
});

Deno.test("preparePrBranch - passes cwd to every git command", async () => {
  const captured: (string | undefined)[] = [];
  const runGitCommand = ((_args: string[], options?: { cwd?: string }) => {
    captured.push(options?.cwd);
    return Promise.resolve({
      ok: true as const,
      value: { code: 0, stdout: "", stderr: "" },
    });
  }) as unknown as GitDeps["runGitCommand"];

  await preparePrBranch("feature-branch", {
    logger: makeSilentLogger(),
    git: { runGitCommand },
    cwd: "/tmp/my-repo",
  });

  assertEquals(captured, ["/tmp/my-repo", "/tmp/my-repo", "/tmp/my-repo"]);
});

// ---------------------------------------------------------------------------
// Held branch — released from this host's own lane worktree (Issue #1677)
// ---------------------------------------------------------------------------

const HELD_BY_LANE = "fatal: 'issue-171-fix' is already used by worktree at " +
  "'/home/vibe/auto-issue-work/worktrees/s1/NEAT-AI-Ockham'";

/**
 * A git runner whose `checkout <branch>` is refused until the named worktree
 * has been detached, recording every call so the order can be asserted.
 */
function heldBranchRunner(
  refusal: string,
  options: { detachSucceeds: boolean },
): {
  runGitCommand: GitDeps["runGitCommand"];
  calls: string[][];
  cwds: (string | undefined)[];
} {
  const calls: string[][] = [];
  const cwds: (string | undefined)[] = [];
  let released = false;
  const runGitCommand = ((args: string[], opts?: { cwd?: string }) => {
    calls.push(args);
    cwds.push(opts?.cwd);
    if (args[0] === "checkout" && args[1] === "--detach") {
      released = options.detachSucceeds;
      return Promise.resolve({
        ok: true as const,
        value: {
          code: options.detachSucceeds ? 0 : 128,
          stdout: "",
          stderr: options.detachSucceeds ? "" : "fatal: not a git repository",
        },
      });
    }
    if (args[0] === "checkout" && !released) {
      return Promise.resolve({
        ok: true as const,
        value: { code: 128, stdout: "", stderr: refusal },
      });
    }
    return Promise.resolve({
      ok: true as const,
      value: { code: 0, stdout: "", stderr: "" },
    });
  }) as unknown as GitDeps["runGitCommand"];
  return { runGitCommand, calls, cwds };
}

Deno.test("preparePrBranch - a branch held by one of this host's lane worktrees is released and checked out (Issue #1677)", async () => {
  const { runGitCommand, calls, cwds } = heldBranchRunner(HELD_BY_LANE, {
    detachSucceeds: true,
  });

  const outcome = await preparePrBranch("issue-171-fix", {
    logger: makeSilentLogger(),
    git: { runGitCommand },
    cwd: "/work/NEAT-AI-Ockham",
  });
  assertEquals(outcome, { ok: true });

  // The holder was detached, in its own directory, between the refused
  // checkout and the one that succeeded.
  const detachAt = calls.findIndex((c) =>
    c[0] === "checkout" && c[1] === "--detach"
  );
  assert(detachAt > 0, "the lane worktree must be detached");
  assertEquals(
    cwds[detachAt],
    "/home/vibe/auto-issue-work/worktrees/s1/NEAT-AI-Ockham",
    "detach runs in the holding worktree",
  );
  const checkouts = calls.filter((c) =>
    c[0] === "checkout" && c[1] !== "--detach"
  );
  assertEquals(checkouts.length, 2, "one refused checkout, one retry");
  assertEquals(
    checkouts[1]?.at(-1),
    "FETCH_HEAD",
    "the retry is still the reset onto the fetched tip",
  );
  assert(!calls.some((c) => c[0] === "pull"), "no pull once at the tip");
});

Deno.test("preparePrBranch - a branch held by a worktree that is not a lane worktree is reported as branch_held and left alone (Issue #1677)", async () => {
  const { runGitCommand, calls } = heldBranchRunner(
    "fatal: 'issue-171-fix' is already used by worktree at '/home/dev/checkouts/NEAT-AI-Ockham'",
    { detachSucceeds: true },
  );

  const outcome = await preparePrBranch("issue-171-fix", {
    logger: makeSilentLogger(),
    git: { runGitCommand },
    cwd: "/work/NEAT-AI-Ockham",
  });
  assertEquals(outcome.ok, false);
  if (!outcome.ok) {
    assertEquals(outcome.reason, "branch_held");
    assert(outcome.detail.includes("/home/dev/checkouts/NEAT-AI-Ockham"));
  }
  assertEquals(
    calls.some((c) => c[0] === "checkout" && c[1] === "--detach"),
    false,
    "a worktree outside <work root>/worktrees/<lane>/<repo> is never detached",
  );
  assertEquals(calls.some((c) => c[0] === "pull"), false);
});

Deno.test("preparePrBranch - a lane worktree that cannot be detached leaves the branch held (branch_held), not checkout_failed (Issue #1677)", async () => {
  const { runGitCommand, calls } = heldBranchRunner(HELD_BY_LANE, {
    detachSucceeds: false,
  });

  const outcome = await preparePrBranch("issue-171-fix", {
    logger: makeSilentLogger(),
    git: { runGitCommand },
    cwd: "/work/NEAT-AI-Ockham",
  });
  assertEquals(outcome.ok, false);
  if (!outcome.ok) assertEquals(outcome.reason, "branch_held");
  // One detach was tried; the checkout was not retried after it failed.
  assertEquals(
    calls.filter((c) => c[0] === "checkout" && c[1] === "--detach").length,
    1,
  );
  assertEquals(
    calls.filter((c) => c[0] === "checkout" && c[1] !== "--detach").length,
    1,
  );
});

// ---------------------------------------------------------------------------
// readPrResponseMessage
// ---------------------------------------------------------------------------

Deno.test("readPrResponseMessage - returns undefined when workDir is undefined", async () => {
  const result = await readPrResponseMessage(undefined);
  assertEquals(result, undefined);
});

Deno.test("readPrResponseMessage - returns undefined when file is missing", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const result = await readPrResponseMessage(tmpDir);
    assertEquals(result, undefined);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("readPrResponseMessage - reads and consumes the file", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const path = `${tmpDir}/.pr_response_message`;
    const message = "I fixed the typo on line 42.";
    await Deno.writeTextFile(path, message);

    const result = await readPrResponseMessage(tmpDir);
    assertEquals(result, message);

    // File should have been removed so a subsequent run does not see stale content
    const stillExists = await Deno.stat(path).then(() => true).catch(() =>
      false
    );
    assertEquals(stillExists, false, "file should be removed after reading");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("readPrResponseMessage - trims whitespace from file content", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const path = `${tmpDir}/.pr_response_message`;
    await Deno.writeTextFile(path, "\n  Fixed the bug.  \n\n");

    const result = await readPrResponseMessage(tmpDir);
    assertEquals(result, "Fixed the bug.");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("readPrResponseMessage - returns undefined for empty file", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const path = `${tmpDir}/.pr_response_message`;
    await Deno.writeTextFile(path, "\n  \n");

    const result = await readPrResponseMessage(tmpDir);
    assertEquals(result, undefined);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("readPrResponseMessage - redacts secrets before returning (Issue #3202)", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const path = `${tmpDir}/.pr_response_message`;
    const anthropicKey = "sk-ant-api03-" + "A".repeat(40);
    const githubToken = "ghp_" + "B".repeat(36);
    await Deno.writeTextFile(
      path,
      `I fixed the bug. The key was ${anthropicKey} and token ${githubToken}.`,
    );

    const result = await readPrResponseMessage(tmpDir);

    assert(result !== undefined, "expected a message");
    assert(
      !result!.includes(anthropicKey),
      "Anthropic key must not survive into the PR comment body",
    );
    assert(
      !result!.includes(githubToken),
      "GitHub token must not survive into the PR comment body",
    );
    assert(
      result!.includes("***REDACTED***"),
      "secrets should be replaced with the redaction placeholder",
    );
    // Non-secret prose is preserved.
    assert(result!.includes("I fixed the bug."));
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("readPrResponseMessage - neutralises marker syntax and says so (Issue #2236)", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const path = `${tmpDir}/.pr_response_message`;
    await Deno.writeTextFile(
      path,
      'Nothing to fix.\n<!-- vibe-ci-fix-deferred signature="deadbeef" ' +
        'check="build" depends-on="org/other#42" -->\n',
    );
    const events: Array<[string, string]> = [];
    const logger: Logger = {
      ...makeSilentLogger(),
      security: (event: string, details: string) =>
        void events.push([event, details]),
    };

    const result = await readPrResponseMessage(tmpDir, logger);

    assert(result !== undefined, "expected a message");
    assertEquals(
      result!.includes("<!--"),
      false,
      "no comment delimiter may survive into a fleet-authored body",
    );
    // Defused, not deleted — a reviewer still sees the attempt.
    assert(result!.includes("vibe-ci-fix-deferred"));
    assert(result!.includes("Nothing to fix."));
    assertEquals(events.length, 1, "the defusal must be logged, not swallowed");
    assertEquals(events[0]?.[0], "AGENT_MARKER_NEUTRALISED");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("readPrResponseMessage - leaves marker-free prose byte-exact (Issue #2236)", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const message = "Fixed the generic bound: Map<string, number> was wrong.";
    await Deno.writeTextFile(`${tmpDir}/.pr_response_message`, message);
    const events: string[] = [];
    const logger: Logger = {
      ...makeSilentLogger(),
      security: (event: string) => void events.push(event),
    };

    assertEquals(await readPrResponseMessage(tmpDir, logger), message);
    assertEquals(events, [], "nothing was defused, so nothing is logged");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test(
  "readPrResponseMessage - a bare result-placeholder token is replaced and logged loudly (Issue #3124)",
  async () => {
    const tmpDir = await Deno.makeTempDir();
    try {
      const message = "Full `./quality.sh`: QUALITY_RESULT_PLACEHOLDER";
      await Deno.writeTextFile(`${tmpDir}/.pr_response_message`, message);
      const errors: Array<[string, unknown?]> = [];
      const logger: Logger = {
        ...makeSilentLogger(),
        error: (msg: string, details?: unknown) =>
          void errors.push([msg, details]),
      };

      const result = await readPrResponseMessage(tmpDir, logger);

      assert(result !== undefined, "expected a message");
      assertEquals(
        result!.includes("QUALITY_RESULT_PLACEHOLDER"),
        false,
        "the bare token must never reach a public PR comment",
      );
      assert(
        result!.includes("[result not reported]"),
        "the token must be replaced with a plain not-reported marker",
      );
      assertEquals(
        errors.length,
        1,
        "the chokepoint backstop must log loudly, not swallow the problem",
      );
      assert(
        String(errors[0]?.[0]).includes("QUALITY_RESULT_PLACEHOLDER"),
        "the error must name the offending token",
      );
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "readPrResponseMessage - a token mentioned only inside backticks is left untouched (Issue #3124)",
  async () => {
    const tmpDir = await Deno.makeTempDir();
    try {
      const message =
        "Discussed the `QUALITY_RESULT_PLACEHOLDER` convention in review.";
      await Deno.writeTextFile(`${tmpDir}/.pr_response_message`, message);
      const errors: unknown[] = [];
      const logger: Logger = {
        ...makeSilentLogger(),
        error: (...args: unknown[]) => void errors.push(args),
      };

      const result = await readPrResponseMessage(tmpDir, logger);

      assertEquals(result, message);
      assertEquals(
        errors.length,
        0,
        "a backtick-wrapped mention is discussion, not an unresolved result",
      );
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "readPrResponseMessage - a clean message with no placeholder token is unaffected (Issue #3124)",
  async () => {
    const tmpDir = await Deno.makeTempDir();
    try {
      const message = "Full `./quality.sh`: passed";
      await Deno.writeTextFile(`${tmpDir}/.pr_response_message`, message);
      const errors: unknown[] = [];
      const logger: Logger = {
        ...makeSilentLogger(),
        error: (...args: unknown[]) => void errors.push(args),
      };

      const result = await readPrResponseMessage(tmpDir, logger);

      assertEquals(result, message);
      assertEquals(errors.length, 0);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

// ---------------------------------------------------------------------------
// Issue #4530: the fetch / rev-list edges the reset path depends on
// ---------------------------------------------------------------------------

function scriptedRunner(
  respond: (args: string[]) => unknown,
): { runGitCommand: GitDeps["runGitCommand"]; calls: string[][] } {
  const calls: string[][] = [];
  const runGitCommand = ((args: string[]) => {
    calls.push(args);
    return Promise.resolve(respond(args));
  }) as unknown as GitDeps["runGitCommand"];
  return { runGitCommand, calls };
}

const GIT_OK = {
  ok: true as const,
  value: { code: 0, stdout: "", stderr: "" },
};

Deno.test("preparePrBranch - a fetch that could not run at all falls back to checkout and pull, without FETCH_HEAD or a rev-list (Issue #4530)", async () => {
  const { runGitCommand, calls } = scriptedRunner((args) =>
    args[0] === "fetch"
      ? { ok: false as const, error: new Error("spawn failed") }
      : GIT_OK
  );

  const outcome = await preparePrBranch("feature-branch", {
    logger: makeSilentLogger(),
    git: { runGitCommand },
    cwd: "/tmp/repo",
  });

  assertEquals(outcome.ok, true);
  assertEquals(calls.map((c) => c[0]), ["fetch", "checkout", "pull"]);
});

Deno.test("preparePrBranch - a rev-list that could not run is tolerated and the reset still happens (Issue #4530)", async () => {
  const { runGitCommand, calls } = scriptedRunner((args) =>
    args[0] === "rev-list"
      ? { ok: false as const, error: new Error("spawn failed") }
      : GIT_OK
  );
  const warnings: { msg: string; ctx: unknown }[] = [];

  const outcome = await preparePrBranch("feature-branch", {
    logger: capturingLogger(warnings),
    git: { runGitCommand },
    cwd: "/tmp/repo",
  });

  assertEquals(outcome.ok, true);
  assertEquals(calls.map((c) => c[0]), ["fetch", "rev-list", "checkout"]);
  assertEquals(warnings.length, 0);
});

Deno.test("preparePrBranch - a failing rev-list never produces a discard warning, whatever it printed (Issue #4530)", async () => {
  const { runGitCommand } = scriptedRunner((args) =>
    args[0] === "rev-list"
      ? {
        ok: true as const,
        value: { code: 128, stdout: "deadbeef\n", stderr: "fatal: bad ref" },
      }
      : GIT_OK
  );
  const warnings: { msg: string; ctx: unknown }[] = [];

  const outcome = await preparePrBranch("feature-branch", {
    logger: capturingLogger(warnings),
    git: { runGitCommand },
    cwd: "/tmp/repo",
  });

  assertEquals(outcome.ok, true);
  assertEquals(
    warnings.filter((w) => w.msg.includes("Discarding")).length,
    0,
  );
});

Deno.test("preparePrBranch - the rev-list ends its revisions with `--`, so a working-tree file named like a ref cannot hide the dropped commits (Issue #4530)", async () => {
  const fx = await setupGitRepoFixture("issue-4530-ambiguous-");
  try {
    await gitOk(["checkout", "-b", "pr-branch"], fx.clone);
    await commitFile(fx.clone, "a.txt", "a\n", "first");
    await gitOk(["push", "-u", "origin", "pr-branch"], fx.clone);
    const stale = await commitFile(fx.clone, "local.txt", "x\n", "unpushed");
    await gitOk(["reset", "--hard", "HEAD"], fx.clone);
    // A file with the same name as the revision is ambiguous without `--`.
    await Deno.writeTextFile(`${fx.clone}/FETCH_HEAD`, "not a ref\n");
    // Origin's branch moves so the local commit is no longer an ancestor.
    const other = `${fx.root}/other`;
    await gitOk(["clone", fx.remote, other], fx.root);
    await gitOk(["config", "user.email", "o@example.com"], other);
    await gitOk(["config", "user.name", "Other"], other);
    await gitOk(["checkout", "pr-branch"], other);
    await commitFile(other, "remote.txt", "r\n", "reviewed head");
    await gitOk(["push", "origin", "pr-branch"], other);
    await gitOk(["checkout", "main"], fx.clone);

    const warnings: { msg: string; ctx: unknown }[] = [];
    await preparePrBranch("pr-branch", {
      logger: capturingLogger(warnings),
      git: { runGitCommand: realGit() },
      cwd: fx.clone,
    });

    const dropped = warnings.find((w) => w.msg.includes("Discarding local"));
    assert(dropped !== undefined, "expected a warning naming the dropped work");
    assertEquals((dropped.ctx as { shas: string[] }).shas, [stale]);
  } finally {
    await fx.cleanup();
  }
});
