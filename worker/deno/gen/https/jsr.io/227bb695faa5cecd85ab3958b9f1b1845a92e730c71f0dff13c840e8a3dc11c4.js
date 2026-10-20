// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { AssertionError } from "./assertion_error.ts";
/**
 * Make an assertion that actual is not null or undefined.
 * If not then throw.
 *
 * @example Usage
 * ```ts ignore
 * import { assertExists } from "@std/assert";
 *
 * assertExists("something"); // Doesn't throw
 * assertExists(undefined); // Throws
 * ```
 *
 * @typeParam T The type of the actual value.
 * @param actual The actual value to check.
 * @param msg The optional message to include in the error if the assertion fails.
 */ export function assertExists(actual, msg) {
  if (actual === undefined || actual === null) {
    const msgSuffix = msg ? `: ${msg}` : ".";
    msg = `Expected actual: "${actual}" to not be null or undefined${msgSuffix}`;
    throw new AssertionError(msg);
  }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvYXNzZXJ0LzEuMC4xOC9leGlzdHMudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQ29weXJpZ2h0IDIwMTgtMjAyNiB0aGUgRGVubyBhdXRob3JzLiBNSVQgbGljZW5zZS5cbi8vIFRoaXMgbW9kdWxlIGlzIGJyb3dzZXIgY29tcGF0aWJsZS5cbmltcG9ydCB7IEFzc2VydGlvbkVycm9yIH0gZnJvbSBcIi4vYXNzZXJ0aW9uX2Vycm9yLnRzXCI7XG5cbi8qKlxuICogTWFrZSBhbiBhc3NlcnRpb24gdGhhdCBhY3R1YWwgaXMgbm90IG51bGwgb3IgdW5kZWZpbmVkLlxuICogSWYgbm90IHRoZW4gdGhyb3cuXG4gKlxuICogQGV4YW1wbGUgVXNhZ2VcbiAqIGBgYHRzIGlnbm9yZVxuICogaW1wb3J0IHsgYXNzZXJ0RXhpc3RzIH0gZnJvbSBcIkBzdGQvYXNzZXJ0XCI7XG4gKlxuICogYXNzZXJ0RXhpc3RzKFwic29tZXRoaW5nXCIpOyAvLyBEb2Vzbid0IHRocm93XG4gKiBhc3NlcnRFeGlzdHModW5kZWZpbmVkKTsgLy8gVGhyb3dzXG4gKiBgYGBcbiAqXG4gKiBAdHlwZVBhcmFtIFQgVGhlIHR5cGUgb2YgdGhlIGFjdHVhbCB2YWx1ZS5cbiAqIEBwYXJhbSBhY3R1YWwgVGhlIGFjdHVhbCB2YWx1ZSB0byBjaGVjay5cbiAqIEBwYXJhbSBtc2cgVGhlIG9wdGlvbmFsIG1lc3NhZ2UgdG8gaW5jbHVkZSBpbiB0aGUgZXJyb3IgaWYgdGhlIGFzc2VydGlvbiBmYWlscy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFzc2VydEV4aXN0czxUPihcbiAgYWN0dWFsOiBULFxuICBtc2c/OiBzdHJpbmcsXG4pOiBhc3NlcnRzIGFjdHVhbCBpcyBOb25OdWxsYWJsZTxUPiB7XG4gIGlmIChhY3R1YWwgPT09IHVuZGVmaW5lZCB8fCBhY3R1YWwgPT09IG51bGwpIHtcbiAgICBjb25zdCBtc2dTdWZmaXggPSBtc2cgPyBgOiAke21zZ31gIDogXCIuXCI7XG4gICAgbXNnID1cbiAgICAgIGBFeHBlY3RlZCBhY3R1YWw6IFwiJHthY3R1YWx9XCIgdG8gbm90IGJlIG51bGwgb3IgdW5kZWZpbmVkJHttc2dTdWZmaXh9YDtcbiAgICB0aHJvdyBuZXcgQXNzZXJ0aW9uRXJyb3IobXNnKTtcbiAgfVxufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLHFEQUFxRDtBQUNyRCxxQ0FBcUM7QUFDckMsU0FBUyxjQUFjLFFBQVEsdUJBQXVCO0FBRXREOzs7Ozs7Ozs7Ozs7Ozs7Q0FlQyxHQUNELE9BQU8sU0FBUyxhQUNkLE1BQVMsRUFDVCxHQUFZO0VBRVosSUFBSSxXQUFXLGFBQWEsV0FBVyxNQUFNO0lBQzNDLE1BQU0sWUFBWSxNQUFNLENBQUMsRUFBRSxFQUFFLEtBQUssR0FBRztJQUNyQyxNQUNFLENBQUMsa0JBQWtCLEVBQUUsT0FBTyw2QkFBNkIsRUFBRSxXQUFXO0lBQ3hFLE1BQU0sSUFBSSxlQUFlO0VBQzNCO0FBQ0YifQ==
// denoCacheMetadata=18095699961759072735,8272499093217555766