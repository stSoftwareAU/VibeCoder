/**
 * Finding an issue's existing work branch by issue number (Issue #220).
 *
 * Retitling an issue between two claims changed the title-derived branch
 * slug, so the old exact-name match orphaned the pushed WIP. These tests
 * pin the number-keyed lookup: the pure helpers, and the whole discovery
 * driven against a real local remote with real git.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  buildIssueBranchLsRemoteArgs,
  findResumableIssueBranch,
  isIssueBranchFor,
  parseLsRemoteHeads,
  selectResumeBranch,
} from "../lib/git_issue_branches.ts";
import type { Result } from "../types.ts";
import type { GitCommandOutput } from "../lib/git_timeout.ts";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test("isIssueBranchFor - matches the issue's branches only", () => {
  assert(isIssueBranchFor("issue-220-fix-resume", 220));
  assert(isIssueBranchFor("issue-220", 220));
  // Prefix boundary: a longer issue number must not be captured.
  assertEquals(isIssueBranchFor("issue-2201-something", 220), false);
  assertEquals(isIssueBranchFor("issue-22-something", 220), false);
  assertEquals(isIssueBranchFor("milestone/oidc", 220), false);
});

Deno.test("buildIssueBranchLsRemoteArgs - asks for both issue-branch shapes", () => {
  const args = buildIssueBranchLsRemoteArgs(220);
  assertEquals(args[0], "ls-remote");
  assert(args.includes("--heads"));
  assert(args.includes("--end-of-options"));
  assert(args.includes("refs/heads/issue-220"));
  assert(args.includes("refs/heads/issue-220-*"));
});

Deno.test("buildIssueBranchLsRemoteArgs - rejects a non-integer issue number", () => {
  assertThrows(
    () => buildIssueBranchLsRemoteArgs(Number.NaN),
    Error,
    "non-negative integer",
  );
});

Deno.test("parseLsRemoteHeads - parses head refs and ignores noise", () => {
  const stdout = [
    "warning: something noisy",
    "1111111111111111111111111111111111111111\trefs/heads/issue-220-a",
    "2222222222222222222222222222222222222222\trefs/heads/issue-220-b",
    "3333333333333333333333333333333333333333\trefs/tags/v1",
    "",
  ].join("\n");
  const parsed = parseLsRemoteHeads(stdout);
  assertEquals(parsed.map((p) => p.branch), ["issue-220-a", "issue-220-b"]);
  assertEquals(parsed[0]?.sha, "1".repeat(40));
});

Deno.test("selectResumeBranch - the persisted branch wins whatever its name", () => {
  const { chosen, others } = selectResumeBranch(
    [
      { branch: "issue-220-new-title", sha: "a", committedAtEpochSeconds: 200 },
      { branch: "issue-220-old-title", sha: "b", committedAtEpochSeconds: 100 },
    ],
    "issue-220-old-title",
  );
  assertEquals(chosen?.branch, "issue-220-old-title");
  assertEquals(others, ["issue-220-new-title"]);
});

Deno.test("selectResumeBranch - otherwise the most recently committed wins", () => {
  const { chosen, others } = selectResumeBranch([
    { branch: "issue-220-a", sha: "a", committedAtEpochSeconds: 100 },
    { branch: "issue-220-b", sha: "b", committedAtEpochSeconds: 300 },
    { branch: "issue-220-c", sha: "c", committedAtEpochSeconds: 200 },
  ]);
  assertEquals(chosen?.branch, "issue-220-b");
  assertEquals(others, ["issue-220-c", "issue-220-a"]);
});

Deno.test("selectResumeBranch - no candidates means nothing to resume", () => {
  assertEquals(selectResumeBranch([]).chosen, null);
});

// ---------------------------------------------------------------------------
// findResumableIssueBranch — pointer and failure paths (injected runner)
// ---------------------------------------------------------------------------

function stubRunner(
  handler: (args: string[]) => { code: number; stdout?: string } | Error,
): (args: string[]) => Promise<Result<GitCommandOutput>> {
  return (args: string[]) => {
    const outcome = handler(args);
    if (outcome instanceof Error) {
      return Promise.resolve({ ok: false as const, error: outcome });
    }
    return Promise.resolve({
      ok: true as const,
      value: {
        code: outcome.code,
        stdout: outcome.stdout ?? "",
        stderr: outcome.code === 0 ? "" : "boom",
      },
    });
  };
}

Deno.test("findResumableIssueBranch - the resume pointer is used without ls-remote", async () => {
  const calls: string[][] = [];
  const discovery = await findResumableIssueBranch(
    {
      issueNumber: 211,
      baseBranch: "main",
      persistedBranch: "issue-211-two-hosts-maintaining-the-same-pr",
    },
    {},
    stubRunner((args) => {
      calls.push(args);
      return { code: 0 };
    }),
  );
  assertEquals(
    discovery.branch,
    "issue-211-two-hosts-maintaining-the-same-pr",
  );
  assertEquals(discovery.source, "persisted");
  assertEquals(calls.length, 0);
});

Deno.test("findResumableIssueBranch - a failed lookup reports the error, not 'nothing found'", async () => {
  const discovery = await findResumableIssueBranch(
    { issueNumber: 220, baseBranch: "main" },
    {},
    stubRunner(() => new Error("network unreachable")),
  );
  assertEquals(discovery.branch, null);
  assertEquals(discovery.error, "network unreachable");
});

Deno.test("findResumableIssueBranch - no matching remote branch is reported cleanly", async () => {
  const discovery = await findResumableIssueBranch(
    { issueNumber: 220, baseBranch: "main" },
    {},
    stubRunner(() => ({ code: 0, stdout: "" })),
  );
  assertEquals(discovery.branch, null);
  assertEquals(discovery.source, "none");
  assertEquals(discovery.error, undefined);
  assert(discovery.reason.includes("issue-220"));
});

// ---------------------------------------------------------------------------
// findResumableIssueBranch — against a real git remote
// ---------------------------------------------------------------------------

interface Fixture {
  root: string;
  clone: string;
}

async function git(
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
): Promise<GitCommandOutput> {
  const output = await new Deno.Command("git", {
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
      ...extraEnv,
    },
  }).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

/** Origin repo with `main`, plus a clone of it. */
async function makeFixture(): Promise<Fixture> {
  const root = await Deno.makeTempDir({ prefix: "issue220-branches-" });
  const origin = `${root}/origin`;
  await Deno.mkdir(origin, { recursive: true });
  await git(["init", "-q", "-b", "main", "."], origin);
  await Deno.writeTextFile(`${origin}/README.md`, "# fixture\n");
  await git(["add", "."], origin);
  await git(["commit", "-q", "-m", "base"], origin);
  const clone = `${root}/clone`;
  await git(["clone", "-q", origin, clone], root);
  return { root, clone };
}

