/**
 * Tests for the milestone roll-back mechanics (Issue #1771, part of #1730).
 *
 * The planning half is pure and tested as such. The executing half is tested
 * against **real git** in a bare-upstream fixture, in the shape
 * `commit_and_push_pending_test.ts` uses: a roll-back that only looked right
 * against a stubbed git is exactly the roll-back that resets the wrong commit
 * or pushes a branch nobody can merge.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  ALREADY_CLEAN_REASON,
  executeRollback,
  type MilestoneRollbackDeps,
  NOTHING_LEFT_REASON,
  parseMergedChildPrs,
  parseRevertedChildPrs,
  planRollback,
  revertCommitMessage,
  type RollbackCandidate,
} from "../lib/milestone_rollback.ts";

const MILESTONE_BRANCH = "milestone/1730-roll-back";

/** A candidate with the fields a test does not care about filled in. */
function candidate(
  fields: Partial<RollbackCandidate> & { prNumber: number },
): RollbackCandidate {
  return {
    title: `child ${fields.prNumber}`,
    sha: `${fields.prNumber}`.padStart(2, "0").repeat(20).slice(0, 40),
    mergedAt: "2026-09-01T00:00:00Z",
    files: [],
    ...fields,
  };
}

Deno.test("planRollback - lists only the children touching a conflicting file, newest first", () => {
  const plan = planRollback(
    [
      candidate({
        prNumber: 11,
        mergedAt: "2026-09-01T10:00:00Z",
        files: ["worker/deno/lib/shared.ts"],
        headRefName: "issue-11-shared",
      }),
      candidate({
        prNumber: 12,
        mergedAt: "2026-09-02T10:00:00Z",
        files: ["docs/README.md"],
        headRefName: "issue-12-docs",
      }),
      candidate({
        prNumber: 13,
        mergedAt: "2026-09-03T10:00:00Z",
        files: ["worker/deno/lib/shared.ts", "worker/deno/lib/other.ts"],
        headRefName: "issue-13-shared",
      }),
      // The sync PR carries the default branch itself; reverting it would
      // undo the very merge the roll-back is trying to achieve.
      candidate({
        prNumber: 14,
        mergedAt: "2026-09-04T10:00:00Z",
        files: ["worker/deno/lib/shared.ts"],
        headRefName: "sync/milestone-1730-roll-back",
      }),
    ],
    ["worker/deno/lib/shared.ts"],
  );

  assertEquals(plan.map((c) => c.prNumber), [13, 11]);
});

Deno.test("planRollback - never re-reverts a child, and never a candidate with no merge commit", () => {
  const candidates = [
    candidate({
      prNumber: 21,
      mergedAt: "2026-09-01T10:00:00Z",
      files: ["shared.txt"],
    }),
    candidate({
      prNumber: 22,
      mergedAt: "2026-09-02T10:00:00Z",
      files: ["shared.txt"],
    }),
    candidate({
      prNumber: 23,
      sha: "",
      mergedAt: "2026-09-03T10:00:00Z",
      files: ["shared.txt"],
    }),
  ];

  assertEquals(
    planRollback(candidates, ["shared.txt"], [22]).map((c) => c.prNumber),
    [21],
    "a child already reverted, and one with no merge commit, are both skipped",
  );
  assertEquals(
    planRollback(candidates, ["untouched.txt"]).map((c) => c.prNumber),
    [],
    "a child touching none of the conflicting paths is kept",
  );
});

Deno.test("parseRevertedChildPrs - reads the roll-back's own revert commits back", () => {
  const log = [
    revertCommitMessage(42, 'Add the "thing"'),
    "",
    'Revert child PR #7 "Older" — milestone roll-back (Issue #1730)',
    "",
    "Some unrelated commit mentioning PR #99",
  ].join("\n");
  assertEquals(parseRevertedChildPrs(log).sort((a, b) => a - b), [7, 42]);
});

