/**
 * check-mermaid-built-output command (Issue #272).
 *
 * Asserts Mermaid hardening in the **built** Pages output rather than in the
 * source include. `pages.yml` runs this straight after the Jekyll build, so a
 * bump that loosens `securityLevel` or drops the SRI hash in the HTML that
 * actually ships fails the deploy instead of shipping.
 *
 * Usage:
 *   deno run --allow-read mod.ts check-mermaid-built-output [--site-dir _site]
 *
 * Exits non-zero when a built page loads or initialises Mermaid unsafely.
 * A missing build is SKIPPED, which the command treats as success — the
 * workflow step runs it only after a build, and the quality gate's strict
 * mode is what promotes a skip to a failure.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import type { Command, CommandResult } from "../types.ts";
import {
  checkBuiltMermaidOutput,
  type MermaidBuiltOutputResult,
} from "../lib/mermaid_built_output_check.ts";

export const checkMermaidBuiltOutputCommand: Command = {
  name: "check-mermaid-built-output",
  description:
    "Assert Mermaid securityLevel and CDN SRI in the built _site HTML (Issue #272)",
  async execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult<MermaidBuiltOutputResult>> {
    const siteDir = typeof args["site-dir"] === "string"
      ? (args["site-dir"] as string)
      : `${Deno.cwd()}/_site`;

    const result = await checkBuiltMermaidOutput(siteDir);

    return {
      success: result.status !== "FAILED",
      message: result.output,
      data: result,
    };
  },
};
