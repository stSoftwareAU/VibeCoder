/**
 * The babysitter brings a PR's branch up to date with its base in the same
 * push as its fix, and arms auto-merge, so CI runs once per repair and a
 * green, approved PR merges straight away (owner rule 2026-11-03).
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  armBabysitterAutoMerge,
  buildRepairPrompt,
  fix,
  mergeBaseForRepair,
  validateAndCommit,
} from "../commands/fleet_pr_babysitter.ts";
import {
  AutoMergeResult,
  type EnableAutoMergeOptions,
} from "../lib/pr_auto_merge.ts";
import { strictRefreshFixture } from "./support/strict_refresh_fixture.ts";

/** A repository with a `main` base and a `feature` head checked out. */
async function repoWithFeature(): Promise<{
  dir: string;
  git: (...args: string[]) => Promise<string>;
}> {
  const dir = await Deno.makeTempDir();
  const git = async (...args: string[]) => {
    const out = await new Deno.Command("git", {
      args,
      cwd: dir,
      stdin: "null",
    }).output();
    assert(out.success, new TextDecoder().decode(out.stderr));
    return new TextDecoder().decode(out.stdout).trim();
  };
  await git("init", "-q", "-b", "main");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.invalid");
  await Deno.writeTextFile(`${dir}/shared.txt`, "original\n");
  await git("add", ".");
  await git("commit", "-q", "-m", "initial");
  await git("checkout", "-q", "-b", "feature");
  await Deno.writeTextFile(`${dir}/feature.txt`, "feature\n");
  await git("add", ".");
  await git("commit", "-q", "-m", "feature");
  return { dir, git };
}

/** Advance `main` (and its tracking ref) without touching the checkout. */
async function advanceBase(
  git: (...args: string[]) => Promise<string>,
  file: string,
  content: string,
): Promise<void> {
  await git("checkout", "-q", "main");
  await Deno.writeTextFile(file, content);
  await git("add", ".");
  await git("commit", "-q", "-m", "base moved on");
  await git("update-ref", "refs/remotes/origin/main", "HEAD");
  await git("checkout", "-q", "feature");
}

const bot = { login: "test-app[bot]", id: "12345" };

