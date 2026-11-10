// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { AssertionError } from "./assertion_error.ts";
/**
 * Make an assertion that `actual` not match RegExp `expected`. If match
 * then throw.
 *
 * @example Usage
 * ```ts ignore
 * import { assertNotMatch } from "@std/assert";
 *
 * assertNotMatch("Denosaurus", /Raptor/); // Doesn't throw
 * assertNotMatch("Raptor", /Raptor/); // Throws
 * ```
 *
 * @param actual The actual value to match.
 * @param expected The expected value to not match.
 * @param msg The optional message to display if the assertion fails.
 */ export function assertNotMatch(actual, expected, msg) {
  if (!expected.test(actual)) return;
  const msgSuffix = msg ? `: ${msg}` : ".";
  msg = `Expected actual: "${actual}" to not match: "${expected}"${msgSuffix}`;
  throw new AssertionError(msg);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvYXNzZXJ0LzEuMC4xOC9ub3RfbWF0Y2gudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQ29weXJpZ2h0IDIwMTgtMjAyNiB0aGUgRGVubyBhdXRob3JzLiBNSVQgbGljZW5zZS5cbi8vIFRoaXMgbW9kdWxlIGlzIGJyb3dzZXIgY29tcGF0aWJsZS5cbmltcG9ydCB7IEFzc2VydGlvbkVycm9yIH0gZnJvbSBcIi4vYXNzZXJ0aW9uX2Vycm9yLnRzXCI7XG5cbi8qKlxuICogTWFrZSBhbiBhc3NlcnRpb24gdGhhdCBgYWN0dWFsYCBub3QgbWF0Y2ggUmVnRXhwIGBleHBlY3RlZGAuIElmIG1hdGNoXG4gKiB0aGVuIHRocm93LlxuICpcbiAqIEBleGFtcGxlIFVzYWdlXG4gKiBgYGB0cyBpZ25vcmVcbiAqIGltcG9ydCB7IGFzc2VydE5vdE1hdGNoIH0gZnJvbSBcIkBzdGQvYXNzZXJ0XCI7XG4gKlxuICogYXNzZXJ0Tm90TWF0Y2goXCJEZW5vc2F1cnVzXCIsIC9SYXB0b3IvKTsgLy8gRG9lc24ndCB0aHJvd1xuICogYXNzZXJ0Tm90TWF0Y2goXCJSYXB0b3JcIiwgL1JhcHRvci8pOyAvLyBUaHJvd3NcbiAqIGBgYFxuICpcbiAqIEBwYXJhbSBhY3R1YWwgVGhlIGFjdHVhbCB2YWx1ZSB0byBtYXRjaC5cbiAqIEBwYXJhbSBleHBlY3RlZCBUaGUgZXhwZWN0ZWQgdmFsdWUgdG8gbm90IG1hdGNoLlxuICogQHBhcmFtIG1zZyBUaGUgb3B0aW9uYWwgbWVzc2FnZSB0byBkaXNwbGF5IGlmIHRoZSBhc3NlcnRpb24gZmFpbHMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhc3NlcnROb3RNYXRjaChcbiAgYWN0dWFsOiBzdHJpbmcsXG4gIGV4cGVjdGVkOiBSZWdFeHAsXG4gIG1zZz86IHN0cmluZyxcbikge1xuICBpZiAoIWV4cGVjdGVkLnRlc3QoYWN0dWFsKSkgcmV0dXJuO1xuICBjb25zdCBtc2dTdWZmaXggPSBtc2cgPyBgOiAke21zZ31gIDogXCIuXCI7XG4gIG1zZyA9IGBFeHBlY3RlZCBhY3R1YWw6IFwiJHthY3R1YWx9XCIgdG8gbm90IG1hdGNoOiBcIiR7ZXhwZWN0ZWR9XCIke21zZ1N1ZmZpeH1gO1xuICB0aHJvdyBuZXcgQXNzZXJ0aW9uRXJyb3IobXNnKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxREFBcUQ7QUFDckQscUNBQXFDO0FBQ3JDLFNBQVMsY0FBYyxRQUFRLHVCQUF1QjtBQUV0RDs7Ozs7Ozs7Ozs7Ozs7O0NBZUMsR0FDRCxPQUFPLFNBQVMsZUFDZCxNQUFjLEVBQ2QsUUFBZ0IsRUFDaEIsR0FBWTtFQUVaLElBQUksQ0FBQyxTQUFTLElBQUksQ0FBQyxTQUFTO0VBQzVCLE1BQU0sWUFBWSxNQUFNLENBQUMsRUFBRSxFQUFFLEtBQUssR0FBRztFQUNyQyxNQUFNLENBQUMsa0JBQWtCLEVBQUUsT0FBTyxpQkFBaUIsRUFBRSxTQUFTLENBQUMsRUFBRSxXQUFXO0VBQzVFLE1BQU0sSUFBSSxlQUFlO0FBQzNCIn0=
// denoCacheMetadata=15839169741113274571,9501643798779960881