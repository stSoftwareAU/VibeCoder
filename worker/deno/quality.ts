/**
 * Quality gate entry point (Issue #917).
 *
 * Standalone Deno entry point for running quality checks. This replaces
 * the shell-based orchestration in quality.sh with a Deno TypeScript
 * implementation.
 *
 * Usage:
 *   deno run --allow-all quality.ts                    # Normal mode (parallel)
 *   deno run --allow-all quality.ts --strict           # Strict mode
 *   deno run --allow-all quality.ts --sequential       # Sequential mode
 *   deno run --allow-all quality.ts --validate-prompts # Validate prompts
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { applyEnvOverrides, parseQualityArgs } from "./lib/quality_helpers.ts";
import { runQualityGate } from "./lib/quality_gate.ts";
import type {
  QualityGateConfig,
  QualityGateResult,
} from "./lib/quality_gate.ts";
import { installConsoleRedaction } from "./lib/console_redaction.ts";

/**
 * Build environment record from Deno.env for quality options.
 */
function getEnvRecord(): Record<string, string | undefined> {
  return {
    QUALITY_STRICT: Deno.env.get("QUALITY_STRICT"),
    QUALITY_SEQUENTIAL: Deno.env.get("QUALITY_SEQUENTIAL"),
    QUALITY_VALIDATE_PROMPTS: Deno.env.get("QUALITY_VALIDATE_PROMPTS"),
  };
}

/**
 * Print the gate's assembled transcript and summary table (Issue #1280).
 *
 * `output` is built from the raw `stdout + stderr` of every check, so a test
 * or lint step that echoed a tokenised clone URL puts that URL on this
 * process's stdout — and `quality.ts` is a separate process from `mod.ts`,
 * where the console patch used to be installed. Installing it here as well as
 * at the top of {@link main} is deliberate defence in depth: the installer is
 * idempotent, and binding it to the function that actually prints the
 * captured transcript means no reordering of `main` can leave this path
 * unpatched.
 *
 * @param result - The settled gate result whose output is being printed.
 */
export function printGateOutput(
  result: Pick<QualityGateResult, "summary" | "output">,
): void {
  installConsoleRedaction();
  // Print detailed check output first, then summary table
  if (result.output) {
    console.log(result.output);
  }
  console.log(result.summary.text);
}

/**
 * Main entry point for the quality gate.
 */
async function main(): Promise<void> {
  // Issue #1280 (SEC-1217-12): `quality.ts` is its own process, so it needs
  // its own console patch — the `mod.ts` install never runs here. Every line
  // below (streamed progress, the gate error, the transcript) carries raw
  // check output.
  installConsoleRedaction();

  const rawOptions = parseQualityArgs(Deno.args);
  const options = applyEnvOverrides(rawOptions, getEnvRecord());

  // Determine project root — quality.ts is at worker/deno/quality.ts
  const qualityTsDir = new URL(".", import.meta.url).pathname.replace(
    /\/$/,
    "",
  );
  const scriptDir = qualityTsDir.replace(/\/worker\/deno$/, "");
  const denoDir = `${scriptDir}/worker/deno`;

  // Issue #86: the content-addressed check cache lives on the work volume so
  // it survives an agent's repeated in-session `./quality.sh` runs. Off when
  // WORK_DIR is unset (a host dev run) — never a source of a wrong answer.
  const workDir = Deno.env.get("WORK_DIR");
  const cacheDir = workDir ? `${workDir}/.vibe-cache` : undefined;

  // Issue #399: stream each check as it settles. The gate printed nothing
  // until every check had finished — up to 16 minutes — so an agent driving
  // it could not tell a slow run from a hung one, and backgrounded it behind
  // a `sleep`/`pgrep` poll loop that ate the rest of its execute budget.
  //
  // Progress goes to stdout, deliberately: the worker captures a failing run
  // as `stdout + stderr` and quotes the TAIL of it into the remediation
  // prompt and the failure comment. On stderr the progress block would land
  // at the very end and crowd out the failing detail those tails exist to
  // carry; on stdout it precedes the detail-then-summary dump, which is
  // where a reader wants it anyway.
  const config: QualityGateConfig = {
    scriptDir,
    denoDir,
    options,
    onProgress: (line) => console.log(line),
    ...(cacheDir ? { cacheDir } : {}),
  };

  const result = await runQualityGate(config);
  if (!result.ok) {
    console.error(`Quality gate error: ${result.error.message}`);
    Deno.exit(1);
  }

  const { summary, passed, output } = result.value;
  printGateOutput({ summary, output });
  Deno.exit(passed ? 0 : 1);
}

if (import.meta.main) {
  await main();
}
