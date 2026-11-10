// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { assertFalse } from "./false.ts";
/**
 * Make an assertion that `obj` is not an instance of `type`.
 * If so, then throw.
 *
 * @example Usage
 * ```ts ignore
 * import { assertNotInstanceOf } from "@std/assert";
 *
 * assertNotInstanceOf(new Date(), Number); // Doesn't throw
 * assertNotInstanceOf(new Date(), Date); // Throws
 * ```
 *
 * @typeParam A The type of the object to check.
 * @typeParam T The type of the class to check against.
 * @param actual The object to check.
 * @param unexpectedType The class constructor to check against.
 * @param msg The optional message to display if the assertion fails.
 */ export function assertNotInstanceOf(actual, // deno-lint-ignore no-explicit-any
unexpectedType, msg) {
  const msgSuffix = msg ? `: ${msg}` : ".";
  msg = `Expected object to not be an instance of "${typeof unexpectedType}"${msgSuffix}`;
  assertFalse(actual instanceof unexpectedType, msg);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvYXNzZXJ0LzEuMC4xOC9ub3RfaW5zdGFuY2Vfb2YudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQ29weXJpZ2h0IDIwMTgtMjAyNiB0aGUgRGVubyBhdXRob3JzLiBNSVQgbGljZW5zZS5cbi8vIFRoaXMgbW9kdWxlIGlzIGJyb3dzZXIgY29tcGF0aWJsZS5cbmltcG9ydCB7IGFzc2VydEZhbHNlIH0gZnJvbSBcIi4vZmFsc2UudHNcIjtcblxuLyoqXG4gKiBNYWtlIGFuIGFzc2VydGlvbiB0aGF0IGBvYmpgIGlzIG5vdCBhbiBpbnN0YW5jZSBvZiBgdHlwZWAuXG4gKiBJZiBzbywgdGhlbiB0aHJvdy5cbiAqXG4gKiBAZXhhbXBsZSBVc2FnZVxuICogYGBgdHMgaWdub3JlXG4gKiBpbXBvcnQgeyBhc3NlcnROb3RJbnN0YW5jZU9mIH0gZnJvbSBcIkBzdGQvYXNzZXJ0XCI7XG4gKlxuICogYXNzZXJ0Tm90SW5zdGFuY2VPZihuZXcgRGF0ZSgpLCBOdW1iZXIpOyAvLyBEb2Vzbid0IHRocm93XG4gKiBhc3NlcnROb3RJbnN0YW5jZU9mKG5ldyBEYXRlKCksIERhdGUpOyAvLyBUaHJvd3NcbiAqIGBgYFxuICpcbiAqIEB0eXBlUGFyYW0gQSBUaGUgdHlwZSBvZiB0aGUgb2JqZWN0IHRvIGNoZWNrLlxuICogQHR5cGVQYXJhbSBUIFRoZSB0eXBlIG9mIHRoZSBjbGFzcyB0byBjaGVjayBhZ2FpbnN0LlxuICogQHBhcmFtIGFjdHVhbCBUaGUgb2JqZWN0IHRvIGNoZWNrLlxuICogQHBhcmFtIHVuZXhwZWN0ZWRUeXBlIFRoZSBjbGFzcyBjb25zdHJ1Y3RvciB0byBjaGVjayBhZ2FpbnN0LlxuICogQHBhcmFtIG1zZyBUaGUgb3B0aW9uYWwgbWVzc2FnZSB0byBkaXNwbGF5IGlmIHRoZSBhc3NlcnRpb24gZmFpbHMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhc3NlcnROb3RJbnN0YW5jZU9mPEEsIFQ+KFxuICBhY3R1YWw6IEEsXG4gIC8vIGRlbm8tbGludC1pZ25vcmUgbm8tZXhwbGljaXQtYW55XG4gIHVuZXhwZWN0ZWRUeXBlOiBhYnN0cmFjdCBuZXcgKC4uLmFyZ3M6IGFueVtdKSA9PiBULFxuICBtc2c/OiBzdHJpbmcsXG4pOiBhc3NlcnRzIGFjdHVhbCBpcyBFeGNsdWRlPEEsIFQ+IHtcbiAgY29uc3QgbXNnU3VmZml4ID0gbXNnID8gYDogJHttc2d9YCA6IFwiLlwiO1xuICBtc2cgPVxuICAgIGBFeHBlY3RlZCBvYmplY3QgdG8gbm90IGJlIGFuIGluc3RhbmNlIG9mIFwiJHt0eXBlb2YgdW5leHBlY3RlZFR5cGV9XCIke21zZ1N1ZmZpeH1gO1xuICBhc3NlcnRGYWxzZShhY3R1YWwgaW5zdGFuY2VvZiB1bmV4cGVjdGVkVHlwZSwgbXNnKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxREFBcUQ7QUFDckQscUNBQXFDO0FBQ3JDLFNBQVMsV0FBVyxRQUFRLGFBQWE7QUFFekM7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBaUJDLEdBQ0QsT0FBTyxTQUFTLG9CQUNkLE1BQVMsRUFDVCxtQ0FBbUM7QUFDbkMsY0FBa0QsRUFDbEQsR0FBWTtFQUVaLE1BQU0sWUFBWSxNQUFNLENBQUMsRUFBRSxFQUFFLEtBQUssR0FBRztFQUNyQyxNQUNFLENBQUMsMENBQTBDLEVBQUUsT0FBTyxlQUFlLENBQUMsRUFBRSxXQUFXO0VBQ25GLFlBQVksa0JBQWtCLGdCQUFnQjtBQUNoRCJ9
// denoCacheMetadata=9595289604103271369,9233913362031021102