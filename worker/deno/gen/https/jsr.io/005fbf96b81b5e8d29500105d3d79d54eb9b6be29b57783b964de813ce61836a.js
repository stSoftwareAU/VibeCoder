// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { AssertionError } from "./assertion_error.ts";
/**
 * Use this to stub out methods that will throw when invoked.
 *
 * @example Usage
 * ```ts ignore
 * import { unimplemented } from "@std/assert";
 *
 * unimplemented(); // Throws
 * ```
 *
 * @param msg Optional message to include in the error.
 * @returns Never returns, always throws.
 */ export function unimplemented(msg) {
  const msgSuffix = msg ? `: ${msg}` : ".";
  throw new AssertionError(`Unimplemented${msgSuffix}`);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvYXNzZXJ0LzEuMC4xOC91bmltcGxlbWVudGVkLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIENvcHlyaWdodCAyMDE4LTIwMjYgdGhlIERlbm8gYXV0aG9ycy4gTUlUIGxpY2Vuc2UuXG4vLyBUaGlzIG1vZHVsZSBpcyBicm93c2VyIGNvbXBhdGlibGUuXG5pbXBvcnQgeyBBc3NlcnRpb25FcnJvciB9IGZyb20gXCIuL2Fzc2VydGlvbl9lcnJvci50c1wiO1xuXG4vKipcbiAqIFVzZSB0aGlzIHRvIHN0dWIgb3V0IG1ldGhvZHMgdGhhdCB3aWxsIHRocm93IHdoZW4gaW52b2tlZC5cbiAqXG4gKiBAZXhhbXBsZSBVc2FnZVxuICogYGBgdHMgaWdub3JlXG4gKiBpbXBvcnQgeyB1bmltcGxlbWVudGVkIH0gZnJvbSBcIkBzdGQvYXNzZXJ0XCI7XG4gKlxuICogdW5pbXBsZW1lbnRlZCgpOyAvLyBUaHJvd3NcbiAqIGBgYFxuICpcbiAqIEBwYXJhbSBtc2cgT3B0aW9uYWwgbWVzc2FnZSB0byBpbmNsdWRlIGluIHRoZSBlcnJvci5cbiAqIEByZXR1cm5zIE5ldmVyIHJldHVybnMsIGFsd2F5cyB0aHJvd3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB1bmltcGxlbWVudGVkKG1zZz86IHN0cmluZyk6IG5ldmVyIHtcbiAgY29uc3QgbXNnU3VmZml4ID0gbXNnID8gYDogJHttc2d9YCA6IFwiLlwiO1xuICB0aHJvdyBuZXcgQXNzZXJ0aW9uRXJyb3IoYFVuaW1wbGVtZW50ZWQke21zZ1N1ZmZpeH1gKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxREFBcUQ7QUFDckQscUNBQXFDO0FBQ3JDLFNBQVMsY0FBYyxRQUFRLHVCQUF1QjtBQUV0RDs7Ozs7Ozs7Ozs7O0NBWUMsR0FDRCxPQUFPLFNBQVMsY0FBYyxHQUFZO0VBQ3hDLE1BQU0sWUFBWSxNQUFNLENBQUMsRUFBRSxFQUFFLEtBQUssR0FBRztFQUNyQyxNQUFNLElBQUksZUFBZSxDQUFDLGFBQWEsRUFBRSxXQUFXO0FBQ3REIn0=
// denoCacheMetadata=9280427522850832283,14501315621201536448