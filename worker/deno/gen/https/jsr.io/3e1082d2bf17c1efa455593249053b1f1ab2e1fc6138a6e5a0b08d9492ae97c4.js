// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { equal } from "./equal.ts";
import { buildMessage } from "jsr:@std/internal@^1.0.12/build-message";
import { diff } from "jsr:@std/internal@^1.0.12/diff";
import { diffStr } from "jsr:@std/internal@^1.0.12/diff-str";
import { format } from "jsr:@std/internal@^1.0.12/format";
import { AssertionError } from "./assertion_error.ts";
/**
 * Make an assertion that `actual` and `expected` are equal, deeply. If not
 * deeply equal, then throw.
 *
 * Type parameter can be specified to ensure values under comparison have the
 * same type.
 *
 * Note: When comparing `Blob` objects, you should first convert them to
 * `Uint8Array` using the `Blob.bytes()` method and then compare their
 * contents.
 *
 * @example Usage
 * ```ts ignore
 * import { assertEquals } from "@std/assert";
 *
 * assertEquals("world", "world"); // Doesn't throw
 * assertEquals("hello", "world"); // Throws
 * ```
 * @example Compare `Blob` objects
 * ```ts ignore
 * import { assertEquals } from "@std/assert";
 *
 * const bytes1 = await new Blob(["foo"]).bytes();
 * const bytes2 = await new Blob(["foo"]).bytes();
 *
 * assertEquals(bytes1, bytes2);
 * ```
 *
 * @typeParam T The type of the values to compare. This is usually inferred.
 * @param actual The actual value to compare.
 * @param expected The expected value to compare.
 * @param msg The optional message to display if the assertion fails.
 */ export function assertEquals(actual, expected, msg) {
  if (equal(actual, expected)) {
    return;
  }
  const msgSuffix = msg ? `: ${msg}` : ".";
  let message = `Values are not equal${msgSuffix}`;
  const actualString = format(actual);
  const expectedString = format(expected);
  const stringDiff = typeof actual === "string" && typeof expected === "string";
  const diffResult = stringDiff ? diffStr(actual, expected) : diff(actualString.split("\n"), expectedString.split("\n"));
  const diffMsg = buildMessage(diffResult, {
    stringDiff
  }, arguments[3]).join("\n");
  message = `${message}\n${diffMsg}`;
  throw new AssertionError(message);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvYXNzZXJ0LzEuMC4xOC9lcXVhbHMudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQ29weXJpZ2h0IDIwMTgtMjAyNiB0aGUgRGVubyBhdXRob3JzLiBNSVQgbGljZW5zZS5cbi8vIFRoaXMgbW9kdWxlIGlzIGJyb3dzZXIgY29tcGF0aWJsZS5cbmltcG9ydCB7IGVxdWFsIH0gZnJvbSBcIi4vZXF1YWwudHNcIjtcbmltcG9ydCB7IGJ1aWxkTWVzc2FnZSB9IGZyb20gXCJqc3I6QHN0ZC9pbnRlcm5hbEBeMS4wLjEyL2J1aWxkLW1lc3NhZ2VcIjtcbmltcG9ydCB7IGRpZmYgfSBmcm9tIFwianNyOkBzdGQvaW50ZXJuYWxAXjEuMC4xMi9kaWZmXCI7XG5pbXBvcnQgeyBkaWZmU3RyIH0gZnJvbSBcImpzcjpAc3RkL2ludGVybmFsQF4xLjAuMTIvZGlmZi1zdHJcIjtcbmltcG9ydCB7IGZvcm1hdCB9IGZyb20gXCJqc3I6QHN0ZC9pbnRlcm5hbEBeMS4wLjEyL2Zvcm1hdFwiO1xuXG5pbXBvcnQgeyBBc3NlcnRpb25FcnJvciB9IGZyb20gXCIuL2Fzc2VydGlvbl9lcnJvci50c1wiO1xuXG4vKipcbiAqIE1ha2UgYW4gYXNzZXJ0aW9uIHRoYXQgYGFjdHVhbGAgYW5kIGBleHBlY3RlZGAgYXJlIGVxdWFsLCBkZWVwbHkuIElmIG5vdFxuICogZGVlcGx5IGVxdWFsLCB0aGVuIHRocm93LlxuICpcbiAqIFR5cGUgcGFyYW1ldGVyIGNhbiBiZSBzcGVjaWZpZWQgdG8gZW5zdXJlIHZhbHVlcyB1bmRlciBjb21wYXJpc29uIGhhdmUgdGhlXG4gKiBzYW1lIHR5cGUuXG4gKlxuICogTm90ZTogV2hlbiBjb21wYXJpbmcgYEJsb2JgIG9iamVjdHMsIHlvdSBzaG91bGQgZmlyc3QgY29udmVydCB0aGVtIHRvXG4gKiBgVWludDhBcnJheWAgdXNpbmcgdGhlIGBCbG9iLmJ5dGVzKClgIG1ldGhvZCBhbmQgdGhlbiBjb21wYXJlIHRoZWlyXG4gKiBjb250ZW50cy5cbiAqXG4gKiBAZXhhbXBsZSBVc2FnZVxuICogYGBgdHMgaWdub3JlXG4gKiBpbXBvcnQgeyBhc3NlcnRFcXVhbHMgfSBmcm9tIFwiQHN0ZC9hc3NlcnRcIjtcbiAqXG4gKiBhc3NlcnRFcXVhbHMoXCJ3b3JsZFwiLCBcIndvcmxkXCIpOyAvLyBEb2Vzbid0IHRocm93XG4gKiBhc3NlcnRFcXVhbHMoXCJoZWxsb1wiLCBcIndvcmxkXCIpOyAvLyBUaHJvd3NcbiAqIGBgYFxuICogQGV4YW1wbGUgQ29tcGFyZSBgQmxvYmAgb2JqZWN0c1xuICogYGBgdHMgaWdub3JlXG4gKiBpbXBvcnQgeyBhc3NlcnRFcXVhbHMgfSBmcm9tIFwiQHN0ZC9hc3NlcnRcIjtcbiAqXG4gKiBjb25zdCBieXRlczEgPSBhd2FpdCBuZXcgQmxvYihbXCJmb29cIl0pLmJ5dGVzKCk7XG4gKiBjb25zdCBieXRlczIgPSBhd2FpdCBuZXcgQmxvYihbXCJmb29cIl0pLmJ5dGVzKCk7XG4gKlxuICogYXNzZXJ0RXF1YWxzKGJ5dGVzMSwgYnl0ZXMyKTtcbiAqIGBgYFxuICpcbiAqIEB0eXBlUGFyYW0gVCBUaGUgdHlwZSBvZiB0aGUgdmFsdWVzIHRvIGNvbXBhcmUuIFRoaXMgaXMgdXN1YWxseSBpbmZlcnJlZC5cbiAqIEBwYXJhbSBhY3R1YWwgVGhlIGFjdHVhbCB2YWx1ZSB0byBjb21wYXJlLlxuICogQHBhcmFtIGV4cGVjdGVkIFRoZSBleHBlY3RlZCB2YWx1ZSB0byBjb21wYXJlLlxuICogQHBhcmFtIG1zZyBUaGUgb3B0aW9uYWwgbWVzc2FnZSB0byBkaXNwbGF5IGlmIHRoZSBhc3NlcnRpb24gZmFpbHMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhc3NlcnRFcXVhbHM8VD4oXG4gIGFjdHVhbDogVCxcbiAgZXhwZWN0ZWQ6IFQsXG4gIG1zZz86IHN0cmluZyxcbikge1xuICBpZiAoZXF1YWwoYWN0dWFsLCBleHBlY3RlZCkpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgbXNnU3VmZml4ID0gbXNnID8gYDogJHttc2d9YCA6IFwiLlwiO1xuICBsZXQgbWVzc2FnZSA9IGBWYWx1ZXMgYXJlIG5vdCBlcXVhbCR7bXNnU3VmZml4fWA7XG5cbiAgY29uc3QgYWN0dWFsU3RyaW5nID0gZm9ybWF0KGFjdHVhbCk7XG4gIGNvbnN0IGV4cGVjdGVkU3RyaW5nID0gZm9ybWF0KGV4cGVjdGVkKTtcbiAgY29uc3Qgc3RyaW5nRGlmZiA9ICh0eXBlb2YgYWN0dWFsID09PSBcInN0cmluZ1wiKSAmJlxuICAgICh0eXBlb2YgZXhwZWN0ZWQgPT09IFwic3RyaW5nXCIpO1xuICBjb25zdCBkaWZmUmVzdWx0ID0gc3RyaW5nRGlmZlxuICAgID8gZGlmZlN0cihhY3R1YWwgYXMgc3RyaW5nLCBleHBlY3RlZCBhcyBzdHJpbmcpXG4gICAgOiBkaWZmKGFjdHVhbFN0cmluZy5zcGxpdChcIlxcblwiKSwgZXhwZWN0ZWRTdHJpbmcuc3BsaXQoXCJcXG5cIikpO1xuICBjb25zdCBkaWZmTXNnID0gYnVpbGRNZXNzYWdlKGRpZmZSZXN1bHQsIHsgc3RyaW5nRGlmZiB9LCBhcmd1bWVudHNbM10pXG4gICAgLmpvaW4oXCJcXG5cIik7XG4gIG1lc3NhZ2UgPSBgJHttZXNzYWdlfVxcbiR7ZGlmZk1zZ31gO1xuICB0aHJvdyBuZXcgQXNzZXJ0aW9uRXJyb3IobWVzc2FnZSk7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEscURBQXFEO0FBQ3JELHFDQUFxQztBQUNyQyxTQUFTLEtBQUssUUFBUSxhQUFhO0FBQ25DLFNBQVMsWUFBWSxRQUFRLDBDQUEwQztBQUN2RSxTQUFTLElBQUksUUFBUSxpQ0FBaUM7QUFDdEQsU0FBUyxPQUFPLFFBQVEscUNBQXFDO0FBQzdELFNBQVMsTUFBTSxRQUFRLG1DQUFtQztBQUUxRCxTQUFTLGNBQWMsUUFBUSx1QkFBdUI7QUFFdEQ7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBZ0NDLEdBQ0QsT0FBTyxTQUFTLGFBQ2QsTUFBUyxFQUNULFFBQVcsRUFDWCxHQUFZO0VBRVosSUFBSSxNQUFNLFFBQVEsV0FBVztJQUMzQjtFQUNGO0VBQ0EsTUFBTSxZQUFZLE1BQU0sQ0FBQyxFQUFFLEVBQUUsS0FBSyxHQUFHO0VBQ3JDLElBQUksVUFBVSxDQUFDLG9CQUFvQixFQUFFLFdBQVc7RUFFaEQsTUFBTSxlQUFlLE9BQU87RUFDNUIsTUFBTSxpQkFBaUIsT0FBTztFQUM5QixNQUFNLGFBQWEsQUFBQyxPQUFPLFdBQVcsWUFDbkMsT0FBTyxhQUFhO0VBQ3ZCLE1BQU0sYUFBYSxhQUNmLFFBQVEsUUFBa0IsWUFDMUIsS0FBSyxhQUFhLEtBQUssQ0FBQyxPQUFPLGVBQWUsS0FBSyxDQUFDO0VBQ3hELE1BQU0sVUFBVSxhQUFhLFlBQVk7SUFBRTtFQUFXLEdBQUcsU0FBUyxDQUFDLEVBQUUsRUFDbEUsSUFBSSxDQUFDO0VBQ1IsVUFBVSxHQUFHLFFBQVEsRUFBRSxFQUFFLFNBQVM7RUFDbEMsTUFBTSxJQUFJLGVBQWU7QUFDM0IifQ==
// denoCacheMetadata=15861678750012377098,9174370628126186861