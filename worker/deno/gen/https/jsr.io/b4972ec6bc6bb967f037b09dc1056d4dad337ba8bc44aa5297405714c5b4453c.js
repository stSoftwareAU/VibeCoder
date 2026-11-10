// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { assertEquals } from "./equals.ts";
/**
 * Make an assertion that `expected` object is a subset of `actual` object,
 * deeply. If not, then throw a diff of the objects, with mismatching
 * properties highlighted.
 *
 * @example Usage
 * ```ts ignore
 * import { assertObjectMatch } from "@std/assert";
 *
 * assertObjectMatch({ foo: "bar" }, { foo: "bar" }); // Doesn't throw
 * assertObjectMatch({ foo: "bar" }, { foo: "baz" }); // Throws
 * assertObjectMatch({ foo: 1, bar: 2 }, { foo: 1 }); // Doesn't throw
 * assertObjectMatch({ foo: 1 }, { foo: 1, bar: 2 }); // Throws
 * ```
 *
 * @example Usage with nested objects
 * ```ts ignore
 * import { assertObjectMatch } from "@std/assert";
 *
 * assertObjectMatch({ foo: { bar: 3, baz: 4 } }, { foo: { bar: 3 } }); // Doesn't throw
 * assertObjectMatch({ foo: { bar: 3 } }, { foo: { bar: 3, baz: 4 } }); // Throws
 * ```
 *
 * @param actual The actual value to be matched.
 * @param expected The expected value to match.
 * @param msg The optional message to display if the assertion fails.
 */ export function assertObjectMatch(// deno-lint-ignore no-explicit-any
actual, expected, msg) {
  return assertEquals(// get the intersection of "actual" and "expected"
  // side effect: all the instances' constructor field is "Object" now.
  filter(actual, expected), // set (nested) instances' constructor field to be "Object" without changing expected value.
  // see https://github.com/denoland/std/pull/1419
  filter(expected, expected), msg);
}
function isObject(val) {
  return typeof val === "object" && val !== null;
}
function defineProperty(target, key, value) {
  return Object.defineProperty(target, key, {
    value,
    configurable: true,
    enumerable: true,
    writable: true
  });
}
function filter(a, b) {
  const seen = new WeakMap();
  return filterObject(a, b);
  function filterObject(a, b) {
    // Prevent infinite loop with circular references with same filter
    const memo = seen.get(a);
    if (memo && memo === b) return a;
    try {
      seen.set(a, b);
    } catch (err) {
      if (err instanceof TypeError) {
        throw new TypeError(`Cannot assertObjectMatch ${a === null ? null : `type ${typeof a}`}`);
      }
    }
    // Filter keys and symbols which are present in both actual and expected
    const filtered = {};
    const keysA = Reflect.ownKeys(a);
    const keysB = Reflect.ownKeys(b);
    const entries = keysA.filter((key)=>keysB.includes(key)).map((key)=>[
        key,
        a[key]
      ]);
    if (keysA.length && keysB.length && !entries.length) {
      // If both objects are not empty but don't have the same keys or symbols,
      // returns the entries in object a.
      for (const key of keysA)defineProperty(filtered, key, a[key]);
      return filtered;
    }
    for (const [key, value] of entries){
      // On regexp references, keep value as it to avoid losing pattern and flags
      if (value instanceof RegExp) {
        defineProperty(filtered, key, value);
        continue;
      }
      const subset = b[key];
      // On array references, build a filtered array and filter nested objects inside
      if (Array.isArray(value) && Array.isArray(subset)) {
        defineProperty(filtered, key, filterArray(value, subset));
        continue;
      }
      // On nested objects references, build a filtered object recursively
      if (isObject(value) && isObject(subset)) {
        // When both operands are maps, build a filtered map with common keys and filter nested objects inside
        if (value instanceof Map && subset instanceof Map) {
          defineProperty(filtered, key, new Map([
            ...value
          ].filter(([k])=>subset.has(k)).map(([k, v])=>{
            const v2 = subset.get(k);
            if (isObject(v) && isObject(v2)) {
              return [
                k,
                filterObject(v, v2)
              ];
            }
            return [
              k,
              v
            ];
          })));
          continue;
        }
        // When both operands are set, build a filtered set with common values
        if (value instanceof Set && subset instanceof Set) {
          defineProperty(filtered, key, value.intersection(subset));
          continue;
        }
        defineProperty(filtered, key, filterObject(value, subset));
        continue;
      }
      defineProperty(filtered, key, value);
    }
    return filtered;
  }
  function filterArray(a, b) {
    // Prevent infinite loop with circular references with same filter
    const memo = seen.get(a);
    if (memo && memo === b) return a;
    seen.set(a, b);
    const filtered = [];
    const count = Math.min(a.length, b.length);
    for(let i = 0; i < count; ++i){
      const value = a[i];
      const subset = b[i];
      // On regexp references, keep value as it to avoid losing pattern and flags
      if (value instanceof RegExp) {
        filtered.push(value);
        continue;
      }
      // On array references, build a filtered array and filter nested objects inside
      if (Array.isArray(value) && Array.isArray(subset)) {
        filtered.push(filterArray(value, subset));
        continue;
      }
      // On nested objects references, build a filtered object recursively
      if (isObject(value) && isObject(subset)) {
        // When both operands are maps, build a filtered map with common keys and filter nested objects inside
        if (value instanceof Map && subset instanceof Map) {
          const map = new Map([
            ...value
          ].filter(([k])=>subset.has(k)).map(([k, v])=>{
            const v2 = subset.get(k);
            if (isObject(v) && isObject(v2)) {
              return [
                k,
                filterObject(v, v2)
              ];
            }
            return [
              k,
              v
            ];
          }));
          filtered.push(map);
          continue;
        }
        // When both operands are set, build a filtered set with common values
        if (value instanceof Set && subset instanceof Set) {
          filtered.push(value.intersection(subset));
          continue;
        }
        filtered.push(filterObject(value, subset));
        continue;
      }
      filtered.push(value);
    }
    return filtered;
  }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvYXNzZXJ0LzEuMC4xOC9vYmplY3RfbWF0Y2gudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQ29weXJpZ2h0IDIwMTgtMjAyNiB0aGUgRGVubyBhdXRob3JzLiBNSVQgbGljZW5zZS5cbi8vIFRoaXMgbW9kdWxlIGlzIGJyb3dzZXIgY29tcGF0aWJsZS5cbmltcG9ydCB7IGFzc2VydEVxdWFscyB9IGZyb20gXCIuL2VxdWFscy50c1wiO1xuXG4vKipcbiAqIE1ha2UgYW4gYXNzZXJ0aW9uIHRoYXQgYGV4cGVjdGVkYCBvYmplY3QgaXMgYSBzdWJzZXQgb2YgYGFjdHVhbGAgb2JqZWN0LFxuICogZGVlcGx5LiBJZiBub3QsIHRoZW4gdGhyb3cgYSBkaWZmIG9mIHRoZSBvYmplY3RzLCB3aXRoIG1pc21hdGNoaW5nXG4gKiBwcm9wZXJ0aWVzIGhpZ2hsaWdodGVkLlxuICpcbiAqIEBleGFtcGxlIFVzYWdlXG4gKiBgYGB0cyBpZ25vcmVcbiAqIGltcG9ydCB7IGFzc2VydE9iamVjdE1hdGNoIH0gZnJvbSBcIkBzdGQvYXNzZXJ0XCI7XG4gKlxuICogYXNzZXJ0T2JqZWN0TWF0Y2goeyBmb286IFwiYmFyXCIgfSwgeyBmb286IFwiYmFyXCIgfSk7IC8vIERvZXNuJ3QgdGhyb3dcbiAqIGFzc2VydE9iamVjdE1hdGNoKHsgZm9vOiBcImJhclwiIH0sIHsgZm9vOiBcImJhelwiIH0pOyAvLyBUaHJvd3NcbiAqIGFzc2VydE9iamVjdE1hdGNoKHsgZm9vOiAxLCBiYXI6IDIgfSwgeyBmb286IDEgfSk7IC8vIERvZXNuJ3QgdGhyb3dcbiAqIGFzc2VydE9iamVjdE1hdGNoKHsgZm9vOiAxIH0sIHsgZm9vOiAxLCBiYXI6IDIgfSk7IC8vIFRocm93c1xuICogYGBgXG4gKlxuICogQGV4YW1wbGUgVXNhZ2Ugd2l0aCBuZXN0ZWQgb2JqZWN0c1xuICogYGBgdHMgaWdub3JlXG4gKiBpbXBvcnQgeyBhc3NlcnRPYmplY3RNYXRjaCB9IGZyb20gXCJAc3RkL2Fzc2VydFwiO1xuICpcbiAqIGFzc2VydE9iamVjdE1hdGNoKHsgZm9vOiB7IGJhcjogMywgYmF6OiA0IH0gfSwgeyBmb286IHsgYmFyOiAzIH0gfSk7IC8vIERvZXNuJ3QgdGhyb3dcbiAqIGFzc2VydE9iamVjdE1hdGNoKHsgZm9vOiB7IGJhcjogMyB9IH0sIHsgZm9vOiB7IGJhcjogMywgYmF6OiA0IH0gfSk7IC8vIFRocm93c1xuICogYGBgXG4gKlxuICogQHBhcmFtIGFjdHVhbCBUaGUgYWN0dWFsIHZhbHVlIHRvIGJlIG1hdGNoZWQuXG4gKiBAcGFyYW0gZXhwZWN0ZWQgVGhlIGV4cGVjdGVkIHZhbHVlIHRvIG1hdGNoLlxuICogQHBhcmFtIG1zZyBUaGUgb3B0aW9uYWwgbWVzc2FnZSB0byBkaXNwbGF5IGlmIHRoZSBhc3NlcnRpb24gZmFpbHMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhc3NlcnRPYmplY3RNYXRjaChcbiAgLy8gZGVuby1saW50LWlnbm9yZSBuby1leHBsaWNpdC1hbnlcbiAgYWN0dWFsOiBSZWNvcmQ8UHJvcGVydHlLZXksIGFueT4sXG4gIGV4cGVjdGVkOiBSZWNvcmQ8UHJvcGVydHlLZXksIHVua25vd24+LFxuICBtc2c/OiBzdHJpbmcsXG4pOiB2b2lkIHtcbiAgcmV0dXJuIGFzc2VydEVxdWFscyhcbiAgICAvLyBnZXQgdGhlIGludGVyc2VjdGlvbiBvZiBcImFjdHVhbFwiIGFuZCBcImV4cGVjdGVkXCJcbiAgICAvLyBzaWRlIGVmZmVjdDogYWxsIHRoZSBpbnN0YW5jZXMnIGNvbnN0cnVjdG9yIGZpZWxkIGlzIFwiT2JqZWN0XCIgbm93LlxuICAgIGZpbHRlcihhY3R1YWwsIGV4cGVjdGVkKSxcbiAgICAvLyBzZXQgKG5lc3RlZCkgaW5zdGFuY2VzJyBjb25zdHJ1Y3RvciBmaWVsZCB0byBiZSBcIk9iamVjdFwiIHdpdGhvdXQgY2hhbmdpbmcgZXhwZWN0ZWQgdmFsdWUuXG4gICAgLy8gc2VlIGh0dHBzOi8vZ2l0aHViLmNvbS9kZW5vbGFuZC9zdGQvcHVsbC8xNDE5XG4gICAgZmlsdGVyKGV4cGVjdGVkLCBleHBlY3RlZCksXG4gICAgbXNnLFxuICApO1xufVxuXG50eXBlIExvb3NlID0gUmVjb3JkPFByb3BlcnR5S2V5LCB1bmtub3duPjtcblxuZnVuY3Rpb24gaXNPYmplY3QodmFsOiB1bmtub3duKTogYm9vbGVhbiB7XG4gIHJldHVybiB0eXBlb2YgdmFsID09PSBcIm9iamVjdFwiICYmIHZhbCAhPT0gbnVsbDtcbn1cblxuZnVuY3Rpb24gZGVmaW5lUHJvcGVydHkodGFyZ2V0OiBvYmplY3QsIGtleTogUHJvcGVydHlLZXksIHZhbHVlOiB1bmtub3duKSB7XG4gIHJldHVybiBPYmplY3QuZGVmaW5lUHJvcGVydHkodGFyZ2V0LCBrZXksIHtcbiAgICB2YWx1ZSxcbiAgICBjb25maWd1cmFibGU6IHRydWUsXG4gICAgZW51bWVyYWJsZTogdHJ1ZSxcbiAgICB3cml0YWJsZTogdHJ1ZSxcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGZpbHRlcihhOiBMb29zZSwgYjogTG9vc2UpOiBMb29zZSB7XG4gIGNvbnN0IHNlZW4gPSBuZXcgV2Vha01hcDxMb29zZSB8IHVua25vd25bXSwgTG9vc2UgfCB1bmtub3duW10+KCk7XG4gIHJldHVybiBmaWx0ZXJPYmplY3QoYSwgYik7XG5cbiAgZnVuY3Rpb24gZmlsdGVyT2JqZWN0KGE6IExvb3NlLCBiOiBMb29zZSk6IExvb3NlIHtcbiAgICAvLyBQcmV2ZW50IGluZmluaXRlIGxvb3Agd2l0aCBjaXJjdWxhciByZWZlcmVuY2VzIHdpdGggc2FtZSBmaWx0ZXJcbiAgICBjb25zdCBtZW1vID0gc2Vlbi5nZXQoYSk7XG4gICAgaWYgKG1lbW8gJiYgKG1lbW8gPT09IGIpKSByZXR1cm4gYTtcblxuICAgIHRyeSB7XG4gICAgICBzZWVuLnNldChhLCBiKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGlmIChlcnIgaW5zdGFuY2VvZiBUeXBlRXJyb3IpIHtcbiAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcihcbiAgICAgICAgICBgQ2Fubm90IGFzc2VydE9iamVjdE1hdGNoICR7YSA9PT0gbnVsbCA/IG51bGwgOiBgdHlwZSAke3R5cGVvZiBhfWB9YCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBGaWx0ZXIga2V5cyBhbmQgc3ltYm9scyB3aGljaCBhcmUgcHJlc2VudCBpbiBib3RoIGFjdHVhbCBhbmQgZXhwZWN0ZWRcbiAgICBjb25zdCBmaWx0ZXJlZCA9IHt9IGFzIExvb3NlO1xuICAgIGNvbnN0IGtleXNBID0gUmVmbGVjdC5vd25LZXlzKGEpO1xuICAgIGNvbnN0IGtleXNCID0gUmVmbGVjdC5vd25LZXlzKGIpO1xuICAgIGNvbnN0IGVudHJpZXMgPSBrZXlzQS5maWx0ZXIoKGtleSkgPT4ga2V5c0IuaW5jbHVkZXMoa2V5KSlcbiAgICAgIC5tYXAoKGtleSkgPT4gW2tleSwgYVtrZXkgYXMgc3RyaW5nXV0pIGFzIEFycmF5PFtzdHJpbmcsIHVua25vd25dPjtcblxuICAgIGlmIChrZXlzQS5sZW5ndGggJiYga2V5c0IubGVuZ3RoICYmICFlbnRyaWVzLmxlbmd0aCkge1xuICAgICAgLy8gSWYgYm90aCBvYmplY3RzIGFyZSBub3QgZW1wdHkgYnV0IGRvbid0IGhhdmUgdGhlIHNhbWUga2V5cyBvciBzeW1ib2xzLFxuICAgICAgLy8gcmV0dXJucyB0aGUgZW50cmllcyBpbiBvYmplY3QgYS5cbiAgICAgIGZvciAoY29uc3Qga2V5IG9mIGtleXNBKSBkZWZpbmVQcm9wZXJ0eShmaWx0ZXJlZCwga2V5LCBhW2tleV0pO1xuICAgICAgcmV0dXJuIGZpbHRlcmVkO1xuICAgIH1cblxuICAgIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIGVudHJpZXMpIHtcbiAgICAgIC8vIE9uIHJlZ2V4cCByZWZlcmVuY2VzLCBrZWVwIHZhbHVlIGFzIGl0IHRvIGF2b2lkIGxvc2luZyBwYXR0ZXJuIGFuZCBmbGFnc1xuICAgICAgaWYgKHZhbHVlIGluc3RhbmNlb2YgUmVnRXhwKSB7XG4gICAgICAgIGRlZmluZVByb3BlcnR5KGZpbHRlcmVkLCBrZXksIHZhbHVlKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHN1YnNldCA9IChiIGFzIExvb3NlKVtrZXldO1xuXG4gICAgICAvLyBPbiBhcnJheSByZWZlcmVuY2VzLCBidWlsZCBhIGZpbHRlcmVkIGFycmF5IGFuZCBmaWx0ZXIgbmVzdGVkIG9iamVjdHMgaW5zaWRlXG4gICAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkgJiYgQXJyYXkuaXNBcnJheShzdWJzZXQpKSB7XG4gICAgICAgIGRlZmluZVByb3BlcnR5KGZpbHRlcmVkLCBrZXksIGZpbHRlckFycmF5KHZhbHVlLCBzdWJzZXQpKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIC8vIE9uIG5lc3RlZCBvYmplY3RzIHJlZmVyZW5jZXMsIGJ1aWxkIGEgZmlsdGVyZWQgb2JqZWN0IHJlY3Vyc2l2ZWx5XG4gICAgICBpZiAoaXNPYmplY3QodmFsdWUpICYmIGlzT2JqZWN0KHN1YnNldCkpIHtcbiAgICAgICAgLy8gV2hlbiBib3RoIG9wZXJhbmRzIGFyZSBtYXBzLCBidWlsZCBhIGZpbHRlcmVkIG1hcCB3aXRoIGNvbW1vbiBrZXlzIGFuZCBmaWx0ZXIgbmVzdGVkIG9iamVjdHMgaW5zaWRlXG4gICAgICAgIGlmICgodmFsdWUgaW5zdGFuY2VvZiBNYXApICYmIChzdWJzZXQgaW5zdGFuY2VvZiBNYXApKSB7XG4gICAgICAgICAgZGVmaW5lUHJvcGVydHkoXG4gICAgICAgICAgICBmaWx0ZXJlZCxcbiAgICAgICAgICAgIGtleSxcbiAgICAgICAgICAgIG5ldyBNYXAoXG4gICAgICAgICAgICAgIFsuLi52YWx1ZV0uZmlsdGVyKChba10pID0+IHN1YnNldC5oYXMoaykpLm1hcChcbiAgICAgICAgICAgICAgICAoW2ssIHZdKSA9PiB7XG4gICAgICAgICAgICAgICAgICBjb25zdCB2MiA9IHN1YnNldC5nZXQoayk7XG4gICAgICAgICAgICAgICAgICBpZiAoaXNPYmplY3QodikgJiYgaXNPYmplY3QodjIpKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBbaywgZmlsdGVyT2JqZWN0KHYgYXMgTG9vc2UsIHYyIGFzIExvb3NlKV07XG4gICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICByZXR1cm4gW2ssIHZdO1xuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICksXG4gICAgICAgICAgICApLFxuICAgICAgICAgICk7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBXaGVuIGJvdGggb3BlcmFuZHMgYXJlIHNldCwgYnVpbGQgYSBmaWx0ZXJlZCBzZXQgd2l0aCBjb21tb24gdmFsdWVzXG4gICAgICAgIGlmICgodmFsdWUgaW5zdGFuY2VvZiBTZXQpICYmIChzdWJzZXQgaW5zdGFuY2VvZiBTZXQpKSB7XG4gICAgICAgICAgZGVmaW5lUHJvcGVydHkoZmlsdGVyZWQsIGtleSwgdmFsdWUuaW50ZXJzZWN0aW9uKHN1YnNldCkpO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgZGVmaW5lUHJvcGVydHkoXG4gICAgICAgICAgZmlsdGVyZWQsXG4gICAgICAgICAga2V5LFxuICAgICAgICAgIGZpbHRlck9iamVjdCh2YWx1ZSBhcyBMb29zZSwgc3Vic2V0IGFzIExvb3NlKSxcbiAgICAgICAgKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIGRlZmluZVByb3BlcnR5KGZpbHRlcmVkLCBrZXksIHZhbHVlKTtcbiAgICB9XG5cbiAgICByZXR1cm4gZmlsdGVyZWQ7XG4gIH1cblxuICBmdW5jdGlvbiBmaWx0ZXJBcnJheShhOiB1bmtub3duW10sIGI6IHVua25vd25bXSk6IHVua25vd25bXSB7XG4gICAgLy8gUHJldmVudCBpbmZpbml0ZSBsb29wIHdpdGggY2lyY3VsYXIgcmVmZXJlbmNlcyB3aXRoIHNhbWUgZmlsdGVyXG4gICAgY29uc3QgbWVtbyA9IHNlZW4uZ2V0KGEpO1xuICAgIGlmIChtZW1vICYmIChtZW1vID09PSBiKSkgcmV0dXJuIGE7XG5cbiAgICBzZWVuLnNldChhLCBiKTtcblxuICAgIGNvbnN0IGZpbHRlcmVkOiB1bmtub3duW10gPSBbXTtcbiAgICBjb25zdCBjb3VudCA9IE1hdGgubWluKGEubGVuZ3RoLCBiLmxlbmd0aCk7XG5cbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGNvdW50OyArK2kpIHtcbiAgICAgIGNvbnN0IHZhbHVlID0gYVtpXTtcbiAgICAgIGNvbnN0IHN1YnNldCA9IGJbaV07XG5cbiAgICAgIC8vIE9uIHJlZ2V4cCByZWZlcmVuY2VzLCBrZWVwIHZhbHVlIGFzIGl0IHRvIGF2b2lkIGxvc2luZyBwYXR0ZXJuIGFuZCBmbGFnc1xuICAgICAgaWYgKHZhbHVlIGluc3RhbmNlb2YgUmVnRXhwKSB7XG4gICAgICAgIGZpbHRlcmVkLnB1c2godmFsdWUpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgLy8gT24gYXJyYXkgcmVmZXJlbmNlcywgYnVpbGQgYSBmaWx0ZXJlZCBhcnJheSBhbmQgZmlsdGVyIG5lc3RlZCBvYmplY3RzIGluc2lkZVxuICAgICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpICYmIEFycmF5LmlzQXJyYXkoc3Vic2V0KSkge1xuICAgICAgICBmaWx0ZXJlZC5wdXNoKGZpbHRlckFycmF5KHZhbHVlLCBzdWJzZXQpKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIC8vIE9uIG5lc3RlZCBvYmplY3RzIHJlZmVyZW5jZXMsIGJ1aWxkIGEgZmlsdGVyZWQgb2JqZWN0IHJlY3Vyc2l2ZWx5XG4gICAgICBpZiAoaXNPYmplY3QodmFsdWUpICYmIGlzT2JqZWN0KHN1YnNldCkpIHtcbiAgICAgICAgLy8gV2hlbiBib3RoIG9wZXJhbmRzIGFyZSBtYXBzLCBidWlsZCBhIGZpbHRlcmVkIG1hcCB3aXRoIGNvbW1vbiBrZXlzIGFuZCBmaWx0ZXIgbmVzdGVkIG9iamVjdHMgaW5zaWRlXG4gICAgICAgIGlmICgodmFsdWUgaW5zdGFuY2VvZiBNYXApICYmIChzdWJzZXQgaW5zdGFuY2VvZiBNYXApKSB7XG4gICAgICAgICAgY29uc3QgbWFwID0gbmV3IE1hcChcbiAgICAgICAgICAgIFsuLi52YWx1ZV0uZmlsdGVyKChba10pID0+IHN1YnNldC5oYXMoaykpXG4gICAgICAgICAgICAgIC5tYXAoKFtrLCB2XSkgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IHYyID0gc3Vic2V0LmdldChrKTtcbiAgICAgICAgICAgICAgICBpZiAoaXNPYmplY3QodikgJiYgaXNPYmplY3QodjIpKSB7XG4gICAgICAgICAgICAgICAgICByZXR1cm4gW2ssIGZpbHRlck9iamVjdCh2IGFzIExvb3NlLCB2MiBhcyBMb29zZSldO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiBbaywgdl07XG4gICAgICAgICAgICAgIH0pLFxuICAgICAgICAgICk7XG4gICAgICAgICAgZmlsdGVyZWQucHVzaChtYXApO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gV2hlbiBib3RoIG9wZXJhbmRzIGFyZSBzZXQsIGJ1aWxkIGEgZmlsdGVyZWQgc2V0IHdpdGggY29tbW9uIHZhbHVlc1xuICAgICAgICBpZiAoKHZhbHVlIGluc3RhbmNlb2YgU2V0KSAmJiAoc3Vic2V0IGluc3RhbmNlb2YgU2V0KSkge1xuICAgICAgICAgIGZpbHRlcmVkLnB1c2godmFsdWUuaW50ZXJzZWN0aW9uKHN1YnNldCkpO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgZmlsdGVyZWQucHVzaChmaWx0ZXJPYmplY3QodmFsdWUgYXMgTG9vc2UsIHN1YnNldCBhcyBMb29zZSkpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgZmlsdGVyZWQucHVzaCh2YWx1ZSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGZpbHRlcmVkO1xuICB9XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEscURBQXFEO0FBQ3JELHFDQUFxQztBQUNyQyxTQUFTLFlBQVksUUFBUSxjQUFjO0FBRTNDOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQTBCQyxHQUNELE9BQU8sU0FBUyxrQkFDZCxtQ0FBbUM7QUFDbkMsTUFBZ0MsRUFDaEMsUUFBc0MsRUFDdEMsR0FBWTtFQUVaLE9BQU8sYUFDTCxrREFBa0Q7RUFDbEQscUVBQXFFO0VBQ3JFLE9BQU8sUUFBUSxXQUNmLDRGQUE0RjtFQUM1RixnREFBZ0Q7RUFDaEQsT0FBTyxVQUFVLFdBQ2pCO0FBRUo7QUFJQSxTQUFTLFNBQVMsR0FBWTtFQUM1QixPQUFPLE9BQU8sUUFBUSxZQUFZLFFBQVE7QUFDNUM7QUFFQSxTQUFTLGVBQWUsTUFBYyxFQUFFLEdBQWdCLEVBQUUsS0FBYztFQUN0RSxPQUFPLE9BQU8sY0FBYyxDQUFDLFFBQVEsS0FBSztJQUN4QztJQUNBLGNBQWM7SUFDZCxZQUFZO0lBQ1osVUFBVTtFQUNaO0FBQ0Y7QUFFQSxTQUFTLE9BQU8sQ0FBUSxFQUFFLENBQVE7RUFDaEMsTUFBTSxPQUFPLElBQUk7RUFDakIsT0FBTyxhQUFhLEdBQUc7RUFFdkIsU0FBUyxhQUFhLENBQVEsRUFBRSxDQUFRO0lBQ3RDLGtFQUFrRTtJQUNsRSxNQUFNLE9BQU8sS0FBSyxHQUFHLENBQUM7SUFDdEIsSUFBSSxRQUFTLFNBQVMsR0FBSSxPQUFPO0lBRWpDLElBQUk7TUFDRixLQUFLLEdBQUcsQ0FBQyxHQUFHO0lBQ2QsRUFBRSxPQUFPLEtBQUs7TUFDWixJQUFJLGVBQWUsV0FBVztRQUM1QixNQUFNLElBQUksVUFDUixDQUFDLHlCQUF5QixFQUFFLE1BQU0sT0FBTyxPQUFPLENBQUMsS0FBSyxFQUFFLE9BQU8sR0FBRyxFQUFFO01BRXhFO0lBQ0Y7SUFFQSx3RUFBd0U7SUFDeEUsTUFBTSxXQUFXLENBQUM7SUFDbEIsTUFB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
// denoCacheMetadata=16089699525044283987,6257203470555931423