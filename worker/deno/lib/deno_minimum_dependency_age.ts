/**
 * Canonical native-Deno minimum-dependency-age policy (Issue #2539).
 *
 * Deno 2.6+ enforces a supply-chain quarantine on JSR/npm dependencies via
 * the `minimumDependencyAge` setting in `deno.json` (and the matching
 * `--minimum-dependency-age` flag on `deno update` / `deno outdated`). This
 * module is the single source of truth for the *Deno* enforcement
 * mechanism: the 24h external floor and the 0h internal-scope exclusion that
 * sub-issues of #2536 reference.
 *
 * Policy numbers are unchanged from the existing 24h-external / 0h-internal
 * rule (renovate.json `minimumReleaseAge`, `VIBE_BUMP_QUARANTINE_HOURS`).
 * `VIBE_BUMP_QUARANTINE_HOURS` still governs npm/cargo/Actions bumps via
 * `bump-deps.sh`; this module covers Deno deps only and does NOT replace or
 * repurpose it.
 *
 * Canonical config shape (object form, per deno's config-file schema):
 *
 *   "minimumDependencyAge": {
 *     "age": "P1D",
 *     "exclude": ["jsr:@stsoftware/*", "npm:@stsoftware/*"]
 *   }
 *
 *   - `age` accepts integer minutes ("1440"), an ISO-8601 duration ("P1D"
 *     = 24h, "PT24H"), an RFC3339 cutoff date/timestamp, or "0" to disable.
 *   - `exclude` is a list of jsr:/npm: package globs exempted from the
 *     floor (0h quarantine). Each entry must start with `jsr:` or `npm:`
 *     to satisfy deno's exclude schema (`^(?:npm:|jsr:).+`).
 *   - The feature is marked "(Unstable)" in deno's config-file schema but
 *     is accepted by `deno check` / `deno outdated` on Deno v2.x with no
 *     `--unstable-*` flag and no `unstable` array entry required (verified
 *     against Deno 2.8.1).
 *
 * Australian English used throughout (behaviour, organisation, etc.).
 */

/** Canonical external floor as an ISO-8601 duration: 24 hours (one day). */
export const CANONICAL_MINIMUM_DEPENDENCY_AGE = "P1D";

/** Hours the canonical external floor maps to. */
export const CANONICAL_MINIMUM_DEPENDENCY_AGE_HOURS = 24;

/**
 * Internal stSoftwareAU Deno deps exempted from the floor (0h quarantine).
 * Mirrors the `stSoftwareAU/*` bypass in `renovate.json`. Each glob carries
 * a `jsr:` or `npm:` prefix to satisfy deno's exclude schema. The repo
 * itself imports only `jsr:@std/*` today, so these entries match nothing
 * yet — they pin the canonical pattern for repos that do have internal
 * Deno deps.
 */
export const INTERNAL_SCOPE_EXCLUDES = [
  "jsr:@stsoftware/*",
  "npm:@stsoftware/*",
] as const;

/** Object form of the `minimumDependencyAge` setting in `deno.json`. */
export interface MinimumDependencyAgeConfig {
  /** Floor expressed as minutes, ISO-8601 duration, RFC3339 date, or "0". */
  age: string;
  /** jsr:/npm: package globs exempted from the floor. */
  exclude: string[];
}

/** Build the canonical `minimumDependencyAge` config object. */
export function buildMinimumDependencyAgeConfig(): MinimumDependencyAgeConfig {
  return {
    age: CANONICAL_MINIMUM_DEPENDENCY_AGE,
    exclude: [...INTERNAL_SCOPE_EXCLUDES],
  };
}

/** True when `entry` is a valid deno exclude glob (jsr:/npm: prefixed). */
export function isValidExcludeEntry(entry: string): boolean {
  return /^(?:npm:|jsr:).+/.test(entry);
}

const ISO_8601_DURATION =
  /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/**
 * Parse a deno `minimumDependencyAge` "age" value into hours.
 *
 * Accepts the duration-style forms deno understands: integer minutes
 * (`"1440"` or the number `1440`) and ISO-8601 durations built from
 * weeks/days/hours/minutes/seconds (`"P1D"`, `"PT24H"`, `"PT30M"`). Returns
 * `null` for unrecognised input and for absolute RFC3339 cutoff dates,
 * which are points in time rather than fixed durations. Calendar durations
 * with years or months (`"P1Y"`, `"P1M"`) are also rejected because they do
 * not map to a fixed number of hours.
 */
export function parseMinimumDependencyAgeHours(
  value: string | number | undefined,
): number | null {
  if (value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value / 60 : null;
  }
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed === "0") return 0;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) / 60; // minutes

  if (trimmed === "P" || trimmed === "PT") return null; // empty durations
  const match = ISO_8601_DURATION.exec(trimmed);
  if (!match) return null;
  const [, w, d, h, m, s] = match;
  const weeks = w ? Number(w) : 0;
  const days = d ? Number(d) : 0;
  const hours = h ? Number(h) : 0;
  const minutes = m ? Number(m) : 0;
  const seconds = s ? Number(s) : 0;
  return weeks * 168 + days * 24 + hours + minutes / 60 + seconds / 3600;
}
