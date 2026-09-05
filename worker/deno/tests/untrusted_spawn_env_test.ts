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
 * Each test below spawns for real and reads the child's own view of its
 * environment, so it fails against the unfixed code (the planted credential
 * is visible to the child) and passes after the fix (it is absent).
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { runPreFlightGate } from "../lib/pre_flight_gate.ts";
import { createBumpDepsRuntimeDeps } from "../lib/phases/bump_deps_phase.ts";
import type { WorkerDeps } from "../lib/issue_worker_wiring.ts";
import { defaultRunner } from "../lib/dependency_lock_regen.ts";

/** A credential-shaped variable name no allowlist entry matches. */
const PLANTED_NAME = "VIBE_TEST_PLANTED_API_TOKEN";
const PLANTED_VALUE = "planted-secret-value-1214";

/**
 * Run `body` with a credential-shaped variable present in the worker's own
 * environment, then remove it again.
 */
async function withPlantedCredential<T>(body: () => Promise<T>): Promise<T> {
  Deno.env.set(PLANTED_NAME, PLANTED_VALUE);
  try {
    return await body();
  } finally {
    Deno.env.delete(PLANTED_NAME);
  }
}

Deno.test("pre-flight gate - a repo-supplied command cannot read the worker's credentials", async () => {
  await withPlantedCredential(async () => {
    // Fails so the captured output rides on the returned error, which is the
    // only surface a pre-flight command's stdout reaches.
    const result = await runPreFlightGate(
      ['sh -c "printenv; exit 1"'],
      { cwd: Deno.cwd(), timeoutSeconds: 30 },
    );
    assert(!result.ok, "expected the failing command to block");
    const output = result.error.output;
    assertEquals(
      output.includes(PLANTED_VALUE),
      false,
      "the pre-flight child inherited a worker credential",
    );
    // The allowlisted essentials are still present, so the gate still works.
    assert(output.includes("PATH="), "expected PATH in the built environment");
  });
});

Deno.test("bump-deps script - a repo-supplied bump script cannot read the worker's credentials", async () => {
  await withPlantedCredential(async () => {
    const dir = await Deno.makeTempDir();
    try {
      const scriptPath = `${dir}/bump-deps.sh`;
      await Deno.writeTextFile(scriptPath, "#!/usr/bin/env bash\nprintenv\n");
      const deps = createBumpDepsRuntimeDeps({} as WorkerDeps);
      const { exitCode, output } = await deps.runScript(dir, scriptPath, {});
      assertEquals(exitCode, 0, `bump script failed: ${output}`);
      assertEquals(
        output.includes(PLANTED_VALUE),
        false,
        "the bump script inherited a worker credential",
      );
      assert(output.includes("PATH="), "expected PATH in the built environment");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
});

Deno.test("lock regeneration - an install hook cannot read the worker's credentials", async () => {
  await withPlantedCredential(async () => {
    const outcome = await defaultRunner({
      bin: "printenv",
      args: [],
      cwd: Deno.cwd(),
      lockPath: "deno.lock",
      timeoutMs: 30_000,
    });
    assertEquals(
      outcome.stdout.includes(PLANTED_VALUE),
      false,
      "the lock-regeneration child inherited a worker credential",
    );
    assert(
      outcome.stdout.includes("PATH="),
      "expected PATH in the built environment",
    );
  });
});
