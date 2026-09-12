/**
 * Structured union of two append-only JSON documents (Issue #1968).
 *
 * The append-only ledger rule (`both_inserted_conflict_rule.ts`) resolves a
 * conflict by keeping both sides' **text**. For `docs/audits/*.json` that fails
 * on the one shape those files actually produce: two branches that each append
 * an object to the same array conflict *inside* the object, so concatenating
 * the two hunks yields text that is not JSON at all. The rule then defers, and
 * the resolution falls to a hand merge — which is how a sweep slice was dropped
 * and `main` went red (Issues #1966, #1609).
 *
 * Text cannot union those sides, but their **values** can. This module parses
 * the merge base and both sides, merges them structurally, and re-serialises.
 * The union is well-formed by construction, so it never writes the broken
 * document the textual path had to refuse.
 *
 * ## What it accepts, and what it refuses
 *
 * The merge is insertion-only, in the same spirit as the rule that calls it:
 *
 * - **Arrays** — the base's items must still appear, in order, in both sides.
 *   Each side's extra items are kept, the base branch's first. An item both
 *   sides added identically is kept once. Items are matched by value, so an
 *   entry one side *rewrote* reads as a missing base item and is refused:
 *   which rewrite wins is a judgement, and this merge makes none.
 * - **Objects** — every key the base had must still be present on both sides.
 *   A key only one side changed takes that side's value; a key both sides
 *   changed to different values is a conflicting edit and is refused.
 * - **Anything else** — a scalar both sides changed differently, a value whose
 *   type changed, a deleted array item or object key: refused, with a reason
 *   naming the path.
 *
 * A refusal is a deferral by the caller, never a silent one-sided pick.
 *
 * ## Formatting
 *
 * The result is re-serialised, so it must not reformat the rest of the file.
 * The guard is exact: the merge base is re-serialised first and must reproduce
 * its own text byte-for-byte. When it does not — a `.jsonc` with comments, a
 * hand-compacted array, tabs — the union is refused rather than rewriting a
 * file the author formatted deliberately.
 *
 * The module is pure — no git, no network, no file I/O.
 *
 * Australian English is used throughout (behaviour, serialised, organisation).
 */

import type { Result } from "../types.ts";

/** Any value `JSON.parse` can produce. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** An `ok: false` result, so every refusal reads the same way. */
function refuse<T>(reason: string): Result<T, string> {
  return { ok: false, error: reason };
}

/** Whether a value is a JSON object (not an array, not null). */
function isObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Structural equality of two JSON values.
 *
 * Key **order** is deliberately ignored: two sides that wrote the same entry
 * with its fields in a different order added the same entry.
 */
export function jsonEquals(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, i) => jsonEquals(item, b[i]!));
  }
  if (isObject(a) && isObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) =>
      Object.hasOwn(b, key) && jsonEquals(a[key]!, b[key]!)
    );
  }
  return false;
}

/** Items one side inserted, grouped by the base index they sit before. */
type InsertionGroups = Map<number, JsonValue[]>;

/**
 * Align a side's array against the base and return what it inserted.
 *
 * Returns `null` when the base is not a subsequence of the side — that means
 * an item was deleted or edited, which this merge refuses.
 */
function insertionsAgainstBase(
  base: readonly JsonValue[],
  side: readonly JsonValue[],
): InsertionGroups | null {
  const groups: InsertionGroups = new Map();
  let baseIndex = 0;
  for (const item of side) {
    if (baseIndex < base.length && jsonEquals(item, base[baseIndex]!)) {
      baseIndex++;
      continue;
    }
    const group = groups.get(baseIndex) ?? [];
    group.push(item);
    groups.set(baseIndex, group);
  }
  return baseIndex === base.length ? groups : null;
}

/**
 * Merge two arrays that both only inserted into the base.
 *
 * `theirs` is emitted before `ours` at each insertion point: the pass runs
 * during `git merge origin/<base>` on the PR branch, so stage 3 ("theirs") is
 * the base branch's side, and a ledger then reads in the order the two authors
 * wrote it.
 */
function mergeArrays(
  base: readonly JsonValue[],
  ours: readonly JsonValue[],
  theirs: readonly JsonValue[],
  path: string,
): Result<JsonValue, string> {
  const ourGroups = insertionsAgainstBase(base, ours);
  const theirGroups = insertionsAgainstBase(base, theirs);
  if (ourGroups === null || theirGroups === null) {
    return refuse(
      `${path} is not two pure insertions: an item the merge base had is ` +
        `missing or changed on one side`,
    );
  }
  const merged: JsonValue[] = [];
  // Both sides adding the same entry — a cherry-pick, or an insertion one side
  // merged cleanly and the other made itself — keeps it once, wherever in the
  // array each side anchored it.
  const theirInsertions = [...theirGroups.values()].flat();
  const emitGroup = (index: number): void => {
    merged.push(...theirGroups.get(index) ?? []);
    for (const item of ourGroups.get(index) ?? []) {
      if (theirInsertions.some((other) => jsonEquals(item, other))) continue;
      merged.push(item);
    }
  };
  for (let i = 0; i < base.length; i++) {
    emitGroup(i);
    merged.push(base[i]!);
  }
  emitGroup(base.length);
  return { ok: true, value: merged };
}

