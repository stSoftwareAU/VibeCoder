/**
 * Prose and heading projections over a prompt template (Issue #840).
 *
 * Two drift gates read the shipped templates and assert what they may not
 * say — `security_scan_house_vocabulary_test.ts` for one directory (#837) and
 * `prompt_house_vocabulary_drift_test.ts` for every directory (#840). Both
 * need the same two projections, and a second copy of them would drift from
 * the first exactly the way the templates drifted from each other, so they
 * live here once.
 *
 *   - {@link flattenProse} strips the parts of a template that are *not*
 *     prose — fenced blocks and inline code spans — and joins what is left
 *     into one string, so a rule about prose never fires on a shell snippet,
 *     a marker literal or a filename, and a hard-wrapped phrase is still one
 *     phrase.
 *   - {@link headings} lists every ATX heading, fenced ones included: a
 *     scan's filed-issue body is shown as a fenced example, so its slot
 *     headings are inside a fence and are governed all the same.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

/** One line of a template, addressed the way an editor addresses it. */
export interface SourceLine {
  /** 1-based line number. */
  line: number;
  /** The line's text, trailing newline removed. */
  text: string;
}

/** A template's prose, flattened, with a map back to its source lines. */
export interface FlatProse {
  /** The prose, fences and code spans removed, joined into one string. */
  flat: string;
  /** The 1-based source line an offset into {@link flat} came from. */
  lineAt: (at: number) => number;
}

/**
 * A template's prose with fenced blocks and inline code spans blanked out,
 * joined into one string so a banned phrase cannot hide across the ~70-column
 * hard wrap. Each character keeps the source line it came from, so a hit
 * still reports where it lives.
 *
 * @param text - The template's full text
 * @returns The flattened prose and its line map
 */
export function flattenProse(text: string): FlatProse {
  let inFence = false;
  const parts: string[] = [];
  const lines: number[] = [];
  text.split("\n").forEach((raw, index) => {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const content = raw.replace(/`[^`]*`/g, "``") + "\n";
    parts.push(content);
    for (let i = 0; i < content.length; i++) lines.push(index + 1);
  });
  return {
    flat: parts.join(""),
    // An index off the end means the flattened text and its line map have
    // diverged, which would silently mislabel every hit. Fail loudly instead.
    lineAt: (at: number) => {
      const line = lines[at];
      if (line === undefined) {
        throw new Error(`prose line map has no entry for offset ${at}`);
      }
      return line;
    },
  };
}

/**
 * Every prose match for `pattern` in `text`, rendered as `line N: <phrase>`.
 *
 * The prose is flattened across the template's ~70-column hard wrap, so a
 * banned phrase can straddle a newline. Patterns must therefore spell inner
 * whitespace `\s+` rather than a literal space — `/idle\s+task/` catches
 * `idle\ntask`, `/idle task/` would not, and a wrapped variant is drift, not
 * an exemption. Both rules are enforced here rather than by rewriting the
 * pattern at runtime, which keeps every regex in the calling test a literal.
 *
 * @param text - The template's full text
 * @param pattern - A global pattern with no literal space in its source
 * @returns One `line N: <phrase>` entry per match, in source order
 */
export function hitsIn(text: string, pattern: RegExp): string[] {
  if (!pattern.global) {
    throw new Error(
      `prose pattern ${pattern} must be global, or only the first hit is found`,
    );
  }
  if (pattern.source.includes(" ")) {
    throw new Error(
      `prose pattern ${pattern} has a literal space; use \\s+ so it still ` +
        "matches when the hard wrap splits the phrase",
    );
  }
  const { flat, lineAt } = flattenProse(text);
  return [...flat.matchAll(pattern)].map((m) =>
    `line ${lineAt(m.index ?? 0)}: ${m[0].replace(/\s+/g, " ").trim()}`
  );
}

/**
 * The contents of every fenced block in `text`, fence lines excluded.
 *
 * Lives beside {@link flattenProse} because both encode the same fact — where
 * a fenced block starts and stops — and a second copy of that knowledge is
 * how the two would drift apart.
 *
 * @param text - The template's full text
 * @returns One entry per fenced block, in source order
 */
export function fencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      if (current) {
        blocks.push(current.join("\n"));
        current = null;
      } else {
        current = [];
      }
      continue;
    }
    current?.push(line);
  }
  return blocks;
}

/** One ATX heading, as written. */
export interface Heading extends SourceLine {
  /** Number of leading `#` characters. */
  level: number;
  /** The heading text, hashes and surrounding whitespace removed. */
  title: string;
  /** The heading as written, leading indentation removed. */
  written: string;
}

/**
 * Every ATX heading in `text`, fenced examples included.
 *
 * A scan template shows the issue body it files as a fenced example, so the
 * body's slot headings (`## Why this matters`, `## Suggested fix`) live inside
 * a fence and are indented with it. They are governed like any other heading,
 * so fences are kept and the indentation is stripped.
 *
 * Level 1 is deliberately excluded: `# ` inside a fenced shell snippet is a
 * comment, not a heading, and every governed section heading is H2 or deeper.
 *
 * @param text - The template's full text
 * @returns Every H2..H6 heading, in source order
 */
export function headings(text: string): Heading[] {
  const found: Heading[] = [];
  text.split("\n").forEach((raw, index) => {
    const match = /^\s*(#{2,6})\s+(\S.*?)\s*$/.exec(raw);
    if (!match) return;
    found.push({
      line: index + 1,
      text: raw,
      level: match[1]!.length,
      title: match[2]!,
      written: `${match[1]} ${match[2]}`,
    });
  });
  return found;
}
