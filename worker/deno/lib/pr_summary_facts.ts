/**
 * PR summary facts file: load, validate and render into the PR summary
 * (Issue #3535, part of #3396).
 *
 * The agent may record the Branch outcomes block as structured JSON beside
 * the PR summary (`pr-summary-<N>.facts.json`). The worker validates it with
 * `parseSummaryFacts` and renders the list into the summary at the
 * established marker, replaces a safely identified legacy list, or appends
 * the block when neither is present.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import {
  checkBranchOutcomeAdmissions,
  MAX_SCAN_CHARS,
  parseBranchOutcomes,
} from "./branch_outcomes_gate.ts";
import {
  markdownLogicalUnits,
  maskMarkdownCode,
} from "./markdown_code_spans.ts";

import {
  parseSummaryFacts,
  renderBranchOutcomes,
  type SummaryFacts,
} from "./summary_facts.ts";

import { markdownLogicalUnits } from "./markdown_code_spans.ts";

/**
 * Render an unambiguous standalone root-manifest bump without predicting the
 * final version. Historical ancestors, release continuations, nested manifests
 * and examples keep their exact evidence. Newly generated archives use the
 * same durable wording directly.
 */
export function normaliseSummaryVersionBumps(content: string): string {
  const chunks = content.split(/(\r\n|[\n\r\u2028\u2029])/);
  const lines = chunks.filter((_, index) => index % 2 === 0);
  const units = markdownLogicalUnits(lines);
  const headings: Array<{ level: number; name: string }> = [];
  const enterHeading = (level: number, name: string) => {
    while (headings.length && headings[headings.length - 1]!.level >= level) {
      headings.pop();
    }
    headings.push({ level, name: name.trim().toLowerCase() });
  };
  for (let u = 0; u < units.length; u++) {
    const unit = units[u]!;
    const index = unit.lines[0]!;
    const line = lines[index]!;
    if (/^(?: {4}| *\t)/.test(line)) continue;
    if (unit.kind === "heading") {
      // Count the bounded ATX prefix and trim in separate linear scans; a lazy
      // name capture next to trailing whitespace is quadratic on long input.
      const prefix = /^ {0,3}#{1,6}(?:[ \t]|$)/.exec(line);
      if (!prefix) continue;
      const level = prefix[0].trim().length;
      let name = line.slice(prefix[0].length).trim();
      let end = name.length;
      while (end > 0 && name[end - 1] === "#") end--;
      if (end > 0 && /\s/.test(name[end - 1]!)) {
        name = name.slice(0, end).trimEnd();
      }
      enterHeading(level, name);
      continue;
    }
    const next = units[u + 1];
    if (
      unit.kind === "paragraph" && next?.kind === "break" &&
      next.lines[0] === unit.lines[unit.lines.length - 1]! + 1
    ) {
      const underline = lines[next.lines[0]!]!.trim();
      if (/^(?:=+|-+)$/.test(underline)) {
        enterHeading(underline[0] === "=" ? 1 : 2, unit.text);
        u++;
        continue;
      }
    }
    if (
      (unit.kind !== "paragraph" && unit.kind !== "list-item") ||
      unit.lines.length !== 1 || headings.some(({ level, name }) =>
        name !== "summary" && name !== "test plan" &&
        !(level === 1 && name === "pr summary")
      )
    ) {
      continue;
    }
    const bump = line.match(
      /^( {0,3}(?:[-*] +)?(?:\*\*)?Version bump:(?:\*\*)? +)`(VERSION|Cargo\.toml|package\.json|deno\.jsonc?)` +`?v?\d+\.\d+\.\d+`? *(?:→|->) *`?v?\d+\.\d+\.\d+`?\.? *$/i,
    );
    if (!bump) {
      continue;
    }
    chunks[index * 2] = `${bump[1]}\`${
      bump[2]
    }\` updated for this change; the merged commit records the final version.`;
  }
  return chunks.join("");
}

