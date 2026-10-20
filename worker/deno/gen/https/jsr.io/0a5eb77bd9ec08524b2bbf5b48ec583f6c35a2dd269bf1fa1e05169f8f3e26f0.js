// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { AssertionError } from "./assertion_error.ts";
/**
 * Make an assertion that actual includes expected. If not
 * then throw.
 *
 * @example Usage
 * ```ts ignore
 * import { assertStringIncludes } from "@std/assert";
 *
 * assertStringIncludes("Hello", "ello"); // Doesn't throw
 * assertStringIncludes("Hello", "world"); // Throws
 * ```
 *
 * @param actual The actual string to check for inclusion.
 * @param expected The expected string to check for inclusion.
 * @param msg The optional message to display if the assertion fails.
 */ export function assertStringIncludes(actual, expected, msg) {
  if (actual.includes(expected)) return;
  const msgSuffix = msg ? `: ${msg}` : ".";
  msg = `Expected actual: "${actual}" to contain: "${expected}"${msgSuffix}`;
  throw new AssertionError(msg);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvYXNzZXJ0LzEuMC4xOC9zdHJpbmdfaW5jbHVkZXMudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQ29weXJpZ2h0IDIwMTgtMjAyNiB0aGUgRGVubyBhdXRob3JzLiBNSVQgbGljZW5zZS5cbi8vIFRoaXMgbW9kdWxlIGlzIGJyb3dzZXIgY29tcGF0aWJsZS5cbmltcG9ydCB7IEFzc2VydGlvbkVycm9yIH0gZnJvbSBcIi4vYXNzZXJ0aW9uX2Vycm9yLnRzXCI7XG5cbi8qKlxuICogTWFrZSBhbiBhc3NlcnRpb24gdGhhdCBhY3R1YWwgaW5jbHVkZXMgZXhwZWN0ZWQuIElmIG5vdFxuICogdGhlbiB0aHJvdy5cbiAqXG4gKiBAZXhhbXBsZSBVc2FnZVxuICogYGBgdHMgaWdub3JlXG4gKiBpbXBvcnQgeyBhc3NlcnRTdHJpbmdJbmNsdWRlcyB9IGZyb20gXCJAc3RkL2Fzc2VydFwiO1xuICpcbiAqIGFzc2VydFN0cmluZ0luY2x1ZGVzKFwiSGVsbG9cIiwgXCJlbGxvXCIpOyAvLyBEb2Vzbid0IHRocm93XG4gKiBhc3NlcnRTdHJpbmdJbmNsdWRlcyhcIkhlbGxvXCIsIFwid29ybGRcIik7IC8vIFRocm93c1xuICogYGBgXG4gKlxuICogQHBhcmFtIGFjdHVhbCBUaGUgYWN0dWFsIHN0cmluZyB0byBjaGVjayBmb3IgaW5jbHVzaW9uLlxuICogQHBhcmFtIGV4cGVjdGVkIFRoZSBleHBlY3RlZCBzdHJpbmcgdG8gY2hlY2sgZm9yIGluY2x1c2lvbi5cbiAqIEBwYXJhbSBtc2cgVGhlIG9wdGlvbmFsIG1lc3NhZ2UgdG8gZGlzcGxheSBpZiB0aGUgYXNzZXJ0aW9uIGZhaWxzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYXNzZXJ0U3RyaW5nSW5jbHVkZXMoXG4gIGFjdHVhbDogc3RyaW5nLFxuICBleHBlY3RlZDogc3RyaW5nLFxuICBtc2c/OiBzdHJpbmcsXG4pIHtcbiAgaWYgKGFjdHVhbC5pbmNsdWRlcyhleHBlY3RlZCkpIHJldHVybjtcbiAgY29uc3QgbXNnU3VmZml4ID0gbXNnID8gYDogJHttc2d9YCA6IFwiLlwiO1xuICBtc2cgPSBgRXhwZWN0ZWQgYWN0dWFsOiBcIiR7YWN0dWFsfVwiIHRvIGNvbnRhaW46IFwiJHtleHBlY3RlZH1cIiR7bXNnU3VmZml4fWA7XG4gIHRocm93IG5ldyBBc3NlcnRpb25FcnJvcihtc2cpO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLHFEQUFxRDtBQUNyRCxxQ0FBcUM7QUFDckMsU0FBUyxjQUFjLFFBQVEsdUJBQXVCO0FBRXREOzs7Ozs7Ozs7Ozs7Ozs7Q0FlQyxHQUNELE9BQU8sU0FBUyxxQkFDZCxNQUFjLEVBQ2QsUUFBZ0IsRUFDaEIsR0FBWTtFQUVaLElBQUksT0FBTyxRQUFRLENBQUMsV0FBVztFQUMvQixNQUFNLFlBQVksTUFBTSxDQUFDLEVBQUUsRUFBRSxLQUFLLEdBQUc7RUFDckMsTUFBTSxDQUFDLGtCQUFrQixFQUFFLE9BQU8sZUFBZSxFQUFFLFNBQVMsQ0FBQyxFQUFFLFdBQVc7RUFDMUUsTUFBTSxJQUFJLGVBQWU7QUFDM0IifQ==
// denoCacheMetadata=5635366836539176697,15687445231807177924