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
 */ import { compareDependencySpecifiers, manifestRuleRegistry } from "./dependency_conflict_rules.ts";
function createScanState() {
  return {
    mode: "text",
    escaped: false,
    literal: "",
    lastString: null,
    pendingKey: null,
    slash: false,
    star: false,
    stack: []
  };
}
/** Decode a raw string literal body, falling back to the raw text. */ function decodeLiteral(literal) {
  try {
    return JSON.parse(`"${literal}"`);
  } catch  {
    return literal;
  }
}
/** Feed one character while outside a string or comment. */ function feedTextChar(state, char) {
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
  switch(char){
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
/** Advance the scanner over a chunk of document text. */ function feed(state, text) {
  for (const char of text){
    switch(state.mode){
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
 */ function containerPath(state) {
  if (state.mode !== "text") return null;
  return state.stack.slice(1);
}
/** Human-readable rendering of a container path for an `unresolved` reason. */ function describePath(path) {
  if (path === null) return "inside a string or comment";
  if (path.length === 0) return "the document root";
  return path.map((key)=>key ?? "[]").join(".");
}
/** A `"key": "value"` line with optional trailing comma — nothing else. */ const ENTRY_PATTERN = /^[ \t]*("(?:[^"\\]|\\.)*")[ \t]*:[ \t]*("(?:[^"\\]|\\.)*")[ \t]*(,?)[ \t]*(\r?\n?)$/;
/** Split text into lines, each keeping its own trailing newline. */ function splitLines(text) {
  return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}
/**
 * Parse one side of a hunk as dependency-map entries.
 *
 * Returns null when any line is not an entry (a nested object, a comment, a
 * blank line), when the side is empty, or when it repeats a key — each of those
 * is a conflict the rules must not decide.
 */ function parseEntries(side) {
  const entries = [];
  const seen = new Set();
  for (const line of splitLines(side)){
    const match = line.match(ENTRY_PATTERN);
    if (!match) return null;
    const terminator = match[4] ?? "";
    const withoutTerminator = terminator === "" ? line : line.slice(0, line.length - terminator.length);
    const key = decodeLiteral(match[1].slice(1, -1));
    if (seen.has(key)) return null;
    seen.add(key);
    entries.push({
      key,
      value: decodeLiteral(match[2].slice(1, -1)),
      core: withoutTerminator.replace(/[ \t]*,?[ \t]*$/, ""),
      comma: match[3] === ",",
      terminator
    });
  }
  return entries.length > 0 ? entries : null;
}
/**
 * Merge two ordered entry lists, taking the higher semver per shared key.
 *
 * Keys unique to a side are kept in place, so a dependency the other branch
 * added is never silently dropped. Keys shared but reordered between the sides
 * are undecidable — reordering is not a version bump.
 */ function mergeEntries(ours, theirs) {
  const oursIndex = new Map(ours.map((entry, index)=>[
      entry.key,
      index
    ]));
  const merged = [];
  let consumed = 0;
  for (const entry of theirs){
    const index = oursIndex.get(entry.key);
    if (index === undefined) {
      merged.push(entry);
      continue;
    }
    if (index < consumed) {
      return {
        kind: "undecidable",
        reason: `dependency keys are reordered between the sides ("${entry.key}")`
      };
    }
    while(consumed < index)merged.push(ours[consumed++]);
    const ourEntry = ours[consumed++];
    if (ourEntry.value === entry.value) {
      merged.push(ourEntry);
      continue;
    }
    const verdict = compareDependencySpecifiers(ourEntry.value, entry.value);
    if (verdict.kind === "undecidable") {
      return {
        kind: "undecidable",
        reason: `"${entry.key}": ${verdict.reason}`
      };
    }
    merged.push(verdict.side === "ours" ? ourEntry : entry);
  }
  while(consumed < ours.length)merged.push(ours[consumed++]);
  return {
    kind: "merged",
    entries: merged
  };
}
/**
 * Render merged entries back to text.
 *
 * Each line keeps its own indentation, quoting and terminator. Only the
 * trailing comma is adjusted: every line but the last needs one, and the last
 * keeps whatever the sides agreed on — that is decided by the text following
 * the hunk, which is common to both.
 */ function renderEntries(entries, lastComma) {
  const fallbackEol = entries.find((e)=>e.terminator !== "")?.terminator ?? "\n";
  return entries.map((entry, index)=>{
    const last = index === entries.length - 1;
    const comma = last ? lastComma : true;
    const terminator = last ? entry.terminator : entry.terminator || fallbackEol;
    return `${entry.core}${comma ? "," : ""}${terminator}`;
  }).join("");
}
function resolveSegments(ruleName, isDependencyMap, segments) {
  const state = createScanState();
  const defer = (reason)=>({
      kind: "unresolved",
      reason: `${ruleName}: ${reason}`
    });
  let out = "";
  let hunkNumber = 0;
  for (const segment of segments){
    if (segment.kind === "literal") {
      out += segment.text;
      feed(state, segment.text);
      continue;
    }
    hunkNumber++;
    const path = containerPath(state);
    if (path === null || !isDependencyMap(path)) {
      return defer(`hunk ${hunkNumber} is not inside a dependency map (${describePath(path)})`);
    }
    const ours = parseEntries(segment.ours);
    const theirs = parseEntries(segment.theirs);
    if (!ours || !theirs) {
      return defer(`hunk ${hunkNumber} touches more than dependency-map entries`);
    }
    if (ours.at(-1).comma !== theirs.at(-1).comma) {
      return defer(`hunk ${hunkNumber} ends the dependency map on one side only`);
    }
    const merged = mergeEntries(ours, theirs);
    if (merged.kind === "undecidable") {
      return defer(`hunk ${hunkNumber} — ${merged.reason}`);
    }
    const text = renderEntries(merged.entries, ours.at(-1).comma);
    out += text;
    feed(state, text);
  }
  return {
    kind: "resolved",
    text: out
  };
}
/** The final path component, for both `/` and `\` separated paths. */ function basename(path) {
  return path.split(/[\\/]/).at(-1) ?? path;
}
function createRule(name, basenames, isDependencyMap) {
  return {
    name,
    matches: (path)=>basenames.includes(basename(path)),
    resolve: (segments)=>resolveSegments(name, isDependencyMap, segments)
  };
}
/** `deno.json` / `deno.jsonc`: the `imports` map, and each map under `scopes`. */ export const denoJsonRule = createRule("deno.json", [
  "deno.json",
  "deno.jsonc"
], (path)=>path.length === 1 && path[0] === "imports" || path.length === 2 && path[0] === "scopes" && path[1] !== null);
/** The four `package.json` maps whose values are version specifiers. */ const PACKAGE_DEPENDENCY_MAPS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies"
];
/** `package.json`: the four dependency maps, and nothing else. */ export const packageJsonRule = createRule("package.json", [
  "package.json"
], (path)=>{
  const [map] = path;
  return path.length === 1 && typeof map === "string" && PACKAGE_DEPENDENCY_MAPS.includes(map);
});
/** The JSON manifest rules, in match order. */ export const jsonManifestRules = [
  denoJsonRule,
  packageJsonRule
];
/**
 * Register the JSON manifest rules into a registry.
 *
 * Called at import time against the shared registry, so importing this module
 * is all it takes to make the rules available; a test can pass its own
 * registry instead.
 */ export function registerJsonManifestRules(registry = manifestRuleRegistry) {
  for (const rule of jsonManifestRules)registry.register(rule);
}
registerJsonManifestRules();
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9kZXBlbmRlbmN5X2NvbmZsaWN0X2pzb24udHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBEZXRlcm1pbmlzdGljIG1lcmdlLWNvbmZsaWN0IHJ1bGVzIGZvciBKU09OIG1hbmlmZXN0cyAoSXNzdWUgIzQ2MywgIzQ1NikuXG4gKlxuICogUmVnaXN0ZXJzIHR3byBydWxlcyBhZ2FpbnN0IHRoZSBzZWFtIGluIGBkZXBlbmRlbmN5X2NvbmZsaWN0X3J1bGVzLnRzYDpcbiAqXG4gKiAtICoqYGRlbm8uanNvbmAgLyBgZGVuby5qc29uY2AqKiDigJQgY29uZmxpY3RzIGluc2lkZSB0aGUgYGltcG9ydHNgIG1hcCwgYW5kXG4gKiAgIGluc2lkZSBhIHBlci1zY29wZSBtYXAgdW5kZXIgYHNjb3Blc2AsIHdoaWNoIG5lc3RzIHRoZSBzYW1lIHNoYXBlLlxuICogLSAqKmBwYWNrYWdlLmpzb25gKiog4oCUIGNvbmZsaWN0cyBpbnNpZGUgYGRlcGVuZGVuY2llc2AsIGBkZXZEZXBlbmRlbmNpZXNgLFxuICogICBgcGVlckRlcGVuZGVuY2llc2AgYW5kIGBvcHRpb25hbERlcGVuZGVuY2llc2AuXG4gKlxuICogQm90aCBydWxlcyB3b3JrICoqcGVyIGRlcGVuZGVuY3kga2V5KiosIG5vdCBwZXIgaHVuazogZm9yIGEga2V5IHByZXNlbnQgb25cbiAqIGJvdGggc2lkZXMgd2l0aCBkaWZmZXJlbnQgc3BlY2lmaWVycyB0aGUgaGlnaGVyIHNlbXZlciB3aW5zLCB3aGljaGV2ZXIgYnJhbmNoXG4gKiBjYXJyaWVzIGl0LCBhbmQgYSBrZXkgb25seSBvbmUgc2lkZSBoYXMgaXMga2VwdC4gVGhhdCBpcyBhbiBvcmRpbmFyeVxuICogYm90aC1zaWRlcy1zdXJ2aXZlIG1lcmdlLCBub3QgYSBzaWRlLXBpY2suXG4gKlxuICogRXZlcnl0aGluZyBlbHNlIGRlZmVycyB0byB0aGUgQUkgZmFsbGJhY2ssIGFsbC1vci1ub3RoaW5nOlxuICpcbiAqIC0gYSBodW5rIHRoYXQgdG91Y2hlcyBhbnl0aGluZyBvdGhlciB0aGFuIGEgZGVwZW5kZW5jeS1tYXAgZW50cnkgKGEgYHRhc2tzYFxuICogICBibG9jaywgYSBgc2NyaXB0c2AgYmxvY2ssIGEgY2hhbmdlZCBgZXhwb3J0c2AsIGEgY29tbWVudCkg4oCUIGluY2x1ZGluZyBhXG4gKiAgIGh1bmsgdGhhdCBzdGFydHMgaW4gb25lIG9mIHRob3NlIGFuZCBydW5zIGludG8gYSBkZXBlbmRlbmN5IG1hcDtcbiAqIC0gYW55IHNpbmdsZSB1bmRlY2lkYWJsZSBkZXBlbmRlbmN5IChwcmUtcmVsZWFzZSwgdW5wYXJzZWFibGUgc3BlY2lmaWVyLFxuICogICBlcXVhbC1idXQtdGV4dHVhbGx5LWRpZmZlcmVudCwgYSBjaGFuZ2VkIHJhbmdlIHByZWZpeCk7XG4gKiAtIGEgc2lkZSB0aGF0IGRlbGV0ZXMgdGhlIHdob2xlIGJsb2NrLCBvciByZW9yZGVycyB0aGUga2V5cy5cbiAqXG4gKiBUaGVyZSBpcyBubyBwYXJ0aWFsIHJlc29sdXRpb246IG9uZSB1bmRlY2lkYWJsZSBrZXkgZGVmZXJzIHRoZSB3aG9sZSBmaWxlLCBzb1xuICogYSByZXNvbHZlZCBmaWxlIGNhbiBuZXZlciBjYXJyeSBjb25mbGljdCBtYXJrZXJzIGludG8gdGhlIHB1c2hlZCB0cmVlLlxuICpcbiAqICoqRm9ybWF0dGluZyBpcyBwcmVzZXJ2ZWQuKiogVGhlIHdpbm5pbmcgc2lkZSdzIG9yaWdpbmFsIGxpbmUgaXMgZW1pdHRlZCB3aXRoXG4gKiBpdHMgb3duIGluZGVudGF0aW9uLCBxdW90aW5nIGFuZCB0ZXJtaW5hdG9yIHJhdGhlciB0aGFuIHJlLXNlcmlhbGlzaW5nIHRoZVxuICogZG9jdW1lbnQ6IGBkZW5vLmpzb25jYCBwZXJtaXRzIGNvbW1lbnRzIGFuZCBgZGVubyBmbXRgIGlzIGEgcXVhbGl0eSBnYXRlLCBzb1xuICogYSBgSlNPTi5wYXJzZWAvYEpTT04uc3RyaW5naWZ5YCByb3VuZCB0cmlwIHdvdWxkIHN0cmlwIHRoZSBjb21tZW50cyBhbmQgdHVyblxuICogYSB0d28tbGluZSByZXNvbHV0aW9uIGludG8gYSB3aG9sZS1maWxlIGRpZmYuIE9ubHkgYSB0cmFpbGluZyBjb21tYSBpc1xuICogYWRqdXN0ZWQsIGFuZCBvbmx5IHdoZXJlIHRoZSBtZXJnZSBtb3ZlZCBhIGxpbmUgb2ZmIHRoZSBlbmQgb2YgdGhlIG1hcC5cbiAqXG4gKiBUaGUgbW9kdWxlIGlzIHB1cmUg4oCUIG5vIGdpdCwgbm8gbmV0d29yaywgbm8gZmlsZSBJL08uXG4gKi9cblxuaW1wb3J0IHtcbiAgY29tcGFyZURlcGVuZGVuY3lTcGVjaWZpZXJzLFxuICB0eXBlIENvbmZsaWN0U2VnbWVudCxcbiAgdHlwZSBNYW5pZmVzdFJ1bGUsXG4gIHR5cGUgTWFuaWZlc3RSdWxlUmVnaXN0cnksXG4gIG1hbmlmZXN0UnVsZVJlZ2lzdHJ5LFxuICB0eXBlIFJ1bGVPdXRjb21lLFxufSBmcm9tIFwiLi9kZXBlbmRlbmN5X2NvbmZsaWN0X3J1bGVzLnRzXCI7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gSlNPTiBwYXRoIHNjYW5uZXJcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKipcbiAqIEtleSBwYXRoIG9mIHRoZSBjb250YWluZXJzIGVuY2xvc2luZyBhIHBvc2l0aW9uLCByb290IG9iamVjdCBkcm9wcGVkLlxuICpcbiAqIGBbXCJpbXBvcnRzXCJdYCBmb3IgYSBsaW5lIGluc2lkZSBgZGVuby5qc29uYCdzIGBpbXBvcnRzYCBtYXA7XG4gKiBgW1wic2NvcGVzXCIsIFwiaHR0cHM6Ly9leGFtcGxlLmNvbS9cIl1gIGZvciBvbmUgaW5zaWRlIGEgc2NvcGUgbWFwLiBBIGNvbnRhaW5lclxuICogd2l0aCBubyBrZXkg4oCUIHRoZSByb290IG9iamVjdCwgb3IgYW4gYXJyYXkgZWxlbWVudCDigJQgY29udHJpYnV0ZXMgbnVsbC5cbiAqL1xudHlwZSBDb250YWluZXJQYXRoID0gcmVhZG9ubHkgKHN0cmluZyB8IG51bGwpW107XG5cbnR5cGUgU2Nhbk1vZGUgPSBcInRleHRcIiB8IFwic3RyaW5nXCIgfCBcImxpbmUtY29tbWVudFwiIHwgXCJibG9jay1jb21tZW50XCI7XG5cbi8qKiBJbmNyZW1lbnRhbCBzY2FubmVyIHN0YXRlOyBKU09OQyBjb21tZW50cyBhbmQgc3RyaW5ncyBhcmUgc2tpcHBlZC4gKi9cbmludGVyZmFjZSBTY2FuU3RhdGUge1xuICBtb2RlOiBTY2FuTW9kZTtcbiAgLyoqIEluc2lkZSBhIHN0cmluZzogdGhlIHByZXZpb3VzIGNoYXJhY3RlciB3YXMgYSBiYWNrc2xhc2guICovXG4gIGVzY2FwZWQ6IGJvb2xlYW47XG4gIC8qKiBJbnNpZGUgYSBzdHJpbmc6IHRoZSByYXcgbGl0ZXJhbCBzbyBmYXIsIHdpdGhvdXQgaXRzIHF1b3Rlcy4gKi9cbiAgbGl0ZXJhbDogc3RyaW5nO1xuICAvKiogVGhlIG1vc3QgcmVjZW50bHkgY2xvc2VkIHN0cmluZywgYSBjYW5kaWRhdGUgb2JqZWN0IGtleS4gKi9cbiAgbGFzdFN0cmluZzogc3RyaW5nIHwgbnVsbDtcbiAgLyoqIFRoZSBrZXkgb2YgdGhlIHZhbHVlIGN1cnJlbnRseSBiZWluZyByZWFkLCBzZXQgYnkgYDpgLiAqL1xuICBwZW5kaW5nS2V5OiBzdHJpbmcgfCBudWxsO1xuICAvKiogVGhlIHByZXZpb3VzIGNoYXJhY3RlciB3YXMgYC9gIOKAlCBhIGNvbW1lbnQgbWF5IGJlIG9wZW5pbmcuICovXG4gIHNsYXNoOiBib29sZWFuO1xuICAvKiogSW5zaWRlIGEgYmxvY2sgY29tbWVudDogdGhlIHByZXZpb3VzIGNoYXJhY3RlciB3YXMgYCpgLiAqL1xuICBzdGFyOiBib29sZWFuO1xuICAvKiogT3BlbiBjb250YWluZXJzLCBvdXRlcm1vc3QgZmlyc3QuICovXG4gIHN0YWNrOiAoc3RyaW5nIHwgbnVsbClbXTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlU2NhblN0YXRlKCk6IFNjYW5TdGF0ZSB7XG4gIHJldHVybiB7XG4gICAgbW9kZTogXCJ0ZXh0XCIsXG4gICAgZXNjYXBlZDogZmFsc2UsXG4gICAgbGl0ZXJhbDogXCJcIixcbiAgICBsYXN0U3RyaW5nOiBudWxsLFxuICAgIHBlbmRpbmdLZXk6IG51bGwsXG4gICAgc2xhc2g6IGZhbHNlLFxuICAgIHN0YXI6IGZhbHNlLFxuICAgIHN0YWNrOiBbXSxcbiAgfTtcbn1cblxuLyoqIERlY29kZSBhIHJhdyBzdHJpbmcgbGl0ZXJhbCBib2R5LCBmYWxsaW5nIGJhY2sgdG8gdGhlIHJhdyB0ZXh0LiAqL1xuZnVuY3Rpb24gZGVjb2RlTGl0ZXJhbChsaXRlcmFsOiBzdHJpbmcpOiBzdHJpbmcge1xuICB0cnkge1xuICAgIHJldHVybiBKU09OLnBhcnNlKGBcIiR7bGl0ZXJhbH1cImApIGFzIHN0cmluZztcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGxpdGVyYWw7XG4gIH1cbn1cblxuLyoqIEZlZWQgb25lIGNoYXJhY3RlciB3aGlsZSBvdXRzaWRlIGEgc3RyaW5nIG9yIGNvbW1lbnQuICovXG5mdW5jdGlvbiBmZWVkVGV4dENoYXIoc3RhdGU6IFNjYW5TdGF0ZSwgY2hhcjogc3RyaW5nKTogdm9pZCB7XG4gIGlmIChzdGF0ZS5zbGFzaCkge1xuICAgIHN0YXRlLnNsYXNoID0gZmFsc2U7XG4gICAgaWYgKGNoYXIgPT09IFwiL1wiKSB7XG4gICAgICBzdGF0ZS5tb2RlID0gXCJsaW5lLWNvbW1lbnRcIjtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKGNoYXIgPT09IFwiKlwiKSB7XG4gICAgICBzdGF0ZS5tb2RlID0gXCJibG9jay1jb21tZW50XCI7XG4gICAgICBzdGF0ZS5zdGFyID0gZmFsc2U7XG4gICAgICByZXR1cm47XG4gICAgfVxuICB9XG5cbiAgc3dpdGNoIChjaGFyKSB7XG4gICAgY2FzZSAnXCInOlxuICAgICAgc3RhdGUubW9kZSA9IFwic3RyaW5nXCI7XG4gICAgICBzdGF0ZS5saXRlcmFsID0gXCJcIjtcbiAgICAgIHN0YXRlLmVzY2FwZWQgPSBmYWxzZTtcbiAgICAgIHJldHVybjtcbiAgICBjYXNlIFwiL1wiOlxuICAgICAgc3RhdGUuc2xhc2ggPSB0cnVlO1xuICAgICAgcmV0dXJuO1xuICAgIGNhc2UgXCJ7XCI6XG4gICAgY2FzZSBcIltcIjpcbiAgICAgIHN0YXRlLnN0YWNrLnB1c2goc3RhdGUucGVuZGluZ0tleSk7XG4gICAgICBzdGF0ZS5wZW5kaW5nS2V5ID0gbnVsbDtcbiAgICAgIHN0YXRlLmxhc3RTdHJpbmcgPSBudWxsO1xuICAgICAgcmV0dXJuO1xuICAgIGNhc2UgXCJ9XCI6XG4gICAgY2FzZSBcIl1cIjpcbiAgICAgIHN0YXRlLnN0YWNrLnBvcCgpO1xuICAgICAgc3RhdGUucGVuZGluZ0tleSA9IG51bGw7XG4gICAgICBzdGF0ZS5sYXN0U3RyaW5nID0gbnVsbDtcbiAgICAgIHJldHVybjtcbiAgICBjYXNlIFwiOlwiOlxuICAgICAgc3RhdGUucGVuZGluZ0tleSA9IHN0YXRlLmxhc3RTdHJpbmc7XG4gICAgICBzdGF0ZS5sYXN0U3RyaW5nID0gbnVsbDtcbiAgICAgIHJldHVybjtcbiAgICBjYXNlIFwiLFwiOlxuICAgICAgc3RhdGUucGVuZGluZ0tleSA9IG51bGw7XG4gICAgICBzdGF0ZS5sYXN0U3RyaW5nID0gbnVsbDtcbiAgICAgIHJldHVybjtcbiAgICBkZWZhdWx0OlxuICAgICAgcmV0dXJuO1xuICB9XG59XG5cbi8qKiBBZHZhbmNlIHRoZSBzY2FubmVyIG92ZXIgYSBjaHVuayBvZiBkb2N1bWVudCB0ZXh0LiAqL1xuZnVuY3Rpb24gZmVlZChzdGF0ZTogU2NhblN0YXRlLCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgZm9yIChjb25zdCBjaGFyIG9mIHRleHQpIHtcbiAgICBzd2l0Y2ggKHN0YXRlLm1vZGUpIHtcbiAgICAgIGNhc2UgXCJzdHJpbmdcIjpcbiAgICAgICAgaWYgKHN0YXRlLmVzY2FwZWQpIHtcbiAgICAgICAgICBzdGF0ZS5saXRlcmFsICs9IGNoYXI7XG4gICAgICAgICAgc3RhdGUuZXNjYXBlZCA9IGZhbHNlO1xuICAgICAgICB9IGVsc2UgaWYgKGNoYXIgPT09IFwiXFxcXFwiKSB7XG4gICAgICAgICAgc3RhdGUubGl0ZXJhbCArPSBjaGFyO1xuICAgICAgICAgIHN0YXRlLmVzY2FwZWQgPSB0cnVlO1xuICAgICAgICB9IGVsc2UgaWYgKGNoYXIgPT09ICdcIicpIHtcbiAgICAgICAgICBzdGF0ZS5sYXN0U3RyaW5nID0gZGVjb2RlTGl0ZXJhbChzdGF0ZS5saXRlcmFsKTtcbiAgICAgICAgICBzdGF0ZS5tb2RlID0gXCJ0ZXh0XCI7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgc3RhdGUubGl0ZXJhbCArPSBjaGFyO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcImxpbmUtY29tbWVudFwiOlxuICAgICAgICBpZiAoY2hhciA9PT0gXCJcXG5cIikgc3RhdGUubW9kZSA9IFwidGV4dFwiO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJibG9jay1jb21tZW50XCI6XG4gICAgICAgIGlmIChzdGF0ZS5zdGFyICYmIGNoYXIgPT09IFwiL1wiKSB7XG4gICAgICAgICAgc3RhdGUubW9kZSA9IFwidGV4dFwiO1xuICAgICAgICAgIHN0YXRlLnN0YXIgPSBmYWxzZTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBzdGF0ZS5zdGFyID0gY2hhciA9PT0gXCIqXCI7XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwidGV4dFwiOlxuICAgICAgICBmZWVkVGV4dENoYXIoc3RhdGUsIGNoYXIpO1xuICAgICAgICBicmVhaztcbiAgICB9XG4gIH1cbn1cblxuLyoqXG4gKiBUaGUgY29udGFpbmVyIHBhdGggYXQgdGhlIHNjYW5uZXIncyBjdXJyZW50IHBvc2l0aW9uLlxuICpcbiAqIFJldHVybnMgbnVsbCB3aGlsZSBpbnNpZGUgYSBzdHJpbmcgb3IgYSBjb21tZW50IOKAlCBhIGh1bmsgdGhhdCBvcGVucyB0aGVyZSBpc1xuICogbm90IGEgZGVwZW5kZW5jeS1tYXAgZW50cnkgYW5kIG11c3QgZGVmZXIuXG4gKi9cbmZ1bmN0aW9uIGNvbnRhaW5lclBhdGgoc3RhdGU6IFNjYW5TdGF0ZSk6IENvbnRhaW5lclBhdGggfCBudWxsIHtcbiAgaWYgKHN0YXRlLm1vZGUgIT09IFwidGV4dFwiKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHN0YXRlLnN0YWNrLnNsaWNlKDEpO1xufVxuXG4vKiogSHVtYW4tcmVhZGFibGUgcmVuZGVyaW5nIG9mIGEgY29udGFpbmVyIHBhdGggZm9yIGFuIGB1bnJlc29sdmVkYCByZWFzb24uICovXG5mdW5jdGlvbiBkZXNjcmliZVBhdGgocGF0aDogQ29udGFpbmVyUGF0aCB8IG51bGwpOiBzdHJpbmcge1xuICBpZiAocGF0aCA9PT0gbnVsbCkgcmV0dXJuIFwiaW5zaWRlIGEgc3RyaW5nIG9yIGNvbW1lbnRcIjtcbiAgaWYgKHBhdGgubGVuZ3RoID09PSAwKSByZXR1cm4gXCJ0aGUgZG9jdW1lbnQgcm9vdFwiO1xuICByZXR1cm4gcGF0aC5tYXAoKGtleSkgPT4ga2V5ID8/IFwiW11cIikuam9pbihcIi5cIik7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gRGVwZW5kZW5jeS1tYXAgZW50cnkgbGluZXNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKiogT25lIGBcImtleVwiOiBcInZhbHVlXCJgIGxpbmUgb2YgYSBkZXBlbmRlbmN5IG1hcCwga2VwdCB2ZXJiYXRpbS4gKi9cbmludGVyZmFjZSBFbnRyeUxpbmUge1xuICBrZXk6IHN0cmluZztcbiAgLyoqIFRoZSBzcGVjaWZpZXIsIEpTT04tZGVjb2RlZC4gKi9cbiAgdmFsdWU6IHN0cmluZztcbiAgLyoqIFRoZSBsaW5lIHdpdGhvdXQgaXRzIHRyYWlsaW5nIGNvbW1hLCB0cmFpbGluZyBzcGFjZSBhbmQgdGVybWluYXRvci4gKi9cbiAgY29yZTogc3RyaW5nO1xuICAvKiogV2hldGhlciB0aGUgb3JpZ2luYWwgbGluZSBjYXJyaWVkIGEgdHJhaWxpbmcgY29tbWEuICovXG4gIGNvbW1hOiBib29sZWFuO1xuICAvKiogVGhlIGxpbmUncyBvd24gdGVybWluYXRvcjogYFxcbmAsIGBcXHJcXG5gLCBvciBlbXB0eSBhdCBlbmQgb2YgZmlsZS4gKi9cbiAgdGVybWluYXRvcjogc3RyaW5nO1xufVxuXG4vKiogQSBgXCJrZXlcIjogXCJ2YWx1ZVwiYCBsaW5lIHdpdGggb3B0aW9uYWwgdHJhaWxpbmcgY29tbWEg4oCUIG5vdGhpbmcgZWxzZS4gKi9cbmNvbnN0IEVOVFJZX1BBVFRFUk4gPVxuICAvXlsgXFx0XSooXCIoPzpbXlwiXFxcXF18XFxcXC4pKlwiKVsgXFx0XSo6WyBcXHRdKihcIig/OlteXCJcXFxcXXxcXFxcLikqXCIpWyBcXHRdKigsPylbIFxcdF0qKFxccj9cXG4/KSQvO1xuXG4vKiogU3BsaXQgdGV4dCBpbnRvIGxpbmVzLCBlYWNoIGtlZXBpbmcgaXRzIG93biB0cmFpbGluZyBuZXdsaW5lLiAqL1xuZnVuY3Rpb24gc3BsaXRMaW5lcyh0ZXh0OiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIHJldHVybiB0ZXh0Lm1hdGNoKC9bXlxcbl0qXFxufFteXFxuXSsvZykgPz8gW107XG59XG5cbi8qKlxuICogUGFyc2Ugb25lIHNpZGUgb2YgYSBodW5rIGFzIGRlcGVuZGVuY3ktbWFwIGVudHJpZXMuXG4gKlxuICogUmV0dXJucyBudWxsIHdoZW4gYW55IGxpbmUgaXMgbm90IGFuIGVudHJ5IChhIG5lc3RlZCBvYmplY3QsIGEgY29tbWVudCwgYVxuICogYmxhbmsgbGluZSksIHdoZW4gdGhlIHNpZGUgaXMgZW1wdHksIG9yIHdoZW4gaXQgcmVwZWF0cyBhIGtleSDigJQgZWFjaCBvZiB0aG9zZVxuICogaXMgYSBjb25mbGljdCB0aGUgcnVsZXMgbXVzdCBub3QgZGVjaWRlLlxuICovXG5mdW5jdGlvbiBwYXJzZUVudHJpZXMoc2lkZTogc3RyaW5nKTogRW50cnlMaW5lW10gfCBudWxsIHtcbiAgY29uc3QgZW50cmllczogRW50cnlMaW5lW10gPSBbXTtcbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gIGZvciAoY29uc3QgbGluZSBvZiBzcGxpdExpbmVzKHNpZGUpKSB7XG4gICAgY29uc3QgbWF0Y2ggPSBsaW5lLm1hdGNoKEVOVFJZX1BBVFRFUk4pO1xuICAgIGlmICghbWF0Y2gpIHJldHVybiBudWxsO1xuXG4gICAgY29uc3QgdGVybWluYXRvciA9IG1hdGNoWzRdID8/IFwiXCI7XG4gICAgY29uc3Qgd2l0aG91dFRlcm1pbmF0b3IgPSB0ZXJtaW5hdG9yID09PSBcIlwiXG4gICAgICA/IGxpbmVcbiAgICAgIDogbGluZS5zbGljZSgwLCBsaW5lLmxlbmd0aCAtIHRlcm1pbmF0b3IubGVuZ3RoKTtcbiAgICBjb25zdCBrZXkgPSBkZWNvZGVMaXRlcmFsKG1hdGNoWzFdIS5zbGljZSgxLCAtMSkpO1xuICAgIGlmIChzZWVuLmhhcyhrZXkpKSByZXR1cm4gbnVsbDtcbiAgICBzZWVuLmFkZChrZXkpO1xuXG4gICAgZW50cmllcy5wdXNoKHtcbiAgICAgIGtleSxcbiAgICAgIHZhbHVlOiBkZWNvZGVMaXRlcmFsKG1hdGNoWzJdIS5zbGljZSgxLCAtMSkpLFxuICAgICAgY29yZTogd2l0aG91dFRlcm1pbmF0b3IucmVwbGFjZSgvWyBcXHRdKiw/WyBcXHRdKiQvLCBcIlwiKSxcbiAgICAgIGNvbW1hOiBtYXRjaFszXSA9PT0gXCIsXCIsXG4gICAgICB0ZXJtaW5hdG9yLFxuICAgIH0pO1xuICB9XG5cbiAgcmV0dXJuIGVudHJpZXMubGVuZ3RoID4gMCA/IGVudHJpZXMgOiBudWxsO1xufVxuXG4vKiogTWVyZ2Ugb3V0Y29tZSBmb3IgYSBzaW5nbGUgaHVuay4gKi9cbnR5cGUgTWVyZ2VPdXRjb21lID1cbiAgfCB7IGtpbmQ6IFwibWVyZ2VkXCI7IGVudHJpZXM6IEVudHJ5TGluZVtdIH1cbiAgfCB7IGtpbmQ6IFwidW5kZWNpZGFibGVcIjsgcmVhc29uOiBzdHJpbmcgfTtcblxuLyoqXG4gKiBNZXJnZSB0d28gb3JkZXJlZCBlbnRyeSBsaXN0cywgdGFraW5nIHRoZSBoaWdoZXIgc2VtdmVyIHBlciBzaGFyZWQga2V5LlxuICpcbiAqIEtleXMgdW5pcXVlIHRvIGEgc2lkZSBhcmUga2VwdCBpbiBwbGFjZSwgc28gYSBkZXBlbmRlbmN5IHRoZSBvdGhlciBicmFuY2hcbiAqIGFkZGVkIGlzIG5ldmVyIHNpbGVudGx5IGRyb3BwZWQuIEtleXMgc2hhcmVkIGJ1dCByZW9yZGVyZWQgYmV0d2VlbiB0aGUgc2lkZXNcbiAqIGFyZSB1bmRlY2lkYWJsZSDigJQgcmVvcmRlcmluZyBpcyBub3QgYSB2ZXJzaW9uIGJ1bXAuXG4gKi9cbmZ1bmN0aW9uIG1lcmdlRW50cmllcyhcbiAgb3VyczogcmVhZG9ubHkgRW50cnlMaW5lW10sXG4gIHRoZWlyczogcmVhZG9ubHkgRW50cnlMaW5lW10sXG4pOiBNZXJnZU91dGNvbWUge1xuICBjb25zdCBvdXJzSW5kZXggPSBuZXcgTWFwKG91cnMubWFwKChlbnRyeSwgaW5kZXgpID0+IFtlbnRyeS5rZXksIGluZGV4XSkpO1xuICBjb25zdCBtZXJnZWQ6IEVudHJ5TGluZVtdID0gW107XG4gIGxldCBjb25zdW1lZCA9IDA7XG5cbiAgZm9yIChjb25zdCBlbnRyeSBvZiB0aGVpcnMpIHtcbiAgICBjb25zdCBpbmRleCA9IG91cnNJbmRleC5nZXQoZW50cnkua2V5KTtcbiAgICBpZiAoaW5kZXggPT09IHVuZGVmaW5lZCkge1xuICAgICAgbWVyZ2VkLnB1c2goZW50cnkpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChpbmRleCA8IGNvbnN1bWVkKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBraW5kOiBcInVuZGVjaWRhYmxlXCIsXG4gICAgICAgIHJlYXNvbjpcbiAgICAgICAgICBgZGVwZW5kZW5jeSBrZXlzIGFyZSByZW9yZGVyZWQgYmV0d2VlbiB0aGUgc2lkZXMgKFwiJHtlbnRyeS5rZXl9XCIpYCxcbiAgICAgIH07XG4gICAgfVxuICAgIHdoaWxlIChjb25zdW1lZCA8IGluZGV4KSBtZXJnZWQucHVzaChvdXJzW2NvbnN1bWVkKytdISk7XG5cbiAgICBjb25zdCBvdXJFbnRyeSA9IG91cnNbY29uc3VtZWQrK10hO1xuICAgIGlmIChvdXJFbnRyeS52YWx1ZSA9PT0gZW50cnkudmFsdWUpIHtcbiAgICAgIG1lcmdlZC5wdXNoKG91ckVudHJ5KTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCB2ZXJkaWN0ID0gY29tcGFyZURlcGVuZGVuY3lTcGVjaWZpZXJzKG91ckVudHJ5LnZhbHVlLCBlbnRyeS52YWx1ZSk7XG4gICAgaWYgKHZlcmRpY3Qua2luZCA9PT0gXCJ1bmRlY2lkYWJsZVwiKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBraW5kOiBcInVuZGVjaWRhYmxlXCIsXG4gICAgICAgIHJlYXNvbjogYFwiJHtlbnRyeS5rZXl9XCI6ICR7dmVyZGljdC5yZWFzb259YCxcbiAgICAgIH07XG4gICAgfVxuICAgIG1lcmdlZC5wdXNoKHZlcmRpY3Quc2lkZSA9PT0gXCJvdXJzXCIgPyBvdXJFbnRyeSA6IGVudHJ5KTtcbiAgfVxuXG4gIHdoaWxlIChjb25zdW1lZCA8IG91cnMubGVuZ3RoKSBtZXJnZWQucHVzaChvdXJzW2NvbnN1bWVkKytdISk7XG4gIHJldHVybiB7IGtpbmQ6IFwibWVyZ2VkXCIsIGVudHJpZXM6IG1lcmdlZCB9O1xufVxuXG4vKipcbiAqIFJlbmRlciBtZXJnZWQgZW50cmllcyBiYWNrIHRvIHRleHQuXG4gKlxuICogRWFjaCBsaW5lIGtlZXBzIGl0cyBvd24gaW5kZW50YXRpb24sIHF1b3RpbmcgYW5kIHRlcm1pbmF0b3IuIE9ubHkgdGhlXG4gKiB0cmFpbGluZyBjb21tYSBpcyBhZGp1c3RlZDogZXZlcnkgbGluZSBidXQgdGhlIGxhc3QgbmVlZHMgb25lLCBhbmQgdGhlIGxhc3RcbiAqIGtlZXBzIHdoYXRldmVyIHRoZSBzaWRlcyBhZ3JlZWQgb24g4oCUIHRoYXQgaXMgZGVjaWRlZCBieSB0aGUgdGV4dCBmb2xsb3dpbmdcbiAqIHRoZSBodW5rLCB3aGljaCBpcyBjb21tb24gdG8gYm90aC5cbiAqL1xuZnVuY3Rpb24gcmVuZGVyRW50cmllcyhlbnRyaWVzOiByZWFkb25seSBFbnRyeUxpbmVbXSwgbGFzdENvbW1hOiBib29sZWFuKSB7XG4gIGNvbnN0IGZhbGxiYWNrRW9sID0gZW50cmllcy5maW5kKChlKSA9PiBlLnRlcm1pbmF0b3IgIT09IFwiXCIpPy50ZXJtaW5hdG9yID8/XG4gICAgXCJcXG5cIjtcbiAgcmV0dXJuIGVudHJpZXNcbiAgICAubWFwKChlbnRyeSwgaW5kZXgpID0+IHtcbiAgICAgIGNvbnN0IGxhc3QgPSBpbmRleCA9PT0gZW50cmllcy5sZW5ndGggLSAxO1xuICAgICAgY29uc3QgY29tbWEgPSBsYXN0ID8gbGFzdENvbW1hIDogdHJ1ZTtcbiAgICAgIGNvbnN0IHRlcm1pbmF0b3IgPSBsYXN0XG4gICAgICAgID8gZW50cnkudGVybWluYXRvclxuICAgICAgICA6IGVudHJ5LnRlcm1pbmF0b3IgfHwgZmFsbGJhY2tFb2w7XG4gICAgICByZXR1cm4gYCR7ZW50cnkuY29yZX0ke2NvbW1hID8gXCIsXCIgOiBcIlwifSR7dGVybWluYXRvcn1gO1xuICAgIH0pXG4gICAgLmpvaW4oXCJcIik7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gVGhlIHJ1bGUgaXRzZWxmXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqIFdoZXRoZXIgYSBjb250YWluZXIgcGF0aCBuYW1lcyBhIGRlcGVuZGVuY3kgbWFwIHRoaXMgcnVsZSBtYXkgcmVzb2x2ZS4gKi9cbnR5cGUgRGVwZW5kZW5jeU1hcFByZWRpY2F0ZSA9IChwYXRoOiBDb250YWluZXJQYXRoKSA9PiBib29sZWFuO1xuXG5mdW5jdGlvbiByZXNvbHZlU2VnbWVudHMoXG4gIHJ1bGVOYW1lOiBzdHJpbmcsXG4gIGlzRGVwZW5kZW5jeU1hcDogRGVwZW5kZW5jeU1hcFByZWRpY2F0ZSxcbiAgc2VnbWVudHM6IHJlYWRvbmx5IENvbmZsaWN0U2VnbWVudFtdLFxuKTogUnVsZU91dGNvbWUge1xuICBjb25zdCBzdGF0ZSA9IGNyZWF0ZVNjYW5TdGF0ZSgpO1xuICBjb25zdCBkZWZlciA9IChyZWFzb246IHN0cmluZyk6IFJ1bGVPdXRjb21lID0+ICh7XG4gICAga2luZDogXCJ1bnJlc29sdmVkXCIsXG4gICAgcmVhc29uOiBgJHtydWxlTmFtZX06ICR7cmVhc29ufWAsXG4gIH0pO1xuXG4gIGxldCBvdXQgPSBcIlwiO1xuICBsZXQgaHVua051bWJlciA9IDA7XG5cbiAgZm9yIChjb25zdCBzZWdtZW50IG9mIHNlZ21lbnRzKSB7XG4gICAgaWYgKHNlZ21lbnQua2luZCA9PT0gXCJsaXRlcmFsXCIpIHtcbiAgICAgIG91dCArPSBzZWdtZW50LnRleHQ7XG4gICAgICBmZWVkKHN0YXRlLCBzZWdtZW50LnRleHQpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgaHVua051bWJlcisrO1xuICAgIGNvbnN0IHBhdGggPSBjb250YWluZXJQYXRoKHN0YXRlKTtcbiAgICBpZiAocGF0aCA9PT0gbnVsbCB8fCAhaXNEZXBlbmRlbmN5TWFwKHBhdGgpKSB7XG4gICAgICByZXR1cm4gZGVmZXIoXG4gICAgICAgIGBodW5rICR7aHVua051bWJlcn0gaXMgbm90IGluc2lkZSBhIGRlcGVuZGVuY3kgbWFwICgke1xuICAgICAgICAgIGRlc2NyaWJlUGF0aChwYXRoKVxuICAgICAgICB9KWAsXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IG91cnMgPSBwYXJzZUVudHJpZXMoc2VnbWVudC5vdXJzKTtcbiAgICBjb25zdCB0aGVpcnMgPSBwYXJzZUVudHJpZXMoc2VnbWVudC50aGVpcnMpO1xuICAgIGlmICghb3VycyB8fCAhdGhlaXJzKSB7XG4gICAgICByZXR1cm4gZGVmZXIoXG4gICAgICAgIGBodW5rICR7aHVua051bWJlcn0gdG91Y2hlcyBtb3JlIHRoYW4gZGVwZW5kZW5jeS1tYXAgZW50cmllc2AsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAob3Vycy5hdCgtMSkhLmNvbW1hICE9PSB0aGVpcnMuYXQoLTEpIS5jb21tYSkge1xuICAgICAgcmV0dXJuIGRlZmVyKFxuICAgICAgICBgaHVuayAke2h1bmtOdW1iZXJ9IGVuZHMgdGhlIGRlcGVuZGVuY3kgbWFwIG9uIG9uZSBzaWRlIG9ubHlgLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCBtZXJnZWQgPSBtZXJnZUVudHJpZXMob3VycywgdGhlaXJzKTtcbiAgICBpZiAobWVyZ2VkLmtpbmQgPT09IFwidW5kZWNpZGFibGVcIikge1xuICAgICAgcmV0dXJuIGRlZmVyKGBodW5rICR7aHVua051bWJlcn0g4oCUICR7bWVyZ2VkLnJlYXNvbn1gKTtcbiAgICB9XG5cbiAgICBjb25zdCB0ZXh0ID0gcmVuZGVyRW50cmllcyhtZXJnZWQuZW50cmllcywgb3Vycy5hdCgtMSkhLmNvbW1hKTtcbiAgICBvdXQgKz0gdGV4dDtcbiAgICBmZWVkKHN0YXRlLCB0ZXh0KTtcbiAgfVxuXG4gIHJldHVybiB7IGtpbmQ6IFwicmVzb2x2ZWRcIiwgdGV4dDogb3V0IH07XG59XG5cbi8qKiBUaGUgZmluYWwgcGF0aCBjb21wb25lbnQsIGZvciBib3RoIGAvYCBhbmQgYFxcYCBzZXBhcmF0ZWQgcGF0aHMuICovXG5mdW5jdGlvbiBiYXNlbmFtZShwYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gcGF0aC5zcGxpdCgvW1xcXFwvXS8pLmF0KC0xKSA/PyBwYXRoO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVSdWxlKFxuICBuYW1lOiBzdHJpbmcsXG4gIGJhc2VuYW1lczogcmVhZG9ubHkgc3RyaW5nW10sXG4gIGlzRGVwZW5kZW5jeU1hcDogRGVwZW5kZW5jeU1hcFByZWRpY2F0ZSxcbik6IE1hbmlmZXN0UnVsZSB7XG4gIHJldHVybiB7XG4gICAgbmFtZSxcbiAgICBtYXRjaGVzOiAocGF0aCkgPT4gYmFzZW5hbWVzLmluY2x1ZGVzKGJhc2VuYW1lKHBhdGgpKSxcbiAgICByZXNvbHZlOiAoc2VnbWVudHMpID0+IHJlc29sdmVTZWdtZW50cyhuYW1lLCBpc0RlcGVuZGVuY3lNYXAsIHNlZ21lbnRzKSxcbiAgfTtcbn1cblxuLyoqIGBkZW5vLmpzb25gIC8gYGRlbm8uanNvbmNgOiB0aGUgYGltcG9ydHNgIG1hcCwgYW5kIGVhY2ggbWFwIHVuZGVyIGBzY29wZXNgLiAqL1xuZXhwb3J0IGNvbnN0IGRlbm9Kc29uUnVsZTogTWFuaWZlc3RSdWxlID0gY3JlYXRlUnVsZShcbiAgXCJkZW5vLmpzb25cIixcbiAgW1wiZGVuby5qc29uXCIsIFwiZGVuby5qc29uY1wiXSxcbiAgKHBhdGgpID0+XG4gICAgKHBhdGgubGVuZ3RoID09PSAxICYmIHBhdGhbMF0gPT09IFwiaW1wb3J0c1wiKSB8fFxuICAgIChwYXRoLmxlbmd0aCA9PT0gMiAmJiBwYXRoWzBdID09PSBcInNjb3Blc1wiICYmIHBhdGhbMV0gIT09IG51bGwpLFxuKTtcblxuLyoqIFRoZSBmb3VyIGBwYWNrYWdlLmpzb25gIG1hcHMgd2hvc2UgdmFsdWVzIGFyZSB2ZXJzaW9uIHNwZWNpZmllcnMuICovXG5jb25zdCBQQUNLQUdFX0RFUEVOREVOQ1lfTUFQUzogcmVhZG9ubHkgc3RyaW5nW10gPSBbXG4gIFwiZGVwZW5kZW5jaWVzXCIsXG4gIFwiZGV2RGVwZW5kZW5jaWVzXCIsXG4gIFwicGVlckRlcGVuZGVuY2llc1wiLFxuICBcIm9wdGlvbmFsRGVwZW5kZW5jaWVzXCIsXG5dO1xuXG4vKiogYHBhY2thZ2UuanNvbmA6IHRoZSBmb3VyIGRlcGVuZGVuY3kgbWFwcywgYW5kIG5vdGhpbmcgZWxzZS4gKi9cbmV4cG9ydCBjb25zdCBwYWNrYWdlSnNvblJ1bGU6IE1hbmlmZXN0UnVsZSA9IGNyZWF0ZVJ1bGUoXG4gIFwicGFja2FnZS5qc29uXCIsXG4gIFtcInBhY2thZ2UuanNvblwiXSxcbiAgKHBhdGgpID0+IHtcbiAgICBjb25zdCBbbWFwXSA9IHBhdGg7XG4gICAgcmV0dXJuIHBhdGgubGVuZ3RoID09PSAxICYmIHR5cGVvZiBtYXAgPT09IFwic3RyaW5nXCIgJiZcbiAgICAgIFBBQ0tBR0VfREVQRU5ERU5DWV9NQVBTLmluY2x1ZGVzKG1hcCk7XG4gIH0sXG4pO1xuXG4vKiogVGhlIEpTT04gbWFuaWZlc3QgcnVsZXMsIGluIG1hdGNoIG9yZGVyLiAqL1xuZXhwb3J0IGNvbnN0IGpzb25NYW5pZmVzdFJ1bGVzOiByZWFkb25seSBNYW5pZmVzdFJ1bGVbXSA9IFtcbiAgZGVub0pzb25SdWxlLFxuICBwYWNrYWdlSnNvblJ1bGUsXG5dO1xuXG4vKipcbiAqIFJlZ2lzdGVyIHRoZSBKU09OIG1hbmlmZXN0IHJ1bGVzIGludG8gYSByZWdpc3RyeS5cbiAqXG4gKiBDYWxsZWQgYXQgaW1wb3J0IHRpbWUgYWdhaW5zdCB0aGUgc2hhcmVkIHJlZ2lzdHJ5LCBzbyBpbXBvcnRpbmcgdGhpcyBtb2R1bGVcbiAqIGlzIGFsbCBpdCB0YWtlcyB0byBtYWtlIHRoZSBydWxlcyBhdmFpbGFibGU7IGEgdGVzdCBjYW4gcGFzcyBpdHMgb3duXG4gKiByZWdpc3RyeSBpbnN0ZWFkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJKc29uTWFuaWZlc3RSdWxlcyhcbiAgcmVnaXN0cnk6IE1hbmlmZXN0UnVsZVJlZ2lzdHJ5ID0gbWFuaWZlc3RSdWxlUmVnaXN0cnksXG4pOiB2b2lkIHtcbiAgZm9yIChjb25zdCBydWxlIG9mIGpzb25NYW5pZmVzdFJ1bGVzKSByZWdpc3RyeS5yZWdpc3RlcihydWxlKTtcbn1cblxucmVnaXN0ZXJKc29uTWFuaWZlc3RSdWxlcygpO1xuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQW1DQyxHQUVELFNBQ0UsMkJBQTJCLEVBSTNCLG9CQUFvQixRQUVmLGlDQUFpQztBQW9DeEMsU0FBUztFQUNQLE9BQU87SUFDTCxNQUFNO0lBQ04sU0FBUztJQUNULFNBQVM7SUFDVCxZQUFZO0lBQ1osWUFBWTtJQUNaLE9BQU87SUFDUCxNQUFNO0lBQ04sT0FBTyxFQUFFO0VBQ1g7QUFDRjtBQUVBLG9FQUFvRSxHQUNwRSxTQUFTLGNBQWMsT0FBZTtFQUNwQyxJQUFJO0lBQ0YsT0FBTyxLQUFLLEtBQUssQ0FBQyxDQUFDLENBQUMsRUFBRSxRQUFRLENBQUMsQ0FBQztFQUNsQyxFQUFFLE9BQU07SUFDTixPQUFPO0VBQ1Q7QUFDRjtBQUVBLDBEQUEwRCxHQUMxRCxTQUFTLGFBQWEsS0FBZ0IsRUFBRSxJQUFZO0VBQ2xELElBQUksTUFBTSxLQUFLLEVBQUU7SUFDZixNQUFNLEtBQUssR0FBRztJQUNkLElBQUksU0FBUyxLQUFLO01BQ2hCLE1BQU0sSUFBSSxHQUFHO01BQ2I7SUFDRjtJQUNBLElBQUksU0FBUyxLQUFLO01BQ2hCLE1BQU0sSUFBSSxHQUFHO01BQ2IsTUFBTSxJQUFJLEdBQUc7TUFDYjtJQUNGO0VBQ0Y7RUFFQSxPQUFRO0lBQ04sS0FBSztNQUNILE1BQU0sSUFBSSxHQUFHO01BQ2IsTUFBTSxPQUFPLEdBQUc7TUFDaEIsTUFBTSxPQUFPLEdBQUc7TUFDaEI7SUFDRixLQUFLO01BQ0gsTUFBTSxLQUFLLEdBQUc7TUFDZDtJQUNGLEtBQUs7SUFDTCxLQUFLO01BQ0gsTUFBTSxLQUFL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
// denoCacheMetadata=12145099421852816016,3108505336825510070