/** Where the rendered Branch outcomes list belongs in the PR summary. */
export const BRANCH_OUTCOMES_MARKER = "<!-- vibe-branch-outcomes -->";
/** End of the block the facts renderer owns. */
export const BRANCH_OUTCOMES_END_MARKER = "<!-- /vibe-branch-outcomes -->";

/** Repo-relative path of the facts file for an issue. */
export function prSummaryFactsPath(issueNumber: number): string {
  return `docs/archive/pr-summaries/pr-summary-${issueNumber}.facts.json`;
}

/**
 * Read the facts file. A missing file is `null`; any other read error is an
 * error, never treated as absent.
 */
export async function loadPrSummaryFacts(
  repoPath: string,
  issueNumber: number,
): Promise<Result<{ content: string; relativePath: string } | null>> {
  const relativePath = prSummaryFactsPath(issueNumber);
  try {
    const content = await Deno.readTextFile(`${repoPath}/${relativePath}`);
    return { ok: true, value: { content, relativePath } };
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return { ok: true, value: null };
    return {
      ok: false,
      error: new Error(
        `Failed to read PR summary facts at ${relativePath}: ${
          (err as Error).message
        }`,
      ),
    };
  }
}

/**
 * Refresh the renderer-owned block and safely replace legacy outcome lists.
 * Unrelated narrative is retained; ambiguous ownership or an unresolved
 * unreached-outcome admission returns an error instead of discarding evidence.
 */
export function applyBranchOutcomesFacts(
  summaryContent: string,
  rendered: string,
): Result<string> {
  if (summaryContent.length > MAX_SCAN_CHARS) {
    return {
      ok: false,
      error: new Error(
        "Branch outcomes ownership is ambiguous: summary exceeds the parser limit",
      ),
    };
  }
  // Keep original line terminators for text outside the renderer-owned block.
  const chunks = summaryContent.split(/(\r\n|[\n\r\u2028\u2029])/);
  const lines = chunks.filter((_, index) => index % 2 === 0);
  const code = new Set(
    markdownLogicalUnits(lines).filter((unit) => unit.kind === "code").flatMap((
      unit,
    ) => unit.lines),
  );
  const starts = lines.flatMap((line, index) =>
    !code.has(index) && line.trim() === BRANCH_OUTCOMES_MARKER ? [index] : []
  );
  const ends = lines.flatMap((line, index) =>
    !code.has(index) && line.trim() === BRANCH_OUTCOMES_END_MARKER
      ? [index]
      : []
  );
  if (
    starts.length > 1 || ends.length > 1 ||
    (ends.length === 1 && (starts.length !== 1 || ends[0]! <= starts[0]!))
  ) {
    return {
      ok: false,
      error: new Error(
        "Branch outcomes ownership is ambiguous: duplicate or unmatched renderer markers",
      ),
    };
  }
  const visible = lines.map((line, index) =>
    code.has(index) || line.trim() === BRANCH_OUTCOMES_MARKER ||
      line.trim() === BRANCH_OUTCOMES_END_MARKER
      ? ""
      : line
  );
  const record = parseBranchOutcomes(visible.join("\n"));
  const admission = checkBranchOutcomeAdmissions(record, visible);
  if (admission.problems.length > 0) {
    return {
      ok: false,
      error: new Error(
        `Branch outcomes evidence is unresolved: ${admission.problems[0]}`,
      ),
    };
  }
  const removed = new Set<number>();
  const ownedStart = starts[0];
  const ownedEnd = ends[0];
  if (ownedEnd !== undefined) {
    for (let index = ownedStart!; index <= ownedEnd; index++) {
      removed.add(index);
    }
  }
  const legacy = visible.map((line, index) => removed.has(index) ? "" : line);
  const legacyRecord = parseBranchOutcomes(legacy.join("\n"));
  const legacyProse = maskMarkdownCode(legacy.join("\n")).split("\n");
  if (legacyRecord.present) {
    if (
      legacyRecord.bodyLineIndexGroups.some((indices) =>
        !parseBranchOutcomes(indices.map((index) => legacy[index]).join("\n"))
          .noneDeclared
      ) ||
      legacyRecord.entryLineIndices.some((indices) =>
        indices.slice(1).some((index) => !/^\s/.test(legacy[index]!))
      ) ||
      legacyRecord.entries.some((entry) =>
        !/^[A-Za-z0-9_.\/-]+:\d+(?:-\d+)?\s+[—-]/.test(entry)
      ) ||
      legacyRecord.uncapturedLines.some((line) =>
        /^[A-Za-z0-9_.\/-]+:\d+/.test(line)
      )
    ) {
      return {
        ok: false,
        error: new Error(
          "Branch outcomes ownership is ambiguous: legacy block contains unowned evidence",
        ),
      };
    }
    for (const [index, line] of legacy.entries()) {
      if (parseBranchOutcomes(line).present) {
        if (!parseBranchOutcomes(legacyProse[index] ?? "").present) {
          return {
            ok: false,
            error: new Error(
              "Branch outcomes ownership is ambiguous: inline-code header may be an example",
            ),
          };
        }
        removed.add(index);
      }
    }
    for (const indices of legacyRecord.entryLineIndices) {
      for (const index of indices) removed.add(index);
    }
  }
  const insertAt = ownedStart ?? Math.min(...removed);
  const block =
    `${BRANCH_OUTCOMES_MARKER}\n${rendered.trimEnd()}\n${BRANCH_OUTCOMES_END_MARKER}`;
  let result = "";
  for (let index = 0; index < lines.length; index++) {
    if (index === insertAt) {
      result += block + (chunks[(ownedEnd ?? index) * 2 + 1] ?? "");
    } else if (!removed.has(index)) {
      result += chunks[index * 2]! + (chunks[index * 2 + 1] ?? "");
    }
  }
  const output = insertAt === Infinity
    ? result.trim().length === 0
      ? block + "\n"
      : result + (lines.at(-1) === "" ? "" : "\n\n") + block + "\n"
    : result;
  if (output.length > MAX_SCAN_CHARS) {
    return {
      ok: false,
      error: new Error(
        "Branch outcomes ownership is ambiguous: rendered summary exceeds the parser limit",
      ),
    };
  }
  return { ok: true, value: output };
}

