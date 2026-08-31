/**
 * release-notice command (Issue #690, part of #674).
 *
 * Prints one line at launch when this host is pinned to a release older than
 * the newest one, and nothing at all otherwise:
 *
 * ```text
 * A new release of Vibe Coder is available: 1.0.4 → 1.0.5. Run ./run.sh upgrade to install it.
 * ```
 *
 * Usage:
 *   deno run --allow-env --allow-read --allow-run \
 *     mod.ts release-notice --base-dir /path/to/checkout
 *
 * Stdout carries the notice and nothing else, so `run.sh` captures it with
 * `$(…)` and — only when it is non-empty — prints it to stderr and records it
 * in `run_core.log`. A host with nothing to be told produces empty output and
 * stays silent.
 *
 * It runs beside `worker-checkout-update`, before the configuration load, so
 * it reads `update_mode` and `pinned_ref` out of `.config.json` under
 * `--base-dir` through the same reader that command uses (Issue #624) rather
 * than resolving them a second way.
 *
 * Failure is loud — a non-zero exit naming what went wrong — and the launcher
 * treats that as a warning, so an unreachable GitHub costs a warning line, not
 * a launch. Every `gh` call is bounded by the shared timeout helper
 * (Issue #689), so it costs seconds rather than hanging the launch.
 *
 * **Notifying only.** This command changes no pin, installs nothing and never
 * moves the checkout — `./run.sh upgrade` (Issue #691) is what does that.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import type { Command, CommandResult } from "../types.ts";
import {
  createDefaultReleaseCheckDeps,
  type ReleaseCheckDeps,
} from "../lib/release_check.ts";
import { releaseNotice } from "../lib/release_notice.ts";
import { readCheckoutUpdateMode } from "./worker_checkout_update.ts";

/** What the command reports back to the launcher. */
export interface ReleaseNoticeResult {
  /** The checkout whose `.config.json` was consulted. */
  repoDir: string;
  /** Whether a notice was printed. */
  notify: boolean;
  /** The notice line, or "" when there was nothing to say. */
  line: string;
  /** Why nothing was said; "" when a notice was printed. */
  reason: string;
}

/** A trimmed non-empty string argument, or undefined. */
function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export const releaseNoticeCommand: Command = {
  name: "release-notice",
  description:
    "Print one line when a newer release than this frozen host's pin exists (Issue #690)",

  execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult<ReleaseNoticeResult>> {
    return printReleaseNotice(args);
  },
};

/**
 * Work out what this launch has to say about releases, and say it once.
 *
 * Separated from the {@link Command} wrapper so the tests can drive it with
 * injected deps — no `gh`, no git, no network.
 *
 * @param args - `base-dir` (required): the checkout holding `.config.json`
 * @param deps - Injected release-check deps; the real `gh`/git ones otherwise
 * @returns The notice as the command's message, "" when there is nothing to
 *   say, or a fail-loud message naming what went wrong
 */
export async function printReleaseNotice(
  args: Record<string, unknown>,
  deps?: ReleaseCheckDeps,
): Promise<CommandResult<ReleaseNoticeResult>> {
  const repoDir = optionalString(args["base-dir"]);
  if (!repoDir) {
    return {
      success: false,
      message: "release-notice requires --base-dir <checkout>",
    };
  }

  const settings = await readCheckoutUpdateMode(repoDir);
  if (!settings.ok) {
    return { success: false, message: settings.error.message };
  }

  const outcome = await releaseNotice(
    settings.value,
    deps ?? createDefaultReleaseCheckDeps(repoDir),
  );
  if (!outcome.ok) {
    return { success: false, message: outcome.error.message };
  }

  const notice = outcome.value;
  return {
    success: true,
    // Stdout is the notice, or empty: the launcher prints and logs whatever
    // it captures here, so anything else would become a spurious notice.
    message: notice.notify ? notice.line : "",
    data: {
      repoDir,
      notify: notice.notify,
      line: notice.notify ? notice.line : "",
      reason: notice.notify ? "" : notice.reason,
    },
  };
}
