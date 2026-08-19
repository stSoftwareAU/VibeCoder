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
import type { QualityGateConfig } from "./lib/quality_gate.ts";

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
 * Main entry point for the quality gate.
 */
async function main(): Promise<void> {
  const rawOptions = parseQualityArgs(Deno.args);
  const options = applyEnvOverrides(rawOptions, getEnvRecord());

  // Determine project root — quality.ts is at worker/deno/quality.ts
  const qualityTsDir = new URL(".", import.meta.url).pathname.replace(
    /\/$/,
    "",
  );
  const scriptDir = qualityTsDir.replace(/\/worker\/deno$/, "");
  const denoDir = `${scriptDir}/worker/deno`;

  const config: QualityGateConfig = {
    scriptDir,
    denoDir,
    options,
  };

  const result = await runQualityGate(config);
  if (!result.ok) {
    console.error(`Quality gate error: ${result.error.message}`);
    Deno.exit(1);
  }

  const { summary, passed, output } = result.value;
  // Print detailed check output first, then summary table
  if (output) {
    console.log(output);
  }
  console.log(summary.text);
  Deno.exit(passed ? 0 : 1);
}

if (import.meta.main) {
  await main();
}
