// Copyright 2018-2025 the Deno authors. MIT license.
// This module is browser compatible.
// A module to print ANSI terminal colors. Inspired by chalk, kleur, and colors
// on npm.
// This code is vendored from `fmt/colors.ts`.
// deno-lint-ignore no-explicit-any
const { Deno } = globalThis;
const noColor = typeof Deno?.noColor === "boolean" ? Deno.noColor : false;
const enabled = !noColor;
function code(open, close) {
  return {
    open: `\x1b[${open.join(";")}m`,
    close: `\x1b[${close}m`,
    regexp: new RegExp(`\\x1b\\[${close}m`, "g")
  };
}
function run(str, code) {
  return enabled ? `${code.open}${str.replace(code.regexp, code.open)}${code.close}` : str;
}
/**
 * Sets the style of text to be printed to bold.
 *
 * Disable by setting the `NO_COLOR` environmental variable.
 *
 * @param str Text to make bold
 *
 * @returns Bold text for printing
 *
 * @example Usage
 * ```ts no-assert
 * import { bold } from "@std/internal/styles";
 *
 * console.log(bold("Hello, world!")); // Prints "Hello, world!" in bold
 * ```
 */ export function bold(str) {
  return run(str, code([
    1
  ], 22));
}
/**
 * Sets the color of text to be printed to red.
 *
 * Disable by setting the `NO_COLOR` environmental variable.
 *
 * @param str Text to make red
 *
 * @returns Red text for printing
 *
 * @example Usage
 * ```ts no-assert
 * import { red } from "@std/internal/styles";
 *
 * console.log(red("Hello, world!")); // Prints "Hello, world!" in red
 * ```
 */ export function red(str) {
  return run(str, code([
    31
  ], 39));
}
/**
 * Sets the color of text to be printed to green.
 *
 * Disable by setting the `NO_COLOR` environmental variable.
 *
 * @param str Text to make green
 *
 * @returns Green text for print
 *
 * @example Usage
 * ```ts no-assert
 * import { green } from "@std/internal/styles";
 *
 * console.log(green("Hello, world!")); // Prints "Hello, world!" in green
 * ```
 */ export function green(str) {
  return run(str, code([
    32
  ], 39));
}
/**
 * Sets the color of text to be printed to yellow.
 *
 * Disable by setting the `NO_COLOR` environmental variable.
 *
 * @param str Text to make yellow
 *
 * @returns Yellow text for print
 *
 * @example Usage
 * ```ts no-assert
 * import { yellow } from "@std/internal/styles";
 *
 * console.log(yellow("Hello, world!")); // Prints "Hello, world!" in yellow
 * ```
 */ export function yellow(str) {
  return run(str, code([
    33
  ], 39));
}
/**
 * Sets the color of text to be printed to white.
 *
 * @param str Text to make white
 *
 * @returns White text for print
 *
 * @example Usage
 * ```ts no-assert
 * import { white } from "@std/internal/styles";
 *
 * console.log(white("Hello, world!")); // Prints "Hello, world!" in white
 * ```
 */ export function white(str) {
  return run(str, code([
    37
  ], 39));
}
/**
 * Sets the color of text to be printed to gray.
 *
 * @param str Text to make gray
 *
 * @returns Gray text for print
 *
 * @example Usage
 * ```ts no-assert
 * import { gray } from "@std/internal/styles";
 *
 * console.log(gray("Hello, world!")); // Prints "Hello, world!" in gray
 * ```
 */ export function gray(str) {
  return brightBlack(str);
}
/**
 * Sets the color of text to be printed to bright-black.
 *
 * @param str Text to make bright-black
 *
 * @returns Bright-black text for print
 *
 * @example Usage
 * ```ts no-assert
 * import { brightBlack } from "@std/internal/styles";
 *
 * console.log(brightBlack("Hello, world!")); // Prints "Hello, world!" in bright-black
 * ```
 */ export function brightBlack(str) {
  return run(str, code([
    90
  ], 39));
}
/**
 * Sets the background color of text to be printed to red.
 *
 * @param str Text to make its background red
 *
 * @returns Red background text for print
 *
 * @example Usage
 * ```ts no-assert
 * import { bgRed } from "@std/internal/styles";
 *
 * console.log(bgRed("Hello, world!")); // Prints "Hello, world!" with red background
 * ```
 */ export function bgRed(str) {
  return run(str, code([
    41
  ], 49));
}
/**
 * Sets the background color of text to be printed to green.
 *
 * @param str Text to make its background green
 *
 * @returns Green background text for print
 *
 * @example Usage
 * ```ts no-assert
 * import { bgGreen } from "@std/internal/styles";
 *
 * console.log(bgGreen("Hello, world!")); // Prints "Hello, world!" with green background
 * ```
 */ export function bgGreen(str) {
  return run(str, code([
    42
  ], 49));
}
// https://github.com/chalk/ansi-regex/blob/02fa893d619d3da85411acc8fd4e2eea0e95a9d9/index.js
const ANSI_PATTERN = new RegExp([
  "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)",
  "(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TXZcf-nq-uy=><~]))"
].join("|"), "g");
/**
 * Remove ANSI escape codes from the string.
 *
 * @param string Text to remove ANSI escape codes from
 *
 * @returns Text without ANSI escape codes
 *
 * @example Usage
 * ```ts no-assert
 * import { red, stripAnsiCode } from "@std/internal/styles";
 *
 * console.log(stripAnsiCode(red("Hello, world!"))); // Prints "Hello, world!"
 * ```
 */ export function stripAnsiCode(string) {
  return string.replace(ANSI_PATTERN, "");
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvaW50ZXJuYWwvMS4wLjEyL3N0eWxlcy50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBDb3B5cmlnaHQgMjAxOC0yMDI1IHRoZSBEZW5vIGF1dGhvcnMuIE1JVCBsaWNlbnNlLlxuLy8gVGhpcyBtb2R1bGUgaXMgYnJvd3NlciBjb21wYXRpYmxlLlxuLy8gQSBtb2R1bGUgdG8gcHJpbnQgQU5TSSB0ZXJtaW5hbCBjb2xvcnMuIEluc3BpcmVkIGJ5IGNoYWxrLCBrbGV1ciwgYW5kIGNvbG9yc1xuLy8gb24gbnBtLlxuXG4vLyBUaGlzIGNvZGUgaXMgdmVuZG9yZWQgZnJvbSBgZm10L2NvbG9ycy50c2AuXG5cbi8vIGRlbm8tbGludC1pZ25vcmUgbm8tZXhwbGljaXQtYW55XG5jb25zdCB7IERlbm8gfSA9IGdsb2JhbFRoaXMgYXMgYW55O1xuY29uc3Qgbm9Db2xvciA9IHR5cGVvZiBEZW5vPy5ub0NvbG9yID09PSBcImJvb2xlYW5cIlxuICA/IERlbm8ubm9Db2xvciBhcyBib29sZWFuXG4gIDogZmFsc2U7XG5cbmludGVyZmFjZSBDb2RlIHtcbiAgb3Blbjogc3RyaW5nO1xuICBjbG9zZTogc3RyaW5nO1xuICByZWdleHA6IFJlZ0V4cDtcbn1cblxuY29uc3QgZW5hYmxlZCA9ICFub0NvbG9yO1xuXG5mdW5jdGlvbiBjb2RlKG9wZW46IG51bWJlcltdLCBjbG9zZTogbnVtYmVyKTogQ29kZSB7XG4gIHJldHVybiB7XG4gICAgb3BlbjogYFxceDFiWyR7b3Blbi5qb2luKFwiO1wiKX1tYCxcbiAgICBjbG9zZTogYFxceDFiWyR7Y2xvc2V9bWAsXG4gICAgcmVnZXhwOiBuZXcgUmVnRXhwKGBcXFxceDFiXFxcXFske2Nsb3NlfW1gLCBcImdcIiksXG4gIH07XG59XG5cbmZ1bmN0aW9uIHJ1bihzdHI6IHN0cmluZywgY29kZTogQ29kZSk6IHN0cmluZyB7XG4gIHJldHVybiBlbmFibGVkXG4gICAgPyBgJHtjb2RlLm9wZW59JHtzdHIucmVwbGFjZShjb2RlLnJlZ2V4cCwgY29kZS5vcGVuKX0ke2NvZGUuY2xvc2V9YFxuICAgIDogc3RyO1xufVxuXG4vKipcbiAqIFNldHMgdGhlIHN0eWxlIG9mIHRleHQgdG8gYmUgcHJpbnRlZCB0byBib2xkLlxuICpcbiAqIERpc2FibGUgYnkgc2V0dGluZyB0aGUgYE5PX0NPTE9SYCBlbnZpcm9ubWVudGFsIHZhcmlhYmxlLlxuICpcbiAqIEBwYXJhbSBzdHIgVGV4dCB0byBtYWtlIGJvbGRcbiAqXG4gKiBAcmV0dXJucyBCb2xkIHRleHQgZm9yIHByaW50aW5nXG4gKlxuICogQGV4YW1wbGUgVXNhZ2VcbiAqIGBgYHRzIG5vLWFzc2VydFxuICogaW1wb3J0IHsgYm9sZCB9IGZyb20gXCJAc3RkL2ludGVybmFsL3N0eWxlc1wiO1xuICpcbiAqIGNvbnNvbGUubG9nKGJvbGQoXCJIZWxsbywgd29ybGQhXCIpKTsgLy8gUHJpbnRzIFwiSGVsbG8sIHdvcmxkIVwiIGluIGJvbGRcbiAqIGBgYFxuICovXG5leHBvcnQgZnVuY3Rpb24gYm9sZChzdHI6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBydW4oc3RyLCBjb2RlKFsxXSwgMjIpKTtcbn1cblxuLyoqXG4gKiBTZXRzIHRoZSBjb2xvciBvZiB0ZXh0IHRvIGJlIHByaW50ZWQgdG8gcmVkLlxuICpcbiAqIERpc2FibGUgYnkgc2V0dGluZyB0aGUgYE5PX0NPTE9SYCBlbnZpcm9ubWVudGFsIHZhcmlhYmxlLlxuICpcbiAqIEBwYXJhbSBzdHIgVGV4dCB0byBtYWtlIHJlZFxuICpcbiAqIEByZXR1cm5zIFJlZCB0ZXh0IGZvciBwcmludGluZ1xuICpcbiAqIEBleGFtcGxlIFVzYWdlXG4gKiBgYGB0cyBuby1hc3NlcnRcbiAqIGltcG9ydCB7IHJlZCB9IGZyb20gXCJAc3RkL2ludGVybmFsL3N0eWxlc1wiO1xuICpcbiAqIGNvbnNvbGUubG9nKHJlZChcIkhlbGxvLCB3b3JsZCFcIikpOyAvLyBQcmludHMgXCJIZWxsbywgd29ybGQhXCIgaW4gcmVkXG4gKiBgYGBcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlZChzdHI6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBydW4oc3RyLCBjb2RlKFszMV0sIDM5KSk7XG59XG5cbi8qKlxuICogU2V0cyB0aGUgY29sb3Igb2YgdGV4dCB0byBiZSBwcmludGVkIHRvIGdyZWVuLlxuICpcbiAqIERpc2FibGUgYnkgc2V0dGluZyB0aGUgYE5PX0NPTE9SYCBlbnZpcm9ubWVudGFsIHZhcmlhYmxlLlxuICpcbiAqIEBwYXJhbSBzdHIgVGV4dCB0byBtYWtlIGdyZWVuXG4gKlxuICogQHJldHVybnMgR3JlZW4gdGV4dCBmb3IgcHJpbnRcbiAqXG4gKiBAZXhhbXBsZSBVc2FnZVxuICogYGBgdHMgbm8tYXNzZXJ0XG4gKiBpbXBvcnQgeyBncmVlbiB9IGZyb20gXCJAc3RkL2ludGVybmFsL3N0eWxlc1wiO1xuICpcbiAqIGNvbnNvbGUubG9nKGdyZWVuKFwiSGVsbG8sIHdvcmxkIVwiKSk7IC8vIFByaW50cyBcIkhlbGxvLCB3b3JsZCFcIiBpbiBncmVlblxuICogYGBgXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBncmVlbihzdHI6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBydW4oc3RyLCBjb2RlKFszMl0sIDM5KSk7XG59XG5cbi8qKlxuICogU2V0cyB0aGUgY29sb3Igb2YgdGV4dCB0byBiZSBwcmludGVkIHRvIHllbGxvdy5cbiAqXG4gKiBEaXNhYmxlIGJ5IHNldHRpbmcgdGhlIGBOT19DT0xPUmAgZW52aXJvbm1lbnRhbCB2YXJpYWJsZS5cbiAqXG4gKiBAcGFyYW0gc3RyIFRleHQgdG8gbWFrZSB5ZWxsb3dcbiAqXG4gKiBAcmV0dXJucyBZZWxsb3cgdGV4dCBmb3IgcHJpbnRcbiAqXG4gKiBAZXhhbXBsZSBVc2FnZVxuICogYGBgdHMgbm8tYXNzZXJ0XG4gKiBpbXBvcnQgeyB5ZWxsb3cgfSBmcm9tIFwiQHN0ZC9pbnRlcm5hbC9zdHlsZXNcIjtcbiAqXG4gKiBjb25zb2xlLmxvZyh5ZWxsb3coXCJIZWxsbywgd29ybGQhXCIpKTsgLy8gUHJpbnRzIFwiSGVsbG8sIHdvcmxkIVwiIGluIHllbGxvd1xuICogYGBgXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB5ZWxsb3coc3RyOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gcnVuKHN0ciwgY29kZShbMzNdLCAzOSkpO1xufVxuXG4vKipcbiAqIFNldHMgdGhlIGNvbG9yIG9mIHRleHQgdG8gYmUgcHJpbnRlZCB0byB3aGl0ZS5cbiAqXG4gKiBAcGFyYW0gc3RyIFRleHQgdG8gbWFrZSB3aGl0ZVxuICpcbiAqIEByZXR1cm5zIFdoaXRlIHRleHQgZm9yIHByaW50XG4gKlxuICogQGV4YW1wbGUgVXNhZ2VcbiAqIGBgYHRzIG5vLWFzc2VydFxuICogaW1wb3J0IHsgd2hpdGUgfSBmcm9tIFwiQHN0ZC9pbnRlcm5hbC9zdHlsZXNcIjtcbiAqXG4gKiBjb25zb2xlLmxvZyh3aGl0ZShcIkhlbGxvLCB3b3JsZCFcIikpOyAvLyBQcmludHMgXCJIZWxsbywgd29ybGQhXCIgaW4gd2hpdGVcbiAqIGBgYFxuICovXG5leHBvcnQgZnVuY3Rpb24gd2hpdGUoc3RyOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gcnVuKHN0ciwgY29kZShbMzddLCAzOSkpO1xufVxuXG4vKipcbiAqIFNldHMgdGhlIGNvbG9yIG9mIHRleHQgdG8gYmUgcHJpbnRlZCB0byBncmF5LlxuICpcbiAqIEBwYXJhbSBzdHIgVGV4dCB0byBtYWtlIGdyYXlcbiAqXG4gKiBAcmV0dXJucyBHcmF5IHRleHQgZm9yIHByaW50XG4gKlxuICogQGV4YW1wbGUgVXNhZ2VcbiAqIGBgYHRzIG5vLWFzc2VydFxuICogaW1wb3J0IHsgZ3JheSB9IGZyb20gXCJAc3RkL2ludGVybmFsL3N0eWxlc1wiO1xuICpcbiAqIGNvbnNvbGUubG9nKGdyYXkoXCJIZWxsbywgd29ybGQhXCIpKTsgLy8gUHJpbnRzIFwiSGVsbG8sIHdvcmxkIVwiIGluIGdyYXlcbiAqIGBgYFxuICovXG5leHBvcnQgZnVuY3Rpb24gZ3JheShzdHI6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBicmlnaHRCbGFjayhzdHIpO1xufVxuXG4vKipcbiAqIFNldHMgdGhlIGNvbG9yIG9mIHRleHQgdG8gYmUgcHJpbnRlZCB0byBicmlnaHQtYmxhY2suXG4gKlxuICogQHBhcmFtIHN0ciBUZXh0IHRvIG1ha2UgYnJpZ2h0LWJsYWNrXG4gKlxuICogQHJldHVybnMgQnJpZ2h0LWJsYWNrIHRleHQgZm9yIHByaW50XG4gKlxuICogQGV4YW1wbGUgVXNhZ2VcbiAqIGBgYHRzIG5vLWFzc2VydFxuICogaW1wb3J0IHsgYnJpZ2h0QmxhY2sgfSBmcm9tIFwiQHN0ZC9pbnRlcm5hbC9zdHlsZXNcIjtcbiAqXG4gKiBjb25zb2xlLmxvZyhicmlnaHRCbGFjayhcIkhlbGxvLCB3b3JsZCFcIikpOyAvLyBQcmludHMgXCJIZWxsbywgd29ybGQhXCIgaW4gYnJpZ2h0LWJsYWNrXG4gKiBgYGBcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJyaWdodEJsYWNrKHN0cjogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHJ1bihzdHIsIGNvZGUoWzkwXSwgMzkpKTtcbn1cblxuLyoqXG4gKiBTZXRzIHRoZSBiYWNrZ3JvdW5kIGNvbG9yIG9mIHRleHQgdG8gYmUgcHJpbnRlZCB0byByZWQuXG4gKlxuICogQHBhcmFtIHN0ciBUZXh0IHRvIG1ha2UgaXRzIGJhY2tncm91bmQgcmVkXG4gKlxuICogQHJldHVybnMgUmVkIGJhY2tncm91bmQgdGV4dCBmb3IgcHJpbnRcbiAqXG4gKiBAZXhhbXBsZSBVc2FnZVxuICogYGBgdHMgbm8tYXNzZXJ0XG4gKiBpbXBvcnQgeyBiZ1JlZCB9IGZyb20gXCJAc3RkL2ludGVybmFsL3N0eWxlc1wiO1xuICpcbiAqIGNvbnNvbGUubG9nKGJnUmVkKFwiSGVsbG8sIHdvcmxkIVwiKSk7IC8vIFByaW50cyBcIkhlbGxvLCB3b3JsZCFcIiB3aXRoIHJlZCBiYWNrZ3JvdW5kXG4gKiBgYGBcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJnUmVkKHN0cjogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHJ1bihzdHIsIGNvZGUoWzQxXSwgNDkpKTtcbn1cblxuLyoqXG4gKiBTZXRzIHRoZSBiYWNrZ3JvdW5kIGNvbG9yIG9mIHRleHQgdG8gYmUgcHJpbnRlZCB0byBncmVlbi5cbiAqXG4gKiBAcGFyYW0gc3RyIFRleHQgdG8gbWFrZSBpdHMgYmFja2dyb3VuZCBncmVlblxuICpcbiAqIEByZXR1cm5zIEdyZWVuIGJhY2tncm91bmQgdGV4dCBmb3IgcHJpbnRcbiAqXG4gKiBAZXhhbXBsZSBVc2FnZVxuICogYGBgdHMgbm8tYXNzZXJ0XG4gKiBpbXBvcnQgeyBiZ0dyZWVuIH0gZnJvbSBcIkBzdGQvaW50ZXJuYWwvc3R5bGVzXCI7XG4gKlxuICogY29uc29sZS5sb2coYmdHcmVlbihcIkhlbGxvLCB3b3JsZCFcIikpOyAvLyBQcmludHMgXCJIZWxsbywgd29ybGQhXCIgd2l0aCBncmVlbiBiYWNrZ3JvdW5kXG4gKiBgYGBcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJnR3JlZW4oc3RyOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gcnVuKHN0ciwgY29kZShbNDJdLCA0OSkpO1xufVxuXG4vLyBodHRwczovL2dpdGh1Yi5jb20vY2hhbGsvYW5zaS1yZWdleC9ibG9iLzAyZmE4OTNkNjE5ZDNkYTg1NDExYWNjOGZkNGUyZWVhMGU5NWE5ZDkvaW5kZXguanNcbmNvbnN0IEFOU0lfUEFUVEVSTiA9IG5ldyBSZWdFeHAoXG4gIFtcbiAgICBcIltcXFxcdTAwMUJcXFxcdTAwOUJdW1tcXFxcXSgpIzs/XSooPzooPzooPzooPzo7Wy1hLXpBLVpcXFxcZFxcXFwvIyYuOj0/JUB+X10rKSp8W2EtekEtWlxcXFxkXSsoPzo7Wy1hLXpBLVpcXFxcZFxcXFwvIyYuOj0/JUB+X10qKSopP1xcXFx1MDAwNylcIixcbiAgICBcIig/Oig/OlxcXFxkezEsNH0oPzo7XFxcXGR7MCw0fSkqKT9bXFxcXGRBLVBSLVRYWmNmLW5xLXV5PT48fl0pKVwiLFxuICBdLmpvaW4oXCJ8XCIpLFxuICBcImdcIixcbik7XG5cbi8qKlxuICogUmVtb3ZlIEFOU0kgZXNjYXBlIGNvZGVzIGZyb20gdGhlIHN0cmluZy5cbiAqXG4gKiBAcGFyYW0gc3RyaW5nIFRleHQgdG8gcmVtb3ZlIEFOU0kgZXNjYXBlIGNvZGVzIGZyb21cbiAqXG4gKiBAcmV0dXJucyBUZXh0IHdpdGhvdXQgQU5TSSBlc2NhcGUgY29kZXNcbiAqXG4gKiBAZXhhbXBsZSBVc2FnZVxuICogYGBgdHMgbm8tYXNzZXJ0XG4gKiBpbXBvcnQgeyByZWQsIHN0cmlwQW5zaUNvZGUgfSBmcm9tIFwiQHN0ZC9pbnRlcm5hbC9zdHlsZXNcIjtcbiAqXG4gKiBjb25zb2xlLmxvZyhzdHJpcEFuc2lDb2RlKHJlZChcIkhlbGxvLCB3b3JsZCFcIikpKTsgLy8gUHJpbnRzIFwiSGVsbG8sIHdvcmxkIVwiXG4gKiBgYGBcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN0cmlwQW5zaUNvZGUoc3RyaW5nOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gc3RyaW5nLnJlcGxhY2UoQU5TSV9QQVRURVJOLCBcIlwiKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxREFBcUQ7QUFDckQscUNBQXFDO0FBQ3JDLCtFQUErRTtBQUMvRSxVQUFVO0FBRVYsOENBQThDO0FBRTlDLG1DQUFtQztBQUNuQyxNQUFNLEVBQUUsSUFBSSxFQUFFLEdBQUc7QUFDakIsTUFBTSxVQUFVLE9BQU8sTUFBTSxZQUFZLFlBQ3JDLEtBQUssT0FBTyxHQUNaO0FBUUosTUFBTSxVQUFVLENBQUM7QUFFakIsU0FBUyxLQUFLLElBQWMsRUFBRSxLQUFhO0VBQ3pDLE9BQU87SUFDTCxNQUFNLENBQUMsS0FBSyxFQUFFLEtBQUssSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQy9CLE9BQU8sQ0FBQyxLQUFLLEVBQUUsTUFBTSxDQUFDLENBQUM7SUFDdkIsUUFBUSxJQUFJLE9BQU8sQ0FBQyxRQUFRLEVBQUUsTUFBTSxDQUFDLENBQUMsRUFBRTtFQUMxQztBQUNGO0FBRUEsU0FBUyxJQUFJLEdBQVcsRUFBRSxJQUFVO0VBQ2xDLE9BQU8sVUFDSCxHQUFHLEtBQUssSUFBSSxHQUFHLElBQUksT0FBTyxDQUFDLEtBQUssTUFBTSxFQUFFLEtBQUssSUFBSSxJQUFJLEtBQUssS0FBSyxFQUFFLEdBQ2pFO0FBQ047QUFFQTs7Ozs7Ozs7Ozs7Ozs7O0NBZUMsR0FDRCxPQUFPLFNBQVMsS0FBSyxHQUFXO0VBQzlCLE9BQU8sSUFBSSxLQUFLLEtBQUs7SUFBQztHQUFFLEVBQUU7QUFDNUI7QUFFQTs7Ozs7Ozs7Ozs7Ozs7O0NBZUMsR0FDRCxPQUFPLFNBQVMsSUFBSSxHQUFXO0VBQzdCLE9BQU8sSUFBSSxLQUFLLEtBQUs7SUFBQztHQUFHLEVBQUU7QUFDN0I7QUFFQTs7Ozs7Ozs7Ozs7Ozs7O0NBZUMsR0FDRCxPQUFPLFNBQVMsTUFBTSxHQUFXO0VBQy9CLE9BQU8sSUFBSSxLQUFLLEtBQUs7SUFBQztHQUFHLEVBQUU7QUFDN0I7QUFFQTs7Ozs7Ozs7Ozs7Ozs7O0NBZUMsR0FDRCxPQUFPLFNBQVMsT0FBTyxHQUFXO0VBQ2hDLE9BQU8sSUFBSSxLQUFLLEtBQUs7SUFBQztHQUFHLEVBQUU7QUFDN0I7QUFFQTs7Ozs7Ozs7Ozs7OztDQWFDLEdBQ0QsT0FBTyxTQUFTLE1BQU0sR0FBVztFQUMvQixPQUFPLElBQUksS0FBSyxLQUFLO0lBQUM7R0FBRyxFQUFFO0FBQzdCO0FBRUE7Ozs7Ozs7Ozs7Ozs7Q0FhQyxHQUNELE9BQU8sU0FBUyxLQUFLLEdBQVc7RUFDOUIsT0FBTyxZQUFZO0FBQ3JCO0FBRUE7Ozs7Ozs7Ozs7Ozs7Q0FhQyxHQUNELE9BQU8sU0FBUyxZQUFZLEdBQVc7RUFDckMsT0FBTyxJQUFJLEtBQUssS0FBSztJQUFDO0dBQUcsRUFBRTtBQUM3QjtBQUVBOzs7Ozs7Ozs7Ozs7O0NBYUMsR0FDRCxPQUFPLFNBQVMsTUFBTSxHQUFXO0VBQy9CLE9BQU8sSUFBSSxLQUFLLEtBQUs7SUFBQztHQUFHLEVBQUU7QUFDN0I7QUFFQTs7Ozs7Ozs7Ozs7OztDQWFDLEdBQ0QsT0FBTyxTQUFTLFFBQVEsR0FBVztFQUNqQyxPQUFPLElBQUksS0FBSyxLQUFLO0lBQUM7R0FBRyxFQUFFO0FBQzdCO0FBRUEsNkZBQTZGO0FBQzdGLE1BQU0sZUFBZSxJQUFJLE9BQ3ZCO0VBQ0U7RUFDQTtDQUNELENBQUMsSUFBSSxDQUFDLE1BQ1A7QUFHRjs7Ozs7Ozs7Ozs7OztDQWFDLEdBQ0QsT0FBTyxTQUFTLGNBQWMsTUFBYztFQUMxQyxPQUFPLE9BQU8sT0FBTyxDQUFDLGNBQWM7QUFDdEMifQ==
// denoCacheMetadata=4666763346722110969,925782762255558377