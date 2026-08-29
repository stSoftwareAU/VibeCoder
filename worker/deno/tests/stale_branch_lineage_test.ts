/**
 * Tests for stale_branch_lineage.ts — stale-lineage detection and the
 * self-healing rebase (Issue #534).
 *
 * The regression test builds the exact production shape with real git: a
 * branch is squash-merged and reaped, a second writer keeps committing on the
 * pre-merge lineage, and the guard must rebase that writer's work onto the
 * current base instead of letting an unmergeable PR be opened.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { runGitCommand } from "../lib/git_timeout.ts";
import {
  classifyBranchLineage,
  decideLineage,
  healStaleBranchLineage,
  type MergedHeadRefPr,
  parseMergedPrList,
  rebaseOntoBase,
  unexplainedDeletions,
} from "../lib/stale_branch_lineage.ts";

// ---------------------------------------------------------------------------
// decideLineage — the rules, with no IO
// ---------------------------------------------------------------------------

Deno.test("decideLineage - no merged PR from this branch is current", () => {
  const verdict = decideLineage([]);
  assertEquals(verdict.kind, "current");
});

Deno.test("decideLineage - a merged PR already in the branch is current", () => {
  // The branch was rebased onto the post-merge base: it contains the merge,
  // so follow-up work on a reused branch name is never flagged.
  const prs: MergedHeadRefPr[] = [
    { number: 531, mergeCommit: "a".repeat(40), inBase: true, inBranch: true },
  ];
  assertEquals(decideLineage(prs).kind, "current");
});

Deno.test("decideLineage - squashed into base but absent from the branch is stale", () => {
  const prs: MergedHeadRefPr[] = [
    { number: 531, mergeCommit: "b".repeat(40), inBase: true, inBranch: false },
  ];
  const verdict = decideLineage(prs);
  assertEquals(verdict.kind, "stale-squashed");
  if (verdict.kind !== "stale-squashed") throw new Error("unreachable");
  assertEquals(verdict.prNumber, 531);
  assertStringIncludes(verdict.detail, "#531");
});

Deno.test("decideLineage - a merge absent from base is not stale", () => {
  // A merged PR whose merge commit is not on this base (e.g. it merged into a
  // different milestone branch) says nothing about this branch's lineage.
  const prs: MergedHeadRefPr[] = [
    {
      number: 400,
      mergeCommit: "c".repeat(40),
      inBase: false,
      inBranch: false,
    },
  ];
  assertEquals(decideLineage(prs).kind, "current");
});

Deno.test("decideLineage - reports the newest stale merge", () => {
  const prs: MergedHeadRefPr[] = [
    { number: 200, mergeCommit: "d".repeat(40), inBase: true, inBranch: false },
    { number: 531, mergeCommit: "e".repeat(40), inBase: true, inBranch: false },
  ];
  const verdict = decideLineage(prs);
  if (verdict.kind !== "stale-squashed") throw new Error("expected stale");
  assertEquals(verdict.prNumber, 531);
});

// ---------------------------------------------------------------------------
// unexplainedDeletions — the "do not revert someone else's merge" guard
// ---------------------------------------------------------------------------

Deno.test("unexplainedDeletions - a deletion a replayed commit makes is explained", () => {
  assertEquals(unexplainedDeletions(["old.ts"], ["old.ts"]), []);
});

Deno.test("unexplainedDeletions - a deletion nothing accounts for is reported", () => {
  assertEquals(
    unexplainedDeletions(
      ["docs/REFERENCES.md", "lib/references_doc.ts"],
      ["lib/references_doc.ts"],
    ),
    ["docs/REFERENCES.md"],
  );
});

Deno.test("unexplainedDeletions - no deletions is empty", () => {
  assertEquals(unexplainedDeletions([], ["a.ts"]), []);
});

// ---------------------------------------------------------------------------
// parseMergedPrList
// ---------------------------------------------------------------------------

Deno.test("parseMergedPrList - reads number and merge commit", () => {
  const parsed = parseMergedPrList(
    JSON.stringify([{ number: 531, mergeCommit: { oid: "f".repeat(40) } }]),
  );
  assert(parsed.ok);
  assertEquals(parsed.value, [{ number: 531, mergeCommit: "f".repeat(40) }]);
});

Deno.test("parseMergedPrList - an entry with no merge commit is skipped", () => {
  const parsed = parseMergedPrList(
    JSON.stringify([{ number: 531, mergeCommit: null }]),
  );
  assert(parsed.ok);
  assertEquals(parsed.value, []);
});

Deno.test("parseMergedPrList - empty output is an empty list", () => {
  const parsed = parseMergedPrList("");
  assert(parsed.ok);
  assertEquals(parsed.value, []);
});

Deno.test("parseMergedPrList - malformed JSON is an error, never an empty list", () => {
  const parsed = parseMergedPrList("{not json");
  assert(!parsed.ok);
  assertStringIncludes(parsed.error.message, "unreadable");
});

// ---------------------------------------------------------------------------
// Real-git harness
// ---------------------------------------------------------------------------

interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run git in `cwd` with a deterministic identity. */
async function git(args: string[], cwd: string): Promise<GitRunResult> {
  const cmd = new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: {
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      PATH: Deno.env.get("PATH") ?? "",
      HOME: Deno.env.get("HOME") ?? "",
    },
  });
  const out = await cmd.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

