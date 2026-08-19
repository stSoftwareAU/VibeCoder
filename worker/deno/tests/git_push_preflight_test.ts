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
import { commitAndPushPending } from "../lib/git_push.ts";
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

async function runGit(args: string[], cwd: string): Promise<GitRunResult> {
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
      { cwd: downstream },
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
      { cwd: downstream },
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
      { cwd: downstream },
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
      { cwd: downstream },
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
