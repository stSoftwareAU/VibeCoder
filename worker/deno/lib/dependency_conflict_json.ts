/**
 * Deterministic merge-conflict rules for JSON manifests (Issue #463, #456).
 *
 * Registers two rules against the seam in `dependency_conflict_rules.ts`:
 *
 * - **`deno.json` / `deno.jsonc`** — conflicts inside the `imports` map, and
 *   inside a per-scope map under `scopes`, which nests the same shape.
 * - **`package.json`** — conflicts inside `dependencies`, `devDependencies`,
 *   `peerDependencies` and `optionalDependencies`.
 *
 * Both rules work **per dependency key**, not per hunk: for a key present on
 * both sides with different specifiers the higher semver wins, whichever branch
 * carries it, and a key only one side has is kept. That is an ordinary
 * both-sides-survive merge, not a side-pick.
 *
 * Everything else defers to the AI fallback, all-or-nothing:
 *
 * - a hunk that touches anything other than a dependency-map entry (a `tasks`
 *   block, a `scripts` block, a changed `exports`, a comment) — including a
 *   hunk that starts in one of those and runs into a dependency map;
 * - any single undecidable dependency (pre-release, unparseable specifier,
 *   equal-but-textually-different, a changed range prefix);
 * - a side that deletes the whole block, or reorders the keys.
 *
 * There is no partial resolution: one undecidable key defers the whole file, so
 * a resolved file can never carry conflict markers into the pushed tree.
 *
 * **Formatting is preserved.** The winning side's original line is emitted with
 * its own indentation, quoting and terminator rather than re-serialising the
 * document: `deno.jsonc` permits comments and `deno fmt` is a quality gate, so
 * a `JSON.parse`/`JSON.stringify` round trip would strip the comments and turn
 * a two-line resolution into a whole-file diff. Only a trailing comma is
 * adjusted, and only where the merge moved a line off the end of the map.
 *
 * The module is pure — no git, no network, no file I/O.
 */

import {
  compareDependencySpecifiers,
  type ConflictSegment,
  type ManifestRule,
  type ManifestRuleRegistry,
  manifestRuleRegistry,
  type RuleOutcome,
} from "./dependency_conflict_rules.ts";

// ---------------------------------------------------------------------------
// JSON path scanner
// ---------------------------------------------------------------------------

/**
 * Key path of the containers enclosing a position, root object dropped.
 *
 * `["imports"]` for a line inside `deno.json`'s `imports` map;
 * `["scopes", "https://example.com/"]` for one inside a scope map. A container
 * with no key — the root object, or an array element — contributes null.
 */
type ContainerPath = readonly (string | null)[];

type ScanMode = "text" | "string" | "line-comment" | "block-comment";

/** Incremental scanner state; JSONC comments and strings are skipped. */
interface ScanState {
  mode: ScanMode;
  /** Inside a string: the previous character was a backslash. */
  escaped: boolean;
  /** Inside a string: the raw literal so far, without its quotes. */
  literal: string;
  /** The most recently closed string, a candidate object key. */
  lastString: string | null;
  /** The key of the value currently being read, set by `:`. */
  pendingKey: string | null;
  /** The previous character was `/` — a comment may be opening. */
  slash: boolean;
  /** Inside a block comment: the previous character was `*`. */
  star: boolean;
  /** Open containers, outermost first. */
  stack: (string | null)[];
}

function createScanState(): ScanState {
  return {
    mode: "text",
    escaped: false,
    literal: "",
    lastString: null,
    pendingKey: null,
    slash: false,
    star: false,
    stack: [],
  };
}

/** Decode a raw string literal body, falling back to the raw text. */
function decodeLiteral(literal: string): string {
  try {
    return JSON.parse(`"${literal}"`) as string;
  } catch {
    return literal;
  }
}

/** Feed one character while outside a string or comment. */
function feedTextChar(state: ScanState, char: string): void {
  if (state.slash) {
    state.slash = false;
    if (char === "/") {
      state.mode = "line-comment";
      return;
    }
    if (char === "*") {
      state.mode = "block-comment";
      state.star = false;
      return;
    }
  }

  switch (char) {
    case '"':
      state.mode = "string";
      state.literal = "";
      state.escaped = false;
      return;
    case "/":
      state.slash = true;
      return;
    case "{":
    case "[":
      state.stack.push(state.pendingKey);
      state.pendingKey = null;
      state.lastString = null;
      return;
    case "}":
    case "]":
      state.stack.pop();
      state.pendingKey = null;
      state.lastString = null;
      return;
    case ":":
      state.pendingKey = state.lastString;
      state.lastString = null;
      return;
    case ",":
      state.pendingKey = null;
      state.lastString = null;
      return;
    default:
      return;
  }
}

