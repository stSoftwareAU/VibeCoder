/**
 * Deterministic merge-conflict core (Issue #462, part of #456).
 *
 * The merge-conflict pass (`pr_merge_conflict_processor.ts`) runs a real
 * `git merge` and, on conflict, hands the tree to an AI agent whose contract
 * (`prompts/merge_conflict/prompt.md`) forbids side-picking and treats "the same
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
 */ import { compareSemver } from "./software_updates.ts";
// ---------------------------------------------------------------------------
// Conflict markers
// ---------------------------------------------------------------------------
/** Marker opening the "ours" side of a conflict hunk. */ export const OURS_MARKER = "<<<<<<<";
/** Marker opening the optional `diff3` base section. */ export const BASE_MARKER = "|||||||";
/** Marker separating "ours" from "theirs". */ export const SEPARATOR_MARKER = "=======";
/** Marker closing the "theirs" side of a conflict hunk. */ export const THEIRS_MARKER = ">>>>>>>";
// ---------------------------------------------------------------------------
// Hunk parser
// ---------------------------------------------------------------------------
/** Split text into lines, each keeping its own trailing newline. */ function splitLines(text) {
  return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}
/** Whether a line is the given conflict marker (bare, or with a label). */ function isMarker(line, marker) {
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
 */ export function parseConflictSegments(text) {
  const lines = splitLines(text);
  const segments = [];
  let literal = "";
  let state = "literal";
  let startLine = 0;
  let oursMarkerLine = "";
  let ours = "";
  let baseMarkerLine = null;
  let base = null;
  let separatorLine = "";
  let theirs = "";
  const fail = (message)=>({
      ok: false,
      error: message
    });
  for(let i = 0; i < lines.length; i++){
    const line = lines[i];
    const lineNo = i + 1;
    if (state === "literal") {
      if (isMarker(line, OURS_MARKER)) {
        if (literal !== "") {
          segments.push({
            kind: "literal",
            text: literal
          });
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
      return fail(`nested conflict start marker at line ${lineNo} (hunk opened at line ${startLine})`);
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
        return fail(`conflict end marker at line ${lineNo} before any separator (hunk opened at line ${startLine})`);
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
        return fail(`conflict end marker at line ${lineNo} before any separator (hunk opened at line ${startLine})`);
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
        theirsMarkerLine: line
      });
      state = "literal";
      continue;
    }
    theirs += line;
  }
  if (state !== "literal") {
    return fail(`unterminated conflict hunk opened at line ${startLine}`);
  }
  if (literal !== "") segments.push({
    kind: "literal",
    text: literal
  });
  return {
    ok: true,
    value: segments
  };
}
/** Render parsed segments back to file text; an unmodified parse round-trips. */ export function renderConflictSegments(segments) {
  let out = "";
  for (const segment of segments){
    if (segment.kind === "literal") {
      out += segment.text;
      continue;
    }
    out += segment.oursMarkerLine + segment.ours + (segment.baseMarkerLine ?? "") + (segment.base ?? "") + segment.separatorLine + segment.theirs + segment.theirsMarkerLine;
  }
  return out;
}
/**
 * Render segments with every conflict hunk replaced by the chosen side.
 *
 * `choices[i]` is the side to keep for the i-th conflict hunk. A mismatched
 * choice count throws rather than resolving part of the file — a partially
 * resolved file would leave conflict markers in the tree.
 */ export function applyHunkChoices(segments, choices) {
  const hunkCount = segments.filter((s)=>s.kind === "conflict").length;
  if (choices.length !== hunkCount) {
    throw new Error(`applyHunkChoices needs one choice per hunk: got ${choices.length} for ${hunkCount} hunks`);
  }
  let out = "";
  let index = 0;
  for (const segment of segments){
    if (segment.kind === "literal") {
      out += segment.text;
      continue;
    }
    out += choices[index] === "ours" ? segment.ours : segment.theirs;
    index++;
  }
  return out;
}
/** Version portion: optional range operator, optional `v`, a semver triple. */ const VERSION_PATTERN = /^(\^|~|>=)?v?(\d+)\.(\d+)\.(\d+)(.*)$/;
/**
 * Parse a dependency specifier, or return null when the shape is unsupported.
 *
 * Supported shapes are the ones this repository actually uses: a bare semver
 * (`1.2.3`, optionally `v`-prefixed), a range-prefixed semver (`^1.2.3`,
 * `~1.2.3`, `>=1.2.3`), and a registry specifier (`jsr:@std/fs@^1.2.3`,
 * `npm:pkg@~1.2.3`). Anything else — `latest`, `workspace:*`, build metadata,
 * a two-segment version, a specifier with a sub-path export — returns null and
 * so reaches the AI/human path.
 */ export function parseDependencySpecifier(specifier) {
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
    version: [
      Number(match[2]),
      Number(match[3]),
      Number(match[4])
    ],
    prerelease: rest.startsWith("-")
  };
}
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
 */ export function compareDependencySpecifiers(ours, theirs) {
  const a = parseDependencySpecifier(ours);
  const b = parseDependencySpecifier(theirs);
  if (!a) {
    return {
      kind: "undecidable",
      reason: `unparseable specifier: ${ours.trim()}`
    };
  }
  if (!b) {
    return {
      kind: "undecidable",
      reason: `unparseable specifier: ${theirs.trim()}`
    };
  }
  if (a.prerelease || b.prerelease) {
    return {
      kind: "undecidable",
      reason: "pre-release version on one or both sides"
    };
  }
  if (a.packagePrefix !== b.packagePrefix) {
    return {
      kind: "undecidable",
      reason: `different packages: ${a.packagePrefix || "(bare)"} vs ${b.packagePrefix || "(bare)"}`
    };
  }
  if (a.rangePrefix !== b.rangePrefix) {
    return {
      kind: "undecidable",
      reason: `range prefix changed: "${a.rangePrefix}" vs "${b.rangePrefix}"`
    };
  }
  const order = compareSemver(a.version, b.version);
  if (order === 0) return {
    kind: "undecidable",
    reason: "versions are equal"
  };
  return order > 0 ? {
    kind: "higher",
    side: "ours",
    specifier: ours.trim()
  } : {
    kind: "higher",
    side: "theirs",
    specifier: theirs.trim()
  };
}
/**
 * Create a rule registry, optionally seeded with rules.
 *
 * Later sub-issues register their per-ecosystem handlers here rather than
 * editing this core. Registration order is match order, so the first matching
 * rule wins.
 */ export function createManifestRuleRegistry(seed = []) {
  const rules = [];
  const register = (rule)=>{
    if (rules.some((existing)=>existing.name === rule.name)) {
      throw new Error(`manifest rule already registered: ${rule.name}`);
    }
    rules.push(rule);
  };
  for (const rule of seed)register(rule);
  return {
    register,
    find: (path)=>rules.find((rule)=>rule.matches(path)),
    get rules () {
      return rules;
    }
  };
}
/**
 * The shared registry the merge-conflict pass will consult.
 *
 * Per-ecosystem modules call `manifestRuleRegistry.register(...)` at import
 * time, so adding an ecosystem never touches this file.
 */ export const manifestRuleRegistry = createManifestRuleRegistry();
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9kZXBlbmRlbmN5X2NvbmZsaWN0X3J1bGVzLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogRGV0ZXJtaW5pc3RpYyBtZXJnZS1jb25mbGljdCBjb3JlIChJc3N1ZSAjNDYyLCBwYXJ0IG9mICM0NTYpLlxuICpcbiAqIFRoZSBtZXJnZS1jb25mbGljdCBwYXNzIChgcHJfbWVyZ2VfY29uZmxpY3RfcHJvY2Vzc29yLnRzYCkgcnVucyBhIHJlYWxcbiAqIGBnaXQgbWVyZ2VgIGFuZCwgb24gY29uZmxpY3QsIGhhbmRzIHRoZSB0cmVlIHRvIGFuIEFJIGFnZW50IHdob3NlIGNvbnRyYWN0XG4gKiAoYHByb21wdHMvbWVyZ2VfY29uZmxpY3QvcHJvbXB0Lm1kYCkgZm9yYmlkcyBzaWRlLXBpY2tpbmcgYW5kIHRyZWF0cyBcInRoZSBzYW1lXG4gKiB2YWx1ZSBzZXQgdG8gdHdvIGRpZmZlcmVudCB2YWx1ZXNcIiBhcyBhIGh1bWFuIGRlY2lzaW9uLiBBIGRlcGVuZGVuY3ktdmVyc2lvblxuICogYnVtcCBvbiBib3RoIHNpZGVzIGlzIGV4YWN0bHkgdGhhdCBzaGFwZSwgc28gaXQgZmFpbHMgYnkgZGVzaWduLlxuICpcbiAqIFRoaXMgbW9kdWxlIGlzIHRoZSBkZXBlbmRlbmN5LWZyZWUgZm91bmRhdGlvbiBmb3IgYSBkZXRlcm1pbmlzdGljIHBhdGggZm9yXG4gKiB0aGF0IG9uZSBuYXJyb3cgY2FzZS4gSXQgcHJvdmlkZXMgdGhyZWUgcGllY2VzIGFuZCBub3RoaW5nIGVsc2Ug4oCUIG5vdGhpbmdcbiAqIGhlcmUgaXMgd2lyZWQgaW50byB0aGUgcHJvY2Vzc29yIHlldDpcbiAqXG4gKiAxLiAqKkh1bmsgcGFyc2VyKiog4oCUIHNwbGl0cyBhIGNvbmZsaWN0ZWQgZmlsZSBpbnRvIGFuIG9yZGVyZWQgbGlzdCBvZiBsaXRlcmFsXG4gKiAgICBzZWdtZW50cyBhbmQgY29uZmxpY3QgaHVua3MsIGluY2x1ZGluZyB0aGUgYHx8fHx8fHwgYmFzZWAgc2VjdGlvbiB0aGF0XG4gKiAgICBgZGlmZjNgIGNvbmZsaWN0IHN0eWxlIHByb2R1Y2VzLiBBbiB1bm1vZGlmaWVkIHBhcnNlIHJlbmRlcnMgYmFja1xuICogICAgYnl0ZS1mb3ItYnl0ZSwgc28gYSByZXNvbHZlZCBmaWxlIGRpZmZlcnMgb25seSB3aGVyZSBhIGh1bmsgd2FzIHJlcGxhY2VkLlxuICogMi4gKipWZXJzaW9uIGNvbXBhcmF0b3IqKiDigJQgcGFyc2VzIHRoZSBkZXBlbmRlbmN5LXNwZWNpZmllciBzaGFwZXMgdGhpc1xuICogICAgcmVwb3NpdG9yeSBhY3R1YWxseSB1c2VzIGFuZCBkZWNpZGVzIHdoaWNoIHNpZGUgaXMgaGlnaGVyLCBvciBzYXlzIGl0XG4gKiAgICBjYW5ub3QgZGVjaWRlLiBQcmUtcmVsZWFzZXMsIGVxdWFsIHZlcnNpb25zLCBkaWZmZXJpbmcgcmFuZ2UgcHJlZml4ZXMgYW5kXG4gKiAgICB1bnBhcnNlYWJsZSBzcGVjaWZpZXJzIGFyZSBhbGwgKnVuZGVjaWRhYmxlKiBhbmQgcmVhY2ggdGhlIEFJL2h1bWFuIHBhdGguXG4gKiAzLiAqKlJ1bGUgcmVnaXN0cnkqKiDigJQgdGhlIGBNYW5pZmVzdFJ1bGVgIHNlYW0gbGF0ZXIgc3ViLWlzc3VlcyByZWdpc3RlclxuICogICAgYGRlbm8uanNvbmAsIGBwYWNrYWdlLmpzb25gLCBgQ2FyZ28udG9tbGAgYW5kIGBnby5tb2RgIGhhbmRsZXJzIGludG9cbiAqICAgIHdpdGhvdXQgZWRpdGluZyB0aGlzIGNvcmUuXG4gKlxuICogQSByZXNvbHV0aW9uIGlzIGVpdGhlciBgcmVzb2x2ZWRgIChmdWxsIGZpbGUgdGV4dCB0byB3cml0ZSkgb3IgYHVucmVzb2x2ZWRgXG4gKiAoYSByZWFzb24sIGhhbmRlZCB0byB0aGUgQUkgZmFsbGJhY2spLiAqKmBwYXJ0aWFsYCBpcyBkZWxpYmVyYXRlbHkgbm90XG4gKiBzdXBwb3J0ZWQqKjogYSBoYWxmLXJlc29sdmVkIGZpbGUgd291bGQgbGVhdmUgY29uZmxpY3QgbWFya2VycyBiZWhpbmQsIHdoaWNoXG4gKiBgcHJfbWVyZ2VfY29uZmxpY3RfcHJvY2Vzc29yLnRzYCByZWZ1c2VzIHRvIHB1c2guIEFsbC1vci1ub3RoaW5nIGtlZXBzIHRoYXRcbiAqIGludmFyaWFudCBpbXBvc3NpYmxlIHRvIGJyZWFrLlxuICpcbiAqIFRoZSBtb2R1bGUgaXMgcHVyZSDigJQgbm8gZ2l0LCBubyBuZXR3b3JrLCBubyBmaWxlIEkvTyDigJQgc28gaXQgaXMgZnVsbHlcbiAqIGNvdmVyZWQgYnkgdW5pdCB0ZXN0cy5cbiAqXG4gKiBBdXN0cmFsaWFuIEVuZ2xpc2ggaXMgdXNlZCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIG5vcm1hbGlzZWQsIG9yZ2FuaXNhdGlvbikuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBSZXN1bHQgfSBmcm9tIFwiLi4vdHlwZXMudHNcIjtcbmltcG9ydCB7IGNvbXBhcmVTZW12ZXIgfSBmcm9tIFwiLi9zb2Z0d2FyZV91cGRhdGVzLnRzXCI7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gQ29uZmxpY3QgbWFya2Vyc1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKiBNYXJrZXIgb3BlbmluZyB0aGUgXCJvdXJzXCIgc2lkZSBvZiBhIGNvbmZsaWN0IGh1bmsuICovXG5leHBvcnQgY29uc3QgT1VSU19NQVJLRVIgPSBcIjw8PDw8PDxcIjtcblxuLyoqIE1hcmtlciBvcGVuaW5nIHRoZSBvcHRpb25hbCBgZGlmZjNgIGJhc2Ugc2VjdGlvbi4gKi9cbmV4cG9ydCBjb25zdCBCQVNFX01BUktFUiA9IFwifHx8fHx8fFwiO1xuXG4vKiogTWFya2VyIHNlcGFyYXRpbmcgXCJvdXJzXCIgZnJvbSBcInRoZWlyc1wiLiAqL1xuZXhwb3J0IGNvbnN0IFNFUEFSQVRPUl9NQVJLRVIgPSBcIj09PT09PT1cIjtcblxuLyoqIE1hcmtlciBjbG9zaW5nIHRoZSBcInRoZWlyc1wiIHNpZGUgb2YgYSBjb25mbGljdCBodW5rLiAqL1xuZXhwb3J0IGNvbnN0IFRIRUlSU19NQVJLRVIgPSBcIj4+Pj4+Pj5cIjtcblxuLyoqIFdoaWNoIHNpZGUgb2YgYSBjb25mbGljdCBodW5rIGEgcmVzb2x1dGlvbiBwaWNrcy4gKi9cbmV4cG9ydCB0eXBlIENvbmZsaWN0U2lkZSA9IFwib3Vyc1wiIHwgXCJ0aGVpcnNcIjtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBQYXJzZWQgc2VnbWVudHNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKiogQSBydW4gb2YgdGV4dCBvdXRzaWRlIGFueSBjb25mbGljdCBodW5rLCBwcmVzZXJ2ZWQgdmVyYmF0aW0uICovXG5leHBvcnQgaW50ZXJmYWNlIExpdGVyYWxTZWdtZW50IHtcbiAga2luZDogXCJsaXRlcmFsXCI7XG4gIC8qKiBSYXcgdGV4dCBpbmNsdWRpbmcgaXRzIGxpbmUgdGVybWluYXRvcnMuICovXG4gIHRleHQ6IHN0cmluZztcbn1cblxuLyoqXG4gKiBPbmUgY29uZmxpY3QgaHVuay5cbiAqXG4gKiBUaGUgbWFya2VyIGxpbmVzIGFyZSBrZXB0IHZlcmJhdGltIChpbmNsdWRpbmcgdGhlaXIgbGFiZWxzIGFuZCBsaW5lXG4gKiB0ZXJtaW5hdG9ycykgc28gcmVuZGVyaW5nIGFuIHVubW9kaWZpZWQgcGFyc2UgcmVwcm9kdWNlcyB0aGUgaW5wdXQgZXhhY3RseS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBDb25mbGljdEh1bmsge1xuICBraW5kOiBcImNvbmZsaWN0XCI7XG4gIC8qKiBUaGUgYDw8PDw8PDwgbGFiZWxgIGxpbmUsIGluY2x1ZGluZyBpdHMgdGVybWluYXRvci4gKi9cbiAgb3Vyc01hcmtlckxpbmU6IHN0cmluZztcbiAgLyoqIFJhdyBcIm91cnNcIiBib2R5IOKAlCBtYXkgYmUgZW1wdHkgd2hlbiB0aGF0IHNpZGUgZGVsZXRlZCB0aGUgcmVnaW9uLiAqL1xuICBvdXJzOiBzdHJpbmc7XG4gIC8qKiBUaGUgYHx8fHx8fHwgbGFiZWxgIGxpbmUgd2hlbiBgZGlmZjNgIHN0eWxlLCBvdGhlcndpc2UgbnVsbC4gKi9cbiAgYmFzZU1hcmtlckxpbmU6IHN0cmluZyB8IG51bGw7XG4gIC8qKiBSYXcgYmFzZSBib2R5IHdoZW4gYGRpZmYzYCBzdHlsZSwgb3RoZXJ3aXNlIG51bGwuICovXG4gIGJhc2U6IHN0cmluZyB8IG51bGw7XG4gIC8qKiBUaGUgYD09PT09PT1gIGxpbmUsIGluY2x1ZGluZyBpdHMgdGVybWluYXRvci4gKi9cbiAgc2VwYXJhdG9yTGluZTogc3RyaW5nO1xuICAvKiogUmF3IFwidGhlaXJzXCIgYm9keSDigJQgbWF5IGJlIGVtcHR5IHdoZW4gdGhhdCBzaWRlIGRlbGV0ZWQgdGhlIHJlZ2lvbi4gKi9cbiAgdGhlaXJzOiBzdHJpbmc7XG4gIC8qKiBUaGUgYD4+Pj4+Pj4gbGFiZWxgIGxpbmUsIGluY2x1ZGluZyBpdHMgdGVybWluYXRvci4gKi9cbiAgdGhlaXJzTWFya2VyTGluZTogc3RyaW5nO1xufVxuXG4vKiogQW4gb3JkZXJlZCBwaWVjZSBvZiBhIHBhcnNlZCBjb25mbGljdGVkIGZpbGUuICovXG5leHBvcnQgdHlwZSBDb25mbGljdFNlZ21lbnQgPSBMaXRlcmFsU2VnbWVudCB8IENvbmZsaWN0SHVuaztcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBIdW5rIHBhcnNlclxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKiBTcGxpdCB0ZXh0IGludG8gbGluZXMsIGVhY2gga2VlcGluZyBpdHMgb3duIHRyYWlsaW5nIG5ld2xpbmUuICovXG5mdW5jdGlvbiBzcGxpdExpbmVzKHRleHQ6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIHRleHQubWF0Y2goL1teXFxuXSpcXG58W15cXG5dKy9nKSA/PyBbXTtcbn1cblxuLyoqIFdoZXRoZXIgYSBsaW5lIGlzIHRoZSBnaXZlbiBjb25mbGljdCBtYXJrZXIgKGJhcmUsIG9yIHdpdGggYSBsYWJlbCkuICovXG5mdW5jdGlvbiBpc01hcmtlcihsaW5lOiBzdHJpbmcsIG1hcmtlcjogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IGNvbnRlbnQgPSBsaW5lLnJlcGxhY2UoL1xccj9cXG4kLywgXCJcIik7XG4gIHJldHVybiBjb250ZW50ID09PSBtYXJrZXIgfHwgY29udGVudC5zdGFydHNXaXRoKGAke21hcmtlcn0gYCk7XG59XG5cbi8qKlxuICogUGFyc2UgYSBjb25mbGljdGVkIGZpbGUgaW50byBvcmRlcmVkIGxpdGVyYWwgc2VnbWVudHMgYW5kIGNvbmZsaWN0IGh1bmtzLlxuICpcbiAqIE1hbGZvcm1lZCBtYXJrZXIgc2VxdWVuY2VzIOKAlCBhbiB1bnRlcm1pbmF0ZWQgaHVuaywgYSBuZXN0ZWQgc3RhcnQgbWFya2VyLCBhblxuICogZW5kIG1hcmtlciBiZWZvcmUgaXRzIHNlcGFyYXRvciDigJQgYXJlIHJlcG9ydGVkIGFzIGVycm9ycyByYXRoZXIgdGhhblxuICogc2lsZW50bHkgdHJlYXRlZCBhcyBsaXRlcmFsIHRleHQ6IGEgY2FsbGVyIHRoYXQgcmVzb2x2ZWQgc3VjaCBhIGZpbGUgd291bGRcbiAqIHdyaXRlIGNvbmZsaWN0IG1hcmtlcnMgaW50byB0aGUgdHJlZS5cbiAqXG4gKiBOb3RlIHRoYXQgYD09PT09PT1gIGFuZCBgPj4+Pj4+PmAgbGluZXMgKm91dHNpZGUqIGEgaHVuayBhcmUgb3JkaW5hcnkgdGV4dFxuICogKGEgTWFya2Rvd24gc2V0ZXh0IGhlYWRpbmcgdW5kZXJsaW5lcyB3aXRoIGA9PT09PT09YCksIHNvIG9ubHkgYW4gdW5jbG9zZWRcbiAqIGA8PDw8PDw8YCBpcyBtYWxmb3JtZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUNvbmZsaWN0U2VnbWVudHMoXG4gIHRleHQ6IHN0cmluZyxcbik6IFJlc3VsdDxDb25mbGljdFNlZ21lbnRbXSwgc3RyaW5nPiB7XG4gIGNvbnN0IGxpbmVzID0gc3BsaXRMaW5lcyh0ZXh0KTtcbiAgY29uc3Qgc2VnbWVudHM6IENvbmZsaWN0U2VnbWVudFtdID0gW107XG5cbiAgbGV0IGxpdGVyYWwgPSBcIlwiO1xuICBsZXQgc3RhdGU6IFwibGl0ZXJhbFwiIHwgXCJvdXJzXCIgfCBcImJhc2VcIiB8IFwidGhlaXJzXCIgPSBcImxpdGVyYWxcIjtcbiAgbGV0IHN0YXJ0TGluZSA9IDA7XG4gIGxldCBvdXJzTWFya2VyTGluZSA9IFwiXCI7XG4gIGxldCBvdXJzID0gXCJcIjtcbiAgbGV0IGJhc2VNYXJrZXJMaW5lOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgbGV0IGJhc2U6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBsZXQgc2VwYXJhdG9yTGluZSA9IFwiXCI7XG4gIGxldCB0aGVpcnMgPSBcIlwiO1xuXG4gIGNvbnN0IGZhaWwgPSAobWVzc2FnZTogc3RyaW5nKTogUmVzdWx0PENvbmZsaWN0U2VnbWVudFtdLCBzdHJpbmc+ID0+ICh7XG4gICAgb2s6IGZhbHNlLFxuICAgIGVycm9yOiBtZXNzYWdlLFxuICB9KTtcblxuICBmb3IgKGxldCBpID0gMDsgaSA8IGxpbmVzLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgbGluZSA9IGxpbmVzW2ldITtcbiAgICBjb25zdCBsaW5lTm8gPSBpICsgMTtcblxuICAgIGlmIChzdGF0ZSA9PT0gXCJsaXRlcmFsXCIpIHtcbiAgICAgIGlmIChpc01hcmtlcihsaW5lLCBPVVJTX01BUktFUikpIHtcbiAgICAgICAgaWYgKGxpdGVyYWwgIT09IFwiXCIpIHtcbiAgICAgICAgICBzZWdtZW50cy5wdXNoKHsga2luZDogXCJsaXRlcmFsXCIsIHRleHQ6IGxpdGVyYWwgfSk7XG4gICAgICAgICAgbGl0ZXJhbCA9IFwiXCI7XG4gICAgICAgIH1cbiAgICAgICAgc3RhdGUgPSBcIm91cnNcIjtcbiAgICAgICAgc3RhcnRMaW5lID0gbGluZU5vO1xuICAgICAgICBvdXJzTWFya2VyTGluZSA9IGxpbmU7XG4gICAgICAgIG91cnMgPSBcIlwiO1xuICAgICAgICBiYXNlTWFya2VyTGluZSA9IG51bGw7XG4gICAgICAgIGJhc2UgPSBudWxsO1xuICAgICAgICBzZXBhcmF0b3JMaW5lID0gXCJcIjtcbiAgICAgICAgdGhlaXJzID0gXCJcIjtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBsaXRlcmFsICs9IGxpbmU7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBpZiAoaXNNYXJrZXIobGluZSwgT1VSU19NQVJLRVIpKSB7XG4gICAgICByZXR1cm4gZmFpbChcbiAgICAgICAgYG5lc3RlZCBjb25mbGljdCBzdGFydCBtYXJrZXIgYXQgbGluZSAke2xpbmVOb30gKGh1bmsgb3BlbmVkIGF0IGxpbmUgJHtzdGFydExpbmV9KWAsXG4gICAgICApO1xuICAgIH1cblxuICAgIGlmIChzdGF0ZSA9PT0gXCJvdXJzXCIpIHtcbiAgICAgIGlmIChpc01hcmtlcihsaW5lLCBCQVNFX01BUktFUikpIHtcbiAgICAgICAgc3RhdGUgPSBcImJhc2VcIjtcbiAgICAgICAgYmFzZU1hcmtlckxpbmUgPSBsaW5lO1xuICAgICAgICBiYXNlID0gXCJcIjtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBpZiAoaXNNYXJrZXIobGluZSwgU0VQQVJBVE9SX01BUktFUikpIHtcbiAgICAgICAgc3RhdGUgPSBcInRoZWlyc1wiO1xuICAgICAgICBzZXBhcmF0b3JMaW5lID0gbGluZTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBpZiAoaXNNYXJrZXIobGluZSwgVEhFSVJTX01BUktFUikpIHtcbiAgICAgICAgcmV0dXJuIGZhaWwoXG4gICAgICAgICAgYGNvbmZsaWN0IGVuZCBtYXJrZXIgYXQgbGluZSAke2xpbmVOb30gYmVmb3JlIGFueSBzZXBhcmF0b3IgKGh1bmsgb3BlbmVkIGF0IGxpbmUgJHtzdGFydExpbmV9KWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBvdXJzICs9IGxpbmU7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBpZiAoc3RhdGUgPT09IFwiYmFzZVwiKSB7XG4gICAgICBpZiAoaXNNYXJrZXIobGluZSwgU0VQQVJBVE9SX01BUktFUikpIHtcbiAgICAgICAgc3RhdGUgPSBcInRoZWlyc1wiO1xuICAgICAgICBzZXBhcmF0b3JMaW5lID0gbGluZTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBpZiAoaXNNYXJrZXIobGluZSwgVEhFSVJTX01BUktFUikpIHtcbiAgICAgICAgcmV0dXJuIGZhaWwoXG4gICAgICAgICAgYGNvbmZsaWN0IGVuZCBtYXJrZXIgYXQgbGluZSAke2xpbmVOb30gYmVmb3JlIGFueSBzZXBhcmF0b3IgKGh1bmsgb3BlbmVkIGF0IGxpbmUgJHtzdGFydExpbmV9KWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBiYXNlICs9IGxpbmU7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICAvLyBzdGF0ZSA9PT0gXCJ0aGVpcnNcIlxuICAgIGlmIChpc01hcmtlcihsaW5lLCBUSEVJUlNfTUFSS0VSKSkge1xuICAgICAgc2VnbWVudHMucHVzaCh7XG4gICAgICAgIGtpbmQ6IFwiY29uZmxpY3RcIixcbiAgICAgICAgb3Vyc01hcmtlckxpbmUsXG4gICAgICAgIG91cnMsXG4gICAgICAgIGJhc2VNYXJrZXJMaW5lLFxuICAgICAgICBiYXNlLFxuICAgICAgICBzZXBhcmF0b3JMaW5lLFxuICAgICAgICB0aGVpcnMsXG4gICAgICAgIHRoZWlyc01hcmtlckxpbmU6IGxpbmUsXG4gICAgICB9KTtcbiAgICAgIHN0YXRlID0gXCJsaXRlcmFsXCI7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgdGhlaXJzICs9IGxpbmU7XG4gIH1cblxuICBpZiAoc3RhdGUgIT09IFwibGl0ZXJhbFwiKSB7XG4gICAgcmV0dXJuIGZhaWwoYHVudGVybWluYXRlZCBjb25mbGljdCBodW5rIG9wZW5lZCBhdCBsaW5lICR7c3RhcnRMaW5lfWApO1xuICB9XG4gIGlmIChsaXRlcmFsICE9PSBcIlwiKSBzZWdtZW50cy5wdXNoKHsga2luZDogXCJsaXRlcmFsXCIsIHRleHQ6IGxpdGVyYWwgfSk7XG5cbiAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBzZWdtZW50cyB9O1xufVxuXG4vKiogUmVuZGVyIHBhcnNlZCBzZWdtZW50cyBiYWNrIHRvIGZpbGUgdGV4dDsgYW4gdW5tb2RpZmllZCBwYXJzZSByb3VuZC10cmlwcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJDb25mbGljdFNlZ21lbnRzKFxuICBzZWdtZW50czogcmVhZG9ubHkgQ29uZmxpY3RTZWdtZW50W10sXG4pOiBzdHJpbmcge1xuICBsZXQgb3V0ID0gXCJcIjtcbiAgZm9yIChjb25zdCBzZWdtZW50IG9mIHNlZ21lbnRzKSB7XG4gICAgaWYgKHNlZ21lbnQua2luZCA9PT0gXCJsaXRlcmFsXCIpIHtcbiAgICAgIG91dCArPSBzZWdtZW50LnRleHQ7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgb3V0ICs9IHNlZ21lbnQub3Vyc01hcmtlckxpbmUgKyBzZWdtZW50Lm91cnMgK1xuICAgICAgKHNlZ21lbnQuYmFzZU1hcmtlckxpbmUgPz8gXCJcIikgKyAoc2VnbWVudC5iYXNlID8/IFwiXCIpICtcbiAgICAgIHNlZ21lbnQuc2VwYXJhdG9yTGluZSArIHNlZ21lbnQudGhlaXJzICsgc2VnbWVudC50aGVpcnNNYXJrZXJMaW5lO1xuICB9XG4gIHJldHVybiBvdXQ7XG59XG5cbi8qKlxuICogUmVuZGVyIHNlZ21lbnRzIHdpdGggZXZlcnkgY29uZmxpY3QgaHVuayByZXBsYWNlZCBieSB0aGUgY2hvc2VuIHNpZGUuXG4gKlxuICogYGNob2ljZXNbaV1gIGlzIHRoZSBzaWRlIHRvIGtlZXAgZm9yIHRoZSBpLXRoIGNvbmZsaWN0IGh1bmsuIEEgbWlzbWF0Y2hlZFxuICogY2hvaWNlIGNvdW50IHRocm93cyByYXRoZXIgdGhhbiByZXNvbHZpbmcgcGFydCBvZiB0aGUgZmlsZSDigJQgYSBwYXJ0aWFsbHlcbiAqIHJlc29sdmVkIGZpbGUgd291bGQgbGVhdmUgY29uZmxpY3QgbWFya2VycyBpbiB0aGUgdHJlZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFwcGx5SHVua0Nob2ljZXMoXG4gIHNlZ21lbnRzOiByZWFkb25seSBDb25mbGljdFNlZ21lbnRbXSxcbiAgY2hvaWNlczogcmVhZG9ubHkgQ29uZmxpY3RTaWRlW10sXG4pOiBzdHJpbmcge1xuICBjb25zdCBodW5rQ291bnQgPSBzZWdtZW50cy5maWx0ZXIoKHMpID0+IHMua2luZCA9PT0gXCJjb25mbGljdFwiKS5sZW5ndGg7XG4gIGlmIChjaG9pY2VzLmxlbmd0aCAhPT0gaHVua0NvdW50KSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYGFwcGx5SHVua0Nob2ljZXMgbmVlZHMgb25lIGNob2ljZSBwZXIgaHVuazogZ290ICR7Y2hvaWNlcy5sZW5ndGh9IGZvciAke2h1bmtDb3VudH0gaHVua3NgLFxuICAgICk7XG4gIH1cblxuICBsZXQgb3V0ID0gXCJcIjtcbiAgbGV0IGluZGV4ID0gMDtcbiAgZm9yIChjb25zdCBzZWdtZW50IG9mIHNlZ21lbnRzKSB7XG4gICAgaWYgKHNlZ21lbnQua2luZCA9PT0gXCJsaXRlcmFsXCIpIHtcbiAgICAgIG91dCArPSBzZWdtZW50LnRleHQ7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgb3V0ICs9IGNob2ljZXNbaW5kZXhdID09PSBcIm91cnNcIiA/IHNlZ21lbnQub3VycyA6IHNlZ21lbnQudGhlaXJzO1xuICAgIGluZGV4Kys7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBEZXBlbmRlbmN5IHNwZWNpZmllciBjb21wYXJpc29uXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqIEEgZGVwZW5kZW5jeSBzcGVjaWZpZXIgYnJva2VuIGludG8gdGhlIHBhcnRzIHRoZSBjb21wYXJhdG9yIG5lZWRzLiAqL1xuZXhwb3J0IGludGVyZmFjZSBQYXJzZWREZXBlbmRlbmN5U3BlY2lmaWVyIHtcbiAgLyoqXG4gICAqIEV2ZXJ5dGhpbmcgdXAgdG8gYW5kIGluY2x1ZGluZyB0aGUgYEBgIHRoYXQgaW50cm9kdWNlcyB0aGUgdmVyc2lvbiwgZS5nLlxuICAgKiBganNyOkBzdGQvZnNAYC4gRW1wdHkgZm9yIGEgYmFyZSB2ZXJzaW9uIHN1Y2ggYXMgYF4xLjIuM2AuXG4gICAqL1xuICBwYWNrYWdlUHJlZml4OiBzdHJpbmc7XG4gIC8qKiBSYW5nZSBvcGVyYXRvcjogYF5gLCBgfmAsIGA+PWAsIG9yIGVtcHR5IGZvciBhbiBleGFjdCBwaW4uICovXG4gIHJhbmdlUHJlZml4OiBzdHJpbmc7XG4gIC8qKiBNQUpPUi5NSU5PUi5QQVRDSCwgY29tcGFyZWQgbnVtZXJpY2FsbHkgcGVyIHNlZ21lbnQuICovXG4gIHZlcnNpb246IFtudW1iZXIsIG51bWJlciwgbnVtYmVyXTtcbiAgLyoqIFRydWUgd2hlbiB0aGUgdmVyc2lvbiBjYXJyaWVzIGEgYC1wcmUucmVsZWFzZWAgc3VmZml4LiAqL1xuICBwcmVyZWxlYXNlOiBib29sZWFuO1xufVxuXG4vKiogVmVyc2lvbiBwb3J0aW9uOiBvcHRpb25hbCByYW5nZSBvcGVyYXRvciwgb3B0aW9uYWwgYHZgLCBhIHNlbXZlciB0cmlwbGUuICovXG5jb25zdCBWRVJTSU9OX1BBVFRFUk4gPSAvXihcXF58fnw+PSk/dj8oXFxkKylcXC4oXFxkKylcXC4oXFxkKykoLiopJC87XG5cbi8qKlxuICogUGFyc2UgYSBkZXBlbmRlbmN5IHNwZWNpZmllciwgb3IgcmV0dXJuIG51bGwgd2hlbiB0aGUgc2hhcGUgaXMgdW5zdXBwb3J0ZWQuXG4gKlxuICogU3VwcG9ydGVkIHNoYXBlcyBhcmUgdGhlIG9uZXMgdGhpcyByZXBvc2l0b3J5IGFjdHVhbGx5IHVzZXM6IGEgYmFyZSBzZW12ZXJcbiAqIChgMS4yLjNgLCBvcHRpb25hbGx5IGB2YC1wcmVmaXhlZCksIGEgcmFuZ2UtcHJlZml4ZWQgc2VtdmVyIChgXjEuMi4zYCxcbiAqIGB+MS4yLjNgLCBgPj0xLjIuM2ApLCBhbmQgYSByZWdpc3RyeSBzcGVjaWZpZXIgKGBqc3I6QHN0ZC9mc0BeMS4yLjNgLFxuICogYG5wbTpwa2dAfjEuMi4zYCkuIEFueXRoaW5nIGVsc2Ug4oCUIGBsYXRlc3RgLCBgd29ya3NwYWNlOipgLCBidWlsZCBtZXRhZGF0YSxcbiAqIGEgdHdvLXNlZ21lbnQgdmVyc2lvbiwgYSBzcGVjaWZpZXIgd2l0aCBhIHN1Yi1wYXRoIGV4cG9ydCDigJQgcmV0dXJucyBudWxsIGFuZFxuICogc28gcmVhY2hlcyB0aGUgQUkvaHVtYW4gcGF0aC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlRGVwZW5kZW5jeVNwZWNpZmllcihcbiAgc3BlY2lmaWVyOiBzdHJpbmcsXG4pOiBQYXJzZWREZXBlbmRlbmN5U3BlY2lmaWVyIHwgbnVsbCB7XG4gIGNvbnN0IHRyaW1tZWQgPSBzcGVjaWZpZXIudHJpbSgpO1xuICBjb25zdCBhdCA9IHRyaW1tZWQubGFzdEluZGV4T2YoXCJAXCIpO1xuICBjb25zdCBwYWNrYWdlUHJlZml4ID0gYXQgPiAwID8gdHJpbW1lZC5zbGljZSgwLCBhdCArIDEpIDogXCJcIjtcbiAgY29uc3QgdmVyc2lvblBhcnQgPSBhdCA+IDAgPyB0cmltbWVkLnNsaWNlKGF0ICsgMSkgOiB0cmltbWVkO1xuXG4gIGNvbnN0IG1hdGNoID0gdmVyc2lvblBhcnQubWF0Y2goVkVSU0lPTl9QQVRURVJOKTtcbiAgaWYgKCFtYXRjaCkgcmV0dXJuIG51bGw7XG5cbiAgY29uc3QgcmVzdCA9IG1hdGNoWzVdID8/IFwiXCI7XG4gIC8vIE9ubHkgYSBwcmUtcmVsZWFzZSBzdWZmaXggbWF5IGZvbGxvdyB0aGUgdHJpcGxlOyBidWlsZCBtZXRhZGF0YSBhbmRcbiAgLy8gc3ViLXBhdGggZXhwb3J0cyBhcmUgbm90IHZlcnNpb24gYnVtcHMgd2UgYXJlIHdpbGxpbmcgdG8gZGVjaWRlLlxuICBpZiAocmVzdCAhPT0gXCJcIiAmJiAhcmVzdC5zdGFydHNXaXRoKFwiLVwiKSkgcmV0dXJuIG51bGw7XG5cbiAgcmV0dXJuIHtcbiAgICBwYWNrYWdlUHJlZml4LFxuICAgIHJhbmdlUHJlZml4OiBtYXRjaFsxXSA/PyBcIlwiLFxuICAgIHZlcnNpb246IFtOdW1iZXIobWF0Y2hbMl0pLCBOdW1iZXIobWF0Y2hbM10pLCBOdW1iZXIobWF0Y2hbNF0pXSxcbiAgICBwcmVyZWxlYXNlOiByZXN0LnN0YXJ0c1dpdGgoXCItXCIpLFxuICB9O1xufVxuXG4vKiogVGhlIGNvbXBhcmF0b3IncyBkZWNpc2lvbiBmb3IgYSBwYWlyIG9mIHNwZWNpZmllcnMuICovXG5leHBvcnQgdHlwZSBWZXJzaW9uVmVyZGljdCA9XG4gIHwge1xuICAgIGtpbmQ6IFwiaGlnaGVyXCI7XG4gICAgLyoqIFRoZSBzaWRlIGNhcnJ5aW5nIHRoZSBoaWdoZXIgdmVyc2lvbi4gKi9cbiAgICBzaWRlOiBDb25mbGljdFNpZGU7XG4gICAgLyoqIFRoYXQgc2lkZSdzIHNwZWNpZmllciwgdmVyYmF0aW0g4oCUIHRoZSByYW5nZSBwcmVmaXggaXMgY2FycmllZCB0aHJvdWdoLiAqL1xuICAgIHNwZWNpZmllcjogc3RyaW5nO1xuICB9XG4gIHwge1xuICAgIGtpbmQ6IFwidW5kZWNpZGFibGVcIjtcbiAgICAvKiogV2h5IHRoZSBwYWlyIHdhcyBub3QgZGVjaWRlZDsgc3VyZmFjZWQgdG8gdGhlIEFJL2h1bWFuIGZhbGxiYWNrLiAqL1xuICAgIHJlYXNvbjogc3RyaW5nO1xuICB9O1xuXG4vKipcbiAqIERlY2lkZSB3aGljaCBvZiB0d28gZGVwZW5kZW5jeSBzcGVjaWZpZXJzIGlzIHRoZSBsYXRlciB2ZXJzaW9uLlxuICpcbiAqIERlbGliZXJhdGVseSB1bmRlY2lkYWJsZSDigJQgYmVjYXVzZSBcImxhdGVyIHZlcnNpb25cIiBpcyB0aGVuIG5vdCB3aGF0IGFcbiAqIHJldmlld2VyIG1lYW5zLCBvciBpcyBub3Qgd2hhdCB0aGUgY2hhbmdlIGlzIGFib3V0OlxuICpcbiAqIC0gZWl0aGVyIHNpZGUgaXMgYSBwcmUtcmVsZWFzZSAoYDEuMi4zLWJldGEuMWApOiBwcmUtcmVsZWFzZSBvcmRlcmluZyBpc1xuICogICByYXJlbHkgdGhlIGludGVudDtcbiAqIC0gdGhlIHZlcnNpb25zIGFyZSBlcXVhbDtcbiAqIC0gdGhlIHJhbmdlIHByZWZpeGVzIGRpZmZlciAoYF4xLjIuM2AgdnMgYH4xLjIuM2ApOiB0aGF0IGlzIGEgcG9saWN5IGNoYW5nZTtcbiAqIC0gdGhlIHR3byBzaWRlcyBuYW1lIGRpZmZlcmVudCBwYWNrYWdlcztcbiAqIC0gZWl0aGVyIHNwZWNpZmllciBjYW5ub3QgYmUgcGFyc2VkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY29tcGFyZURlcGVuZGVuY3lTcGVjaWZpZXJzKFxuICBvdXJzOiBzdHJpbmcsXG4gIHRoZWlyczogc3RyaW5nLFxuKTogVmVyc2lvblZlcmRpY3Qge1xuICBjb25zdCBhID0gcGFyc2VEZXBlbmRlbmN5U3BlY2lmaWVyKG91cnMpO1xuICBjb25zdCBiID0gcGFyc2VEZXBlbmRlbmN5U3BlY2lmaWVyKHRoZWlycyk7XG5cbiAgaWYgKCFhKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGtpbmQ6IFwidW5kZWNpZGFibGVcIixcbiAgICAgIHJlYXNvbjogYHVucGFyc2VhYmxlIHNwZWNpZmllcjogJHtvdXJzLnRyaW0oKX1gLFxuICAgIH07XG4gIH1cbiAgaWYgKCFiKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGtpbmQ6IFwidW5kZWNpZGFibGVcIixcbiAgICAgIHJlYXNvbjogYHVucGFyc2VhYmxlIHNwZWNpZmllcjogJHt0aGVpcnMudHJpbSgpfWAsXG4gICAgfTtcbiAgfVxuXG4gIGlmIChhLnByZXJlbGVhc2UgfHwgYi5wcmVyZWxlYXNlKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGtpbmQ6IFwidW5kZWNpZGFibGVcIixcbiAgICAgIHJlYXNvbjogXCJwcmUtcmVsZWFzZSB2ZXJzaW9uIG9uIG9uZSBvciBib3RoIHNpZGVzXCIsXG4gICAgfTtcbiAgfVxuICBpZiAoYS5wYWNrYWdlUHJlZml4ICE9PSBiLnBhY2thZ2VQcmVmaXgpIHtcbiAgICByZXR1cm4ge1xuICAgICAga2luZDogXCJ1bmRlY2lkYWJsZVwiLFxuICAgICAgcmVhc29uOiBgZGlmZmVyZW50IHBhY2thZ2VzOiAke2EucGFja2FnZVByZWZpeCB8fCBcIihiYXJlKVwifSB2cyAke1xuICAgICAgICBiLnBhY2thZ2VQcmVmaXggfHwgXCIoYmFyZSlcIlxuICAgICAgfWAsXG4gICAgfTtcbiAgfVxuICBpZiAoYS5yYW5nZVByZWZpeCAhPT0gYi5yYW5nZVByZWZpeCkge1xuICAgIHJldHVybiB7XG4gICAgICBraW5kOiBcInVuZGVjaWRhYmxlXCIsXG4gICAgICByZWFzb246IGByYW5nZSBwcmVmaXggY2hhbmdlZDogXCIke2EucmFuZ2VQcmVmaXh9XCIgdnMgXCIke2IucmFuZ2VQcmVmaXh9XCJgLFxuICAgIH07XG4gIH1cblxuICBjb25zdCBvcmRlciA9IGNvbXBhcmVTZW12ZXIoYS52ZXJzaW9uLCBiLnZlcnNpb24pO1xuICBpZiAob3JkZXIgPT09IDApIHJldHVybiB7IGtpbmQ6IFwidW5kZWNpZGFibGVcIiwgcmVhc29uOiBcInZlcnNpb25zIGFyZSBlcXVhbFwiIH07XG5cbiAgcmV0dXJuIG9yZGVyID4gMFxuICAgID8geyBraW5kOiBcImhpZ2hlclwiLCBzaWRlOiBcIm91cnNcIiwgc3BlY2lmaWVyOiBvdXJzLnRyaW0oKSB9XG4gICAgOiB7IGtpbmQ6IFwiaGlnaGVyXCIsIHNpZGU6IFwidGhlaXJzXCIsIHNwZWNpZmllcjogdGhlaXJzLnRyaW0oKSB9O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFJ1bGUgcmVnaXN0cnlcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKipcbiAqIFRoZSByZXN1bHQgb2YgYSBydWxlIGF0dGVtcHRpbmcgYSBmaWxlLlxuICpcbiAqIFRoZXJlIGlzIG5vIGBwYXJ0aWFsYDogYSBmaWxlIGlzIGVpdGhlciBmdWxseSBydWxlLXJlc29sdmVkIG9yIGVudGlyZWx5XG4gKiBkZWZlcnJlZCwgc28gbm8gcmVzb2x1dGlvbiBjYW4gbGVhdmUgY29uZmxpY3QgbWFya2VycyBiZWhpbmQuXG4gKi9cbmV4cG9ydCB0eXBlIFJ1bGVPdXRjb21lID1cbiAgfCB7IGtpbmQ6IFwicmVzb2x2ZWRcIjsgdGV4dDogc3RyaW5nIH1cbiAgfCB7IGtpbmQ6IFwidW5yZXNvbHZlZFwiOyByZWFzb246IHN0cmluZyB9O1xuXG4vKipcbiAqIFdoYXQgYSBydWxlIGtub3dzIGFib3V0IHRoZSBmaWxlIGJleW9uZCBpdHMgb3duIHRleHQgKElzc3VlICMxNzY4KS5cbiAqXG4gKiBUaGUgUFIgbWVyZ2UgcnVucyB3aXRob3V0IGBkaWZmM2AgbWFya2Vycywgc28gYSBodW5rIGNhcnJpZXMgbm9cbiAqIGB8fHx8fHx8IGJhc2VgIHNlY3Rpb24gYW5kIGEgcnVsZSB0aGF0IGhhcyB0byBrbm93IHdoYXQgdGhlIG1lcmdlIGJhc2Ugc2FpZFxuICogY2Fubm90IHJlYWQgaXQgZnJvbSB0aGUgZmlsZS4gVGhlIHBhc3MgcmVhZHMgaXQgb3V0IG9mIHRoZSBjb25mbGljdGVkIGluZGV4XG4gKiBpbnN0ZWFkIChgZ2l0IHNob3cgOjE6PHBhdGg+YCwgdGhlIHN0YWdlIGBtZXJnZV9jb25mbGljdF9zdGFnZXMudHNgIHJlcG9ydHMpXG4gKiBhbmQgaGFuZHMgaXQgb3ZlciBoZXJlLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFJ1bGVDb250ZXh0IHtcbiAgLyoqIFJlcG9zaXRvcnktcmVsYXRpdmUgcGF0aCBvZiB0aGUgY29uZmxpY3RlZCBmaWxlLiAqL1xuICByZWFkb25seSBwYXRoOiBzdHJpbmc7XG4gIC8qKlxuICAgKiBUaGUgbWVyZ2UgYmFzZSdzIHZlcnNpb24gb2YgdGhhdCBmaWxlLCBvciBudWxsIHdoZW4gdGhlcmUgaXMgbm9uZSB0byBiZVxuICAgKiBoYWQg4oCUIGFuIGFkZC9hZGQgY29uZmxpY3Qgd2l0aCBubyBzdGFnZSAxLCBvciBhIHN0YWdlIGdpdCByZWZ1c2VkLiBOdWxsXG4gICAqIG5ldmVyIHJlYWRzIGFzIFwidGhlIGJhc2Ugd2FzIGVtcHR5XCI6IGEgcnVsZSB0aGF0IG5lZWRzIHRoZSBiYXNlIGRlZmVycy5cbiAgICpcbiAgICogT25seSBwb3B1bGF0ZWQgZm9yIGEgcnVsZSB0aGF0IHNldHMge0BsaW5rIE1hbmlmZXN0UnVsZS5uZWVkc0Jhc2V9LlxuICAgKi9cbiAgcmVhZG9ubHkgYmFzZTogc3RyaW5nIHwgbnVsbDtcbn1cblxuLyoqIEEgcGVyLW1hbmlmZXN0IGRldGVybWluaXN0aWMgcmVzb2x1dGlvbiBydWxlLiAqL1xuZXhwb3J0IGludGVyZmFjZSBNYW5pZmVzdFJ1bGUge1xuICAvKiogVW5pcXVlLCBzdGFibGUgbmFtZSDigJQgdXNlZCBmb3IgbG9nZ2luZyBhbmQgZHVwbGljYXRlIGRldGVjdGlvbi4gKi9cbiAgcmVhZG9ubHkgbmFtZTogc3RyaW5nO1xuICAvKiogV2hldGhlciB0aGlzIHJ1bGUgaGFuZGxlcyB0aGUgZ2l2ZW4gcmVwb3NpdG9yeS1yZWxhdGl2ZSBwYXRoLiAqL1xuICBtYXRjaGVzKHBhdGg6IHN0cmluZyk6IGJvb2xlYW47XG4gIC8qKlxuICAgKiBXaGV0aGVyIHRoZSBwYXNzIHNob3VsZCByZWFkIHRoZSBtZXJnZSBiYXNlIChpbmRleCBzdGFnZSAxKSBmb3IgdGhpcyBydWxlLlxuICAgKlxuICAgKiBPZmYgYnkgZGVmYXVsdDogcmVhZGluZyBpdCBjb3N0cyBhIGdpdCBjYWxsIHBlciBjb25mbGljdGVkIGZpbGUsIGFuZCB0aGVcbiAgICogbWFuaWZlc3QgcnVsZXMgZGVjaWRlIHBlciBkZXBlbmRlbmN5IGtleSB3aXRob3V0IGl0LlxuICAgKi9cbiAgcmVhZG9ubHkgbmVlZHNCYXNlPzogYm9vbGVhbjtcbiAgLyoqXG4gICAqIEF0dGVtcHQgdG8gcmVzb2x2ZSBhIHBhcnNlZCBmaWxlLlxuICAgKlxuICAgKiBSZWNlaXZlcyB0aGUgZnVsbCBvcmRlcmVkIHBhcnNlIChsaXRlcmFscyBhbmQgaHVua3MpIHJhdGhlciB0aGFuIHRoZSBodW5rc1xuICAgKiBhbG9uZSwgc28gYSBgcmVzb2x2ZWRgIG91dGNvbWUgY2FuIHJlcHJvZHVjZSBldmVyeSB1bmNvbmZsaWN0ZWQgYnl0ZSwgcGx1c1xuICAgKiB0aGUgY29udGV4dCBhYm92ZS4gQSBydWxlIHRoYXQgZG9lcyBub3QgbmVlZCB0aGUgY29udGV4dCBtYXkgZGVjbGFyZSBhXG4gICAqIHNpbmdsZSBwYXJhbWV0ZXIuXG4gICAqL1xuICByZXNvbHZlKFxuICAgIHNlZ21lbnRzOiByZWFkb25seSBDb25mbGljdFNlZ21lbnRbXSxcbiAgICBjb250ZXh0OiBSdWxlQ29udGV4dCxcbiAgKTogUnVsZU91dGNvbWU7XG59XG5cbi8qKiBMb29rdXAgb2YgbWFuaWZlc3QgcnVsZXMga2V5ZWQgb24gZmlsZSBwYXRoLiAqL1xuZXhwb3J0IGludGVyZmFjZSBNYW5pZmVzdFJ1bGVSZWdpc3RyeSB7XG4gIC8qKiBSZWdpc3RlciBhIHJ1bGU7IGEgZHVwbGljYXRlIG5hbWUgdGhyb3dzLiAqL1xuICByZWdpc3RlcihydWxlOiBNYW5pZmVzdFJ1bGUpOiB2b2lkO1xuICAvKiogVGhlIGZpcnN0IHJlZ2lzdGVyZWQgcnVsZSBtYXRjaGluZyBgcGF0aGAsIG9yIHVuZGVmaW5lZC4gKi9cbiAgZmluZChwYXRoOiBzdHJpbmcpOiBNYW5pZmVzdFJ1bGUgfCB1bmRlZmluZWQ7XG4gIC8qKiBSZWdpc3RlcmVkIHJ1bGVzIGluIHJlZ2lzdHJhdGlvbiBvcmRlci4gKi9cbiAgcmVhZG9ubHkgcnVsZXM6IHJlYWRvbmx5IE1hbmlmZXN0UnVsZVtdO1xufVxuXG4vKipcbiAqIENyZWF0ZSBhIHJ1bGUgcmVnaXN0cnksIG9wdGlvbmFsbHkgc2VlZGVkIHdpdGggcnVsZXMuXG4gKlxuICogTGF0ZXIgc3ViLWlzc3VlcyByZWdpc3RlciB0aGVpciBwZXItZWNvc3lzdGVtIGhhbmRsZXJzIGhlcmUgcmF0aGVyIHRoYW5cbiAqIGVkaXRpbmcgdGhpcyBjb3JlLiBSZWdpc3RyYXRpb24gb3JkZXIgaXMgbWF0Y2ggb3JkZXIsIHNvIHRoZSBmaXJzdCBtYXRjaGluZ1xuICogcnVsZSB3aW5zLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlTWFuaWZlc3RSdWxlUmVnaXN0cnkoXG4gIHNlZWQ6IHJlYWRvbmx5IE1hbmlmZXN0UnVsZVtdID0gW10sXG4pOiBNYW5pZmVzdFJ1bGVSZWdpc3RyeSB7XG4gIGNvbnN0IHJ1bGVzOiBNYW5pZmVzdFJ1bGVbXSA9IFtdO1xuXG4gIGNvbnN0IHJlZ2lzdGVyID0gKHJ1bGU6IE1hbmlmZXN0UnVsZSk6IHZvaWQgPT4ge1xuICAgIGlmIChydWxlcy5zb21lKChleGlzdGluZykgPT4gZXhpc3RpbmcubmFtZSA9PT0gcnVsZS5uYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBtYW5pZmVzdCBydWxlIGFscmVhZHkgcmVnaXN0ZXJlZDogJHtydWxlLm5hbWV9YCk7XG4gICAgfVxuICAgIHJ1bGVzLnB1c2gocnVsZSk7XG4gIH07XG5cbiAgZm9yIChjb25zdCBydWxlIG9mIHNlZWQpIHJlZ2lzdGVyKHJ1bGUpO1xuXG4gIHJldHVybiB7XG4gICAgcmVnaXN0ZXIsXG4gICAgZmluZDogKHBhdGgpID0+IHJ1bGVzLmZpbmQoKHJ1bGUpID0+IHJ1bGUubWF0Y2hlcyhwYXRoKSksXG4gICAgZ2V0IHJ1bGVzKCkge1xuICAgICAgcmV0dXJuIHJ1bGVzO1xuICAgIH0sXG4gIH07XG59XG5cbi8qKlxuICogVGhlIHNoYXJlZCByZWdpc3RyeSB0aGUgbWVyZ2UtY29uZmxpY3QgcGFzcyB3aWxsIGNvbnN1bHQuXG4gKlxuICogUGVyLWVjb3N5c3RlbSBtb2R1bGVzIGNhbGwgYG1hbmlmZXN0UnVsZVJlZ2lzdHJ5LnJlZ2lzdGVyKC4uLilgIGF0IGltcG9ydFxuICogdGltZSwgc28gYWRkaW5nIGFuIGVjb3N5c3RlbSBuZXZlciB0b3VjaGVzIHRoaXMgZmlsZS5cbiAqL1xuZXhwb3J0IGNvbnN0IG1hbmlmZXN0UnVsZVJlZ2lzdHJ5OiBNYW5pZmVzdFJ1bGVSZWdpc3RyeSA9XG4gIGNyZWF0ZU1hbmlmZXN0UnVsZVJlZ2lzdHJ5KCk7XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBbUNDLEdBR0QsU0FBUyxhQUFhLFFBQVEsd0JBQXdCO0FBRXRELDhFQUE4RTtBQUM5RSxtQkFBbUI7QUFDbkIsOEVBQThFO0FBRTlFLHVEQUF1RCxHQUN2RCxPQUFPLE1BQU0sY0FBYyxVQUFVO0FBRXJDLHNEQUFzRCxHQUN0RCxPQUFPLE1BQU0sY0FBYyxVQUFVO0FBRXJDLDRDQUE0QyxHQUM1QyxPQUFPLE1BQU0sbUJBQW1CLFVBQVU7QUFFMUMseURBQXlELEdBQ3pELE9BQU8sTUFBTSxnQkFBZ0IsVUFBVTtBQTJDdkMsOEVBQThFO0FBQzlFLGNBQWM7QUFD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
// denoCacheMetadata=7518705225203392548,4974831895563648759