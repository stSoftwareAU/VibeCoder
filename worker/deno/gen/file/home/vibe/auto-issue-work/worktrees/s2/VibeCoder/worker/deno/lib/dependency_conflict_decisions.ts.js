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
 */ // ---------------------------------------------------------------------------
// Entry-line parsing
// ---------------------------------------------------------------------------
/** `"key": "value"` with an optional trailing comma — JSON manifests. */ const JSON_ENTRY = /^[ \t]*"((?:[^"\\]|\\.)*)"[ \t]*:[ \t]*"((?:[^"\\]|\\.)*)"[ \t]*,?[ \t]*$/;
/** `key = "value"` — a Cargo short-form dependency. */ const TOML_SHORT_ENTRY = /^[ \t]*([A-Za-z0-9_.\-]+)[ \t]*=[ \t]*"([^"]*)"[ \t]*$/;
/** `key = { ... }` — a Cargo inline table; only its `version` is reported. */ const TOML_TABLE_ENTRY = /^[ \t]*([A-Za-z0-9_.\-]+)[ \t]*=[ \t]*\{(.*)\}[ \t]*$/;
/** `version = "x"` inside an inline table. */ const TOML_TABLE_VERSION = /(?:^|[,{])[ \t]*version[ \t]*=[ \t]*"([^"]*)"/;
/** `module vX.Y.Z` with an optional `require` keyword — go.mod. */ const GO_REQUIRE_ENTRY = /^[ \t]*(?:require[ \t]+)?([^\s"'/][^\s"']*)[ \t]+(v[^\s]+)[ \t]*(?:\/\/.*)?$/;
/** Decode a JSON string body, falling back to the raw text. */ function decodeLiteral(literal) {
  try {
    return JSON.parse(`"${literal}"`);
  } catch  {
    return literal;
  }
}
/**
 * Parse one line as a dependency entry, or null when it is not one.
 *
 * Covers the shapes the registered rules can resolve — JSON maps, Cargo short
 * and inline-table entries, and `go.mod` require lines — so a decision report
 * stays ecosystem-agnostic as more rules are registered.
 */ export function parseDependencyEntryLine(line) {
  const text = line.replace(/\r?\n$/, "");
  const json = text.match(JSON_ENTRY);
  if (json) {
    return {
      key: decodeLiteral(json[1]),
      value: decodeLiteral(json[2])
    };
  }
  const short = text.match(TOML_SHORT_ENTRY);
  if (short) return {
    key: short[1],
    value: short[2]
  };
  const table = text.match(TOML_TABLE_ENTRY);
  if (table) {
    const version = table[2].match(TOML_TABLE_VERSION);
    return {
      key: table[1],
      value: version ? version[1] : table[2].trim()
    };
  }
  const go = text.match(GO_REQUIRE_ENTRY);
  if (go) return {
    key: go[1],
    value: go[2]
  };
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
 */ function splitHunkResolutions(segments, resolvedText) {
  const resolutions = [];
  let cursor = 0;
  for(let i = 0; i < segments.length; i++){
    const segment = segments[i];
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
/** Split text into lines, each keeping its own trailing newline. */ function splitLines(text) {
  return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}
function readSide(text) {
  const byKey = new Map();
  const unkeyed = [];
  for (const line of splitLines(text)){
    const entry = parseDependencyEntryLine(line);
    if (entry) {
      byKey.set(entry.key, entry.value);
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.length > 0) unkeyed.push(trimmed);
  }
  return {
    byKey,
    unkeyed
  };
}
/** Decisions for one hunk: kept order first, then keys only a side carried. */ function decisionsForHunk(ours, theirs, kept) {
  const o = readSide(ours);
  const t = readSide(theirs);
  const k = readSide(kept);
  const decisions = [];
  const keys = [
    ...k.byKey.keys()
  ];
  for (const key of [
    ...o.byKey.keys(),
    ...t.byKey.keys()
  ]){
    if (!keys.includes(key)) keys.push(key);
  }
  for (const key of keys){
    const ourValue = o.byKey.get(key) ?? null;
    const theirValue = t.byKey.get(key) ?? null;
    const keptValue = k.byKey.get(key) ?? null;
    if (ourValue === theirValue && theirValue === keptValue) continue;
    decisions.push({
      key,
      ours: ourValue,
      theirs: theirValue,
      kept: keptValue
    });
  }
  // Lines no parser recognised still changed the tree, so they are reported
  // rather than silently dropped from the audit trail.
  for (const line of k.unkeyed){
    if (o.unkeyed.includes(line)) continue;
    decisions.push({
      key: null,
      ours: null,
      theirs: t.unkeyed.includes(line) ? line : null,
      kept: line
    });
  }
  for (const line of o.unkeyed){
    if (k.unkeyed.includes(line)) continue;
    decisions.push({
      key: null,
      ours: line,
      theirs: t.unkeyed.includes(line) ? line : null,
      kept: null
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
 */ export function extractDependencyDecisions(segments, resolvedText) {
  const resolutions = splitHunkResolutions(segments, resolvedText);
  if (resolutions === null) return null;
  const decisions = [];
  let index = 0;
  for (const segment of segments){
    if (segment.kind !== "conflict") continue;
    decisions.push(...decisionsForHunk(segment.ours, segment.theirs, resolutions[index]));
    index++;
  }
  return decisions;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9kZXBlbmRlbmN5X2NvbmZsaWN0X2RlY2lzaW9ucy50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFBlci1kZXBlbmRlbmN5IGRlY2lzaW9uIHJlcG9ydGluZyBmb3IgcnVsZS1yZXNvbHZlZCBjb25mbGljdHMgKElzc3VlICM0NjYpLlxuICpcbiAqIFRoZSBkZXRlcm1pbmlzdGljIHBhc3MgaW4gYGRlcGVuZGVuY3lfY29uZmxpY3RfYXBwbHkudHNgIHJlc29sdmVzIGFcbiAqIGRlcGVuZGVuY3ktdmVyc2lvbiBjb25mbGljdCB3aXRob3V0IGFza2luZyB0aGUgQUkgYW55dGhpbmcuIFRoYXQgaXMgYVxuICogZG9jdW1lbnRlZCBjYXJ2ZS1vdXQgZnJvbSB0aGUgbmV2ZXItc2lkZS1waWNrIGNvbnRyYWN0LCBzbyB0aGUgUFIgY29tbWVudCBoYXNcbiAqIHRvIHNheSAqKndoYXQqKiBpdCBkZWNpZGVkOiB3aGljaCBkZXBlbmRlbmN5IGNoYW5nZWQsIHdoYXQgZWFjaCBzaWRlIGNhcnJpZWQsXG4gKiBhbmQgd2hpY2ggdmFsdWUgZW5kZWQgdXAgaW4gdGhlIHRyZWUuXG4gKlxuICogVGhlIGRlY2lzaW9ucyBhcmUgZGVyaXZlZCBmcm9tIHRoZSBydWxlJ3MgKmFjdHVhbCogb3V0cHV0IHJhdGhlciB0aGFuXG4gKiByZS1kZXJpdmluZyB0aGUgY29tcGFyaXNvbiwgc28gdGhlIGNvbW1lbnQgY2FuIG5ldmVyIGRlc2NyaWJlIGEgcGljayB0aGVcbiAqIHJ1bGVzIGRpZCBub3QgbWFrZS4gQSBydWxlIHJlcGxhY2VzIGNvbmZsaWN0IGh1bmtzIGFuZCByZS1lbWl0cyBldmVyeSBsaXRlcmFsXG4gKiBzZWdtZW50IHZlcmJhdGltLCBzbyB0aGUgcmVzb2x2ZWQgdGV4dCBjYW4gYmUgc3BsaXQgYmFjayBpbnRvIFwidGhlIHRleHQgdGhhdFxuICogcmVwbGFjZWQgaHVuayBOXCIgYnkgYW5jaG9yaW5nIG9uIHRob3NlIGxpdGVyYWxzLiBXaGVuIHRoZSB0ZXh0IGNhbm5vdCBiZVxuICogc3BsaXQgdGhhdCB3YXkg4oCUIGFkamFjZW50IGh1bmtzIHdpdGggbm8gbGl0ZXJhbCBiZXR3ZWVuIHRoZW0sIG9yIGEgcnVsZSB0aGF0XG4gKiByZXdyb3RlIGEgbGl0ZXJhbCDigJQgdGhlIGV4dHJhY3RvciByZXR1cm5zIGBudWxsYCAoXCJjYW5ub3QgYXR0cmlidXRlXCIpIGluc3RlYWRcbiAqIG9mIGd1ZXNzaW5nLlxuICpcbiAqIFRoZSBtb2R1bGUgaXMgcHVyZSDigJQgbm8gZ2l0LCBubyBuZXR3b3JrLCBubyBmaWxlIEkvTy5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IENvbmZsaWN0U2VnbWVudCB9IGZyb20gXCIuL2RlcGVuZGVuY3lfY29uZmxpY3RfcnVsZXMudHNcIjtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBUeXBlc1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogT25lIGRlcGVuZGVuY3kgdGhlIHJ1bGVzIGRlY2lkZWQuXG4gKlxuICogYG51bGxgIG1lYW5zIFwidGhpcyBzaWRlIGRpZCBub3QgY2FycnkgdGhlIGtleVwiLiBBIGRlY2lzaW9uIGlzIG9ubHkgcmVwb3J0ZWRcbiAqIHdoZW4gdGhlIHRocmVlIHZhbHVlcyBhcmUgbm90IGFsbCBpZGVudGljYWwg4oCUIGFuIHVudG91Y2hlZCBkZXBlbmRlbmN5IGlzIG5vdFxuICogYSBkZWNpc2lvbiBhIHJldmlld2VyIG5lZWRzIHRvIGF1ZGl0LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIERlcGVuZGVuY3lEZWNpc2lvbiB7XG4gIC8qKiBEZXBlbmRlbmN5IGtleSwgb3IgbnVsbCBmb3IgYSBsaW5lIG5vIGVudHJ5IHBhcnNlciByZWNvZ25pc2VkLiAqL1xuICBrZXk6IHN0cmluZyB8IG51bGw7XG4gIC8qKiBUaGUgdmFsdWUgb24gdGhlIFBSIGJyYW5jaCdzIHNpZGUgb2YgdGhlIGNvbmZsaWN0LiAqL1xuICBvdXJzOiBzdHJpbmcgfCBudWxsO1xuICAvKiogVGhlIHZhbHVlIG9uIHRoZSBiYXNlIGJyYW5jaCdzIHNpZGUgb2YgdGhlIGNvbmZsaWN0LiAqL1xuICB0aGVpcnM6IHN0cmluZyB8IG51bGw7XG4gIC8qKiBUaGUgdmFsdWUgdGhlIHJ1bGVzIGxlZnQgaW4gdGhlIHRyZWUuICovXG4gIGtlcHQ6IHN0cmluZyB8IG51bGw7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gRW50cnktbGluZSBwYXJzaW5nXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqIGBcImtleVwiOiBcInZhbHVlXCJgIHdpdGggYW4gb3B0aW9uYWwgdHJhaWxpbmcgY29tbWEg4oCUIEpTT04gbWFuaWZlc3RzLiAqL1xuY29uc3QgSlNPTl9FTlRSWSA9XG4gIC9eWyBcXHRdKlwiKCg/OlteXCJcXFxcXXxcXFxcLikqKVwiWyBcXHRdKjpbIFxcdF0qXCIoKD86W15cIlxcXFxdfFxcXFwuKSopXCJbIFxcdF0qLD9bIFxcdF0qJC87XG5cbi8qKiBga2V5ID0gXCJ2YWx1ZVwiYCDigJQgYSBDYXJnbyBzaG9ydC1mb3JtIGRlcGVuZGVuY3kuICovXG5jb25zdCBUT01MX1NIT1JUX0VOVFJZID1cbiAgL15bIFxcdF0qKFtBLVphLXowLTlfLlxcLV0rKVsgXFx0XSo9WyBcXHRdKlwiKFteXCJdKilcIlsgXFx0XSokLztcblxuLyoqIGBrZXkgPSB7IC4uLiB9YCDigJQgYSBDYXJnbyBpbmxpbmUgdGFibGU7IG9ubHkgaXRzIGB2ZXJzaW9uYCBpcyByZXBvcnRlZC4gKi9cbmNvbnN0IFRPTUxfVEFCTEVfRU5UUlkgPVxuICAvXlsgXFx0XSooW0EtWmEtejAtOV8uXFwtXSspWyBcXHRdKj1bIFxcdF0qXFx7KC4qKVxcfVsgXFx0XSokLztcblxuLyoqIGB2ZXJzaW9uID0gXCJ4XCJgIGluc2lkZSBhbiBpbmxpbmUgdGFibGUuICovXG5jb25zdCBUT01MX1RBQkxFX1ZFUlNJT04gPSAvKD86XnxbLHtdKVsgXFx0XSp2ZXJzaW9uWyBcXHRdKj1bIFxcdF0qXCIoW15cIl0qKVwiLztcblxuLyoqIGBtb2R1bGUgdlguWS5aYCB3aXRoIGFuIG9wdGlvbmFsIGByZXF1aXJlYCBrZXl3b3JkIOKAlCBnby5tb2QuICovXG5jb25zdCBHT19SRVFVSVJFX0VOVFJZID1cbiAgL15bIFxcdF0qKD86cmVxdWlyZVsgXFx0XSspPyhbXlxcc1wiJy9dW15cXHNcIiddKilbIFxcdF0rKHZbXlxcc10rKVsgXFx0XSooPzpcXC9cXC8uKik/JC87XG5cbi8qKiBEZWNvZGUgYSBKU09OIHN0cmluZyBib2R5LCBmYWxsaW5nIGJhY2sgdG8gdGhlIHJhdyB0ZXh0LiAqL1xuZnVuY3Rpb24gZGVjb2RlTGl0ZXJhbChsaXRlcmFsOiBzdHJpbmcpOiBzdHJpbmcge1xuICB0cnkge1xuICAgIHJldHVybiBKU09OLnBhcnNlKGBcIiR7bGl0ZXJhbH1cImApIGFzIHN0cmluZztcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGxpdGVyYWw7XG4gIH1cbn1cblxuLyoqXG4gKiBQYXJzZSBvbmUgbGluZSBhcyBhIGRlcGVuZGVuY3kgZW50cnksIG9yIG51bGwgd2hlbiBpdCBpcyBub3Qgb25lLlxuICpcbiAqIENvdmVycyB0aGUgc2hhcGVzIHRoZSByZWdpc3RlcmVkIHJ1bGVzIGNhbiByZXNvbHZlIOKAlCBKU09OIG1hcHMsIENhcmdvIHNob3J0XG4gKiBhbmQgaW5saW5lLXRhYmxlIGVudHJpZXMsIGFuZCBgZ28ubW9kYCByZXF1aXJlIGxpbmVzIOKAlCBzbyBhIGRlY2lzaW9uIHJlcG9ydFxuICogc3RheXMgZWNvc3lzdGVtLWFnbm9zdGljIGFzIG1vcmUgcnVsZXMgYXJlIHJlZ2lzdGVyZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZURlcGVuZGVuY3lFbnRyeUxpbmUoXG4gIGxpbmU6IHN0cmluZyxcbik6IHsga2V5OiBzdHJpbmc7IHZhbHVlOiBzdHJpbmcgfSB8IG51bGwge1xuICBjb25zdCB0ZXh0ID0gbGluZS5yZXBsYWNlKC9cXHI/XFxuJC8sIFwiXCIpO1xuXG4gIGNvbnN0IGpzb24gPSB0ZXh0Lm1hdGNoKEpTT05fRU5UUlkpO1xuICBpZiAoanNvbikge1xuICAgIHJldHVybiB7XG4gICAgICBrZXk6IGRlY29kZUxpdGVyYWwoanNvblsxXSEpLFxuICAgICAgdmFsdWU6IGRlY29kZUxpdGVyYWwoanNvblsyXSEpLFxuICAgIH07XG4gIH1cblxuICBjb25zdCBzaG9ydCA9IHRleHQubWF0Y2goVE9NTF9TSE9SVF9FTlRSWSk7XG4gIGlmIChzaG9ydCkgcmV0dXJuIHsga2V5OiBzaG9ydFsxXSEsIHZhbHVlOiBzaG9ydFsyXSEgfTtcblxuICBjb25zdCB0YWJsZSA9IHRleHQubWF0Y2goVE9NTF9UQUJMRV9FTlRSWSk7XG4gIGlmICh0YWJsZSkge1xuICAgIGNvbnN0IHZlcnNpb24gPSB0YWJsZVsyXSEubWF0Y2goVE9NTF9UQUJMRV9WRVJTSU9OKTtcbiAgICByZXR1cm4geyBrZXk6IHRhYmxlWzFdISwgdmFsdWU6IHZlcnNpb24gPyB2ZXJzaW9uWzFdISA6IHRhYmxlWzJdIS50cmltKCkgfTtcbiAgfVxuXG4gIGNvbnN0IGdvID0gdGV4dC5tYXRjaChHT19SRVFVSVJFX0VOVFJZKTtcbiAgaWYgKGdvKSByZXR1cm4geyBrZXk6IGdvWzFdISwgdmFsdWU6IGdvWzJdISB9O1xuXG4gIHJldHVybiBudWxsO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFNwbGl0dGluZyB0aGUgcmVzb2x2ZWQgdGV4dCBiYWNrIGludG8gcGVyLWh1bmsgcmVzb2x1dGlvbnNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKipcbiAqIFNwbGl0IGByZXNvbHZlZFRleHRgIGludG8gdGhlIHRleHQgdGhhdCByZXBsYWNlZCBlYWNoIGNvbmZsaWN0IGh1bmsuXG4gKlxuICogUmV0dXJucyBudWxsIHdoZW4gdGhlIHRleHQgY2Fubm90IGJlIGF0dHJpYnV0ZWQg4oCUIHRoZSBjYWxsZXIgdGhlbiByZXBvcnRzIHRoZVxuICogZmlsZSBhcyByZXNvbHZlZCB3aXRoIHVua25vd24gZGVjaXNpb25zIHJhdGhlciB0aGFuIGEgd3Jvbmcgb25lLlxuICovXG5mdW5jdGlvbiBzcGxpdEh1bmtSZXNvbHV0aW9ucyhcbiAgc2VnbWVudHM6IHJlYWRvbmx5IENvbmZsaWN0U2VnbWVudFtdLFxuICByZXNvbHZlZFRleHQ6IHN0cmluZyxcbik6IHN0cmluZ1tdIHwgbnVsbCB7XG4gIGNvbnN0IHJlc29sdXRpb25zOiBzdHJpbmdbXSA9IFtdO1xuICBsZXQgY3Vyc29yID0gMDtcblxuICBmb3IgKGxldCBpID0gMDsgaSA8IHNlZ21lbnRzLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3Qgc2VnbWVudCA9IHNlZ21lbnRzW2ldITtcblxuICAgIGlmIChzZWdtZW50LmtpbmQgPT09IFwibGl0ZXJhbFwiKSB7XG4gICAgICBpZiAoIXJlc29sdmVkVGV4dC5zdGFydHNXaXRoKHNlZ21lbnQudGV4dCwgY3Vyc29yKSkgcmV0dXJuIG51bGw7XG4gICAgICBjdXJzb3IgKz0gc2VnbWVudC50ZXh0Lmxlbmd0aDtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGNvbnN0IG5leHQgPSBzZWdtZW50c1tpICsgMV07XG4gICAgaWYgKG5leHQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgcmVzb2x1dGlvbnMucHVzaChyZXNvbHZlZFRleHQuc2xpY2UoY3Vyc29yKSk7XG4gICAgICBjdXJzb3IgPSByZXNvbHZlZFRleHQubGVuZ3RoO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIC8vIFR3byBodW5rcyBpbiBhIHJvdyBoYXZlIG5vIGFuY2hvciBiZXR3ZWVuIHRoZW0sIHNvIHRoZSBib3VuZGFyeSBpc1xuICAgIC8vIGdlbnVpbmVseSBhbWJpZ3VvdXMuXG4gICAgaWYgKG5leHQua2luZCAhPT0gXCJsaXRlcmFsXCIpIHJldHVybiBudWxsO1xuXG4gICAgY29uc3QgYXQgPSByZXNvbHZlZFRleHQuaW5kZXhPZihuZXh0LnRleHQsIGN1cnNvcik7XG4gICAgaWYgKGF0IDwgMCkgcmV0dXJuIG51bGw7XG4gICAgcmVzb2x1dGlvbnMucHVzaChyZXNvbHZlZFRleHQuc2xpY2UoY3Vyc29yLCBhdCkpO1xuICAgIGN1cnNvciA9IGF0O1xuICB9XG5cbiAgcmV0dXJuIGN1cnNvciA9PT0gcmVzb2x2ZWRUZXh0Lmxlbmd0aCA/IHJlc29sdXRpb25zIDogbnVsbDtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBEZWNpc2lvbnNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKiogU3BsaXQgdGV4dCBpbnRvIGxpbmVzLCBlYWNoIGtlZXBpbmcgaXRzIG93biB0cmFpbGluZyBuZXdsaW5lLiAqL1xuZnVuY3Rpb24gc3BsaXRMaW5lcyh0ZXh0OiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIHJldHVybiB0ZXh0Lm1hdGNoKC9bXlxcbl0qXFxufFteXFxuXSsvZykgPz8gW107XG59XG5cbmludGVyZmFjZSBTaWRlRW50cmllcyB7XG4gIC8qKiBSZWNvZ25pc2VkIGVudHJpZXMsIGtleWVkIG9uIGRlcGVuZGVuY3kga2V5LiAqL1xuICBieUtleTogTWFwPHN0cmluZywgc3RyaW5nPjtcbiAgLyoqIFRyaW1tZWQgdGV4dCBvZiBsaW5lcyBubyBlbnRyeSBwYXJzZXIgcmVjb2duaXNlZC4gKi9cbiAgdW5rZXllZDogc3RyaW5nW107XG59XG5cbmZ1bmN0aW9uIHJlYWRTaWRlKHRleHQ6IHN0cmluZyk6IFNpZGVFbnRyaWVzIHtcbiAgY29uc3QgYnlLZXkgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICBjb25zdCB1bmtleWVkOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGxpbmUgb2Ygc3BsaXRMaW5lcyh0ZXh0KSkge1xuICAgIGNvbnN0IGVudHJ5ID0gcGFyc2VEZXBlbmRlbmN5RW50cnlMaW5lKGxpbmUpO1xuICAgIGlmIChlbnRyeSkge1xuICAgICAgYnlLZXkuc2V0KGVudHJ5LmtleSwgZW50cnkudmFsdWUpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IHRyaW1tZWQgPSBsaW5lLnRyaW0oKTtcbiAgICBpZiAodHJpbW1lZC5sZW5ndGggPiAwKSB1bmtleWVkLnB1c2godHJpbW1lZCk7XG4gIH1cbiAgcmV0dXJuIHsgYnlLZXksIHVua2V5ZWQgfTtcbn1cblxuLyoqIERlY2lzaW9ucyBmb3Igb25lIGh1bms6IGtlcHQgb3JkZXIgZmlyc3QsIHRoZW4ga2V5cyBvbmx5IGEgc2lkZSBjYXJyaWVkLiAqL1xuZnVuY3Rpb24gZGVjaXNpb25zRm9ySHVuayhcbiAgb3Vyczogc3RyaW5nLFxuICB0aGVpcnM6IHN0cmluZyxcbiAga2VwdDogc3RyaW5nLFxuKTogRGVwZW5kZW5jeURlY2lzaW9uW10ge1xuICBjb25zdCBvID0gcmVhZFNpZGUob3Vycyk7XG4gIGNvbnN0IHQgPSByZWFkU2lkZSh0aGVpcnMpO1xuICBjb25zdCBrID0gcmVhZFNpZGUoa2VwdCk7XG5cbiAgY29uc3QgZGVjaXNpb25zOiBEZXBlbmRlbmN5RGVjaXNpb25bXSA9IFtdO1xuICBjb25zdCBrZXlzID0gWy4uLmsuYnlLZXkua2V5cygpXTtcbiAgZm9yIChjb25zdCBrZXkgb2YgWy4uLm8uYnlLZXkua2V5cygpLCAuLi50LmJ5S2V5LmtleXMoKV0pIHtcbiAgICBpZiAoIWtleXMuaW5jbHVkZXMoa2V5KSkga2V5cy5wdXNoKGtleSk7XG4gIH1cblxuICBmb3IgKGNvbnN0IGtleSBvZiBrZXlzKSB7XG4gICAgY29uc3Qgb3VyVmFsdWUgPSBvLmJ5S2V5LmdldChrZXkpID8/IG51bGw7XG4gICAgY29uc3QgdGhlaXJWYWx1ZSA9IHQuYnlLZXkuZ2V0KGtleSkgPz8gbnVsbDtcbiAgICBjb25zdCBrZXB0VmFsdWUgPSBrLmJ5S2V5LmdldChrZXkpID8/IG51bGw7XG4gICAgaWYgKG91clZhbHVlID09PSB0aGVpclZhbHVlICYmIHRoZWlyVmFsdWUgPT09IGtlcHRWYWx1ZSkgY29udGludWU7XG4gICAgZGVjaXNpb25zLnB1c2goe1xuICAgICAga2V5LFxuICAgICAgb3Vyczogb3VyVmFsdWUsXG4gICAgICB0aGVpcnM6IHRoZWlyVmFsdWUsXG4gICAgICBrZXB0OiBrZXB0VmFsdWUsXG4gICAgfSk7XG4gIH1cblxuICAvLyBMaW5lcyBubyBwYXJzZXIgcmVjb2duaXNlZCBzdGlsbCBjaGFuZ2VkIHRoZSB0cmVlLCBzbyB0aGV5IGFyZSByZXBvcnRlZFxuICAvLyByYXRoZXIgdGhhbiBzaWxlbnRseSBkcm9wcGVkIGZyb20gdGhlIGF1ZGl0IHRyYWlsLlxuICBmb3IgKGNvbnN0IGxpbmUgb2Ygay51bmtleWVkKSB7XG4gICAgaWYgKG8udW5rZXllZC5pbmNsdWRlcyhsaW5lKSkgY29udGludWU7XG4gICAgZGVjaXNpb25zLnB1c2goe1xuICAgICAga2V5OiBudWxsLFxuICAgICAgb3VyczogbnVsbCxcbiAgICAgIHRoZWlyczogdC51bmtleWVkLmluY2x1ZGVzKGxpbmUpID8gbGluZSA6IG51bGwsXG4gICAgICBrZXB0OiBsaW5lLFxuICAgIH0pO1xuICB9XG4gIGZvciAoY29uc3QgbGluZSBvZiBvLnVua2V5ZWQpIHtcbiAgICBpZiAoay51bmtleWVkLmluY2x1ZGVzKGxpbmUpKSBjb250aW51ZTtcbiAgICBkZWNpc2lvbnMucHVzaCh7XG4gICAgICBrZXk6IG51bGwsXG4gICAgICBvdXJzOiBsaW5lLFxuICAgICAgdGhlaXJzOiB0LnVua2V5ZWQuaW5jbHVkZXMobGluZSkgPyBsaW5lIDogbnVsbCxcbiAgICAgIGtlcHQ6IG51bGwsXG4gICAgfSk7XG4gIH1cblxuICByZXR1cm4gZGVjaXNpb25zO1xufVxuXG4vKipcbiAqIERlc2NyaWJlIHdoYXQgYSBydWxlIGRlY2lkZWQsIGZyb20gaXRzIG93biByZXNvbHZlZCB0ZXh0LlxuICpcbiAqIEBwYXJhbSBzZWdtZW50cyAtIFRoZSBwYXJzZSB0aGUgcnVsZSB3YXMgZ2l2ZW4uXG4gKiBAcGFyYW0gcmVzb2x2ZWRUZXh0IC0gVGhlIHRleHQgdGhlIHJ1bGUgcmV0dXJuZWQuXG4gKiBAcmV0dXJucyBPbmUgZGVjaXNpb24gcGVyIGRlcGVuZGVuY3kgdGhlIHJlc29sdXRpb24gY2hhbmdlZCwgb3IgbnVsbCB3aGVuIHRoZVxuICogICByZXNvbHZlZCB0ZXh0IGNhbm5vdCBiZSBhdHRyaWJ1dGVkIHRvIHRoZSBwYXJzZWQgaHVua3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBleHRyYWN0RGVwZW5kZW5jeURlY2lzaW9ucyhcbiAgc2VnbWVudHM6IHJlYWRvbmx5IENvbmZsaWN0U2VnbWVudFtdLFxuICByZXNvbHZlZFRleHQ6IHN0cmluZyxcbik6IERlcGVuZGVuY3lEZWNpc2lvbltdIHwgbnVsbCB7XG4gIGNvbnN0IHJlc29sdXRpb25zID0gc3BsaXRIdW5rUmVzb2x1dGlvbnMoc2VnbWVudHMsIHJlc29sdmVkVGV4dCk7XG4gIGlmIChyZXNvbHV0aW9ucyA9PT0gbnVsbCkgcmV0dXJuIG51bGw7XG5cbiAgY29uc3QgZGVjaXNpb25zOiBEZXBlbmRlbmN5RGVjaXNpb25bXSA9IFtdO1xuICBsZXQgaW5kZXggPSAwO1xuICBmb3IgKGNvbnN0IHNlZ21lbnQgb2Ygc2VnbWVudHMpIHtcbiAgICBpZiAoc2VnbWVudC5raW5kICE9PSBcImNvbmZsaWN0XCIpIGNvbnRpbnVlO1xuICAgIGRlY2lzaW9ucy5wdXNoKFxuICAgICAgLi4uZGVjaXNpb25zRm9ySHVuayhzZWdtZW50Lm91cnMsIHNlZ21lbnQudGhlaXJzLCByZXNvbHV0aW9uc1tpbmRleF0hKSxcbiAgICApO1xuICAgIGluZGV4Kys7XG4gIH1cbiAgcmV0dXJuIGRlY2lzaW9ucztcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBcUJDLEdBMEJELDhFQUE4RTtBQUM5RSxxQkFBcUI7QUFDckIsOEVBQThFO0FBRTlFLHVFQUF1RSxHQUN2RSxNQUFNLGFBQ0o7QUFFRixxREFBcUQsR0FDckQsTUFBTSxtQkFDSjtBQUVGLDRFQUE0RSxHQUM1RSxNQUFNLG1CQUNKO0FBRUYsNENBQTRDLEdBQzVDLE1BQU0scUJBQXFCO0FBRTNCLGlFQUFpRSxHQUNqRSxNQUFNLG1CQUNKO0FBRUYsNkRBQTZELEdBQzdELFNBQVMsY0FBYyxPQUFlO0VBQ3BDLElBQUk7SUFDRixPQUFPLEtBQUssS0FBSyxDQUFDLENBQUMsQ0FBQyxFQUFFLFFBQVEsQ0FBQyxDQUFDO0VBQ2xDLEVBQUUsT0FBTTtJQUNOLE9BQU87RUFDVDtBQUNGO0FBRUE7Ozs7OztDQU1DLEdBQ0QsT0FBTyxTQUFTLHlCQUNkLElBQVk7RUFFWixNQUFNLE9BQU8sS0FBSyxPQUFPLENBQUMsVUFBVTtFQUVwQyxNQUFNLE9BQU8sS0FBSyxLQUFLLENBQUM7RUFDeEIsSUFBSSxNQUFNO0lBQ1IsT0FBTztNQUNMLEtBQUssY0FBYyxJQUFJLENBQUMsRUFBRTtNQUMx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
// denoCacheMetadata=130801364598506407,9835471930105452442