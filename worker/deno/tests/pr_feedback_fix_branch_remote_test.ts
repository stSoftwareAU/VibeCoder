/**
 * Unit tests for the remote view of a gated-head feedback fix branch
 * (Issue #4466). A scripted git runner stands in for the real repository.
 *
 * Uses Australian English throughout (behaviour, recognise).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { findCommitsAheadOnRemote } from "../lib/pr_feedback_fix_branch_remote.ts";
import type { GitRunner } from "../lib/git_history.ts";

const HEAD = "milestone/4466-head";
const FIX = "milestone-fix/4466-feedback";
const TIP = "c".repeat(40);

interface Call {
  args: string[];
  cwd: string | undefined;
}

interface Reply {
  code?: number;
  stdout?: string;
  stderr?: string;
  /** Return an error Result instead of a git output. */
  error?: string;
}

/** Build a runner that records calls and answers by the first matching rule. */
function scripted(
  rules: Array<[(args: string[]) => boolean, Reply]>,
): { run: GitRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: GitRunner = (args, options) => {
    calls.push({ args, cwd: options?.cwd });
    const rule = rules.find(([matches]) => matches(args));
    const reply: Reply = rule ? rule[1] : {};
    if (reply.error !== undefined) {
      return Promise.resolve({ ok: false, error: new Error(reply.error) });
    }
    return Promise.resolve({
      ok: true,
      value: {
        code: reply.code ?? 0,
        stdout: reply.stdout ?? "",
        stderr: reply.stderr ?? "",
      },
    });
  };
  return { run, calls };
}

const isHeadFetch = (a: string[]) =>
  a[0] === "fetch" && (a.at(-1) ?? "").includes(`heads/${HEAD}:`);
const isFixFetch = (a: string[]) =>
  a[0] === "fetch" && (a.at(-1) ?? "").includes(`heads/${FIX}:`);
const isShallow = (a: string[]) => a[1] === "--is-shallow-repository";
const isCount = (a: string[]) => a[0] === "rev-list" && a[1] === "--count";
const isTip = (a: string[]) => a[0] === "rev-parse" && a[1] === "--verify";

Deno.test("findCommitsAheadOnRemote - reports the count and remote tip when the fix branch is ahead", async () => {
  const { run, calls } = scripted([
    [isCount, { stdout: "3\n" }],
    [isTip, { stdout: `${TIP}\n` }],
  ]);
  const result = await findCommitsAheadOnRemote(run, FIX, HEAD, {
    cwd: "/work",
  });
  assertEquals(result, { ok: true, value: { ahead: 3, tipSha: TIP } });

  const count = calls.find((c) => isCount(c.args));
  assertEquals(count?.args, [
    "rev-list",
    "--count",
    `refs/remotes/origin/${FIX}`,
    "--not",
    `refs/remotes/origin/${HEAD}`,
  ]);
  // Every git call runs in the supplied checkout, including the shallow probe
  // made by ensureHistoryDepth through the same runner.
  assertEquals(calls.some((c) => isShallow(c.args)), true);
  for (const call of calls) assertEquals(call.cwd, "/work");
});

Deno.test("findCommitsAheadOnRemote - passes no cwd when none is supplied", async () => {
  const { run, calls } = scripted([
    [isCount, { stdout: "1\n" }],
    [isTip, { stdout: `${TIP}\n` }],
  ]);
  const result = await findCommitsAheadOnRemote(run, FIX, HEAD);
  assertEquals(result.ok, true);
  for (const call of calls) assertEquals(call.cwd, undefined);
});

Deno.test("findCommitsAheadOnRemote - an unsafe branch name is an error and runs no git", async () => {
  const { run, calls } = scripted([]);
  const bad = await findCommitsAheadOnRemote(run, "bad name", HEAD);
  assertEquals(bad.ok, false);
  const badHead = await findCommitsAheadOnRemote(run, FIX, "bad:head");
  assertEquals(badHead.ok, false);
  assertEquals(calls.length, 0);
});

Deno.test("findCommitsAheadOnRemote - the PR head fetch failing is an error carrying git's stderr", async () => {
  const { run, calls } = scripted([
    [isHeadFetch, { code: 128, stderr: "fatal: head gone\n" }],
  ]);
  const result = await findCommitsAheadOnRemote(run, FIX, HEAD);
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertStringIncludes(result.error.message, HEAD);
  assertStringIncludes(result.error.message, "fatal: head gone");
  assertEquals(calls.length, 1);
});

Deno.test("findCommitsAheadOnRemote - a runner error on the PR head fetch is passed through", async () => {
  const { run, calls } = scripted([[isHeadFetch, { error: "spawn failed" }]]);
  const result = await findCommitsAheadOnRemote(run, FIX, HEAD);
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.error.message, "spawn failed");
  assertEquals(calls.length, 1);
});

