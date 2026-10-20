// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { AssertionError } from "./assertion_error.ts";
/**
 * Make an assertion, an error will be thrown if `expr` has a truthy value.
 *
 * @example Usage
 * ```ts ignore
 * import { assertFalse } from "@std/assert";
 *
 * assertFalse(false); // Doesn't throw
 * assertFalse(true); // Throws
 * ```
 *
 * @param expr The expression to test.
 * @param msg The optional message to display if the assertion fails.
 * @throws {AssertionError} If `expr` is truthy.
 */ export function assertFalse(expr, msg = "") {
  if (expr) {
    throw new AssertionError(msg);
  }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvYXNzZXJ0LzEuMC4xOC9mYWxzZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBDb3B5cmlnaHQgMjAxOC0yMDI2IHRoZSBEZW5vIGF1dGhvcnMuIE1JVCBsaWNlbnNlLlxuLy8gVGhpcyBtb2R1bGUgaXMgYnJvd3NlciBjb21wYXRpYmxlLlxuaW1wb3J0IHsgQXNzZXJ0aW9uRXJyb3IgfSBmcm9tIFwiLi9hc3NlcnRpb25fZXJyb3IudHNcIjtcblxuLyoqIEFzc2VydGlvbiBjb25kaXRpb24gZm9yIHtAbGlua2NvZGUgYXNzZXJ0RmFsc2V9LiAqL1xuZXhwb3J0IHR5cGUgRmFsc3kgPSBmYWxzZSB8IDAgfCAwbiB8IFwiXCIgfCBudWxsIHwgdW5kZWZpbmVkO1xuXG4vKipcbiAqIE1ha2UgYW4gYXNzZXJ0aW9uLCBhbiBlcnJvciB3aWxsIGJlIHRocm93biBpZiBgZXhwcmAgaGFzIGEgdHJ1dGh5IHZhbHVlLlxuICpcbiAqIEBleGFtcGxlIFVzYWdlXG4gKiBgYGB0cyBpZ25vcmVcbiAqIGltcG9ydCB7IGFzc2VydEZhbHNlIH0gZnJvbSBcIkBzdGQvYXNzZXJ0XCI7XG4gKlxuICogYXNzZXJ0RmFsc2UoZmFsc2UpOyAvLyBEb2Vzbid0IHRocm93XG4gKiBhc3NlcnRGYWxzZSh0cnVlKTsgLy8gVGhyb3dzXG4gKiBgYGBcbiAqXG4gKiBAcGFyYW0gZXhwciBUaGUgZXhwcmVzc2lvbiB0byB0ZXN0LlxuICogQHBhcmFtIG1zZyBUaGUgb3B0aW9uYWwgbWVzc2FnZSB0byBkaXNwbGF5IGlmIHRoZSBhc3NlcnRpb24gZmFpbHMuXG4gKiBAdGhyb3dzIHtBc3NlcnRpb25FcnJvcn0gSWYgYGV4cHJgIGlzIHRydXRoeS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFzc2VydEZhbHNlKGV4cHI6IHVua25vd24sIG1zZyA9IFwiXCIpOiBhc3NlcnRzIGV4cHIgaXMgRmFsc3kge1xuICBpZiAoZXhwcikge1xuICAgIHRocm93IG5ldyBBc3NlcnRpb25FcnJvcihtc2cpO1xuICB9XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEscURBQXFEO0FBQ3JELHFDQUFxQztBQUNyQyxTQUFTLGNBQWMsUUFBUSx1QkFBdUI7QUFLdEQ7Ozs7Ozs7Ozs7Ozs7O0NBY0MsR0FDRCxPQUFPLFNBQVMsWUFBWSxJQUFhLEVBQUUsTUFBTSxFQUFFO0VBQ2pELElBQUksTUFBTTtJQUNSLE1BQU0sSUFBSSxlQUFlO0VBQzNCO0FBQ0YifQ==
// denoCacheMetadata=5048362411273195787,10842852193239523304