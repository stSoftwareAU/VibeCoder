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
 * and `.git` are always out of scope, as in deno. `.` segments are dropped, so
 * an entry of `.` or `./` names the whole config directory, as deno reads it.
 * An `include` list holding an entry this module cannot compile (empty,
 * oversized, an unbalanced brace, or a `..` segment it cannot resolve) is
 * ignored, leaving the file in scope.
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

/**
 * Normalise a config entry to a config-relative path pattern: empty and `.`
 * segments are dropped, so `.`, `./` and `./src/./lib` read as deno reads
 * them, and `""` (after a non-empty entry) means the whole config directory.
 * Null for an empty entry and for one with a `..` segment, which would reach
 * outside the directory this matcher works in.
 */
function normaliseEntry(entry: string): string | null {
  if (entry === "") return null;
  const segments = entry.split("/").filter((seg) => seg !== "" && seg !== ".");
  if (segments.includes("..")) return null;
  return segments.join("/");
}

/** Normalise a changed file's path to a config-relative path. */
function normalisePattern(entry: string): string {
  return entry.replace(/^(?:\.\/)+/, "").replace(/^\/+/, "").replace(
    /\/+$/,
    "",
  );
}

const MAX_BRACE_ALTERNATIVES = 64;

/**
 * Expand `{a,b}` groups (nesting allowed) into plain wildcard patterns; null
 * on an unbalanced brace or more than {@link MAX_BRACE_ALTERNATIVES} results.
 */
function expandBraces(pattern: string): string[] | null {
  const open = pattern.indexOf("{");
  if (open === -1) return [pattern];
  let depth = 0;
  let close = -1;
  const cuts: number[] = [];
  for (let i = open; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    } else if (ch === "," && depth === 1) cuts.push(i);
  }
  if (close === -1) return null;
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  const bounds = [open, ...cuts, close];
  const out: string[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const alt = pattern.slice((bounds[i] as number) + 1, bounds[i + 1]);
    const expanded = expandBraces(`${head}${alt}${tail}`);
    if (expanded === null) return null;
    out.push(...expanded);
    if (out.length > MAX_BRACE_ALTERNATIVES) return null;
  }
  return out;
}

/** Match `text` against a `*` / `?` wildcard pattern in O(pattern × text). */
function wildcardMatch(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let starP = -1;
  let starT = 0;
  while (t < text.length) {
    const pc = pattern[p];
    if (pc === "*") {
      starP = p++;
      starT = t;
    } else if (pc === "?" || (pc !== undefined && pc === text[t])) {
      p++;
      t++;
    } else if (starP !== -1) {
      p = starP + 1;
      t = ++starT;
    } else {
      return false;
    }
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

type Segment = string[] | "**";

/**
 * Compile one path/glob entry into a matcher over `/`-separated paths; null
 * when it is empty, oversized, malformed or reaches outside the config
 * directory. A `**` segment matches any number
 * of path segments, matched by a memoised walk so a hostile pattern costs
 * O(pattern segments × path segments), never exponential time.
 */
function compile(entry: string): ((path: string) => boolean) | null {
  const pattern = normaliseEntry(entry);
  if (pattern === null || pattern.length > MAX_PATTERN_LENGTH) return null;
  // The config directory itself: every path under it.
  if (pattern === "") return () => true;
  const segments: Segment[] = [];
  for (const raw of pattern.split("/")) {
    if (raw === "**") {
      if (segments[segments.length - 1] !== "**") segments.push("**");
      continue;
    }
    const alternatives = expandBraces(raw);
    if (alternatives === null) return null;
    segments.push(alternatives);
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
        result = part !== undefined &&
          seg.some((alt) => wildcardMatch(alt, part)) && walk(si + 1, pi + 1);
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
