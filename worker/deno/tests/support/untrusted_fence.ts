/** Shared fence-coverage assertions (Issue #4203). */
import { assert, AssertionError, assertThrows } from "@std/assert";
import { isBoundaryId } from "../../lib/prompt_delimiter.ts";

export interface FenceCoverageRow {
  /** The exported builder name, written as a literal for the completeness scan. */
  name: string;
  canaries: string[];
  render(): string | Promise<string>;
  knownLeak?: `#${number}`;
}

interface FencedRange {
  start: number;
  end: number;
}

function fail(
  prompt: string,
  canary: string,
  reason: string,
  index: number,
): never {
  const context = prompt.slice(Math.max(0, index - 40), index + 40);
  throw new AssertionError(
    `Canary ${JSON.stringify(canary)}: ${reason}; context: ${
      JSON.stringify(context)
    }`,
  );
}

function requireCanary(prompt: string, canary: string): void {
  if (!canary) fail(prompt, canary, "empty canary", 0);
  if (!prompt.includes(canary)) fail(prompt, canary, "missing from prompt", 0);
}

/** Read only whole marker lines; match closing ids against the open stack. */
function fencedRanges(prompt: string, canary: string): FencedRange[] {
  const markers =
    /^---(BEGIN|END) UNTRUSTED USER CONTENT BOUNDARY_([^\r\n]*?)---\r?$/gm;
  const open: Array<{ id: string; start: number; marker: number }> = [];
  const ranges: FencedRange[] = [];
  for (const match of prompt.matchAll(markers)) {
    const id = match[2];
    if (!isBoundaryId(id)) {
      fail(
        prompt,
        canary,
        `invalid boundary id ${JSON.stringify(id)}`,
        match.index,
      );
    }
    if (match[1] === "BEGIN") {
      open.push({
        id,
        start: match.index + match[0].length,
        marker: match.index,
      });
      continue;
    }
    const begin = open.pop();
    if (!begin) fail(prompt, canary, `stray END for ${id}`, match.index);
    if (begin.id !== id) {
      fail(
        prompt,
        canary,
        `mismatched END ${id}, expected ${begin.id}`,
        match.index,
      );
    }
    ranges.push({ start: begin.start, end: match.index });
  }
  const unclosed = open[open.length - 1];
  if (unclosed) {
    fail(prompt, canary, `unclosed BEGIN for ${unclosed.id}`, unclosed.marker);
  }
  return ranges;
}

/** Reject missing input, malformed fences and every occurrence outside a pair. */
export function assertOnlyInsideUntrustedFence(
  prompt: string,
  canary: string,
): void {
  requireCanary(prompt, canary);
  const ranges = fencedRanges(prompt, canary);
  for (
    let index = prompt.indexOf(canary);
    index !== -1;
    index = prompt.indexOf(canary, index + 1)
  ) {
    if (
      !ranges.some(({ start, end }) =>
        index >= start && index + canary.length <= end
      )
    ) {
      fail(prompt, canary, "appears outside an untrusted fence", index);
    }
  }
}

/** Encode field names injectively, retaining only scrub-safe letters and digits. */
export function makeCanary(field: string): string {
  const encoded = Array.from(field, (char) => char.codePointAt(0)!.toString(16))
    .join("Z");
  return `FENCECANARY${encoded}Q7`;
}

/** A tracked leak must keep failing the strict assertion until it is repaired. */
export function knownLeakRow(
  row: FenceCoverageRow & { knownLeak: `#${number}` },
): FenceCoverageRow {
  assert(
    /^#[1-9]\d*$/.test(row.knownLeak),
    "A known leak requires a follow-up issue",
  );
  return row;
}

/** Execute one row; exported so helper tests can verify expected failures. */
export async function assertFenceCoverageRow(
  row: FenceCoverageRow,
): Promise<void> {
  assert(row.canaries.length > 0, `${row.name} needs at least one canary`);
  const prompt = await row.render();
  const check = () => {
    for (const canary of row.canaries) {
      assertOnlyInsideUntrustedFence(prompt, canary);
    }
  };
  if (row.knownLeak) {
    // A dropped input cannot masquerade as a tracked leak. Malformed markers
    // may themselves be the production defect that the follow-up must repair.
    for (const canary of row.canaries) requireCanary(prompt, canary);
    assertThrows(
      check,
      AssertionError,
      undefined,
      `${row.name}: promote the clean ${row.knownLeak} row`,
    );
  } else {
    check();
  }
}

/** Register normal and known-leak rows in the existing Deno test discovery. */
export function runFenceCoverageRows(
  rows: readonly FenceCoverageRow[],
  register: (name: string, test: () => Promise<void>) => void = Deno.test,
): void {
  for (const row of rows) {
    const suffix = row.knownLeak ? ` (known leak ${row.knownLeak})` : "";
    register(
      `fence coverage - ${row.name}${suffix}`,
      () => assertFenceCoverageRow(row),
    );
  }
}
