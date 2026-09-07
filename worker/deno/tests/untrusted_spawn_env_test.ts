/**
 * Regression tests for the untrusted-child-environment class (Issue #1214).
 *
 * `untrusted_command_env.ts` (Issue #572) exists because the worker executes
 * code it did not write, and an inherited environment hands that code every
 * credential the run holds. The control was wired into the quality-gate spawn
 * only: three sibling spawns of repository-supplied code — the pre-flight
 * gate, the per-repo `bump-deps.sh`, and the lock-file regeneration tools —
 * still inherited the worker's whole environment. A fourth, the per-repo
 * `preSetupCommand` that runs the repository's own dependency install
 * (Issue #1285), was the last one left.
 *
 * Each test spawns for real and reads the child's own view of its environment,
 * asserting the property the control promises: **every** name the child can
 * see is one the allowlist put there. That fails against the unfixed code —
 * an inherited environment always carries names outside a thirty-name
 * allowlist — and passes after the fix.
 *
 * Asserting over the whole name set, rather than planting a credential in the
 * worker's own environment, is what keeps these tests parallel-safe: nothing
 * here mutates process-wide state (Issue #880).
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { runPreFlightGate } from "../lib/pre_flight_gate.ts";
import { createBumpDepsRuntimeDeps } from "../lib/phases/bump_deps_phase.ts";
import type { WorkerDeps } from "../lib/issue_worker_wiring.ts";
import { defaultRunner } from "../lib/dependency_lock_regen.ts";
import { runPreSetupCommand } from "../lib/repo_config.ts";
import type { RepoConfig } from "../types.ts";
import { ALLOWED_ENV_NAMES } from "../lib/untrusted_command_env.ts";

/**
 * Names a POSIX shell sets for itself in a child it starts.
 *
 * They carry no secret and are not inherited from the worker — `sh`/`bash`
 * write them after `clearEnv` has already emptied the environment.
 */
const SHELL_SET_NAMES = ["PWD", "SHLVL", "_", "OLDPWD", "IFS"];

/** Parse `printenv` output into the set of variable names the child saw. */
function envNames(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.slice(0, line.indexOf("=")))
    .filter((name) => name.length > 0);
}

/**
 * Assert the child saw only names the allowlist (plus `extra`) put there.
 *
 * @param output - The child's `printenv` output.
 * @param extra - Names the call site legitimately layers on top.
 */
function assertOnlyAllowlistedNames(
  output: string,
  extra: string[] = [],
): void {
  const permitted = new Set([
    ...ALLOWED_ENV_NAMES,
    ...SHELL_SET_NAMES,
    ...extra,
  ]);
  const leaked = envNames(output).filter((name) => !permitted.has(name));
  assertEquals(
    leaked,
    [],
    `the child inherited names the allowlist never granted: ${
      leaked.join(", ")
    }`,
  );
  assert(
    output.includes("PATH="),
    "expected PATH, so the built environment is usable",
  );
}

Deno.test("pre-flight gate - a repo-supplied command sees only the allowlisted environment", async () => {
  // Fails so the captured output rides on the returned error, which is the
  // only surface a pre-flight command's stdout reaches.
  const result = await runPreFlightGate(
    ['sh -c "printenv; exit 1"'],
    { cwd: Deno.cwd(), timeoutSeconds: 30 },
  );
  assert(!result.ok, "expected the failing command to block");
  assertOnlyAllowlistedNames(result.error.output);
});

Deno.test("bump-deps script - a repo-supplied bump script sees only the allowlisted environment", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const scriptPath = `${dir}/bump-deps.sh`;
    await Deno.writeTextFile(scriptPath, "#!/usr/bin/env bash\nprintenv\n");
    const deps = createBumpDepsRuntimeDeps({} as WorkerDeps);
    const { exitCode, output } = await deps.runScript(dir, scriptPath, {
      VIBE_BUMP_QUARANTINE_HOURS: "24",
    });
    assertEquals(exitCode, 0, `bump script failed: ${output}`);
    assertOnlyAllowlistedNames(output, ["VIBE_BUMP_QUARANTINE_HOURS"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("lock regeneration - an install hook sees only the allowlisted environment", async () => {
  const outcome = await defaultRunner({
    bin: "printenv",
    args: [],
    cwd: Deno.cwd(),
    lockPath: "deno.lock",
    timeoutMs: 30_000,
  });
  assertOnlyAllowlistedNames(outcome.stdout);
});

// ---------------------------------------------------------------------------
// Pre-setup command (Issue #1285)
// ---------------------------------------------------------------------------

/** Run a pre-setup command in `dir` and return what it saw in its environment. */
async function preSetupEnvNames(dir: string): Promise<string> {
  const repoConfigs: Record<string, RepoConfig> = {
    "org/test-repo": { preSetupCommand: "printenv > env.txt" },
  };
  const result = await runPreSetupCommand("org/test-repo", dir, repoConfigs);
  assert(result.ok, "expected the pre-setup command to succeed");
  return await Deno.readTextFile(`${dir}/env.txt`);
}

Deno.test("pre-setup command - a repo's install hook sees only the allowlisted environment", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const output = await preSetupEnvNames(dir);
    assertOnlyAllowlistedNames(output, ["REPO_PATH", "REPO_NAME"]);
    assert(
      output.includes(`REPO_PATH=${dir}`),
      "expected REPO_PATH, so the call site's own overrides still arrive",
    );
    assert(
      output.includes("REPO_NAME=org/test-repo"),
      "expected REPO_NAME, so the call site's own overrides still arrive",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pre-setup command - a provider credential in the worker's environment is out of reach", async () => {
  // The credential is planted in a CHILD worker's environment, never this
  // process's: mutating `Deno.env` here would race every other test in the
  // parallel run (Issue #880). The child imports the real module and runs the
  // real pre-setup path, so what it proves is the shipped behaviour.
  const dir = await Deno.makeTempDir();
  try {
    const modulePath = new URL("../lib/repo_config.ts", import.meta.url).href;
    const driver = `${dir}/driver.ts`;
    await Deno.writeTextFile(
      driver,
      `import { runPreSetupCommand } from ${JSON.stringify(modulePath)};\n` +
        `const result = await runPreSetupCommand("org/test-repo", ${
          JSON.stringify(dir)
        }, { "org/test-repo": { preSetupCommand: "printenv > env.txt" } });\n` +
        `if (!result.ok) { console.error(result.error.message); Deno.exit(1); }\n`,
    );

    const fakeToken = "sk-ant-oat01-vibe-coder-1285-canary";
    const child = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-run",
        driver,
      ],
      env: {
        ...Deno.env.toObject(),
        CLAUDE_CODE_OAUTH_TOKEN: fakeToken,
        ANTHROPIC_API_KEY: fakeToken,
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      child.code,
      0,
      `driver failed: ${new TextDecoder().decode(child.stderr)}`,
    );

    const output = await Deno.readTextFile(`${dir}/env.txt`);
    assert(
      !output.includes(fakeToken),
      "the pre-setup command could read a provider credential",
    );
    assertOnlyAllowlistedNames(output, ["REPO_PATH", "REPO_NAME"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
