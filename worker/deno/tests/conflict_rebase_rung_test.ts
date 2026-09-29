/**
 * Tests for conflict_rebase_rung.ts — the stale-verdict ladder's merge rung
 * (Issues #2279, #2806, parent #2272).
 *
 * The property every test here protects is Issue #2806's: the rung never
 * rewrites history. It never runs `git rebase`, no push it makes carries
 * `--force`, `--force-with-lease` or a `+` refspec, and a pushed head is a
 * merge commit on top of the old one. The scripted cases pin the argv the
 * rung hands git; the real-git cases prove the history against a real remote.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildMergeCommitMessage,
  type MergeGitOutcome,
  type MergeGitRunner,
  type MergeRungOutcome,
  runMergeRung,
} from "../lib/conflict_rebase_rung.ts";
import type { Result } from "../types.ts";

// ---------------------------------------------------------------------------
// Shared assertions
// ---------------------------------------------------------------------------

/** No argv the rung issued may be a `git rebase` of any kind. */
function assertNoRebase(argv: string[][]): void {
  assertEquals(
    argv.filter((args) => args.includes("rebase")),
    [],
    "the rung must never invoke `git rebase`",
  );
}

/** No push may force, lease or use a `+` (forced) refspec. */
function assertNoForcedPush(pushes: string[][]): void {
  for (const push of pushes) {
    const forced = push.filter((arg) =>
      arg === "-f" || arg.startsWith("--force") || arg.startsWith("+")
    );
    assertEquals(forced, [], `a forced push: ${push.join(" ")}`);
  }
}

// ---------------------------------------------------------------------------
// Scripted git
// ---------------------------------------------------------------------------

const OLD = "1111111111111111111111111111111111111111";
const MERGED = "2222222222222222222222222222222222222222";
const ELSEWHERE = "3333333333333333333333333333333333333333";

interface GitScript {
  /** `git rev-parse HEAD` before anything moves it. */
  headSha: string;
  /** Exit code for `git merge --no-ff ... origin/<base>`. */
  mergeCode: number;
  /** `git rev-parse HEAD` once a successful merge has run. */
  headAfterMerge: string;
  /** Paths `git diff --diff-filter=U` reports while the merge is stopped. */
  unmergedPaths: string[];
  /** Exit code for `git merge --abort`. */
  abortCode: number;
  /** Exit code for `git reset --hard`. */
  resetCode: number;
  /** Exit code for the plain push. */
  pushCode: number;
}

function makeScript(overrides?: Partial<GitScript>): GitScript {
  return {
    headSha: OLD,
    mergeCode: 0,
    headAfterMerge: MERGED,
    unmergedPaths: [],
    abortCode: 0,
    resetCode: 0,
    pushCode: 0,
    ...overrides,
  };
}

interface Captured {
  /** Every argv the rung handed git, in order. */
  argv: string[][];
  /** `git push` invocations. */
  pushes: string[][];
  /** Revisions `git reset --hard` was pointed at. */
  resets: string[];
}

function ok(value: MergeGitOutcome): Result<MergeGitOutcome> {
  return { ok: true, value };
}

const PUSH_REJECTED =
  "! [rejected] issue-16-fix -> issue-16-fix (fetch first)\n" +
  "error: failed to push some refs";

