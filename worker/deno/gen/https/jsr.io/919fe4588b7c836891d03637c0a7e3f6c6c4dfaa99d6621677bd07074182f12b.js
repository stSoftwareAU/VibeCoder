// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { format } from "jsr:@std/internal@^1.0.12/format";
import { AssertionError } from "./assertion_error.ts";
/**
 * Make an assertion that `actual` is less than `expected`.
 * If not then throw.
 *
 * @example Usage
 * ```ts ignore
 * import { assertLess } from "@std/assert";
 *
 * assertLess(1, 2); // Doesn't throw
 * assertLess(2, 1); // Throws
 * ```
 *
 * @typeParam T The type of the values to compare.
 * @param actual The actual value to compare.
 * @param expected The expected value to compare.
 * @param msg The optional message to display if the assertion fails.
 */ export function assertLess(actual, expected, msg) {
  if (actual < expected) return;
  const actualString = format(actual);
  const expectedString = format(expected);
  throw new AssertionError(msg ?? `Expect ${actualString} < ${expectedString}`);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvYXNzZXJ0LzEuMC4xOC9sZXNzLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIENvcHlyaWdodCAyMDE4LTIwMjYgdGhlIERlbm8gYXV0aG9ycy4gTUlUIGxpY2Vuc2UuXG4vLyBUaGlzIG1vZHVsZSBpcyBicm93c2VyIGNvbXBhdGlibGUuXG5pbXBvcnQgeyBmb3JtYXQgfSBmcm9tIFwianNyOkBzdGQvaW50ZXJuYWxAXjEuMC4xMi9mb3JtYXRcIjtcbmltcG9ydCB7IEFzc2VydGlvbkVycm9yIH0gZnJvbSBcIi4vYXNzZXJ0aW9uX2Vycm9yLnRzXCI7XG5cbi8qKlxuICogTWFrZSBhbiBhc3NlcnRpb24gdGhhdCBgYWN0dWFsYCBpcyBsZXNzIHRoYW4gYGV4cGVjdGVkYC5cbiAqIElmIG5vdCB0aGVuIHRocm93LlxuICpcbiAqIEBleGFtcGxlIFVzYWdlXG4gKiBgYGB0cyBpZ25vcmVcbiAqIGltcG9ydCB7IGFzc2VydExlc3MgfSBmcm9tIFwiQHN0ZC9hc3NlcnRcIjtcbiAqXG4gKiBhc3NlcnRMZXNzKDEsIDIpOyAvLyBEb2Vzbid0IHRocm93XG4gKiBhc3NlcnRMZXNzKDIsIDEpOyAvLyBUaHJvd3NcbiAqIGBgYFxuICpcbiAqIEB0eXBlUGFyYW0gVCBUaGUgdHlwZSBvZiB0aGUgdmFsdWVzIHRvIGNvbXBhcmUuXG4gKiBAcGFyYW0gYWN0dWFsIFRoZSBhY3R1YWwgdmFsdWUgdG8gY29tcGFyZS5cbiAqIEBwYXJhbSBleHBlY3RlZCBUaGUgZXhwZWN0ZWQgdmFsdWUgdG8gY29tcGFyZS5cbiAqIEBwYXJhbSBtc2cgVGhlIG9wdGlvbmFsIG1lc3NhZ2UgdG8gZGlzcGxheSBpZiB0aGUgYXNzZXJ0aW9uIGZhaWxzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYXNzZXJ0TGVzczxUPihhY3R1YWw6IFQsIGV4cGVjdGVkOiBULCBtc2c/OiBzdHJpbmcpIHtcbiAgaWYgKGFjdHVhbCA8IGV4cGVjdGVkKSByZXR1cm47XG5cbiAgY29uc3QgYWN0dWFsU3RyaW5nID0gZm9ybWF0KGFjdHVhbCk7XG4gIGNvbnN0IGV4cGVjdGVkU3RyaW5nID0gZm9ybWF0KGV4cGVjdGVkKTtcbiAgdGhyb3cgbmV3IEFzc2VydGlvbkVycm9yKG1zZyA/PyBgRXhwZWN0ICR7YWN0dWFsU3RyaW5nfSA8ICR7ZXhwZWN0ZWRTdHJpbmd9YCk7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEscURBQXFEO0FBQ3JELHFDQUFxQztBQUNyQyxTQUFTLE1BQU0sUUFBUSxtQ0FBbUM7QUFDMUQsU0FBUyxjQUFjLFFBQVEsdUJBQXVCO0FBRXREOzs7Ozs7Ozs7Ozs7Ozs7O0NBZ0JDLEdBQ0QsT0FBTyxTQUFTLFdBQWMsTUFBUyxFQUFFLFFBQVcsRUFBRSxHQUFZO0VBQ2hFLElBQUksU0FBUyxVQUFVO0VBRXZCLE1BQU0sZUFBZSxPQUFPO0VBQzVCLE1BQU0saUJBQWlCLE9BQU87RUFDOUIsTUFBTSxJQUFJLGVBQWUsT0FBTyxDQUFDLE9BQU8sRUFBRSxhQUFhLEdBQUcsRUFBRSxnQkFBZ0I7QUFDOUUifQ==
// denoCacheMetadata=7040663979563670424,1311929559335248428