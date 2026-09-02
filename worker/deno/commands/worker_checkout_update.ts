/**
 * worker-checkout-update command (Issue #512).
 *
 * Updates the Vibe Coder checkout to `origin/<default-branch>` **on the
 * host**, before each container launch. This is now the *only* update of that
 * checkout: Issue #513 retired the in-container bootstrap reset, so no process
 * inside the container writes to `/workspace` and the mount can be read-only
 * (Issue #509) — which matters because the fleet self-update rewrites
 * `run.sh`, code the *host* executes.
 *
 * The work lives in {@link updateCheckout}: `git fetch origin` →
 * `git checkout <branch>` → `git reset --hard origin/<branch>` →
 * `git clean -fd`, with the branch read from `origin/HEAD` (repairing a clone
 * that lacks it with `git remote set-head origin --auto`), the Issue #4204
 * "active development tree" diagnosis, and the consecutive-failure escalation
 * that came across with the reset. `--default-branch` names the branch
 * explicitly when a host wants to override that.
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
 * default branch mid-run. The skip says so loudly and is never silent — and an
 * update that *did* change the checkout names the same variable in this
 * command's message, which both launchers print on stderr (Issue #735).
 *
 * Under `update_mode: "frozen"` (Issue #624, part of #583) that sequence would
 * drag the host to the tip of the default branch and defeat the pin, so the
 * checkout is held at `pinned_ref` instead. This command runs before the
 * launch plan is built — and so before the configuration load — so it reads
 * `update_mode` and `pinned_ref` straight out of `.config.json` under
 * `--base-dir`, which is where that file lives. A `.config.json` that cannot
 * be read or does not mean what it says is a fail-loud non-zero exit rather
 * than a silent fall back to `dynamic`, which would reset a pinned host.
 * `VIBE_SKIP_CHECKOUT_UPDATE` still wins over both modes.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import type { Command, CommandResult, Result, UpdateMode } from "../types.ts";
import {
  SKIP_CHECKOUT_UPDATE_ENV,
  updateCheckout,
} from "../lib/checkout_update.ts";
import { DEFAULT_UPDATE_MODE, UPDATE_MODES } from "../lib/config_defaults.ts";
import { pinValueErrors } from "../lib/config_validator.ts";

// The name lives beside the update it turns off, so the variable this command
// reads and the one an overwrite advertises cannot drift (Issue #735).
export { SKIP_CHECKOUT_UPDATE_ENV };

/** What the command reports back to the launcher. */
export interface WorkerCheckoutUpdateResult {
  /** The checkout the command was pointed at. */
  repoDir: string;
  /** The branch it was updated to, or "" when frozen or skipped. */
  branch: string;
  /** False when `VIBE_SKIP_CHECKOUT_UPDATE` turned the update off. */
  updated: boolean;
  /** The mode the checkout was brought to (Issue #624). */
  mode: UpdateMode;
  /** The pinned ref the checkout is held at; "" outside `frozen` mode. */
  ref: string;
}

/** The update-mode settings this command reads for itself (Issue #624). */
export interface CheckoutUpdateModeSettings {
  /** `dynamic` unless `.config.json` says otherwise. */
  mode: UpdateMode;
  /** The pinned ref under `frozen`; "" under `dynamic`. */
  ref: string;
}

/**
 * Read `update_mode` and `pinned_ref` from `.config.json` under the checkout
 * (Issue #624).
 *
 * A missing file resolves to `dynamic` — a checkout that has not been set up
 * yet behaves exactly as it always did. Everything else that stops the file
 * meaning what it says — unreadable, malformed, an unrecognised mode, a
 * `frozen` host with no usable `pinned_ref` — is a fail-loud error, because
 * quietly resolving to `dynamic` would reset a host that asked to be pinned.
 *
 * @param repoDir - The checkout root, which is where `.config.json` lives
 * @returns The resolved mode and ref, or a fail-loud error naming the field
 */
