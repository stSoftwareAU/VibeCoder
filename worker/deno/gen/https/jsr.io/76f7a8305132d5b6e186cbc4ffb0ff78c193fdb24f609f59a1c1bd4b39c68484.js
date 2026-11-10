// Copyright 2018-2025 the Deno authors. MIT license.
// This module is browser compatible.
import { diff } from "./diff.ts";
/**
 * Unescape invisible characters.
 *
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String#escape_sequences}
 *
 * @param string String to unescape.
 *
 * @returns Unescaped string.
 *
 * @example Usage
 * ```ts
 * import { unescape } from "@std/internal/diff-str";
 * import { assertEquals } from "@std/assert";
 *
 * assertEquals(unescape("Hello\nWorld"), "Hello\\n\nWorld");
 * ```
 */ export function unescape(string) {
  return string.replaceAll("\\", "\\\\").replaceAll("\b", "\\b").replaceAll("\f", "\\f").replaceAll("\t", "\\t").replaceAll("\v", "\\v")// This does not remove line breaks
  .replaceAll(/\r\n|\r|\n/g, (str)=>str === "\r" ? "\\r" : str === "\n" ? "\\n\n" : "\\r\\n\r\n");
}
const WHITESPACE_SYMBOLS = /((?:\\[bftv]|[^\S\r\n])+|\\[rn\\]|[()[\]{}'"\r\n]|\b)/;
/**
 * Tokenizes a string into an array of tokens.
 *
 * @param string The string to tokenize.
 * @param wordDiff If true, performs word-based tokenization. Default is false.
 *
 * @returns An array of tokens.
 *
 * @example Usage
 * ```ts
 * import { tokenize } from "@std/internal/diff-str";
 * import { assertEquals } from "@std/assert";
 *
 * assertEquals(tokenize("Hello\nWorld"), ["Hello\n", "World"]);
 * ```
 */ export function tokenize(string, wordDiff = false) {
  if (wordDiff) {
    return string.split(WHITESPACE_SYMBOLS).filter((token)=>token);
  }
  const tokens = [];
  const lines = string.split(/(\n|\r\n)/).filter((line)=>line);
  for (const [i, line] of lines.entries()){
    if (i % 2) {
      tokens[tokens.length - 1] += line;
    } else {
      tokens.push(line);
    }
  }
  return tokens;
}
/**
 * Create details by filtering relevant word-diff for current line and merge
 * "space-diff" if surrounded by word-diff for cleaner displays.
 *
 * @param line Current line
 * @param tokens Word-diff tokens
 *
 * @returns Array of diff results.
 *
 * @example Usage
 * ```ts
 * import { createDetails } from "@std/internal/diff-str";
 * import { assertEquals } from "@std/assert";
 *
 * const tokens = [
 *   { type: "added", value: "a" },
 *   { type: "removed", value: "b" },
 *   { type: "common", value: "c" },
 * ] as const;
 * assertEquals(
 *   createDetails({ type: "added", value: "a" }, [...tokens]),
 *   [{ type: "added", value: "a" }, { type: "common", value: "c" }]
 * );
 * ```
 */ export function createDetails(line, tokens) {
  return tokens.filter(({ type })=>type === line.type || type === "common").map((result, i, t)=>{
    const token = t[i - 1];
    if (result.type === "common" && token && token.type === t[i + 1]?.type && /\s+/.test(result.value)) {
      return {
        ...result,
        type: token.type
      };
    }
    return result;
  });
}
const NON_WHITESPACE_REGEXP = /\S/;
/**
 * Renders the differences between the actual and expected strings. Partially
 * inspired from {@link https://github.com/kpdecker/jsdiff}.
 *
 * @param A Actual string
 * @param B Expected string
 *
 * @returns Array of diff results.
 *
 * @example Usage
 * ```ts
 * import { diffStr } from "@std/internal/diff-str";
 * import { assertEquals } from "@std/assert";
 *
 * assertEquals(diffStr("Hello!", "Hello"), [
 *   {
 *     type: "removed",
 *     value: "Hello!\n",
 *     details: [
 *       { type: "common", value: "Hello" },
 *       { type: "removed", value: "!" },
 *       { type: "common", value: "\n" }
 *     ]
 *   },
 *   {
 *     type: "added",
 *     value: "Hello\n",
 *     details: [
 *       { type: "common", value: "Hello" },
 *       { type: "common", value: "\n" }
 *     ]
 *   }
 * ]);
 * ```
 */ export function diffStr(A, B) {
  // Compute multi-line diff
  const diffResult = diff(tokenize(`${unescape(A)}\n`), tokenize(`${unescape(B)}\n`));
  const added = [];
  const removed = [];
  for (const result of diffResult){
    if (result.type === "added") {
      added.push(result);
    }
    if (result.type === "removed") {
      removed.push(result);
    }
  }
  // Compute word-diff
  const hasMoreRemovedLines = added.length < removed.length;
  const aLines = hasMoreRemovedLines ? added : removed;
  const bLines = hasMoreRemovedLines ? removed : added;
  for (const a of aLines){
    let tokens = [];
    let b;
    // Search another diff line with at least one common token
    while(bLines.length){
      b = bLines.shift();
      const tokenized = [
        tokenize(a.value, true),
        tokenize(b.value, true)
      ];
      if (hasMoreRemovedLines) tokenized.reverse();
      tokens = diff(tokenized[0], tokenized[1]);
      if (tokens.some(({ type, value })=>type === "common" && NON_WHITESPACE_REGEXP.test(value))) {
        break;
      }
    }
    // Register word-diff details
    a.details = createDetails(a, tokens);
    if (b) {
      b.details = createDetails(b, tokens);
    }
  }
  return diffResult;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvaW50ZXJuYWwvMS4wLjEyL2RpZmZfc3RyLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIENvcHlyaWdodCAyMDE4LTIwMjUgdGhlIERlbm8gYXV0aG9ycy4gTUlUIGxpY2Vuc2UuXG4vLyBUaGlzIG1vZHVsZSBpcyBicm93c2VyIGNvbXBhdGlibGUuXG5cbmltcG9ydCB0eXBlIHsgQ2hhbmdlZERpZmZSZXN1bHQsIERpZmZSZXN1bHQgfSBmcm9tIFwiLi90eXBlcy50c1wiO1xuaW1wb3J0IHsgZGlmZiB9IGZyb20gXCIuL2RpZmYudHNcIjtcblxuLyoqXG4gKiBVbmVzY2FwZSBpbnZpc2libGUgY2hhcmFjdGVycy5cbiAqXG4gKiBAc2VlIHtAbGluayBodHRwczovL2RldmVsb3Blci5tb3ppbGxhLm9yZy9lbi1VUy9kb2NzL1dlYi9KYXZhU2NyaXB0L1JlZmVyZW5jZS9HbG9iYWxfT2JqZWN0cy9TdHJpbmcjZXNjYXBlX3NlcXVlbmNlc31cbiAqXG4gKiBAcGFyYW0gc3RyaW5nIFN0cmluZyB0byB1bmVzY2FwZS5cbiAqXG4gKiBAcmV0dXJucyBVbmVzY2FwZWQgc3RyaW5nLlxuICpcbiAqIEBleGFtcGxlIFVzYWdlXG4gKiBgYGB0c1xuICogaW1wb3J0IHsgdW5lc2NhcGUgfSBmcm9tIFwiQHN0ZC9pbnRlcm5hbC9kaWZmLXN0clwiO1xuICogaW1wb3J0IHsgYXNzZXJ0RXF1YWxzIH0gZnJvbSBcIkBzdGQvYXNzZXJ0XCI7XG4gKlxuICogYXNzZXJ0RXF1YWxzKHVuZXNjYXBlKFwiSGVsbG9cXG5Xb3JsZFwiKSwgXCJIZWxsb1xcXFxuXFxuV29ybGRcIik7XG4gKiBgYGBcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHVuZXNjYXBlKHN0cmluZzogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHN0cmluZ1xuICAgIC5yZXBsYWNlQWxsKFwiXFxcXFwiLCBcIlxcXFxcXFxcXCIpXG4gICAgLnJlcGxhY2VBbGwoXCJcXGJcIiwgXCJcXFxcYlwiKVxuICAgIC5yZXBsYWNlQWxsKFwiXFxmXCIsIFwiXFxcXGZcIilcbiAgICAucmVwbGFjZUFsbChcIlxcdFwiLCBcIlxcXFx0XCIpXG4gICAgLnJlcGxhY2VBbGwoXCJcXHZcIiwgXCJcXFxcdlwiKVxuICAgIC8vIFRoaXMgZG9lcyBub3QgcmVtb3ZlIGxpbmUgYnJlYWtzXG4gICAgLnJlcGxhY2VBbGwoXG4gICAgICAvXFxyXFxufFxccnxcXG4vZyxcbiAgICAgIChzdHIpID0+IHN0ciA9PT0gXCJcXHJcIiA/IFwiXFxcXHJcIiA6IHN0ciA9PT0gXCJcXG5cIiA/IFwiXFxcXG5cXG5cIiA6IFwiXFxcXHJcXFxcblxcclxcblwiLFxuICAgICk7XG59XG5cbmNvbnN0IFdISVRFU1BBQ0VfU1lNQk9MUyA9XG4gIC8oKD86XFxcXFtiZnR2XXxbXlxcU1xcclxcbl0pK3xcXFxcW3JuXFxcXF18WygpW1xcXXt9J1wiXFxyXFxuXXxcXGIpLztcblxuLyoqXG4gKiBUb2tlbml6ZXMgYSBzdHJpbmcgaW50byBhbiBhcnJheSBvZiB0b2tlbnMuXG4gKlxuICogQHBhcmFtIHN0cmluZyBUaGUgc3RyaW5nIHRvIHRva2VuaXplLlxuICogQHBhcmFtIHdvcmREaWZmIElmIHRydWUsIHBlcmZvcm1zIHdvcmQtYmFzZWQgdG9rZW5pemF0aW9uLiBEZWZhdWx0IGlzIGZhbHNlLlxuICpcbiAqIEByZXR1cm5zIEFuIGFycmF5IG9mIHRva2Vucy5cbiAqXG4gKiBAZXhhbXBsZSBVc2FnZVxuICogYGBgdHNcbiAqIGltcG9ydCB7IHRva2VuaXplIH0gZnJvbSBcIkBzdGQvaW50ZXJuYWwvZGlmZi1zdHJcIjtcbiAqIGltcG9ydCB7IGFzc2VydEVxdWFscyB9IGZyb20gXCJAc3RkL2Fzc2VydFwiO1xuICpcbiAqIGFzc2VydEVxdWFscyh0b2tlbml6ZShcIkhlbGxvXFxuV29ybGRcIiksIFtcIkhlbGxvXFxuXCIsIFwiV29ybGRcIl0pO1xuICogYGBgXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0b2tlbml6ZShzdHJpbmc6IHN0cmluZywgd29yZERpZmYgPSBmYWxzZSk6IHN0cmluZ1tdIHtcbiAgaWYgKHdvcmREaWZmKSB7XG4gICAgcmV0dXJuIHN0cmluZ1xuICAgICAgLnNwbGl0KFdISVRFU1BBQ0VfU1lNQk9MUylcbiAgICAgIC5maWx0ZXIoKHRva2VuKSA9PiB0b2tlbik7XG4gIH1cbiAgY29uc3QgdG9rZW5zOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBsaW5lcyA9IHN0cmluZy5zcGxpdCgvKFxcbnxcXHJcXG4pLykuZmlsdGVyKChsaW5lKSA9PiBsaW5lKTtcblxuICBmb3IgKGNvbnN0IFtpLCBsaW5lXSBvZiBsaW5lcy5lbnRyaWVzKCkpIHtcbiAgICBpZiAoaSAlIDIpIHtcbiAgICAgIHRva2Vuc1t0b2tlbnMubGVuZ3RoIC0gMV0gKz0gbGluZTtcbiAgICB9IGVsc2Uge1xuICAgICAgdG9rZW5zLnB1c2gobGluZSk7XG4gICAgfVxuICB9XG4gIHJldHVybiB0b2tlbnM7XG59XG5cbi8qKlxuICogQ3JlYXRlIGRldGFpbHMgYnkgZmlsdGVyaW5nIHJlbGV2YW50IHdvcmQtZGlmZiBmb3IgY3VycmVudCBsaW5lIGFuZCBtZXJnZVxuICogXCJzcGFjZS1kaWZmXCIgaWYgc3Vycm91bmRlZCBieSB3b3JkLWRpZmYgZm9yIGNsZWFuZXIgZGlzcGxheXMuXG4gKlxuICogQHBhcmFtIGxpbmUgQ3VycmVudCBsaW5lXG4gKiBAcGFyYW0gdG9rZW5zIFdvcmQtZGlmZiB0b2tlbnNcbiAqXG4gKiBAcmV0dXJucyBBcnJheSBvZiBkaWZmIHJlc3VsdHMuXG4gKlxuICogQGV4YW1wbGUgVXNhZ2VcbiAqIGBgYHRzXG4gKiBpbXBvcnQgeyBjcmVhdGVEZXRhaWxzIH0gZnJvbSBcIkBzdGQvaW50ZXJuYWwvZGlmZi1zdHJcIjtcbiAqIGltcG9ydCB7IGFzc2VydEVxdWFscyB9IGZyb20gXCJAc3RkL2Fzc2VydFwiO1xuICpcbiAqIGNvbnN0IHRva2VucyA9IFtcbiAqICAgeyB0eXBlOiBcImFkZGVkXCIsIHZhbHVlOiBcImFcIiB9LFxuICogICB7IHR5cGU6IFwicmVtb3ZlZFwiLCB2YWx1ZTogXCJiXCIgfSxcbiAqICAgeyB0eXBlOiBcImNvbW1vblwiLCB2YWx1ZTogXCJjXCIgfSxcbiAqIF0gYXMgY29uc3Q7XG4gKiBhc3NlcnRFcXVhbHMoXG4gKiAgIGNyZWF0ZURldGFpbHMoeyB0eXBlOiBcImFkZGVkXCIsIHZhbHVlOiBcImFcIiB9LCBbLi4udG9rZW5zXSksXG4gKiAgIFt7IHR5cGU6IFwiYWRkZWRcIiwgdmFsdWU6IFwiYVwiIH0sIHsgdHlwZTogXCJjb21tb25cIiwgdmFsdWU6IFwiY1wiIH1dXG4gKiApO1xuICogYGBgXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVEZXRhaWxzKFxuICBsaW5lOiBEaWZmUmVzdWx0PHN0cmluZz4sXG4gIHRva2VuczogRGlmZlJlc3VsdDxzdHJpbmc+W10sXG4pOiBEaWZmUmVzdWx0PHN0cmluZz5bXSB7XG4gIHJldHVybiB0b2tlbnMuZmlsdGVyKCh7IHR5cGUgfSkgPT4gdHlwZSA9PT0gbGluZS50eXBlIHx8IHR5cGUgPT09IFwiY29tbW9uXCIpXG4gICAgLm1hcCgocmVzdWx0LCBpLCB0KSA9PiB7XG4gICAgICBjb25zdCB0b2tlbiA9IHRbaSAtIDFdO1xuICAgICAgaWYgKFxuICAgICAgICAocmVzdWx0LnR5cGUgPT09IFwiY29tbW9uXCIpICYmIHRva2VuICYmXG4gICAgICAgICh0b2tlbi50eXBlID09PSB0W2kgKyAxXT8udHlwZSkgJiYgL1xccysvLnRlc3QocmVzdWx0LnZhbHVlKVxuICAgICAgKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgLi4ucmVzdWx0LFxuICAgICAgICAgIHR5cGU6IHRva2VuLnR5cGUsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH0pO1xufVxuXG5jb25zdCBOT05fV0hJVEVTUEFDRV9SRUdFWFAgPSAvXFxTLztcblxuLyoqXG4gKiBSZW5kZXJzIHRoZSBkaWZmZXJlbmNlcyBiZXR3ZWVuIHRoZSBhY3R1YWwgYW5kIGV4cGVjdGVkIHN0cmluZ3MuIFBhcnRpYWxseVxuICogaW5zcGlyZWQgZnJvbSB7QGxpbmsgaHR0cHM6Ly9naXRodWIuY29tL2twZGVja2VyL2pzZGlmZn0uXG4gKlxuICogQHBhcmFtIEEgQWN0dWFsIHN0cmluZ1xuICogQHBhcmFtIEIgRXhwZWN0ZWQgc3RyaW5nXG4gKlxuICogQHJldHVybnMgQXJyYXkgb2YgZGlmZiByZXN1bHRzLlxuICpcbiAqIEBleGFtcGxlIFVzYWdlXG4gKiBgYGB0c1xuICogaW1wb3J0IHsgZGlmZlN0ciB9IGZyb20gXCJAc3RkL2ludGVybmFsL2RpZmYtc3RyXCI7XG4gKiBpbXBvcnQgeyBhc3NlcnRFcXVhbHMgfSBmcm9tIFwiQHN0ZC9hc3NlcnRcIjtcbiAqXG4gKiBhc3NlcnRFcXVhbHMoZGlmZlN0cihcIkhlbGxvIVwiLCBcIkhlbGxvXCIpLCBbXG4gKiAgIHtcbiAqICAgICB0eXBlOiBcInJlbW92ZWRcIixcbiAqICAgICB2YWx1ZTogXCJIZWxsbyFcXG5cIixcbiAqICAgICBkZXRhaWxzOiBbXG4gKiAgICAgICB7IHR5cGU6IFwiY29tbW9uXCIsIHZhbHVlOiBcIkhlbGxvXCIgfSxcbiAqICAgICAgIHsgdHlwZTogXCJyZW1vdmVkXCIsIHZhbHVlOiBcIiFcIiB9LFxuICogICAgICAgeyB0eXBlOiBcImNvbW1vblwiLCB2YWx1ZTogXCJcXG5cIiB9XG4gKiAgICAgXVxuICogICB9LFxuICogICB7XG4gKiAgICAgdHlwZTogXCJhZGRlZFwiLFxuICogICAgIHZhbHVlOiBcIkhlbGxvXFxuXCIsXG4gKiAgICAgZGV0YWlsczogW1xuICogICAgICAgeyB0eXBlOiBcImNvbW1vblwiLCB2YWx1ZTogXCJIZWxsb1wiIH0sXG4gKiAgICAgICB7IHR5cGU6IFwiY29tbW9uXCIsIHZhbHVlOiBcIlxcblwiIH1cbiAqICAgICBdXG4gKiAgIH1cbiAqIF0pO1xuICogYGBgXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkaWZmU3RyKEE6IHN0cmluZywgQjogc3RyaW5nKTogRGlmZlJlc3VsdDxzdHJpbmc+W10ge1xuICAvLyBDb21wdXRlIG11bHRpLWxpbmUgZGlmZlxuICBjb25zdCBkaWZmUmVzdWx0ID0gZGlmZihcbiAgICB0b2tlbml6ZShgJHt1bmVzY2FwZShBKX1cXG5gKSxcbiAgICB0b2tlbml6ZShgJHt1bmVzY2FwZShCKX1cXG5gKSxcbiAgKTtcblxuICBjb25zdCBhZGRlZCA9IFtdO1xuICBjb25zdCByZW1vdmVkID0gW107XG4gIGZvciAoY29uc3QgcmVzdWx0IG9mIGRpZmZSZXN1bHQpIHtcbiAgICBpZiAocmVzdWx0LnR5cGUgPT09IFwiYWRkZWRcIikge1xuICAgICAgYWRkZWQucHVzaChyZXN1bHQpO1xuICAgIH1cbiAgICBpZiAocmVzdWx0LnR5cGUgPT09IFwicmVtb3ZlZFwiKSB7XG4gICAgICByZW1vdmVkLnB1c2gocmVzdWx0KTtcbiAgICB9XG4gIH1cblxuICAvLyBDb21wdXRlIHdvcmQtZGlmZlxuICBjb25zdCBoYXNNb3JlUmVtb3ZlZExpbmVzID0gYWRkZWQubGVuZ3RoIDwgcmVtb3ZlZC5sZW5ndGg7XG4gIGNvbnN0IGFMaW5lcyA9IGhhc01vcmVSZW1vdmVkTGluZXMgPyBhZGRlZCA6IHJlbW92ZWQ7XG4gIGNvbnN0IGJMaW5lcyA9IGhhc01vcmVSZW1vdmVkTGluZXMgPyByZW1vdmVkIDogYWRkZWQ7XG4gIGZvciAoY29uc3QgYSBvZiBhTGluZXMpIHtcbiAgICBsZXQgdG9rZW5zID0gW10gYXMgQXJyYXk8RGlmZlJlc3VsdDxzdHJpbmc+PjtcbiAgICBsZXQgYjogdW5kZWZpbmVkIHwgQ2hhbmdlZERpZmZSZXN1bHQ8c3RyaW5nPjtcbiAgICAvLyBTZWFyY2ggYW5vdGhlciBkaWZmIGxpbmUgd2l0aCBhdCBsZWFzdCBvbmUgY29tbW9uIHRva2VuXG4gICAgd2hpbGUgKGJMaW5lcy5sZW5ndGgpIHtcbiAgICAgIGIgPSBiTGluZXMuc2hpZnQoKTtcbiAgICAgIGNvbnN0IHRva2VuaXplZCA9IFtcbiAgICAgICAgdG9rZW5pemUoYS52YWx1ZSwgdHJ1ZSksXG4gICAgICAgIHRva2VuaXplKGIhLnZhbHVlLCB0cnVlKSxcbiAgICAgIF0gYXMgW3N0cmluZ1tdLCBzdHJpbmdbXV07XG4gICAgICBpZiAoaGFzTW9yZVJlbW92ZWRMaW5lcykgdG9rZW5pemVkLnJldmVyc2UoKTtcbiAgICAgIHRva2VucyA9IGRpZmYodG9rZW5pemVkWzBdLCB0b2tlbml6ZWRbMV0pO1xuICAgICAgaWYgKFxuICAgICAgICB0b2tlbnMuc29tZSgoeyB0eXBlLCB2YWx1ZSB9KSA9PlxuICAgICAgICAgIHR5cGUgPT09IFwiY29tbW9uXCIgJiYgTk9OX1dISVRFU1BBQ0VfUkVHRVhQLnRlc3QodmFsdWUpXG4gICAgICAgIClcbiAgICAgICkge1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG4gICAgLy8gUmVnaXN0ZXIgd29yZC1kaWZmIGRldGFpbHNcbiAgICBhLmRldGFpbHMgPSBjcmVhdGVEZXRhaWxzKGEsIHRva2Vucyk7XG4gICAgaWYgKGIpIHtcbiAgICAgIGIuZGV0YWlscyA9IGNyZWF0ZURldGFpbHMoYiwgdG9rZW5zKTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gZGlmZlJlc3VsdDtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxREFBcUQ7QUFDckQscUNBQXFDO0FBR3JDLFNBQVMsSUFBSSxRQUFRLFlBQVk7QUFFakM7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FnQkMsR0FDRCxPQUFPLFNBQVMsU0FBUyxNQUFjO0VBQ3JDLE9BQU8sT0FDSixVQUFVLENBQUMsTUFBTSxRQUNqQixVQUFVLENBQUMsTUFBTSxPQUNqQixVQUFVLENBQUMsTUFBTSxPQUNqQixVQUFVLENBQUMsTUFBTSxPQUNqQixVQUFVLENBQUMsTUFBTSxNQUNsQixtQ0FBbUM7R0FDbEMsVUFBVSxDQUNULGVBQ0EsQ0FBQyxNQUFRLFFBQVEsT0FBTyxRQUFRLFFBQVEsT0FBTyxVQUFVO0FBRS9EO0FBRUEsTUFBTSxxQkFDSjtB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
// denoCacheMetadata=13584883292248902938,12927379164884447497