/** Advance the scanner over a chunk of document text. */
function feed(state: ScanState, text: string): void {
  for (const char of text) {
    switch (state.mode) {
      case "string":
        if (state.escaped) {
          state.literal += char;
          state.escaped = false;
        } else if (char === "\\") {
          state.literal += char;
          state.escaped = true;
        } else if (char === '"') {
          state.lastString = decodeLiteral(state.literal);
          state.mode = "text";
        } else {
          state.literal += char;
        }
        break;
      case "line-comment":
        if (char === "\n") state.mode = "text";
        break;
      case "block-comment":
        if (state.star && char === "/") {
          state.mode = "text";
          state.star = false;
        } else {
          state.star = char === "*";
        }
        break;
      case "text":
        feedTextChar(state, char);
        break;
    }
  }
}

/**
 * The container path at the scanner's current position.
 *
 * Returns null while inside a string or a comment — a hunk that opens there is
 * not a dependency-map entry and must defer.
 */
function containerPath(state: ScanState): ContainerPath | null {
  if (state.mode !== "text") return null;
  return state.stack.slice(1);
}

/** Human-readable rendering of a container path for an `unresolved` reason. */
function describePath(path: ContainerPath | null): string {
  if (path === null) return "inside a string or comment";
  if (path.length === 0) return "the document root";
  return path.map((key) => key ?? "[]").join(".");
}

// ---------------------------------------------------------------------------
// Dependency-map entry lines
// ---------------------------------------------------------------------------

/** One `"key": "value"` line of a dependency map, kept verbatim. */
interface EntryLine {
  key: string;
  /** The specifier, JSON-decoded. */
  value: string;
  /** The line without its trailing comma, trailing space and terminator. */
  core: string;
  /** Whether the original line carried a trailing comma. */
  comma: boolean;
  /** The line's own terminator: `\n`, `\r\n`, or empty at end of file. */
  terminator: string;
}

