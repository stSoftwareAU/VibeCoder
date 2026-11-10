// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { AssertionError } from "./assertion_error.ts";
/**
 * Make an assertion that `actual` match RegExp `expected`. If not
 * then throw.
 *
 * @example Usage
 * ```ts ignore
 * import { assertMatch } from "@std/assert";
 *
 * assertMatch("Raptor", /Raptor/); // Doesn't throw
 * assertMatch("Denosaurus", /Raptor/); // Throws
 * ```
 *
 * @param actual The actual value to be matched.
 * @param expected The expected pattern to match.
 * @param msg The optional message to display if the assertion fails.
 */ export function assertMatch(actual, expected, msg) {
  if (expected.test(actual)) return;
  const msgSuffix = msg ? `: ${msg}` : ".";
  msg = `Expected actual: "${actual}" to match: "${expected}"${msgSuffix}`;
  throw new AssertionError(msg);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvYXNzZXJ0LzEuMC4xOC9tYXRjaC50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBDb3B5cmlnaHQgMjAxOC0yMDI2IHRoZSBEZW5vIGF1dGhvcnMuIE1JVCBsaWNlbnNlLlxuLy8gVGhpcyBtb2R1bGUgaXMgYnJvd3NlciBjb21wYXRpYmxlLlxuaW1wb3J0IHsgQXNzZXJ0aW9uRXJyb3IgfSBmcm9tIFwiLi9hc3NlcnRpb25fZXJyb3IudHNcIjtcblxuLyoqXG4gKiBNYWtlIGFuIGFzc2VydGlvbiB0aGF0IGBhY3R1YWxgIG1hdGNoIFJlZ0V4cCBgZXhwZWN0ZWRgLiBJZiBub3RcbiAqIHRoZW4gdGhyb3cuXG4gKlxuICogQGV4YW1wbGUgVXNhZ2VcbiAqIGBgYHRzIGlnbm9yZVxuICogaW1wb3J0IHsgYXNzZXJ0TWF0Y2ggfSBmcm9tIFwiQHN0ZC9hc3NlcnRcIjtcbiAqXG4gKiBhc3NlcnRNYXRjaChcIlJhcHRvclwiLCAvUmFwdG9yLyk7IC8vIERvZXNuJ3QgdGhyb3dcbiAqIGFzc2VydE1hdGNoKFwiRGVub3NhdXJ1c1wiLCAvUmFwdG9yLyk7IC8vIFRocm93c1xuICogYGBgXG4gKlxuICogQHBhcmFtIGFjdHVhbCBUaGUgYWN0dWFsIHZhbHVlIHRvIGJlIG1hdGNoZWQuXG4gKiBAcGFyYW0gZXhwZWN0ZWQgVGhlIGV4cGVjdGVkIHBhdHRlcm4gdG8gbWF0Y2guXG4gKiBAcGFyYW0gbXNnIFRoZSBvcHRpb25hbCBtZXNzYWdlIHRvIGRpc3BsYXkgaWYgdGhlIGFzc2VydGlvbiBmYWlscy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFzc2VydE1hdGNoKFxuICBhY3R1YWw6IHN0cmluZyxcbiAgZXhwZWN0ZWQ6IFJlZ0V4cCxcbiAgbXNnPzogc3RyaW5nLFxuKSB7XG4gIGlmIChleHBlY3RlZC50ZXN0KGFjdHVhbCkpIHJldHVybjtcbiAgY29uc3QgbXNnU3VmZml4ID0gbXNnID8gYDogJHttc2d9YCA6IFwiLlwiO1xuICBtc2cgPSBgRXhwZWN0ZWQgYWN0dWFsOiBcIiR7YWN0dWFsfVwiIHRvIG1hdGNoOiBcIiR7ZXhwZWN0ZWR9XCIke21zZ1N1ZmZpeH1gO1xuICB0aHJvdyBuZXcgQXNzZXJ0aW9uRXJyb3IobXNnKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxREFBcUQ7QUFDckQscUNBQXFDO0FBQ3JDLFNBQVMsY0FBYyxRQUFRLHVCQUF1QjtBQUV0RDs7Ozs7Ozs7Ozs7Ozs7O0NBZUMsR0FDRCxPQUFPLFNBQVMsWUFDZCxNQUFjLEVBQ2QsUUFBZ0IsRUFDaEIsR0FBWTtFQUVaLElBQUksU0FBUyxJQUFJLENBQUMsU0FBUztFQUMzQixNQUFNLFlBQVksTUFBTSxDQUFDLEVBQUUsRUFBRSxLQUFLLEdBQUc7RUFDckMsTUFBTSxDQUFDLGtCQUFrQixFQUFFLE9BQU8sYUFBYSxFQUFFLFNBQVMsQ0FBQyxFQUFFLFdBQVc7RUFDeEUsTUFBTSxJQUFJLGVBQWU7QUFDM0IifQ==
// denoCacheMetadata=15396178005080933618,15991726867259095976