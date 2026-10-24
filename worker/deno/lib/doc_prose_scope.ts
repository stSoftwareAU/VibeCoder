/** Bounded prose affected by a branch or review-fix diff (Issues #3715, #3731). */
import {
  isManualProsePath,
  isProseSourcePath,
  MAX_DOC_PROSE_FILES,
  selectManualProseFiles,
} from "./doc_prose_claims.ts";
import { parseDocsSweepLine } from "./docs_sweep_gate.ts";
import { githubSlug } from "./markdown_anchors.ts";
import { maskMarkdownCode } from "./markdown_code_spans.ts";
import {
  sourceProseLines,
  sourceStringLiterals,
} from "./removed_assertion_gate.ts";

/** Cap on unchanged user-visible strings asked about in one run (Issue #4196). */
const MAX_USER_VISIBLE_STRINGS = 40;

/** An inclusive, one-based range the model is asked to check. */
export interface ProseRange {
  file: string;
  start: number;
  end: number;
  kind:
    | "changed prose"
    | "source comment"
    | "affected manual section"
    | "user-visible string";
  /** Verbatim literal, present for a user-visible string so the prompt can quote it. */
  text?: string;
}

/** Selected text also confines confirmation of model findings to the actual scope. */
export interface DocProseScope {
  contents: Map<string, string>;
  ranges: ProseRange[];
  notChecked: string[];
  /** The `notChecked` entries caused by the file/section caps (a subset of `notChecked`). */
  capOverflow: string[];
}

/** Parse head-side changed lines from a zero-context git diff. */
function changedLines(diff: string): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  let file = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) file = line.slice(6);
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || !file) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const lines = result.get(file) ?? new Set<number>();
    // A deletion still changes its enclosing declaration/section at this boundary.
    for (let i = start; i < start + Math.max(1, count); i++) {
      lines.add(Math.max(1, i));
    }
    result.set(file, lines);
  }
  return result;
}

/** End of the declaration following a comment, using masked code for braces. */
function declarationEnd(code: readonly string[], start: number): number {
  const indent = code[start]?.search(/\S/) ?? 0;
  let braces = 0;
  let parens = 0;
  let brackets = 0;
  let opened = false;
  for (let i = start; i < code.length; i++) {
    const line = code[i]!;
    if (
      i > start && !opened && line.trim() && line.search(/\S/) <= indent &&
      /^(?:export|pub|function|class|def|fn|const|let|var)\b/.test(line.trim())
    ) return i - 1;
    for (const char of line) {
      if (char === "(") parens++;
      if (char === ")") parens--;
      if (char === "[") brackets++;
      if (char === "]") brackets--;
      if (char === "{") {
        opened = true;
        braces++;
      }
      if (char === "}") braces--;
    }
    if (opened && braces === 0 && parens === 0 && brackets === 0) {
      let next = "";
      for (let j = i + 1; j < code.length; j++) {
        if (code[j]!.trim()) {
          next = code[j]!.trim();
          break;
        }
      }
      // A parameter or return-type object is not the declaration body.
      if (!/^(?:=>|[({,=])/.test(next) && /[};]\s*$/.test(line)) return i;
    }
    if (!opened && parens === 0 && brackets === 0 && /;\s*$/.test(line)) {
      return i;
    }
  }
  return code.length - 1;
}

/**
 * A changed line whose blanked code alters which case reaches existing text:
 * a comparison, a case or match arm, an if / else-if / ternary, or an
 * allowed-value array or set.
 */
function isConditionCode(code: string): boolean {
  const scan = code.replace(/=>/g, "  ").replace(/->/g, "  ");
  if (/<=|>=|===|!==|==|!=/.test(scan)) return true;
  if (/(?:^|[^<>=!])<(?![<=])/.test(scan)) return true;
  if (/(?:^|[^<>=!-])>(?![>=])/.test(scan)) return true;
  if (/\b(?:case|match)\b/.test(scan)) return true;
  if (/\bif\b/.test(scan) || /\belse\s+if\b/.test(scan)) return true;
  if (/\?(?![.?])/.test(scan)) return true;
  if (/new\s+Set\s*\(/.test(scan)) return true;
  if (
    /\[[^\]\n]*\]/.test(scan) &&
    /\b(?:allowed|allowlist|includes|has)\b/.test(scan)
  ) return true;
  return false;
}

/** Nearest indent-0 declaration that contains `lineIndex`, if there is one. */
function enclosingDeclaration(
  code: readonly string[],
  lineIndex: number,
): { start: number; end: number } | undefined {
  for (let i = lineIndex; i >= 0; i--) {
    const line = code[i]!;
    if (!line.trim() || line.search(/\S/) !== 0) continue;
    if (
      !/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var|fn|struct|impl)\b/
        .test(line.trim())
    ) continue;
    const end = declarationEnd(code, i);
    if (lineIndex <= end) return { start: i, end };
    return undefined;
  }
  return undefined;
}

