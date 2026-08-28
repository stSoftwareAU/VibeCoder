/**
 * Per-dependency decision reporting for rule-resolved conflicts (Issue #466).
 *
 * The deterministic pass in `dependency_conflict_apply.ts` resolves a
 * dependency-version conflict without asking the AI anything. That is a
 * documented carve-out from the never-side-pick contract, so the PR comment has
 * to say **what** it decided: which dependency changed, what each side carried,
 * and which value ended up in the tree.
 *
 * The decisions are derived from the rule's *actual* output rather than
 * re-deriving the comparison, so the comment can never describe a pick the
 * rules did not make. A rule replaces conflict hunks and re-emits every literal
 * segment verbatim, so the resolved text can be split back into "the text that
 * replaced hunk N" by anchoring on those literals. When the text cannot be
 * split that way — adjacent hunks with no literal between them, or a rule that
 * rewrote a literal — the extractor returns `null` ("cannot attribute") instead
 * of guessing.
 *
 * The module is pure — no git, no network, no file I/O.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { ConflictSegment } from "./dependency_conflict_rules.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One dependency the rules decided.
 *
 * `null` means "this side did not carry the key". A decision is only reported
 * when the three values are not all identical — an untouched dependency is not
 * a decision a reviewer needs to audit.
 */
export interface DependencyDecision {
  /** Dependency key, or null for a line no entry parser recognised. */
  key: string | null;
  /** The value on the PR branch's side of the conflict. */
  ours: string | null;
  /** The value on the base branch's side of the conflict. */
  theirs: string | null;
  /** The value the rules left in the tree. */
  kept: string | null;
}

// ---------------------------------------------------------------------------
// Entry-line parsing
// ---------------------------------------------------------------------------

/** `"key": "value"` with an optional trailing comma — JSON manifests. */
const JSON_ENTRY =
  /^[ \t]*"((?:[^"\\]|\\.)*)"[ \t]*:[ \t]*"((?:[^"\\]|\\.)*)"[ \t]*,?[ \t]*$/;

/** `key = "value"` — a Cargo short-form dependency. */
const TOML_SHORT_ENTRY =
  /^[ \t]*([A-Za-z0-9_.\-]+)[ \t]*=[ \t]*"([^"]*)"[ \t]*$/;

/** `key = { ... }` — a Cargo inline table; only its `version` is reported. */
const TOML_TABLE_ENTRY =
  /^[ \t]*([A-Za-z0-9_.\-]+)[ \t]*=[ \t]*\{(.*)\}[ \t]*$/;

/** `version = "x"` inside an inline table. */
const TOML_TABLE_VERSION = /(?:^|[,{])[ \t]*version[ \t]*=[ \t]*"([^"]*)"/;

