/**
 * Tests for the agent-side `git` guard shim and its guard CLI (Issue #1284).
 *
 * The shim tests run the generated wrapper for real against a stub `git` that
 * logs the argv it was handed, so the assertion is on the argv the chokepoint
 * finally spawns — not on the guard's return value.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  encodeGitGuardStdout,
  GIT_GUARD_ALLOW_MARKER,
  GIT_GUARD_REFUSE_MARKER,
  runGitGuardCli,
} from "../lib/git_guard_cli.ts";
import {
  defaultGitGuardModulePath,
  renderGitShimScript,
} from "../lib/git_guard_shim.ts";
import {
  type GhGuardShim,
  type GhGuardShimOutcome,
  installGhGuardShim,
} from "../lib/gh_guard_shim.ts";

/** A known-shaped fake GitHub token — never a real credential. */
const FAKE_TOKEN = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";

/** The placeholder `redactSecrets` substitutes. */
const MASK = "***REDACTED***";

// ---------------------------------------------------------------------------
// runGitGuardCli
// ---------------------------------------------------------------------------

Deno.test("git guard cli - returns the redacted argv for a commit message", () => {
  const result = runGitGuardCli([
    "--",
    "commit",
    "-m",
    `chore: ${FAKE_TOKEN}`,
  ]);
  assertEquals(result.exitCode, 0);
  assertEquals(result.stdout, GIT_GUARD_ALLOW_MARKER);
  assertEquals(result.gitArgs, ["commit", "-m", `chore: ${MASK}`]);
  assertStringIncludes(result.stderr, "GIT_MESSAGE_REDACTED");
});

Deno.test("git guard cli - passes an ordinary command through unchanged", () => {
  const result = runGitGuardCli(["--", "status", "--short"]);
  assertEquals(result.exitCode, 0);
  assertEquals(result.gitArgs, ["status", "--short"]);
  assertEquals(result.stderr, "");
});

Deno.test("git guard cli - refuses a message it cannot scan", () => {
  const result = runGitGuardCli(["--", "commit", "-F", "-"]);
  assertEquals(result.exitCode, 1);
  assertEquals(result.stdout, GIT_GUARD_REFUSE_MARKER);
  assertStringIncludes(result.stderr, "GIT_MESSAGE_UNREDACTABLE");
  assertEquals(result.gitArgs, undefined);
});

Deno.test("git guard cli - a malformed invocation refuses", () => {
  const result = runGitGuardCli(["commit", "-m", "no separator"]);
  assertEquals(result.exitCode, 2);
  assertEquals(result.stdout, GIT_GUARD_REFUSE_MARKER);
});

Deno.test("git guard cli - frames the verdict as NUL-terminated fields", () => {
  assertEquals(
    encodeGitGuardStdout({
      exitCode: 0,
      stdout: GIT_GUARD_ALLOW_MARKER,
      stderr: "",
      gitArgs: ["commit", "-m", "line one\nline two"],
    }),
    `${GIT_GUARD_ALLOW_MARKER}\0commit\0-m\0line one\nline two\0`,
  );
});

// ---------------------------------------------------------------------------
// renderGitShimScript
// ---------------------------------------------------------------------------

Deno.test("git guard shim - the script refuses on a missing allow marker", () => {
  const script = renderGitShimScript({
    denoPath: "/usr/bin/deno",
    guardModulePath: "/repo/git_guard_cli.ts",
    realGitPath: "/usr/bin/git",
    verdictDir: "/tmp/shim",
  });
  // Fail closed: the wrapper only execs on the positive marker.
  assertStringIncludes(script, `= "${GIT_GUARD_ALLOW_MARKER}"`);
  assertStringIncludes(script, "GIT_GUARD_ERROR");
  assertStringIncludes(script, "#!/bin/bash");
});

// ---------------------------------------------------------------------------
// The installed wrapper, run for real against a stub git
// ---------------------------------------------------------------------------

/** A stub `git` on PATH plus the log file it appends its arguments to. */
interface StubGit {
  dir: string;
  log: string;
}

/**
 * Create a temp directory containing a stub `git` (and a stub `gh`, which the
 * install requires) that logs one line per argument received.
 */
