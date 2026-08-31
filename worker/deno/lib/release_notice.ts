/**
 * The launch-time new-release notice (Issue #690, part of #674).
 *
 * A host pinned to a release older than the newest one has no way of knowing
 * it is behind: the checkout update holds it at its pin, exactly as asked, and
 * says nothing about the world moving on. This module answers one question —
 * *is there anything to tell this host at launch?* — and, when there is,
 * renders the single line that says it:
 *
 * ```text
 * A new release of Vibe Coder is available: 1.0.4 → 1.0.5. Run ./run.sh upgrade to install it.
 * ```
 *
 * Silent by default. A `dynamic` host already installs the latest at every
 * launch, so there is nothing to say; nor is there when the repository has no
 * releases, when the pin is already the newest, or when the pin is a commit
 * SHA that cannot be ordered against a tag (Issue #689).
 *
 * **Notifying only.** Nothing here changes a pin, installs anything or moves a
 * checkout.
 *
 * **Nothing throws.** This runs on the launch path, where a failed check must
 * degrade to a warning rather than an exception, so every fault comes back as
 * a `Result` and every side effect arrives through {@link ReleaseCheckDeps}.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import type { Result, UpdateMode } from "../types.ts";
import {
  compareToPin,
  latestRelease,
  type ReleaseCheckDeps,
} from "./release_check.ts";
import { UPGRADE_INVOCATION } from "./upgrade_command.ts";

/** The update-mode settings the notice is decided from. */
export interface ReleaseNoticeSettings {
  /** This host's `update_mode`; only `frozen` is ever notified. */
  mode: UpdateMode;
  /** The `pinned_ref` under `frozen`; "" under `dynamic`. */
  ref: string;
}

/** Whether this launch has a notice to print, and what it says. */
export type ReleaseNoticeOutcome =
  | {
    notify: true;
    /** The one line to print, exactly as the operator should see it. */
    line: string;
    /** The release this host is pinned to. */
    current: string;
    /** The newest release. */
    latest: string;
  }
  | {
    notify: false;
    /** Why there is nothing to say — for the log, not for the operator. */
    reason: string;
  };

/**
 * Render the notice line for a host behind the newest release.
 *
 * The command it names comes from {@link UPGRADE_INVOCATION}, so the wording
 * and the real command cannot drift apart (Issue #691).
 *
 * @param current - The release this host is pinned to, e.g. `1.0.4`
 * @param latest - The newest release, e.g. `1.0.5`
 * @returns The single line the launcher prints and logs
 */
export function formatReleaseNotice(current: string, latest: string): string {
  return `A new release of Vibe Coder is available: ${current} → ${latest}. ` +
    `Run ${UPGRADE_INVOCATION} to install it.`;
}

/** Nothing to say, and why. */
function silent(reason: string): Result<ReleaseNoticeOutcome> {
  return { ok: true, value: { notify: false, reason } };
}

/**
 * Decide what this launch has to tell the operator about releases.
 *
 * @param settings - This host's `update_mode` and `pinned_ref`
 * @param deps - Injected `gh` and repository resolution (Issue #689)
 * @returns The notice, or a silent outcome naming why there is none; a failed
 *   check is a fail-loud error the caller degrades to a warning
 */
export async function releaseNotice(
  settings: ReleaseNoticeSettings,
  deps: ReleaseCheckDeps,
): Promise<Result<ReleaseNoticeOutcome>> {
  if (settings.mode !== "frozen") {
    return silent(
      `update_mode=${settings.mode}: this host installs the newest release ` +
        `at every launch, so there is nothing to notify about.`,
    );
  }

  const latest = await latestRelease(deps);
  if (!latest.ok) return latest;
  if (latest.value === null) {
    return silent("the repository has no releases yet.");
  }

  const comparison = compareToPin(settings.ref, latest.value.tag);
  if (!comparison.ok) return comparison;
  if (!comparison.value.comparable) return silent(comparison.value.reason);
  if (!comparison.value.newer) {
    return silent(
      `pinned_ref ${comparison.value.current} is the newest release.`,
    );
  }

  const { current, latest: newest } = comparison.value;
  return {
    ok: true,
    value: {
      notify: true,
      line: formatReleaseNotice(current, newest),
      current,
      latest: newest,
    },
  };
}
