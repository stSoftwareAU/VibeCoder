/**
 * Tests for the agent-side `git` guard shim (Issue #1284).
 *
 * Every test runs the generated wrapper for real against a stub `git` that
 * logs the argv it was handed, so the assertion is on the argv the chokepoint
 * finally spawns — not on a return value and never on the script's source text.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
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

/** Install a shim over `stub`, with the run's allowlist active. */
function installOver(stub: StubGit): Promise<GhGuardShimOutcome> {
  return installGhGuardShim({
    baseEnv: { ...Deno.env.toObject(), PATH: stub.dir },
    active: true,
    allowedRepos: ["owner/repo"],
  });
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

/** Read the stub's call log (empty string when it never ran). */
function readLog(log: string): Promise<string> {
  return Deno.readTextFile(log).catch(() => "");
}

/** The message spellings `git` accepts, each carrying the same fake token. */
const MESSAGE_SPELLINGS: ReadonlyArray<{ name: string; args: string[] }> = [
  { name: "-m <text>", args: ["commit", "-m", `chore: ${FAKE_TOKEN}`] },
  { name: "-m<text>", args: ["commit", `-m${FAKE_TOKEN}`] },
  // The cluster is the case an anchored `-m*` fast path would have skipped.
  { name: "-am <text> (cluster)", args: ["commit", "-am", FAKE_TOKEN] },
  { name: "-am<text> (cluster)", args: ["commit", `-am${FAKE_TOKEN}`] },
  { name: "--message <text>", args: ["commit", "--message", FAKE_TOKEN] },
  { name: "--message=<text>", args: ["commit", `--message=${FAKE_TOKEN}`] },
  // `git` expands any unambiguous long-option prefix.
  {
    name: "--mess <text> (abbreviated)",
    args: ["commit", "--mess", FAKE_TOKEN],
  },
  { name: "tag -m <text>", args: ["tag", "-a", "v1", "-m", FAKE_TOKEN] },
];

for (const spelling of MESSAGE_SPELLINGS) {
  Deno.test({
    name:
      `git-guard-shim - a token spelled ${spelling.name} never reaches git (Issue #1284)`,
    permissions: { run: true, read: true, write: true, env: true },
    ignore: Deno.build.os === "windows",
    fn: async () => {
      const stub = await makeStubGit();
      try {
        const shim = expectInstalled(await installOver(stub));
        assertEquals(shim.gitShimPath, `${shim.dir}/git`);

        const result = await runShim(
          shim.gitShimPath!,
          shim.env,
          spelling.args,
        );
        assertEquals(result.code, 0, result.stderr);

        const logged = await readLog(stub.log);
        assertEquals(
          logged.includes(FAKE_TOKEN),
          false,
          `the token must never reach the git binary (${spelling.name})`,
        );
        assertStringIncludes(logged, MASK);
        assertStringIncludes(result.stderr, "GIT_MESSAGE_REDACTED");

        await shim.cleanup();
      } finally {
        await Deno.remove(stub.dir, { recursive: true });
      }
    },
  });
}

Deno.test({
  name: "git-guard-shim - a token in a -F message file never reaches git",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const stub = await makeStubGit();
    try {
      const shim = expectInstalled(await installOver(stub));
      const messageFile = `${stub.dir}/message.txt`;
      const original = `chore: from a file\n\n${FAKE_TOKEN}\n`;
      await Deno.writeTextFile(messageFile, original);

      const result = await runShim(shim.gitShimPath!, shim.env, [
        "commit",
        "-F",
        messageFile,
      ]);
      assertEquals(result.code, 0, result.stderr);

      const logged = await readLog(stub.log);
      assertEquals(logged.includes(FAKE_TOKEN), false);
      assertStringIncludes(logged, MASK);
      // The agent's own file is never rewritten.
      assertEquals(await Deno.readTextFile(messageFile), original);

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
      const shim = expectInstalled(await installOver(stub));

      const result = await runShim(shim.gitShimPath!, shim.env, [
        "push",
        "origin",
        "HEAD",
      ]);
      assertEquals(result.code, 0, result.stderr);
      assertEquals(await readLog(stub.log), "push\norigin\nHEAD\n");

      await shim.cleanup();
    } finally {
      await Deno.remove(stub.dir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "git-guard-shim - a routing argument the guard sees is still byte-for-byte",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const stub = await makeStubGit();
    try {
      const shim = expectInstalled(await installOver(stub));

      // `--format` reaches the guard (it contains an "m") and must come back
      // exactly as it went in.
      const result = await runShim(shim.gitShimPath!, shim.env, [
        "log",
        "-1",
        "--format=%H",
      ]);
      assertEquals(result.code, 0, result.stderr);
      assertEquals(await readLog(stub.log), "log\n-1\n--format=%H\n");

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
      const shim = expectInstalled(await installOver(stub));
      // Re-render the wrapper against a guard module that does not exist:
      // `deno run` then exits non-zero and writes no marker, which must
      // refuse rather than pass the command through.
      await Deno.writeTextFile(
        shim.gitShimPath!,
        renderGitShimScript({
          denoPath: Deno.execPath(),
          guardModulePath: `${stub.dir}/absent_guard.ts`,
          realGitPath: `${stub.dir}/git`,
          verdictDir: shim.dir,
        }),
      );
      await Deno.chmod(shim.gitShimPath!, 0o755);

      const result = await runShim(shim.gitShimPath!, shim.env, [
        "commit",
        "-m",
        "anything",
      ]);
      assert(result.code !== 0, "a broken guard must refuse the git call");
      assertStringIncludes(result.stderr, "GIT_GUARD_ERROR");
      assertEquals(
        await readLog(stub.log),
        "",
        "the real git must never run when the guard could not be evaluated",
      );

      await shim.cleanup();
    } finally {
      await Deno.remove(stub.dir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "git-guard-shim - no git on PATH means no git wrapper (there is nothing to guard)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "git_guard_ghonly_" });
    try {
      await Deno.writeTextFile(`${dir}/gh`, "#!/bin/bash\nexit 0\n");
      await Deno.chmod(`${dir}/gh`, 0o755);

      const shim = expectInstalled(
        await installGhGuardShim({
          baseEnv: { ...Deno.env.toObject(), PATH: dir },
          active: true,
          allowedRepos: ["owner/repo"],
        }),
      );
      assertEquals(shim.gitShimPath, undefined);
      // The child searches the same directories, so it has no git either.
      assertEquals(shim.env["PATH"], `${shim.dir}:${dir}`);

      await shim.cleanup();
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test("git guard shim - resolves its guard module inside the worker lib", () => {
  assertStringIncludes(defaultGitGuardModulePath(), "/lib/git_guard_cli.ts");
});
