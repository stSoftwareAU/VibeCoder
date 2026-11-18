/**
 * Renovate release-age policy (Issue #5120).
 *
 * Renovate's `minimumReleaseAge` is a duration string or `null`. Its validator
 * rejects any other type (a boolean `false` aborts the run), and the
 * quarantine is only as strong as the shortest age a config can set. This
 * module reads that policy the way Renovate reads it:
 *
 *   - {@link parseRenovateDurationHours} mirrors Renovate's `toMs` exactly
 *     (its lower-case split, its case-sensitive month rewrite and the `ms`
 *     2.1.3 grammar), returning hours.
 *   - {@link isFirstPartyPackagePattern} says whether one `matchPackageNames`
 *     entry can only ever match stSoftwareAU names.
 *   - {@link findReleaseAgeProblems} walks a whole config and reports every
 *     age that lifts the quarantine beyond a first-party exemption.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

/** The 24-hour quarantine floor: the `VIBE_BUMP_QUARANTINE_HOURS` default. */
export const RENOVATE_RELEASE_AGE_FLOOR_HOURS = 24;

// SIMPLE-ON-PURPOSE: a 64-character cap on the trimmed duration, so the parser below never sees a hostile-length string; no real Renovate duration comes close to it — upgrade when Renovate accepts durations longer than 64 characters
const MAX_DURATION_LENGTH = 64;

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const YEAR_MS = 365.25 * DAY_MS;

/**
 * Renovate's `toMs` split: each part runs up to and including a run of
 * lower-case letters. Case-sensitive, as in Renovate, so `"1 D 12 H"` stays
 * one part (which `ms` then refuses).
 */
const TO_MS_SPLIT = /(.*?[a-z]+)/;

/** Renovate's month rewrite (`N months` → `N*30 days`): case-sensitive, integers only. */
const TO_MS_MONTH = /^(\d+)\s*(?:months?|M)$/;

