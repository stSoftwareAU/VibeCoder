// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { AssertionError } from "./assertion_error.ts";
/**
 * Use this to assert unreachable code.
 *
 * @example Usage
 * ```ts ignore
 * import { unreachable } from "@std/assert";
 *
 * unreachable(); // Throws
 * ```
 *
 * @param msg Optional message to include in the error.
 * @returns Never returns, always throws.
 */ export function unreachable(msg) {
  const msgSuffix = msg ? `: ${msg}` : ".";
  throw new AssertionError(`Unreachable${msgSuffix}`);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvYXNzZXJ0LzEuMC4xOC91bnJlYWNoYWJsZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBDb3B5cmlnaHQgMjAxOC0yMDI2IHRoZSBEZW5vIGF1dGhvcnMuIE1JVCBsaWNlbnNlLlxuLy8gVGhpcyBtb2R1bGUgaXMgYnJvd3NlciBjb21wYXRpYmxlLlxuaW1wb3J0IHsgQXNzZXJ0aW9uRXJyb3IgfSBmcm9tIFwiLi9hc3NlcnRpb25fZXJyb3IudHNcIjtcblxuLyoqXG4gKiBVc2UgdGhpcyB0byBhc3NlcnQgdW5yZWFjaGFibGUgY29kZS5cbiAqXG4gKiBAZXhhbXBsZSBVc2FnZVxuICogYGBgdHMgaWdub3JlXG4gKiBpbXBvcnQgeyB1bnJlYWNoYWJsZSB9IGZyb20gXCJAc3RkL2Fzc2VydFwiO1xuICpcbiAqIHVucmVhY2hhYmxlKCk7IC8vIFRocm93c1xuICogYGBgXG4gKlxuICogQHBhcmFtIG1zZyBPcHRpb25hbCBtZXNzYWdlIHRvIGluY2x1ZGUgaW4gdGhlIGVycm9yLlxuICogQHJldHVybnMgTmV2ZXIgcmV0dXJucywgYWx3YXlzIHRocm93cy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHVucmVhY2hhYmxlKG1zZz86IHN0cmluZyk6IG5ldmVyIHtcbiAgY29uc3QgbXNnU3VmZml4ID0gbXNnID8gYDogJHttc2d9YCA6IFwiLlwiO1xuICB0aHJvdyBuZXcgQXNzZXJ0aW9uRXJyb3IoYFVucmVhY2hhYmxlJHttc2dTdWZmaXh9YCk7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEscURBQXFEO0FBQ3JELHFDQUFxQztBQUNyQyxTQUFTLGNBQWMsUUFBUSx1QkFBdUI7QUFFdEQ7Ozs7Ozs7Ozs7OztDQVlDLEdBQ0QsT0FBTyxTQUFTLFlBQVksR0FBWTtFQUN0QyxNQUFNLFlBQVksTUFBTSxDQUFDLEVBQUUsRUFBRSxLQUFLLEdBQUc7RUFDckMsTUFBTSxJQUFJLGVBQWUsQ0FBQyxXQUFXLEVBQUUsV0FBVztBQUNwRCJ9
// denoCacheMetadata=15010736144767877601,7617853981012152077