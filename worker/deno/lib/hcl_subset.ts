/**
 * A small, pure parser for the part of Terraform HCL that the cloud
 * permission-chain scan reads to find AWS IAM resources and their policy
 * documents (Issue #4416).
 *
 * Nothing in the input is ever evaluated. A reference is kept as its traversal
 * text, and anything that cannot be resolved statically (a function call other
 * than `jsonencode`, a conditional, a for-expression, a splat, arithmetic) is
 * kept as its raw source text.
 *
 * The parser is single-pass and bounded: input over 1,000,000 characters is
 * rejected, and bracket, brace, block and interpolation nesting is capped at 64
 * levels. It never throws. Problems are returned in `errors`, and parsing carries
 * on wherever it can. Uses Australian English throughout.
 */

export interface HclRef {
  ref: string;
}

export interface HclUnknown {
  unknown: string;
}

export type HclValue =
  | string
  | number
  | boolean
  | null
  | HclValue[]
  | { [key: string]: HclValue }
  | HclRef
  | HclUnknown;

export interface HclBlock {
  type: string;
  labels: string[];
  attrs: Record<string, HclValue>;
  attrLines: Record<string, number>;
  blocks: HclBlock[];
  line: number;
}

export interface HclParseResult {
  blocks: HclBlock[];
  errors: string[];
}

const MAX_INPUT_CHARS = 1_000_000;
const MAX_DEPTH = 64;

const IDENT_START = /^[A-Za-z_]$/;
const IDENT_PART = /^[A-Za-z0-9_-]$/;
const NUMBER_AT = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const SPLAT_AT = /\[\s*\*\s*\]/y;
const FOR_AT = /for\s/y;
const HEREDOC_AT = /<<(-?)([A-Za-z_][A-Za-z0-9_-]*)[ \t]*\r?\n/y;
const HEX_DIGITS = /^[0-9A-Fa-f]+$/;

interface Body {
  attrs: Record<string, HclValue>;
  attrLines: Record<string, number>;
  blocks: HclBlock[];
}

function emptyBody(): Body {
  return { attrs: {}, attrLines: {}, blocks: [] };
}

// Defining the property directly keeps a key such as `__proto__` as data.
function setOwn<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function ownKeys(v: HclValue | undefined): string[] | null {
  if (v === undefined || v === null || typeof v !== "object") return null;
  if (Array.isArray(v)) return null;
  return Object.keys(v);
}

export function isHclRef(v: HclValue | undefined): v is HclRef {
  const keys = ownKeys(v);
  return keys !== null && keys.length === 1 && keys[0] === "ref" &&
    typeof (v as HclRef).ref === "string";
}

export function isHclUnknown(v: HclValue | undefined): v is HclUnknown {
  const keys = ownKeys(v);
  return keys !== null && keys.length === 1 && keys[0] === "unknown" &&
    typeof (v as HclUnknown).unknown === "string";
}

class Parser {
  readonly errors: string[] = [];
  private readonly src: string;
  private end: number;
  private readonly lineStarts: number[] = [0];
  private pos = 0;
  private stopped = false;

  constructor(src: string) {
    this.src = src;
    this.end = src.length;
    for (let i = src.indexOf("\n"); i !== -1; i = src.indexOf("\n", i + 1)) {
      this.lineStarts.push(i + 1);
    }
  }

  parseFile(): HclBlock[] {
    if (this.src.charAt(0) === "\uFEFF") this.pos = 1;
    return this.parseBody(0, false).blocks;
  }

  // ---- low-level cursor helpers -------------------------------------------

  // The character at an offset, or "" at the end of input or after an abort.
  private ch(offset = 0): string {
    const i = this.pos + offset;
    if (this.stopped || i >= this.end) return "";
    return this.src.charAt(i);
  }

  private report(msg: string): void {
    if (!this.stopped) this.errors.push(msg);
  }

