/**
 * Shared parser for `gh api --paginate` output (Issue #2895).
 *
 * `--paginate` prints one top-level JSON array per page, concatenated with no
 * guaranteed separator. Splitting that on a `][`-shaped regex breaks as soon
 * as a page body contains `[text][ref]` or an escaped `]\n[`, producing
 * "Unterminated string in JSON". This scans the raw text for top-level page
 * boundaries while tracking JSON string state instead. One shared parser
 * keeps every paginated read — with or without `--jq` — on the same path
 * (see `marker_comment_pages.ts` for the sibling parser that works
 * line-by-line instead of scanning raw concatenated pages).
 */

/** One page's scan outcome: where it ended and the elements it held. */
interface PageScan {
  /** Index just past the page's closing `]`. */
  endIndex: number;
  /** The elements the page's top-level array held. */
  elements: unknown[];
}

/** Scan one `[...]` page starting at `startIndex`, tracking string state. */
function scanPage(raw: string, startIndex: number): PageScan {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let index = startIndex;

  for (; index < raw.length; index++) {
    const ch = raw[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "[" || ch === "{") {
      depth++;
    } else if (ch === "]" || ch === "}") {
      depth--;
    }

    if (depth === 0) {
      index++;
      break;
    }
  }

  if (depth !== 0 || inString) {
    throw new Error(
      `gh output ends mid-page (unterminated) at offset ${startIndex}`,
    );
  }

  const pageText = raw.slice(startIndex, index);
  let parsed: unknown;
  try {
    parsed = JSON.parse(pageText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`gh returned a malformed JSON array page: ${message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `gh returned output that is not a JSON array page at offset ${startIndex}`,
    );
  }

  return { endIndex: index, elements: parsed };
}

/**
 * Parse `gh api --paginate` output made of one or more concatenated
 * top-level JSON arrays into a single flat list, in page order.
 *
 * @param raw - Raw stdout from a paginated `gh api` call
 * @returns Every element from every page, in page order
 * @throws {Error} When a non-whitespace character outside a page is not `[`,
 * a page does not parse as JSON, a parsed page is not an array, or the input
 * ends mid-page
 */
export function parseJsonArrayPages(raw: string): unknown[] {
  const elements: unknown[] = [];
  let index = 0;

  while (index < raw.length) {
    const ch = raw[index];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      index++;
      continue;
    }
    if (ch !== "[") {
      throw new Error(
        `gh returned output that is not a JSON array page at offset ${index}`,
      );
    }

    const page = scanPage(raw, index);
    elements.push(...page.elements);
    index = page.endIndex;
  }

  return elements;
}
