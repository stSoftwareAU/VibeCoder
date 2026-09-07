/**
 * Tests for `git` message redaction and the `runGitCommand` chokepoint that
 * applies it (Issue #1284).
 *
 * The end-to-end tests drive real `git` against a throwaway repository and
 * assert on the message actually written to history — the argv the chokepoint
 * finally spawned — rather than on the function's return value alone.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  gitSubcommandIndex,
  redactGitMessageArgs,
  UnredactableMessageError,
} from "../lib/git_message_redaction.ts";
import { runGitCommand } from "../lib/git_timeout.ts";

/** A known-shaped fake GitHub token — never a real credential. */
const FAKE_TOKEN = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";

/** The placeholder `redactSecrets` substitutes. */
const MASK = "***REDACTED***";

// ---------------------------------------------------------------------------
// redactGitMessageArgs — text-carrying arguments
// ---------------------------------------------------------------------------

Deno.test("git message redaction - masks a token in commit -m", () => {
  const out = redactGitMessageArgs(["commit", "-m", `leak ${FAKE_TOKEN}`]);
  assertEquals(out, ["commit", "-m", `leak ${MASK}`]);
});

Deno.test("git message redaction - masks --message and --message=", () => {
  assertEquals(
    redactGitMessageArgs(["commit", "--message", FAKE_TOKEN]),
    ["commit", "--message", MASK],
  );
  assertEquals(
    redactGitMessageArgs(["commit", `--message=${FAKE_TOKEN}`]),
    ["commit", `--message=${MASK}`],
  );
});

Deno.test("git message redaction - masks a message attached to its flag", () => {
  assertEquals(
    redactGitMessageArgs(["commit", `-m${FAKE_TOKEN}`]),
    ["commit", `-m${MASK}`],
  );
});

Deno.test("git message redaction - masks a message in a short cluster", () => {
  assertEquals(
    redactGitMessageArgs(["commit", "-am", FAKE_TOKEN]),
    ["commit", "-am", MASK],
  );
  assertEquals(
    redactGitMessageArgs(["commit", `-am${FAKE_TOKEN}`]),
    ["commit", `-am${MASK}`],
  );
});

Deno.test("git message redaction - masks tag, merge, notes and stash messages", () => {
  assertEquals(
    redactGitMessageArgs(["tag", "-a", "v1", "-m", FAKE_TOKEN]),
    ["tag", "-a", "v1", "-m", MASK],
  );
  assertEquals(
    redactGitMessageArgs(["merge", "-m", FAKE_TOKEN, "topic"]),
    ["merge", "-m", MASK, "topic"],
  );
  assertEquals(
    redactGitMessageArgs(["notes", "add", "-m", FAKE_TOKEN]),
    ["notes", "add", "-m", MASK],
  );
  assertEquals(
    redactGitMessageArgs(["stash", "push", "-m", FAKE_TOKEN]),
    ["stash", "push", "-m", MASK],
  );
});

Deno.test("git message redaction - masks an abbreviated long option", () => {
  // `git` expands any unambiguous prefix, so `--mess` commits exactly as
  // `--message` does and must not be a one-character bypass.
  for (const flag of ["--m", "--mes", "--mess", "--messag"]) {
    assertEquals(
      redactGitMessageArgs(["commit", flag, FAKE_TOKEN]),
      ["commit", flag, MASK],
      `${flag} must carry the same redaction as --message`,
    );
  }
  assertEquals(
    redactGitMessageArgs(["commit", `--mess=${FAKE_TOKEN}`]),
    ["commit", `--message=${MASK}`],
  );
  assertEquals(
    redactGitMessageArgs(["commit", "--fil", "/tmp/msg.txt"], () => FAKE_TOKEN),
    ["commit", "--message", MASK],
  );
});

Deno.test("git message redaction - a --file prefix git itself rejects is inert", () => {
  // `--fi` is ambiguous with `--fixup`, so git rejects it; treating it as a
  // message file would turn `git commit --fixup <ref>` into a refusal.
  const args = ["commit", "--fi", "/tmp/msg.txt"];
  assertEquals(redactGitMessageArgs(args, () => FAKE_TOKEN), args);
  const fixup = ["commit", "--fixup", "deadbeef"];
  assertEquals(redactGitMessageArgs(fixup, () => FAKE_TOKEN), fixup);
});

