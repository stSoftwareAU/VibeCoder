/**
 * Tests for conflict_rebase_rung.ts (Issue #2279, parent #2272).
 *
 * The rung force-pushes, so the property every test here checks is the one
 * that makes that admissible: whatever happens, the branch ends at `OLD` or at
 * a head whose tree equals `OLD`'s, and the push carries the lease pinned to
 * `OLD` rather than a bare `--force`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildSquashCommitMessage,
  type RebaseGitOutcome,
  type RebaseGitRunner,
  type RebaseRungOutcome,
  runRebaseRung,
} from "../lib/conflict_rebase_rung.ts";
import type { Result } from "../types.ts";

// ---------------------------------------------------------------------------
// Scripted git
// ---------------------------------------------------------------------------

const OLD = "1111111111111111111111111111111111111111";
const REBASED = "2222222222222222222222222222222222222222";
const SQUASHED = "3333333333333333333333333333333333333333";

interface GitScript {
  /** `git rev-parse HEAD` before anything moves it. */
  headSha: string;
  /** Exit code for `git rebase --no-rebase-merges origin/<base>`. */
  rebaseCode: number;
  /** Paths `git diff --diff-filter=U` reports while the rebase is stopped. */
  unmergedPaths: string[];
  /** Exit code for `git rebase --abort`. */
  abortCode: number;
  /** `git rev-parse HEAD` once the replay has run. */
  headAfterRebase: string;
  /** Whether `git diff --quiet OLD HEAD` after the replay exits 0. */
  rebasedTreeIdentical: boolean;
  /** What `git commit-tree` prints for the fallback commit. */
  commitTreeStdout: string;
  /** Exit code for `git commit-tree`. */
  commitTreeCode: number;
  /** Whether `git diff --quiet OLD NEW` on the fallback exits 0. */
  squashTreeIdentical: boolean;
  /** Exit code for `git reset --hard`. */
  resetCode: number;
  /** Exit code for the leased force push. */
  pushCode: number;
}

