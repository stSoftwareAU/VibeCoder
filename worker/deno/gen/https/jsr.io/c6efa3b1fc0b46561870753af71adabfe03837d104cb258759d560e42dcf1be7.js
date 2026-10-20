// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { AssertionError } from "./assertion_error.ts";
/**
 * Forcefully throws a failed assertion.
 *
 * @example Usage
 * ```ts ignore
 * import { fail } from "@std/assert";
 *
 * fail("Deliberately failed!"); // Throws
 * ```
 *
 * @param msg Optional message to include in the error.
 * @returns Never returns, always throws.
 */ export function fail(msg) {
  const msgSuffix = msg ? `: ${msg}` : ".";
  throw new AssertionError(`Failed assertion${msgSuffix}`);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvYXNzZXJ0LzEuMC4xOC9mYWlsLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIENvcHlyaWdodCAyMDE4LTIwMjYgdGhlIERlbm8gYXV0aG9ycy4gTUlUIGxpY2Vuc2UuXG4vLyBUaGlzIG1vZHVsZSBpcyBicm93c2VyIGNvbXBhdGlibGUuXG5pbXBvcnQgeyBBc3NlcnRpb25FcnJvciB9IGZyb20gXCIuL2Fzc2VydGlvbl9lcnJvci50c1wiO1xuXG4vKipcbiAqIEZvcmNlZnVsbHkgdGhyb3dzIGEgZmFpbGVkIGFzc2VydGlvbi5cbiAqXG4gKiBAZXhhbXBsZSBVc2FnZVxuICogYGBgdHMgaWdub3JlXG4gKiBpbXBvcnQgeyBmYWlsIH0gZnJvbSBcIkBzdGQvYXNzZXJ0XCI7XG4gKlxuICogZmFpbChcIkRlbGliZXJhdGVseSBmYWlsZWQhXCIpOyAvLyBUaHJvd3NcbiAqIGBgYFxuICpcbiAqIEBwYXJhbSBtc2cgT3B0aW9uYWwgbWVzc2FnZSB0byBpbmNsdWRlIGluIHRoZSBlcnJvci5cbiAqIEByZXR1cm5zIE5ldmVyIHJldHVybnMsIGFsd2F5cyB0aHJvd3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmYWlsKG1zZz86IHN0cmluZyk6IG5ldmVyIHtcbiAgY29uc3QgbXNnU3VmZml4ID0gbXNnID8gYDogJHttc2d9YCA6IFwiLlwiO1xuICB0aHJvdyBuZXcgQXNzZXJ0aW9uRXJyb3IoYEZhaWxlZCBhc3NlcnRpb24ke21zZ1N1ZmZpeH1gKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxREFBcUQ7QUFDckQscUNBQXFDO0FBQ3JDLFNBQVMsY0FBYyxRQUFRLHVCQUF1QjtBQUV0RDs7Ozs7Ozs7Ozs7O0NBWUMsR0FDRCxPQUFPLFNBQVMsS0FBSyxHQUFZO0VBQy9CLE1BQU0sWUFBWSxNQUFNLENBQUMsRUFBRSxFQUFFLEtBQUssR0FBRztFQUNyQyxNQUFNLElBQUksZUFBZSxDQUFDLGdCQUFnQixFQUFFLFdBQVc7QUFDekQifQ==
// denoCacheMetadata=9611956559247377989,6721615674708625700