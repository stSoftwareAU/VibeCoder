/**
 * Atomic write command for the Vibe Coder worker.
 *
 * Writes content to a file atomically (write-to-temp-then-rename),
 * callable from shell via deno_bridge.sh.
 *
 * Migrated from worker/shared/file_utils.sh (Issue #901).
 * Issue #693: Atomic file write utilities for state and cache files.
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { atomicWrite } from "../lib/file_utils.ts";

/**
 * Atomic write command implementation.
 *
 * Args:
 *   --path <string>     Target file path (required)
 *   --content <string>  Content to write (default: empty string)
 *   --mode <string>     File permissions as octal string (default: "600")
 *   --stdin <bool>      Read content from stdin instead of --content arg
 */
export const atomicWriteCommand: Command = {
  name: "atomic-write",
  description: "Write content to a file atomically (Issue #693)",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult> {
    const targetFile = args["path"];
    if (typeof targetFile !== "string" || targetFile.length === 0) {
      return {
        success: false,
        message: "atomic-write: --path is required",
      };
    }

    let content: string;
    if (args["stdin"] === true || args["stdin"] === "true") {
      // Read content from stdin
      const decoder = new TextDecoder();
      const chunks: Uint8Array[] = [];
      for await (const chunk of Deno.stdin.readable) {
        chunks.push(chunk);
      }
      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      const merged = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      content = decoder.decode(merged);
    } else {
      content = typeof args["content"] === "string" ? args["content"] : "";
    }

    // Parse mode from octal string
    const modeStr = typeof args["mode"] === "string" ? args["mode"] : "600";
    const mode = parseInt(modeStr, 8);
    if (isNaN(mode)) {
      return {
        success: false,
        message:
          `atomic-write: invalid mode "${modeStr}" — expected octal (e.g., "600")`,
      };
    }

    const result = await atomicWrite({ targetFile, content, mode });

    if (!result.ok) {
      return { success: false, message: result.error.message };
    }

    return {
      success: true,
      message: `Wrote ${content.length} bytes to ${targetFile}`,
    };
  },
};
