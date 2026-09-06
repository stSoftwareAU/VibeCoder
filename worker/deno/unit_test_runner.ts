/**
 * `deno task test:unit` — the gate's unit suite, run by hand (Issue #940).
 *
 * The task used to carry its own hand-typed `--ignore` list, which had
 * already drifted: it named the thirteen integration suites #907 started
 * with and not the fourteen #935 added, so a developer running the task got
 * a slower, differently-scoped suite than the gate would run on the same
 * change. Deriving the exclusions from the manifests removes the second copy
 * rather than correcting it, and running the same two passes as
 * `runDenoTests` means "it passed locally" and "the gate passed" mean the
 * same thing.
 *
 * Usage:
 *   deno task test:unit               # both passes
 *   deno task test:unit --parallel-only
 *   deno task test:unit --serial-only
 *   deno task test:integration        # the #907 suites, same manifest
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { installConsoleRedaction } from "./lib/console_redaction.ts";
import {
  formatPassDuration,
  integrationTestPass,
  type UnitTestPass,
  unitTestPasses,
} from "./lib/unit_test_passes.ts";

/** Run both passes, stopping at the first failure. */
async function main(): Promise<void> {
  // Issue #1280 (SEC-1217-12): every entry point patches its own console —
  // this one prints pass labels alongside inherited `deno test` output.
  installConsoleRedaction();

  const options = {
    denoCmd: Deno.execPath(),
    env: Deno.env.toObject(),
    extraArgs: ["--frozen", "--lock=deno.lock"],
  };

  const only = Deno.args.includes("--parallel-only")
    ? "parallel"
    : Deno.args.includes("--serial-only")
    ? "serial"
    : null;

  const passes: readonly UnitTestPass[] = Deno.args.includes("--integration")
    ? [integrationTestPass(options)]
    : unitTestPasses(options).filter((pass) =>
      only === null || pass.label === only
    );

  for (const pass of passes) {
    console.log(`\n=== deno test: ${pass.label} pass — ${pass.description}`);
    const startedAt = Date.now();
    const status = await new Deno.Command(pass.args[0]!, {
      args: pass.args.slice(1),
      // The pass env is the whole environment, not an overlay (Issue #1098):
      // without `clearEnv` the child inherits the variables the pass scrubbed,
      // and "it passed locally" stops meaning what the gate means.
      env: pass.env,
      clearEnv: true,
      stdout: "inherit",
      stderr: "inherit",
    }).output();
    const elapsed = formatPassDuration(Date.now() - startedAt);
    const verdict = status.code === 0 ? "PASSED" : "FAILED";
    console.log(`=== ${pass.label} pass: ${verdict} in ${elapsed}`);
    // Stop at the first failure: the remaining pass costs minutes and
    // cannot change the verdict.
    if (status.code !== 0) Deno.exit(status.code);
  }
}

if (import.meta.main) await main();
