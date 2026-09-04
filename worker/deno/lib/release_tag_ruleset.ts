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
  const include = assertStringArray(
    refName.include,
    "conditions.ref_name.include",
  );
  const exclude = assertStringArray(
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

/** Repository root, resolved from this module's location. */
function repoRoot(): string {
  return decodeURIComponent(new URL("../../../", import.meta.url).pathname);
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

/** A single token in a compiled ref pattern. */
type RefToken =
  | { kind: "globstar" } // `**` — any run of characters including `/`
  | { kind: "star" } // `*`  — any run of characters except `/`
  | { kind: "any" } // `?`  — a single character except `/`
  | { kind: "class"; negated: boolean; body: string } // `[0-9]`, `[!a-z]`
  | { kind: "lit"; ch: string };

/** Whether `ch` falls inside a `[...]` class body such as `0-9abc`. */
function classMatches(body: string, negated: boolean, ch: string): boolean {
  let hit = false;
  for (let i = 0; i < body.length; i++) {
    const from = body[i] as string;
    if (body[i + 1] === "-" && i + 2 < body.length) {
      const to = body[i + 2] as string;
      if (ch >= from && ch <= to) hit = true;
      i += 2;
    } else if (ch === from) {
      hit = true;
    }
  }
  return negated ? !hit : hit;
}

/**
 * Tokenise a GitHub ruleset ref pattern.
 *
 * Ref-name conditions are matched with fnmatch, so `*` spans one path segment,
 * `**` spans separators too, `?` is a single character and `[...]` is a
 * character class (`[!...]` negates). An unclosed `[` is a literal bracket.
 *
 * This is deliberately not `branchPatternMatches()` from
 * `workflow_branch_glob.ts`: that matcher answers for GitHub Actions branch
 * filters and has no character class, which every include pattern here uses.
 */
function tokeniseRefPattern(pattern: string): RefToken[] {
  const tokens: RefToken[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        tokens.push({ kind: "globstar" });
        i++;
      } else {
        tokens.push({ kind: "star" });
      }
    } else if (ch === "?") {
      tokens.push({ kind: "any" });
    } else if (ch === "[" && pattern.indexOf("]", i + 1) > i + 1) {
      const close = pattern.indexOf("]", i + 1);
      const body = pattern.slice(i + 1, close);
      tokens.push({
        kind: "class",
        negated: body.startsWith("!"),
        body: body.startsWith("!") ? body.slice(1) : body,
      });
      i = close;
    } else {
      tokens.push({ kind: "lit", ch });
    }
  }
  return tokens;
}

/**
 * Match one ruleset ref pattern against a full ref such as
 * `refs/tags/1.0.49`.
 *
 * Matching never builds a `RegExp` from the pattern — a memo over
 * `(tokenIndex, refIndex)` keeps it linear-ish and leaves no
 * catastrophic-backtrack surface, the same choice `workflow_branch_glob.ts`
 * made for the branch-filter matcher.
 */
export function refPatternMatches(pattern: string, ref: string): boolean {
  const tokens = tokeniseRefPattern(pattern);
  const failed = new Set<number>();
  const stride = ref.length + 1;

  const match = (ti: number, ri: number): boolean => {
    if (ti === tokens.length) return ri === ref.length;
    const key = ti * stride + ri;
    if (failed.has(key)) return false;

    const token = tokens[ti] as RefToken;
    let ok = false;
    switch (token.kind) {
      case "lit":
        ok = ref[ri] === token.ch && match(ti + 1, ri + 1);
        break;
      case "any":
        ok = ri < ref.length && ref[ri] !== "/" && match(ti + 1, ri + 1);
        break;
      case "class":
        ok = ri < ref.length && ref[ri] !== "/" &&
          classMatches(token.body, token.negated, ref[ri] as string) &&
          match(ti + 1, ri + 1);
        break;
      case "star":
        for (let k = ri;; k++) {
          if (match(ti + 1, k)) {
            ok = true;
            break;
          }
          if (k >= ref.length || ref[k] === "/") break;
        }
        break;
      case "globstar":
        for (let k = ri; k <= ref.length; k++) {
          if (match(ti + 1, k)) {
            ok = true;
            break;
          }
        }
        break;
    }
    if (!ok) failed.add(key);
    return ok;
  };

  return match(0, 0);
}

/** Whether `ref` (a full ref such as `refs/tags/1.0.49`) is covered. */
export function refIsProtected(ruleset: TagRuleset, ref: string): boolean {
  const { include, exclude } = ruleset.conditions.ref_name;
  const matches = (pattern: string) => refPatternMatches(pattern, ref);
  return include.some(matches) && !exclude.some(matches);
}