async function gitOk(args: string[], cwd: string): Promise<string> {
  const result = await git(args, cwd);
  assertEquals(
    result.code,
    0,
    `git ${args.join(" ")} failed: ${result.stderr}`,
  );
  return result.stdout.trim();
}

async function writeAndCommit(
  repo: string,
  path: string,
  content: string,
  message: string,
): Promise<string> {
  const full = `${repo}/${path}`;
  const dir = full.slice(0, full.lastIndexOf("/"));
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(full, content);
  await gitOk(["add", "-A"], repo);
  await gitOk(["commit", "-m", message], repo);
  return await gitOk(["rev-parse", "HEAD"], repo);
}

/** A `gh` stub that reports one merged PR raised from `branch`. */
function mergedPrStub(
  prNumber: number,
  mergeCommit: string,
): (args: string[]) => Promise<string> {
  return (_args: string[]) =>
    Promise.resolve(
      JSON.stringify([{ number: prNumber, mergeCommit: { oid: mergeCommit } }]),
    );
}

const BRANCH = "issue-514-mount-the-worker-checkout-read-only";

/**
 * Build the incident: a bare origin, a squash-merged-and-reaped branch, and a
 * second writer's clone still sitting on the pre-merge lineage.
 *
 * @returns the writer's clone path, the squash commit on `main`, and the SHAs
 *   of the writer's two commits (`shared` was squashed into base, `extra` is
 *   the genuinely unmerged one).
 */
async function buildSquashMergedIncident(tmp: string): Promise<{
  writer: string;
  squashCommit: string;
  shared: string;
  extra: string;
}> {
  const origin = `${tmp}/origin.git`;
  const seed = `${tmp}/seed`;
  await gitOk(["init", "--bare", "-b", "main", origin], tmp);
  await gitOk(["clone", origin, seed], tmp);
  await gitOk(["config", "user.email", "t@t"], seed);
  await gitOk(["config", "user.name", "t"], seed);
  await writeAndCommit(seed, "README.md", "seed\n", "seed");
  await gitOk(["push", "origin", "main"], seed);

  // Writer's branch: one commit that will be squashed into base, raised as the
  // PR that merges.
  await gitOk(["checkout", "-b", BRANCH], seed);
  const shared = await writeAndCommit(
    seed,
    "docs/CONTAINMENT.md",
    "the read-only checkout\n",
    "The orphaned-branch sweep names the read-only checkout",
  );
  await gitOk(["push", "origin", BRANCH], seed);

  // The second writer clones now, so it holds the pre-merge lineage — exactly
  // the worktree that "never learned about any of the above".
  const writer = `${tmp}/writer`;
  await gitOk(["clone", origin, writer], tmp);
  await gitOk(["config", "user.email", "t@t"], writer);
  await gitOk(["config", "user.name", "t"], writer);
  await gitOk(["checkout", BRANCH], writer);

  // Meanwhile a *different* issue lands on main. Nothing this branch does may
  // delete these files — that is the Issue #517 revert trap.
  await gitOk(["checkout", "main"], seed);
  await writeAndCommit(
    seed,
    "docs/REFERENCES.md",
    "credits\n",
    "Add a references doc (Issue #517)",
  );
  await gitOk(["push", "origin", "main"], seed);

  // The branch squash-merges into main and GitHub reaps the branch.
  await gitOk(["merge", "--squash", BRANCH], seed);
  await gitOk(["commit", "-m", "Mount the checkout read-only (#531)"], seed);
  const squashCommit = await gitOk(["rev-parse", "HEAD"], seed);
  await gitOk(["push", "origin", "main"], seed);
  await gitOk(["push", "origin", "--delete", BRANCH], seed);

  // The stale writer commits on the pre-rebase lineage, unaware of any of it.
  const extra = await writeAndCommit(
    writer,
    "worker/deno/lib/branch_cleanup.ts",
    "export const sweep = true;\n",
    "Name the read-only checkout in the sweep",
  );

  return { writer, squashCommit, shared, extra };
}

