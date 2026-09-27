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
  assertAdoptedMergeIsSafe,
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

Deno.test(
  "readMergeCommitState - a default tip nobody could read is unknown, never a determinate no-merge (Issue #1964)",
  async () => {
    const { dir, preMergeSha } = await conflictedRepo();
    try {
      await git(["merge", "--abort"], dir);
      const state = await readMergeCommitState({
        preMergeSha,
        defaultSha: "",
        options: { cwd: dir },
      });
      assertEquals(
        state.kind,
        "unknown",
        "the caller resets the branch on `no-merge`, so a failed read must " +
          "never be reported as one",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "readMergeCommitState - a repository git cannot read at all is unknown (Issue #1964)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "issue-1964-state-" });
    try {
      const state = await readMergeCommitState({
        preMergeSha: "a".repeat(40),
        defaultSha: "b".repeat(40),
        options: { cwd: dir },
      });
      assertEquals(state.kind, "unknown");
      assert(
        state.kind === "unknown" && state.detail.length > 0,
        "the failure says what could not be read",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "assertAdoptedMergeIsSafe - a commit the worker did not write still faces the pre-commit safety gate (Issue #1964)",
  async () => {
    const { dir, preMergeSha, defaultSha } = await conflictedRepo();
    try {
      await Deno.writeTextFile(`${dir}/f.txt`, "topic and main\n");
      await Deno.writeTextFile(`${dir}/.env`, "TOKEN=secret\n");
      await git(["add", "-A"], dir);
      await git(["commit", "--no-edit"], dir);

      const refused = await assertAdoptedMergeIsSafe({
        preMergeSha,
        defaultSha,
        options: { cwd: dir },
      });
      assert(!refused.ok, "a merge commit carrying .env is not adoptable");
      assertStringIncludes(refused.error.message, ".env");
      assertStringIncludes(refused.error.message, "safety gate");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "assertAdoptedMergeIsSafe - an ordinary resolution is adoptable, and an unreadable one never is (Issue #1964)",
  async () => {
    const { dir, preMergeSha, defaultSha } = await conflictedRepo();
    try {
      await Deno.writeTextFile(`${dir}/f.txt`, "topic and main\n");
      await git(["add", "-A"], dir);
      await git(["commit", "--no-edit"], dir);
      const safe = await assertAdoptedMergeIsSafe({
        preMergeSha,
        defaultSha,
        options: { cwd: dir },
      });
      assert(safe.ok, `${!safe.ok && safe.error.message}`);

      const unreadable = await assertAdoptedMergeIsSafe({
        preMergeSha: "c".repeat(40),
        defaultSha,
        options: { cwd: dir },
      });
      assert(
        !unreadable.ok,
        "a check that could not run must never read as a pass",
      );
      assertStringIncludes(unreadable.error.message, "could not be listed");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

/**
 * A conflicted merge whose default branch also tracks hidden files
 * (`.claude/…`, `.github/…`) the milestone branch never had (Issue #2739).
 * The conflict is resolved and staged; the caller commits it.
 */
async function conflictedRepoWithHiddenFiles(): Promise<
  { dir: string; preMergeSha: string; defaultSha: string }
> {
  const dir = await Deno.makeTempDir({ prefix: "issue-2739-adopted-" });
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
  await Deno.mkdir(`${dir}/.claude/skills/s`, { recursive: true });
  await Deno.writeTextFile(`${dir}/.claude/skills/s/SKILL.md`, "# skill\n");
  await Deno.mkdir(`${dir}/.github`, { recursive: true });
  await Deno.writeTextFile(`${dir}/.github/y.yml`, "on: push\n");
  // Forced past any .gitignore, as a default branch may legitimately track it.
  await git(["add", "-A", "-f"], dir);
  await git(["commit", "-m", "Main"], dir);
  const defaultSha = (await git(["rev-parse", "main"], dir)).trim();
  await git(["checkout", "topic"], dir);
  const preMergeSha = (await git(["rev-parse", "HEAD"], dir)).trim();
  await new Deno.Command("git", {
    args: ["merge", "main", "--no-edit"],
    cwd: dir,
    stdout: "null",
    stderr: "null",
  }).output();
  await Deno.writeTextFile(`${dir}/f.txt`, "topic and main\n");
  await git(["add", "f.txt"], dir);
  return { dir, preMergeSha, defaultSha };
}

Deno.test(
  "assertAdoptedMergeIsSafe - hidden files the default branch tracks, brought in unchanged, are adopted (Issue #2739)",
  async () => {
    const { dir, preMergeSha, defaultSha } =
      await conflictedRepoWithHiddenFiles();
    try {
      await git(["commit", "--no-edit"], dir);
      const safe = await assertAdoptedMergeIsSafe({
        preMergeSha,
        defaultSha,
        options: { cwd: dir },
      });
      assert(safe.ok, `${!safe.ok && safe.error.message}`);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "assertAdoptedMergeIsSafe - a hidden or secret file the agent added to the merge is still refused (Issue #2739)",
  async () => {
    const { dir, preMergeSha, defaultSha } =
      await conflictedRepoWithHiddenFiles();
    try {
      await Deno.writeTextFile(`${dir}/.env`, "TOKEN=secret\n");
      await Deno.writeTextFile(`${dir}/.claude/secret`, "token\n");
      await git(["add", "-f", ".env", ".claude/secret"], dir);
      await git(["commit", "--no-edit"], dir);
      const refused = await assertAdoptedMergeIsSafe({
        preMergeSha,
        defaultSha,
        options: { cwd: dir },
      });
      assert(!refused.ok, "an agent-added .env or .claude file is refused");
      assertStringIncludes(refused.error.message, ".env");
      assertStringIncludes(refused.error.message, ".claude/secret");
      assert(
        !refused.error.message.includes("SKILL.md"),
        `the merged-in SKILL.md is exempt and must not be listed: ${refused.error.message}`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "assertAdoptedMergeIsSafe - a merged-in hidden file the agent edited or re-moded is still refused (Issue #2739)",
  async () => {
    const edited = await conflictedRepoWithHiddenFiles();
    try {
      await Deno.writeTextFile(
        `${edited.dir}/.claude/skills/s/SKILL.md`,
        "# skill\nleaked=1\n",
      );
      await git(["add", "-f", ".claude/skills/s/SKILL.md"], edited.dir);
      await git(["commit", "--no-edit"], edited.dir);
      const refused = await assertAdoptedMergeIsSafe({
        preMergeSha: edited.preMergeSha,
        defaultSha: edited.defaultSha,
        options: { cwd: edited.dir },
      });
      assert(!refused.ok, "an edited merged-in hidden file is refused");
      assertStringIncludes(refused.error.message, ".claude/skills/s/SKILL.md");
    } finally {
      await Deno.remove(edited.dir, { recursive: true });
    }

    const moded = await conflictedRepoWithHiddenFiles();
    try {
      await git(
        ["update-index", "--chmod=+x", ".claude/skills/s/SKILL.md"],
        moded.dir,
      );
      await git(["commit", "--no-edit"], moded.dir);
      const refused = await assertAdoptedMergeIsSafe({
        preMergeSha: moded.preMergeSha,
        defaultSha: moded.defaultSha,
        options: { cwd: moded.dir },
      });
      assert(!refused.ok, "a mode change is a modification and is refused");
      assertStringIncludes(refused.error.message, ".claude/skills/s/SKILL.md");
    } finally {
      await Deno.remove(moded.dir, { recursive: true });
    }
  },
);

Deno.test(
  "assertAdoptedMergeIsSafe - a merged-in parent that cannot be read, or is not HEAD's parent, exempts nothing (Issue #2739)",
  async () => {
    const { dir, preMergeSha, defaultSha } =
      await conflictedRepoWithHiddenFiles();
    try {
      await git(["commit", "--no-edit"], dir);

      const unreadable = await assertAdoptedMergeIsSafe({
        preMergeSha,
        defaultSha: "d".repeat(40),
        options: { cwd: dir },
      });
      assert(!unreadable.ok, "an unreadable parent must fail closed");
      assertStringIncludes(
        unreadable.error.message,
        ".claude/skills/s/SKILL.md",
      );

      // A commit holding the very same blobs that is not HEAD's parent is
      // not what the merge brought in, so it vouches for nothing.
      await git(["checkout", "-q", "-b", "lookalike", defaultSha], dir);
      await git(["commit", "--allow-empty", "-m", "Lookalike"], dir);
      const lookalike = (await git(["rev-parse", "HEAD"], dir)).trim();
      await git(["checkout", "-q", "topic"], dir);
      const stranger = await assertAdoptedMergeIsSafe({
        preMergeSha,
        defaultSha: lookalike,
        options: { cwd: dir },
      });
      assert(!stranger.ok, "only HEAD's own merged-in parent is trusted");
      assertStringIncludes(stranger.error.message, ".claude/skills/s/SKILL.md");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);
