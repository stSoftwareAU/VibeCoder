/**
 * The merge state read before the sync's final-mile commit, and how a failed
 * git command is described (Issue #1964).
 *
 * Real git repositories for the state reading — the question is what git
 * leaves behind after a merge, a committed merge and an aborted one, and a
 * stub of that proves nothing about the real thing.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  describeGitFailure,
  readMergeCommitState,
} from "../lib/milestone_merge_state.ts";

async function git(args: string[], cwd: string): Promise<string> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decode = new TextDecoder();
  if (out.code !== 0) {
    throw new Error(`git ${args.join(" ")}: ${decode.decode(out.stderr)}`);
  }
  return decode.decode(out.stdout);
}

/** A repo whose `main` and `topic` both changed the same line. */
async function conflictedRepo(): Promise<
  { dir: string; preMergeSha: string; defaultSha: string }
> {
  const dir = await Deno.makeTempDir({ prefix: "issue-1964-state-" });
  await git(["init", "--initial-branch=main", "."], dir);
  await git(["config", "user.email", "t@example.com"], dir);
  await git(["config", "user.name", "Test"], dir);
  await Deno.writeTextFile(`${dir}/f.txt`, "seed\n");
  await git(["add", "-A"], dir);
  await git(["commit", "-m", "Seed"], dir);
  await git(["checkout", "-b", "topic"], dir);
  await Deno.writeTextFile(`${dir}/f.txt`, "topic\n");
  await git(["commit", "-am", "Topic"], dir);
  await git(["checkout", "main"], dir);
  await Deno.writeTextFile(`${dir}/f.txt`, "main\n");
  await git(["commit", "-am", "Main"], dir);
  const defaultSha = (await git(["rev-parse", "main"], dir)).trim();
  await git(["checkout", "topic"], dir);
  const preMergeSha = (await git(["rev-parse", "HEAD"], dir)).trim();
  // The merge stops on the conflict, leaving MERGE_HEAD behind.
  await new Deno.Command("git", {
    args: ["merge", "main", "--no-edit"],
    cwd: dir,
    stdout: "null",
    stderr: "null",
  }).output();
  return { dir, preMergeSha, defaultSha };
}

Deno.test(
  "describeGitFailure - a git failure that printed only on stdout is described with that stdout (Issue #1964)",
  () => {
    const detail = describeGitFailure({
      ok: true,
      value: {
        code: 1,
        stdout:
          "On branch milestone/168\nnothing to commit, working tree clean\n",
        stderr: "",
      },
    });
    assertStringIncludes(detail, "nothing to commit, working tree clean");
    assert(
      !detail.includes("no stderr"),
      `a stdout-only refusal must not read as "no stderr": ${detail}`,
    );
  },
);

Deno.test(
  "describeGitFailure - stderr leads, stdout follows, and silence names the exit code (Issue #1964)",
  () => {
    assertEquals(
      describeGitFailure({
        ok: true,
        value: { code: 1, stdout: "out line", stderr: "err line" },
      }),
      "err line | out line",
    );
    assertStringIncludes(
      describeGitFailure({
        ok: true,
        value: { code: 128, stdout: "  \n", stderr: "" },
      }),
      "git exited 128 and printed nothing",
    );
    assertStringIncludes(
      describeGitFailure({ ok: false, error: new Error("spawn refused") }),
      "spawn refused",
    );
  },
);

Deno.test(
  "describeGitFailure - the head of a long output can be taken instead of its tail (Issue #1964)",
  () => {
    const value = { code: 1, stdout: "", stderr: "a\nb\nc\nd\ne\n" };
    assertEquals(
      describeGitFailure({ ok: true, value }, { lines: 2, from: "head" }),
      "a | b",
    );
    assertEquals(
      describeGitFailure({ ok: true, value }, { lines: 2 }),
      "d | e",
    );
  },
);

Deno.test(
  "readMergeCommitState - a conflicted merge still in progress reads as in-progress (Issue #1964)",
  async () => {
    const { dir, preMergeSha, defaultSha } = await conflictedRepo();
    try {
      const state = await readMergeCommitState({
        preMergeSha,
        defaultSha,
        options: { cwd: dir },
      });
      assertEquals(state.kind, "in-progress");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "readMergeCommitState - a merge the agent committed itself is recognised by its parents (Issue #1964)",
  async () => {
    const { dir, preMergeSha, defaultSha } = await conflictedRepo();
    try {
      await Deno.writeTextFile(`${dir}/f.txt`, "topic and main\n");
      await git(["add", "-A"], dir);
      await git(["commit", "--no-edit"], dir);
      const state = await readMergeCommitState({
        preMergeSha,
        defaultSha,
        options: { cwd: dir },
      });
      assertEquals(state.kind, "already-committed");
      assertEquals(
        state.kind === "already-committed" ? state.sha : "",
        (await git(["rev-parse", "HEAD"], dir)).trim(),
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "readMergeCommitState - an aborted merge is a named failure, not a merge commit (Issue #1964)",
  async () => {
    const { dir, preMergeSha, defaultSha } = await conflictedRepo();
    try {
      await git(["merge", "--abort"], dir);
      const state = await readMergeCommitState({
        preMergeSha,
        defaultSha,
        options: { cwd: dir },
      });
      assertEquals(state.kind, "no-merge");
      const detail = state.kind === "no-merge" ? state.detail : "";
      assertStringIncludes(detail, "no longer in progress");
      assertStringIncludes(detail, preMergeSha);
      assertStringIncludes(detail, defaultSha);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "readMergeCommitState - a commit merging some other pair of commits is not the sync's merge (Issue #1964)",
  async () => {
    const { dir, preMergeSha, defaultSha } = await conflictedRepo();
    try {
      await Deno.writeTextFile(`${dir}/f.txt`, "topic and main\n");
      await git(["add", "-A"], dir);
      await git(["commit", "--no-edit"], dir);
      // One extra commit on top: HEAD is no longer the merge itself.
      await Deno.writeTextFile(`${dir}/f.txt`, "and then some\n");
      await git(["commit", "-am", "Extra"], dir);
      const state = await readMergeCommitState({
        preMergeSha,
        defaultSha,
        options: { cwd: dir },
      });
      assertEquals(state.kind, "no-merge");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);