Deno.test("git message redaction - masks a commit-tree plumbing message", () => {
  assertEquals(
    redactGitMessageArgs(["commit-tree", "abc123", "-m", FAKE_TOKEN]),
    ["commit-tree", "abc123", "-m", MASK],
  );
  // `-p <parent>` is routing.
  const routing = ["commit-tree", "abc123", "-p", "deadbeef"];
  assertEquals(redactGitMessageArgs(routing), routing);
});

Deno.test("git message redaction - scopes past git's own global options", () => {
  assertEquals(
    redactGitMessageArgs(["-C", "/repo", "commit", "-m", FAKE_TOKEN]),
    ["-C", "/repo", "commit", "-m", MASK],
  );
  assertEquals(
    redactGitMessageArgs([
      "-c",
      "user.name=x",
      "--git-dir",
      "/repo/.git",
      "commit",
      "-m",
      FAKE_TOKEN,
    ]),
    [
      "-c",
      "user.name=x",
      "--git-dir",
      "/repo/.git",
      "commit",
      "-m",
      MASK,
    ],
  );
});

// ---------------------------------------------------------------------------
// redactGitMessageArgs — routing arguments stay byte-for-byte
// ---------------------------------------------------------------------------

Deno.test("git message redaction - leaves routing arguments untouched", () => {
  const args = [
    "commit",
    "--no-verify",
    "-C",
    "deadbeef",
    "--allow-empty",
    "--",
    "src/file.ts",
  ];
  assertEquals(redactGitMessageArgs(args), args);
});

Deno.test("git message redaction - never touches -m where it is not a message", () => {
  // `revert -m <mainline>`, `cherry-pick -m <mainline>`, `branch -m <name>`
  // and `rebase -m` (which takes no argument at all) are routing.
  for (const sub of ["revert", "cherry-pick", "branch", "rebase"]) {
    const args = [sub, "-m", "1", "deadbeef"];
    assertEquals(redactGitMessageArgs(args), args, `${sub} -m must be inert`);
  }
});

Deno.test("git message redaction - leaves a cluster whose earlier letter takes the value", () => {
  // `git commit -Sm keyid` signs with key "m"; there is no message here.
  const args = ["commit", "-Sm", FAKE_TOKEN];
  assertEquals(redactGitMessageArgs(args), args);
});

Deno.test("git message redaction - leaves a pathspec after -- alone", () => {
  const args = ["commit", "--", "-m", FAKE_TOKEN];
  assertEquals(redactGitMessageArgs(args), args);
});

Deno.test("git message redaction - a message with no secret is unchanged", () => {
  const args = ["commit", "-m", "Fix the date parser\n\nCloses #1284"];
  assertEquals(redactGitMessageArgs(args), args);
});

Deno.test("git message redaction - gitSubcommandIndex reports no subcommand", () => {
  assertEquals(gitSubcommandIndex([]), -1);
  assertEquals(gitSubcommandIndex(["-C", "/repo"]), -1);
  assertEquals(gitSubcommandIndex(["--version"]), -1);
});

// ---------------------------------------------------------------------------
// redactGitMessageArgs — message files
// ---------------------------------------------------------------------------

Deno.test("git message redaction - inlines a masked -F file, leaving the file alone", () => {
  const reader = (path: string) => {
    assertEquals(path, "/tmp/msg.txt");
    return `subject\n\n${FAKE_TOKEN}\n`;
  };
  assertEquals(
    redactGitMessageArgs(["commit", "-F", "/tmp/msg.txt"], reader),
    ["commit", "-m", `subject\n\n${MASK}\n`],
  );
  assertEquals(
    redactGitMessageArgs(["commit", "--file", "/tmp/msg.txt"], reader),
    ["commit", "--message", `subject\n\n${MASK}\n`],
  );
  assertEquals(
    redactGitMessageArgs(["commit", "--file=/tmp/msg.txt"], reader),
    ["commit", `--message=subject\n\n${MASK}\n`],
  );
});

Deno.test("git message redaction - a clean -F file keeps its file reference", () => {
  const args = ["commit", "-F", "/tmp/msg.txt"];
  assertEquals(redactGitMessageArgs(args, () => "nothing secret here"), args);
});

