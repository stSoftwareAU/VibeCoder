/**
 * Resume-on-reclaim keyed on the issue number (Issue #220).
 *
 * Retitling an issue between two claims must not orphan the pushed WIP
 * branch, so discovery keys on `issue-<N>` rather than the title slug. These
 * tests drive the selection rules with injected git functions, and the
 * `ls-remote` plumbing against a real local remote.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  countCommitsAhead,
  issueBranchRefPatterns,
  listRemoteIssueBranches,
  orderBranchesByRecency,
  parseLsRemoteHeads,
} from "../lib/git_issue_branches.ts";
import {
  describeResumeOutcome,
  rankResumeCandidates,
  type ResumeBranchGitDeps,
  resumeIssueBranch,
} from "../lib/issue_branch_resume.ts";

/** Git deps that answer from a fixed remote-branch map. */
function fakeGit(
  remote: Record<string, { ahead: number }>,
  overrides: Partial<ResumeBranchGitDeps> = {},
): ResumeBranchGitDeps {
  const checkedOut: string[] = [];
  const deps: ResumeBranchGitDeps = {
    listRemoteIssueBranches: (issueNumber, _options, extraRefs = []) =>
      Promise.resolve({
        ok: true,
        value: Object.keys(remote)
          .filter((branch) =>
            branch === `issue-${issueNumber}` ||
            branch.startsWith(`issue-${issueNumber}-`) ||
            extraRefs.includes(branch)
          )
          .map((branch) => ({ branch, sha: "a".repeat(40) })),
      }),
    orderBranchesByRecency: (branches) => Promise.resolve([...branches]),
    countCommitsAhead: (_baseRef, ref) =>
      Promise.resolve(
        remote[ref]
          ? { ok: true as const, value: remote[ref].ahead }
          : { ok: false as const, error: new Error(`unknown ref ${ref}`) },
      ),
    resumeFeatureBranchFromRemote: (branch) => {
      checkedOut.push(branch);
      return Promise.resolve({ ok: true, value: branch in remote });
    },
    ...overrides,
  };
  return deps;
}

const GIT_OPTIONS = { cwd: "/tmp/does-not-matter" };

Deno.test("#220 - a retitled issue resumes the persisted branch, not the title slug", async () => {
  const outcome = await resumeIssueBranch(
    {
      issueNumber: 211,
      baseBranch: "main",
      // The resume file still names the branch created under the OLD title.
      persistedBranch: "issue-211-two-hosts-maintaining-the-same-pr",
      gitOptions: GIT_OPTIONS,
    },
    fakeGit({ "issue-211-two-hosts-maintaining-the-same-pr": { ahead: 1 } }),
  );

  assertEquals(outcome.branch, "issue-211-two-hosts-maintaining-the-same-pr");
  assertEquals(outcome.reason, "persisted");
  assertEquals(outcome.aheadCount, 1);
});

Deno.test("#220 - a pushed branch is resumed even with no resume file (cross-host reclaim)", async () => {
  const outcome = await resumeIssueBranch(
    { issueNumber: 211, baseBranch: "main", gitOptions: GIT_OPTIONS },
    fakeGit({ "issue-211-old-title": { ahead: 3 } }),
  );

  assertEquals(outcome.branch, "issue-211-old-title");
  assertEquals(outcome.reason, "only-candidate");
  assertEquals(outcome.aheadCount, 3);
});

Deno.test("#220 - several candidates: the persisted one wins and the rest are logged", async () => {
  const outcome = await resumeIssueBranch(
    {
      issueNumber: 211,
      baseBranch: "main",
      persistedBranch: "issue-211-old-title",
      gitOptions: GIT_OPTIONS,
    },
    fakeGit({
      "issue-211-new-title": { ahead: 1 },
      "issue-211-old-title": { ahead: 20 },
    }),
  );

  assertEquals(outcome.branch, "issue-211-old-title");
  assertEquals(outcome.reason, "persisted");
  assertEquals(outcome.skipped, ["issue-211-new-title (not chosen)"]);
});

