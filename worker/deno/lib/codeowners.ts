/**
 * Minimal CODEOWNERS parser and owner resolver (Issue #2606).
 *
 * Lets a test pin that the committed `.github/CODEOWNERS` gives every
 * privileged path (workflows, actions, CI scripts, rulesets) a human owner,
 * so the ruleset's `require_code_owner_review` enforces something real.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** One CODEOWNERS line: a path pattern and the owners it names. */
export interface CodeownersRule {
  pattern: string;
  owners: string[];
  /** 1-based source line, for error messages. */
  line: number;
}

// `@user`, `@org/team`, or an email address — the three owner forms GitHub accepts.
const OWNER_RE =
  /^(@[A-Za-z0-9][A-Za-z0-9-]*(\/[A-Za-z0-9._-]+)?|[^@\s]+@[^@\s]+\.[^@\s]+)$/;

/**
 * Parse CODEOWNERS text into rules, in file order.
 * Throws on a malformed owner token rather than silently dropping it.
 */
export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  text.split("\n").forEach((raw, index) => {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (line === "") return;
    const [pattern = "", ...owners] = line.split(/\s+/);
    for (const owner of owners) {
      if (!OWNER_RE.test(owner)) {
        throw new Error(
          `CODEOWNERS line ${index + 1}: invalid owner "${owner}"`,
        );
      }
    }
    rules.push({ pattern, owners, line: index + 1 });
  });
  return rules;
}

// SIMPLE-ON-PURPOSE: supports `*`, `**`, `?`, anchoring and trailing-slash directories, not `[...]` classes or `\` escapes — upgrade when CODEOWNERS needs either.
/** Match one path segment against a glob segment (`*` and `?` never cross `/`). */
function segmentMatches(glob: string, text: string): boolean {
  if (glob === "") return text === "";
  const [head, rest] = [glob[0], glob.slice(1)];
  if (head === "*") {
    for (let i = 0; i <= text.length; i++) {
      if (segmentMatches(rest, text.slice(i))) return true;
    }
    return false;
  }
  if (text === "") return false;
  return (head === "?" || head === text[0]) &&
    segmentMatches(rest, text.slice(1));
}

/**
 * Match glob segments against a path prefix. A `**` segment spans zero or
 * more path segments; once the glob is exhausted, any remaining path is
 * beneath a matched directory and is covered by it.
 */
function segmentsMatch(glob: string[], path: string[]): boolean {
  const [head, ...rest] = glob;
  if (head === undefined) return true;
  if (head === "**") {
    for (let i = 0; i <= path.length; i++) {
      if (segmentsMatch(rest, path.slice(i))) return true;
    }
    return false;
  }
  const [first, ...remaining] = path;
  return first !== undefined && segmentMatches(head, first) &&
    segmentsMatch(rest, remaining);
}

/** Whether a CODEOWNERS pattern covers a repo-relative path (gitignore rules). */
function patternMatches(pattern: string, target: string): boolean {
  // gitignore rule: a leading or middle slash anchors the pattern to the root.
  const anchored = pattern.startsWith("/") ||
    pattern.slice(0, -1).includes("/");
  const glob = pattern.replace(/^\//, "").replace(/\/$/, "").split("/");
  const path = target.split("/");
  if (anchored) return segmentsMatch(glob, path);
  // An unanchored pattern may start at any depth.
  return path.some((_, i) => segmentsMatch(glob, path.slice(i)));
}

/**
 * Owners for a repo-relative path — the last matching rule wins, as on
 * GitHub. Returns `[]` when no rule matches or the winning rule has no owners.
 */
export function ownersForPath(rules: CodeownersRule[], path: string): string[] {
  const target = path.replace(/^\//, "");
  const rule = rules.findLast((r) => patternMatches(r.pattern, target));
  return rule?.owners ?? [];
}