Deno.test("git message redaction - without a reader, -F is left as it was", () => {
  const args = ["commit", "-F", "/tmp/msg.txt"];
  assertEquals(redactGitMessageArgs(args), args);
});

Deno.test("git message redaction - an unreadable message file fails closed", () => {
  let raised: unknown;
  try {
    redactGitMessageArgs(["commit", "-F", "/tmp/gone.txt"], () => {
      throw new Error("ENOENT");
    });
  } catch (err) {
    raised = err;
  }
  assert(raised instanceof UnredactableMessageError);
  assertEquals(raised.source, "/tmp/gone.txt");
});

Deno.test("git message redaction - a message from stdin fails closed", () => {
  let raised: unknown;
  try {
    redactGitMessageArgs(["commit", "-F", "-"], () => "unused");
  } catch (err) {
    raised = err;
  }
  assert(raised instanceof UnredactableMessageError);
  assertEquals(raised.source, "-");
});

// ---------------------------------------------------------------------------
// runGitCommand — the chokepoint, end to end against real git
// ---------------------------------------------------------------------------

/** Create a throwaway repository with an identity and one empty commit. */
async function makeRepo(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "git_msg_redaction_" });
  for (
    const args of [
      ["init", "-q", "-b", "main"],
      ["config", "user.email", "test@example.com"],
      ["config", "user.name", "Test"],
      ["config", "commit.gpgsign", "false"],
    ]
  ) {
    const result = await runGitCommand(args, { cwd: dir });
    assert(result.ok && result.value.code === 0, `git ${args[0]} failed`);
  }
  return dir;
}

/** The subject and body of `HEAD` in `dir`. */
async function headMessage(dir: string): Promise<string> {
  const result = await runGitCommand(["log", "-1", "--format=%B"], {
    cwd: dir,
  });
  assert(result.ok, "git log failed");
  return result.value.stdout;
}

Deno.test({
  name:
    "runGitCommand masks a token in the commit message it spawns (Issue #1284)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const dir = await makeRepo();
    try {
      const result = await runGitCommand(
        [
          "commit",
          "--allow-empty",
          "--no-verify",
          "-m",
          `chore: leak ${FAKE_TOKEN}`,
        ],
        { cwd: dir },
      );
      assert(result.ok, "the commit should still run");
      assertEquals(result.value.code, 0, result.value.stderr);

      const message = await headMessage(dir);
      assertEquals(
        message.includes(FAKE_TOKEN),
        false,
        "the token must not reach branch history",
      );
      assertStringIncludes(message, MASK);
      assertStringIncludes(message, "chore: leak");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "runGitCommand masks a token in a -F commit message file (Issue #1284)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const dir = await makeRepo();
    try {
      const messageFile = `${dir}/message.txt`;
      const original = `chore: from a file\n\ntoken ${FAKE_TOKEN}\n`;
      await Deno.writeTextFile(messageFile, original);

      const result = await runGitCommand(
        ["commit", "--allow-empty", "--no-verify", "-F", messageFile],
        { cwd: dir },
      );
      assert(result.ok, "the commit should still run");
      assertEquals(result.value.code, 0, result.value.stderr);

      const message = await headMessage(dir);
      assertEquals(message.includes(FAKE_TOKEN), false);
      assertStringIncludes(message, MASK);
      // The caller's own file is never rewritten.
      assertEquals(await Deno.readTextFile(messageFile), original);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "runGitCommand leaves an ordinary commit message byte-for-byte",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const dir = await makeRepo();
    try {
      const subject = "fix(parser): handle empty input\n\nCloses #1284";
      const result = await runGitCommand(
        ["commit", "--allow-empty", "--no-verify", "-m", subject],
        { cwd: dir },
      );
      assert(result.ok && result.value.code === 0, "the commit should run");
      assertStringIncludes(await headMessage(dir), subject);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "runGitCommand refuses a message it cannot scan (Issue #1284)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const dir = await makeRepo();
    try {
      const result = await runGitCommand(
        ["commit", "--allow-empty", "-F", `${dir}/missing.txt`],
        { cwd: dir },
      );
      assertEquals(result.ok, false, "an unscannable message must fail loud");
      assert(!result.ok);
      assertStringIncludes(result.error.message, "GIT_MESSAGE_UNREDACTABLE");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