Deno.test("parseMergedChildPrs - maps gh output, dropping what cannot be reverted", () => {
  const parsed = parseMergedChildPrs(JSON.stringify([
    {
      number: 5,
      title: "Child",
      mergedAt: "2026-09-01T10:00:00Z",
      headRefName: "issue-5",
      mergeCommit: { oid: "a".repeat(40) },
    },
    { number: 6, title: "No merge commit", mergeCommit: null },
    { title: "No number", mergeCommit: { oid: "b".repeat(40) } },
  ]));
  assert(parsed.ok, "a well-formed listing parses");
  assertEquals(parsed.value.length, 2);
  assertEquals(parsed.value[0]!.sha, "a".repeat(40));
  assertEquals(
    parsed.value[1]!.sha,
    "",
    "an absent merge commit reads as no SHA",
  );
});

Deno.test("parseMergedChildPrs - an unreadable listing fails, never reads as no children", () => {
  for (const broken of ["{not json", '{"prs": []}']) {
    const parsed = parseMergedChildPrs(broken);
    assertEquals(parsed.ok, false, `expected ${broken} to be refused`);
  }
});

Deno.test("revertCommitMessage - names the PR, its title and the milestone roll-back", () => {
  assertEquals(
    revertCommitMessage(1771, "Roll-back mechanics"),
    'Revert child PR #1771 "Roll-back mechanics" — milestone roll-back ' +
      "(Issue #1730)",
  );
});

// ---------------------------------------------------------------------------
// Real-git fixture
// ---------------------------------------------------------------------------

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runGit(args: string[], cwd: string): Promise<GitResult> {
  const command = new Deno.Command("git", {
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
    },
  });
  const output = await command.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

interface Fixture {
  tmp: string;
  upstream: string;
  clone: string;
}

/** Commit `files` on the checked-out branch and return the new commit SHA. */
async function commitFiles(
  clone: string,
  message: string,
  files: Record<string, string>,
): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    await Deno.writeTextFile(`${clone}/${path}`, content);
  }
  await runGit(["add", "-A"], clone);
  await runGit(["commit", "-m", message], clone);
  return (await runGit(["rev-parse", "HEAD"], clone)).stdout.trim();
}

/** A bare `main` upstream with a milestone branch checked out in a clone. */
async function makeFixture(prefix: string): Promise<Fixture> {
  const tmp = await Deno.makeTempDir({ prefix });
  const upstream = `${tmp}/upstream.git`;
  const clone = `${tmp}/clone`;

  await runGit(["init", "--bare", "-b", "main", upstream], tmp);
  const seed = `${tmp}/seed`;
  await runGit(["clone", upstream, seed], tmp);
  await runGit(["config", "user.email", "t@t"], seed);
  await runGit(["config", "user.name", "t"], seed);
  await commitFiles(seed, "seed", {
    "shared.txt": "base\n",
    "other.txt": "base\n",
    "manual.txt": "base\n",
  });
  await runGit(["push", "origin", "main"], seed);
  await runGit(["push", "origin", `main:refs/heads/${MILESTONE_BRANCH}`], seed);

  await runGit(["clone", upstream, clone], tmp);
  await runGit(["config", "user.email", "t@t"], clone);
  await runGit(["config", "user.name", "t"], clone);
  await runGit(["checkout", MILESTONE_BRANCH], clone);
  return { tmp, upstream, clone };
}

/** Move `main` on the upstream, from a scratch clone, then fetch it. */
async function advanceDefaultBranch(
  fixture: Fixture,
  files: Record<string, string>,
): Promise<void> {
  const scratch = `${fixture.tmp}/default-mover`;
  await runGit(["clone", "-b", "main", fixture.upstream, scratch], fixture.tmp);
  await runGit(["config", "user.email", "t@t"], scratch);
  await runGit(["config", "user.name", "t"], scratch);
  await commitFiles(scratch, "default branch moves on", files);
  await runGit(["push", "origin", "main"], scratch);
  await runGit(["fetch", "origin"], fixture.clone);
}

