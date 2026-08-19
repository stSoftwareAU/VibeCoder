/**
 * `strip-containerfile` — write the comment-stripped Containerfile the
 * image is built from (Issue #4393).
 *
 * The launcher writes the same copy beside its plan file; CI's Docker and
 * Podman builds call this command so all three build the identical text.
 *
 *   deno run --allow-read --allow-write mod.ts strip-containerfile \
 *     --out /tmp/Containerfile.stripped [--in container/Containerfile]
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  CONTAINERFILE_SIZE_CAP_BYTES,
  stripContainerfile,
} from "../lib/containerfile_strip.ts";

/** What the command reports. */
export interface StripContainerfileResult {
  input: string;
  output: string;
  originalBytes: number;
  strippedBytes: number;
  capBytes: number;
}

export const stripContainerfileCommand: Command = {
  name: "strip-containerfile",
  description:
    "Write the comment-stripped Containerfile the image is built from — Apple container caps a Dockerfile at 16 KB (Issue #4393)",
  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<StripContainerfileResult>> {
    const input = typeof args["in"] === "string" && args["in"].length > 0
      ? args["in"]
      : "container/Containerfile";
    const output = typeof args["out"] === "string" && args["out"].length > 0
      ? args["out"]
      : undefined;
    if (!output) {
      return {
        success: false,
        message: "strip-containerfile requires --out <path>",
      };
    }
    let original: string;
    try {
      original = await Deno.readTextFile(input);
    } catch (err) {
      return {
        success: false,
        message: `could not read ${input}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
    const stripped = stripContainerfile(original);
    const strippedBytes = new TextEncoder().encode(stripped).length;
    try {
      await Deno.writeTextFile(output, stripped);
    } catch (err) {
      return {
        success: false,
        message: `could not write ${output}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
    const data = {
      input,
      output,
      originalBytes: new TextEncoder().encode(original).length,
      strippedBytes,
      capBytes: CONTAINERFILE_SIZE_CAP_BYTES,
    };
    if (strippedBytes > CONTAINERFILE_SIZE_CAP_BYTES) {
      return {
        success: false,
        message:
          `stripped Containerfile is ${strippedBytes} bytes — over the ${CONTAINERFILE_SIZE_CAP_BYTES}-byte cap Apple container enforces; trim instructions`,
        data,
      };
    }
    return {
      success: true,
      message:
        `Wrote ${output} (${strippedBytes} bytes stripped from ${data.originalBytes}; cap ${CONTAINERFILE_SIZE_CAP_BYTES})`,
      data,
    };
  },
};
