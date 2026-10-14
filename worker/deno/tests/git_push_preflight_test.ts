/**
 * Tests for the pre-flight gate wired into commitAndPushPending (Issue #3577).
 *
 * These exercise the enforcement chokepoint on a real git repo:
 *  - gate absent → commits and pushes exactly as today;
 *  - gate present + exit 0 → commit proceeds;
 *  - gate exit non-zero → BOTH commit and push abort (origin unchanged, no
 *    local commit created), and the failing output reaches the error;
 *  - unstartable command → abort with the distinct not-started reason.
 *
 * The regression that matters is fail-open: we assert on the reason string,
 * not just the boolean.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  commitAndPushPending,
  gateUnpushedCommits,
  PrePushGateBlockedError,
} from "../lib/git_push.ts";
import {
  type PreFlightCommandResult,
  PreFlightGateError,
  type PreFlightRunner,
} from "../lib/pre_flight_gate.ts";

interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Keeps every git call away from the host's ambient config: the worker hands
 * agent runs a `core.hooksPath` through `GIT_CONFIG_COUNT`/`KEY`/`VALUE`, and
 * that pre-push hook would refuse the deliberately badly formatted fixtures,
 * so the tests would differ inside and outside an agent run.
 */
const NO_HOST_GIT_CONFIG = { GIT_CONFIG_COUNT: "0" };