interface StubbedPr {
  number: number;
  title: string;
  mergedAt: string;
  headRefName: string;
  sha: string;
}

/** A `gh` seam that answers the two listings the roll-back makes. */
function ghStub(
  merged: StubbedPr[],
  recorded: string[][],
): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    recorded.push(args);
    if (args[0] === "pr" && args[1] === "list") {
      if (!args.includes("merged")) return Promise.resolve("[]");
      return Promise.resolve(JSON.stringify(
        merged.map((pr) => ({
          number: pr.number,
          title: pr.title,
          mergedAt: pr.mergedAt,
          headRefName: pr.headRefName,
          mergeCommit: { oid: pr.sha },
        })),
      ));
    }
    if (args[0] === "pr" && args[1] === "create") {
      return Promise.resolve("https://github.com/owner/repo/pull/99\n");
    }
    return Promise.resolve("");
  };
}

/** Deps wired to real git in the fixture clone. */
function depsFor(
  fixture: Fixture,
  gh: (args: string[]) => Promise<string>,
  extra: Partial<MilestoneRollbackDeps> = {},
): MilestoneRollbackDeps {
  return {
    repo: "owner/repo",
    milestoneBranch: MILESTONE_BRANCH,
    defaultBranch: "main",
    git: (args) => runGit(args, fixture.clone),
    gh,
    ...extra,
  };
}

Deno.test("executeRollback - reverts the one child in the way, then pushes the merged branch", async () => {
  const fixture = await makeFixture("milestone_rollback_success_");
  try {
    const shaA = await commitFiles(fixture.clone, "child A", {
      "other.txt": "child A\n",
    });
    const shaB = await commitFiles(fixture.clone, "child B", {
      "shared.txt": "child B\n",
    });
    await runGit(["push", "origin", MILESTONE_BRANCH], fixture.clone);
    await advanceDefaultBranch(fixture, { "shared.txt": "default\n" });

    const recorded: string[][] = [];
    const gh = ghStub([
      {
        number: 11,
        title: "Child A",
        mergedAt: "2026-09-01T10:00:00Z",
        headRefName: "issue-11-other",
        sha: shaA,
      },
      {
        number: 12,
        title: "Child B",
        mergedAt: "2026-09-02T10:00:00Z",
        headRefName: "issue-12-shared",
        sha: shaB,
      },
    ], recorded);

    // No conflicting paths supplied: the roll-back discovers them itself.
    const result = await executeRollback(depsFor(fixture, gh));
    assert(result.ok, `roll-back failed: ${result.ok ? "" : result.error}`);
    assertEquals(result.value.merged, true);
    assertEquals(result.value.reverted.map((c) => c.prNumber), [12]);
    assertEquals(result.value.reverted[0]!.headRefName, "issue-12-shared");

    await runGit(["fetch", "origin"], fixture.clone);
    const head = (await runGit(["rev-parse", "HEAD"], fixture.clone)).stdout
      .trim();
    const remote =
      (await runGit(["rev-parse", `origin/${MILESTONE_BRANCH}`], fixture.clone))
        .stdout.trim();
    assertEquals(remote, head, "the rolled-back branch was pushed");

    const behind = await runGit(
      ["rev-list", "--count", "HEAD..origin/main"],
      fixture.clone,
    );
    assertEquals(behind.stdout.trim(), "0", "the branch is zero behind main");

    const subjects =
      (await runGit(["log", "--format=%s", "-n", "10"], fixture.clone)).stdout;
    assertStringIncludes(subjects, 'Revert child PR #12 "Child B"');

    const ancestor = await runGit(
      ["merge-base", "--is-ancestor", shaA, "HEAD"],
      fixture.clone,
    );
    assertEquals(
      ancestor.code,
      0,
      "the untouched child's commit is still on the branch",
    );
    assertEquals(
      await Deno.readTextFile(`${fixture.clone}/other.txt`),
      "child A\n",
      "the untouched child's change survives the roll-back",
    );
    assertEquals(
      await Deno.readTextFile(`${fixture.clone}/shared.txt`),
      "default\n",
      "the default branch's version of the conflicting file is now in place",
    );
  } finally {
    await Deno.remove(fixture.tmp, { recursive: true });
  }
});

