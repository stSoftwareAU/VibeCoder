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
 *   deno task test:unit tests/a_test.ts tests/b_test.ts
 *                                     # only the unit tests among these files
 *   deno task test:integration        # the #907 suites, same manifest
 *
 * Every unit pass is held to the time budget (Issue #2642): a test over one
 * second is reported as a WARNING, and a file whose tests are all over it
 * fails the run unless it is exempt — see `lib/unit_test_time_budget.ts`.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { installConsoleRedaction } from "./lib/console_redaction.ts";
import {
  formatPassDuration,
  integrationTestPass,
  targetedUnitTestPasses,
  type UnitTestPass,
  unitTestPasses,
} from "./lib/unit_test_passes.ts";
import { passesTimeBudget } from "./lib/unit_test_time_budget.ts";

/** The runner's own flags; anything else starting with `-` is refused. */
const KNOWN_FLAGS = ["--", "--integration", "--parallel-only", "--serial-only"];

/** Run the passes, stopping at the first failure, then apply the budget. */
async function main(): Promise<void> {
  // Issue #1280 (SEC-1217-12): every entry point patches its own console —
  // this one prints pass labels alongside inherited `deno test` output.
  installConsoleRedaction();

  const integration = Deno.args.includes("--integration");
  const junitDir = integration ? undefined : await Deno.makeTempDir({
    prefix: "vibe_unit_junit_",
  });
  let code: number;
  try {
    code = await runPasses(integration, junitDir);
  } finally {
    if (junitDir) await Deno.remove(junitDir, { recursive: true });
  }
  if (code !== 0) Deno.exit(code);
}

/** Run the selected passes; the exit code the task should end with. */
async function runPasses(
  integration: boolean,
  junitDir: string | undefined,
): Promise<number> {
  const options = {
    denoCmd: Deno.execPath(),
    env: Deno.env.toObject(),
    extraArgs: ["--frozen", "--lock=deno.lock"],
    ...(junitDir ? { junitDir } : {}),
  };

  const only = Deno.args.includes("--parallel-only")
    ? "parallel"
    : Deno.args.includes("--serial-only")
    ? "serial"
    : null;
  // Positional arguments are test files (Issue #2642); `--` is what an
  // operator types to separate them from the task's own flags.
  const files = Deno.args.filter((arg) => !arg.startsWith("-"));
  // Fail loud on anything else: `--filter foo` would otherwise read `foo` as
  // a file and run a different suite from the one asked for.
  const unknown = Deno.args.filter((arg) =>
    arg.startsWith("-") && !KNOWN_FLAGS.includes(arg)
  );
  if (unknown.length > 0) {
    console.error(`Unknown option(s): ${unknown.join(" ")}`);
    return 2;
  }

  let passes: readonly UnitTestPass[];
  if (integration) {
    passes = [integrationTestPass(options)];
  } else if (files.length > 0) {
    const plan = targetedUnitTestPasses(options, files);
    for (const file of plan.skippedIntegration) {
      console.log(`skipped (integration suite, #907): ${file}`);
    }
    if (plan.passes.length === 0) {
      console.error("No unit test files among the files given.");
      return 1;
    }
    passes = plan.passes;
  } else {
    passes = unitTestPasses(options);
  }
  passes = passes.filter((pass) => only === null || pass.label === only);

  const junitPaths: string[] = [];
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
    if (status.code !== 0) return status.code;
    if (pass.junitPath) junitPaths.push(pass.junitPath);
  }

  const budget = await passesTimeBudget(junitPaths);
  for (
    const line of [
      ...budget.exemptNotes,
      ...budget.warnings,
      ...budget.failures,
    ]
  ) {
    console.log(line);
  }
  return budget.failures.length > 0 ? 1 : 0;
}

if (import.meta.main) await main();
