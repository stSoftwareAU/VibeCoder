/**
 * Deterministic merge-conflict core (Issue #462, part of #456).
 *
 * The merge-conflict pass (`pr_merge_conflict_processor.ts`) runs a real
 * `git merge` and, on conflict, hands the tree to an AI agent whose contract
 * (`prompts/merge_conflict/v1.md`) forbids side-picking and treats "the same
 * value set to two different values" as a human decision. A dependency-version
 * bump on both sides is exactly that shape, so it fails by design.
 *
 * This module is the dependency-free foundation for a deterministic path for
 * that one narrow case. It provides three pieces and nothing else — nothing
 * here is wired into the processor yet:
 *
 * 1. **Hunk parser** — splits a conflicted file into an ordered list of literal
 *    segments and conflict hunks, including the `||||||| base` section that
 *    `diff3` conflict style produces. An unmodified parse renders back
 *    byte-for-byte, so a resolved file differs only where a hunk was replaced.
 * 2. **Version comparator** — parses the dependency-specifier shapes this
 *    repository actually uses and decides which side is higher, or says it
 *    cannot decide. Pre-releases, equal versions, differing range prefixes and
 *    unparseable specifiers are all *undecidable* and reach the AI/human path.
 * 3. **Rule registry** — the `ManifestRule` seam later sub-issues register
 *    `deno.json`, `package.json`, `Cargo.toml` and `go.mod` handlers into
 *    without editing this core.
 *
 * A resolution is either `resolved` (full file text to write) or `unresolved`
 * (a reason, handed to the AI fallback). **`partial` is deliberately not
 * supported**: a half-resolved file would leave conflict markers behind, which
 * `pr_merge_conflict_processor.ts` refuses to push. All-or-nothing keeps that
 * invariant impossible to break.
 *
 * The module is pure — no git, no network, no file I/O — so it is fully
 * covered by unit tests.
 *
 * Australian English is used throughout (behaviour, normalised, organisation).
 */

import type { Result } from "../types.ts";
import { compareSemver } from "./software_updates.ts";

// ---------------------------------------------------------------------------
// Conflict markers
// ---------------------------------------------------------------------------

/** Marker opening the "ours" side of a conflict hunk. */
export const OURS_MARKER = "<<<<<<<";

/** Marker opening the optional `diff3` base section. */
export const BASE_MARKER = "|||||||";

/** Marker separating "ours" from "theirs". */
export const SEPARATOR_MARKER = "=======";

/** Marker closing the "theirs" side of a conflict hunk. */
export const THEIRS_MARKER = ">>>>>>>";

/** Which side of a conflict hunk a resolution picks. */
export type ConflictSide = "ours" | "theirs";

// ---------------------------------------------------------------------------
// Parsed segments
// ---------------------------------------------------------------------------

/** A run of text outside any conflict hunk, preserved verbatim. */
export interface LiteralSegment {
  kind: "literal";
  /** Raw text including its line terminators. */
  text: string;
}

/**
 * One conflict hunk.
 *
 * The marker lines are kept verbatim (including their labels and line
 * terminators) so rendering an unmodified parse reproduces the input exactly.
 */
export interface ConflictHunk {
  kind: "conflict";
  /** The `<<<<<<< label` line, including its terminator. */
  oursMarkerLine: string;
  /** Raw "ours" body — may be empty when that side deleted the region. */
  ours: string;
  /** The `||||||| label` line when `diff3` style, otherwise null. */
  baseMarkerLine: string | null;
  /** Raw base body when `diff3` style, otherwise null. */
  base: string | null;
  /** The `=======` line, including its terminator. */
  separatorLine: string;
  /** Raw "theirs" body — may be empty when that side deleted the region. */
  theirs: string;
  /** The `>>>>>>> label` line, including its terminator. */
  theirsMarkerLine: string;
}

/** An ordered piece of a parsed conflicted file. */
export type ConflictSegment = LiteralSegment | ConflictHunk;

// ---------------------------------------------------------------------------
// Hunk parser
// ---------------------------------------------------------------------------