function makeGit(script: GitScript, captured: Captured): MergeGitRunner {
  let head = script.headSha;

  return (args: string[]) => {
    captured.argv.push(args);

    if (args[0] === "rev-parse" && args[1] === "HEAD") {
      return Promise.resolve(ok({ code: 0, stdout: `${head}\n`, stderr: "" }));
    }
    if (args[0] === "merge" && args.includes("--abort")) {
      return Promise.resolve(ok({
        code: script.abortCode,
        stdout: "",
        stderr: script.abortCode === 0 ? "" : "fatal: no merge to abort",
      }));
    }
    if (args[0] === "merge") {
      if (script.mergeCode === 0) head = script.headAfterMerge;
      return Promise.resolve(ok({
        code: script.mergeCode,
        stdout: script.mergeCode === 0
          ? ""
          : "CONFLICT (content): Merge conflict in SECURITY.md",
        stderr: script.mergeCode === 0 ? "" : "fatal: merge failed",
      }));
    }
    if (args[0] === "diff" && args.includes("--diff-filter=U")) {
      return Promise.resolve(ok({
        code: 0,
        stdout: script.unmergedPaths.join("\n"),
        stderr: "",
      }));
    }
    if (args[0] === "reset" && args[1] === "--hard") {
      const revision = args[2] ?? "";
      captured.resets.push(revision);
      if (script.resetCode === 0) head = revision.toLowerCase();
      return Promise.resolve(ok({
        code: script.resetCode,
        stdout: "",
        stderr: script.resetCode === 0 ? "" : "reset failed",
      }));
    }
    if (args[0] === "push") {
      captured.pushes.push(args);
      return Promise.resolve(ok({
        code: script.pushCode,
        stdout: "",
        stderr: script.pushCode === 0 ? "" : PUSH_REJECTED,
      }));
    }
    return Promise.resolve(ok({ code: 0, stdout: "", stderr: "" }));
  };
}

async function runScripted(
  script: GitScript,
  oldHead: string = OLD,
): Promise<{ captured: Captured; outcome: MergeRungOutcome }> {
  const captured: Captured = { argv: [], pushes: [], resets: [] };
  const outcome = await runMergeRung({
    branchName: "issue-16-fix",
    baseBranch: "Develop",
    oldHead,
    cwd: "/clone",
    git: makeGit(script, captured),
    runId: "vibe-test-run",
  });
  return { captured, outcome };
}

async function expectThrow(script: GitScript): Promise<{
  captured: Captured;
  error: Error;
}> {
  const captured: Captured = { argv: [], pushes: [], resets: [] };
  try {
    await runMergeRung({
      branchName: "issue-16-fix",
      baseBranch: "Develop",
      oldHead: OLD,
      cwd: "/clone",
      git: makeGit(script, captured),
      runId: "vibe-test-run",
    });
  } catch (err) {
    return { captured, error: err as Error };
  }
  throw new Error("expected runMergeRung to throw, but it returned");
}

// ---------------------------------------------------------------------------
// Scripted: the argv the rung hands git
// ---------------------------------------------------------------------------

Deno.test("runMergeRung - a clean merge is pushed once, plainly", async () => {
  const { captured, outcome } = await runScripted(makeScript());

  assertEquals(outcome, { kind: "pushed", oldHead: OLD, newHead: MERGED });
  assertNoRebase(captured.argv);
  assertEquals(captured.pushes, [[
    "push",
    "--end-of-options",
    "origin",
    "issue-16-fix",
  ]]);
  assertNoForcedPush(captured.pushes);
  assertEquals(captured.resets, [], "a clean merge resets nothing");

  const merge = captured.argv.find((args) => args[0] === "merge") ?? [];
  assert(merge.includes("--no-ff"), "a real merge commit, never a rewrite");
  assertEquals(merge.at(-1), "origin/Develop");
  assert(
    merge.some((arg) => arg.includes("Vibe-Coder-Run-Id: vibe-test-run")),
    "the merge commit is attributable to this run",
  );
});

Deno.test("runMergeRung - a conflicting merge is aborted and reported so the ladder climbs", async () => {
  const { captured, outcome } = await runScripted(
    makeScript({ mergeCode: 1, unmergedPaths: ["SECURITY.md", "deno.lock"] }),
  );

  assertEquals(outcome.kind, "merge-conflicted");
  assert(outcome.kind === "merge-conflicted");
  assertEquals(outcome.conflictedPaths, 2);
  assertEquals(captured.pushes, [], "a conflicted merge pushes nothing");

  // The unmerged paths are read while the merge is still stopped — after the
  // abort git reports none, so the conflict would be invisible.
  const unmergedIndex = captured.argv.findIndex((args) =>
    args.includes("--diff-filter=U")
  );
  const abortIndex = captured.argv.findIndex((args) =>
    args[0] === "merge" && args.includes("--abort")
  );
  assert(abortIndex >= 0, "the conflicted merge must be aborted");
  assert(unmergedIndex >= 0 && unmergedIndex < abortIndex);
  assertNoRebase(captured.argv);
});

