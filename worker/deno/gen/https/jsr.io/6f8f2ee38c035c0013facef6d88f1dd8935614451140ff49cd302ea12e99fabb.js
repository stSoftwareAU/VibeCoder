// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { AssertionError } from "./assertion_error.ts";
import { format } from "jsr:@std/internal@^1.0.12/format";
/**
 * Make an assertion that `actual` and `expected` are not strictly equal, using
 * {@linkcode Object.is} for equality comparison. If the values are strictly
 * equal then throw.
 *
 * @example Usage
 * ```ts ignore
 * import { assertNotStrictEquals } from "@std/assert";
 *
 * assertNotStrictEquals(1, 1); // Throws
 * assertNotStrictEquals(1, 2); // Doesn't throw
 *
 * assertNotStrictEquals(0, 0); // Throws
 * assertNotStrictEquals(0, -0); // Doesn't throw
 * ```
 *
 * @typeParam T The type of the values to compare.
 * @param actual The actual value to compare.
 * @param expected The expected value to compare.
 * @param msg The optional message to display if the assertion fails.
 */ export function assertNotStrictEquals(actual, expected, msg) {
  if (!Object.is(actual, expected)) {
    return;
  }
  const msgSuffix = msg ? `: ${msg}` : ".";
  throw new AssertionError(`Expected "actual" to not be strictly equal to: ${format(actual)}${msgSuffix}\n`);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvYXNzZXJ0LzEuMC4xOC9ub3Rfc3RyaWN0X2VxdWFscy50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBDb3B5cmlnaHQgMjAxOC0yMDI2IHRoZSBEZW5vIGF1dGhvcnMuIE1JVCBsaWNlbnNlLlxuLy8gVGhpcyBtb2R1bGUgaXMgYnJvd3NlciBjb21wYXRpYmxlLlxuaW1wb3J0IHsgQXNzZXJ0aW9uRXJyb3IgfSBmcm9tIFwiLi9hc3NlcnRpb25fZXJyb3IudHNcIjtcbmltcG9ydCB7IGZvcm1hdCB9IGZyb20gXCJqc3I6QHN0ZC9pbnRlcm5hbEBeMS4wLjEyL2Zvcm1hdFwiO1xuXG4vKipcbiAqIE1ha2UgYW4gYXNzZXJ0aW9uIHRoYXQgYGFjdHVhbGAgYW5kIGBleHBlY3RlZGAgYXJlIG5vdCBzdHJpY3RseSBlcXVhbCwgdXNpbmdcbiAqIHtAbGlua2NvZGUgT2JqZWN0LmlzfSBmb3IgZXF1YWxpdHkgY29tcGFyaXNvbi4gSWYgdGhlIHZhbHVlcyBhcmUgc3RyaWN0bHlcbiAqIGVxdWFsIHRoZW4gdGhyb3cuXG4gKlxuICogQGV4YW1wbGUgVXNhZ2VcbiAqIGBgYHRzIGlnbm9yZVxuICogaW1wb3J0IHsgYXNzZXJ0Tm90U3RyaWN0RXF1YWxzIH0gZnJvbSBcIkBzdGQvYXNzZXJ0XCI7XG4gKlxuICogYXNzZXJ0Tm90U3RyaWN0RXF1YWxzKDEsIDEpOyAvLyBUaHJvd3NcbiAqIGFzc2VydE5vdFN0cmljdEVxdWFscygxLCAyKTsgLy8gRG9lc24ndCB0aHJvd1xuICpcbiAqIGFzc2VydE5vdFN0cmljdEVxdWFscygwLCAwKTsgLy8gVGhyb3dzXG4gKiBhc3NlcnROb3RTdHJpY3RFcXVhbHMoMCwgLTApOyAvLyBEb2Vzbid0IHRocm93XG4gKiBgYGBcbiAqXG4gKiBAdHlwZVBhcmFtIFQgVGhlIHR5cGUgb2YgdGhlIHZhbHVlcyB0byBjb21wYXJlLlxuICogQHBhcmFtIGFjdHVhbCBUaGUgYWN0dWFsIHZhbHVlIHRvIGNvbXBhcmUuXG4gKiBAcGFyYW0gZXhwZWN0ZWQgVGhlIGV4cGVjdGVkIHZhbHVlIHRvIGNvbXBhcmUuXG4gKiBAcGFyYW0gbXNnIFRoZSBvcHRpb25hbCBtZXNzYWdlIHRvIGRpc3BsYXkgaWYgdGhlIGFzc2VydGlvbiBmYWlscy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFzc2VydE5vdFN0cmljdEVxdWFsczxUPihcbiAgYWN0dWFsOiBULFxuICBleHBlY3RlZDogVCxcbiAgbXNnPzogc3RyaW5nLFxuKSB7XG4gIGlmICghT2JqZWN0LmlzKGFjdHVhbCwgZXhwZWN0ZWQpKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgbXNnU3VmZml4ID0gbXNnID8gYDogJHttc2d9YCA6IFwiLlwiO1xuICB0aHJvdyBuZXcgQXNzZXJ0aW9uRXJyb3IoXG4gICAgYEV4cGVjdGVkIFwiYWN0dWFsXCIgdG8gbm90IGJlIHN0cmljdGx5IGVxdWFsIHRvOiAke1xuICAgICAgZm9ybWF0KGFjdHVhbClcbiAgICB9JHttc2dTdWZmaXh9XFxuYCxcbiAgKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxREFBcUQ7QUFDckQscUNBQXFDO0FBQ3JDLFNBQVMsY0FBYyxRQUFRLHVCQUF1QjtBQUN0RCxTQUFTLE1BQU0sUUFBUSxtQ0FBbUM7QUFFMUQ7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBb0JDLEdBQ0QsT0FBTyxTQUFTLHNCQUNkLE1BQVMsRUFDVCxRQUFXLEVBQ1gsR0FBWTtFQUVaLElBQUksQ0FBQyxPQUFPLEVBQUUsQ0FBQyxRQUFRLFdBQVc7SUFDaEM7RUFDRjtFQUVBLE1BQU0sWUFBWSxNQUFNLENBQUMsRUFBRSxFQUFFLEtBQUssR0FBRztFQUNyQyxNQUFNLElBQUksZUFDUixDQUFDLCtDQUErQyxFQUM5QyxPQUFPLFVBQ04sVUFBVSxFQUFFLENBQUM7QUFFcEIifQ==
// denoCacheMetadata=5103532685173670588,6757685576490554733