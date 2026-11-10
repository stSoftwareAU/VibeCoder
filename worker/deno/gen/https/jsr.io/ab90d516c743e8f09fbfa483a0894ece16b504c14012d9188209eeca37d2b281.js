// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
function isKeyedCollection(x) {
  return x instanceof Set || x instanceof Map;
}
function prototypesEqual(a, b) {
  const pa = Object.getPrototypeOf(a);
  const pb = Object.getPrototypeOf(b);
  return pa === pb || pa === Object.prototype && pb === null || pa === null && pb === Object.prototype;
}
function isBasicObjectOrArray(obj) {
  const proto = Object.getPrototypeOf(obj);
  return proto === null || proto === Object.prototype || proto === Array.prototype;
}
// Slightly faster than Reflect.ownKeys in V8 as of 12.9.202.13-rusty (2024-10-28)
function ownKeys(obj) {
  return [
    ...Object.getOwnPropertyNames(obj),
    ...Object.getOwnPropertySymbols(obj)
  ];
}
function getKeysDeep(obj) {
  const keys = new Set();
  while(obj !== Object.prototype && obj !== Array.prototype && obj != null){
    for (const key of ownKeys(obj)){
      keys.add(key);
    }
    obj = Object.getPrototypeOf(obj);
  }
  return keys;
}
// deno-lint-ignore no-explicit-any
const Temporal = globalThis.Temporal ?? Object.create(null);
/** A non-exhaustive list of prototypes that can be accurately fast-path compared with `String(instance)` */ const stringComparablePrototypes = new Set([
  Intl.Locale,
  RegExp,
  Temporal.Duration,
  Temporal.Instant,
  Temporal.PlainDate,
  Temporal.PlainDateTime,
  Temporal.PlainTime,
  Temporal.PlainYearMonth,
  Temporal.PlainMonthDay,
  Temporal.ZonedDateTime,
  URL,
  URLSearchParams
].filter((x)=>x != null).map((x)=>x.prototype));
function isPrimitive(x) {
  return typeof x === "string" || typeof x === "number" || typeof x === "boolean" || typeof x === "bigint" || typeof x === "symbol" || x == null;
}
const TypedArray = Object.getPrototypeOf(Uint8Array);
function compareTypedArrays(a, b) {
  if (a.length !== b.length) return false;
  for(let i = 0; i < b.length; i++){
    if (!sameValueZero(a[i], b[i])) return false;
  }
  return true;
}
/** Check both strict equality (`0 == -0`) and `Object.is` (`NaN == NaN`) */ function sameValueZero(a, b) {
  return a === b || Object.is(a, b);
}
/**
 * Deep equality comparison used in assertions.
 *
 * @param a The actual value
 * @param b The expected value
 * @returns `true` if the values are deeply equal, `false` otherwise
 *
 * @example Usage
 * ```ts
 * import { equal } from "@std/assert/equal";
 *
 * equal({ foo: "bar" }, { foo: "bar" }); // Returns `true`
 * equal({ foo: "bar" }, { foo: "baz" }); // Returns `false`
 * ```
 */ export function equal(a, b) {
  const seen = new Map();
  return function compare(a, b) {
    if (sameValueZero(a, b)) return true;
    if (isPrimitive(a) || isPrimitive(b)) return false;
    if (a instanceof Date && b instanceof Date) {
      return Object.is(a.getTime(), b.getTime());
    }
    if (a && typeof a === "object" && b && typeof b === "object") {
      if (!prototypesEqual(a, b)) {
        return false;
      }
      if (a instanceof TypedArray) {
        return compareTypedArrays(a, b);
      }
      if (a instanceof ArrayBuffer || globalThis.SharedArrayBuffer && a instanceof SharedArrayBuffer) {
        return compareTypedArrays(new Uint8Array(a), new Uint8Array(b));
      }
      if (a instanceof WeakMap) {
        throw new TypeError("Cannot compare WeakMap instances");
      }
      if (a instanceof WeakSet) {
        throw new TypeError("Cannot compare WeakSet instances");
      }
      if (a instanceof WeakRef) {
        return compare(a.deref(), b.deref());
      }
      if (seen.get(a) === b) {
        return true;
      }
      if (Object.keys(a).length !== Object.keys(b).length) {
        return false;
      }
      seen.set(a, b);
      if (isKeyedCollection(a) && isKeyedCollection(b)) {
        if (a.size !== b.size) {
          return false;
        }
        const aKeys = [
          ...a.keys()
        ];
        const primitiveKeysFastPath = aKeys.every(isPrimitive);
        if (primitiveKeysFastPath) {
          if (a instanceof Set) {
            return a.symmetricDifference(b).size === 0;
          }
          for (const key of aKeys){
            if (!b.has(key) || !compare(a.get(key), b.get(key))) {
              return false;
            }
          }
          return true;
        }
        let unmatchedEntries = a.size;
        for (const [aKey, aValue] of a.entries()){
          for (const [bKey, bValue] of b.entries()){
            /* Given that Map keys can be references, we need
             * to ensure that they are also deeply equal */ if (!compare(aKey, bKey)) continue;
            if (aKey === aValue && bKey === bValue || compare(aValue, bValue)) {
              unmatchedEntries--;
              break;
            }
          }
        }
        return unmatchedEntries === 0;
      }
      let keys;
      if (isBasicObjectOrArray(a)) {
        // fast path
        keys = ownKeys({
          ...a,
          ...b
        });
      } else if (stringComparablePrototypes.has(Object.getPrototypeOf(a))) {
        // medium path
        return String(a) === String(b);
      } else {
        // slow path
        keys = getKeysDeep(a).union(getKeysDeep(b));
      }
      for (const key of keys){
        if (!compare(a[key], b[key])) {
          return false;
        }
        if (key in a && !(key in b) || key in b && !(key in a)) {
          return false;
        }
      }
      return true;
    }
    return false;
  }(a, b);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvYXNzZXJ0LzEuMC4xOC9lcXVhbC50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBDb3B5cmlnaHQgMjAxOC0yMDI2IHRoZSBEZW5vIGF1dGhvcnMuIE1JVCBsaWNlbnNlLlxuLy8gVGhpcyBtb2R1bGUgaXMgYnJvd3NlciBjb21wYXRpYmxlLlxuXG50eXBlIEtleWVkQ29sbGVjdGlvbiA9IFNldDx1bmtub3duPiB8IE1hcDx1bmtub3duLCB1bmtub3duPjtcbmZ1bmN0aW9uIGlzS2V5ZWRDb2xsZWN0aW9uKHg6IHVua25vd24pOiB4IGlzIEtleWVkQ29sbGVjdGlvbiB7XG4gIHJldHVybiB4IGluc3RhbmNlb2YgU2V0IHx8IHggaW5zdGFuY2VvZiBNYXA7XG59XG5cbmZ1bmN0aW9uIHByb3RvdHlwZXNFcXVhbChhOiBvYmplY3QsIGI6IG9iamVjdCkge1xuICBjb25zdCBwYSA9IE9iamVjdC5nZXRQcm90b3R5cGVPZihhKTtcbiAgY29uc3QgcGIgPSBPYmplY3QuZ2V0UHJvdG90eXBlT2YoYik7XG4gIHJldHVybiBwYSA9PT0gcGIgfHxcbiAgICBwYSA9PT0gT2JqZWN0LnByb3RvdHlwZSAmJiBwYiA9PT0gbnVsbCB8fFxuICAgIHBhID09PSBudWxsICYmIHBiID09PSBPYmplY3QucHJvdG90eXBlO1xufVxuXG5mdW5jdGlvbiBpc0Jhc2ljT2JqZWN0T3JBcnJheShvYmo6IG9iamVjdCkge1xuICBjb25zdCBwcm90byA9IE9iamVjdC5nZXRQcm90b3R5cGVPZihvYmopO1xuICByZXR1cm4gcHJvdG8gPT09IG51bGwgfHwgcHJvdG8gPT09IE9iamVjdC5wcm90b3R5cGUgfHxcbiAgICBwcm90byA9PT0gQXJyYXkucHJvdG90eXBlO1xufVxuXG4vLyBTbGlnaHRseSBmYXN0ZXIgdGhhbiBSZWZsZWN0Lm93bktleXMgaW4gVjggYXMgb2YgMTIuOS4yMDIuMTMtcnVzdHkgKDIwMjQtMTAtMjgpXG5mdW5jdGlvbiBvd25LZXlzKG9iajogb2JqZWN0KSB7XG4gIHJldHVybiBbXG4gICAgLi4uT2JqZWN0LmdldE93blByb3BlcnR5TmFtZXMob2JqKSxcbiAgICAuLi5PYmplY3QuZ2V0T3duUHJvcGVydHlTeW1ib2xzKG9iaiksXG4gIF07XG59XG5cbmZ1bmN0aW9uIGdldEtleXNEZWVwKG9iajogb2JqZWN0KSB7XG4gIGNvbnN0IGtleXMgPSBuZXcgU2V0PHN0cmluZyB8IHN5bWJvbD4oKTtcblxuICB3aGlsZSAob2JqICE9PSBPYmplY3QucHJvdG90eXBlICYmIG9iaiAhPT0gQXJyYXkucHJvdG90eXBlICYmIG9iaiAhPSBudWxsKSB7XG4gICAgZm9yIChjb25zdCBrZXkgb2Ygb3duS2V5cyhvYmopKSB7XG4gICAgICBrZXlzLmFkZChrZXkpO1xuICAgIH1cbiAgICBvYmogPSBPYmplY3QuZ2V0UHJvdG90eXBlT2Yob2JqKTtcbiAgfVxuXG4gIHJldHVybiBrZXlzO1xufVxuXG4vLyBkZW5vLWxpbnQtaWdub3JlIG5vLWV4cGxpY2l0LWFueVxuY29uc3QgVGVtcG9yYWwgPSAoZ2xvYmFsVGhpcyBhcyBhbnkpLlRlbXBvcmFsID8/IE9iamVjdC5jcmVhdGUobnVsbCk7XG5cbi8qKiBBIG5vbi1leGhhdXN0aXZlIGxpc3Qgb2YgcHJvdG90eXBlcyB0aGF0IGNhbiBiZSBhY2N1cmF0ZWx5IGZhc3QtcGF0aCBjb21wYXJlZCB3aXRoIGBTdHJpbmcoaW5zdGFuY2UpYCAqL1xuY29uc3Qgc3RyaW5nQ29tcGFyYWJsZVByb3RvdHlwZXMgPSBuZXcgU2V0PHVua25vd24+KFxuICBbXG4gICAgSW50bC5Mb2NhbGUsXG4gICAgUmVnRXhwLFxuICAgIFRlbXBvcmFsLkR1cmF0aW9uLFxuICAgIFRlbXBvcmFsLkluc3RhbnQsXG4gICAgVGVtcG9yYWwuUGxhaW5EYXRlLFxuICAgIFRlbXBvcmFsLlBsYWluRGF0ZVRpbWUsXG4gICAgVGVtcG9yYWwuUGxhaW5UaW1lLFxuICAgIFRlbXBvcmFsLlBsYWluWWVhck1vbnRoLFxuICAgIFRlbXBvcmFsLlBsYWluTW9udGhEYXksXG4gICAgVGVtcG9yYWwuWm9uZWREYXRlVGltZSxcbiAgICBVUkwsXG4gICAgVVJMU2VhcmNoUGFyYW1zLFxuICBdLmZpbHRlcigoeCkgPT4geCAhPSBudWxsKS5tYXAoKHgpID0+IHgucHJvdG90eXBlKSxcbik7XG5cbmZ1bmN0aW9uIGlzUHJpbWl0aXZlKHg6IHVua25vd24pIHtcbiAgcmV0dXJuIHR5cGVvZiB4ID09PSBcInN0cmluZ1wiIHx8XG4gICAgdHlwZW9mIHggPT09IFwibnVtYmVyXCIgfHxcbiAgICB0eXBlb2YgeCA9PT0gXCJib29sZWFuXCIgfHxcbiAgICB0eXBlb2YgeCA9PT0gXCJiaWdpbnRcIiB8fFxuICAgIHR5cGVvZiB4ID09PSBcInN5bWJvbFwiIHx8XG4gICAgeCA9PSBudWxsO1xufVxuXG50eXBlIFR5cGVkQXJyYXkgPSBQaWNrPFVpbnQ4QXJyYXkgfCBCaWdVaW50NjRBcnJheSwgXCJsZW5ndGhcIiB8IG51bWJlcj47XG5jb25zdCBUeXBlZEFycmF5ID0gT2JqZWN0LmdldFByb3RvdHlwZU9mKFVpbnQ4QXJyYXkpO1xuZnVuY3Rpb24gY29tcGFyZVR5cGVkQXJyYXlzKGE6IFR5cGVkQXJyYXksIGI6IFR5cGVkQXJyYXkpIHtcbiAgaWYgKGEubGVuZ3RoICE9PSBiLmxlbmd0aCkgcmV0dXJuIGZhbHNlO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGIubGVuZ3RoOyBpKyspIHtcbiAgICBpZiAoIXNhbWVWYWx1ZVplcm8oYVtpXSwgYltpXSkpIHJldHVybiBmYWxzZTtcbiAgfVxuICByZXR1cm4gdHJ1ZTtcbn1cblxuLyoqIENoZWNrIGJvdGggc3RyaWN0IGVxdWFsaXR5IChgMCA9PSAtMGApIGFuZCBgT2JqZWN0LmlzYCAoYE5hTiA9PSBOYU5gKSAqL1xuZnVuY3Rpb24gc2FtZVZhbHVlWmVybyhhOiB1bmtub3duLCBiOiB1bmtub3duKSB7XG4gIHJldHVybiBhID09PSBiIHx8IE9iamVjdC5pcyhhLCBiKTtcbn1cblxuLyoqXG4gKiBEZWVwIGVxdWFsaXR5IGNvbXBhcmlzb24gdXNlZCBpbiBhc3NlcnRpb25zLlxuICpcbiAqIEBwYXJhbSBhIFRoZSBhY3R1YWwgdmFsdWVcbiAqIEBwYXJhbSBiIFRoZSBleHBlY3RlZCB2YWx1ZVxuICogQHJldHVybnMgYHRydWVgIGlmIHRoZSB2YWx1ZXMgYXJlIGRlZXBseSBlcXVhbCwgYGZhbHNlYCBvdGhlcndpc2VcbiAqXG4gKiBAZXhhbXBsZSBVc2FnZVxuICogYGBgdHNcbiAqIGltcG9ydCB7IGVxdWFsIH0gZnJvbSBcIkBzdGQvYXNzZXJ0L2VxdWFsXCI7XG4gKlxuICogZXF1YWwoeyBmb286IFwiYmFyXCIgfSwgeyBmb286IFwiYmFyXCIgfSk7IC8vIFJldHVybnMgYHRydWVgXG4gKiBlcXVhbCh7IGZvbzogXCJiYXJcIiB9LCB7IGZvbzogXCJiYXpcIiB9KTsgLy8gUmV0dXJucyBgZmFsc2VgXG4gKiBgYGBcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVxdWFsKGE6IHVua25vd24sIGI6IHVua25vd24pOiBib29sZWFuIHtcbiAgY29uc3Qgc2VlbiA9IG5ldyBNYXA8dW5rbm93biwgdW5rbm93bj4oKTtcbiAgcmV0dXJuIChmdW5jdGlvbiBjb21wYXJlKGE6IHVua25vd24sIGI6IHVua25vd24pOiBib29sZWFuIHtcbiAgICBpZiAoc2FtZVZhbHVlWmVybyhhLCBiKSkgcmV0dXJuIHRydWU7XG4gICAgaWYgKGlzUHJpbWl0aXZlKGEpIHx8IGlzUHJpbWl0aXZlKGIpKSByZXR1cm4gZmFsc2U7XG5cbiAgICBpZiAoYSBpbnN0YW5jZW9mIERhdGUgJiYgYiBpbnN0YW5jZW9mIERhdGUpIHtcbiAgICAgIHJldHVybiBPYmplY3QuaXMoYS5nZXRUaW1lKCksIGIuZ2V0VGltZSgpKTtcbiAgICB9XG4gICAgaWYgKGEgJiYgdHlwZW9mIGEgPT09IFwib2JqZWN0XCIgJiYgYiAmJiB0eXBlb2YgYiA9PT0gXCJvYmplY3RcIikge1xuICAgICAgaWYgKCFwcm90b3R5cGVzRXF1YWwoYSwgYikpIHtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgfVxuICAgICAgaWYgKGEgaW5zdGFuY2VvZiBUeXBlZEFycmF5KSB7XG4gICAgICAgIHJldHVybiBjb21wYXJlVHlwZWRBcnJheXMoYSBhcyBUeXBlZEFycmF5LCBiIGFzIFR5cGVkQXJyYXkpO1xuICAgICAgfVxuICAgICAgaWYgKFxuICAgICAgICBhIGluc3RhbmNlb2YgQXJyYXlCdWZmZXIgfHxcbiAgICAgICAgKGdsb2JhbFRoaXMuU2hhcmVkQXJyYXlCdWZmZXIgJiYgYSBpbnN0YW5jZW9mIFNoYXJlZEFycmF5QnVmZmVyKVxuICAgICAgKSB7XG4gICAgICAgIHJldHVybiBjb21wYXJlVHlwZWRBcnJheXMoXG4gICAgICAgICAgbmV3IFVpbnQ4QXJyYXkoYSksXG4gICAgICAgICAgbmV3IFVpbnQ4QXJyYXkoYiBhcyBBcnJheUJ1ZmZlciB8IFNoYXJlZEFycmF5QnVmZmVyKSxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmIChhIGluc3RhbmNlb2YgV2Vha01hcCkge1xuICAgICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKFwiQ2Fubm90IGNvbXBhcmUgV2Vha01hcCBpbnN0YW5jZXNcIik7XG4gICAgICB9XG4gICAgICBpZiAoYSBpbnN0YW5jZW9mIFdlYWtTZXQpIHtcbiAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcihcIkNhbm5vdCBjb21wYXJlIFdlYWtTZXQgaW5zdGFuY2VzXCIpO1xuICAgICAgfVxuICAgICAgaWYgKGEgaW5zdGFuY2VvZiBXZWFrUmVmKSB7XG4gICAgICAgIHJldHVybiBjb21wYXJlKGEuZGVyZWYoKSwgKGIgYXMgV2Vha1JlZjxXZWFrS2V5PikuZGVyZWYoKSk7XG4gICAgICB9XG4gICAgICBpZiAoc2Vlbi5nZXQoYSkgPT09IGIpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG4gICAgICBpZiAoT2JqZWN0LmtleXMoYSkubGVuZ3RoICE9PSBPYmplY3Qua2V5cyhiKS5sZW5ndGgpIHtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgfVxuICAgICAgc2Vlbi5zZXQoYSwgYik7XG4gICAgICBpZiAoaXNLZXllZENvbGxlY3Rpb24oYSkgJiYgaXNLZXllZENvbGxlY3Rpb24oYikpIHtcbiAgICAgICAgaWYgKGEuc2l6ZSAhPT0gYi5zaXplKSB7XG4gICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgYUtleXMgPSBbLi4uYS5rZXlzKCldO1xuICAgICAgICBjb25zdCBwcmltaXRpdmVLZXlzRmFzdFBhdGggPSBhS2V5cy5ldmVyeShpc1ByaW1pdGl2ZSk7XG4gICAgICAgIGlmIChwcmltaXRpdmVLZXlzRmFzdFBhdGgpIHtcbiAgICAgICAgICBpZiAoYSBpbnN0YW5jZW9mIFNldCkge1xuICAgICAgICAgICAgcmV0dXJuIGEuc3ltbWV0cmljRGlmZmVyZW5jZShiKS5zaXplID09PSAwO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGZvciAoY29uc3Qga2V5IG9mIGFLZXlzKSB7XG4gICAgICAgICAgICBpZiAoXG4gICAgICAgICAgICAgICFiLmhhcyhrZXkpIHx8XG4gICAgICAgICAgICAgICFjb21wYXJlKGEuZ2V0KGtleSksIChiIGFzIE1hcDx1bmtub3duLCB1bmtub3duPikuZ2V0KGtleSkpXG4gICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCB1bm1hdGNoZWRFbnRyaWVzID0gYS5zaXplO1xuXG4gICAgICAgIGZvciAoY29uc3QgW2FLZXksIGFWYWx1ZV0gb2YgYS5lbnRyaWVzKCkpIHtcbiAgICAgICAgICBmb3IgKGNvbnN0IFtiS2V5LCBiVmFsdWVdIG9mIGIuZW50cmllcygpKSB7XG4gICAgICAgICAgICAvKiBHaXZlbiB0aGF0IE1hcCBrZXlzIGNhbiBiZSByZWZlcmVuY2VzLCB3ZSBuZWVkXG4gICAgICAgICAgICAgKiB0byBlbnN1cmUgdGhhdCB0aGV5IGFyZSBhbHNvIGRlZXBseSBlcXVhbCAqL1xuXG4gICAgICAgICAgICBpZiAoIWNvbXBhcmUoYUtleSwgYktleSkpIGNvbnRpbnVlO1xuXG4gICAgICAgICAgICBpZiAoXG4gICAgICAgICAgICAgIChhS2V5ID09PSBhVmFsdWUgJiYgYktleSA9PT0gYlZhbHVlKSB8fFxuICAgICAgICAgICAgICAoY29tcGFyZShhVmFsdWUsIGJWYWx1ZSkpXG4gICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgdW5tYXRjaGVkRW50cmllcy0tO1xuICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdW5tYXRjaGVkRW50cmllcyA9PT0gMDtcbiAgICAgIH1cblxuICAgICAgbGV0IGtleXM6IEl0ZXJhYmxlPHN0cmluZyB8IHN5bWJvbD47XG5cbiAgICAgIGlmIChpc0Jhc2ljT2JqZWN0T3JBcnJheShhKSkge1xuICAgICAgICAvLyBmYXN0IHBhdGhcbiAgICAgICAga2V5cyA9IG93bktleXMoeyAuLi5hLCAuLi5iIH0pO1xuICAgICAgfSBlbHNlIGlmIChzdHJpbmdDb21wYXJhYmxlUHJvdG90eXBlcy5oYXMoT2JqZWN0LmdldFByb3RvdHlwZU9mKGEpKSkge1xuICAgICAgICAvLyBtZWRpdW0gcGF0aFxuICAgICAgICByZXR1cm4gU3RyaW5nKGEpID09PSBTdHJpbmcoYik7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBzbG93IHBhdGhcbiAgICAgICAga2V5cyA9IGdldEtleXNEZWVwKGEpLnVuaW9uKGdldEtleXNEZWVwKGIpKTtcbiAgICAgIH1cblxuICAgICAgZm9yIChjb25zdCBrZXkgb2Yga2V5cykge1xuICAgICAgICB0eXBlIEtleSA9IGtleW9mIHR5cGVvZiBhO1xuICAgICAgICBpZiAoIWNvbXBhcmUoYVtrZXkgYXMgS2V5XSwgYltrZXkgYXMgS2V5XSkpIHtcbiAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCgoa2V5IGluIGEpICYmICghKGtleSBpbiBiKSkpIHx8ICgoa2V5IGluIGIpICYmICghKGtleSBpbiBhKSkpKSB7XG4gICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9KShhLCBiKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxREFBcUQ7QUFDckQscUNBQXFDO0FBR3JDLFNBQVMsa0JBQWtCLENBQVU7RUFDbkMsT0FBTyxhQUFhLE9BQU8sYUFBYTtBQUMxQztBQUVBLFNBQVMsZ0JBQWdCLENBQVMsRUFBRSxDQUFTO0VBQzNDLE1BQU0sS0FBSyxPQUFPLGNBQWMsQ0FBQztFQUNqQyxNQUFNLEtBQUssT0FBTyxjQUFjLENBQUM7RUFDakMsT0FBTyxPQUFPLE1BQ1osT0FBTyxPQUFPLFNBQVMsSUFBSSxPQUFPLFFBQ2xDLE9BQU8sUUFBUSxPQUFPLE9BQU8sU0FBUztBQUMxQztBQUVBLFNBQVMscUJBQXFCLEdBQVc7RUFDdkMsTUFBTSxRQUFRLE9BQU8sY0FBYyxDQUFDO0VBQ3BDLE9BQU8sVUFBVSxRQUFRLFVBQVUsT0FBTyxTQUFTLElBQ2pELFVBQVUsTUFBTSxTQUFTO0FBQzdCO0FBRUEsa0ZBQWtGO0FBQ2xGLFNBQVMsUUFBUSxHQUFXO0VBQzFCLE9BQU87T0FDRixPQUFPLG1CQUFtQixDQUFDO09BQzNCLE9BQU8scUJBQXFCLENBQUM7R0FDakM7QUFDSDtBQUVBLFNBQVMsWUFBWSxHQUFXO0VBQzlCLE1BQU0sT0FBTyxJQUFJO0VBRWpCLE1BQU8sUUFBUSxPQUFPLFNBQVMsSUFBSSxRQUFRLE1BQU0sU0FBUyxJQUFJLE9BQU8sS0FBTTtJQUN6RSxLQUFLLE1BQU0sT0FBTyxRQUFRLEtBQU07TUFDOUIsS0FBSyxHQUFHLENBQUM7SUFDWDtJ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
// denoCacheMetadata=10158222477952854265,4602479423094749208