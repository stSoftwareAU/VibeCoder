/**
 * Version-pin vetting shared by the bump-diff scanners (stSoftwareAU/NEAT-AI-scorer#627).
 *
 * Split out of `bump_diff_scan.ts` so the per-ecosystem scanners
 * (`bump_diff_cargo.ts` and the JS shapes that stayed in the original
 * module) can share one definition of "names a single release" without
 * importing each other.
 *
 * Pure — no I/O, no clock.
 *
 * Australian English used throughout (behaviour, organisation, etc.).
 */

/**
 * Range prefixes that still pin a concrete floor version whose release
 * age is meaningful. `>`/`>=`/`*`/`x`/`latest` are deliberately absent:
 * they name no release, so they are refused rather than guessed at.
 */
const PINNING_RANGE_PREFIX_RE = /^[\^~=v]+/;

/** A concrete release version, e.g. `1.9.9`, `18`, `2.0.0-rc.1`. */
const CONCRETE_VERSION_RE = /^\d+(?:\.\d+)*(?:[-+][A-Za-z0-9.-]+)?$/;

/** A registry alias prefix on a lockfile version (`chalk@npm:5.6.2`). */
const ALIAS_PREFIX_RE = /^(?:npm|jsr):/;

/**
 * A value that is trying to be a version range — used to decide whether
 * an unpinnable manifest value is a dependency worth refusing or
 * ordinary metadata (`"license": "MIT"`) worth ignoring.
 */
export const RANGE_LOOKING_RE = /^[\s~^>=<]*[\dxX*]|^(?:latest|next)$/;

/** Longest added-line excerpt quoted back in a refusal message. */
export const MAX_QUOTED_LINE = 200;

/**
 * Reduce a version specification to the exact release whose age can be
 * checked, or `null` when it names no single release.
 *
 * `^1.9.9`/`~1.9.9`/`=1.9.9`/`v1.9.9` pin a floor inside a bounded range
 * and normalise to `1.9.9`. `>=1.0.0`, `*`, `1.x` and `latest` are
 * open-ended — they name whatever the registry serves at install time,
 * which is exactly the evasion the embargo exists to stop — so they
 * return `null` and the caller refuses them.
 */
export function pinnedVersion(raw: string): string | null {
  const trimmed = raw.trim().replace(ALIAS_PREFIX_RE, "");
  if (trimmed.length === 0) return null;
  const stripped = trimmed.replace(PINNING_RANGE_PREFIX_RE, "");
  return CONCRETE_VERSION_RE.test(stripped) ? stripped : null;
}

/** Trim and truncate an added line for quoting in a message. */
export function quoteLine(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > MAX_QUOTED_LINE
    ? `${trimmed.slice(0, MAX_QUOTED_LINE)}…`
    : trimmed;
}