Deno.test("#220 - several candidates and no resume file: the most recently pushed wins", async () => {
  const outcome = await resumeIssueBranch(
    { issueNumber: 211, baseBranch: "main", gitOptions: GIT_OPTIONS },
    fakeGit(
      {
        "issue-211-older": { ahead: 1 },
        "issue-211-newer": { ahead: 2 },
      },
      // Recency ordering puts the newest first.
      {
        orderBranchesByRecency: () =>
          Promise.resolve(["issue-211-newer", "issue-211-older"]),
      },
    ),
  );

  assertEquals(outcome.branch, "issue-211-newer");
  assertEquals(outcome.reason, "most-recent");
  assertEquals(outcome.skipped, ["issue-211-older (not chosen)"]);
});

Deno.test("#220 - a branch level with base is not resumed", async () => {
  const outcome = await resumeIssueBranch(
    { issueNumber: 211, baseBranch: "main", gitOptions: GIT_OPTIONS },
    fakeGit({ "issue-211-stale": { ahead: 0 } }),
  );

  assertEquals(outcome.branch, null);
  assertEquals(outcome.reason, "no-usable-candidate");
  assertEquals(outcome.skipped, ["issue-211-stale (no commits beyond main)"]);
});

Deno.test("#220 - no branch on the remote reports 'none existed' rather than failing", async () => {
  const outcome = await resumeIssueBranch(
    { issueNumber: 999, baseBranch: "main", gitOptions: GIT_OPTIONS },
    fakeGit({ "issue-211-other-issue": { ahead: 1 } }),
  );

  assertEquals(outcome.branch, null);
  assertEquals(outcome.reason, "no-candidates");
  assertStringIncludes(
    describeResumeOutcome(outcome, 999),
    "No prior progress branch exists for issue #999",
  );
});

Deno.test("#220 - a failed lookup is reported loudly, never as 'no prior work'", async () => {
  const outcome = await resumeIssueBranch(
    { issueNumber: 211, baseBranch: "main", gitOptions: GIT_OPTIONS },
    fakeGit({}, {
      listRemoteIssueBranches: () =>
        Promise.resolve({ ok: false, error: new Error("network unreachable") }),
    }),
  );

  assertEquals(outcome.branch, null);
  assertEquals(outcome.reason, "lookup-failed");
  const line = describeResumeOutcome(outcome, 211);
  assertStringIncludes(line, "Could not look up prior branches");
  assertStringIncludes(line, "network unreachable");
});

Deno.test("#220 - an unverifiable ahead-count still resumes, and says so", async () => {
  const outcome = await resumeIssueBranch(
    { issueNumber: 211, baseBranch: "main", gitOptions: GIT_OPTIONS },
    fakeGit({ "issue-211-wip": { ahead: 1 } }, {
      countCommitsAhead: () =>
        Promise.resolve({ ok: false, error: new Error("unknown revision") }),
    }),
  );

  assertEquals(outcome.branch, "issue-211-wip");
  assertEquals(outcome.aheadCount, undefined);
  assertStringIncludes(outcome.detail ?? "", "ahead-count unavailable");
});

Deno.test("#220 - a candidate that cannot be checked out is skipped for the next", async () => {
  const outcome = await resumeIssueBranch(
    {
      issueNumber: 211,
      baseBranch: "main",
      persistedBranch: "issue-211-gone",
      gitOptions: GIT_OPTIONS,
    },
    fakeGit(
      { "issue-211-gone": { ahead: 1 }, "issue-211-here": { ahead: 2 } },
      {
        resumeFeatureBranchFromRemote: (branch) =>
          Promise.resolve({ ok: true, value: branch === "issue-211-here" }),
      },
    ),
  );

  assertEquals(outcome.branch, "issue-211-here");
  assertEquals(outcome.skipped, ["issue-211-gone (could not be checked out)"]);
});

Deno.test("#220 - ranking prefers the persisted branch then the given order", () => {
  assertEquals(
    rankResumeCandidates(["b", "a", "c"], "c"),
    [
      { branch: "c", reason: "persisted" },
      { branch: "b", reason: "most-recent" },
      { branch: "a", reason: "most-recent" },
    ],
  );
  assertEquals(rankResumeCandidates(["only"]), [
    { branch: "only", reason: "only-candidate" },
  ]);
  // A persisted branch absent from the remote cannot be resumed.
  assertEquals(rankResumeCandidates([], "issue-1-gone"), []);
});

