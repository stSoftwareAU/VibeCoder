/**
 * Tests for broken_ref_repair.ts — repairing a broken loose ref so branch
 * creation self-heals (Issue #2880).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  brokenRefsIn,
  isBrokenRefFailure,
  removeBrokenRef,
  sweepBrokenRefs,
} from "../lib/broken_ref_repair.ts";
import { createFeatureBranchFromBase } from "../lib/git_branch.ts";
import type { GitCommandOutput } from "../lib/git_timeout.ts";
import type { Result } from "../types.ts";

// ---------------------------------------------------------------------------
// brokenRefsIn
// ---------------------------------------------------------------------------

Deno.test("brokenRefsIn - extracts a ref from 'bad object'", () => {
  const refs = brokenRefsIn(
    "fatal: bad object refs/heads/issue-1661-activity-transactions;",
  );
  assertEquals(refs, ["refs/heads/issue-1661-activity-transactions"]);
});

Deno.test("brokenRefsIn - extracts a ref from 'ignoring broken ref'", () => {
  const refs = brokenRefsIn(
    "warning: ignoring broken ref refs/remotes/origin/Develop",
  );
  assertEquals(refs, ["refs/remotes/origin/Develop"]);
});

Deno.test("brokenRefsIn - extracts a ref from 'missing object … for'", () => {
  const refs = brokenRefsIn(
    "error: missing object deadbeefdeadbeefdeadbeefdeadbeefdeadbeef for refs/heads/x",
  );
  assertEquals(refs, ["refs/heads/x"]);
});

Deno.test("brokenRefsIn - extracts a ref from 'bad ref'", () => {
  const refs = brokenRefsIn("fatal: bad ref refs/heads/y.");
  assertEquals(refs, ["refs/heads/y"]);
});

Deno.test("brokenRefsIn - the production Issue #2880 message yields both refs", () => {
  const message = [
    "git checkout -B issue-1811-x --end-of-options Develop exited 128: " +
    "fatal: bad object refs/heads/issue-1661-activity-transactions-empty-though-autotrader-s-bu;",
    "git checkout -B issue-1811-x --end-of-options origin/Develop exited 128: " +
    "warning: ignoring broken ref refs/remotes/origin/Develop",
    "fatal: 'origin/Develop' is not a commit and a branch " +
    "'issue-1811-x' cannot be created from it",
  ].join("\n");
  const refs = brokenRefsIn(message);
  assertEquals(refs, [
    "refs/heads/issue-1661-activity-transactions-empty-though-autotrader-s-bu",
    "refs/remotes/origin/Develop",
  ]);
});

Deno.test("brokenRefsIn - rejects refs outside heads/ and remotes/", () => {
  assertEquals(brokenRefsIn("fatal: bad object refs/tags/x"), []);
  assertEquals(brokenRefsIn("fatal: bad object refs/stash"), []);
  assertEquals(brokenRefsIn("fatal: bad ref refs/notes/commits"), []);
});

Deno.test("brokenRefsIn - drops a ref that climbs out with '..'", () => {
  // git's stderr can carry server-relayed `remote:` lines, so a "ref" naming
  // `..` segments must never become a repair candidate: `rev-parse
  // --git-path` would resolve it to a file outside the clone.
  assertEquals(
    brokenRefsIn("remote: fatal: bad object refs/heads/a/../../../../victim"),
    [],
  );
  assertEquals(brokenRefsIn("fatal: bad ref refs/remotes/origin/..x"), []);
});

Deno.test("brokenRefsIn - drops a ref carrying characters git refuses", () => {
  assertEquals(brokenRefsIn("fatal: bad object refs/heads/a~1"), []);
  assertEquals(brokenRefsIn("fatal: bad object refs/heads/a:b"), []);
});

Deno.test("brokenRefsIn - empty input gives an empty array", () => {
  assertEquals(brokenRefsIn(""), []);
});

Deno.test("brokenRefsIn - de-duplicates while preserving order", () => {
  const refs = brokenRefsIn(
    "fatal: bad object refs/heads/a\n" +
      "warning: ignoring broken ref refs/heads/b\n" +
      "fatal: bad object refs/heads/a\n",
  );
  assertEquals(refs, ["refs/heads/a", "refs/heads/b"]);
});

// ---------------------------------------------------------------------------
// removeBrokenRef
// ---------------------------------------------------------------------------

Deno.test("removeBrokenRef - refuses a non-allowlisted ref", async () => {
  const result = await removeBrokenRef("refs/tags/x", {});
  assert(!result.ok, "expected refusal for a ref outside heads/remotes");
});

/**
 * A fake git for removeBrokenRef: `update-ref -d` always fails (forcing the
 * filesystem fallback), `rev-parse --git-path` answers `gitPath`, and
 * `rev-parse --git-common-dir` answers `commonDir`. Records every argv.
 */
