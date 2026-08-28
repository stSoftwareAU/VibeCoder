/**
 * Deterministic merge-conflict rules for native manifests (Issue #464, #456).
 *
 * Registers two rules against the seam in `dependency_conflict_rules.ts`,
 * completing the ecosystem coverage the parent issue asks for:
 *
 * - **`Cargo.toml`** — conflicts inside `[dependencies]`, `[dev-dependencies]`,
 *   `[build-dependencies]` and their `[target.*.dependencies]` variants, in
 *   both the short form (`serde = "1.0.195"`) and the inline-table form
 *   (`serde = { version = "1.0.195", features = [...] }`). Only the `version`
 *   field is compared: a conflict that also changes `features`,
 *   `default-features`, `path` or `git` is a policy change, not a bump, and
 *   defers.
 * - **`go.mod`** — conflicts on `require` lines, both the single-line and the
 *   parenthesised-block form. Go versions carry a mandatory leading `v`;
 *   `+incompatible` and pseudo-versions (`v0.0.0-20230101120000-abcdef123456`)
 *   are undecidable, because timestamp-ordered pseudo-versions are not
 *   comparable by the semver rule.
 *
 * Like the JSON rules, both work **per dependency key** rather than per hunk:
 * for a key present on both sides with different versions the higher semver
 * wins, whichever branch carries it, and a key only one side has is kept. That
 * is an ordinary both-sides-survive merge, not a side-pick.
 *
 * Everything else defers to the AI fallback, all-or-nothing: a hunk touching a
 * non-dependency line (a `[features]` block, a `go` directive, a `replace`
 * directive, a table header), a single undecidable version, or a change to any
 * field other than the version. One undecidable hunk defers the whole file, so
 * a resolved file can never carry conflict markers into the pushed tree.
 *
 * **Formatting is preserved.** The winning side's original line is emitted with
 * its own indentation, spacing and terminator rather than re-serialising the
 * document — these are hand-maintained files and a re-serialisation would turn
 * a one-line resolution into a whole-file diff.
 *
 * The module is pure — no git, no network, no file I/O.
 */

import {
  compareDependencySpecifiers,
  type ConflictSegment,
  type ConflictSide,
  type ManifestRule,
  type ManifestRuleRegistry,
  manifestRuleRegistry,
  renderConflictSegments,
  type RuleOutcome,
} from "./dependency_conflict_rules.ts";

// ---------------------------------------------------------------------------
// Shared entry model
// ---------------------------------------------------------------------------

/** One dependency line of a manifest, kept verbatim. */
interface NativeEntry {
  /** The dependency name — the crate name, or the Go module path. */
  key: string;
  /** The line without its terminator, emitted verbatim when this side wins. */
  core: string;
  /** The line's own terminator: `\n`, `\r\n`, or empty at end of file. */
  terminator: string;
  /** The version token compared against the other side. */
  version: string;
  /**
   * Everything about the entry other than its version, normalised.
   *
   * Two sides whose shapes differ are a policy change (a new `features` list, a
   * dropped `// indirect` marker), not a version bump, so they defer.
   */
  shape: string;
}

/** The comparator's decision for one pair of versions. */
type VersionOutcome =
  | { kind: "higher"; side: ConflictSide }
  | { kind: "undecidable"; reason: string };

/** Merge outcome for a single hunk. */
type MergeOutcome =
  | { kind: "merged"; entries: NativeEntry[] }
  | { kind: "undecidable"; reason: string };

/** Split text into lines, each keeping its own trailing newline. */
function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

/** Strip a line's terminator, returning the content and the terminator. */
function splitTerminator(line: string): [string, string] {
  const match = line.match(/\r?\n$/);
  const terminator = match?.[0] ?? "";
  return [line.slice(0, line.length - terminator.length), terminator];
}

