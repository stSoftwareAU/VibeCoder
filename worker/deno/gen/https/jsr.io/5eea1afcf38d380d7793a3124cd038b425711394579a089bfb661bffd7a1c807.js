// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { format } from "jsr:@std/internal@^1.0.12/format";
import { AssertionError } from "./assertion_error.ts";
/**
 * Make an assertion that `actual` is less than or equal to `expected`.
 * If not then throw.
 *
 * @example Usage
 * ```ts ignore
 * import { assertLessOrEqual } from "@std/assert";
 *
 * assertLessOrEqual(1, 2); // Doesn't throw
 * assertLessOrEqual(1, 1); // Doesn't throw
 * assertLessOrEqual(1, 0); // Throws
 * ```
 *
 * @typeParam T The type of the values to compare.
 * @param actual The actual value to compare.
 * @param expected The expected value to compare.
 * @param msg The optional message to display if the assertion fails.
 */ export function assertLessOrEqual(actual, expected, msg) {
  if (actual <= expected) return;
  const actualString = format(actual);
  const expectedString = format(expected);
  throw new AssertionError(msg ?? `Expect ${actualString} <= ${expectedString}`);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvYXNzZXJ0LzEuMC4xOC9sZXNzX29yX2VxdWFsLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIENvcHlyaWdodCAyMDE4LTIwMjYgdGhlIERlbm8gYXV0aG9ycy4gTUlUIGxpY2Vuc2UuXG4vLyBUaGlzIG1vZHVsZSBpcyBicm93c2VyIGNvbXBhdGlibGUuXG5pbXBvcnQgeyBmb3JtYXQgfSBmcm9tIFwianNyOkBzdGQvaW50ZXJuYWxAXjEuMC4xMi9mb3JtYXRcIjtcbmltcG9ydCB7IEFzc2VydGlvbkVycm9yIH0gZnJvbSBcIi4vYXNzZXJ0aW9uX2Vycm9yLnRzXCI7XG5cbi8qKlxuICogTWFrZSBhbiBhc3NlcnRpb24gdGhhdCBgYWN0dWFsYCBpcyBsZXNzIHRoYW4gb3IgZXF1YWwgdG8gYGV4cGVjdGVkYC5cbiAqIElmIG5vdCB0aGVuIHRocm93LlxuICpcbiAqIEBleGFtcGxlIFVzYWdlXG4gKiBgYGB0cyBpZ25vcmVcbiAqIGltcG9ydCB7IGFzc2VydExlc3NPckVxdWFsIH0gZnJvbSBcIkBzdGQvYXNzZXJ0XCI7XG4gKlxuICogYXNzZXJ0TGVzc09yRXF1YWwoMSwgMik7IC8vIERvZXNuJ3QgdGhyb3dcbiAqIGFzc2VydExlc3NPckVxdWFsKDEsIDEpOyAvLyBEb2Vzbid0IHRocm93XG4gKiBhc3NlcnRMZXNzT3JFcXVhbCgxLCAwKTsgLy8gVGhyb3dzXG4gKiBgYGBcbiAqXG4gKiBAdHlwZVBhcmFtIFQgVGhlIHR5cGUgb2YgdGhlIHZhbHVlcyB0byBjb21wYXJlLlxuICogQHBhcmFtIGFjdHVhbCBUaGUgYWN0dWFsIHZhbHVlIHRvIGNvbXBhcmUuXG4gKiBAcGFyYW0gZXhwZWN0ZWQgVGhlIGV4cGVjdGVkIHZhbHVlIHRvIGNvbXBhcmUuXG4gKiBAcGFyYW0gbXNnIFRoZSBvcHRpb25hbCBtZXNzYWdlIHRvIGRpc3BsYXkgaWYgdGhlIGFzc2VydGlvbiBmYWlscy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFzc2VydExlc3NPckVxdWFsPFQ+KFxuICBhY3R1YWw6IFQsXG4gIGV4cGVjdGVkOiBULFxuICBtc2c/OiBzdHJpbmcsXG4pIHtcbiAgaWYgKGFjdHVhbCA8PSBleHBlY3RlZCkgcmV0dXJuO1xuXG4gIGNvbnN0IGFjdHVhbFN0cmluZyA9IGZvcm1hdChhY3R1YWwpO1xuICBjb25zdCBleHBlY3RlZFN0cmluZyA9IGZvcm1hdChleHBlY3RlZCk7XG4gIHRocm93IG5ldyBBc3NlcnRpb25FcnJvcihcbiAgICBtc2cgPz8gYEV4cGVjdCAke2FjdHVhbFN0cmluZ30gPD0gJHtleHBlY3RlZFN0cmluZ31gLFxuICApO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLHFEQUFxRDtBQUNyRCxxQ0FBcUM7QUFDckMsU0FBUyxNQUFNLFFBQVEsbUNBQW1DO0FBQzFELFNBQVMsY0FBYyxRQUFRLHVCQUF1QjtBQUV0RDs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FpQkMsR0FDRCxPQUFPLFNBQVMsa0JBQ2QsTUFBUyxFQUNULFFBQVcsRUFDWCxHQUFZO0VBRVosSUFBSSxVQUFVLFVBQVU7RUFFeEIsTUFBTSxlQUFlLE9BQU87RUFDNUIsTUFBTSxpQkFBaUIsT0FBTztFQUM5QixNQUFNLElBQUksZUFDUixPQUFPLENBQUMsT0FBTyxFQUFFLGFBQWEsSUFBSSxFQUFFLGdCQUFnQjtBQUV4RCJ9
// denoCacheMetadata=17969529651060818064,10696239162685010320