// SIMPLE-ON-PURPOSE: two-word heuristic — upgrade when a single-word user-visible label is missed in a real PR
function isUserVisibleLiteral(text: string): boolean {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/).filter((word) => /[A-Za-z]/.test(word));
  if (words.length < 2) return false;
  if (/[/\\]/.test(trimmed)) return false;
  if (/%[sdif]|\{[0-9]+\}|\$\{/.test(trimmed)) return false;
  if (trimmed.startsWith("/") || /\\[dws]/.test(trimmed)) return false;
  return true;
}

/** Build the same scope for completion and review-fix checks. */
export async function collectDocProseScope(input: {
  changedFiles: readonly string[];
  trackedFiles: readonly string[];
  summaryContent: string;
  diff: string | null;
  untrackedFiles?: readonly string[];
  readFile: (file: string) => Promise<string | undefined>;
  fileCap?: number;
  sectionCap?: number;
}): Promise<DocProseScope> {
  const fileCap = input.fileCap ?? MAX_DOC_PROSE_FILES;
  const sectionCap = input.sectionCap ?? 40;
  if (
    !Number.isInteger(fileCap) || fileCap < 0 ||
    !Number.isInteger(sectionCap) || sectionCap < 0
  ) {
    throw new Error("Prose scope caps must be non-negative integers");
  }
  const scope: DocProseScope = {
    contents: new Map(),
    ranges: [],
    notChecked: [],
    capOverflow: [],
  };
  const changed = changedLines(input.diff ?? "");
  const stringCandidates: Array<{ file: string; line: number; text: string }> =
    [];
  if (input.diff === null) {
    scope.notChecked.push(
      "the prose diff could not be read; changed lines not checked, never passed",
    );
  }
  const sources = input.changedFiles.filter(isProseSourcePath);
  const identifiers = new Set<string>();
  const mentions = new Set(
    sources.flatMap((f) => [f, f.slice(f.lastIndexOf("/") + 1)]),
  );
  const cached = new Map<string, string | undefined>();
  const read = async (file: string) => {
    if (!cached.has(file)) cached.set(file, await input.readFile(file));
    return cached.get(file);
  };
  const add = (range: ProseRange, content: string) => {
    if (!scope.contents.has(range.file) && scope.contents.size >= fileCap) {
      const note =
        `${range.file}:${range.start}-${range.end}: over the ${fileCap}-file cap; not checked, never passed`;
      scope.notChecked.push(note);
      scope.capOverflow.push(note);
      return;
    }
    if (
      scope.ranges.some((r) =>
        r.file === range.file && r.start === range.start && r.end === range.end
      )
    ) return;
    scope.ranges.push(range);
    scope.contents.set(
      range.file,
      (scope.contents.get(range.file) ?? "") + "\n" + content,
    );
  };
  for (const file of [...new Set(input.changedFiles)]) {
    if (!isManualProsePath(file) && !isProseSourcePath(file)) continue;
    const content = await read(file);
    if (content === undefined) {
      if (input.trackedFiles.includes(file)) {
        scope.notChecked.push(
          `${file}: tracked prose could not be read; not checked, never passed`,
        );
      }
      continue;
    }
    const lines = content.split("\n");
    if (isManualProsePath(file)) {
      // The model reads the diff for this original scope. The extra unchanged
      // scope below is always narrowed to explicit heading ranges.
      add(
        { file, start: 1, end: lines.length, kind: "changed prose" },
        content,
      );
      continue;
    }
    const touched = input.untrackedFiles?.includes(file)
      ? new Set(lines.map((_, i) => i + 1))
      : changed.get(file);
    if (!touched) {
      scope.notChecked.push(
        `${file}: changed source lines unavailable; not checked, never passed`,
      );
      continue;
    }
    const lexed = sourceProseLines(content, file);
    if (lexed.unterminatedFrom >= 0) {
      scope.notChecked.push(
        `${file}:${
          lexed.unterminatedFrom + 1
        }: unterminated source literal/comment; not checked, never passed`,
      );
      continue;
    }
    const code = lexed.lines.map((line) => line.code);
    const firstCode = code.findIndex((line) => line.trim());
    const touchedLines = [...touched].sort((a, b) => a - b);
    const hasChange = (start: number, end: number) => {
      let lo = 0, hi = touchedLines.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (touchedLines[mid]! < start) lo = mid + 1;
        else hi = mid;
      }
      return lo < touchedLines.length && touchedLines[lo]! <= end;
    };
    const declarationEnds = new Map<number, number>();
    const endOf = (start: number) => {
      if (!declarationEnds.has(start)) {
        declarationEnds.set(start, declarationEnd(code, start));
      }
      return declarationEnds.get(start)!;
    };
    for (let i = 0; i < code.length; i++) {
      const exported =
        /\b(?:export\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const)|pub(?:\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum))\s+(\w+)/
          .exec(code[i]!);
      if (
        exported &&
        hasChange(i + 1, endOf(i) + 1)
      ) identifiers.add(exported[1]!);
      if (!lexed.lines[i]!.comment.trim()) continue;
      const start = i;
      while (
        i + 1 < lines.length && lexed.lines[i + 1]!.comment.trim() &&
        !code[i + 1]!.trim()
      ) i++;
      const end = i;
      let next = end + 1;
      while (next < lines.length && !code[next]!.trim()) next++;
      const moduleHeader = firstCode === -1 || start <= firstCode;
      const attached = !code[start]!.trim() && next < lines.length &&
        hasChange(next + 1, endOf(next) + 1);
      if (
        moduleHeader || attached ||
        hasChange(start + 1, end + 1)
      ) {
        add(
          { file, start: start + 1, end: end + 1, kind: "source comment" },
          lexed.lines.slice(start, end + 1).map((line) => line.comment).join(
            "\n",
          ),
        );
      }
    }
    const literals = sourceStringLiterals(content, file).filter((literal) =>
      isUserVisibleLiteral(literal.text) && !touched.has(literal.line)
    );
    const seenInFile = new Set<string>();
    for (const hunk of [...touched].sort((a, b) => a - b)) {
      const row = code[hunk - 1];
      if (row === undefined || !isConditionCode(row)) continue;
      const declaration = enclosingDeclaration(code, hunk - 1);
      for (const literal of literals) {
        const inside = declaration
          ? literal.line >= declaration.start + 1 &&
            literal.line <= declaration.end + 1
          : Math.abs(literal.line - hunk) <= 15;
        if (!inside) continue;
        const key = `${literal.line}:${literal.text}`;
        if (seenInFile.has(key)) continue;
        seenInFile.add(key);
        stringCandidates.push({ file, line: literal.line, text: literal.text });
      }
    }
  }
  let keptStrings = 0;
  for (const candidate of stringCandidates) {
    if (keptStrings >= MAX_USER_VISIBLE_STRINGS) {
      const note =
        `${candidate.file}:${candidate.line}: user-visible string over the 40-string cap; not checked, never passed`;
      scope.notChecked.push(note);
      scope.capOverflow.push(note);
      continue;
    }
    const before = scope.ranges.length;
    add(
      {
        file: candidate.file,
        start: candidate.line,
        end: candidate.line,
        kind: "user-visible string",
        text: candidate.text,
      },
      candidate.text,
    );
    if (scope.ranges.length > before) keptStrings++;
  }
  for (const name of identifiers) mentions.add(name);
  const named = parseDocsSweepLine(input.summaryContent).section;
  let sections = 0;
  for (
    const file of selectManualProseFiles([
      ...input.trackedFiles,
      ...input.changedFiles,
    ], Number.MAX_SAFE_INTEGER).files
  ) {
    if (!isManualProsePath(file) || file.startsWith("docs/archive/")) continue;
    const content = await read(file);
    if (content === undefined) {
      if (input.trackedFiles.includes(file)) {
        scope.notChecked.push(
          `${file}: manual could not be read; not checked, never passed`,
        );
      }
      continue;
    }
    const lines = content.split("\n");
    const masked = maskMarkdownCode(content).split("\n");
    const headings = masked.flatMap((line, i) => {
      const match = /^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
      return match
        ? [{
          index: i,
          level: match[1]!.length,
          title: lines[i]!.replace(/^ {0,3}#{1,6}\s+/, "").replace(
            /\s+#+\s*$/,
            "",
          ),
        }]
        : [];
    });
    if (headings.length === 0) headings.push({ index: 0, level: 1, title: "" });
    for (let i = 0; i < headings.length; i++) {
      const heading = headings[i]!;
      const leafEnd = headings[i + 1]?.index ?? lines.length;
      const section = lines.slice(heading.index, leafEnd).join("\n");
      const slug = githubSlug(heading.title);
      const fileAt = named.indexOf(file);
      const descriptor = fileAt < 0
        ? ""
        : named.slice(fileAt + file.length).split(/[,;]/, 1)[0]!.trim();
      const explicit = fileAt >= 0 && slug !== "" &&
        githubSlug(descriptor).includes(slug);
      const referenced = [...mentions].some((name) => {
        let at = section.indexOf(name);
        while (at >= 0) {
          if (
            !/[\w/.-]/.test(section[at - 1] ?? "") &&
            !/[\w/.-]/.test(section[at + name.length] ?? "")
          ) return true;
          at = section.indexOf(name, at + name.length);
        }
        return false;
      });
      if (!explicit && !referenced) continue;
      const end = explicit
        ? headings.slice(i + 1).find((h) => h.level <= heading.level)?.index ??
          lines.length
        : leafEnd;
      if (sections++ >= sectionCap) {
        const note = `${file}:${
          heading.index + 1
        }-${end}: over the ${sectionCap}-section cap; not checked, never passed`;
        scope.notChecked.push(note);
        scope.capOverflow.push(note);
        continue;
      }
      add({
        file,
        start: heading.index + 1,
        end,
        kind: "affected manual section",
      }, lines.slice(heading.index, end).join("\n"));
    }
  }
  return scope;
}

/**
 * Paths and bounds, plus the verbatim text of a user-visible string.
 * Other source content stays in tool output and is not copied into the prompt.
 */
export function renderProseRanges(ranges: readonly ProseRange[]): string {
  return ranges.map((r) => {
    const line = `${r.file}:${r.start}-${r.end} — ${r.kind}`;
    return r.text ? `${line}: ${r.text}` : line;
  }).join("\n");
}