/** Split text into lines, each keeping its own trailing newline. */
function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

/** Whether a line is the given conflict marker (bare, or with a label). */
function isMarker(line: string, marker: string): boolean {
  const content = line.replace(/\r?\n$/, "");
  return content === marker || content.startsWith(`${marker} `);
}

/**
 * Parse a conflicted file into ordered literal segments and conflict hunks.
 *
 * Malformed marker sequences — an unterminated hunk, a nested start marker, an
 * end marker before its separator — are reported as errors rather than
 * silently treated as literal text: a caller that resolved such a file would
 * write conflict markers into the tree.
 *
 * Note that `=======` and `>>>>>>>` lines *outside* a hunk are ordinary text
 * (a Markdown setext heading underlines with `=======`), so only an unclosed
 * `<<<<<<<` is malformed.
 */
export function parseConflictSegments(
  text: string,
): Result<ConflictSegment[], string> {
  const lines = splitLines(text);
  const segments: ConflictSegment[] = [];

  let literal = "";
  let state: "literal" | "ours" | "base" | "theirs" = "literal";
  let startLine = 0;
  let oursMarkerLine = "";
  let ours = "";
  let baseMarkerLine: string | null = null;
  let base: string | null = null;
  let separatorLine = "";
  let theirs = "";

  const fail = (message: string): Result<ConflictSegment[], string> => ({
    ok: false,
    error: message,
  });

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;

    if (state === "literal") {
      if (isMarker(line, OURS_MARKER)) {
        if (literal !== "") {
          segments.push({ kind: "literal", text: literal });
          literal = "";
        }
        state = "ours";
        startLine = lineNo;
        oursMarkerLine = line;
        ours = "";
        baseMarkerLine = null;
        base = null;
        separatorLine = "";
        theirs = "";
        continue;
      }
      literal += line;
      continue;
    }

    if (isMarker(line, OURS_MARKER)) {
      return fail(
        `nested conflict start marker at line ${lineNo} (hunk opened at line ${startLine})`,
      );
    }

    if (state === "ours") {
      if (isMarker(line, BASE_MARKER)) {
        state = "base";
        baseMarkerLine = line;
        base = "";
        continue;
      }
      if (isMarker(line, SEPARATOR_MARKER)) {
        state = "theirs";
        separatorLine = line;
        continue;
      }
      if (isMarker(line, THEIRS_MARKER)) {
        return fail(
          `conflict end marker at line ${lineNo} before any separator (hunk opened at line ${startLine})`,
        );
      }
      ours += line;
      continue;
    }

    if (state === "base") {
      if (isMarker(line, SEPARATOR_MARKER)) {
        state = "theirs";
        separatorLine = line;
        continue;
      }
      if (isMarker(line, THEIRS_MARKER)) {
        return fail(
          `conflict end marker at line ${lineNo} before any separator (hunk opened at line ${startLine})`,
        );
      }
      base += line;
      continue;
    }

    // state === "theirs"
    if (isMarker(line, THEIRS_MARKER)) {
      segments.push({
        kind: "conflict",
        oursMarkerLine,
        ours,
        baseMarkerLine,
        base,
        separatorLine,
        theirs,
        theirsMarkerLine: line,
      });
      state = "literal";
      continue;
    }
    theirs += line;
  }

  if (state !== "literal") {
    return fail(`unterminated conflict hunk opened at line ${startLine}`);
  }
  if (literal !== "") segments.push({ kind: "literal", text: literal });

  return { ok: true, value: segments };
}

/** Render parsed segments back to file text; an unmodified parse round-trips. */
export function renderConflictSegments(
  segments: readonly ConflictSegment[],
): string {
  let out = "";
  for (const segment of segments) {
    if (segment.kind === "literal") {
      out += segment.text;
      continue;
    }
    out += segment.oursMarkerLine + segment.ours +
      (segment.baseMarkerLine ?? "") + (segment.base ?? "") +
      segment.separatorLine + segment.theirs + segment.theirsMarkerLine;
  }
  return out;
}