/** Push a branch on the origin carrying one extra commit. */
async function pushWipBranch(
  origin: string,
  branch: string,
  file: string,
): Promise<void> {
  await git(["checkout", "-q", "-b", branch, "main"], origin);
  await Deno.writeTextFile(`${origin}/${file}`, "wip\n");
  await git(["add", "."], origin);
  await git(["commit", "-q", "-m", `wip on ${branch}`], origin);
  await git(["checkout", "-q", "main"], origin);
}

Deno.test("findResumableIssueBranch - resumes a retitled issue's orphaned WIP branch", async () => {
  const { root, clone } = await makeFixture();
  try {
    await pushWipBranch(`${root}/origin`, "issue-220-old-slug", "wip.txt");
    // The current title would derive `issue-220-brand-new-slug`; nothing
    // matches it, and there is no resume pointer on disk.
    const discovery = await findResumableIssueBranch(
      { issueNumber: 220, baseBranch: "main" },
      { cwd: clone },
    );
    assertEquals(discovery.branch, "issue-220-old-slug");
    assertEquals(discovery.source, "remote-lookup");
    assertEquals(discovery.error, undefined);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("findResumableIssueBranch - ignores a branch carrying nothing beyond base", async () => {
  const { root, clone } = await makeFixture();
  try {
    // A branch at base — no WIP to resume.
    await git(["branch", "issue-220-empty", "main"], `${root}/origin`);
    const discovery = await findResumableIssueBranch(
      { issueNumber: 220, baseBranch: "main" },
      { cwd: clone },
    );
    assertEquals(discovery.branch, null);
    assertEquals(discovery.others, ["issue-220-empty"]);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("findResumableIssueBranch - another issue's branch is never resumed", async () => {
  const { root, clone } = await makeFixture();
  try {
    await pushWipBranch(`${root}/origin`, "issue-2201-other", "other.txt");
    const discovery = await findResumableIssueBranch(
      { issueNumber: 220, baseBranch: "main" },
      { cwd: clone },
    );
    assertEquals(discovery.branch, null);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("findResumableIssueBranch - with several candidates the newest wins and the rest are named", async () => {
  const { root, clone } = await makeFixture();
  const origin = `${root}/origin`;
  try {
    await pushWipBranch(origin, "issue-220-first", "first.txt");
    // Commit dates have one-second resolution, so pin the committer date
    // explicitly to make the second branch unambiguously newer.
    await git(["checkout", "-q", "-b", "issue-220-second", "main"], origin);
    await Deno.writeTextFile(`${origin}/second.txt`, "wip\n");
    await git(["add", "."], origin);
    await git(["commit", "-q", "-m", "newer wip"], origin, {
      GIT_COMMITTER_DATE: "2030-01-01T00:00:00Z",
    });
    await git(["checkout", "-q", "main"], origin);

    const discovery = await findResumableIssueBranch(
      { issueNumber: 220, baseBranch: "main" },
      { cwd: clone },
    );
    assertEquals(discovery.branch, "issue-220-second");
    assertEquals(discovery.others, ["issue-220-first"]);
    assert(discovery.reason.includes("2 remote branches"));
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});
