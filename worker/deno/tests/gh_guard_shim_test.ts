/**
 * Tests for gh_guard_shim.ts — the `gh` wrapper interposed on the agent
 * subprocess's PATH (Issue #3643).
 *
 * These are end-to-end behaviour tests: the shim is installed, then executed
 * as a real subprocess against a stub `gh` binary. What is asserted is the
 * observable outcome — did the stub `gh` run, what exit code did the shim
 * return, what did it say on stderr — never how the shim is written.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { AuditMutation } from "../lib/audit_journal.ts";
import {
  GH_GUARD_SHIM_AUDIT_VERB,
  type GhGuardShim,
  type GhGuardShimOutcome,
  installGhGuardShim,
  prepareGhGuardShim,
  UNGUARDED_AGENT_GH_ENV,
} from "../lib/gh_guard_shim.ts";
import {
  _resetWriteRepoAllowlistSinks,
  _setWriteRepoAllowlistSinks,
  registerWriteRepo,
  resetWriteRepoAllowlist,
  seedWriteRepoAllowlist,
} from "../lib/write_repo_allowlist.ts";

/** The `gh` target variables the wrapper is expected to control (#3866). */
const GH_TARGET_ENV_NAMES = [
  "GH_REPO",
  "GH_HOST",
  "GH_CONFIG_DIR",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
];

/** Unwrap an installed shim, failing the test when the install was refused. */
function expectInstalled(outcome: GhGuardShimOutcome): GhGuardShim {
  assertEquals(
    outcome.status,
    "installed",
    `expected the shim to install, got ${outcome.status}`,
  );
  assert(outcome.status === "installed");
  return outcome.shim;
}

/** A stub `gh` on PATH plus the log file it appends its arguments to. */
interface StubGh {
  /** Directory holding the stub binary (the "real gh" the shim delegates to). */
  dir: string;
  /** File the stub appends one line per argument to. */
  log: string;
}

/** Create a temp directory containing a stub `gh` that logs its arguments. */
async function makeStubGh(): Promise<StubGh> {
  const dir = await Deno.makeTempDir({ prefix: "gh_guard_stub_" });
  const log = `${dir}/calls.log`;
  await Deno.writeTextFile(
    `${dir}/gh`,
    `#!/bin/bash\nprintf '%s\\n' "$@" >> "${log}"\nprintf 'stub-gh-ok\\n'\n`,
  );
  await Deno.chmod(`${dir}/gh`, 0o755);
  return { dir, log };
}

/**
 * Create a stub `gh` that logs the target-selecting environment it received.
 *
 * One `NAME=value` line per variable, with `<unset>` when it is absent — this
 * is what the real binary would have resolved its target from (Issue #3866).
 */
async function makeEnvLoggingStubGh(): Promise<StubGh> {
  const dir = await Deno.makeTempDir({ prefix: "gh_guard_env_stub_" });
  const log = `${dir}/env.log`;
  const names = GH_TARGET_ENV_NAMES;
  const lines = names
    .map((n) => `printf '${n}=%s\\n' "\${${n}-<unset>}" >> "${log}"`)
    .join("\n");
  await Deno.writeTextFile(
    `${dir}/gh`,
    `#!/bin/bash\n${lines}\nprintf 'stub-gh-ok\\n'\n`,
  );
  await Deno.chmod(`${dir}/gh`, 0o755);
  return { dir, log };
}

/** The worker's environment with every `gh` target variable removed. */
function baseEnvWithoutGhTargets(path: string): Record<string, string> {
  const env: Record<string, string> = { ...Deno.env.toObject(), PATH: path };
  for (const name of GH_TARGET_ENV_NAMES) delete env[name];
  return env;
}

/** Read the stub's call log (empty string when it never ran). */
async function readLog(log: string): Promise<string> {
  try {
    return await Deno.readTextFile(log);
  } catch {
    return "";
  }
}