Deno.test("executeRollback - every candidate reverted and still conflicting leaves the branch untouched", async () => {
  const fixture = await makeFixture("milestone_rollback_exhausted_");
  try {
    const shaA = await commitFiles(fixture.clone, "child A", {
      "shared.txt": "child A\n",
    });
    const shaB = await commitFiles(fixture.clone, "child B", {
      "shared.txt": "child B\n",
    });
    // A change no child PR owns, conflicting in its own right: no roll-back
    // of the children can clear it.
    await commitFiles(fixture.clone, "hand edit on the milestone branch", {
      "manual.txt": "milestone\n",
    });
    await runGit(["push", "origin", MILESTONE_BRANCH], fixture.clone);
    const preRollbackSha = (await runGit(["rev-parse", "HEAD"], fixture.clone))
      .stdout.trim();
    await advanceDefaultBranch(fixture, {
      "shared.txt": "default\n",
      "manual.txt": "default\n",
    });

    const recorded: string[][] = [];
    const gh = ghStub([
      {
        number: 21,
        title: "Child A",
        mergedAt: "2026-09-01T10:00:00Z",
        headRefName: "issue-21",
        sha: shaA,
      },
      {
        number: 22,
        title: "Child B",
        mergedAt: "2026-09-02T10:00:00Z",
        headRefName: "issue-22",
        sha: shaB,
      },
    ], recorded);

    const result = await executeRollback(
      depsFor(fixture, gh, {
        conflictingPaths: ["shared.txt", "manual.txt"],
      }),
    );
    assert(result.ok, `roll-back failed: ${result.ok ? "" : result.error}`);
    assertEquals(result.value.merged, false);
    assertEquals(result.value.reverted, []);
    assertEquals(result.value.reason, NOTHING_LEFT_REASON);

    const head = (await runGit(["rev-parse", "HEAD"], fixture.clone)).stdout
      .trim();
    assertEquals(head, preRollbackSha, "the local branch was reset");
    await runGit(["fetch", "origin"], fixture.clone);
    const remote =
      (await runGit(["rev-parse", `origin/${MILESTONE_BRANCH}`], fixture.clone))
        .stdout.trim();
    assertEquals(remote, preRollbackSha, "nothing was pushed");
  } finally {
    await Deno.remove(fixture.tmp, { recursive: true });
  }
});

Deno.test("executeRollback - a ruleset-rejected push lands through the sync PR", async () => {
  const fixture = await makeFixture("milestone_rollback_ruleset_");
  try {
    const shaB = await commitFiles(fixture.clone, "child B", {
      "shared.txt": "child B\n",
    });
    await runGit(["push", "origin", MILESTONE_BRANCH], fixture.clone);
    await advanceDefaultBranch(fixture, { "shared.txt": "default\n" });
    const beforeRemote =
      (await runGit(["rev-parse", `origin/${MILESTONE_BRANCH}`], fixture.clone))
        .stdout.trim();

    // The `milestone/**` required-status-checks ruleset, as git sees it: the
    // milestone ref is refused, every other ref is not (Issue #589).
    const hook = `${fixture.upstream}/hooks/pre-receive`;
    await Deno.writeTextFile(
      hook,
      [
        "#!/bin/sh",
        "while read -r old new ref; do",
        '  case "$ref" in',
        "    refs/heads/milestone/*)",
        '      echo "remote: - 2 of 2 required status checks are expected." >&2',
        '      echo "! [remote rejected] $ref (push declined due to repository rule violations)" >&2',
        "      exit 1;;",
        "  esac",
        "done",
        "exit 0",
      ].join("\n") + "\n",
    );
    await Deno.chmod(hook, 0o755);

    const recorded: string[][] = [];
    const gh = ghStub([
      {
        number: 31,
        title: "Child B",
        mergedAt: "2026-09-02T10:00:00Z",
        headRefName: "issue-31-shared",
        sha: shaB,
      },
    ], recorded);

    const result = await executeRollback(
      depsFor(fixture, gh, { conflictingPaths: ["shared.txt"] }),
    );
    assert(result.ok, `roll-back failed: ${result.ok ? "" : result.error}`);
    assertEquals(result.value.merged, true);
    assertEquals(result.value.reverted.map((c) => c.prNumber), [31]);

    const created = recorded.find((args) =>
      args[0] === "pr" && args[1] === "create"
    );
    assert(created, "a sync PR was raised for the refused push");
    assertEquals(created[created.indexOf("--base") + 1], MILESTONE_BRANCH);
    assertStringIncludes(
      created[created.indexOf("--head") + 1]!,
      "sync/milestone-",
    );

    const refs = (await runGit(["ls-remote", "origin"], fixture.clone)).stdout;
    assertStringIncludes(refs, "refs/heads/sync/milestone-");
    await runGit(["fetch", "origin"], fixture.clone);
    assertEquals(
      (await runGit(["rev-parse", `origin/${MILESTONE_BRANCH}`], fixture.clone))
        .stdout.trim(),
      beforeRemote,
      "the gated milestone branch itself was never pushed to",
    );
  } finally {
    await Deno.remove(fixture.tmp, { recursive: true });
  }
});

