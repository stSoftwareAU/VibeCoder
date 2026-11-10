/**
 * `.config.json` surface for the TokenEconomizer block (Issue #4955, part of
 * #4953).
 *
 * One block, `token_economizer`, carries four keys:
 *
 * - `enabled` — whether the plugin is switched on for this host; off by
 *   default, so a host that never mentions the block is unchanged;
 * - `learnings_repo` — the private `owner/name` repository that holds the
 *   learnings; required when `enabled` is true;
 * - `microskills` — the micro-skills mechanism: `off`, `envfacts`,
 *   `distiller` or `envfacts+distiller` (default `envfacts+distiller`);
 * - `loopguard` — the loop-guard mechanism: `off` or `nudge` (default
 *   `nudge`).
 *
 * The block is accepted and validated, but not read yet: #4956 will wire it
 * into runs; today a run is the same whatever it is set to.
 *
 * ## Validation posture — fail loud
 *
 * A switch that changes how a run is staffed must never be half-understood:
 * reading a malformed block as the default would leave an operator who wrote
 * `token_economizer` with a setting that looks live and does nothing. So,
 * matching `lib/rtk_output_config.ts`, {@link parseTokenEconomizer} returns the
 * fault as an error naming the offending key and the config load throws it.
 *
 * An **unknown key inside** the block changes no behaviour, so it is reported
 * by `lib/config_unknown_keys.ts` as a warning, the way an unknown key inside
 * `rtk_output` is.
 *
 * Australian English spelling used throughout (behaviour, recognised).
 */

import type {
  Result,
  TokenEconomizerConfig,
  TokenEconomizerLoopguard,
  TokenEconomizerMicroskills,
} from "../types.ts";
import { OPERATIONAL_DEFAULTS } from "./config_defaults.ts";

/** Recognised keys inside the `token_economizer` block. */
export const TOKEN_ECONOMIZER_KEYS: ReadonlySet<string> = new Set([
  "enabled",
  "learnings_repo",
  "microskills",
  "loopguard",
]);

/** The values the `microskills` key accepts. */
export const TOKEN_ECONOMIZER_MICROSKILLS:
  readonly TokenEconomizerMicroskills[] = [
    "off",
    "envfacts",
    "distiller",
    "envfacts+distiller",
  ];

/** The values the `loopguard` key accepts. */
export const TOKEN_ECONOMIZER_LOOPGUARD: readonly TokenEconomizerLoopguard[] = [
  "off",
  "nudge",
];

/** A GitHub owner is at most 39 characters. */
const OWNER_MAX_LENGTH = 39;
/** A repository name is at most 100 characters. */
const NAME_MAX_LENGTH = 100;
/** One character an owner may carry: letters, digits and hyphens. */
const OWNER_CHAR = /[A-Za-z0-9-]/;
/** One character a repository name may carry: letters, digits, dots, underscores and hyphens. */
const NAME_CHAR = /[A-Za-z0-9._-]/;
/** Longest value echoed back in an error; anything longer is named by type. */
const ECHO_MAX_LENGTH = 40;

/**
 * The TokenEconomizer block as an unconfigured host reads it.
 *
 * The values live in `OPERATIONAL_DEFAULTS` — the one place config defaults are
 * written — and a fresh object is returned each call so no caller can mutate
 * the shared default. The block is accepted and validated, but not read yet:
 * #4956 will wire it into runs; today a run is the same whatever it is set to.
 */
export function defaultTokenEconomizer(): TokenEconomizerConfig {
  return {
    enabled: OPERATIONAL_DEFAULTS.tokenEconomizer.enabled,
    learningsRepo: OPERATIONAL_DEFAULTS.tokenEconomizer.learningsRepo,
    microskills: OPERATIONAL_DEFAULTS.tokenEconomizer.microskills,
    loopguard: OPERATIONAL_DEFAULTS.tokenEconomizer.loopguard,
  };
}

/**
 * Parse the raw `token_economizer` block from `.config.json`. Accepted and
 * validated, but not read yet: #4956 will wire it into runs; today a run is the
 * same whatever it is set to.
 *
 * @param raw - The block as it appeared in the file, or `undefined`.
 * @returns The parsed block, or the first fault naming the offending key.
 */