function makeScript(overrides?: Partial<GitScript>): GitScript {
  return {
    headSha: OLD,
    rebaseCode: 0,
    unmergedPaths: [],
    abortCode: 0,
    headAfterRebase: REBASED,
    rebasedTreeIdentical: true,
    commitTreeStdout: `${SQUASHED}\n`,
    commitTreeCode: 0,
    squashTreeIdentical: true,
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
  /** The `git commit-tree` invocations, derived from {@link Captured.argv}. */
  commitTrees: () => string[][];
}

function makeCaptured(): Captured {
  const captured: Captured = {
    argv: [],
    pushes: [],
    resets: [],
    commitTrees: () =>
      captured.argv.filter((args) => args[0] === "commit-tree"),
  };
  return captured;
}

function ok(value: RebaseGitOutcome): Result<RebaseGitOutcome> {
  return { ok: true, value };
}

function makeGit(
  script: GitScript,
  captured: Captured,
): RebaseGitRunner {
  // The branch's position, as the scripted clone would report it.
  let head = script.headSha;

  return (args: string[]) => {
    captured.argv.push(args);

    if (args[0] === "rev-parse" && args[1] === "HEAD") {
      return Promise.resolve(ok({ code: 0, stdout: `${head}\n`, stderr: "" }));
    }

    if (args[0] === "rebase" && args.includes("--abort")) {
      return Promise.resolve(ok({
        code: script.abortCode,
        stdout: "",
        stderr: script.abortCode === 0 ? "" : "no rebase in progress",
      }));
    }

    if (args[0] === "rebase") {
      if (script.rebaseCode === 0) head = script.headAfterRebase;
      return Promise.resolve(ok({
        code: script.rebaseCode,
        stdout: "",
        stderr: script.rebaseCode === 0
          ? ""
          : "CONFLICT (content): SECURITY.md",
      }));
    }

    if (args[0] === "diff" && args.includes("--diff-filter=U")) {
      return Promise.resolve(ok({
        code: 0,
        stdout: script.unmergedPaths.join("\n"),
        stderr: "",
      }));
    }

    if (args[0] === "diff" && args.includes("--quiet")) {
      // `[..., "--quiet", OLD, "HEAD"]` is the post-replay guard;
      // `[..., "--quiet", OLD, NEW]` is the fallback's own assertion.
      const identical = args[3] === "HEAD"
        ? script.rebasedTreeIdentical
        : script.squashTreeIdentical;
      return Promise.resolve(ok({
        code: identical ? 0 : 1,
        stdout: "",
        stderr: "",
      }));
    }

    if (args[0] === "commit-tree") {
      return Promise.resolve(ok({
        code: script.commitTreeCode,
        stdout: script.commitTreeCode === 0 ? script.commitTreeStdout : "",
        stderr: script.commitTreeCode === 0 ? "" : "fatal: not a tree object",
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
        stderr: script.pushCode === 0
          ? ""
          : "! [remote rejected] stale info: the lease did not match",
      }));
    }

    return Promise.resolve(ok({ code: 0, stdout: "", stderr: "" }));
  };
}

async function runRung(
  script: GitScript,
  overrides?: { oldHead?: string },
): Promise<{ captured: Captured; outcome: RebaseRungOutcome }> {
  const captured = makeCaptured();
  const outcome = await runRebaseRung({
    branchName: "issue-16-fix",
    baseBranch: "Develop",
    oldHead: overrides?.oldHead ?? OLD,
    cwd: "/clone",
    git: makeGit(script, captured),
    runId: "vibe-test-run",
  });
  return { captured, outcome };
}

/** The head the scripted clone is left at — the last reset, or the replay. */
function finalHead(captured: Captured, script: GitScript): string {
  const lastReset = captured.resets.at(-1);
  if (lastReset !== undefined) return lastReset.toLowerCase();
  return script.rebaseCode === 0 ? script.headAfterRebase : OLD;
}

/** Whether an argv list contains a `git rebase` that is not the abort. */
function hasReplay(captured: Captured): boolean {
  return captured.argv.some(
    (args) => args[0] === "rebase" && !args.includes("--abort"),
  );
}

async function expectThrow(script: GitScript): Promise<{
  captured: Captured;
  error: Error;
}> {
  const captured = makeCaptured();
  try {
    await runRebaseRung({
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
  throw new Error("expected runRebaseRung to throw, but it returned");
}

// ---------------------------------------------------------------------------
// Outcome: pushed via the replay
// ---------------------------------------------------------------------------

Deno.test("runRebaseRung - an identical tree pushes the replay with the pinned lease", async () => {
  const script = makeScript();
  const { captured, outcome } = await runRung(script);

  assertEquals(outcome, {
    kind: "pushed",
    oldHead: OLD,
    newHead: REBASED,
    via: "rebase",
  });

  assertEquals(captured.pushes.length, 1, "exactly one push");
  const push = captured.pushes[0] ?? [];
  assert(
    push.includes(`--force-with-lease=issue-16-fix:${OLD}`),
    `the lease must pin the judged head; got ${push.join(" ")}`,
  );
  assertEquals(
    push.filter((a) => a === "--force" || a === "-f"),
    [],
    "never a bare force",
  );
  assertEquals(captured.resets, [], "a clean replay resets nothing");

  const replay = captured.argv.find((args) => args[0] === "rebase") ?? [];
  assert(
    replay.includes("--no-rebase-merges"),
    "merge commits must be dropped, not replayed",
  );
  assert(replay.includes("origin/Develop"));
  assertEquals(finalHead(captured, script), REBASED);
});

// ---------------------------------------------------------------------------
// Outcome: pushed via the fallback
// ---------------------------------------------------------------------------

Deno.test("runRebaseRung - a differing tree is reset to OLD and the old tree squashed instead", async () => {
  const script = makeScript({ rebasedTreeIdentical: false });
  const { captured, outcome } = await runRung(script);

  assertEquals(outcome, {
    kind: "pushed",
    oldHead: OLD,
    newHead: SQUASHED,
    via: "squash",
  });

  // The replayed head is discarded before anything else happens.
  assertEquals(captured.resets[0], OLD, "the differing replay is thrown away");
  assertEquals(captured.resets.at(-1), SQUASHED);

  const commitTree = captured.argv.find((args) => args[0] === "commit-tree") ??
    [];
  assertEquals(
    commitTree[1],
    `${OLD}^{tree}`,
    "the fallback carries OLD's tree",
  );
  assertEquals(commitTree[2], "-p");
  assertEquals(commitTree[3], "origin/Develop", "and sits on the base");

  assertEquals(captured.pushes.length, 1);
  assert(
    (captured.pushes[0] ?? []).includes(
      `--force-with-lease=issue-16-fix:${OLD}`,
    ),
  );
  assertEquals(finalHead(captured, script), SQUASHED);
});

Deno.test("runRebaseRung - a replay conflict aborts and pushes the squash of OLD's tree", async () => {
  const script = makeScript({
    rebaseCode: 1,
    unmergedPaths: ["SECURITY.md", "deno.lock"],
  });
  const { captured, outcome } = await runRung(script);

  assertEquals(outcome, {
    kind: "pushed",
    oldHead: OLD,
    newHead: SQUASHED,
    via: "squash",
  });

  assert(
    captured.argv.some(
      (args) => args[0] === "rebase" && args.includes("--abort"),
    ),
    "a conflicted replay must be aborted, never left in progress",
  );
  // The unmerged paths are read while the rebase is still stopped — after the
  // abort git reports none, so the conflict would be invisible.
  const unmergedIndex = captured.argv.findIndex((args) =>
    args.includes("--diff-filter=U")
  );
  const abortIndex = captured.argv.findIndex((args) =>
    args[0] === "rebase" && args.includes("--abort")
  );
  assert(unmergedIndex >= 0 && unmergedIndex < abortIndex);

  assertEquals(captured.pushes.length, 1);
  const push = captured.pushes[0] ?? [];
  assert(push.includes(`--force-with-lease=issue-16-fix:${OLD}`));
  assertEquals(push.filter((a) => a === "--force" || a === "-f"), []);
  assertEquals(finalHead(captured, script), SQUASHED);
});

// ---------------------------------------------------------------------------
// Outcome: head-moved
// ---------------------------------------------------------------------------

Deno.test("runRebaseRung - a clone that is not at the judged head touches nothing", async () => {
  const script = makeScript({ headSha: REBASED });
  const { captured, outcome } = await runRung(script);

  assertEquals(outcome, { kind: "head-moved", localHead: REBASED });
  assertEquals(hasReplay(captured), false, "no replay is attempted");
  assertEquals(captured.pushes, []);
  assertEquals(captured.resets, []);
  assertEquals(
    captured.argv.map((args) => args[0]),
    ["rev-parse"],
    "the head read is the only command issued",
  );
});

// ---------------------------------------------------------------------------
// Outcome: push-refused
// ---------------------------------------------------------------------------

Deno.test("runRebaseRung - a refused push restores the branch to OLD", async () => {
  const script = makeScript({ pushCode: 1 });
  const { captured, outcome } = await runRung(script);

  assertEquals(outcome.kind, "push-refused");
  assert(outcome.kind === "push-refused");
  assertStringIncludes(outcome.detail, "stale info");
  assertEquals(captured.resets.at(-1), OLD, "the replay is not left behind");
  assertEquals(finalHead(captured, script), OLD);
});

// ---------------------------------------------------------------------------
// Loud failures
// ---------------------------------------------------------------------------

Deno.test("runRebaseRung - a replay failure with no unmerged paths fails loud", async () => {
  // Not a conflict: a dirty tree or a missing upstream. Falling back would
  // hide a broken clone behind a green push.
  const script = makeScript({ rebaseCode: 1, unmergedPaths: [] });
  const { captured, error } = await expectThrow(script);

  assertStringIncludes(error.message, "no unmerged paths");
  assertEquals(captured.pushes, [], "nothing is pushed");
  assertEquals(
    captured.argv.some((args) => args[0] === "commit-tree"),
    false,
    "the fallback is not taken for a fault that is not a conflict",
  );
});

Deno.test("runRebaseRung - a fallback whose tree differs from OLD fails loud and restores OLD", async () => {
  const script = makeScript({
    rebasedTreeIdentical: false,
    squashTreeIdentical: false,
  });
  const { captured, error } = await expectThrow(script);

  assertStringIncludes(error.message, "by construction");
  assertEquals(captured.pushes, [], "a tree that is not OLD's is never pushed");
  assertEquals(captured.resets.at(-1), OLD);
  assertEquals(finalHead(captured, script), OLD);
});

Deno.test("runRebaseRung - a replay that moves nothing takes the fallback rather than pushing OLD back", async () => {
  // The branch was already linear off the base, so the replay is a no-op.
  // Pushing OLD back gives GitHub nothing new to judge, and the comment would
  // claim a linearisation that never happened.
  const script = makeScript({ headAfterRebase: OLD });
  const { captured, outcome } = await runRung(script);

  assertEquals(outcome, {
    kind: "pushed",
    oldHead: OLD,
    newHead: SQUASHED,
    via: "squash",
  });
  assertEquals(captured.commitTrees().length, 1);
  assertEquals(finalHead(captured, script), SQUASHED);
});

Deno.test("runRebaseRung - an abort that fails stops rather than building on a mid-rebase clone", async () => {
  const script = makeScript({
    rebaseCode: 1,
    unmergedPaths: ["SECURITY.md"],
    abortCode: 1,
  });
  const { captured, error } = await expectThrow(script);

  assertStringIncludes(error.message, "--abort");
  assertEquals(captured.pushes, [], "nothing is pushed");
  assertEquals(
    captured.commitTrees().length,
    0,
    "the fallback is never built on a clone that may still be mid-rebase",
  );
  assertEquals(captured.resets.at(-1), OLD);
});

Deno.test("runRebaseRung - a commit-tree failure pushes nothing", async () => {
  const script = makeScript({
    rebasedTreeIdentical: false,
    commitTreeCode: 1,
  });
  const { captured, error } = await expectThrow(script);

  assertStringIncludes(error.message, "fallback commit");
  assertEquals(captured.pushes, []);
});

Deno.test("runRebaseRung - an unreadable HEAD refuses rather than claiming the head moved", async () => {
  const captured = makeCaptured();
  let threw: Error | undefined;
  try {
    await runRebaseRung({
      branchName: "issue-16-fix",
      baseBranch: "Develop",
      oldHead: OLD,
      cwd: "/clone",
      git: () =>
        Promise.resolve({
          ok: false,
          error: new Error("git: not a repository"),
        }),
      runId: "vibe-test-run",
    });
  } catch (err) {
    threw = err as Error;
  }
  assert(threw !== undefined);
  assertStringIncludes(threw.message, "rev-parse HEAD");
  assertEquals(captured.pushes, []);
});

Deno.test("runRebaseRung - an unusable old head is refused before any git runs", async () => {
  const captured = makeCaptured();
  let threw: Error | undefined;
  try {
    await runRebaseRung({
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

// ---------------------------------------------------------------------------
// The invariant, over every outcome kind
// ---------------------------------------------------------------------------

Deno.test("runRebaseRung - every outcome leaves the branch at OLD or at a head whose tree equals OLD", async () => {
  const scenarios: { name: string; script: GitScript }[] = [
    { name: "identical tree", script: makeScript() },
    {
      name: "differing tree",
      script: makeScript({ rebasedTreeIdentical: false }),
    },
    {
      name: "replay conflict",
      script: makeScript({ rebaseCode: 1, unmergedPaths: ["SECURITY.md"] }),
    },
    { name: "head moved", script: makeScript({ headSha: REBASED }) },
    { name: "push refused", script: makeScript({ pushCode: 1 }) },
  ];

  for (const { name, script } of scenarios) {
    const { captured, outcome } = await runRung(script);
    const head = finalHead(captured, script);

    if (outcome.kind === "pushed") {
      assertEquals(head, outcome.newHead, `${name}: the branch is at the push`);
      // Every pushed head was proven identical to OLD by a `diff --quiet`
      // that exited 0 — the replay guard or the fallback's own assertion.
      assert(
        captured.argv.some((args) =>
          args[0] === "diff" && args.includes("--quiet") &&
          args.includes(OLD)
        ),
        `${name}: a push must be preceded by the identity guard`,
      );
    } else if (outcome.kind === "head-moved") {
      assertEquals(captured.pushes, [], `${name}: nothing is pushed`);
    } else {
      assertEquals(head, OLD, `${name}: the branch is restored`);
    }
  }
});

// ---------------------------------------------------------------------------
// The fallback commit message
// ---------------------------------------------------------------------------

Deno.test("buildSquashCommitMessage - names the parent issue, the old head and stays attributable", () => {
  const message = buildSquashCommitMessage("Develop", OLD, "vibe-test-run");
  assertStringIncludes(message, "Issue #2272");
  assertStringIncludes(message, OLD);
  assertStringIncludes(message, "`origin/Develop`");
  assertStringIncludes(message, "byte-identical");
  assertStringIncludes(message, "Vibe-Coder-Run-Id: vibe-test-run");
});
