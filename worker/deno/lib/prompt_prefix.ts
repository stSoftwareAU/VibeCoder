/**
 * Stable prompt-prefix ordering and volatility detection (Issue #4282).
 *
 * Anthropic prompt caching reuses the **longest byte-identical prefix** of a
 * request. Everything from the first differing byte onwards is re-read at full
 * input price, so a single volatile token near the top — a timestamp, a run id,
 * an issue number — throws away the cache for the whole prompt behind it.
 *
 * This module owns two things:
 *
 * 1. **A canonical order** for the stable sections a prompt leads with, so the
 *    same repository produces the same leading bytes on every run regardless of
 *    the order a caller happened to assemble them in.
 * 2. **A volatility scan** that names the tokens which would break that
 *    stability, so a newly introduced timestamp is a visible warning rather
 *    than a silent doubling of token spend.
 *
 * The scan is deliberately conservative: it matches shapes that are volatile by
 * construction (ISO timestamps, UUIDs, epoch milliseconds, boundary nonces)
 * rather than guessing at prose.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/**
 * Sections that make up the stable, cacheable prefix, in canonical order.
 *
 * - `coding_guidelines` — the versioned shared standards (system prompt).
 * - `repo_context` — `CLAUDE.md`/`AGENTS.md`, fenced as untrusted (#3706).
 * - `codebase_map` — the generated repository map (#4281); slots in here once
 *   that work lands, ahead of the repo-specific instructions.
 * - `custom_instructions` — per-repo instructions from `.config.json`.
 */
export const STABLE_PREFIX_ORDER = [
  "coding_guidelines",
  "repo_context",
  "codebase_map",
  "custom_instructions",
] as const;

/** One section of the stable prefix. */
export type StablePrefixSection = typeof STABLE_PREFIX_ORDER[number];

/** Separator between stable prefix sections. */
const SECTION_SEPARATOR = "\n\n";

/**
 * Join the supplied stable sections in {@link STABLE_PREFIX_ORDER}.
 *
 * Absent, empty, and whitespace-only sections are dropped, and each retained
 * section is trimmed, so the output depends only on the section *content* —
 * never on the caller's key order or incidental surrounding whitespace. Two
 * callers passing the same content therefore produce byte-identical prefixes,
 * which is the whole point.
 *
 * @param sections - Section text keyed by section name
 * @returns The ordered prefix, or "" when no section had content
 */
export function orderStablePrefix(
  sections: Partial<Record<StablePrefixSection, string | undefined>>,
): string {
  const parts: string[] = [];
  for (const name of STABLE_PREFIX_ORDER) {
    const value = sections[name];
    if (value && value.trim()) parts.push(value.trim());
  }
  return parts.join(SECTION_SEPARATOR);
}

// ---------------------------------------------------------------------------
// Volatility detection
// ---------------------------------------------------------------------------

/** Kind of volatile token found in a prompt prefix. */
export type VolatileTokenKind =
  | "iso-timestamp"
  | "iso-date"
  | "uuid"
  | "epoch-millis"
  | "boundary-nonce";

/** A volatile token located in a prompt prefix. */
export interface VolatilePrefixToken {
  /** What kind of volatile value this is. */
  kind: VolatileTokenKind;
  /** The matched text (for a boundary nonce, the nonce itself). */
  value: string;
  /** Character offset of the match within the scanned text. */
  index: number;
}

/** Options for {@link findVolatilePrefixTokens}. */
export interface VolatileScanOptions {
  /**
   * Boundary nonce this prompt legitimately carries (Issue #1343).
   *
   * The untrusted-content fence is randomised per invocation on purpose, so its
   * own nonce is expected and is not reported. Every *other* nonce-shaped token
   * still is — an unexpected one means a second, unaccounted fence.
   */
  allowBoundaryId?: string;
}

/**
 * Patterns whose matches cannot be byte-stable between invocations.
 *
 * Each entry captures the volatile value in group 1 when the surrounding text
 * is part of the match (the boundary nonce), otherwise the whole match is the
 * value.
 */
const VOLATILE_PATTERNS: ReadonlyArray<
  { kind: VolatileTokenKind; pattern: RegExp }
> = [
  // 2026-08-17T04:15:00Z — changes every invocation.
  {
    kind: "iso-timestamp",
    pattern:
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g,
  },
  // 3f2b1c8e-... — crypto.randomUUID() and friends.
  {
    kind: "uuid",
    pattern:
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  },
  // 1755400000000 — Date.now() in milliseconds.
  { kind: "epoch-millis", pattern: /\b1[6-9]\d{11}\b/g },
  // BOUNDARY_eb47423456a7 / <<<ISSUE_BODY_END_eb47423456a7>>> — the #1343 nonce.
  { kind: "boundary-nonce", pattern: /_([0-9a-f]{12})\b/g },
  // 2026-08-17 — a bare date is stable only until midnight.
  { kind: "iso-date", pattern: /\b\d{4}-\d{2}-\d{2}\b/g },
];

/**
 * Find tokens in `text` that cannot be byte-stable across invocations.
 *
 * Matches are reported in the order the patterns are declared, most specific
 * first, and a region already claimed by an earlier (more specific) pattern is
 * not reported again — so `2026-08-17T04:15:00Z` is one `iso-timestamp`, not
 * also an `iso-date`.
 *
 * @param text - Prefix text to scan
 * @param options - Scan options (see {@link VolatileScanOptions})
 * @returns Volatile tokens in ascending offset order (empty when stable)
 */
export function findVolatilePrefixTokens(
  text: string,
  options: VolatileScanOptions = {},
): VolatilePrefixToken[] {
  const found: VolatilePrefixToken[] = [];
  const claimed: Array<[number, number]> = [];

  const overlaps = (start: number, end: number) =>
    claimed.some(([s, e]) => start < e && end > s);

  for (const { kind, pattern } of VOLATILE_PATTERNS) {
    // Fresh regex per scan so lastIndex never leaks between calls.
    const scanner = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = scanner.exec(text)) !== null) {
      const whole = match[0];
      const start = match.index;
      const end = start + whole.length;
      if (overlaps(start, end)) continue;
      const value = match[1] ?? whole;
      if (kind === "boundary-nonce" && value === options.allowBoundaryId) {
        // Expected fence for this invocation — claim it so no other pattern
        // reports the same characters, but do not flag it.
        claimed.push([start, end]);
        continue;
      }
      claimed.push([start, end]);
      found.push({ kind, value, index: start });
    }
  }

  return found.sort((a, b) => a.index - b.index);
}

/**
 * Describe volatile tokens for an operator-facing log line.
 *
 * Reports at most `limit` distinct `kind=value` pairs so a prefix riddled with
 * timestamps produces a readable warning rather than a wall of text.
 *
 * @param tokens - Tokens from {@link findVolatilePrefixTokens}
 * @param limit - Maximum distinct pairs to name (default 5)
 * @returns A comma-separated description, or "" when there is nothing to report
 */
export function describeVolatileTokens(
  tokens: readonly VolatilePrefixToken[],
  limit = 5,
): string {
  if (tokens.length === 0) return "";
  const distinct: string[] = [];
  for (const token of tokens) {
    const label = `${token.kind}=${token.value}`;
    if (!distinct.includes(label)) distinct.push(label);
    if (distinct.length >= limit) break;
  }
  const more = tokens.length > distinct.length
    ? ` (+${tokens.length - distinct.length} more)`
    : "";
  return `${distinct.join(", ")}${more}`;
}