/** Merge two objects whose keys neither side deleted. */
function mergeObjects(
  base: { [key: string]: JsonValue },
  ours: { [key: string]: JsonValue },
  theirs: { [key: string]: JsonValue },
  path: string,
): Result<JsonValue, string> {
  for (const key of Object.keys(base)) {
    if (!Object.hasOwn(ours, key) || !Object.hasOwn(theirs, key)) {
      return refuse(`${path}.${key} was deleted on one side`);
    }
  }
  const merged: { [key: string]: JsonValue } = {};
  // Base key order first, then each side's additions — base's side first.
  const keys = [
    ...Object.keys(base),
    ...Object.keys(theirs).filter((k) => !Object.hasOwn(base, k)),
    ...Object.keys(ours).filter((k) =>
      !Object.hasOwn(base, k) && !Object.hasOwn(theirs, k)
    ),
  ];
  for (const key of keys) {
    const inOurs = Object.hasOwn(ours, key);
    const inTheirs = Object.hasOwn(theirs, key);
    if (!inOurs) {
      merged[key] = theirs[key]!;
      continue;
    }
    if (!inTheirs) {
      merged[key] = ours[key]!;
      continue;
    }
    const value = mergeValue(
      Object.hasOwn(base, key) ? base[key]! : undefined,
      ours[key]!,
      theirs[key]!,
      `${path}.${key}`,
    );
    if (!value.ok) return value;
    merged[key] = value.value;
  }
  return { ok: true, value: merged };
}

/**
 * Merge one value three ways.
 *
 * `base` is `undefined` for a key both sides added, which is an insertion on
 * both sides rather than a change to anything.
 */
function mergeValue(
  base: JsonValue | undefined,
  ours: JsonValue,
  theirs: JsonValue,
  path: string,
): Result<JsonValue, string> {
  if (jsonEquals(ours, theirs)) return { ok: true, value: ours };
  if (base !== undefined) {
    if (jsonEquals(ours, base)) return { ok: true, value: theirs };
    if (jsonEquals(theirs, base)) return { ok: true, value: ours };
    if (Array.isArray(base) && Array.isArray(ours) && Array.isArray(theirs)) {
      return mergeArrays(base, ours, theirs, path);
    }
    if (isObject(base) && isObject(ours) && isObject(theirs)) {
      return mergeObjects(base, ours, theirs, path);
    }
  }
  return refuse(
    `${path} was set to two different values, which is a decision this merge ` +
      `does not make`,
  );
}

/** Parse one side, naming it in the refusal so the caller can say which. */
function parseSide(text: string, name: string): Result<JsonValue, string> {
  try {
    return { ok: true, value: JSON.parse(text) as JsonValue };
  } catch (error) {
    return refuse(
      `the ${name} side is not valid JSON — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** The indent the document is written with, or `null` when it is not spaces. */
function detectIndent(text: string): number | null {
  const match = text.match(/\n( +)\S/);
  return match ? match[1]!.length : null;
}

/**
 * Union two append-only JSON documents over their merge base.
 *
 * @param base - Merge-base text of the file.
 * @param ours - The PR branch's whole-file text.
 * @param theirs - The base branch's whole-file text.
 * @returns The merged document's text, or the reason it was refused.
 */
export function unionJsonInsertions(
  base: string,
  ours: string,
  theirs: string,
): Result<string, string> {
  const parsedBase = parseSide(base, "base");
  if (!parsedBase.ok) return parsedBase;
  const parsedOurs = parseSide(ours, "ours");
  if (!parsedOurs.ok) return parsedOurs;
  const parsedTheirs = parseSide(theirs, "theirs");
  if (!parsedTheirs.ok) return parsedTheirs;

  const indent = detectIndent(base);
  if (indent === null) {
    return refuse(
      "the merge base is not indented with spaces, so re-serialising it would " +
        "reformat the file",
    );
  }
  const trailingNewline = base.endsWith("\n") ? "\n" : "";
  const serialise = (value: JsonValue): string =>
    JSON.stringify(value, null, indent) + trailingNewline;
  // A document `JSON.parse` accepts can still exhaust the stack on the way
  // out, so the walk and the re-serialisation are guarded too: the caller
  // gets a refusal it can defer on, never a crash in the conflict pass.
  try {
    if (serialise(parsedBase.value) !== base) {
      return refuse(
        "the merge base does not round-trip through JSON.stringify, so the " +
          "union would reformat lines neither side touched",
      );
    }
    const merged = mergeValue(
      parsedBase.value,
      parsedOurs.value,
      parsedTheirs.value,
      "$",
    );
    if (!merged.ok) return merged;
    return { ok: true, value: serialise(merged.value) };
  } catch (error) {
    return refuse(
      `the union could not be built — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
