// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
/** A library of assertion functions.
 * If the assertion is false an `AssertionError` will be thrown which will
 * result in pretty-printed diff of the failing assertion.
 *
 * This module is browser compatible, but do not rely on good formatting of
 * values for AssertionError messages in browsers.
 *
 * ```ts ignore
 * import { assert } from "@std/assert";
 *
 * assert("I am truthy"); // Doesn't throw
 * assert(false); // Throws `AssertionError`
 * ```
 *
 * @module
 */ export * from "./almost_equals.ts";
export * from "./array_includes.ts";
export * from "./equals.ts";
export * from "./exists.ts";
export * from "./false.ts";
export * from "./greater_or_equal.ts";
export * from "./greater.ts";
export * from "./instance_of.ts";
export * from "./is_error.ts";
export * from "./less_or_equal.ts";
export * from "./less.ts";
export * from "./match.ts";
export * from "./not_equals.ts";
export * from "./not_instance_of.ts";
export * from "./not_match.ts";
export * from "./not_strict_equals.ts";
export * from "./object_match.ts";
export * from "./rejects.ts";
export * from "./strict_equals.ts";
export * from "./string_includes.ts";
export * from "./throws.ts";
export * from "./assert.ts";
export * from "./assertion_error.ts";
export * from "./equal.ts";
export * from "./fail.ts";
export * from "./unimplemented.ts";
export * from "./unreachable.ts";
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvYXNzZXJ0LzEuMC4xOC9tb2QudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQ29weXJpZ2h0IDIwMTgtMjAyNiB0aGUgRGVubyBhdXRob3JzLiBNSVQgbGljZW5zZS5cbi8vIFRoaXMgbW9kdWxlIGlzIGJyb3dzZXIgY29tcGF0aWJsZS5cblxuLyoqIEEgbGlicmFyeSBvZiBhc3NlcnRpb24gZnVuY3Rpb25zLlxuICogSWYgdGhlIGFzc2VydGlvbiBpcyBmYWxzZSBhbiBgQXNzZXJ0aW9uRXJyb3JgIHdpbGwgYmUgdGhyb3duIHdoaWNoIHdpbGxcbiAqIHJlc3VsdCBpbiBwcmV0dHktcHJpbnRlZCBkaWZmIG9mIHRoZSBmYWlsaW5nIGFzc2VydGlvbi5cbiAqXG4gKiBUaGlzIG1vZHVsZSBpcyBicm93c2VyIGNvbXBhdGlibGUsIGJ1dCBkbyBub3QgcmVseSBvbiBnb29kIGZvcm1hdHRpbmcgb2ZcbiAqIHZhbHVlcyBmb3IgQXNzZXJ0aW9uRXJyb3IgbWVzc2FnZXMgaW4gYnJvd3NlcnMuXG4gKlxuICogYGBgdHMgaWdub3JlXG4gKiBpbXBvcnQgeyBhc3NlcnQgfSBmcm9tIFwiQHN0ZC9hc3NlcnRcIjtcbiAqXG4gKiBhc3NlcnQoXCJJIGFtIHRydXRoeVwiKTsgLy8gRG9lc24ndCB0aHJvd1xuICogYXNzZXJ0KGZhbHNlKTsgLy8gVGhyb3dzIGBBc3NlcnRpb25FcnJvcmBcbiAqIGBgYFxuICpcbiAqIEBtb2R1bGVcbiAqL1xuXG5leHBvcnQgKiBmcm9tIFwiLi9hbG1vc3RfZXF1YWxzLnRzXCI7XG5leHBvcnQgKiBmcm9tIFwiLi9hcnJheV9pbmNsdWRlcy50c1wiO1xuZXhwb3J0ICogZnJvbSBcIi4vZXF1YWxzLnRzXCI7XG5leHBvcnQgKiBmcm9tIFwiLi9leGlzdHMudHNcIjtcbmV4cG9ydCAqIGZyb20gXCIuL2ZhbHNlLnRzXCI7XG5leHBvcnQgKiBmcm9tIFwiLi9ncmVhdGVyX29yX2VxdWFsLnRzXCI7XG5leHBvcnQgKiBmcm9tIFwiLi9ncmVhdGVyLnRzXCI7XG5leHBvcnQgKiBmcm9tIFwiLi9pbnN0YW5jZV9vZi50c1wiO1xuZXhwb3J0ICogZnJvbSBcIi4vaXNfZXJyb3IudHNcIjtcbmV4cG9ydCAqIGZyb20gXCIuL2xlc3Nfb3JfZXF1YWwudHNcIjtcbmV4cG9ydCAqIGZyb20gXCIuL2xlc3MudHNcIjtcbmV4cG9ydCAqIGZyb20gXCIuL21hdGNoLnRzXCI7XG5leHBvcnQgKiBmcm9tIFwiLi9ub3RfZXF1YWxzLnRzXCI7XG5leHBvcnQgKiBmcm9tIFwiLi9ub3RfaW5zdGFuY2Vfb2YudHNcIjtcbmV4cG9ydCAqIGZyb20gXCIuL25vdF9tYXRjaC50c1wiO1xuZXhwb3J0ICogZnJvbSBcIi4vbm90X3N0cmljdF9lcXVhbHMudHNcIjtcbmV4cG9ydCAqIGZyb20gXCIuL29iamVjdF9tYXRjaC50c1wiO1xuZXhwb3J0ICogZnJvbSBcIi4vcmVqZWN0cy50c1wiO1xuZXhwb3J0ICogZnJvbSBcIi4vc3RyaWN0X2VxdWFscy50c1wiO1xuZXhwb3J0ICogZnJvbSBcIi4vc3RyaW5nX2luY2x1ZGVzLnRzXCI7XG5leHBvcnQgKiBmcm9tIFwiLi90aHJvd3MudHNcIjtcbmV4cG9ydCAqIGZyb20gXCIuL2Fzc2VydC50c1wiO1xuZXhwb3J0ICogZnJvbSBcIi4vYXNzZXJ0aW9uX2Vycm9yLnRzXCI7XG5leHBvcnQgKiBmcm9tIFwiLi9lcXVhbC50c1wiO1xuZXhwb3J0ICogZnJvbSBcIi4vZmFpbC50c1wiO1xuZXhwb3J0ICogZnJvbSBcIi4vdW5pbXBsZW1lbnRlZC50c1wiO1xuZXhwb3J0ICogZnJvbSBcIi4vdW5yZWFjaGFibGUudHNcIjtcbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxREFBcUQ7QUFDckQscUNBQXFDO0FBRXJDOzs7Ozs7Ozs7Ozs7Ozs7Q0FlQyxHQUVELGNBQWMscUJBQXFCO0FBQ25DLGNBQWMsc0JBQXNCO0FBQ3BDLGNBQWMsY0FBYztBQUM1QixjQUFjLGNBQWM7QUFDNUIsY0FBYyxhQUFhO0FBQzNCLGNBQWMsd0JBQXdCO0FBQ3RDLGNBQWMsZUFBZTtBQUM3QixjQUFjLG1CQUFtQjtBQUNqQyxjQUFjLGdCQUFnQjtBQUM5QixjQUFjLHFCQUFxQjtBQUNuQyxjQUFjLFlBQVk7QUFDMUIsY0FBYyxhQUFhO0FBQzNCLGNBQWMsa0JBQWtCO0FBQ2hDLGNBQWMsdUJBQXVCO0FBQ3JDLGNBQWMsaUJBQWlCO0FBQy9CLGNBQWMseUJBQXlCO0FBQ3ZDLGNBQWMsb0JBQW9CO0FBQ2xDLGNBQWMsZUFBZTtBQUM3QixjQUFjLHFCQUFxQjtBQUNuQyxjQUFjLHVCQUF1QjtBQUNyQyxjQUFjLGNBQWM7QUFDNUIsY0FBYyxjQUFjO0FBQzVCLGNBQWMsdUJBQXVCO0FBQ3JDLGNBQWMsYUFBYTtBQUMzQixjQUFjLFlBQVk7QUFDMUIsY0FBYyxxQkFBcUI7QUFDbkMsY0FBYyxtQkFBbUIifQ==
// denoCacheMetadata=15022488947574211552,3491902006765561234