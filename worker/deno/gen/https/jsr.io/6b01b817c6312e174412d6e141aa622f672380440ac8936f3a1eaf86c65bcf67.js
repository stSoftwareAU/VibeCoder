// Ported from js-yaml v3.13.1:
// https://github.com/nodeca/js-yaml/commit/665aadda42349dcae869f12040d9b10ef18d12da
// Copyright 2011-2015 by Vitaly Puzrin. All rights reserved. MIT license.
// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { isEOL } from "./_chars.ts";
import { LoaderState } from "./_loader_state.ts";
import { SCHEMA_MAP } from "./_schema.ts";
function sanitizeInput(input) {
  input = String(input);
  if (input.length > 0) {
    // Add trailing `\n` if not exists
    if (!isEOL(input.charCodeAt(input.length - 1))) input += "\n";
    // Strip BOM
    if (input.charCodeAt(0) === 0xfeff) input = input.slice(1);
  }
  return input;
}
/**
 * Parse and return a YAML string as a parsed YAML document object.
 *
 * Note: This does not support functions. Untrusted data is safe to parse.
 *
 * @example Usage
 * ```ts
 * import { parse } from "@std/yaml/parse";
 * import { assertEquals } from "@std/assert";
 *
 * const data = parse(`
 * id: 1
 * name: Alice
 * `);
 *
 * assertEquals(data, { id: 1, name: "Alice" });
 * ```
 *
 * @throws {SyntaxError} Throws error on invalid YAML.
 * @param content YAML string to parse.
 * @param options Parsing options.
 * @returns Parsed document.
 */ export function parse(content, options = {}) {
  content = sanitizeInput(content);
  const state = new LoaderState(content, {
    ...options,
    schema: SCHEMA_MAP.get(options.schema)
  });
  const documentGenerator = state.readDocuments();
  const document = documentGenerator.next().value;
  if (!documentGenerator.next().done) {
    throw new SyntaxError("Found more than 1 document in the stream: expected a single document");
  }
  return document ?? null;
}
/**
 * Same as {@linkcode parse}, but understands multi-document YAML sources, and
 * returns multiple parsed YAML document objects.
 *
 * @example Usage
 * ```ts
 * import { parseAll } from "@std/yaml/parse";
 * import { assertEquals } from "@std/assert";
 *
 * const data = parseAll(`
 * ---
 * id: 1
 * name: Alice
 * ---
 * id: 2
 * name: Bob
 * ---
 * id: 3
 * name: Eve
 * `);
 * assertEquals(data, [ { id: 1, name: "Alice" }, { id: 2, name: "Bob" }, { id: 3, name: "Eve" }]);
 * ```
 *
 * @param content YAML string to parse.
 * @param options Parsing options.
 * @returns Array of parsed documents.
 */ export function parseAll(content, options = {}) {
  content = sanitizeInput(content);
  const state = new LoaderState(content, {
    ...options,
    schema: SCHEMA_MAP.get(options.schema)
  });
  return [
    ...state.readDocuments()
  ];
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQveWFtbC8xLjAuMTIvcGFyc2UudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gUG9ydGVkIGZyb20ganMteWFtbCB2My4xMy4xOlxuLy8gaHR0cHM6Ly9naXRodWIuY29tL25vZGVjYS9qcy15YW1sL2NvbW1pdC82NjVhYWRkYTQyMzQ5ZGNhZTg2OWYxMjA0MGQ5YjEwZWYxOGQxMmRhXG4vLyBDb3B5cmlnaHQgMjAxMS0yMDE1IGJ5IFZpdGFseSBQdXpyaW4uIEFsbCByaWdodHMgcmVzZXJ2ZWQuIE1JVCBsaWNlbnNlLlxuLy8gQ29weXJpZ2h0IDIwMTgtMjAyNiB0aGUgRGVubyBhdXRob3JzLiBNSVQgbGljZW5zZS5cbi8vIFRoaXMgbW9kdWxlIGlzIGJyb3dzZXIgY29tcGF0aWJsZS5cblxuaW1wb3J0IHsgaXNFT0wgfSBmcm9tIFwiLi9fY2hhcnMudHNcIjtcbmltcG9ydCB7IExvYWRlclN0YXRlIH0gZnJvbSBcIi4vX2xvYWRlcl9zdGF0ZS50c1wiO1xuaW1wb3J0IHsgU0NIRU1BX01BUCwgdHlwZSBTY2hlbWFUeXBlIH0gZnJvbSBcIi4vX3NjaGVtYS50c1wiO1xuXG5leHBvcnQgdHlwZSB7IFNjaGVtYVR5cGUgfTtcblxuLyoqIE9wdGlvbnMgZm9yIHtAbGlua2NvZGUgcGFyc2V9LiAqL1xuZXhwb3J0IGludGVyZmFjZSBQYXJzZU9wdGlvbnMge1xuICAvKipcbiAgICogTmFtZSBvZiB0aGUgc2NoZW1hIHRvIHVzZS5cbiAgICpcbiAgICogQGRlZmF1bHQge1wiZGVmYXVsdFwifVxuICAgKi9cbiAgc2NoZW1hPzogU2NoZW1hVHlwZTtcbiAgLyoqXG4gICAqIElmIGB0cnVlYCwgZHVwbGljYXRlIGtleXMgd2lsbCBvdmVyd3JpdGUgcHJldmlvdXMgdmFsdWVzLiBPdGhlcndpc2UsXG4gICAqIGR1cGxpY2F0ZSBrZXlzIHdpbGwgdGhyb3cgYSB7QGxpbmtjb2RlIFN5bnRheEVycm9yfS5cbiAgICpcbiAgICogQGRlZmF1bHQge2ZhbHNlfVxuICAgKi9cbiAgYWxsb3dEdXBsaWNhdGVLZXlzPzogYm9vbGVhbjtcbiAgLyoqXG4gICAqIElmIGRlZmluZWQsIGEgZnVuY3Rpb24gdG8gY2FsbCBvbiB3YXJuaW5nIG1lc3NhZ2VzIHRha2luZyBhblxuICAgKiB7QGxpbmtjb2RlIEVycm9yfSBhcyBpdHMgb25seSBhcmd1bWVudC5cbiAgICovXG4gIG9uV2FybmluZz8oZXJyb3I6IEVycm9yKTogdm9pZDtcbn1cblxuZnVuY3Rpb24gc2FuaXRpemVJbnB1dChpbnB1dDogc3RyaW5nKSB7XG4gIGlucHV0ID0gU3RyaW5nKGlucHV0KTtcblxuICBpZiAoaW5wdXQubGVuZ3RoID4gMCkge1xuICAgIC8vIEFkZCB0cmFpbGluZyBgXFxuYCBpZiBub3QgZXhpc3RzXG4gICAgaWYgKCFpc0VPTChpbnB1dC5jaGFyQ29kZUF0KGlucHV0Lmxlbmd0aCAtIDEpKSkgaW5wdXQgKz0gXCJcXG5cIjtcblxuICAgIC8vIFN0cmlwIEJPTVxuICAgIGlmIChpbnB1dC5jaGFyQ29kZUF0KDApID09PSAweGZlZmYpIGlucHV0ID0gaW5wdXQuc2xpY2UoMSk7XG4gIH1cblxuICByZXR1cm4gaW5wdXQ7XG59XG5cbi8qKlxuICogUGFyc2UgYW5kIHJldHVybiBhIFlBTUwgc3RyaW5nIGFzIGEgcGFyc2VkIFlBTUwgZG9jdW1lbnQgb2JqZWN0LlxuICpcbiAqIE5vdGU6IFRoaXMgZG9lcyBub3Qgc3VwcG9ydCBmdW5jdGlvbnMuIFVudHJ1c3RlZCBkYXRhIGlzIHNhZmUgdG8gcGFyc2UuXG4gKlxuICogQGV4YW1wbGUgVXNhZ2VcbiAqIGBgYHRzXG4gKiBpbXBvcnQgeyBwYXJzZSB9IGZyb20gXCJAc3RkL3lhbWwvcGFyc2VcIjtcbiAqIGltcG9ydCB7IGFzc2VydEVxdWFscyB9IGZyb20gXCJAc3RkL2Fzc2VydFwiO1xuICpcbiAqIGNvbnN0IGRhdGEgPSBwYXJzZShgXG4gKiBpZDogMVxuICogbmFtZTogQWxpY2VcbiAqIGApO1xuICpcbiAqIGFzc2VydEVxdWFscyhkYXRhLCB7IGlkOiAxLCBuYW1lOiBcIkFsaWNlXCIgfSk7XG4gKiBgYGBcbiAqXG4gKiBAdGhyb3dzIHtTeW50YXhFcnJvcn0gVGhyb3dzIGVycm9yIG9uIGludmFsaWQgWUFNTC5cbiAqIEBwYXJhbSBjb250ZW50IFlBTUwgc3RyaW5nIHRvIHBhcnNlLlxuICogQHBhcmFtIG9wdGlvbnMgUGFyc2luZyBvcHRpb25zLlxuICogQHJldHVybnMgUGFyc2VkIGRvY3VtZW50LlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2UoXG4gIGNvbnRlbnQ6IHN0cmluZyxcbiAgb3B0aW9uczogUGFyc2VPcHRpb25zID0ge30sXG4pOiB1bmtub3duIHtcbiAgY29udGVudCA9IHNhbml0aXplSW5wdXQoY29udGVudCk7XG4gIGNvbnN0IHN0YXRlID0gbmV3IExvYWRlclN0YXRlKGNvbnRlbnQsIHtcbiAgICAuLi5vcHRpb25zLFxuICAgIHNjaGVtYTogU0NIRU1BX01BUC5nZXQob3B0aW9ucy5zY2hlbWEhKSEsXG4gIH0pO1xuICBjb25zdCBkb2N1bWVudEdlbmVyYXRvciA9IHN0YXRlLnJlYWREb2N1bWVudHMoKTtcbiAgY29uc3QgZG9jdW1lbnQgPSBkb2N1bWVudEdlbmVyYXRvci5uZXh0KCkudmFsdWU7XG4gIGlmICghZG9jdW1lbnRHZW5lcmF0b3IubmV4dCgpLmRvbmUpIHtcbiAgICB0aHJvdyBuZXcgU3ludGF4RXJyb3IoXG4gICAgICBcIkZvdW5kIG1vcmUgdGhhbiAxIGRvY3VtZW50IGluIHRoZSBzdHJlYW06IGV4cGVjdGVkIGEgc2luZ2xlIGRvY3VtZW50XCIsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gZG9jdW1lbnQgPz8gbnVsbDtcbn1cblxuLyoqXG4gKiBTYW1lIGFzIHtAbGlua2NvZGUgcGFyc2V9LCBidXQgdW5kZXJzdGFuZHMgbXVsdGktZG9jdW1lbnQgWUFNTCBzb3VyY2VzLCBhbmRcbiAqIHJldHVybnMgbXVsdGlwbGUgcGFyc2VkIFlBTUwgZG9jdW1lbnQgb2JqZWN0cy5cbiAqXG4gKiBAZXhhbXBsZSBVc2FnZVxuICogYGBgdHNcbiAqIGltcG9ydCB7IHBhcnNlQWxsIH0gZnJvbSBcIkBzdGQveWFtbC9wYXJzZVwiO1xuICogaW1wb3J0IHsgYXNzZXJ0RXF1YWxzIH0gZnJvbSBcIkBzdGQvYXNzZXJ0XCI7XG4gKlxuICogY29uc3QgZGF0YSA9IHBhcnNlQWxsKGBcbiAqIC0tLVxuICogaWQ6IDFcbiAqIG5hbWU6IEFsaWNlXG4gKiAtLS1cbiAqIGlkOiAyXG4gKiBuYW1lOiBCb2JcbiAqIC0tLVxuICogaWQ6IDNcbiAqIG5hbWU6IEV2ZVxuICogYCk7XG4gKiBhc3NlcnRFcXVhbHMoZGF0YSwgWyB7IGlkOiAxLCBuYW1lOiBcIkFsaWNlXCIgfSwgeyBpZDogMiwgbmFtZTogXCJCb2JcIiB9LCB7IGlkOiAzLCBuYW1lOiBcIkV2ZVwiIH1dKTtcbiAqIGBgYFxuICpcbiAqIEBwYXJhbSBjb250ZW50IFlBTUwgc3RyaW5nIHRvIHBhcnNlLlxuICogQHBhcmFtIG9wdGlvbnMgUGFyc2luZyBvcHRpb25zLlxuICogQHJldHVybnMgQXJyYXkgb2YgcGFyc2VkIGRvY3VtZW50cy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQWxsKGNvbnRlbnQ6IHN0cmluZywgb3B0aW9uczogUGFyc2VPcHRpb25zID0ge30pOiB1bmtub3duIHtcbiAgY29udGVudCA9IHNhbml0aXplSW5wdXQoY29udGVudCk7XG4gIGNvbnN0IHN0YXRlID0gbmV3IExvYWRlclN0YXRlKGNvbnRlbnQsIHtcbiAgICAuLi5vcHRpb25zLFxuICAgIHNjaGVtYTogU0NIRU1BX01BUC5nZXQob3B0aW9ucy5zY2hlbWEhKSEsXG4gIH0pO1xuICByZXR1cm4gWy4uLnN0YXRlLnJlYWREb2N1bWVudHMoKV07XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsK0JBQStCO0FBQy9CLG9GQUFvRjtBQUNwRiwwRUFBMEU7QUFDMUUscURBQXFEO0FBQ3JELHFDQUFxQztBQUVyQyxTQUFTLEtBQUssUUFBUSxjQUFjO0FBQ3BDLFNBQVMsV0FBVyxRQUFRLHFCQUFxQjtBQUNqRCxTQUFTLFVBQVUsUUFBeUIsZUFBZTtBQTBCM0QsU0FBUyxjQUFjLEtBQWE7RUFDbEMsUUFBUSxPQUFPO0VBRWYsSUFBSSxNQUFNLE1BQU0sR0FBRyxHQUFHO0lBQ3BCLGtDQUFrQztJQUNsQyxJQUFJLENBQUMsTUFBTSxNQUFNLFVBQVUsQ0FBQyxNQUFNLE1BQU0sR0FBRyxLQUFLLFNBQVM7SUFFekQsWUFBWTtJQUNaLElBQUksTUFBTSxVQUFVLENBQUMsT0FBTyxRQUFRLFFBQVEsTUFBTSxLQUFLLENBQUM7RUFDMUQ7RUFFQSxPQUFPO0FBQ1Q7QUFFQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQXNCQyxHQUNELE9BQU8sU0FBUyxNQUNkLE9BQWUsRUFDZixVQUF3QixDQUFDLENBQUM7RUFFMUIsVUFBVSxjQUFjO0VBQ3hCLE1BQU0sUUFBUSxJQUFJLFlBQVksU0FBUztJQUNyQyxHQUFHLE9BQU87SUFDVixRQUFRLFdBQVcsR0FBRyxDQUFDLFFBQVEsTUFBTTtFQUN2QztFQUNBLE1BQU0sb0JBQW9CLE1BQU0sYUFBYTtFQUM3QyxNQUFNLFdBQVcsa0JBQWtCLElBQUksR0FBRyxLQUFLO0VBQy9DLElBQUksQ0FBQyxrQkFBa0IsSUFBSSxHQUFHLElBQUksRUFBRTtJQUNsQyxNQUFNLElBQUksWUFDUjtFQUVKO0VBQ0EsT0FBTyxZQUFZO0FBQ3JCO0FBRUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBMEJDLEdBQ0QsT0FBTyxTQUFTLFNBQVMsT0FBZSxFQUFFLFVBQXdCLENBQUMsQ0FBQztFQUNsRSxVQUFVLGNBQWM7RUFDeEIsTUFBTSxRQUFRLElBQUksWUFBWSxTQUFTO0lBQ3JDLEdBQUcsT0FBTztJQUNWLFFBQVEsV0FBVyxHQUFHLENBQUMsUUFBUSxNQUFNO0VBQ3ZDO0VBQ0EsT0FBTztPQUFJLE1BQU0sYUFBYTtHQUFHO0FBQ25DIn0=
// denoCacheMetadata=1682123678616494601,265208708980865362