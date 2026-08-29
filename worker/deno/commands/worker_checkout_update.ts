/**
 * worker-checkout-update command (Issue #512).
 *
 * Updates the Vibe Coder checkout to `origin/<default-branch>` **on the
 * host**, before each container launch. The same update happens inside the
 * container today (the bootstrap prelude's git reset), which is the only
 * reason `/workspace` has to be mounted read-write — and because the fleet
 * self-update rewrites `run.sh`, code the *host* executes, that mount is a
 * container→host escape path. Doing the update here is the prerequisite for
 * mounting the checkout read-only (Issue #509).
 *
 * The sequence and the branch resolution are the prelude's, not a restatement
 * of them: {@link resetCheckoutToDefaultBranch} runs `git fetch origin` →
 * `git checkout <branch>` → `git reset --hard origin/<branch>` →
 * `git clean -fd`, and {@link resolveOriginDefaultBranch} reads `origin/HEAD`,
 * repairing a clone that lacks it with `git remote set-head origin --auto`.
 * `--default-branch` names the branch explicitly when a host wants to
 * override that.
 *
 * Usage:
 *   deno run --allow-env --allow-read --allow-write --allow-run \
 *     mod.ts worker-checkout-update --base-dir /path/to/checkout \
 *     [--default-branch trunk] [--log-dir ~/logs]
 *
 * Failure is loud here — a non-zero exit naming what went wrong — and the
 * launchers treat that as a warning rather than a fatal error, so a host that
 * cannot reach GitHub still launches the worker on the checkout it has.
 *
 * **The update discards uncommitted work**, exactly as the in-container reset
 * always has. `VIBE_SKIP_CHECKOUT_UPDATE` is the way out for the checkouts
 * where that is wrong: a development tree someone is working in, and CI, whose
 * checkout is a pull-request merge commit that must not be reset to the
 * default branch mid-run. The skip says so loudly and is never silent.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import type { Command, CommandResult } from "../types.ts";
import {
  resetCheckoutToDefaultBranch,
  resolveOriginDefaultBranch,
} from "../lib/run_bootstrap.ts";

/** Environment variable that turns the update off (see the module doc). */
export const SKIP_CHECKOUT_UPDATE_ENV = "VIBE_SKIP_CHECKOUT_UPDATE";

/** What the command reports back to the launcher. */
export interface WorkerCheckoutUpdateResult {
  /** The checkout the command was pointed at. */
  repoDir: string;
  /** The branch it was updated to, or "" when the update was skipped. */
  branch: string;
  /** False when `VIBE_SKIP_CHECKOUT_UPDATE` turned the update off. */
  updated: boolean;
}

/** A trimmed non-empty string argument, or undefined. */
function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Is the update turned off for this checkout? */
function updateSkipped(): boolean {
  let raw: string | undefined;
  try {
    raw = Deno.env.get(SKIP_CHECKOUT_UPDATE_ENV);
  } catch {
    return false; // No env permission — the update is not turned off.
  }
  const value = raw?.trim().toLowerCase() ?? "";
  return value !== "" && !["0", "false", "no", "off"].includes(value);
}

/** Where git output is logged when the caller names no directory. */
function defaultLogDir(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  return home ? `${home}/logs` : "logs";
}

export const workerCheckoutUpdateCommand: Command = {
  name: "worker-checkout-update",
  description:
    "Update the worker checkout to origin's default branch, host-side (Issue #512)",

  execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult<WorkerCheckoutUpdateResult>> {
    return updateWorkerCheckout(args);
  },
};

/**
 * Update a checkout to `origin/<default-branch>`.
 *
 * Separated from the {@link Command} wrapper so the tests can drive it
 * directly against a temporary repository.
 *
 * @param args - `base-dir` (required), optional `default-branch`, `log-dir`
 * @returns Success with the branch updated to, or a fail-loud message
 */
export async function updateWorkerCheckout(
  args: Record<string, unknown>,
): Promise<CommandResult<WorkerCheckoutUpdateResult>> {
  const repoDir = optionalString(args["base-dir"]);
  if (!repoDir) {
    return {
      success: false,
      message: "worker-checkout-update requires --base-dir <checkout>",
    };
  }

  if (updateSkipped()) {
    return {
      success: true,
      message: `${SKIP_CHECKOUT_UPDATE_ENV} is set: leaving ${repoDir} ` +
        `exactly as it is — the worker will run whatever this checkout holds`,
      data: { repoDir, branch: "", updated: false },
    };
  }

  // A path that is not a checkout can never be updated, and saying so beats
  // four confusing git failures in a row. `.git` is a directory in a normal
  // clone and a file in a worktree — either is a checkout.
  try {
    await Deno.stat(`${repoDir}/.git`);
  } catch {
    return {
      success: false,
      message: `${repoDir} is not a git checkout (no .git): ` +
        `refusing to update it`,
    };
  }

  const logDir = optionalString(args["log-dir"]) ?? defaultLogDir();

  let branch = optionalString(args["default-branch"]);
  if (!branch) {
    const resolved = await resolveOriginDefaultBranch(repoDir);
    if (!resolved.ok) {
      return {
        success: false,
        message: `cannot resolve the default branch of ${repoDir}: ` +
          `${resolved.error.message} (pass --default-branch to name it)`,
      };
    }
    branch = resolved.value;
  }

  const reset = await resetCheckoutToDefaultBranch(repoDir, branch, logDir);
  if (!reset.ok) {
    return {
      success: false,
      message: `cannot update ${repoDir} to origin/${branch}: ` +
        reset.error.message,
      data: { repoDir, branch, updated: false },
    };
  }

  return {
    success: true,
    message: `updated ${repoDir} to origin/${branch}`,
    data: { repoDir, branch, updated: true },
  };
}