/** A `"key": "value"` line with optional trailing comma — nothing else. */
const ENTRY_PATTERN =
  /^[ \t]*("(?:[^"\\]|\\.)*")[ \t]*:[ \t]*("(?:[^"\\]|\\.)*")[ \t]*(,?)[ \t]*(\r?\n?)$/;

/** Split text into lines, each keeping its own trailing newline. */
function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

/**
 * Parse one side of a hunk as dependency-map entries.
 *
 * Returns null when any line is not an entry (a nested object, a comment, a
 * blank line), when the side is empty, or when it repeats a key — each of those
 * is a conflict the rules must not decide.
 */
function parseEntries(side: string): EntryLine[] | null {
  const entries: EntryLine[] = [];
  const seen = new Set<string>();

  for (const line of splitLines(side)) {
    const match = line.match(ENTRY_PATTERN);
    if (!match) return null;

    const terminator = match[4] ?? "";
    const withoutTerminator = terminator === ""
      ? line
      : line.slice(0, line.length - terminator.length);
    const key = decodeLiteral(match[1]!.slice(1, -1));
    if (seen.has(key)) return null;
    seen.add(key);

    entries.push({
      key,
      value: decodeLiteral(match[2]!.slice(1, -1)),
      core: withoutTerminator.replace(/[ \t]*,?[ \t]*$/, ""),
      comma: match[3] === ",",
      terminator,
    });
  }

  return entries.length > 0 ? entries : null;
}

/** Merge outcome for a single hunk. */
type MergeOutcome =
  | { kind: "merged"; entries: EntryLine[] }
  | { kind: "undecidable"; reason: string };

/**
 * Merge two ordered entry lists, taking the higher semver per shared key.
 *
 * Keys unique to a side are kept in place, so a dependency the other branch
 * added is never silently dropped. Keys shared but reordered between the sides
 * are undecidable — reordering is not a version bump.
 */
function mergeEntries(
  ours: readonly EntryLine[],
  theirs: readonly EntryLine[],
): MergeOutcome {
  const oursIndex = new Map(ours.map((entry, index) => [entry.key, index]));
  const merged: EntryLine[] = [];
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
    if (ourEntry.value === entry.value) {
      merged.push(ourEntry);
      continue;
    }
    const verdict = compareDependencySpecifiers(ourEntry.value, entry.value);
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

/**
 * Render merged entries back to text.
 *
 * Each line keeps its own indentation, quoting and terminator. Only the
 * trailing comma is adjusted: every line but the last needs one, and the last
 * keeps whatever the sides agreed on — that is decided by the text following
 * the hunk, which is common to both.
 */
function renderEntries(entries: readonly EntryLine[], lastComma: boolean) {
  const fallbackEol = entries.find((e) => e.terminator !== "")?.terminator ??
    "\n";
  return entries
    .map((entry, index) => {
      const last = index === entries.length - 1;
      const comma = last ? lastComma : true;
      const terminator = last
        ? entry.terminator
        : entry.terminator || fallbackEol;
      return `${entry.core}${comma ? "," : ""}${terminator}`;
    })
    .join("");
}

// ---------------------------------------------------------------------------
// The rule itself
// ---------------------------------------------------------------------------

/** Whether a container path names a dependency map this rule may resolve. */
type DependencyMapPredicate = (path: ContainerPath) => boolean;

function resolveSegments(
  ruleName: string,
  isDependencyMap: DependencyMapPredicate,
  segments: readonly ConflictSegment[],
): RuleOutcome {
  const state = createScanState();
  const defer = (reason: string): RuleOutcome => ({
    kind: "unresolved",
    reason: `${ruleName}: ${reason}`,
  });

  let out = "";
  let hunkNumber = 0;

  for (const segment of segments) {
    if (segment.kind === "literal") {
      out += segment.text;
      feed(state, segment.text);
      continue;
    }

    hunkNumber++;
    const path = containerPath(state);
    if (path === null || !isDependencyMap(path)) {
      return defer(
        `hunk ${hunkNumber} is not inside a dependency map (${
          describePath(path)
        })`,
      );
    }

    const ours = parseEntries(segment.ours);
    const theirs = parseEntries(segment.theirs);
    if (!ours || !theirs) {
      return defer(
        `hunk ${hunkNumber} touches more than dependency-map entries`,
      );
    }
    if (ours.at(-1)!.comma !== theirs.at(-1)!.comma) {
      return defer(
        `hunk ${hunkNumber} ends the dependency map on one side only`,
      );
    }

    const merged = mergeEntries(ours, theirs);
    if (merged.kind === "undecidable") {
      return defer(`hunk ${hunkNumber} — ${merged.reason}`);
    }

    const text = renderEntries(merged.entries, ours.at(-1)!.comma);
    out += text;
    feed(state, text);
  }

  return { kind: "resolved", text: out };
}

/** The final path component, for both `/` and `\` separated paths. */
function basename(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

function createRule(
  name: string,
  basenames: readonly string[],
  isDependencyMap: DependencyMapPredicate,
): ManifestRule {
  return {
    name,
    matches: (path) => basenames.includes(basename(path)),
    resolve: (segments) => resolveSegments(name, isDependencyMap, segments),
  };
}

/** `deno.json` / `deno.jsonc`: the `imports` map, and each map under `scopes`. */
export const denoJsonRule: ManifestRule = createRule(
  "deno.json",
  ["deno.json", "deno.jsonc"],
  (path) =>
    (path.length === 1 && path[0] === "imports") ||
    (path.length === 2 && path[0] === "scopes" && path[1] !== null),
);

/** The four `package.json` maps whose values are version specifiers. */
const PACKAGE_DEPENDENCY_MAPS: readonly string[] = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

/** `package.json`: the four dependency maps, and nothing else. */
export const packageJsonRule: ManifestRule = createRule(
  "package.json",
  ["package.json"],
  (path) => {
    const [map] = path;
    return path.length === 1 && typeof map === "string" &&
      PACKAGE_DEPENDENCY_MAPS.includes(map);
  },
);

/** The JSON manifest rules, in match order. */
export const jsonManifestRules: readonly ManifestRule[] = [
  denoJsonRule,
  packageJsonRule,
];

/**
 * Register the JSON manifest rules into a registry.
 *
 * Called at import time against the shared registry, so importing this module
 * is all it takes to make the rules available; a test can pass its own
 * registry instead.
 */
export function registerJsonManifestRules(
  registry: ManifestRuleRegistry = manifestRuleRegistry,
): void {
  for (const rule of jsonManifestRules) registry.register(rule);
}

registerJsonManifestRules();