/**
 * Text the PR-body digest is computed over. With no facts file it is the
 * summary unchanged, so existing PRs' digests stay stable.
 */
export function prSummaryDigestInput(
  summaryContent: string,
  factsContent: string | null,
): string {
  if (factsContent === null) return summaryContent;
  return summaryContent + "\n<!-- vibe-pr-summary-facts -->\n" + factsContent;
}

/** What the facts file amounts to for the completion phase. */
export type BranchOutcomesFactsOutcome =
  | { kind: "absent" }
  | {
    kind: "error";
    reason: string;
    relativePath: string;
    /** Raw facts text when it was read, null when it was unreadable. */
    content: string | null;
  }
  | {
    kind: "valid";
    relativePath: string;
    facts: SummaryFacts;
    rendered: string;
    content: string;
  };

/** Load, validate and render the facts file for an issue. */
export async function resolveBranchOutcomesFacts(
  repoPath: string,
  issueNumber: number,
): Promise<BranchOutcomesFactsOutcome> {
  const relativePath = prSummaryFactsPath(issueNumber);
  const loaded = await loadPrSummaryFacts(repoPath, issueNumber);
  if (!loaded.ok) {
    return {
      kind: "error",
      relativePath,
      content: null,
      reason:
        `Branch outcomes facts file ${relativePath} could not be read: ${loaded.error.message}`,
    };
  }
  if (loaded.value === null) return { kind: "absent" };
  const { content } = loaded.value;
  const parsed = parseSummaryFacts(content);
  if (!parsed.ok) {
    return {
      kind: "error",
      relativePath,
      content,
      reason:
        `Branch outcomes facts file ${relativePath} is invalid: ${parsed.error.message}`,
    };
  }
  return {
    kind: "valid",
    relativePath,
    facts: parsed.value,
    rendered: renderBranchOutcomes(parsed.value),
    content,
  };
}