Deno.test("runMergeRung - a merge that moves nothing pushes nothing", async () => {
  // The base is already in OLD — the ladder's own entry condition. Pushing
  // OLD back would give GitHub nothing new while claiming a merge.
  const { captured, outcome } = await runScripted(
    makeScript({ headAfterMerge: OLD }),
  );

  assertEquals(outcome, { kind: "nothing-to-merge" });
  assertEquals(captured.pushes, []);
  assertEquals(captured.resets, []);
});

Deno.test("runMergeRung - a rejected push restores OLD and carries git's stderr, never forcing", async () => {
  const { captured, outcome } = await runScripted(makeScript({ pushCode: 1 }));

  assertEquals(outcome, { kind: "push-refused", detail: PUSH_REJECTED });
  assertEquals(captured.pushes.length, 1, "no retry, and no forced fallback");
  assertNoForcedPush(captured.pushes);
  assertEquals(captured.resets, [OLD], "the unpushed merge is not left behind");
});

Deno.test("runMergeRung - a clone that is not at the judged head touches nothing", async () => {
  const { captured, outcome } = await runScripted(
    makeScript({ headSha: ELSEWHERE }),
  );

  assertEquals(outcome, { kind: "head-moved", localHead: ELSEWHERE });
  assertEquals(captured.argv.map((args) => args[0]), ["rev-parse"]);
});

Deno.test("runMergeRung - a merge failure with no unmerged paths restores OLD and fails loud", async () => {
  const { captured, error } = await expectThrow(
    makeScript({ mergeCode: 1, unmergedPaths: [] }),
  );

  assertStringIncludes(error.message, "no unmerged paths");
  assertStringIncludes(error.message, "fatal: merge failed");
  assertEquals(captured.pushes, []);
  assertEquals(captured.resets, [OLD]);
});

Deno.test("runMergeRung - an abort that fails restores OLD and fails loud", async () => {
  const { captured, error } = await expectThrow(
    makeScript({ mergeCode: 1, unmergedPaths: ["SECURITY.md"], abortCode: 1 }),
  );

  assertStringIncludes(error.message, "--abort");
  assertEquals(captured.pushes, []);
  assertEquals(captured.resets, [OLD]);
});

Deno.test("runMergeRung - an unreadable HEAD fails loud before anything moves", async () => {
  let threw: Error | undefined;
  try {
    await runMergeRung({
      branchName: "issue-16-fix",
      baseBranch: "Develop",
      oldHead: OLD,
      cwd: "/clone",
      git: () =>
        Promise.resolve({ ok: false, error: new Error("not a repository") }),
      runId: "vibe-test-run",
    });
  } catch (err) {
    threw = err as Error;
  }
  assert(threw !== undefined);
  assertStringIncludes(threw.message, "rev-parse HEAD");
});

Deno.test("runMergeRung - an unusable old head is refused before any git runs", async () => {
  const captured: Captured = { argv: [], pushes: [], resets: [] };
  let threw: Error | undefined;
  try {
    await runMergeRung({
      branchName: "issue-16-fix",
      baseBranch: "Develop",
      oldHead: "not-a-sha",
      cwd: "/clone",
      git: makeGit(makeScript(), captured),
    });
  } catch (err) {
    threw = err as Error;
  }
  assert(threw !== undefined);
  assertStringIncludes(threw.message, "7–40 hex characters");
  assertEquals(captured.argv, []);
});

Deno.test("runMergeRung - no outcome ever rebases or forces a push", async () => {
  const scenarios: Partial<GitScript>[] = [
    {},
    { mergeCode: 1, unmergedPaths: ["SECURITY.md"] },
    { headAfterMerge: OLD },
    { pushCode: 1 },
    { headSha: ELSEWHERE },
  ];
  for (const overrides of scenarios) {
    const { captured } = await runScripted(makeScript(overrides));
    assertNoRebase(captured.argv);
    assertNoForcedPush(captured.pushes);
  }
});

