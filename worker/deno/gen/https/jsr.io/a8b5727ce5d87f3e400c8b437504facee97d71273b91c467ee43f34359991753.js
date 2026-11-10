// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
/**
 * Error thrown when an assertion fails.
 *
 * @example Usage
 * ```ts ignore
 * import { AssertionError } from "@std/assert";
 *
 * try {
 *   throw new AssertionError("foo", { cause: "bar" });
 * } catch (error) {
 *   if (error instanceof AssertionError) {
 *     error.message === "foo"; // true
 *     error.cause === "bar"; // true
 *   }
 * }
 * ```
 */ export class AssertionError extends Error {
  /** Constructs a new instance.
   *
   * @param message The error message.
   * @param options Additional options. This argument is still unstable. It may change in the future release.
   */ constructor(message, options){
    super(message, options);
    this.name = "AssertionError";
  }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvYXNzZXJ0LzEuMC4xOC9hc3NlcnRpb25fZXJyb3IudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQ29weXJpZ2h0IDIwMTgtMjAyNiB0aGUgRGVubyBhdXRob3JzLiBNSVQgbGljZW5zZS5cbi8vIFRoaXMgbW9kdWxlIGlzIGJyb3dzZXIgY29tcGF0aWJsZS5cblxuLyoqXG4gKiBFcnJvciB0aHJvd24gd2hlbiBhbiBhc3NlcnRpb24gZmFpbHMuXG4gKlxuICogQGV4YW1wbGUgVXNhZ2VcbiAqIGBgYHRzIGlnbm9yZVxuICogaW1wb3J0IHsgQXNzZXJ0aW9uRXJyb3IgfSBmcm9tIFwiQHN0ZC9hc3NlcnRcIjtcbiAqXG4gKiB0cnkge1xuICogICB0aHJvdyBuZXcgQXNzZXJ0aW9uRXJyb3IoXCJmb29cIiwgeyBjYXVzZTogXCJiYXJcIiB9KTtcbiAqIH0gY2F0Y2ggKGVycm9yKSB7XG4gKiAgIGlmIChlcnJvciBpbnN0YW5jZW9mIEFzc2VydGlvbkVycm9yKSB7XG4gKiAgICAgZXJyb3IubWVzc2FnZSA9PT0gXCJmb29cIjsgLy8gdHJ1ZVxuICogICAgIGVycm9yLmNhdXNlID09PSBcImJhclwiOyAvLyB0cnVlXG4gKiAgIH1cbiAqIH1cbiAqIGBgYFxuICovXG5leHBvcnQgY2xhc3MgQXNzZXJ0aW9uRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIC8qKiBDb25zdHJ1Y3RzIGEgbmV3IGluc3RhbmNlLlxuICAgKlxuICAgKiBAcGFyYW0gbWVzc2FnZSBUaGUgZXJyb3IgbWVzc2FnZS5cbiAgICogQHBhcmFtIG9wdGlvbnMgQWRkaXRpb25hbCBvcHRpb25zLiBUaGlzIGFyZ3VtZW50IGlzIHN0aWxsIHVuc3RhYmxlLiBJdCBtYXkgY2hhbmdlIGluIHRoZSBmdXR1cmUgcmVsZWFzZS5cbiAgICovXG4gIGNvbnN0cnVjdG9yKG1lc3NhZ2U6IHN0cmluZywgb3B0aW9ucz86IEVycm9yT3B0aW9ucykge1xuICAgIHN1cGVyKG1lc3NhZ2UsIG9wdGlvbnMpO1xuICAgIHRoaXMubmFtZSA9IFwiQXNzZXJ0aW9uRXJyb3JcIjtcbiAgfVxufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLHFEQUFxRDtBQUNyRCxxQ0FBcUM7QUFFckM7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FnQkMsR0FDRCxPQUFPLE1BQU0sdUJBQXVCO0VBQ2xDOzs7O0dBSUMsR0FDRCxZQUFZLE9BQWUsRUFBRSxPQUFzQixDQUFFO0lBQ25ELEtBQUssQ0FBQyxTQUFTO0lBQ2YsSUFBSSxDQUFDLElBQUksR0FBRztFQUNkO0FBQ0YifQ==
// denoCacheMetadata=15157343324490443401,4045237885508269870