/**
 * Render segments with every conflict hunk replaced by the chosen side.
 *
 * `choices[i]` is the side to keep for the i-th conflict hunk. A mismatched
 * choice count throws rather than resolving part of the file — a partially
 * resolved file would leave conflict markers in the tree.
 */
export function applyHunkChoices(
  segments: readonly ConflictSegment[],
  choices: readonly ConflictSide[],
): string {
  const hunkCount = segments.filter((s) => s.kind === "conflict").length;
  if (choices.length !== hunkCount) {
    throw new Error(
      `applyHunkChoices needs one choice per hunk: got ${choices.length} for ${hunkCount} hunks`,
    );
  }

  let out = "";
  let index = 0;
  for (const segment of segments) {
    if (segment.kind === "literal") {
      out += segment.text;
      continue;
    }
    out += choices[index] === "ours" ? segment.ours : segment.theirs;
    index++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dependency specifier comparison
// ---------------------------------------------------------------------------

/** A dependency specifier broken into the parts the comparator needs. */
export interface ParsedDependencySpecifier {
  /**
   * Everything up to and including the `@` that introduces the version, e.g.
   * `jsr:@std/fs@`. Empty for a bare version such as `^1.2.3`.
   */
  packagePrefix: string;
  /** Range operator: `^`, `~`, `>=`, or empty for an exact pin. */
  rangePrefix: string;
  /** MAJOR.MINOR.PATCH, compared numerically per segment. */
  version: [number, number, number];
  /** True when the version carries a `-pre.release` suffix. */
  prerelease: boolean;
}

/** Version portion: optional range operator, optional `v`, a semver triple. */
const VERSION_PATTERN = /^(\^|~|>=)?v?(\d+)\.(\d+)\.(\d+)(.*)$/;

/**
 * Parse a dependency specifier, or return null when the shape is unsupported.
 *
 * Supported shapes are the ones this repository actually uses: a bare semver
 * (`1.2.3`, optionally `v`-prefixed), a range-prefixed semver (`^1.2.3`,
 * `~1.2.3`, `>=1.2.3`), and a registry specifier (`jsr:@std/fs@^1.2.3`,
 * `npm:pkg@~1.2.3`). Anything else — `latest`, `workspace:*`, build metadata,
 * a two-segment version, a specifier with a sub-path export — returns null and
 * so reaches the AI/human path.
 */
export function parseDependencySpecifier(
  specifier: string,
): ParsedDependencySpecifier | null {
  const trimmed = specifier.trim();
  const at = trimmed.lastIndexOf("@");
  const packagePrefix = at > 0 ? trimmed.slice(0, at + 1) : "";
  const versionPart = at > 0 ? trimmed.slice(at + 1) : trimmed;

  const match = versionPart.match(VERSION_PATTERN);
  if (!match) return null;

  const rest = match[5] ?? "";
  // Only a pre-release suffix may follow the triple; build metadata and
  // sub-path exports are not version bumps we are willing to decide.
  if (rest !== "" && !rest.startsWith("-")) return null;

  return {
    packagePrefix,
    rangePrefix: match[1] ?? "",
    version: [Number(match[2]), Number(match[3]), Number(match[4])],
    prerelease: rest.startsWith("-"),
  };
}

/** The comparator's decision for a pair of specifiers. */
export type VersionVerdict =
  | {
    kind: "higher";
    /** The side carrying the higher version. */
    side: ConflictSide;
    /** That side's specifier, verbatim — the range prefix is carried through. */
    specifier: string;
  }
  | {
    kind: "undecidable";
    /** Why the pair was not decided; surfaced to the AI/human fallback. */
    reason: string;
  };

/**
 * Decide which of two dependency specifiers is the later version.
 *
 * Deliberately undecidable — because "later version" is then not what a
 * reviewer means, or is not what the change is about:
 *
 * - either side is a pre-release (`1.2.3-beta.1`): pre-release ordering is
 *   rarely the intent;
 * - the versions are equal;
 * - the range prefixes differ (`^1.2.3` vs `~1.2.3`): that is a policy change;
 * - the two sides name different packages;
 * - either specifier cannot be parsed.
 */
export function compareDependencySpecifiers(
  ours: string,
  theirs: string,
): VersionVerdict {
  const a = parseDependencySpecifier(ours);
  const b = parseDependencySpecifier(theirs);

  if (!a) {
    return {
      kind: "undecidable",
      reason: `unparseable specifier: ${ours.trim()}`,
    };
  }
  if (!b) {
    return {
      kind: "undecidable",
      reason: `unparseable specifier: ${theirs.trim()}`,
    };
  }

  if (a.prerelease || b.prerelease) {
    return {
      kind: "undecidable",
      reason: "pre-release version on one or both sides",
    };
  }
  if (a.packagePrefix !== b.packagePrefix) {
    return {
      kind: "undecidable",
      reason: `different packages: ${a.packagePrefix || "(bare)"} vs ${
        b.packagePrefix || "(bare)"
      }`,
    };
  }
  if (a.rangePrefix !== b.rangePrefix) {
    return {
      kind: "undecidable",
      reason: `range prefix changed: "${a.rangePrefix}" vs "${b.rangePrefix}"`,
    };
  }

  const order = compareSemver(a.version, b.version);
  if (order === 0) return { kind: "undecidable", reason: "versions are equal" };

  return order > 0
    ? { kind: "higher", side: "ours", specifier: ours.trim() }
    : { kind: "higher", side: "theirs", specifier: theirs.trim() };
}

// ---------------------------------------------------------------------------
// Rule registry
// ---------------------------------------------------------------------------

/**
 * The result of a rule attempting a file.
 *
 * There is no `partial`: a file is either fully rule-resolved or entirely
 * deferred, so no resolution can leave conflict markers behind.
 */
export type RuleOutcome =
  | { kind: "resolved"; text: string }
  | { kind: "unresolved"; reason: string };

/** A per-manifest deterministic resolution rule. */
export interface ManifestRule {
  /** Unique, stable name — used for logging and duplicate detection. */
  readonly name: string;
  /** Whether this rule handles the given repository-relative path. */
  matches(path: string): boolean;
  /**
   * Attempt to resolve a parsed file.
   *
   * Receives the full ordered parse (literals and hunks) rather than the hunks
   * alone, so a `resolved` outcome can reproduce every unconflicted byte.
   */
  resolve(segments: readonly ConflictSegment[]): RuleOutcome;
}

/** Lookup of manifest rules keyed on file path. */
export interface ManifestRuleRegistry {
  /** Register a rule; a duplicate name throws. */
  register(rule: ManifestRule): void;
  /** The first registered rule matching `path`, or undefined. */
  find(path: string): ManifestRule | undefined;
  /** Registered rules in registration order. */
  readonly rules: readonly ManifestRule[];
}

/**
 * Create a rule registry, optionally seeded with rules.
 *
 * Later sub-issues register their per-ecosystem handlers here rather than
 * editing this core. Registration order is match order, so the first matching
 * rule wins.
 */
export function createManifestRuleRegistry(
  seed: readonly ManifestRule[] = [],
): ManifestRuleRegistry {
  const rules: ManifestRule[] = [];

  const register = (rule: ManifestRule): void => {
    if (rules.some((existing) => existing.name === rule.name)) {
      throw new Error(`manifest rule already registered: ${rule.name}`);
    }
    rules.push(rule);
  };

  for (const rule of seed) register(rule);

  return {
    register,
    find: (path) => rules.find((rule) => rule.matches(path)),
    get rules() {
      return rules;
    },
  };
}

/**
 * The shared registry the merge-conflict pass will consult.
 *
 * Per-ecosystem modules call `manifestRuleRegistry.register(...)` at import
 * time, so adding an ecosystem never touches this file.
 */
export const manifestRuleRegistry: ManifestRuleRegistry =
  createManifestRuleRegistry();