Deno.test("buildMergeCommitMessage - names the parent issue, the old head and stays attributable", () => {
  const message = buildMergeCommitMessage("Develop", OLD, "vibe-test-run");
  assertStringIncludes(message, "Issue #2272");
  assertStringIncludes(message, "Issue #2806");
  assertStringIncludes(message, OLD);
  assertStringIncludes(message, "origin/Develop");
  assertStringIncludes(message, "Vibe-Coder-Run-Id: vibe-test-run");
});

// ---------------------------------------------------------------------------
// Real git: the history the rung leaves behind
// ---------------------------------------------------------------------------

const GIT_ENV = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  // Keep the host's hooks and config out of the fixture.
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

async function gitIn(args: string[], cwd: string): Promise<MergeGitOutcome> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    env: GIT_ENV,
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

/** Run git and fail the fixture loudly if it does not succeed. */
async function mustGit(args: string[], cwd: string): Promise<string> {
  const out = await gitIn(args, cwd);
  if (out.code !== 0) {
    throw new Error(`fixture: git ${args.join(" ")} failed: ${out.stderr}`);
  }
  return out.stdout.trim();
}

async function commitFile(
  cwd: string,
  path: string,
  content: string,
): Promise<void> {
  await Deno.writeTextFile(`${cwd}/${path}`, content);
  await mustGit(["add", path], cwd);
  await mustGit(["commit", "-m", `edit ${path}`], cwd);
}

interface Fixture {
  tmp: string;
  remote: string;
  clone: string;
  oldHead: string;
}

/**
 * A remote with `main` and a PR branch `feature`, and a clone checked out on
 * `feature` with `origin/main` fetched. `baseEdit` / `featureEdit` choose what
 * each side commits after the branch point; `null` commits nothing.
 */
async function makeFixture(
  featureEdit: [string, string],
  baseEdit: [string, string] | null,
): Promise<Fixture> {
  const tmp = await Deno.makeTempDir({ prefix: "merge_rung_" });
  const remote = `${tmp}/remote.git`;
  const seed = `${tmp}/seed`;
  const clone = `${tmp}/clone`;
  await mustGit(["init", "--bare", "-b", "main", remote], tmp);
  await mustGit(["clone", remote, seed], tmp);
  await mustGit(["checkout", "-b", "main"], seed);
  await commitFile(seed, "shared.txt", "line one\n");
  await mustGit(["push", "origin", "main"], seed);

  await mustGit(["checkout", "-b", "feature"], seed);
  await commitFile(seed, featureEdit[0], featureEdit[1]);
  await mustGit(["push", "origin", "feature"], seed);

  if (baseEdit !== null) {
    await mustGit(["checkout", "main"], seed);
    await commitFile(seed, baseEdit[0], baseEdit[1]);
    await mustGit(["push", "origin", "main"], seed);
  }

  await mustGit(["clone", "-b", "feature", remote, clone], tmp);
  const oldHead = await mustGit(["rev-parse", "HEAD"], clone);
  return { tmp, remote, clone, oldHead };
}

/** A real runner that also records every argv, for the no-force checks. */
function recordingRealGit(captured: Captured): MergeGitRunner {
  return async (args, { cwd }) => {
    captured.argv.push(args);
    if (args[0] === "push") captured.pushes.push(args);
    return { ok: true, value: await gitIn(args, cwd) };
  };
}

async function runReal(
  fixture: Fixture,
): Promise<{ captured: Captured; outcome: MergeRungOutcome }> {
  const captured: Captured = { argv: [], pushes: [], resets: [] };
  const outcome = await runMergeRung({
    branchName: "feature",
    baseBranch: "main",
    oldHead: fixture.oldHead,
    cwd: fixture.clone,
    git: recordingRealGit(captured),
    runId: "vibe-test-run",
  });
  return { captured, outcome };
}

async function remoteHead(fixture: Fixture, branch: string): Promise<string> {
  return await mustGit(["rev-parse", branch], fixture.remote);
}