/** The `ms` 2.1.3 grammar Renovate hands every other part to (case-insensitive). */
const MS_GRAMMAR =
  /^(-?(?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?$/i;

/** `ms` 2.1.3 unit lengths, keyed by the lower-cased unit `MS_GRAMMAR` captures. */
const MS_UNIT: ReadonlyMap<string, number> = new Map([
  ["years", YEAR_MS],
  ["year", YEAR_MS],
  ["yrs", YEAR_MS],
  ["yr", YEAR_MS],
  ["y", YEAR_MS],
  ["weeks", WEEK_MS],
  ["week", WEEK_MS],
  ["w", WEEK_MS],
  ["days", DAY_MS],
  ["day", DAY_MS],
  ["d", DAY_MS],
  ["hours", HOUR_MS],
  ["hour", HOUR_MS],
  ["hrs", HOUR_MS],
  ["hr", HOUR_MS],
  ["h", HOUR_MS],
  ["minutes", MINUTE_MS],
  ["minute", MINUTE_MS],
  ["mins", MINUTE_MS],
  ["min", MINUTE_MS],
  ["m", MINUTE_MS],
  ["seconds", SECOND_MS],
  ["second", SECOND_MS],
  ["secs", SECOND_MS],
  ["sec", SECOND_MS],
  ["s", SECOND_MS],
  ["milliseconds", 1],
  ["millisecond", 1],
  ["msecs", 1],
  ["msec", 1],
  ["ms", 1],
]);

/** `ms` 2.1.3 `parse`: milliseconds for one part, or null when it does not match. */
function msParse(part: string): number | null {
  const match = MS_GRAMMAR.exec(part);
  if (match === null) return null;
  // MS_GRAMMAR captures only MS_UNIT keys, so the lookup always succeeds.
  const factor = MS_UNIT.get((match[2] ?? "ms").toLowerCase())!;
  return parseFloat(match[1]!) * factor;
}

/** Renovate's `matchPackageNames` regex prefixes that can only match stSoftwareAU names. */
const FIRST_PARTY_REGEX_PREFIXES = [
  "^stsoftwareau\\/",
  "^stsoftwareau/",
  "^@stsoftware\\/",
  "^@stsoftware/",
];

/** Characters that make the character before them optional or repeated. */
const QUANTIFIER_CHARS: ReadonlySet<string> = new Set(["?", "*", "+", "{"]);

/** Exact-name and glob prefixes that can only match stSoftwareAU names. */
const FIRST_PARTY_NAME_PREFIXES = ["stsoftwareau/", "@stsoftware/"];

const PACKAGE_RULE_PATH = /^packageRules\[\d+\]$/;

/**
 * Legacy package-name matchers Renovate's migration folds into
 * `matchPackageNames`, so each one widens what an exemption covers. A lifting
 * rule carrying any of them is refused rather than translated.
 */
export const MERGED_PACKAGE_NAME_KEYS = [
  "matchPackagePrefixes",
  "packagePatterns",
  "packageNames",
] as const;

/**
 * Parse a Renovate duration string (`"24 hours"`, `"2d"`, `"1 day 12 hours"`,
 * `"0"`) into hours, or return null when Renovate would not read it as a
 * duration. Trims first; returns null for empty input or input longer than
 * {@link MAX_DURATION_LENGTH}.
 */
export function parseRenovateDurationHours(value: string): number | null {
  const text = value.trim();
  if (text === "" || text.length > MAX_DURATION_LENGTH) return null;
  const parts = text.split(TO_MS_SPLIT)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  let totalMs = 0;
  for (const part of parts) {
    const month = TO_MS_MONTH.exec(part);
    const ms = month === null ? msParse(part) : Number(month[1]) * 30 * DAY_MS; // Renovate rewrites it to `N*30 days`.
    if (ms === null) return null;
    totalMs += ms;
  }
  return totalMs / HOUR_MS;
}

/**
 * True only when a Renovate `matchPackageNames` entry can match nothing but
 * stSoftwareAU names. A leading `!` (negation) is never first-party. A regex
 * `/body/flags` (flags `i` or none) must anchor its body on the org prefix,
 * with the next character after the prefix not a quantifier (`?`, `*`, `+`,
 * `{`, which would make the slash optional or repeated, so `\/?evil` matches
 * `stSoftwareAUevil`), and carry no alternation. An exact name or glob must
 * start with the org prefix.
 */
export function isFirstPartyPackagePattern(pattern: string): boolean {
  if (pattern.startsWith("!")) return false;
  const close = pattern.lastIndexOf("/");
  const isRegex = pattern.startsWith("/") && close > 0 &&
    /^i?$/.test(pattern.slice(close + 1));
  if (isRegex) {
    const body = pattern.slice(1, close).toLowerCase();
    return !body.includes("|") &&
      FIRST_PARTY_REGEX_PREFIXES.some((prefix) =>
        body.startsWith(prefix) &&
        !QUANTIFIER_CHARS.has(body.charAt(prefix.length))
      );
  }
  const lower = pattern.toLowerCase();
  return FIRST_PARTY_NAME_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Every release-age problem in a Renovate config, as human messages. Walks all
 * objects and arrays; each object holding a `minimumReleaseAge` key is checked
 * at its path (`""` is the top level, `packageRules[0]`, `github-actions`, ...).
 *
 * - Any value that is neither a string nor null is refused by type, at the
 *   top level too (path `top-level`).
 * - The top level then reports only an unreadable or sub-floor string: a
 *   missing, null or blank age is the gate's own finding (Issue #4192).
 * - An unparseable string is refused as not a duration, wherever it sits
 *   except `vulnerabilityAlerts`, which keeps Renovate's own treatment and so
 *   gets the type check only.
 * - A `packageRules` entry that sets null or a sub-floor age is an exemption,
 *   and must be scoped to first-party names only.
 * - Any other category that sets null or a sub-floor age lifts the quarantine
 *   for everything it covers, so it is refused.
 */
export function findReleaseAgeProblems(
  config: Record<string, unknown>,
): string[] {
  const problems: string[] = [];
  visitReleaseAge(config, "", problems);
  return problems;
}

function visitReleaseAge(
  node: unknown,
  path: string,
  problems: string[],
): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => visitReleaseAge(item, `${path}[${i}]`, problems));
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const record = node as Record<string, unknown>;
  if (Object.hasOwn(record, "stabilityDays")) {
    problems.push(
      `${
        path || "top-level"
      }.stabilityDays is a deprecated alias for minimumReleaseAge; remove it and use a validated minimumReleaseAge instead`,
    );
  }
  if (PACKAGE_RULE_PATH.test(path) && Object.hasOwn(record, "packageRules")) {
    problems.push(
      `${path}.packageRules nests package rules; Renovate merges parent age and child package names, which can widen a first-party exemption — flatten the rules explicitly`,
    );
  }
  if (Object.hasOwn(record, "minimumReleaseAge")) {
    checkReleaseAge(record, path, problems);
  }
  for (const [key, value] of Object.entries(record)) {
    visitReleaseAge(value, path === "" ? key : `${path}.${key}`, problems);
  }
}

function checkReleaseAge(
  node: Record<string, unknown>,
  path: string,
  problems: string[],
): void {
  const value = node["minimumReleaseAge"];
  const floor = RENOVATE_RELEASE_AGE_FLOOR_HOURS;
  if (value !== null && typeof value !== "string") {
    const label = path === "" ? "top-level" : path;
    problems.push(
      `${label}.minimumReleaseAge is a ${typeof value}; Renovate accepts only a duration string or null, so its validator rejects the config and the repository run aborts — spell a first-party exemption as null, never false`,
    );
    return;
  }
  if (path === "") {
    // A missing, null or blank top-level age is the gate's own finding.
    if (typeof value !== "string" || value.trim() === "") return;
    const hours = parseRenovateDurationHours(value);
    if (hours === null) {
      problems.push(
        `top-level minimumReleaseAge "${value}" is not a duration Renovate reads`,
      );
    } else if (hours < floor) {
      problems.push(
        `top-level minimumReleaseAge "${value}" is below the ${floor}-hour quarantine floor`,
      );
    }
    return;
  }
  if (path === "vulnerabilityAlerts") return;
  const hours = typeof value === "string"
    ? parseRenovateDurationHours(value)
    : null;
  if (typeof value === "string" && hours === null) {
    problems.push(
      `${path}.minimumReleaseAge "${value}" is not a duration Renovate reads`,
    );
    return;
  }
  const lifts = value === null || (hours !== null && hours < floor);
  if (PACKAGE_RULE_PATH.test(path)) {
    if (lifts && !isScopedToFirstParty(node)) {
      problems.push(
        `${path} lifts the release-age quarantine (minimumReleaseAge ${
          JSON.stringify(value)
        }) for packages that are not first-party stSoftwareAU — list only first-party names in matchPackageNames (or matchPackagePatterns), and drop matchPackagePrefixes, packagePatterns and packageNames, which Renovate merges into matchPackageNames`,
      );
    }
    return;
  }
  if (lifts) {
    problems.push(
      `${path}.minimumReleaseAge ${
        JSON.stringify(value)
      } lifts the quarantine for a whole category; a first-party exemption belongs in a packageRules entry scoped to first-party names`,
    );
  }
}

/**
 * A packageRules entry is first-party only when its `matchPackageNames` and
 * legacy `matchPackagePatterns` (bare regexes, read as `/${p}/`) together form
 * a non-empty list in which every entry is a first-party pattern, and it
 * carries none of {@link MERGED_PACKAGE_NAME_KEYS}.
 */
export function isScopedToFirstParty(rule: Record<string, unknown>): boolean {
  if (MERGED_PACKAGE_NAME_KEYS.some((key) => Object.hasOwn(rule, key))) {
    return false;
  }
  const names = listOrNull(rule["matchPackageNames"]);
  const patterns = listOrNull(rule["matchPackagePatterns"]);
  if (names === null || patterns === null) return false;
  const entries = [
    ...names,
    ...patterns.map((p) => typeof p === "string" ? `/${p}/` : p),
  ];
  return entries.length > 0 &&
    entries.every((entry) =>
      typeof entry === "string" && isFirstPartyPackagePattern(entry)
    );
}

/** An absent key is an empty list; a present key must be an array. */
function listOrNull(value: unknown): unknown[] | null {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : null;
}