export function parseTokenEconomizer(
  raw: unknown,
): Result<TokenEconomizerConfig, string> {
  // Only an **absent** key means "this host said nothing". An explicit `null`
  // is a written-out block, so it is refused like any other malformed one.
  if (raw === undefined) return { ok: true, value: defaultTokenEconomizer() };

  if (!isPlainObject(raw)) {
    return {
      ok: false,
      error: `token_economizer must be an object carrying the keys ` +
        `${[...TOKEN_ECONOMIZER_KEYS].join(", ")} (token_economizer.enabled ` +
        `and the rest), got ${describe(raw)}.`,
    };
  }

  const defaults = defaultTokenEconomizer();

  const enabled = raw.enabled === undefined ? defaults.enabled : raw.enabled;
  if (typeof enabled !== "boolean") {
    return {
      ok: false,
      error: `token_economizer.enabled must be a boolean, got ${
        describe(enabled)
      }.`,
    };
  }

  let learningsRepo: string | undefined;
  if (raw.learnings_repo !== undefined) {
    const repo = raw.learnings_repo;
    if (typeof repo !== "string") {
      return {
        ok: false,
        error: `token_economizer.learnings_repo must be an "owner/name" ` +
          `string, got ${describe(repo)}.`,
      };
    }
    if (!isRepoSlug(repo)) {
      return {
        ok: false,
        error: `token_economizer.learnings_repo must be an "owner/name" ` +
          `repository: an owner of up to ${OWNER_MAX_LENGTH} letters, digits ` +
          `and hyphens with no leading or trailing hyphen, one slash, then a ` +
          `name of up to ${NAME_MAX_LENGTH} letters, digits, dots, ` +
          `underscores and hyphens, not "." or "..". No URL, no extra slash.`,
      };
    }
    learningsRepo = repo;
  }

  if (enabled && learningsRepo === undefined) {
    return {
      ok: false,
      error: `token_economizer.learnings_repo is required when ` +
        `token_economizer.enabled is true: name the private owner/name ` +
        `repository that holds the learnings.`,
    };
  }

  const microskills = choiceOf(
    raw.microskills,
    TOKEN_ECONOMIZER_MICROSKILLS,
    defaults.microskills,
    "token_economizer.microskills",
  );
  if (!microskills.ok) return microskills;

  const loopguard = choiceOf(
    raw.loopguard,
    TOKEN_ECONOMIZER_LOOPGUARD,
    defaults.loopguard,
    "token_economizer.loopguard",
  );
  if (!loopguard.ok) return loopguard;

  return {
    ok: true,
    value: {
      enabled,
      learningsRepo,
      microskills: microskills.value,
      loopguard: loopguard.value,
    },
  };
}

/**
 * Whether `text` is an `owner/name` repository: exactly one slash, an owner
 * within GitHub's owner rules and a name within the repository-name rules.
 * Plain length and character checks, so a long input is refused by its length
 * before any character is read.
 */
function isRepoSlug(text: string): boolean {
  const parts = text.split("/");
  if (parts.length !== 2) return false;
  const owner = parts[0] ?? "";
  const name = parts[1] ?? "";
  return isOwner(owner) && isName(name);
}

/** Whether `text` is a GitHub owner: 1 to 39 characters, no leading or trailing hyphen. */
function isOwner(text: string): boolean {
  if (text.length < 1 || text.length > OWNER_MAX_LENGTH) return false;
  if (text.startsWith("-") || text.endsWith("-")) return false;
  return allCharsIn(text, OWNER_CHAR);
}

/** Whether `text` is a repository name: 1 to 100 characters, and neither "." nor "..". */
function isName(text: string): boolean {
  if (text.length < 1 || text.length > NAME_MAX_LENGTH) return false;
  if (text === "." || text === "..") return false;
  return allCharsIn(text, NAME_CHAR);
}

/** Whether every character of `text` matches `allowed`. */
function allCharsIn(text: string, allowed: RegExp): boolean {
  for (const ch of text) {
    if (!allowed.test(ch)) return false;
  }
  return true;
}

/**
 * Validate one choice-valued key. An absent key takes its default; any value
 * outside `allowed` (including `null`, a non-string or a near miss) is refused,
 * with the allowed values named in the error.
 */
function choiceOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  key: string,
): Result<T, string> {
  if (value === undefined) return { ok: true, value: fallback };
  const found = allowed.find((candidate) => candidate === value);
  if (found !== undefined) return { ok: true, value: found };
  const listed = allowed.map((candidate) => `"${candidate}"`).join(", ");
  return {
    ok: false,
    error: `${key} must be one of ${listed}, got ${describeValue(value)}.`,
  };
}

/** Whether a value is a plain (non-array, non-null) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Name a rejected value's JSON type, distinguishing null and array. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Like {@link describe}, but a short string is shown in full, so the operator sees the typo. */
function describeValue(value: unknown): string {
  if (typeof value === "string" && value.length <= ECHO_MAX_LENGTH) {
    return JSON.stringify(value);
  }
  return describe(value);
}