/** Run an installed shim with `args` and capture its outcome. */
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
  name: "gh-guard-shim - blocks an off-allowlist write before gh ever runs",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const stub = await makeStubGh();
    const shim = expectInstalled(
      await installGhGuardShim({
        baseEnv: { ...Deno.env.toObject(), PATH: stub.dir },
        active: true,
        allowedRepos: ["stSoftwareAU/VibeCoder"],
      }),
    );
    try {
      const result = await runShim(shim.shimPath, shim.env, [
        "issue",
        "comment",
        "1",
        "-R",
        "other-owner/other-repo",
        "--body",
        "leak",
      ]);
      assert(result.code !== 0, "expected a non-zero exit for a refused write");
      assertStringIncludes(result.stderr, "[SECURITY]");
      assertStringIncludes(result.stderr, "other-owner/other-repo");
      assertEquals(await readLog(stub.log), "", "gh must not have been run");
    } finally {
      await shim.cleanup();
      await Deno.remove(stub.dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "gh-guard-shim - blocks a reserved-label self-application",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const stub = await makeStubGh();
    const shim = expectInstalled(
      await installGhGuardShim({
        baseEnv: { ...Deno.env.toObject(), PATH: stub.dir },
        active: true,
        allowedRepos: ["stSoftwareAU/VibeCoder"],
      }),
    );
    try {
      const result = await runShim(shim.shimPath, shim.env, [
        "issue",
        "edit",
        "1",
        "--add-label",
        "top-priority",
      ]);
      assert(result.code !== 0, "expected a non-zero exit for a refused label");
      assertStringIncludes(result.stderr, "WORKER_LABEL_REFUSED");
      assertEquals(await readLog(stub.log), "", "gh must not have been run");
    } finally {
      await shim.cleanup();
      await Deno.remove(stub.dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "gh-guard-shim - delegates an allowed command to the real gh verbatim",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const stub = await makeStubGh();
    const shim = expectInstalled(
      await installGhGuardShim({
        baseEnv: { ...Deno.env.toObject(), PATH: stub.dir },
        active: true,
        allowedRepos: ["stSoftwareAU/VibeCoder"],
      }),
    );
    try {
      const result = await runShim(shim.shimPath, shim.env, [
        "issue",
        "comment",
        "1",
        "-R",
        "stSoftwareAU/VibeCoder",
        "--body",
        "hello world",
      ]);
      assertEquals(result.code, 0, result.stderr);
      assertStringIncludes(result.stdout, "stub-gh-ok");
      assertEquals(
        await readLog(stub.log),
        "issue\ncomment\n1\n-R\nstSoftwareAU/VibeCoder\n--body\nhello world\n",
      );
    } finally {
      await shim.cleanup();
      await Deno.remove(stub.dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "gh-guard-shim - fails closed when the guard cannot be evaluated",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const stub = await makeStubGh();
    const shim = expectInstalled(
      await installGhGuardShim({
        baseEnv: { ...Deno.env.toObject(), PATH: stub.dir },
        active: true,
        allowedRepos: ["stSoftwareAU/VibeCoder"],
        guardModulePath: "/nonexistent/gh_guard_cli.ts",
      }),
    );
    try {
      const result = await runShim(shim.shimPath, shim.env, [
        "issue",
        "comment",
        "1",
        "--body",
        "hello",
      ]);
      assert(result.code !== 0, "a guard that cannot run must refuse the call");
      assertStringIncludes(result.stderr, "GH_GUARD_ERROR");
      assertEquals(await readLog(stub.log), "", "gh must not have been run");
    } finally {
      await shim.cleanup();
      await Deno.remove(stub.dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "gh-guard-shim - puts the shim first on the child's PATH",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const stub = await makeStubGh();
    const shim = expectInstalled(
      await installGhGuardShim({
        baseEnv: { ...Deno.env.toObject(), PATH: `${stub.dir}:/usr/bin` },
        active: false,
        allowedRepos: [],
      }),
    );
    try {
      assertEquals(shim.env["PATH"], `${shim.dir}:${stub.dir}:/usr/bin`);
      assertEquals(shim.shimPath, `${shim.dir}/gh`);
      const info = await Deno.stat(shim.shimPath);
      assert(info.isFile, "the shim must be a file");
      assert(((info.mode ?? 0) & 0o111) !== 0, "the shim must be executable");
    } finally {
      await shim.cleanup();
      await Deno.remove(stub.dir, { recursive: true });
    }
  },
});

// ---------------------------------------------------------------------------
// The baked snapshot is deliberately not live (Issue #3861)
//
// `registerWriteRepo` is a worker-process grant. The agent keeps the allowlist
// baked into its wrapper at spawn time, so a mid-run grant must not reach the
// child — and must not be silent either. This is the tripwire for the
// dangerous direction: a future "live allowlist file" would flip the first
// assertion, reopening the #3858 containment gap.
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "gh-guard-shim - a mid-run registerWriteRepo does not widen the spawned child",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const stub = await makeStubGh();
    const logs: string[] = [];
    _setWriteRepoAllowlistSinks({ log: (m) => logs.push(m) });
    seedWriteRepoAllowlist("stSoftwareAU/VibeCoder");

    const shim = expectInstalled(
      await prepareGhGuardShim({
        ...Deno.env.toObject(),
        PATH: stub.dir,
      }),
    );
    try {
      // The worker grants itself a second repo *after* the child was spawned.
      registerWriteRepo("example-org/private-repo-29");

      const result = await runShim(shim.shimPath, shim.env, [
        "issue",
        "create",
        "--repo",
        "example-org/private-repo-29",
        "--title",
        "Idle task: security scan",
        "--body",
        "x",
      ]);
      assert(result.code !== 0, "the child must keep its spawn-time allowlist");
      assertStringIncludes(result.stderr, "WRITE_REPO_BLOCKED");
      assertEquals(await readLog(stub.log), "", "gh must not have been run");

      // The ineffective-for-the-agent grant is reported, not swallowed.
      assertEquals(logs.length, 1);
      assertStringIncludes(logs[0] ?? "", "WRITE_REPO_GRANT_AFTER_SPAWN");
      assertStringIncludes(logs[0] ?? "", "example-org/private-repo-29");
    } finally {
      await shim.cleanup();
      await Deno.remove(stub.dir, { recursive: true });
      resetWriteRepoAllowlist();
      _resetWriteRepoAllowlistSinks();
    }
  },
});

Deno.test({
  name: "gh-guard-shim - the wrapper is not writable by group or other",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const stub = await makeStubGh();
    seedWriteRepoAllowlist("stSoftwareAU/VibeCoder");
    const shim = expectInstalled(
      await prepareGhGuardShim({
        ...Deno.env.toObject(),
        PATH: stub.dir,
      }),
    );
    try {
      // The allowlist the child enforces lives in this wrapper, so nothing
      // outside the worker's own user may rewrite it.
      const file = await Deno.stat(shim.shimPath);
      const dir = await Deno.stat(shim.dir);
      assertEquals((file.mode ?? 0) & 0o022, 0, "wrapper must not be w by g/o");
      assertEquals((dir.mode ?? 0) & 0o022, 0, "shim dir must not be w by g/o");
    } finally {
      await shim.cleanup();
      await Deno.remove(stub.dir, { recursive: true });
      resetWriteRepoAllowlist();
    }
  },
});

Deno.test({
  name:
    "gh-guard-shim - blocks the run and installs nothing when gh is absent while the allowlist is active",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const empty = await Deno.makeTempDir({ prefix: "gh_guard_empty_" });
    const warnings: string[] = [];
    const recorded: AuditMutation[] = [];
    try {
      const outcome = await installGhGuardShim({
        baseEnv: { ...Deno.env.toObject(), PATH: empty },
        active: true,
        allowedRepos: ["stSoftwareAU/VibeCoder"],
        warn: (m) => warnings.push(m),
        allowUnguarded: false,
        record: (m) => {
          recorded.push(m);
          return Promise.resolve();
        },
      });
      assertEquals(outcome.status, "blocked");
      assertEquals(warnings.length, 1);
      assertStringIncludes(warnings[0] ?? "", "GH_GUARD_SHIM_UNAVAILABLE");
      assertEquals(
        recorded.length,
        1,
        "the loss of control must be journalled",
      );
      assertEquals(recorded[0]?.verb, GH_GUARD_SHIM_AUDIT_VERB);
      assertEquals(recorded[0]?.outcome, "error");
      assertStringIncludes(recorded[0]?.target ?? "", "blocked");
    } finally {
      await Deno.remove(empty, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "gh-guard-shim - blocks the run when the shim directory cannot be created",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const stub = await makeStubGh();
    const warnings: string[] = [];
    try {
      const outcome = await installGhGuardShim({
        baseEnv: { ...Deno.env.toObject(), PATH: stub.dir },
        active: true,
        allowedRepos: ["stSoftwareAU/VibeCoder"],
        warn: (m) => warnings.push(m),
        allowUnguarded: false,
        record: () => Promise.resolve(),
        makeTempDir: () => Promise.reject(new Error("no space left on device")),
      });
      assertEquals(outcome.status, "blocked");
      assert(outcome.status === "blocked");
      assertStringIncludes(outcome.reason, "no space left on device");
      assertStringIncludes(warnings[0] ?? "", "GH_GUARD_SHIM_UNAVAILABLE");
    } finally {
      await Deno.remove(stub.dir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "gh-guard-shim - degrades rather than blocks while the allowlist is inactive",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const empty = await Deno.makeTempDir({ prefix: "gh_guard_empty_" });
    const warnings: string[] = [];
    const recorded: AuditMutation[] = [];
    try {
      const outcome = await installGhGuardShim({
        baseEnv: { ...Deno.env.toObject(), PATH: empty },
        active: false,
        allowedRepos: [],
        warn: (m) => warnings.push(m),
        allowUnguarded: false,
        record: (m) => {
          recorded.push(m);
          return Promise.resolve();
        },
      });
      assertEquals(outcome.status, "degraded");
      assertStringIncludes(warnings[0] ?? "", "GH_GUARD_SHIM_UNAVAILABLE");
      assertStringIncludes(recorded[0]?.target ?? "", "degraded");
    } finally {
      await Deno.remove(empty, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "gh-guard-shim - degrades when the operator explicitly opts in to an unguarded run",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const empty = await Deno.makeTempDir({ prefix: "gh_guard_empty_" });
    const warnings: string[] = [];
    try {
      const outcome = await installGhGuardShim({
        baseEnv: { ...Deno.env.toObject(), PATH: empty },
        active: true,
        allowedRepos: ["stSoftwareAU/VibeCoder"],
        warn: (m) => warnings.push(m),
        allowUnguarded: true,
        record: () => Promise.resolve(),
      });
      assertEquals(outcome.status, "degraded");
      assertStringIncludes(warnings[0] ?? "", UNGUARDED_AGENT_GH_ENV);
    } finally {
      await Deno.remove(empty, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "gh-guard-shim - reads the operator opt-in from the environment by default",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const empty = await Deno.makeTempDir({ prefix: "gh_guard_empty_" });
    const previous = Deno.env.get(UNGUARDED_AGENT_GH_ENV);
    try {
      Deno.env.set(UNGUARDED_AGENT_GH_ENV, "1");
      const optedIn = await installGhGuardShim({
        baseEnv: { ...Deno.env.toObject(), PATH: empty },
        active: true,
        allowedRepos: ["stSoftwareAU/VibeCoder"],
        warn: () => {},
        record: () => Promise.resolve(),
      });
      assertEquals(optedIn.status, "degraded");

      // A falsey value is not an opt-in — the run still fails closed.
      Deno.env.set(UNGUARDED_AGENT_GH_ENV, "false");
      const notOptedIn = await installGhGuardShim({
        baseEnv: { ...Deno.env.toObject(), PATH: empty },
        active: true,
        allowedRepos: ["stSoftwareAU/VibeCoder"],
        warn: () => {},
        record: () => Promise.resolve(),
      });
      assertEquals(notOptedIn.status, "blocked");
    } finally {
      if (previous === undefined) Deno.env.delete(UNGUARDED_AGENT_GH_ENV);
      else Deno.env.set(UNGUARDED_AGENT_GH_ENV, previous);
      await Deno.remove(empty, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "gh-guard-shim - a failing audit sink is reported loudly and still blocks",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const empty = await Deno.makeTempDir({ prefix: "gh_guard_empty_" });
    const warnings: string[] = [];
    try {
      const outcome = await installGhGuardShim({
        baseEnv: { ...Deno.env.toObject(), PATH: empty },
        active: true,
        allowedRepos: ["stSoftwareAU/VibeCoder"],
        warn: (m) => warnings.push(m),
        allowUnguarded: false,
        record: () => Promise.reject(new Error("journal unavailable")),
      });
      assertEquals(outcome.status, "blocked");
      assert(
        warnings.some((w) => w.includes("AUDIT_JOURNAL_REFUSED")),
        "a journalling failure must not be swallowed",
      );
    } finally {
      await Deno.remove(empty, { recursive: true });
    }
  },
});

Deno.test({
  name: "gh-guard-shim - a caller-supplied GH_REPO never reaches the real gh",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const stub = await makeEnvLoggingStubGh();
    const shim = expectInstalled(
      await installGhGuardShim({
        baseEnv: baseEnvWithoutGhTargets(stub.dir),
        active: true,
        allowedRepos: ["stSoftwareAU/VibeCoder"],
      }),
    );
    try {
      const result = await runShim(
        shim.shimPath,
        {
          ...shim.env,
          GH_REPO: "other-owner/other-repo",
          GH_HOST: "attacker.example",
          GH_CONFIG_DIR: "/tmp/attacker-gh-config",
          GH_ENTERPRISE_TOKEN: "leaked",
          GITHUB_ENTERPRISE_TOKEN: "leaked",
        },
        ["issue", "comment", "1", "--body", "hello"],
      );
      assertEquals(result.code, 0, result.stderr);
      assertEquals(
        await readLog(stub.log),
        "GH_REPO=<unset>\nGH_HOST=<unset>\nGH_CONFIG_DIR=<unset>\n" +
          "GH_ENTERPRISE_TOKEN=<unset>\nGITHUB_ENTERPRISE_TOKEN=<unset>\n",
      );
    } finally {
      await shim.cleanup();
      await Deno.remove(stub.dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "gh-guard-shim - re-asserts the run's own gh target environment",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const stub = await makeEnvLoggingStubGh();
    const shim = expectInstalled(
      await installGhGuardShim({
        baseEnv: {
          ...baseEnvWithoutGhTargets(stub.dir),
          GH_HOST: "github.com",
          GH_CONFIG_DIR: "/run/owned/gh config",
          // A run that *did* set GH_REPO still must not pass it on: the guard's
          // cwd-scope reasoning assumes the binary resolves the repo from the
          // clone, so GH_REPO is cleared unconditionally (Issue #3866).
          GH_REPO: "stSoftwareAU/VibeCoder",
        },
        active: true,
        allowedRepos: ["stSoftwareAU/VibeCoder"],
      }),
    );
    try {
      const result = await runShim(
        shim.shimPath,
        {
          ...shim.env,
          GH_HOST: "attacker.example",
          GH_CONFIG_DIR: "/tmp/attacker-gh-config",
        },
        ["issue", "comment", "1", "--body", "hello"],
      );
      assertEquals(result.code, 0, result.stderr);
      assertEquals(
        await readLog(stub.log),
        "GH_REPO=<unset>\nGH_HOST=github.com\n" +
          "GH_CONFIG_DIR=/run/owned/gh config\nGH_ENTERPRISE_TOKEN=<unset>\n" +
          "GITHUB_ENTERPRISE_TOKEN=<unset>\n",
      );
    } finally {
      await shim.cleanup();
      await Deno.remove(stub.dir, { recursive: true });
    }
  },
});

// ---------------------------------------------------------------------------
// Issue #3938 — model-authored bodies are redacted on the way to the real gh
// ---------------------------------------------------------------------------

/** A realistic GitHub token shape — the payload the agent must not publish. */
const GH_TOKEN_SAMPLE = `ghp_${"a1B2c3D4e5".repeat(4)}`;

Deno.test({
  name:
    "gh-guard-shim - redacts a secret in an inline --body before gh sees it",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const stub = await makeStubGh();
    const shim = expectInstalled(
      await installGhGuardShim({
        baseEnv: { ...Deno.env.toObject(), PATH: stub.dir },
        active: true,
        allowedRepos: ["stSoftwareAU/VibeCoder"],
      }),
    );
    try {
      const result = await runShim(shim.shimPath, shim.env, [
        "issue",
        "comment",
        "1",
        "-R",
        "stSoftwareAU/VibeCoder",
        "--body",
        `the token is ${GH_TOKEN_SAMPLE}`,
      ]);
      assertEquals(result.code, 0, result.stderr);
      const log = await readLog(stub.log);
      assertEquals(
        log.includes(GH_TOKEN_SAMPLE),
        false,
        "the token must never reach the real gh",
      );
      assertStringIncludes(log, "the token is ***REDACTED***");
      // The routing arguments are untouched by the rewrite.
      assertStringIncludes(log, "stSoftwareAU/VibeCoder");
      assertStringIncludes(result.stderr, "GH_BODY_REDACTED");
    } finally {
      await shim.cleanup();
      await Deno.remove(stub.dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "gh-guard-shim - redacts a secret carried in a --body-file",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const stub = await makeStubGh();
    const bodyFile = `${stub.dir}/body.md`;
    await Deno.writeTextFile(bodyFile, `leaked ${GH_TOKEN_SAMPLE}\n`);
    const shim = expectInstalled(
      await installGhGuardShim({
        baseEnv: { ...Deno.env.toObject(), PATH: stub.dir },
        active: true,
        allowedRepos: ["stSoftwareAU/VibeCoder"],
      }),
    );
    try {
      const result = await runShim(shim.shimPath, shim.env, [
        "issue",
        "comment",
        "1",
        "--body-file",
        bodyFile,
      ]);
      assertEquals(result.code, 0, result.stderr);
      const log = await readLog(stub.log);
      assertEquals(
        log.includes(GH_TOKEN_SAMPLE),
        false,
        "the file's token must never reach the real gh",
      );
      assertStringIncludes(log, "leaked ***REDACTED***");
      // The agent's own file is left exactly as it wrote it.
      assertEquals(
        await Deno.readTextFile(bodyFile),
        `leaked ${GH_TOKEN_SAMPLE}\n`,
      );
    } finally {
      await shim.cleanup();
      await Deno.remove(stub.dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "gh-guard-shim - refuses a body it cannot scan for secrets",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const stub = await makeStubGh();
    const shim = expectInstalled(
      await installGhGuardShim({
        baseEnv: { ...Deno.env.toObject(), PATH: stub.dir },
        active: true,
        allowedRepos: ["stSoftwareAU/VibeCoder"],
      }),
    );
    try {
      const result = await runShim(shim.shimPath, shim.env, [
        "issue",
        "comment",
        "1",
        "--body-file",
        "-",
      ]);
      assert(result.code !== 0, "an unscannable body must not be published");
      assertStringIncludes(result.stderr, "GH_BODY_UNREDACTABLE");
      assertEquals(await readLog(stub.log), "", "gh must not have been run");
    } finally {
      await shim.cleanup();
      await Deno.remove(stub.dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "gh-guard-shim - refuses a config alias the guard cannot classify",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const stub = await makeStubGh();
    const shim = expectInstalled(
      await installGhGuardShim({
        baseEnv: { ...Deno.env.toObject(), PATH: stub.dir },
        active: true,
        allowedRepos: ["stSoftwareAU/VibeCoder"],
      }),
    );
    try {
      const result = await runShim(shim.shimPath, shim.env, ["leak-it"]);
      assert(result.code !== 0, "expected a non-zero exit for an alias");
      assertStringIncludes(result.stderr, "GH_UNKNOWN_COMMAND");
      assertEquals(await readLog(stub.log), "", "gh must not have been run");
    } finally {
      await shim.cleanup();
      await Deno.remove(stub.dir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "gh-guard-shim - two concurrent slots spawn two shims with two different allowlists (Issue #4175)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const {
      createWriteRepoAllowlistContext,
      withWriteRepoAllowlistContext,
    } = await import("../lib/write_repo_allowlist.ts");
    const stub = await makeStubGh();
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));
    let shimA: Awaited<ReturnType<typeof expectInstalled>> | undefined;
    let shimB: Awaited<ReturnType<typeof expectInstalled>> | undefined;
    try {
      // Slot A seeds repo A, slot B seeds repo B; both prepare a shim while
      // interleaved. Each shim must bake ITS slot's allowlist.
      const prepA = withWriteRepoAllowlistContext(
        createWriteRepoAllowlistContext(),
        async () => {
          seedWriteRepoAllowlist("stSoftwareAU/VibeCoder");
          await tick();
          shimA = expectInstalled(
            await prepareGhGuardShim({
              ...Deno.env.toObject(),
              PATH: stub.dir,
            }),
          );
        },
      );
      const prepB = withWriteRepoAllowlistContext(
        createWriteRepoAllowlistContext(),
        async () => {
          seedWriteRepoAllowlist("example-org/private-repo-29");
          await tick();
          shimB = expectInstalled(
            await prepareGhGuardShim({
              ...Deno.env.toObject(),
              PATH: stub.dir,
            }),
          );
        },
      );
      await Promise.all([prepA, prepB]);
      assert(shimA && shimB);

      const write = (repo: string) => [
        "issue",
        "create",
        "--repo",
        repo,
        "--title",
        "t",
        "--body",
        "x",
      ];
      // A's shim: NEAT-AI is refused, VibeCoder is allowed through.
      const aCross = await runShim(
        shimA.shimPath,
        shimA.env,
        write("example-org/private-repo-29"),
      );
      assert(aCross.code !== 0, "shim A must refuse slot B's repo");
      assertStringIncludes(aCross.stderr, "WRITE_REPO_BLOCKED");
      const aOwn = await runShim(
        shimA.shimPath,
        shimA.env,
        write("stSoftwareAU/VibeCoder"),
      );
      assertEquals(aOwn.code, 0, aOwn.stderr);
      // B's shim: the mirror image.
      const bCross = await runShim(
        shimB.shimPath,
        shimB.env,
        write("stSoftwareAU/VibeCoder"),
      );
      assert(bCross.code !== 0, "shim B must refuse slot A's repo");
      assertStringIncludes(bCross.stderr, "WRITE_REPO_BLOCKED");
      const bOwn = await runShim(
        shimB.shimPath,
        shimB.env,
        write("example-org/private-repo-29"),
      );
      assertEquals(bOwn.code, 0, bOwn.stderr);
    } finally {
      await shimA?.cleanup();
      await shimB?.cleanup();
      await Deno.remove(stub.dir, { recursive: true });
      resetWriteRepoAllowlist();
    }
  },
});
