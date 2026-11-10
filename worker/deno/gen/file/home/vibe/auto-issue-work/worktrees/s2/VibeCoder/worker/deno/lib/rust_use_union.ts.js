/**
 * Folding a textual union's duplicated Rust `use` declarations (Issue #3007).
 *
 * `unionMergeConflictedFile` resolves a conflicted test file by a textual
 * union (`git merge-file --union`): both sides' hunks are kept, whichever way
 * round they came. For a Rust file where both sides edited the *same* `use`
 * line, that union keeps both lines verbatim — e.g. two lines each importing
 * `StrategyConfig` and `Symbol` from `grq_policy` — which `cargo check`
 * rejects as `error[E0252]` (a name imported twice), so the resolution gate
 * refuses the same union every sync cycle.
 *
 * This module folds such duplicates back into one declaration *before* the
 * result is checked. It only ever merges `use` declarations whose item sets
 * overlap; anything it cannot parse with confidence — a nested brace, a glob
 * import, an attribute-gated import, an import with no path, a `use`-like
 * line that is not actually at brace depth 0 (e.g. inside a `mod`/`fn` body
 * written at column 0) or not actually code (inside a raw string, quoted
 * string, or block comment) — is left untouched, because a wrong fold here
 * would silently drop an import rather than merely fail to clean one up.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ /** Matches a top-level `use` declaration's opening line, column 0 only. */ const USE_START = /^(pub(?:\([^)]*\))?\s+)?use\s/;
