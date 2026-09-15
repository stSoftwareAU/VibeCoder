/**
 * `toolchain-selfcheck` — run the worker's own start-up toolchain self-check
 * and report its verdict (Issues #1956, #2070–#2073).
 *
 * The check itself lives in `lib/toolchain_selfcheck.ts` and the worker runs
 * it before it claims anything. This command exposes exactly that check to a
 * caller outside the worker — the container build in CI, which runs it inside
 * the freshly built image over the checkout mounted where the launchers mount
 * it — so the verdict the fleet will reach is reached on the pull request
 * first.
 *
 * It exists because the alternative already failed: CI verified the baked
 * toolchain with its own shell reimplementation of "does the image report the
 * pin", that reimplementation passed `v24.19.0`, the worker's stricter rule
 * did not, and every host in the fleet refused to claim work against an
 * image CI had passed. Two implementations of one rule will drift; the fix is
 * for CI to run the one the fleet runs.
 *
 * Exit status follows the worker's: 0 when every pinned toolchain reports its
 * pin, {@link TOOLCHAIN_SELFCHECK_EXIT_STATUS} (89) when the image does not
 * provide one, 1 when the manifest itself cannot be judged. A run outside the
 * image is a FAILURE here, not a skip: the caller asked for an image to be
 * proved, and "nothing was verified" is not that.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  checkContainerToolchains,
  TOOLCHAIN_SELFCHECK_EXIT_STATUS,
  type ToolchainSelfCheckOptions,
  type ToolchainSelfCheckVerdict,
} from "../lib/toolchain_selfcheck.ts";
import { CONTAINER_IMAGE_STAMP_ENV } from "../lib/container_stamp.ts";

/** The seams of the underlying check, minus the root the command resolves. */
export type ToolchainSelfcheckSeams = Omit<
  ToolchainSelfCheckOptions,
  "repoRoot"
>;

export interface ToolchainSelfcheckCommand extends Command {
  execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
    seams?: ToolchainSelfcheckSeams,
  ): Promise<CommandResult<ToolchainSelfCheckVerdict>>;
}

export const toolchainSelfcheckCommand: ToolchainSelfcheckCommand = {
  name: "toolchain-selfcheck",
  description:
    "Probe every toolchain container/tools.json pins against the running image — the check the worker runs before it claims anything (Issue #1956)",
  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
    seams: ToolchainSelfcheckSeams = {},
  ): Promise<CommandResult<ToolchainSelfCheckVerdict>> {
    const repoRoot = typeof args["base-dir"] === "string" &&
        (args["base-dir"] as string).length > 0
      ? (args["base-dir"] as string).replace(/[/\\]+$/, "")
      : Deno.cwd();

    const verdict = await checkContainerToolchains({ ...seams, repoRoot });
    const account = verdict.lines.join("\n");

    if (verdict.skipped !== undefined) {
      return {
        success: false,
        exitCode: 1,
        message: `toolchain-selfcheck: nothing verified — ${verdict.skipped} ` +
          `(run it inside the image, where ${CONTAINER_IMAGE_STAMP_ENV} is set)`,
        data: verdict,
      };
    }
    if (verdict.ok) {
      return { success: true, message: account, data: verdict };
    }
    return {
      success: false,
      // The worker's own statuses, so a caller can tell an image that does
      // not provide a pin (worth rebuilding) from a manifest that cannot be
      // judged (not worth rebuilding).
      exitCode: verdict.fault === "image" ? TOOLCHAIN_SELFCHECK_EXIT_STATUS : 1,
      message: `${account}\ntoolchain-selfcheck: FAILED — ${verdict.reason}`,
      data: verdict,
    };
  },
};
