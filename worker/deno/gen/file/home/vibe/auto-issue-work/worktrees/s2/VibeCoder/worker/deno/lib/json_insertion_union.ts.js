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
 */ /** An `ok: false` result, so every refusal reads the same way. */ function refuse(reason) {
  return {
    ok: false,
    error: reason
  };
}
/** Whether a value is a JSON object (not an array, not null). */ function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Structural equality of two JSON values.
 *
 * Key **order** is deliberately ignored: two sides that wrote the same entry
 * with its fields in a different order added the same entry.
 */ export function jsonEquals(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, i)=>jsonEquals(item, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key)=>Object.hasOwn(b, key) && jsonEquals(a[key], b[key]));
  }
  return false;
}
/**
 * Align a side's array against the base and return what it inserted.
 *
 * Returns `null` when the base is not a subsequence of the side — that means
 * an item was deleted or edited, which this merge refuses.
 */ function insertionsAgainstBase(base, side) {
  const groups = new Map();
  let baseIndex = 0;
  for (const item of side){
    if (baseIndex < base.length && jsonEquals(item, base[baseIndex])) {
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
 */ function mergeArrays(base, ours, theirs, path) {
  const ourGroups = insertionsAgainstBase(base, ours);
  const theirGroups = insertionsAgainstBase(base, theirs);
  if (ourGroups === null || theirGroups === null) {
    return refuse(`${path} is not two pure insertions: an item the merge base had is ` + `missing or changed on one side`);
  }
  const merged = [];
  // Both sides adding the same entry — a cherry-pick, or an insertion one side
  // merged cleanly and the other made itself — keeps it once, wherever in the
  // array each side anchored it.
  const theirInsertions = [
    ...theirGroups.values()
  ].flat();
  const emitGroup = (index)=>{
    merged.push(...theirGroups.get(index) ?? []);
    for (const item of ourGroups.get(index) ?? []){
      if (theirInsertions.some((other)=>jsonEquals(item, other))) continue;
      merged.push(item);
    }
  };
  for(let i = 0; i < base.length; i++){
    emitGroup(i);
    merged.push(base[i]);
  }
  emitGroup(base.length);
  return {
    ok: true,
    value: merged
  };
}
/** Merge two objects whose keys neither side deleted. */ function mergeObjects(base, ours, theirs, path) {
  for (const key of Object.keys(base)){
    if (!Object.hasOwn(ours, key) || !Object.hasOwn(theirs, key)) {
      return refuse(`${path}.${key} was deleted on one side`);
    }
  }
  const merged = {};
  // Base key order first, then each side's additions — base's side first.
  const keys = [
    ...Object.keys(base),
    ...Object.keys(theirs).filter((k)=>!Object.hasOwn(base, k)),
    ...Object.keys(ours).filter((k)=>!Object.hasOwn(base, k) && !Object.hasOwn(theirs, k))
  ];
  for (const key of keys){
    const inOurs = Object.hasOwn(ours, key);
    const inTheirs = Object.hasOwn(theirs, key);
    if (!inOurs) {
      merged[key] = theirs[key];
      continue;
    }
    if (!inTheirs) {
      merged[key] = ours[key];
      continue;
    }
    const value = mergeValue(Object.hasOwn(base, key) ? base[key] : undefined, ours[key], theirs[key], `${path}.${key}`);
    if (!value.ok) return value;
    merged[key] = value.value;
  }
  return {
    ok: true,
    value: merged
  };
}
/**
 * Merge one value three ways.
 *
 * `base` is `undefined` for a key both sides added, which is an insertion on
 * both sides rather than a change to anything.
 */ function mergeValue(base, ours, theirs, path) {
  if (jsonEquals(ours, theirs)) return {
    ok: true,
    value: ours
  };
  if (base !== undefined) {
    if (jsonEquals(ours, base)) return {
      ok: true,
      value: theirs
    };
    if (jsonEquals(theirs, base)) return {
      ok: true,
      value: ours
    };
    if (Array.isArray(base) && Array.isArray(ours) && Array.isArray(theirs)) {
      return mergeArrays(base, ours, theirs, path);
    }
    if (isObject(base) && isObject(ours) && isObject(theirs)) {
      return mergeObjects(base, ours, theirs, path);
    }
  }
  return refuse(`${path} was set to two different values, which is a decision this merge ` + `does not make`);
}
/** Parse one side, naming it in the refusal so the caller can say which. */ function parseSide(text, name) {
  try {
    return {
      ok: true,
      value: JSON.parse(text)
    };
  } catch (error) {
    return refuse(`the ${name} side is not valid JSON — ${error instanceof Error ? error.message : String(error)}`);
  }
}
/** The indent the document is written with, or `null` when it is not spaces. */ function detectIndent(text) {
  const match = text.match(/\n( +)\S/);
  return match ? match[1].length : null;
}
/**
 * Union two append-only JSON documents over their merge base.
 *
 * @param base - Merge-base text of the file.
 * @param ours - The PR branch's whole-file text.
 * @param theirs - The base branch's whole-file text.
 * @returns The merged document's text, or the reason it was refused.
 */ export function unionJsonInsertions(base, ours, theirs) {
  const parsedBase = parseSide(base, "base");
  if (!parsedBase.ok) return parsedBase;
  const parsedOurs = parseSide(ours, "ours");
  if (!parsedOurs.ok) return parsedOurs;
  const parsedTheirs = parseSide(theirs, "theirs");
  if (!parsedTheirs.ok) return parsedTheirs;
  const indent = detectIndent(base);
  if (indent === null) {
    return refuse("the merge base is not indented with spaces, so re-serialising it would " + "reformat the file");
  }
  const trailingNewline = base.endsWith("\n") ? "\n" : "";
  const serialise = (value)=>JSON.stringify(value, null, indent) + trailingNewline;
  // A document `JSON.parse` accepts can still exhaust the stack on the way
  // out, so the walk and the re-serialisation are guarded too: the caller
  // gets a refusal it can defer on, never a crash in the conflict pass.
  try {
    if (serialise(parsedBase.value) !== base) {
      return refuse("the merge base does not round-trip through JSON.stringify, so the " + "union would reformat lines neither side touched");
    }
    const merged = mergeValue(parsedBase.value, parsedOurs.value, parsedTheirs.value, "$");
    if (!merged.ok) return merged;
    return {
      ok: true,
      value: serialise(merged.value)
    };
  } catch (error) {
    return refuse(`the union could not be built — ${error instanceof Error ? error.message : String(error)}`);
  }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9qc29uX2luc2VydGlvbl91bmlvbi50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFN0cnVjdHVyZWQgdW5pb24gb2YgdHdvIGFwcGVuZC1vbmx5IEpTT04gZG9jdW1lbnRzIChJc3N1ZSAjMTk2OCkuXG4gKlxuICogVGhlIGFwcGVuZC1vbmx5IGxlZGdlciBydWxlIChgYm90aF9pbnNlcnRlZF9jb25mbGljdF9ydWxlLnRzYCkgcmVzb2x2ZXMgYVxuICogY29uZmxpY3QgYnkga2VlcGluZyBib3RoIHNpZGVzJyAqKnRleHQqKi4gRm9yIGBkb2NzL2F1ZGl0cy8qLmpzb25gIHRoYXQgZmFpbHNcbiAqIG9uIHRoZSBvbmUgc2hhcGUgdGhvc2UgZmlsZXMgYWN0dWFsbHkgcHJvZHVjZTogdHdvIGJyYW5jaGVzIHRoYXQgZWFjaCBhcHBlbmRcbiAqIGFuIG9iamVjdCB0byB0aGUgc2FtZSBhcnJheSBjb25mbGljdCAqaW5zaWRlKiB0aGUgb2JqZWN0LCBzbyBjb25jYXRlbmF0aW5nXG4gKiB0aGUgdHdvIGh1bmtzIHlpZWxkcyB0ZXh0IHRoYXQgaXMgbm90IEpTT04gYXQgYWxsLiBUaGUgcnVsZSB0aGVuIGRlZmVycywgYW5kXG4gKiB0aGUgcmVzb2x1dGlvbiBmYWxscyB0byBhIGhhbmQgbWVyZ2Ug4oCUIHdoaWNoIGlzIGhvdyBhIHN3ZWVwIHNsaWNlIHdhcyBkcm9wcGVkXG4gKiBhbmQgYG1haW5gIHdlbnQgcmVkIChJc3N1ZXMgIzE5NjYsICMxNjA5KS5cbiAqXG4gKiBUZXh0IGNhbm5vdCB1bmlvbiB0aG9zZSBzaWRlcywgYnV0IHRoZWlyICoqdmFsdWVzKiogY2FuLiBUaGlzIG1vZHVsZSBwYXJzZXNcbiAqIHRoZSBtZXJnZSBiYXNlIGFuZCBib3RoIHNpZGVzLCBtZXJnZXMgdGhlbSBzdHJ1Y3R1cmFsbHksIGFuZCByZS1zZXJpYWxpc2VzLlxuICogVGhlIHVuaW9uIGlzIHdlbGwtZm9ybWVkIGJ5IGNvbnN0cnVjdGlvbiwgc28gaXQgbmV2ZXIgd3JpdGVzIHRoZSBicm9rZW5cbiAqIGRvY3VtZW50IHRoZSB0ZXh0dWFsIHBhdGggaGFkIHRvIHJlZnVzZS5cbiAqXG4gKiAjIyBXaGF0IGl0IGFjY2VwdHMsIGFuZCB3aGF0IGl0IHJlZnVzZXNcbiAqXG4gKiBUaGUgbWVyZ2UgaXMgaW5zZXJ0aW9uLW9ubHksIGluIHRoZSBzYW1lIHNwaXJpdCBhcyB0aGUgcnVsZSB0aGF0IGNhbGxzIGl0OlxuICpcbiAqIC0gKipBcnJheXMqKiDigJQgdGhlIGJhc2UncyBpdGVtcyBtdXN0IHN0aWxsIGFwcGVhciwgaW4gb3JkZXIsIGluIGJvdGggc2lkZXMuXG4gKiAgIEVhY2ggc2lkZSdzIGV4dHJhIGl0ZW1zIGFyZSBrZXB0LCB0aGUgYmFzZSBicmFuY2gncyBmaXJzdC4gQW4gaXRlbSBib3RoXG4gKiAgIHNpZGVzIGFkZGVkIGlkZW50aWNhbGx5IGlzIGtlcHQgb25jZS4gSXRlbXMgYXJlIG1hdGNoZWQgYnkgdmFsdWUsIHNvIGFuXG4gKiAgIGVudHJ5IG9uZSBzaWRlICpyZXdyb3RlKiByZWFkcyBhcyBhIG1pc3NpbmcgYmFzZSBpdGVtIGFuZCBpcyByZWZ1c2VkOlxuICogICB3aGljaCByZXdyaXRlIHdpbnMgaXMgYSBqdWRnZW1lbnQsIGFuZCB0aGlzIG1lcmdlIG1ha2VzIG5vbmUuXG4gKiAtICoqT2JqZWN0cyoqIOKAlCBldmVyeSBrZXkgdGhlIGJhc2UgaGFkIG11c3Qgc3RpbGwgYmUgcHJlc2VudCBvbiBib3RoIHNpZGVzLlxuICogICBBIGtleSBvbmx5IG9uZSBzaWRlIGNoYW5nZWQgdGFrZXMgdGhhdCBzaWRlJ3MgdmFsdWU7IGEga2V5IGJvdGggc2lkZXNcbiAqICAgY2hhbmdlZCB0byBkaWZmZXJlbnQgdmFsdWVzIGlzIGEgY29uZmxpY3RpbmcgZWRpdCBhbmQgaXMgcmVmdXNlZC5cbiAqIC0gKipBbnl0aGluZyBlbHNlKiog4oCUIGEgc2NhbGFyIGJvdGggc2lkZXMgY2hhbmdlZCBkaWZmZXJlbnRseSwgYSB2YWx1ZSB3aG9zZVxuICogICB0eXBlIGNoYW5nZWQsIGEgZGVsZXRlZCBhcnJheSBpdGVtIG9yIG9iamVjdCBrZXk6IHJlZnVzZWQsIHdpdGggYSByZWFzb25cbiAqICAgbmFtaW5nIHRoZSBwYXRoLlxuICpcbiAqIEEgcmVmdXNhbCBpcyBhIGRlZmVycmFsIGJ5IHRoZSBjYWxsZXIsIG5ldmVyIGEgc2lsZW50IG9uZS1zaWRlZCBwaWNrLlxuICpcbiAqICMjIEZvcm1hdHRpbmdcbiAqXG4gKiBUaGUgcmVzdWx0IGlzIHJlLXNlcmlhbGlzZWQsIHNvIGl0IG11c3Qgbm90IHJlZm9ybWF0IHRoZSByZXN0IG9mIHRoZSBmaWxlLlxuICogVGhlIGd1YXJkIGlzIGV4YWN0OiB0aGUgbWVyZ2UgYmFzZSBpcyByZS1zZXJpYWxpc2VkIGZpcnN0IGFuZCBtdXN0IHJlcHJvZHVjZVxuICogaXRzIG93biB0ZXh0IGJ5dGUtZm9yLWJ5dGUuIFdoZW4gaXQgZG9lcyBub3Qg4oCUIGEgYC5qc29uY2Agd2l0aCBjb21tZW50cywgYVxuICogaGFuZC1jb21wYWN0ZWQgYXJyYXksIHRhYnMg4oCUIHRoZSB1bmlvbiBpcyByZWZ1c2VkIHJhdGhlciB0aGFuIHJld3JpdGluZyBhXG4gKiBmaWxlIHRoZSBhdXRob3IgZm9ybWF0dGVkIGRlbGliZXJhdGVseS5cbiAqXG4gKiBUaGUgbW9kdWxlIGlzIHB1cmUg4oCUIG5vIGdpdCwgbm8gbmV0d29yaywgbm8gZmlsZSBJL08uXG4gKlxuICogQXVzdHJhbGlhbiBFbmdsaXNoIGlzIHVzZWQgdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBzZXJpYWxpc2VkLCBvcmdhbmlzYXRpb24pLlxuICovXG5cbmltcG9ydCB0eXBlIHsgUmVzdWx0IH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5cbi8qKiBBbnkgdmFsdWUgYEpTT04ucGFyc2VgIGNhbiBwcm9kdWNlLiAqL1xuZXhwb3J0IHR5cGUgSnNvblZhbHVlID1cbiAgfCBudWxsXG4gIHwgYm9vbGVhblxuICB8IG51bWJlclxuICB8IHN0cmluZ1xuICB8IEpzb25WYWx1ZVtdXG4gIHwgeyBba2V5OiBzdHJpbmddOiBKc29uVmFsdWUgfTtcblxuLyoqIEFuIGBvazogZmFsc2VgIHJlc3VsdCwgc28gZXZlcnkgcmVmdXNhbCByZWFkcyB0aGUgc2FtZSB3YXkuICovXG5mdW5jdGlvbiByZWZ1c2U8VD4ocmVhc29uOiBzdHJpbmcpOiBSZXN1bHQ8VCwgc3RyaW5nPiB7XG4gIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IHJlYXNvbiB9O1xufVxuXG4vKiogV2hldGhlciBhIHZhbHVlIGlzIGEgSlNPTiBvYmplY3QgKG5vdCBhbiBhcnJheSwgbm90IG51bGwpLiAqL1xuZnVuY3Rpb24gaXNPYmplY3QodmFsdWU6IEpzb25WYWx1ZSk6IHZhbHVlIGlzIHsgW2tleTogc3RyaW5nXTogSnNvblZhbHVlIH0ge1xuICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSBcIm9iamVjdFwiICYmIHZhbHVlICE9PSBudWxsICYmICFBcnJheS5pc0FycmF5KHZhbHVlKTtcbn1cblxuLyoqXG4gKiBTdHJ1Y3R1cmFsIGVxdWFsaXR5IG9mIHR3byBKU09OIHZhbHVlcy5cbiAqXG4gKiBLZXkgKipvcmRlcioqIGlzIGRlbGliZXJhdGVseSBpZ25vcmVkOiB0d28gc2lkZXMgdGhhdCB3cm90ZSB0aGUgc2FtZSBlbnRyeVxuICogd2l0aCBpdHMgZmllbGRzIGluIGEgZGlmZmVyZW50IG9yZGVyIGFkZGVkIHRoZSBzYW1lIGVudHJ5LlxuICovXG5leHBvcnQgZnVuY3Rpb24ganNvbkVxdWFscyhhOiBKc29uVmFsdWUsIGI6IEpzb25WYWx1ZSk6IGJvb2xlYW4ge1xuICBpZiAoYSA9PT0gYikgcmV0dXJuIHRydWU7XG4gIGlmIChBcnJheS5pc0FycmF5KGEpIHx8IEFycmF5LmlzQXJyYXkoYikpIHtcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkoYSkgfHwgIUFycmF5LmlzQXJyYXkoYikgfHwgYS5sZW5ndGggIT09IGIubGVuZ3RoKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIHJldHVybiBhLmV2ZXJ5KChpdGVtLCBpKSA9PiBqc29uRXF1YWxzKGl0ZW0sIGJbaV0hKSk7XG4gIH1cbiAgaWYgKGlzT2JqZWN0KGEpICYmIGlzT2JqZWN0KGIpKSB7XG4gICAgY29uc3QgYUtleXMgPSBPYmplY3Qua2V5cyhhKTtcbiAgICBjb25zdCBiS2V5cyA9IE9iamVjdC5rZXlzKGIpO1xuICAgIGlmIChhS2V5cy5sZW5ndGggIT09IGJLZXlzLmxlbmd0aCkgcmV0dXJuIGZhbHNlO1xuICAgIHJldHVybiBhS2V5cy5ldmVyeSgoa2V5KSA9PlxuICAgICAgT2JqZWN0Lmhhc093bihiLCBrZXkpICYmIGpzb25FcXVhbHMoYVtrZXldISwgYltrZXldISlcbiAgICApO1xuICB9XG4gIHJldHVybiBmYWxzZTtcbn1cblxuLyoqIEl0ZW1zIG9uZSBzaWRlIGluc2VydGVkLCBncm91cGVkIGJ5IHRoZSBiYXNlIGluZGV4IHRoZXkgc2l0IGJlZm9yZS4gKi9cbnR5cGUgSW5zZXJ0aW9uR3JvdXBzID0gTWFwPG51bWJlciwgSnNvblZhbHVlW10+O1xuXG4vKipcbiAqIEFsaWduIGEgc2lkZSdzIGFycmF5IGFnYWluc3QgdGhlIGJhc2UgYW5kIHJldHVybiB3aGF0IGl0IGluc2VydGVkLlxuICpcbiAqIFJldHVybnMgYG51bGxgIHdoZW4gdGhlIGJhc2UgaXMgbm90IGEgc3Vic2VxdWVuY2Ugb2YgdGhlIHNpZGUg4oCUIHRoYXQgbWVhbnNcbiAqIGFuIGl0ZW0gd2FzIGRlbGV0ZWQgb3IgZWRpdGVkLCB3aGljaCB0aGlzIG1lcmdlIHJlZnVzZXMuXG4gKi9cbmZ1bmN0aW9uIGluc2VydGlvbnNBZ2FpbnN0QmFzZShcbiAgYmFzZTogcmVhZG9ubHkgSnNvblZhbHVlW10sXG4gIHNpZGU6IHJlYWRvbmx5IEpzb25WYWx1ZVtdLFxuKTogSW5zZXJ0aW9uR3JvdXBzIHwgbnVsbCB7XG4gIGNvbnN0IGdyb3VwczogSW5zZXJ0aW9uR3JvdXBzID0gbmV3IE1hcCgpO1xuICBsZXQgYmFzZUluZGV4ID0gMDtcbiAgZm9yIChjb25zdCBpdGVtIG9mIHNpZGUpIHtcbiAgICBpZiAoYmFzZUluZGV4IDwgYmFzZS5sZW5ndGggJiYganNvbkVxdWFscyhpdGVtLCBiYXNlW2Jhc2VJbmRleF0hKSkge1xuICAgICAgYmFzZUluZGV4Kys7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgZ3JvdXAgPSBncm91cHMuZ2V0KGJhc2VJbmRleCkgPz8gW107XG4gICAgZ3JvdXAucHVzaChpdGVtKTtcbiAgICBncm91cHMuc2V0KGJhc2VJbmRleCwgZ3JvdXApO1xuICB9XG4gIHJldHVybiBiYXNlSW5kZXggPT09IGJhc2UubGVuZ3RoID8gZ3JvdXBzIDogbnVsbDtcbn1cblxuLyoqXG4gKiBNZXJnZSB0d28gYXJyYXlzIHRoYXQgYm90aCBvbmx5IGluc2VydGVkIGludG8gdGhlIGJhc2UuXG4gKlxuICogYHRoZWlyc2AgaXMgZW1pdHRlZCBiZWZvcmUgYG91cnNgIGF0IGVhY2ggaW5zZXJ0aW9uIHBvaW50OiB0aGUgcGFzcyBydW5zXG4gKiBkdXJpbmcgYGdpdCBtZXJnZSBvcmlnaW4vPGJhc2U+YCBvbiB0aGUgUFIgYnJhbmNoLCBzbyBzdGFnZSAzIChcInRoZWlyc1wiKSBpc1xuICogdGhlIGJhc2UgYnJhbmNoJ3Mgc2lkZSwgYW5kIGEgbGVkZ2VyIHRoZW4gcmVhZHMgaW4gdGhlIG9yZGVyIHRoZSB0d28gYXV0aG9yc1xuICogd3JvdGUgaXQuXG4gKi9cbmZ1bmN0aW9uIG1lcmdlQXJyYXlzKFxuICBiYXNlOiByZWFkb25seSBKc29uVmFsdWVbXSxcbiAgb3VyczogcmVhZG9ubHkgSnNvblZhbHVlW10sXG4gIHRoZWlyczogcmVhZG9ubHkgSnNvblZhbHVlW10sXG4gIHBhdGg6IHN0cmluZyxcbik6IFJlc3VsdDxKc29uVmFsdWUsIHN0cmluZz4ge1xuICBjb25zdCBvdXJHcm91cHMgPSBpbnNlcnRpb25zQWdhaW5zdEJhc2UoYmFzZSwgb3Vycyk7XG4gIGNvbnN0IHRoZWlyR3JvdXBzID0gaW5zZXJ0aW9uc0FnYWluc3RCYXNlKGJhc2UsIHRoZWlycyk7XG4gIGlmIChvdXJHcm91cHMgPT09IG51bGwgfHwgdGhlaXJHcm91cHMgPT09IG51bGwpIHtcbiAgICByZXR1cm4gcmVmdXNlKFxuICAgICAgYCR7cGF0aH0gaXMgbm90IHR3byBwdXJlIGluc2VydGlvbnM6IGFuIGl0ZW0gdGhlIG1lcmdlIGJhc2UgaGFkIGlzIGAgK1xuICAgICAgICBgbWlzc2luZyBvciBjaGFuZ2VkIG9uIG9uZSBzaWRlYCxcbiAgICApO1xuICB9XG4gIGNvbnN0IG1lcmdlZDogSnNvblZhbHVlW10gPSBbXTtcbiAgLy8gQm90aCBzaWRlcyBhZGRpbmcgdGhlIHNhbWUgZW50cnkg4oCUIGEgY2hlcnJ5LXBpY2ssIG9yIGFuIGluc2VydGlvbiBvbmUgc2lkZVxuICAvLyBtZXJnZWQgY2xlYW5seSBhbmQgdGhlIG90aGVyIG1hZGUgaXRzZWxmIOKAlCBrZWVwcyBpdCBvbmNlLCB3aGVyZXZlciBpbiB0aGVcbiAgLy8gYXJyYXkgZWFjaCBzaWRlIGFuY2hvcmVkIGl0LlxuICBjb25zdCB0aGVpckluc2VydGlvbnMgPSBbLi4udGhlaXJHcm91cHMudmFsdWVzKCldLmZsYXQoKTtcbiAgY29uc3QgZW1pdEdyb3VwID0gKGluZGV4OiBudW1iZXIpOiB2b2lkID0+IHtcbiAgICBtZXJnZWQucHVzaCguLi50aGVpckdyb3Vwcy5nZXQoaW5kZXgpID8/IFtdKTtcbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2Ygb3VyR3JvdXBzLmdldChpbmRleCkgPz8gW10pIHtcbiAgICAgIGlmICh0aGVpckluc2VydGlvbnMuc29tZSgob3RoZXIpID0+IGpzb25FcXVhbHMoaXRlbSwgb3RoZXIpKSkgY29udGludWU7XG4gICAgICBtZXJnZWQucHVzaChpdGVtKTtcbiAgICB9XG4gIH07XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgYmFzZS5sZW5ndGg7IGkrKykge1xuICAgIGVtaXRHcm91cChpKTtcbiAgICBtZXJnZWQucHVzaChiYXNlW2ldISk7XG4gIH1cbiAgZW1pdEdyb3VwKGJhc2UubGVuZ3RoKTtcbiAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBtZXJnZWQgfTtcbn1cblxuLyoqIE1lcmdlIHR3byBvYmplY3RzIHdob3NlIGtleXMgbmVpdGhlciBzaWRlIGRlbGV0ZWQuICovXG5mdW5jdGlvbiBtZXJnZU9iamVjdHMoXG4gIGJhc2U6IHsgW2tleTogc3RyaW5nXTogSnNvblZhbHVlIH0sXG4gIG91cnM6IHsgW2tleTogc3RyaW5nXTogSnNvblZhbHVlIH0sXG4gIHRoZWlyczogeyBba2V5OiBzdHJpbmddOiBKc29uVmFsdWUgfSxcbiAgcGF0aDogc3RyaW5nLFxuKTogUmVzdWx0PEpzb25WYWx1ZSwgc3RyaW5nPiB7XG4gIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKGJhc2UpKSB7XG4gICAgaWYgKCFPYmplY3QuaGFzT3duKG91cnMsIGtleSkgfHwgIU9iamVjdC5oYXNPd24odGhlaXJzLCBrZXkpKSB7XG4gICAgICByZXR1cm4gcmVmdXNlKGAke3BhdGh9LiR7a2V5fSB3YXMgZGVsZXRlZCBvbiBvbmUgc2lkZWApO1xuICAgIH1cbiAgfVxuICBjb25zdCBtZXJnZWQ6IHsgW2tleTogc3RyaW5nXTogSnNvblZhbHVlIH0gPSB7fTtcbiAgLy8gQmFzZSBrZXkgb3JkZXIgZmlyc3QsIHRoZW4gZWFjaCBzaWRlJ3MgYWRkaXRpb25zIOKAlCBiYXNlJ3Mgc2lkZSBmaXJzdC5cbiAgY29uc3Qga2V5cyA9IFtcbiAgICAuLi5PYmplY3Qua2V5cyhiYXNlKSxcbiAgICAuLi5PYmplY3Qua2V5cyh0aGVpcnMpLmZpbHRlcigoaykgPT4gIU9iamVjdC5oYXNPd24oYmFzZSwgaykpLFxuICAgIC4uLk9iamVjdC5rZXlzKG91cnMpLmZpbHRlcigoaykgPT5cbiAgICAgICFPYmplY3QuaGFzT3duKGJhc2UsIGspICYmICFPYmplY3QuaGFzT3duKHRoZWlycywgaylcbiAgICApLFxuICBdO1xuICBmb3IgKGNvbnN0IGtleSBvZiBrZXlzKSB7XG4gICAgY29uc3QgaW5PdXJzID0gT2JqZWN0Lmhhc093bihvdXJzLCBrZXkpO1xuICAgIGNvbnN0IGluVGhlaXJzID0gT2JqZWN0Lmhhc093bih0aGVpcnMsIGtleSk7XG4gICAgaWYgKCFpbk91cnMpIHtcbiAgICAgIG1lcmdlZFtrZXldID0gdGhlaXJzW2tleV0hO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmICghaW5UaGVpcnMpIHtcbiAgICAgIG1lcmdlZFtrZXldID0gb3Vyc1trZXldITtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCB2YWx1ZSA9IG1lcmdlVmFsdWUoXG4gICAgICBPYmplY3QuaGFzT3duKGJhc2UsIGtleSkgPyBiYXNlW2tleV0hIDogdW5kZWZpbmVkLFxuICAgICAgb3Vyc1trZXldISxcbiAgICAgIHRoZWlyc1trZXldISxcbiAgICAgIGAke3BhdGh9LiR7a2V5fWAsXG4gICAgKTtcbiAgICBpZiAoIXZhbHVlLm9rKSByZXR1cm4gdmFsdWU7XG4gICAgbWVyZ2VkW2tleV0gPSB2YWx1ZS52YWx1ZTtcbiAgfVxuICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IG1lcmdlZCB9O1xufVxuXG4vKipcbiAqIE1lcmdlIG9uZSB2YWx1ZSB0aHJlZSB3YXlzLlxuICpcbiAqIGBiYXNlYCBpcyBgdW5kZWZpbmVkYCBmb3IgYSBrZXkgYm90aCBzaWRlcyBhZGRlZCwgd2hpY2ggaXMgYW4gaW5zZXJ0aW9uIG9uXG4gKiBib3RoIHNpZGVzIHJhdGhlciB0aGFuIGEgY2hhbmdlIHRvIGFueXRoaW5nLlxuICovXG5mdW5jdGlvbiBtZXJnZVZhbHVlKFxuICBiYXNlOiBKc29uVmFsdWUgfCB1bmRlZmluZWQsXG4gIG91cnM6IEpzb25WYWx1ZSxcbiAgdGhlaXJzOiBKc29uVmFsdWUsXG4gIHBhdGg6IHN0cmluZyxcbik6IFJlc3VsdDxKc29uVmFsdWUsIHN0cmluZz4ge1xuICBpZiAoanNvbkVxdWFscyhvdXJzLCB0aGVpcnMpKSByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IG91cnMgfTtcbiAgaWYgKGJhc2UgIT09IHVuZGVmaW5lZCkge1xuICAgIGlmIChqc29uRXF1YWxzKG91cnMsIGJhc2UpKSByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHRoZWlycyB9O1xuICAgIGlmIChqc29uRXF1YWxzKHRoZWlycywgYmFzZSkpIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogb3VycyB9O1xuICAgIGlmIChBcnJheS5pc0FycmF5KGJhc2UpICYmIEFycmF5LmlzQXJyYXkob3VycykgJiYgQXJyYXkuaXNBcnJheSh0aGVpcnMpKSB7XG4gICAgICByZXR1cm4gbWVyZ2VBcnJheXMoYmFzZSwgb3VycywgdGhlaXJzLCBwYXRoKTtcbiAgICB9XG4gICAgaWYgKGlzT2JqZWN0KGJhc2UpICYmIGlzT2JqZWN0KG91cnMpICYmIGlzT2JqZWN0KHRoZWlycykpIHtcbiAgICAgIHJldHVybiBtZXJnZU9iamVjdHMoYmFzZSwgb3VycywgdGhlaXJzLCBwYXRoKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHJlZnVzZShcbiAgICBgJHtwYXRofSB3YXMgc2V0IHRvIHR3byBkaWZmZXJlbnQgdmFsdWVzLCB3aGljaCBpcyBhIGRlY2lzaW9uIHRoaXMgbWVyZ2UgYCArXG4gICAgICBgZG9lcyBub3QgbWFrZWAsXG4gICk7XG59XG5cbi8qKiBQYXJzZSBvbmUgc2lkZSwgbmFtaW5nIGl0IGluIHRoZSByZWZ1c2FsIHNvIHRoZSBjYWxsZXIgY2FuIHNheSB3aGljaC4gKi9cbmZ1bmN0aW9uIHBhcnNlU2lkZSh0ZXh0OiBzdHJpbmcsIG5hbWU6IHN0cmluZyk6IFJlc3VsdDxKc29uVmFsdWUsIHN0cmluZz4ge1xuICB0cnkge1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogSlNPTi5wYXJzZSh0ZXh0KSBhcyBKc29uVmFsdWUgfTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICByZXR1cm4gcmVmdXNlKFxuICAgICAgYHRoZSAke25hbWV9IHNpZGUgaXMgbm90IHZhbGlkIEpTT04g4oCUICR7XG4gICAgICAgIGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKVxuICAgICAgfWAsXG4gICAgKTtcbiAgfVxufVxuXG4vKiogVGhlIGluZGVudCB0aGUgZG9jdW1lbnQgaXMgd3JpdHRlbiB3aXRoLCBvciBgbnVsbGAgd2hlbiBpdCBpcyBub3Qgc3BhY2VzLiAqL1xuZnVuY3Rpb24gZGV0ZWN0SW5kZW50KHRleHQ6IHN0cmluZyk6IG51bWJlciB8IG51bGwge1xuICBjb25zdCBtYXRjaCA9IHRleHQubWF0Y2goL1xcbiggKylcXFMvKTtcbiAgcmV0dXJuIG1hdGNoID8gbWF0Y2hbMV0hLmxlbmd0aCA6IG51bGw7XG59XG5cbi8qKlxuICogVW5pb24gdHdvIGFwcGVuZC1vbmx5IEpTT04gZG9jdW1lbnRzIG92ZXIgdGhlaXIgbWVyZ2UgYmFzZS5cbiAqXG4gKiBAcGFyYW0gYmFzZSAtIE1lcmdlLWJhc2UgdGV4dCBvZiB0aGUgZmlsZS5cbiAqIEBwYXJhbSBvdXJzIC0gVGhlIFBSIGJyYW5jaCdzIHdob2xlLWZpbGUgdGV4dC5cbiAqIEBwYXJhbSB0aGVpcnMgLSBUaGUgYmFzZSBicmFuY2gncyB3aG9sZS1maWxlIHRleHQuXG4gKiBAcmV0dXJucyBUaGUgbWVyZ2VkIGRvY3VtZW50J3MgdGV4dCwgb3IgdGhlIHJlYXNvbiBpdCB3YXMgcmVmdXNlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHVuaW9uSnNvbkluc2VydGlvbnMoXG4gIGJhc2U6IHN0cmluZyxcbiAgb3Vyczogc3RyaW5nLFxuICB0aGVpcnM6IHN0cmluZyxcbik6IFJlc3VsdDxzdHJpbmcsIHN0cmluZz4ge1xuICBjb25zdCBwYXJzZWRCYXNlID0gcGFyc2VTaWRlKGJhc2UsIFwiYmFzZVwiKTtcbiAgaWYgKCFwYXJzZWRCYXNlLm9rKSByZXR1cm4gcGFyc2VkQmFzZTtcbiAgY29uc3QgcGFyc2VkT3VycyA9IHBhcnNlU2lkZShvdXJzLCBcIm91cnNcIik7XG4gIGlmICghcGFyc2VkT3Vycy5vaykgcmV0dXJuIHBhcnNlZE91cnM7XG4gIGNvbnN0IHBhcnNlZFRoZWlycyA9IHBhcnNlU2lkZSh0aGVpcnMsIFwidGhlaXJzXCIpO1xuICBpZiAoIXBhcnNlZFRoZWlycy5vaykgcmV0dXJuIHBhcnNlZFRoZWlycztcblxuICBjb25zdCBpbmRlbnQgPSBkZXRlY3RJbmRlbnQoYmFzZSk7XG4gIGlmIChpbmRlbnQgPT09IG51bGwpIHtcbiAgICByZXR1cm4gcmVmdXNlKFxuICAgICAgXCJ0aGUgbWVyZ2UgYmFzZSBpcyBub3QgaW5kZW50ZWQgd2l0aCBzcGFjZXMsIHNvIHJlLXNlcmlhbGlzaW5nIGl0IHdvdWxkIFwiICtcbiAgICAgICAgXCJyZWZvcm1hdCB0aGUgZmlsZVwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgdHJhaWxpbmdOZXdsaW5lID0gYmFzZS5lbmRzV2l0aChcIlxcblwiKSA/IFwiXFxuXCIgOiBcIlwiO1xuICBjb25zdCBzZXJpYWxpc2UgPSAodmFsdWU6IEpzb25WYWx1ZSk6IHN0cmluZyA9PlxuICAgIEpTT04uc3RyaW5naWZ5KHZhbHVlLCBudWxsLCBpbmRlbnQpICsgdHJhaWxpbmdOZXdsaW5lO1xuICAvLyBBIGRvY3VtZW50IGBKU09OLnBhcnNlYCBhY2NlcHRzIGNhbiBzdGlsbCBleGhhdXN0IHRoZSBzdGFjayBvbiB0aGUgd2F5XG4gIC8vIG91dCwgc28gdGhlIHdhbGsgYW5kIHRoZSByZS1zZXJpYWxpc2F0aW9uIGFyZSBndWFyZGVkIHRvbzogdGhlIGNhbGxlclxuICAvLyBnZXRzIGEgcmVmdXNhbCBpdCBjYW4gZGVmZXIgb24sIG5ldmVyIGEgY3Jhc2ggaW4gdGhlIGNvbmZsaWN0IHBhc3MuXG4gIHRyeSB7XG4gICAgaWYgKHNlcmlhbGlzZShwYXJzZWRCYXNlLnZhbHVlKSAhPT0gYmFzZSkge1xuICAgICAgcmV0dXJuIHJlZnVzZShcbiAgICAgICAgXCJ0aGUgbWVyZ2UgYmFzZSBkb2VzIG5vdCByb3VuZC10cmlwIHRocm91Z2ggSlNPTi5zdHJpbmdpZnksIHNvIHRoZSBcIiArXG4gICAgICAgICAgXCJ1bmlvbiB3b3VsZCByZWZvcm1hdCBsaW5lcyBuZWl0aGVyIHNpZGUgdG91Y2hlZFwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgbWVyZ2VkID0gbWVyZ2VWYWx1ZShcbiAgICAgIHBhcnNlZEJhc2UudmFsdWUsXG4gICAgICBwYXJzZWRPdXJzLnZhbHVlLFxuICAgICAgcGFyc2VkVGhlaXJzLnZhbHVlLFxuICAgICAgXCIkXCIsXG4gICAgKTtcbiAgICBpZiAoIW1lcmdlZC5vaykgcmV0dXJuIG1lcmdlZDtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHNlcmlhbGlzZShtZXJnZWQudmFsdWUpIH07XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgcmV0dXJuIHJlZnVzZShcbiAgICAgIGB0aGUgdW5pb24gY291bGQgbm90IGJlIGJ1aWx0IOKAlCAke1xuICAgICAgICBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcilcbiAgICAgIH1gLFxuICAgICk7XG4gIH1cbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBNkNDLEdBYUQsZ0VBQWdFLEdBQ2hFLFNBQVMsT0FBVSxNQUFjO0VBQy9CLE9BQU87SUFBRSxJQUFJO0lBQU8sT0FBTztFQUFPO0FBQ3BDO0FBRUEsK0RBQStELEdBQy9ELFNBQVMsU0FBUyxLQUFnQjtFQUNoQyxPQUFPLE9BQU8sVUFBVSxZQUFZLFVBQVUsUUFBUSxDQUFDLE1BQU0sT0FBTyxDQUFDO0FBQ3ZFO0FBRUE7Ozs7O0NBS0MsR0FDRCxPQUFPLFNBQVMsV0FBVyxDQUFZLEVBQUUsQ0FBWTtFQUNuRCxJQUFJLE1BQU0sR0FBRyxPQUFPO0VBQ3BCLElBQUksTUFBTSxP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
// denoCacheMetadata=6023053372788870690,2747713063121297592