function fallbackGit(gitPath: string, commonDir: string) {
  const calls: string[][] = [];
  const fn = (
    args: string[],
  ): Promise<Result<GitCommandOutput>> => {
    calls.push([...args]);
    const out = (code: number, stdout = "", stderr = "") =>
      Promise.resolve({ ok: true as const, value: { code, stdout, stderr } });
    if (args[0] === "update-ref") return out(1, "", "error: cannot lock ref");
    if (args[0] === "rev-parse" && args[1] === "--git-path") {
      return out(0, `${gitPath}\n`);
    }
    if (args[0] === "rev-parse" && args[1] === "--git-common-dir") {
      return out(0, `${commonDir}\n`);
    }
    return out(128, "", `unexpected git ${args.join(" ")}`);
  };
  return { calls, fn };
}

Deno.test("removeBrokenRef - refuses a '..' ref before running git", async () => {
  const workDir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "vibe-broken-ref-dotdot-" }),
  );
  try {
    const victim = `${workDir}/victim`;
    await Deno.writeTextFile(victim, "keep me");
    await Deno.mkdir(`${workDir}/clone/.git`, { recursive: true });
    // What an unvalidating `rev-parse --git-path` really returns for such a
    // ref: a path that climbs out of .git.
    const git = fallbackGit(".git/refs/heads/a/../../../../victim", ".git");
    const result = await removeBrokenRef(
      "refs/heads/a/../../../../victim",
      { cwd: `${workDir}/clone` },
      git.fn,
    );
    assert(!result.ok, "expected refusal for a '..'-bearing ref");
    assertEquals(git.calls, [], "no git command may run for a '..' ref");
    assertEquals(await Deno.readTextFile(victim), "keep me");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("removeBrokenRef - never deletes a resolved path outside the git common dir", async () => {
  const workDir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "vibe-broken-ref-escape-" }),
  );
  try {
    const victim = `${workDir}/victim`;
    await Deno.writeTextFile(victim, "keep me");
    await Deno.mkdir(`${workDir}/clone/.git/refs/heads`, { recursive: true });
    // A valid ref name, but git resolves it somewhere outside the common dir.
    const git = fallbackGit(victim, ".git");
    const result = await removeBrokenRef(
      "refs/heads/x",
      { cwd: `${workDir}/clone` },
      git.fn,
    );
    assert(!result.ok, "expected refusal for a path outside the clone");
    assert(
      result.error.message.includes("outside"),
      `error should say the path is outside the git dir: ${result.error.message}`,
    );
    assertEquals(await Deno.readTextFile(victim), "keep me");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("removeBrokenRef - deletes the loose ref file inside the git common dir", async () => {
  const workDir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "vibe-broken-ref-inside-" }),
  );
  try {
    const refDir = `${workDir}/clone/.git/refs/heads`;
    await Deno.mkdir(refDir, { recursive: true });
    await Deno.writeTextFile(`${refDir}/x`, "0".repeat(40) + "\n");
    let updateRefCalls = 0;
    const fn = (args: string[]): Promise<Result<GitCommandOutput>> => {
      const out = (code: number, stdout = "") =>
        Promise.resolve({
          ok: true as const,
          value: { code, stdout, stderr: code === 0 ? "" : "error" },
        });
      if (args[0] === "update-ref") return out(++updateRefCalls === 1 ? 1 : 0);
      if (args[1] === "--git-path") return out(0, ".git/refs/heads/x\n");
      if (args[1] === "--git-common-dir") return out(0, ".git\n");
      return out(128);
    };
    const result = await removeBrokenRef(
      "refs/heads/x",
      { cwd: `${workDir}/clone` },
      fn,
    );
    assert(
      result.ok,
      `expected success: ${!result.ok && result.error.message}`,
    );
    let exists = true;
    try {
      await Deno.stat(`${refDir}/x`);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) exists = false;
      else throw error;
    }
    assert(!exists, "the loose ref file inside .git should be removed");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Integration: createFeatureBranchFromBase self-heals a broken loose ref
// (Issue #2880) — real git in temp dirs, mirroring git_branch_test.ts.
// ---------------------------------------------------------------------------

