// Ported from js-yaml v3.13.1:
// https://github.com/nodeca/js-yaml/commit/665aadda42349dcae869f12040d9b10ef18d12da
// Copyright 2011-2015 by Vitaly Puzrin. All rights reserved. MIT license.
// Copyright 2018-2026 the Deno authors. MIT license.
import { AMPERSAND, ASTERISK, BACKSLASH, CARRIAGE_RETURN, COLON, COMMA, COMMERCIAL_AT, DOT, DOUBLE_QUOTE, EXCLAMATION, GRAVE_ACCENT, GREATER_THAN, isEOL, isFlowIndicator, isWhiteSpace, isWhiteSpaceOrEOL, LEFT_CURLY_BRACKET, LEFT_SQUARE_BRACKET, LINE_FEED, MINUS, PERCENT, PLUS, QUESTION, RIGHT_CURLY_BRACKET, RIGHT_SQUARE_BRACKET, SHARP, SINGLE_QUOTE, SMALLER_THAN, SPACE, VERTICAL_LINE } from "./_chars.ts";
import { DEFAULT_SCHEMA } from "./_schema.ts";
import { isObject, isPlainObject } from "./_utils.ts";
const CONTEXT_FLOW_IN = 1;
const CONTEXT_FLOW_OUT = 2;
const CONTEXT_BLOCK_IN = 3;
const CONTEXT_BLOCK_OUT = 4;
const CHOMPING_CLIP = 1;
const CHOMPING_STRIP = 2;
const CHOMPING_KEEP = 3;
const PATTERN_NON_PRINTABLE = // deno-lint-ignore no-control-regex
/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x84\x86-\x9F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/;
const PATTERN_NON_ASCII_LINE_BREAKS = /[\x85\u2028\u2029]/;
const PATTERN_FLOW_INDICATORS = /[,\[\]\{\}]/;
const PATTERN_TAG_HANDLE = /^(?:!|!!|![a-z\-]+!)$/i;
const PATTERN_TAG_URI = /^(?:!|[^,\[\]\{\}])(?:%[0-9a-f]{2}|[0-9a-z\-#;\/\?:@&=\+\$,_\.!~\*'\(\)\[\]])*$/i;
const ESCAPED_HEX_LENGTHS = new Map([
  [
    0x78,
    2
  ],
  [
    0x75,
    4
  ],
  [
    0x55,
    8
  ]
]);
const SIMPLE_ESCAPE_SEQUENCES = new Map([
  [
    0x30,
    "\x00"
  ],
  [
    0x61,
    "\x07"
  ],
  [
    0x62,
    "\x08"
  ],
  [
    0x74,
    "\x09"
  ],
  [
    0x09,
    "\x09"
  ],
  [
    0x6e,
    "\x0A"
  ],
  [
    0x76,
    "\x0B"
  ],
  [
    0x66,
    "\x0C"
  ],
  [
    0x72,
    "\x0D"
  ],
  [
    0x65,
    "\x1B"
  ],
  [
    0x20,
    " "
  ],
  [
    0x22,
    '"'
  ],
  [
    0x2f,
    "/"
  ],
  [
    0x5c,
    "\\"
  ],
  [
    0x4e,
    "\x85"
  ],
  [
    0x5f,
    "\xA0"
  ],
  [
    0x4c,
    "\u2028"
  ],
  [
    0x50,
    "\u2029"
  ]
]);
/**
 * Converts a hexadecimal character code to its decimal value.
 */ function hexCharCodeToNumber(charCode) {
  // Check if the character code is in the range for '0' to '9'
  if (0x30 <= charCode && charCode <= 0x39) return charCode - 0x30; // Convert '0'-'9' to 0-9
  // Normalize the character code to lowercase if it's a letter
  const lc = charCode | 0x20;
  // Check if the character code is in the range for 'a' to 'f'
  if (0x61 <= lc && lc <= 0x66) return lc - 0x61 + 10; // Convert 'a'-'f' to 10-15
  return -1;
}
/**
 * Converts a decimal character code to its decimal value.
 */ function decimalCharCodeToNumber(charCode) {
  // Check if the character code is in the range for '0' to '9'
  if (0x30 <= charCode && charCode <= 0x39) return charCode - 0x30; // Convert '0'-'9' to 0-9
  return -1;
}
/**
 * Converts a Unicode code point to a string.
 */ function codepointToChar(codepoint) {
  // Check if the code point is within the Basic Multilingual Plane (BMP)
  if (codepoint <= 0xffff) return String.fromCharCode(codepoint); // Convert BMP code point to character
  // Encode UTF-16 surrogate pair for code points beyond BMP
  // Reference: https://en.wikipedia.org/wiki/UTF-16#Code_points_U.2B010000_to_U.2B10FFFF
  return String.fromCharCode((codepoint - 0x010000 >> 10) + 0xd800, (codepoint - 0x010000 & 0x03ff) + 0xdc00);
}
const INDENT = 4;
const MAX_LENGTH = 75;
const DELIMITERS = "\x00\r\n\x85\u2028\u2029";
function getSnippet(buffer, position) {
  if (!buffer) return null;
  let start = position;
  let end = position;
  let head = "";
  let tail = "";
  while(start > 0 && !DELIMITERS.includes(buffer.charAt(start - 1))){
    start--;
    if (position - start > MAX_LENGTH / 2 - 1) {
      head = " ... ";
      start += 5;
      break;
    }
  }
  while(end < buffer.length && !DELIMITERS.includes(buffer.charAt(end))){
    end++;
    if (end - position > MAX_LENGTH / 2 - 1) {
      tail = " ... ";
      end -= 5;
      break;
    }
  }
  const snippet = buffer.slice(start, end);
  const indent = " ".repeat(INDENT);
  const caretIndent = " ".repeat(INDENT + position - start + head.length);
  return `${indent + head + snippet + tail}\n${caretIndent}^`;
}
function markToString(buffer, position, line, column) {
  let where = `at line ${line + 1}, column ${column + 1}`;
  const snippet = getSnippet(buffer, position);
  if (snippet) where += `:\n${snippet}`;
  return where;
}
function getIndentStatus(lineIndent, parentIndent) {
  if (lineIndent > parentIndent) return 1;
  if (lineIndent < parentIndent) return -1;
  return 0;
}
function writeFoldedLines(count) {
  if (count === 1) return " ";
  if (count > 1) return "\n".repeat(count - 1);
  return "";
}
class Scanner {
  source;
  #length;
  position = 0;
  constructor(source){
    // Use 0 as string terminator. That significantly simplifies bounds check.
    source += "\0";
    this.source = source;
    this.#length = source.length;
  }
  peek(offset = 0) {
    return this.source.charCodeAt(this.position + offset);
  }
  next() {
    this.position += 1;
  }
  eof() {
    return this.position >= this.#length - 1;
  }
}
export class LoaderState {
  #scanner;
  lineIndent = 0;
  lineStart = 0;
  line = 0;
  onWarning;
  allowDuplicateKeys;
  implicitTypes;
  typeMap;
  checkLineBreaks = false;
  tagMap = new Map();
  anchorMap = new Map();
  constructor(input, { schema = DEFAULT_SCHEMA, onWarning, allowDuplicateKeys = false }){
    this.#scanner = new Scanner(input);
    this.onWarning = onWarning;
    this.allowDuplicateKeys = allowDuplicateKeys;
    this.implicitTypes = schema.implicitTypes;
    this.typeMap = schema.typeMap;
    this.readIndent();
  }
  skipWhitespaces() {
    let ch = this.#scanner.peek();
    while(isWhiteSpace(ch)){
      this.#scanner.next();
      ch = this.#scanner.peek();
    }
  }
  skipComment() {
    let ch = this.#scanner.peek();
    if (ch !== SHARP) return;
    this.#scanner.next();
    ch = this.#scanner.peek();
    while(ch !== 0 && !isEOL(ch)){
      this.#scanner.next();
      ch = this.#scanner.peek();
    }
  }
  readIndent() {
    let ch = this.#scanner.peek();
    while(ch === SPACE){
      this.lineIndent += 1;
      this.#scanner.next();
      ch = this.#scanner.peek();
    }
  }
  #createError(message) {
    const mark = markToString(this.#scanner.source, this.#scanner.position, this.line, this.#scanner.position - this.lineStart);
    return new SyntaxError(`${message} ${mark}`);
  }
  dispatchWarning(message) {
    const error = this.#createError(message);
    this.onWarning?.(error);
  }
  yamlDirectiveHandler(args) {
    if (args.length !== 1) {
      throw this.#createError("Cannot handle YAML directive: YAML directive accepts exactly one argument");
    }
    const match = /^([0-9]+)\.([0-9]+)$/.exec(args[0]);
    if (match === null) {
      throw this.#createError("Cannot handle YAML directive: ill-formed argument");
    }
    const major = parseInt(match[1], 10);
    const minor = parseInt(match[2], 10);
    if (major !== 1) {
      throw this.#createError("Cannot handle YAML directive: unacceptable YAML version");
    }
    this.checkLineBreaks = minor < 2;
    if (minor !== 1 && minor !== 2) {
      this.dispatchWarning("Cannot handle YAML directive: unsupported YAML version");
    }
    return args[0] ?? null;
  }
  tagDirectiveHandler(args) {
    if (args.length !== 2) {
      throw this.#createError(`Cannot handle tag directive: directive accepts exactly two arguments, received ${args.length}`);
    }
    const handle = args[0];
    const prefix = args[1];
    if (!PATTERN_TAG_HANDLE.test(handle)) {
      throw this.#createError(`Cannot handle tag directive: ill-formed handle (first argument) in "${handle}"`);
    }
    if (this.tagMap.has(handle)) {
      throw this.#createError(`Cannot handle tag directive: previously declared suffix for "${handle}" tag handle`);
    }
    if (!PATTERN_TAG_URI.test(prefix)) {
      throw this.#createError("Cannot handle tag directive: ill-formed tag prefix (second argument) of the TAG directive");
    }
    this.tagMap.set(handle, prefix);
  }
  captureSegment(start, end, checkJson) {
    if (start < end) {
      const result = this.#scanner.source.slice(start, end);
      if (checkJson) {
        for(let position = 0; position < result.length; position++){
          const character = result.charCodeAt(position);
          if (!(character === 0x09 || 0x20 <= character && character <= 0x10ffff)) {
            throw this.#createError(`Expected valid JSON character: received "${character}"`);
          }
        }
      } else if (PATTERN_NON_PRINTABLE.test(result)) {
        throw this.#createError("Stream contains non-printable characters");
      }
      return result;
    }
  }
  readBlockSequence(tag, anchor, nodeIndent) {
    let detected = false;
    const result = [];
    if (anchor !== null) this.anchorMap.set(anchor, result);
    let ch = this.#scanner.peek();
    while(ch !== 0){
      if (ch !== MINUS) {
        break;
      }
      const following = this.#scanner.peek(1);
      if (!isWhiteSpaceOrEOL(following)) {
        break;
      }
      detected = true;
      this.#scanner.next();
      if (this.skipSeparationSpace(true, -1)) {
        if (this.lineIndent <= nodeIndent) {
          result.push(null);
          ch = this.#scanner.peek();
          continue;
        }
      }
      const line = this.line;
      const newState = this.composeNode({
        parentIndent: nodeIndent,
        nodeContext: CONTEXT_BLOCK_IN,
        allowToSeek: false,
        allowCompact: true
      });
      if (newState) result.push(newState.result);
      this.skipSeparationSpace(true, -1);
      ch = this.#scanner.peek();
      if ((this.line === line || this.lineIndent > nodeIndent) && ch !== 0) {
        throw this.#createError("Cannot read block sequence: bad indentation of a sequence entry");
      } else if (this.lineIndent < nodeIndent) {
        break;
      }
    }
    if (detected) return {
      tag,
      anchor,
      kind: "sequence",
      result
    };
  }
  mergeMappings(destination, source, overridableKeys) {
    if (!isObject(source)) {
      throw this.#createError("Cannot merge mappings: the provided source object is unacceptable");
    }
    for (const [key, value] of Object.entries(source)){
      if (Object.hasOwn(destination, key)) continue;
      Object.defineProperty(destination, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true
      });
      overridableKeys.add(key);
    }
  }
  storeMappingPair(result, overridableKeys, keyTag, keyNode, valueNode, startLine, startPos) {
    // The output is a plain object here, so keys can only be strings.
    // We need to convert keyNode to a string, but doing so can hang the process
    // (deeply nested arrays that explode exponentially using aliases).
    if (Array.isArray(keyNode)) {
      keyNode = Array.prototype.slice.call(keyNode);
      for(let index = 0; index < keyNode.length; index++){
        if (Array.isArray(keyNode[index])) {
          throw this.#createError("Cannot store mapping pair: nested arrays are not supported inside keys");
        }
        if (typeof keyNode === "object" && isPlainObject(keyNode[index])) {
          keyNode[index] = "[object Object]";
        }
      }
    }
    // Avoid code execution in load() via toString property
    // (still use its own toString for arrays, timestamps,
    // and whatever user schema extensions happen to have @@toStringTag)
    if (typeof keyNode === "object" && isPlainObject(keyNode)) {
      keyNode = "[object Object]";
    }
    keyNode = String(keyNode);
    if (keyTag === "tag:yaml.org,2002:merge") {
      if (Array.isArray(valueNode)) {
        for(let index = 0; index < valueNode.length; index++){
          this.mergeMappings(result, valueNode[index], overridableKeys);
        }
      } else {
        this.mergeMappings(result, valueNode, overridableKeys);
      }
    } else {
      if (!this.allowDuplicateKeys && !overridableKeys.has(keyNode) && Object.hasOwn(result, keyNode)) {
        this.line = startLine || this.line;
        this.#scanner.position = startPos || this.#scanner.position;
        throw this.#createError("Cannot store mapping pair: duplicated key");
      }
      Object.defineProperty(result, keyNode, {
        value: valueNode,
        writable: true,
        enumerable: true,
        configurable: true
      });
      overridableKeys.delete(keyNode);
    }
    return result;
  }
  readLineBreak() {
    const ch = this.#scanner.peek();
    if (ch === LINE_FEED) {
      this.#scanner.next();
    } else if (ch === CARRIAGE_RETURN) {
      this.#scanner.next();
      if (this.#scanner.peek() === LINE_FEED) {
        this.#scanner.next();
      }
    } else {
      throw this.#createError("Cannot read line: line break not found");
    }
    this.line += 1;
    this.lineStart = this.#scanner.position;
  }
  skipSeparationSpace(allowComments, checkIndent) {
    let lineBreaks = 0;
    let ch = this.#scanner.peek();
    while(ch !== 0){
      this.skipWhitespaces();
      ch = this.#scanner.peek();
      if (allowComments) {
        this.skipComment();
        ch = this.#scanner.peek();
      }
      if (isEOL(ch)) {
        this.readLineBreak();
        ch = this.#scanner.peek();
        lineBreaks++;
        this.lineIndent = 0;
        this.readIndent();
        ch = this.#scanner.peek();
      } else {
        break;
      }
    }
    if (checkIndent !== -1 && lineBreaks !== 0 && this.lineIndent < checkIndent) {
      this.dispatchWarning("deficient indentation");
    }
    return lineBreaks;
  }
  testDocumentSeparator() {
    let ch = this.#scanner.peek();
    // Condition this.#scanner.position === this.lineStart is tested
    // in parent on each call, for efficiency. No needs to test here again.
    if ((ch === MINUS || ch === DOT) && ch === this.#scanner.peek(1) && ch === this.#scanner.peek(2)) {
      ch = this.#scanner.peek(3);
      if (ch === 0 || isWhiteSpaceOrEOL(ch)) {
        return true;
      }
    }
    return false;
  }
  readPlainScalar(tag, anchor, nodeIndent, withinFlowCollection) {
    let ch = this.#scanner.peek();
    if (isWhiteSpaceOrEOL(ch) || isFlowIndicator(ch) || ch === SHARP || ch === AMPERSAND || ch === ASTERISK || ch === EXCLAMATION || ch === VERTICAL_LINE || ch === GREATER_THAN || ch === SINGLE_QUOTE || ch === DOUBLE_QUOTE || ch === PERCENT || ch === COMMERCIAL_AT || ch === GRAVE_ACCENT) {
      return;
    }
    let following;
    if (ch === QUESTION || ch === MINUS) {
      following = this.#scanner.peek(1);
      if (isWhiteSpaceOrEOL(following) || withinFlowCollection && isFlowIndicator(following)) {
        return;
      }
    }
    let result = "";
    let captureEnd = this.#scanner.position;
    let captureStart = this.#scanner.position;
    let hasPendingContent = false;
    let line = 0;
    while(ch !== 0){
      if (ch === COLON) {
        following = this.#scanner.peek(1);
        if (isWhiteSpaceOrEOL(following) || withinFlowCollection && isFlowIndicator(following)) {
          break;
        }
      } else if (ch === SHARP) {
        const preceding = this.#scanner.peek(-1);
        if (isWhiteSpaceOrEOL(preceding)) {
          break;
        }
      } else if (this.#scanner.position === this.lineStart && this.testDocumentSeparator() || withinFlowCollection && isFlowIndicator(ch)) {
        break;
      } else if (isEOL(ch)) {
        line = this.line;
        const lineStart = this.lineStart;
        const lineIndent = this.lineIndent;
        this.skipSeparationSpace(false, -1);
        if (this.lineIndent >= nodeIndent) {
          hasPendingContent = true;
          ch = this.#scanner.peek();
          continue;
        } else {
          this.#scanner.position = captureEnd;
          this.line = line;
          this.lineStart = lineStart;
          this.lineIndent = lineIndent;
          break;
        }
      }
      if (hasPendingContent) {
        const segment = this.captureSegment(captureStart, captureEnd, false);
        if (segment) result += segment;
        result += writeFoldedLines(this.line - line);
        captureStart = captureEnd = this.#scanner.position;
        hasPendingContent = false;
      }
      if (!isWhiteSpace(ch)) {
        captureEnd = this.#scanner.position + 1;
      }
      this.#scanner.next();
      ch = this.#scanner.peek();
    }
    const segment = this.captureSegment(captureStart, captureEnd, false);
    if (segment) result += segment;
    if (anchor !== null) this.anchorMap.set(anchor, result);
    if (result) return {
      tag,
      anchor,
      kind: "scalar",
      result
    };
  }
  readSingleQuotedScalar(tag, anchor, nodeIndent) {
    let ch = this.#scanner.peek();
    if (ch !== SINGLE_QUOTE) return;
    let result = "";
    this.#scanner.next();
    let captureStart = this.#scanner.position;
    let captureEnd = this.#scanner.position;
    ch = this.#scanner.peek();
    while(ch !== 0){
      if (ch === SINGLE_QUOTE) {
        const segment = this.captureSegment(captureStart, this.#scanner.position, true);
        if (segment) result += segment;
        this.#scanner.next();
        ch = this.#scanner.peek();
        if (ch === SINGLE_QUOTE) {
          captureStart = this.#scanner.position;
          this.#scanner.next();
          captureEnd = this.#scanner.position;
        } else {
          if (anchor !== null) this.anchorMap.set(anchor, result);
          return {
            tag,
            anchor,
            kind: "scalar",
            result
          };
        }
      } else if (isEOL(ch)) {
        const segment = this.captureSegment(captureStart, captureEnd, true);
        if (segment) result += segment;
        result += writeFoldedLines(this.skipSeparationSpace(false, nodeIndent));
        captureStart = captureEnd = this.#scanner.position;
      } else if (this.#scanner.position === this.lineStart && this.testDocumentSeparator()) {
        throw this.#createError("Unexpected end of the document within a single quoted scalar");
      } else {
        this.#scanner.next();
        captureEnd = this.#scanner.position;
      }
      ch = this.#scanner.peek();
    }
    throw this.#createError("Unexpected end of the stream within a single quoted scalar");
  }
  readDoubleQuotedScalar(tag, anchor, nodeIndent) {
    let ch = this.#scanner.peek();
    if (ch !== DOUBLE_QUOTE) return;
    let result = "";
    this.#scanner.next();
    let captureEnd = this.#scanner.position;
    let captureStart = this.#scanner.position;
    let tmp;
    ch = this.#scanner.peek();
    while(ch !== 0){
      if (ch === DOUBLE_QUOTE) {
        const segment = this.captureSegment(captureStart, this.#scanner.position, true);
        if (segment) result += segment;
        this.#scanner.next();
        if (anchor !== null) this.anchorMap.set(anchor, result);
        return {
          tag,
          anchor,
          kind: "scalar",
          result
        };
      }
      if (ch === BACKSLASH) {
        const segment = this.captureSegment(captureStart, this.#scanner.position, true);
        if (segment) result += segment;
        this.#scanner.next();
        ch = this.#scanner.peek();
        if (isEOL(ch)) {
          this.skipSeparationSpace(false, nodeIndent);
        } else if (ch < 256 && SIMPLE_ESCAPE_SEQUENCES.has(ch)) {
          result += SIMPLE_ESCAPE_SEQUENCES.get(ch);
          this.#scanner.next();
        } else if ((tmp = ESCAPED_HEX_LENGTHS.get(ch) ?? 0) > 0) {
          let hexLength = tmp;
          let hexResult = 0;
          for(; hexLength > 0; hexLength--){
            this.#scanner.next();
            ch = this.#scanner.peek();
            if ((tmp = hexCharCodeToNumber(ch)) >= 0) {
              hexResult = (hexResult << 4) + tmp;
            } else {
              throw this.#createError("Cannot read double quoted scalar: expected hexadecimal character");
            }
          }
          result += codepointToChar(hexResult);
          this.#scanner.next();
        } else {
          throw this.#createError("Cannot read double quoted scalar: unknown escape sequence");
        }
        captureStart = captureEnd = this.#scanner.position;
      } else if (isEOL(ch)) {
        const segment = this.captureSegment(captureStart, captureEnd, true);
        if (segment) result += segment;
        result += writeFoldedLines(this.skipSeparationSpace(false, nodeIndent));
        captureStart = captureEnd = this.#scanner.position;
      } else if (this.#scanner.position === this.lineStart && this.testDocumentSeparator()) {
        throw this.#createError("Unexpected end of the document within a double quoted scalar");
      } else {
        this.#scanner.next();
        captureEnd = this.#scanner.position;
      }
      ch = this.#scanner.peek();
    }
    throw this.#createError("Unexpected end of the stream within a double quoted scalar");
  }
  readFlowCollection(tag, anchor, nodeIndent) {
    let ch = this.#scanner.peek();
    let terminator;
    let isMapping = true;
    let result = {};
    if (ch === LEFT_SQUARE_BRACKET) {
      terminator = RIGHT_SQUARE_BRACKET;
      isMapping = false;
      result = [];
    } else if (ch === LEFT_CURLY_BRACKET) {
      terminator = RIGHT_CURLY_BRACKET;
    } else {
      return;
    }
    if (anchor !== null) this.anchorMap.set(anchor, result);
    this.#scanner.next();
    ch = this.#scanner.peek();
    let readNext = true;
    let valueNode = null;
    let keyNode = null;
    let keyTag = null;
    let isExplicitPair = false;
    let isPair = false;
    let following = 0;
    let line = 0;
    const overridableKeys = new Set();
    while(ch !== 0){
      this.skipSeparationSpace(true, nodeIndent);
      ch = this.#scanner.peek();
      if (ch === terminator) {
        this.#scanner.next();
        const kind = isMapping ? "mapping" : "sequence";
        return {
          tag,
          anchor,
          kind,
          result
        };
      }
      if (!readNext) {
        throw this.#createError("Cannot read flow collection: missing comma between flow collection entries");
      }
      keyTag = keyNode = valueNode = null;
      isPair = isExplicitPair = false;
      if (ch === QUESTION) {
        following = this.#scanner.peek(1);
        if (isWhiteSpaceOrEOL(following)) {
          isPair = isExplicitPair = true;
          this.#scanner.next();
          this.skipSeparationSpace(true, nodeIndent);
        }
      }
      line = this.line;
      const newState = this.composeNode({
        parentIndent: nodeIndent,
        nodeContext: CONTEXT_FLOW_IN,
        allowToSeek: false,
        allowCompact: true
      });
      if (newState) {
        keyTag = newState.tag || null;
        keyNode = newState.result;
      }
      this.skipSeparationSpace(true, nodeIndent);
      ch = this.#scanner.peek();
      if ((isExplicitPair || this.line === line) && ch === COLON) {
        isPair = true;
        this.#scanner.next();
        ch = this.#scanner.peek();
        this.skipSeparationSpace(true, nodeIndent);
        const newState = this.composeNode({
          parentIndent: nodeIndent,
          nodeContext: CONTEXT_FLOW_IN,
          allowToSeek: false,
          allowCompact: true
        });
        if (newState) valueNode = newState.result;
      }
      if (isMapping) {
        this.storeMappingPair(result, overridableKeys, keyTag, keyNode, valueNode);
      } else if (isPair) {
        result.push(this.storeMappingPair({}, overridableKeys, keyTag, keyNode, valueNode));
      } else {
        result.push(keyNode);
      }
      this.skipSeparationSpace(true, nodeIndent);
      ch = this.#scanner.peek();
      if (ch === COMMA) {
        readNext = true;
        this.#scanner.next();
        ch = this.#scanner.peek();
      } else {
        readNext = false;
      }
    }
    throw this.#createError("Cannot read flow collection: unexpected end of the stream within a flow collection");
  }
  // Handles block scaler styles: e.g. '|', '>', '|-' and '>-'.
  // https://yaml.org/spec/1.2.2/#81-block-scalar-styles
  readBlockScalar(tag, anchor, nodeIndent) {
    let chomping = CHOMPING_CLIP;
    let didReadContent = false;
    let detectedIndent = false;
    let textIndent = nodeIndent;
    let emptyLines = 0;
    let atMoreIndented = false;
    let ch = this.#scanner.peek();
    let folding = false;
    if (ch === VERTICAL_LINE) {
      folding = false;
    } else if (ch === GREATER_THAN) {
      folding = true;
    } else {
      return;
    }
    let result = "";
    let tmp = 0;
    while(ch !== 0){
      this.#scanner.next();
      ch = this.#scanner.peek();
      if (ch === PLUS || ch === MINUS) {
        if (CHOMPING_CLIP === chomping) {
          chomping = ch === PLUS ? CHOMPING_KEEP : CHOMPING_STRIP;
        } else {
          throw this.#createError("Cannot read block: chomping mode identifier repeated");
        }
      } else if ((tmp = decimalCharCodeToNumber(ch)) >= 0) {
        if (tmp === 0) {
          throw this.#createError("Cannot read block: indentation width must be greater than 0");
        } else if (!detectedIndent) {
          textIndent = nodeIndent + tmp - 1;
          detectedIndent = true;
        } else {
          throw this.#createError("Cannot read block: indentation width identifier repeated");
        }
      } else {
        break;
      }
    }
    if (isWhiteSpace(ch)) {
      this.skipWhitespaces();
      this.skipComment();
      ch = this.#scanner.peek();
    }
    while(ch !== 0){
      this.readLineBreak();
      this.lineIndent = 0;
      ch = this.#scanner.peek();
      while((!detectedIndent || this.lineIndent < textIndent) && ch === SPACE){
        this.lineIndent++;
        this.#scanner.next();
        ch = this.#scanner.peek();
      }
      if (!detectedIndent && this.lineIndent > textIndent) {
        textIndent = this.lineIndent;
      }
      if (isEOL(ch)) {
        emptyLines++;
        continue;
      }
      // End of the scalar.
      if (this.lineIndent < textIndent) {
        // Perform the chomping.
        if (chomping === CHOMPING_KEEP) {
          result += "\n".repeat(didReadContent ? 1 + emptyLines : emptyLines);
        } else if (chomping === CHOMPING_CLIP) {
          if (didReadContent) {
            // i.e. only if the scalar is not empty.
            result += "\n";
          }
        }
        break;
      }
      // Folded style: use fancy rules to handle line breaks.
      if (folding) {
        // Lines starting with white space characters (more-indented lines) are not folded.
        if (isWhiteSpace(ch)) {
          atMoreIndented = true;
          // except for the first content line (cf. Example 8.1)
          result += "\n".repeat(didReadContent ? 1 + emptyLines : emptyLines);
        // End of more-indented block.
        } else if (atMoreIndented) {
          atMoreIndented = false;
          result += "\n".repeat(emptyLines + 1);
        // Just one line break - perceive as the same line.
        } else if (emptyLines === 0) {
          if (didReadContent) {
            // i.e. only if we have already read some scalar content.
            result += " ";
          }
        // Several line breaks - perceive as different lines.
        } else {
          result += "\n".repeat(emptyLines);
        }
      // Literal style: just add exact number of line breaks between content lines.
      } else {
        // Keep all line breaks except the header line break.
        result += "\n".repeat(didReadContent ? 1 + emptyLines : emptyLines);
      }
      didReadContent = true;
      detectedIndent = true;
      emptyLines = 0;
      const captureStart = this.#scanner.position;
      while(!isEOL(ch) && ch !== 0){
        this.#scanner.next();
        ch = this.#scanner.peek();
      }
      const segment = this.captureSegment(captureStart, this.#scanner.position, false);
      if (segment) result += segment;
    }
    if (anchor !== null) this.anchorMap.set(anchor, result);
    return {
      tag,
      anchor,
      kind: "scalar",
      result
    };
  }
  readBlockMapping(tag, anchor, nodeIndent, flowIndent) {
    const result = {};
    const overridableKeys = new Set();
    let allowCompact = false;
    let line;
    let pos;
    let keyTag = null;
    let keyNode = null;
    let valueNode = null;
    let atExplicitKey = false;
    let detected = false;
    if (anchor !== null) this.anchorMap.set(anchor, result);
    let ch = this.#scanner.peek();
    while(ch !== 0){
      const following = this.#scanner.peek(1);
      line = this.line; // Save the current line.
      pos = this.#scanner.position;
      //
      // Explicit notation case. There are two separate blocks:
      // first for the key (denoted by "?") and second for the value (denoted by ":")
      //
      if ((ch === QUESTION || ch === COLON) && isWhiteSpaceOrEOL(following)) {
        if (ch === QUESTION) {
          if (atExplicitKey) {
            this.storeMappingPair(result, overridableKeys, keyTag, keyNode, null);
            keyTag = null;
            keyNode = null;
            valueNode = null;
          }
          detected = true;
          atExplicitKey = true;
          allowCompact = true;
        } else if (atExplicitKey) {
          // i.e. 0x3A/* : */ === character after the explicit key.
          atExplicitKey = false;
          allowCompact = true;
        } else {
          throw this.#createError("Cannot read block as explicit mapping pair is incomplete: a key node is missed or followed by a non-tabulated empty line");
        }
        this.#scanner.next();
        ch = following;
      //
      // Implicit notation case. Flow-style node as the key first, then ":", and the value.
      //
      } else {
        const newState = this.composeNode({
          parentIndent: flowIndent,
          nodeContext: CONTEXT_FLOW_OUT,
          allowToSeek: false,
          allowCompact: true
        });
        if (!newState) break; // Reading is done. Go to the epilogue.
        if (this.line === line) {
          ch = this.#scanner.peek();
          this.skipWhitespaces();
          ch = this.#scanner.peek();
          if (ch === COLON) {
            this.#scanner.next();
            ch = this.#scanner.peek();
            if (!isWhiteSpaceOrEOL(ch)) {
              throw this.#createError("Cannot read block: a whitespace character is expected after the key-value separator within a block mapping");
            }
            if (atExplicitKey) {
              this.storeMappingPair(result, overridableKeys, keyTag, keyNode, null);
              keyTag = null;
              keyNode = null;
              valueNode = null;
            }
            detected = true;
            atExplicitKey = false;
            allowCompact = false;
            keyTag = newState.tag;
            keyNode = newState.result;
          } else if (detected) {
            throw this.#createError("Cannot read an implicit mapping pair: missing colon");
          } else {
            const { kind, result } = newState;
            return {
              tag,
              anchor,
              kind,
              result
            }; // Keep the result of `composeNode`.
          }
        } else if (detected) {
          throw this.#createError("Cannot read a block mapping entry: a multiline key may not be an implicit key");
        } else {
          const { kind, result } = newState;
          return {
            tag,
            anchor,
            kind,
            result
          }; // Keep the result of `composeNode`.
        }
      }
      //
      // Common reading code for both explicit and implicit notations.
      //
      if (this.line === line || this.lineIndent > nodeIndent) {
        const newState = this.composeNode({
          parentIndent: nodeIndent,
          nodeContext: CONTEXT_BLOCK_OUT,
          allowToSeek: true,
          allowCompact
        });
        if (newState) {
          if (atExplicitKey) {
            keyNode = newState.result;
          } else {
            valueNode = newState.result;
          }
        }
        if (!atExplicitKey) {
          this.storeMappingPair(result, overridableKeys, keyTag, keyNode, valueNode, line, pos);
          keyTag = keyNode = valueNode = null;
        }
        this.skipSeparationSpace(true, -1);
        ch = this.#scanner.peek();
      }
      if (this.lineIndent > nodeIndent && ch !== 0) {
        throw this.#createError("Cannot read block: bad indentation of a mapping entry");
      } else if (this.lineIndent < nodeIndent) {
        break;
      }
    }
    //
    // Epilogue.
    //
    // Special case: last mapping's node contains only the key in explicit notation.
    if (atExplicitKey) {
      this.storeMappingPair(result, overridableKeys, keyTag, keyNode, null);
    }
    // Expose the resulting mapping.
    if (detected) return {
      tag,
      anchor,
      kind: "mapping",
      result
    };
  }
  readTagProperty(tag) {
    let isVerbatim = false;
    let isNamed = false;
    let tagHandle = "";
    let tagName;
    let ch = this.#scanner.peek();
    if (ch !== EXCLAMATION) return;
    if (tag !== null) {
      throw this.#createError("Cannot read tag property: duplication of a tag property");
    }
    this.#scanner.next();
    ch = this.#scanner.peek();
    if (ch === SMALLER_THAN) {
      isVerbatim = true;
      this.#scanner.next();
      ch = this.#scanner.peek();
    } else if (ch === EXCLAMATION) {
      isNamed = true;
      tagHandle = "!!";
      this.#scanner.next();
      ch = this.#scanner.peek();
    } else {
      tagHandle = "!";
    }
    let position = this.#scanner.position;
    if (isVerbatim) {
      do {
        this.#scanner.next();
        ch = this.#scanner.peek();
      }while (ch !== 0 && ch !== GREATER_THAN)
      if (!this.#scanner.eof()) {
        tagName = this.#scanner.source.slice(position, this.#scanner.position);
        this.#scanner.next();
        ch = this.#scanner.peek();
      } else {
        throw this.#createError("Cannot read tag property: unexpected end of stream");
      }
    } else {
      while(ch !== 0 && !isWhiteSpaceOrEOL(ch)){
        if (ch === EXCLAMATION) {
          if (!isNamed) {
            tagHandle = this.#scanner.source.slice(position - 1, this.#scanner.position + 1);
            if (!PATTERN_TAG_HANDLE.test(tagHandle)) {
              throw this.#createError("Cannot read tag property: named tag handle contains invalid characters");
            }
            isNamed = true;
            position = this.#scanner.position + 1;
          } else {
            throw this.#createError("Cannot read tag property: tag suffix cannot contain an exclamation mark");
          }
        }
        this.#scanner.next();
        ch = this.#scanner.peek();
      }
      tagName = this.#scanner.source.slice(position, this.#scanner.position);
      if (PATTERN_FLOW_INDICATORS.test(tagName)) {
        throw this.#createError("Cannot read tag property: tag suffix cannot contain flow indicator characters");
      }
    }
    if (tagName && !PATTERN_TAG_URI.test(tagName)) {
      throw this.#createError(`Cannot read tag property: invalid characters in tag name "${tagName}"`);
    }
    if (isVerbatim) {
      return tagName;
    } else if (this.tagMap.has(tagHandle)) {
      return this.tagMap.get(tagHandle) + tagName;
    } else if (tagHandle === "!") {
      return `!${tagName}`;
    } else if (tagHandle === "!!") {
      return `tag:yaml.org,2002:${tagName}`;
    }
    throw this.#createError(`Cannot read tag property: undeclared tag handle "${tagHandle}"`);
  }
  readAnchorProperty(anchor) {
    let ch = this.#scanner.peek();
    if (ch !== AMPERSAND) return;
    if (anchor !== null) {
      throw this.#createError("Cannot read anchor property: duplicate anchor property");
    }
    this.#scanner.next();
    ch = this.#scanner.peek();
    const position = this.#scanner.position;
    while(ch !== 0 && !isWhiteSpaceOrEOL(ch) && !isFlowIndicator(ch)){
      this.#scanner.next();
      ch = this.#scanner.peek();
    }
    if (this.#scanner.position === position) {
      throw this.#createError("Cannot read anchor property: name of an anchor node must contain at least one character");
    }
    return this.#scanner.source.slice(position, this.#scanner.position);
  }
  readAlias() {
    if (this.#scanner.peek() !== ASTERISK) return;
    this.#scanner.next();
    let ch = this.#scanner.peek();
    const position = this.#scanner.position;
    while(ch !== 0 && !isWhiteSpaceOrEOL(ch) && !isFlowIndicator(ch)){
      this.#scanner.next();
      ch = this.#scanner.peek();
    }
    if (this.#scanner.position === position) {
      throw this.#createError("Cannot read alias: alias name must contain at least one character");
    }
    const alias = this.#scanner.source.slice(position, this.#scanner.position);
    if (!this.anchorMap.has(alias)) {
      throw this.#createError(`Cannot read alias: unidentified alias "${alias}"`);
    }
    this.skipSeparationSpace(true, -1);
    return this.anchorMap.get(alias);
  }
  resolveTag(state) {
    switch(state.tag){
      case null:
      case "!":
        return state;
      case "?":
        {
          for (const type of this.implicitTypes){
            // Implicit resolving is not allowed for non-scalar types, and '?'
            // non-specific tag is only assigned to plain scalars. So, it isn't
            // needed to check for 'kind' conformity.
            if (!type.resolve(state.result)) continue;
            // `state.result` updated in resolver if matched
            const result = type.construct(state.result);
            state.result = result;
            state.tag = type.tag;
            const { anchor } = state;
            if (anchor !== null) this.anchorMap.set(anchor, result);
            return state;
          }
          return state;
        }
    }
    const kind = state.kind ?? "fallback";
    const map = this.typeMap[kind];
    const type = map.get(state.tag);
    if (!type) {
      throw this.#createError(`Cannot resolve unknown tag !<${state.tag}>`);
    }
    if (state.result !== null && type.kind !== state.kind) {
      throw this.#createError(`Unacceptable node kind for !<${state.tag}> tag: it should be "${type.kind}", not "${state.kind}"`);
    }
    if (!type.resolve(state.result)) {
      // `state.result` updated in resolver if matched
      throw this.#createError(`Cannot resolve a node with !<${state.tag}> explicit tag`);
    }
    const result = type.construct(state.result);
    state.result = result;
    const { anchor } = state;
    if (anchor !== null) this.anchorMap.set(anchor, result);
    return state;
  }
  composeNode({ parentIndent, nodeContext, allowToSeek, allowCompact }) {
    let indentStatus = 1; // 1: this>parent, 0: this=parent, -1: this<parent
    let atNewLine = false;
    const allowBlockScalars = CONTEXT_BLOCK_OUT === nodeContext || CONTEXT_BLOCK_IN === nodeContext;
    let allowBlockCollections = allowBlockScalars;
    const allowBlockStyles = allowBlockScalars;
    if (allowToSeek) {
      if (this.skipSeparationSpace(true, -1)) {
        atNewLine = true;
        indentStatus = getIndentStatus(this.lineIndent, parentIndent);
      }
    }
    let tag = null;
    let anchor = null;
    if (indentStatus === 1) {
      while(true){
        const newTag = this.readTagProperty(tag);
        if (newTag) {
          tag = newTag;
        } else {
          const newAnchor = this.readAnchorProperty(anchor);
          if (!newAnchor) break;
          anchor = newAnchor;
        }
        if (this.skipSeparationSpace(true, -1)) {
          atNewLine = true;
          allowBlockCollections = allowBlockStyles;
          indentStatus = getIndentStatus(this.lineIndent, parentIndent);
        } else {
          allowBlockCollections = false;
        }
      }
    }
    if (allowBlockCollections) {
      allowBlockCollections = atNewLine || allowCompact;
    }
    if (indentStatus === 1) {
      const cond = CONTEXT_FLOW_IN === nodeContext || CONTEXT_FLOW_OUT === nodeContext;
      const flowIndent = cond ? parentIndent : parentIndent + 1;
      if (allowBlockCollections) {
        const blockIndent = this.#scanner.position - this.lineStart;
        const blockSequenceState = this.readBlockSequence(tag, anchor, blockIndent);
        if (blockSequenceState) return this.resolveTag(blockSequenceState);
        const blockMappingState = this.readBlockMapping(tag, anchor, blockIndent, flowIndent);
        if (blockMappingState) return this.resolveTag(blockMappingState);
      }
      const flowCollectionState = this.readFlowCollection(tag, anchor, flowIndent);
      if (flowCollectionState) return this.resolveTag(flowCollectionState);
      if (allowBlockScalars) {
        const blockScalarState = this.readBlockScalar(tag, anchor, flowIndent);
        if (blockScalarState) return this.resolveTag(blockScalarState);
      }
      const singleQuoteState = this.readSingleQuotedScalar(tag, anchor, flowIndent);
      if (singleQuoteState) return this.resolveTag(singleQuoteState);
      const doubleQuoteState = this.readDoubleQuotedScalar(tag, anchor, flowIndent);
      if (doubleQuoteState) return this.resolveTag(doubleQuoteState);
      const alias = this.readAlias();
      if (alias) {
        if (tag !== null || anchor !== null) {
          throw this.#createError("Cannot compose node: alias node should not have any properties");
        }
        return this.resolveTag({
          tag,
          anchor,
          kind: null,
          result: alias
        });
      }
      const plainScalarState = this.readPlainScalar(tag, anchor, flowIndent, CONTEXT_FLOW_IN === nodeContext);
      if (plainScalarState) {
        plainScalarState.tag ??= "?";
        return this.resolveTag(plainScalarState);
      }
    } else if (indentStatus === 0 && CONTEXT_BLOCK_OUT === nodeContext && allowBlockCollections) {
      // Special case: block sequences are allowed to have same indentation level as the parent.
      // http://www.yaml.org/spec/1.2/spec.html#id2799784
      const blockIndent = this.#scanner.position - this.lineStart;
      const newState = this.readBlockSequence(tag, anchor, blockIndent);
      if (newState) return this.resolveTag(newState);
    }
    const newState = this.resolveTag({
      tag,
      anchor,
      kind: null,
      result: null
    });
    if (newState.tag !== null || newState.anchor !== null) return newState;
  }
  readDirectives() {
    let hasDirectives = false;
    let version = null;
    let ch = this.#scanner.peek();
    while(ch !== 0){
      this.skipSeparationSpace(true, -1);
      ch = this.#scanner.peek();
      if (this.lineIndent > 0 || ch !== PERCENT) {
        break;
      }
      hasDirectives = true;
      this.#scanner.next();
      ch = this.#scanner.peek();
      let position = this.#scanner.position;
      while(ch !== 0 && !isWhiteSpaceOrEOL(ch)){
        this.#scanner.next();
        ch = this.#scanner.peek();
      }
      const directiveName = this.#scanner.source.slice(position, this.#scanner.position);
      const directiveArgs = [];
      if (directiveName.length < 1) {
        throw this.#createError("Cannot read document: directive name length must be greater than zero");
      }
      while(ch !== 0){
        this.skipWhitespaces();
        this.skipComment();
        ch = this.#scanner.peek();
        if (isEOL(ch)) break;
        position = this.#scanner.position;
        while(ch !== 0 && !isWhiteSpaceOrEOL(ch)){
          this.#scanner.next();
          ch = this.#scanner.peek();
        }
        directiveArgs.push(this.#scanner.source.slice(position, this.#scanner.position));
      }
      if (ch !== 0) this.readLineBreak();
      switch(directiveName){
        case "YAML":
          if (version !== null) {
            throw this.#createError("Cannot handle YAML directive: duplication of %YAML directive");
          }
          version = this.yamlDirectiveHandler(directiveArgs);
          break;
        case "TAG":
          this.tagDirectiveHandler(directiveArgs);
          break;
        default:
          this.dispatchWarning(`unknown document directive "${directiveName}"`);
          break;
      }
      ch = this.#scanner.peek();
    }
    return hasDirectives;
  }
  readDocument() {
    const documentStart = this.#scanner.position;
    this.checkLineBreaks = false;
    this.tagMap = new Map();
    this.anchorMap = new Map();
    const hasDirectives = this.readDirectives();
    this.skipSeparationSpace(true, -1);
    let result = null;
    if (this.lineIndent === 0 && this.#scanner.peek() === MINUS && this.#scanner.peek(1) === MINUS && this.#scanner.peek(2) === MINUS) {
      this.#scanner.position += 3;
      this.skipSeparationSpace(true, -1);
    } else if (hasDirectives) {
      throw this.#createError("Cannot read document: directives end mark is expected");
    }
    const newState = this.composeNode({
      parentIndent: this.lineIndent - 1,
      nodeContext: CONTEXT_BLOCK_OUT,
      allowToSeek: false,
      allowCompact: true
    });
    if (newState) result = newState.result;
    this.skipSeparationSpace(true, -1);
    if (this.checkLineBreaks && PATTERN_NON_ASCII_LINE_BREAKS.test(this.#scanner.source.slice(documentStart, this.#scanner.position))) {
      this.dispatchWarning("non-ASCII line breaks are interpreted as content");
    }
    if (this.#scanner.position === this.lineStart && this.testDocumentSeparator()) {
      if (this.#scanner.peek() === DOT) {
        this.#scanner.position += 3;
        this.skipSeparationSpace(true, -1);
      }
    } else if (!this.#scanner.eof()) {
      throw this.#createError("Cannot read document: end of the stream or a document separator is expected");
    }
    return result;
  }
  *readDocuments() {
    while(!this.#scanner.eof()){
      yield this.readDocument();
    }
  }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQveWFtbC8xLjAuMTIvX2xvYWRlcl9zdGF0ZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBQb3J0ZWQgZnJvbSBqcy15YW1sIHYzLjEzLjE6XG4vLyBodHRwczovL2dpdGh1Yi5jb20vbm9kZWNhL2pzLXlhbWwvY29tbWl0LzY2NWFhZGRhNDIzNDlkY2FlODY5ZjEyMDQwZDliMTBlZjE4ZDEyZGFcbi8vIENvcHlyaWdodCAyMDExLTIwMTUgYnkgVml0YWx5IFB1enJpbi4gQWxsIHJpZ2h0cyByZXNlcnZlZC4gTUlUIGxpY2Vuc2UuXG4vLyBDb3B5cmlnaHQgMjAxOC0yMDI2IHRoZSBEZW5vIGF1dGhvcnMuIE1JVCBsaWNlbnNlLlxuXG5pbXBvcnQge1xuICBBTVBFUlNBTkQsXG4gIEFTVEVSSVNLLFxuICBCQUNLU0xBU0gsXG4gIENBUlJJQUdFX1JFVFVSTixcbiAgQ09MT04sXG4gIENPTU1BLFxuICBDT01NRVJDSUFMX0FULFxuICBET1QsXG4gIERPVUJMRV9RVU9URSxcbiAgRVhDTEFNQVRJT04sXG4gIEdSQVZFX0FDQ0VOVCxcbiAgR1JFQVRFUl9USEFOLFxuICBpc0VPTCxcbiAgaXNGbG93SW5kaWNhdG9yLFxuICBpc1doaXRlU3BhY2UsXG4gIGlzV2hpdGVTcGFjZU9yRU9MLFxuICBMRUZUX0NVUkxZX0JSQUNLRVQsXG4gIExFRlRfU1FVQVJFX0JSQUNLRVQsXG4gIExJTkVfRkVFRCxcbiAgTUlOVVMsXG4gIFBFUkNFTlQsXG4gIFBMVVMsXG4gIFFVRVNUSU9OLFxuICBSSUdIVF9DVVJMWV9CUkFDS0VULFxuICBSSUdIVF9TUVVBUkVfQlJBQ0tFVCxcbiAgU0hBUlAsXG4gIFNJTkdMRV9RVU9URSxcbiAgU01BTExFUl9USEFOLFxuICBTUEFDRSxcbiAgVkVSVElDQUxfTElORSxcbn0gZnJvbSBcIi4vX2NoYXJzLnRzXCI7XG5cbmltcG9ydCB7IERFRkFVTFRfU0NIRU1BLCB0eXBlIFNjaGVtYSwgdHlwZSBUeXBlTWFwIH0gZnJvbSBcIi4vX3NjaGVtYS50c1wiO1xuaW1wb3J0IHR5cGUgeyBLaW5kVHlwZSwgVHlwZSB9IGZyb20gXCIuL190eXBlLnRzXCI7XG5pbXBvcnQgeyBpc09iamVjdCwgaXNQbGFpbk9iamVjdCB9IGZyb20gXCIuL191dGlscy50c1wiO1xuXG5jb25zdCBDT05URVhUX0ZMT1dfSU4gPSAxO1xuY29uc3QgQ09OVEVYVF9GTE9XX09VVCA9IDI7XG5jb25zdCBDT05URVhUX0JMT0NLX0lOID0gMztcbmNvbnN0IENPTlRFWFRfQkxPQ0tfT1VUID0gNDtcblxuY29uc3QgQ0hPTVBJTkdfQ0xJUCA9IDE7XG5jb25zdCBDSE9NUElOR19TVFJJUCA9IDI7XG5jb25zdCBDSE9NUElOR19LRUVQID0gMztcblxuY29uc3QgUEFUVEVSTl9OT05fUFJJTlRBQkxFID1cbiAgLy8gZGVuby1saW50LWlnbm9yZSBuby1jb250cm9sLXJlZ2V4XG4gIC9bXFx4MDAtXFx4MDhcXHgwQlxceDBDXFx4MEUtXFx4MUZcXHg3Ri1cXHg4NFxceDg2LVxceDlGXFx1RkZGRVxcdUZGRkZdfFtcXHVEODAwLVxcdURCRkZdKD8hW1xcdURDMDAtXFx1REZGRl0pfCg/OlteXFx1RDgwMC1cXHVEQkZGXXxeKVtcXHVEQzAwLVxcdURGRkZdLztcbmNvbnN0IFBBVFRFUk5fTk9OX0FTQ0lJX0xJTkVfQlJFQUtTID0gL1tcXHg4NVxcdTIwMjhcXHUyMDI5XS87XG5jb25zdCBQQVRURVJOX0ZMT1dfSU5ESUNBVE9SUyA9IC9bLFxcW1xcXVxce1xcfV0vO1xuY29uc3QgUEFUVEVSTl9UQUdfSEFORExFID0gL14oPzohfCEhfCFbYS16XFwtXSshKSQvaTtcbmNvbnN0IFBBVFRFUk5fVEFHX1VSSSA9XG4gIC9eKD86IXxbXixcXFtcXF1cXHtcXH1dKSg/OiVbMC05YS1mXXsyfXxbMC05YS16XFwtIztcXC9cXD86QCY9XFwrXFwkLF9cXC4hflxcKidcXChcXClcXFtcXF1dKSokL2k7XG5cbmV4cG9ydCBpbnRlcmZhY2UgTG9hZGVyU3RhdGVPcHRpb25zIHtcbiAgLyoqIHNwZWNpZmllcyBhIHNjaGVtYSB0byB1c2UuICovXG4gIHNjaGVtYT86IFNjaGVtYTtcbiAgLyoqIGNvbXBhdGliaWxpdHkgd2l0aCBKU09OLnBhcnNlIGJlaGF2aW91ci4gKi9cbiAgYWxsb3dEdXBsaWNhdGVLZXlzPzogYm9vbGVhbjtcbiAgLyoqIGZ1bmN0aW9uIHRvIGNhbGwgb24gd2FybmluZyBtZXNzYWdlcy4gKi9cbiAgb25XYXJuaW5nPyhlcnJvcjogRXJyb3IpOiB2b2lkO1xufVxuXG5jb25zdCBFU0NBUEVEX0hFWF9MRU5HVEhTID0gbmV3IE1hcDxudW1iZXIsIG51bWJlcj4oW1xuICBbMHg3OCwgMl0sIC8vIHhcbiAgWzB4NzUsIDRdLCAvLyB1XG4gIFsweDU1LCA4XSwgLy8gVVxuXSk7XG5cbmNvbnN0IFNJTVBMRV9FU0NBUEVfU0VRVUVOQ0VTID0gbmV3IE1hcDxudW1iZXIsIHN0cmluZz4oW1xuICBbMHgzMCwgXCJcXHgwMFwiXSwgLy8gMFxuICBbMHg2MSwgXCJcXHgwN1wiXSwgLy8gYVxuICBbMHg2MiwgXCJcXHgwOFwiXSwgLy8gYlxuICBbMHg3NCwgXCJcXHgwOVwiXSwgLy8gdFxuICBbMHgwOSwgXCJcXHgwOVwiXSwgLy8gVGFiXG4gIFsweDZlLCBcIlxceDBBXCJdLCAvLyBuXG4gIFsweDc2LCBcIlxceDBCXCJdLCAvLyB2XG4gIFsweDY2LCBcIlxceDBDXCJdLCAvLyBmXG4gIFsweDcyLCBcIlxceDBEXCJdLCAvLyByXG4gIFsweDY1LCBcIlxceDFCXCJdLCAvLyBlXG4gIFsweDIwLCBcIiBcIl0sIC8vIFNwYWNlXG4gIFsweDIyLCAnXCInXSwgLy8gXCJcbiAgWzB4MmYsIFwiL1wiXSwgLy8gL1xuICBbMHg1YywgXCJcXFxcXCJdLCAvLyBcXFxuICBbMHg0ZSwgXCJcXHg4NVwiXSwgLy8gTlxuICBbMHg1ZiwgXCJcXHhBMFwiXSwgLy8gX1xuICBbMHg0YywgXCJcXHUyMDI4XCJdLCAvLyBMXG4gIFsweDUwLCBcIlxcdTIwMjlcIl0sIC8vIFBcbl0pO1xuXG4vKipcbiAqIENvbnZlcnRzIGEgaGV4YWRlY2ltYWwgY2hhcmFjdGVyIGNvZGUgdG8gaXRzIGRlY2ltYWwgdmFsdWUuXG4gKi9cbmZ1bmN0aW9uIGhleENoYXJDb2RlVG9OdW1iZXIoY2hhckNvZGU6IG51bWJlcikge1xuICAvLyBDaGVjayBpZiB0aGUgY2hhcmFjdGVyIGNvZGUgaXMgaW4gdGhlIHJhbmdlIGZvciAnMCcgdG8gJzknXG4gIGlmICgweDMwIDw9IGNoYXJDb2RlICYmIGNoYXJDb2RlIDw9IDB4MzkpIHJldHVybiBjaGFyQ29kZSAtIDB4MzA7IC8vIENvbnZlcnQgJzAnLSc5JyB0byAwLTlcblxuICAvLyBOb3JtYWxpemUgdGhlIGNoYXJhY3RlciBjb2RlIHRvIGxvd2VyY2FzZSBpZiBpdCdzIGEgbGV0dGVyXG4gIGNvbnN0IGxjID0gY2hhckNvZGUgfCAweDIwO1xuXG4gIC8vIENoZWNrIGlmIHRoZSBjaGFyYWN0ZXIgY29kZSBpcyBpbiB0aGUgcmFuZ2UgZm9yICdhJyB0byAnZidcbiAgaWYgKDB4NjEgPD0gbGMgJiYgbGMgPD0gMHg2NikgcmV0dXJuIGxjIC0gMHg2MSArIDEwOyAvLyBDb252ZXJ0ICdhJy0nZicgdG8gMTAtMTVcblxuICByZXR1cm4gLTE7XG59XG5cbi8qKlxuICogQ29udmVydHMgYSBkZWNpbWFsIGNoYXJhY3RlciBjb2RlIHRvIGl0cyBkZWNpbWFsIHZhbHVlLlxuICovXG5mdW5jdGlvbiBkZWNpbWFsQ2hhckNvZGVUb051bWJlcihjaGFyQ29kZTogbnVtYmVyKTogbnVtYmVyIHtcbiAgLy8gQ2hlY2sgaWYgdGhlIGNoYXJhY3RlciBjb2RlIGlzIGluIHRoZSByYW5nZSBmb3IgJzAnIHRvICc5J1xuICBpZiAoMHgzMCA8PSBjaGFyQ29kZSAmJiBjaGFyQ29kZSA8PSAweDM5KSByZXR1cm4gY2hhckNvZGUgLSAweDMwOyAvLyBDb252ZXJ0ICcwJy0nOScgdG8gMC05XG4gIHJldHVybiAtMTtcbn1cblxuLyoqXG4gKiBDb252ZXJ0cyBhIFVuaWNvZGUgY29kZSBwb2ludCB0byBhIHN0cmluZy5cbiAqL1xuZnVuY3Rpb24gY29kZXBvaW50VG9DaGFyKGNvZGVwb2ludDogbnVtYmVyKTogc3RyaW5nIHtcbiAgLy8gQ2hlY2sgaWYgdGhlIGNvZGUgcG9pbnQgaXMgd2l0aGluIHRoZSBCYXNpYyBNdWx0aWxpbmd1YWwgUGxhbmUgKEJNUClcbiAgaWYgKGNvZGVwb2ludCA8PSAweGZmZmYpIHJldHVybiBTdHJpbmcuZnJvbUNoYXJDb2RlKGNvZGVwb2ludCk7IC8vIENvbnZlcnQgQk1QIGNvZGUgcG9pbnQgdG8gY2hhcmFjdGVyXG5cbiAgLy8gRW5jb2RlIFVURi0xNiBzdXJyb2dhdGUgcGFpciBmb3IgY29kZSBwb2ludHMgYmV5b25kIEJNUFxuICAvLyBSZWZlcmVuY2U6IGh0dHBzOi8vZW4ud2lraXBlZGlhLm9yZy93aWtpL1VURi0xNiNDb2RlX3BvaW50c19VLjJCMDEwMDAwX3RvX1UuMkIxMEZGRkZcbiAgcmV0dXJuIFN0cmluZy5mcm9tQ2hhckNvZGUoXG4gICAgKChjb2RlcG9pbnQgLSAweDAxMDAwMCkgPj4gMTApICsgMHhkODAwLCAvLyBIaWdoIHN1cnJvZ2F0ZVxuICAgICgoY29kZXBvaW50IC0gMHgwMTAwMDApICYgMHgwM2ZmKSArIDB4ZGMwMCwgLy8gTG93IHN1cnJvZ2F0ZVxuICApO1xufVxuXG5jb25zdCBJTkRFTlQgPSA0O1xuY29uc3QgTUFYX0xFTkdUSCA9IDc1O1xuY29uc3QgREVMSU1JVEVSUyA9IFwiXFx4MDBcXHJcXG5cXHg4NVxcdTIwMjhcXHUyMDI5XCI7XG5cbmZ1bmN0aW9uIGdldFNuaXBwZXQoYnVmZmVyOiBzdHJpbmcsIHBvc2l0aW9uOiBudW1iZXIpOiBzdHJpbmcgfCBudWxsIHtcbiAgaWYgKCFidWZmZXIpIHJldHVybiBudWxsO1xuICBsZXQgc3RhcnQgPSBwb3NpdGlvbjtcbiAgbGV0IGVuZCA9IHBvc2l0aW9uO1xuICBsZXQgaGVhZCA9IFwiXCI7XG4gIGxldCB0YWlsID0gXCJcIjtcblxuICB3aGlsZSAoc3RhcnQgPiAwICYmICFERUxJTUlURVJTLmluY2x1ZGVzKGJ1ZmZlci5jaGFyQXQoc3RhcnQgLSAxKSkpIHtcbiAgICBzdGFydC0tO1xuICAgIGlmIChwb3NpdGlvbiAtIHN0YXJ0ID4gTUFYX0xFTkdUSCAvIDIgLSAxKSB7XG4gICAgICBoZWFkID0gXCIgLi4uIFwiO1xuICAgICAgc3RhcnQgKz0gNTtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgfVxuXG4gIHdoaWxlIChlbmQgPCBidWZmZXIubGVuZ3RoICYmICFERUxJTUlURVJTLmluY2x1ZGVzKGJ1ZmZlci5jaGFyQXQoZW5kKSkpIHtcbiAgICBlbmQrKztcbiAgICBpZiAoZW5kIC0gcG9zaXRpb24gPiBNQVhfTEVOR1RIIC8gMiAtIDEpIHtcbiAgICAgIHRhaWwgPSBcIiAuLi4gXCI7XG4gICAgICBlbmQgLT0gNTtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IHNuaXBwZXQgPSBidWZmZXIuc2xpY2Uoc3RhcnQsIGVuZCk7XG4gIGNvbnN0IGluZGVudCA9IFwiIFwiLnJlcGVhdChJTkRFTlQpO1xuICBjb25zdCBjYXJldEluZGVudCA9IFwiIFwiLnJlcGVhdChJTkRFTlQgKyBwb3NpdGlvbiAtIHN0YXJ0ICsgaGVhZC5sZW5ndGgpO1xuICByZXR1cm4gYCR7aW5kZW50ICsgaGVhZCArIHNuaXBwZXQgKyB0YWlsfVxcbiR7Y2FyZXRJbmRlbnR9XmA7XG59XG5cbmZ1bmN0aW9uIG1hcmtUb1N0cmluZyhcbiAgYnVmZmVyOiBzdHJpbmcsXG4gIHBvc2l0aW9uOiBudW1iZXIsXG4gIGxpbmU6IG51bWJlcixcbiAgY29sdW1uOiBudW1iZXIsXG4pOiBzdHJpbmcge1xuICBsZXQgd2hlcmUgPSBgYXQgbGluZSAke2xpbmUgKyAxfSwgY29sdW1uICR7Y29sdW1uICsgMX1gO1xuICBjb25zdCBzbmlwcGV0ID0gZ2V0U25pcHBldChidWZmZXIsIHBvc2l0aW9uKTtcbiAgaWYgKHNuaXBwZXQpIHdoZXJlICs9IGA6XFxuJHtzbmlwcGV0fWA7XG4gIHJldHVybiB3aGVyZTtcbn1cblxuZnVuY3Rpb24gZ2V0SW5kZW50U3RhdHVzKGxpbmVJbmRlbnQ6IG51bWJlciwgcGFyZW50SW5kZW50OiBudW1iZXIpIHtcbiAgaWYgKGxpbmVJbmRlbnQgPiBwYXJlbnRJbmRlbnQpIHJldHVybiAxO1xuICBpZiAobGluZUluZGVudCA8IHBhcmVudEluZGVudCkgcmV0dXJuIC0xO1xuICByZXR1cm4gMDtcbn1cblxuZnVuY3Rpb24gd3JpdGVGb2xkZWRMaW5lcyhjb3VudDogbnVtYmVyKSB7XG4gIGlmIChjb3VudCA9PT0gMSkgcmV0dXJuIFwiIFwiO1xuICBpZiAoY291bnQgPiAxKSByZXR1cm4gXCJcXG5cIi5yZXBlYXQoY291bnQgLSAxKTtcbiAgcmV0dXJuIFwiXCI7XG59XG5cbmNsYXNzIFNjYW5uZXIge1xuICBzb3VyY2U6IHN0cmluZztcbiAgI2xlbmd0aDogbnVtYmVyO1xuICBwb3NpdGlvbiA9IDA7XG5cbiAgY29uc3RydWN0b3Ioc291cmNlOiBzdHJpbmcpIHtcbiAgICAvLyBVc2UgMCBhcyBzdHJpbmcgdGVybWluYXRvci4gVGhhdCBzaWduaWZpY2FudGx5IHNpbXBsaWZpZXMgYm91bmRzIGNoZWNrLlxuICAgIHNvdXJjZSArPSBcIlxcMFwiO1xuICAgIHRoaXMuc291cmNlID0gc291cmNlO1xuICAgIHRoaXMuI2xlbmd0aCA9IHNvdXJjZS5sZW5ndGg7XG4gIH1cblxuICBwZWVrKG9mZnNldCA9IDApIHtcbiAgICByZXR1cm4gdGhpcy5zb3VyY2UuY2hhckNvZGVBdCh0aGlzLnBvc2l0aW9uICsgb2Zmc2V0KTtcbiAgfVxuXG4gIG5leHQoKSB7XG4gICAgdGhpcy5wb3NpdGlvbiArPSAxO1xuICB9XG5cbiAgZW9mKCkge1xuICAgIHJldHVybiB0aGlzLnBvc2l0aW9uID49IHRoaXMuI2xlbmd0aCAtIDE7XG4gIH1cbn1cblxuaW50ZXJmYWNlIFN0YXRlIHtcbiAgdGFnOiBzdHJpbmcgfCBudWxsO1xuICBhbmNob3I6IHN0cmluZyB8IG51bGw7XG4gIGtpbmQ6IEtpbmRUeXBlIHwgbnVsbDtcbiAgcmVzdWx0OiB1bmtub3duW10gfCBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHN0cmluZyB8IG51bGw7XG59XG5leHBvcnQgY2xhc3MgTG9hZGVyU3RhdGUge1xuICAjc2Nhbm5lcjogU2Nhbm5lcjtcbiAgbGluZUluZGVudCA9IDA7XG4gIGxpbmVTdGFydCA9IDA7XG4gIGxpbmUgPSAwO1xuICBvbldhcm5pbmc6ICgoZXJyb3I6IEVycm9yKSA9PiB2b2lkKSB8IHVuZGVmaW5lZDtcbiAgYWxsb3dEdXBsaWNhdGVLZXlzOiBib29sZWFuO1xuICBpbXBsaWNpdFR5cGVzOiBUeXBlPFwic2NhbGFyXCI+W107XG4gIHR5cGVNYXA6IFR5cGVNYXA7XG5cbiAgY2hlY2tMaW5lQnJlYWtzID0gZmFsc2U7XG4gIHRhZ01hcCA9IG5ldyBNYXAoKTtcbiAgYW5jaG9yTWFwID0gbmV3IE1hcCgpO1xuXG4gIGNvbnN0cnVjdG9yKFxuICAgIGlucHV0OiBzdHJpbmcsXG4gICAge1xuICAgICAgc2NoZW1hID0gREVGQVVMVF9TQ0hFTUEsXG4gICAgICBvbldhcm5pbmcsXG4gICAgICBhbGxvd0R1cGxpY2F0ZUtleXMgPSBmYWxzZSxcbiAgICB9OiBMb2FkZXJTdGF0ZU9wdGlvbnMsXG4gICkge1xuICAgIHRoaXMuI3NjYW5uZXIgPSBuZXcgU2Nhbm5lcihpbnB1dCk7XG4gICAgdGhpcy5vbldhcm5pbmcgPSBvbldhcm5pbmc7XG4gICAgdGhpcy5hbGxvd0R1cGxpY2F0ZUtleXMgPSBhbGxvd0R1cGxpY2F0ZUtleXM7XG4gICAgdGhpcy5pbXBsaWNpdFR5cGVzID0gc2NoZW1hLmltcGxpY2l0VHlwZXM7XG4gICAgdGhpcy50eXBlTWFwID0gc2NoZW1hLnR5cGVNYXA7XG5cbiAgICB0aGlzLnJlYWRJbmRlbnQoKTtcbiAgfVxuXG4gIHNraXBXaGl0ZXNwYWNlcygpIHtcbiAgICBsZXQgY2ggPSB0aGlzLiNzY2FubmVyLnBlZWsoKTtcbiAgICB3aGlsZSAoaXNXaGl0ZVNwYWNlKGNoKSkge1xuICAgICAgdGhpcy4jc2Nhbm5lci5uZXh0KCk7XG4gICAgICBjaCA9IHRoaXMuI3NjYW5uZXIucGVlaygpO1xuICAgIH1cbiAgfVxuXG4gIHNraXBDb21tZW50KCkge1xuICAgIGxldCBjaCA9IHRoaXMuI3NjYW5uZXIucGVlaygpO1xuICAgIGlmIChjaCAhPT0gU0hBUlApIHJldHVybjtcbiAgICB0aGlzLiNzY2FubmVyLm5leHQoKTtcbiAgICBjaCA9IHRoaXMuI3NjYW5uZXIucGVlaygpO1xuICAgIHdoaWxlIChjaCAhPT0gMCAmJiAhaXNFT0woY2gpKSB7XG4gICAgICB0aGlzLiNzY2FubmVyLm5leHQoKTtcbiAgICAgIGNoID0gdGhpcy4jc2Nhbm5lci5wZWVrKCk7XG4gICAgfVxuICB9XG5cbiAgcmVhZEluZGVudCgpIHtcbiAgICBsZXQgY2ggPSB0aGlzLiNzY2FubmVyLnBlZWsoKTtcbiAgICB3aGlsZSAoY2ggPT09IFNQQUNFKSB7XG4gICAgICB0aGlzLmxpbmVJbmRlbnQgKz0gMTtcbiAgICAgIHRoaXMuI3NjYW5uZXIubmV4dCgpO1xuICAgICAgY2ggPSB0aGlzLiNzY2FubmVyLnBlZWsoKTtcbiAgICB9XG4gIH1cblxuICAjY3JlYXRlRXJyb3IobWVzc2FnZTogc3RyaW5nKTogU3ludGF4RXJyb3Ige1xuICAgIGNvbnN0IG1hcmsgPSBtYXJrVG9TdHJpbmcoXG4gICAgICB0aGlzLiNzY2FubmVyLnNvdXJjZSxcbiAgICAgIHRoaXMuI3NjYW5uZXIucG9zaXRpb24sXG4gICAgICB0aGlzLmxpbmUsXG4gICAgICB0aGlzLiNzY2FubmVyLnBvc2l0aW9uIC0gdGhpcy5saW5lU3RhcnQsXG4gICAgKTtcbiAgICByZXR1cm4gbmV3IFN5bnRheEVycm9yKGAke21lc3NhZ2V9ICR7bWFya31gKTtcbiAgfVxuXG4gIGRpc3BhdGNoV2FybmluZyhtZXNzYWdlOiBzdHJpbmcpIHtcbiAgICBjb25zdCBlcnJvciA9IHRoaXMuI2NyZWF0ZUVycm9yKG1lc3NhZ2UpO1xuICAgIHRoaXMub25XYXJuaW5nPy4oZXJyb3IpO1xuICB9XG5cbiAgeWFtbERpcmVjdGl2ZUhhbmRsZXIoYXJnczogc3RyaW5nW10pOiBzdHJpbmcgfCBudWxsIHtcbiAgICBpZiAoYXJncy5sZW5ndGggIT09IDEpIHtcbiAgICAgIHRocm93IHRoaXMuI2NyZWF0ZUVycm9yKFxuICAgICAgICBcIkNhbm5vdCBoYW5kbGUgWUFNTCBkaXJlY3RpdmU6IFlBTUwgZGlyZWN0aXZlIGFjY2VwdHMgZXhhY3RseSBvbmUgYXJndW1lbnRcIixcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3QgbWF0Y2ggPSAvXihbMC05XSspXFwuKFswLTldKykkLy5leGVjKGFyZ3NbMF0hKTtcbiAgICBpZiAobWF0Y2ggPT09IG51bGwpIHtcbiAgICAgIHRocm93IHRoaXMuI2NyZWF0ZUVycm9yKFxuICAgICAgICBcIkNhbm5vdCBoYW5kbGUgWUFNTCBkaXJlY3RpdmU6IGlsbC1mb3JtZWQgYXJndW1lbnRcIixcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3QgbWFqb3IgPSBwYXJzZUludChtYXRjaFsxXSEsIDEwKTtcbiAgICBjb25zdCBtaW5vciA9IHBhcnNlSW50KG1hdGNoWzJdISwgMTApO1xuICAgIGlmIChtYWpvciAhPT0gMSkge1xuICAgICAgdGhyb3cgdGhpcy4jY3JlYXRlRXJyb3IoXG4gICAgICAgIFwiQ2Fubm90IGhhbmRsZSBZQU1MIGRpcmVjdGl2ZTogdW5hY2NlcHRhYmxlIFlBTUwgdmVyc2lvblwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgdGhpcy5jaGVja0xpbmVCcmVha3MgPSBtaW5vciA8IDI7XG4gICAgaWYgKG1pbm9yICE9PSAxICYmIG1pbm9yICE9PSAyKSB7XG4gICAgICB0aGlzLmRpc3BhdGNoV2FybmluZyhcbiAgICAgICAgXCJDYW5ub3QgaGFuZGxlIFlBTUwgZGlyZWN0aXZlOiB1bnN1cHBvcnRlZCBZQU1MIHZlcnNpb25cIixcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiBhcmdzWzBdID8/IG51bGw7XG4gIH1cbiAgdGFnRGlyZWN0aXZlSGFuZGxlcihhcmdzOiBzdHJpbmdbXSkge1xuICAgIGlmIChhcmdzLmxlbmd0aCAhPT0gMikge1xuICAgICAgdGhyb3cgdGhpcy4jY3JlYXRlRXJyb3IoXG4gICAgICAgIGBDYW5ub3QgaGFuZGxlIHRhZyBkaXJlY3RpdmU6IGRpcmVjdGl2ZSBhY2NlcHRzIGV4YWN0bHkgdHdvIGFyZ3VtZW50cywgcmVjZWl2ZWQgJHthcmdzLmxlbmd0aH1gLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCBoYW5kbGUgPSBhcmdzWzBdITtcbiAgICBjb25zdCBwcmVmaXggPSBhcmdzWzFdITtcblxuICAgIGlmICghUEFUVEVSTl9UQUdfSEFORExFLnRlc3QoaGFuZGxlKSkge1xuICAgICAgdGhyb3cgdGhpcy4jY3JlYXRlRXJyb3IoXG4gICAgICAgIGBDYW5ub3QgaGFuZGxlIHRhZyBkaXJlY3RpdmU6IGlsbC1mb3JtZWQgaGFuZGxlIChmaXJzdCBhcmd1bWVudCkgaW4gXCIke2hhbmRsZX1cImAsXG4gICAgICApO1xuICAgIH1cblxuICAgIGlmICh0aGlzLnRhZ01hcC5oYXMoaGFuZGxlKSkge1xuICAgICAgdGhyb3cgdGhpcy4jY3JlYXRlRXJyb3IoXG4gICAgICAgIGBDYW5ub3QgaGFuZGxlIHRhZyBkaXJlY3RpdmU6IHByZXZpb3VzbHkgZGVjbGFyZWQgc3VmZml4IGZvciBcIiR7aGFuZGxlfVwiIHRhZyBoYW5kbGVgLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBpZiAoIVBBVFRFUk5fVEFHX1VSSS50ZXN0KHByZWZpeCkpIHtcbiAgICAgIHRocm93IHRoaXMuI2NyZWF0ZUVycm9yKFxuICAgICAgICBcIkNhbm5vdCBoYW5kbGUgdGFnIGRpcmVjdGl2ZTogaWxsLWZvcm1lZCB0YWcgcHJlZml4IChzZWNvbmQgYXJndW1lbnQpIG9mIHRoZSBUQUcgZGlyZWN0aXZlXCIsXG4gICAgICApO1xuICAgIH1cblxuICAgIHRoaXMudGFnTWFwLnNldChoYW5kbGUsIHByZWZpeCk7XG4gIH1cbiAgY2FwdHVyZVNlZ21lbnQoc3RhcnQ6IG51bWJlciwgZW5kOiBudW1iZXIsIGNoZWNrSnNvbjogYm9vbGVhbikge1xuICAgIGlmIChzdGFydCA8IGVuZCkge1xuICAgICAgY29uc3QgcmVzdWx0ID0gdGhpcy4jc2Nhbm5lci5zb3VyY2Uuc2xpY2Uoc3RhcnQsIGVuZCk7XG5cbiAgICAgIGlmIChjaGVja0pzb24pIHtcbiAgICAgICAgZm9yIChsZXQgcG9zaXRpb24gPSAwOyBwb3NpdGlvbiA8IHJlc3VsdC5sZW5ndGg7IHBvc2l0aW9uKyspIHtcbiAgICAgICAgICBjb25zdCBjaGFyYWN0ZXIgPSByZXN1bHQuY2hhckNvZGVBdChwb3NpdGlvbik7XG4gICAgICAgICAgaWYgKFxuICAgICAgICAgICAgIShjaGFyYWN0ZXIgPT09IDB4MDkgfHxcbiAgICAgICAgICAgICAgKDB4MjAgPD0gY2hhcmFjdGVyICYmIGNoYXJhY3RlciA8PSAweDEwZmZmZikpXG4gICAgICAgICAgKSB7XG4gICAgICAgICAgICB0aHJvdyB0aGlzLiNjcmVhdGVFcnJvcihcbiAgICAgICAgICAgICAgYEV4cGVjdGVkIHZhbGlkIEpTT04gY2hhcmFjdGVyOiByZWNlaXZlZCBcIiR7Y2hhcmFjdGVyfVwiYCxcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKFBBVFRFUk5fTk9OX1BSSU5UQUJMRS50ZXN0KHJlc3VsdCkpIHtcbiAgICAgICAgdGhyb3cgdGhpcy4jY3JlYXRlRXJyb3IoXCJTdHJlYW0gY29udGFpbnMgbm9uLXByaW50YWJsZSBjaGFyYWN0ZXJzXCIpO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cbiAgfVxuICByZWFkQmxvY2tTZXF1ZW5jZShcbiAgICB0YWc6IHN0cmluZyB8IG51bGwsXG4gICAgYW5jaG9yOiBzdHJpbmcgfCBudWxsLFxuICAgIG5vZGVJbmRlbnQ6IG51bWJlcixcbiAgKTogU3RhdGUgfCB2b2lkIHtcbiAgICBsZXQgZGV0ZWN0ZWQgPSBmYWxzZTtcblxuICAgIGNvbnN0IHJlc3VsdDogdW5rbm93bltdID0gW107XG5cbiAgICBpZiAoYW5jaG9yICE9PSBudWxsKSB0aGlzLmFuY2hvck1hcC5zZXQoYW5jaG9yLCByZXN1bHQpO1xuXG4gICAgbGV0IGNoID0gdGhpcy4jc2Nhbm5lci5wZWVrKCk7XG5cbiAgICB3aGlsZSAoY2ggIT09IDApIHtcbiAgICAgIGlmIChjaCAhPT0gTUlOVVMpIHtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGZvbGxvd2luZyA9IHRoaXMuI3NjYW5uZXIucGVlaygxKTtcblxuICAgICAgaWYgKCFpc1doaXRlU3BhY2VPckVPTChmb2xsb3dpbmcpKSB7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuXG4gICAgICBkZXRlY3RlZCA9IHRydWU7XG4gICAgICB0aGlzLiNzY2FubmVyLm5leHQoKTtcblxuICAgICAgaWYgKHRoaXMuc2tpcFNlcGFyYXRpb25TcGFjZSh0cnVlLCAtMSkpIHtcbiAgICAgICAgaWYgKHRoaXMubGluZUluZGVudCA8PSBub2RlSW5kZW50KSB7XG4gICAgICAgICAgcmVzdWx0LnB1c2gobnVsbCk7XG4gICAgICAgICAgY2ggPSB0aGlzLiNzY2FubmVyLnBlZWsoKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBjb25zdCBsaW5lID0gdGhpcy5saW5lO1xuICAgICAgY29uc3QgbmV3U3RhdGUgPSB0aGlzLmNvbXBvc2VOb2RlKHtcbiAgICAgICAgcGFyZW50SW5kZW50OiBub2RlSW5kZW50LFxuICAgICAgICBub2RlQ29udGV4dDogQ09OVEVYVF9CTE9DS19JTixcbiAgICAgICAgYWxsb3dUb1NlZWs6IGZhbHNlLFxuICAgICAgICBhbGxvd0NvbXBhY3Q6IHRydWUsXG4gICAgICB9KTtcbiAgICAgIGlmIChuZXdTdGF0ZSkgcmVzdWx0LnB1c2gobmV3U3RhdGUucmVzdWx0KTtcbiAgICAgIHRoaXMuc2tpcFNlcGFyYXRpb25TcGFjZSh0cnVlLCAtMSk7XG5cbiAgICAgIGNoID0gdGhpcy4jc2Nhbm5lci5wZWVrKCk7XG5cbiAgICAgIGlmICgodGhpcy5saW5lID09PSBsaW5lIHx8IHRoaXMubGluZUluZGVudCA+IG5vZGVJbmRlbnQpICYmIGNoICE9PSAwKSB7XG4gICAgICAgIHRocm93IHRoaXMuI2NyZWF0ZUVycm9yKFxuICAgICAgICAgIFwiQ2Fubm90IHJlYWQgYmxvY2sgc2VxdWVuY2U6IGJhZCBpbmRlbnRhdGlvbiBvZiBhIHNlcXVlbmNlIGVudHJ5XCIsXG4gICAgICAgICk7XG4gICAgICB9IGVsc2UgaWYgKHRoaXMubGluZUluZGVudCA8IG5vZGVJbmRlbnQpIHtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGRldGVjdGVkKSByZXR1cm4geyB0YWcsIGFuY2hvciwga2luZDogXCJzZXF1ZW5jZVwiLCByZXN1bHQgfTtcbiAgfVxuICBtZXJnZU1hcHBpbmdzKFxuICAgIGRlc3RpbmF0aW9uOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAgICBzb3VyY2U6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICAgIG92ZXJyaWRhYmxlS2V5czogU2V0PHN0cmluZz4sXG4gICkge1xuICAgIGlmICghaXNPYmplY3Qoc291cmNlKSkge1xuICAgICAgdGhyb3cgdGhpcy4jY3JlYXRlRXJyb3IoXG4gICAgICAgIFwiQ2Fubm90IG1lcmdlIG1hcHBpbmdzOiB0aGUgcHJvdmlkZWQgc291cmNlIG9iamVjdCBpcyB1bmFjY2VwdGFibGVcIixcbiAgICAgICk7XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMoc291cmNlKSkge1xuICAgICAgaWYgKE9iamVjdC5oYXNPd24oZGVzdGluYXRpb24sIGtleSkpIGNvbnRpbnVlO1xuICAgICAgT2JqZWN0LmRlZmluZVByb3BlcnR5KGRlc3RpbmF0aW9uLCBrZXksIHtcbiAgICAgICAgdmFsdWUsXG4gICAgICAgIHdyaXRhYmxlOiB0cnVlLFxuICAgICAgICBlbnVtZXJhYmxlOiB0cnVlLFxuICAgICAgICBjb25maWd1cmFibGU6IHRydWUsXG4gICAgICB9KTtcbiAgICAgIG92ZXJyaWRhYmxlS2V5cy5hZGQoa2V5KTtcbiAgICB9XG4gIH1cbiAgc3RvcmVNYXBwaW5nUGFpcihcbiAgICByZXN1bHQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICAgIG92ZXJyaWRhYmxlS2V5czogU2V0PHN0cmluZz4sXG4gICAga2V5VGFnOiBzdHJpbmcgfCBudWxsLFxuICAgIGtleU5vZGU6IFJlY29yZDxQcm9wZXJ0eUtleSwgdW5rbm93bj4gfCB1bmtub3duW10gfCBzdHJpbmcgfCBudWxsLFxuICAgIHZhbHVlTm9kZTogdW5rbm93bixcbiAgICBzdGFydExpbmU/OiBudW1iZXIsXG4gICAgc3RhcnRQb3M/OiBudW1iZXIsXG4gICk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICAvLyBUaGUgb3V0cHV0IGlzIGEgcGxhaW4gb2JqZWN0IGhlcmUsIHNvIGtleXMgY2FuIG9ubHkgYmUgc3RyaW5ncy5cbiAgICAvLyBXZSBuZWVkIHRvIGNvbnZlcnQga2V5Tm9kZSB0byBhIHN0cmluZywgYnV0IGRvaW5nIHNvIGNhbiBoYW5nIHRoZSBwcm9jZXNzXG4gICAgLy8gKGRlZXBseSBuZXN0ZWQgYXJyYXlzIHRoYXQgZXhwbG9kZSBleHBvbmVudGlhbGx5IHVzaW5nIGFsaWFzZXMpLlxuICAgIGlmIChBcnJheS5pc0FycmF5KGtleU5vZGUpKSB7XG4gICAgICBrZXlOb2RlID0gQXJyYXkucHJvdG90eXBlLnNsaWNlLmNhbGwoa2V5Tm9kZSk7XG5cbiAgICAgIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCBrZXlOb2RlLmxlbmd0aDsgaW5kZXgrKykge1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShrZXlOb2RlW2luZGV4XSkpIHtcbiAgICAgICAgICB0aHJvdyB0aGlzLiNjcmVhdGVFcnJvcihcbiAgICAgICAgICAgIFwiQ2Fubm90IHN0b3JlIG1hcHBpbmcgcGFpcjogbmVzdGVkIGFycmF5cyBhcmUgbm90IHN1cHBvcnRlZCBpbnNpZGUga2V5c1wiLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodHlwZW9mIGtleU5vZGUgPT09IFwib2JqZWN0XCIgJiYgaXNQbGFpbk9iamVjdChrZXlOb2RlW2luZGV4XSkpIHtcbiAgICAgICAgICBrZXlOb2RlW2luZGV4XSA9IFwiW29iamVjdCBPYmplY3RdXCI7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBBdm9pZCBjb2RlIGV4ZWN1dGlvbiBpbiBsb2FkKCkgdmlhIHRvU3RyaW5nIHByb3BlcnR5XG4gICAgLy8gKHN0aWxsIHVzZSBpdHMgb3duIHRvU3RyaW5nIGZvciBhcnJheXMsIHRpbWVzdGFtcHMsXG4gICAgLy8gYW5kIHdoYXRldmVyIHVzZXIgc2NoZW1hIGV4dGVuc2lvbnMgaGFwcGVuIHRvIGhhdmUgQEB0b1N0cmluZ1RhZylcbiAgICBpZiAodHlwZW9mIGtleU5vZGUgPT09IFwib2JqZWN0XCIgJiYgaXNQbGFpbk9iamVjdChrZXlOb2RlKSkge1xuICAgICAga2V5Tm9kZSA9IFwiW29iamVjdCBPYmplY3RdXCI7XG4gICAgfVxuXG4gICAga2V5Tm9kZSA9IFN0cmluZyhrZXlOb2RlKTtcblxuICAgIGlmIChrZXlUYWcgPT09IFwidGFnOnlhbWwub3JnLDIwMDI6bWVyZ2VcIikge1xuICAgICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWVOb2RlKSkge1xuICAgICAgICBmb3IgKFxuICAgICAgICAgIGxldCBpbmRleCA9IDA7XG4gICAgICAgICAgaW5kZXggPCB2YWx1ZU5vZGUubGVuZ3RoO1xuICAgICAgICAgIGluZGV4KytcbiAgICAgICAgKSB7XG4gICAgICAgICAgdGhpcy5tZXJnZU1hcHBpbmdzKHJlc3VsdCwgdmFsdWVOb2RlW2luZGV4XSwgb3ZlcnJpZGFibGVLZXlzKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5tZXJnZU1hcHBpbmdzKFxuICAgICAgICAgIHJlc3VsdCxcbiAgICAgICAgICB2YWx1ZU5vZGUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gICAgICAgICAgb3ZlcnJpZGFibGVLZXlzLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBpZiAoXG4gICAgICAgICF0aGlzLmFsbG93RHVwbGljYXRlS2V5cyAmJlxuICAgICAgICAhb3ZlcnJpZGFibGVLZXlzLmhhcyhrZXlOb2RlKSAmJlxuICAgICAgICBPYmplY3QuaGFzT3duKHJlc3VsdCwga2V5Tm9kZSlcbiAgICAgICkge1xuICAgICAgICB0aGlzLmxpbmUgPSBzdGFydExpbmUgfHwgdGhpcy5saW5lO1xuICAgICAgICB0aGlzLiNzY2FubmVyLnBvc2l0aW9uID0gc3RhcnRQb3MgfHwgdGhpcy4jc2Nhbm5lci5wb3NpdGlvbjtcbiAgICAgICAgdGhyb3cgdGhpcy4jY3JlYXRlRXJyb3IoXCJDYW5ub3Qgc3RvcmUgbWFwcGluZyBwYWlyOiBkdXBsaWNhdGVkIGtleVwiKTtcbiAgICAgIH1cbiAgICAgIE9iamVjdC5kZWZpbmVQcm9wZXJ0eShyZXN1bHQsIGtleU5vZGUsIHtcbiAgICAgICAgdmFsdWU6IHZhbHVlTm9kZSxcbiAgICAgICAgd3JpdGFibGU6IHRydWUsXG4gICAgICAgIGVudW1lcmFibGU6IHRydWUsXG4gICAgICAgIGNvbmZpZ3VyYWJsZTogdHJ1ZSxcbiAgICAgIH0pO1xuICAgICAgb3ZlcnJpZGFibGVLZXlzLmRlbGV0ZShrZXlOb2RlKTtcbiAgICB9XG5cbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG4gIHJlYWRMaW5lQnJlYWsoKSB7XG4gICAgY29uc3QgY2ggPSB0aGlzLiNzY2FubmVyLnBlZWsoKTtcblxuICAgIGlmIChjaCA9PT0gTElORV9GRUVEKSB7XG4gICAgICB0aGlzLiNzY2FubmVyLm5leHQoKTtcbiAgICB9IGVsc2UgaWYgKGNoID09PSBDQVJSSUFHRV9SRVRVUk4pIHtcbiAgICAgIHRoaXMuI3NjYW5uZXIubmV4dCgpO1xuICAgICAgaWYgKHRoaXMuI3NjYW5uZXIucGVlaygpID09PSBMSU5FX0ZFRUQpIHtcbiAgICAgICAgdGhpcy4jc2Nhbm5lci5uZXh0KCk7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93IHRoaXMuI2NyZWF0ZUVycm9yKFwiQ2Fubm90IHJlYWQgbGluZTogbGluZSBicmVhayBub3QgZm91bmRcIik7XG4gICAgfVxuXG4gICAgdGhpcy5saW5lICs9IDE7XG4gICAgdGhpcy5saW5lU3RhcnQgPSB0aGlzLiNzY2FubmVyLnBvc2l0aW9uO1xuICB9XG4gIHNraXBTZXBhcmF0aW9uU3BhY2UoYWxsb3dDb21tZW50czogYm9vbGVhbiwgY2hlY2tJbmRlbnQ6IG51bWJlcik6IG51bWJlciB7XG4gICAgbGV0IGxpbmVCcmVha3MgPSAwO1xuICAgIGxldCBjaCA9IHRoaXMuI3NjYW5uZXIucGVlaygpO1xuXG4gICAgd2hpbGUgKGNoICE9PSAwKSB7XG4gICAgICB0aGlzLnNraXBXaGl0ZXNwYWNlcygpO1xuICAgICAgY2ggPSB0aGlzLiNzY2FubmVyLnBlZWsoKTtcblxuICAgICAgaWYgKGFsbG93Q29tbWVudHMpIHtcbiAgICAgICAgdGhpcy5za2lwQ29tbWVudCgpO1xuICAgICAgICBjaCA9IHRoaXMuI3NjYW5uZXIucGVlaygpO1xuICAgICAgfVxuXG4gICAgICBpZiAoaXNFT0woY2gpKSB7XG4gICAgICAgIHRoaXMucmVhZExpbmVCcmVhaygpO1xuXG4gICAgICAgIGNoID0gdGhpcy4jc2Nhbm5lci5wZWVrKCk7XG4gICAgICAgIGxpbmVCcmVha3MrKztcbiAgICAgICAgdGhpcy5saW5lSW5kZW50ID0gMDtcblxuICAgICAgICB0aGlzLnJlYWRJbmRlbnQoKTtcbiAgICAgICAgY2ggPSB0aGlzLiNzY2FubmVyLnBlZWsoKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChcbiAgICAgIGNoZWNrSW5kZW50ICE9PSAtMSAmJlxuICAgICAgbGluZUJyZWFrcyAhPT0gMCAmJlxuICAgICAgdGhpcy5saW5lSW5kZW50IDwgY2hlY2tJbmRlbnRcbiAgICApIHtcbiAgICAgIHRoaXMuZGlzcGF0Y2hXYXJuaW5nKFwiZGVmaWNpZW50IGluZGVudGF0aW9uXCIpO1xuICAgIH1cblxuICAgIHJldHVybiBsaW5lQnJlYWtzO1xuICB9XG4gIHRlc3REb2N1bWVudFNlcGFyYXRvcigpOiBib29sZWFuIHtcbiAgICBsZXQgY2ggPSB0aGlzLiNzY2FubmVyLnBlZWsoKTtcblxuICAgIC8vIENvbmRpdGlvbiB0aGlzLiNzY2FubmVyLnBvc2l0aW9uID09PSB0aGlzLmxpbmVTdGFydCBpcyB0ZXN0ZWRcbiAgICAvLyBpbiBwYXJlbnQgb24gZWFjaCBjYWxsLCBmb3IgZWZmaWNpZW5jeS4gTm8gbmVlZHMgdG8gdGVzdCBoZXJlIGFnYWluLlxuICAgIGlmIChcbiAgICAgIChjaCA9PT0gTUlOVVMgfHwgY2ggPT09IERPVCkgJiZcbiAgICAgIGNoID09PSB0aGlzLiNzY2FubmVyLnBlZWsoMSkgJiZcbiAgICAgIGNoID09PSB0aGlzLiNzY2FubmVyLnBlZWsoMilcbiAgICApIHtcbiAgICAgIGNoID0gdGhpcy4jc2Nhbm5lci5wZWVrKDMpO1xuXG4gICAgICBpZiAoY2ggPT09IDAgfHwgaXNXaGl0ZVNwYWNlT3JFT0woY2gpKSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIHJlYWRQbGFpblNjYWxhcihcbiAgICB0YWc6IHN0cmluZyB8IG51bGwsXG4gICAgYW5jaG9yOiBzdHJpbmcgfCBudWxsLFxuICAgIG5vZGVJbmRlbnQ6IG51bWJlcixcbiAgICB3aXRoaW5GbG93Q29sbGVjdGlvbjogYm9vbGVhbixcbiAgKTogU3RhdGUgfCB2b2lkIHtcbiAgICBsZXQgY2ggPSB0aGlzLiNzY2FubmVyLnBlZWsoKTtcblxuICAgIGlmIChcbiAgICAgIGlzV2hpdGVTcGFjZU9yRU9MKGNoKSB8fFxuICAgICAgaXNGbG93SW5kaWNhdG9yKGNoKSB8fFxuICAgICAgY2ggPT09IFNIQVJQIHx8XG4gICAgICBjaCA9PT0gQU1QRVJTQU5EIHx8XG4gICAgICBjaCA9PT0gQVNURVJJU0sgfHxcbiAgICAgIGNoID09PSBFWENMQU1BVElPTiB8fFxuICAgICAgY2ggPT09IFZFUlRJQ0FMX0xJTkUgfHxcbiAgICAgIGNoID09PSBHUkVBVEVSX1RIQU4gfHxcbiAgICAgIGNoID09PSBTSU5HTEVfUVVPVEUgfHxcbiAgICAgIGNoID09PSBET1VCTEVfUVVPVEUgfHxcbiAgICAgIGNoID09PSBQRVJDRU5UIHx8XG4gICAgICBjaCA9PT0gQ09NTUVSQ0lBTF9BVCB8fFxuICAgICAgY2ggPT09IEdSQVZFX0FDQ0VOVFxuICAgICkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGxldCBmb2xsb3dpbmc6IG51bWJlcjtcbiAgICBpZiAoY2ggPT09IFFVRVNUSU9OIHx8IGNoID09PSBNSU5VUykge1xuICAgICAgZm9sbG93aW5nID0gdGhpcy4jc2Nhbm5lci5wZWVrKDEpO1xuXG4gICAgICBpZiAoXG4gICAgICAgIGlzV2hpdGVTcGFjZU9yRU9MKGZvbGxvd2luZykgfHxcbiAgICAgICAgKHdpdGhpbkZsb3dDb2xsZWN0aW9uICYmIGlzRmxvd0luZGljYXRvcihmb2xsb3dpbmcpKVxuICAgICAgKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBsZXQgcmVzdWx0ID0gXCJcIjtcblxuICAgIGxldCBjYXB0dXJlRW5kID0gdGhpcy4jc2Nhbm5lci5wb3NpdGlvbjtcbiAgICBsZXQgY2FwdHVyZVN0YXJ0ID0gdGhpcy4jc2Nhbm5lci5wb3NpdGlvbjtcbiAgICBsZXQgaGFzUGVuZGluZ0NvbnRlbnQgPSBmYWxzZTtcbiAgICBsZXQgbGluZSA9IDA7XG4gICAgd2hpbGUgKGNoICE9PSAwKSB7XG4gICAgICBpZiAoY2ggPT09IENPTE9OKSB7XG4gICAgICAgIGZvbGxvd2luZyA9IHRoaXMuI3NjYW5uZXIucGVlaygxKTtcblxuICAgICAgICBpZiAoXG4gICAgICAgICAgaXNXaGl0ZVNwYWNlT3JFT0woZm9sbG93aW5nKSB8fFxuICAgICAgICAgICh3aXRoaW5GbG93Q29sbGVjdGlvbiAmJiBpc0Zsb3dJbmRpY2F0b3IoZm9sbG93aW5nKSlcbiAgICAgICAgKSB7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSBpZiAoY2ggPT09IFNIQVJQKSB7XG4gICAgICAgIGNvbnN0IHByZWNlZGluZyA9IHRoaXMuI3NjYW5uZXIucGVlaygtMSk7XG5cbiAgICAgICAgaWYgKGlzV2hpdGVTcGFjZU9yRU9MKHByZWNlZGluZykpIHtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIGlmIChcbiAgICAgICAgKHRoaXMuI3NjYW5uZXIucG9zaXRpb24gPT09IHRoaXMubGluZVN0YXJ0ICYmXG4gICAgICAgICAgdGhpcy50ZXN0RG9jdW1lbnRTZXBhcmF0b3IoKSkgfHxcbiAgICAgICAgKHdpdGhpbkZsb3dDb2xsZWN0aW9uICYmIGlzRmxvd0luZGljYXRvcihjaCkpXG4gICAgICApIHtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9IGVsc2UgaWYgKGlzRU9MKGNoKSkge1xuICAgICAgICBsaW5lID0gdGhpcy5saW5lO1xuICAgICAgICBjb25zdCBsaW5lU3RhcnQgPSB0aGlzLmxpbmVTdGFydDtcbiAgICAgICAgY29uc3QgbGluZUluZGVudCA9IHRoaXMubGluZUluZGVudDtcbiAgICAgICAgdGhpcy5za2lwU2VwYXJhdGlvblNwYWNlKGZhbHNlLCAtMSk7XG5cbiAgICAgICAgaWYgKHRoaXMubGluZUluZGVudCA+PSBub2RlSW5kZW50KSB7XG4gICAgICAgICAgaGFzUGVuZGluZ0NvbnRlbnQgPSB0cnVlO1xuICAgICAgICAgIGNoID0gdGhpcy4jc2Nhbm5lci5wZWVrKCk7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdGhpcy4jc2Nhbm5lci5wb3NpdGlvbiA9IGNhcHR1cmVFbmQ7XG4gICAgICAgICAgdGhpcy5saW5lID0gbGluZTtcbiAgICAgICAgICB0aGlzLmxpbmVTdGFydCA9IGxpbmVTdGFydDtcbiAgICAgICAgICB0aGlzLmxpbmVJbmRlbnQgPSBsaW5lSW5kZW50O1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGlmIChoYXNQZW5kaW5nQ29udGVudCkge1xuICAgICAgICBjb25zdCBzZWdtZW50ID0gdGhpcy5jYXB0dXJlU2VnbWVudChjYXB0dXJlU3RhcnQsIGNhcHR1cmVFbmQsIGZhbHNlKTtcbiAgICAgICAgaWYgKHNlZ21lbnQpIHJlc3VsdCArPSBzZWdtZW50O1xuICAgICAgICByZXN1bHQgKz0gd3JpdGVGb2xkZWRMaW5lcyh0aGlzLmxpbmUgLSBsaW5lKTtcbiAgICAgICAgY2FwdHVyZVN0YXJ0ID0gY2FwdHVyZUVuZCA9IHRoaXMuI3NjYW5uZXIucG9zaXRpb247XG4gICAgICAgIGhhc1BlbmRpbmdDb250ZW50ID0gZmFsc2U7XG4gICAgICB9XG5cbiAgICAgIGlmICghaXNXaGl0ZVNwYWNlKGNoKSkge1xuICAgICAgICBjYXB0dXJlRW5kID0gdGhpcy4jc2Nhbm5lci5wb3NpdGlvbiArIDE7XG4gICAgICB9XG5cbiAgICAgIHRoaXMuI3NjYW5uZXIubmV4dCgpO1xuICAgICAgY2ggPSB0aGlzLiNzY2FubmVyLnBlZWsoKTtcbiAgICB9XG5cbiAgICBjb25zdCBzZWdtZW50ID0gdGhpcy5jYXB0dXJlU2VnbWVudChjYXB0dXJlU3RhcnQsIGNhcHR1cmVFbmQsIGZhbHNlKTtcbiAgICBpZiAoc2VnbWVudCkgcmVzdWx0ICs9IHNlZ21lbnQ7XG4gICAgaWYgKGFuY2hvciAhPT0gbnVsbCkgdGhpcy5hbmNob3JNYXAuc2V0KGFuY2hvciwgcmVzdWx0KTtcbiAgICBpZiAocmVzdWx0KSByZXR1cm4geyB0YWcsIGFuY2hvciwga2luZDogXCJzY2FsYXJcIiwgcmVzdWx0IH07XG4gIH1cbiAgcmVhZFNpbmdsZVF1b3RlZFNjYWxhcihcbiAgICB0YWc6IHN0cmluZyB8IG51bGwsXG4gICAgYW5jaG9yOiBzdHJpbmcgfCBudWxsLFxuICAgIG5vZGVJbmRlbnQ6IG51bWJlcixcbiAgKTogU3RhdGUgfCB2b2lkIHtcbiAgICBsZXQgY2ggPSB0aGlzLiNzY2FubmVyLnBlZWsoKTtcblxuICAgIGlmIChjaCAhPT0gU0lOR0xFX1FVT1RFKSByZXR1cm47XG5cbiAgICBsZXQgcmVzdWx0ID0gXCJcIjtcbiAgICB0aGlzLiNzY2FubmVyLm5leHQoKTtcbiAgICBsZXQgY2FwdHVyZVN0YXJ0ID0gdGhpcy4jc2Nhbm5lci5wb3NpdGlvbjtcbiAgICBsZXQgY2FwdHVyZUVuZCA9IHRoaXMuI3NjYW5uZXIucG9zaXRpb247XG5cbiAgICBjaCA9IHRoaXMuI3NjYW5uZXIucGVlaygpO1xuICAgIHdoaWxlIChjaCAhPT0gMCkge1xuICAgICAgaWYgKGNoID09PSBTSU5HTEVfUVVPVEUpIHtcbiAgICAgICAgY29uc3Qgc2VnbWVudCA9IHRoaXMuY2FwdHVyZVNlZ21lbnQoXG4gICAgICAgICAgY2FwdHVyZVN0YXJ0LFxuICAgICAgICAgIHRoaXMuI3NjYW5uZXIucG9zaXRpb24sXG4gICAgICAgICAgdHJ1ZSxcbiAgICAgICAgKTtcbiAgICAgICAgaWYgKHNlZ21lbnQpIHJlc3VsdCArPSBzZWdtZW50O1xuICAgICAgICB0aGlzLiNzY2FubmVyLm5leHQoKTtcbiAgICAgICAgY2ggPSB0aGlzLiNzY2FubmVyLnBlZWsoKTtcblxuICAgICAgICBpZiAoY2ggPT09IFNJTkdMRV9RVU9URSkge1xuICAgICAgICAgIGNhcHR1cmVTdGFydCA9IHRoaXMuI3NjYW5uZXIucG9zaXRpb247XG4gICAgICAgICAgdGhpcy4jc2Nhbm5lci5uZXh0KCk7XG4gICAgICAgICAgY2FwdHVyZUVuZCA9IHRoaXMuI3NjYW5uZXIucG9zaXRpb247XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgaWYgKGFuY2hvciAhPT0gbnVsbCkgdGhpcy5hbmNob3JNYXAuc2V0KGFuY2hvciwgcmVzdWx0KTtcbiAgICAgICAgICByZXR1cm4geyB0YWcsIGFuY2hvciwga2luZDogXCJzY2FsYXJcIiwgcmVzdWx0IH07XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSBpZiAoaXNFT0woY2gpKSB7XG4gICAgICAgIGNvbnN0IHNlZ21lbnQgPSB0aGlzLmNhcHR1cmVTZWdtZW50KGNhcHR1cmVTdGFydCwgY2FwdHVyZUVuZCwgdHJ1ZSk7XG4gICAgICAgIGlmIChzZWdtZW50KSByZXN1bHQgKz0gc2VnbWVudDtcbiAgICAgICAgcmVzdWx0ICs9IHdyaXRlRm9sZGVkTGluZXMoXG4gICAgICAgICAgdGhpcy5za2lwU2VwYXJhdGlvblNwYWNlKGZhbHNlLCBub2RlSW5kZW50KSxcbiAgICAgICAgKTtcbiAgICAgICAgY2FwdHVyZVN0YXJ0ID0gY2FwdHVyZUVuZCA9IHRoaXMuI3NjYW5uZXIucG9zaXRpb247XG4gICAgICB9IGVsc2UgaWYgKFxuICAgICAgICB0aGlzLiNzY2FubmVyLnBvc2l0aW9uID09PSB0aGlzLmxpbmVTdGFydCAmJlxuICAgICAgICB0aGlzLnRlc3REb2N1bWVudFNlcGFyYXRvcigpXG4gICAgICApIHtcbiAgICAgICAgdGhyb3cgdGhpcy4jY3JlYXRlRXJyb3IoXG4gICAgICAgICAgXCJVbmV4cGVjdGVkIGVuZCBvZiB0aGUgZG9jdW1lbnQgd2l0aGluIGEgc2luZ2xlIHF1b3RlZCBzY2FsYXJcIixcbiAgICAgICAgKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMuI3NjYW5uZXIubmV4dCgpO1xuICAgICAgICBjYXB0dXJlRW5kID0gdGhpcy4jc2Nhbm5lci5wb3NpdGlvbjtcbiAgICAgIH1cbiAgICAgIGNoID0gdGhpcy4jc2Nhbm5lci5wZWVrKCk7XG4gICAgfVxuXG4gICAgdGhyb3cgdGhpcy4jY3JlYXRlRXJyb3IoXG4gICAgICBcIlVuZXhwZWN0ZWQgZW5kIG9mIHRoZSBzdHJlYW0gd2l0aGluIGEgc2luZ2xlIHF1b3RlZCBzY2FsYXJcIixcbiAgICApO1xuICB9XG4gIHJlYWREb3VibGVRdW90ZWRTY2FsYXIoXG4gICAgdGFnOiBzdHJpbmcgfCBudWxsLFxuICAgIGFuY2hvcjogc3RyaW5nIHwgbnVsbCxcbiAgICBub2RlSW5kZW50OiBudW1iZXIsXG4gICk6IFN0YXRlIHwgdm9pZCB7XG4gICAgbGV0IGNoID0gdGhpcy4jc2Nhbm5lci5wZWVrKCk7XG5cbiAgICBpZiAoY2ggIT09IERPVUJMRV9RVU9URSkgcmV0dXJuO1xuXG4gICAgbGV0IHJlc3VsdCA9IFwiXCI7XG4gICAgdGhpcy4jc2Nhbm5lci5uZXh0KCk7XG4gICAgbGV0IGNhcHR1cmVFbmQgPSB0aGlzLiNzY2FubmVyLnBvc2l0aW9uO1xuICAgIGxldCBjYXB0dXJlU3RhcnQgPSB0aGlzLiNzY2FubmVyLnBvc2l0aW9uO1xuICAgIGxldCB0bXA6IG51bWJlcjtcbiAgICBjaCA9IHRoaXMuI3NjYW5uZXIucGVlaygpO1xuICAgIHdoaWxlIChjaCAhPT0gMCkge1xuICAgICAgaWYgKGNoID09PSBET1VCTEVfUVVPVEUpIHtcbiAgICAgICAgY29uc3Qgc2VnbWVudCA9IHRoaXMuY2FwdHVyZVNlZ21lbnQoXG4gICAgICAgICAgY2FwdHVyZVN0YXJ0LFxuICAgICAgICAgIHRoaXMuI3NjYW5uZXIucG9zaXRpb24sXG4gICAgICAgICAgdHJ1ZSxcbiAgICAgICAgKTtcbiAgICAgICAgaWYgKHNlZ21lbnQpIHJlc3VsdCArPSBzZWdtZW50O1xuICAgICAgICB0aGlzLiNzY2FubmVyLm5leHQoKTtcbiAgICAgICAgaWYgKGFuY2hvciAhPT0gbnVsbCkgdGhpcy5hbmNob3JNYXAuc2V0KGFuY2hvciwgcmVzdWx0KTtcbiAgICAgICAgcmV0dXJuIHsgdGFnLCBhbmNob3IsIGtpbmQ6IFwic2NhbGFyXCIsIHJlc3VsdCB9O1xuICAgICAgfVxuICAgICAgaWYgKGNoID09PSBCQUNLU0xBU0gpIHtcbiAgICAgICAgY29uc3Qgc2VnbWVudCA9IHRoaXMuY2FwdHVyZVNlZ21lbnQoXG4gICAgICAgICAgY2FwdHVyZVN0YXJ0LFxuICAgICAgICAgIHRoaXMuI3NjYW5uZXIucG9zaXRpb24sXG4gICAgICAgICAgdHJ1ZSxcbiAgICAgICAgKTtcbiAgICAgICAgaWYgKHNlZ21lbnQpIHJlc3VsdCArPSBzZWdtZW50O1xuICAgICAgICB0aGlzLiNzY2FubmVyLm5leHQoKTtcbiAgICAgICAgY2ggPSB0aGlzLiNzY2FubmVyLnBlZWsoKTtcblxuICAgICAgICBpZiAoaXNFT0woY2gpKSB7XG4gICAgICAgICAgdGhpcy5za2lwU2VwYXJhdGlvblNwYWNlKGZhbHNlLCBub2RlSW5kZW50KTtcbiAgICAgICAgfSBlbHNlIGlmIChjaCA8IDI1NiAmJiBTSU1QTEVfRVNDQVBFX1NFUVVFTkNFUy5oYXMoY2gpKSB7XG4gICAgICAgICAgcmVzdWx0ICs9IFNJTVBMRV9FU0NBUEVfU0VRVUVOQ0VTLmdldChjaCk7XG4gICAgICAgICAgdGhpcy4jc2Nhbm5lci5uZXh0KCk7XG4gICAgICAgIH0gZWxzZSBpZiAoKHRtcCA9IEVTQ0FQRURfSEVYX0xFTkdUSFMuZ2V0KGNoKSA/PyAwKSA+IDApIHtcbiAgICAgICAgICBsZXQgaGV4TGVuZ3RoID0gdG1wO1xuICAgICAgICAgIGxldCBoZXhSZXN1bHQgPSAwO1xuXG4gICAgICAgICAgZm9yICg7IGhleExlbmd0aCA+IDA7IGhleExlbmd0aC0tKSB7XG4gICAgICAgICAgICB0aGlzLiNzY2FubmVyLm5leHQoKTtcbiAgICAgICAgICAgIGNoID0gdGhpcy4jc2Nhbm5lci5wZWVrKCk7XG5cbiAgICAgICAgICAgIGlmICgodG1wID0gaGV4Q2hhckNvZGVUb051bWJlcihjaCkpID49IDApIHtcbiAgICAgICAgICAgICAgaGV4UmVzdWx0ID0gKGhleFJlc3VsdCA8PCA0KSArIHRtcDtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIHRocm93IHRoaXMuI2NyZWF0ZUVycm9yKFxuICAgICAgICAgICAgICAgIFwiQ2Fubm90IHJlYWQgZG91YmxlIHF1b3RlZCBzY2FsYXI6IGV4cGVjdGVkIGhleGFkZWNpbWFsIGNoYXJhY3RlclwiLFxuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cblxuICAgICAgICAgIHJlc3VsdCArPSBjb2RlcG9pbnRUb0NoYXIoaGV4UmVzdWx0KTtcblxuICAgICAgICAgIHRoaXMuI3NjYW5uZXIubmV4dCgpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRocm93IHRoaXMuI2NyZWF0ZUVycm9yKFxuICAgICAgICAgICAgXCJDYW5ub3QgcmVhZCBkb3VibGUgcXVvdGVkIHNjYWxhcjogdW5rbm93biBlc2NhcGUgc2VxdWVuY2VcIixcbiAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgY2FwdHVyZVN0YXJ0ID0gY2FwdHVyZUVuZCA9IHRoaXMuI3NjYW5uZXIucG9zaXRpb247XG4gICAgICB9IGVsc2UgaWYgKGlzRU9MKGNoKSkge1xuICAgICAgICBjb25zdCBzZWdtZW50ID0gdGhpcy5jYXB0dXJlU2VnbWVudChjYXB0dXJlU3RhcnQsIGNhcHR1cmVFbmQsIHRydWUpO1xuICAgICAgICBpZiAoc2VnbWVudCkgcmVzdWx0ICs9IHNlZ21lbnQ7XG4gICAgICAgIHJlc3VsdCArPSB3cml0ZUZvbGRlZExpbmVzKFxuICAgICAgICAgIHRoaXMuc2tpcFNlcGFyYXRpb25TcGFjZShmYWxzZSwgbm9kZUluZGVudCksXG4gICAgICAgICk7XG4gICAgICAgIGNhcHR1cmVTdGFydCA9IGNhcHR1cmVFbmQgPSB0aGlzLiNzY2FubmVyLnBvc2l0aW9uO1xuICAgICAgfSBlbHNlIGlmIChcbiAgICAgICAgdGhpcy4jc2Nhbm5lci5wb3NpdGlvbiA9PT0gdGhpcy5saW5lU3RhcnQgJiZcbiAgICAgICAgdGhpcy50ZXN0RG9jdW1lbnRTZXBhcmF0b3IoKVxuICAgICAgKSB7XG4gICAgICAgIHRocm93IHRoaXMuI2NyZWF0ZUVycm9yKFxuICAgICAgICAgIFwiVW5leHBlY3RlZCBlbmQgb2YgdGhlIGRvY3VtZW50IHdpdGhpbiBhIGRvdWJsZSBxdW90ZWQgc2NhbGFyXCIsXG4gICAgICAgICk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aGlzLiNzY2FubmVyLm5leHQoKTtcbiAgICAgICAgY2FwdHVyZUVuZCA9IHRoaXMuI3NjYW5uZXIucG9zaXRpb247XG4gICAgICB9XG4gICAgICBjaCA9IHRoaXMuI3NjYW5uZXIucGVlaygpO1xuICAgIH1cblxuICAgIHRocm93IHRoaXMuI2NyZWF0ZUVycm9yKFxuICAgICAgXCJVbmV4cGVjdGVkIGVuZCBvZiB0aGUgc3RyZWFtIHdpdGhpbiBhIGRvdWJsZSBxdW90ZWQgc2NhbGFyXCIsXG4gICAgKTtcbiAgfVxuICByZWFkRmxvd0NvbGxlY3Rpb24oXG4gICAgdGFnOiBzdHJpbmcgfCBudWxsLFxuICAgIGFuY2hvcjogc3RyaW5nIHwgbnVsbCxcbiAgICBub2RlSW5kZW50OiBudW1iZXIsXG4gICk6IFN0YXRlIHwgdm9pZCB7XG4gICAgbGV0IGNoID0gdGhpcy4jc2Nhbm5lci5wZWVrKCk7XG4gICAgbGV0IHRlcm1pbmF0b3I6IG51bWJlcjtcbiAgICBsZXQgaXNNYXBwaW5nID0gdHJ1ZTtcbiAgICBsZXQgcmVzdWx0ID0ge307XG4gICAgaWYgKGNoID09PSBMRUZUX1NRVUFSRV9CUkFDS0VUKSB7XG4gICAgICB0ZXJtaW5hdG9yID0gUklHSFRfU1FVQVJFX0JSQUNLRVQ7XG4gICAgICBpc01hcHBpbmcgPSBmYWxzZTtcbiAgICAgIHJlc3VsdCA9IFtdO1xuICAgIH0gZWxzZSBpZiAoY2ggPT09IExFRlRfQ1VSTFlfQlJBQ0tFVCkge1xuICAgICAgdGVybWluYXRvciA9IFJJR0hUX0NVUkxZX0JSQUNLRVQ7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAoYW5jaG9yICE9PSBudWxsKSB0aGlzLmFuY2hvck1hcC5zZXQoYW5jaG9yLCByZXN1bHQpO1xuXG4gICAgdGhpcy4jc2Nhbm5lci5uZXh0KCk7XG4gICAgY2ggPSB0aGlzLiNzY2FubmVyLnBlZWsoKTtcblxuICAgIGxldCByZWFkTmV4dCA9IHRydWU7XG4gICAgbGV0IHZhbHVlTm9kZSA9IG51bGw7XG4gICAgbGV0IGtleU5vZGUgPSBudWxsO1xuICAgIGxldCBrZXlUYWc6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgIGxldCBpc0V4cGxpY2l0UGFpciA9IGZhbHNlO1xuICAgIGxldCBpc1BhaXIgPSBmYWxzZTtcbiAgICBsZXQgZm9sbG93aW5nID0gMDtcbiAgICBsZXQgbGluZSA9IDA7XG4gICAgY29uc3Qgb3ZlcnJpZGFibGVLZXlzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgd2hpbGUgKGNoICE9PSAwKSB7XG4gICAgICB0aGlzLnNraXBTZXBhcmF0aW9uU3BhY2UodHJ1ZSwgbm9kZUluZGVudCk7XG5cbiAgICAgIGNoID0gdGhpcy4jc2Nhbm5lci5wZWVrKCk7XG5cbiAgICAgIGlmIChjaCA9PT0gdGVybWluYXRvcikge1xuICAgICAgICB0aGlzLiNzY2FubmVyLm5leHQoKTtcbiAgICAgICAgY29uc3Qga2luZCA9IGlzTWFwcGluZyA/IFwibWFwcGluZ1wiIDogXCJzZXF1ZW5jZVwiO1xuICAgICAgICByZXR1cm4geyB0YWcsIGFuY2hvciwga2luZCwgcmVzdWx0IH07XG4gICAgICB9XG4gICAgICBpZiAoIXJlYWROZXh0KSB7XG4gICAgICAgIHRocm93IHRoaXMuI2NyZWF0ZUVycm9yKFxuICAgICAgICAgIFwiQ2Fubm90IHJlYWQgZmxvdyBjb2xsZWN0aW9uOiBtaXNzaW5nIGNvbW1hIGJldHdlZW4gZmxvdyBjb2xsZWN0aW9uIGVudHJpZXNcIixcbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAga2V5VGFnID0ga2V5Tm9kZSA9IHZhbHVlTm9kZSA9IG51bGw7XG4gICAgICBpc1BhaXIgPSBpc0V4cGxpY2l0UGFpciA9IGZhbHNlO1xuXG4gICAgICBpZiAoY2ggPT09IFFVRVNUSU9OKSB7XG4gICAgICAgIGZvbGxvd2luZyA9IHRoaXMuI3NjYW5uZXIucGVlaygxKTtcblxuICAgICAgICBpZiAoaXNXaGl0ZVNwYWNlT3JFT0woZm9sbG93aW5nKSkge1xuICAgICAgICAgIGlzUGFpciA9IGlzRXhwbGljaXRQYWlyID0gdHJ1ZTtcbiAgICAgICAgICB0aGlzLiNzY2FubmVyLm5leHQoKTtcbiAgICAgICAgICB0aGlzLnNraXBTZXBhcmF0aW9uU3BhY2UodHJ1ZSwgbm9kZUluZGVudCk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgbGluZSA9IHRoaXMubGluZTtcbiAgICAgIGNvbnN0IG5ld1N0YXRlID0gdGhpcy5jb21wb3NlTm9kZSh7XG4gICAgICAgIHBhcmVudEluZGVudDogbm9kZUluZGVudCxcbiAgICAgICAgbm9kZUNvbnRleHQ6IENPTlRFWFRfRkxPV19JTixcbiAgICAgICAgYWxsb3dUb1NlZWs6IGZhbHNlLFxuICAgICAgICBhbGxvd0NvbXBhY3Q6IHRydWUsXG4gICAgICB9KTtcbiAgICAgIGlmIChuZXdTdGF0ZSkge1xuICAgICAgICBrZXlUYWcgPSBuZXdTdGF0ZS50YWcgfHwgbnVsbDtcbiAgICAgICAga2V5Tm9kZSA9IG5ld1N0YXRlLnJlc3VsdDtcbiAgICAgIH1cbiAgICAgIHRoaXMuc2tpcFNlcGFyYXRpb25TcGFjZSh0cnVlLCBub2RlSW5kZW50KTtcblxuICAgICAgY2ggPSB0aGlzLiNzY2FubmVyLnBlZWsoKTtcblxuICAgICAgaWYgKChpc0V4cGxpY2l0UGFpciB8fCB0aGlzLmxpbmUgPT09IGxpbmUpICYmIGNoID09PSBDT0xPTikge1xuICAgICAgICBpc1BhaXIgPSB0cnVlO1xuICAgICAgICB0aGlzLiNzY2FubmVyLm5leHQoKTtcbiAgICAgICAgY2ggPSB0aGlzLiNzY2FubmVyLnBlZWsoKTtcbiAgICAgICAgdGhpcy5za2lwU2VwYXJhdGlvblNwYWNlKHRydWUsIG5vZGVJbmRlbnQpO1xuICAgICAgICBjb25zdCBuZXdTdGF0ZSA9IHRoaXMuY29tcG9zZU5vZGUoe1xuICAgICAgICAgIHBhcmVudEluZGVudDogbm9kZUluZGVudCxcbiAgICAgICAgICBub2RlQ29udGV4dDogQ09OVEVYVF9GTE9XX0lOLFxuICAgICAgICAgIGFsbG93VG9TZWVrOiBmYWxzZSxcbiAgICAgICAgICBhbGxvd0NvbXBhY3Q6IHRydWUsXG4gICAgICAgIH0pO1xuICAgICAgICBpZiAobmV3U3RhdGUpIHZhbHVlTm9kZSA9IG5ld1N0YXRlLnJlc3VsdDtcbiAgICAgIH1cblxuICAgICAgaWYgKGlzTWFwcGluZykge1xuICAgICAgICB0aGlzLnN0b3JlTWFwcGluZ1BhaXIoXG4gICAgICAgICAgcmVzdWx0IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICAgICAgICAgIG92ZXJyaWRhYmxlS2V5cyxcbiAgICAgICAgICBrZXlUYWcsXG4gICAgICAgICAga2V5Tm9kZSxcbiAgICAgICAgICB2YWx1ZU5vZGUsXG4gICAgICAgICk7XG4gICAgICB9IGVsc2UgaWYgKGlzUGFpcikge1xuICAgICAgICAocmVzdWx0IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+W10pLnB1c2goXG4gICAgICAgICAgdGhpcy5zdG9yZU1hcHBpbmdQYWlyKFxuICAgICAgICAgICAge30sXG4gICAgICAgICAgICBvdmVycmlkYWJsZUtleXMsXG4gICAgICAgICAgICBrZXlUYWcsXG4gICAgICAgICAgICBrZXlOb2RlLFxuICAgICAgICAgICAgdmFsdWVOb2RlLFxuICAgICAgICAgICksXG4gICAgICAgICk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAocmVzdWx0IGFzIHVua25vd25bXSkucHVzaChrZXlOb2RlKTtcbiAgICAgIH1cblxuICAgICAgdGhpcy5za2lwU2VwYXJhdGlvblNwYWNlKHRydWUsIG5vZGVJbmRlbnQpO1xuXG4gICAgICBjaCA9IHRoaXMuI3NjYW5uZXIucGVlaygpO1xuXG4gICAgICBpZiAoY2ggPT09IENPTU1BKSB7XG4gICAgICAgIHJlYWROZXh0ID0gdHJ1ZTtcbiAgICAgICAgdGhpcy4jc2Nhbm5lci5uZXh0KCk7XG4gICAgICAgIGNoID0gdGhpcy4jc2Nhbm5lci5wZWVrKCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZWFkTmV4dCA9IGZhbHNlO1xuICAgICAgfVxuICAgIH1cblxuICAgIHRocm93IHRoaXMuI2NyZWF0ZUVycm9yKFxuICAgICAgXCJDYW5ub3QgcmVhZCBmbG93IGNvbGxlY3Rpb246IHVuZXhwZWN0ZWQgZW5kIG9mIHRoZSBzdHJlYW0gd2l0aGluIGEgZmxvdyBjb2xsZWN0aW9uXCIsXG4gICAgKTtcbiAgfVxuICAvLyBIYW5kbGVzIGJsb2NrIHNjYWxlciBzdHlsZXM6IGUuZy4gJ3wnLCAnPicsICd8LScgYW5kICc+LScuXG4gIC8vIGh0dHBzOi8veWFtbC5vcmcvc3BlYy8xLjIuMi8jODEtYmxvY2stc2NhbGFyLXN0eWxlc1xuICByZWFkQmxvY2tTY2FsYXIoXG4gICAgdGFnOiBzdHJpbmcgfCBudWxsLFxuICAgIGFuY2hvcjogc3RyaW5nIHwgbnVsbCxcbiAgICBub2RlSW5kZW50OiBudW1iZXIsXG4gICk6IFN0YXRlIHwgdm9pZCB7XG4gICAgbGV0IGNob21waW5nID0gQ0hPTVBJTkdfQ0xJUDtcbiAgICBsZXQgZGlkUmVhZENvbnRlbnQgPSBmYWxzZTtcbiAgICBsZXQgZGV0ZWN0ZWRJbmRlbnQgPSBmYWxzZTtcbiAgICBsZXQgdGV4dEluZGVudCA9IG5vZGVJbmRlbnQ7XG4gICAgbGV0IGVtcHR5TGluZXMgPSAwO1xuICAgIGxldCBhdE1vcmVJbmRlbnRlZCA9IGZhbHNlO1xuXG4gICAgbGV0IGNoID0gdGhpcy4jc2Nhbm5lci5wZWVrKCk7XG5cbiAgICBsZXQgZm9sZGluZyA9IGZhbHNlO1xuICAgIGlmIChjaCA9PT0gVkVSVElDQUxfTElORSkge1xuICAgICAgZm9sZGluZyA9IGZhbHNlO1xuICAgIH0gZWxzZSBpZiAoY2ggPT09IEdSRUFURVJfVEhBTikge1xuICAgICAgZm9sZGluZyA9IHRydWU7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBsZXQgcmVzdWx0ID0gXCJcIjtcblxuICAgIGxldCB0bXAgPSAwO1xuICAgIHdoaWxlIChjaCAhPT0gMCkge1xuICAgICAgdGhpcy4jc2Nhbm5lci5uZXh0KCk7XG4gICAgICBjaCA9IHRoaXMuI3NjYW5uZXIucGVlaygpO1xuXG4gICAgICBpZiAoY2ggPT09IFBMVVMgfHwgY2ggPT09IE1JTlVTKSB7XG4gICAgICAgIGlmIChDSE9NUElOR19DTElQID09PSBjaG9tcGluZykge1xuICAgICAgICAgIGNob21waW5nID0gY2ggPT09IFBMVVMgPyBDSE9NUElOR19LRUVQIDogQ0hPTVBJTkdfU1RSSVA7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdGhyb3cgdGhpcy4jY3JlYXRlRXJyb3IoXG4gICAgICAgICAgICBcIkNhbm5vdCByZWFkIGJsb2NrOiBjaG9tcGluZyBtb2RlIGlkZW50aWZpZXIgcmVwZWF0ZWRcIixcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKCh0bXAgPSBkZWNpbWFsQ2hhckNvZGVUb051bWJlcihjaCkpID49IDApIHtcbiAgICAgICAgaWYgKHRtcCA9PT0gMCkge1xuICAgICAgICAgIHRocm93IHRoaXMuI2NyZWF0ZUVycm9yKFxuICAgICAgICAgICAgXCJDYW5ub3QgcmVhZCBibG9jazogaW5kZW50YXRpb24gd2lkdGggbXVzdCBiZSBncmVhdGVyIHRoYW4gMFwiLFxuICAgICAgICAgICk7XG4gICAgICAgIH0gZWxzZSBpZiAoIWRldGVjdGVkSW5kZW50KSB7XG4gICAgICAgICAgdGV4dEluZGVudCA9IG5vZGVJbmRlbnQgKyB0bXAgLSAxO1xuICAgICAgICAgIGRldGVjdGVkSW5kZW50ID0gdHJ1ZTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0aHJvdyB0aGlzLiNjcmVhdGVFcnJvcihcbiAgICAgICAgICAgIFwiQ2Fubm90IHJlYWQgYmxvY2s6IGluZGVudGF0aW9uIHdpZHRoIGlkZW50aWZpZXIgcmVwZWF0ZWRcIixcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoaXNXaGl0ZVNwYWNlKGNoKSkge1xuICAgICAgdGhpcy5za2lwV2hpdGVzcGFjZXMoKTtcbiAgICAgIHRoaXMuc2tpcENvbW1lbnQoKTtcbiAgICAgIGNoID0gdGhpcy4jc2Nhbm5lci5wZWVrKCk7XG4gICAgfVxuXG4gICAgd2hpbGUgKGNoICE9PSAwKSB7XG4gICAgICB0aGlzLnJlYWRMaW5lQnJlYWsoKTtcbiAgICAgIHRoaXMubGluZUluZGVudCA9IDA7XG5cbiAgICAgIGNoID0gdGhpcy4jc2Nhbm5lci5wZWVrKCk7XG5cbiAgICAgIHdoaWxlIChcbiAgICAgICAgKCFkZXRlY3RlZEluZGVudCB8fCB0aGlzLmxpbmVJbmRlbnQgPCB0ZXh0SW5kZW50KSAmJlxuICAgICAgICBjaCA9PT0gU1BBQ0VcbiAgICAgICkge1xuICAgICAgICB0aGlzLmxpbmVJbmRlbnQrKztcbiAgICAgICAgdGhpcy4jc2Nhbm5lci5uZXh0KCk7XG4gICAgICAgIGNoID0gdGhpcy4jc2Nhbm5lci5wZWVrKCk7XG4gICAgICB9XG5cbiAgICAgIGlmICghZGV0ZWN0ZWRJbmRlbnQgJiYgdGhpcy5saW5lSW5kZW50ID4gdGV4dEluZGVudCkge1xuICAgICAgICB0ZXh0SW5kZW50ID0gdGhpcy5saW5lSW5kZW50O1xuICAgICAgfVxuXG4gICAgICBpZiAoaXNFT0woY2gpKSB7XG4gICAgICAgIGVtcHR5TGluZXMrKztcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIC8vIEVuZCBvZiB0aGUgc2NhbGFyLlxuICAgICAgaWYgKHRoaXMubGluZUluZGVudCA8IHRleHRJbmRlbnQpIHtcbiAgICAgICAgLy8gUGVyZm9ybSB0aGUgY2hvbXBpbmcuXG4gICAgICAgIGlmIChjaG9tcGluZyA9PT0gQ0hPTVBJTkdfS0VFUCkge1xuICAgICAgICAgIHJlc3VsdCArPSBcIlxcblwiLnJlcGVhdChcbiAgICAgICAgICAgIGRpZFJlYWRDb250ZW50ID8gMSArIGVtcHR5TGluZXMgOiBlbXB0eUxpbmVzLFxuICAgICAgICAgICk7XG4gICAgICAgIH0gZWxzZSBpZiAoY2hvbXBpbmcgPT09IENIT01QSU5HX0NMSVApIHtcbiAgICAgICAgICBpZiAoZGlkUmVhZENvbnRlbnQpIHtcbiAgICAgICAgICAgIC8vIGkuZS4gb25seSBpZiB0aGUgc2NhbGFyIGlzIG5vdCBlbXB0eS5cbiAgICAgICAgICAgIHJlc3VsdCArPSBcIlxcblwiO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEJyZWFrIHRoaXMgYHdoaWxlYCBjeWNsZSBhbmQgZ28gdG8gdGhlIGZ1bmN0aW9uJ3MgZXBpbG9ndWUuXG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuXG4gICAgICAvLyBGb2xkZWQgc3R5bGU6IHVzZSBmYW5jeSBydWxlcyB0byBoYW5kbGUgbGluZSBicmVha3MuXG4gICAgICBpZiAoZm9sZGluZykge1xuICAgICAgICAvLyBMaW5lcyBzdGFydGluZyB3aXRoIHdoaXRlIHNwYWNlIGNoYXJhY3RlcnMgKG1vcmUtaW5kZW50ZWQgbGluZXMpIGFyZSBub3QgZm9sZGVkLlxuICAgICAgICBpZiAoaXNXaGl0ZVNwYWNlKGNoKSkge1xuICAgICAgICAgIGF0TW9yZUluZGVudGVkID0gdHJ1ZTtcbiAgICAgICAgICAvLyBleGNlcHQgZm9yIHRoZSBmaXJzdCBjb250ZW50IGxpbmUgKGNmLiBFeGFtcGxlIDguMSlcbiAgICAgICAgICByZXN1bHQgKz0gXCJcXG5cIi5yZXBlYXQoXG4gICAgICAgICAgICBkaWRSZWFkQ29udGVudCA/IDEgKyBlbXB0eUxpbmVzIDogZW1wdHlMaW5lcyxcbiAgICAgICAgICApO1xuXG4gICAgICAgICAgLy8gRW5kIG9mIG1vcmUtaW5kZW50ZWQgYmxvY2suXG4gICAgICAgIH0gZWxzZSBpZiAoYXRNb3JlSW5kZW50ZWQpIHtcbiAgICAgICAgICBhdE1vcmVJbmRlbnRlZCA9IGZhbHNlO1xuICAgICAgICAgIHJlc3VsdCArPSBcIlxcblwiLnJlcGVhdChlbXB0eUxpbmVzICsgMSk7XG5cbiAgICAgICAgICAvLyBKdXN0IG9uZSBsaW5lIGJyZWFrIC0gcGVyY2VpdmUgYXMgdGhlIHNhbWUgbGluZS5cbiAgICAgICAgfSBlbHNlIGlmIChlbXB0eUxpbmVzID09PSAwKSB7XG4gICAgICAgICAgaWYgKGRpZFJlYWRDb250ZW50KSB7XG4gICAgICAgICAgICAvLyBpLmUuIG9ubHkgaWYgd2UgaGF2ZSBhbHJlYWR5IHJlYWQgc29tZSBzY2FsYXIgY29udGVudC5cbiAgICAgICAgICAgIHJlc3VsdCArPSBcIiBcIjtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBTZXZlcmFsIGxpbmUgYnJlYWtzIC0gcGVyY2VpdmUgYXMgZGlmZmVyZW50IGxpbmVzLlxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHJlc3VsdCArPSBcIlxcblwiLnJlcGVhdChlbXB0eUxpbmVzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIExpdGVyYWwgc3R5bGU6IGp1c3QgYWRkIGV4YWN0IG51bWJlciBvZiBsaW5lIGJyZWFrcyBiZXR3ZWVuIGNvbnRlbnQgbGluZXMuXG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBLZWVwIGFsbCBsaW5lIGJyZWFrcyBleGNlcHQgdGhlIGhlYWRlciBsaW5lIGJyZWFrLlxuICAgICAgICByZXN1bHQgKz0gXCJcXG5cIi5yZXBlYXQoXG4gICAgICAgICAgZGlkUmVhZENvbnRlbnQgPyAxICsgZW1wdHlMaW5lcyA6IGVtcHR5TGluZXMsXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIGRpZFJlYWRDb250ZW50ID0gdHJ1ZTtcbiAgICAgIGRldGVjdGVkSW5kZW50ID0gdHJ1ZTtcbiAgICAgIGVtcHR5TGluZXMgPSAwO1xuICAgICAgY29uc3QgY2FwdHVyZVN0YXJ0ID0gdGhpcy4jc2Nhbm5lci5wb3NpdGlvbjtcblxuICAgICAgd2hpbGUgKCFpc0VPTChjaCkgJiYgY2ggIT09IDApIHtcbiAgICAgICAgdGhpcy4jc2Nhbm5lci5uZXh0KCk7XG4gICAgICAgIGNoID0gdGhpcy4jc2Nhbm5lci5wZWVrKCk7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHNlZ21lbnQgPSB0aGlzLmNhcHR1cmVTZWdtZW50KFxuICAgICAgICBjYXB0dXJlU3RhcnQsXG4gICAgICAgIHRoaXMuI3NjYW5uZXIucG9zaXRpb24sXG4gICAgICAgIGZhbHNlLFxuICAgICAgKTtcbiAgICAgIGlmIChzZWdtZW50KSByZXN1bHQgKz0gc2VnbWVudDtcbiAgICB9XG5cbiAgICBpZiAoYW5jaG9yICE9PSBudWxsKSB0aGlzLmFuY2hvck1hcC5zZXQoYW5jaG9yLCByZXN1bHQpO1xuICAgIHJldHVybiB7IHRhZywgYW5jaG9yLCBraW5kOiBcInNjYWxhclwiLCByZXN1bHQgfTtcbiAgfVxuICByZWFkQmxvY2tNYXBwaW5nKFxuICAgIHRhZzogc3RyaW5nIHwgbnVsbCxcbiAgICBhbmNob3I6IHN0cmluZyB8IG51bGwsXG4gICAgbm9kZUluZGVudDogbnVtYmVyLFxuICAgIGZsb3dJbmRlbnQ6IG51bWJlcixcbiAgKTogU3RhdGUgfCB2b2lkIHtcbiAgICBjb25zdCByZXN1bHQgPSB7fTtcbiAgICBjb25zdCBvdmVycmlkYWJsZUtleXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuICAgIGxldCBhbGxvd0NvbXBhY3QgPSBmYWxzZTtcbiAgICBsZXQgbGluZTogbnVtYmVyO1xuICAgIGxldCBwb3M6IG51bWJlcjtcbiAgICBsZXQga2V5VGFnID0gbnVsbDtcbiAgICBsZXQga2V5Tm9kZSA9IG51bGw7XG4gICAgbGV0IHZhbHVlTm9kZSA9IG51bGw7XG4gICAgbGV0IGF0RXhwbGljaXRLZXkgPSBmYWxzZTtcbiAgICBsZXQgZGV0ZWN0ZWQgPSBmYWxzZTtcblxuICAgIGlmIChhbmNob3IgIT09IG51bGwpIHRoaXMuYW5jaG9yTWFwLnNldChhbmNob3IsIHJlc3VsdCk7XG5cbiAgICBsZXQgY2ggPSB0aGlzLiNzY2FubmVyLnBlZWsoKTtcblxuICAgIHdoaWxlIChjaCAhPT0gMCkge1xuICAgICAgY29uc3QgZm9sbG93aW5nID0gdGhpcy4jc2Nhbm5lci5wZWVrKDEpO1xuICAgICAgbGluZSA9IHRoaXMubGluZTsgLy8gU2F2ZSB0aGUgY3VycmVudCBsaW5lLlxuICAgICAgcG9zID0gdGhpcy4jc2Nhbm5lci5wb3NpdGlvbjtcblxuICAgICAgLy9cbiAgICAgIC8vIEV4cGxpY2l0IG5vdGF0aW9uIGNhc2UuIFRoZXJlIGFyZSB0d28gc2VwYXJhdGUgYmxvY2tzOlxuICAgICAgLy8gZmlyc3QgZm9yIHRoZSBrZXkgKGRlbm90ZWQgYnkgXCI/XCIpIGFuZCBzZWNvbmQgZm9yIHRoZSB2YWx1ZSAoZGVub3RlZCBieSBcIjpcIilcbiAgICAgIC8vXG4gICAgICBpZiAoKGNoID09PSBRVUVTVElPTiB8fCBjaCA9PT0gQ09MT04pICYmIGlzV2hpdGVTcGFjZU9yRU9MKGZvbGxvd2luZykpIHtcbiAgICAgICAgaWYgKGNoID09PSBRVUVTVElPTikge1xuICAgICAgICAgIGlmIChhdEV4cGxpY2l0S2V5KSB7XG4gICAgICAgICAgICB0aGlzLnN0b3JlTWFwcGluZ1BhaXIoXG4gICAgICAgICAgICAgIHJlc3VsdCxcbiAgICAgICAgICAgICAgb3ZlcnJpZGFibGVLZXlzLFxuICAgICAgICAgICAgICBrZXlUYWcgYXMgc3RyaW5nLFxuICAgICAgICAgICAgICBrZXlOb2RlLFxuICAgICAgICAgICAgICBudWxsLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGtleVRhZyA9IG51bGw7XG4gICAgICAgICAgICBrZXlOb2RlID0gbnVsbDtcbiAgICAgICAgICAgIHZhbHVlTm9kZSA9IG51bGw7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgZGV0ZWN0ZWQgPSB0cnVlO1xuICAgICAgICAgIGF0RXhwbGljaXRLZXkgPSB0cnVlO1xuICAgICAgICAgIGFsbG93Q29tcGFjdCA9IHRydWU7XG4gICAgICAgIH0gZWxzZSBpZiAoYXRFeHBsaWNpdEtleSkge1xuICAgICAgICAgIC8vIGkuZS4gMHgzQS8qIDogKi8gPT09IGNoYXJhY3RlciBhZnRlciB0aGUgZXhwbGljaXQga2V5LlxuICAgICAgICAgIGF0RXhwbGljaXRLZXkgPSBmYWxzZTtcbiAgICAgICAgICBhbGxvd0NvbXBhY3QgPSB0cnVlO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRocm93IHRoaXMuI2NyZWF0ZUVycm9yKFxuICAgICAgICAgICAgXCJDYW5ub3QgcmVhZCBibG9jayBhcyBleHBsaWNpdCBtYXBwaW5nIHBhaXIgaXMgaW5jb21wbGV0ZTogYSBrZXkgbm9kZSBpcyBtaXNzZWQgb3IgZm9sbG93ZWQgYnkgYSBub24tdGFidWxhdGVkIGVtcHR5IGxpbmVcIixcbiAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhpcy4jc2Nhbm5lci5uZXh0KCk7XG4gICAgICAgIGNoID0gZm9sbG93aW5nO1xuXG4gICAgICAgIC8vXG4gICAgICAgIC8vIEltcGxpY2l0IG5vdGF0aW9uIGNhc2UuIEZsb3ctc3R5bGUgbm9kZSBhcyB0aGUga2V5IGZpcnN0LCB0aGVuIFwiOlwiLCBhbmQgdGhlIHZhbHVlLlxuICAgICAgICAvL1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc3QgbmV3U3RhdGUgPSB0aGlzLmNvbXBvc2VOb2RlKHtcbiAgICAgICAgICBwYXJlbnRJbmRlbnQ6IGZsb3dJbmRlbnQsXG4gICAgICAgICAgbm9kZUNvbnRleHQ6IENPTlRFWFRfRkxPV19PVVQsXG4gICAgICAgICAgYWxsb3dUb1NlZWs6IGZhbHNlLFxuICAgICAgICAgIGFsbG93Q29tcGFjdDogdHJ1ZSxcbiAgICAgICAgfSk7XG4gICAgICAgIGlmICghbmV3U3RhdGUpIGJyZWFrOyAvLyBSZWFkaW5nIGlzIGRvbmUuIEdvIHRvIHRoZSBlcGlsb2d1ZS5cbiAgICAgICAgaWYgKHRoaXMubGluZSA9PT0gbGluZSkge1xuICAgICAgICAgIGNoID0gdGhpcy4jc2Nhbm5lci5wZWVrKCk7XG5cbiAgICAgICAgICB0aGlzLnNraXBXaGl0ZXNwYWNlcygpO1xuICAgICAgICAgIGNoID0gdGhpcy4jc2Nhbm5lci5wZWVrKCk7XG5cbiAgICAgICAgICBpZiAoY2ggPT09IENPTE9OKSB7XG4gICAgICAgICAgICB0aGlzLiNzY2FubmVyLm5leHQoKTtcbiAgICAgICAgICAgIGNoID0gdGhpcy4jc2Nhbm5lci5wZWVrKCk7XG5cbiAgICAgICAgICAgIGlmICghaXNXaGl0ZVNwYWNlT3JFT0woY2gpKSB7XG4gICAgICAgICAgICAgIHRocm93IHRoaXMuI2NyZWF0ZUVycm9yKFxuICAgICAgICAgICAgICAgIFwiQ2Fubm90IHJlYWQgYmxvY2s6IGEgd2hpdGVzcGFjZSBjaGFyYWN0ZXIgaXMgZXhwZWN0ZWQgYWZ0ZXIgdGhlIGtleS12YWx1ZSBzZXBhcmF0b3Igd2l0aGluIGEgYmxvY2sgbWFwcGluZ1wiLFxuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoYXRFeHBsaWNpdEtleSkge1xuICAgICAgICAgICAgICB0aGlzLnN0b3JlTWFwcGluZ1BhaXIoXG4gICAgICAgICAgICAgICAgcmVzdWx0LFxuICAgICAgICAgICAgICAgIG92ZXJyaWRhYmxlS2V5cyxcbiAgICAgICAgICAgICAgICBrZXlUYWcgYXMgc3RyaW5nLFxuICAgICAgICAgICAgICAgIGtleU5vZGUsXG4gICAgICAgICAgICAgICAgbnVsbCxcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAga2V5VGFnID0gbnVsbDtcbiAgICAgICAgICAgICAga2V5Tm9kZSA9IG51bGw7XG4gICAgICAgICAgICAgIHZhbHVlTm9kZSA9IG51bGw7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGRldGVjdGVkID0gdHJ1ZTtcbiAgICAgICAgICAgIGF0RXhwbGljaXRLZXkgPSBmYWxzZTtcbiAgICAgICAgICAgIGFsbG93Q29tcGFjdCA9IGZhbHNlO1xuICAgICAgICAgICAga2V5VGFnID0gbmV3U3RhdGUudGFnO1xuICAgICAgICAgICAga2V5Tm9kZSA9IG5ld1N0YXRlLnJlc3VsdDtcbiAgICAgICAgICB9IGVsc2UgaWYgKGRldGVjdGVkKSB7XG4gICAgICAgICAgICB0aHJvdyB0aGlzLiNjcmVhdGVFcnJvcihcbiAgICAgICAgICAgICAgXCJDYW5ub3QgcmVhZCBhbiBpbXBsaWNpdCBtYXBwaW5nIHBhaXI6IG1pc3NpbmcgY29sb25cIixcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNvbnN0IHsga2luZCwgcmVzdWx0IH0gPSBuZXdTdGF0ZTtcbiAgICAgICAgICAgIHJldHVybiB7IHRhZywgYW5jaG9yLCBraW5kLCByZXN1bHQgfTsgLy8gS2VlcCB0aGUgcmVzdWx0IG9mIGBjb21wb3NlTm9kZWAuXG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgaWYgKGRldGVjdGVkKSB7XG4gICAgICAgICAgdGhyb3cgdGhpcy4jY3JlYXRlRXJyb3IoXG4gICAgICAgICAgICBcIkNhbm5vdCByZWFkIGEgYmxvY2sgbWFwcGluZyBlbnRyeTogYSBtdWx0aWxpbmUga2V5IG1heSBub3QgYmUgYW4gaW1wbGljaXQga2V5XCIsXG4gICAgICAgICAgKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBjb25zdCB7IGtpbmQsIHJlc3VsdCB9ID0gbmV3U3RhdGU7XG4gICAgICAgICAgcmV0dXJuIHsgdGFnLCBhbmNob3IsIGtpbmQsIHJlc3VsdCB9OyAvLyBLZWVwIHRoZSByZXN1bHQgb2YgYGNvbXBvc2VOb2RlYC5cbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvL1xuICAgICAgLy8gQ29tbW9uIHJlYWRpbmcgY29kZSBmb3IgYm90aCBleHBsaWNpdCBhbmQgaW1wbGljaXQgbm90YXRpb25zLlxuICAgICAgLy9cbiAgICAgIGlmICh0aGlzLmxpbmUgPT09IGxpbmUgfHwgdGhpcy5saW5lSW5kZW50ID4gbm9kZUluZGVudCkge1xuICAgICAgICBjb25zdCBuZXdTdGF0ZSA9IHRoaXMuY29tcG9zZU5vZGUoe1xuICAgICAgICAgIHBhcmVudEluZGVudDogbm9kZUluZGVudCxcbiAgICAgICAgICBub2RlQ29udGV4dDogQ09OVEVYVF9CTE9DS19PVVQsXG4gICAgICAgICAgYWxsb3dUb1NlZWs6IHRydWUsXG4gICAgICAgICAgYWxsb3dDb21wYWN0LFxuICAgICAgICB9KTtcbiAgICAgICAgaWYgKG5ld1N0YXRlKSB7XG4gICAgICAgICAgaWYgKGF0RXhwbGljaXRLZXkpIHtcbiAgICAgICAgICAgIGtleU5vZGUgPSBuZXdTdGF0ZS5yZXN1bHQ7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHZhbHVlTm9kZSA9IG5ld1N0YXRlLnJlc3VsdDtcbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIWF0RXhwbGljaXRLZXkpIHtcbiAgICAgICAgICB0aGlzLnN0b3JlTWFwcGluZ1BhaXIoXG4gICAgICAgICAgICByZXN1bHQsXG4gICAgICAgICAgICBvdmVycmlkYWJsZUtleXMsXG4gICAgICAgICAgICBrZXlUYWcgYXMgc3RyaW5nLFxuICAgICAgICAgICAga2V5Tm9kZSxcbiAgICAgICAgICAgIHZhbHVlTm9kZSxcbiAgICAgICAgICAgIGxpbmUsXG4gICAgICAgICAgICBwb3MsXG4gICAgICAgICAgKTtcbiAgICAgICAgICBrZXlUYWcgPSBrZXlOb2RlID0gdmFsdWVOb2RlID0gbnVsbDtcbiAgICAgICAgfVxuXG4gICAgICAgIHRoaXMuc2tpcFNlcGFyYXRpb25TcGFjZSh0cnVlLCAtMSk7XG4gICAgICAgIGNoID0gdGhpcy4jc2Nhbm5lci5wZWVrKCk7XG4gICAgICB9XG5cbiAgICAgIGlmICh0aGlzLmxpbmVJbmRlbnQgPiBub2RlSW5kZW50ICYmIGNoICE9PSAwKSB7XG4gICAgICAgIHRocm93IHRoaXMuI2NyZWF0ZUVycm9yKFxuICAgICAgICAgIFwiQ2Fubm90IHJlYWQgYmxvY2s6IGJhZCBpbmRlbnRhdGlvbiBvZiBhIG1hcHBpbmcgZW50cnlcIixcbiAgICAgICAgKTtcbiAgICAgIH0gZWxzZSBpZiAodGhpcy5saW5lSW5kZW50IDwgbm9kZUluZGVudCkge1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvL1xuICAgIC8vIEVwaWxvZ3VlLlxuICAgIC8vXG5cbiAgICAvLyBTcGVjaWFsIGNhc2U6IGxhc3QgbWFwcGluZydzIG5vZGUgY29udGFpbnMgb25seSB0aGUga2V5IGluIGV4cGxpY2l0IG5vdGF0aW9uLlxuICAgIGlmIChhdEV4cGxpY2l0S2V5KSB7XG4gICAgICB0aGlzLnN0b3JlTWFwcGluZ1BhaXIoXG4gICAgICAgIHJlc3VsdCxcbiAgICAgICAgb3ZlcnJpZGFibGVLZXlzLFxuICAgICAgICBrZXlUYWcgYXMgc3RyaW5nLFxuICAgICAgICBrZXlOb2RlLFxuICAgICAgICBudWxsLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICAvLyBFeHBvc2UgdGhlIHJlc3VsdGluZyBtYXBwaW5nLlxuICAgIGlmIChkZXRlY3RlZCkgcmV0dXJuIHsgdGFnLCBhbmNob3IsIGtpbmQ6IFwibWFwcGluZ1wiLCByZXN1bHQgfTtcbiAgfVxuICByZWFkVGFnUHJvcGVydHkodGFnOiBzdHJpbmcgfCBudWxsKTogc3RyaW5nIHwgdm9pZCB7XG4gICAgbGV0IGlzVmVyYmF0aW0gPSBmYWxzZTtcbiAgICBsZXQgaXNOYW1lZCA9IGZhbHNlO1xuICAgIGxldCB0YWdIYW5kbGUgPSBcIlwiO1xuICAgIGxldCB0YWdOYW1lOiBzdHJpbmc7XG5cbiAgICBsZXQgY2ggPSB0aGlzLiNzY2FubmVyLnBlZWsoKTtcblxuICAgIGlmIChjaCAhPT0gRVhDTEFNQVRJT04pIHJldHVybjtcblxuICAgIGlmICh0YWcgIT09IG51bGwpIHtcbiAgICAgIHRocm93IHRoaXMuI2NyZWF0ZUVycm9yKFxuICAgICAgICBcIkNhbm5vdCByZWFkIHRhZyBwcm9wZXJ0eTogZHVwbGljYXRpb24gb2YgYSB0YWcgcHJvcGVydHlcIixcbiAgICAgICk7XG4gICAgfVxuXG4gICAgdGhpcy4jc2Nhbm5lci5uZXh0KCk7XG4gICAgY2ggPSB0aGlzLiNzY2FubmVyLnBlZWsoKTtcblxuICAgIGlmIChjaCA9PT0gU01BTExFUl9USEFOKSB7XG4gICAgICBpc1ZlcmJhdGltID0gdHJ1ZTtcbiAgICAgIHRoaXMuI3NjYW5uZXIubmV4dCgpO1xuICAgICAgY2ggPSB0aGlzLiNzY2FubmVyLnBlZWsoKTtcbiAgICB9IGVsc2UgaWYgKGNoID09PSBFWENMQU1BVElPTikge1xuICAgICAgaXNOYW1lZCA9IHRydWU7XG4gICAgICB0YWdIYW5kbGUgPSBcIiEhXCI7XG4gICAgICB0aGlzLiNzY2FubmVyLm5leHQoKTtcbiAgICAgIGNoID0gdGhpcy4jc2Nhbm5lci5wZWVrKCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRhZ0hhbmRsZSA9IFwiIVwiO1xuICAgIH1cblxuICAgIGxldCBwb3NpdGlvbiA9IHRoaXMuI3NjYW5uZXIucG9zaXRpb247XG5cbiAgICBpZiAoaXNWZXJiYXRpbSkge1xuICAgICAgZG8ge1xuICAgICAgICB0aGlzLiNzY2FubmVyLm5leHQoKTtcbiAgICAgICAgY2ggPSB0aGlzLiNzY2FubmVyLnBlZWsoKTtcbiAgICAgIH0gd2hpbGUgKGNoICE9PSAwICYmIGNoICE9PSBHUkVBVEVSX1RIQU4pO1xuXG4gICAgICBpZiAoIXRoaXMuI3NjYW5uZXIuZW9mKCkpIHtcbiAgICAgICAgdGFnTmFtZSA9IHRoaXMuI3NjYW5uZXIuc291cmNlLnNsaWNlKHBvc2l0aW9uLCB0aGlzLiNzY2FubmVyLnBvc2l0aW9uKTtcbiAgICAgICAgdGhpcy4jc2Nhbm5lci5uZXh0KCk7XG4gICAgICAgIGNoID0gdGhpcy4jc2Nhbm5lci5wZWVrKCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aHJvdyB0aGlzLiNjcmVhdGVFcnJvcihcbiAgICAgICAgICBcIkNhbm5vdCByZWFkIHRhZyBwcm9wZXJ0eTogdW5leHBlY3RlZCBlbmQgb2Ygc3RyZWFtXCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHdoaWxlIChjaCAhPT0gMCAmJiAhaXNXaGl0ZVNwYWNlT3JFT0woY2gpKSB7XG4gICAgICAgIGlmIChjaCA9PT0gRVhDTEFNQVRJT04pIHtcbiAgICAgICAgICBpZiAoIWlzTmFtZWQpIHtcbiAgICAgICAgICAgIHRhZ0hhbmRsZSA9IHRoaXMuI3NjYW5uZXIuc291cmNlLnNsaWNlKFxuICAgICAgICAgICAgICBwb3NpdGlvbiAtIDEsXG4gICAgICAgICAgICAgIHRoaXMuI3NjYW5uZXIucG9zaXRpb24gKyAxLFxuICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgaWYgKCFQQVRURVJOX1RBR19IQU5ETEUudGVzdCh0YWdIYW5kbGUpKSB7XG4gICAgICAgICAgICAgIHRocm93IHRoaXMuI2NyZWF0ZUVycm9yKFxuICAgICAgICAgICAgICAgIFwiQ2Fubm90IHJlYWQgdGFnIHByb3BlcnR5OiBuYW1lZCB0YWcgaGFuZGxlIGNvbnRhaW5zIGludmFsaWQgY2hhcmFjdGVyc1wiLFxuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpc05hbWVkID0gdHJ1ZTtcbiAgICAgICAgICAgIHBvc2l0aW9uID0gdGhpcy4jc2Nhbm5lci5wb3NpdGlvbiArIDE7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRocm93IHRoaXMuI2NyZWF0ZUVycm9yKFxuICAgICAgICAgICAgICBcIkNhbm5vdCByZWFkIHRhZyBwcm9wZXJ0eTogdGFnIHN1ZmZpeCBjYW5ub3QgY29udGFpbiBhbiBleGNsYW1hdGlvbiBtYXJrXCIsXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHRoaXMuI3NjYW5uZXIubmV4dCgpO1xuICAgICAgICBjaCA9IHRoaXMuI3NjYW5uZXIucGVlaygpO1xuICAgICAgfVxuXG4gICAgICB0YWdOYW1lID0gdGhpcy4jc2Nhbm5lci5zb3VyY2Uuc2xpY2UocG9zaXRpb24sIHRoaXMuI3NjYW5uZXIucG9zaXRpb24pO1xuXG4gICAgICBpZiAoUEFUVEVSTl9GTE9XX0lORElDQVRPUlMudGVzdCh0YWdOYW1lKSkge1xuICAgICAgICB0aHJvdyB0aGlzLiNjcmVhdGVFcnJvcihcbiAgICAgICAgICBcIkNhbm5vdCByZWFkIHRhZyBwcm9wZXJ0eTogdGFnIHN1ZmZpeCBjYW5ub3QgY29udGFpbiBmbG93IGluZGljYXRvciBjaGFyYWN0ZXJzXCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHRhZ05hbWUgJiYgIVBBVFRFUk5fVEFHX1VSSS50ZXN0KHRhZ05hbWUpKSB7XG4gICAgICB0aHJvdyB0aGlzLiNjcmVhdGVFcnJvcihcbiAgICAgICAgYENhbm5vdCByZWFkIHRhZyBwcm9wZXJ0eTogaW52YWxpZCBjaGFyYWN0ZXJzIGluIHRhZyBuYW1lIFwiJHt0YWdOYW1lfVwiYCxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgaWYgKGlzVmVyYmF0aW0pIHtcbiAgICAgIHJldHVybiB0YWdOYW1lO1xuICAgIH0gZWxzZSBpZiAodGhpcy50YWdNYXAuaGFzKHRhZ0hhbmRsZSkpIHtcbiAgICAgIHJldHVybiB0aGlzLnRhZ01hcC5nZXQodGFnSGFuZGxlKSArIHRhZ05hbWU7XG4gICAgfSBlbHNlIGlmICh0YWdIYW5kbGUgPT09IFwiIVwiKSB7XG4gICAgICByZXR1cm4gYCEke3RhZ05hbWV9YDtcbiAgICB9IGVsc2UgaWYgKHRhZ0hhbmRsZSA9PT0gXCIhIVwiKSB7XG4gICAgICByZXR1cm4gYHRhZzp5YW1sLm9yZywyMDAyOiR7dGFnTmFtZX1gO1xuICAgIH1cblxuICAgIHRocm93IHRoaXMuI2NyZWF0ZUVycm9yKFxuICAgICAgYENhbm5vdCByZWFkIHRhZyBwcm9wZXJ0eTogdW5kZWNsYXJlZCB0YWcgaGFuZGxlIFwiJHt0YWdIYW5kbGV9XCJgLFxuICAgICk7XG4gIH1cbiAgcmVhZEFuY2hvclByb3BlcnR5KGFuY2hvcjogc3RyaW5nIHwgbnVsbCk6IHN0cmluZyB8IHZvaWQge1xuICAgIGxldCBjaCA9IHRoaXMuI3NjYW5uZXIucGVlaygpO1xuICAgIGlmIChjaCAhPT0gQU1QRVJTQU5EKSByZXR1cm47XG5cbiAgICBpZiAoYW5jaG9yICE9PSBudWxsKSB7XG4gICAgICB0aHJvdyB0aGlzLiNjcmVhdGVFcnJvcihcbiAgICAgICAgXCJDYW5ub3QgcmVhZCBhbmNob3IgcHJvcGVydHk6IGR1cGxpY2F0ZSBhbmNob3IgcHJvcGVydHlcIixcbiAgICAgICk7XG4gICAgfVxuICAgIHRoaXMuI3NjYW5uZXIubmV4dCgpO1xuICAgIGNoID0gdGhpcy4jc2Nhbm5lci5wZWVrKCk7XG5cbiAgICBjb25zdCBwb3NpdGlvbiA9IHRoaXMuI3NjYW5uZXIucG9zaXRpb247XG4gICAgd2hpbGUgKGNoICE9PSAwICYmICFpc1doaXRlU3BhY2VPckVPTChjaCkgJiYgIWlzRmxvd0luZGljYXRvcihjaCkpIHtcbiAgICAgIHRoaXMuI3NjYW5uZXIubmV4dCgpO1xuICAgICAgY2ggPSB0aGlzLiNzY2FubmVyLnBlZWsoKTtcbiAgICB9XG5cbiAgICBpZiAodGhpcy4jc2Nhbm5lci5wb3NpdGlvbiA9PT0gcG9zaXRpb24pIHtcbiAgICAgIHRocm93IHRoaXMuI2NyZWF0ZUVycm9yKFxuICAgICAgICBcIkNhbm5vdCByZWFkIGFuY2hvciBwcm9wZXJ0eTogbmFtZSBvZiBhbiBhbmNob3Igbm9kZSBtdXN0IGNvbnRhaW4gYXQgbGVhc3Qgb25lIGNoYXJhY3RlclwiLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICByZXR1cm4gdGhpcy4jc2Nhbm5lci5zb3VyY2Uuc2xpY2UocG9zaXRpb24sIHRoaXMuI3NjYW5uZXIucG9zaXRpb24pO1xuICB9XG4gIHJlYWRBbGlhcygpOiBzdHJpbmcgfCB2b2lkIHtcbiAgICBpZiAodGhpcy4jc2Nhbm5lci5wZWVrKCkgIT09IEFTVEVSSVNLKSByZXR1cm47XG5cbiAgICB0aGlzLiNzY2FubmVyLm5leHQoKTtcbiAgICBsZXQgY2ggPSB0aGlzLiNzY2FubmVyLnBlZWsoKTtcblxuICAgIGNvbnN0IHBvc2l0aW9uID0gdGhpcy4jc2Nhbm5lci5wb3NpdGlvbjtcblxuICAgIHdoaWxlIChjaCAhPT0gMCAmJiAhaXNXaGl0ZVNwYWNlT3JFT0woY2gpICYmICFpc0Zsb3dJbmRpY2F0b3IoY2gpKSB7XG4gICAgICB0aGlzLiNzY2FubmVyLm5leHQoKTtcbiAgICAgIGNoID0gdGhpcy4jc2Nhbm5lci5wZWVrKCk7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuI3NjYW5uZXIucG9zaXRpb24gPT09IHBvc2l0aW9uKSB7XG4gICAgICB0aHJvdyB0aGlzLiNjcmVhdGVFcnJvcihcbiAgICAgICAgXCJDYW5ub3QgcmVhZCBhbGlhczogYWxpYXMgbmFtZSBtdXN0IGNvbnRhaW4gYXQgbGVhc3Qgb25lIGNoYXJhY3RlclwiLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCBhbGlhcyA9IHRoaXMuI3NjYW5uZXIuc291cmNlLnNsaWNlKHBvc2l0aW9uLCB0aGlzLiNzY2FubmVyLnBvc2l0aW9uKTtcbiAgICBpZiAoIXRoaXMuYW5jaG9yTWFwLmhhcyhhbGlhcykpIHtcbiAgICAgIHRocm93IHRoaXMuI2NyZWF0ZUVycm9yKFxuICAgICAgICBgQ2Fubm90IHJlYWQgYWxpYXM6IHVuaWRlbnRpZmllZCBhbGlhcyBcIiR7YWxpYXN9XCJgLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICB0aGlzLnNraXBTZXBhcmF0aW9uU3BhY2UodHJ1ZSwgLTEpO1xuXG4gICAgcmV0dXJuIHRoaXMuYW5jaG9yTWFwLmdldChhbGlhcyk7XG4gIH1cbiAgcmVzb2x2ZVRhZyhzdGF0ZTogU3RhdGUpIHtcbiAgICBzd2l0Y2ggKHN0YXRlLnRhZykge1xuICAgICAgY2FzZSBudWxsOlxuICAgICAgY2FzZSBcIiFcIjpcbiAgICAgICAgcmV0dXJuIHN0YXRlO1xuICAgICAgY2FzZSBcIj9cIjoge1xuICAgICAgICBmb3IgKGNvbnN0IHR5cGUgb2YgdGhpcy5pbXBsaWNpdFR5cGVzKSB7XG4gICAgICAgICAgLy8gSW1wbGljaXQgcmVzb2x2aW5nIGlzIG5vdCBhbGxvd2VkIGZvciBub24tc2NhbGFyIHR5cGVzLCBhbmQgJz8nXG4gICAgICAgICAgLy8gbm9uLXNwZWNpZmljIHRhZyBpcyBvbmx5IGFzc2lnbmVkIHRvIHBsYWluIHNjYWxhcnMuIFNvLCBpdCBpc24ndFxuICAgICAgICAgIC8vIG5lZWRlZCB0byBjaGVjayBmb3IgJ2tpbmQnIGNvbmZvcm1pdHkuXG5cbiAgICAgICAgICBpZiAoIXR5cGUucmVzb2x2ZShzdGF0ZS5yZXN1bHQpKSBjb250aW51ZTtcbiAgICAgICAgICAvLyBgc3RhdGUucmVzdWx0YCB1cGRhdGVkIGluIHJlc29sdmVyIGlmIG1hdGNoZWRcbiAgICAgICAgICBjb25zdCByZXN1bHQgPSB0eXBlLmNvbnN0cnVjdChzdGF0ZS5yZXN1bHQpO1xuICAgICAgICAgIHN0YXRlLnJlc3VsdCA9IHJlc3VsdDtcbiAgICAgICAgICBzdGF0ZS50YWcgPSB0eXBlLnRhZztcbiAgICAgICAgICBjb25zdCB7IGFuY2hvciB9ID0gc3RhdGU7XG4gICAgICAgICAgaWYgKGFuY2hvciAhPT0gbnVsbCkgdGhpcy5hbmNob3JNYXAuc2V0KGFuY2hvciwgcmVzdWx0KTtcbiAgICAgICAgICByZXR1cm4gc3RhdGU7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHN0YXRlO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IGtpbmQgPSBzdGF0ZS5raW5kID8/IFwiZmFsbGJhY2tcIjtcblxuICAgIGNvbnN0IG1hcCA9IHRoaXMudHlwZU1hcFtraW5kXTtcbiAgICBjb25zdCB0eXBlID0gbWFwLmdldChzdGF0ZS50YWcpO1xuXG4gICAgaWYgKCF0eXBlKSB7XG4gICAgICB0aHJvdyB0aGlzLiNjcmVhdGVFcnJvcihcbiAgICAgICAgYENhbm5vdCByZXNvbHZlIHVua25vd24gdGFnICE8JHtzdGF0ZS50YWd9PmAsXG4gICAgICApO1xuICAgIH1cblxuICAgIGlmIChzdGF0ZS5yZXN1bHQgIT09IG51bGwgJiYgdHlwZS5raW5kICE9PSBzdGF0ZS5raW5kKSB7XG4gICAgICB0aHJvdyB0aGlzLiNjcmVhdGVFcnJvcihcbiAgICAgICAgYFVuYWNjZXB0YWJsZSBub2RlIGtpbmQgZm9yICE8JHtzdGF0ZS50YWd9PiB0YWc6IGl0IHNob3VsZCBiZSBcIiR7dHlwZS5raW5kfVwiLCBub3QgXCIke3N0YXRlLmtpbmR9XCJgLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBpZiAoIXR5cGUucmVzb2x2ZShzdGF0ZS5yZXN1bHQpKSB7XG4gICAgICAvLyBgc3RhdGUucmVzdWx0YCB1cGRhdGVkIGluIHJlc29sdmVyIGlmIG1hdGNoZWRcbiAgICAgIHRocm93IHRoaXMuI2NyZWF0ZUVycm9yKFxuICAgICAgICBgQ2Fubm90IHJlc29sdmUgYSBub2RlIHdpdGggITwke3N0YXRlLnRhZ30+IGV4cGxpY2l0IHRhZ2AsXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IHJlc3VsdCA9IHR5cGUuY29uc3RydWN0KHN0YXRlLnJlc3VsdCk7XG4gICAgc3RhdGUucmVzdWx0ID0gcmVzdWx0O1xuICAgIGNvbnN0IHsgYW5jaG9yIH0gPSBzdGF0ZTtcbiAgICBpZiAoYW5jaG9yICE9PSBudWxsKSB0aGlzLmFuY2hvck1hcC5zZXQoYW5jaG9yLCByZXN1bHQpO1xuICAgIHJldHVybiBzdGF0ZTtcbiAgfVxuICBjb21wb3NlTm9kZSh7IHBhcmVudEluZGVudCwgbm9kZUNvbnRleHQsIGFsbG93VG9TZWVrLCBhbGxvd0NvbXBhY3QgfToge1xuICAgIHBhcmVudEluZGVudDogbnVtYmVyO1xuICAgIG5vZGVDb250ZXh0OiBudW1iZXI7XG4gICAgYWxsb3dUb1NlZWs6IGJvb2xlYW47XG4gICAgYWxsb3dDb21wYWN0OiBib29sZWFuO1xuICB9KTogU3RhdGUgfCB2b2lkIHtcbiAgICBsZXQgaW5kZW50U3RhdHVzID0gMTsgLy8gMTogdGhpcz5wYXJlbnQsIDA6IHRoaXM9cGFyZW50LCAtMTogdGhpczxwYXJlbnRcbiAgICBsZXQgYXROZXdMaW5lID0gZmFsc2U7XG5cbiAgICBjb25zdCBhbGxvd0Jsb2NrU2NhbGFycyA9IENPTlRFWFRfQkxPQ0tfT1VUID09PSBub2RlQ29udGV4dCB8fFxuICAgICAgQ09OVEVYVF9CTE9DS19JTiA9PT0gbm9kZUNvbnRleHQ7XG5cbiAgICBsZXQgYWxsb3dCbG9ja0NvbGxlY3Rpb25zID0gYWxsb3dCbG9ja1NjYWxhcnM7XG4gICAgY29uc3QgYWxsb3dCbG9ja1N0eWxlcyA9IGFsbG93QmxvY2tTY2FsYXJzO1xuXG4gICAgaWYgKGFsbG93VG9TZWVrKSB7XG4gICAgICBpZiAodGhpcy5za2lwU2VwYXJhdGlvblNwYWNlKHRydWUsIC0xKSkge1xuICAgICAgICBhdE5ld0xpbmUgPSB0cnVlO1xuICAgICAgICBpbmRlbnRTdGF0dXMgPSBnZXRJbmRlbnRTdGF0dXModGhpcy5saW5lSW5kZW50LCBwYXJlbnRJbmRlbnQpO1xuICAgICAgfVxuICAgIH1cblxuICAgIGxldCB0YWc6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgIGxldCBhbmNob3I6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG4gICAgaWYgKGluZGVudFN0YXR1cyA9PT0gMSkge1xuICAgICAgd2hpbGUgKHRydWUpIHtcbiAgICAgICAgY29uc3QgbmV3VGFnID0gdGhpcy5yZWFkVGFnUHJvcGVydHkodGFnKTtcbiAgICAgICAgaWYgKG5ld1RhZykge1xuICAgICAgICAgIHRhZyA9IG5ld1RhZztcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBjb25zdCBuZXdBbmNob3IgPSB0aGlzLnJlYWRBbmNob3JQcm9wZXJ0eShhbmNob3IpO1xuICAgICAgICAgIGlmICghbmV3QW5jaG9yKSBicmVhaztcbiAgICAgICAgICBhbmNob3IgPSBuZXdBbmNob3I7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHRoaXMuc2tpcFNlcGFyYXRpb25TcGFjZSh0cnVlLCAtMSkpIHtcbiAgICAgICAgICBhdE5ld0xpbmUgPSB0cnVlO1xuICAgICAgICAgIGFsbG93QmxvY2tDb2xsZWN0aW9ucyA9IGFsbG93QmxvY2tTdHlsZXM7XG4gICAgICAgICAgaW5kZW50U3RhdHVzID0gZ2V0SW5kZW50U3RhdHVzKHRoaXMubGluZUluZGVudCwgcGFyZW50SW5kZW50KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBhbGxvd0Jsb2NrQ29sbGVjdGlvbnMgPSBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChhbGxvd0Jsb2NrQ29sbGVjdGlvbnMpIHtcbiAgICAgIGFsbG93QmxvY2tDb2xsZWN0aW9ucyA9IGF0TmV3TGluZSB8fCBhbGxvd0NvbXBhY3Q7XG4gICAgfVxuXG4gICAgaWYgKGluZGVudFN0YXR1cyA9PT0gMSkge1xuICAgICAgY29uc3QgY29uZCA9IENPTlRFWFRfRkxPV19JTiA9PT0gbm9kZUNvbnRleHQgfHxcbiAgICAgICAgQ09OVEVYVF9GTE9XX09VVCA9PT0gbm9kZUNvbnRleHQ7XG4gICAgICBjb25zdCBmbG93SW5kZW50ID0gY29uZCA/IHBhcmVudEluZGVudCA6IHBhcmVudEluZGVudCArIDE7XG5cbiAgICAgIGlmIChhbGxvd0Jsb2NrQ29sbGVjdGlvbnMpIHtcbiAgICAgICAgY29uc3QgYmxvY2tJbmRlbnQgPSB0aGlzLiNzY2FubmVyLnBvc2l0aW9uIC0gdGhpcy5saW5lU3RhcnQ7XG4gICAgICAgIGNvbnN0IGJsb2NrU2VxdWVuY2VTdGF0ZSA9IHRoaXMucmVhZEJsb2NrU2VxdWVuY2UoXG4gICAgICAgICAgdGFnLFxuICAgICAgICAgIGFuY2hvcixcbiAgICAgICAgICBibG9ja0luZGVudCxcbiAgICAgICAgKTtcbiAgICAgICAgaWYgKGJsb2NrU2VxdWVuY2VTdGF0ZSkgcmV0dXJuIHRoaXMucmVzb2x2ZVRhZyhibG9ja1NlcXVlbmNlU3RhdGUpO1xuXG4gICAgICAgIGNvbnN0IGJsb2NrTWFwcGluZ1N0YXRlID0gdGhpcy5yZWFkQmxvY2tNYXBwaW5nKFxuICAgICAgICAgIHRhZyxcbiAgICAgICAgICBhbmNob3IsXG4gICAgICAgICAgYmxvY2tJbmRlbnQsXG4gICAgICAgICAgZmxvd0luZGVudCxcbiAgICAgICAgKTtcbiAgICAgICAgaWYgKGJsb2NrTWFwcGluZ1N0YXRlKSByZXR1cm4gdGhpcy5yZXNvbHZlVGFnKGJsb2NrTWFwcGluZ1N0YXRlKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGZsb3dDb2xsZWN0aW9uU3RhdGUgPSB0aGlzLnJlYWRGbG93Q29sbGVjdGlvbihcbiAgICAgICAgdGFnLFxuICAgICAgICBhbmNob3IsXG4gICAgICAgIGZsb3dJbmRlbnQsXG4gICAgICApO1xuICAgICAgaWYgKGZsb3dDb2xsZWN0aW9uU3RhdGUpIHJldHVybiB0aGlzLnJlc29sdmVUYWcoZmxvd0NvbGxlY3Rpb25TdGF0ZSk7XG5cbiAgICAgIGlmIChhbGxvd0Jsb2NrU2NhbGFycykge1xuICAgICAgICBjb25zdCBibG9ja1NjYWxhclN0YXRlID0gdGhpcy5yZWFkQmxvY2tTY2FsYXIoXG4gICAgICAgICAgdGFnLFxuICAgICAgICAgIGFuY2hvcixcbiAgICAgICAgICBmbG93SW5kZW50LFxuICAgICAgICApO1xuICAgICAgICBpZiAoYmxvY2tTY2FsYXJTdGF0ZSkgcmV0dXJuIHRoaXMucmVzb2x2ZVRhZyhibG9ja1NjYWxhclN0YXRlKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHNpbmdsZVF1b3RlU3RhdGUgPSB0aGlzLnJlYWRTaW5nbGVRdW90ZWRTY2FsYXIoXG4gICAgICAgIHRhZyxcbiAgICAgICAgYW5jaG9yLFxuICAgICAgICBmbG93SW5kZW50LFxuICAgICAgKTtcbiAgICAgIGlmIChzaW5nbGVRdW90ZVN0YXRlKSByZXR1cm4gdGhpcy5yZXNvbHZlVGFnKHNpbmdsZVF1b3RlU3RhdGUpO1xuXG4gICAgICBjb25zdCBkb3VibGVRdW90ZVN0YXRlID0gdGhpcy5yZWFkRG91YmxlUXVvdGVkU2NhbGFyKFxuICAgICAgICB0YWcsXG4gICAgICAgIGFuY2hvcixcbiAgICAgICAgZmxvd0luZGVudCxcbiAgICAgICk7XG4gICAgICBpZiAoZG91YmxlUXVvdGVTdGF0ZSkgcmV0dXJuIHRoaXMucmVzb2x2ZVRhZyhkb3VibGVRdW90ZVN0YXRlKTtcblxuICAgICAgY29uc3QgYWxpYXMgPSB0aGlzLnJlYWRBbGlhcygpO1xuICAgICAgaWYgKGFsaWFzKSB7XG4gICAgICAgIGlmICh0YWcgIT09IG51bGwgfHwgYW5jaG9yICE9PSBudWxsKSB7XG4gICAgICAgICAgdGhyb3cgdGhpcy4jY3JlYXRlRXJyb3IoXG4gICAgICAgICAgICBcIkNhbm5vdCBjb21wb3NlIG5vZGU6IGFsaWFzIG5vZGUgc2hvdWxkIG5vdCBoYXZlIGFueSBwcm9wZXJ0aWVzXCIsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdGhpcy5yZXNvbHZlVGFnKHsgdGFnLCBhbmNob3IsIGtpbmQ6IG51bGwsIHJlc3VsdDogYWxpYXMgfSk7XG4gICAgICB9XG4gICAgICBjb25zdCBwbGFpblNjYWxhclN0YXRlID0gdGhpcy5yZWFkUGxhaW5TY2FsYXIoXG4gICAgICAgIHRhZyxcbiAgICAgICAgYW5jaG9yLFxuICAgICAgICBmbG93SW5kZW50LFxuICAgICAgICBDT05URVhUX0ZMT1dfSU4gPT09IG5vZGVDb250ZXh0LFxuICAgICAgKTtcbiAgICAgIGlmIChwbGFpblNjYWxhclN0YXRlKSB7XG4gICAgICAgIHBsYWluU2NhbGFyU3RhdGUudGFnID8/PSBcIj9cIjtcbiAgICAgICAgcmV0dXJuIHRoaXMucmVzb2x2ZVRhZyhwbGFpblNjYWxhclN0YXRlKTtcbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKFxuICAgICAgaW5kZW50U3RhdHVzID09PSAwICYmXG4gICAgICBDT05URVhUX0JMT0NLX09VVCA9PT0gbm9kZUNvbnRleHQgJiZcbiAgICAgIGFsbG93QmxvY2tDb2xsZWN0aW9uc1xuICAgICkge1xuICAgICAgLy8gU3BlY2lhbCBjYXNlOiBibG9jayBzZXF1ZW5jZXMgYXJlIGFsbG93ZWQgdG8gaGF2ZSBzYW1lIGluZGVudGF0aW9uIGxldmVsIGFzIHRoZSBwYXJlbnQuXG4gICAgICAvLyBodHRwOi8vd3d3LnlhbWwub3JnL3NwZWMvMS4yL3NwZWMuaHRtbCNpZDI3OTk3ODRcbiAgICAgIGNvbnN0IGJsb2NrSW5kZW50ID0gdGhpcy4jc2Nhbm5lci5wb3NpdGlvbiAtIHRoaXMubGluZVN0YXJ0O1xuICAgICAgY29uc3QgbmV3U3RhdGUgPSB0aGlzLnJlYWRCbG9ja1NlcXVlbmNlKHRhZywgYW5jaG9yLCBibG9ja0luZGVudCk7XG4gICAgICBpZiAobmV3U3RhdGUpIHJldHVybiB0aGlzLnJlc29sdmVUYWcobmV3U3RhdGUpO1xuICAgIH1cblxuICAgIGNvbnN0IG5ld1N0YXRlID0gdGhpcy5yZXNvbHZlVGFnKHsgdGFnLCBhbmNob3IsIGtpbmQ6IG51bGwsIHJlc3VsdDogbnVsbCB9KTtcbiAgICBpZiAobmV3U3RhdGUudGFnICE9PSBudWxsIHx8IG5ld1N0YXRlLmFuY2hvciAhPT0gbnVsbCkgcmV0dXJuIG5ld1N0YXRlO1xuICB9XG5cbiAgcmVhZERpcmVjdGl2ZXMoKSB7XG4gICAgbGV0IGhhc0RpcmVjdGl2ZXMgPSBmYWxzZTtcbiAgICBsZXQgdmVyc2lvbiA9IG51bGw7XG5cbiAgICBsZXQgY2ggPSB0aGlzLiNzY2FubmVyLnBlZWsoKTtcbiAgICB3aGlsZSAoY2ggIT09IDApIHtcbiAgICAgIHRoaXMuc2tpcFNlcGFyYXRpb25TcGFjZSh0cnVlLCAtMSk7XG5cbiAgICAgIGNoID0gdGhpcy4jc2Nhbm5lci5wZWVrKCk7XG5cbiAgICAgIGlmICh0aGlzLmxpbmVJbmRlbnQgPiAwIHx8IGNoICE9PSBQRVJDRU5UKSB7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuXG4gICAgICBoYXNEaXJlY3RpdmVzID0gdHJ1ZTtcbiAgICAgIHRoaXMuI3NjYW5uZXIubmV4dCgpO1xuICAgICAgY2ggPSB0aGlzLiNzY2FubmVyLnBlZWsoKTtcbiAgICAgIGxldCBwb3NpdGlvbiA9IHRoaXMuI3NjYW5uZXIucG9zaXRpb247XG5cbiAgICAgIHdoaWxlIChjaCAhPT0gMCAmJiAhaXNXaGl0ZVNwYWNlT3JFT0woY2gpKSB7XG4gICAgICAgIHRoaXMuI3NjYW5uZXIubmV4dCgpO1xuICAgICAgICBjaCA9IHRoaXMuI3NjYW5uZXIucGVlaygpO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBkaXJlY3RpdmVOYW1lID0gdGhpcy4jc2Nhbm5lci5zb3VyY2Uuc2xpY2UoXG4gICAgICAgIHBvc2l0aW9uLFxuICAgICAgICB0aGlzLiNzY2FubmVyLnBvc2l0aW9uLFxuICAgICAgKTtcbiAgICAgIGNvbnN0IGRpcmVjdGl2ZUFyZ3MgPSBbXTtcblxuICAgICAgaWYgKGRpcmVjdGl2ZU5hbWUubGVuZ3RoIDwgMSkge1xuICAgICAgICB0aHJvdyB0aGlzLiNjcmVhdGVFcnJvcihcbiAgICAgICAgICBcIkNhbm5vdCByZWFkIGRvY3VtZW50OiBkaXJlY3RpdmUgbmFtZSBsZW5ndGggbXVzdCBiZSBncmVhdGVyIHRoYW4gemVyb1wiLFxuICAgICAgICApO1xuICAgICAgfVxuXG4gICAgICB3aGlsZSAoY2ggIT09IDApIHtcbiAgICAgICAgdGhpcy5za2lwV2hpdGVzcGFjZXMoKTtcbiAgICAgICAgdGhpcy5za2lwQ29tbWVudCgpO1xuICAgICAgICBjaCA9IHRoaXMuI3NjYW5uZXIucGVlaygpO1xuXG4gICAgICAgIGlmIChpc0VPTChjaCkpIGJyZWFrO1xuXG4gICAgICAgIHBvc2l0aW9uID0gdGhpcy4jc2Nhbm5lci5wb3NpdGlvbjtcblxuICAgICAgICB3aGlsZSAoY2ggIT09IDAgJiYgIWlzV2hpdGVTcGFjZU9yRU9MKGNoKSkge1xuICAgICAgICAgIHRoaXMuI3NjYW5uZXIubmV4dCgpO1xuICAgICAgICAgIGNoID0gdGhpcy4jc2Nhbm5lci5wZWVrKCk7XG4gICAgICAgIH1cblxuICAgICAgICBkaXJlY3RpdmVBcmdzLnB1c2goXG4gICAgICAgICAgdGhpcy4jc2Nhbm5lci5zb3VyY2Uuc2xpY2UocG9zaXRpb24sIHRoaXMuI3NjYW5uZXIucG9zaXRpb24pLFxuICAgICAgICApO1xuICAgICAgfVxuXG4gICAgICBpZiAoY2ggIT09IDApIHRoaXMucmVhZExpbmVCcmVhaygpO1xuXG4gICAgICBzd2l0Y2ggKGRpcmVjdGl2ZU5hbWUpIHtcbiAgICAgICAgY2FzZSBcIllBTUxcIjpcbiAgICAgICAgICBpZiAodmVyc2lvbiAhPT0gbnVsbCkge1xuICAgICAgICAgICAgdGhyb3cgdGhpcy4jY3JlYXRlRXJyb3IoXG4gICAgICAgICAgICAgIFwiQ2Fubm90IGhhbmRsZSBZQU1MIGRpcmVjdGl2ZTogZHVwbGljYXRpb24gb2YgJVlBTUwgZGlyZWN0aXZlXCIsXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgICB2ZXJzaW9uID0gdGhpcy55YW1sRGlyZWN0aXZlSGFuZGxlcihkaXJlY3RpdmVBcmdzKTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSBcIlRBR1wiOlxuICAgICAgICAgIHRoaXMudGFnRGlyZWN0aXZlSGFuZGxlcihkaXJlY3RpdmVBcmdzKTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICB0aGlzLmRpc3BhdGNoV2FybmluZyhgdW5rbm93biBkb2N1bWVudCBkaXJlY3RpdmUgXCIke2RpcmVjdGl2ZU5hbWV9XCJgKTtcbiAgICAgICAgICBicmVhaztcbiAgICAgIH1cblxuICAgICAgY2ggPSB0aGlzLiNzY2FubmVyLnBlZWsoKTtcbiAgICB9XG4gICAgcmV0dXJuIGhhc0RpcmVjdGl2ZXM7XG4gIH1cblxuICByZWFkRG9jdW1lbnQoKSB7XG4gICAgY29uc3QgZG9jdW1lbnRTdGFydCA9IHRoaXMuI3NjYW5uZXIucG9zaXRpb247XG5cbiAgICB0aGlzLmNoZWNrTGluZUJyZWFrcyA9IGZhbHNlO1xuICAgIHRoaXMudGFnTWFwID0gbmV3IE1hcCgpO1xuICAgIHRoaXMuYW5jaG9yTWFwID0gbmV3IE1hcCgpO1xuXG4gICAgY29uc3QgaGFzRGlyZWN0aXZlcyA9IHRoaXMucmVhZERpcmVjdGl2ZXMoKTtcblxuICAgIHRoaXMuc2tpcFNlcGFyYXRpb25TcGFjZSh0cnVlLCAtMSk7XG5cbiAgICBsZXQgcmVzdWx0ID0gbnVsbDtcblxuICAgIGlmIChcbiAgICAgIHRoaXMubGluZUluZGVudCA9PT0gMCAmJlxuICAgICAgdGhpcy4jc2Nhbm5lci5wZWVrKCkgPT09IE1JTlVTICYmXG4gICAgICB0aGlzLiNzY2FubmVyLnBlZWsoMSkgPT09IE1JTlVTICYmXG4gICAgICB0aGlzLiNzY2FubmVyLnBlZWsoMikgPT09IE1JTlVTXG4gICAgKSB7XG4gICAgICB0aGlzLiNzY2FubmVyLnBvc2l0aW9uICs9IDM7XG4gICAgICB0aGlzLnNraXBTZXBhcmF0aW9uU3BhY2UodHJ1ZSwgLTEpO1xuICAgIH0gZWxzZSBpZiAoaGFzRGlyZWN0aXZlcykge1xuICAgICAgdGhyb3cgdGhpcy4jY3JlYXRlRXJyb3IoXG4gICAgICAgIFwiQ2Fubm90IHJlYWQgZG9jdW1lbnQ6IGRpcmVjdGl2ZXMgZW5kIG1hcmsgaXMgZXhwZWN0ZWRcIixcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3QgbmV3U3RhdGUgPSB0aGlzLmNvbXBvc2VOb2RlKHtcbiAgICAgIHBhcmVudEluZGVudDogdGhpcy5saW5lSW5kZW50IC0gMSxcbiAgICAgIG5vZGVDb250ZXh0OiBDT05URVhUX0JMT0NLX09VVCxcbiAgICAgIGFsbG93VG9TZWVrOiBmYWxzZSxcbiAgICAgIGFsbG93Q29tcGFjdDogdHJ1ZSxcbiAgICB9KTtcbiAgICBpZiAobmV3U3RhdGUpIHJlc3VsdCA9IG5ld1N0YXRlLnJlc3VsdDtcbiAgICB0aGlzLnNraXBTZXBhcmF0aW9uU3BhY2UodHJ1ZSwgLTEpO1xuXG4gICAgaWYgKFxuICAgICAgdGhpcy5jaGVja0xpbmVCcmVha3MgJiZcbiAgICAgIFBBVFRFUk5fTk9OX0FTQ0lJX0xJTkVfQlJFQUtTLnRlc3QoXG4gICAgICAgIHRoaXMuI3NjYW5uZXIuc291cmNlLnNsaWNlKGRvY3VtZW50U3RhcnQsIHRoaXMuI3NjYW5uZXIucG9zaXRpb24pLFxuICAgICAgKVxuICAgICkge1xuICAgICAgdGhpcy5kaXNwYXRjaFdhcm5pbmcoXCJub24tQVNDSUkgbGluZSBicmVha3MgYXJlIGludGVycHJldGVkIGFzIGNvbnRlbnRcIik7XG4gICAgfVxuXG4gICAgaWYgKFxuICAgICAgdGhpcy4jc2Nhbm5lci5wb3NpdGlvbiA9PT0gdGhpcy5saW5lU3RhcnQgJiYgdGhpcy50ZXN0RG9jdW1lbnRTZXBhcmF0b3IoKVxuICAgICkge1xuICAgICAgaWYgKHRoaXMuI3NjYW5uZXIucGVlaygpID09PSBET1QpIHtcbiAgICAgICAgdGhpcy4jc2Nhbm5lci5wb3NpdGlvbiArPSAzO1xuICAgICAgICB0aGlzLnNraXBTZXBhcmF0aW9uU3BhY2UodHJ1ZSwgLTEpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAoIXRoaXMuI3NjYW5uZXIuZW9mKCkpIHtcbiAgICAgIHRocm93IHRoaXMuI2NyZWF0ZUVycm9yKFxuICAgICAgICBcIkNhbm5vdCByZWFkIGRvY3VtZW50OiBlbmQgb2YgdGhlIHN0cmVhbSBvciBhIGRvY3VtZW50IHNlcGFyYXRvciBpcyBleHBlY3RlZFwiLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG5cbiAgKnJlYWREb2N1bWVudHMoKSB7XG4gICAgd2hpbGUgKCF0aGlzLiNzY2FubmVyLmVvZigpKSB7XG4gICAgICB5aWVsZCB0aGlzLnJlYWREb2N1bWVudCgpO1xuICAgIH1cbiAgfVxufVxuIl0sIm5hbWVz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
// denoCacheMetadata=16656319402661942134,12106265377332131144