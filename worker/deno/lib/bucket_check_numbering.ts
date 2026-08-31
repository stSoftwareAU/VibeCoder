/**
 * Check-numbering invariant for the best-practices bucket guides (Issue #677).
 *
 * Each guide under `prompts/best_practices/buckets/` numbers its checks as one
 * gapless `1..N` list that runs across the guide's sections, and the guides
 * cross-reference those numbers ("Missing `// SAFETY:` comments belong to
 * check 3 — do not file both"). Inserting a check mid-list therefore renumbers
 * every check below it, and a slip leaves a duplicate or a hole — a scan then
 * cites a check number that names something else, or nothing at all.
 *
 * This module reports that structural fault loudly rather than letting a
 * mis-numbered guide ship green. It asserts nothing about the wording of a
 * check, so guides stay freely rewordable (the WHAT-vs-HOW rule from Issue
 * #3115).
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

/**
 * A check heading: a top-level ordered-list item whose text opens with a bold
 * title, e.g. `16. **Concurrency — locking.** Gate: …`. The bold lead is what
 * separates a check from ordinary numbered prose.
 */
const CHECK_HEADING = /^(\d+)\. \*\*/;

/** Opening or closing fence of a Markdown code block, at any indent. */
const CODE_FENCE = /^\s*(```|~~~)/;

/**
 * Check numbers declared in a guide, in the order they appear.
 *
 * Lines inside fenced code blocks are skipped — a sample manifest or snippet
 * may legitimately contain something that looks like a numbered item.
 */
export function checkNumbersIn(markdown: string): number[] {
  const numbers: number[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (CODE_FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = CHECK_HEADING.exec(line);
    if (match) numbers.push(Number(match[1]));
  }
  return numbers;
}

/**
 * Numbering faults in a guide: one message per check whose number is not the
 * next one in the `1..N` sequence.
 *
 * An empty array means the guide is well numbered. A guide with no checks at
 * all is not a fault — not every document under review declares checks.
 */
export function findCheckNumberingIssues(markdown: string): string[] {
  const issues: string[] = [];
  checkNumbersIn(markdown).forEach((found, index) => {
    const expected = index + 1;
    if (found !== expected) {
      issues.push(
        `check ${index + 1} of the list is misnumbered: ` +
          `expected ${expected}, found ${found}`,
      );
    }
  });
  return issues;
}