async function runGit(args: string[], cwd: string): Promise<GitRunResult> {
  const cmd = new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: {
      ...NO_HOST_GIT_CONFIG,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  const out = await cmd.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

async function makeRepo(
  prefix: string,
  branchName: string,
): Promise<{ tmp: string; downstream: string }> {
  const tmp = await Deno.makeTempDir({ prefix });
  const upstream = `${tmp}/upstream.git`;
  const seed = `${tmp}/seed`;
  const downstream = `${tmp}/downstream`;

  await runGit(["init", "--bare", "-b", "main", upstream], tmp);
  await runGit(["clone", upstream, seed], tmp);
  await runGit(["config", "user.email", "t@t"], seed);
  await runGit(["config", "user.name", "t"], seed);
  await Deno.writeTextFile(`${seed}/README.md`, "seed\n");
  await runGit(["add", "."], seed);
  await runGit(["commit", "-m", "seed"], seed);
  await runGit(["push", "origin", "main"], seed);

  await runGit(["clone", upstream, downstream], tmp);
  await runGit(["config", "user.email", "t@t"], downstream);
  await runGit(["config", "user.name", "t"], downstream);
  await runGit(["checkout", "-b", branchName], downstream);
  await runGit(["push", "-u", "origin", branchName], downstream);

  return { tmp, downstream };
}

const passRunner: PreFlightRunner = () =>
  Promise.resolve({ started: true, code: 0, stdout: "", stderr: "" });

function failRunner(
  result: PreFlightCommandResult,
): { runner: PreFlightRunner; calls: string[] } {
  const calls: string[] = [];
  const runner: PreFlightRunner = (command) => {
    calls.push(command);
    return Promise.resolve(result);
  };
  return { runner, calls };
}

Deno.test("commitAndPushPending - no pre-flight entry: unaffected (commits + pushes)", async () => {
  const branch = "issue-3577-nogate";
  const { tmp, downstream } = await makeRepo("preflight_nogate_", branch);
  try {
    await Deno.writeTextFile(`${downstream}/feature.txt`, "work\n");

    // No preFlight arg → runs exactly as today.
    const result = await commitAndPushPending(
      branch,
      "Auto-commit (Issue #3577 no gate)",
      { cwd: downstream, env: NO_HOST_GIT_CONFIG },
    );

    assert(result.ok, result.ok ? "" : result.error.message);
    if (result.ok) {
      assertEquals(result.value.committedNewChanges, true);
      assertEquals(result.value.finalUnpushedCount, 0);
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("commitAndPushPending - pre-flight exit 0: commit proceeds", async () => {
  const branch = "issue-3577-pass";
  const { tmp, downstream } = await makeRepo("preflight_pass_", branch);
  try {
    await Deno.writeTextFile(`${downstream}/feature.txt`, "work\n");

    const result = await commitAndPushPending(
      branch,
      "Auto-commit (Issue #3577 gate pass)",
      { cwd: downstream, env: NO_HOST_GIT_CONFIG },
      false,
      { commands: ["./pre-flight.sh"], runner: passRunner },
    );

    assert(result.ok, result.ok ? "" : result.error.message);
    if (result.ok) {
      assertEquals(result.value.committedNewChanges, true);
      assertEquals(result.value.finalUnpushedCount, 0);
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("commitAndPushPending - pre-flight non-zero: commit AND push both abort", async () => {
  const branch = "issue-3577-block";
  const { tmp, downstream } = await makeRepo("preflight_block_", branch);
  try {
    const originBefore = (await runGit(
      ["rev-parse", `refs/remotes/origin/${branch}`],
      downstream,
    )).stdout.trim();
    const headBefore = (await runGit(["rev-parse", "HEAD"], downstream))
      .stdout.trim();

    await Deno.writeTextFile(`${downstream}/broken.txt`, "does not compile\n");

    const { runner } = failRunner({
      started: true,
      code: 1,
      stdout: "Compiling…",
      stderr: "error: does not compile",
    });

    const result = await commitAndPushPending(
      branch,
      "Auto-commit (Issue #3577 gate block)",
      { cwd: downstream, env: NO_HOST_GIT_CONFIG },
      false,
      { commands: ["./pre-flight.sh"], runner },
    );

    assert(!result.ok, "a failing pre-flight must block the commit");
    if (!result.ok) {
      assert(result.error instanceof PreFlightGateError);
      assertEquals(result.error.reason, "non-zero-exit");
      // Failing output reaches the diagnosis path.
      assert(result.error.output.includes("does not compile"));
    }

    // No new commit was created (commit blocked).
    const headAfter = (await runGit(["rev-parse", "HEAD"], downstream))
      .stdout.trim();
    assertEquals(headAfter, headBefore, "HEAD must not advance");

    // Origin is unchanged (push blocked).
    const originAfter = (await runGit(
      ["rev-parse", `refs/remotes/origin/${branch}`],
      downstream,
    )).stdout.trim();
    assertEquals(originAfter, originBefore, "origin must not advance");

    // The change was unstaged so no secret/broken work lingers in the index.
    const staged = await runGit(
      ["diff", "--cached", "--name-only"],
      downstream,
    );
    assertEquals(staged.stdout.trim(), "", "index must be reset on block");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("commitAndPushPending - unstartable command aborts with not-started reason", async () => {
  const branch = "issue-3577-unstartable";
  const { tmp, downstream } = await makeRepo("preflight_unstartable_", branch);
  try {
    const headBefore = (await runGit(["rev-parse", "HEAD"], downstream))
      .stdout.trim();
    await Deno.writeTextFile(`${downstream}/feature.txt`, "work\n");

    const { runner } = failRunner({
      started: false,
      code: -1,
      stdout: "",
      stderr: "No such file or directory",
    });

    const result = await commitAndPushPending(
      branch,
      "Auto-commit (Issue #3577 unstartable)",
      { cwd: downstream, env: NO_HOST_GIT_CONFIG },
      false,
      { commands: ["./missing.sh"], runner },
    );

    assert(!result.ok, "'could not run the check' is a block, never a pass");
    if (!result.ok) {
      assert(result.error instanceof PreFlightGateError);
      assertEquals(result.error.reason, "not-started");
    }

    const headAfter = (await runGit(["rev-parse", "HEAD"], downstream))
      .stdout.trim();
    assertEquals(headAfter, headBefore, "no commit on unstartable gate");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

// Issue #3689 — commits the agent made but never pushed must pass the
// changed-file gate before the final-mile push.

const BAD_TS = "export const   x  =  1\n";
const GOOD_TS = "export const x = 1;\n";

/** Commit `file` locally (unpushed) in a repo rooted by a deno.json. */
async function commitLocally(
  downstream: string,
  file: string,
  content: string,
): Promise<void> {
  await Deno.writeTextFile(`${downstream}/deno.json`, "{}\n");
  await runGit(["add", "deno.json"], downstream);
  await runGit(["commit", "-m", "add deno.json"], downstream);
  await runGit(["push", "origin", "HEAD"], downstream);
  await Deno.writeTextFile(`${downstream}/${file}`, content);
  await runGit(["add", file], downstream);
  const c = await runGit(["commit", "-m", "agent commit"], downstream);
  assertEquals(c.code, 0, c.stderr);
}

const originSha = async (cwd: string, branch: string) =>
  (await runGit(["ls-remote", "origin", branch], cwd)).stdout.split("\t")[0];

Deno.test("commitAndPushPending - unpushed agent commit failing the gate is not pushed (#3689)", async () => {
  const branch = "issue-3689-bad";
  const { tmp, downstream } = await makeRepo("preflight_3689_bad_", branch);
  try {
    await commitLocally(downstream, "bad.ts", BAD_TS);
    const before = await originSha(downstream, branch);

    const result = await commitAndPushPending(
      branch,
      "unused",
      { cwd: downstream, env: NO_HOST_GIT_CONFIG },
      false,
      { commands: [] },
    );

    assert(!result.ok, "ungated unpushed commit must be refused");
    if (!result.ok) {
      assert(result.error.message.includes("[PRE_PUSH_BLOCKED]"));
    }
    assertEquals(await originSha(downstream, branch), before);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

/** A failing check that prints ~100 KB, ending in a distinctive last line. */
const HUGE_FAILURE: PreFlightCommandResult = {
  started: true,
  code: 1,
  stdout: "noisy diff hunk line\n".repeat(5_000) + "THE-LAST-LINE",
  stderr: "",
};

Deno.test("commitAndPushPending - Step 1b block with ~100 KB of output is capped, keeping the command and the trailer (PR #3716 review)", async () => {
  const branch = "issue-3689-huge";
  const { tmp, downstream } = await makeRepo("preflight_3689_huge_", branch);
  try {
    // Clean content, so only the pre-flight command blocks; nothing is dirty,
    // so Step 1 runs no pre-flight and Step 1b's gate does.
    await commitLocally(downstream, "good.ts", GOOD_TS);
    const before = await originSha(downstream, branch);
    // The gate's own changed-file checks use this runner too: only the repo's
    // pre-flight command fails.
    const runner: PreFlightRunner = (command) =>
      Promise.resolve(
        command === "./pre-flight.sh"
          ? HUGE_FAILURE
          : { started: true, code: 0, stdout: "", stderr: "" },
      );

    const result = await commitAndPushPending(
      branch,
      "unused",
      { cwd: downstream, env: NO_HOST_GIT_CONFIG },
      false,
      { commands: ["./pre-flight.sh"], runner },
    );

    assert(!result.ok, "a failing pre-flight must refuse the push");
    if (!result.ok) {
      const message = result.error.message;
      assert(HUGE_FAILURE.stdout.length > 100_000);
      assert(message.length < 6_000, `uncapped: ${message.length} characters`);
      assert(result.error instanceof PrePushGateBlockedError);
      assert(message.startsWith("[PRE_PUSH_BLOCKED]"));
      assert(message.includes("./pre-flight.sh"), "names the failing command");
      assert(message.includes("THE-LAST-LINE"), "keeps the end of the output");
      assert(
        message.endsWith(`Unpushed commits on ${branch} were not pushed.`),
        "keeps the trailer",
      );
    }
    assertEquals(await originSha(downstream, branch), before);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("commitAndPushPending - Step 1 pre-flight block with ~100 KB of output is capped, keeping the command (PR #3716 review)", async () => {
  const branch = "issue-3689-huge-step1";
  const { tmp, downstream } = await makeRepo("preflight_3689_huge1_", branch);
  try {
    await Deno.writeTextFile(`${downstream}/broken.txt`, "does not compile\n");
    const { runner } = failRunner(HUGE_FAILURE);

    const result = await commitAndPushPending(
      branch,
      "Auto-commit",
      { cwd: downstream, env: NO_HOST_GIT_CONFIG },
      false,
      { commands: ["./pre-flight.sh"], runner },
    );

    assert(!result.ok, "a failing pre-flight must block the commit");
    if (!result.ok) {
      const message = result.error.message;
      assert(message.length < 6_000, `uncapped: ${message.length} characters`);
      assert(message.includes("./pre-flight.sh"), "names the failing command");
      assert(message.includes("THE-LAST-LINE"), "keeps the end of the output");
      // The full record stays reachable for a caller that wants it.
      assert(result.error.cause instanceof PreFlightGateError);
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("commitAndPushPending - clean unpushed agent commit passes the gate and is pushed (#3689)", async () => {
  const branch = "issue-3689-good";
  const { tmp, downstream } = await makeRepo("preflight_3689_good_", branch);
  try {
    await commitLocally(downstream, "good.ts", GOOD_TS);
    const before = await originSha(downstream, branch);

    const result = await commitAndPushPending(
      branch,
      "unused",
      { cwd: downstream, env: NO_HOST_GIT_CONFIG },
      false,
      { commands: [] },
    );

    assert(result.ok, result.ok ? "" : result.error.message);
    const head = (await runGit(["rev-parse", "HEAD"], downstream)).stdout
      .trim();
    assertEquals(await originSha(downstream, branch), head);
    assert(head !== before);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("commitAndPushPending - staged changes run pre-flight exactly once (#3689)", async () => {
  const branch = "issue-3689-once";
  const { tmp, downstream } = await makeRepo("preflight_3689_once_", branch);
  try {
    await Deno.writeTextFile(`${downstream}/feature.txt`, "work\n");
    const { runner, calls } = failRunner({
      started: true,
      code: 0,
      stdout: "",
      stderr: "",
    });

    const result = await commitAndPushPending(
      branch,
      "Auto-commit (Issue #3689 once)",
      { cwd: downstream, env: NO_HOST_GIT_CONFIG },
      false,
      { commands: ["./pre-flight.sh"], runner },
    );

    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(calls, ["./pre-flight.sh"]);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("commitAndPushPending - no preFlight spec: bad unpushed commit still pushed (#3689 WIP path)", async () => {
  const branch = "issue-3689-wip";
  const { tmp, downstream } = await makeRepo("preflight_3689_wip_", branch);
  try {
    await commitLocally(downstream, "bad.ts", BAD_TS);

    const result = await commitAndPushPending(
      branch,
      "unused",
      { cwd: downstream, env: NO_HOST_GIT_CONFIG },
    );

    assert(result.ok, result.ok ? "" : result.error.message);
    const head = (await runGit(["rev-parse", "HEAD"], downstream)).stdout
      .trim();
    assertEquals(await originSha(downstream, branch), head);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

// Issue #3689 / PR #3716 review: the execute phase's WIP checkpoints push the
// agent's commits with no gate, so by the time the completion phase runs they
// are already on origin and "unpushed" is empty. The whole-branch mode checks
// them against the PR base instead.

/** Commit `file` and push it, as a WIP checkpoint push does (no gate). */
async function checkpointPush(
  downstream: string,
  file: string,
  content: string,
): Promise<void> {
  await commitLocally(downstream, file, content);
  const pushed = await runGit(["push", "origin", "HEAD"], downstream);
  assertEquals(pushed.code, 0, pushed.stderr);
}

Deno.test("gateUnpushedCommits - bad commit already pushed by a checkpoint is blocked against the PR base (#3689)", async () => {
  const branch = "issue-3689-checkpointed";
  const { tmp, downstream } = await makeRepo("preflight_3689_ckpt_", branch);
  try {
    await checkpointPush(downstream, "bad.ts", BAD_TS);
    const opts = { cwd: downstream, env: NO_HOST_GIT_CONFIG };

    // Positive control: the unpushed-only gate sees nothing — the gap.
    const unpushedOnly = await gateUnpushedCommits(branch, opts, {
      commands: [],
    });
    assert(unpushedOnly.ok, "nothing is unpushed, so this mode checks nothing");

    const wholeBranch = await gateUnpushedCommits(
      branch,
      opts,
      { commands: [] },
      false,
      "origin/main",
    );
    assert(!wholeBranch.ok, "the checkpointed bad commit must be blocked");
    if (!wholeBranch.ok) {
      assert(wholeBranch.error instanceof PrePushGateBlockedError);
      assert(wholeBranch.error.message.includes("[PRE_PUSH_BLOCKED]"));
      assert(wholeBranch.error.message.includes("bad.ts"));
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("gateUnpushedCommits - clean checkpointed branch passes against the PR base (#3689)", async () => {
  const branch = "issue-3689-checkpointed-good";
  const { tmp, downstream } = await makeRepo("preflight_3689_ckpt_ok_", branch);
  try {
    await checkpointPush(downstream, "good.ts", GOOD_TS);
    const result = await gateUnpushedCommits(
      branch,
      { cwd: downstream, env: NO_HOST_GIT_CONFIG },
      { commands: [] },
      false,
      "origin/main",
    );
    assert(result.ok, result.ok ? "" : result.error.message);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("gateUnpushedCommits - branch with no commit ahead of the PR base is a no-op (#3689)", async () => {
  const branch = "issue-3689-level";
  const { tmp, downstream } = await makeRepo("preflight_3689_level_", branch);
  try {
    const { runner, calls } = failRunner({
      started: true,
      code: 0,
      stdout: "",
      stderr: "",
    });
    const result = await gateUnpushedCommits(
      branch,
      { cwd: downstream, env: NO_HOST_GIT_CONFIG },
      { commands: ["./pre-flight.sh"], runner },
      false,
      "origin/main",
    );
    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(calls, [], "no commit ahead: pre-flight must not run");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("gateUnpushedCommits - unresolvable or option-like base ref fails closed (#3689)", async () => {
  const branch = "issue-3689-badbase";
  const { tmp, downstream } = await makeRepo("preflight_3689_base_", branch);
  try {
    await checkpointPush(downstream, "good.ts", GOOD_TS);
    const opts = { cwd: downstream, env: NO_HOST_GIT_CONFIG };
    const missing = await gateUnpushedCommits(
      branch,
      opts,
      { commands: [] },
      false,
      "origin/does-not-exist",
    );
    assert(!missing.ok, "an unreadable range must not read as a pass");
    if (!missing.ok) {
      // A failed git lookup is no verdict on the branch (PR #3716 review).
      assert(!(missing.error instanceof PrePushGateBlockedError));
      assert(!missing.error.message.includes("[PRE_PUSH_BLOCKED]"));
      assert(missing.error.message.includes("origin/does-not-exist..HEAD"));
    }

    const optionLike = await gateUnpushedCommits(
      branch,
      opts,
      { commands: [] },
      false,
      "--all",
    );
    assert(!optionLike.ok);
    if (!optionLike.ok) {
      assert(optionLike.error instanceof PrePushGateBlockedError);
      assert(optionLike.error.message.includes("[PRE_PUSH_BLOCKED]"));
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("gateUnpushedCommits - whole-branch mode never looks the remote up: an unreachable origin still gives the verdict (PR #3716 review)", async () => {
  const branch = "issue-3689-offline";
  const { tmp, downstream } = await makeRepo("preflight_3689_offline_", branch);
  try {
    await checkpointPush(downstream, "bad.ts", BAD_TS);
    // No tracking ref for the branch and an origin that cannot be reached:
    // `describeUnpushedCommits` would need `ls-remote` and fail.
    await runGit(
      ["update-ref", "-d", `refs/remotes/origin/${branch}`],
      downstream,
    );
    await runGit(
      ["remote", "set-url", "origin", `${tmp}/does-not-exist.git`],
      downstream,
    );
    const opts = { cwd: downstream, env: NO_HOST_GIT_CONFIG };

    // Positive control: the unpushed-only mode does need the remote lookup and
    // fails on it, and that failure is not a verdict.
    const unpushedOnly = await gateUnpushedCommits(branch, opts, {
      commands: [],
    });
    assert(!unpushedOnly.ok);
    if (!unpushedOnly.ok) {
      assert(!(unpushedOnly.error instanceof PrePushGateBlockedError));
    }

    const wholeBranch = await gateUnpushedCommits(
      branch,
      opts,
      { commands: [] },
      false,
      "origin/main",
    );
    assert(!wholeBranch.ok);
    if (!wholeBranch.ok) {
      assert(wholeBranch.error instanceof PrePushGateBlockedError);
      assert(wholeBranch.error.message.includes("bad.ts"));
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("gateUnpushedCommits - a failed git lookup inside the gate is returned unmarked, not as a verdict (PR #3716 review)", async () => {
  const branch = "issue-3689-corrupt-index";
  const { tmp, downstream } = await makeRepo("preflight_3689_index_", branch);
  try {
    await checkpointPush(downstream, "bad.ts", BAD_TS);
    const opts = { cwd: downstream, env: NO_HOST_GIT_CONFIG };

    // Positive control: with a readable index the same branch is a verdict.
    const verdict = await gateUnpushedCommits(
      branch,
      opts,
      { commands: [] },
      false,
      "origin/main",
    );
    assert(!verdict.ok);
    if (!verdict.ok) {
      assert(verdict.error instanceof PrePushGateBlockedError);
    }

    // `git ls-files` cannot read the index; rev-list and rev-parse still work.
    await Deno.writeTextFile(`${downstream}/.git/index`, "not an index");
    const result = await gateUnpushedCommits(
      branch,
      opts,
      { commands: [] },
      false,
      "origin/main",
    );
    assert(!result.ok, "an unreadable index must still fail closed");
    if (!result.ok) {
      assert(!(result.error instanceof PrePushGateBlockedError));
      assert(!result.error.message.includes("[PRE_PUSH_BLOCKED]"));
      assert(result.error.message.includes("ls-files"));
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
