/**
 * End-to-end check of the formatters' production wiring (Issue #4113).
 *
 * Unlike `repo_formatters_test.ts`, nothing here is faked: `deno fmt` really
 * runs through `createRepoFormatterDeps()`, and git really commits. The
 * formatters once ran as the untrusted `agent` account, which cannot write the
 * worker-owned worktree, so they reported a result and changed nothing.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";
import {
  createRepoFormatterDeps,
  FORMATTER_COMMIT_MESSAGE,
  runRepoFormatters,
} from "../lib/repo_formatters.ts";
import type { Logger } from "../types.ts";

interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run git in `cwd` with a fixed author identity, as the other fixtures do. */
async function runGit(args: string[], cwd: string): Promise<GitRunResult> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
    env: {
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

/** Run git and fail the test, with stderr, when it exits non-zero. */
async function runGitOk(args: string[], cwd: string): Promise<GitRunResult> {
  const result = await runGit(args, cwd);
  assertEquals(result.code, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result;
}

/** A recording logger implementing every Logger method. */
function makeRecordingLogger(): Logger & { warns: string[] } {
  const warns: string[] = [];
  return {
    warns,
    info: () => {},
    warn: (message) => {
      warns.push(message);
    },
    error: () => {},
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
}

Deno.test("runRepoFormatters - real deno fmt with the production deps fixes and commits a badly formatted file (Issue #4113)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "repo-formatters-real-" });
  try {
    await runGitOk(["init", "-q"], dir);
    await runGitOk(["config", "user.name", "test"], dir);
    await runGitOk(["config", "user.email", "test@example.com"], dir);
    await Deno.writeTextFile(`${dir}/deno.json`, "{}\n");
    await Deno.writeTextFile(`${dir}/a.ts`, "const   x  =  1 ;\n");
    await runGitOk(["add", "-A"], dir);
    await runGitOk(["commit", "-q", "-m", "init"], dir);

    // Mirror the production worktree: worker-owned, readable by everyone and
    // writable only by its owner.
    await Deno.chmod(dir, 0o755);
    await Deno.chmod(`${dir}/a.ts`, 0o644);

    const logger = makeRecordingLogger();
    const result = await runRepoFormatters(dir, ["a.ts"], {
      ...createRepoFormatterDeps(),
      logger,
    });

    const diagnostics = `failures=${JSON.stringify(result.failures)} ` +
      `gitError=${result.gitError} warns=${logger.warns.join(" | ")}`;
    assertEquals(result.failures, [], diagnostics);
    assertEquals(result.committed, true, diagnostics);
    assertEquals(
      await Deno.readTextFile(`${dir}/a.ts`),
      "const x = 1;\n",
      diagnostics,
    );

    const subject = await runGitOk(["log", "-1", "--format=%s"], dir);
    assertEquals(subject.stdout.trim(), FORMATTER_COMMIT_MESSAGE);

    const status = await runGitOk(["status", "--porcelain"], dir);
    assertEquals(status.stdout, "", "working tree should be clean");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