/** Collapse runs of whitespace so cosmetic spacing is not a shape change. */
function normaliseSpacing(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Merge two ordered entry lists, taking the higher version per shared key.
 *
 * Keys unique to a side are kept in place, so a dependency the other branch
 * added is never silently dropped. Keys shared but reordered between the sides
 * are undecidable — reordering is not a version bump.
 */
function mergeEntries(
  ours: readonly NativeEntry[],
  theirs: readonly NativeEntry[],
  compare: (ours: string, theirs: string) => VersionOutcome,
): MergeOutcome {
  const oursIndex = new Map(ours.map((entry, index) => [entry.key, index]));
  const merged: NativeEntry[] = [];
  let consumed = 0;

  for (const entry of theirs) {
    const index = oursIndex.get(entry.key);
    if (index === undefined) {
      merged.push(entry);
      continue;
    }
    if (index < consumed) {
      return {
        kind: "undecidable",
        reason:
          `dependency keys are reordered between the sides ("${entry.key}")`,
      };
    }
    while (consumed < index) merged.push(ours[consumed++]!);

    const ourEntry = ours[consumed++]!;
    if (ourEntry.shape !== entry.shape) {
      return {
        kind: "undecidable",
        reason: `"${entry.key}" changes more than the version`,
      };
    }
    if (ourEntry.version === entry.version) {
      merged.push(ourEntry);
      continue;
    }
    const verdict = compare(ourEntry.version, entry.version);
    if (verdict.kind === "undecidable") {
      return {
        kind: "undecidable",
        reason: `"${entry.key}": ${verdict.reason}`,
      };
    }
    merged.push(verdict.side === "ours" ? ourEntry : entry);
  }

  while (consumed < ours.length) merged.push(ours[consumed++]!);
  return { kind: "merged", entries: merged };
}

/** Render merged entries, each line keeping its own text and terminator. */
function renderEntries(entries: readonly NativeEntry[]): string {
  const fallbackEol = entries.find((e) => e.terminator !== "")?.terminator ??
    "\n";
  return entries
    .map((entry, index) =>
      entry.core +
      (index === entries.length - 1
        ? entry.terminator
        : entry.terminator || fallbackEol)
    )
    .join("");
}

// ---------------------------------------------------------------------------
// Dialect seam
// ---------------------------------------------------------------------------

/**
 * The per-format behaviour the shared resolver needs.
 *
 * `Ctx` is the dialect's mutable scanner state: it is fed every byte the
 * resolver emits — literal text and resolved hunks alike — so the position of
 * each hunk is known without re-parsing the document.
 */
interface NativeDialect<Ctx> {
  readonly name: string;
  readonly basenames: readonly string[];
  /** What this dialect's resolvable lines are called, for a defer reason. */
  readonly entryNoun: string;
  /** Fresh scanner state for one file. */
  createContext(): Ctx;
  /** Advance the scanner over emitted text. */
  feed(context: Ctx, text: string): void;
  /** Whether the current position is a region this rule may resolve. */
  isDependencyRegion(context: Ctx): boolean;
  /** Human-readable current position, for an `unresolved` reason. */
  describe(context: Ctx): string;
  /** Parse one side of a hunk, or null when it is not entries alone. */
  parseEntries(context: Ctx, side: string): NativeEntry[] | null;
  /** Decide which version is later. */
  compare(ours: string, theirs: string): VersionOutcome;
  /** Optional whole-file guard, returning a defer reason. */
  guard?(text: string): string | null;
}

function resolveSegments<Ctx>(
  dialect: NativeDialect<Ctx>,
  segments: readonly ConflictSegment[],
): RuleOutcome {
  const defer = (reason: string): RuleOutcome => ({
    kind: "unresolved",
    reason: `${dialect.name}: ${reason}`,
  });

  const guardReason = dialect.guard?.(renderConflictSegments(segments));
  if (guardReason) return defer(guardReason);

  const context = dialect.createContext();
  let out = "";
  let hunkNumber = 0;

  for (const segment of segments) {
    if (segment.kind === "literal") {
      out += segment.text;
      dialect.feed(context, segment.text);
      continue;
    }

    hunkNumber++;
    if (!dialect.isDependencyRegion(context)) {
      return defer(
        `hunk ${hunkNumber} is ${dialect.describe(context)}`,
      );
    }

    const ours = dialect.parseEntries(context, segment.ours);
    const theirs = dialect.parseEntries(context, segment.theirs);
    if (!ours || !theirs) {
      return defer(
        `hunk ${hunkNumber} touches more than ${dialect.entryNoun} entries`,
      );
    }

    const merged = mergeEntries(ours, theirs, dialect.compare);
    if (merged.kind === "undecidable") {
      return defer(`hunk ${hunkNumber} — ${merged.reason}`);
    }

    const text = renderEntries(merged.entries);
    out += text;
    dialect.feed(context, text);
  }

  return { kind: "resolved", text: out };
}

/** The final path component, for both `/` and `\` separated paths. */
function basename(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

function createRule<Ctx>(dialect: NativeDialect<Ctx>): ManifestRule {
  return {
    name: dialect.name,
    matches: (path) => dialect.basenames.includes(basename(path)),
    resolve: (segments) => resolveSegments(dialect, segments),
  };
}

// ---------------------------------------------------------------------------
// Cargo.toml
// ---------------------------------------------------------------------------

/** Scanner state for `Cargo.toml`: the table header currently in force. */
interface CargoContext {
  /** The dotted header text, or null before the first header. */
  header: string | null;
  /** A partial trailing line, awaiting the rest of its text. */
  pending: string;
}

/** A table header line, with an optional trailing comment. */
const CARGO_HEADER = /^[ \t]*(\[\[?)([^\]]+)\]\]?[ \t]*(#.*)?$/;

/** A `key = value` line; the value is classified separately. */
const CARGO_ENTRY =
  /^[ \t]*((?:"(?:[^"\\]|\\.)*")|[A-Za-z0-9_+.-]+)[ \t]*=[ \t]*(.+?)[ \t]*(\r?\n?)$/;

/** A quoted version string, the only value shape worth comparing. */
const CARGO_VERSION_STRING = /^"([^"\\]*)"$/;

