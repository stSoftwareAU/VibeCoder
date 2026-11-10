/** Bounded prose affected by a branch or review-fix diff (Issues #3715, #3731). */ import { isManualProsePath, isProseSourcePath, MAX_DOC_PROSE_FILES, selectManualProseFiles } from "./doc_prose_claims.ts";
import { githubSlug } from "./markdown_anchors.ts";
import { maskMarkdownCode } from "./markdown_code_spans.ts";
/** Cap on unchanged user-visible strings asked about in one run (Issue #4196). */ const MAX_USER_VISIBLE_STRINGS = 40;
/**
 * One warning for every cap-overflow note (Issues #4118, #4177).
 * Empty overflow returns undefined so the caller logs nothing.
 * The first three names are listed; the rest are a count.
 */ export function formatCapOverflowSummary(prefix, overflow) {
  if (overflow.length === 0) return undefined;
  const shown = overflow.slice(0, 3);
  const more = overflow.length > shown.length ? `; and ${overflow.length - shown.length} more` : "";
  return `${prefix}: ${overflow.length} doc-prose range(s) over a cap, not checked (first ${shown.length}): ${shown.join("; ")}${more}`;
}
/** Parse head-side changed lines from a zero-context git diff. */ function changedLines(diff) {
  const result = new Map();
  let file = "";
  for (const line of diff.split("\n")){
    if (line.startsWith("+++ b/")) file = line.slice(6);
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || !file) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const lines = result.get(file) ?? new Set();
    // A deletion still changes its enclosing declaration/section at this boundary.
    for(let i = start; i < start + Math.max(1, count); i++){
      lines.add(Math.max(1, i));
    }
    result.set(file, lines);
  }
  return result;
}
/** End of the declaration following a comment, using masked code for braces. */ function declarationEnd(code, start) {
  const indent = code[start]?.search(/\S/) ?? 0;
  let braces = 0;
  let parens = 0;
  let brackets = 0;
  let opened = false;
  for(let i = start; i < code.length; i++){
    const line = code[i];
    if (i > start && !opened && line.trim() && line.search(/\S/) <= indent && /^(?:export|pub|function|class|def|fn|const|let|var)\b/.test(line.trim())) return i - 1;
    for (const char of line){
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
      for(let j = i + 1; j < code.length; j++){
        if (code[j].trim()) {
          next = code[j].trim();
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
 */ function isConditionCode(code) {
  const scan = code.replace(/=>/g, "  ").replace(/->/g, "  ");
  if (/<=|>=|===|!==|==|!=/.test(scan)) return true;
  if (/(?:^|[^<>=!])<(?![<=])/.test(scan)) return true;
  if (/(?:^|[^<>=!-])>(?![>=])/.test(scan)) return true;
  if (/\b(?:case|match)\b/.test(scan)) return true;
  if (/\bif\b/.test(scan) || /\belse\s+if\b/.test(scan)) return true;
  if (/\?(?![.?])/.test(scan)) return true;
  if (/new\s+Set\s*\(/.test(scan)) return true;
  if (/\[[^\]\n]*\]/.test(scan) && /\b(?:allowed|allowlist|includes|has)\b/.test(scan)) return true;
  return false;
}
/** Nearest indent-0 declaration that contains `lineIndex`, if there is one. */ function enclosingDeclaration(code, lineIndex) {
  for(let i = lineIndex; i >= 0; i--){
    const line = code[i];
    if (!line.trim() || line.search(/\S/) !== 0) continue;
    if (!/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var|fn|struct|impl)\b/.test(line.trim())) continue;
    const end = declarationEnd(code, i);
    if (lineIndex <= end) return {
      start: i,
      end
    };
    return undefined;
  }
  return undefined;
}
/** Added and removed line text per file, from a unified diff. */ function diffLineSides(diff) {
  const sides = new Map();
  let file = "";
  for (const line of diff.split("\n")){
    if (line.startsWith("+++ b/")) {
      file = line.slice(6);
      if (!sides.has(file)) sides.set(file, {
        added: [],
        removed: []
      });
      continue;
    }
    if (!file) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      sides.get(file).added.push(line.slice(1));
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      sides.get(file).removed.push(line.slice(1));
    }
  }
  return sides;
}
/** `name(` calls and `<Name` elements on these diff lines. */ function calledNames(lines) {
  const names = new Set();
  for (const line of lines){
    for (const match of line.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)){
      names.add(match[1]);
    }
    for (const match of line.matchAll(/<([A-Z][\w$]*)\b/g)){
      names.add(match[1]);
    }
  }
  return names;
}
/**
 * Indent-0 declaration keyword and the name that follows it.
 * The name is compared as text. A regex built from `name` is what
 * semgrep's detect-non-literal-regexp rule rejects.
 */ const TOP_LEVEL_NAMED_DECLARATION = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)\b/;
function topLevelDeclarationIndex(source, name) {
  const lines = source.split("\n");
  for(let i = 0; i < lines.length; i++){
    const line = lines[i];
    if (line.search(/\S/) !== 0) continue;
    const declared = line.trim().match(TOP_LEVEL_NAMED_DECLARATION)?.[1];
    if (declared === name) return i;
  }
  return undefined;
}
function relativeImportSpecifier(source, name) {
  for (const match of source.matchAll(/import\s+(?:type\s+)?([^;"']+?)\s+from\s+["'](\.[^"']+)["']/g)){
    const clause = match[1].trim();
    const spec = match[2];
    if (clause === name) return spec;
    const brace = /\{([^}]*)\}/.exec(clause);
    if (!brace) continue;
    for (const part of brace[1].split(",")){
      const bits = part.trim().split(/\s+as\s+/);
      const local = (bits.length === 2 ? bits[1] : bits[0])?.trim();
      if (local === name) return spec;
    }
  }
  return undefined;
}
function joinRelative(fromFile, spec) {
  const base = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/") + 1) : "";
  const out = [];
  for (const part of `${base}${spec}`.split("/")){
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return undefined;
      out.pop();
      continue;
    }
    out.push(part);
  }
  const joined = out.join("/");
  return joined === "" ? undefined : joined;
}
// SIMPLE-ON-PURPOSE: same file or one relative import hop — upgrade when a missed label is traced to a barrel or package re-export
async function resolveCalledDeclaration(callerFile, callerSource, name, read) {
  if (topLevelDeclarationIndex(callerSource, name) !== undefined) {
    return {
      file: callerFile,
      content: callerSource
    };
  }
  const spec = relativeImportSpecifier(callerSource, name);
  if (spec === undefined) return undefined;
  const joined = joinRelative(callerFile, spec);
  if (joined === undefined) return undefined;
  const hasExt = /\.[A-Za-z]+$/.test(joined);
  const candidates = hasExt ? [
    joined
  ] : [
    `${joined}.ts`,
    `${joined}.tsx`,
    `${joined}.js`,
    `${joined}.jsx`,
    joined
  ];
  for (const candidate of candidates){
    if (!isProseSourcePath(candidate)) continue;
    const content = await read(candidate);
    if (content !== undefined && topLevelDeclarationIndex(content, name) !== undefined) {
      return {
        file: candidate,
        content
      };
    }
  }
  return undefined;
}
// SIMPLE-ON-PURPOSE: two-word heuristic — upgrade when a single-word user-visible label is missed in a real PR
function isUserVisibleLiteral(text) {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/).filter((word)=>/[A-Za-z]/.test(word));
  if (words.length < 2) return false;
  if (/[/\\]/.test(trimmed)) return false;
  if (/%[sdif]|\{[0-9]+\}|\$\{/.test(trimmed)) return false;
  if (trimmed.startsWith("/") || /\\[dws]/.test(trimmed)) return false;
  return true;
}
/** Build the prose scope the review-fix drift check asks about. */ export async function collectDocProseScope(input) {
  const fileCap = input.fileCap ?? MAX_DOC_PROSE_FILES;
  const sectionCap = input.sectionCap ?? 40;
  if (!Number.isInteger(fileCap) || fileCap < 0 || !Number.isInteger(sectionCap) || sectionCap < 0) {
    throw new Error("Prose scope caps must be non-negative integers");
  }
  const scope = {
    contents: new Map(),
    ranges: [],
    notChecked: [],
    capOverflow: []
  };
  const changed = changedLines(input.diff ?? "");
  const lineSides = diffLineSides(input.diff ?? "");
  const stringCandidates = [];
  const seenStrings = new Set();
  const pushString = (file, line, text)=>{
    const key = `${file}:${line}:${text}`;
    if (seenStrings.has(key)) return;
    seenStrings.add(key);
    stringCandidates.push({
      file,
      line,
      text
    });
  };
  if (input.diff === null) {
    scope.notChecked.push("the prose diff could not be read; changed lines not checked, never passed");
  }
  const sources = input.changedFiles.filter(isProseSourcePath);
  const identifiers = new Set();
  const mentions = new Set(sources.flatMap((f)=>[
      f,
      f.slice(f.lastIndexOf("/") + 1)
    ]));
  const cached = new Map();
  const read = async (file)=>{
    if (!cached.has(file)) cached.set(file, await input.readFile(file));
    return cached.get(file);
  };
  const add = (range, content)=>{
    if (!scope.contents.has(range.file) && scope.contents.size >= fileCap) {
      const note = `${range.file}:${range.start}-${range.end}: over the ${fileCap}-file cap; not checked, never passed`;
      scope.notChecked.push(note);
      scope.capOverflow.push(note);
      return;
    }
    if (scope.ranges.some((r)=>r.file === range.file && r.start === range.start && r.end === range.end)) return;
    scope.ranges.push(range);
    scope.contents.set(range.file, (scope.contents.get(range.file) ?? "") + "\n" + content);
  };
  for (const file of [
    ...new Set(input.changedFiles)
  ]){
    if (!isManualProsePath(file) && !isProseSourcePath(file)) continue;
    const content = await read(file);
    if (content === undefined) {
      if (input.trackedFiles.includes(file)) {
        scope.notChecked.push(`${file}: tracked prose could not be read; not checked, never passed`);
      }
      continue;
    }
    const lines = content.split("\n");
    if (isManualProsePath(file)) {
      // The model reads the diff for this original scope. The extra unchanged
      // scope below is always narrowed to explicit heading ranges.
      add({
        file,
        start: 1,
        end: lines.length,
        kind: "changed prose"
      }, content);
      continue;
    }
    const touched = input.untrackedFiles?.includes(file) ? new Set(lines.map((_, i)=>i + 1)) : changed.get(file);
    if (!touched) {
      scope.notChecked.push(`${file}: changed source lines unavailable; not checked, never passed`);
      continue;
    }
    const lexed = sourceProseLines(content, file);
    if (lexed.unterminatedFrom >= 0) {
      scope.notChecked.push(`${file}:${lexed.unterminatedFrom + 1}: unterminated source literal/comment; not checked, never passed`);
      continue;
    }
    const code = lexed.lines.map((line)=>line.code);
    const firstCode = code.findIndex((line)=>line.trim());
    const touchedLines = [
      ...touched
    ].sort((a, b)=>a - b);
    const hasChange = (start, end)=>{
      let lo = 0, hi = touchedLines.length;
      while(lo < hi){
        const mid = lo + hi >>> 1;
        if (touchedLines[mid] < start) lo = mid + 1;
        else hi = mid;
      }
      return lo < touchedLines.length && touchedLines[lo] <= end;
    };
    const declarationEnds = new Map();
    const endOf = (start)=>{
      if (!declarationEnds.has(start)) {
        declarationEnds.set(start, declarationEnd(code, start));
      }
      return declarationEnds.get(start);
    };
    for(let i = 0; i < code.length; i++){
      const exported = /\b(?:export\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const)|pub(?:\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum))\s+(\w+)/.exec(code[i]);
      if (exported && hasChange(i + 1, endOf(i) + 1)) identifiers.add(exported[1]);
      if (!lexed.lines[i].comment.trim()) continue;
      const start = i;
      while(i + 1 < lines.length && lexed.lines[i + 1].comment.trim() && !code[i + 1].trim())i++;
      const end = i;
      let next = end + 1;
      while(next < lines.length && !code[next].trim())next++;
      const moduleHeader = firstCode === -1 || start <= firstCode;
      const attached = !code[start].trim() && next < lines.length && hasChange(next + 1, endOf(next) + 1);
      if (moduleHeader || attached || hasChange(start + 1, end + 1)) {
        add({
          file,
          start: start + 1,
          end: end + 1,
          kind: "source comment"
        }, lexed.lines.slice(start, end + 1).map((line)=>line.comment).join("\n"));
      }
    }
    const literals = sourceStringLiterals(content, file).filter((literal)=>isUserVisibleLiteral(literal.text) && !touched.has(literal.line));
    const seenInFile = new Set();
    for (const hunk of [
      ...touched
    ].sort((a, b)=>a - b)){
      const row = code[hunk - 1];
      if (row === undefined || !isConditionCode(row)) continue;
      const declaration = enclosingDeclaration(code, hunk - 1);
      for (const literal of literals){
        const inside = declaration ? literal.line >= declaration.start + 1 && literal.line <= declaration.end + 1 : Math.abs(literal.line - hunk) <= 15;
        if (!inside) continue;
        const key = `${literal.line}:${literal.text}`;
        if (seenInFile.has(key)) continue;
        seenInFile.add(key);
        pushString(file, literal.line, literal.text);
      }
    }
    const sides = lineSides.get(file);
    if (sides) {
      const addedNames = calledNames(sides.added);
      const removedNames = calledNames(sides.removed);
      for (const name of addedNames){
        if (removedNames.has(name)) continue;
        const resolved = await resolveCalledDeclaration(file, content, name, read);
        if (!resolved) continue;
        const lexedDef = sourceProseLines(resolved.content, resolved.file);
        if (lexedDef.unterminatedFrom >= 0) {
          scope.notChecked.push(`${resolved.file}:${lexedDef.unterminatedFrom + 1}: unterminated source literal/comment; not checked, never passed`);
          continue;
        }
        const start = topLevelDeclarationIndex(resolved.content, name);
        if (start === undefined) continue;
        const defCode = lexedDef.lines.map((line)=>line.code);
        const end = declarationEnd(defCode, start);
        const changedInDef = changed.get(resolved.file) ?? new Set();
        for (const literal of sourceStringLiterals(resolved.content, resolved.file)){
          if (!isUserVisibleLiteral(literal.text)) continue;
          if (literal.line < start + 1 || literal.line > end + 1) continue;
          if (changedInDef.has(literal.line)) continue;
          pushString(resolved.file, literal.line, literal.text);
        }
      }
    }
  }
  let keptStrings = 0;
  for (const candidate of stringCandidates){
    if (keptStrings >= MAX_USER_VISIBLE_STRINGS) {
      const note = `${candidate.file}:${candidate.line}: user-visible string over the 40-string cap; not checked, never passed`;
      scope.notChecked.push(note);
      scope.capOverflow.push(note);
      continue;
    }
    const before = scope.ranges.length;
    add({
      file: candidate.file,
      start: candidate.line,
      end: candidate.line,
      kind: "user-visible string",
      text: candidate.text
    }, candidate.text);
    if (scope.ranges.length > before) keptStrings++;
  }
  for (const name of identifiers)mentions.add(name);
  // Existing summaries may name manual sections. Treat those references only
  // as bounded scope hints; no Docs sweep entry or format is required.
  const named = input.summaryContent.slice(0, 64_000);
  let sections = 0;
  for (const file of selectManualProseFiles([
    ...input.trackedFiles,
    ...input.changedFiles
  ], Number.MAX_SAFE_INTEGER).files){
    if (!isManualProsePath(file) || file.startsWith("docs/archive/")) continue;
    const content = await read(file);
    if (content === undefined) {
      if (input.trackedFiles.includes(file)) {
        scope.notChecked.push(`${file}: manual could not be read; not checked, never passed`);
      }
      continue;
    }
    const lines = content.split("\n");
    const masked = maskMarkdownCode(content).split("\n");
    const headings = masked.flatMap((line, i)=>{
      const match = /^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
      return match ? [
        {
          index: i,
          level: match[1].length,
          title: lines[i].replace(/^ {0,3}#{1,6}\s+/, "").replace(/\s+#+\s*$/, "")
        }
      ] : [];
    });
    if (headings.length === 0) headings.push({
      index: 0,
      level: 1,
      title: ""
    });
    for(let i = 0; i < headings.length; i++){
      const heading = headings[i];
      const leafEnd = headings[i + 1]?.index ?? lines.length;
      const section = lines.slice(heading.index, leafEnd).join("\n");
      const slug = githubSlug(heading.title);
      const fileAt = named.indexOf(file);
      const descriptor = fileAt < 0 ? "" : named.slice(fileAt + file.length).split(/[,;]/, 1)[0].trim();
      const explicit = fileAt >= 0 && slug !== "" && githubSlug(descriptor).includes(slug);
      const referenced = [
        ...mentions
      ].some((name)=>{
        let at = section.indexOf(name);
        while(at >= 0){
          if (!/[\w/.-]/.test(section[at - 1] ?? "") && !/[\w/.-]/.test(section[at + name.length] ?? "")) return true;
          at = section.indexOf(name, at + name.length);
        }
        return false;
      });
      if (!explicit && !referenced) continue;
      const end = explicit ? headings.slice(i + 1).find((h)=>h.level <= heading.level)?.index ?? lines.length : leafEnd;
      if (sections++ >= sectionCap) {
        const note = `${file}:${heading.index + 1}-${end}: over the ${sectionCap}-section cap; not checked, never passed`;
        scope.notChecked.push(note);
        scope.capOverflow.push(note);
        continue;
      }
      add({
        file,
        start: heading.index + 1,
        end,
        kind: "affected manual section"
      }, lines.slice(heading.index, end).join("\n"));
    }
  }
  return scope;
}
/**
 * Paths and bounds, plus the verbatim text of a user-visible string.
 * Other source content stays in tool output and is not copied into the prompt.
 */ export function renderProseRanges(ranges) {
  return ranges.map((r)=>{
    const line = `${r.file}:${r.start}-${r.end} — ${r.kind}`;
    return r.text ? `${line}: ${r.text}` : line;
  }).join("\n");
}
/** File extensions whose comments start with `#`, by language. */ const PYTHON_EXT_RE = /\.pyi?$/i;
const SHELL_EXT_RE = /\.(?:sh|bash|bats|zsh|rb)$/i;
const RUST_EXT_RE = /\.rs$/i;
/** The lexing rules for a test file, chosen by its extension. */ function langFor(path) {
  if (RUST_EXT_RE.test(path)) return "rust";
  if (/\.sql$/i.test(path)) return "sql";
  if (PYTHON_EXT_RE.test(path)) return "python";
  if (SHELL_EXT_RE.test(path)) return "shell";
  return "c";
}
/** Whether `ch` can be part of an identifier. */ function isIdentChar(ch) {
  return ch !== undefined && /[\w$]/.test(ch);
}
/** A template literal resumed at the `}` that closes its `${…}` substitution. */ const TEMPLATE = {
  close: "`",
  escapes: true,
  multiline: true
};
/**
 * Lex a side's lines with a manual character loop (linear time, no regex
 * over the whole text). Line comments, block comments and string contents
 * are blanked in `code`; comments alone are removed in `stripped`. In the
 * C-like rules a JS/TS regex literal is blanked like a string, so a quote
 * or backtick inside it does not open a phantom string that hides the
 * lines below (PR #3148 review), and a template literal's `${…}`
 * substitutions are lexed as code: a stack of brace depths resumes the
 * template at the `}` that closes each one, so a nested template or quote
 * inside a substitution cannot close the outer template early.
 * Lexing is a heuristic — an exotic string form can still mislead it.
 * {@link LexedSide.unterminatedFrom} marks a side that ends still inside a
 * string or block comment, which callers treat as not checked.
 */ function lexLines(lines, lang) {
  const out = [];
  let inBlockComment = false;
  let open = null;
  /** Line that opened the multi-line string or block comment now open. */ let openLine = -1;
  /** Brace depth outside each open `${`, and the line that opened it. */ const substitutions = [];
  let braceDepth = 0;
  const slashComments = lang === "rust" || lang === "c";
  // The last significant code token, carried across lines so a `/` that
  // opens a line continuing an expression (`a\n  / b`) stays division.
  let prev = {
    char: "",
    word: ""
  };
  for(let lineIndex = 0; lineIndex < lines.length; lineIndex++){
    const raw = lines[lineIndex].raw;
    let code = "";
    let stripped = "";
    let comment = "";
    const startsInside = inBlockComment || open !== null;
    let sawComment = inBlockComment;
    let sawCode = false;
    let i = 0;
    while(i < raw.length){
      const ch = raw[i];
      if (inBlockComment) {
        comment += ch;
        if (ch === "*" && raw[i + 1] === "/") {
          comment += "/";
          inBlockComment = false;
          code += "  ";
          i += 2;
        } else {
          code += " ";
          i++;
        }
        continue;
      }
      if (open) {
        sawCode = true;
        if (open.escapes && ch === "\\") {
          code += "  ";
          stripped += raw.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (raw.startsWith(open.close, i)) {
          code += open.close;
          stripped += open.close;
          i += open.close.length;
          open = null;
          prev = OPERAND;
          continue;
        }
        if (open === TEMPLATE && ch === "$" && raw[i + 1] === "{") {
          // A substitution is code until its matching `}`.
          substitutions.push({
            depth: braceDepth,
            line: lineIndex
          });
          code += "  ";
          stripped += "${";
          i += 2;
          open = null;
          prev = {
            char: "{",
            word: ""
          };
          continue;
        }
        code += " ";
        stripped += ch;
        i++;
        continue;
      }
      if (slashComments && ch === "/" && raw[i + 1] === "/") {
        sawComment = true;
        comment += raw.slice(i);
        break;
      }
      if ((slashComments || lang === "sql") && ch === "/" && raw[i + 1] === "*") {
        comment += "/*";
        sawComment = true;
        inBlockComment = true;
        openLine = lineIndex;
        code += "  ";
        i += 2;
        continue;
      }
      if (ch === "#" && (lang === "python" || lang === "shell" && (i === 0 || /\s/.test(raw[i - 1])))) {
        sawComment = true;
        comment += raw.slice(i);
        break;
      }
      if (lang === "sql" && ch === "-" && raw[i + 1] === "-") {
        sawComment = true;
        comment += raw.slice(i);
        break;
      }
      if (lang === "c" && ch === "/" && regexCanStart(prev)) {
        const end = regexLiteralEnd(raw, i);
        if (end !== -1) {
          sawCode = true;
          code += "/" + " ".repeat(end - i - 2) + "/";
          stripped += raw.slice(i, end);
          i = end;
          prev = OPERAND;
          continue;
        }
      }
      if (lang === "c" && (ch === "{" || ch === "}")) {
        const top = substitutions[substitutions.length - 1];
        if (ch === "}" && top !== undefined && top.depth === braceDepth) {
          // The `}` closing a `${…}`: the template literal resumes.
          substitutions.pop();
          sawCode = true;
          code += " ";
          stripped += ch;
          i++;
          open = TEMPLATE;
          continue;
        }
        braceDepth += ch === "{" ? 1 : -1;
      }
      const opened = openStringAt(raw, i, lang);
      if (opened) {
        sawCode = true;
        code += raw.slice(i, i + opened.length);
        stripped += raw.slice(i, i + opened.length);
        i += opened.length;
        open = opened.string.close === "`" && lang === "c" ? TEMPLATE : opened.string;
        if (open.multiline) openLine = lineIndex;
        prev = OPERAND;
        continue;
      }
      if (!/\s/.test(ch)) {
        sawCode = true;
        let word = "";
        if (isIdentChar(ch)) {
          // Capped: no keyword is longer, and a long identifier stays linear.
          const cont = i > 0 && isIdentChar(raw[i - 1]);
          word = !cont ? ch : prev.word.length > 10 ? prev.word : prev.word + ch;
        }
        prev = {
          char: ch,
          word
        };
      }
      code += ch;
      stripped += ch;
      i++;
    }
    if (open && !open.multiline) open = null;
    out.push({
      comment,
      code,
      stripped,
      commentOnly: sawComment && !sawCode,
      startsInside
    });
  }
  let unterminatedFrom = inBlockComment || open !== null ? openLine : -1;
  const outer = substitutions[0];
  if (outer !== undefined) {
    unterminatedFrom = unterminatedFrom === -1 ? outer.line : Math.min(unterminatedFrom, outer.line);
  }
  return {
    lines: out,
    unterminatedFrom
  };
}
/** Reuse the assertion scanner's language-aware lexer for prose selection. */ export function sourceProseLines(source, path) {
  return lexLines(source.split("\n").map((raw, seq)=>({
      raw,
      changed: false,
      seq
    })), langFor(path));
}
/**
 * String literals on each line. `stripped` keeps the characters inside the
 * quotes and `code` blanks them, so a quote-delimited run that differs
 * between the two is a literal. Comment blanks exist only in `code` and are
 * skipped. The return shape of {@link sourceProseLines} is unchanged.
 */ export function sourceStringLiterals(source, path) {
  const lexed = lexLines(source.split("\n").map((raw, seq)=>({
      raw,
      changed: false,
      seq
    })), langFor(path));
  const literals = [];
  for(let lineIndex = 0; lineIndex < lexed.lines.length; lineIndex++){
    const { code, stripped } = lexed.lines[lineIndex];
    let i = 0;
    let j = 0;
    while(i < code.length && j < stripped.length){
      if (code[i] !== stripped[j]) {
        // A comment is blanked in `code` and absent from `stripped`.
        if (code[i] === " ") i++;
        else {
          i++;
          j++;
        }
        continue;
      }
      const ch = stripped[j];
      if (ch !== '"' && ch !== "'" && ch !== "`") {
        i++;
        j++;
        continue;
      }
      const column = i + 1;
      i++;
      j++;
      let text = "";
      let closed = false;
      while(i < code.length && j < stripped.length){
        if (stripped.startsWith(ch, j) && code.startsWith(ch, i)) {
          literals.push({
            text,
            line: lineIndex + 1,
            column
          });
          i += ch.length;
          j += ch.length;
          closed = true;
          break;
        }
        text += stripped[j];
        i++;
        j++;
      }
      if (!closed) break;
    }
  }
  return literals;
}
/** A token after which a `/` is division: a closed string, regex or operand. */ const OPERAND = {
  char: ")",
  word: ""
};
/**
 * Punctuation after which an expression — so a regex literal — can begin:
 * opening brackets and separators, and every operator, including the `>` of
 * an arrow (`=> /`/.test(c)`) or a comparison (`a > /x/` cannot be a
 * division). After a postfix `++`/`--` a `/` divides, but a regex literal
 * must close on its line, so a misread there blanks at most one line's
 * slashes rather than opening a phantom string (PR #3148 review).
 */ const REGEX_PRECEDERS = new Set([
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  ">",
  "<",
  "+",
  "-",
  "*",
  "%",
  "^",
  "~"
]);
/** Keywords after which an expression — so a regex literal — can begin. */ const REGEX_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await"
]);
/**
 * Whether a `/` after `prev` opens a regex literal rather than dividing:
 * at the start of the file, after an operator or opening punctuation, or
 * after a keyword such as `return` or `typeof`.
 */ function regexCanStart(prev) {
  if (prev.char === "") return true;
  if (REGEX_PRECEDERS.has(prev.char)) return true;
  return prev.word !== "" && REGEX_KEYWORDS.has(prev.word);
}
/**
 * The index just past a single-line regex literal opening at `raw[i]` (its
 * closing `/` and any flags), or -1 when none closes on the line — then the
 * `/` is division after all, since a regex literal cannot span lines. A `/`
 * inside a `[…]` class or escaped with a backslash does not close it. `//`
 * and `/*` are comments, matched before this is called.
 */ function regexLiteralEnd(raw, i) {
  let inClass = false;
  for(let j = i + 1; j < raw.length; j++){
    const ch = raw[j];
    if (ch === "\\") {
      j++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "/") {
      let end = j + 1;
      while(end < raw.length && /[a-z]/i.test(raw[end]))end++;
      return end;
    }
  }
  return -1;
}
/** A string literal opening at `raw[i]`: how many chars open it, and its rules. */ function openStringAt(raw, i, lang) {
  const ch = raw[i];
  if (lang === "python") {
    if (ch === '"' || ch === "'") {
      const triple = ch.repeat(3);
      if (raw.startsWith(triple, i)) {
        return {
          length: 3,
          string: {
            close: triple,
            escapes: true,
            multiline: true
          }
        };
      }
      return {
        length: 1,
        string: {
          close: ch,
          escapes: true,
          multiline: false
        }
      };
    }
    return null;
  }
  if (lang === "shell") {
    if (ch === '"' || ch === "'") {
      return {
        length: 1,
        string: {
          close: ch,
          escapes: ch === '"',
          multiline: false
        }
      };
    }
    return null;
  }
  if (lang === "rust") {
    if ((ch === "r" || ch === "b") && !isIdentChar(raw[i - 1])) {
      // Raw string: r"…", r#"…"#, br#"…"#.
      let j = i + (ch === "b" && raw[i + 1] === "r" ? 2 : 1);
      if (ch === "b" && raw[i + 1] !== "r") return null;
      let hashes = 0;
      while(raw[j] === "#"){
        hashes++;
        j++;
      }
      if (raw[j] === '"') {
        return {
          length: j - i + 1,
          string: {
            close: '"' + "#".repeat(hashes),
            escapes: false,
            multiline: true
          }
        };
      }
      return null;
    }
    if (ch === '"') {
      return {
        length: 1,
        string: {
          close: '"',
          escapes: true,
          multiline: true
        }
      };
    }
    if (ch === "'") {
      // A char literal ('x', '\n', '\u{1F600}'), not a lifetime ('a).
      if (raw[i + 1] === "\\") {
        const close = raw.indexOf("'", i + 2);
        if (close !== -1 && close - i <= 12) {
          return {
            length: 1,
            string: {
              close: "'",
              escapes: true,
              multiline: false
            }
          };
        }
        return null;
      }
      if (raw[i + 2] === "'") {
        return {
          length: 1,
          string: {
            close: "'",
            escapes: true,
            multiline: false
          }
        };
      }
      return null;
    }
    return null;
  }
  // C-like: TypeScript, JavaScript, Go, Java, Kotlin, C#, Swift…
  if (ch === '"' || ch === "'") {
    return {
      length: 1,
      string: {
        close: ch,
        escapes: true,
        multiline: false
      }
    };
  }
  if (ch === "`") {
    return {
      length: 1,
      string: {
        close: "`",
        escapes: true,
        multiline: true
      }
    };
  }
  return null;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9kb2NfcHJvc2Vfc2NvcGUudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqIEJvdW5kZWQgcHJvc2UgYWZmZWN0ZWQgYnkgYSBicmFuY2ggb3IgcmV2aWV3LWZpeCBkaWZmIChJc3N1ZXMgIzM3MTUsICMzNzMxKS4gKi9cbmltcG9ydCB7XG4gIGlzTWFudWFsUHJvc2VQYXRoLFxuICBpc1Byb3NlU291cmNlUGF0aCxcbiAgTUFYX0RPQ19QUk9TRV9GSUxFUyxcbiAgc2VsZWN0TWFudWFsUHJvc2VGaWxlcyxcbn0gZnJvbSBcIi4vZG9jX3Byb3NlX2NsYWltcy50c1wiO1xuaW1wb3J0IHsgZ2l0aHViU2x1ZyB9IGZyb20gXCIuL21hcmtkb3duX2FuY2hvcnMudHNcIjtcbmltcG9ydCB7IG1hc2tNYXJrZG93bkNvZGUgfSBmcm9tIFwiLi9tYXJrZG93bl9jb2RlX3NwYW5zLnRzXCI7XG5cbi8qKiBDYXAgb24gdW5jaGFuZ2VkIHVzZXItdmlzaWJsZSBzdHJpbmdzIGFza2VkIGFib3V0IGluIG9uZSBydW4gKElzc3VlICM0MTk2KS4gKi9cbmNvbnN0IE1BWF9VU0VSX1ZJU0lCTEVfU1RSSU5HUyA9IDQwO1xuXG4vKiogQW4gaW5jbHVzaXZlLCBvbmUtYmFzZWQgcmFuZ2UgdGhlIG1vZGVsIGlzIGFza2VkIHRvIGNoZWNrLiAqL1xuZXhwb3J0IGludGVyZmFjZSBQcm9zZVJhbmdlIHtcbiAgZmlsZTogc3RyaW5nO1xuICBzdGFydDogbnVtYmVyO1xuICBlbmQ6IG51bWJlcjtcbiAga2luZDpcbiAgICB8IFwiY2hhbmdlZCBwcm9zZVwiXG4gICAgfCBcInNvdXJjZSBjb21tZW50XCJcbiAgICB8IFwiYWZmZWN0ZWQgbWFudWFsIHNlY3Rpb25cIlxuICAgIHwgXCJ1c2VyLXZpc2libGUgc3RyaW5nXCI7XG4gIC8qKiBWZXJiYXRpbSBsaXRlcmFsLCBwcmVzZW50IGZvciBhIHVzZXItdmlzaWJsZSBzdHJpbmcgc28gdGhlIHByb21wdCBjYW4gcXVvdGUgaXQuICovXG4gIHRleHQ/OiBzdHJpbmc7XG59XG5cbi8qKiBTZWxlY3RlZCB0ZXh0IGFsc28gY29uZmluZXMgY29uZmlybWF0aW9uIG9mIG1vZGVsIGZpbmRpbmdzIHRvIHRoZSBhY3R1YWwgc2NvcGUuICovXG5leHBvcnQgaW50ZXJmYWNlIERvY1Byb3NlU2NvcGUge1xuICBjb250ZW50czogTWFwPHN0cmluZywgc3RyaW5nPjtcbiAgcmFuZ2VzOiBQcm9zZVJhbmdlW107XG4gIG5vdENoZWNrZWQ6IHN0cmluZ1tdO1xuICAvKiogVGhlIGBub3RDaGVja2VkYCBlbnRyaWVzIGNhdXNlZCBieSB0aGUgZmlsZS9zZWN0aW9uIGNhcHMgKGEgc3Vic2V0IG9mIGBub3RDaGVja2VkYCkuICovXG4gIGNhcE92ZXJmbG93OiBzdHJpbmdbXTtcbn1cblxuLyoqXG4gKiBPbmUgd2FybmluZyBmb3IgZXZlcnkgY2FwLW92ZXJmbG93IG5vdGUgKElzc3VlcyAjNDExOCwgIzQxNzcpLlxuICogRW1wdHkgb3ZlcmZsb3cgcmV0dXJucyB1bmRlZmluZWQgc28gdGhlIGNhbGxlciBsb2dzIG5vdGhpbmcuXG4gKiBUaGUgZmlyc3QgdGhyZWUgbmFtZXMgYXJlIGxpc3RlZDsgdGhlIHJlc3QgYXJlIGEgY291bnQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXRDYXBPdmVyZmxvd1N1bW1hcnkoXG4gIHByZWZpeDogc3RyaW5nLFxuICBvdmVyZmxvdzogcmVhZG9ubHkgc3RyaW5nW10sXG4pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBpZiAob3ZlcmZsb3cubGVuZ3RoID09PSAwKSByZXR1cm4gdW5kZWZpbmVkO1xuICBjb25zdCBzaG93biA9IG92ZXJmbG93LnNsaWNlKDAsIDMpO1xuICBjb25zdCBtb3JlID0gb3ZlcmZsb3cubGVuZ3RoID4gc2hvd24ubGVuZ3RoXG4gICAgPyBgOyBhbmQgJHtvdmVyZmxvdy5sZW5ndGggLSBzaG93bi5sZW5ndGh9IG1vcmVgXG4gICAgOiBcIlwiO1xuICByZXR1cm4gYCR7cHJlZml4fTogJHtvdmVyZmxvdy5sZW5ndGh9IGRvYy1wcm9zZSByYW5nZShzKSBvdmVyIGEgY2FwLCBub3QgY2hlY2tlZCAoZmlyc3QgJHtzaG93bi5sZW5ndGh9KTogJHtcbiAgICBzaG93bi5qb2luKFwiOyBcIilcbiAgfSR7bW9yZX1gO1xufVxuXG4vKiogUGFyc2UgaGVhZC1zaWRlIGNoYW5nZWQgbGluZXMgZnJvbSBhIHplcm8tY29udGV4dCBnaXQgZGlmZi4gKi9cbmZ1bmN0aW9uIGNoYW5nZWRMaW5lcyhkaWZmOiBzdHJpbmcpOiBNYXA8c3RyaW5nLCBTZXQ8bnVtYmVyPj4ge1xuICBjb25zdCByZXN1bHQgPSBuZXcgTWFwPHN0cmluZywgU2V0PG51bWJlcj4+KCk7XG4gIGxldCBmaWxlID0gXCJcIjtcbiAgZm9yIChjb25zdCBsaW5lIG9mIGRpZmYuc3BsaXQoXCJcXG5cIikpIHtcbiAgICBpZiAobGluZS5zdGFydHNXaXRoKFwiKysrIGIvXCIpKSBmaWxlID0gbGluZS5zbGljZSg2KTtcbiAgICBjb25zdCBodW5rID0gL15AQCAtXFxkKyg/OixcXGQrKT8gXFwrKFxcZCspKD86LChcXGQrKSk/IEBALy5leGVjKGxpbmUpO1xuICAgIGlmICghaHVuayB8fCAhZmlsZSkgY29udGludWU7XG4gICAgY29uc3Qgc3RhcnQgPSBOdW1iZXIoaHVua1sxXSk7XG4gICAgY29uc3QgY291bnQgPSBodW5rWzJdID09PSB1bmRlZmluZWQgPyAxIDogTnVtYmVyKGh1bmtbMl0pO1xuICAgIGNvbnN0IGxpbmVzID0gcmVzdWx0LmdldChmaWxlKSA/PyBuZXcgU2V0PG51bWJlcj4oKTtcbiAgICAvLyBBIGRlbGV0aW9uIHN0aWxsIGNoYW5nZXMgaXRzIGVuY2xvc2luZyBkZWNsYXJhdGlvbi9zZWN0aW9uIGF0IHRoaXMgYm91bmRhcnkuXG4gICAgZm9yIChsZXQgaSA9IHN0YXJ0OyBpIDwgc3RhcnQgKyBNYXRoLm1heCgxLCBjb3VudCk7IGkrKykge1xuICAgICAgbGluZXMuYWRkKE1hdGgubWF4KDEsIGkpKTtcbiAgICB9XG4gICAgcmVzdWx0LnNldChmaWxlLCBsaW5lcyk7XG4gIH1cbiAgcmV0dXJuIHJlc3VsdDtcbn1cblxuLyoqIEVuZCBvZiB0aGUgZGVjbGFyYXRpb24gZm9sbG93aW5nIGEgY29tbWVudCwgdXNpbmcgbWFza2VkIGNvZGUgZm9yIGJyYWNlcy4gKi9cbmZ1bmN0aW9uIGRlY2xhcmF0aW9uRW5kKGNvZGU6IHJlYWRvbmx5IHN0cmluZ1tdLCBzdGFydDogbnVtYmVyKTogbnVtYmVyIHtcbiAgY29uc3QgaW5kZW50ID0gY29kZVtzdGFydF0/LnNlYXJjaCgvXFxTLykgPz8gMDtcbiAgbGV0IGJyYWNlcyA9IDA7XG4gIGxldCBwYXJlbnMgPSAwO1xuICBsZXQgYnJhY2tldHMgPSAwO1xuICBsZXQgb3BlbmVkID0gZmFsc2U7XG4gIGZvciAobGV0IGkgPSBzdGFydDsgaSA8IGNvZGUubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBsaW5lID0gY29kZVtpXSE7XG4gICAgaWYgKFxuICAgICAgaSA+IHN0YXJ0ICYmICFvcGVuZWQgJiYgbGluZS50cmltKCkgJiYgbGluZS5zZWFyY2goL1xcUy8pIDw9IGluZGVudCAmJlxuICAgICAgL14oPzpleHBvcnR8cHVifGZ1bmN0aW9ufGNsYXNzfGRlZnxmbnxjb25zdHxsZXR8dmFyKVxcYi8udGVzdChsaW5lLnRyaW0oKSlcbiAgICApIHJldHVybiBpIC0gMTtcbiAgICBmb3IgKGNvbnN0IGNoYXIgb2YgbGluZSkge1xuICAgICAgaWYgKGNoYXIgPT09IFwiKFwiKSBwYXJlbnMrKztcbiAgICAgIGlmIChjaGFyID09PSBcIilcIikgcGFyZW5zLS07XG4gICAgICBpZiAoY2hhciA9PT0gXCJbXCIpIGJyYWNrZXRzKys7XG4gICAgICBpZiAoY2hhciA9PT0gXCJdXCIpIGJyYWNrZXRzLS07XG4gICAgICBpZiAoY2hhciA9PT0gXCJ7XCIpIHtcbiAgICAgICAgb3BlbmVkID0gdHJ1ZTtcbiAgICAgICAgYnJhY2VzKys7XG4gICAgICB9XG4gICAgICBpZiAoY2hhciA9PT0gXCJ9XCIpIGJyYWNlcy0tO1xuICAgIH1cbiAgICBpZiAob3BlbmVkICYmIGJyYWNlcyA9PT0gMCAmJiBwYXJlbnMgPT09IDAgJiYgYnJhY2tldHMgPT09IDApIHtcbiAgICAgIGxldCBuZXh0ID0gXCJcIjtcbiAgICAgIGZvciAobGV0IGogPSBpICsgMTsgaiA8IGNvZGUubGVuZ3RoOyBqKyspIHtcbiAgICAgICAgaWYgKGNvZGVbal0hLnRyaW0oKSkge1xuICAgICAgICAgIG5leHQgPSBjb2RlW2pdIS50cmltKCk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIC8vIEEgcGFyYW1ldGVyIG9yIHJldHVybi10eXBlIG9iamVjdCBpcyBub3QgdGhlIGRlY2xhcmF0aW9uIGJvZHkuXG4gICAgICBpZiAoIS9eKD86PT58Wyh7LD1dKS8udGVzdChuZXh0KSAmJiAvW307XVxccyokLy50ZXN0KGxpbmUpKSByZXR1cm4gaTtcbiAgICB9XG4gICAgaWYgKCFvcGVuZWQgJiYgcGFyZW5zID09PSAwICYmIGJyYWNrZXRzID09PSAwICYmIC87XFxzKiQvLnRlc3QobGluZSkpIHtcbiAgICAgIHJldHVybiBpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gY29kZS5sZW5ndGggLSAxO1xufVxuXG4vKipcbiAqIEEgY2hhbmdlZCBsaW5lIHdob3NlIGJsYW5rZWQgY29kZSBhbHRlcnMgd2hpY2ggY2FzZSByZWFjaGVzIGV4aXN0aW5nIHRleHQ6XG4gKiBhIGNvbXBhcmlzb24sIGEgY2FzZSBvciBtYXRjaCBhcm0sIGFuIGlmIC8gZWxzZS1pZiAvIHRlcm5hcnksIG9yIGFuXG4gKiBhbGxvd2VkLXZhbHVlIGFycmF5IG9yIHNldC5cbiAqL1xuZnVuY3Rpb24gaXNDb25kaXRpb25Db2RlKGNvZGU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBzY2FuID0gY29kZS5yZXBsYWNlKC89Pi9nLCBcIiAgXCIpLnJlcGxhY2UoLy0+L2csIFwiICBcIik7XG4gIGlmICgvPD18Pj18PT09fCE9PXw9PXwhPS8udGVzdChzY2FuKSkgcmV0dXJuIHRydWU7XG4gIGlmICgvKD86XnxbXjw+PSFdKTwoPyFbPD1dKS8udGVzdChzY2FuKSkgcmV0dXJuIHRydWU7XG4gIGlmICgvKD86XnxbXjw+PSEtXSk+KD8hWz49XSkvLnRlc3Qoc2NhbikpIHJldHVybiB0cnVlO1xuICBpZiAoL1xcYig/OmNhc2V8bWF0Y2gpXFxiLy50ZXN0KHNjYW4pKSByZXR1cm4gdHJ1ZTtcbiAgaWYgKC9cXGJpZlxcYi8udGVzdChzY2FuKSB8fCAvXFxiZWxzZVxccytpZlxcYi8udGVzdChzY2FuKSkgcmV0dXJuIHRydWU7XG4gIGlmICgvXFw/KD8hWy4/XSkvLnRlc3Qoc2NhbikpIHJldHVybiB0cnVlO1xuICBpZiAoL25ld1xccytTZXRcXHMqXFwoLy50ZXN0KHNjYW4pKSByZXR1cm4gdHJ1ZTtcbiAgaWYgKFxuICAgIC9cXFtbXlxcXVxcbl0qXFxdLy50ZXN0KHNjYW4pICYmXG4gICAgL1xcYig/OmFsbG93ZWR8YWxsb3dsaXN0fGluY2x1ZGVzfGhhcylcXGIvLnRlc3Qoc2NhbilcbiAgKSByZXR1cm4gdHJ1ZTtcbiAgcmV0dXJuIGZhbHNlO1xufVxuXG4vKiogTmVhcmVzdCBpbmRlbnQtMCBkZWNsYXJhdGlvbiB0aGF0IGNvbnRhaW5zIGBsaW5lSW5kZXhgLCBpZiB0aGVyZSBpcyBvbmUuICovXG5mdW5jdGlvbiBlbmNsb3NpbmdEZWNsYXJhdGlvbihcbiAgY29kZTogcmVhZG9ubHkgc3RyaW5nW10sXG4gIGxpbmVJbmRleDogbnVtYmVyLFxuKTogeyBzdGFydDogbnVtYmVyOyBlbmQ6IG51bWJlciB9IHwgdW5kZWZpbmVkIHtcbiAgZm9yIChsZXQgaSA9IGxpbmVJbmRleDsgaSA+PSAwOyBpLS0pIHtcbiAgICBjb25zdCBsaW5lID0gY29kZVtpXSE7XG4gICAgaWYgKCFsaW5lLnRyaW0oKSB8fCBsaW5lLnNlYXJjaCgvXFxTLykgIT09IDApIGNvbnRpbnVlO1xuICAgIGlmIChcbiAgICAgICEvXig/OmV4cG9ydFxccyspPyg/OmRlZmF1bHRcXHMrKT8oPzphc3luY1xccyspPyg/OmZ1bmN0aW9ufGNsYXNzfGludGVyZmFjZXx0eXBlfGVudW18Y29uc3R8bGV0fHZhcnxmbnxzdHJ1Y3R8aW1wbClcXGIvXG4gICAgICAgIC50ZXN0KGxpbmUudHJpbSgpKVxuICAgICkgY29udGludWU7XG4gICAgY29uc3QgZW5kID0gZGVjbGFyYXRpb25FbmQoY29kZSwgaSk7XG4gICAgaWYgKGxpbmVJbmRleCA8PSBlbmQpIHJldHVybiB7IHN0YXJ0OiBpLCBlbmQgfTtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbi8qKiBBZGRlZCBhbmQgcmVtb3ZlZCBsaW5lIHRleHQgcGVyIGZpbGUsIGZyb20gYSB1bmlmaWVkIGRpZmYuICovXG5mdW5jdGlvbiBkaWZmTGluZVNpZGVzKFxuICBkaWZmOiBzdHJpbmcsXG4pOiBNYXA8c3RyaW5nLCB7IGFkZGVkOiBzdHJpbmdbXTsgcmVtb3ZlZDogc3RyaW5nW10gfT4ge1xuICBjb25zdCBzaWRlcyA9IG5ldyBNYXA8c3RyaW5nLCB7IGFkZGVkOiBzdHJpbmdbXTsgcmVtb3ZlZDogc3RyaW5nW10gfT4oKTtcbiAgbGV0IGZpbGUgPSBcIlwiO1xuICBmb3IgKGNvbnN0IGxpbmUgb2YgZGlmZi5zcGxpdChcIlxcblwiKSkge1xuICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoXCIrKysgYi9cIikpIHtcbiAgICAgIGZpbGUgPSBsaW5lLnNsaWNlKDYpO1xuICAgICAgaWYgKCFzaWRlcy5oYXMoZmlsZSkpIHNpZGVzLnNldChmaWxlLCB7IGFkZGVkOiBbXSwgcmVtb3ZlZDogW10gfSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKCFmaWxlKSBjb250aW51ZTtcbiAgICBpZiAobGluZS5zdGFydHNXaXRoKFwiK1wiKSAmJiAhbGluZS5zdGFydHNXaXRoKFwiKysrXCIpKSB7XG4gICAgICBzaWRlcy5nZXQoZmlsZSkhLmFkZGVkLnB1c2gobGluZS5zbGljZSgxKSk7XG4gICAgfSBlbHNlIGlmIChsaW5lLnN0YXJ0c1dpdGgoXCItXCIpICYmICFsaW5lLnN0YXJ0c1dpdGgoXCItLS1cIikpIHtcbiAgICAgIHNpZGVzLmdldChmaWxlKSEucmVtb3ZlZC5wdXNoKGxpbmUuc2xpY2UoMSkpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gc2lkZXM7XG59XG5cbi8qKiBgbmFtZShgIGNhbGxzIGFuZCBgPE5hbWVgIGVsZW1lbnRzIG9uIHRoZXNlIGRpZmYgbGluZXMuICovXG5mdW5jdGlvbiBjYWxsZWROYW1lcyhsaW5lczogcmVhZG9ubHkgc3RyaW5nW10pOiBTZXQ8c3RyaW5nPiB7XG4gIGNvbnN0IG5hbWVzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuICAgIGZvciAoY29uc3QgbWF0Y2ggb2YgbGluZS5tYXRjaEFsbCgvXFxiKFtBLVphLXpfJF1bXFx3JF0qKVxccypcXCgvZykpIHtcbiAgICAgIG5hbWVzLmFkZChtYXRjaFsxXSEpO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IG1hdGNoIG9mIGxpbmUubWF0Y2hBbGwoLzwoW0EtWl1bXFx3JF0qKVxcYi9nKSkge1xuICAgICAgbmFtZXMuYWRkKG1hdGNoWzFdISk7XG4gICAgfVxuICB9XG4gIHJldHVybiBuYW1lcztcbn1cblxuLyoqXG4gKiBJbmRlbnQtMCBkZWNsYXJhdGlvbiBrZXl3b3JkIGFuZCB0aGUgbmFtZSB0aGF0IGZvbGxvd3MgaXQuXG4gKiBUaGUgbmFtZSBpcyBjb21wYXJlZCBhcyB0ZXh0LiBBIHJlZ2V4IGJ1aWx0IGZyb20gYG5hbWVgIGlzIHdoYXRcbiAqIHNlbWdyZXAncyBkZXRlY3Qtbm9uLWxpdGVyYWwtcmVnZXhwIHJ1bGUgcmVqZWN0cy5cbiAqL1xuY29uc3QgVE9QX0xFVkVMX05BTUVEX0RFQ0xBUkFUSU9OID1cbiAgL14oPzpleHBvcnRcXHMrKT8oPzpkZWZhdWx0XFxzKyk/KD86YXN5bmNcXHMrKT8oPzpmdW5jdGlvblxcKj98Y2xhc3N8Y29uc3R8bGV0fHZhcilcXHMrKFtBLVphLXpfJF1bXFx3JF0qKVxcYi87XG5cbmZ1bmN0aW9uIHRvcExldmVsRGVjbGFyYXRpb25JbmRleChcbiAgc291cmNlOiBzdHJpbmcsXG4gIG5hbWU6IHN0cmluZyxcbik6IG51bWJlciB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IGxpbmVzID0gc291cmNlLnNwbGl0KFwiXFxuXCIpO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGxpbmVzLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgbGluZSA9IGxpbmVzW2ldITtcbiAgICBpZiAobGluZS5zZWFyY2goL1xcUy8pICE9PSAwKSBjb250aW51ZTtcbiAgICBjb25zdCBkZWNsYXJlZCA9IGxpbmUudHJpbSgpLm1hdGNoKFRPUF9MRVZFTF9OQU1FRF9ERUNMQVJBVElPTik/LlsxXTtcbiAgICBpZiAoZGVjbGFyZWQgPT09IG5hbWUpIHJldHVybiBpO1xuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIHJlbGF0aXZlSW1wb3J0U3BlY2lmaWVyKFxuICBzb3VyY2U6IHN0cmluZyxcbiAgbmFtZTogc3RyaW5nLFxuKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgZm9yIChcbiAgICBjb25zdCBtYXRjaCBvZiBzb3VyY2UubWF0Y2hBbGwoXG4gICAgICAvaW1wb3J0XFxzKyg/OnR5cGVcXHMrKT8oW147XCInXSs/KVxccytmcm9tXFxzK1tcIiddKFxcLlteXCInXSspW1wiJ10vZyxcbiAgICApXG4gICkge1xuICAgIGNvbnN0IGNsYXVzZSA9IG1hdGNoWzFdIS50cmltKCk7XG4gICAgY29uc3Qgc3BlYyA9IG1hdGNoWzJdITtcbiAgICBpZiAoY2xhdXNlID09PSBuYW1lKSByZXR1cm4gc3BlYztcbiAgICBjb25zdCBicmFjZSA9IC9cXHsoW159XSopXFx9Ly5leGVjKGNsYXVzZSk7XG4gICAgaWYgKCFicmFjZSkgY29udGludWU7XG4gICAgZm9yIChjb25zdCBwYXJ0IG9mIGJyYWNlWzFdIS5zcGxpdChcIixcIikpIHtcbiAgICAgIGNvbnN0IGJpdHMgPSBwYXJ0LnRyaW0oKS5zcGxpdCgvXFxzK2FzXFxzKy8pO1xuICAgICAgY29uc3QgbG9jYWwgPSAoYml0cy5sZW5ndGggPT09IDIgPyBiaXRzWzFdIDogYml0c1swXSk/LnRyaW0oKTtcbiAgICAgIGlmIChsb2NhbCA9PT0gbmFtZSkgcmV0dXJuIHNwZWM7XG4gICAgfVxuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIGpvaW5SZWxhdGl2ZShmcm9tRmlsZTogc3RyaW5nLCBzcGVjOiBzdHJpbmcpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBjb25zdCBiYXNlID0gZnJvbUZpbGUuaW5jbHVkZXMoXCIvXCIpXG4gICAgPyBmcm9tRmlsZS5zbGljZSgwLCBmcm9tRmlsZS5sYXN0SW5kZXhPZihcIi9cIikgKyAxKVxuICAgIDogXCJcIjtcbiAgY29uc3Qgb3V0OiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IHBhcnQgb2YgYCR7YmFzZX0ke3NwZWN9YC5zcGxpdChcIi9cIikpIHtcbiAgICBpZiAocGFydCA9PT0gXCJcIiB8fCBwYXJ0ID09PSBcIi5cIikgY29udGludWU7XG4gICAgaWYgKHBhcnQgPT09IFwiLi5cIikge1xuICAgICAgaWYgKG91dC5sZW5ndGggPT09IDApIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICBvdXQucG9wKCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgb3V0LnB1c2gocGFydCk7XG4gIH1cbiAgY29uc3Qgam9pbmVkID0gb3V0LmpvaW4oXCIvXCIpO1xuICByZXR1cm4gam9pbmVkID09PSBcIlwiID8gdW5kZWZpbmVkIDogam9pbmVkO1xufVxuXG4vLyBTSU1QTEUtT04tUFVSUE9TRTogc2FtZSBmaWxlIG9yIG9uZSByZWxhdGl2ZSBpbXBvcnQgaG9wIOKAlCB1cGdyYWRlIHdoZW4gYSBtaXNzZWQgbGFiZWwgaXMgdHJhY2VkIHRvIGEgYmFycmVsIG9yIHBhY2thZ2UgcmUtZXhwb3J0XG5hc3luYyBmdW5jdGlvbiByZXNvbHZlQ2FsbGVkRGVjbGFyYXRpb24oXG4gIGNhbGxlckZpbGU6IHN0cmluZyxcbiAgY2FsbGVyU291cmNlOiBzdHJpbmcsXG4gIG5hbWU6IHN0cmluZyxcbiAgcmVhZDogKGZpbGU6IHN0cmluZykgPT4gUHJvbWlzZTxzdHJpbmcgfCB1bmRlZmluZWQ+LFxuKTogUHJvbWlzZTx7IGZpbGU6IHN0cmluZzsgY29udGVudDogc3RyaW5nIH0gfCB1bmRlZmluZWQ+IHtcbiAgaWYgKHRvcExldmVsRGVjbGFyYXRpb25JbmRleChjYWxsZXJTb3VyY2UsIG5hbWUpICE9PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4geyBmaWxlOiBjYWxsZXJGaWxlLCBjb250ZW50OiBjYWxsZXJTb3VyY2UgfTtcbiAgfVxuICBjb25zdCBzcGVjID0gcmVsYXRpdmVJbXBvcnRTcGVjaWZpZXIoY2FsbGVyU291cmNlLCBuYW1lKTtcbiAgaWYgKHNwZWMgPT09IHVuZGVmaW5lZCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgY29uc3Qgam9pbmVkID0gam9pblJlbGF0aXZlKGNhbGxlckZpbGUsIHNwZWMpO1xuICBpZiAoam9pbmVkID09PSB1bmRlZmluZWQpIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IGhhc0V4dCA9IC9cXC5bQS1aYS16XSskLy50ZXN0KGpvaW5lZCk7XG4gIGNvbnN0IGNhbmRpZGF0ZXMgPSBoYXNFeHQgPyBbam9pbmVkXSA6IFtcbiAgICBgJHtqb2luZWR9LnRzYCxcbiAgICBgJHtqb2luZWR9LnRzeGAsXG4gICAgYCR7am9pbmVkfS5qc2AsXG4gICAgYCR7am9pbmVkfS5qc3hgLFxuICAgIGpvaW5lZCxcbiAgXTtcbiAgZm9yIChjb25zdCBjYW5kaWRhdGUgb2YgY2FuZGlkYXRlcykge1xuICAgIGlmICghaXNQcm9zZVNvdXJjZVBhdGgoY2FuZGlkYXRlKSkgY29udGludWU7XG4gICAgY29uc3QgY29udGVudCA9IGF3YWl0IHJlYWQoY2FuZGlkYXRlKTtcbiAgICBpZiAoXG4gICAgICBjb250ZW50ICE9PSB1bmRlZmluZWQgJiZcbiAgICAgIHRvcExldmVsRGVjbGFyYXRpb25JbmRleChjb250ZW50LCBuYW1lKSAhPT0gdW5kZWZpbmVkXG4gICAgKSB7XG4gICAgICByZXR1cm4geyBmaWxlOiBjYW5kaWRhdGUsIGNvbnRlbnQgfTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn1cblxuLy8gU0lNUExFLU9OLVBVUlBPU0U6IHR3by13b3JkIGhldXJpc3RpYyDigJQgdXBncmFkZSB3aGVuIGEgc2luZ2xlLXdvcmQgdXNlci12aXNpYmxlIGxhYmVsIGlzIG1pc3NlZCBpbiBhIHJlYWwgUFJcbmZ1bmN0aW9uIGlzVXNlclZpc2libGVMaXRlcmFsKHRleHQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCB0cmltbWVkID0gdGV4dC50cmltKCk7XG4gIGNvbnN0IHdvcmRzID0gdHJpbW1lZC5zcGxpdCgvXFxzKy8pLmZpbHRlcigod29yZCkgPT4gL1tBLVphLXpdLy50ZXN0KHdvcmQpKTtcbiAgaWYgKHdvcmRzLmxlbmd0aCA8IDIpIHJldHVybiBmYWxzZTtcbiAgaWYgKC9bL1xcXFxdLy50ZXN0KHRyaW1tZWQpKSByZXR1cm4gZmFsc2U7XG4gIGlmICgvJVtzZGlmXXxcXHtbMC05XStcXH18XFwkXFx7Ly50ZXN0KHRyaW1tZWQpKSByZXR1cm4gZmFsc2U7XG4gIGlmICh0cmltbWVkLnN0YXJ0c1dpdGgoXCIvXCIpIHx8IC9cXFxcW2R3c10vLnRlc3QodHJpbW1lZCkpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbi8qKiBCdWlsZCB0aGUgcHJvc2Ugc2NvcGUgdGhlIHJldmlldy1maXggZHJpZnQgY2hlY2sgYXNrcyBhYm91dC4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjb2xsZWN0RG9jUHJvc2VTY29wZShpbnB1dDoge1xuICBjaGFuZ2VkRmlsZXM6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICB0cmFja2VkRmlsZXM6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICBzdW1tYXJ5Q29udGVudDogc3RyaW5nO1xuICBkaWZmOiBzdHJpbmcgfCBudWxsO1xuICB1bnRyYWNrZWRGaWxlcz86IHJlYWRvbmx5IHN0cmluZ1tdO1xuICByZWFkRmlsZTogKGZpbGU6IHN0cmluZykgPT4gUHJvbWlzZTxzdHJpbmcgfCB1bmRlZmluZWQ+O1xuICBmaWxlQ2FwPzogbnVtYmVyO1xuICBzZWN0aW9uQ2FwPzogbnVtYmVyO1xufSk6IFByb21pc2U8RG9jUHJvc2VTY29wZT4ge1xuICBjb25zdCBmaWxlQ2FwID0gaW5wdXQuZmlsZUNhcCA/PyBNQVhfRE9DX1BST1NFX0ZJTEVTO1xuICBjb25zdCBzZWN0aW9uQ2FwID0gaW5wdXQuc2VjdGlvbkNhcCA/PyA0MDtcbiAgaWYgKFxuICAgICFOdW1iZXIuaXNJbnRlZ2VyKGZpbGVDYXApIHx8IGZpbGVDYXAgPCAwIHx8XG4gICAgIU51bWJlci5pc0ludGVnZXIoc2VjdGlvbkNhcCkgfHwgc2VjdGlvbkNhcCA8IDBcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiUHJvc2Ugc2NvcGUgY2FwcyBtdXN0IGJlIG5vbi1uZWdhdGl2ZSBpbnRlZ2Vyc1wiKTtcbiAgfVxuICBjb25zdCBzY29wZTogRG9jUHJvc2VTY29wZSA9IHtcbiAgICBjb250ZW50czogbmV3IE1hcCgpLFxuICAgIHJhbmdlczogW10sXG4gICAgbm90Q2hlY2tlZDogW10sXG4gICAgY2FwT3ZlcmZsb3c6IFtdLFxuICB9O1xuICBjb25zdCBjaGFuZ2VkID0gY2hhbmdlZExpbmVzKGlucHV0LmRpZmYgPz8gXCJcIik7XG4gIGNvbnN0IGxpbmVTaWRlcyA9IGRpZmZMaW5lU2lkZXMoaW5wdXQuZGlmZiA/PyBcIlwiKTtcbiAgY29uc3Qgc3RyaW5nQ2FuZGlkYXRlczogQXJyYXk8eyBmaWxlOiBzdHJpbmc7IGxpbmU6IG51bWJlcjsgdGV4dDogc3RyaW5nIH0+ID1cbiAgICBbXTtcbiAgY29uc3Qgc2VlblN0cmluZ3MgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgY29uc3QgcHVzaFN0cmluZyA9IChmaWxlOiBzdHJpbmcsIGxpbmU6IG51bWJlciwgdGV4dDogc3RyaW5nKSA9PiB7XG4gICAgY29uc3Qga2V5ID0gYCR7ZmlsZX06JHtsaW5lfToke3RleHR9YDtcbiAgICBpZiAoc2VlblN0cmluZ3MuaGFzKGtleSkpIHJldHVybjtcbiAgICBzZWVuU3RyaW5ncy5hZGQoa2V5KTtcbiAgICBzdHJpbmdDYW5kaWRhdGVzLnB1c2goeyBmaWxlLCBsaW5lLCB0ZXh0IH0pO1xuICB9O1xuICBpZiAoaW5wdXQuZGlmZiA9PT0gbnVsbCkge1xuICAgIHNjb3BlLm5vdENoZWNrZWQucHVzaChcbiAgICAgIFwidGhlIHByb3NlIGRpZmYgY291bGQgbm90IGJlIHJlYWQ7IGNoYW5nZWQgbGluZXMgbm90IGNoZWNrZWQsIG5ldmVyIHBhc3NlZFwiLFxuICAgICk7XG4gIH1cbiAgY29uc3Qgc291cmNlcyA9IGlucHV0LmNoYW5nZWRGaWxlcy5maWx0ZXIoaXNQcm9zZVNvdXJjZVBhdGgpO1xuICBjb25zdCBpZGVudGlmaWVycyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBjb25zdCBtZW50aW9ucyA9IG5ldyBTZXQoXG4gICAgc291cmNlcy5mbGF0TWFwKChmKSA9PiBbZiwgZi5zbGljZShmLmxhc3RJbmRleE9mKFwiL1wiKSArIDEpXSksXG4gICk7XG4gIGNvbnN0IGNhY2hlZCA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmcgfCB1bmRlZmluZWQ+KCk7XG4gIGNvbnN0IHJlYWQgPSBhc3luYyAoZmlsZTogc3RyaW5nKSA9PiB7XG4gICAgaWYgKCFjYWNoZWQuaGFzKGZpbGUpKSBjYWNoZWQuc2V0KGZpbGUsIGF3YWl0IGlucHV0LnJlYWRGaWxlKGZpbGUpKTtcbiAgICByZXR1cm4gY2FjaGVkLmdldChmaWxlKTtcbiAgfTtcbiAgY29uc3QgYWRkID0gKHJhbmdlOiBQcm9zZVJhbmdlLCBjb250ZW50OiBzdHJpbmcpID0+IHtcbiAgICBpZiAoIXNjb3BlLmNvbnRlbnRzLmhhcyhyYW5nZS5maWxlKSAmJiBzY29wZS5jb250ZW50cy5zaXplID49IGZpbGVDYXApIHtcbiAgICAgIGNvbnN0IG5vdGUgPVxuICAgICAgICBgJHtyYW5nZS5maWxlfToke3JhbmdlLnN0YXJ0fS0ke3JhbmdlLmVuZH06IG92ZXIgdGhlICR7ZmlsZUNhcH0tZmlsZSBjYXA7IG5vdCBjaGVja2VkLCBuZXZlciBwYXNzZWRgO1xuICAgICAgc2NvcGUubm90Q2hlY2tlZC5wdXNoKG5vdGUpO1xuICAgICAgc2NvcGUuY2FwT3ZlcmZsb3cucHVzaChub3RlKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKFxuICAgICAgc2NvcGUucmFuZ2VzLnNvbWUoKHIpID0+XG4gICAgICAgIHIuZmlsZSA9PT0gcmFuZ2UuZmlsZSAmJiByLnN0YXJ0ID09PSByYW5nZS5zdGFydCAmJiByLmVuZCA9PT0gcmFuZ2UuZW5kXG4gICAgICApXG4gICAgKSByZXR1cm47XG4gICAgc2NvcGUucmFuZ2VzLnB1c2gocmFuZ2UpO1xuICAgIHNjb3BlLmNvbnRlbnRzLnNldChcbiAgICAgIHJhbmdlLmZpbGUsXG4gICAgICAoc2NvcGUuY29udGVudHMuZ2V0KHJhbmdlLmZpbGUpID8/IFwiXCIpICsgXCJcXG5cIiArIGNvbnRlbnQsXG4gICAgKTtcbiAgfTtcbiAgZm9yIChjb25zdCBmaWxlIG9mIFsuLi5uZXcgU2V0KGlucHV0LmNoYW5nZWRGaWxlcyldKSB7XG4gICAgaWYgKCFpc01hbnVhbFByb3NlUGF0aChmaWxlKSAmJiAhaXNQcm9zZVNvdXJjZVBhdGgoZmlsZSkpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGNvbnRlbnQgPSBhd2FpdCByZWFkKGZpbGUpO1xuICAgIGlmIChjb250ZW50ID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGlmIChpbnB1dC50cmFja2VkRmlsZXMuaW5jbHVkZXMoZmlsZSkpIHtcbiAgICAgICAgc2NvcGUubm90Q2hlY2tlZC5wdXNoKFxuICAgICAgICAgIGAke2ZpbGV9OiB0cmFja2VkIHByb3NlIGNvdWxkIG5vdCBiZSByZWFkOyBub3QgY2hlY2tlZCwgbmV2ZXIgcGFzc2VkYCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBsaW5lcyA9IGNvbnRlbnQuc3BsaXQoXCJcXG5cIik7XG4gICAgaWYgKGlzTWFudWFsUHJvc2VQYXRoKGZpbGUpKSB7XG4gICAgICAvLyBUaGUgbW9kZWwgcmVhZHMgdGhlIGRpZmYgZm9yIHRoaXMgb3JpZ2luYWwgc2NvcGUuIFRoZSBleHRyYSB1bmNoYW5nZWRcbiAgICAgIC8vIHNjb3BlIGJlbG93IGlzIGFsd2F5cyBuYXJyb3dlZCB0byBleHBsaWNpdCBoZWFkaW5nIHJhbmdlcy5cbiAgICAgIGFkZChcbiAgICAgICAgeyBmaWxlLCBzdGFydDogMSwgZW5kOiBsaW5lcy5sZW5ndGgsIGtpbmQ6IFwiY2hhbmdlZCBwcm9zZVwiIH0sXG4gICAgICAgIGNvbnRlbnQsXG4gICAgICApO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IHRvdWNoZWQgPSBpbnB1dC51bnRyYWNrZWRGaWxlcz8uaW5jbHVkZXMoZmlsZSlcbiAgICAgID8gbmV3IFNldChsaW5lcy5tYXAoKF8sIGkpID0+IGkgKyAxKSlcbiAgICAgIDogY2hhbmdlZC5nZXQoZmlsZSk7XG4gICAgaWYgKCF0b3VjaGVkKSB7XG4gICAgICBzY29wZS5ub3RDaGVja2VkLnB1c2goXG4gICAgICAgIGAke2ZpbGV9OiBjaGFuZ2VkIHNvdXJjZSBsaW5lcyB1bmF2YWlsYWJsZTsgbm90IGNoZWNrZWQsIG5ldmVyIHBhc3NlZGAsXG4gICAgICApO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IGxleGVkID0gc291cmNlUHJvc2VMaW5lcyhjb250ZW50LCBmaWxlKTtcbiAgICBpZiAobGV4ZWQudW50ZXJtaW5hdGVkRnJvbSA+PSAwKSB7XG4gICAgICBzY29wZS5ub3RDaGVja2VkLnB1c2goXG4gICAgICAgIGAke2ZpbGV9OiR7XG4gICAgICAgICAgbGV4ZWQudW50ZXJtaW5hdGVkRnJvbSArIDFcbiAgICAgICAgfTogdW50ZXJtaW5hdGVkIHNvdXJjZSBsaXRlcmFsL2NvbW1lbnQ7IG5vdCBjaGVja2VkLCBuZXZlciBwYXNzZWRgLFxuICAgICAgKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBjb2RlID0gbGV4ZWQubGluZXMubWFwKChsaW5lKSA9PiBsaW5lLmNvZGUpO1xuICAgIGNvbnN0IGZpcnN0Q29kZSA9IGNvZGUuZmluZEluZGV4KChsaW5lKSA9PiBsaW5lLnRyaW0oKSk7XG4gICAgY29uc3QgdG91Y2hlZExpbmVzID0gWy4uLnRvdWNoZWRdLnNvcnQoKGEsIGIpID0+IGEgLSBiKTtcbiAgICBjb25zdCBoYXNDaGFuZ2UgPSAoc3RhcnQ6IG51bWJlciwgZW5kOiBudW1iZXIpID0+IHtcbiAgICAgIGxldCBsbyA9IDAsIGhpID0gdG91Y2hlZExpbmVzLmxlbmd0aDtcbiAgICAgIHdoaWxlIChsbyA8IGhpKSB7XG4gICAgICAgIGNvbnN0IG1pZCA9IChsbyArIGhpKSA+Pj4gMTtcbiAgICAgICAgaWYgKHRvdWNoZWRMaW5lc1ttaWRdISA8IHN0YXJ0KSBsbyA9IG1pZCArIDE7XG4gICAgICAgIGVsc2UgaGkgPSBtaWQ7XG4gICAgICB9XG4gICAgICByZXR1cm4gbG8gPCB0b3VjaGVkTGluZXMubGVuZ3RoICYmIHRvdWNoZWRMaW5lc1tsb10hIDw9IGVuZDtcbiAgICB9O1xuICAgIGNvbnN0IGRlY2xhcmF0aW9uRW5kcyA9IG5ldyBNYXA8bnVtYmVyLCBudW1iZXI+KCk7XG4gICAgY29uc3QgZW5kT2YgPSAoc3RhcnQ6IG51bWJlcikgPT4ge1xuICAgICAgaWYgKCFkZWNsYXJhdGlvbkVuZHMuaGFzKHN0YXJ0KSkge1xuICAgICAgICBkZWNsYXJhdGlvbkVuZHMuc2V0KHN0YXJ0LCBkZWNsYXJhdGlvbkVuZChjb2RlLCBzdGFydCkpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIGRlY2xhcmF0aW9uRW5kcy5nZXQoc3RhcnQpITtcbiAgICB9O1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgY29kZS5sZW5ndGg7IGkrKykge1xuICAgICAgY29uc3QgZXhwb3J0ZWQgPVxuICAgICAgICAvXFxiKD86ZXhwb3J0XFxzKyg/OmRlZmF1bHRcXHMrKT8oPzphc3luY1xccyspPyg/OmZ1bmN0aW9ufGNsYXNzfGludGVyZmFjZXx0eXBlfGNvbnN0KXxwdWIoPzpcXChbXildKlxcKSk/XFxzKyg/OmFzeW5jXFxzKyk/KD86Zm58c3RydWN0fGVudW0pKVxccysoXFx3KykvXG4gICAgICAgICAgLmV4ZWMoY29kZVtpXSEpO1xuICAgICAgaWYgKFxuICAgICAgICBleHBvcnRlZCAmJlxuICAgICAgICBoYXNDaGFuZ2UoaSArIDEsIGVuZE9mKGkpICsgMSlcbiAgICAgICkgaWRlbnRpZmllcnMuYWRkKGV4cG9ydGVkWzFdISk7XG4gICAgICBpZiAoIWxleGVkLmxpbmVzW2ldIS5jb21tZW50LnRyaW0oKSkgY29udGludWU7XG4gICAgICBjb25zdCBzdGFydCA9IGk7XG4gICAgICB3aGlsZSAoXG4gICAgICAgIGkgKyAxIDwgbGluZXMubGVuZ3RoICYmIGxleGVkLmxpbmVzW2kgKyAxXSEuY29tbWVudC50cmltKCkgJiZcbiAgICAgICAgIWNvZGVbaSArIDFdIS50cmltKClcbiAgICAgICkgaSsrO1xuICAgICAgY29uc3QgZW5kID0gaTtcbiAgICAgIGxldCBuZXh0ID0gZW5kICsgMTtcbiAgICAgIHdoaWxlIChuZXh0IDwgbGluZXMubGVuZ3RoICYmICFjb2RlW25leHRdIS50cmltKCkpIG5leHQrKztcbiAgICAgIGNvbnN0IG1vZHVsZUhlYWRlciA9IGZpcnN0Q29kZSA9PT0gLTEgfHwgc3RhcnQgPD0gZmlyc3RDb2RlO1xuICAgICAgY29uc3QgYXR0YWNoZWQgPSAhY29kZVtzdGFydF0hLnRyaW0oKSAmJiBuZXh0IDwgbGluZXMubGVuZ3RoICYmXG4gICAgICAgIGhhc0NoYW5nZShuZXh0ICsgMSwgZW5kT2YobmV4dCkgKyAxKTtcbiAgICAgIGlmIChcbiAgICAgICAgbW9kdWxlSGVhZGVyIHx8IGF0dGFjaGVkIHx8XG4gICAgICAgIGhhc0NoYW5nZShzdGFydCArIDEsIGVuZCArIDEpXG4gICAgICApIHtcbiAgICAgICAgYWRkKFxuICAgICAgICAgIHsgZmlsZSwgc3RhcnQ6IHN0YXJ0ICsgMSwgZW5kOiBlbmQgKyAxLCBraW5kOiBcInNvdXJjZSBjb21tZW50XCIgfSxcbiAgICAgICAgICBsZXhlZC5saW5lcy5zbGljZShzdGFydCwgZW5kICsgMSkubWFwKChsaW5lKSA9PiBsaW5lLmNvbW1lbnQpLmpvaW4oXG4gICAgICAgICAgICBcIlxcblwiLFxuICAgICAgICAgICksXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IGxpdGVyYWxzID0gc291cmNlU3RyaW5nTGl0ZXJhbHMoY29udGVudCwgZmlsZSkuZmlsdGVyKChsaXRlcmFsKSA9PlxuICAgICAgaXNVc2VyVmlzaWJsZUxpdGVyYWwobGl0ZXJhbC50ZXh0KSAmJiAhdG91Y2hlZC5oYXMobGl0ZXJhbC5saW5lKVxuICAgICk7XG4gICAgY29uc3Qgc2VlbkluRmlsZSA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICAgIGZvciAoY29uc3QgaHVuayBvZiBbLi4udG91Y2hlZF0uc29ydCgoYSwgYikgPT4gYSAtIGIpKSB7XG4gICAgICBjb25zdCByb3cgPSBjb2RlW2h1bmsgLSAxXTtcbiAgICAgIGlmIChyb3cgPT09IHVuZGVmaW5lZCB8fCAhaXNDb25kaXRpb25Db2RlKHJvdykpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgZGVjbGFyYXRpb24gPSBlbmNsb3NpbmdEZWNsYXJhdGlvbihjb2RlLCBodW5rIC0gMSk7XG4gICAgICBmb3IgKGNvbnN0IGxpdGVyYWwgb2YgbGl0ZXJhbHMpIHtcbiAgICAgICAgY29uc3QgaW5zaWRlID0gZGVjbGFyYXRpb25cbiAgICAgICAgICA/IGxpdGVyYWwubGluZSA+PSBkZWNsYXJhdGlvbi5zdGFydCArIDEgJiZcbiAgICAgICAgICAgIGxpdGVyYWwubGluZSA8PSBkZWNsYXJhdGlvbi5lbmQgKyAxXG4gICAgICAgICAgOiBNYXRoLmFicyhsaXRlcmFsLmxpbmUgLSBodW5rKSA8PSAxNTtcbiAgICAgICAgaWYgKCFpbnNpZGUpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBrZXkgPSBgJHtsaXRlcmFsLmxpbmV9OiR7bGl0ZXJhbC50ZXh0fWA7XG4gICAgICAgIGlmIChzZWVuSW5GaWxlLmhhcyhrZXkpKSBjb250aW51ZTtcbiAgICAgICAgc2VlbkluRmlsZS5hZGQoa2V5KTtcbiAgICAgICAgcHVzaFN0cmluZyhmaWxlLCBsaXRlcmFsLmxpbmUsIGxpdGVyYWwudGV4dCk7XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IHNpZGVzID0gbGluZVNpZGVzLmdldChmaWxlKTtcbiAgICBpZiAoc2lkZXMpIHtcbiAgICAgIGNvbnN0IGFkZGVkTmFtZXMgPSBjYWxsZWROYW1lcyhzaWRlcy5hZGRlZCk7XG4gICAgICBjb25zdCByZW1vdmVkTmFtZXMgPSBjYWxsZWROYW1lcyhzaWRlcy5yZW1vdmVkKTtcbiAgICAgIGZvciAoY29uc3QgbmFtZSBvZiBhZGRlZE5hbWVzKSB7XG4gICAgICAgIGlmIChyZW1vdmVkTmFtZXMuaGFzKG5hbWUpKSBjb250aW51ZTtcbiAgICAgICAgY29uc3QgcmVzb2x2ZWQgPSBhd2FpdCByZXNvbHZlQ2FsbGVkRGVjbGFyYXRpb24oXG4gICAgICAgICAgZmlsZSxcbiAgICAgICAgICBjb250ZW50LFxuICAgICAgICAgIG5hbWUsXG4gICAgICAgICAgcmVhZCxcbiAgICAgICAgKTtcbiAgICAgICAgaWYgKCFyZXNvbHZlZCkgY29udGludWU7XG4gICAgICAgIGNvbnN0IGxleGVkRGVmID0gc291cmNlUHJvc2VMaW5lcyhyZXNvbHZlZC5jb250ZW50LCByZXNvbHZlZC5maWxlKTtcbiAgICAgICAgaWYgKGxleGVkRGVmLnVudGVybWluYXRlZEZyb20gPj0gMCkge1xuICAgICAgICAgIHNjb3BlLm5vdENoZWNrZWQucHVzaChcbiAgICAgICAgICAgIGAke3Jlc29sdmVkLmZpbGV9OiR7XG4gICAgICAgICAgICAgIGxleGVkRGVmLnVudGVybWluYXRlZEZyb20gKyAxXG4gICAgICAgICAgICB9OiB1bnRlcm1pbmF0ZWQgc291cmNlIGxpdGVyYWwvY29tbWVudDsgbm90IGNoZWNrZWQsIG5ldmVyIHBhc3NlZGAsXG4gICAgICAgICAgKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBzdGFydCA9IHRvcExldmVsRGVjbGFyYXRpb25JbmRleChyZXNvbHZlZC5jb250ZW50LCBuYW1lKTtcbiAgICAgICAgaWYgKHN0YXJ0ID09PSB1bmRlZmluZWQpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBkZWZDb2RlID0gbGV4ZWREZWYubGluZXMubWFwKChsaW5lKSA9PiBsaW5lLmNvZGUpO1xuICAgICAgICBjb25zdCBlbmQgPSBkZWNsYXJhdGlvbkVuZChkZWZDb2RlLCBzdGFydCk7XG4gICAgICAgIGNvbnN0IGNoYW5nZWRJbkRlZiA9IGNoYW5nZWQuZ2V0KHJlc29sdmVkLmZpbGUpID8/IG5ldyBTZXQ8bnVtYmVyPigpO1xuICAgICAgICBmb3IgKFxuICAgICAgICAgIGNvbnN0IGxpdGVyYWwgb2Ygc291cmNlU3RyaW5nTGl0ZXJhbHMocmVzb2x2ZWQuY29udGVudCwgcmVzb2x2ZWQuZmlsZSlcbiAgICAgICAgKSB7XG4gICAgICAgICAgaWYgKCFpc1VzZXJWaXNpYmxlTGl0ZXJhbChsaXRlcmFsLnRleHQpKSBjb250aW51ZTtcbiAgICAgICAgICBpZiAobGl0ZXJhbC5saW5lIDwgc3RhcnQgKyAxIHx8IGxpdGVyYWwubGluZSA+IGVuZCArIDEpIGNvbnRpbnVlO1xuICAgICAgICAgIGlmIChjaGFuZ2VkSW5EZWYuaGFzKGxpdGVyYWwubGluZSkpIGNvbnRpbnVlO1xuICAgICAgICAgIHB1c2hTdHJpbmcocmVzb2x2ZWQuZmlsZSwgbGl0ZXJhbC5saW5lLCBsaXRlcmFsLnRleHQpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG4gIGxldCBrZXB0U3RyaW5ncyA9IDA7XG4gIGZvciAoY29uc3QgY2FuZGlkYXRlIG9mIHN0cmluZ0NhbmRpZGF0ZXMpIHtcbiAgICBpZiAoa2VwdFN0cmluZ3MgPj0gTUFYX1VTRVJfVklTSUJMRV9TVFJJTkdTKSB7XG4gICAgICBjb25zdCBub3RlID1cbiAgICAgICAgYCR7Y2FuZGlkYXRlLmZpbGV9OiR7Y2FuZGlkYXRlLmxpbmV9OiB1c2VyLXZpc2libGUgc3RyaW5nIG92ZXIgdGhlIDQwLXN0cmluZyBjYXA7IG5vdCBjaGVja2VkLCBuZXZlciBwYXNzZWRgO1xuICAgICAgc2NvcGUubm90Q2hlY2tlZC5wdXNoKG5vdGUpO1xuICAgICAgc2NvcGUuY2FwT3ZlcmZsb3cucHVzaChub3RlKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBiZWZvcmUgPSBzY29wZS5yYW5nZXMubGVuZ3RoO1xuICAgIGFkZChcbiAgICAgIHtcbiAgICAgICAgZmlsZTogY2FuZGlkYXRlLmZpbGUsXG4gICAgICAgIHN0YXJ0OiBjYW5kaWRhdGUubGluZSxcbiAgICAgICAgZW5kOiBjYW5kaWRhdGUubGluZSxcbiAgICAgICAga2luZDogXCJ1c2VyLXZpc2libGUgc3RyaW5nXCIsXG4gICAgICAgIHRleHQ6IGNhbmRpZGF0ZS50ZXh0LFxuICAgICAgfSxcbiAgICAgIGNhbmRpZGF0ZS50ZXh0LFxuICAgICk7XG4gICAgaWYgKHNjb3BlLnJhbmdlcy5sZW5ndGggPiBiZWZvcmUpIGtlcHRTdHJpbmdzKys7XG4gIH1cbiAgZm9yIChjb25zdCBuYW1lIG9mIGlkZW50aWZpZXJzKSBtZW50aW9ucy5hZGQobmFtZSk7XG4gIC8vIEV4aXN0aW5nIHN1bW1hcmllcyBtYXkgbmFtZSBtYW51YWwgc2VjdGlvbnMuIFRyZWF0IHRob3NlIHJlZmVyZW5jZXMgb25seVxuICAvLyBhcyBib3VuZGVkIHNjb3BlIGhpbnRzOyBubyBEb2NzIHN3ZWVwIGVudHJ5IG9yIGZvcm1hdCBpcyByZXF1aXJlZC5cbiAgY29uc3QgbmFtZWQgPSBpbnB1dC5zdW1tYXJ5Q29udGVudC5zbGljZSgwLCA2NF8wMDApO1xuICBsZXQgc2VjdGlvbnMgPSAwO1xuICBmb3IgKFxuICAgIGNvbnN0IGZpbGUgb2Ygc2VsZWN0TWFudWFsUHJvc2VGaWxlcyhbXG4gICAgICAuLi5pbnB1dC50cmFja2VkRmlsZXMsXG4gICAgICAuLi5pbnB1dC5jaGFuZ2VkRmlsZXMsXG4gICAgXSwgTnVtYmVyLk1BWF9TQUZFX0lOVEVHRVIpLmZpbGVzXG4gICkge1xuICAgIGlmICghaXNNYW51YWxQcm9zZVBhdGgoZmlsZSkgfHwgZmlsZS5zdGFydHNXaXRoKFwiZG9jcy9hcmNoaXZlL1wiKSkgY29udGludWU7XG4gICAgY29uc3QgY29udGVudCA9IGF3YWl0IHJlYWQoZmlsZSk7XG4gICAgaWYgKGNvbnRlbnQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgaWYgKGlucHV0LnRyYWNrZWRGaWxlcy5pbmNsdWRlcyhmaWxlKSkge1xuICAgICAgICBzY29wZS5ub3RDaGVja2VkLnB1c2goXG4gICAgICAgICAgYCR7ZmlsZX06IG1hbnVhbCBjb3VsZCBub3QgYmUgcmVhZDsgbm90IGNoZWNrZWQsIG5ldmVyIHBhc3NlZGAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgbGluZXMgPSBjb250ZW50LnNwbGl0KFwiXFxuXCIpO1xuICAgIGNvbnN0IG1hc2tlZCA9IG1hc2tNYXJrZG93bkNvZGUoY29udGVudCkuc3BsaXQoXCJcXG5cIik7XG4gICAgY29uc3QgaGVhZGluZ3MgPSBtYXNrZWQuZmxhdE1hcCgobGluZSwgaSkgPT4ge1xuICAgICAgY29uc3QgbWF0Y2ggPSAvXiB7MCwzfSgjezEsNn0pXFxzKyguKz8pKD86XFxzKyMrKT9cXHMqJC8uZXhlYyhsaW5lKTtcbiAgICAgIHJldHVybiBtYXRjaFxuICAgICAgICA/IFt7XG4gICAgICAgICAgaW5kZXg6IGksXG4gICAgICAgICAgbGV2ZWw6IG1hdGNoWzFdIS5sZW5ndGgsXG4gICAgICAgICAgdGl0bGU6IGxpbmVzW2ldIS5yZXBsYWNlKC9eIHswLDN9I3sxLDZ9XFxzKy8sIFwiXCIpLnJlcGxhY2UoXG4gICAgICAgICAgICAvXFxzKyMrXFxzKiQvLFxuICAgICAgICAgICAgXCJcIixcbiAgICAgICAgICApLFxuICAgICAgICB9XVxuICAgICAgICA6IFtdO1xuICAgIH0pO1xuICAgIGlmIChoZWFkaW5ncy5sZW5ndGggPT09IDApIGhlYWRpbmdzLnB1c2goeyBpbmRleDogMCwgbGV2ZWw6IDEsIHRpdGxlOiBcIlwiIH0pO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgaGVhZGluZ3MubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IGhlYWRpbmcgPSBoZWFkaW5nc1tpXSE7XG4gICAgICBjb25zdCBsZWFmRW5kID0gaGVhZGluZ3NbaSArIDFdPy5pbmRleCA/PyBsaW5lcy5sZW5ndGg7XG4gICAgICBjb25zdCBzZWN0aW9uID0gbGluZXMuc2xpY2UoaGVhZGluZy5pbmRleCwgbGVhZkVuZCkuam9pbihcIlxcblwiKTtcbiAgICAgIGNvbnN0IHNsdWcgPSBnaXRodWJTbHVnKGhlYWRpbmcudGl0bGUpO1xuICAgICAgY29uc3QgZmlsZUF0ID0gbmFtZWQuaW5kZXhPZihmaWxlKTtcbiAgICAgIGNvbnN0IGRlc2NyaXB0b3IgPSBmaWxlQXQgPCAwXG4gICAgICAgID8gXCJcIlxuICAgICAgICA6IG5hbWVkLnNsaWNlKGZpbGVBdCArIGZpbGUubGVuZ3RoKS5zcGxpdCgvWyw7XS8sIDEpWzBdIS50cmltKCk7XG4gICAgICBjb25zdCBleHBsaWNpdCA9IGZpbGVBdCA+PSAwICYmIHNsdWcgIT09IFwiXCIgJiZcbiAgICAgICAgZ2l0aHViU2x1ZyhkZXNjcmlwdG9yKS5pbmNsdWRlcyhzbHVnKTtcbiAgICAgIGNvbnN0IHJlZmVyZW5jZWQgPSBbLi4ubWVudGlvbnNdLnNvbWUoKG5hbWUpID0+IHtcbiAgICAgICAgbGV0IGF0ID0gc2VjdGlvbi5pbmRleE9mKG5hbWUpO1xuICAgICAgICB3aGlsZSAoYXQgPj0gMCkge1xuICAgICAgICAgIGlmIChcbiAgICAgICAgICAgICEvW1xcdy8uLV0vLnRlc3Qoc2VjdGlvblthdCAtIDFdID8/IFwiXCIpICYmXG4gICAgICAgICAgICAhL1tcXHcvLi1dLy50ZXN0KHNlY3Rpb25bYXQgKyBuYW1lLmxlbmd0aF0gPz8gXCJcIilcbiAgICAgICAgICApIHJldHVybiB0cnVlO1xuICAgICAgICAgIGF0ID0gc2VjdGlvbi5pbmRleE9mKG5hbWUsIGF0ICsgbmFtZS5sZW5ndGgpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgIH0pO1xuICAgICAgaWYgKCFleHBsaWNpdCAmJiAhcmVmZXJlbmNlZCkgY29udGludWU7XG4gICAgICBjb25zdCBlbmQgPSBleHBsaWNpdFxuICAgICAgICA/IGhlYWRpbmdzLnNsaWNlKGkgKyAxKS5maW5kKChoKSA9PiBoLmxldmVsIDw9IGhlYWRpbmcubGV2ZWwpPy5pbmRleCA/P1xuICAgICAgICAgIGxpbmVzLmxlbmd0aFxuICAgICAgICA6IGxlYWZFbmQ7XG4gICAgICBpZiAoc2VjdGlvbnMrKyA+PSBzZWN0aW9uQ2FwKSB7XG4gICAgICAgIGNvbnN0IG5vdGUgPSBgJHtmaWxlfToke1xuICAgICAgICAgIGhlYWRpbmcuaW5kZXggKyAxXG4gICAgICAgIH0tJHtlbmR9OiBvdmVyIHRoZSAke3NlY3Rpb25DYXB9LXNlY3Rpb24gY2FwOyBub3QgY2hlY2tlZCwgbmV2ZXIgcGFzc2VkYDtcbiAgICAgICAgc2NvcGUubm90Q2hlY2tlZC5wdXNoKG5vdGUpO1xuICAgICAgICBzY29wZS5jYXBPdmVyZmxvdy5wdXNoKG5vdGUpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGFkZCh7XG4gICAgICAgIGZpbGUsXG4gICAgICAgIHN0YXJ0OiBoZWFkaW5nLmluZGV4ICsgMSxcbiAgICAgICAgZW5kLFxuICAgICAgICBraW5kOiBcImFmZmVjdGVkIG1hbnVhbCBzZWN0aW9uXCIsXG4gICAgICB9LCBsaW5lcy5zbGljZShoZWFkaW5nLmluZGV4LCBlbmQpLmpvaW4oXCJcXG5cIikpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gc2NvcGU7XG59XG5cbi8qKlxuICogUGF0aHMgYW5kIGJvdW5kcywgcGx1cyB0aGUgdmVyYmF0aW0gdGV4dCBvZiBhIHVzZXItdmlzaWJsZSBzdHJpbmcuXG4gKiBPdGhlciBzb3VyY2UgY29udGVudCBzdGF5cyBpbiB0b29sIG91dHB1dCBhbmQgaXMgbm90IGNvcGllZCBpbnRvIHRoZSBwcm9tcHQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJQcm9zZVJhbmdlcyhyYW5nZXM6IHJlYWRvbmx5IFByb3NlUmFuZ2VbXSk6IHN0cmluZyB7XG4gIHJldHVybiByYW5nZXMubWFwKChyKSA9PiB7XG4gICAgY29uc3QgbGluZSA9IGAke3IuZmlsZX06JHtyLnN0YXJ0fS0ke3IuZW5kfSDigJQgJHtyLmtpbmR9YDtcbiAgICByZXR1cm4gci50ZXh0ID8gYCR7bGluZX06ICR7ci50ZXh0fWAgOiBsaW5lO1xuICB9KS5qb2luKFwiXFxuXCIpO1xufVxuXG5pbnRlcmZhY2UgU2lkZUxpbmUge1xuICByYXc6IHN0cmluZztcbiAgLyoqIFRydWUgZm9yIGEgYC1gIGxpbmUgb24gdGhlIG9sZCBzaWRlIG9yIGEgYCtgIGxpbmUgb24gdGhlIG5ldyBzaWRlLiAqL1xuICBjaGFuZ2VkOiBib29sZWFuO1xuICAvKiogUG9zaXRpb24gb2YgdGhlIGxpbmUgaW4gdGhlIHBhdGNoLCBzaGFyZWQgYnkgYm90aCBzaWRlcy4gKi9cbiAgc2VxOiBudW1iZXI7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gU291cmNlIGxleGluZyDigJQgYmxhbmsgb3V0IGNvbW1lbnRzIGFuZCBzdHJpbmcgY29udGVudHMgYmVmb3JlIG1hdGNoaW5nXG4vLyAoQ09ESU5HLVNUQU5EQVJEUy5tZCDCpyBXcml0aW5nIGEgZ2F0ZSBvdmVyIHRleHQ6IFwiQSBnYXRlIHRoYXQgcmVhZHMgc291cmNlXG4vLyBjb2RlIGJsYW5rcyBvdXQgY29tbWVudHMgYW5kIGxpdGVyYWxzIGJlZm9yZSBpdCBtYXRjaGVzXCIpLlxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKiBDb21tZW50IGFuZCBzdHJpbmcgcnVsZXMgYSB0ZXN0IGZpbGUgaXMgbGV4ZWQgd2l0aC4gKi9cbnR5cGUgTGFuZyA9IFwicnVzdFwiIHwgXCJweXRob25cIiB8IFwic2hlbGxcIiB8IFwic3FsXCIgfCBcImNcIjtcblxuLyoqIEZpbGUgZXh0ZW5zaW9ucyB3aG9zZSBjb21tZW50cyBzdGFydCB3aXRoIGAjYCwgYnkgbGFuZ3VhZ2UuICovXG5jb25zdCBQWVRIT05fRVhUX1JFID0gL1xcLnB5aT8kL2k7XG5jb25zdCBTSEVMTF9FWFRfUkUgPSAvXFwuKD86c2h8YmFzaHxiYXRzfHpzaHxyYikkL2k7XG5jb25zdCBSVVNUX0VYVF9SRSA9IC9cXC5ycyQvaTtcblxuLyoqIFRoZSBsZXhpbmcgcnVsZXMgZm9yIGEgdGVzdCBmaWxlLCBjaG9zZW4gYnkgaXRzIGV4dGVuc2lvbi4gKi9cbmZ1bmN0aW9uIGxhbmdGb3IocGF0aDogc3RyaW5nKTogTGFuZyB7XG4gIGlmIChSVVNUX0VYVF9SRS50ZXN0KHBhdGgpKSByZXR1cm4gXCJydXN0XCI7XG4gIGlmICgvXFwuc3FsJC9pLnRlc3QocGF0aCkpIHJldHVybiBcInNxbFwiO1xuICBpZiAoUFlUSE9OX0VYVF9SRS50ZXN0KHBhdGgpKSByZXR1cm4gXCJweXRob25cIjtcbiAgaWYgKFNIRUxMX0VYVF9SRS50ZXN0KHBhdGgpKSByZXR1cm4gXCJzaGVsbFwiO1xuICByZXR1cm4gXCJjXCI7XG59XG5cbi8qKiBPbmUgbGV4ZWQgbGluZSBvZiBhIHNpZGUuICovXG5pbnRlcmZhY2UgTGV4ZWRMaW5lIHtcbiAgLyoqIE9yaWdpbmFsIGNvbW1lbnQgdGV4dCwgZXhjbHVkaW5nIGNvZGUgYW5kIHN0cmluZyBsaXRlcmFscy4gKi9cbiAgY29tbWVudDogc3RyaW5nO1xuICAvKiogVGhlIGxpbmUgd2l0aCBjb21tZW50cyBhbmQgc3RyaW5nIGNvbnRlbnRzIHJlcGxhY2VkIGJ5IHNwYWNlcy4gKi9cbiAgY29kZTogc3RyaW5nO1xuICAvKiogVGhlIGxpbmUgd2l0aCBjb21tZW50cyByZW1vdmVkIGFuZCBzdHJpbmdzIGtlcHQuICovXG4gIHN0cmlwcGVkOiBzdHJpbmc7XG4gIC8qKiBUcnVlIHdoZW4gdGhlIGxpbmUgaG9sZHMgYSBjb21tZW50IGFuZCBub3RoaW5nIGVsc2UuICovXG4gIGNvbW1lbnRPbmx5OiBib29sZWFuO1xuICAvKipcbiAgICogVHJ1ZSB3aGVuIHRoZSBsaW5lIGJlZ2FuIGluc2lkZSBhIHN0cmluZyBvciBibG9jayBjb21tZW50IGNhcnJpZWQgb3ZlclxuICAgKiBmcm9tIGFuIGVhcmxpZXIgbGluZSDigJQgdGhlIG9uZSBjYXNlIHdoZXJlIGEgbGV4ZXIgbWlzdGFrZSAoYSByZWdleFxuICAgKiBsaXRlcmFsIGhvbGRpbmcgYSBxdW90ZSwgc2F5KSBjYW4gaGlkZSBhIHdob2xlIGxpbmUuXG4gICAqL1xuICBzdGFydHNJbnNpZGU6IGJvb2xlYW47XG59XG5cbi8qKiBBbiBvcGVuIHN0cmluZyBsaXRlcmFsIGNhcnJpZWQgYmV0d2VlbiBjaGFyYWN0ZXJzIChhbmQgbGluZXMpLiAqL1xuaW50ZXJmYWNlIE9wZW5TdHJpbmcge1xuICBjbG9zZTogc3RyaW5nO1xuICBlc2NhcGVzOiBib29sZWFuO1xuICBtdWx0aWxpbmU6IGJvb2xlYW47XG59XG5cbi8qKiBXaGV0aGVyIGBjaGAgY2FuIGJlIHBhcnQgb2YgYW4gaWRlbnRpZmllci4gKi9cbmZ1bmN0aW9uIGlzSWRlbnRDaGFyKGNoOiBzdHJpbmcgfCB1bmRlZmluZWQpOiBib29sZWFuIHtcbiAgcmV0dXJuIGNoICE9PSB1bmRlZmluZWQgJiYgL1tcXHckXS8udGVzdChjaCk7XG59XG5cbi8qKiBBIHNpZGUncyBsZXhlZCBsaW5lcywgYW5kIHdoZXJlIGl0cyBsZXhlciB3YXMgbGVmdCBpbnNpZGUgYSBsaXRlcmFsLiAqL1xuaW50ZXJmYWNlIExleGVkU2lkZSB7XG4gIGxpbmVzOiBMZXhlZExpbmVbXTtcbiAgLyoqXG4gICAqIEluZGV4IG9mIHRoZSBsaW5lIHRoYXQgb3BlbmVkIHRoZSBzdHJpbmcsIHRlbXBsYXRlIGxpdGVyYWwsIGAke+KApn1gXG4gICAqIHN1YnN0aXR1dGlvbiBvciBibG9jayBjb21tZW50IHN0aWxsIG9wZW4gYXQgdGhlIGVuZCBvZiB0aGUgc2lkZSwgb3IgLTFcbiAgICogd2hlbiB0aGUgc2lkZSBlbmRzIGluIGNvZGUuIFZhbGlkIHNvdXJjZSBuZXZlciBlbmRzIGluc2lkZSBvbmUsIHNvIHRoaXNcbiAgICogbWFya3MgYSBsZXhlciBtaXN0YWtlIGZyb20gdGhhdCBsaW5lIG9uIChQUiAjMzE0OCByZXZpZXcpLlxuICAgKi9cbiAgdW50ZXJtaW5hdGVkRnJvbTogbnVtYmVyO1xufVxuXG4vKiogQSB0ZW1wbGF0ZSBsaXRlcmFsIHJlc3VtZWQgYXQgdGhlIGB9YCB0aGF0IGNsb3NlcyBpdHMgYCR74oCmfWAgc3Vic3RpdHV0aW9uLiAqL1xuY29uc3QgVEVNUExBVEU6IE9wZW5TdHJpbmcgPSB7IGNsb3NlOiBcImBcIiwgZXNjYXBlczogdHJ1ZSwgbXVsdGlsaW5lOiB0cnVlIH07XG5cbi8qKlxuICogTGV4IGEgc2lkZSdzIGxpbmVzIHdpdGggYSBtYW51YWwgY2hhcmFjdGVyIGxvb3AgKGxpbmVhciB0aW1lLCBubyByZWdleFxuICogb3ZlciB0aGUgd2hvbGUgdGV4dCkuIExpbmUgY29tbWVudHMsIGJsb2NrIGNvbW1lbnRzIGFuZCBzdHJpbmcgY29udGVudHNcbiAqIGFyZSBibGFua2VkIGluIGBjb2RlYDsgY29tbWVudHMgYWxvbmUgYXJlIHJlbW92ZWQgaW4gYHN0cmlwcGVkYC4gSW4gdGhlXG4gKiBDLWxpa2UgcnVsZXMgYSBKUy9UUyByZWdleCBsaXRlcmFsIGlzIGJsYW5rZWQgbGlrZSBhIHN0cmluZywgc28gYSBxdW90ZVxuICogb3IgYmFja3RpY2sgaW5zaWRlIGl0IGRvZXMgbm90IG9wZW4gYSBwaGFudG9tIHN0cmluZyB0aGF0IGhpZGVzIHRoZVxuICogbGluZXMgYmVsb3cgKFBSICMzMTQ4IHJldmlldyksIGFuZCBhIHRlbXBsYXRlIGxpdGVyYWwncyBgJHvigKZ9YFxuICogc3Vic3RpdHV0aW9ucyBhcmUgbGV4ZWQgYXMgY29kZTogYSBzdGFjayBvZiBicmFjZSBkZXB0aHMgcmVzdW1lcyB0aGVcbiAqIHRlbXBsYXRlIGF0IHRoZSBgfWAgdGhhdCBjbG9zZXMgZWFjaCBvbmUsIHNvIGEgbmVzdGVkIHRlbXBsYXRlIG9yIHF1b3RlXG4gKiBpbnNpZGUgYSBzdWJzdGl0dXRpb24gY2Fubm90IGNsb3NlIHRoZSBvdXRlciB0ZW1wbGF0ZSBlYXJseS5cbiAqIExleGluZyBpcyBhIGhldXJpc3RpYyDigJQgYW4gZXhvdGljIHN0cmluZyBmb3JtIGNhbiBzdGlsbCBtaXNsZWFkIGl0LlxuICoge0BsaW5rIExleGVkU2lkZS51bnRlcm1pbmF0ZWRGcm9tfSBtYXJrcyBhIHNpZGUgdGhhdCBlbmRzIHN0aWxsIGluc2lkZSBhXG4gKiBzdHJpbmcgb3IgYmxvY2sgY29tbWVudCwgd2hpY2ggY2FsbGVycyB0cmVhdCBhcyBub3QgY2hlY2tlZC5cbiAqL1xuZnVuY3Rpb24gbGV4TGluZXMobGluZXM6IHJlYWRvbmx5IFNpZGVMaW5lW10sIGxhbmc6IExhbmcpOiBMZXhlZFNpZGUge1xuICBjb25zdCBvdXQ6IExleGVkTGluZVtdID0gW107XG4gIGxldCBpbkJsb2NrQ29tbWVudCA9IGZhbHNlO1xuICBsZXQgb3BlbjogT3BlblN0cmluZyB8IG51bGwgPSBudWxsO1xuICAvKiogTGluZSB0aGF0IG9wZW5lZCB0aGUgbXVsdGktbGluZSBzdHJpbmcgb3IgYmxvY2sgY29tbWVudCBub3cgb3Blbi4gKi9cbiAgbGV0IG9wZW5MaW5lID0gLTE7XG4gIC8qKiBCcmFjZSBkZXB0aCBvdXRzaWRlIGVhY2ggb3BlbiBgJHtgLCBhbmQgdGhlIGxpbmUgdGhhdCBvcGVuZWQgaXQuICovXG4gIGNvbnN0IHN1YnN0aXR1dGlvbnM6IHsgZGVwdGg6IG51bWJlcjsgbGluZTogbnVtYmVyIH1bXSA9IFtdO1xuICBsZXQgYnJhY2VEZXB0aCA9IDA7XG4gIGNvbnN0IHNsYXNoQ29tbWVudHMgPSBsYW5nID09PSBcInJ1c3RcIiB8fCBsYW5nID09PSBcImNcIjtcbiAgLy8gVGhlIGxhc3Qgc2lnbmlmaWNhbnQgY29kZSB0b2tlbiwgY2FycmllZCBhY3Jvc3MgbGluZXMgc28gYSBgL2AgdGhhdFxuICAvLyBvcGVucyBhIGxpbmUgY29udGludWluZyBhbiBleHByZXNzaW9uIChgYVxcbiAgLyBiYCkgc3RheXMgZGl2aXNpb24uXG4gIGxldCBwcmV2OiBQcmV2VG9rZW4gPSB7IGNoYXI6IFwiXCIsIHdvcmQ6IFwiXCIgfTtcblxuICBmb3IgKGxldCBsaW5lSW5kZXggPSAwOyBsaW5lSW5kZXggPCBsaW5lcy5sZW5ndGg7IGxpbmVJbmRleCsrKSB7XG4gICAgY29uc3QgcmF3ID0gbGluZXNbbGluZUluZGV4XSEucmF3O1xuICAgIGxldCBjb2RlID0gXCJcIjtcbiAgICBsZXQgc3RyaXBwZWQgPSBcIlwiO1xuICAgIGxldCBjb21tZW50ID0gXCJcIjtcbiAgICBjb25zdCBzdGFydHNJbnNpZGUgPSBpbkJsb2NrQ29tbWVudCB8fCBvcGVuICE9PSBudWxsO1xuICAgIGxldCBzYXdDb21tZW50ID0gaW5CbG9ja0NvbW1lbnQ7XG4gICAgbGV0IHNhd0NvZGUgPSBmYWxzZTtcbiAgICBsZXQgaSA9IDA7XG4gICAgd2hpbGUgKGkgPCByYXcubGVuZ3RoKSB7XG4gICAgICBjb25zdCBjaCA9IHJhd1tpXSE7XG4gICAgICBpZiAoaW5CbG9ja0NvbW1lbnQpIHtcbiAgICAgICAgY29tbWVudCArPSBjaDtcbiAgICAgICAgaWYgKGNoID09PSBcIipcIiAmJiByYXdbaSArIDFdID09PSBcIi9cIikge1xuICAgICAgICAgIGNvbW1lbnQgKz0gXCIvXCI7XG4gICAgICAgICAgaW5CbG9ja0NvbW1lbnQgPSBmYWxzZTtcbiAgICAgICAgICBjb2RlICs9IFwiICBcIjtcbiAgICAgICAgICBpICs9IDI7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgY29kZSArPSBcIiBcIjtcbiAgICAgICAgICBpKys7XG4gICAgICAgIH1cbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBpZiAob3Blbikge1xuICAgICAgICBzYXdDb2RlID0gdHJ1ZTtcbiAgICAgICAgaWYgKG9wZW4uZXNjYXBlcyAmJiBjaCA9PT0gXCJcXFxcXCIpIHtcbiAgICAgICAgICBjb2RlICs9IFwiICBcIjtcbiAgICAgICAgICBzdHJpcHBlZCArPSByYXcuc2xpY2UoaSwgaSArIDIpO1xuICAgICAgICAgIGkgKz0gMjtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocmF3LnN0YXJ0c1dpdGgob3Blbi5jbG9zZSwgaSkpIHtcbiAgICAgICAgICBjb2RlICs9IG9wZW4uY2xvc2U7XG4gICAgICAgICAgc3RyaXBwZWQgKz0gb3Blbi5jbG9zZTtcbiAgICAgICAgICBpICs9IG9wZW4uY2xvc2UubGVuZ3RoO1xuICAgICAgICAgIG9wZW4gPSBudWxsO1xuICAgICAgICAgIHByZXYgPSBPUEVSQU5EO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmIChvcGVuID09PSBURU1QTEFURSAmJiBjaCA9PT0gXCIkXCIgJiYgcmF3W2kgKyAxXSA9PT0gXCJ7XCIpIHtcbiAgICAgICAgICAvLyBBIHN1YnN0aXR1dGlvbiBpcyBjb2RlIHVudGlsIGl0cyBtYXRjaGluZyBgfWAuXG4gICAgICAgICAgc3Vic3RpdHV0aW9ucy5wdXNoKHsgZGVwdGg6IGJyYWNlRGVwdGgsIGxpbmU6IGxpbmVJbmRleCB9KTtcbiAgICAgICAgICBjb2RlICs9IFwiICBcIjtcbiAgICAgICAgICBzdHJpcHBlZCArPSBcIiR7XCI7XG4gICAgICAgICAgaSArPSAyO1xuICAgICAgICAgIG9wZW4gPSBudWxsO1xuICAgICAgICAgIHByZXYgPSB7IGNoYXI6IFwie1wiLCB3b3JkOiBcIlwiIH07XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgY29kZSArPSBcIiBcIjtcbiAgICAgICAgc3RyaXBwZWQgKz0gY2g7XG4gICAgICAgIGkrKztcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBpZiAoc2xhc2hDb21tZW50cyAmJiBjaCA9PT0gXCIvXCIgJiYgcmF3W2kgKyAxXSA9PT0gXCIvXCIpIHtcbiAgICAgICAgc2F3Q29tbWVudCA9IHRydWU7XG4gICAgICAgIGNvbW1lbnQgKz0gcmF3LnNsaWNlKGkpO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGlmIChcbiAgICAgICAgKHNsYXNoQ29tbWVudHMgfHwgbGFuZyA9PT0gXCJzcWxcIikgJiYgY2ggPT09IFwiL1wiICYmIHJhd1tpICsgMV0gPT09IFwiKlwiXG4gICAgICApIHtcbiAgICAgICAgY29tbWVudCArPSBcIi8qXCI7XG4gICAgICAgIHNhd0NvbW1lbnQgPSB0cnVlO1xuICAgICAgICBpbkJsb2NrQ29tbWVudCA9IHRydWU7XG4gICAgICAgIG9wZW5MaW5lID0gbGluZUluZGV4O1xuICAgICAgICBjb2RlICs9IFwiICBcIjtcbiAgICAgICAgaSArPSAyO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmIChcbiAgICAgICAgY2ggPT09IFwiI1wiICYmIChsYW5nID09PSBcInB5dGhvblwiIHx8XG4gICAgICAgICAgKGxhbmcgPT09IFwic2hlbGxcIiAmJiAoaSA9PT0gMCB8fCAvXFxzLy50ZXN0KHJhd1tpIC0gMV0hKSkpKVxuICAgICAgKSB7XG4gICAgICAgIHNhd0NvbW1lbnQgPSB0cnVlO1xuICAgICAgICBjb21tZW50ICs9IHJhdy5zbGljZShpKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBpZiAobGFuZyA9PT0gXCJzcWxcIiAmJiBjaCA9PT0gXCItXCIgJiYgcmF3W2kgKyAxXSA9PT0gXCItXCIpIHtcbiAgICAgICAgc2F3Q29tbWVudCA9IHRydWU7XG4gICAgICAgIGNvbW1lbnQgKz0gcmF3LnNsaWNlKGkpO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGlmIChsYW5nID09PSBcImNcIiAmJiBjaCA9PT0gXCIvXCIgJiYgcmVnZXhDYW5TdGFydChwcmV2KSkge1xuICAgICAgICBjb25zdCBlbmQgPSByZWdleExpdGVyYWxFbmQocmF3LCBpKTtcbiAgICAgICAgaWYgKGVuZCAhPT0gLTEpIHtcbiAgICAgICAgICBzYXdDb2RlID0gdHJ1ZTtcbiAgICAgICAgICBjb2RlICs9IFwiL1wiICsgXCIgXCIucmVwZWF0KGVuZCAtIGkgLSAyKSArIFwiL1wiO1xuICAgICAgICAgIHN0cmlwcGVkICs9IHJhdy5zbGljZShpLCBlbmQpO1xuICAgICAgICAgIGkgPSBlbmQ7XG4gICAgICAgICAgcHJldiA9IE9QRVJBTkQ7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChsYW5nID09PSBcImNcIiAmJiAoY2ggPT09IFwie1wiIHx8IGNoID09PSBcIn1cIikpIHtcbiAgICAgICAgY29uc3QgdG9wID0gc3Vic3RpdHV0aW9uc1tzdWJzdGl0dXRpb25zLmxlbmd0aCAtIDFdO1xuICAgICAgICBpZiAoY2ggPT09IFwifVwiICYmIHRvcCAhPT0gdW5kZWZpbmVkICYmIHRvcC5kZXB0aCA9PT0gYnJhY2VEZXB0aCkge1xuICAgICAgICAgIC8vIFRoZSBgfWAgY2xvc2luZyBhIGAke+KApn1gOiB0aGUgdGVtcGxhdGUgbGl0ZXJhbCByZXN1bWVzLlxuICAgICAgICAgIHN1YnN0aXR1dGlvbnMucG9wKCk7XG4gICAgICAgICAgc2F3Q29kZSA9IHRydWU7XG4gICAgICAgICAgY29kZSArPSBcIiBcIjtcbiAgICAgICAgICBzdHJpcHBlZCArPSBjaDtcbiAgICAgICAgICBpKys7XG4gICAgICAgICAgb3BlbiA9IFRFTVBMQVRFO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGJyYWNlRGVwdGggKz0gY2ggPT09IFwie1wiID8gMSA6IC0xO1xuICAgICAgfVxuICAgICAgY29uc3Qgb3BlbmVkID0gb3BlblN0cmluZ0F0KHJhdywgaSwgbGFuZyk7XG4gICAgICBpZiAob3BlbmVkKSB7XG4gICAgICAgIHNhd0NvZGUgPSB0cnVlO1xuICAgICAgICBjb2RlICs9IHJhdy5zbGljZShpLCBpICsgb3BlbmVkLmxlbmd0aCk7XG4gICAgICAgIHN0cmlwcGVkICs9IHJhdy5zbGljZShpLCBpICsgb3BlbmVkLmxlbmd0aCk7XG4gICAgICAgIGkgKz0gb3BlbmVkLmxlbmd0aDtcbiAgICAgICAgb3BlbiA9IG9wZW5lZC5zdHJpbmcuY2xvc2UgPT09IFwiYFwiICYmIGxhbmcgPT09IFwiY1wiXG4gICAgICAgICAgPyBURU1QTEFURVxuICAgICAgICAgIDogb3BlbmVkLnN0cmluZztcbiAgICAgICAgaWYgKG9wZW4ubXVsdGlsaW5lKSBvcGVuTGluZSA9IGxpbmVJbmRleDtcbiAgICAgICAgcHJldiA9IE9QRVJBTkQ7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgaWYgKCEvXFxzLy50ZXN0KGNoKSkge1xuICAgICAgICBzYXdDb2RlID0gdHJ1ZTtcbiAgICAgICAgbGV0IHdvcmQgPSBcIlwiO1xuICAgICAgICBpZiAoaXNJZGVudENoYXIoY2gpKSB7XG4gICAgICAgICAgLy8gQ2FwcGVkOiBubyBrZXl3b3JkIGlzIGxvbmdlciwgYW5kIGEgbG9uZyBpZGVudGlmaWVyIHN0YXlzIGxpbmVhci5cbiAgICAgICAgICBjb25zdCBjb250ID0gaSA+IDAgJiYgaXNJZGVudENoYXIocmF3W2kgLSAxXSk7XG4gICAgICAgICAgd29yZCA9ICFjb250XG4gICAgICAgICAgICA/IGNoXG4gICAgICAgICAgICA6IHByZXYud29yZC5sZW5ndGggPiAxMFxuICAgICAgICAgICAgPyBwcmV2LndvcmRcbiAgICAgICAgICAgIDogcHJldi53b3JkICsgY2g7XG4gICAgICAgIH1cbiAgICAgICAgcHJldiA9IHsgY2hhcjogY2gsIHdvcmQgfTtcbiAgICAgIH1cbiAgICAgIGNvZGUgKz0gY2g7XG4gICAgICBzdHJpcHBlZCArPSBjaDtcbiAgICAgIGkrKztcbiAgICB9XG4gICAgaWYgKG9wZW4gJiYgIW9wZW4ubXVsdGlsaW5lKSBvcGVuID0gbnVsbDtcbiAgICBvdXQucHVzaCh7XG4gICAgICBjb21tZW50LFxuICAgICAgY29kZSxcbiAgICAgIHN0cmlwcGVkLFxuICAgICAgY29tbWVudE9ubHk6IHNhd0NvbW1lbnQgJiYgIXNhd0NvZGUsXG4gICAgICBzdGFydHNJbnNpZGUsXG4gICAgfSk7XG4gIH1cbiAgbGV0IHVudGVybWluYXRlZEZyb20gPSBpbkJsb2NrQ29tbWVudCB8fCBvcGVuICE9PSBudWxsID8gb3BlbkxpbmUgOiAtMTtcbiAgY29uc3Qgb3V0ZXIgPSBzdWJzdGl0dXRpb25zWzBdO1xuICBpZiAob3V0ZXIgIT09IHVuZGVmaW5lZCkge1xuICAgIHVudGVybWluYXRlZEZyb20gPSB1bnRlcm1pbmF0ZWRGcm9tID09PSAtMVxuICAgICAgPyBvdXRlci5saW5lXG4gICAgICA6IE1hdGgubWluKHVudGVybWluYXRlZEZyb20sIG91dGVyLmxpbmUpO1xuICB9XG4gIHJldHVybiB7IGxpbmVzOiBvdXQsIHVudGVybWluYXRlZEZyb20gfTtcbn1cblxuLyoqIFJldXNlIHRoZSBhc3NlcnRpb24gc2Nhbm5lcidzIGxhbmd1YWdlLWF3YXJlIGxleGVyIGZvciBwcm9zZSBzZWxlY3Rpb24uICovXG5leHBvcnQgZnVuY3Rpb24gc291cmNlUHJvc2VMaW5lcyhzb3VyY2U6IHN0cmluZywgcGF0aDogc3RyaW5nKToge1xuICBsaW5lczogQXJyYXk8eyBjb2RlOiBzdHJpbmc7IGNvbW1lbnQ6IHN0cmluZyB9PjtcbiAgdW50ZXJtaW5hdGVkRnJvbTogbnVtYmVyO1xufSB7XG4gIHJldHVybiBsZXhMaW5lcyhcbiAgICBzb3VyY2Uuc3BsaXQoXCJcXG5cIikubWFwKChyYXcsIHNlcSkgPT4gKHsgcmF3LCBjaGFuZ2VkOiBmYWxzZSwgc2VxIH0pKSxcbiAgICBsYW5nRm9yKHBhdGgpLFxuICApO1xufVxuXG4vKiogT25lIHN0cmluZyBsaXRlcmFsIHJlY292ZXJlZCBmcm9tIGEgbGV4ZWQgbGluZS4gQ29sdW1uIGlzIDEtYmFzZWQuICovXG5leHBvcnQgaW50ZXJmYWNlIFNvdXJjZVN0cmluZ0xpdGVyYWwge1xuICB0ZXh0OiBzdHJpbmc7XG4gIGxpbmU6IG51bWJlcjtcbiAgY29sdW1uOiBudW1iZXI7XG59XG5cbi8qKlxuICogU3RyaW5nIGxpdGVyYWxzIG9uIGVhY2ggbGluZS4gYHN0cmlwcGVkYCBrZWVwcyB0aGUgY2hhcmFjdGVycyBpbnNpZGUgdGhlXG4gKiBxdW90ZXMgYW5kIGBjb2RlYCBibGFua3MgdGhlbSwgc28gYSBxdW90ZS1kZWxpbWl0ZWQgcnVuIHRoYXQgZGlmZmVyc1xuICogYmV0d2VlbiB0aGUgdHdvIGlzIGEgbGl0ZXJhbC4gQ29tbWVudCBibGFua3MgZXhpc3Qgb25seSBpbiBgY29kZWAgYW5kIGFyZVxuICogc2tpcHBlZC4gVGhlIHJldHVybiBzaGFwZSBvZiB7QGxpbmsgc291cmNlUHJvc2VMaW5lc30gaXMgdW5jaGFuZ2VkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc291cmNlU3RyaW5nTGl0ZXJhbHMoXG4gIHNvdXJjZTogc3RyaW5nLFxuICBwYXRoOiBzdHJpbmcsXG4pOiBTb3VyY2VTdHJpbmdMaXRlcmFsW10ge1xuICBjb25zdCBsZXhlZCA9IGxleExpbmVzKFxuICAgIHNvdXJjZS5zcGxpdChcIlxcblwiKS5tYXAoKHJhdywgc2VxKSA9PiAoeyByYXcsIGNoYW5nZWQ6IGZhbHNlLCBzZXEgfSkpLFxuICAgIGxhbmdGb3IocGF0aCksXG4gICk7XG4gIGNvbnN0IGxpdGVyYWxzOiBTb3VyY2VTdHJpbmdMaXRlcmFsW10gPSBbXTtcbiAgZm9yIChsZXQgbGluZUluZGV4ID0gMDsgbGluZUluZGV4IDwgbGV4ZWQubGluZXMubGVuZ3RoOyBsaW5lSW5kZXgrKykge1xuICAgIGNvbnN0IHsgY29kZSwgc3RyaXBwZWQgfSA9IGxleGVkLmxpbmVzW2xpbmVJbmRleF0hO1xuICAgIGxldCBpID0gMDtcbiAgICBsZXQgaiA9IDA7XG4gICAgd2hpbGUgKGkgPCBjb2RlLmxlbmd0aCAmJiBqIDwgc3RyaXBwZWQubGVuZ3RoKSB7XG4gICAgICBpZiAoY29kZVtpXSAhPT0gc3RyaXBwZWRbal0pIHtcbiAgICAgICAgLy8gQSBjb21tZW50IGlzIGJsYW5rZWQgaW4gYGNvZGVgIGFuZCBhYnNlbnQgZnJvbSBgc3RyaXBwZWRgLlxuICAgICAgICBpZiAoY29kZVtpXSA9PT0gXCIgXCIpIGkrKztcbiAgICAgICAgZWxzZSB7XG4gICAgICAgICAgaSsrO1xuICAgICAgICAgIGorKztcbiAgICAgICAgfVxuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGNoID0gc3RyaXBwZWRbal0hO1xuICAgICAgaWYgKGNoICE9PSAnXCInICYmIGNoICE9PSBcIidcIiAmJiBjaCAhPT0gXCJgXCIpIHtcbiAgICAgICAgaSsrO1xuICAgICAgICBqKys7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgY29uc3QgY29sdW1uID0gaSArIDE7XG4gICAgICBpKys7XG4gICAgICBqKys7XG4gICAgICBsZXQgdGV4dCA9IFwiXCI7XG4gICAgICBsZXQgY2xvc2VkID0gZmFsc2U7XG4gICAgICB3aGlsZSAoaSA8IGNvZGUubGVuZ3RoICYmIGogPCBzdHJpcHBlZC5sZW5ndGgpIHtcbiAgICAgICAgaWYgKHN0cmlwcGVkLnN0YXJ0c1dpdGgoY2gsIGopICYmIGNvZGUuc3RhcnRzV2l0aChjaCwgaSkpIHtcbiAgICAgICAgICBsaXRlcmFscy5wdXNoKHsgdGV4dCwgbGluZTogbGluZUluZGV4ICsgMSwgY29sdW1uIH0pO1xuICAgICAgICAgIGkgKz0gY2gubGVuZ3RoO1xuICAgICAgICAgIGogKz0gY2gubGVuZ3RoO1xuICAgICAgICAgIGNsb3NlZCA9IHRydWU7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgICAgdGV4dCArPSBzdHJpcHBlZFtqXTtcbiAgICAgICAgaSsrO1xuICAgICAgICBqKys7XG4gICAgICB9XG4gICAgICBpZiAoIWNsb3NlZCkgYnJlYWs7XG4gICAgfVxuICB9XG4gIHJldHVybiBsaXRlcmFscztcbn1cblxuLyoqIFRoZSBsYXN0IHNpZ25pZmljYW50IGNvZGUgY2hhcmFjdGVyLCBhbmQgdGhlIGlkZW50aWZpZXIgaXQgZW5kcy4gKi9cbmludGVyZmFjZSBQcmV2VG9rZW4ge1xuICBjaGFyOiBzdHJpbmc7XG4gIHdvcmQ6IHN0cmluZztcbn1cblxuLyoqIEEgdG9rZW4gYWZ0ZXIgd2hpY2ggYSBgL2AgaXMgZGl2aXNpb246IGEgY2xvc2VkIHN0cmluZywgcmVnZXggb3Igb3BlcmFuZC4gKi9cbmNvbnN0IE9QRVJBTkQ6IFByZXZUb2tlbiA9IHsgY2hhcjogXCIpXCIsIHdvcmQ6IFwiXCIgfTtcblxuLyoqXG4gKiBQdW5jdHVhdGlvbiBhZnRlciB3aGljaCBhbiBleHByZXNzaW9uIOKAlCBzbyBhIHJlZ2V4IGxpdGVyYWwg4oCUIGNhbiBiZWdpbjpcbiAqIG9wZW5pbmcgYnJhY2tldHMgYW5kIHNlcGFyYXRvcnMsIGFuZCBldmVyeSBvcGVyYXRvciwgaW5jbHVkaW5nIHRoZSBgPmAgb2ZcbiAqIGFuIGFycm93IChgPT4gL2AvLnRlc3QoYylgKSBvciBhIGNvbXBhcmlzb24gKGBhID4gL3gvYCBjYW5ub3QgYmUgYVxuICogZGl2aXNpb24pLiBBZnRlciBhIHBvc3RmaXggYCsrYC9gLS1gIGEgYC9gIGRpdmlkZXMsIGJ1dCBhIHJlZ2V4IGxpdGVyYWxcbiAqIG11c3QgY2xvc2Ugb24gaXRzIGxpbmUsIHNvIGEgbWlzcmVhZCB0aGVyZSBibGFua3MgYXQgbW9zdCBvbmUgbGluZSdzXG4gKiBzbGFzaGVzIHJhdGhlciB0aGFuIG9wZW5pbmcgYSBwaGFudG9tIHN0cmluZyAoUFIgIzMxNDggcmV2aWV3KS5cbiAqL1xuY29uc3QgUkVHRVhfUFJFQ0VERVJTID0gbmV3IFNldChbXG4gIFwiKFwiLFxuICBcIixcIixcbiAgXCI9XCIsXG4gIFwiOlwiLFxuICBcIltcIixcbiAgXCIhXCIsXG4gIFwiJlwiLFxuICBcInxcIixcbiAgXCI/XCIsXG4gIFwie1wiLFxuICBcIn1cIixcbiAgXCI7XCIsXG4gIFwiPlwiLFxuICBcIjxcIixcbiAgXCIrXCIsXG4gIFwiLVwiLFxuICBcIipcIixcbiAgXCIlXCIsXG4gIFwiXlwiLFxuICBcIn5cIixcbl0pO1xuXG4vKiogS2V5d29yZHMgYWZ0ZXIgd2hpY2ggYW4gZXhwcmVzc2lvbiDigJQgc28gYSByZWdleCBsaXRlcmFsIOKAlCBjYW4gYmVnaW4uICovXG5jb25zdCBSRUdFWF9LRVlXT1JEUyA9IG5ldyBTZXQoW1xuICBcInJldHVyblwiLFxuICBcInR5cGVvZlwiLFxuICBcImluc3RhbmNlb2ZcIixcbiAgXCJpblwiLFxuICBcIm9mXCIsXG4gIFwibmV3XCIsXG4gIFwiZGVsZXRlXCIsXG4gIFwidm9pZFwiLFxuICBcInRocm93XCIsXG4gIFwiY2FzZVwiLFxuICBcImRvXCIsXG4gIFwiZWxzZVwiLFxuICBcInlpZWxkXCIsXG4gIFwiYXdhaXRcIixcbl0pO1xuXG4vKipcbiAqIFdoZXRoZXIgYSBgL2AgYWZ0ZXIgYHByZXZgIG9wZW5zIGEgcmVnZXggbGl0ZXJhbCByYXRoZXIgdGhhbiBkaXZpZGluZzpcbiAqIGF0IHRoZSBzdGFydCBvZiB0aGUgZmlsZSwgYWZ0ZXIgYW4gb3BlcmF0b3Igb3Igb3BlbmluZyBwdW5jdHVhdGlvbiwgb3JcbiAqIGFmdGVyIGEga2V5d29yZCBzdWNoIGFzIGByZXR1cm5gIG9yIGB0eXBlb2ZgLlxuICovXG5mdW5jdGlvbiByZWdleENhblN0YXJ0KHByZXY6IFByZXZUb2tlbik6IGJvb2xlYW4ge1xuICBpZiAocHJldi5jaGFyID09PSBcIlwiKSByZXR1cm4gdHJ1ZTtcbiAgaWYgKFJFR0VYX1BSRUNFREVSUy5oYXMocHJldi5jaGFyKSkgcmV0dXJuIHRydWU7XG4gIHJldHVybiBwcmV2LndvcmQgIT09IFwiXCIgJiYgUkVHRVhfS0VZV09SRFMuaGFzKHByZXYud29yZCk7XG59XG5cbi8qKlxuICogVGhlIGluZGV4IGp1c3QgcGFzdCBhIHNpbmdsZS1saW5lIHJlZ2V4IGxpdGVyYWwgb3BlbmluZyBhdCBgcmF3W2ldYCAoaXRzXG4gKiBjbG9zaW5nIGAvYCBhbmQgYW55IGZsYWdzKSwgb3IgLTEgd2hlbiBub25lIGNsb3NlcyBvbiB0aGUgbGluZSDigJQgdGhlbiB0aGVcbiAqIGAvYCBpcyBkaXZpc2lvbiBhZnRlciBhbGwsIHNpbmNlIGEgcmVnZXggbGl0ZXJhbCBjYW5ub3Qgc3BhbiBsaW5lcy4gQSBgL2BcbiAqIGluc2lkZSBhIGBb4oCmXWAgY2xhc3Mgb3IgZXNjYXBlZCB3aXRoIGEgYmFja3NsYXNoIGRvZXMgbm90IGNsb3NlIGl0LiBgLy9gXG4gKiBhbmQgYC8qYCBhcmUgY29tbWVudHMsIG1hdGNoZWQgYmVmb3JlIHRoaXMgaXMgY2FsbGVkLlxuICovXG5mdW5jdGlvbiByZWdleExpdGVyYWxFbmQocmF3OiBzdHJpbmcsIGk6IG51bWJlcik6IG51bWJlciB7XG4gIGxldCBpbkNsYXNzID0gZmFsc2U7XG4gIGZvciAobGV0IGogPSBpICsgMTsgaiA8IHJhdy5sZW5ndGg7IGorKykge1xuICAgIGNvbnN0IGNoID0gcmF3W2pdO1xuICAgIGlmIChjaCA9PT0gXCJcXFxcXCIpIHtcbiAgICAgIGorKztcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoaW5DbGFzcykge1xuICAgICAgaWYgKGNoID09PSBcIl1cIikgaW5DbGFzcyA9IGZhbHNlO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChjaCA9PT0gXCJbXCIpIGluQ2xhc3MgPSB0cnVlO1xuICAgIGVsc2UgaWYgKGNoID09PSBcIi9cIikge1xuICAgICAgbGV0IGVuZCA9IGogKyAxO1xuICAgICAgd2hpbGUgKGVuZCA8IHJhdy5sZW5ndGggJiYgL1thLXpdL2kudGVzdChyYXdbZW5kXSEpKSBlbmQrKztcbiAgICAgIHJldHVybiBlbmQ7XG4gICAgfVxuICB9XG4gIHJldHVybiAtMTtcbn1cblxuLyoqIEEgc3RyaW5nIGxpdGVyYWwgb3BlbmluZyBhdCBgcmF3W2ldYDogaG93IG1hbnkgY2hhcnMgb3BlbiBpdCwgYW5kIGl0cyBydWxlcy4gKi9cbmZ1bmN0aW9uIG9wZW5TdHJpbmdBdChcbiAgcmF3OiBzdHJpbmcsXG4gIGk6IG51bWJlcixcbiAgbGFuZzogTGFuZyxcbik6IHsgbGVuZ3RoOiBudW1iZXI7IHN0cmluZzogT3BlblN0cmluZyB9IHwgbnVsbCB7XG4gIGNvbnN0IGNoID0gcmF3W2ldITtcbiAgaWYgKGxhbmcgPT09IFwicHl0aG9uXCIpIHtcbiAgICBpZiAoY2ggPT09ICdcIicgfHwgY2ggPT09IFwiJ1wiKSB7XG4gICAgICBjb25zdCB0cmlwbGUgPSBjaC5yZXBlYXQoMyk7XG4gICAgICBpZiAocmF3LnN0YXJ0c1dpdGgodHJpcGxlLCBpKSkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGxlbmd0aDogMyxcbiAgICAgICAgICBzdHJpbmc6IHsgY2xvc2U6IHRyaXBsZSwgZXNjYXBlczogdHJ1ZSwgbXVsdGlsaW5lOiB0cnVlIH0sXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICByZXR1cm4ge1xuICAgICAgICBsZW5ndGg6IDEsXG4gICAgICAgIHN0cmluZzogeyBjbG9zZTogY2gsIGVzY2FwZXM6IHRydWUsIG11bHRpbGluZTogZmFsc2UgfSxcbiAgICAgIH07XG4gICAgfVxuICAgIHJldHVybiBudWxsO1xuICB9XG4gIGlmIChsYW5nID09PSBcInNoZWxsXCIpIHtcbiAgICBpZiAoY2ggPT09ICdcIicgfHwgY2ggPT09IFwiJ1wiKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBsZW5ndGg6IDEsXG4gICAgICAgIHN0cmluZzogeyBjbG9zZTogY2gsIGVzY2FwZXM6IGNoID09PSAnXCInLCBtdWx0aWxpbmU6IGZhbHNlIH0sXG4gICAgICB9O1xuICAgIH1cbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICBpZiAobGFuZyA9PT0gXCJydXN0XCIpIHtcbiAgICBpZiAoKGNoID09PSBcInJcIiB8fCBjaCA9PT0gXCJiXCIpICYmICFpc0lkZW50Q2hhcihyYXdbaSAtIDFdKSkge1xuICAgICAgLy8gUmF3IHN0cmluZzogclwi4oCmXCIsIHIjXCLigKZcIiMsIGJyI1wi4oCmXCIjLlxuICAgICAgbGV0IGogPSBpICsgKGNoID09PSBcImJcIiAmJiByYXdbaSArIDFdID09PSBcInJcIiA/IDIgOiAxKTtcbiAgICAgIGlmIChjaCA9PT0gXCJiXCIgJiYgcmF3W2kgKyAxXSAhPT0gXCJyXCIpIHJldHVybiBudWxsO1xuICAgICAgbGV0IGhhc2hlcyA9IDA7XG4gICAgICB3aGlsZSAocmF3W2pdID09PSBcIiNcIikge1xuICAgICAgICBoYXNoZXMrKztcbiAgICAgICAgaisrO1xuICAgICAgfVxuICAgICAgaWYgKHJhd1tqXSA9PT0gJ1wiJykge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGxlbmd0aDogaiAtIGkgKyAxLFxuICAgICAgICAgIHN0cmluZzoge1xuICAgICAgICAgICAgY2xvc2U6ICdcIicgKyBcIiNcIi5yZXBlYXQoaGFzaGVzKSxcbiAgICAgICAgICAgIGVzY2FwZXM6IGZhbHNlLFxuICAgICAgICAgICAgbXVsdGlsaW5lOiB0cnVlLFxuICAgICAgICAgIH0sXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgaWYgKGNoID09PSAnXCInKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBsZW5ndGg6IDEsXG4gICAgICAgIHN0cmluZzogeyBjbG9zZTogJ1wiJywgZXNjYXBlczogdHJ1ZSwgbXVsdGlsaW5lOiB0cnVlIH0sXG4gICAgICB9O1xuICAgIH1cbiAgICBpZiAoY2ggPT09IFwiJ1wiKSB7XG4gICAgICAvLyBBIGNoYXIgbGl0ZXJhbCAoJ3gnLCAnXFxuJywgJ1xcdXsxRjYwMH0nKSwgbm90IGEgbGlmZXRpbWUgKCdhKS5cbiAgICAgIGlmIChyYXdbaSArIDFdID09PSBcIlxcXFxcIikge1xuICAgICAgICBjb25zdCBjbG9zZSA9IHJhdy5pbmRleE9mKFwiJ1wiLCBpICsgMik7XG4gICAgICAgIGlmIChjbG9zZSAhPT0gLTEgJiYgY2xvc2UgLSBpIDw9IDEyKSB7XG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIGxlbmd0aDogMSxcbiAgICAgICAgICAgIHN0cmluZzogeyBjbG9zZTogXCInXCIsIGVzY2FwZXM6IHRydWUsIG11bHRpbGluZTogZmFsc2UgfSxcbiAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgfVxuICAgICAgaWYgKHJhd1tpICsgMl0gPT09IFwiJ1wiKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgbGVuZ3RoOiAxLFxuICAgICAgICAgIHN0cmluZzogeyBjbG9zZTogXCInXCIsIGVzY2FwZXM6IHRydWUsIG11bHRpbGluZTogZmFsc2UgfSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICAvLyBDLWxpa2U6IFR5cGVTY3JpcHQsIEphdmFTY3JpcHQsIEdvLCBKYXZhLCBLb3RsaW4sIEMjLCBTd2lmdOKAplxuICBpZiAoY2ggPT09ICdcIicgfHwgY2ggPT09IFwiJ1wiKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGxlbmd0aDogMSxcbiAgICAgIHN0cmluZzogeyBjbG9zZTogY2gsIGVzY2FwZXM6IHRydWUsIG11bHRpbGluZTogZmFsc2UgfSxcbiAgICB9O1xuICB9XG4gIGlmIChjaCA9PT0gXCJgXCIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgbGVuZ3RoOiAxLFxuICAgICAgc3RyaW5nOiB7IGNsb3NlOiBcImBcIiwgZXNjYXBlczogdHJ1ZSwgbXVsdGlsaW5lOiB0cnVlIH0sXG4gICAgfTtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxpRkFBaUYsR0FDakYsU0FDRSxpQkFBaUIsRUFDakIsaUJBQWlCLEVBQ2pCLG1CQUFtQixFQUNuQixzQkFBc0IsUUFDakIsd0JBQXdCO0FBQy9CLFNBQVMsVUFBVSxRQUFRLHdCQUF3QjtBQUNuRCxTQUFTLGdCQUFnQixRQUFRLDJCQUEyQjtBQUU1RCxnRkFBZ0YsR0FDaEYsTUFBTSwyQkFBMkI7QUF5QmpDOzs7O0NBSUMsR0FDRCxPQUFPLFNBQVMseUJBQ2QsTUFBYyxFQUNkLFFBQTJCO0VBRTNCLElBQUksU0FBUyxNQUFNLEtBQUssR0FBRyxPQUFPO0VBQ2xDLE1BQU0sUUFBUSxTQUFTLEtBQUssQ0FBQyxHQUFHO0VBQ2hDLE1BQU0sT0FBTyxTQUFTLE1BQU0sR0FBRyxNQUFNLE1BQU0sR0FDdkMsQ0FBQyxNQUFNLEVBQUUsU0FBUyxNQUFNLEdBQUcsTUFBTSxNQUFNLENBQUMsS0FBSyxDQUFDLEdBQzlDO0VBQ0osT0FBTyxHQUFHLE9BQU8sRUFBRSxFQUFFLFNBQVMsTUFBTSxDQUFDLG1EQUFtRCxFQUFFLE1BQU0sTUFBTSxDQUFDLEdBQUcsRUFDeEcsTUFBTSxJQUFJLENBQUMsUUFDVixNQUFNO0FBQ1g7QUFFQSxnRUFBZ0UsR0FDaEUsU0FBUyxhQUFhLElBQVk7RUFDaEMsTUFBTSxTQUFTLElBQUk7RUFDbkIsSUFBSSxPQUFPO0VBQ1gsS0FBSyxN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
// denoCacheMetadata=11513104754915421035,18079546147470880807