Deno.test("findCommitsAheadOnRemote - a fix branch absent from origin means nothing is stranded", async () => {
  const { run, calls } = scripted([
    [isFixFetch, {
      code: 128,
      stderr: "fatal: couldn't find remote ref refs/heads/x",
    }],
  ]);
  const result = await findCommitsAheadOnRemote(run, FIX, HEAD);
  assertEquals(result, { ok: true, value: null });
  assertEquals(calls.some((c) => isCount(c.args)), false);
});

Deno.test("findCommitsAheadOnRemote - any other fix fetch failure is an error, never 'nothing ahead'", async () => {
  const { run, calls } = scripted([
    [isFixFetch, { code: 128, stderr: "fatal: unable to access remote\n" }],
  ]);
  const result = await findCommitsAheadOnRemote(run, FIX, HEAD);
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertStringIncludes(result.error.message, FIX);
  assertStringIncludes(result.error.message, "unable to access remote");
  assertEquals(calls.some((c) => isCount(c.args)), false);
});

Deno.test("findCommitsAheadOnRemote - a runner error on the fix fetch is passed through", async () => {
  const { run } = scripted([[isFixFetch, { error: "spawn failed" }]]);
  const result = await findCommitsAheadOnRemote(run, FIX, HEAD);
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.error.message, "spawn failed");
});

Deno.test("findCommitsAheadOnRemote - a history-depth failure is an error", async () => {
  const { run, calls } = scripted([
    [isShallow, { code: 1, stderr: "fatal: not a repo" }],
  ]);
  const result = await findCommitsAheadOnRemote(run, FIX, HEAD);
  assertEquals(result.ok, false);
  assertEquals(calls.some((c) => isCount(c.args)), false);
});

Deno.test("findCommitsAheadOnRemote - a failing rev-list count is an error carrying stderr", async () => {
  const { run } = scripted([
    [isCount, { code: 128, stderr: "fatal: bad revision\n" }],
  ]);
  const result = await findCommitsAheadOnRemote(run, FIX, HEAD);
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertStringIncludes(result.error.message, "fatal: bad revision");
});

Deno.test("findCommitsAheadOnRemote - a runner error on the count is passed through", async () => {
  const { run } = scripted([[isCount, { error: "spawn failed" }]]);
  const result = await findCommitsAheadOnRemote(run, FIX, HEAD);
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.error.message, "spawn failed");
});

Deno.test("findCommitsAheadOnRemote - non-numeric count output is an error", async () => {
  for (const stdout of ["", "abc\n", "-1\n", "2 extra\n"]) {
    const { run } = scripted([[isCount, { stdout }]]);
    const result = await findCommitsAheadOnRemote(run, FIX, HEAD);
    assertEquals(result.ok, false, `stdout ${JSON.stringify(stdout)}`);
    if (result.ok) continue;
    assertStringIncludes(result.error.message, "unexpected");
  }
});

Deno.test("findCommitsAheadOnRemote - a zero count is null and never resolves the tip", async () => {
  const { run, calls } = scripted([[isCount, { stdout: "0\n" }]]);
  const result = await findCommitsAheadOnRemote(run, FIX, HEAD);
  assertEquals(result, { ok: true, value: null });
  assertEquals(calls.some((c) => isTip(c.args)), false);
});

Deno.test("findCommitsAheadOnRemote - a failing tip resolve is an error", async () => {
  const { run } = scripted([
    [isCount, { stdout: "2\n" }],
    [isTip, { code: 128, stdout: `${TIP}\n`, stderr: "fatal: no ref\n" }],
  ]);
  const result = await findCommitsAheadOnRemote(run, FIX, HEAD);
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertStringIncludes(result.error.message, "fatal: no ref");
});

Deno.test("findCommitsAheadOnRemote - a tip that is not an object id is an error", async () => {
  for (const stdout of ["", "not-a-sha\n", `${"c".repeat(39)}\n`]) {
    const { run } = scripted([
      [isCount, { stdout: "2\n" }],
      [isTip, { stdout }],
    ]);
    const result = await findCommitsAheadOnRemote(run, FIX, HEAD);
    assertEquals(result.ok, false, `stdout ${JSON.stringify(stdout)}`);
  }
});

Deno.test("findCommitsAheadOnRemote - a SHA-256 object id is accepted as the tip", async () => {
  const sha256 = "d".repeat(64);
  const { run } = scripted([
    [isCount, { stdout: "1\n" }],
    [isTip, { stdout: `${sha256}\n` }],
  ]);
  const result = await findCommitsAheadOnRemote(run, FIX, HEAD);
  assertEquals(result, { ok: true, value: { ahead: 1, tipSha: sha256 } });
});

Deno.test("findCommitsAheadOnRemote - a runner error on the tip resolve is passed through", async () => {
  const { run } = scripted([
    [isCount, { stdout: "2\n" }],
    [isTip, { error: "spawn failed" }],
  ]);
  const result = await findCommitsAheadOnRemote(run, FIX, HEAD);
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.error.message, "spawn failed");
});
