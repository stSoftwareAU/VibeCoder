/**
 * Shared parsing for a checked-in GitHub **ruleset** payload (Issue #858).
 *
 * `infra/rulesets/*.json` holds the rulesets this repository expects GitHub to
 * apply — the tag ruleset of Issue #869 and the `main` branch ruleset of Issue
 * #858. Both files are the same API shape, so the validation lives here once:
 * a payload that cannot be fully validated throws an `Error` naming the file
 * and the offending field, never a half-populated object a caller might act
 * on.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

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

/** A repository ruleset payload, in the shape the create/update API accepts. */
export interface RulesetPayload {
  name: string;
  target: string;
  enforcement: string;
  bypass_actors: unknown[];
  conditions: { ref_name: RefNameCondition };
  rules: RulesetRule[];
}

/** Fail loud with a message naming the payload and the offending field. */
function reject(source: string, detail: string): never {
  throw new Error(`${source}: ${detail}`);
}

function assertStringArray(
  source: string,
  value: unknown,
  field: string,
): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    reject(source, `${field} must be an array of strings`);
  }
  return value as string[];
}

/**
 * Parse a ruleset payload, throwing an `Error` naming `source` and the first
 * problem found.
 */
export function parseRulesetPayload(
  text: string,
  source: string,
): RulesetPayload {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    reject(source, `not valid JSON — ${(error as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    reject(source, "payload must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  for (const field of ["name", "target", "enforcement"]) {
    if (typeof obj[field] !== "string") {
      reject(source, `${field} must be a string`);
    }
  }
  if (!Array.isArray(obj.bypass_actors)) {
    reject(source, "bypass_actors must be an array");
  }
  if (!Array.isArray(obj.rules) || obj.rules.length === 0) {
    reject(source, "rules must be a non-empty array");
  }
  const rules = (obj.rules as unknown[]).map((rule) => {
    if (
      typeof rule !== "object" || rule === null ||
      typeof (rule as RulesetRule).type !== "string"
    ) {
      reject(source, "every entry in rules needs a string type");
    }
    return rule as RulesetRule;
  });

  const conditions = obj.conditions as Record<string, unknown> | undefined;
  const refName = conditions?.ref_name as Record<string, unknown> | undefined;
  if (typeof refName !== "object" || refName === null) {
    reject(source, "conditions.ref_name must be an object");
  }
  const include = assertStringArray(
    source,
    refName.include,
    "conditions.ref_name.include",
  );
  const exclude = assertStringArray(
    source,
    refName.exclude,
    "conditions.ref_name.exclude",
  );

  return {
    name: obj.name as string,
    target: obj.target as string,
    enforcement: obj.enforcement as string,
    bypass_actors: obj.bypass_actors as unknown[],
    conditions: { ref_name: { include, exclude } },
    rules,
  };
}

/** The rule types a ruleset carries, in payload order. */
export function ruleTypes(ruleset: RulesetPayload): string[] {
  return ruleset.rules.map((rule) => rule.type);
}
