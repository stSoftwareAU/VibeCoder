/**
 * Tests for broken_ref_repair.ts — repairing a broken loose ref so branch
 * creation self-heals (Issue #2880).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { brokenRefsIn, removeBrokenRef } from "../lib/broken_ref_repair.ts";
import { createFeatureBranchFromBase } from "../lib/git_branch.ts";

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

Deno.test("brokenRefsIn - rejects unsafe ref names", () => {
  // A dash-leading "ref" would be parsed by git as an option, not a ref —
  // assertSafeGitRef must reject it before it ever reaches update-ref.
  assertEquals(brokenRefsIn("fatal: bad object refs/heads/-x"), []);
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

Deno.test("removeBrokenRef - refuses an unsafe ref name", async () => {
  const result = await removeBrokenRef("refs/heads/-x", {});
  assert(!result.ok, "expected refusal for a dash-leading ref component");
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

Deno.test(
  "createFeatureBranchFromBase - self-heals a broken loose refs/heads ref (Issue #2880)",
  async () => {
    const { workDir, remote, local } = await setupRemoteAndClone();
    try {
      // Push a new commit upstream so the fetch this repair unblocks is the
      // only way to land on the remote's real tip — the unfixed fallback to
      // the local 'main' branch would land on the stale initial commit
      // instead, and say so ("from 'main'", not "from 'origin/main'").
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
      // (Issue #2880), so the unfixed code falls back to the stale local ref.
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

      // Created from the freshly repaired fetch, not the stale local ref —
      // the unfixed fallback path would say "from 'main'" and leave HEAD on
      // the initial commit.
      assert(
        result.value.includes("from 'origin/main'"),
        `expected the branch to be created from the repaired 'origin/main', got: ${result.value}`,
      );

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

      // Corrupt the local clone's remote-tracking ref for main.
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

      const joined = warnings.join("\n");
      assert(
        joined.includes("removed broken ref refs/remotes/origin/main"),
        `expected a warning naming the repaired ref, got: ${joined}`,
      );
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);
