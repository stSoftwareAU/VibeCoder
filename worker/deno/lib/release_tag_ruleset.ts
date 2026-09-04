/**
 * The release-tag ruleset payload, read and checked (Issue #869).
 *
 * `infra/rulesets/release-tags.json` is the source of truth for the GitHub tag
 * ruleset applied to this repository: it refuses deletion and any re-pointing
 * of an existing release tag while leaving tag *creation* alone, so
 * `release-tag.yml` keeps minting the next patch and a hand-minted `1.1.0`
 * still succeeds (Issue #808).
 *
 * This module exists so the payload is checked by tests rather than by
 * eyeballing JSON: {@link parseTagRuleset} rejects a malformed payload loudly,
 * and {@link refIsProtected} answers whether a given ref is covered by
 * evaluating the ruleset's own fnmatch conditions — the question that matters
 * is "is `refs/tags/1.0.49` protected", not "does the file contain a glob".
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

/** Path of the checked-in payload, relative to the repository root. */
export const RELEASE_TAG_RULESET_PATH = "infra/rulesets/release-tags.json";

/** One rule inside a ruleset — `{"type": "deletion"}` and friends. */
export interface RulesetRule {
  type: string;
  parameters?: Record<string, unknown>;
}

/** The ref-name condition selecting which refs a ruleset covers. */
export interface RefNameCondition {
  include: string[];
  exclude: string[];
}

/** A repository ruleset payload, in the shape the create API accepts. */
export interface TagRuleset {
  name: string;
  target: string;
  enforcement: string;
  bypass_actors: unknown[];
  conditions: { ref_name: RefNameCondition };
  rules: RulesetRule[];
}

/** Fail loud with a message naming the payload and the offending field. */
function reject(detail: string): never {
  throw new Error(`${RELEASE_TAG_RULESET_PATH}: ${detail}`);
}

function assertStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    reject(`${field} must be an array of strings`);
  }
  return value as string[];
}

/**
 * Parse a ruleset payload, throwing an `Error` naming the first problem.
 *
 * Nothing here is best-effort: a payload that cannot be fully validated is an
 * exception, never a partially-populated object a caller might act on.
 */
export function parseTagRuleset(text: string): TagRuleset {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    reject(`not valid JSON — ${(error as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    reject("payload must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  for (const field of ["name", "target", "enforcement"]) {
    if (typeof obj[field] !== "string") reject(`${field} must be a string`);
  }
  if (!Array.isArray(obj.bypass_actors)) {
    reject("bypass_actors must be an array");
  }
  if (!Array.isArray(obj.rules) || obj.rules.length === 0) {
    reject("rules must be a non-empty array");
  }
  const rules = (obj.rules as unknown[]).map((rule) => {
    if (
      typeof rule !== "object" || rule === null ||
      typeof (rule as RulesetRule).type !== "string"
    ) {
      reject("every entry in rules needs a string type");
    }
    return rule as RulesetRule;
  });

  const conditions = obj.conditions as Record<string, unknown> | undefined;
  const refName = conditions?.ref_name as Record<string, unknown> | undefined;
  if (typeof refName !== "object" || refName === null) {
    reject("conditions.ref_name must be an object");
  }
  const include = assertStringArray(refName.include, "conditions.ref_name.include");
  const exclude = assertStringArray(refName.exclude, "conditions.ref_name.exclude");

  return {
    name: obj.name as string,
    target: obj.target as string,
    enforcement: obj.enforcement as string,
    bypass_actors: obj.bypass_actors as unknown[],
    conditions: { ref_name: { include, exclude } },
    rules,
  };
}

/** Repository root, resolved from this module's location. */
function repoRoot(): string {
  return new URL("../../../", import.meta.url).pathname;
}

/** Read and validate the checked-in payload. Throws if it is missing or bad. */
export async function loadReleaseTagRuleset(
  root: string = repoRoot(),
): Promise<TagRuleset> {
  const path = `${root.replace(/\/$/, "")}/${RELEASE_TAG_RULESET_PATH}`;
  return parseTagRuleset(await Deno.readTextFile(path));
}

/** The rule types a ruleset carries, in payload order. */
export function ruleTypes(ruleset: TagRuleset): string[] {
  return ruleset.rules.map((rule) => rule.type);
}

/**
 * Translate one GitHub ruleset ref pattern into a regular expression.
 *
 * GitHub matches ref-name conditions with fnmatch: `*` spans one path segment,
 * `**` spans separators too, `?` is a single character and `[...]` is a
 * character class (`[!...]` negates).
 */
export function refPatternToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*";
        i++;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) {
        source += "\\[";
      } else {
        const body = pattern.slice(i + 1, close).replace(/\\/g, "\\\\");
        source += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
        i = close;
      }
    } else {
      source += char.replace(/[.+^${}()|\\]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

/** Whether `ref` (a full ref such as `refs/tags/1.0.49`) is covered. */
export function refIsProtected(ruleset: TagRuleset, ref: string): boolean {
  const { include, exclude } = ruleset.conditions.ref_name;
  const matches = (pattern: string) => refPatternToRegExp(pattern).test(ref);
  return include.some(matches) && !exclude.some(matches);
}
