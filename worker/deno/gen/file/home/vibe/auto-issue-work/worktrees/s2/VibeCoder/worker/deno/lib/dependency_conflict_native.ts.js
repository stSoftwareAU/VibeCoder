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
 */ import { compareDependencySpecifiers, manifestRuleRegistry, renderConflictSegments } from "./dependency_conflict_rules.ts";
/** Split text into lines, each keeping its own trailing newline. */ function splitLines(text) {
  return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}
/** Strip a line's terminator, returning the content and the terminator. */ function splitTerminator(line) {
  const match = line.match(/\r?\n$/);
  const terminator = match?.[0] ?? "";
  return [
    line.slice(0, line.length - terminator.length),
    terminator
  ];
}
/** Collapse runs of whitespace so cosmetic spacing is not a shape change. */ function normaliseSpacing(text) {
  return text.replace(/\s+/g, " ").trim();
}
/**
 * Merge two ordered entry lists, taking the higher version per shared key.
 *
 * Keys unique to a side are kept in place, so a dependency the other branch
 * added is never silently dropped. Keys shared but reordered between the sides
 * are undecidable — reordering is not a version bump.
 */ function mergeEntries(ours, theirs, compare) {
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
    if (ourEntry.shape !== entry.shape) {
      return {
        kind: "undecidable",
        reason: `"${entry.key}" changes more than the version`
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
/** Render merged entries, each line keeping its own text and terminator. */ function renderEntries(entries) {
  const fallbackEol = entries.find((e)=>e.terminator !== "")?.terminator ?? "\n";
  return entries.map((entry, index)=>entry.core + (index === entries.length - 1 ? entry.terminator : entry.terminator || fallbackEol)).join("");
}
function resolveSegments(dialect, segments) {
  const defer = (reason)=>({
      kind: "unresolved",
      reason: `${dialect.name}: ${reason}`
    });
  const guardReason = dialect.guard?.(renderConflictSegments(segments));
  if (guardReason) return defer(guardReason);
  const context = dialect.createContext();
  let out = "";
  let hunkNumber = 0;
  for (const segment of segments){
    if (segment.kind === "literal") {
      out += segment.text;
      dialect.feed(context, segment.text);
      continue;
    }
    hunkNumber++;
    if (!dialect.isDependencyRegion(context)) {
      return defer(`hunk ${hunkNumber} is ${dialect.describe(context)}`);
    }
    const ours = dialect.parseEntries(context, segment.ours);
    const theirs = dialect.parseEntries(context, segment.theirs);
    if (!ours || !theirs) {
      return defer(`hunk ${hunkNumber} touches more than ${dialect.entryNoun} entries`);
    }
    const merged = mergeEntries(ours, theirs, dialect.compare);
    if (merged.kind === "undecidable") {
      return defer(`hunk ${hunkNumber} — ${merged.reason}`);
    }
    const text = renderEntries(merged.entries);
    out += text;
    dialect.feed(context, text);
  }
  return {
    kind: "resolved",
    text: out
  };
}
/** The final path component, for both `/` and `\` separated paths. */ function basename(path) {
  return path.split(/[\\/]/).at(-1) ?? path;
}
function createRule(dialect) {
  return {
    name: dialect.name,
    matches: (path)=>dialect.basenames.includes(basename(path)),
    resolve: (segments)=>resolveSegments(dialect, segments)
  };
}
/** A table header line, with an optional trailing comment. */ const CARGO_HEADER = /^[ \t]*(\[\[?)([^\]]+)\]\]?[ \t]*(#.*)?$/;
/** A `key = value` line; the value is classified separately. */ const CARGO_ENTRY = /^[ \t]*((?:"(?:[^"\\]|\\.)*")|[A-Za-z0-9_+.-]+)[ \t]*=[ \t]*(.+?)[ \t]*(\r?\n?)$/;
/** A quoted version string, the only value shape worth comparing. */ const CARGO_VERSION_STRING = /^"([^"\\]*)"$/;
/** The dependency tables this rule may resolve, keyed on the final segment. */ const CARGO_DEPENDENCY_TABLES = [
  "dependencies",
  "dev-dependencies",
  "build-dependencies"
];
/**
 * Split a dotted TOML key path, honouring quoted segments.
 *
 * `target.'cfg(unix)'.dependencies` is three segments, not five: the `.` inside
 * the quoted `cfg(unix)` predicate is part of that segment's text.
 */ function splitTomlKey(header) {
  const segments = [];
  let current = "";
  let quote = null;
  for (const char of header){
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
/** Whether a header names a dependency table this rule may resolve. */ function isCargoDependencyTable(header) {
  if (header === null) return false;
  const segments = splitTomlKey(header);
  if (!segments) return false;
  const last = segments.at(-1) ?? "";
  if (!CARGO_DEPENDENCY_TABLES.includes(last)) return false;
  return segments.length === 1 || segments.length === 3 && segments[0] === "target";
}
/** Split an inline table body on its top-level commas. */ function splitInlineFields(body) {
  const parts = [];
  let current = "";
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (const char of body){
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
/** Parse an inline table body into its fields, or null when malformed. */ function parseInlineTable(body) {
  const parts = splitInlineFields(body);
  if (!parts) return null;
  const fields = new Map();
  for (const part of parts){
    const match = part.match(/^[ \t]*((?:"(?:[^"\\]|\\.)*")|[A-Za-z0-9_+.-]+)[ \t]*=[ \t]*(.+?)[ \t]*$/);
    if (!match) return null;
    const key = match[1];
    if (fields.has(key)) return null;
    fields.set(key, normaliseSpacing(match[2]));
  }
  return fields;
}
/** Classify a dependency value into its version and its remaining shape. */ function parseCargoValue(raw) {
  const short = raw.match(CARGO_VERSION_STRING);
  if (short) return {
    version: short[1],
    shape: "short"
  };
  if (!raw.startsWith("{") || !raw.endsWith("}")) return null;
  const fields = parseInlineTable(raw.slice(1, -1));
  if (!fields) return null;
  const version = fields.get("version")?.match(CARGO_VERSION_STRING);
  if (!version) return null;
  const others = [
    ...fields
  ].filter(([key])=>key !== "version").map(([key, value])=>`${key}=${value}`).sort();
  return {
    version: version[1],
    shape: `table{${others.join(",")}}`
  };
}
const cargoDialect = {
  name: "Cargo.toml",
  basenames: [
    "Cargo.toml"
  ],
  entryNoun: "dependency",
  createContext: ()=>({
      header: null,
      pending: ""
    }),
  feed (context, text) {
    const lines = splitLines(context.pending + text);
    context.pending = "";
    for (const line of lines){
      const [content, terminator] = splitTerminator(line);
      if (terminator === "") {
        context.pending = content;
        continue;
      }
      const match = content.match(CARGO_HEADER);
      if (!match) continue;
      // An array-of-tables header (`[[bin]]`) is never a dependency table.
      context.header = match[1] === "[[" ? null : match[2].trim();
    }
  },
  isDependencyRegion: (context)=>isCargoDependencyTable(context.header),
  describe: (context)=>context.header === null ? "not inside a dependency table (no table header yet)" : `not inside a dependency table ([${context.header}])`,
  parseEntries (_context, side) {
    const entries = [];
    const seen = new Set();
    for (const line of splitLines(side)){
      const match = line.match(CARGO_ENTRY);
      if (!match) return null;
      const value = parseCargoValue(match[2]);
      if (!value) return null;
      const key = match[1];
      if (seen.has(key)) return null;
      seen.add(key);
      const terminator = match[3] ?? "";
      entries.push({
        key,
        core: line.slice(0, line.length - terminator.length),
        terminator,
        version: value.version,
        shape: value.shape
      });
    }
    return entries.length > 0 ? entries : null;
  },
  compare (ours, theirs) {
    const verdict = compareDependencySpecifiers(ours, theirs);
    return verdict.kind === "higher" ? {
      kind: "higher",
      side: verdict.side
    } : {
      kind: "undecidable",
      reason: verdict.reason
    };
  },
  guard (text) {
    // The header scanner reads line by line, so a `"""` or `'''` block could
    // hide a line that looks like a table header. Defer rather than guess.
    return /"""|'''/.test(text) ? "the file contains a multi-line string, which the table scanner does not follow" : null;
  }
};
/** A directive opening a parenthesised block, e.g. `require (`. */ const GO_BLOCK_OPEN = /^[ \t]*([a-z]+)[ \t]*\([ \t]*$/;
/** A `module version` line inside a `require` block, with optional comment. */ const GO_BLOCK_ENTRY = /^[ \t]*([^\s()]+)[ \t]+([^\s()]+)[ \t]*(\/\/.*?)?[ \t]*(\r?\n?)$/;
/** A single-line `require module version` directive. */ const GO_SINGLE_ENTRY = /^[ \t]*require[ \t]+([^\s()]+)[ \t]+([^\s()]+)[ \t]*(\/\/.*?)?[ \t]*(\r?\n?)$/;
/**
 * A plain Go semver version: mandatory `v`, exactly three numeric segments.
 *
 * Pseudo-versions (`v0.0.0-20230101120000-abcdef123456`) and `+incompatible`
 * are deliberately excluded — a timestamp-ordered pseudo-version is not
 * comparable by the semver rule, and `+incompatible` marks a module outside the
 * versioning scheme entirely.
 */ const GO_VERSION = /^v\d+\.\d+\.\d+$/;
const goModDialect = {
  name: "go.mod",
  basenames: [
    "go.mod"
  ],
  entryNoun: "require",
  createContext: ()=>({
      block: null,
      pending: ""
    }),
  feed (context, text) {
    const lines = splitLines(context.pending + text);
    context.pending = "";
    for (const line of lines){
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
      if (match) context.block = match[1];
    }
  },
  // A hunk at the top level may still be a single-line `require`; any other
  // open block (`replace`, `exclude`, `retract`) is never resolvable.
  isDependencyRegion: (context)=>context.block === null || context.block === "require",
  describe: (context)=>`not inside a require directive (the ${context.block} block)`,
  parseEntries (context, side) {
    const pattern = context.block === "require" ? GO_BLOCK_ENTRY : GO_SINGLE_ENTRY;
    const entries = [];
    const seen = new Set();
    for (const line of splitLines(side)){
      const match = line.match(pattern);
      if (!match) return null;
      const key = match[1];
      // A comment line parses as two tokens; it is not a require entry.
      if (key.startsWith("//")) return null;
      if (seen.has(key)) return null;
      seen.add(key);
      const terminator = match[4] ?? "";
      entries.push({
        key,
        core: line.slice(0, line.length - terminator.length),
        terminator,
        version: match[2],
        shape: match[3] ?? ""
      });
    }
    return entries.length > 0 ? entries : null;
  },
  compare (ours, theirs) {
    for (const version of [
      ours,
      theirs
    ]){
      if (!GO_VERSION.test(version)) {
        return {
          kind: "undecidable",
          reason: `not a plain Go semver version: ${version}`
        };
      }
    }
    const verdict = compareDependencySpecifiers(ours, theirs);
    return verdict.kind === "higher" ? {
      kind: "higher",
      side: verdict.side
    } : {
      kind: "undecidable",
      reason: verdict.reason
    };
  }
};
// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------
/** `Cargo.toml`: the dependency tables, short and inline-table entry forms. */ export const cargoTomlRule = createRule(cargoDialect);
/** `go.mod`: `require` lines, single-line and parenthesised-block forms. */ export const goModRule = createRule(goModDialect);
/** The native manifest rules, in match order. */ export const nativeManifestRules = [
  cargoTomlRule,
  goModRule
];
/**
 * Register the native manifest rules into a registry.
 *
 * Called at import time against the shared registry, so importing this module
 * is all it takes to make the rules available; a test can pass its own registry
 * instead.
 */ export function registerNativeManifestRules(registry = manifestRuleRegistry) {
  for (const rule of nativeManifestRules)registry.register(rule);
}
registerNativeManifestRules();
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9kZXBlbmRlbmN5X2NvbmZsaWN0X25hdGl2ZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIERldGVybWluaXN0aWMgbWVyZ2UtY29uZmxpY3QgcnVsZXMgZm9yIG5hdGl2ZSBtYW5pZmVzdHMgKElzc3VlICM0NjQsICM0NTYpLlxuICpcbiAqIFJlZ2lzdGVycyB0d28gcnVsZXMgYWdhaW5zdCB0aGUgc2VhbSBpbiBgZGVwZW5kZW5jeV9jb25mbGljdF9ydWxlcy50c2AsXG4gKiBjb21wbGV0aW5nIHRoZSBlY29zeXN0ZW0gY292ZXJhZ2UgdGhlIHBhcmVudCBpc3N1ZSBhc2tzIGZvcjpcbiAqXG4gKiAtICoqYENhcmdvLnRvbWxgKiog4oCUIGNvbmZsaWN0cyBpbnNpZGUgYFtkZXBlbmRlbmNpZXNdYCwgYFtkZXYtZGVwZW5kZW5jaWVzXWAsXG4gKiAgIGBbYnVpbGQtZGVwZW5kZW5jaWVzXWAgYW5kIHRoZWlyIGBbdGFyZ2V0LiouZGVwZW5kZW5jaWVzXWAgdmFyaWFudHMsIGluXG4gKiAgIGJvdGggdGhlIHNob3J0IGZvcm0gKGBzZXJkZSA9IFwiMS4wLjE5NVwiYCkgYW5kIHRoZSBpbmxpbmUtdGFibGUgZm9ybVxuICogICAoYHNlcmRlID0geyB2ZXJzaW9uID0gXCIxLjAuMTk1XCIsIGZlYXR1cmVzID0gWy4uLl0gfWApLiBPbmx5IHRoZSBgdmVyc2lvbmBcbiAqICAgZmllbGQgaXMgY29tcGFyZWQ6IGEgY29uZmxpY3QgdGhhdCBhbHNvIGNoYW5nZXMgYGZlYXR1cmVzYCxcbiAqICAgYGRlZmF1bHQtZmVhdHVyZXNgLCBgcGF0aGAgb3IgYGdpdGAgaXMgYSBwb2xpY3kgY2hhbmdlLCBub3QgYSBidW1wLCBhbmRcbiAqICAgZGVmZXJzLlxuICogLSAqKmBnby5tb2RgKiog4oCUIGNvbmZsaWN0cyBvbiBgcmVxdWlyZWAgbGluZXMsIGJvdGggdGhlIHNpbmdsZS1saW5lIGFuZCB0aGVcbiAqICAgcGFyZW50aGVzaXNlZC1ibG9jayBmb3JtLiBHbyB2ZXJzaW9ucyBjYXJyeSBhIG1hbmRhdG9yeSBsZWFkaW5nIGB2YDtcbiAqICAgYCtpbmNvbXBhdGlibGVgIGFuZCBwc2V1ZG8tdmVyc2lvbnMgKGB2MC4wLjAtMjAyMzAxMDExMjAwMDAtYWJjZGVmMTIzNDU2YClcbiAqICAgYXJlIHVuZGVjaWRhYmxlLCBiZWNhdXNlIHRpbWVzdGFtcC1vcmRlcmVkIHBzZXVkby12ZXJzaW9ucyBhcmUgbm90XG4gKiAgIGNvbXBhcmFibGUgYnkgdGhlIHNlbXZlciBydWxlLlxuICpcbiAqIExpa2UgdGhlIEpTT04gcnVsZXMsIGJvdGggd29yayAqKnBlciBkZXBlbmRlbmN5IGtleSoqIHJhdGhlciB0aGFuIHBlciBodW5rOlxuICogZm9yIGEga2V5IHByZXNlbnQgb24gYm90aCBzaWRlcyB3aXRoIGRpZmZlcmVudCB2ZXJzaW9ucyB0aGUgaGlnaGVyIHNlbXZlclxuICogd2lucywgd2hpY2hldmVyIGJyYW5jaCBjYXJyaWVzIGl0LCBhbmQgYSBrZXkgb25seSBvbmUgc2lkZSBoYXMgaXMga2VwdC4gVGhhdFxuICogaXMgYW4gb3JkaW5hcnkgYm90aC1zaWRlcy1zdXJ2aXZlIG1lcmdlLCBub3QgYSBzaWRlLXBpY2suXG4gKlxuICogRXZlcnl0aGluZyBlbHNlIGRlZmVycyB0byB0aGUgQUkgZmFsbGJhY2ssIGFsbC1vci1ub3RoaW5nOiBhIGh1bmsgdG91Y2hpbmcgYVxuICogbm9uLWRlcGVuZGVuY3kgbGluZSAoYSBgW2ZlYXR1cmVzXWAgYmxvY2ssIGEgYGdvYCBkaXJlY3RpdmUsIGEgYHJlcGxhY2VgXG4gKiBkaXJlY3RpdmUsIGEgdGFibGUgaGVhZGVyKSwgYSBzaW5nbGUgdW5kZWNpZGFibGUgdmVyc2lvbiwgb3IgYSBjaGFuZ2UgdG8gYW55XG4gKiBmaWVsZCBvdGhlciB0aGFuIHRoZSB2ZXJzaW9uLiBPbmUgdW5kZWNpZGFibGUgaHVuayBkZWZlcnMgdGhlIHdob2xlIGZpbGUsIHNvXG4gKiBhIHJlc29sdmVkIGZpbGUgY2FuIG5ldmVyIGNhcnJ5IGNvbmZsaWN0IG1hcmtlcnMgaW50byB0aGUgcHVzaGVkIHRyZWUuXG4gKlxuICogKipGb3JtYXR0aW5nIGlzIHByZXNlcnZlZC4qKiBUaGUgd2lubmluZyBzaWRlJ3Mgb3JpZ2luYWwgbGluZSBpcyBlbWl0dGVkIHdpdGhcbiAqIGl0cyBvd24gaW5kZW50YXRpb24sIHNwYWNpbmcgYW5kIHRlcm1pbmF0b3IgcmF0aGVyIHRoYW4gcmUtc2VyaWFsaXNpbmcgdGhlXG4gKiBkb2N1bWVudCDigJQgdGhlc2UgYXJlIGhhbmQtbWFpbnRhaW5lZCBmaWxlcyBhbmQgYSByZS1zZXJpYWxpc2F0aW9uIHdvdWxkIHR1cm5cbiAqIGEgb25lLWxpbmUgcmVzb2x1dGlvbiBpbnRvIGEgd2hvbGUtZmlsZSBkaWZmLlxuICpcbiAqIFRoZSBtb2R1bGUgaXMgcHVyZSDigJQgbm8gZ2l0LCBubyBuZXR3b3JrLCBubyBmaWxlIEkvTy5cbiAqL1xuXG5pbXBvcnQge1xuICBjb21wYXJlRGVwZW5kZW5jeVNwZWNpZmllcnMsXG4gIHR5cGUgQ29uZmxpY3RTZWdtZW50LFxuICB0eXBlIENvbmZsaWN0U2lkZSxcbiAgdHlwZSBNYW5pZmVzdFJ1bGUsXG4gIHR5cGUgTWFuaWZlc3RSdWxlUmVnaXN0cnksXG4gIG1hbmlmZXN0UnVsZVJlZ2lzdHJ5LFxuICByZW5kZXJDb25mbGljdFNlZ21lbnRzLFxuICB0eXBlIFJ1bGVPdXRjb21lLFxufSBmcm9tIFwiLi9kZXBlbmRlbmN5X2NvbmZsaWN0X3J1bGVzLnRzXCI7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gU2hhcmVkIGVudHJ5IG1vZGVsXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqIE9uZSBkZXBlbmRlbmN5IGxpbmUgb2YgYSBtYW5pZmVzdCwga2VwdCB2ZXJiYXRpbS4gKi9cbmludGVyZmFjZSBOYXRpdmVFbnRyeSB7XG4gIC8qKiBUaGUgZGVwZW5kZW5jeSBuYW1lIOKAlCB0aGUgY3JhdGUgbmFtZSwgb3IgdGhlIEdvIG1vZHVsZSBwYXRoLiAqL1xuICBrZXk6IHN0cmluZztcbiAgLyoqIFRoZSBsaW5lIHdpdGhvdXQgaXRzIHRlcm1pbmF0b3IsIGVtaXR0ZWQgdmVyYmF0aW0gd2hlbiB0aGlzIHNpZGUgd2lucy4gKi9cbiAgY29yZTogc3RyaW5nO1xuICAvKiogVGhlIGxpbmUncyBvd24gdGVybWluYXRvcjogYFxcbmAsIGBcXHJcXG5gLCBvciBlbXB0eSBhdCBlbmQgb2YgZmlsZS4gKi9cbiAgdGVybWluYXRvcjogc3RyaW5nO1xuICAvKiogVGhlIHZlcnNpb24gdG9rZW4gY29tcGFyZWQgYWdhaW5zdCB0aGUgb3RoZXIgc2lkZS4gKi9cbiAgdmVyc2lvbjogc3RyaW5nO1xuICAvKipcbiAgICogRXZlcnl0aGluZyBhYm91dCB0aGUgZW50cnkgb3RoZXIgdGhhbiBpdHMgdmVyc2lvbiwgbm9ybWFsaXNlZC5cbiAgICpcbiAgICogVHdvIHNpZGVzIHdob3NlIHNoYXBlcyBkaWZmZXIgYXJlIGEgcG9saWN5IGNoYW5nZSAoYSBuZXcgYGZlYXR1cmVzYCBsaXN0LCBhXG4gICAqIGRyb3BwZWQgYC8vIGluZGlyZWN0YCBtYXJrZXIpLCBub3QgYSB2ZXJzaW9uIGJ1bXAsIHNvIHRoZXkgZGVmZXIuXG4gICAqL1xuICBzaGFwZTogc3RyaW5nO1xufVxuXG4vKiogVGhlIGNvbXBhcmF0b3IncyBkZWNpc2lvbiBmb3Igb25lIHBhaXIgb2YgdmVyc2lvbnMuICovXG50eXBlIFZlcnNpb25PdXRjb21lID1cbiAgfCB7IGtpbmQ6IFwiaGlnaGVyXCI7IHNpZGU6IENvbmZsaWN0U2lkZSB9XG4gIHwgeyBraW5kOiBcInVuZGVjaWRhYmxlXCI7IHJlYXNvbjogc3RyaW5nIH07XG5cbi8qKiBNZXJnZSBvdXRjb21lIGZvciBhIHNpbmdsZSBodW5rLiAqL1xudHlwZSBNZXJnZU91dGNvbWUgPVxuICB8IHsga2luZDogXCJtZXJnZWRcIjsgZW50cmllczogTmF0aXZlRW50cnlbXSB9XG4gIHwgeyBraW5kOiBcInVuZGVjaWRhYmxlXCI7IHJlYXNvbjogc3RyaW5nIH07XG5cbi8qKiBTcGxpdCB0ZXh0IGludG8gbGluZXMsIGVhY2gga2VlcGluZyBpdHMgb3duIHRyYWlsaW5nIG5ld2xpbmUuICovXG5mdW5jdGlvbiBzcGxpdExpbmVzKHRleHQ6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIHRleHQubWF0Y2goL1teXFxuXSpcXG58W15cXG5dKy9nKSA/PyBbXTtcbn1cblxuLyoqIFN0cmlwIGEgbGluZSdzIHRlcm1pbmF0b3IsIHJldHVybmluZyB0aGUgY29udGVudCBhbmQgdGhlIHRlcm1pbmF0b3IuICovXG5mdW5jdGlvbiBzcGxpdFRlcm1pbmF0b3IobGluZTogc3RyaW5nKTogW3N0cmluZywgc3RyaW5nXSB7XG4gIGNvbnN0IG1hdGNoID0gbGluZS5tYXRjaCgvXFxyP1xcbiQvKTtcbiAgY29uc3QgdGVybWluYXRvciA9IG1hdGNoPy5bMF0gPz8gXCJcIjtcbiAgcmV0dXJuIFtsaW5lLnNsaWNlKDAsIGxpbmUubGVuZ3RoIC0gdGVybWluYXRvci5sZW5ndGgpLCB0ZXJtaW5hdG9yXTtcbn1cblxuLyoqIENvbGxhcHNlIHJ1bnMgb2Ygd2hpdGVzcGFjZSBzbyBjb3NtZXRpYyBzcGFjaW5nIGlzIG5vdCBhIHNoYXBlIGNoYW5nZS4gKi9cbmZ1bmN0aW9uIG5vcm1hbGlzZVNwYWNpbmcodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHRleHQucmVwbGFjZSgvXFxzKy9nLCBcIiBcIikudHJpbSgpO1xufVxuXG4vKipcbiAqIE1lcmdlIHR3byBvcmRlcmVkIGVudHJ5IGxpc3RzLCB0YWtpbmcgdGhlIGhpZ2hlciB2ZXJzaW9uIHBlciBzaGFyZWQga2V5LlxuICpcbiAqIEtleXMgdW5pcXVlIHRvIGEgc2lkZSBhcmUga2VwdCBpbiBwbGFjZSwgc28gYSBkZXBlbmRlbmN5IHRoZSBvdGhlciBicmFuY2hcbiAqIGFkZGVkIGlzIG5ldmVyIHNpbGVudGx5IGRyb3BwZWQuIEtleXMgc2hhcmVkIGJ1dCByZW9yZGVyZWQgYmV0d2VlbiB0aGUgc2lkZXNcbiAqIGFyZSB1bmRlY2lkYWJsZSDigJQgcmVvcmRlcmluZyBpcyBub3QgYSB2ZXJzaW9uIGJ1bXAuXG4gKi9cbmZ1bmN0aW9uIG1lcmdlRW50cmllcyhcbiAgb3VyczogcmVhZG9ubHkgTmF0aXZlRW50cnlbXSxcbiAgdGhlaXJzOiByZWFkb25seSBOYXRpdmVFbnRyeVtdLFxuICBjb21wYXJlOiAob3Vyczogc3RyaW5nLCB0aGVpcnM6IHN0cmluZykgPT4gVmVyc2lvbk91dGNvbWUsXG4pOiBNZXJnZU91dGNvbWUge1xuICBjb25zdCBvdXJzSW5kZXggPSBuZXcgTWFwKG91cnMubWFwKChlbnRyeSwgaW5kZXgpID0+IFtlbnRyeS5rZXksIGluZGV4XSkpO1xuICBjb25zdCBtZXJnZWQ6IE5hdGl2ZUVudHJ5W10gPSBbXTtcbiAgbGV0IGNvbnN1bWVkID0gMDtcblxuICBmb3IgKGNvbnN0IGVudHJ5IG9mIHRoZWlycykge1xuICAgIGNvbnN0IGluZGV4ID0gb3Vyc0luZGV4LmdldChlbnRyeS5rZXkpO1xuICAgIGlmIChpbmRleCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBtZXJnZWQucHVzaChlbnRyeSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGluZGV4IDwgY29uc3VtZWQpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGtpbmQ6IFwidW5kZWNpZGFibGVcIixcbiAgICAgICAgcmVhc29uOlxuICAgICAgICAgIGBkZXBlbmRlbmN5IGtleXMgYXJlIHJlb3JkZXJlZCBiZXR3ZWVuIHRoZSBzaWRlcyAoXCIke2VudHJ5LmtleX1cIilgLFxuICAgICAgfTtcbiAgICB9XG4gICAgd2hpbGUgKGNvbnN1bWVkIDwgaW5kZXgpIG1lcmdlZC5wdXNoKG91cnNbY29uc3VtZWQrK10hKTtcblxuICAgIGNvbnN0IG91ckVudHJ5ID0gb3Vyc1tjb25zdW1lZCsrXSE7XG4gICAgaWYgKG91ckVudHJ5LnNoYXBlICE9PSBlbnRyeS5zaGFwZSkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAga2luZDogXCJ1bmRlY2lkYWJsZVwiLFxuICAgICAgICByZWFzb246IGBcIiR7ZW50cnkua2V5fVwiIGNoYW5nZXMgbW9yZSB0aGFuIHRoZSB2ZXJzaW9uYCxcbiAgICAgIH07XG4gICAgfVxuICAgIGlmIChvdXJFbnRyeS52ZXJzaW9uID09PSBlbnRyeS52ZXJzaW9uKSB7XG4gICAgICBtZXJnZWQucHVzaChvdXJFbnRyeSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgdmVyZGljdCA9IGNvbXBhcmUob3VyRW50cnkudmVyc2lvbiwgZW50cnkudmVyc2lvbik7XG4gICAgaWYgKHZlcmRpY3Qua2luZCA9PT0gXCJ1bmRlY2lkYWJsZVwiKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBraW5kOiBcInVuZGVjaWRhYmxlXCIsXG4gICAgICAgIHJlYXNvbjogYFwiJHtlbnRyeS5rZXl9XCI6ICR7dmVyZGljdC5yZWFzb259YCxcbiAgICAgIH07XG4gICAgfVxuICAgIG1lcmdlZC5wdXNoKHZlcmRpY3Quc2lkZSA9PT0gXCJvdXJzXCIgPyBvdXJFbnRyeSA6IGVudHJ5KTtcbiAgfVxuXG4gIHdoaWxlIChjb25zdW1lZCA8IG91cnMubGVuZ3RoKSBtZXJnZWQucHVzaChvdXJzW2NvbnN1bWVkKytdISk7XG4gIHJldHVybiB7IGtpbmQ6IFwibWVyZ2VkXCIsIGVudHJpZXM6IG1lcmdlZCB9O1xufVxuXG4vKiogUmVuZGVyIG1lcmdlZCBlbnRyaWVzLCBlYWNoIGxpbmUga2VlcGluZyBpdHMgb3duIHRleHQgYW5kIHRlcm1pbmF0b3IuICovXG5mdW5jdGlvbiByZW5kZXJFbnRyaWVzKGVudHJpZXM6IHJlYWRvbmx5IE5hdGl2ZUVudHJ5W10pOiBzdHJpbmcge1xuICBjb25zdCBmYWxsYmFja0VvbCA9IGVudHJpZXMuZmluZCgoZSkgPT4gZS50ZXJtaW5hdG9yICE9PSBcIlwiKT8udGVybWluYXRvciA/P1xuICAgIFwiXFxuXCI7XG4gIHJldHVybiBlbnRyaWVzXG4gICAgLm1hcCgoZW50cnksIGluZGV4KSA9PlxuICAgICAgZW50cnkuY29yZSArXG4gICAgICAoaW5kZXggPT09IGVudHJpZXMubGVuZ3RoIC0gMVxuICAgICAgICA/IGVudHJ5LnRlcm1pbmF0b3JcbiAgICAgICAgOiBlbnRyeS50ZXJtaW5hdG9yIHx8IGZhbGxiYWNrRW9sKVxuICAgIClcbiAgICAuam9pbihcIlwiKTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBEaWFsZWN0IHNlYW1cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKipcbiAqIFRoZSBwZXItZm9ybWF0IGJlaGF2aW91ciB0aGUgc2hhcmVkIHJlc29sdmVyIG5lZWRzLlxuICpcbiAqIGBDdHhgIGlzIHRoZSBkaWFsZWN0J3MgbXV0YWJsZSBzY2FubmVyIHN0YXRlOiBpdCBpcyBmZWQgZXZlcnkgYnl0ZSB0aGVcbiAqIHJlc29sdmVyIGVtaXRzIOKAlCBsaXRlcmFsIHRleHQgYW5kIHJlc29sdmVkIGh1bmtzIGFsaWtlIOKAlCBzbyB0aGUgcG9zaXRpb24gb2ZcbiAqIGVhY2ggaHVuayBpcyBrbm93biB3aXRob3V0IHJlLXBhcnNpbmcgdGhlIGRvY3VtZW50LlxuICovXG5pbnRlcmZhY2UgTmF0aXZlRGlhbGVjdDxDdHg+IHtcbiAgcmVhZG9ubHkgbmFtZTogc3RyaW5nO1xuICByZWFkb25seSBiYXNlbmFtZXM6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogV2hhdCB0aGlzIGRpYWxlY3QncyByZXNvbHZhYmxlIGxpbmVzIGFyZSBjYWxsZWQsIGZvciBhIGRlZmVyIHJlYXNvbi4gKi9cbiAgcmVhZG9ubHkgZW50cnlOb3VuOiBzdHJpbmc7XG4gIC8qKiBGcmVzaCBzY2FubmVyIHN0YXRlIGZvciBvbmUgZmlsZS4gKi9cbiAgY3JlYXRlQ29udGV4dCgpOiBDdHg7XG4gIC8qKiBBZHZhbmNlIHRoZSBzY2FubmVyIG92ZXIgZW1pdHRlZCB0ZXh0LiAqL1xuICBmZWVkKGNvbnRleHQ6IEN0eCwgdGV4dDogc3RyaW5nKTogdm9pZDtcbiAgLyoqIFdoZXRoZXIgdGhlIGN1cnJlbnQgcG9zaXRpb24gaXMgYSByZWdpb24gdGhpcyBydWxlIG1heSByZXNvbHZlLiAqL1xuICBpc0RlcGVuZGVuY3lSZWdpb24oY29udGV4dDogQ3R4KTogYm9vbGVhbjtcbiAgLyoqIEh1bWFuLXJlYWRhYmxlIGN1cnJlbnQgcG9zaXRpb24sIGZvciBhbiBgdW5yZXNvbHZlZGAgcmVhc29uLiAqL1xuICBkZXNjcmliZShjb250ZXh0OiBDdHgpOiBzdHJpbmc7XG4gIC8qKiBQYXJzZSBvbmUgc2lkZSBvZiBhIGh1bmssIG9yIG51bGwgd2hlbiBpdCBpcyBub3QgZW50cmllcyBhbG9uZS4gKi9cbiAgcGFyc2VFbnRyaWVzKGNvbnRleHQ6IEN0eCwgc2lkZTogc3RyaW5nKTogTmF0aXZlRW50cnlbXSB8IG51bGw7XG4gIC8qKiBEZWNpZGUgd2hpY2ggdmVyc2lvbiBpcyBsYXRlci4gKi9cbiAgY29tcGFyZShvdXJzOiBzdHJpbmcsIHRoZWlyczogc3RyaW5nKTogVmVyc2lvbk91dGNvbWU7XG4gIC8qKiBPcHRpb25hbCB3aG9sZS1maWxlIGd1YXJkLCByZXR1cm5pbmcgYSBkZWZlciByZWFzb24uICovXG4gIGd1YXJkPyh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsO1xufVxuXG5mdW5jdGlvbiByZXNvbHZlU2VnbWVudHM8Q3R4PihcbiAgZGlhbGVjdDogTmF0aXZlRGlhbGVjdDxDdHg+LFxuICBzZWdtZW50czogcmVhZG9ubHkgQ29uZmxpY3RTZWdtZW50W10sXG4pOiBSdWxlT3V0Y29tZSB7XG4gIGNvbnN0IGRlZmVyID0gKHJlYXNvbjogc3RyaW5nKTogUnVsZU91dGNvbWUgPT4gKHtcbiAgICBraW5kOiBcInVucmVzb2x2ZWRcIixcbiAgICByZWFzb246IGAke2RpYWxlY3QubmFtZX06ICR7cmVhc29ufWAsXG4gIH0pO1xuXG4gIGNvbnN0IGd1YXJkUmVhc29uID0gZGlhbGVjdC5ndWFyZD8uKHJlbmRlckNvbmZsaWN0U2VnbWVudHMoc2VnbWVudHMpKTtcbiAgaWYgKGd1YXJkUmVhc29uKSByZXR1cm4gZGVmZXIoZ3VhcmRSZWFzb24pO1xuXG4gIGNvbnN0IGNvbnRleHQgPSBkaWFsZWN0LmNyZWF0ZUNvbnRleHQoKTtcbiAgbGV0IG91dCA9IFwiXCI7XG4gIGxldCBodW5rTnVtYmVyID0gMDtcblxuICBmb3IgKGNvbnN0IHNlZ21lbnQgb2Ygc2VnbWVudHMpIHtcbiAgICBpZiAoc2VnbWVudC5raW5kID09PSBcImxpdGVyYWxcIikge1xuICAgICAgb3V0ICs9IHNlZ21lbnQudGV4dDtcbiAgICAgIGRpYWxlY3QuZmVlZChjb250ZXh0LCBzZWdtZW50LnRleHQpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgaHVua051bWJlcisrO1xuICAgIGlmICghZGlhbGVjdC5pc0RlcGVuZGVuY3lSZWdpb24oY29udGV4dCkpIHtcbiAgICAgIHJldHVybiBkZWZlcihcbiAgICAgICAgYGh1bmsgJHtodW5rTnVtYmVyfSBpcyAke2RpYWxlY3QuZGVzY3JpYmUoY29udGV4dCl9YCxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3Qgb3VycyA9IGRpYWxlY3QucGFyc2VFbnRyaWVzKGNvbnRleHQsIHNlZ21lbnQub3Vycyk7XG4gICAgY29uc3QgdGhlaXJzID0gZGlhbGVjdC5wYXJzZUVudHJpZXMoY29udGV4dCwgc2VnbWVudC50aGVpcnMpO1xuICAgIGlmICghb3VycyB8fCAhdGhlaXJzKSB7XG4gICAgICByZXR1cm4gZGVmZXIoXG4gICAgICAgIGBodW5rICR7aHVua051bWJlcn0gdG91Y2hlcyBtb3JlIHRoYW4gJHtkaWFsZWN0LmVudHJ5Tm91bn0gZW50cmllc2AsXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IG1lcmdlZCA9IG1lcmdlRW50cmllcyhvdXJzLCB0aGVpcnMsIGRpYWxlY3QuY29tcGFyZSk7XG4gICAgaWYgKG1lcmdlZC5raW5kID09PSBcInVuZGVjaWRhYmxlXCIpIHtcbiAgICAgIHJldHVybiBkZWZlcihgaHVuayAke2h1bmtOdW1iZXJ9IOKAlCAke21lcmdlZC5yZWFzb259YCk7XG4gICAgfVxuXG4gICAgY29uc3QgdGV4dCA9IHJlbmRlckVudHJpZXMobWVyZ2VkLmVudHJpZXMpO1xuICAgIG91dCArPSB0ZXh0O1xuICAgIGRpYWxlY3QuZmVlZChjb250ZXh0LCB0ZXh0KTtcbiAgfVxuXG4gIHJldHVybiB7IGtpbmQ6IFwicmVzb2x2ZWRcIiwgdGV4dDogb3V0IH07XG59XG5cbi8qKiBUaGUgZmluYWwgcGF0aCBjb21wb25lbnQsIGZvciBib3RoIGAvYCBhbmQgYFxcYCBzZXBhcmF0ZWQgcGF0aHMuICovXG5mdW5jdGlvbiBiYXNlbmFtZShwYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gcGF0aC5zcGxpdCgvW1xcXFwvXS8pLmF0KC0xKSA/PyBwYXRoO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVSdWxlPEN0eD4oZGlhbGVjdDogTmF0aXZlRGlhbGVjdDxDdHg+KTogTWFuaWZlc3RSdWxlIHtcbiAgcmV0dXJuIHtcbiAgICBuYW1lOiBkaWFsZWN0Lm5hbWUsXG4gICAgbWF0Y2hlczogKHBhdGgpID0+IGRpYWxlY3QuYmFzZW5hbWVzLmluY2x1ZGVzKGJhc2VuYW1lKHBhdGgpKSxcbiAgICByZXNvbHZlOiAoc2VnbWVudHMpID0+IHJlc29sdmVTZWdtZW50cyhkaWFsZWN0LCBzZWdtZW50cyksXG4gIH07XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gQ2FyZ28udG9tbFxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKiBTY2FubmVyIHN0YXRlIGZvciBgQ2FyZ28udG9tbGA6IHRoZSB0YWJsZSBoZWFkZXIgY3VycmVudGx5IGluIGZvcmNlLiAqL1xuaW50ZXJmYWNlIENhcmdvQ29udGV4dCB7XG4gIC8qKiBUaGUgZG90dGVkIGhlYWRlciB0ZXh0LCBvciBudWxsIGJlZm9yZSB0aGUgZmlyc3QgaGVhZGVyLiAqL1xuICBoZWFkZXI6IHN0cmluZyB8IG51bGw7XG4gIC8qKiBBIHBhcnRpYWwgdHJhaWxpbmcgbGluZSwgYXdhaXRpbmcgdGhlIHJlc3Qgb2YgaXRzIHRleHQuICovXG4gIHBlbmRpbmc6IHN0cmluZztcbn1cblxuLyoqIEEgdGFibGUgaGVhZGVyIGxpbmUsIHdpdGggYW4gb3B0aW9uYWwgdHJhaWxpbmcgY29tbWVudC4gKi9cbmNvbnN0IENBUkdPX0hFQURFUiA9IC9eWyBcXHRdKihcXFtcXFs/KShbXlxcXV0rKVxcXVxcXT9bIFxcdF0qKCMuKik/JC87XG5cbi8qKiBBIGBrZXkgPSB2YWx1ZWAgbGluZTsgdGhlIHZhbHVlIGlzIGNsYXNzaWZpZWQgc2VwYXJhdGVseS4gKi9cbmNvbnN0IENBUkdPX0VOVFJZID1cbiAgL15bIFxcdF0qKCg/OlwiKD86W15cIlxcXFxdfFxcXFwuKSpcIil8W0EtWmEtejAtOV8rLi1dKylbIFxcdF0qPVsgXFx0XSooLis/KVsgXFx0XSooXFxyP1xcbj8pJC87XG5cbi8qKiBBIHF1b3RlZCB2ZXJzaW9uIHN0cmluZywgdGhlIG9ubHkgdmFsdWUgc2hhcGUgd29ydGggY29tcGFyaW5nLiAqL1xuY29uc3QgQ0FSR09fVkVSU0lPTl9TVFJJTkcgPSAvXlwiKFteXCJcXFxcXSopXCIkLztcblxuLyoqIFRoZSBkZXBlbmRlbmN5IHRhYmxlcyB0aGlzIHJ1bGUgbWF5IHJlc29sdmUsIGtleWVkIG9uIHRoZSBmaW5hbCBzZWdtZW50LiAqL1xuY29uc3QgQ0FSR09fREVQRU5ERU5DWV9UQUJMRVM6IHJlYWRvbmx5IHN0cmluZ1tdID0gW1xuICBcImRlcGVuZGVuY2llc1wiLFxuICBcImRldi1kZXBlbmRlbmNpZXNcIixcbiAgXCJidWlsZC1kZXBlbmRlbmNpZXNcIixcbl07XG5cbi8qKlxuICogU3BsaXQgYSBkb3R0ZWQgVE9NTCBrZXkgcGF0aCwgaG9ub3VyaW5nIHF1b3RlZCBzZWdtZW50cy5cbiAqXG4gKiBgdGFyZ2V0LidjZmcodW5peCknLmRlcGVuZGVuY2llc2AgaXMgdGhyZWUgc2VnbWVudHMsIG5vdCBmaXZlOiB0aGUgYC5gIGluc2lkZVxuICogdGhlIHF1b3RlZCBgY2ZnKHVuaXgpYCBwcmVkaWNhdGUgaXMgcGFydCBvZiB0aGF0IHNlZ21lbnQncyB0ZXh0LlxuICovXG5mdW5jdGlvbiBzcGxpdFRvbWxLZXkoaGVhZGVyOiBzdHJpbmcpOiBzdHJpbmdbXSB8IG51bGwge1xuICBjb25zdCBzZWdtZW50czogc3RyaW5nW10gPSBbXTtcbiAgbGV0IGN1cnJlbnQgPSBcIlwiO1xuICBsZXQgcXVvdGU6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG4gIGZvciAoY29uc3QgY2hhciBvZiBoZWFkZXIpIHtcbiAgICBpZiAocXVvdGUpIHtcbiAgICAgIGN1cnJlbnQgKz0gY2hhcjtcbiAgICAgIGlmIChjaGFyID09PSBxdW90ZSkgcXVvdGUgPSBudWxsO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChjaGFyID09PSAnXCInIHx8IGNoYXIgPT09IFwiJ1wiKSB7XG4gICAgICBxdW90ZSA9IGNoYXI7XG4gICAgICBjdXJyZW50ICs9IGNoYXI7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGNoYXIgPT09IFwiLlwiKSB7XG4gICAgICBzZWdtZW50cy5wdXNoKGN1cnJlbnQudHJpbSgpKTtcbiAgICAgIGN1cnJlbnQgPSBcIlwiO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGN1cnJlbnQgKz0gY2hhcjtcbiAgfVxuICBpZiAocXVvdGUpIHJldHVybiBudWxsO1xuICBzZWdtZW50cy5wdXNoKGN1cnJlbnQudHJpbSgpKTtcbiAgcmV0dXJuIHNlZ21lbnRzO1xufVxuXG4vKiogV2hldGhlciBhIGhlYWRlciBuYW1lcyBhIGRlcGVuZGVuY3kgdGFibGUgdGhpcyBydWxlIG1heSByZXNvbHZlLiAqL1xuZnVuY3Rpb24gaXNDYXJnb0RlcGVuZGVuY3lUYWJsZShoZWFkZXI6IHN0cmluZyB8IG51bGwpOiBib29sZWFuIHtcbiAgaWYgKGhlYWRlciA9PT0gbnVsbCkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBzZWdtZW50cyA9IHNwbGl0VG9tbEtleShoZWFkZXIpO1xuICBpZiAoIXNlZ21lbnRzKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGxhc3QgPSBzZWdtZW50cy5hdCgtMSkgPz8gXCJcIjtcbiAgaWYgKCFDQVJHT19ERVBFTkRFTkNZX1RBQkxFUy5pbmNsdWRlcyhsYXN0KSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gc2VnbWVudHMubGVuZ3RoID09PSAxIHx8XG4gICAgKHNlZ21lbnRzLmxlbmd0aCA9PT0gMyAmJiBzZWdtZW50c1swXSA9PT0gXCJ0YXJnZXRcIik7XG59XG5cbi8qKiBTcGxpdCBhbiBpbmxpbmUgdGFibGUgYm9keSBvbiBpdHMgdG9wLWxldmVsIGNvbW1hcy4gKi9cbmZ1bmN0aW9uIHNwbGl0SW5saW5lRmllbGRzKGJvZHk6IHN0cmluZyk6IHN0cmluZ1tdIHwgbnVsbCB7XG4gIGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuICBsZXQgY3VycmVudCA9IFwiXCI7XG4gIGxldCBkZXB0aCA9IDA7XG4gIGxldCBxdW90ZTogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIGxldCBlc2NhcGVkID0gZmFsc2U7XG5cbiAgZm9yIChjb25zdCBjaGFyIG9mIGJvZHkpIHtcbiAgICBpZiAocXVvdGUpIHtcbiAgICAgIGN1cnJlbnQgKz0gY2hhcjtcbiAgICAgIGlmIChlc2NhcGVkKSBlc2NhcGVkID0gZmFsc2U7XG4gICAgICBlbHNlIGlmIChjaGFyID09PSBcIlxcXFxcIikgZXNjYXBlZCA9IHRydWU7XG4gICAgICBlbHNlIGlmIChjaGFyID09PSBxdW90ZSkgcXVvdGUgPSBudWxsO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChjaGFyID09PSAnXCInIHx8IGNoYXIgPT09IFwiJ1wiKSB7XG4gICAgICBxdW90ZSA9IGNoYXI7XG4gICAgICBjdXJyZW50ICs9IGNoYXI7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGNoYXIgPT09IFwiW1wiIHx8IGNoYXIgPT09IFwie1wiKSBkZXB0aCsrO1xuICAgIGlmIChjaGFyID09PSBcIl1cIiB8fCBjaGFyID09PSBcIn1cIikge1xuICAgICAgZGVwdGgtLTtcbiAgICAgIGlmIChkZXB0aCA8IDApIHJldHVybiBudWxsO1xuICAgIH1cbiAgICBpZiAoY2hhciA9PT0gXCIsXCIgJiYgZGVwdGggPT09IDApIHtcbiAgICAgIHBhcnRzLnB1c2goY3VycmVudCk7XG4gICAgICBjdXJyZW50ID0gXCJcIjtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjdXJyZW50ICs9IGNoYXI7XG4gIH1cbiAgaWYgKHF1b3RlIHx8IGRlcHRoICE9PSAwKSByZXR1cm4gbnVsbDtcbiAgaWYgKGN1cnJlbnQudHJpbSgpICE9PSBcIlwiKSBwYXJ0cy5wdXNoKGN1cnJlbnQpO1xuICByZXR1cm4gcGFydHM7XG59XG5cbi8qKiBQYXJzZSBhbiBpbmxpbmUgdGFibGUgYm9keSBpbnRvIGl0cyBmaWVsZHMsIG9yIG51bGwgd2hlbiBtYWxmb3JtZWQuICovXG5mdW5jdGlvbiBwYXJzZUlubGluZVRhYmxlKGJvZHk6IHN0cmluZyk6IE1hcDxzdHJpbmcsIHN0cmluZz4gfCBudWxsIHtcbiAgY29uc3QgcGFydHMgPSBzcGxpdElubGluZUZpZWxkcyhib2R5KTtcbiAgaWYgKCFwYXJ0cykgcmV0dXJuIG51bGw7XG5cbiAgY29uc3QgZmllbGRzID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcbiAgZm9yIChjb25zdCBwYXJ0IG9mIHBhcnRzKSB7XG4gICAgY29uc3QgbWF0Y2ggPSBwYXJ0Lm1hdGNoKFxuICAgICAgL15bIFxcdF0qKCg/OlwiKD86W15cIlxcXFxdfFxcXFwuKSpcIil8W0EtWmEtejAtOV8rLi1dKylbIFxcdF0qPVsgXFx0XSooLis/KVsgXFx0XSokLyxcbiAgICApO1xuICAgIGlmICghbWF0Y2gpIHJldHVybiBudWxsO1xuICAgIGNvbnN0IGtleSA9IG1hdGNoWzFdITtcbiAgICBpZiAoZmllbGRzLmhhcyhrZXkpKSByZXR1cm4gbnVsbDtcbiAgICBmaWVsZHMuc2V0KGtleSwgbm9ybWFsaXNlU3BhY2luZyhtYXRjaFsyXSEpKTtcbiAgfVxuICByZXR1cm4gZmllbGRzO1xufVxuXG4vKiogQ2xhc3NpZnkgYSBkZXBlbmRlbmN5IHZhbHVlIGludG8gaXRzIHZlcnNpb24gYW5kIGl0cyByZW1haW5pbmcgc2hhcGUuICovXG5mdW5jdGlvbiBwYXJzZUNhcmdvVmFsdWUoXG4gIHJhdzogc3RyaW5nLFxuKTogeyB2ZXJzaW9uOiBzdHJpbmc7IHNoYXBlOiBzdHJpbmcgfSB8IG51bGwge1xuICBjb25zdCBzaG9ydCA9IHJhdy5tYXRjaChDQVJHT19WRVJTSU9OX1NUUklORyk7XG4gIGlmIChzaG9ydCkgcmV0dXJuIHsgdmVyc2lvbjogc2hvcnRbMV0hLCBzaGFwZTogXCJzaG9ydFwiIH07XG5cbiAgaWYgKCFyYXcuc3RhcnRzV2l0aChcIntcIikgfHwgIXJhdy5lbmRzV2l0aChcIn1cIikpIHJldHVybiBudWxsO1xuICBjb25zdCBmaWVsZHMgPSBwYXJzZUlubGluZVRhYmxlKHJhdy5zbGljZSgxLCAtMSkpO1xuICBpZiAoIWZpZWxkcykgcmV0dXJuIG51bGw7XG5cbiAgY29uc3QgdmVyc2lvbiA9IGZpZWxkcy5nZXQoXCJ2ZXJzaW9uXCIpPy5tYXRjaChDQVJHT19WRVJTSU9OX1NUUklORyk7XG4gIGlmICghdmVyc2lvbikgcmV0dXJuIG51bGw7XG5cbiAgY29uc3Qgb3RoZXJzID0gWy4uLmZpZWxkc11cbiAgICAuZmlsdGVyKChba2V5XSkgPT4ga2V5ICE9PSBcInZlcnNpb25cIilcbiAgICAubWFwKChba2V5LCB2YWx1ZV0pID0+IGAke2tleX09JHt2YWx1ZX1gKVxuICAgIC5zb3J0KCk7XG4gIHJldHVybiB7IHZlcnNpb246IHZlcnNpb25bMV0hLCBzaGFwZTogYHRhYmxleyR7b3RoZXJzLmpvaW4oXCIsXCIpfX1gIH07XG59XG5cbmNvbnN0IGNhcmdvRGlhbGVjdDogTmF0aXZlRGlhbGVjdDxDYXJnb0NvbnRleHQ+ID0ge1xuICBuYW1lOiBcIkNhcmdvLnRvbWxcIixcbiAgYmFzZW5hbWVzOiBbXCJDYXJnby50b21sXCJdLFxuICBlbnRyeU5vdW46IFwiZGVwZW5kZW5jeVwiLFxuXG4gIGNyZWF0ZUNvbnRleHQ6ICgpID0+ICh7IGhlYWRlcjogbnVsbCwgcGVuZGluZzogXCJcIiB9KSxcblxuICBmZWVkKGNvbnRleHQsIHRleHQpIHtcbiAgICBjb25zdCBsaW5lcyA9IHNwbGl0TGluZXMoY29udGV4dC5wZW5kaW5nICsgdGV4dCk7XG4gICAgY29udGV4dC5wZW5kaW5nID0gXCJcIjtcbiAgICBmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMpIHtcbiAgICAgIGNvbnN0IFtjb250ZW50LCB0ZXJtaW5hdG9yXSA9IHNwbGl0VGVybWluYXRvcihsaW5lKTtcbiAgICAgIGlmICh0ZXJtaW5hdG9yID09PSBcIlwiKSB7XG4gICAgICAgIGNvbnRleHQucGVuZGluZyA9IGNvbnRlbnQ7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgY29uc3QgbWF0Y2ggPSBjb250ZW50Lm1hdGNoKENBUkdPX0hFQURFUik7XG4gICAgICBpZiAoIW1hdGNoKSBjb250aW51ZTtcbiAgICAgIC8vIEFuIGFycmF5LW9mLXRhYmxlcyBoZWFkZXIgKGBbW2Jpbl1dYCkgaXMgbmV2ZXIgYSBkZXBlbmRlbmN5IHRhYmxlLlxuICAgICAgY29udGV4dC5oZWFkZXIgPSBtYXRjaFsxXSA9PT0gXCJbW1wiID8gbnVsbCA6IG1hdGNoWzJdIS50cmltKCk7XG4gICAgfVxuICB9LFxuXG4gIGlzRGVwZW5kZW5jeVJlZ2lvbjogKGNvbnRleHQpID0+IGlzQ2FyZ29EZXBlbmRlbmN5VGFibGUoY29udGV4dC5oZWFkZXIpLFxuXG4gIGRlc2NyaWJlOiAoY29udGV4dCkgPT5cbiAgICBjb250ZXh0LmhlYWRlciA9PT0gbnVsbFxuICAgICAgPyBcIm5vdCBpbnNpZGUgYSBkZXBlbmRlbmN5IHRhYmxlIChubyB0YWJsZSBoZWFkZXIgeWV0KVwiXG4gICAgICA6IGBub3QgaW5zaWRlIGEgZGVwZW5kZW5jeSB0YWJsZSAoWyR7Y29udGV4dC5oZWFkZXJ9XSlgLFxuXG4gIHBhcnNlRW50cmllcyhfY29udGV4dCwgc2lkZSkge1xuICAgIGNvbnN0IGVudHJpZXM6IE5hdGl2ZUVudHJ5W10gPSBbXTtcbiAgICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cbiAgICBmb3IgKGNvbnN0IGxpbmUgb2Ygc3BsaXRMaW5lcyhzaWRlKSkge1xuICAgICAgY29uc3QgbWF0Y2ggPSBsaW5lLm1hdGNoKENBUkdPX0VOVFJZKTtcbiAgICAgIGlmICghbWF0Y2gpIHJldHVybiBudWxsO1xuICAgICAgY29uc3QgdmFsdWUgPSBwYXJzZUNhcmdvVmFsdWUobWF0Y2hbMl0hKTtcbiAgICAgIGlmICghdmFsdWUpIHJldHVybiBudWxsO1xuXG4gICAgICBjb25zdCBrZXkgPSBtYXRjaFsxXSE7XG4gICAgICBpZiAoc2Vlbi5oYXMoa2V5KSkgcmV0dXJuIG51bGw7XG4gICAgICBzZWVuLmFkZChrZXkpO1xuXG4gICAgICBjb25zdCB0ZXJtaW5hdG9yID0gbWF0Y2hbM10gPz8gXCJcIjtcbiAgICAgIGVudHJpZXMucHVzaCh7XG4gICAgICAgIGtleSxcbiAgICAgICAgY29yZTogbGluZS5zbGljZSgwLCBsaW5lLmxlbmd0aCAtIHRlcm1pbmF0b3IubGVuZ3RoKSxcbiAgICAgICAgdGVybWluYXRvcixcbiAgICAgICAgdmVyc2lvbjogdmFsdWUudmVyc2lvbixcbiAgICAgICAgc2hhcGU6IHZhbHVlLnNoYXBlLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGVudHJpZXMubGVuZ3RoID4gMCA/IGVudHJpZXMgOiBudWxsO1xuICB9LFxuXG4gIGNvbXBhcmUob3VycywgdGhlaXJzKSB7XG4gICAgY29uc3QgdmVyZGljdCA9IGNvbXBhcmVEZXBlbmRlbmN5U3BlY2lmaWVycyhvdXJzLCB0aGVpcnMpO1xuICAgIHJldHVybiB2ZXJkaWN0LmtpbmQgPT09IFwiaGlnaGVyXCJcbiAgICAgID8geyBraW5kOiBcImhpZ2hlclwiLCBzaWRlOiB2ZXJkaWN0LnNpZGUgfVxuICAgICAgOiB7IGtpbmQ6IFwidW5kZWNpZGFibGVcIiwgcmVhc29uOiB2ZXJkaWN0LnJlYXNvbiB9O1xuICB9LFxuXG4gIGd1YXJkKHRleHQpIHtcbiAgICAvLyBUaGUgaGVhZGVyIHNjYW5uZXIgcmVhZHMgbGluZSBieSBsaW5lLCBzbyBhIGBcIlwiXCJgIG9yIGAnJydgIGJsb2NrIGNvdWxkXG4gICAgLy8gaGlkZSBhIGxpbmUgdGhhdCBsb29rcyBsaWtlIGEgdGFibGUgaGVhZGVyLiBEZWZlciByYXRoZXIgdGhhbiBndWVzcy5cbiAgICByZXR1cm4gL1wiXCJcInwnJycvLnRlc3QodGV4dClcbiAgICAgID8gXCJ0aGUgZmlsZSBjb250YWlucyBhIG11bHRpLWxpbmUgc3RyaW5nLCB3aGljaCB0aGUgdGFibGUgc2Nhbm5lciBkb2VzIG5vdCBmb2xsb3dcIlxuICAgICAgOiBudWxsO1xuICB9LFxufTtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBnby5tb2Rcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKiogU2Nhbm5lciBzdGF0ZSBmb3IgYGdvLm1vZGA6IHRoZSBwYXJlbnRoZXNpc2VkIGJsb2NrIGN1cnJlbnRseSBvcGVuLiAqL1xuaW50ZXJmYWNlIEdvTW9kQ29udGV4dCB7XG4gIC8qKiBUaGUgb3BlbiBibG9jaydzIGRpcmVjdGl2ZSAoYHJlcXVpcmVgLCBgcmVwbGFjZWAsIOKApiksIG9yIG51bGwuICovXG4gIGJsb2NrOiBzdHJpbmcgfCBudWxsO1xuICAvKiogQSBwYXJ0aWFsIHRyYWlsaW5nIGxpbmUsIGF3YWl0aW5nIHRoZSByZXN0IG9mIGl0cyB0ZXh0LiAqL1xuICBwZW5kaW5nOiBzdHJpbmc7XG59XG5cbi8qKiBBIGRpcmVjdGl2ZSBvcGVuaW5nIGEgcGFyZW50aGVzaXNlZCBibG9jaywgZS5nLiBgcmVxdWlyZSAoYC4gKi9cbmNvbnN0IEdPX0JMT0NLX09QRU4gPSAvXlsgXFx0XSooW2Etel0rKVsgXFx0XSpcXChbIFxcdF0qJC87XG5cbi8qKiBBIGBtb2R1bGUgdmVyc2lvbmAgbGluZSBpbnNpZGUgYSBgcmVxdWlyZWAgYmxvY2ssIHdpdGggb3B0aW9uYWwgY29tbWVudC4gKi9cbmNvbnN0IEdPX0JMT0NLX0VOVFJZID1cbiAgL15bIFxcdF0qKFteXFxzKCldKylbIFxcdF0rKFteXFxzKCldKylbIFxcdF0qKFxcL1xcLy4qPyk/WyBcXHRdKihcXHI/XFxuPykkLztcblxuLyoqIEEgc2luZ2xlLWxpbmUgYHJlcXVpcmUgbW9kdWxlIHZlcnNpb25gIGRpcmVjdGl2ZS4gKi9cbmNvbnN0IEdPX1NJTkdMRV9FTlRSWSA9XG4gIC9eWyBcXHRdKnJlcXVpcmVbIFxcdF0rKFteXFxzKCldKylbIFxcdF0rKFteXFxzKCldKylbIFxcdF0qKFxcL1xcLy4qPyk/WyBcXHRdKihcXHI/XFxuPykkLztcblxuLyoqXG4gKiBBIHBsYWluIEdvIHNlbXZlciB2ZXJzaW9uOiBtYW5kYXRvcnkgYHZgLCBleGFjdGx5IHRocmVlIG51bWVyaWMgc2VnbWVudHMuXG4gKlxuICogUHNldWRvLXZlcnNpb25zIChgdjAuMC4wLTIwMjMwMTAxMTIwMDAwLWFiY2RlZjEyMzQ1NmApIGFuZCBgK2luY29tcGF0aWJsZWBcbiAqIGFyZSBkZWxpYmVyYXRlbHkgZXhjbHVkZWQg4oCUIGEgdGltZXN0YW1wLW9yZGVyZWQgcHNldWRvLXZlcnNpb24gaXMgbm90XG4gKiBjb21wYXJhYmxlIGJ5IHRoZSBzZW12ZXIgcnVsZSwgYW5kIGAraW5jb21wYXRpYmxlYCBtYXJrcyBhIG1vZHVsZSBvdXRzaWRlIHRoZVxuICogdmVyc2lvbmluZyBzY2hlbWUgZW50aXJlbHkuXG4gKi9cbmNvbnN0IEdPX1ZFUlNJT04gPSAvXnZcXGQrXFwuXFxkK1xcLlxcZCskLztcblxuY29uc3QgZ29Nb2REaWFsZWN0OiBOYXRpdmVEaWFsZWN0PEdvTW9kQ29udGV4dD4gPSB7XG4gIG5hbWU6IFwiZ28ubW9kXCIsXG4gIGJhc2VuYW1lczogW1wiZ28ubW9kXCJdLFxuICBlbnRyeU5vdW46IFwicmVxdWlyZVwiLFxuXG4gIGNyZWF0ZUNvbnRleHQ6ICgpID0+ICh7IGJsb2NrOiBudWxsLCBwZW5kaW5nOiBcIlwiIH0pLFxuXG4gIGZlZWQoY29udGV4dCwgdGV4dCkge1xuICAgIGNvbnN0IGxpbmVzID0gc3BsaXRMaW5lcyhjb250ZXh0LnBlbmRpbmcgKyB0ZXh0KTtcbiAgICBjb250ZXh0LnBlbmRpbmcgPSBcIlwiO1xuICAgIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuICAgICAgY29uc3QgW2NvbnRlbnQsIHRlcm1pbmF0b3JdID0gc3BsaXRUZXJtaW5hdG9yKGxpbmUpO1xuICAgICAgaWYgKHRlcm1pbmF0b3IgPT09IFwiXCIpIHtcbiAgICAgICAgY29udGV4dC5wZW5kaW5nID0gY29udGVudDtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBpZiAoY29udGV4dC5ibG9jayAhPT0gbnVsbCkge1xuICAgICAgICBpZiAoY29udGVudC50cmltKCkuc3RhcnRzV2l0aChcIilcIikpIGNvbnRleHQuYmxvY2sgPSBudWxsO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IG1hdGNoID0gY29udGVudC5tYXRjaChHT19CTE9DS19PUEVOKTtcbiAgICAgIGlmIChtYXRjaCkgY29udGV4dC5ibG9jayA9IG1hdGNoWzFdITtcbiAgICB9XG4gIH0sXG5cbiAgLy8gQSBodW5rIGF0IHRoZSB0b3AgbGV2ZWwgbWF5IHN0aWxsIGJlIGEgc2luZ2xlLWxpbmUgYHJlcXVpcmVgOyBhbnkgb3RoZXJcbiAgLy8gb3BlbiBibG9jayAoYHJlcGxhY2VgLCBgZXhjbHVkZWAsIGByZXRyYWN0YCkgaXMgbmV2ZXIgcmVzb2x2YWJsZS5cbiAgaXNEZXBlbmRlbmN5UmVnaW9uOiAoY29udGV4dCkgPT5cbiAgICBjb250ZXh0LmJsb2NrID09PSBudWxsIHx8IGNvbnRleHQuYmxvY2sgPT09IFwicmVxdWlyZVwiLFxuXG4gIGRlc2NyaWJlOiAoY29udGV4dCkgPT5cbiAgICBgbm90IGluc2lkZSBhIHJlcXVpcmUgZGlyZWN0aXZlICh0aGUgJHtjb250ZXh0LmJsb2NrfSBibG9jaylgLFxuXG4gIHBhcnNlRW50cmllcyhjb250ZXh0LCBzaWRlKSB7XG4gICAgY29uc3QgcGF0dGVybiA9IGNvbnRleHQuYmxvY2sgPT09IFwicmVxdWlyZVwiXG4gICAgICA/IEdPX0JMT0NLX0VOVFJZXG4gICAgICA6IEdPX1NJTkdMRV9FTlRSWTtcbiAgICBjb25zdCBlbnRyaWVzOiBOYXRpdmVFbnRyeVtdID0gW107XG4gICAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gICAgZm9yIChjb25zdCBsaW5lIG9mIHNwbGl0TGluZXMoc2lkZSkpIHtcbiAgICAgIGNvbnN0IG1hdGNoID0gbGluZS5tYXRjaChwYXR0ZXJuKTtcbiAgICAgIGlmICghbWF0Y2gpIHJldHVybiBudWxsO1xuXG4gICAgICBjb25zdCBrZXkgPSBtYXRjaFsxXSE7XG4gICAgICAvLyBBIGNvbW1lbnQgbGluZSBwYXJzZXMgYXMgdHdvIHRva2VuczsgaXQgaXMgbm90IGEgcmVxdWlyZSBlbnRyeS5cbiAgICAgIGlmIChrZXkuc3RhcnRzV2l0aChcIi8vXCIpKSByZXR1cm4gbnVsbDtcbiAgICAgIGlmIChzZWVuLmhhcyhrZXkpKSByZXR1cm4gbnVsbDtcbiAgICAgIHNlZW4uYWRkKGtleSk7XG5cbiAgICAgIGNvbnN0IHRlcm1pbmF0b3IgPSBtYXRjaFs0XSA/PyBcIlwiO1xuICAgICAgZW50cmllcy5wdXNoKHtcbiAgICAgICAga2V5LFxuICAgICAgICBjb3JlOiBsaW5lLnNsaWNlKDAsIGxpbmUubGVuZ3RoIC0gdGVybWluYXRvci5sZW5ndGgpLFxuICAgICAgICB0ZXJtaW5hdG9yLFxuICAgICAgICB2ZXJzaW9uOiBtYXRjaFsyXSEsXG4gICAgICAgIHNoYXBlOiBtYXRjaFszXSA/PyBcIlwiLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGVudHJpZXMubGVuZ3RoID4gMCA/IGVudHJpZXMgOiBudWxsO1xuICB9LFxuXG4gIGNvbXBhcmUob3VycywgdGhlaXJzKSB7XG4gICAgZm9yIChjb25zdCB2ZXJzaW9uIG9mIFtvdXJzLCB0aGVpcnNdKSB7XG4gICAgICBpZiAoIUdPX1ZFUlNJT04udGVzdCh2ZXJzaW9uKSkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGtpbmQ6IFwidW5kZWNpZGFibGVcIixcbiAgICAgICAgICByZWFzb246IGBub3QgYSBwbGFpbiBHbyBzZW12ZXIgdmVyc2lvbjogJHt2ZXJzaW9ufWAsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IHZlcmRpY3QgPSBjb21wYXJlRGVwZW5kZW5jeVNwZWNpZmllcnMob3VycywgdGhlaXJzKTtcbiAgICByZXR1cm4gdmVyZGljdC5raW5kID09PSBcImhpZ2hlclwiXG4gICAgICA/IHsga2luZDogXCJoaWdoZXJcIiwgc2lkZTogdmVyZGljdC5zaWRlIH1cbiAgICAgIDogeyBraW5kOiBcInVuZGVjaWRhYmxlXCIsIHJlYXNvbjogdmVyZGljdC5yZWFzb24gfTtcbiAgfSxcbn07XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gUmVnaXN0cmF0aW9uXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqIGBDYXJnby50b21sYDogdGhlIGRlcGVuZGVuY3kgdGFibGVzLCBzaG9ydCBhbmQgaW5saW5lLXRhYmxlIGVudHJ5IGZvcm1zLiAqL1xuZXhwb3J0IGNvbnN0IGNhcmdvVG9tbFJ1bGU6IE1hbmlmZXN0UnVsZSA9IGNyZWF0ZVJ1bGUoY2FyZ29EaWFsZWN0KTtcblxuLyoqIGBnby5tb2RgOiBgcmVxdWlyZWAgbGluZXMsIHNpbmdsZS1saW5lIGFuZCBwYXJlbnRoZXNpc2VkLWJsb2NrIGZvcm1zLiAqL1xuZXhwb3J0IGNvbnN0IGdvTW9kUnVsZTogTWFuaWZlc3RSdWxlID0gY3JlYXRlUnVsZShnb01vZERpYWxlY3QpO1xuXG4vKiogVGhlIG5hdGl2ZSBtYW5pZmVzdCBydWxlcywgaW4gbWF0Y2ggb3JkZXIuICovXG5leHBvcnQgY29uc3QgbmF0aXZlTWFuaWZlc3RSdWxlczogcmVhZG9ubHkgTWFuaWZlc3RSdWxlW10gPSBbXG4gIGNhcmdvVG9tbFJ1bGUsXG4gIGdvTW9kUnVsZSxcbl07XG5cbi8qKlxuICogUmVnaXN0ZXIgdGhlIG5hdGl2ZSBtYW5pZmVzdCBydWxlcyBpbnRvIGEgcmVnaXN0cnkuXG4gKlxuICogQ2FsbGVkIGF0IGltcG9ydCB0aW1lIGFnYWluc3QgdGhlIHNoYXJlZCByZWdpc3RyeSwgc28gaW1wb3J0aW5nIHRoaXMgbW9kdWxlXG4gKiBpcyBhbGwgaXQgdGFrZXMgdG8gbWFrZSB0aGUgcnVsZXMgYXZhaWxhYmxlOyBhIHRlc3QgY2FuIHBhc3MgaXRzIG93biByZWdpc3RyeVxuICogaW5zdGVhZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyTmF0aXZlTWFuaWZlc3RSdWxlcyhcbiAgcmVnaXN0cnk6IE1hbmlmZXN0UnVsZVJlZ2lzdHJ5ID0gbWFuaWZlc3RSdWxlUmVnaXN0cnksXG4pOiB2b2lkIHtcbiAgZm9yIChjb25zdCBydWxlIG9mIG5hdGl2ZU1hbmlmZXN0UnVsZXMpIHJlZ2lzdHJ5LnJlZ2lzdGVyKHJ1bGUpO1xufVxuXG5yZWdpc3Rlck5hdGl2ZU1hbmlmZXN0UnVsZXMoKTtcbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBb0NDLEdBRUQsU0FDRSwyQkFBMkIsRUFLM0Isb0JBQW9CLEVBQ3BCLHNCQUFzQixRQUVqQixpQ0FBaUM7QUFtQ3hDLGtFQUFrRSxHQUNsRSxTQUFTLFdBQVcsSUFBWTtFQUM5QixPQUFPLEtBQUssS0FBSyxDQUFDLHVCQUF1QixFQUFFO0FBQzdDO0FBRUEseUVBQXlFLEdBQ3pFLFNBQVMsZ0JBQWdCLElBQVk7RUFDbkMsTUFBTSxRQUFRLEtBQUssS0FBSyxDQUFDO0VBQ3pCLE1BQU0sYUFBYSxPQUFPLENBQUMsRUFBRSxJQUFJO0VBQ2pDLE9BQU87SUFBQyxLQUFLLEtBQUssQ0FBQyxHQUFHLEtBQUssTUFBTSxHQUFHLFdBQVcsTUFBTTtJQUFHO0dBQVc7QUFDckU7QUFFQSwyRUFBMkUsR0FDM0UsU0FBUyxpQkFBaUIsSUFBWTtFQUNwQyxPQUFPLEtBQUssT0FBTyxDQUFDLFFBQVEsS0FBSyxJQUFJO0FBQ3ZDO0FBRUE7Ozs7OztDQU1DLEdBQ0QsU0FBUyxhQUNQLElBQTRCLEVBQzVCLE1BQThCLEVBQzlCLE9BQXlEO0VBRXpELE1BQU0sWUFBWSxJQUFJLElBQUksS0FBSyxHQUFHLENBQUMsQ0FBQyxPQUFP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
// denoCacheMetadata=5164869831948506749,11356280726259212944