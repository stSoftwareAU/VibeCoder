// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { AssertionError } from "./assertion_error.ts";
/**
 * Make an assertion, an error will be thrown if `expr` does not have a truthy value.
 *
 * @example Usage
 * ```ts ignore
 * import { assert } from "@std/assert";
 *
 * assert("hello".includes("ello")); // Doesn't throw
 * assert("hello".includes("world")); // Throws
 * ```
 *
 * @param expr The expression to test.
 * @param msg The optional message to display if the assertion fails.
 * @throws {AssertionError} If `expr` is falsy.
 */ export function assert(expr, msg = "") {
  if (!expr) {
    throw new AssertionError(msg);
  }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvYXNzZXJ0LzEuMC4xOC9hc3NlcnQudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQ29weXJpZ2h0IDIwMTgtMjAyNiB0aGUgRGVubyBhdXRob3JzLiBNSVQgbGljZW5zZS5cbi8vIFRoaXMgbW9kdWxlIGlzIGJyb3dzZXIgY29tcGF0aWJsZS5cbmltcG9ydCB7IEFzc2VydGlvbkVycm9yIH0gZnJvbSBcIi4vYXNzZXJ0aW9uX2Vycm9yLnRzXCI7XG5cbi8qKlxuICogTWFrZSBhbiBhc3NlcnRpb24sIGFuIGVycm9yIHdpbGwgYmUgdGhyb3duIGlmIGBleHByYCBkb2VzIG5vdCBoYXZlIGEgdHJ1dGh5IHZhbHVlLlxuICpcbiAqIEBleGFtcGxlIFVzYWdlXG4gKiBgYGB0cyBpZ25vcmVcbiAqIGltcG9ydCB7IGFzc2VydCB9IGZyb20gXCJAc3RkL2Fzc2VydFwiO1xuICpcbiAqIGFzc2VydChcImhlbGxvXCIuaW5jbHVkZXMoXCJlbGxvXCIpKTsgLy8gRG9lc24ndCB0aHJvd1xuICogYXNzZXJ0KFwiaGVsbG9cIi5pbmNsdWRlcyhcIndvcmxkXCIpKTsgLy8gVGhyb3dzXG4gKiBgYGBcbiAqXG4gKiBAcGFyYW0gZXhwciBUaGUgZXhwcmVzc2lvbiB0byB0ZXN0LlxuICogQHBhcmFtIG1zZyBUaGUgb3B0aW9uYWwgbWVzc2FnZSB0byBkaXNwbGF5IGlmIHRoZSBhc3NlcnRpb24gZmFpbHMuXG4gKiBAdGhyb3dzIHtBc3NlcnRpb25FcnJvcn0gSWYgYGV4cHJgIGlzIGZhbHN5LlxuICovXG5leHBvcnQgZnVuY3Rpb24gYXNzZXJ0KGV4cHI6IHVua25vd24sIG1zZyA9IFwiXCIpOiBhc3NlcnRzIGV4cHIge1xuICBpZiAoIWV4cHIpIHtcbiAgICB0aHJvdyBuZXcgQXNzZXJ0aW9uRXJyb3IobXNnKTtcbiAgfVxufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLHFEQUFxRDtBQUNyRCxxQ0FBcUM7QUFDckMsU0FBUyxjQUFjLFFBQVEsdUJBQXVCO0FBRXREOzs7Ozs7Ozs7Ozs7OztDQWNDLEdBQ0QsT0FBTyxTQUFTLE9BQU8sSUFBYSxFQUFFLE1BQU0sRUFBRTtFQUM1QyxJQUFJLENBQUMsTUFBTTtJQUNULE1BQU0sSUFBSSxlQUFlO0VBQzNCO0FBQ0YifQ==
// denoCacheMetadata=15685464841706730133,13099915317899538299