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
 * import, an attribute-gated import, an import with no path — is left
 * untouched, because a wrong fold here would silently drop an import rather
 * than merely fail to clean one up.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** Matches a top-level `use` declaration's opening line, column 0 only. */
const USE_START = /^(pub(?:\([^)]*\))?\s+)?use\s/;

/** One parsed top-level `use` declaration. */
interface ParsedUse {
  /** The visibility prefix as written, including its trailing space. */
  vis: string;
  /** The path shared by every item, e.g. `grq_policy`. */
  prefix: string;
  /** The imported items, in the order they were written. */
  items: string[];
}

/** One `use` declaration found while scanning the file, line-indexed. */
interface Candidate extends ParsedUse {
  /** First line of this declaration (0-based, in the normalised text). */
  start: number;
  /** Last line of this declaration (0-based, inclusive). */
  end: number;
}

/** A set of candidates with the same key, folded together when they overlap. */
interface Group {
  key: string;
  /** Indices into the candidate list; the first is the group's anchor. */
  memberIndices: number[];
  /** The running union of every member's items, in first-occurrence order. */
  items: string[];
}

/** Whether `items` is already in rustfmt's order: `self` first, then sorted. */
function isSortedRustfmt(items: string[]): boolean {
  const rest = items[0] === "self" ? items.slice(1) : items;
  for (let i = 1; i < rest.length; i++) {
    if (rest[i - 1]! > rest[i]!) return false;
  }
  return true;
}

/** Sort `items` the way rustfmt would: `self` first, then plain string order. */
function sortRustfmt(items: string[]): string[] {
  const hasSelf = items.includes("self");
  const rest = items.filter((item) => item !== "self").sort();
  return hasSelf ? ["self", ...rest] : rest;
}

/** The union of `a` and `b`, in first-occurrence order, with no duplicates. */
function unionPreserveOrder(a: string[], b: string[]): string[] {
  const result = [...a];
  for (const item of b) {
    if (!result.includes(item)) result.push(item);
  }
  return result;
}

/** Whether two item sets share at least one item (covers "identical" too). */
function itemsOverlap(a: string[], b: string[]): boolean {
  return a.some((item) => b.includes(item));
}

/**
 * Parse one `use` declaration's text (its lines joined by a single space).
 *
 * Returns null for anything that is not confidently a simple, flat `use`:
 * a glob, a nested brace group, or a path with no `::` at all.
 */
function parseUseDeclaration(text: string): ParsedUse | null {
  const match = text.match(/^(pub(?:\([^)]*\))?\s+)?use\s+(.*);\s*$/s);
  if (!match) return null;
  const vis = match[1] ?? "";
  const body = match[2]!.trim();
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
    const items = inner
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (items.length === 0) return null;
    return { vis, prefix, items };
  }

  const sepIndex = body.lastIndexOf("::");
  if (sepIndex === -1) return null;
  const prefix = body.slice(0, sepIndex).trim();
  const item = body.slice(sepIndex + 2).trim();
  if (prefix === "" || item === "") return null;
  return { vis, prefix, items: [item] };
}

/** Whether the nearest non-blank line before `start` is an attribute. */
function gatedByAttribute(lines: string[], start: number): boolean {
  for (let i = start - 1; i >= 0; i--) {
    const trimmed = lines[i]!.trim();
    if (trimmed === "") continue;
    return trimmed.startsWith("#[");
  }
  return false;
}

/** Scan `lines` for top-level `use` declarations, parsed where possible. */
function findCandidates(lines: string[]): Candidate[] {
  const candidates: Candidate[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!USE_START.test(line)) {
      i++;
      continue;
    }
    // Collect lines up to the terminating `;`.
    let end = -1;
    let joined = "";
    for (let j = i; j < lines.length; j++) {
      joined += (j > i ? " " : "") + lines[j]!.trim();
      if (lines[j]!.includes(";")) {
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
      candidates.push({ start: i, end, ...parsed });
    }
    i = end + 1;
  }
  return candidates;
}

/** Group candidates by `vis + prefix`, folding overlapping item sets. */
function buildGroups(candidates: Candidate[]): Group[] {
  const groups: Group[] = [];
  candidates.forEach((candidate, index) => {
    const key = `${candidate.vis}\u0000${candidate.prefix}`;
    const existing = groups.find(
      (group) =>
        group.key === key && itemsOverlap(group.items, candidate.items),
    );
    if (existing) {
      existing.items = unionPreserveOrder(existing.items, candidate.items);
      existing.memberIndices.push(index);
    } else {
      groups.push({ key, items: [...candidate.items], memberIndices: [index] });
    }
  });
  return groups;
}

/** Render one folded group's `use` declaration, as one or several lines. */
function renderGroup(vis: string, prefix: string, items: string[]): string[] {
  const MAX_LINE = 100;
  if (items.length === 1) {
    const oneLine = `${vis}use ${prefix}::${items[0]};`;
    if (oneLine.length <= MAX_LINE) return [oneLine];
  } else {
    const oneLine = `${vis}use ${prefix}::{${items.join(", ")}};`;
    if (oneLine.length <= MAX_LINE) return [oneLine];
  }

  const lines = [`${vis}use ${prefix}::{`];
  let current = "";
  for (const item of items) {
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
 */
export function mergeDuplicateRustUses(text: string): string {
  const crlf = text.includes("\r\n");
  const normalised = crlf ? text.replace(/\r\n/g, "\n") : text;
  const trailingNewline = normalised.endsWith("\n");
  const body = trailingNewline ? normalised.slice(0, -1) : normalised;
  const lines = body.split("\n");

  const candidates = findCandidates(lines);
  const groups = buildGroups(candidates);
  const groupByMember = new Map<number, Group>();
  for (const group of groups) {
    for (const memberIndex of group.memberIndices) {
      groupByMember.set(memberIndex, group);
    }
  }
  const candidateAtStart = new Map<number, number>();
  candidates.forEach((candidate, index) =>
    candidateAtStart.set(candidate.start, index)
  );

  let folded = false;
  const outLines: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const candidateIndex = candidateAtStart.get(i);
    if (candidateIndex === undefined) {
      outLines.push(lines[i]!);
      i++;
      continue;
    }
    const candidate = candidates[candidateIndex]!;
    const group = groupByMember.get(candidateIndex)!;
    const isFoldedGroup = group.memberIndices.length > 1;
    if (!isFoldedGroup) {
      for (let k = candidate.start; k <= candidate.end; k++) {
        outLines.push(lines[k]!);
      }
      i = candidate.end + 1;
      continue;
    }

    folded = true;
    const isAnchor = group.memberIndices[0] === candidateIndex;
    if (isAnchor) {
      const allSorted = group.memberIndices.every((index) =>
        isSortedRustfmt(candidates[index]!.items)
      );
      const finalItems = allSorted ? sortRustfmt(group.items) : group.items;
      outLines.push(
        ...renderGroup(candidate.vis, candidate.prefix, finalItems),
      );
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