Deno.test("executeRollback - a branch that already merges cleanly reverts nothing", async () => {
  const fixture = await makeFixture("milestone_rollback_clean_");
  try {
    const shaA = await commitFiles(fixture.clone, "child A", {
      "other.txt": "child A\n",
    });
    await runGit(["push", "origin", MILESTONE_BRANCH], fixture.clone);
    await advanceDefaultBranch(fixture, { "shared.txt": "default\n" });
    const preRollbackSha = (await runGit(["rev-parse", "HEAD"], fixture.clone))
      .stdout.trim();

    const warnings: string[] = [];
    const result = await executeRollback(depsFor(
      fixture,
      ghStub([
        {
          number: 41,
          title: "Child A",
          mergedAt: "2026-09-01T10:00:00Z",
          headRefName: "issue-41",
          sha: shaA,
        },
      ], []),
      { log: (message) => warnings.push(message) },
    ));

    assert(result.ok, `roll-back failed: ${result.ok ? "" : result.error}`);
    assertEquals(result.value.merged, false);
    assertEquals(result.value.reason, ALREADY_CLEAN_REASON);
    assertEquals(
      (await runGit(["rev-parse", "HEAD"], fixture.clone)).stdout.trim(),
      preRollbackSha,
      "the trial merge was undone",
    );
    assert(
      warnings.some((line) => line.startsWith("WARNING:")),
      "the anomaly is reported, not swallowed",
    );
  } finally {
    await Deno.remove(fixture.tmp, { recursive: true });
  }
});

Deno.test("executeRollback - a revert that conflicts stops the roll-back and restores the branch", async () => {
  const fixture = await makeFixture("milestone_rollback_revert_conflict_");
  try {
    const shaB = await commitFiles(fixture.clone, "child B", {
      "shared.txt": "child B\n",
    });
    // A later hand edit of the same line: reverting child B no longer applies.
    await commitFiles(fixture.clone, "hand edit on the milestone branch", {
      "shared.txt": "hand edit\n",
    });
    await runGit(["push", "origin", MILESTONE_BRANCH], fixture.clone);
    const preRollbackSha = (await runGit(["rev-parse", "HEAD"], fixture.clone))
      .stdout.trim();
    await advanceDefaultBranch(fixture, { "shared.txt": "default\n" });

    const result = await executeRollback(depsFor(
      fixture,
      ghStub([
        {
          number: 51,
          title: "Child B",
          mergedAt: "2026-09-02T10:00:00Z",
          headRefName: "issue-51",
          sha: shaB,
        },
      ], []),
      { conflictingPaths: ["shared.txt"] },
    ));

    assert(result.ok, `roll-back failed: ${result.ok ? "" : result.error}`);
    assertEquals(result.value.merged, false);
    assertEquals(result.value.reverted, []);
    assertEquals(result.value.reason, "revert conflicted on #51");
    assertEquals(
      (await runGit(["rev-parse", "HEAD"], fixture.clone)).stdout.trim(),
      preRollbackSha,
      "the branch is back where it started",
    );
    await runGit(["fetch", "origin"], fixture.clone);
    assertEquals(
      (await runGit(["rev-parse", `origin/${MILESTONE_BRANCH}`], fixture.clone))
        .stdout.trim(),
      preRollbackSha,
      "nothing was pushed",
    );
  } finally {
    await Deno.remove(fixture.tmp, { recursive: true });
  }
});