/** Whether `items` is already in rustfmt's order: `self` first, then sorted. */ function isSortedRustfmt(items) {
  const rest = items[0] === "self" ? items.slice(1) : items;
  for(let i = 1; i < rest.length; i++){
    if (rest[i - 1] > rest[i]) return false;
  }
  return true;
}
/** Sort `items` the way rustfmt would: `self` first, then plain string order. */ function sortRustfmt(items) {
  const hasSelf = items.includes("self");
  const rest = items.filter((item)=>item !== "self").sort();
  return hasSelf ? [
    "self",
    ...rest
  ] : rest;
}
/** The union of `a` and `b`, in first-occurrence order, with no duplicates. */ function unionPreserveOrder(a, b) {
  const result = [
    ...a
  ];
  for (const item of b){
    if (!result.includes(item)) result.push(item);
  }
  return result;
}
/** Whether two item sets share at least one item (covers "identical" too). */ function itemsOverlap(a, b) {
  return a.some((item)=>b.includes(item));
}
/**
 * Parse one `use` declaration's text (its lines joined by a single space).
 *
 * Returns null for anything that is not confidently a simple, flat `use`:
 * a glob, a nested brace group, or a path with no `::` at all.
 */ function parseUseDeclaration(text) {
  const match = text.match(/^(pub(?:\([^)]*\))?\s+)?use\s+(.*);\s*$/s);
  if (!match) return null;
  const vis = match[1] ?? "";
  const body = match[2].trim();
  if (body.includes("*")) return null;
  const braceIndex = body.indexOf("{");
  if (braceIndex !== -1) {
    const closeIndex = body.lastIndexOf("}");
    if (closeIndex === -1 || closeIndex < braceIndex) return null;
    const inner = body.slice(braceIndex + 1, closeIndex);
    if (inner.includes("{") || inner.includes("}")) return null; // nested
    if (body.slice(closeIndex + 1).trim().length > 0) return null; // trailing junk
    const prefix = body.slice(0, braceIndex).replace(/::\s*$/, "").trim();
    if (prefix === "" || !prefix.length) return null;
    const items = inner.split(",").map((item)=>item.trim()).filter((item)=>item.length > 0);
    if (items.length === 0) return null;
    return {
      vis,
      prefix,
      items
    };
  }
  const sepIndex = body.lastIndexOf("::");
  if (sepIndex === -1) return null;
  const prefix = body.slice(0, sepIndex).trim();
  const item = body.slice(sepIndex + 2).trim();
  if (prefix === "" || item === "") return null;
  return {
    vis,
    prefix,
    items: [
      item
    ]
  };
}
/**
 * Strip a trailing `//` line comment. A `use` declaration's own text never
 * contains a string literal, so cutting at the first `//` is unambiguous.
 */ function stripLineComment(line) {
  const index = line.indexOf("//");
  return index === -1 ? line : line.slice(0, index);
}
/** Whether the nearest non-blank line before `start` is an attribute. */ function gatedByAttribute(lines, start) {
  for(let i = start - 1; i >= 0; i--){
    const trimmed = lines[i].trim();
    if (trimmed === "") continue;
    return trimmed.startsWith("#[");
  }
  return false;
}
/**
 * For each line, whether its column 0 sits at brace depth 0 and outside any
 * string or comment — the only position a top-level `use` can start.
 *
 * A column-0 line matching USE_START is not necessarily top-level: it may be
 * inside a `mod`/`fn` body written without rustfmt's indentation (a different
 * scope, where a duplicate import is not an error), or inside a raw string,
 * quoted string, or block comment (not code at all). Folding either case
 * risks dropping a legal import or rewriting literal text, so both must be
 * excluded before a candidate is even considered.
 */ function scanTopLevelLines(lines) {
  const topLevel = [];
  let depth = 0;
  let blockCommentDepth = 0;
  let rawStringHashes = -1; // -1 = not inside a raw string
  let inString = false; // inside a normal "..." or b"..." string
  for (const line of lines){
    topLevel.push(depth === 0 && blockCommentDepth === 0 && rawStringHashes === -1 && !inString);
    let i = 0;
    while(i < line.length){
      const ch = line[i];
      if (blockCommentDepth > 0) {
        if (ch === "/" && line[i + 1] === "*") {
          blockCommentDepth++;
          i += 2;
        } else if (ch === "*" && line[i + 1] === "/") {
          blockCommentDepth--;
          i += 2;
        } else {
          i++;
        }
        continue;
      }
      if (rawStringHashes !== -1) {
        const hashes = "#".repeat(rawStringHashes);
        if (ch === '"' && line.slice(i + 1, i + 1 + rawStringHashes) === hashes) {
          i += 1 + rawStringHashes;
          rawStringHashes = -1;
        } else {
          i++;
        }
        continue;
      }
      if (inString) {
        if (ch === "\\") {
          i += 2;
        } else {
          if (ch === '"') inString = false;
          i++;
        }
        continue;
      }
      if (ch === "/" && line[i + 1] === "/") break; // line comment: rest is not code
      if (ch === "/" && line[i + 1] === "*") {
        blockCommentDepth = 1;
        i += 2;
        continue;
      }
      const rawMatch = /^(?:b)?r(#*)"/.exec(line.slice(i));
      if (rawMatch) {
        rawStringHashes = rawMatch[1].length;
        i += rawMatch[0].length;
        continue;
      }
      if (ch === '"') {
        inString = true;
        i++;
        continue;
      }
      if (ch === "'") {
        const next = line[i + 1];
        if (next !== undefined && /[A-Za-z_]/.test(next)) {
          // A lifetime (`'a`, `'static`) — skip the quote and one identifier
          // character only, so a longer name's remaining letters are scanned
          // normally rather than being swallowed as part of a fake literal.
          i += 2;
        } else {
          // A char/byte literal (`'}'`, `'\n'`, `b'x'`) — skip to the closing
          // unescaped `'` without counting any brace or quote inside it.
          i++;
          while(i < line.length){
            if (line[i] === "\\") {
              i += 2;
              continue;
            }
            if (line[i] === "'") {
              i++;
              break;
            }
            i++;
          }
        }
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") depth = Math.max(0, depth - 1);
      i++;
    }
  }
  return topLevel;
}
/** Scan `lines` for top-level `use` declarations, parsed where possible. */ function findCandidates(lines) {
  const candidates = [];
  const topLevel = scanTopLevelLines(lines);
  let i = 0;
  while(i < lines.length){
    const line = lines[i];
    if (!topLevel[i] || !USE_START.test(line)) {
      i++;
      continue;
    }
    // Collect lines up to the terminating `;`.
    let end = -1;
    let joined = "";
    for(let j = i; j < lines.length; j++){
      const codePart = stripLineComment(lines[j]).trim();
      joined += (j > i ? " " : "") + codePart;
      if (codePart.includes(";")) {
        end = j;
        break;
      }
    }
    if (end === -1) {
      // Unterminated — not a candidate; move past this line only.
      i++;
      continue;
    }
    const gated = gatedByAttribute(lines, i);
    const parsed = gated ? null : parseUseDeclaration(joined);
    if (parsed) {
      candidates.push({
        start: i,
        end,
        ...parsed
      });
    }
    i = end + 1;
  }
  return candidates;
}
/** Group candidates by `vis + prefix`, folding overlapping item sets. */ function buildGroups(candidates) {
  const groups = [];
  candidates.forEach((candidate, index)=>{
    const key = `${candidate.vis}\u0000${candidate.prefix}`;
    const existing = groups.find((group)=>group.key === key && itemsOverlap(group.items, candidate.items));
    if (existing) {
      existing.items = unionPreserveOrder(existing.items, candidate.items);
      existing.memberIndices.push(index);
    } else {
      groups.push({
        key,
        items: [
          ...candidate.items
        ],
        memberIndices: [
          index
        ]
      });
    }
  });
  return groups;
}
/** Render one folded group's `use` declaration, as one or several lines. */ function renderGroup(vis, prefix, items) {
  const MAX_LINE = 100;
  if (items.length === 1) {
    const oneLine = `${vis}use ${prefix}::${items[0]};`;
    if (oneLine.length <= MAX_LINE) return [
      oneLine
    ];
  } else {
    const oneLine = `${vis}use ${prefix}::{${items.join(", ")}};`;
    if (oneLine.length <= MAX_LINE) return [
      oneLine
    ];
  }
  const lines = [
    `${vis}use ${prefix}::{`
  ];
  let current = "";
  for (const item of items){
    const candidate = current ? `${current}, ${item}` : item;
    if (`    ${candidate},`.length <= MAX_LINE) {
      current = candidate;
    } else {
      lines.push(`    ${current},`);
      current = item;
    }
  }
  if (current) lines.push(`    ${current},`);
  lines.push("};");
  return lines;
}
/**
 * Fold duplicated top-level Rust `use` declarations back into one.
 *
 * Only declarations whose item sets overlap are folded; everything else —
 * including anything this cannot parse with confidence — is left exactly as
 * it was. When nothing is folded the input is returned byte-for-byte, so this
 * is safe to call on every `.rs` union unconditionally.
 */ export function mergeDuplicateRustUses(text) {
  const crlf = text.includes("\r\n");
  const normalised = crlf ? text.replace(/\r\n/g, "\n") : text;
  const trailingNewline = normalised.endsWith("\n");
  const body = trailingNewline ? normalised.slice(0, -1) : normalised;
  const lines = body.split("\n");
  const candidates = findCandidates(lines);
  const groups = buildGroups(candidates);
  const groupByMember = new Map();
  for (const group of groups){
    for (const memberIndex of group.memberIndices){
      groupByMember.set(memberIndex, group);
    }
  }
  const candidateAtStart = new Map();
  candidates.forEach((candidate, index)=>candidateAtStart.set(candidate.start, index));
  let folded = false;
  const outLines = [];
  let i = 0;
  while(i < lines.length){
    const candidateIndex = candidateAtStart.get(i);
    if (candidateIndex === undefined) {
      outLines.push(lines[i]);
      i++;
      continue;
    }
    const candidate = candidates[candidateIndex];
    const group = groupByMember.get(candidateIndex);
    const isFoldedGroup = group.memberIndices.length > 1;
    if (!isFoldedGroup) {
      for(let k = candidate.start; k <= candidate.end; k++){
        outLines.push(lines[k]);
      }
      i = candidate.end + 1;
      continue;
    }
    folded = true;
    const isAnchor = group.memberIndices[0] === candidateIndex;
    if (isAnchor) {
      const allSorted = group.memberIndices.every((index)=>isSortedRustfmt(candidates[index].items));
      const finalItems = allSorted ? sortRustfmt(group.items) : group.items;
      outLines.push(...renderGroup(candidate.vis, candidate.prefix, finalItems));
    }
    // A non-anchor member's lines are dropped entirely — folded into the anchor.
    i = candidate.end + 1;
  }
  if (!folded) return text;
  let result = outLines.join("\n");
  if (trailingNewline) result += "\n";
  if (crlf) result = result.replace(/\n/g, "\r\n");
  return result;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9ydXN0X3VzZV91bmlvbi50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEZvbGRpbmcgYSB0ZXh0dWFsIHVuaW9uJ3MgZHVwbGljYXRlZCBSdXN0IGB1c2VgIGRlY2xhcmF0aW9ucyAoSXNzdWUgIzMwMDcpLlxuICpcbiAqIGB1bmlvbk1lcmdlQ29uZmxpY3RlZEZpbGVgIHJlc29sdmVzIGEgY29uZmxpY3RlZCB0ZXN0IGZpbGUgYnkgYSB0ZXh0dWFsXG4gKiB1bmlvbiAoYGdpdCBtZXJnZS1maWxlIC0tdW5pb25gKTogYm90aCBzaWRlcycgaHVua3MgYXJlIGtlcHQsIHdoaWNoZXZlciB3YXlcbiAqIHJvdW5kIHRoZXkgY2FtZS4gRm9yIGEgUnVzdCBmaWxlIHdoZXJlIGJvdGggc2lkZXMgZWRpdGVkIHRoZSAqc2FtZSogYHVzZWBcbiAqIGxpbmUsIHRoYXQgdW5pb24ga2VlcHMgYm90aCBsaW5lcyB2ZXJiYXRpbSDigJQgZS5nLiB0d28gbGluZXMgZWFjaCBpbXBvcnRpbmdcbiAqIGBTdHJhdGVneUNvbmZpZ2AgYW5kIGBTeW1ib2xgIGZyb20gYGdycV9wb2xpY3lgIOKAlCB3aGljaCBgY2FyZ28gY2hlY2tgXG4gKiByZWplY3RzIGFzIGBlcnJvcltFMDI1Ml1gIChhIG5hbWUgaW1wb3J0ZWQgdHdpY2UpLCBzbyB0aGUgcmVzb2x1dGlvbiBnYXRlXG4gKiByZWZ1c2VzIHRoZSBzYW1lIHVuaW9uIGV2ZXJ5IHN5bmMgY3ljbGUuXG4gKlxuICogVGhpcyBtb2R1bGUgZm9sZHMgc3VjaCBkdXBsaWNhdGVzIGJhY2sgaW50byBvbmUgZGVjbGFyYXRpb24gKmJlZm9yZSogdGhlXG4gKiByZXN1bHQgaXMgY2hlY2tlZC4gSXQgb25seSBldmVyIG1lcmdlcyBgdXNlYCBkZWNsYXJhdGlvbnMgd2hvc2UgaXRlbSBzZXRzXG4gKiBvdmVybGFwOyBhbnl0aGluZyBpdCBjYW5ub3QgcGFyc2Ugd2l0aCBjb25maWRlbmNlIOKAlCBhIG5lc3RlZCBicmFjZSwgYSBnbG9iXG4gKiBpbXBvcnQsIGFuIGF0dHJpYnV0ZS1nYXRlZCBpbXBvcnQsIGFuIGltcG9ydCB3aXRoIG5vIHBhdGgsIGEgYHVzZWAtbGlrZVxuICogbGluZSB0aGF0IGlzIG5vdCBhY3R1YWxseSBhdCBicmFjZSBkZXB0aCAwIChlLmcuIGluc2lkZSBhIGBtb2RgL2BmbmAgYm9keVxuICogd3JpdHRlbiBhdCBjb2x1bW4gMCkgb3Igbm90IGFjdHVhbGx5IGNvZGUgKGluc2lkZSBhIHJhdyBzdHJpbmcsIHF1b3RlZFxuICogc3RyaW5nLCBvciBibG9jayBjb21tZW50KSDigJQgaXMgbGVmdCB1bnRvdWNoZWQsIGJlY2F1c2UgYSB3cm9uZyBmb2xkIGhlcmVcbiAqIHdvdWxkIHNpbGVudGx5IGRyb3AgYW4gaW1wb3J0IHJhdGhlciB0aGFuIG1lcmVseSBmYWlsIHRvIGNsZWFuIG9uZSB1cC5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG4vKiogTWF0Y2hlcyBhIHRvcC1sZXZlbCBgdXNlYCBkZWNsYXJhdGlvbidzIG9wZW5pbmcgbGluZSwgY29sdW1uIDAgb25seS4gKi9cbmNvbnN0IFVTRV9TVEFSVCA9IC9eKHB1Yig/OlxcKFteKV0qXFwpKT9cXHMrKT91c2VcXHMvO1xuXG4vKiogT25lIHBhcnNlZCB0b3AtbGV2ZWwgYHVzZWAgZGVjbGFyYXRpb24uICovXG5pbnRlcmZhY2UgUGFyc2VkVXNlIHtcbiAgLyoqIFRoZSB2aXNpYmlsaXR5IHByZWZpeCBhcyB3cml0dGVuLCBpbmNsdWRpbmcgaXRzIHRyYWlsaW5nIHNwYWNlLiAqL1xuICB2aXM6IHN0cmluZztcbiAgLyoqIFRoZSBwYXRoIHNoYXJlZCBieSBldmVyeSBpdGVtLCBlLmcuIGBncnFfcG9saWN5YC4gKi9cbiAgcHJlZml4OiBzdHJpbmc7XG4gIC8qKiBUaGUgaW1wb3J0ZWQgaXRlbXMsIGluIHRoZSBvcmRlciB0aGV5IHdlcmUgd3JpdHRlbi4gKi9cbiAgaXRlbXM6IHN0cmluZ1tdO1xufVxuXG4vKiogT25lIGB1c2VgIGRlY2xhcmF0aW9uIGZvdW5kIHdoaWxlIHNjYW5uaW5nIHRoZSBmaWxlLCBsaW5lLWluZGV4ZWQuICovXG5pbnRlcmZhY2UgQ2FuZGlkYXRlIGV4dGVuZHMgUGFyc2VkVXNlIHtcbiAgLyoqIEZpcnN0IGxpbmUgb2YgdGhpcyBkZWNsYXJhdGlvbiAoMC1iYXNlZCwgaW4gdGhlIG5vcm1hbGlzZWQgdGV4dCkuICovXG4gIHN0YXJ0OiBudW1iZXI7XG4gIC8qKiBMYXN0IGxpbmUgb2YgdGhpcyBkZWNsYXJhdGlvbiAoMC1iYXNlZCwgaW5jbHVzaXZlKS4gKi9cbiAgZW5kOiBudW1iZXI7XG59XG5cbi8qKiBBIHNldCBvZiBjYW5kaWRhdGVzIHdpdGggdGhlIHNhbWUga2V5LCBmb2xkZWQgdG9nZXRoZXIgd2hlbiB0aGV5IG92ZXJsYXAuICovXG5pbnRlcmZhY2UgR3JvdXAge1xuICBrZXk6IHN0cmluZztcbiAgLyoqIEluZGljZXMgaW50byB0aGUgY2FuZGlkYXRlIGxpc3Q7IHRoZSBmaXJzdCBpcyB0aGUgZ3JvdXAncyBhbmNob3IuICovXG4gIG1lbWJlckluZGljZXM6IG51bWJlcltdO1xuICAvKiogVGhlIHJ1bm5pbmcgdW5pb24gb2YgZXZlcnkgbWVtYmVyJ3MgaXRlbXMsIGluIGZpcnN0LW9jY3VycmVuY2Ugb3JkZXIuICovXG4gIGl0ZW1zOiBzdHJpbmdbXTtcbn1cblxuLyoqIFdoZXRoZXIgYGl0ZW1zYCBpcyBhbHJlYWR5IGluIHJ1c3RmbXQncyBvcmRlcjogYHNlbGZgIGZpcnN0LCB0aGVuIHNvcnRlZC4gKi9cbmZ1bmN0aW9uIGlzU29ydGVkUnVzdGZtdChpdGVtczogc3RyaW5nW10pOiBib29sZWFuIHtcbiAgY29uc3QgcmVzdCA9IGl0ZW1zWzBdID09PSBcInNlbGZcIiA/IGl0ZW1zLnNsaWNlKDEpIDogaXRlbXM7XG4gIGZvciAobGV0IGkgPSAxOyBpIDwgcmVzdC5sZW5ndGg7IGkrKykge1xuICAgIGlmIChyZXN0W2kgLSAxXSEgPiByZXN0W2ldISkgcmV0dXJuIGZhbHNlO1xuICB9XG4gIHJldHVybiB0cnVlO1xufVxuXG4vKiogU29ydCBgaXRlbXNgIHRoZSB3YXkgcnVzdGZtdCB3b3VsZDogYHNlbGZgIGZpcnN0LCB0aGVuIHBsYWluIHN0cmluZyBvcmRlci4gKi9cbmZ1bmN0aW9uIHNvcnRSdXN0Zm10KGl0ZW1zOiBzdHJpbmdbXSk6IHN0cmluZ1tdIHtcbiAgY29uc3QgaGFzU2VsZiA9IGl0ZW1zLmluY2x1ZGVzKFwic2VsZlwiKTtcbiAgY29uc3QgcmVzdCA9IGl0ZW1zLmZpbHRlcigoaXRlbSkgPT4gaXRlbSAhPT0gXCJzZWxmXCIpLnNvcnQoKTtcbiAgcmV0dXJuIGhhc1NlbGYgPyBbXCJzZWxmXCIsIC4uLnJlc3RdIDogcmVzdDtcbn1cblxuLyoqIFRoZSB1bmlvbiBvZiBgYWAgYW5kIGBiYCwgaW4gZmlyc3Qtb2NjdXJyZW5jZSBvcmRlciwgd2l0aCBubyBkdXBsaWNhdGVzLiAqL1xuZnVuY3Rpb24gdW5pb25QcmVzZXJ2ZU9yZGVyKGE6IHN0cmluZ1tdLCBiOiBzdHJpbmdbXSk6IHN0cmluZ1tdIHtcbiAgY29uc3QgcmVzdWx0ID0gWy4uLmFdO1xuICBmb3IgKGNvbnN0IGl0ZW0gb2YgYikge1xuICAgIGlmICghcmVzdWx0LmluY2x1ZGVzKGl0ZW0pKSByZXN1bHQucHVzaChpdGVtKTtcbiAgfVxuICByZXR1cm4gcmVzdWx0O1xufVxuXG4vKiogV2hldGhlciB0d28gaXRlbSBzZXRzIHNoYXJlIGF0IGxlYXN0IG9uZSBpdGVtIChjb3ZlcnMgXCJpZGVudGljYWxcIiB0b28pLiAqL1xuZnVuY3Rpb24gaXRlbXNPdmVybGFwKGE6IHN0cmluZ1tdLCBiOiBzdHJpbmdbXSk6IGJvb2xlYW4ge1xuICByZXR1cm4gYS5zb21lKChpdGVtKSA9PiBiLmluY2x1ZGVzKGl0ZW0pKTtcbn1cblxuLyoqXG4gKiBQYXJzZSBvbmUgYHVzZWAgZGVjbGFyYXRpb24ncyB0ZXh0IChpdHMgbGluZXMgam9pbmVkIGJ5IGEgc2luZ2xlIHNwYWNlKS5cbiAqXG4gKiBSZXR1cm5zIG51bGwgZm9yIGFueXRoaW5nIHRoYXQgaXMgbm90IGNvbmZpZGVudGx5IGEgc2ltcGxlLCBmbGF0IGB1c2VgOlxuICogYSBnbG9iLCBhIG5lc3RlZCBicmFjZSBncm91cCwgb3IgYSBwYXRoIHdpdGggbm8gYDo6YCBhdCBhbGwuXG4gKi9cbmZ1bmN0aW9uIHBhcnNlVXNlRGVjbGFyYXRpb24odGV4dDogc3RyaW5nKTogUGFyc2VkVXNlIHwgbnVsbCB7XG4gIGNvbnN0IG1hdGNoID0gdGV4dC5tYXRjaCgvXihwdWIoPzpcXChbXildKlxcKSk/XFxzKyk/dXNlXFxzKyguKik7XFxzKiQvcyk7XG4gIGlmICghbWF0Y2gpIHJldHVybiBudWxsO1xuICBjb25zdCB2aXMgPSBtYXRjaFsxXSA/PyBcIlwiO1xuICBjb25zdCBib2R5ID0gbWF0Y2hbMl0hLnRyaW0oKTtcbiAgaWYgKGJvZHkuaW5jbHVkZXMoXCIqXCIpKSByZXR1cm4gbnVsbDtcblxuICBjb25zdCBicmFjZUluZGV4ID0gYm9keS5pbmRleE9mKFwie1wiKTtcbiAgaWYgKGJyYWNlSW5kZXggIT09IC0xKSB7XG4gICAgY29uc3QgY2xvc2VJbmRleCA9IGJvZHkubGFzdEluZGV4T2YoXCJ9XCIpO1xuICAgIGlmIChjbG9zZUluZGV4ID09PSAtMSB8fCBjbG9zZUluZGV4IDwgYnJhY2VJbmRleCkgcmV0dXJuIG51bGw7XG4gICAgY29uc3QgaW5uZXIgPSBib2R5LnNsaWNlKGJyYWNlSW5kZXggKyAxLCBjbG9zZUluZGV4KTtcbiAgICBpZiAoaW5uZXIuaW5jbHVkZXMoXCJ7XCIpIHx8IGlubmVyLmluY2x1ZGVzKFwifVwiKSkgcmV0dXJuIG51bGw7IC8vIG5lc3RlZFxuICAgIGlmIChib2R5LnNsaWNlKGNsb3NlSW5kZXggKyAxKS50cmltKCkubGVuZ3RoID4gMCkgcmV0dXJuIG51bGw7IC8vIHRyYWlsaW5nIGp1bmtcbiAgICBjb25zdCBwcmVmaXggPSBib2R5LnNsaWNlKDAsIGJyYWNlSW5kZXgpLnJlcGxhY2UoLzo6XFxzKiQvLCBcIlwiKS50cmltKCk7XG4gICAgaWYgKHByZWZpeCA9PT0gXCJcIiB8fCAhcHJlZml4Lmxlbmd0aCkgcmV0dXJuIG51bGw7XG4gICAgY29uc3QgaXRlbXMgPSBpbm5lclxuICAgICAgLnNwbGl0KFwiLFwiKVxuICAgICAgLm1hcCgoaXRlbSkgPT4gaXRlbS50cmltKCkpXG4gICAgICAuZmlsdGVyKChpdGVtKSA9PiBpdGVtLmxlbmd0aCA+IDApO1xuICAgIGlmIChpdGVtcy5sZW5ndGggPT09IDApIHJldHVybiBudWxsO1xuICAgIHJldHVybiB7IHZpcywgcHJlZml4LCBpdGVtcyB9O1xuICB9XG5cbiAgY29uc3Qgc2VwSW5kZXggPSBib2R5Lmxhc3RJbmRleE9mKFwiOjpcIik7XG4gIGlmIChzZXBJbmRleCA9PT0gLTEpIHJldHVybiBudWxsO1xuICBjb25zdCBwcmVmaXggPSBib2R5LnNsaWNlKDAsIHNlcEluZGV4KS50cmltKCk7XG4gIGNvbnN0IGl0ZW0gPSBib2R5LnNsaWNlKHNlcEluZGV4ICsgMikudHJpbSgpO1xuICBpZiAocHJlZml4ID09PSBcIlwiIHx8IGl0ZW0gPT09IFwiXCIpIHJldHVybiBudWxsO1xuICByZXR1cm4geyB2aXMsIHByZWZpeCwgaXRlbXM6IFtpdGVtXSB9O1xufVxuXG4vKipcbiAqIFN0cmlwIGEgdHJhaWxpbmcgYC8vYCBsaW5lIGNvbW1lbnQuIEEgYHVzZWAgZGVjbGFyYXRpb24ncyBvd24gdGV4dCBuZXZlclxuICogY29udGFpbnMgYSBzdHJpbmcgbGl0ZXJhbCwgc28gY3V0dGluZyBhdCB0aGUgZmlyc3QgYC8vYCBpcyB1bmFtYmlndW91cy5cbiAqL1xuZnVuY3Rpb24gc3RyaXBMaW5lQ29tbWVudChsaW5lOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBpbmRleCA9IGxpbmUuaW5kZXhPZihcIi8vXCIpO1xuICByZXR1cm4gaW5kZXggPT09IC0xID8gbGluZSA6IGxpbmUuc2xpY2UoMCwgaW5kZXgpO1xufVxuXG4vKiogV2hldGhlciB0aGUgbmVhcmVzdCBub24tYmxhbmsgbGluZSBiZWZvcmUgYHN0YXJ0YCBpcyBhbiBhdHRyaWJ1dGUuICovXG5mdW5jdGlvbiBnYXRlZEJ5QXR0cmlidXRlKGxpbmVzOiBzdHJpbmdbXSwgc3RhcnQ6IG51bWJlcik6IGJvb2xlYW4ge1xuICBmb3IgKGxldCBpID0gc3RhcnQgLSAxOyBpID49IDA7IGktLSkge1xuICAgIGNvbnN0IHRyaW1tZWQgPSBsaW5lc1tpXSEudHJpbSgpO1xuICAgIGlmICh0cmltbWVkID09PSBcIlwiKSBjb250aW51ZTtcbiAgICByZXR1cm4gdHJpbW1lZC5zdGFydHNXaXRoKFwiI1tcIik7XG4gIH1cbiAgcmV0dXJuIGZhbHNlO1xufVxuXG4vKipcbiAqIEZvciBlYWNoIGxpbmUsIHdoZXRoZXIgaXRzIGNvbHVtbiAwIHNpdHMgYXQgYnJhY2UgZGVwdGggMCBhbmQgb3V0c2lkZSBhbnlcbiAqIHN0cmluZyBvciBjb21tZW50IOKAlCB0aGUgb25seSBwb3NpdGlvbiBhIHRvcC1sZXZlbCBgdXNlYCBjYW4gc3RhcnQuXG4gKlxuICogQSBjb2x1bW4tMCBsaW5lIG1hdGNoaW5nIFVTRV9TVEFSVCBpcyBub3QgbmVjZXNzYXJpbHkgdG9wLWxldmVsOiBpdCBtYXkgYmVcbiAqIGluc2lkZSBhIGBtb2RgL2BmbmAgYm9keSB3cml0dGVuIHdpdGhvdXQgcnVzdGZtdCdzIGluZGVudGF0aW9uIChhIGRpZmZlcmVudFxuICogc2NvcGUsIHdoZXJlIGEgZHVwbGljYXRlIGltcG9ydCBpcyBub3QgYW4gZXJyb3IpLCBvciBpbnNpZGUgYSByYXcgc3RyaW5nLFxuICogcXVvdGVkIHN0cmluZywgb3IgYmxvY2sgY29tbWVudCAobm90IGNvZGUgYXQgYWxsKS4gRm9sZGluZyBlaXRoZXIgY2FzZVxuICogcmlza3MgZHJvcHBpbmcgYSBsZWdhbCBpbXBvcnQgb3IgcmV3cml0aW5nIGxpdGVyYWwgdGV4dCwgc28gYm90aCBtdXN0IGJlXG4gKiBleGNsdWRlZCBiZWZvcmUgYSBjYW5kaWRhdGUgaXMgZXZlbiBjb25zaWRlcmVkLlxuICovXG5mdW5jdGlvbiBzY2FuVG9wTGV2ZWxMaW5lcyhsaW5lczogc3RyaW5nW10pOiBib29sZWFuW10ge1xuICBjb25zdCB0b3BMZXZlbDogYm9vbGVhbltdID0gW107XG4gIGxldCBkZXB0aCA9IDA7XG4gIGxldCBibG9ja0NvbW1lbnREZXB0aCA9IDA7XG4gIGxldCByYXdTdHJpbmdIYXNoZXMgPSAtMTsgLy8gLTEgPSBub3QgaW5zaWRlIGEgcmF3IHN0cmluZ1xuICBsZXQgaW5TdHJpbmcgPSBmYWxzZTsgLy8gaW5zaWRlIGEgbm9ybWFsIFwiLi4uXCIgb3IgYlwiLi4uXCIgc3RyaW5nXG5cbiAgZm9yIChjb25zdCBsaW5lIG9mIGxpbmVzKSB7XG4gICAgdG9wTGV2ZWwucHVzaChcbiAgICAgIGRlcHRoID09PSAwICYmIGJsb2NrQ29tbWVudERlcHRoID09PSAwICYmIHJhd1N0cmluZ0hhc2hlcyA9PT0gLTEgJiZcbiAgICAgICAgIWluU3RyaW5nLFxuICAgICk7XG4gICAgbGV0IGkgPSAwO1xuICAgIHdoaWxlIChpIDwgbGluZS5sZW5ndGgpIHtcbiAgICAgIGNvbnN0IGNoID0gbGluZVtpXSE7XG4gICAgICBpZiAoYmxvY2tDb21tZW50RGVwdGggPiAwKSB7XG4gICAgICAgIGlmIChjaCA9PT0gXCIvXCIgJiYgbGluZVtpICsgMV0gPT09IFwiKlwiKSB7XG4gICAgICAgICAgYmxvY2tDb21tZW50RGVwdGgrKztcbiAgICAgICAgICBpICs9IDI7XG4gICAgICAgIH0gZWxzZSBpZiAoY2ggPT09IFwiKlwiICYmIGxpbmVbaSArIDFdID09PSBcIi9cIikge1xuICAgICAgICAgIGJsb2NrQ29tbWVudERlcHRoLS07XG4gICAgICAgICAgaSArPSAyO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGkrKztcbiAgICAgICAgfVxuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmIChyYXdTdHJpbmdIYXNoZXMgIT09IC0xKSB7XG4gICAgICAgIGNvbnN0IGhhc2hlcyA9IFwiI1wiLnJlcGVhdChyYXdTdHJpbmdIYXNoZXMpO1xuICAgICAgICBpZiAoXG4gICAgICAgICAgY2ggPT09ICdcIicgJiYgbGluZS5zbGljZShpICsgMSwgaSArIDEgKyByYXdTdHJpbmdIYXNoZXMpID09PSBoYXNoZXNcbiAgICAgICAgKSB7XG4gICAgICAgICAgaSArPSAxICsgcmF3U3RyaW5nSGFzaGVzO1xuICAgICAgICAgIHJhd1N0cmluZ0hhc2hlcyA9IC0xO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGkrKztcbiAgICAgICAgfVxuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmIChpblN0cmluZykge1xuICAgICAgICBpZiAoY2ggPT09IFwiXFxcXFwiKSB7XG4gICAgICAgICAgaSArPSAyO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGlmIChjaCA9PT0gJ1wiJykgaW5TdHJpbmcgPSBmYWxzZTtcbiAgICAgICAgICBpKys7XG4gICAgICAgIH1cbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBpZiAoY2ggPT09IFwiL1wiICYmIGxpbmVbaSArIDFdID09PSBcIi9cIikgYnJlYWs7IC8vIGxpbmUgY29tbWVudDogcmVzdCBpcyBub3QgY29kZVxuICAgICAgaWYgKGNoID09PSBcIi9cIiAmJiBsaW5lW2kgKyAxXSA9PT0gXCIqXCIpIHtcbiAgICAgICAgYmxvY2tDb21tZW50RGVwdGggPSAxO1xuICAgICAgICBpICs9IDI7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgY29uc3QgcmF3TWF0Y2ggPSAvXig/OmIpP3IoIyopXCIvLmV4ZWMobGluZS5zbGljZShpKSk7XG4gICAgICBpZiAocmF3TWF0Y2gpIHtcbiAgICAgICAgcmF3U3RyaW5nSGFzaGVzID0gcmF3TWF0Y2hbMV0hLmxlbmd0aDtcbiAgICAgICAgaSArPSByYXdNYXRjaFswXS5sZW5ndGg7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgaWYgKGNoID09PSAnXCInKSB7XG4gICAgICAgIGluU3RyaW5nID0gdHJ1ZTtcbiAgICAgICAgaSsrO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmIChjaCA9PT0gXCInXCIpIHtcbiAgICAgICAgY29uc3QgbmV4dCA9IGxpbmVbaSArIDFdO1xuICAgICAgICBpZiAobmV4dCAhPT0gdW5kZWZpbmVkICYmIC9bQS1aYS16X10vLnRlc3QobmV4dCkpIHtcbiAgICAgICAgICAvLyBBIGxpZmV0aW1lIChgJ2FgLCBgJ3N0YXRpY2ApIOKAlCBza2lwIHRoZSBxdW90ZSBhbmQgb25lIGlkZW50aWZpZXJcbiAgICAgICAgICAvLyBjaGFyYWN0ZXIgb25seSwgc28gYSBsb25nZXIgbmFtZSdzIHJlbWFpbmluZyBsZXR0ZXJzIGFyZSBzY2FubmVkXG4gICAgICAgICAgLy8gbm9ybWFsbHkgcmF0aGVyIHRoYW4gYmVpbmcgc3dhbGxvd2VkIGFzIHBhcnQgb2YgYSBmYWtlIGxpdGVyYWwuXG4gICAgICAgICAgaSArPSAyO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIEEgY2hhci9ieXRlIGxpdGVyYWwgKGAnfSdgLCBgJ1xcbidgLCBgYid4J2ApIOKAlCBza2lwIHRvIHRoZSBjbG9zaW5nXG4gICAgICAgICAgLy8gdW5lc2NhcGVkIGAnYCB3aXRob3V0IGNvdW50aW5nIGFueSBicmFjZSBvciBxdW90ZSBpbnNpZGUgaXQuXG4gICAgICAgICAgaSsrO1xuICAgICAgICAgIHdoaWxlIChpIDwgbGluZS5sZW5ndGgpIHtcbiAgICAgICAgICAgIGlmIChsaW5lW2ldID09PSBcIlxcXFxcIikge1xuICAgICAgICAgICAgICBpICs9IDI7XG4gICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGxpbmVbaV0gPT09IFwiJ1wiKSB7XG4gICAgICAgICAgICAgIGkrKztcbiAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpKys7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgaWYgKGNoID09PSBcIntcIikgZGVwdGgrKztcbiAgICAgIGVsc2UgaWYgKGNoID09PSBcIn1cIikgZGVwdGggPSBNYXRoLm1heCgwLCBkZXB0aCAtIDEpO1xuICAgICAgaSsrO1xuICAgIH1cbiAgfVxuICByZXR1cm4gdG9wTGV2ZWw7XG59XG5cbi8qKiBTY2FuIGBsaW5lc2AgZm9yIHRvcC1sZXZlbCBgdXNlYCBkZWNsYXJhdGlvbnMsIHBhcnNlZCB3aGVyZSBwb3NzaWJsZS4gKi9cbmZ1bmN0aW9uIGZpbmRDYW5kaWRhdGVzKGxpbmVzOiBzdHJpbmdbXSk6IENhbmRpZGF0ZVtdIHtcbiAgY29uc3QgY2FuZGlkYXRlczogQ2FuZGlkYXRlW10gPSBbXTtcbiAgY29uc3QgdG9wTGV2ZWwgPSBzY2FuVG9wTGV2ZWxMaW5lcyhsaW5lcyk7XG4gIGxldCBpID0gMDtcbiAgd2hpbGUgKGkgPCBsaW5lcy5sZW5ndGgpIHtcbiAgICBjb25zdCBsaW5lID0gbGluZXNbaV0hO1xuICAgIGlmICghdG9wTGV2ZWxbaV0gfHwgIVVTRV9TVEFSVC50ZXN0KGxpbmUpKSB7XG4gICAgICBpKys7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgLy8gQ29sbGVjdCBsaW5lcyB1cCB0byB0aGUgdGVybWluYXRpbmcgYDtgLlxuICAgIGxldCBlbmQgPSAtMTtcbiAgICBsZXQgam9pbmVkID0gXCJcIjtcbiAgICBmb3IgKGxldCBqID0gaTsgaiA8IGxpbmVzLmxlbmd0aDsgaisrKSB7XG4gICAgICBjb25zdCBjb2RlUGFydCA9IHN0cmlwTGluZUNvbW1lbnQobGluZXNbal0hKS50cmltKCk7XG4gICAgICBqb2luZWQgKz0gKGogPiBpID8gXCIgXCIgOiBcIlwiKSArIGNvZGVQYXJ0O1xuICAgICAgaWYgKGNvZGVQYXJ0LmluY2x1ZGVzKFwiO1wiKSkge1xuICAgICAgICBlbmQgPSBqO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKGVuZCA9PT0gLTEpIHtcbiAgICAgIC8vIFVudGVybWluYXRlZCDigJQgbm90IGEgY2FuZGlkYXRlOyBtb3ZlIHBhc3QgdGhpcyBsaW5lIG9ubHkuXG4gICAgICBpKys7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgZ2F0ZWQgPSBnYXRlZEJ5QXR0cmlidXRlKGxpbmVzLCBpKTtcbiAgICBjb25zdCBwYXJzZWQgPSBnYXRlZCA/IG51bGwgOiBwYXJzZVVzZURlY2xhcmF0aW9uKGpvaW5lZCk7XG4gICAgaWYgKHBhcnNlZCkge1xuICAgICAgY2FuZGlkYXRlcy5wdXNoKHsgc3RhcnQ6IGksIGVuZCwgLi4ucGFyc2VkIH0pO1xuICAgIH1cbiAgICBpID0gZW5kICsgMTtcbiAgfVxuICByZXR1cm4gY2FuZGlkYXRlcztcbn1cblxuLyoqIEdyb3VwIGNhbmRpZGF0ZXMgYnkgYHZpcyArIHByZWZpeGAsIGZvbGRpbmcgb3ZlcmxhcHBpbmcgaXRlbSBzZXRzLiAqL1xuZnVuY3Rpb24gYnVpbGRHcm91cHMoY2FuZGlkYXRlczogQ2FuZGlkYXRlW10pOiBHcm91cFtdIHtcbiAgY29uc3QgZ3JvdXBzOiBHcm91cFtdID0gW107XG4gIGNhbmRpZGF0ZXMuZm9yRWFjaCgoY2FuZGlkYXRlLCBpbmRleCkgPT4ge1xuICAgIGNvbnN0IGtleSA9IGAke2NhbmRpZGF0ZS52aXN9XFx1MDAwMCR7Y2FuZGlkYXRlLnByZWZpeH1gO1xuICAgIGNvbnN0IGV4aXN0aW5nID0gZ3JvdXBzLmZpbmQoXG4gICAgICAoZ3JvdXApID0+XG4gICAgICAgIGdyb3VwLmtleSA9PT0ga2V5ICYmIGl0ZW1zT3ZlcmxhcChncm91cC5pdGVtcywgY2FuZGlkYXRlLml0ZW1zKSxcbiAgICApO1xuICAgIGlmIChleGlzdGluZykge1xuICAgICAgZXhpc3RpbmcuaXRlbXMgPSB1bmlvblByZXNlcnZlT3JkZXIoZXhpc3RpbmcuaXRlbXMsIGNhbmRpZGF0ZS5pdGVtcyk7XG4gICAgICBleGlzdGluZy5tZW1iZXJJbmRpY2VzLnB1c2goaW5kZXgpO1xuICAgIH0gZWxzZSB7XG4gICAgICBncm91cHMucHVzaCh7IGtleSwgaXRlbXM6IFsuLi5jYW5kaWRhdGUuaXRlbXNdLCBtZW1iZXJJbmRpY2VzOiBbaW5kZXhdIH0pO1xuICAgIH1cbiAgfSk7XG4gIHJldHVybiBncm91cHM7XG59XG5cbi8qKiBSZW5kZXIgb25lIGZvbGRlZCBncm91cCdzIGB1c2VgIGRlY2xhcmF0aW9uLCBhcyBvbmUgb3Igc2V2ZXJhbCBsaW5lcy4gKi9cbmZ1bmN0aW9uIHJlbmRlckdyb3VwKHZpczogc3RyaW5nLCBwcmVmaXg6IHN0cmluZywgaXRlbXM6IHN0cmluZ1tdKTogc3RyaW5nW10ge1xuICBjb25zdCBNQVhfTElORSA9IDEwMDtcbiAgaWYgKGl0ZW1zLmxlbmd0aCA9PT0gMSkge1xuICAgIGNvbnN0IG9uZUxpbmUgPSBgJHt2aXN9dXNlICR7cHJlZml4fTo6JHtpdGVtc1swXX07YDtcbiAgICBpZiAob25lTGluZS5sZW5ndGggPD0gTUFYX0xJTkUpIHJldHVybiBbb25lTGluZV07XG4gIH0gZWxzZSB7XG4gICAgY29uc3Qgb25lTGluZSA9IGAke3Zpc311c2UgJHtwcmVmaXh9Ojp7JHtpdGVtcy5qb2luKFwiLCBcIil9fTtgO1xuICAgIGlmIChvbmVMaW5lLmxlbmd0aCA8PSBNQVhfTElORSkgcmV0dXJuIFtvbmVMaW5lXTtcbiAgfVxuXG4gIGNvbnN0IGxpbmVzID0gW2Ake3Zpc311c2UgJHtwcmVmaXh9Ojp7YF07XG4gIGxldCBjdXJyZW50ID0gXCJcIjtcbiAgZm9yIChjb25zdCBpdGVtIG9mIGl0ZW1zKSB7XG4gICAgY29uc3QgY2FuZGlkYXRlID0gY3VycmVudCA/IGAke2N1cnJlbnR9LCAke2l0ZW19YCA6IGl0ZW07XG4gICAgaWYgKGAgICAgJHtjYW5kaWRhdGV9LGAubGVuZ3RoIDw9IE1BWF9MSU5FKSB7XG4gICAgICBjdXJyZW50ID0gY2FuZGlkYXRlO1xuICAgIH0gZWxzZSB7XG4gICAgICBsaW5lcy5wdXNoKGAgICAgJHtjdXJyZW50fSxgKTtcbiAgICAgIGN1cnJlbnQgPSBpdGVtO1xuICAgIH1cbiAgfVxuICBpZiAoY3VycmVudCkgbGluZXMucHVzaChgICAgICR7Y3VycmVudH0sYCk7XG4gIGxpbmVzLnB1c2goXCJ9O1wiKTtcbiAgcmV0dXJuIGxpbmVzO1xufVxuXG4vKipcbiAqIEZvbGQgZHVwbGljYXRlZCB0b3AtbGV2ZWwgUnVzdCBgdXNlYCBkZWNsYXJhdGlvbnMgYmFjayBpbnRvIG9uZS5cbiAqXG4gKiBPbmx5IGRlY2xhcmF0aW9ucyB3aG9zZSBpdGVtIHNldHMgb3ZlcmxhcCBhcmUgZm9sZGVkOyBldmVyeXRoaW5nIGVsc2Ug4oCUXG4gKiBpbmNsdWRpbmcgYW55dGhpbmcgdGhpcyBjYW5ub3QgcGFyc2Ugd2l0aCBjb25maWRlbmNlIOKAlCBpcyBsZWZ0IGV4YWN0bHkgYXNcbiAqIGl0IHdhcy4gV2hlbiBub3RoaW5nIGlzIGZvbGRlZCB0aGUgaW5wdXQgaXMgcmV0dXJuZWQgYnl0ZS1mb3ItYnl0ZSwgc28gdGhpc1xuICogaXMgc2FmZSB0byBjYWxsIG9uIGV2ZXJ5IGAucnNgIHVuaW9uIHVuY29uZGl0aW9uYWxseS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1lcmdlRHVwbGljYXRlUnVzdFVzZXModGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgY3JsZiA9IHRleHQuaW5jbHVkZXMoXCJcXHJcXG5cIik7XG4gIGNvbnN0IG5vcm1hbGlzZWQgPSBjcmxmID8gdGV4dC5yZXBsYWNlKC9cXHJcXG4vZywgXCJcXG5cIikgOiB0ZXh0O1xuICBjb25zdCB0cmFpbGluZ05ld2xpbmUgPSBub3JtYWxpc2VkLmVuZHNXaXRoKFwiXFxuXCIpO1xuICBjb25zdCBib2R5ID0gdHJhaWxpbmdOZXdsaW5lID8gbm9ybWFsaXNlZC5zbGljZSgwLCAtMSkgOiBub3JtYWxpc2VkO1xuICBjb25zdCBsaW5lcyA9IGJvZHkuc3BsaXQoXCJcXG5cIik7XG5cbiAgY29uc3QgY2FuZGlkYXRlcyA9IGZpbmRDYW5kaWRhdGVzKGxpbmVzKTtcbiAgY29uc3QgZ3JvdXBzID0gYnVpbGRHcm91cHMoY2FuZGlkYXRlcyk7XG4gIGNvbnN0IGdyb3VwQnlNZW1iZXIgPSBuZXcgTWFwPG51bWJlciwgR3JvdXA+KCk7XG4gIGZvciAoY29uc3QgZ3JvdXAgb2YgZ3JvdXBzKSB7XG4gICAgZm9yIChjb25zdCBtZW1iZXJJbmRleCBvZiBncm91cC5tZW1iZXJJbmRpY2VzKSB7XG4gICAgICBncm91cEJ5TWVtYmVyLnNldChtZW1iZXJJbmRleCwgZ3JvdXApO1xuICAgIH1cbiAgfVxuICBjb25zdCBjYW5kaWRhdGVBdFN0YXJ0ID0gbmV3IE1hcDxudW1iZXIsIG51bWJlcj4oKTtcbiAgY2FuZGlkYXRlcy5mb3JFYWNoKChjYW5kaWRhdGUsIGluZGV4KSA9PlxuICAgIGNhbmRpZGF0ZUF0U3RhcnQuc2V0KGNhbmRpZGF0ZS5zdGFydCwgaW5kZXgpXG4gICk7XG5cbiAgbGV0IGZvbGRlZCA9IGZhbHNlO1xuICBjb25zdCBvdXRMaW5lczogc3RyaW5nW10gPSBbXTtcbiAgbGV0IGkgPSAwO1xuICB3aGlsZSAoaSA8IGxpbmVzLmxlbmd0aCkge1xuICAgIGNvbnN0IGNhbmRpZGF0ZUluZGV4ID0gY2FuZGlkYXRlQXRTdGFydC5nZXQoaSk7XG4gICAgaWYgKGNhbmRpZGF0ZUluZGV4ID09PSB1bmRlZmluZWQpIHtcbiAgICAgIG91dExpbmVzLnB1c2gobGluZXNbaV0hKTtcbiAgICAgIGkrKztcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBjYW5kaWRhdGUgPSBjYW5kaWRhdGVzW2NhbmRpZGF0ZUluZGV4XSE7XG4gICAgY29uc3QgZ3JvdXAgPSBncm91cEJ5TWVtYmVyLmdldChjYW5kaWRhdGVJbmRleCkhO1xuICAgIGNvbnN0IGlzRm9sZGVkR3JvdXAgPSBncm91cC5tZW1iZXJJbmRpY2VzLmxlbmd0aCA+IDE7XG4gICAgaWYgKCFpc0ZvbGRlZEdyb3VwKSB7XG4gICAgICBmb3IgKGxldCBrID0gY2FuZGlkYXRlLnN0YXJ0OyBrIDw9IGNhbmRpZGF0ZS5lbmQ7IGsrKykge1xuICAgICAgICBvdXRMaW5lcy5wdXNoKGxpbmVzW2tdISk7XG4gICAgICB9XG4gICAgICBpID0gY2FuZGlkYXRlLmVuZCArIDE7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBmb2xkZWQgPSB0cnVlO1xuICAgIGNvbnN0IGlzQW5jaG9yID0gZ3JvdXAubWVtYmVySW5kaWNlc1swXSA9PT0gY2FuZGlkYXRlSW5kZXg7XG4gICAgaWYgKGlzQW5jaG9yKSB7XG4gICAgICBjb25zdCBhbGxTb3J0ZWQgPSBncm91cC5tZW1iZXJJbmRpY2VzLmV2ZXJ5KChpbmRleCkgPT5cbiAgICAgICAgaXNTb3J0ZWRSdXN0Zm10KGNhbmRpZGF0ZXNbaW5kZXhdIS5pdGVtcylcbiAgICAgICk7XG4gICAgICBjb25zdCBmaW5hbEl0ZW1zID0gYWxsU29ydGVkID8gc29ydFJ1c3RmbXQoZ3JvdXAuaXRlbXMpIDogZ3JvdXAuaXRlbXM7XG4gICAgICBvdXRMaW5lcy5wdXNoKFxuICAgICAgICAuLi5yZW5kZXJHcm91cChjYW5kaWRhdGUudmlzLCBjYW5kaWRhdGUucHJlZml4LCBmaW5hbEl0ZW1zKSxcbiAgICAgICk7XG4gICAgfVxuICAgIC8vIEEgbm9uLWFuY2hvciBtZW1iZXIncyBsaW5lcyBhcmUgZHJvcHBlZCBlbnRpcmVseSDigJQgZm9sZGVkIGludG8gdGhlIGFuY2hvci5cbiAgICBpID0gY2FuZGlkYXRlLmVuZCArIDE7XG4gIH1cblxuICBpZiAoIWZvbGRlZCkgcmV0dXJuIHRleHQ7XG5cbiAgbGV0IHJlc3VsdCA9IG91dExpbmVzLmpvaW4oXCJcXG5cIik7XG4gIGlmICh0cmFpbGluZ05ld2xpbmUpIHJlc3VsdCArPSBcIlxcblwiO1xuICBpZiAoY3JsZikgcmVzdWx0ID0gcmVzdWx0LnJlcGxhY2UoL1xcbi9nLCBcIlxcclxcblwiKTtcbiAgcmV0dXJuIHJlc3VsdDtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBcUJDLEdBRUQseUVBQXlFLEdBQ3pFLE1BQU0sWUFBWTtBQTZCbEIsOEVBQThFLEdBQzlFLFNBQVMsZ0JBQWdCLEtBQWU7RUFDdEMsTUFBTSxPQUFPLEtBQUssQ0FBQyxFQUFFLEtBQUssU0FBUyxNQUFNLEtBQUssQ0FBQyxLQUFLO0VBQ3BELElBQUssSUFBSSxJQUFJLEdBQUcsSUFBSSxLQUFLLE1BQU0sRUFBRSxJQUFLO0lBQ3BDLElBQUksSUFBSSxDQUFDLElBQUksRUFBRSxHQUFJLElBQUksQ0FBQyxFQUFFLEVBQUcsT0FBTztFQUN0QztFQUNBLE9BQU87QUFDVDtBQUVBLCtFQUErRSxHQUMvRSxTQUFTLFlBQVksS0FBZTtFQUNsQyxNQUFNLFVBQVUsTUFBTSxRQUFRLENBQUM7RUFDL0IsTUFBTSxPQUFPLE1BQU0sTUFBTSxDQUFDLENBQUMsT0FBUyxTQUFTLFFBQVEsSUFBSTtFQUN6RCxPQUFPLFVBQVU7SUFBQztPQUFXO0dBQUssR0FBRztBQUN2QztBQUVBLDZFQUE2RSxHQUM3RSxTQUFTLG1CQUFtQixDQUFXLEVBQUUsQ0FBVztFQUNsRCxNQUFNLFNBQVM7T0FBSTtHQUFFO0VBQ3JCLEtBQUssTUFBTSxRQUFRLEVBQUc7SUFDcEIsSUFBSSxDQUFDLE9BQU8sUUFBUSxDQUFDLE9BQU8sT0FBTyxJQUFJLENBQUM7RUFDMUM7RUFDQSxPQUFPO0FBQ1Q7QUFFQSw0RUFBNEUsR0FDNUUsU0FBUyxhQUFhLENBQVcsRUFBRSxDQUFXO0VBQzVDLE9BQU8sRUFBRSxJQUFJLENBQUMsQ0FBQyxPQUFTLEVBQUUsUUFBUSxDQUFDO0FBQ3JDO0FBRUE7Ozs7O0NBS0MsR0FDRCxTQUFTLG9CQUFvQixJQUFZO0VBQ3ZDLE1BQU0sUUFBUSxLQUFLLEtBQUssQ0FBQztFQUN6QixJQUFJLENBQUMsT0FBTyxPQUFPO0VBQ25CLE1BQU0sTUFBTSxLQUFLLENBQUMsRUFBRSxJQUFJO0VBQ3hCLE1BQU0sT0FBTyxLQUFLLENBQUMsRUFBRSxDQUFFLElBQUk7RUFDM0IsSUFBSSxLQUFLLFFBQVEsQ0FBQyxNQUFNLE9BQU87RUFFL0IsTUFBTSxhQUFhLEtBQUssT0FBTyxDQUFDO0VBQ2hDLElBQUksZUFBZSxDQUFDLEdBQUc7SUFDckIsTUFBTSxhQUFhLEtBQUssV0FBVyxDQUFDO0lBQ3BDLElBQUksZUFBZSxDQUFDLEtBQUssYUFBYSxZQUFZLE9BQU87SUFDekQsTUFBTSxRQUFRLEtBQUssS0FBSyxDQUFDLGFBQWEsR0FBRztJQUN6QyxJQUFJLE1BQU0sUUFBUSxDQUFDLFFBQVEsTUFBTSxRQUFRLENBQUMsTUFBTSxPQUFPLE1BQU0sU0FBUztJQUN0RSxJQUFJLEtBQUssS0FBSyxDQUFDLGFBQWEsR0FBRyxJQUFJLEdBQUcsTUFBTSxHQUFHLEdBQUcsT0FBTyxNQUFNLGdCQUFnQjtJQUMvRSxNQUFNLFNBQVMsS0FBSyxLQUFLLENBQUMsR0FBRyxZQUFZLE9BQU8sQ0FBQyxVQUFVLElBQUksSUFBSTtJQUNuRSxJQUFJLFdBQVcsTUFBTSxDQUFDLE9BQU8sTUFBTSxFQUFFLE9BQU87SUFDNUMsTUFBTSxRQUFRLE1BQ1gsS0FBSyxDQUFDLEtBQ04sR0FBRyxDQUFDLENBQUMsT0FBUyxLQUFLLElBQUksSUFDdkIsTUFBTSxDQUFDLENBQUMsT0FBUyxLQUFLLE1BQU0sR0FBRztJQUNsQyxJQUFJLE1BQU0sTUFBTSxLQUFLLEdBQUcsT0FBTztJQUMvQixPQUFPO01BQUU7TUFBSztNQUFRO0lBQU07RUFDOUI7RUFFQSxNQUFNLFdBQVcsS0FBSyxXQUFXLENBQUM7RUFDbEMsSUFBSSxhQUFhLENBQUMsR0FBRyxPQUFPO0VBQzVCLE1BQU0sU0FBUyxLQUFLLEtBQUssQ0FBQyxHQUFHLFVBQVUsSUFBSTtFQUMzQyxNQUFNLE9BQU8sS0FBSyxLQUFLLENBQUMsV0FBVyxHQUFHLElBQUk7RUFDMUMsSUFBSSxXQUFXLE1BQU0sU0FBUyxJQUFJLE9BQU87RUFDekMsT0FBTztJQUFFO0lBQUs7SUFBUSxPQUFPO01BQUM7S0FBSztFQUFDO0FBQ3RDO0FBRUE7OztDQUdDLEdBQ0QsU0FBUyxpQkFBaUIsSUFBWTtFQUNwQyxNQUFNLFFBQVEsS0FBSyxPQUFPLENBQUM7RUFDM0IsT0FBTyxVQUFVLENBQUMsSUFBSSxPQUFPLEtBQUssS0FBSyxDQUFDLEdBQUc7QUFDN0M7QUFFQSx1RUFBdUUsR0FDdkUsU0FBUyxpQkFBaUIsS0FBZSxFQUFFLEtBQWE7RUFDdEQsSUFBSyxJQUFJLElBQUksUUFBUSxHQUFHLEtBQUssR0FBRyxJQUFLO0lBQ25DLE1BQU0sVUFBVSxLQUFLLENBQUMsRUFBRSxDQUFFLElBQUk7SUFDOUIsSUFBSSxZQUFZLElBQUk7SUFDcEIsT0FBTyxRQUFRLFVBQVUsQ0FBQztFQUM1QjtFQUNBLE9BQU87QUFDVDtBQUVBOzs7Ozs7Ozs7O0NBVUMsR0FDRCxTQUFTLGtCQUFrQixLQUFlO0VBQ3hDLE1BQU0sV0FBc0IsRUFBRTtFQUM5QixJQUFJLFFBQVE7RUFDWixJQUFJLG9CQUFvQjtFQUN4QixJQUFJLGtCQUFrQixDQUFDLEdBQUcsK0JBQStCO0VBQ3pELElBQUksV0FBVyxPQUFPLHlDQUF5QztFQUUvRCxLQUFLLE1BQU0sUUFBUSxNQUFPO0lBQ3hCLFNBQVMsSUFBSSxDQUNYLFVBQVUsS0FBSyxzQkFBc0IsS0FBSyxvQkFBb0IsQ0FBQyxLQUM3RCxDQUFDO0lBRUwsSUFBSSxJQUFJO0lBQ1IsTUFBTyxJQUFJLEtBQUssTUFBTSxDQUFFO01BQ3RCLE1BQU0sS0FBSyxJQUFJLENBQUMsRUFBRTtNQUNsQixJQUFJLG9CQUFvQixHQUFHO1FBQ3pCLElBQUksT0FBTyxPQUFPLElBQUksQ0FBQyxJQUFJLEVBQUUsS0FBSyxLQUFLO1VBQ3JDO1VBQ0EsS0FBSztRQUNQLE9BQU8sSUFBSSxPQUFPLE9BQU8sSUFBSSxDQUFDLElBQUksRUFBRSxLQUFLLEtBQUs7VUFDNUM7VUFDQSxLQUFLO1FBQ1AsT0FBTztVQUNMO1FBQ0Y7UUFDQTtNQUNGO01BQ0EsSUFBSSxvQkFBb0IsQ0FBQyxHQUFHO1FBQzFCLE1BQU0sU0FBUyxJQUFJLE1BQU0sQ0FBQztRQUMxQixJQUNFLE9BQU8sT0FBTyxLQUFLLEtBQUssQ0FBQyxJQUFJLEdBQUcsSUFBSSxJQUFJLHFCQUFxQixRQUM3RDtVQUNBLEtBQUssSUFBSTtVQUNULGtCQUFrQixDQUFDO1FBQ3JCLE9BQU87VUFDTDtRQUNGO1FBQ0E7TUFDRjtNQUNBLElBQUksVUFBVTtRQUNaLElBQUksT0FBTyxNQUFNO1VBQ2YsS0FBSztRQUNQLE9BQU87VUFDTCxJQUFJLE9BQU8sS0FBSyxXQUFXO1VBQzNCO1FBQ0Y7UUFDQTtNQUNGO01BQ0EsSUFBSSxPQUFPLE9BQU8sSUFBSSxDQUFDLElBQUksRUFBRSxLQUFLLEtBQUssT0FBTyxpQ0FBaUM7TUFDL0UsSUFBSSxPQUFPLE9BQU8sSUFBSSxDQUFDLElBQUksRUFBRSxLQUFLLEtBQUs7UUFDckMsb0JBQW9CO1FBQ3BCLEtBQUs7UUFDTDtNQUNGO01BQ0EsTUFBTSxXQUFXLGdCQUFnQixJQUFJLENBQUMsS0FBSyxLQUFLLENBQUM7TUFDakQsSUFBSSxVQUFVO1FBQ1osa0JBQWtCLFFBQVEsQ0FBQyxFQUFFLENBQUUsTUFBTTtRQUNyQyxLQUFLLFFBQVEsQ0FBQyxFQUFFLENBQUMsTUFBTTtRQUN2QjtNQUNGO01BQ0EsSUFBSSxPQUFPLEtBQUs7UUFDZCxXQUFXO1FBQ1g7UUFDQTtNQUNGO01BQ0EsSUFBSSxPQUFPLEtBQUs7UUFDZCxNQUFNLE9BQU8sSUFBSSxDQUFDLElBQUksRUFBRTtRQUN4QixJQUFJLFNBQVMsYUFBYSxZQUFZLElBQUksQ0FBQyxPQUFPO1VBQ2hELG1FQUFtRTtVQUNuRSxtRUFBbUU7VUFDbkUsa0VBQWtFO1VBQ2xFLEtBQUs7UUFDUCxPQUFPO1VBQ0wsb0VBQW9FO1VBQ3BFLCtEQUErRDtVQUMvRDtVQUNBLE1BQU8sSUFBSSxLQUFLLE1BQU0sQ0FBRTtZQUN0QixJQUFJLElBQUksQ0FBQyxFQUFFLEtBQUssTUFBTTtjQUNwQixLQUFLO2NBQ0w7WUFDRjtZQUNBLElBQUksSUFBSSxDQUFDLEVBQUUsS0FBSyxLQUFLO2NBQ25CO2NBQ0E7WUFDRjtZQUNBO1VBQ0Y7UUFDRjtRQUNBO01BQ0Y7TUFDQSxJQUFJLE9BQU8sS0FBSztXQUNYLElBQUksT0FBTyxLQUFLLFFBQVEsS0FBSyxHQUFHLENBQUMsR0FBRyxRQUFRO01BQ2pEO0lBQ0Y7RUFDRjtFQUNBLE9BQU87QUFDVDtBQUVBLDBFQUEwRSxHQUMxRSxTQUFTLGVBQWUsS0FBZTtFQUNyQyxNQUFNLGFBQTBCLEVBQUU7RUFDbEMsTUFBTSxXQUFXLGtCQUFrQjtFQUNuQyxJQUFJLElBQUk7RUFDUixNQUFPLElBQUksTUFBTSxNQUFNLENBQUU7SUFDdkIsTUFBTSxPQUFPLEtBQUssQ0FBQyxFQUFFO0lBQ3JCLElBQUksQ0FBQyxRQUFRLENBQUMsRUFBRSxJQUFJLENBQUMsVUFBVSxJQUFJLENBQUMsT0FBTztNQUN6QztNQUNBO0lBQ0Y7SUFDQSwyQ0FBMkM7SUFDM0MsSUFBSSxNQUFNLENBQUM7SUFDWCxJQUFJLFNBQVM7SUFDYixJQUFLLElBQUksSUFBSSxHQUFHLElBQUksTUFBTSxNQUFNLEVBQUUsSUFBSztNQUNyQyxNQUFNLFdBQVcsaUJBQWlCLEtBQUssQ0FBQyxFQUFFLEVBQUcsSUFBSTtNQUNqRCxVQUFVLENBQUMsSUFBSSxJQUFJLE1BQU0sRUFBRSxJQUFJO01BQy9CLElBQUksU0FBUyxRQUFRLENBQUMsTUFBTTtRQUMxQixNQUFNO1FBQ047TUFDRjtJQUNGO0lBQ0EsSUFBSSxRQUFRLENBQUMsR0FBRztNQUNkLDREQUE0RDtNQUM1RDtNQUNBO0lBQ0Y7SUFDQSxNQUFNLFFBQVEsaUJBQWlCLE9BQU87SUFDdEMsTUFBTSxTQUFTLFFBQVEsT0FBTyxvQkFBb0I7SUFDbEQsSUFBSSxRQUFRO01BQ1YsV0FBVyxJQUFJLENBQUM7UUFBRSxPQUFPO1FBQUc7UUFBSyxHQUFHLE1BQU07TUFBQztJQUM3QztJQUNBLElBQUksTUFBTTtFQUNaO0VBQ0EsT0FBTztBQUNUO0FBRUEsdUVBQXVFLEdBQ3ZFLFNBQVMsWUFBWSxVQUF1QjtFQUMxQyxNQUFNLFNBQWtCLEVBQUU7RUFDMUIsV0FBVyxPQUFPLENBQUMsQ0FBQyxXQUFXO0lBQzdCLE1BQU0sTUFBTSxHQUFHLFVBQVUsR0FBRyxDQUFDLE1BQU0sRUFBRSxVQUFVLE1BQU0sRUFBRTtJQUN2RCxNQUFNLFdBQVcsT0FBTyxJQUFJLENBQzFCLENBQUMsUUFDQyxNQUFNLEdBQUcsS0FBSyxPQUFPLGFBQWEsTUFBTSxLQUFLLEVBQUUsVUFBVSxLQUFLO0lBRWxFLElBQUksVUFBVTtNQUNaLFNBQVMsS0FBSyxHQUFHLG1CQUFtQixTQUFTLEtBQUssRUFBRSxVQUFVLEtBQUs7TUFDbkUsU0FBUyxhQUFhLENBQUMsSUFBSSxDQUFDO0lBQzlCLE9BQU87TUFDTCxPQUFPLElBQUksQ0FBQztRQUFFO1FBQUssT0FBTzthQUFJLFVBQVUsS0FBSztTQUFDO1FBQUUsZUFBZTtVQUFDO1NBQU07TUFBQztJQUN6RTtFQUNGO0VBQ0EsT0FBTztBQUNUO0FBRUEsMEVBQTBFLEdBQzFFLFNBQVMsWUFBWSxHQUFXLEVBQUUsTUFBYyxFQUFFLEtBQWU7RUFDL0QsTUFBTSxXQUFXO0VBQ2pCLElBQUksTUFBTSxNQUFNLEtBQUssR0FBRztJQUN0QixNQUFNLFVBQVUsR0FBRyxJQUFJLElBQUksRUFBRSxPQUFPLEVBQUUsRUFBRSxLQUFLLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQztJQUNuRCxJQUFJLFFBQVEsTUFBTSxJQUFJLFVBQVUsT0FBTztNQUFDO0tBQVE7RUFDbEQsT0FBTztJQUNMLE1BQU0sVUFBVSxHQUFHLElBQUksSUFBSSxFQUFFLE9BQU8sR0FBRyxFQUFFLE1BQU0sSUFBSSxDQUFDLE1BQU0sRUFBRSxDQUFDO0lBQzdELElBQUksUUFBUSxNQUFNLElBQUksVUFBVSxPQUFPO01BQUM7S0FBUTtFQUNsRDtFQUVBLE1BQU0sUUFBUTtJQUFDLEdBQUcsSUFBSSxJQUFJLEVBQUUsT0FBTyxHQUFHLENBQUM7R0FBQztFQUN4QyxJQUFJLFVBQVU7RUFDZCxLQUFLLE1BQU0sUUFBUSxNQUFPO0lBQ3hCLE1BQU0sWUFBWSxVQUFVLEdBQUcsUUFBUSxFQUFFLEVBQUUsTUFBTSxHQUFHO0lBQ3BELElBQUksQ0FBQyxJQUFJLEVBQUUsVUFBVSxDQUFDLENBQUMsQ0FBQyxNQUFNLElBQUksVUFBVTtNQUMxQyxVQUFVO0lBQ1osT0FBTztNQUNMLE1BQU0sSUFBSSxDQUFDLENBQUMsSUFBSSxFQUFFLFFBQVEsQ0FBQyxDQUFDO01BQzVCLFVBQVU7SUFDWjtFQUNGO0VBQ0EsSUFBSSxTQUFTLE1BQU0sSUFBSSxDQUFDLENBQUMsSUFBSSxFQUFFLFFBQVEsQ0FBQyxDQUFDO0VBQ3pDLE1BQU0sSUFBSSxDQUFDO0VBQ1gsT0FBTztBQUNUO0FBRUE7Ozs7Ozs7Q0FPQyxHQUNELE9BQU8sU0FBUyx1QkFBdUIsSUFBWTtFQUNqRCxNQUFNLE9BQU8sS0FBSyxRQUFRLENBQUM7RUFDM0IsTUFBTSxhQUFhLE9BQU8sS0FBSyxPQUFPLENBQUMsU0FBUyxRQUFRO0VBQ3hELE1BQU0sa0JBQWtCLFdBQVcsUUFBUSxDQUFDO0VBQzVDLE1BQU0sT0FBTyxrQkFBa0IsV0FBVyxLQUFLLENBQUMsR0FBRyxDQUFDLEtBQUs7RUFDekQsTUFBTSxRQUFRLEtBQUssS0FBSyxDQUFDO0VBRXpCLE1BQU0sYUFBYSxlQUFlO0VBQ2xDLE1BQU0sU0FBUyxZQUFZO0VBQzNCLE1BQU0sZ0JBQWdCLElBQUk7RUFDMUIsS0FBSyxNQUFNLFNBQVMsT0FBUTtJQUMxQixLQUFLLE1BQU0sZUFBZSxNQUFNLGFBQWEsQ0FBRTtNQUM3QyxjQUFjLEdBQUcsQ0FBQyxhQUFhO0lBQ2pDO0VBQ0Y7RUFDQSxNQUFNLG1CQUFtQixJQUFJO0VBQzdCLFdBQVcsT0FBTyxDQUFDLENBQUMsV0FBVyxRQUM3QixpQkFBaUIsR0FBRyxDQUFDLFVBQVUsS0FBSyxFQUFFO0VBR3hDLElBQUksU0FBUztFQUNiLE1BQU0sV0FBcUIsRUFBRTtFQUM3QixJQUFJLElBQUk7RUFDUixNQUFPLElBQUksTUFBTSxNQUFNLENBQUU7SUFDdkIsTUFBTSxpQkFBaUIsaUJBQWlCLEdBQUcsQ0FBQztJQUM1QyxJQUFJLG1CQUFtQixXQUFXO01BQ2hDLFNBQVMsSUFBSSxDQUFDLEtBQUssQ0FBQyxFQUFFO01BQ3RCO01BQ0E7SUFDRjtJQUNBLE1BQU0sWUFBWSxVQUFVLENBQUMsZUFBZTtJQUM1QyxNQUFNLFFBQVEsY0FBYyxHQUFHLENBQUM7SUFDaEMsTUFBTSxnQkFBZ0IsTUFBTSxhQUFhLENBQUMsTUFBTSxHQUFHO0lBQ25ELElBQUksQ0FBQyxlQUFlO01BQ2xCLElBQUssSUFBSSxJQUFJLFVBQVUsS0FBSyxFQUFFLEtBQUssVUFBVSxHQUFHLEVBQUUsSUFBSztRQUNyRCxTQUFTLElBQUksQ0FBQyxLQUFLLENBQUMsRUFBRTtNQUN4QjtNQUNBLElBQUksVUFBVSxHQUFHLEdBQUc7TUFDcEI7SUFDRjtJQUVBLFNBQVM7SUFDVCxNQUFNLFdBQVcsTUFBTSxhQUFhLENBQUMsRUFBRSxLQUFLO0lBQzVDLElBQUksVUFBVTtNQUNaLE1BQU0sWUFBWSxNQUFNLGFBQWEsQ0FBQyxLQUFLLENBQUMsQ0FBQyxRQUMzQyxnQkFBZ0IsVUFBVSxDQUFDLE1BQU0sQ0FBRSxLQUFLO01BRTFDLE1BQU0sYUFBYSxZQUFZLFlBQVksTUFBTSxLQUFLLElBQUksTUFBTSxLQUFLO01BQ3JFLFNBQVMsSUFBSSxJQUNSLFlBQVksVUFBVSxHQUFHLEVBQUUsVUFBVSxNQUFNLEVBQUU7SUFFcEQ7SUFDQSw2RUFBNkU7SUFDN0UsSUFBSSxVQUFVLEdBQUcsR0FBRztFQUN0QjtFQUVBLElBQUksQ0FBQyxRQUFRLE9BQU87RUFFcEIsSUFBSSxTQUFTLFNBQVMsSUFBSSxDQUFDO0VBQzNCLElBQUksaUJBQWlCLFVBQVU7RUFDL0IsSUFBSSxNQUFNLFNBQVMsT0FBTyxPQUFPLENBQUMsT0FBTztFQUN6QyxPQUFPO0FBQ1QifQ==
// denoCacheMetadata=15235562793087237210,17444251893494672520