Deno.test("runMergeRung (real git) - a clean merge lands a merge commit on top of the old head", async () => {
  const fixture = await makeFixture(["feature.txt", "feature\n"], [
    "base.txt",
    "base\n",
  ]);
  try {
    const { captured, outcome } = await runReal(fixture);

    assertEquals(outcome.kind, "pushed");
    assert(outcome.kind === "pushed");
    assertNoRebase(captured.argv);
    assertNoForcedPush(captured.pushes);

    // The old head survives as an ancestor: nothing was rewritten.
    const ancestor = await gitIn(
      ["merge-base", "--is-ancestor", fixture.oldHead, outcome.newHead],
      fixture.clone,
    );
    assertEquals(ancestor.code, 0, "the old head must be an ancestor");

    // A real merge commit: first parent the old head, second the base.
    const parents = (await mustGit(
      ["rev-list", "--parents", "-n", "1", outcome.newHead],
      fixture.clone,
    )).split(" ").slice(1);
    assertEquals(parents, [
      fixture.oldHead,
      await remoteHead(fixture, "main"),
    ]);

    assertEquals(await remoteHead(fixture, "feature"), outcome.newHead);
  } finally {
    await Deno.remove(fixture.tmp, { recursive: true });
  }
});

Deno.test("runMergeRung (real git) - a conflicting merge is aborted and the branch left at the old head", async () => {
  const fixture = await makeFixture(["shared.txt", "feature side\n"], [
    "shared.txt",
    "base side\n",
  ]);
  try {
    const { captured, outcome } = await runReal(fixture);

    assertEquals(outcome.kind, "merge-conflicted");
    assertEquals(captured.pushes, []);
    assertNoRebase(captured.argv);
    assertEquals(
      await mustGit(["rev-parse", "HEAD"], fixture.clone),
      fixture.oldHead,
    );
    assertEquals(
      await mustGit(["status", "--porcelain"], fixture.clone),
      "",
      "the aborted merge leaves a clean tree",
    );
    const mergeHead = await gitIn(
      ["rev-parse", "-q", "--verify", "MERGE_HEAD"],
      fixture.clone,
    );
    assert(mergeHead.code !== 0, "no merge is left in progress");
    assertEquals(await remoteHead(fixture, "feature"), fixture.oldHead);
  } finally {
    await Deno.remove(fixture.tmp, { recursive: true });
  }
});

Deno.test("runMergeRung (real git) - a base already in the head is nothing to merge", async () => {
  const fixture = await makeFixture(["feature.txt", "feature\n"], null);
  try {
    const { captured, outcome } = await runReal(fixture);

    assertEquals(outcome, { kind: "nothing-to-merge" });
    assertEquals(captured.pushes, []);
    assertEquals(await remoteHead(fixture, "feature"), fixture.oldHead);
  } finally {
    await Deno.remove(fixture.tmp, { recursive: true });
  }
});

Deno.test("runMergeRung (real git) - a rejected push carries git's stderr and overwrites nothing", async () => {
  const fixture = await makeFixture(["feature.txt", "feature\n"], [
    "base.txt",
    "base\n",
  ]);
  try {
    // Somebody else pushes to the PR branch after the clone was taken.
    const other = `${fixture.tmp}/other`;
    await mustGit(
      ["clone", "-b", "feature", fixture.remote, other],
      fixture.tmp,
    );
    await commitFile(other, "theirs.txt", "theirs\n");
    await mustGit(["push", "origin", "feature"], other);
    const theirs = await remoteHead(fixture, "feature");

    const { captured, outcome } = await runReal(fixture);

    assertEquals(outcome.kind, "push-refused");
    assert(outcome.kind === "push-refused");
    assertStringIncludes(outcome.detail, "rejected");
    assertEquals(captured.pushes.length, 1, "no forced retry");
    assertNoForcedPush(captured.pushes);
    assertEquals(await remoteHead(fixture, "feature"), theirs);
    assertEquals(
      await mustGit(["rev-parse", "HEAD"], fixture.clone),
      fixture.oldHead,
    );
  } finally {
    await Deno.remove(fixture.tmp, { recursive: true });
  }
});
