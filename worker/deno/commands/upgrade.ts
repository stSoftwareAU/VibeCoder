/**
 * upgrade command (Issue #691, part of #674).
 *
 * One command that moves this host onto the latest release: it rewrites
 * `pinned_ref` and all three `pinned_tool_versions` in `.config.json`, and
 * nothing else. The next launch installs exactly what the pins name — this
 * command installs nothing, touches no checkout and starts no container.
 *
 * Usage:
 *   ./run.sh upgrade
 *   deno run --allow-env --allow-read --allow-write --allow-run \
 *     mod.ts upgrade --base-dir /path/to/checkout
 *
 * `./run.sh upgrade` is the operator-facing spelling and keeps no upgrade
 * logic of its own — the same shell-delegates-to-Deno split
 * `worker-checkout-update` uses (Issue #512).
 *
 * What one successful run does, in a single atomic write through the setup
 * writer (`setup/config_writer.ts`):
 *
 * 1. Resolve the newest release (Issue #689).
 * 2. Read the tool versions that release recorded in its manifest (#688).
 * 3. Set `pinned_ref` to the release tag and all three tool versions to the
 *    ones it records, validating the result through `config_validator.ts` —
 *    the very validator config load uses — *before* writing, so an invalid
 *    pin never reaches the file.
 *
 * **All-or-nothing.** A release minted before Issue #688 carries no manifest,
 * and a fresh `pinned_ref` beside stale tool versions is exactly the partial
 * pin `pinned_tool_versions` is all-or-nothing to prevent: that is a fail-loud
 * refusal naming the release, with nothing written. So is a resolution or
 * network failure — `.config.json` is left byte-identical either way.
 *
 * **Dynamic hosts have nothing to pin.** `update_mode: "dynamic"` already
 * installs the latest at every launch, so the command says so and exits 0
 * without touching the config.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type {
  Command,
  CommandResult,
  PinnedToolVersions,
  UpdateMode,
} from "../types.ts";
import { DEFAULT_UPDATE_MODE, PINNED_TOOLS } from "../lib/config_defaults.ts";
import { validateUpdateModeSettings } from "../lib/config_validator.ts";
import {
  compareToPin,
  createDefaultReleaseCheckDeps,
  latestRelease,
  type ReleaseCheckDeps,
  releaseToolVersions,
} from "../lib/release_check.ts";
import { RELEASE_MANIFEST_ASSET } from "../lib/release_manifest.ts";
import {
  readUpdateModeSettings,
  writeUpdateModeConfig,
} from "../setup/config_writer.ts";

/**
 * The command's registered name.
 *
 * Exported so anything that *names* the upgrade to an operator — the
 * new-release notice on the launch path (Issue #690) — can assert against the
 * real command rather than repeating a string that can drift.
 */
export const UPGRADE_COMMAND_NAME = "upgrade";

/** How an operator invokes it: the launcher spelling of the same command. */
export const UPGRADE_COMMAND = `./run.sh ${UPGRADE_COMMAND_NAME}`;

/** What the command reports back about the host it was pointed at. */
export interface UpgradeOutcome {
  /** The `.config.json` the command read, and wrote when it changed. */
  configPath: string;
  /** The host's update mode; nothing is pinned outside `frozen`. */
  mode: UpdateMode;
  /** True only when `.config.json` was rewritten. */
  changed: boolean;
  /** The `pinned_ref` before the upgrade; "" when the host had none. */
  previousRef: string;
  /** The `pinned_ref` after it — unchanged when nothing was written. */
  ref: string;
  /** The `pinned_tool_versions` before the upgrade. */
  previousTools: PinnedToolVersions;
  /** The `pinned_tool_versions` after it. */
  tools: PinnedToolVersions;
}

/** A trimmed non-empty string argument, or undefined. */
function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** The label column width, so every old → new line lines up. */
const LABEL_WIDTH = "pinned_tool_versions.claude".length;

/** One `field old → new` line, naming an absent old value rather than eliding it. */
function changeLine(field: string, before: string, after: string): string {
  return `  ${field.padEnd(LABEL_WIDTH)}  ${before || "(unset)"} → ${after}`;
}

/**
 * Move this host's pins onto the newest release.
 *
 * Separated from the {@link Command} wrapper so the tests can drive it against
 * a temporary `.config.json` with injected release-check deps.
 *
 * @param args - `base-dir` (required): the checkout whose `.config.json` is pinned
 * @param deps - Release resolution; the real `gh`/`git` deps when omitted
 * @returns Success with what changed, or a fail-loud message with nothing written
 */