Deno.test("executeRollback - a merged tree the verification refuses is never pushed", async () => {
  const fixture = await makeFixture("milestone_rollback_verify_");
  try {
    const shaB = await commitFiles(fixture.clone, "child B", {
      "shared.txt": "child B\n",
    });
    await runGit(["push", "origin", MILESTONE_BRANCH], fixture.clone);
    const preRollbackSha = (await runGit(["rev-parse", "HEAD"], fixture.clone))
      .stdout.trim();
    await advanceDefaultBranch(fixture, { "shared.txt": "default\n" });

    const result = await executeRollback(depsFor(
      fixture,
      ghStub([
        {
          number: 61,
          title: "Child B",
          mergedAt: "2026-09-02T10:00:00Z",
          headRefName: "issue-61",
          sha: shaB,
        },
      ], []),
      {
        conflictingPaths: ["shared.txt"],
        verify: () =>
          Promise.resolve({ ok: false, detail: "the unit suite failed" }),
      },
    ));

    assert(result.ok, `roll-back failed: ${result.ok ? "" : result.error}`);
    assertEquals(result.value.merged, false);
    assertEquals(result.value.reverted, []);
    assertStringIncludes(result.value.reason ?? "", "the unit suite failed");
    assertEquals(
      (await runGit(["rev-parse", "HEAD"], fixture.clone)).stdout.trim(),
      preRollbackSha,
      "the refused merge was reset away",
    );
    await runGit(["fetch", "origin"], fixture.clone);
    assertEquals(
      (await runGit(["rev-parse", `origin/${MILESTONE_BRANCH}`], fixture.clone))
        .stdout.trim(),
      preRollbackSha,
      "nothing was pushed",
    );
  } finally {
    await Deno.remove(fixture.tmp, { recursive: true });
  }
});

Deno.test("executeRollback - an unreadable branch state fails loudly rather than reverting blind", async () => {
  const result = await executeRollback({
    repo: "owner/repo",
    milestoneBranch: MILESTONE_BRANCH,
    defaultBranch: "main",
    git: () =>
      Promise.resolve({
        code: 128,
        stdout: "",
        stderr: "not a git repository",
      }),
    gh: () => Promise.resolve("[]"),
  });
  assertEquals(result.ok, false);
  assertStringIncludes(
    result.ok ? "" : result.error.message,
    "not a git repository",
  );
});

Deno.test("executeRollback - a listing gh will not give up fails, never reads as no children", async () => {
  const fixture = await makeFixture("milestone_rollback_gh_failure_");
  try {
    await commitFiles(fixture.clone, "child B", { "shared.txt": "child B\n" });
    await runGit(["push", "origin", MILESTONE_BRANCH], fixture.clone);
    await advanceDefaultBranch(fixture, { "shared.txt": "default\n" });

    const result = await executeRollback(depsFor(
      fixture,
      () => Promise.reject(new Error("gh: API rate limit exceeded")),
      { conflictingPaths: ["shared.txt"] },
    ));
    assertEquals(result.ok, false);
    assertStringIncludes(
      result.ok ? "" : result.error.message,
      "API rate limit exceeded",
    );
  } finally {
    await Deno.remove(fixture.tmp, { recursive: true });
  }
});
