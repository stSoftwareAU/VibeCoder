/**
 * Repair git commands routed through `run` in fleet_pr_babysitter.ts get a
 * 30-minute timeout via the git chokepoint (Issue #4734), not the 60 s default.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { run } from "../commands/fleet_pr_babysitter.ts";
import type { runGitArgv } from "../lib/git_timeout.ts";

type GitArgvOutput = Awaited<ReturnType<typeof runGitArgv>>;

interface RecordedCall {
  argv: readonly string[];
  options: { cwd?: string; timeoutSeconds?: number };
}

/** A fake git runner that records each call and returns a fixed outcome. */
function fakeRunGit(
  outcome: GitArgvOutput,
): { calls: RecordedCall[]; runGit: typeof runGitArgv } {
  const calls: RecordedCall[] = [];
  const runGit = (argv: readonly string[], options = {}) => {
    calls.push({ argv: [...argv], options });
    return Promise.resolve(outcome);
  };
  return { calls, runGit: runGit as typeof runGitArgv };
}

Deno.test("run sends git push through the chokepoint with a 30-minute timeout", async () => {
  const { calls, runGit } = fakeRunGit({
    success: true,
    stdout: "ok",
    stderr: "",
  });

  const result = await run(
    "git",
    ["push", "origin", "HEAD"],
    "/some/dir",
    runGit,
  );

  assertEquals(calls.length, 1);
  const call = calls[0];
  assert(call !== undefined);
  assertEquals(call.argv, ["git", "push", "origin", "HEAD"]);
  assertEquals(call.options.cwd, "/some/dir");
  assertEquals(call.options.timeoutSeconds, 1800);
  assertEquals(result, "ok");
});

Deno.test("run sends git fetch through the chokepoint with a 30-minute timeout", async () => {
  const { calls, runGit } = fakeRunGit({
    success: true,
    stdout: "ok",
    stderr: "",
  });
  const refspec = "+refs/heads/x:refs/remotes/origin/x";

  const result = await run(
    "git",
    ["fetch", "origin", refspec],
    "/some/dir",
    runGit,
  );

  assertEquals(calls.length, 1);
  const call = calls[0];
  assert(call !== undefined);
  assertEquals(call.argv, ["git", "fetch", "origin", refspec]);
  assertEquals(call.options.cwd, "/some/dir");
  assertEquals(call.options.timeoutSeconds, 1800);
  assertEquals(result, "ok");
});

Deno.test("run throws with git's stderr when the git command fails", async () => {
  const { runGit } = fakeRunGit({
    success: false,
    stdout: "",
    stderr: "boom cause",
  });

  await assertRejects(
    () => run("git", ["push", "origin", "HEAD"], "/some/dir", runGit),
    Error,
    "boom cause",
  );
});
