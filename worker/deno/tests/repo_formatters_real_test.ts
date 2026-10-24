/**
 * End-to-end check of the formatters' production wiring (Issue #4113).
 *
 * Unlike `worker/deno/tests/repo_formatters_test.ts`, nothing here is faked:
 * `deno fmt` really runs through `createRepoFormatterDeps()`, and git really
 * commits. The formatters once ran as the untrusted `agent` account, which
 * cannot write the worker-owned worktree, so they reported a result and changed
 * nothing.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  createRepoFormatterDeps,
  FORMATTER_COMMIT_MESSAGE,
  runFormatterCommand,
  runRepoFormatters,
} from "../lib/repo_formatters.ts";
import { ALLOWED_ENV_NAMES } from "../lib/untrusted_command_env.ts";
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

Deno.test("createRepoFormatterDeps().runCommand runs the formatter as the worker's own uid (Issue #4113)", async () => {
  // Base ran `sudo -u agent`, so this fails there wherever the `agent` account
  // exists: the uid it reports is then not the worker's.
  // The worker's uid is read by spawning `id -u` directly in this process, which
  // has the same uid as the test, so no --allow-sys is needed (Deno.uid()).
  const direct = await new Deno.Command("id", {
    args: ["-u"],
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
  }).output();
  const directStderr = new TextDecoder().decode(direct.stderr);
  const directUid = new TextDecoder().decode(direct.stdout).trim();
  assertEquals(direct.code, 0, directStderr);
  assert(directUid.length > 0, "direct `id -u` printed no uid (Issue #4113)");

  const result = await createRepoFormatterDeps().runCommand(["id", "-u"]);
  assertEquals(result.exitCode, 0, result.output);
  assertEquals(result.output.trim(), directUid);
});

Deno.test("runFormatterCommand records a missing binary as exit 1 with the error text (Issue #4113)", async () => {
  const result = await runFormatterCommand([
    "definitely-not-a-real-binary-4113",
  ]);
  assertEquals(result.exitCode, 1, result.output);
  assertStringIncludes(result.output, "definitely-not-a-real-binary-4113");
});

Deno.test("runFormatterCommand gives the child a credential-free environment (Issue #4113)", async () => {
  // Only reads the environment: parallel tests share it, so nothing is set here.
  const allowed = new Set(ALLOWED_ENV_NAMES);
  const result = await runFormatterCommand(["env"]);
  assertEquals(result.exitCode, 0, result.output);

  // `env` prints NAME=value per line. A continuation line of a multi-line value
  // has no '=' of its own at line start, so only lines containing '=' count,
  // and a name is the text before the first '='.
  const childNames = result.output
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => line.slice(0, line.indexOf("=")));
  const offenders = childNames.filter((name) => !allowed.has(name));
  assertEquals(
    offenders,
    [],
    `child environment carries names outside ALLOWED_ENV_NAMES: ${
      offenders.join(", ")
    }`,
  );

  // Positive control 1: the child does get an environment, so the check above
  // is the allowlist at work rather than an empty environment.
  assertStringIncludes(result.output, "PATH=");

  // Positive control 2: the parent does have names outside the allowlist, so
  // the check above is not vacuous.
  const parentOutside = Object.keys(Deno.env.toObject()).filter((name) =>
    !allowed.has(name)
  );
  assert(
    parentOutside.length > 0,
    "the parent process has no environment name outside ALLOWED_ENV_NAMES, so the child check would pass vacuously (Issue #4113)",
  );
});