export async function runUpgrade(
  args: Record<string, unknown>,
  deps?: ReleaseCheckDeps,
): Promise<CommandResult<UpgradeOutcome>> {
  const baseDir = optionalString(args["base-dir"]);
  if (!baseDir) {
    return {
      success: false,
      message:
        `${UPGRADE_COMMAND_NAME} requires --base-dir <checkout> — the Vibe ` +
        `Coder checkout whose .config.json carries the pins`,
    };
  }

  const configPath = `${baseDir}/.config.json`;
  try {
    await Deno.stat(configPath);
  } catch {
    return {
      success: false,
      message: `${configPath} does not exist, so there are no pins to move — ` +
        `run ./setup.sh on this host first.`,
    };
  }

  const settings = await readUpdateModeSettings(configPath);
  if (!settings.ok) return { success: false, message: settings.error.message };

  const mode = settings.value.update_mode ?? DEFAULT_UPDATE_MODE;
  const previousRef = settings.value.pinned_ref ?? "";
  const previousTools = settings.value.pinned_tool_versions ?? {};
  const unchanged: UpgradeOutcome = {
    configPath,
    mode,
    changed: false,
    previousRef,
    ref: previousRef,
    previousTools,
    tools: previousTools,
  };

  /** Fail loud, having written nothing. */
  const refuse = (reason: string): CommandResult<UpgradeOutcome> => ({
    success: false,
    message: reason,
    data: unchanged,
  });

  if (mode !== "frozen") {
    return {
      success: true,
      message:
        `update_mode is "${mode}": this host already tracks the latest Vibe ` +
        `Coder at every launch — the checkout and all three tools — so there ` +
        `is nothing to pin. update_mode in ${configPath} decides this; set ` +
        `it to "frozen" (./setup.sh) to pin this host to a release.`,
      data: unchanged,
    };
  }

  const check = deps ?? createDefaultReleaseCheckDeps(baseDir);

  const release = await latestRelease(check);
  if (!release.ok) {
    return refuse(
      `Cannot resolve the newest release, so nothing was pinned and ` +
        `${configPath} is unchanged: ${release.error.message}`,
    );
  }
  if (release.value === null) {
    return refuse(
      `No MAJOR.MINOR.PATCH release exists to upgrade to, so ${configPath} ` +
        `is unchanged.`,
    );
  }
  const latest = release.value.tag;

  // Why the pin could not be ordered against the release, when it could not:
  // an explicit upgrade still moves such a host, but never silently.
  let note = "";
  if (previousRef !== "") {
    const comparison = compareToPin(previousRef, latest);
    if (!comparison.ok) {
      return refuse(
        `Cannot compare this host's pin against release ${latest}, so ` +
          `${configPath} is unchanged: ${comparison.error.message}`,
      );
    }
    if (comparison.value.comparable) {
      if (!comparison.value.newer) {
        return {
          success: true,
          message:
            `Vibe Coder is already up to date (${comparison.value.current}).`,
          data: unchanged,
        };
      }
    } else {
      note = comparison.value.reason;
    }
  }

  const lookup = await releaseToolVersions(latest, check);
  if (!lookup.ok) {
    return refuse(
      `Cannot read the tool versions release ${latest} ships with, so ` +
        `nothing was pinned and ${configPath} is unchanged: ` +
        lookup.error.message,
    );
  }
  if (lookup.value.kind === "no-manifest") {
    return refuse(
      `${lookup.value.reason} Moving pinned_ref to ${latest} without the ` +
        `versions it ships with would leave this host partially pinned, so ` +
        `nothing was written and ${configPath} is unchanged. Pin an earlier ` +
        `release that carries ${RELEASE_MANIFEST_ASSET}, or cut a new one.`,
    );
  }
  const tools: PinnedToolVersions = { ...lookup.value.tools };

  // The validator config load itself runs, applied before the write: an
  // invalid pin must never reach the file.
  const errors = validateUpdateModeSettings({
    updateMode: "frozen",
    pinnedRef: latest,
    pinnedToolVersions: tools,
  });
  if (errors.length > 0) {
    return refuse(
      `Refusing to write ${configPath}: the pins release ${latest} records ` +
        `do not validate — ${errors.join(" ")}`,
    );
  }

  const written = await writeUpdateModeConfig(configPath, {
    update_mode: "frozen",
    pinned_ref: latest,
    pinned_tool_versions: tools,
  });
  if (!written.ok) return refuse(written.error.message);

  const outcome: UpgradeOutcome = {
    configPath,
    mode: "frozen",
    changed: written.value,
    previousRef,
    ref: latest,
    previousTools,
    tools,
  };

  if (!written.value) {
    return {
      success: true,
      message: `${configPath} already pins release ${latest} and the ` +
        `versions it records — left untouched.`,
      data: outcome,
    };
  }

  const lines = [
    `Upgrading Vibe Coder: ${previousRef || "(unset)"} → ${latest}.`,
    ...(note === "" ? [] : [`  ${note}`]),
    changeLine("pinned_ref", previousRef, latest),
    ...PINNED_TOOLS.map((tool) =>
      changeLine(
        `pinned_tool_versions.${tool}`,
        previousTools[tool] ?? "",
        tools[tool] ?? "",
      )
    ),
    `Written to ${configPath} — the next launch installs exactly these ` +
    `versions.`,
  ];

  return { success: true, message: lines.join("\n"), data: outcome };
}

/** The registered command (Issue #691). */
export const upgradeCommand: Command = {
  name: UPGRADE_COMMAND_NAME,
  description:
    "Move pinned_ref and all three pinned_tool_versions to the latest " +
    "release, in one write to .config.json (Issue #691)",

  execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult<UpgradeOutcome>> {
    return runUpgrade(args);
  },
};
