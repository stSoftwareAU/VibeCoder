/**
 * Deno project configuration for the diff-scoped mutation check (Issue #4533):
 * which repo-relative files are Deno tests, and which local module an import
 * specifier names.
 *
 * The mutation check used to decide a test by file name alone (`*_test.ts`,
 * `*.test.ts`) and to find a module's importers by relative specifier alone
 * (`./`, `../`). A repository whose tests sit under `test/**` without a suffix
 * and import through an alias in `imports` was therefore mutated as source and
 * had every mutant reported as untested. This module reads the two fields that
 * decide it from a `deno.json` or `deno.jsonc`:
 *
 * - `test.include` / `test.exclude`, matched against paths relative to the
 *   config's directory, with `*`, `?`, `**` and flat `{a,b}` braces. Negation
 *   (`!`) falls back to the suffix rule, with a warning.
 * - `imports`, kept only where the target is a local `./` or `../` path. A
 *   `jsr:`, `npm:` or remote target names no repository file, so it is dropped.
 *
 * Limits: `importMap` files and `scopes` are not read.
 *
 * The caller reads the file and passes its text in.
 *
 * Australian English spelling used throughout.
 */

import { stripJsonc } from "./jsonc.ts";
import { isDenoTestFile } from "./mutation_gate.ts";

export interface DenoProjectConfig {
  /** `test.include` entries: files, directories or globs, relative to the config's directory. */
  readonly include: readonly string[];
  /** `test.exclude` entries, with the same syntax as `include`. */
  readonly exclude: readonly string[];
  /** `imports` entries whose target is a local `./` or `../` path. */
  readonly imports: ReadonlyMap<string, string>;
}

export const EMPTY_PROJECT_CONFIG: DenoProjectConfig = {
  include: [],
  exclude: [],
  imports: new Map(),
};

/** Brace alternatives expanded per entry; any beyond this are ignored. */
const MAX_BRACE_EXPANSIONS = 64;

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown> | null;
}

function causeOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A `test.include` or `test.exclude` list: absent is empty, otherwise strings. */
function patternList(
  value: unknown,
  field: string,
  source: string,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new Error(`${source}: ${field} must be an array of strings`);
  }
  return value as string[];
}

/** The `imports` entries whose target is a local `./` or `../` path. */
function localImports(value: unknown, source: string): Map<string, string> {
  const out = new Map<string, string>();
  if (value === undefined) return out;
  const entries = asObject(value);
  if (entries === null) {
    throw new Error(`${source}: imports must be an object`);
  }
  for (const [key, target] of Object.entries(entries)) {
    if (typeof target !== "string") {
      throw new Error(`${source}: imports["${key}"] must be a string`);
    }
    if (target.startsWith("./") || target.startsWith("../")) {
      out.set(key, target);
    }
  }
  return out;
}

/**
 * Read the fields the mutation check uses from a `deno.json` / `deno.jsonc`.
 * Empty or whitespace-only text is an empty config. Throws an `Error` naming
 * `source` and the field at fault on invalid JSON, a non-object top level,
 * or a wrongly typed field. Negated patterns fall back to the suffix rule.
 */
export function parseDenoProjectConfig(
  text: string,
  source: string,
): DenoProjectConfig {
  if (text.trim() === "") return EMPTY_PROJECT_CONFIG;
  let data: unknown;
  try {
    data = JSON.parse(stripJsonc(text));
  } catch (err) {
    throw new Error(`${source}: not valid JSON or JSONC: ${causeOf(err)}`);
  }
  const root = asObject(data);
  if (root === null) {
    throw new Error(`${source}: the top level must be a JSON object`);
  }
  let test: Record<string, unknown> = {};
  if (root.test !== undefined) {
    const block = asObject(root.test);
    if (block === null) throw new Error(`${source}: test must be an object`);
    test = block;
  }
  let include = patternList(test.include, "test.include", source);
  let exclude = patternList(test.exclude, "test.exclude", source);
  const imports = localImports(root.imports, source);
  if ([...include, ...exclude].some((entry) => entry.startsWith("!"))) {
    console.warn(
      `${source}: negated test patterns are unsupported; using the test filename suffix rule`,
    );
    include = [];
    exclude = [];
  }
  return { include, exclude, imports };
}

/** Segments of a repo-relative path, dropping empty and `.` parts. */
function segmentsOf(p: string): string[] {
  return p.split("/").filter((s) => s !== "" && s !== ".");
}

/**
 * Lexically normalise a repo-relative path the way the runner's own paths are
 * (empty and `.` parts dropped, `..` pops), except that a `..` climbing above
 * the root yields null rather than being ignored.
 */
function normaliseRelPath(p: string): string | null {
  const out: string[] = [];
  for (const part of segmentsOf(p)) {
    if (part === "..") {
      if (out.pop() === undefined) return null;
    } else out.push(part);
  }
  return out.join("/");
}

/**
 * Expand flat `{a,b}` groups into at most {@link MAX_BRACE_EXPANSIONS}
 * patterns. Depth-first and iterative, so a long run of groups cannot exhaust
 * the call stack.
 */