export async function readCheckoutUpdateMode(
  repoDir: string,
): Promise<Result<CheckoutUpdateModeSettings>> {
  const configPath = `${repoDir}/.config.json`;
  const dynamic: CheckoutUpdateModeSettings = {
    mode: DEFAULT_UPDATE_MODE,
    ref: "",
  };

  let content: string;
  try {
    content = await Deno.readTextFile(configPath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { ok: true, value: dynamic };
    }
    return {
      ok: false,
      error: new Error(
        `cannot read ${configPath} to resolve update_mode: ` +
          (error instanceof Error ? error.message : String(error)),
      ),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return {
      ok: false,
      error: new Error(
        `${configPath} contains invalid JSON, so update_mode cannot be ` +
          `resolved — refusing to update ${repoDir} on a guess`,
      ),
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error: new Error(
        `${configPath} is not a JSON object, so update_mode cannot be ` +
          `resolved — refusing to update ${repoDir} on a guess`,
      ),
    };
  }

  const record = parsed as Record<string, unknown>;
  const rawMode = record["update_mode"];
  if (rawMode === undefined) return { ok: true, value: dynamic };
  if (
    typeof rawMode !== "string" ||
    !(UPDATE_MODES as readonly string[]).includes(rawMode)
  ) {
    return {
      ok: false,
      error: new Error(
        `Invalid update_mode ${JSON.stringify(rawMode)} in ${configPath}. ` +
          `Accepted values: ${UPDATE_MODES.join(", ")}.`,
      ),
    };
  }
  if (rawMode !== "frozen") return { ok: true, value: dynamic };

  const rawRef = record["pinned_ref"];
  if (typeof rawRef !== "string" || rawRef.trim() === "") {
    return {
      ok: false,
      error: new Error(
        `update_mode "frozen" requires pinned_ref in ${configPath} — the ` +
          `commit SHA or tag ${repoDir} is held at`,
      ),
    };
  }
  const ref = rawRef.trim();
  const refErrors = pinValueErrors("pinned_ref", ref);
  if (refErrors.length > 0) {
    return { ok: false, error: new Error(refErrors.join(" ")) };
  }

  return { ok: true, value: { mode: "frozen", ref } };
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
    "Update the worker checkout host-side — origin's default branch, or the pinned ref when frozen (Issues #512, #624)",

  execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult<WorkerCheckoutUpdateResult>> {
    return updateWorkerCheckout(args);
  },
};

/**
 * Bring a checkout to where this host's update mode says it belongs —
 * `origin/<default-branch>` under `dynamic`, `pinned_ref` under `frozen`.
 *
 * Separated from the {@link Command} wrapper so the tests can drive it
 * directly against a temporary repository.
 *
 * @param args - `base-dir` (required), optional `default-branch`, `log-dir`
 * @returns Success with the branch or pinned ref, or a fail-loud message
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
      data: {
        repoDir,
        branch: "",
        updated: false,
        mode: DEFAULT_UPDATE_MODE,
        ref: "",
      },
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

  const settings = await readCheckoutUpdateMode(repoDir);
  if (!settings.ok) {
    return { success: false, message: settings.error.message };
  }

  const outcome = await updateCheckout({
    repoDir,
    logDir: optionalString(args["log-dir"]) ?? defaultLogDir(),
    defaultBranch: optionalString(args["default-branch"]),
    updateMode: settings.value.mode,
    pinnedRef: settings.value.ref,
  });

  const data: WorkerCheckoutUpdateResult = {
    repoDir,
    branch: outcome.branch,
    updated: outcome.ok,
    mode: outcome.mode,
    ref: outcome.ref,
  };

  if (!outcome.ok) {
    return {
      success: false,
      message: outcome.error ?? `cannot update ${repoDir}`,
      data,
    };
  }

  const summary = outcome.mode === "frozen"
    ? `update_mode=frozen: ${repoDir} is held at pinned_ref ${outcome.ref}`
    : `updated ${repoDir} to origin/${outcome.branch}`;

  return {
    success: true,
    // The launchers print this on stderr, so an update that overwrote local
    // work names the opt-out where the operator is already looking (#735).
    message: outcome.overwriteNotice === ""
      ? summary
      : `${summary}. ${outcome.overwriteNotice}`,
    data,
  };
}