// ---------------------------------------------------------------------------
// Regression test — the incident shape
// ---------------------------------------------------------------------------

Deno.test(
  "healStaleBranchLineage - rebases a squash-merged lineage instead of opening a conflicting PR (Issue #534)",
  async () => {
    const tmp = await Deno.makeTempDir({ prefix: "stale_lineage_heal_" });
    try {
      const { writer, squashCommit, shared, extra } =
        await buildSquashMergedIncident(tmp);

      const outcome = await healStaleBranchLineage({
        repo: "stSoftwareAU/VibeCoder",
        branch: BRANCH,
        baseBranch: "main",
        runGit: runGitCommand,
        runGh: mergedPrStub(531, squashCommit),
        cwd: writer,
      });

      assertEquals(outcome.kind, "healed", JSON.stringify(outcome));
      if (outcome.kind !== "healed") throw new Error("unreachable");

      // Only the genuinely unmerged commit survives; the squashed one is
      // dropped because base already carries its content.
      assertEquals(outcome.replayed.length, 1);
      assertEquals(outcome.dropped, [shared]);
      assert(outcome.pushed, "the healed branch must reach origin");
      assert(outcome.replayed[0] === extra);

      // The branch now sits on top of the current base: a PR from it can
      // fast-forward, so the CONFLICTING shape is impossible.
      const mainSha = await gitOk(["rev-parse", "origin/main"], writer);
      const ancestry = await git(
        ["merge-base", "--is-ancestor", mainSha, "HEAD"],
        writer,
      );
      assertEquals(ancestry.code, 0, "base must be an ancestor of the branch");

      // Issue #517's file — added to base while this branch was stale — is
      // still there. This is the assertion that catches a resolver that
      // "wins" by reverting someone else's merged work.
      const references = await Deno.readTextFile(
        `${writer}/docs/REFERENCES.md`,
      );
      assertEquals(references, "credits\n");

      // The unmerged work is present, and the squashed content is intact.
      assertEquals(
        await Deno.readTextFile(
          `${writer}/worker/deno/lib/branch_cleanup.ts`,
        ),
        "export const sweep = true;\n",
      );
      assertEquals(
        await Deno.readTextFile(`${writer}/docs/CONTAINMENT.md`),
        "the read-only checkout\n",
      );

      // The push actually landed the healed head on the remote.
      const remote = await gitOk(
        ["ls-remote", "--heads", "origin", BRANCH],
        writer,
      );
      assertStringIncludes(remote, outcome.newHead);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "healStaleBranchLineage - replaces a surviving stale remote branch under a lease",
  async () => {
    const tmp = await Deno.makeTempDir({ prefix: "stale_lineage_lease_" });
    try {
      const { writer, squashCommit } = await buildSquashMergedIncident(tmp);
      // The remote branch survives the merge here (no `delete_branch_on_merge`),
      // still carrying the stale lineage this writer pushed.
      await gitOk(["push", "origin", BRANCH], writer);
      const staleRemote = await gitOk(
        ["rev-parse", "HEAD"],
        writer,
      );

      const outcome = await healStaleBranchLineage({
        repo: "stSoftwareAU/VibeCoder",
        branch: BRANCH,
        baseBranch: "main",
        runGit: runGitCommand,
        runGh: mergedPrStub(531, squashCommit),
        cwd: writer,
      });

      assertEquals(outcome.kind, "healed", JSON.stringify(outcome));
      if (outcome.kind !== "healed") throw new Error("unreachable");
      assert(outcome.pushed);
      assertEquals(outcome.previousHead, staleRemote);
      const remote = await gitOk(
        ["ls-remote", "--heads", "origin", BRANCH],
        writer,
      );
      assertStringIncludes(remote, outcome.newHead);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "healStaleBranchLineage - a branch with no merged PR is left alone",
  async () => {
    const tmp = await Deno.makeTempDir({ prefix: "stale_lineage_fresh_" });
    try {
      const origin = `${tmp}/origin.git`;
      const clone = `${tmp}/clone`;
      await gitOk(["init", "--bare", "-b", "main", origin], tmp);
      await gitOk(["clone", origin, clone], tmp);
      await gitOk(["config", "user.email", "t@t"], clone);
      await gitOk(["config", "user.name", "t"], clone);
      await writeAndCommit(clone, "README.md", "seed\n", "seed");
      await gitOk(["push", "origin", "main"], clone);
      await gitOk(["checkout", "-b", "issue-9-fresh"], clone);
      const head = await writeAndCommit(clone, "new.md", "work\n", "work");

      const outcome = await healStaleBranchLineage({
        repo: "stSoftwareAU/VibeCoder",
        branch: "issue-9-fresh",
        baseBranch: "main",
        runGit: runGitCommand,
        runGh: () => Promise.resolve("[]"),
        cwd: clone,
      });

      assertEquals(outcome.kind, "not-stale");
      assertEquals(await gitOk(["rev-parse", "HEAD"], clone), head);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "healStaleBranchLineage - a branch that already contains base costs no gh call",
  async () => {
    const tmp = await Deno.makeTempDir({ prefix: "stale_lineage_prefilter_" });
    try {
      const origin = `${tmp}/origin.git`;
      const clone = `${tmp}/clone`;
      await gitOk(["init", "--bare", "-b", "main", origin], tmp);
      await gitOk(["clone", origin, clone], tmp);
      await gitOk(["config", "user.email", "t@t"], clone);
      await gitOk(["config", "user.name", "t"], clone);
      await writeAndCommit(clone, "README.md", "seed\n", "seed");
      await gitOk(["push", "origin", "main"], clone);
      await gitOk(["checkout", "-b", "issue-9-on-top"], clone);
      await writeAndCommit(clone, "new.md", "work\n", "work");

      const outcome = await healStaleBranchLineage({
        repo: "stSoftwareAU/VibeCoder",
        branch: "issue-9-on-top",
        baseBranch: "main",
        runGit: runGitCommand,
        runGh: () => {
          throw new Error("gh must not be called for an up-to-date branch");
        },
        cwd: clone,
      });

      assertEquals(outcome.kind, "not-stale");
      assertStringIncludes(outcome.detail, "already contains");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "healStaleBranchLineage - an unreadable merged-PR lookup is unknown, never 'not stale'",
  async () => {
    const tmp = await Deno.makeTempDir({ prefix: "stale_lineage_unknown_" });
    try {
      const { writer, squashCommit } = await buildSquashMergedIncident(tmp);
      const headBefore = await gitOk(["rev-parse", "HEAD"], writer);

      const outcome = await healStaleBranchLineage({
        repo: "stSoftwareAU/VibeCoder",
        branch: BRANCH,
        baseBranch: "main",
        runGit: runGitCommand,
        runGh: () => Promise.reject(new Error("gh: API rate limit exceeded")),
        cwd: writer,
      });

      assertEquals(outcome.kind, "unknown");
      assertStringIncludes(outcome.detail, "rate limit");
      // The branch must be untouched when the guard cannot answer.
      assertEquals(await gitOk(["rev-parse", "HEAD"], writer), headBefore);
      assert(squashCommit.length > 0);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

// ---------------------------------------------------------------------------
// rebaseOntoBase — the recovery's own guards
// ---------------------------------------------------------------------------

Deno.test(
  "rebaseOntoBase - refuses on a dirty working tree rather than destroying it",
  async () => {
    const tmp = await Deno.makeTempDir({ prefix: "stale_lineage_dirty_" });
    try {
      const { writer } = await buildSquashMergedIncident(tmp);
      const headBefore = await gitOk(["rev-parse", "HEAD"], writer);
      await Deno.writeTextFile(`${writer}/uncommitted.md`, "precious\n");

      const result = await rebaseOntoBase({
        branch: BRANCH,
        baseRef: "origin/main",
        runGit: runGitCommand,
        cwd: writer,
      });

      assert(!result.ok, "a dirty tree must refuse the rebase");
      assertStringIncludes(result.error.message, "uncommitted changes");
      assertEquals(await gitOk(["rev-parse", "HEAD"], writer), headBefore);
      assertEquals(
        await Deno.readTextFile(`${writer}/uncommitted.md`),
        "precious\n",
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "rebaseOntoBase - a conflicting replay restores the branch unchanged",
  async () => {
    const tmp = await Deno.makeTempDir({ prefix: "stale_lineage_conflict_" });
    try {
      const origin = `${tmp}/origin.git`;
      const seed = `${tmp}/seed`;
      await gitOk(["init", "--bare", "-b", "main", origin], tmp);
      await gitOk(["clone", origin, seed], tmp);
      await gitOk(["config", "user.email", "t@t"], seed);
      await gitOk(["config", "user.name", "t"], seed);
      await writeAndCommit(seed, "shared.md", "original\n", "seed");
      await gitOk(["push", "origin", "main"], seed);

      const clone = `${tmp}/clone`;
      await gitOk(["clone", origin, clone], tmp);
      await gitOk(["config", "user.email", "t@t"], clone);
      await gitOk(["config", "user.name", "t"], clone);
      await gitOk(["checkout", "-b", "issue-9-conflict"], clone);
      const headBefore = await writeAndCommit(
        clone,
        "shared.md",
        "branch side\n",
        "branch edit",
      );

      // Base moves the same line a different way.
      await writeAndCommit(seed, "shared.md", "base side\n", "base edit");
      await gitOk(["push", "origin", "main"], seed);
      await gitOk(["fetch", "origin", "main"], clone);

      const result = await rebaseOntoBase({
        branch: "issue-9-conflict",
        baseRef: "origin/main",
        runGit: runGitCommand,
        cwd: clone,
      });

      assert(!result.ok, "a conflicting replay must refuse, never side-pick");
      assertStringIncludes(result.error.message, "restored unchanged");
      assertEquals(await gitOk(["rev-parse", "HEAD"], clone), headBefore);
      assertEquals(
        await Deno.readTextFile(`${clone}/shared.md`),
        "branch side\n",
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

// ---------------------------------------------------------------------------
// classifyBranchLineage — end to end against a real graph
// ---------------------------------------------------------------------------

Deno.test(
  "classifyBranchLineage - names the merged PR whose squash the branch never saw",
  async () => {
    const tmp = await Deno.makeTempDir({ prefix: "stale_lineage_classify_" });
    try {
      const { writer, squashCommit } = await buildSquashMergedIncident(tmp);
      await gitOk(["fetch", "origin", "main"], writer);

      const verdict = await classifyBranchLineage({
        repo: "stSoftwareAU/VibeCoder",
        branch: BRANCH,
        baseRef: "origin/main",
        runGit: runGitCommand,
        runGh: mergedPrStub(531, squashCommit),
        cwd: writer,
      });

      assertEquals(verdict.kind, "stale-squashed");
      if (verdict.kind !== "stale-squashed") throw new Error("unreachable");
      assertEquals(verdict.mergeCommit, squashCommit);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "classifyBranchLineage - a merge commit this clone does not have is unknown",
  async () => {
    const tmp = await Deno.makeTempDir({ prefix: "stale_lineage_missing_" });
    try {
      const { writer } = await buildSquashMergedIncident(tmp);

      const verdict = await classifyBranchLineage({
        repo: "stSoftwareAU/VibeCoder",
        branch: BRANCH,
        baseRef: "origin/main",
        runGit: runGitCommand,
        runGh: mergedPrStub(531, "0".repeat(40)),
        cwd: writer,
      });

      assertEquals(verdict.kind, "unknown");
      assertStringIncludes(verdict.detail, "not present in this clone");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);
