/**
 * Regression tests for the untrusted-child-environment class (Issue #1214).
 *
 * `untrusted_command_env.ts` (Issue #572) exists because the worker executes
 * code it did not write, and an inherited environment hands that code every
 * credential the run holds. The control was wired into the quality-gate spawn
 * only: three sibling spawns of repository-supplied code — the pre-flight
 * gate, the per-repo `bump-deps.sh`, and the lock-file regeneration tools —
 * still inherited the worker's whole environment.
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