/** Run git in the given cwd with a clean, non-interactive environment. */
async function runGit(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: {
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  const out = await cmd.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

async function commitEmpty(repo: string, message: string): Promise<string> {
  const r = await runGit(repo, [
    "commit",
    "--allow-empty",
    "-q",
    "-m",
    message,
  ]);
  assertEquals(r.code, 0, `git commit failed: ${r.stderr}`);
  const rev = await runGit(repo, ["rev-parse", "HEAD"]);
  assertEquals(rev.code, 0, `git rev-parse failed: ${rev.stderr}`);
  return rev.stdout.trim();
}

/**
 * Set up a tiny remote + local clone, both on `main`, with a shared initial
 * commit. Returns { workDir, remote, local }. Caller must clean up workDir.
 */
async function setupRemoteAndClone(): Promise<{
  workDir: string;
  remote: string;
  local: string;
}> {
  const workDir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "vibe-broken-ref-" }),
  );

  const seed = `${workDir}/seed`;
  await Deno.mkdir(seed, { recursive: true });
  assertEquals((await runGit(seed, ["init", "-q", "-b", "main"])).code, 0);
  await commitEmpty(seed, "initial");

  const remote = `${workDir}/remote.git`;
  assertEquals(
    (await runGit(workDir, ["clone", "--bare", "-q", seed, remote])).code,
    0,
  );

  const local = `${workDir}/local`;
  assertEquals(
    (await runGit(workDir, ["clone", "-q", remote, local])).code,
    0,
  );

  return { workDir, remote, local };
}

/**
 * Detach HEAD and delete the local `main` branch, so `checkout -B … main`
 * cannot fall back to a local ref that happens to already be there — the
 * only way to land the feature branch is through `origin/main`. Mirrors a
 * shared clone whose lane worktrees, not the shared clone itself, hold the
 * local branch checkouts.
 */
async function detachAndDropLocalMain(local: string): Promise<void> {
  assertEquals(
    (await runGit(local, ["checkout", "-q", "--detach", "HEAD"])).code,
    0,
  );
  assertEquals((await runGit(local, ["branch", "-D", "main"])).code, 0);
}