Deno.test("a head that already contains its base is left as it is", async () => {
  const { dir, git } = await repoWithFeature();
  try {
    await git("update-ref", "refs/remotes/origin/main", "main");
    const head = await git("rev-parse", "HEAD");
    assertEquals(await mergeBaseForRepair(dir, "main"), { kind: "current" });
    assertEquals(await git("rev-parse", "HEAD"), head);
    assertEquals(await git("status", "--porcelain"), "");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a fix on an outdated head is committed with the base merged in, as one commit", async () => {
  const { dir, git } = await repoWithFeature();
  try {
    // The base's own trailing whitespace is not the fix's to answer for.
    await advanceBase(git, `${dir}/base.md`, "hard break  \nnext\n");
    const head = await git("rev-parse", "HEAD");
    const base = await git("rev-parse", "refs/remotes/origin/main");
    const sync = await mergeBaseForRepair(dir, "main");
    assertEquals(sync.kind, "merged");
    assert(sync.kind === "merged");
    // The merge waits uncommitted for the agent's fix.
    assertEquals(await git("rev-parse", "HEAD"), head);

    await Deno.writeTextFile(`${dir}/feature.txt`, "feature, fixed\n");
    await validateAndCommit(dir, 7, bot, {
      checkBaseline: sync.tree,
      mergedBase: "main",
    });

    assertEquals(await git("rev-parse", "HEAD^1"), head);
    assertEquals(await git("rev-parse", "HEAD^2"), base);
    assertEquals(
      await git("show", "-s", "--format=%s", "HEAD"),
      "Fix PR #7 quality issues and merge main",
    );
    assertEquals(await git("show", "HEAD:feature.txt"), "feature, fixed");
    assertEquals(await git("status", "--porcelain"), "");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("whitespace the fix itself adds is still refused after a clean base merge", async () => {
  const { dir, git } = await repoWithFeature();
  try {
    await advanceBase(git, `${dir}/base.txt`, "base\n");
    const sync = await mergeBaseForRepair(dir, "main");
    assert(sync.kind === "merged");
    await Deno.writeTextFile(`${dir}/feature.txt`, "trailing  \n");
    let refused = false;
    try {
      await validateAndCommit(dir, 7, bot, {
        checkBaseline: sync.tree,
        mergedBase: "main",
      });
    } catch {
      refused = true;
    }
    assert(refused, "a whitespace error in the fix must refuse the commit");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a base that conflicts with the head is left for the agent to resolve", async () => {
  const { dir, git } = await repoWithFeature();
  try {
    await Deno.writeTextFile(`${dir}/shared.txt`, "feature side\n");
    await git("commit", "-q", "-am", "feature edits shared");
    await advanceBase(git, `${dir}/shared.txt`, "base side\n");
    assertEquals(await mergeBaseForRepair(dir, "main"), { kind: "conflicted" });
    assertStringIncludes(
      await git("diff", "--name-only", "--diff-filter=U"),
      "shared.txt",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the agent is told to keep the base merge only when one was made", () => {
  for (const why of ["failed CI", "requested review changes"]) {
    const merged = buildRepairPrompt(
      why,
      1,
      "owner/repo",
      null,
      "",
      "Develop",
    );
    assertStringIncludes(merged, "merged the latest Develop");
    assertStringIncludes(merged, "one push");
    assertStringIncludes(merged, "do not abort, reset or revert it");
    assertEquals(
      buildRepairPrompt(why, 1, "owner/repo", null, "").includes(
        "merged the latest",
      ),
      false,
    );
  }
});

const candidate = {
  state: "OPEN",
  number: 9,
  title: "fix",
  author: { login: "VibeCoderST" },
  headRefName: "feature",
  headRefOid: "abc",
  baseRefName: "main",
  isCrossRepository: false,
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  statusCheckRollup: [{ conclusion: "FAILURE" }],
};

const neverGh = (args: string[]): Promise<string> => {
  throw new Error(`unexpected gh ${args.join(" ")}`);
};

Deno.test("auto-merge is armed on an unarmed PR with the fleet's identities", async () => {
  const seen: EnableAutoMergeOptions[] = [];
  await armBabysitterAutoMerge(
    "owner/repo",
    { ...candidate, autoMergeRequest: null },
    ["VibeCoderST"],
    neverGh,
    async (options) => {
      seen.push(options);
      return { result: AutoMergeResult.Enabled, message: "armed" };
    },
  );
  assertEquals(seen.length, 1);
  assertEquals(seen[0]!.repo, "owner/repo");
  assertEquals(seen[0]!.prNumber, 9);
  assertEquals(seen[0]!.headRefName, "feature");
  assertEquals(seen[0]!.baseRefName, "main");
  assertEquals(seen[0]!.fleetAuthors, ["VibeCoderST"]);
  assertEquals(seen[0]!.ghCommandFn, neverGh);
});

Deno.test("an already armed PR is not armed again", async () => {
  let calls = 0;
  await armBabysitterAutoMerge(
    "owner/repo",
    { ...candidate, autoMergeRequest: { mergeMethod: "SQUASH" } },
    ["VibeCoderST"],
    neverGh,
    async () => {
      calls++;
      return { result: AutoMergeResult.Enabled, message: "armed" };
    },
  );
  assertEquals(calls, 0);
});

Deno.test("a failure to arm auto-merge never stops the repair", async () => {
  await armBabysitterAutoMerge(
    "owner/repo",
    candidate,
    ["VibeCoderST"],
    neverGh,
    () => Promise.reject(new Error("GraphQL down")),
  );
});

Deno.test("an outdated PR is armed before its branch is refreshed", async () => {
  const f = strictRefreshFixture();
  const initial = {
    ...candidate,
    headRefOid: f.head,
    mergeStateStatus: "BEHIND",
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
  };
  const order: string[] = [];
  let updated = false;
  const gh = async (args: string[]) => {
    if (
      args[0] === "pr" && args[1] === "view" &&
      args.at(-1)?.includes("statusCheckRollup")
    ) {
      return JSON.stringify({
        ...initial,
        headRefOid: updated ? "d".repeat(40) : f.head,
      });
    }
    if (args.includes("PUT")) {
      order.push("update");
      updated = true;
    }
    return await f.gh(args);
  };
  await fix(
    "owner/repo",
    initial,
    ["VibeCoderST"],
    "VibeCoderST",
    { appId: "1", installationId: "1", privateKeyPath: "/unused" },
    "/unused",
    gh,
    () => Promise.resolve(),
    3,
    {
      armAutoMerge: async (_repo, pr) => {
        assertEquals(pr.number, initial.number);
        order.push("arm");
      },
    },
  );
  assertEquals(order, ["arm", "update"]);
});