function expandBraces(pattern: string): string[] {
  const out: string[] = [];
  const pending = [pattern];
  while (pending.length > 0 && out.length < MAX_BRACE_EXPANSIONS) {
    const current = pending.pop() as string;
    const group = /\{([^{}]*)\}/.exec(current);
    if (group === null) {
      out.push(current);
      continue;
    }
    const [whole = "", body = ""] = group;
    const head = current.slice(0, group.index);
    const tail = current.slice(group.index + whole.length);
    const alternatives = body.split(",");
    // Pushed in reverse so the first alternative is expanded first.
    for (let i = alternatives.length - 1; i >= 0; i--) {
      pending.push(`${head}${alternatives[i] ?? ""}${tail}`);
    }
  }
  return out;
}

/**
 * One `include` / `exclude` entry as segment patterns. A leading `./` and a
 * trailing `/` are dropped; an empty result (`.` or `./`) is the whole
 * directory, so `**`. Consecutive `**` collapse, which keeps the DP small.
 */
function compileEntry(entry: string): string[][] {
  let p = entry === "." ? "" : entry;
  while (p.startsWith("./")) p = p.slice(2);
  while (p.endsWith("/")) p = p.slice(0, -1);
  return expandBraces(p === "" ? "**" : p).map((expanded) => {
    const segments: string[] = [];
    for (const seg of segmentsOf(expanded)) {
      if (!(seg === "**" && segments[segments.length - 1] === "**")) {
        segments.push(seg);
      }
    }
    return segments;
  });
}

/**
 * Match one path segment against one pattern segment: `*` for any run of
 * characters, `?` for one character, anything else literal. The classic
 * iterative wildcard match, which backtracks only to the last `*`, so its
 * cost is bounded by the lengths of the two strings.
 */
function segmentMatches(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    const pc = pattern[p];
    if (pc === "*") {
      star = p;
      mark = t;
      p++;
    } else if (pc === "?" || pc === text[t]) {
      p++;
      t++;
    } else if (star !== -1) {
      p = star + 1;
      mark++;
      t = mark;
    } else return false;
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

/**
 * Does the pattern match the path? `**` matches zero or more whole segments.
 * A pattern fully consumed while path segments remain is a match, so a
 * directory entry covers everything beneath it. Decided by a memoised table of
 * (pattern index, path index), filled bottom-up, so a hostile pattern costs
 * O(pattern × path) and cannot recurse deeply.
 */
function matchSegments(
  pattern: readonly string[],
  path: readonly string[],
): boolean {
  const width = path.length + 1;
  // reach[i * width + j]: pattern[i..] matches path[j..].
  const reach = new Uint8Array((pattern.length + 1) * width);
  for (let j = 0; j < width; j++) reach[pattern.length * width + j] = 1;
  for (let i = pattern.length - 1; i >= 0; i--) {
    const seg = pattern[i] as string;
    for (let j = path.length; j >= 0; j--) {
      let ok: boolean;
      if (seg === "**") {
        ok = reach[(i + 1) * width + j] === 1 ||
          (j < path.length && reach[i * width + j + 1] === 1);
      } else {
        ok = j < path.length &&
          segmentMatches(seg, path[j] as string) &&
          reach[(i + 1) * width + j + 1] === 1;
      }
      reach[i * width + j] = ok ? 1 : 0;
    }
  }
  return reach[0] === 1;
}

function matchesAny(
  entries: readonly string[],
  path: readonly string[],
  include = false,
): boolean {
  return entries.some((entry) => {
    if (include && !/[*?{]/.test(entry)) {
      return segmentsOf(entry).join("/") === path.join("/");
    }
    return compileEntry(entry).some((pattern) => matchSegments(pattern, path));
  });
}

/**
 * Is the repo-relative `relToConfigDir` a Deno test? True when the suffix rule
 * (`isDenoTestFile`) says so, which always applies, or when it matches some
 * `include` entry and no `exclude` entry. Entries are relative to the config's
 * directory, so the caller passes the path relative to that directory.
 */
export function isDenoTestPath(
  relToConfigDir: string,
  config: DenoProjectConfig,
): boolean {
  if (isDenoTestFile(relToConfigDir)) return true;
  const path = segmentsOf(relToConfigDir);
  return matchesAny(config.include, path, true) &&
    !matchesAny(config.exclude, path);
}

/**
 * The repo-relative path a bare import specifier resolves to through the
 * config's `imports` map, or null. An exact key wins; otherwise the longest key
 * ending in `/` that prefixes the specifier, whose target must itself end in
 * `/` (as Deno requires). A specifier starting with `.` or `/` is not bare and
 * resolves to nothing, as does a target that climbs above the repository root.
 */
export function resolveImportSpecifier(
  spec: string,
  config: DenoProjectConfig,
  configDir: string,
): string | null {
  if (spec.startsWith(".") || spec.startsWith("/")) return null;
  const exact = config.imports.get(spec);
  if (exact !== undefined) return joinConfigPath(configDir, exact);
  let bestKey: string | undefined;
  for (const key of config.imports.keys()) {
    if (
      key.endsWith("/") && spec.startsWith(key) &&
      (bestKey === undefined || key.length > bestKey.length)
    ) {
      bestKey = key;
    }
  }
  if (bestKey === undefined) return null;
  const target = config.imports.get(bestKey) as string;
  if (!target.endsWith("/")) return null;
  return joinConfigPath(configDir, target + spec.slice(bestKey.length));
}

function joinConfigPath(configDir: string, target: string): string | null {
  return normaliseRelPath(configDir === "" ? target : `${configDir}/${target}`);
}