async function makeStubGit(): Promise<StubGit> {
  const dir = await Deno.makeTempDir({ prefix: "git_guard_stub_" });
  const log = `${dir}/calls.log`;
  for (const name of ["git", "gh"]) {
    await Deno.writeTextFile(
      `${dir}/${name}`,
      `#!/bin/bash\nprintf '%s\\n' "$@" >> "${log}"\n`,
    );
    await Deno.chmod(`${dir}/${name}`, 0o755);
  }
  return { dir, log };
}

/** Unwrap an installed shim, failing the test when the install was refused. */
function expectInstalled(outcome: GhGuardShimOutcome): GhGuardShim {
  assert(
    outcome.status === "installed",
    `expected the shim to install, got ${outcome.status}`,
  );
  return outcome.shim;
}

/** Run an installed wrapper with `args` and capture its outcome. */
async function runShim(
  shimPath: string,
  env: Record<string, string>,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const command = new Deno.Command(shimPath, {
    args,
    env,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

Deno.test({
  name:
    "git-guard-shim - a token in the agent's commit message never reaches git (Issue #1284)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const stub = await makeStubGit();
    try {
      const shim = expectInstalled(
        await installGhGuardShim({
          baseEnv: { ...Deno.env.toObject(), PATH: stub.dir },
          active: true,
          allowedRepos: ["owner/repo"],
        }),
      );
      assertEquals(shim.gitShimPath, `${shim.dir}/git`);

      const result = await runShim(shim.gitShimPath!, shim.env, [
        "commit",
        "-m",
        `chore: ${FAKE_TOKEN}`,
      ]);
      assertEquals(result.code, 0, result.stderr);

      const logged = await Deno.readTextFile(stub.log);
      assertEquals(
        logged.includes(FAKE_TOKEN),
        false,
        "the token must never reach the git binary",
      );
      assertStringIncludes(logged, MASK);
      assertStringIncludes(result.stderr, "GIT_MESSAGE_REDACTED");

      await shim.cleanup();
    } finally {
      await Deno.remove(stub.dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "git-guard-shim - passes an ordinary git command through untouched",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const stub = await makeStubGit();
    try {
      const shim = expectInstalled(
        await installGhGuardShim({
          baseEnv: { ...Deno.env.toObject(), PATH: stub.dir },
          active: true,
          allowedRepos: ["owner/repo"],
        }),
      );

      const result = await runShim(shim.gitShimPath!, shim.env, [
        "push",
        "origin",
        "HEAD",
      ]);
      assertEquals(result.code, 0, result.stderr);
      assertEquals(await Deno.readTextFile(stub.log), "push\norigin\nHEAD\n");

      await shim.cleanup();
    } finally {
      await Deno.remove(stub.dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "git-guard-shim - refuses the call when the guard cannot be evaluated",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const stub = await makeStubGit();
    try {
      const shim = expectInstalled(
        await installGhGuardShim({
          baseEnv: { ...Deno.env.toObject(), PATH: stub.dir },
          active: true,
          allowedRepos: ["owner/repo"],
        }),
      );
      // Re-render the wrapper against a guard module that does not exist:
      // `deno run` then exits non-zero and writes no marker, which must
      // refuse rather than pass the command through.
      const script = renderGitShimScript({
        denoPath: Deno.execPath(),
        guardModulePath: `${stub.dir}/absent_guard.ts`,
        realGitPath: `${stub.dir}/git`,
        verdictDir: shim.dir,
      });
      await Deno.writeTextFile(shim.gitShimPath!, script);
      await Deno.chmod(shim.gitShimPath!, 0o755);

      const result = await runShim(shim.gitShimPath!, shim.env, [
        "commit",
        "-m",
        "anything",
      ]);
      assert(result.code !== 0, "a broken guard must refuse the git call");
      assertStringIncludes(result.stderr, "GIT_GUARD_ERROR");
      assertEquals(
        await Deno.readTextFile(stub.log).catch(() => ""),
        "",
        "the real git must never run when the guard could not be evaluated",
      );

      await shim.cleanup();
    } finally {
      await Deno.remove(stub.dir, { recursive: true });
    }
  },
});

Deno.test("git guard shim - resolves its guard module inside the worker lib", () => {
  assertStringIncludes(defaultGitGuardModulePath(), "/lib/git_guard_cli.ts");
});
