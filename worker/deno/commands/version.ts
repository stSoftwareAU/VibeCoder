/**
 * Version command for the Vibe Coder worker.
 *
 * Displays version information about the worker.
 * Version is sourced from deno.json as the single source of truth (Issue #226).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";

/** Load version from deno.json — the single source of truth (Issue #226). */
function loadVersionFromDenoJson(): string {
  const denoJsonPath = new URL("../deno.json", import.meta.url);
  const denoJsonText = Deno.readTextFileSync(denoJsonPath);
  const denoJson = JSON.parse(denoJsonText);
  return denoJson.version;
}

/** Current worker version, sourced from deno.json. */
export const VERSION: string = loadVersionFromDenoJson();

/** Typed data returned by the version command (Issue #223). */
export interface VersionData {
  version: string;
  runtime: string;
  denoVersion: string;
  v8Version: string;
  typescriptVersion: string;
}

/**
 * Version command implementation.
 */
export const versionCommand: Command = {
  name: "version",
  description: "Display version information about the Vibe Coder worker",

  async execute(
    _args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<VersionData>> {
    return {
      success: true,
      message: `Vibe Coder Worker v${VERSION}`,
      data: {
        version: VERSION,
        runtime: "Deno",
        denoVersion: Deno.version.deno,
        v8Version: Deno.version.v8,
        typescriptVersion: Deno.version.typescript,
      },
    };
  },
};
