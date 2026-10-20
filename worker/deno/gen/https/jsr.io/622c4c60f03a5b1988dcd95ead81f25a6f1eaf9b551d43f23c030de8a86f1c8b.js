// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { equal } from "./equal.ts";
import { format } from "jsr:@std/internal@^1.0.12/format";
import { AssertionError } from "./assertion_error.ts";
function isPrimitive(value) {
  return value === null || typeof value !== "object" && typeof value !== "function";
}
/**
 * Asserts that `actual` contains all values in `expected`, using deep equality
 * for non-primitive values.
 *
 * @example Usage with primitives
 * ```ts ignore
 * import { assertArrayIncludes } from "@std/assert";
 *
 * assertArrayIncludes([1, 2, 3], [2, 3]); // Passes
 * assertArrayIncludes([1, 2, 3], [4]); // Throws
 * ```
 *
 * @example Usage with objects (deep equality)
 * ```ts ignore
 * import { assertArrayIncludes } from "@std/assert";
 *
 * assertArrayIncludes([{ a: 1 }, { b: 2 }], [{ a: 1 }]); // Passes
 * ```
 *
 * @typeParam T The element type of the arrays.
 * @param actual The array-like object to search within.
 * @param expected The values that must be present in `actual`.
 * @param msg Optional message to display on failure.
 * @throws {AssertionError} If any value in `expected` is not found in `actual`.
 */ export function assertArrayIncludes(actual, expected, msg) {
  const missing = [];
  const expectedLen = expected.length;
  const actualLen = actual.length;
  for(let i = 0; i < expectedLen; i++){
    const item = expected[i];
    let found;
    if (isPrimitive(item)) {
      // Fast path
      found = Array.prototype.includes.call(actual, item);
    } else {
      found = false;
      for(let j = 0; j < actualLen; j++){
        if (equal(item, actual[j])) {
          found = true;
          break;
        }
      }
    }
    if (!found) {
      missing.push(item);
    }
  }
  if (missing.length === 0) {
    return;
  }
  const msgSuffix = msg ? `: ${msg}` : ".";
  msg = `Expected actual: "${format(actual)}" to include: "${format(expected)}"${msgSuffix}\nmissing: ${format(missing)}`;
  throw new AssertionError(msg);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvYXNzZXJ0LzEuMC4xOC9hcnJheV9pbmNsdWRlcy50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBDb3B5cmlnaHQgMjAxOC0yMDI2IHRoZSBEZW5vIGF1dGhvcnMuIE1JVCBsaWNlbnNlLlxuLy8gVGhpcyBtb2R1bGUgaXMgYnJvd3NlciBjb21wYXRpYmxlLlxuaW1wb3J0IHsgZXF1YWwgfSBmcm9tIFwiLi9lcXVhbC50c1wiO1xuaW1wb3J0IHsgZm9ybWF0IH0gZnJvbSBcImpzcjpAc3RkL2ludGVybmFsQF4xLjAuMTIvZm9ybWF0XCI7XG5pbXBvcnQgeyBBc3NlcnRpb25FcnJvciB9IGZyb20gXCIuL2Fzc2VydGlvbl9lcnJvci50c1wiO1xuXG4vKiogQW4gYXJyYXktbGlrZSBvYmplY3QgKGBBcnJheWAsIGBVaW50OEFycmF5YCwgYE5vZGVMaXN0YCwgZXRjLikgdGhhdCBpcyBub3QgYSBzdHJpbmcgKi9cbmV4cG9ydCB0eXBlIEFycmF5TGlrZUFyZzxUPiA9IEFycmF5TGlrZTxUPiAmIG9iamVjdDtcblxuZnVuY3Rpb24gaXNQcmltaXRpdmUodmFsdWU6IHVua25vd24pOiBib29sZWFuIHtcbiAgcmV0dXJuIHZhbHVlID09PSBudWxsIHx8XG4gICAgdHlwZW9mIHZhbHVlICE9PSBcIm9iamVjdFwiICYmIHR5cGVvZiB2YWx1ZSAhPT0gXCJmdW5jdGlvblwiO1xufVxuXG4vKipcbiAqIEFzc2VydHMgdGhhdCBgYWN0dWFsYCBjb250YWlucyBhbGwgdmFsdWVzIGluIGBleHBlY3RlZGAsIHVzaW5nIGRlZXAgZXF1YWxpdHlcbiAqIGZvciBub24tcHJpbWl0aXZlIHZhbHVlcy5cbiAqXG4gKiBAZXhhbXBsZSBVc2FnZSB3aXRoIHByaW1pdGl2ZXNcbiAqIGBgYHRzIGlnbm9yZVxuICogaW1wb3J0IHsgYXNzZXJ0QXJyYXlJbmNsdWRlcyB9IGZyb20gXCJAc3RkL2Fzc2VydFwiO1xuICpcbiAqIGFzc2VydEFycmF5SW5jbHVkZXMoWzEsIDIsIDNdLCBbMiwgM10pOyAvLyBQYXNzZXNcbiAqIGFzc2VydEFycmF5SW5jbHVkZXMoWzEsIDIsIDNdLCBbNF0pOyAvLyBUaHJvd3NcbiAqIGBgYFxuICpcbiAqIEBleGFtcGxlIFVzYWdlIHdpdGggb2JqZWN0cyAoZGVlcCBlcXVhbGl0eSlcbiAqIGBgYHRzIGlnbm9yZVxuICogaW1wb3J0IHsgYXNzZXJ0QXJyYXlJbmNsdWRlcyB9IGZyb20gXCJAc3RkL2Fzc2VydFwiO1xuICpcbiAqIGFzc2VydEFycmF5SW5jbHVkZXMoW3sgYTogMSB9LCB7IGI6IDIgfV0sIFt7IGE6IDEgfV0pOyAvLyBQYXNzZXNcbiAqIGBgYFxuICpcbiAqIEB0eXBlUGFyYW0gVCBUaGUgZWxlbWVudCB0eXBlIG9mIHRoZSBhcnJheXMuXG4gKiBAcGFyYW0gYWN0dWFsIFRoZSBhcnJheS1saWtlIG9iamVjdCB0byBzZWFyY2ggd2l0aGluLlxuICogQHBhcmFtIGV4cGVjdGVkIFRoZSB2YWx1ZXMgdGhhdCBtdXN0IGJlIHByZXNlbnQgaW4gYGFjdHVhbGAuXG4gKiBAcGFyYW0gbXNnIE9wdGlvbmFsIG1lc3NhZ2UgdG8gZGlzcGxheSBvbiBmYWlsdXJlLlxuICogQHRocm93cyB7QXNzZXJ0aW9uRXJyb3J9IElmIGFueSB2YWx1ZSBpbiBgZXhwZWN0ZWRgIGlzIG5vdCBmb3VuZCBpbiBgYWN0dWFsYC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFzc2VydEFycmF5SW5jbHVkZXM8VD4oXG4gIGFjdHVhbDogQXJyYXlMaWtlQXJnPFQ+LFxuICBleHBlY3RlZDogQXJyYXlMaWtlQXJnPFQ+LFxuICBtc2c/OiBzdHJpbmcsXG4pOiB2b2lkIHtcbiAgY29uc3QgbWlzc2luZzogdW5rbm93bltdID0gW107XG4gIGNvbnN0IGV4cGVjdGVkTGVuID0gZXhwZWN0ZWQubGVuZ3RoO1xuICBjb25zdCBhY3R1YWxMZW4gPSBhY3R1YWwubGVuZ3RoO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGV4cGVjdGVkTGVuOyBpKyspIHtcbiAgICBjb25zdCBpdGVtID0gZXhwZWN0ZWRbaV07XG4gICAgbGV0IGZvdW5kOiBib29sZWFuO1xuICAgIGlmIChpc1ByaW1pdGl2ZShpdGVtKSkge1xuICAgICAgLy8gRmFzdCBwYXRoXG4gICAgICBmb3VuZCA9IEFycmF5LnByb3RvdHlwZS5pbmNsdWRlcy5jYWxsKGFjdHVhbCwgaXRlbSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGZvdW5kID0gZmFsc2U7XG4gICAgICBmb3IgKGxldCBqID0gMDsgaiA8IGFjdHVhbExlbjsgaisrKSB7XG4gICAgICAgIGlmIChlcXVhbChpdGVtLCBhY3R1YWxbal0pKSB7XG4gICAgICAgICAgZm91bmQgPSB0cnVlO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIGlmICghZm91bmQpIHtcbiAgICAgIG1pc3NpbmcucHVzaChpdGVtKTtcbiAgICB9XG4gIH1cbiAgaWYgKG1pc3NpbmcubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgbXNnU3VmZml4ID0gbXNnID8gYDogJHttc2d9YCA6IFwiLlwiO1xuICBtc2cgPSBgRXhwZWN0ZWQgYWN0dWFsOiBcIiR7Zm9ybWF0KGFjdHVhbCl9XCIgdG8gaW5jbHVkZTogXCIke1xuICAgIGZvcm1hdChleHBlY3RlZClcbiAgfVwiJHttc2dTdWZmaXh9XFxubWlzc2luZzogJHtmb3JtYXQobWlzc2luZyl9YDtcbiAgdGhyb3cgbmV3IEFzc2VydGlvbkVycm9yKG1zZyk7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEscURBQXFEO0FBQ3JELHFDQUFxQztBQUNyQyxTQUFTLEtBQUssUUFBUSxhQUFhO0FBQ25DLFNBQVMsTUFBTSxRQUFRLG1DQUFtQztBQUMxRCxTQUFTLGNBQWMsUUFBUSx1QkFBdUI7QUFLdEQsU0FBUyxZQUFZLEtBQWM7RUFDakMsT0FBTyxVQUFVLFFBQ2YsT0FBTyxVQUFVLFlBQVksT0FBTyxVQUFVO0FBQ2xEO0FBRUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQXdCQyxHQUNELE9BQU8sU0FBUyxvQkFDZCxNQUF1QixFQUN2QixRQUF5QixFQUN6QixHQUFZO0VBRVosTUFBTSxVQUFxQixFQUFFO0VBQzdCLE1BQU0sY0FBYyxTQUFTLE1BQU07RUFDbkMsTUFBTSxZQUFZLE9BQU8sTUFBTTtFQUMvQixJQUFLLElBQUksSUFBSSxHQUFHLElBQUksYUFBYSxJQUFLO0lBQ3BDLE1BQU0sT0FBTyxRQUFRLENBQUMsRUFBRTtJQUN4QixJQUFJO0lBQ0osSUFBSSxZQUFZLE9BQU87TUFDckIsWUFBWTtNQUNaLFFBQVEsTUFBTSxTQUFTLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxRQUFRO0lBQ2hELE9BQU87TUFDTCxRQUFRO01BQ1IsSUFBSyxJQUFJLElBQUksR0FBRyxJQUFJLFdBQVcsSUFBSztRQUNsQyxJQUFJLE1BQU0sTUFBTSxNQUFNLENBQUMsRUFBRSxHQUFHO1VBQzFCLFFBQVE7VUFDUjtRQUNGO01BQ0Y7SUFDRjtJQUNBLElBQUksQ0FBQyxPQUFPO01BQ1YsUUFBUSxJQUFJLENBQUM7SUFDZjtFQUNGO0VBQ0EsSUFBSSxRQUFRLE1BQU0sS0FBSyxHQUFHO0lBQ3hCO0VBQ0Y7RUFFQSxNQUFNLFlBQVksTUFBTSxDQUFDLEVBQUUsRUFBRSxLQUFLLEdBQUc7RUFDckMsTUFBTSxDQUFDLGtCQUFrQixFQUFFLE9BQU8sUUFBUSxlQUFlLEVBQ3ZELE9BQU8sVUFDUixDQUFDLEVBQUUsVUFBVSxXQUFXLEVBQUUsT0FBTyxVQUFVO0VBQzVDLE1BQU0sSUFBSSxlQUFlO0FBQzNCIn0=
// denoCacheMetadata=5556870043424944862,384373166078051678