  // Records a failure that makes the rest of the input unreadable and stops
  // every loop by making the cursor report end of input.
  private abort(msg: string): void {
    this.report(msg);
    this.stopped = true;
  }

  private lineOf(p: number): number {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.lineStarts[mid] ?? 0) <= p) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  private matchAt(re: RegExp): RegExpExecArray | null {
    if (this.stopped) return null;
    re.lastIndex = this.pos;
    const m = re.exec(this.src);
    return m !== null && this.pos + m[0].length <= this.end ? m : null;
  }

  private rawFrom(begin: number): string {
    return this.src.slice(begin, this.pos).trim();
  }

  private readIdent(): string {
    const start = this.pos;
    while (IDENT_PART.test(this.ch())) this.pos++;
    return this.src.slice(start, this.pos);
  }

  private skipSpace(newlines: boolean): void {
    for (;;) {
      const c = this.ch();
      if (c === " " || c === "\t" || c === "\r" || (newlines && c === "\n")) {
        this.pos++;
      } else if (c === "#" || (c === "/" && this.ch(1) === "/")) {
        while (this.ch() !== "" && this.ch() !== "\n") this.pos++;
      } else if (c === "/" && this.ch(1) === "*") {
        const close = this.src.indexOf("*/", this.pos + 2);
        if (close === -1 || close + 2 > this.end) {
          this.abort(`unterminated /* comment at line ${this.lineOf(this.pos)}`);
          return;
        }
        this.pos = close + 2;
      } else {
        return;
      }
    }
  }

  private skipLine(): void {
    while (this.ch() !== "" && this.ch() !== "\n") this.pos++;
    if (this.ch() === "\n") this.pos++;
  }

  private atTerminator(attr: boolean): boolean {
    const c = this.ch();
    return c === "" || c === "," || c === ")" || c === "]" || c === "}" ||
      (attr && c === "\n");
  }

  // Consumes a run of tokens up to a separator at bracket depth zero. With
  // `group`, the cursor is on an opener and the run ends after its closer.
  // Strings and heredocs go through the real readers, so a bracket inside a
  // quoted string never counts. The bracket stack is iterative.
  private skipTokens(attr: boolean, depth: number, group: boolean): void {
    const open: string[] = [];
    for (;;) {
      this.skipSpace(false);
      const c = this.ch();
      if (c === "") break;
      if (
        open.length === 0 && !group &&
        (c === "," || c === ")" || c === "]" || c === "}" ||
          (attr && c === "\n"))
      ) {
        break;
      }
      if (c === "\n") {
        this.pos++;
        continue;
      }
      if (c === '"') {
        this.readString(depth + 1);
        continue;
      }
      if (c === "<" && this.matchAt(HEREDOC_AT)) {
        this.readHeredoc(depth + 1);
        continue;
      }
      if (c === "(" || c === "[" || c === "{") {
        if (depth + open.length + 1 > MAX_DEPTH) {
          this.abort(
            `nesting deeper than ${MAX_DEPTH} levels at line ${this.lineOf(this.pos)}`,
          );
          return;
        }
        open.push(c);
        this.pos++;
        continue;
      }
      if (c === ")" || c === "]" || c === "}") {
        const want = c === ")" ? "(" : c === "]" ? "[" : "{";
        if (open[open.length - 1] !== want) {
          this.abort(`unexpected ${c} at line ${this.lineOf(this.pos)}`);
          return;
        }
        open.pop();
        this.pos++;
        if (group && open.length === 0) return;
        continue;
      }
      this.pos++;
    }
    if (group) {
      this.abort(`bracket at line ${this.lineOf(this.pos)} is not closed`);
    }
  }

  // ---- bodies and blocks ---------------------------------------------------

  private parseBody(depth: number, closing: boolean): Body {
    const body = emptyBody();
    if (depth > MAX_DEPTH) {
      this.abort(
        `blocks nested deeper than ${MAX_DEPTH} levels at line ${this.lineOf(this.pos)}`,
      );
      return body;
    }
    for (;;) {
      this.skipSpace(true);
      const c = this.ch();
      if (c === "") {
        if (closing) this.report("unterminated block: end of input before }");
        return body;
      }
      if (c === "}") {
        this.pos++;
        if (closing) return body;
        this.report(`unexpected } at line ${this.lineOf(this.pos - 1)}`);
        continue;
      }
      if (!IDENT_START.test(c)) {
        this.report(`unexpected "${c}" at line ${this.lineOf(this.pos)}`);
        this.skipLine();
        continue;
      }
      const line = this.lineOf(this.pos);
      const name = this.readIdent();
      this.skipSpace(false);
      if (this.ch() === "=") {
        this.pos++;
        const value = this.parseExpr(true, depth);
        if (!closing) {
          this.report(`attribute "${name}" at line ${line} is outside any block`);
        } else if (Object.hasOwn(body.attrs, name)) {
          this.report(`duplicate attribute "${name}" at line ${line}`);
        } else {
          setOwn(body.attrs, name, value);
          setOwn(body.attrLines, name, line);
        }
        this.endOfItem();
        continue;
      }
      const labels: string[] = [];
      for (;;) {
        this.skipSpace(false);
        const lc = this.ch();
        if (lc === '"') labels.push(this.plainString(depth));
        else if (IDENT_START.test(lc)) labels.push(this.readIdent());
        else break;
      }
      if (this.ch() !== "{") {
        this.report(`expected = or { after "${name}" at line ${line}`);
        this.skipLine();
        continue;
      }
      this.pos++;
      const inner = this.parseBody(depth + 1, true);
      body.blocks.push({
        type: name,
        labels,
        attrs: inner.attrs,
        attrLines: inner.attrLines,
        blocks: inner.blocks,
        line,
      });
    }
  }

  // After an attribute value only a line end, a closing brace, the end of
  // input or another name may follow. Anything else is reported and skipped.
  private endOfItem(): void {
    this.skipSpace(false);
    const c = this.ch();
    if (c === "" || c === "\n" || c === "}" || IDENT_START.test(c)) return;
    this.report(`unexpected "${c}" after a value at line ${this.lineOf(this.pos)}`);
    this.skipLine();
  }

  private plainString(depth: number): string {
    const v = this.readString(depth);
    if (typeof v === "string") return v;
    this.report(`expected a plain string at line ${this.lineOf(this.pos)}`);
    return "";
  }

  // ---- expressions ---------------------------------------------------------

  // `attr` is true for a value that ends at a line end (an attribute or an
  // object member). Otherwise newlines are insignificant, as inside brackets.
  private parseExpr(attr: boolean, depth: number): HclValue {
    if (depth > MAX_DEPTH) {
      this.abort(
        `expressions nested deeper than ${MAX_DEPTH} levels at line ${this.lineOf(this.pos)}`,
      );
      return { unknown: "" };
    }
    this.skipSpace(!attr);
    const begin = this.pos;
    const value = this.parsePrimary(attr, depth);
    this.skipSpace(!attr);
    if (this.atTerminator(attr)) return value;
    // SIMPLE-ON-PURPOSE: arithmetic and conditionals stay raw text, never evaluated — upgrade when a rule must read their value.
    this.skipTokens(attr, depth, false);
    return { unknown: this.rawFrom(begin) };
  }

  private parsePrimary(attr: boolean, depth: number): HclValue {
    const begin = this.pos;
    const c = this.ch();
    if (c === '"') return this.readString(depth);
    if (c === "<" && this.matchAt(HEREDOC_AT)) return this.readHeredoc(depth);
    if (c === "[") return this.parseList(depth);
    if (c === "{") return this.parseObject(depth);
    if (IDENT_START.test(c)) return this.parseWord(depth);
    const num = this.matchAt(NUMBER_AT);
    if (num) {
      this.pos += num[0].length;
      return Number(num[0]);
    }
    if (this.atTerminator(attr)) {
      this.report(`expected a value at line ${this.lineOf(begin)}`);
      return { unknown: "" };
    }
    this.skipTokens(attr, depth, false);
    return { unknown: this.rawFrom(begin) };
  }

  // A name: a literal keyword, a function call, or a traversal such as
  // `aws_iam_role.x.arn` or `aws_instance.web[0].id`.
  private parseWord(depth: number): HclValue {
    const begin = this.pos;
    const word = this.readIdent();
    if (this.ch() === "(") {
      if (word === "jsonencode") return this.parseJsonencode(begin, depth);
      this.skipTokens(false, depth, true);
      return { unknown: this.rawFrom(begin) };
    }
    if (this.ch() !== "." && this.ch() !== "[") {
      if (word === "true") return true;
      if (word === "false") return false;
      if (word === "null") return null;
    }
    let splat = false;
    for (;;) {
      if (this.ch() === ".") {
        if (IDENT_PART.test(this.ch(1))) {
          this.pos++;
          this.readIdent();
        } else if (this.ch(1) === "*") {
          this.pos += 2;
          splat = true;
          break;
        } else {
          this.report(`invalid attribute access after ${word} at line ${this.lineOf(begin)}`);
          break;
        }
      } else if (this.ch() === "[") {
        const star = this.matchAt(SPLAT_AT);
        if (star) {
          this.pos += star[0].length;
          splat = true;
          break;
        }
        this.skipTokens(false, depth, true);
      } else {
        break;
      }
    }
    return splat ? { unknown: this.rawFrom(begin) } : { ref: this.rawFrom(begin) };
  }

  // `jsonencode(<expr>)` yields the expression's own value, so a policy built
  // this way is a plain object or list.
  private parseJsonencode(begin: number, depth: number): HclValue {
    this.pos++;
    const value = this.parseExpr(false, depth + 1);
    this.skipSpace(true);
    if (this.ch() === ")") {
      this.pos++;
      return value;
    }
    this.report(`jsonencode( at line ${this.lineOf(begin)} is not closed by )`);
    return { unknown: this.rawFrom(begin) };
  }

  private parseList(depth: number): HclValue {
    const open = this.pos;
    this.pos++;
    const items: HclValue[] = [];
    for (;;) {
      this.skipSpace(true);
      const c = this.ch();
      if (c === "]") {
        this.pos++;
        return items;
      }
      if (c === "") {
        this.report(`list at line ${this.lineOf(open)} is not closed by ]`);
        return items;
      }
      if (c === ")" || c === "}") {
        this.report(`list at line ${this.lineOf(open)} is not closed by ]`);
        return items;
      }
      if (items.length === 0 && this.matchAt(FOR_AT)) {
        // Nothing has been parsed yet, so only whitespace is re-read.
        this.pos = open;
        this.skipTokens(false, depth, true);
        return { unknown: this.rawFrom(open) };
      }
      items.push(this.parseExpr(false, depth + 1));
      this.skipSpace(true);
      const sep = this.ch();
      if (sep === ",") {
        this.pos++;
      } else if (sep !== "]" && sep !== "" && sep !== ")" && sep !== "}") {
        this.report(`unexpected "${sep}" in list at line ${this.lineOf(this.pos)}`);
        this.skipTokens(false, depth + 1, false);
      }
    }
  }

  private parseObject(depth: number): HclValue {
    const open = this.pos;
    this.pos++;
    const obj: Record<string, HclValue> = {};
    let first = true;
    for (;;) {
      this.skipSpace(true);
      const c = this.ch();
      if (c === "}") {
        this.pos++;
        return obj;
      }
      if (c === "") {
        this.report(`object at line ${this.lineOf(open)} is not closed by }`);
        return obj;
      }
      if (c === ",") {
        this.pos++;
        continue;
      }
      if (c === ")" || c === "]") {
        this.report(`object at line ${this.lineOf(open)} is not closed by }`);
        return obj;
      }
      if (first && this.matchAt(FOR_AT)) {
        this.pos = open;
        this.skipTokens(false, depth, true);
        return { unknown: this.rawFrom(open) };
      }
      first = false;
      let key: string;
      if (c === '"') {
        key = this.plainString(depth + 1);
      } else if (IDENT_START.test(c)) {
        key = this.readIdent();
      } else {
        this.report(`expected an object key at line ${this.lineOf(this.pos)}`);
        this.skipTokens(false, depth + 1, false);
        continue;
      }
      this.skipSpace(false);
      const sep = this.ch();
      if (sep !== "=" && sep !== ":") {
        this.report(`expected = or : after "${key}" at line ${this.lineOf(this.pos)}`);
        this.skipTokens(false, depth + 1, false);
        continue;
      }
      this.pos++;
      const value = this.parseExpr(true, depth + 1);
      if (Object.hasOwn(obj, key)) {
        this.report(`duplicate key "${key}" at line ${this.lineOf(open)}`);
      } else {
        setOwn(obj, key, value);
      }
      this.skipSpace(false);
      const after = this.ch();
      if (
        after === "," || after === "\n" || after === "}" || after === "" ||
        after === '"' || IDENT_START.test(after)
      ) {
        continue;
      }
      this.report(`unexpected "${after}" in object at line ${this.lineOf(this.pos)}`);
      this.skipTokens(false, depth + 1, false);
    }
  }

  // ---- strings and heredocs ------------------------------------------------

  private readString(depth: number): HclValue {
    const open = this.pos;
    this.pos++;
    return this.readTemplate(open, depth, true, 0);
  }

  private readHeredoc(depth: number): HclValue {
    const open = this.pos;
    const m = this.matchAt(HEREDOC_AT);
    if (m === null) {
      this.abort(`malformed heredoc at line ${this.lineOf(open)}`);
      return { unknown: "" };
    }
    const stripIndent = m[1] === "-";
    const marker = m[2] ?? "";
    const bodyStart = open + m[0].length;
    let closeStart = -1;
    let closeEnd = this.end;
    for (let lineStart = bodyStart; lineStart < this.end;) {
      let lineEnd = this.src.indexOf("\n", lineStart);
      if (lineEnd === -1 || lineEnd > this.end) lineEnd = this.end;
      if (this.src.slice(lineStart, lineEnd).trim() === marker) {
        closeStart = lineStart;
        // Stop on the closing line's newline, so the caller sees a line end.
        closeEnd = lineEnd;
        break;
      }
      lineStart = lineEnd + 1;
    }
    if (closeStart === -1) {
      this.abort(`heredoc ${marker} at line ${this.lineOf(open)} is not closed`);
      return { unknown: "" };
    }
    const indent = stripIndent ? this.commonIndent(bodyStart, closeStart) : 0;
    const savedEnd = this.end;
    this.end = closeStart;
    this.pos = bodyStart;
    const value = this.readTemplate(open, depth, false, indent);
    this.end = savedEnd;
    this.pos = closeEnd;
    return value;
  }

  // The smallest leading indent over the non-blank lines of a `<<-` body.
  private commonIndent(from: number, to: number): number {
    let min = Number.POSITIVE_INFINITY;
    for (let p = from; p < to;) {
      let e = this.src.indexOf("\n", p);
      if (e === -1 || e > to) e = to;
      let n = p;
      while (n < e && (this.src.charAt(n) === " " || this.src.charAt(n) === "\t")) {
        n++;
      }
      if (n < e) min = Math.min(min, n - p);
      p = e + 1;
    }
    return Number.isFinite(min) ? min : 0;
  }

  // Reads template text up to the closing quote (quoted) or the current end
  // (heredoc). A string with no interpolation is its decoded text. Exactly one
  // interpolation, with nothing else in the string, of a traversal is that
  // reference. Anything else keeps the raw source text.
  private readTemplate(
    start: number,
    depth: number,
    quoted: boolean,
    indent: number,
  ): HclValue {
    const bodyStart = this.pos;
    let text = "";
    let literal = false;
    let interps = 0;
    let unknownPart = false;
    let sole: HclRef | null = null;
    let lineStart = !quoted;
    for (;;) {
      if (lineStart && indent > 0) {
        for (
          let n = 0;
          n < indent && (this.ch() === " " || this.ch() === "\t");
          n++
        ) {
          this.pos++;
        }
      }
      lineStart = false;
      const c = this.ch();
      if (c === "" || (quoted && c === '"')) break;
      const next = this.ch(1);
      if ((c === "$" || c === "%") && next === c && this.ch(2) === "{") {
        // `$${` and `%%{` are escapes for a literal `${` and `%{`.
        text += `${c}{`;
        literal = true;
        this.pos += 3;
        continue;
      }
      if (c === "$" && next === "{") {
        this.pos += 2;
        const expr = this.parseExpr(false, depth + 1);
        interps++;
        if (isHclRef(expr)) sole = expr;
        else unknownPart = true;
        this.skipSpace(true);
        if (this.ch() === "}") {
          this.pos++;
        } else {
          this.report(`interpolation at line ${this.lineOf(this.pos)} is not closed by }`);
          unknownPart = true;
        }
        continue;
      }
      if (c === "%" && next === "{") {
        // A directive (`%{if ...}`) is kept as raw text and never evaluated.
        this.pos += 1;
        interps++;
        unknownPart = true;
        this.skipTokens(false, depth + 1, true);
        continue;
      }
      if (quoted && c === "\\") {
        this.pos++;
        text += this.escape();
        literal = true;
        continue;
      }
      if (c === "\n" && !quoted) lineStart = true;
      text += c;
      literal = true;
      this.pos++;
    }
    const raw = this.src.slice(bodyStart, this.pos);
    if (quoted) {
      if (this.ch() === "") {
        this.abort(`unterminated string starting at line ${this.lineOf(start)}`);
        return { unknown: raw };
      }
      this.pos++;
    }
    if (interps === 0) return text;
    if (interps === 1 && !literal && !unknownPart && sole !== null) return sole;
    return { unknown: raw };
  }

  // Decodes one escape. The cursor is on the character after the backslash.
  private escape(): string {
    const c = this.ch();
    if (c === "") return "";
    this.pos++;
    switch (c) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case '"':
        return '"';
      case "\\":
        return "\\";
      case "u":
        return this.codePoint(4);
      case "U":
        return this.codePoint(8);
      default:
        this.report(`unknown escape "\\${c}" at line ${this.lineOf(this.pos - 1)}`);
        return c;
    }
  }

  private codePoint(digits: number): string {
    const hex = this.src.slice(this.pos, Math.min(this.pos + digits, this.end));
    if (hex.length !== digits || !HEX_DIGITS.test(hex)) {
      this.report(`invalid unicode escape at line ${this.lineOf(this.pos)}`);
      return "";
    }
    const n = parseInt(hex, 16);
    if (n > 0x10ffff) {
      this.report(`invalid unicode escape at line ${this.lineOf(this.pos)}`);
      return "";
    }
    this.pos += digits;
    return String.fromCodePoint(n);
  }
}

/**
 * Parses HCL text into its top-level blocks without evaluating anything.
 * Never throws. `errors` is non-empty when any construct could not be read,
 * and the blocks that could be read are still returned.
 */
export function parseHcl(text: string): HclParseResult {
  if (typeof text !== "string") {
    return { blocks: [], errors: ["HCL input must be a string"] };
  }
  if (text.length > MAX_INPUT_CHARS) {
    return {
      blocks: [],
      errors: [
        `HCL input is ${text.length} characters; the limit is ${MAX_INPUT_CHARS}`,
      ],
    };
  }
  const parser = new Parser(text);
  const blocks = parser.parseFile();
  return { blocks, errors: parser.errors };
}