/** The dependency tables this rule may resolve, keyed on the final segment. */
const CARGO_DEPENDENCY_TABLES: readonly string[] = [
  "dependencies",
  "dev-dependencies",
  "build-dependencies",
];

/**
 * Split a dotted TOML key path, honouring quoted segments.
 *
 * `target.'cfg(unix)'.dependencies` is three segments, not five: the `.` inside
 * the quoted `cfg(unix)` predicate is part of that segment's text.
 */
function splitTomlKey(header: string): string[] | null {
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (const char of header) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ".") {
      segments.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (quote) return null;
  segments.push(current.trim());
  return segments;
}

/** Whether a header names a dependency table this rule may resolve. */
function isCargoDependencyTable(header: string | null): boolean {
  if (header === null) return false;
  const segments = splitTomlKey(header);
  if (!segments) return false;
  const last = segments.at(-1) ?? "";
  if (!CARGO_DEPENDENCY_TABLES.includes(last)) return false;
  return segments.length === 1 ||
    (segments.length === 3 && segments[0] === "target");
}

/** Split an inline table body on its top-level commas. */
function splitInlineFields(body: string): string[] | null {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (const char of body) {
    if (quote) {
      current += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "[" || char === "{") depth++;
    if (char === "]" || char === "}") {
      depth--;
      if (depth < 0) return null;
    }
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (quote || depth !== 0) return null;
  if (current.trim() !== "") parts.push(current);
  return parts;
}

/** Parse an inline table body into its fields, or null when malformed. */
function parseInlineTable(body: string): Map<string, string> | null {
  const parts = splitInlineFields(body);
  if (!parts) return null;

  const fields = new Map<string, string>();
  for (const part of parts) {
    const match = part.match(
      /^[ \t]*((?:"(?:[^"\\]|\\.)*")|[A-Za-z0-9_+.-]+)[ \t]*=[ \t]*(.+?)[ \t]*$/,
    );
    if (!match) return null;
    const key = match[1]!;
    if (fields.has(key)) return null;
    fields.set(key, normaliseSpacing(match[2]!));
  }
  return fields;
}

/** Classify a dependency value into its version and its remaining shape. */
function parseCargoValue(
  raw: string,
): { version: string; shape: string } | null {
  const short = raw.match(CARGO_VERSION_STRING);
  if (short) return { version: short[1]!, shape: "short" };

  if (!raw.startsWith("{") || !raw.endsWith("}")) return null;
  const fields = parseInlineTable(raw.slice(1, -1));
  if (!fields) return null;

  const version = fields.get("version")?.match(CARGO_VERSION_STRING);
  if (!version) return null;

  const others = [...fields]
    .filter(([key]) => key !== "version")
    .map(([key, value]) => `${key}=${value}`)
    .sort();
  return { version: version[1]!, shape: `table{${others.join(",")}}` };
}

const cargoDialect: NativeDialect<CargoContext> = {
  name: "Cargo.toml",
  basenames: ["Cargo.toml"],
  entryNoun: "dependency",

  createContext: () => ({ header: null, pending: "" }),

  feed(context, text) {
    const lines = splitLines(context.pending + text);
    context.pending = "";
    for (const line of lines) {
      const [content, terminator] = splitTerminator(line);
      if (terminator === "") {
        context.pending = content;
        continue;
      }
      const match = content.match(CARGO_HEADER);
      if (!match) continue;
      // An array-of-tables header (`[[bin]]`) is never a dependency table.
      context.header = match[1] === "[[" ? null : match[2]!.trim();
    }
  },

  isDependencyRegion: (context) => isCargoDependencyTable(context.header),

  describe: (context) =>
    context.header === null
      ? "not inside a dependency table (no table header yet)"
      : `not inside a dependency table ([${context.header}])`,

  parseEntries(_context, side) {
    const entries: NativeEntry[] = [];
    const seen = new Set<string>();

    for (const line of splitLines(side)) {
      const match = line.match(CARGO_ENTRY);
      if (!match) return null;
      const value = parseCargoValue(match[2]!);
      if (!value) return null;

      const key = match[1]!;
      if (seen.has(key)) return null;
      seen.add(key);

      const terminator = match[3] ?? "";
      entries.push({
        key,
        core: line.slice(0, line.length - terminator.length),
        terminator,
        version: value.version,
        shape: value.shape,
      });
    }

    return entries.length > 0 ? entries : null;
  },

  compare(ours, theirs) {
    const verdict = compareDependencySpecifiers(ours, theirs);
    return verdict.kind === "higher"
      ? { kind: "higher", side: verdict.side }
      : { kind: "undecidable", reason: verdict.reason };
  },

  guard(text) {
    // The header scanner reads line by line, so a `"""` or `'''` block could
    // hide a line that looks like a table header. Defer rather than guess.
    return /"""|'''/.test(text)
      ? "the file contains a multi-line string, which the table scanner does not follow"
      : null;
  },
};

// ---------------------------------------------------------------------------
// go.mod
// ---------------------------------------------------------------------------

/** Scanner state for `go.mod`: the parenthesised block currently open. */
interface GoModContext {
  /** The open block's directive (`require`, `replace`, …), or null. */
  block: string | null;
  /** A partial trailing line, awaiting the rest of its text. */
  pending: string;
}

/** A directive opening a parenthesised block, e.g. `require (`. */
const GO_BLOCK_OPEN = /^[ \t]*([a-z]+)[ \t]*\([ \t]*$/;

/** A `module version` line inside a `require` block, with optional comment. */
const GO_BLOCK_ENTRY =
  /^[ \t]*([^\s()]+)[ \t]+([^\s()]+)[ \t]*(\/\/.*?)?[ \t]*(\r?\n?)$/;

/** A single-line `require module version` directive. */
const GO_SINGLE_ENTRY =
  /^[ \t]*require[ \t]+([^\s()]+)[ \t]+([^\s()]+)[ \t]*(\/\/.*?)?[ \t]*(\r?\n?)$/;

/**
 * A plain Go semver version: mandatory `v`, exactly three numeric segments.
 *
 * Pseudo-versions (`v0.0.0-20230101120000-abcdef123456`) and `+incompatible`
 * are deliberately excluded — a timestamp-ordered pseudo-version is not
 * comparable by the semver rule, and `+incompatible` marks a module outside the
 * versioning scheme entirely.
 */
const GO_VERSION = /^v\d+\.\d+\.\d+$/;

const goModDialect: NativeDialect<GoModContext> = {
  name: "go.mod",
  basenames: ["go.mod"],
  entryNoun: "require",

  createContext: () => ({ block: null, pending: "" }),

  feed(context, text) {
    const lines = splitLines(context.pending + text);
    context.pending = "";
    for (const line of lines) {
      const [content, terminator] = splitTerminator(line);
      if (terminator === "") {
        context.pending = content;
        continue;
      }
      if (context.block !== null) {
        if (content.trim().startsWith(")")) context.block = null;
        continue;
      }
      const match = content.match(GO_BLOCK_OPEN);
      if (match) context.block = match[1]!;
    }
  },

  // A hunk at the top level may still be a single-line `require`; any other
  // open block (`replace`, `exclude`, `retract`) is never resolvable.
  isDependencyRegion: (context) =>
    context.block === null || context.block === "require",

  describe: (context) =>
    `not inside a require directive (the ${context.block} block)`,

  parseEntries(context, side) {
    const pattern = context.block === "require"
      ? GO_BLOCK_ENTRY
      : GO_SINGLE_ENTRY;
    const entries: NativeEntry[] = [];
    const seen = new Set<string>();

    for (const line of splitLines(side)) {
      const match = line.match(pattern);
      if (!match) return null;

      const key = match[1]!;
      // A comment line parses as two tokens; it is not a require entry.
      if (key.startsWith("//")) return null;
      if (seen.has(key)) return null;
      seen.add(key);

      const terminator = match[4] ?? "";
      entries.push({
        key,
        core: line.slice(0, line.length - terminator.length),
        terminator,
        version: match[2]!,
        shape: match[3] ?? "",
      });
    }

    return entries.length > 0 ? entries : null;
  },

  compare(ours, theirs) {
    for (const version of [ours, theirs]) {
      if (!GO_VERSION.test(version)) {
        return {
          kind: "undecidable",
          reason: `not a plain Go semver version: ${version}`,
        };
      }
    }
    const verdict = compareDependencySpecifiers(ours, theirs);
    return verdict.kind === "higher"
      ? { kind: "higher", side: verdict.side }
      : { kind: "undecidable", reason: verdict.reason };
  },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** `Cargo.toml`: the dependency tables, short and inline-table entry forms. */
export const cargoTomlRule: ManifestRule = createRule(cargoDialect);

/** `go.mod`: `require` lines, single-line and parenthesised-block forms. */
export const goModRule: ManifestRule = createRule(goModDialect);

/** The native manifest rules, in match order. */
export const nativeManifestRules: readonly ManifestRule[] = [
  cargoTomlRule,
  goModRule,
];

/**
 * Register the native manifest rules into a registry.
 *
 * Called at import time against the shared registry, so importing this module
 * is all it takes to make the rules available; a test can pass its own registry
 * instead.
 */
export function registerNativeManifestRules(
  registry: ManifestRuleRegistry = manifestRuleRegistry,
): void {
  for (const rule of nativeManifestRules) registry.register(rule);
}

registerNativeManifestRules();