/** `module vX.Y.Z` with an optional `require` keyword — go.mod. */
const GO_REQUIRE_ENTRY =
  /^[ \t]*(?:require[ \t]+)?([^\s"'/][^\s"']*)[ \t]+(v[^\s]+)[ \t]*(?:\/\/.*)?$/;

/** Decode a JSON string body, falling back to the raw text. */
function decodeLiteral(literal: string): string {
  try {
    return JSON.parse(`"${literal}"`) as string;
  } catch {
    return literal;
  }
}

/**
 * Parse one line as a dependency entry, or null when it is not one.
 *
 * Covers the shapes the registered rules can resolve — JSON maps, Cargo short
 * and inline-table entries, and `go.mod` require lines — so a decision report
 * stays ecosystem-agnostic as more rules are registered.
 */
export function parseDependencyEntryLine(
  line: string,
): { key: string; value: string } | null {
  const text = line.replace(/\r?\n$/, "");

  const json = text.match(JSON_ENTRY);
  if (json) {
    return {
      key: decodeLiteral(json[1]!),
      value: decodeLiteral(json[2]!),
    };
  }

  const short = text.match(TOML_SHORT_ENTRY);
  if (short) return { key: short[1]!, value: short[2]! };

  const table = text.match(TOML_TABLE_ENTRY);
  if (table) {
    const version = table[2]!.match(TOML_TABLE_VERSION);
    return { key: table[1]!, value: version ? version[1]! : table[2]!.trim() };
  }

  const go = text.match(GO_REQUIRE_ENTRY);
  if (go) return { key: go[1]!, value: go[2]! };

  return null;
}

// ---------------------------------------------------------------------------
// Splitting the resolved text back into per-hunk resolutions
// ---------------------------------------------------------------------------

/**
 * Split `resolvedText` into the text that replaced each conflict hunk.
 *
 * Returns null when the text cannot be attributed — the caller then reports the
 * file as resolved with unknown decisions rather than a wrong one.
 */
function splitHunkResolutions(
  segments: readonly ConflictSegment[],
  resolvedText: string,
): string[] | null {
  const resolutions: string[] = [];
  let cursor = 0;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;

    if (segment.kind === "literal") {
      if (!resolvedText.startsWith(segment.text, cursor)) return null;
      cursor += segment.text.length;
      continue;
    }

    const next = segments[i + 1];
    if (next === undefined) {
      resolutions.push(resolvedText.slice(cursor));
      cursor = resolvedText.length;
      continue;
    }
    // Two hunks in a row have no anchor between them, so the boundary is
    // genuinely ambiguous.
    if (next.kind !== "literal") return null;

    const at = resolvedText.indexOf(next.text, cursor);
    if (at < 0) return null;
    resolutions.push(resolvedText.slice(cursor, at));
    cursor = at;
  }

  return cursor === resolvedText.length ? resolutions : null;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** Split text into lines, each keeping its own trailing newline. */
function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

interface SideEntries {
  /** Recognised entries, keyed on dependency key. */
  byKey: Map<string, string>;
  /** Trimmed text of lines no entry parser recognised. */
  unkeyed: string[];
}

function readSide(text: string): SideEntries {
  const byKey = new Map<string, string>();
  const unkeyed: string[] = [];
  for (const line of splitLines(text)) {
    const entry = parseDependencyEntryLine(line);
    if (entry) {
      byKey.set(entry.key, entry.value);
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.length > 0) unkeyed.push(trimmed);
  }
  return { byKey, unkeyed };
}

/** Decisions for one hunk: kept order first, then keys only a side carried. */
function decisionsForHunk(
  ours: string,
  theirs: string,
  kept: string,
): DependencyDecision[] {
  const o = readSide(ours);
  const t = readSide(theirs);
  const k = readSide(kept);

  const decisions: DependencyDecision[] = [];
  const keys = [...k.byKey.keys()];
  for (const key of [...o.byKey.keys(), ...t.byKey.keys()]) {
    if (!keys.includes(key)) keys.push(key);
  }

  for (const key of keys) {
    const ourValue = o.byKey.get(key) ?? null;
    const theirValue = t.byKey.get(key) ?? null;
    const keptValue = k.byKey.get(key) ?? null;
    if (ourValue === theirValue && theirValue === keptValue) continue;
    decisions.push({
      key,
      ours: ourValue,
      theirs: theirValue,
      kept: keptValue,
    });
  }

  // Lines no parser recognised still changed the tree, so they are reported
  // rather than silently dropped from the audit trail.
  for (const line of k.unkeyed) {
    if (o.unkeyed.includes(line)) continue;
    decisions.push({
      key: null,
      ours: null,
      theirs: t.unkeyed.includes(line) ? line : null,
      kept: line,
    });
  }
  for (const line of o.unkeyed) {
    if (k.unkeyed.includes(line)) continue;
    decisions.push({
      key: null,
      ours: line,
      theirs: t.unkeyed.includes(line) ? line : null,
      kept: null,
    });
  }

  return decisions;
}

/**
 * Describe what a rule decided, from its own resolved text.
 *
 * @param segments - The parse the rule was given.
 * @param resolvedText - The text the rule returned.
 * @returns One decision per dependency the resolution changed, or null when the
 *   resolved text cannot be attributed to the parsed hunks.
 */
export function extractDependencyDecisions(
  segments: readonly ConflictSegment[],
  resolvedText: string,
): DependencyDecision[] | null {
  const resolutions = splitHunkResolutions(segments, resolvedText);
  if (resolutions === null) return null;

  const decisions: DependencyDecision[] = [];
  let index = 0;
  for (const segment of segments) {
    if (segment.kind !== "conflict") continue;
    decisions.push(
      ...decisionsForHunk(segment.ours, segment.theirs, resolutions[index]!),
    );
    index++;
  }
  return decisions;
}
