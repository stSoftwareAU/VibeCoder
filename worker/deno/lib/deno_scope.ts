/**
 * Which files a repo's own `deno fmt --check` / `deno lint` would check
 * (PR #3584 review).
 *
 * Explicit CLI paths replace a config's `fmt.include` / `lint.include` — only
 * `exclude` still applies — so the pre-push gate (`pre_push_gate.ts`) must
 * drop out-of-scope files itself rather than hand them to deno, or it would
 * refuse a push over formatting the repo's CI never enforces.
 *
 * Supported: `include` / `exclude` entries as file paths, directory paths
 * (with or without a trailing `/`) and globs (`*`, `**`, `?`, `{a,b}`), and
 * `!`-negated `exclude` entries (the last matching entry wins). `node_modules`
 * and `.git` are always out of scope, as in deno. An `include` list holding an
 * entry this module cannot compile (empty, oversized or an unbalanced brace)
 * is ignored, leaving the file in scope.
 *
 * Australian English spelling throughout.
 */

import { stripJsonc } from "./jsonc.ts";

/** One tool's (`fmt` or `lint`) include/exclude lists. */
export interface DenoToolScope {
  include?: string[];
  exclude?: string[];
}

/** The scope-relevant slice of a `deno.json` / `deno.jsonc`. */
export interface DenoScopeConfig {
  exclude?: string[];
  fmt?: DenoToolScope;
  lint?: DenoToolScope;
}

export type DenoScopeTool = "fmt" | "lint";

const MAX_PATTERN_LENGTH = 256;

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === "string");
}

function toolScope(value: unknown): DenoToolScope | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  return { include: stringList(raw.include), exclude: stringList(raw.exclude) };
}

/**
 * Read the scope slice out of a deno.json(c) document. Returns null when the
 * text does not parse, so the caller can stay unfiltered (deno itself will
 * then report the broken config) rather than guess a scope.
 */
export function parseDenoScope(text: string): DenoScopeConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(text));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const raw = parsed as Record<string, unknown>;
  return {
    exclude: stringList(raw.exclude),
    fmt: toolScope(raw.fmt),
    lint: toolScope(raw.lint),
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+^$()|\\[\]{}]/g, "\\$&");
}

/** Normalise a config entry to a repo-config-relative path pattern. */
function normalisePattern(entry: string): string {
  return entry.replace(/^(?:\.\/)+/, "").replace(/^\/+/, "").replace(
    /\/+$/,
    "",
  );
}

/** Compile one glob segment (no `/`); null on an unbalanced brace. */
function compileSegment(segment: string): RegExp | null {
  let out = "";
  let braceDepth = 0;
  for (const ch of segment) {
    if (ch === "*") {
      // Runs of `*` collapse, so adjacent stars add no backtracking.
      if (!out.endsWith("[^/]*")) out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "{") {
      braceDepth++;
      out += "(?:";
    } else if (ch === "}" && braceDepth > 0) {
      braceDepth--;
      out += ")";
    } else if (ch === "," && braceDepth > 0) {
      out += "|";
    } else {
      out += escapeRegExp(ch);
    }
  }
  return braceDepth === 0 ? new RegExp(`^${out}$`) : null;
}

type Segment = RegExp | "**";

/**
 * Compile one path/glob entry into a matcher over `/`-separated paths; null
 * when it is empty, oversized or malformed. A `**` segment matches any number
 * of path segments, matched by a memoised walk so a hostile pattern costs
 * O(pattern segments × path segments), never exponential time.
 */
function compile(entry: string): ((path: string) => boolean) | null {
  const pattern = normalisePattern(entry);
  if (pattern === "" || pattern.length > MAX_PATTERN_LENGTH) return null;
  const segments: Segment[] = [];
  for (const raw of pattern.split("/")) {
    if (raw === "**") {
      if (segments[segments.length - 1] !== "**") segments.push("**");
      continue;
    }
    const re = compileSegment(raw);
    if (re === null) return null;
    segments.push(re);
  }
  return (path) => {
    const parts = path.split("/");
    const memo = new Map<number, boolean>();
    const walk = (si: number, pi: number): boolean => {
      const key = si * (parts.length + 1) + pi;
      const cached = memo.get(key);
      if (cached !== undefined) return cached;
      let result: boolean;
      const seg = segments[si];
      if (seg === undefined) {
        result = pi === parts.length;
      } else if (seg === "**") {
        result = walk(si + 1, pi) || (pi < parts.length && walk(si, pi + 1));
      } else {
        const part = parts[pi];
        result = part !== undefined && seg.test(part) && walk(si + 1, pi + 1);
      }
      memo.set(key, result);
      return result;
    };
    return walk(0, 0);
  };
}

/** The path itself and each ancestor directory, shortest first. */
function pathAndAncestors(path: string): string[] {
  const parts = path.split("/");
  const out: string[] = [];
  for (let i = 1; i <= parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

/** Whether `path` or any directory above it matches the entry. */
function matchesEntry(path: string, entry: string): boolean {
  const matches = compile(entry);
  if (matches === null) return false;
  return pathAndAncestors(path).some(matches);
}

/** Last matching entry wins; a `!` entry re-includes. */
function excluded(path: string, entries: readonly string[] | undefined) {
  let result = false;
  for (const entry of entries ?? []) {
    if (entry.startsWith("!")) {
      if (matchesEntry(path, entry.slice(1))) result = false;
    } else if (matchesEntry(path, entry)) {
      result = true;
    }
  }
  return result;
}

/**
 * Whether the repo's own `deno <tool>` run, at the config's directory, would
 * check `relPath` (a `/`-separated path relative to that directory).
 */
export function inDenoScope(
  relPath: string,
  config: DenoScopeConfig,
  tool: DenoScopeTool,
): boolean {
  const path = normalisePattern(relPath);
  if (
    pathAndAncestors(path).some((p) => /(^|\/)(node_modules|\.git)$/.test(p))
  ) {
    return false;
  }
  const scope = config[tool];
  const includes = scope?.include;
  // An include we cannot compile is not guessed at: the file stays in scope
  // and deno itself judges it, so a push is never waved through on a guess.
  if (
    includes !== undefined && includes.length > 0 &&
    includes.every((entry) => compile(entry) !== null) &&
    !includes.some((entry) => matchesEntry(path, entry))
  ) {
    return false;
  }
  return !excluded(path, config.exclude) && !excluded(path, scope?.exclude);
}