Deno.test(
  "createFeatureBranchFromBase - self-heals a broken loose refs/heads ref (Issue #2880)",
  async () => {
    const { workDir, remote, local } = await setupRemoteAndClone();
    try {
      await detachAndDropLocalMain(local);

      // Push a new commit upstream. Without a repaired fetch the checkout
      // can only fall back to the *stale* origin/main already in the clone.
      const upstream = `${workDir}/upstream`;
      assertEquals(
        (await runGit(workDir, ["clone", "-q", remote, upstream])).code,
        0,
      );
      const freshRev = await commitEmpty(upstream, "fresh upstream commit");
      assertEquals(
        (await runGit(upstream, ["push", "-q", "origin", "main"])).code,
        0,
      );

      // Corrupt an unrelated loose ref: a 40-hex sha of a nonexistent object.
      // This alone is enough to make `git fetch origin main` fail outright
      // (Issue #2880) — confirmed against git 2.47 to name
      // refs/remotes/origin/HEAD as the "bad object" (fetch resolves the
      // remote's symbolic HEAD, which points at the corrupt origin/main).
      const brokenRefPath = `${local}/.git/refs/heads/issue-1661-x`;
      await Deno.writeTextFile(
        brokenRefPath,
        "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n",
      );

      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      };

      let result;
      try {
        result = await createFeatureBranchFromBase(
          "issue-2880-demo",
          "main",
          { cwd: local },
        );
      } finally {
        console.warn = originalWarn;
      }

      assert(
        result.ok,
        `expected the broken ref to be repaired and branch created, got: ${
          !result.ok && result.error.message
        }`,
      );

      // Lands on the remote's real tip, which only a repaired, retried fetch
      // can provide — the unfixed code has no local branch to fall back to
      // and would fail outright here.
      const headRev = (await runGit(local, ["rev-parse", "HEAD"])).stdout
        .trim();
      assertEquals(
        headRev,
        freshRev,
        "feature branch should land on the remote's real tip after repair",
      );

      // The broken ref is gone.
      await Deno.stat(brokenRefPath).then(
        () => {
          throw new Error("broken ref should have been removed");
        },
        (error) => {
          assert(error instanceof Deno.errors.NotFound);
        },
      );

      const joined = warnings.join("\n");
      assert(
        joined.includes("removed broken ref refs/heads/issue-1661-x"),
        `expected a warning naming the repaired ref, got: ${joined}`,
      );
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "createFeatureBranchFromBase - self-heals a broken refs/remotes/origin ref and re-fetches (Issue #2880)",
  async () => {
    const { workDir, remote, local } = await setupRemoteAndClone();
    try {
      await detachAndDropLocalMain(local);

      // Push a new commit upstream so the repaired remote-tracking ref
      // should land on the remote's real tip after the re-fetch.
      const upstream = `${workDir}/upstream`;
      assertEquals(
        (await runGit(workDir, ["clone", "-q", remote, upstream])).code,
        0,
      );
      const freshRev = await commitEmpty(upstream, "fresh upstream commit");
      assertEquals(
        (await runGit(upstream, ["push", "-q", "origin", "main"])).code,
        0,
      );

      // Corrupt the local clone's remote-tracking ref for main. With no
      // local main branch to fall back to, both `checkout -B … main` and
      // `checkout -B … origin/main` fail outright on the unfixed code
      // (confirmed against git 2.47: "fatal: unable to read tree …").
      const brokenRefPath = `${local}/.git/refs/remotes/origin/main`;
      await Deno.writeTextFile(
        brokenRefPath,
        "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n",
      );

      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      };

      let result;
      try {
        result = await createFeatureBranchFromBase(
          "issue-2880-remote-demo",
          "main",
          { cwd: local },
        );
      } finally {
        console.warn = originalWarn;
      }

      assert(
        result.ok,
        `expected the broken remote-tracking ref to be repaired, got: ${
          !result.ok && result.error.message
        }`,
      );

      const headRev = (await runGit(local, ["rev-parse", "HEAD"])).stdout
        .trim();
      assertEquals(
        headRev,
        freshRev,
        "feature branch should land on the remote's real tip after repair",
      );

      // git 2.47 blames the fetch failure on the remote's symbolic HEAD
      // (refs/remotes/origin/HEAD), which resolves through the corrupted
      // origin/main — removing it is enough for the retried fetch to
      // recreate origin/main cleanly from the remote.
      const joined = warnings.join("\n");
      assert(
        joined.includes("removed broken ref refs/remotes/origin/HEAD"),
        `expected a warning naming the repaired ref, got: ${joined}`,
      );
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

// ---------------------------------------------------------------------------
// isBrokenRefFailure
// ---------------------------------------------------------------------------

Deno.test("isBrokenRefFailure - true for the production Issue #2884 three-line sample", () => {
  const message = [
    "fatal: bad object refs/heads/issue-1661-foo",
    "warning: ignoring broken ref refs/remotes/origin/Develop",
    "fatal: 'origin/Develop' is not a commit and a branch " +
    "'issue-1787-x' cannot be created from it",
  ].join("\n");
  assert(isBrokenRefFailure(message));
});

Deno.test("isBrokenRefFailure - true for a lone 'bad object refs/…'", () => {
  assert(isBrokenRefFailure("fatal: bad object refs/heads/x"));
});

Deno.test("isBrokenRefFailure - true for a lone 'ignoring broken ref refs/…'", () => {
  assert(
    isBrokenRefFailure("warning: ignoring broken ref refs/remotes/origin/main"),
  );
});

Deno.test("isBrokenRefFailure - false for 'is not a commit' alone", () => {
  assert(
    !isBrokenRefFailure(
      "fatal: 'nosuch' is not a commit and a branch 'b' cannot be created from it",
    ),
  );
});

Deno.test("isBrokenRefFailure - false for an ordinary invalid-reference failure", () => {
  assert(!isBrokenRefFailure("fatal: invalid reference: nosuch"));
});

Deno.test("isBrokenRefFailure - false for 'bad object' naming a non-refs path", () => {
  assert(!isBrokenRefFailure("fatal: bad object HEAD~3"));
});

Deno.test("isBrokenRefFailure - false for 'bad object' naming a non-repairable namespace", () => {
  // Issue #2884: refs/tags/… is outside the refs/heads/ and refs/remotes/
  // namespaces this module repairs, so it must not be treated as repairable.
  assert(!isBrokenRefFailure("fatal: bad object refs/tags/v1"));
});

// ---------------------------------------------------------------------------
// sweepBrokenRefs
// ---------------------------------------------------------------------------

Deno.test("sweepBrokenRefs - fails loud when for-each-ref fails", async () => {
  const fn = (args: string[]): Promise<Result<GitCommandOutput>> => {
    if (args[0] === "for-each-ref") {
      return Promise.resolve({
        ok: true,
        value: { code: 128, stdout: "", stderr: "fatal: not a git repository" },
      });
    }
    return Promise.resolve({
      ok: false,
      error: new Error(`unexpected git ${args.join(" ")}`),
    });
  };
  const result = await sweepBrokenRefs({}, fn);
  assert(!result.ok, "expected failure when for-each-ref fails");
  assertStringIncludes(result.error.message, "not a git repository");
});

Deno.test("sweepBrokenRefs - fails loud when the fetch fails", async () => {
  const fn = (args: string[]): Promise<Result<GitCommandOutput>> => {
    if (args[0] === "for-each-ref") {
      return Promise.resolve({
        ok: true,
        value: { code: 0, stdout: "refs/heads/main\n", stderr: "" },
      });
    }
    if (args[0] === "rev-parse") {
      return Promise.resolve({
        ok: true,
        value: { code: 0, stdout: "deadbeef\n", stderr: "" },
      });
    }
    if (args[0] === "fetch") {
      return Promise.resolve({
        ok: true,
        value: { code: 128, stdout: "", stderr: "fatal: unable to access" },
      });
    }
    return Promise.resolve({
      ok: false,
      error: new Error(`unexpected git ${args.join(" ")}`),
    });
  };
  const result = await sweepBrokenRefs({}, fn);
  assert(!result.ok, "expected failure when fetch fails");
  assertStringIncludes(result.error.message, "unable to access");
});

Deno.test(
  "sweepBrokenRefs - real git repairs a broken loose ref and lets a base branch check-out succeed",
  async () => {
    const workDir = await Deno.realPath(
      await Deno.makeTempDir({ prefix: "vibe-sweep-broken-ref-" }),
    );
    try {
      const seed = `${workDir}/seed`;
      await Deno.mkdir(seed, { recursive: true });
      assertEquals(
        (await runGit(seed, ["init", "-q", "-b", "main"])).code,
        0,
      );
      await commitEmpty(seed, "initial");

      const remote = `${workDir}/remote.git`;
      assertEquals(
        (await runGit(workDir, ["clone", "--bare", "-q", seed, remote])).code,
        0,
      );

      const local = `${workDir}/local`;
      assertEquals(
        (await runGit(workDir, ["clone", "-q", remote, local])).code,
        0,
      );

      // No local `main` to fall back to — the only way to land `feat` is
      // through `origin/main`, so a broken `origin/main` genuinely blocks
      // a plain `checkout -B`.
      await detachAndDropLocalMain(local);

      // Corrupt the remote-tracking ref with a 40-hex sha the object store
      // never had.
      const brokenRefPath = `${local}/.git/refs/remotes/origin/main`;
      await Deno.writeTextFile(
        brokenRefPath,
        "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n",
      );

      // `createFeatureBranchFromBase` already self-heals broken refs
      // (Issue #2880), so a raw `checkout -B` is used here to show the
      // failure the sweep exists to pre-empt.
      const before = await runGit(local, [
        "checkout",
        "-B",
        "feat-before",
        "origin/main",
      ]);
      assert(before.code !== 0, "checkout should fail before the sweep");

      const sweep = await sweepBrokenRefs({ cwd: local });
      assert(sweep.ok, sweep.ok ? "" : sweep.error.message);
      assert(
        sweep.value.removed.includes("refs/remotes/origin/main"),
        `expected refs/remotes/origin/main among removed refs: ${
          JSON.stringify(sweep.value.removed)
        }`,
      );

      // origin/main is restored to a real commit by the `--prune` fetch —
      // no longer the corrupted sha (the loose ref file itself is
      // recreated by that same fetch, so its mere presence proves nothing).
      const restored = (await Deno.readTextFile(brokenRefPath)).trim();
      assert(
        restored !== "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        "origin/main should be restored to a real commit by the sweep's fetch",
      );

      const after = await createFeatureBranchFromBase("feat", "main", {
        cwd: local,
      });
      assert(
        after.ok,
        `expected checkout to succeed after the sweep: ${
          !after.ok && after.error.message
        }`,
      );
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "sweepBrokenRefs - an invalid base name still fails, and is not a broken-ref failure",
  async () => {
    const workDir = await Deno.realPath(
      await Deno.makeTempDir({ prefix: "vibe-sweep-invalid-base-" }),
    );
    try {
      assertEquals(
        (await runGit(workDir, ["init", "-q", "-b", "main"])).code,
        0,
      );
      await commitEmpty(workDir, "initial");

      const result = await createFeatureBranchFromBase(
        "feat",
        "no-such-base",
        { cwd: workDir },
      );
      assert(!result.ok, "expected failure for a nonexistent base branch");
      assert(
        !isBrokenRefFailure(result.error.message),
        `plain branch-creation failure should not read as a broken-ref failure: ${result.error.message}`,
      );
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);