Deno.test("#220 - the resumed branch is named in the log line", () => {
  assertStringIncludes(
    describeResumeOutcome(
      {
        branch: "issue-211-wip",
        reason: "persisted",
        candidates: ["issue-211-wip"],
        skipped: [],
        aheadCount: 1,
      },
      211,
    ),
    "Resuming prior progress from issue-211-wip (1 commit ahead of base)",
  );
});

Deno.test("#220 - ref patterns cover the bare and slugged forms, and reject rubbish", () => {
  assertEquals(issueBranchRefPatterns(220), [
    "refs/heads/issue-220",
    "refs/heads/issue-220-*",
  ]);
  assertEquals(
    issueBranchRefPatterns(220, ["issue-220-old-title", "issue-220-old-title"]),
    [
      "refs/heads/issue-220",
      "refs/heads/issue-220-*",
      "refs/heads/issue-220-old-title",
    ],
  );
  assertThrows(() => issueBranchRefPatterns(0), Error, "positive integer");
  assertThrows(() => issueBranchRefPatterns(1.5), Error, "positive integer");
  // A dash-leading ref would be parsed by git as an option (CWE-88).
  assertThrows(
    () => issueBranchRefPatterns(220, ["--upload-pack=echo"]),
    Error,
    "must not begin with '-'",
  );
});

Deno.test("#220 - ls-remote output parses to branch/SHA pairs, ignoring noise", () => {
  const parsed = parseLsRemoteHeads(
    "7bc5ea8f0d9c1b2a3e4f5061728394a5b6c7d8e9\trefs/heads/issue-211-wip\n" +
      "not-a-sha\trefs/heads/issue-211-bogus\n" +
      "7bc5ea8f0d9c1b2a3e4f5061728394a5b6c7d8e9\trefs/tags/v1\n" +
      "\n",
  );
  assertEquals(parsed, [{
    branch: "issue-211-wip",
    sha: "7bc5ea8f0d9c1b2a3e4f5061728394a5b6c7d8e9",
  }]);
});

Deno.test("#220 - ls-remote finds an issue's branches on a real remote", async () => {
  const root = await Deno.makeTempDir({ prefix: "issue220-lsremote-" });
  try {
    const remote = `${root}/remote`;
    const clone = `${root}/clone`;
    await git(["init", "-q", "-b", "main", remote], root);
    await git(["config", "user.email", "t@example.com"], remote);
    await git(["config", "user.name", "Test"], remote);
    await git(["commit", "-q", "--allow-empty", "-m", "base"], remote);
    for (
      const branch of [
        "issue-220-old-title",
        "issue-2200-other-issue",
        "wip-issue-220-decoy",
      ]
    ) {
      await git(["branch", branch], remote);
    }
    await git(["clone", "-q", remote, clone], root);

    const listed = await listRemoteIssueBranches(220, { cwd: clone });
    assert(listed.ok);
    assertEquals(listed.value.map((entry) => entry.branch), [
      "issue-220-old-title",
    ]);

    // A branch that is only ahead by real commits counts as resumable.
    await git(["checkout", "-q", "issue-220-old-title"], remote);
    await git(["commit", "-q", "--allow-empty", "-m", "wip"], remote);
    await git(["checkout", "-q", "main"], remote);
    const ordered = await orderBranchesByRecency(["issue-220-old-title"], {
      cwd: clone,
    });
    assertEquals(ordered, ["issue-220-old-title"]);
    const ahead = await countCommitsAhead(
      "origin/main",
      "FETCH_HEAD",
      { cwd: clone },
    );
    assert(ahead.ok);
    assertEquals(ahead.value, 1);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

/** Run a git command in `cwd`, failing loudly on a non-zero exit. */
async function git(args: string[], cwd: string): Promise<void> {
  const { code, stderr } = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "null",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(stderr)}`,
    );
  }
}
