// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { format } from "jsr:@std/internal@^1.0.12/format";
import { AssertionError } from "./assertion_error.ts";
/**
 * Make an assertion that `actual` is greater than `expected`.
 * If not then throw.
 *
 * @example Usage
 * ```ts ignore
 * import { assertGreater } from "@std/assert";
 *
 * assertGreater(2, 1); // Doesn't throw
 * assertGreater(1, 1); // Throws
 * assertGreater(0, 1); // Throws
 * ```
 *
 * @typeParam T The type of the values to compare.
 * @param actual The actual value to compare.
 * @param expected The expected value to compare.
 * @param msg The optional message to display if the assertion fails.
 */ export function assertGreater(actual, expected, msg) {
  if (actual > expected) return;
  const actualString = format(actual);
  const expectedString = format(expected);
  throw new AssertionError(msg ?? `Expect ${actualString} > ${expectedString}`);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvYXNzZXJ0LzEuMC4xOC9ncmVhdGVyLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIENvcHlyaWdodCAyMDE4LTIwMjYgdGhlIERlbm8gYXV0aG9ycy4gTUlUIGxpY2Vuc2UuXG4vLyBUaGlzIG1vZHVsZSBpcyBicm93c2VyIGNvbXBhdGlibGUuXG5pbXBvcnQgeyBmb3JtYXQgfSBmcm9tIFwianNyOkBzdGQvaW50ZXJuYWxAXjEuMC4xMi9mb3JtYXRcIjtcbmltcG9ydCB7IEFzc2VydGlvbkVycm9yIH0gZnJvbSBcIi4vYXNzZXJ0aW9uX2Vycm9yLnRzXCI7XG5cbi8qKlxuICogTWFrZSBhbiBhc3NlcnRpb24gdGhhdCBgYWN0dWFsYCBpcyBncmVhdGVyIHRoYW4gYGV4cGVjdGVkYC5cbiAqIElmIG5vdCB0aGVuIHRocm93LlxuICpcbiAqIEBleGFtcGxlIFVzYWdlXG4gKiBgYGB0cyBpZ25vcmVcbiAqIGltcG9ydCB7IGFzc2VydEdyZWF0ZXIgfSBmcm9tIFwiQHN0ZC9hc3NlcnRcIjtcbiAqXG4gKiBhc3NlcnRHcmVhdGVyKDIsIDEpOyAvLyBEb2Vzbid0IHRocm93XG4gKiBhc3NlcnRHcmVhdGVyKDEsIDEpOyAvLyBUaHJvd3NcbiAqIGFzc2VydEdyZWF0ZXIoMCwgMSk7IC8vIFRocm93c1xuICogYGBgXG4gKlxuICogQHR5cGVQYXJhbSBUIFRoZSB0eXBlIG9mIHRoZSB2YWx1ZXMgdG8gY29tcGFyZS5cbiAqIEBwYXJhbSBhY3R1YWwgVGhlIGFjdHVhbCB2YWx1ZSB0byBjb21wYXJlLlxuICogQHBhcmFtIGV4cGVjdGVkIFRoZSBleHBlY3RlZCB2YWx1ZSB0byBjb21wYXJlLlxuICogQHBhcmFtIG1zZyBUaGUgb3B0aW9uYWwgbWVzc2FnZSB0byBkaXNwbGF5IGlmIHRoZSBhc3NlcnRpb24gZmFpbHMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhc3NlcnRHcmVhdGVyPFQ+KGFjdHVhbDogVCwgZXhwZWN0ZWQ6IFQsIG1zZz86IHN0cmluZykge1xuICBpZiAoYWN0dWFsID4gZXhwZWN0ZWQpIHJldHVybjtcblxuICBjb25zdCBhY3R1YWxTdHJpbmcgPSBmb3JtYXQoYWN0dWFsKTtcbiAgY29uc3QgZXhwZWN0ZWRTdHJpbmcgPSBmb3JtYXQoZXhwZWN0ZWQpO1xuICB0aHJvdyBuZXcgQXNzZXJ0aW9uRXJyb3IobXNnID8/IGBFeHBlY3QgJHthY3R1YWxTdHJpbmd9ID4gJHtleHBlY3RlZFN0cmluZ31gKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxREFBcUQ7QUFDckQscUNBQXFDO0FBQ3JDLFNBQVMsTUFBTSxRQUFRLG1DQUFtQztBQUMxRCxTQUFTLGNBQWMsUUFBUSx1QkFBdUI7QUFFdEQ7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBaUJDLEdBQ0QsT0FBTyxTQUFTLGNBQWlCLE1BQVMsRUFBRSxRQUFXLEVBQUUsR0FBWTtFQUNuRSxJQUFJLFNBQVMsVUFBVTtFQUV2QixNQUFNLGVBQWUsT0FBTztFQUM1QixNQUFNLGlCQUFpQixPQUFPO0VBQzlCLE1BQU0sSUFBSSxlQUFlLE9BQU8sQ0FBQyxPQUFPLEVBQUUsYUFBYSxHQUFHLEVBQUUsZ0JBQWdCO0FBQzlFIn0=
// denoCacheMetadata=13541998884202028419,1117101050504138100