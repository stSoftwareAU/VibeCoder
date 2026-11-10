// Copyright 2018-2025 the Deno authors. MIT license.
// This module is browser compatible.
const REMOVED = 1;
const COMMON = 2;
const ADDED = 3;
/**
 * Creates an array of common elements between two arrays.
 *
 * @typeParam T The type of elements in the arrays.
 *
 * @param A The first array.
 * @param B The second array.
 *
 * @returns An array containing the common elements between the two arrays.
 *
 * @example Usage
 * ```ts
 * import { createCommon } from "@std/internal/diff";
 * import { assertEquals } from "@std/assert";
 *
 * const a = [1, 2, 3];
 * const b = [1, 2, 4];
 *
 * assertEquals(createCommon(a, b), [1, 2]);
 * ```
 */ export function createCommon(A, B) {
  const common = [];
  if (A.length === 0 || B.length === 0) return [];
  for(let i = 0; i < Math.min(A.length, B.length); i += 1){
    const a = A[i];
    const b = B[i];
    if (a !== undefined && a === b) {
      common.push(a);
    } else {
      return common;
    }
  }
  return common;
}
/**
 * Asserts that the value is a {@linkcode FarthestPoint}.
 * If not, an error is thrown.
 *
 * @param value The value to check.
 *
 * @returns A void value that returns once the assertion completes.
 *
 * @example Usage
 * ```ts
 * import { assertFp } from "@std/internal/diff";
 * import { assertThrows } from "@std/assert";
 *
 * assertFp({ y: 0, id: 0 });
 * assertThrows(() => assertFp({ id: 0 }));
 * assertThrows(() => assertFp({ y: 0 }));
 * assertThrows(() => assertFp(undefined));
 * ```
 */ export function assertFp(value) {
  if (value == null || typeof value !== "object" || typeof value?.y !== "number" || typeof value?.id !== "number") {
    throw new Error(`Unexpected value, expected 'FarthestPoint': received ${typeof value}`);
  }
}
/**
 * Creates an array of backtraced differences.
 *
 * @typeParam T The type of elements in the arrays.
 *
 * @param A The first array.
 * @param B The second array.
 * @param current The current {@linkcode FarthestPoint}.
 * @param swapped Boolean indicating if the arrays are swapped.
 * @param routes The routes array.
 * @param diffTypesPtrOffset The offset of the diff types in the routes array.
 *
 * @returns An array of backtraced differences.
 *
 * @example Usage
 * ```ts
 * import { backTrace } from "@std/internal/diff";
 * import { assertEquals } from "@std/assert";
 *
 * assertEquals(
 *   backTrace([], [], { y: 0, id: 0 }, false, new Uint32Array(0), 0),
 *   [],
 * );
 * ```
 */ export function backTrace(A, B, current, swapped, routes, diffTypesPtrOffset) {
  const M = A.length;
  const N = B.length;
  const result = [];
  let a = M - 1;
  let b = N - 1;
  let j = routes[current.id];
  let type = routes[current.id + diffTypesPtrOffset];
  while(true){
    if (!j && !type) break;
    const prev = j;
    if (type === REMOVED) {
      result.unshift({
        type: swapped ? "removed" : "added",
        value: B[b]
      });
      b -= 1;
    } else if (type === ADDED) {
      result.unshift({
        type: swapped ? "added" : "removed",
        value: A[a]
      });
      a -= 1;
    } else {
      result.unshift({
        type: "common",
        value: A[a]
      });
      a -= 1;
      b -= 1;
    }
    j = routes[prev];
    type = routes[prev + diffTypesPtrOffset];
  }
  return result;
}
/**
 * Creates a {@linkcode FarthestPoint}.
 *
 * @param k The current index.
 * @param M The length of the first array.
 * @param routes The routes array.
 * @param diffTypesPtrOffset The offset of the diff types in the routes array.
 * @param ptr The current pointer.
 * @param slide The slide {@linkcode FarthestPoint}.
 * @param down The down {@linkcode FarthestPoint}.
 *
 * @returns A {@linkcode FarthestPoint}.
 *
 * @example Usage
 * ```ts
 * import { createFp } from "@std/internal/diff";
 * import { assertEquals } from "@std/assert";
 *
 * assertEquals(
 *   createFp(
 *     0,
 *     0,
 *     new Uint32Array(0),
 *     0,
 *     0,
 *     { y: -1, id: 0 },
 *     { y: 0, id: 0 },
 *   ),
 *   { y: -1, id: 1 },
 * );
 * ```
 */ export function createFp(k, M, routes, diffTypesPtrOffset, ptr, slide, down) {
  if (slide && slide.y === -1 && down && down.y === -1) {
    return {
      y: 0,
      id: 0
    };
  }
  const isAdding = down?.y === -1 || k === M || (slide?.y ?? 0) > (down?.y ?? 0) + 1;
  if (slide && isAdding) {
    const prev = slide.id;
    ptr++;
    routes[ptr] = prev;
    routes[ptr + diffTypesPtrOffset] = ADDED;
    return {
      y: slide.y,
      id: ptr
    };
  }
  if (down && !isAdding) {
    const prev = down.id;
    ptr++;
    routes[ptr] = prev;
    routes[ptr + diffTypesPtrOffset] = REMOVED;
    return {
      y: down.y + 1,
      id: ptr
    };
  }
  throw new Error("Unexpected missing FarthestPoint");
}
/**
 * Renders the differences between the actual and expected values.
 *
 * @typeParam T The type of elements in the arrays.
 *
 * @param A Actual value
 * @param B Expected value
 *
 * @returns An array of differences between the actual and expected values.
 *
 * @example Usage
 * ```ts
 * import { diff } from "@std/internal/diff";
 * import { assertEquals } from "@std/assert";
 *
 * const a = [1, 2, 3];
 * const b = [1, 2, 4];
 *
 * assertEquals(diff(a, b), [
 *   { type: "common", value: 1 },
 *   { type: "common", value: 2 },
 *   { type: "removed", value: 3 },
 *   { type: "added", value: 4 },
 * ]);
 * ```
 */ export function diff(A, B) {
  const prefixCommon = createCommon(A, B);
  A = A.slice(prefixCommon.length);
  B = B.slice(prefixCommon.length);
  const swapped = B.length > A.length;
  [A, B] = swapped ? [
    B,
    A
  ] : [
    A,
    B
  ];
  const M = A.length;
  const N = B.length;
  if (!M && !N && !prefixCommon.length) return [];
  if (!N) {
    return [
      ...prefixCommon.map((value)=>({
          type: "common",
          value
        })),
      ...A.map((value)=>({
          type: swapped ? "added" : "removed",
          value
        }))
    ];
  }
  const offset = N;
  const delta = M - N;
  const length = M + N + 1;
  const fp = Array.from({
    length
  }, ()=>({
      y: -1,
      id: -1
    }));
  /**
   * Note: this buffer is used to save memory and improve performance. The first
   * half is used to save route and the last half is used to save diff type.
   */ const routes = new Uint32Array((M * N + length + 1) * 2);
  const diffTypesPtrOffset = routes.length / 2;
  let ptr = 0;
  function snake(k, A, B, slide, down) {
    const M = A.length;
    const N = B.length;
    const fp = createFp(k, M, routes, diffTypesPtrOffset, ptr, slide, down);
    ptr = fp.id;
    while(fp.y + k < M && fp.y < N && A[fp.y + k] === B[fp.y]){
      const prev = fp.id;
      ptr++;
      fp.id = ptr;
      fp.y += 1;
      routes[ptr] = prev;
      routes[ptr + diffTypesPtrOffset] = COMMON;
    }
    return fp;
  }
  let currentFp = fp[delta + offset];
  assertFp(currentFp);
  let p = -1;
  while(currentFp.y < N){
    p = p + 1;
    for(let k = -p; k < delta; ++k){
      const index = k + offset;
      fp[index] = snake(k, A, B, fp[index - 1], fp[index + 1]);
    }
    for(let k = delta + p; k > delta; --k){
      const index = k + offset;
      fp[index] = snake(k, A, B, fp[index - 1], fp[index + 1]);
    }
    const index = delta + offset;
    fp[delta + offset] = snake(delta, A, B, fp[index - 1], fp[index + 1]);
    currentFp = fp[delta + offset];
    assertFp(currentFp);
  }
  return [
    ...prefixCommon.map((value)=>({
        type: "common",
        value
      })),
    ...backTrace(A, B, currentFp, swapped, routes, diffTypesPtrOffset)
  ];
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvaW50ZXJuYWwvMS4wLjEyL2RpZmYudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQ29weXJpZ2h0IDIwMTgtMjAyNSB0aGUgRGVubyBhdXRob3JzLiBNSVQgbGljZW5zZS5cbi8vIFRoaXMgbW9kdWxlIGlzIGJyb3dzZXIgY29tcGF0aWJsZS5cblxuaW1wb3J0IHR5cGUgeyBEaWZmUmVzdWx0LCBEaWZmVHlwZSB9IGZyb20gXCIuL3R5cGVzLnRzXCI7XG5cbi8qKiBSZXByZXNlbnRzIHRoZSBmYXJ0aGVzdCBwb2ludCBpbiB0aGUgZGlmZiBhbGdvcml0aG0uICovXG5leHBvcnQgaW50ZXJmYWNlIEZhcnRoZXN0UG9pbnQge1xuICAvKiogVGhlIHktY29vcmRpbmF0ZSBvZiB0aGUgcG9pbnQuICovXG4gIHk6IG51bWJlcjtcbiAgLyoqIFRoZSBpZCBvZiB0aGUgcG9pbnQuICovXG4gIGlkOiBudW1iZXI7XG59XG5cbmNvbnN0IFJFTU9WRUQgPSAxO1xuY29uc3QgQ09NTU9OID0gMjtcbmNvbnN0IEFEREVEID0gMztcblxuLyoqXG4gKiBDcmVhdGVzIGFuIGFycmF5IG9mIGNvbW1vbiBlbGVtZW50cyBiZXR3ZWVuIHR3byBhcnJheXMuXG4gKlxuICogQHR5cGVQYXJhbSBUIFRoZSB0eXBlIG9mIGVsZW1lbnRzIGluIHRoZSBhcnJheXMuXG4gKlxuICogQHBhcmFtIEEgVGhlIGZpcnN0IGFycmF5LlxuICogQHBhcmFtIEIgVGhlIHNlY29uZCBhcnJheS5cbiAqXG4gKiBAcmV0dXJucyBBbiBhcnJheSBjb250YWluaW5nIHRoZSBjb21tb24gZWxlbWVudHMgYmV0d2VlbiB0aGUgdHdvIGFycmF5cy5cbiAqXG4gKiBAZXhhbXBsZSBVc2FnZVxuICogYGBgdHNcbiAqIGltcG9ydCB7IGNyZWF0ZUNvbW1vbiB9IGZyb20gXCJAc3RkL2ludGVybmFsL2RpZmZcIjtcbiAqIGltcG9ydCB7IGFzc2VydEVxdWFscyB9IGZyb20gXCJAc3RkL2Fzc2VydFwiO1xuICpcbiAqIGNvbnN0IGEgPSBbMSwgMiwgM107XG4gKiBjb25zdCBiID0gWzEsIDIsIDRdO1xuICpcbiAqIGFzc2VydEVxdWFscyhjcmVhdGVDb21tb24oYSwgYiksIFsxLCAyXSk7XG4gKiBgYGBcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZUNvbW1vbjxUPihBOiBUW10sIEI6IFRbXSk6IFRbXSB7XG4gIGNvbnN0IGNvbW1vbjogVFtdID0gW107XG4gIGlmIChBLmxlbmd0aCA9PT0gMCB8fCBCLmxlbmd0aCA9PT0gMCkgcmV0dXJuIFtdO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IE1hdGgubWluKEEubGVuZ3RoLCBCLmxlbmd0aCk7IGkgKz0gMSkge1xuICAgIGNvbnN0IGEgPSBBW2ldO1xuICAgIGNvbnN0IGIgPSBCW2ldO1xuICAgIGlmIChhICE9PSB1bmRlZmluZWQgJiYgYSA9PT0gYikge1xuICAgICAgY29tbW9uLnB1c2goYSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJldHVybiBjb21tb247XG4gICAgfVxuICB9XG4gIHJldHVybiBjb21tb247XG59XG5cbi8qKlxuICogQXNzZXJ0cyB0aGF0IHRoZSB2YWx1ZSBpcyBhIHtAbGlua2NvZGUgRmFydGhlc3RQb2ludH0uXG4gKiBJZiBub3QsIGFuIGVycm9yIGlzIHRocm93bi5cbiAqXG4gKiBAcGFyYW0gdmFsdWUgVGhlIHZhbHVlIHRvIGNoZWNrLlxuICpcbiAqIEByZXR1cm5zIEEgdm9pZCB2YWx1ZSB0aGF0IHJldHVybnMgb25jZSB0aGUgYXNzZXJ0aW9uIGNvbXBsZXRlcy5cbiAqXG4gKiBAZXhhbXBsZSBVc2FnZVxuICogYGBgdHNcbiAqIGltcG9ydCB7IGFzc2VydEZwIH0gZnJvbSBcIkBzdGQvaW50ZXJuYWwvZGlmZlwiO1xuICogaW1wb3J0IHsgYXNzZXJ0VGhyb3dzIH0gZnJvbSBcIkBzdGQvYXNzZXJ0XCI7XG4gKlxuICogYXNzZXJ0RnAoeyB5OiAwLCBpZDogMCB9KTtcbiAqIGFzc2VydFRocm93cygoKSA9PiBhc3NlcnRGcCh7IGlkOiAwIH0pKTtcbiAqIGFzc2VydFRocm93cygoKSA9PiBhc3NlcnRGcCh7IHk6IDAgfSkpO1xuICogYXNzZXJ0VGhyb3dzKCgpID0+IGFzc2VydEZwKHVuZGVmaW5lZCkpO1xuICogYGBgXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhc3NlcnRGcCh2YWx1ZTogdW5rbm93bik6IGFzc2VydHMgdmFsdWUgaXMgRmFydGhlc3RQb2ludCB7XG4gIGlmIChcbiAgICB2YWx1ZSA9PSBudWxsIHx8XG4gICAgdHlwZW9mIHZhbHVlICE9PSBcIm9iamVjdFwiIHx8XG4gICAgdHlwZW9mICh2YWx1ZSBhcyBGYXJ0aGVzdFBvaW50KT8ueSAhPT0gXCJudW1iZXJcIiB8fFxuICAgIHR5cGVvZiAodmFsdWUgYXMgRmFydGhlc3RQb2ludCk/LmlkICE9PSBcIm51bWJlclwiXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBVbmV4cGVjdGVkIHZhbHVlLCBleHBlY3RlZCAnRmFydGhlc3RQb2ludCc6IHJlY2VpdmVkICR7dHlwZW9mIHZhbHVlfWAsXG4gICAgKTtcbiAgfVxufVxuXG4vKipcbiAqIENyZWF0ZXMgYW4gYXJyYXkgb2YgYmFja3RyYWNlZCBkaWZmZXJlbmNlcy5cbiAqXG4gKiBAdHlwZVBhcmFtIFQgVGhlIHR5cGUgb2YgZWxlbWVudHMgaW4gdGhlIGFycmF5cy5cbiAqXG4gKiBAcGFyYW0gQSBUaGUgZmlyc3QgYXJyYXkuXG4gKiBAcGFyYW0gQiBUaGUgc2Vjb25kIGFycmF5LlxuICogQHBhcmFtIGN1cnJlbnQgVGhlIGN1cnJlbnQge0BsaW5rY29kZSBGYXJ0aGVzdFBvaW50fS5cbiAqIEBwYXJhbSBzd2FwcGVkIEJvb2xlYW4gaW5kaWNhdGluZyBpZiB0aGUgYXJyYXlzIGFyZSBzd2FwcGVkLlxuICogQHBhcmFtIHJvdXRlcyBUaGUgcm91dGVzIGFycmF5LlxuICogQHBhcmFtIGRpZmZUeXBlc1B0ck9mZnNldCBUaGUgb2Zmc2V0IG9mIHRoZSBkaWZmIHR5cGVzIGluIHRoZSByb3V0ZXMgYXJyYXkuXG4gKlxuICogQHJldHVybnMgQW4gYXJyYXkgb2YgYmFja3RyYWNlZCBkaWZmZXJlbmNlcy5cbiAqXG4gKiBAZXhhbXBsZSBVc2FnZVxuICogYGBgdHNcbiAqIGltcG9ydCB7IGJhY2tUcmFjZSB9IGZyb20gXCJAc3RkL2ludGVybmFsL2RpZmZcIjtcbiAqIGltcG9ydCB7IGFzc2VydEVxdWFscyB9IGZyb20gXCJAc3RkL2Fzc2VydFwiO1xuICpcbiAqIGFzc2VydEVxdWFscyhcbiAqICAgYmFja1RyYWNlKFtdLCBbXSwgeyB5OiAwLCBpZDogMCB9LCBmYWxzZSwgbmV3IFVpbnQzMkFycmF5KDApLCAwKSxcbiAqICAgW10sXG4gKiApO1xuICogYGBgXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBiYWNrVHJhY2U8VD4oXG4gIEE6IFRbXSxcbiAgQjogVFtdLFxuICBjdXJyZW50OiBGYXJ0aGVzdFBvaW50LFxuICBzd2FwcGVkOiBib29sZWFuLFxuICByb3V0ZXM6IFVpbnQzMkFycmF5LFxuICBkaWZmVHlwZXNQdHJPZmZzZXQ6IG51bWJlcixcbik6IEFycmF5PHtcbiAgdHlwZTogRGlmZlR5cGU7XG4gIHZhbHVlOiBUO1xufT4ge1xuICBjb25zdCBNID0gQS5sZW5ndGg7XG4gIGNvbnN0IE4gPSBCLmxlbmd0aDtcbiAgY29uc3QgcmVzdWx0OiB7IHR5cGU6IERpZmZUeXBlOyB2YWx1ZTogVCB9W10gPSBbXTtcbiAgbGV0IGEgPSBNIC0gMTtcbiAgbGV0IGIgPSBOIC0gMTtcbiAgbGV0IGogPSByb3V0ZXNbY3VycmVudC5pZF07XG4gIGxldCB0eXBlID0gcm91dGVzW2N1cnJlbnQuaWQgKyBkaWZmVHlwZXNQdHJPZmZzZXRdO1xuICB3aGlsZSAodHJ1ZSkge1xuICAgIGlmICghaiAmJiAhdHlwZSkgYnJlYWs7XG4gICAgY29uc3QgcHJldiA9IGohO1xuICAgIGlmICh0eXBlID09PSBSRU1PVkVEKSB7XG4gICAgICByZXN1bHQudW5zaGlmdCh7XG4gICAgICAgIHR5cGU6IHN3YXBwZWQgPyBcInJlbW92ZWRcIiA6IFwiYWRkZWRcIixcbiAgICAgICAgdmFsdWU6IEJbYl0hLFxuICAgICAgfSk7XG4gICAgICBiIC09IDE7XG4gICAgfSBlbHNlIGlmICh0eXBlID09PSBBRERFRCkge1xuICAgICAgcmVzdWx0LnVuc2hpZnQoe1xuICAgICAgICB0eXBlOiBzd2FwcGVkID8gXCJhZGRlZFwiIDogXCJyZW1vdmVkXCIsXG4gICAgICAgIHZhbHVlOiBBW2FdISxcbiAgICAgIH0pO1xuICAgICAgYSAtPSAxO1xuICAgIH0gZWxzZSB7XG4gICAgICByZXN1bHQudW5zaGlmdCh7IHR5cGU6IFwiY29tbW9uXCIsIHZhbHVlOiBBW2FdISB9KTtcbiAgICAgIGEgLT0gMTtcbiAgICAgIGIgLT0gMTtcbiAgICB9XG4gICAgaiA9IHJvdXRlc1twcmV2XTtcbiAgICB0eXBlID0gcm91dGVzW3ByZXYgKyBkaWZmVHlwZXNQdHJPZmZzZXRdO1xuICB9XG4gIHJldHVybiByZXN1bHQ7XG59XG5cbi8qKlxuICogQ3JlYXRlcyBhIHtAbGlua2NvZGUgRmFydGhlc3RQb2ludH0uXG4gKlxuICogQHBhcmFtIGsgVGhlIGN1cnJlbnQgaW5kZXguXG4gKiBAcGFyYW0gTSBUaGUgbGVuZ3RoIG9mIHRoZSBmaXJzdCBhcnJheS5cbiAqIEBwYXJhbSByb3V0ZXMgVGhlIHJvdXRlcyBhcnJheS5cbiAqIEBwYXJhbSBkaWZmVHlwZXNQdHJPZmZzZXQgVGhlIG9mZnNldCBvZiB0aGUgZGlmZiB0eXBlcyBpbiB0aGUgcm91dGVzIGFycmF5LlxuICogQHBhcmFtIHB0ciBUaGUgY3VycmVudCBwb2ludGVyLlxuICogQHBhcmFtIHNsaWRlIFRoZSBzbGlkZSB7QGxpbmtjb2RlIEZhcnRoZXN0UG9pbnR9LlxuICogQHBhcmFtIGRvd24gVGhlIGRvd24ge0BsaW5rY29kZSBGYXJ0aGVzdFBvaW50fS5cbiAqXG4gKiBAcmV0dXJucyBBIHtAbGlua2NvZGUgRmFydGhlc3RQb2ludH0uXG4gKlxuICogQGV4YW1wbGUgVXNhZ2VcbiAqIGBgYHRzXG4gKiBpbXBvcnQgeyBjcmVhdGVGcCB9IGZyb20gXCJAc3RkL2ludGVybmFsL2RpZmZcIjtcbiAqIGltcG9ydCB7IGFzc2VydEVxdWFscyB9IGZyb20gXCJAc3RkL2Fzc2VydFwiO1xuICpcbiAqIGFzc2VydEVxdWFscyhcbiAqICAgY3JlYXRlRnAoXG4gKiAgICAgMCxcbiAqICAgICAwLFxuICogICAgIG5ldyBVaW50MzJBcnJheSgwKSxcbiAqICAgICAwLFxuICogICAgIDAsXG4gKiAgICAgeyB5OiAtMSwgaWQ6IDAgfSxcbiAqICAgICB7IHk6IDAsIGlkOiAwIH0sXG4gKiAgICksXG4gKiAgIHsgeTogLTEsIGlkOiAxIH0sXG4gKiApO1xuICogYGBgXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVGcChcbiAgazogbnVtYmVyLFxuICBNOiBudW1iZXIsXG4gIHJvdXRlczogVWludDMyQXJyYXksXG4gIGRpZmZUeXBlc1B0ck9mZnNldDogbnVtYmVyLFxuICBwdHI6IG51bWJlcixcbiAgc2xpZGU/OiBGYXJ0aGVzdFBvaW50LFxuICBkb3duPzogRmFydGhlc3RQb2ludCxcbik6IEZhcnRoZXN0UG9pbnQge1xuICBpZiAoc2xpZGUgJiYgc2xpZGUueSA9PT0gLTEgJiYgZG93biAmJiBkb3duLnkgPT09IC0xKSB7XG4gICAgcmV0dXJuIHsgeTogMCwgaWQ6IDAgfTtcbiAgfVxuICBjb25zdCBpc0FkZGluZyA9IChkb3duPy55ID09PSAtMSkgfHxcbiAgICBrID09PSBNIHx8XG4gICAgKHNsaWRlPy55ID8/IDApID4gKGRvd24/LnkgPz8gMCkgKyAxO1xuICBpZiAoc2xpZGUgJiYgaXNBZGRpbmcpIHtcbiAgICBjb25zdCBwcmV2ID0gc2xpZGUuaWQ7XG4gICAgcHRyKys7XG4gICAgcm91dGVzW3B0cl0gPSBwcmV2O1xuICAgIHJvdXRlc1twdHIgKyBkaWZmVHlwZXNQdHJPZmZzZXRdID0gQURERUQ7XG4gICAgcmV0dXJuIHsgeTogc2xpZGUueSwgaWQ6IHB0ciB9O1xuICB9XG4gIGlmIChkb3duICYmICFpc0FkZGluZykge1xuICAgIGNvbnN0IHByZXYgPSBkb3duLmlkO1xuICAgIHB0cisrO1xuICAgIHJvdXRlc1twdHJdID0gcHJldjtcbiAgICByb3V0ZXNbcHRyICsgZGlmZlR5cGVzUHRyT2Zmc2V0XSA9IFJFTU9WRUQ7XG4gICAgcmV0dXJuIHsgeTogZG93bi55ICsgMSwgaWQ6IHB0ciB9O1xuICB9XG4gIHRocm93IG5ldyBFcnJvcihcIlVuZXhwZWN0ZWQgbWlzc2luZyBGYXJ0aGVzdFBvaW50XCIpO1xufVxuXG4vKipcbiAqIFJlbmRlcnMgdGhlIGRpZmZlcmVuY2VzIGJldHdlZW4gdGhlIGFjdHVhbCBhbmQgZXhwZWN0ZWQgdmFsdWVzLlxuICpcbiAqIEB0eXBlUGFyYW0gVCBUaGUgdHlwZSBvZiBlbGVtZW50cyBpbiB0aGUgYXJyYXlzLlxuICpcbiAqIEBwYXJhbSBBIEFjdHVhbCB2YWx1ZVxuICogQHBhcmFtIEIgRXhwZWN0ZWQgdmFsdWVcbiAqXG4gKiBAcmV0dXJucyBBbiBhcnJheSBvZiBkaWZmZXJlbmNlcyBiZXR3ZWVuIHRoZSBhY3R1YWwgYW5kIGV4cGVjdGVkIHZhbHVlcy5cbiAqXG4gKiBAZXhhbXBsZSBVc2FnZVxuICogYGBgdHNcbiAqIGltcG9ydCB7IGRpZmYgfSBmcm9tIFwiQHN0ZC9pbnRlcm5hbC9kaWZmXCI7XG4gKiBpbXBvcnQgeyBhc3NlcnRFcXVhbHMgfSBmcm9tIFwiQHN0ZC9hc3NlcnRcIjtcbiAqXG4gKiBjb25zdCBhID0gWzEsIDIsIDNdO1xuICogY29uc3QgYiA9IFsxLCAyLCA0XTtcbiAqXG4gKiBhc3NlcnRFcXVhbHMoZGlmZihhLCBiKSwgW1xuICogICB7IHR5cGU6IFwiY29tbW9uXCIsIHZhbHVlOiAxIH0sXG4gKiAgIHsgdHlwZTogXCJjb21tb25cIiwgdmFsdWU6IDIgfSxcbiAqICAgeyB0eXBlOiBcInJlbW92ZWRcIiwgdmFsdWU6IDMgfSxcbiAqICAgeyB0eXBlOiBcImFkZGVkXCIsIHZhbHVlOiA0IH0sXG4gKiBdKTtcbiAqIGBgYFxuICovXG5leHBvcnQgZnVuY3Rpb24gZGlmZjxUPihBOiBUW10sIEI6IFRbXSk6IERpZmZSZXN1bHQ8VD5bXSB7XG4gIGNvbnN0IHByZWZpeENvbW1vbiA9IGNyZWF0ZUNvbW1vbihBLCBCKTtcbiAgQSA9IEEuc2xpY2UocHJlZml4Q29tbW9uLmxlbmd0aCk7XG4gIEIgPSBCLnNsaWNlKHByZWZpeENvbW1vbi5sZW5ndGgpO1xuICBjb25zdCBzd2FwcGVkID0gQi5sZW5ndGggPiBBLmxlbmd0aDtcbiAgW0EsIEJdID0gc3dhcHBlZCA/IFtCLCBBXSA6IFtBLCBCXTtcbiAgY29uc3QgTSA9IEEubGVuZ3RoO1xuICBjb25zdCBOID0gQi5sZW5ndGg7XG4gIGlmICghTSAmJiAhTiAmJiAhcHJlZml4Q29tbW9uLmxlbmd0aCkgcmV0dXJuIFtdO1xuICBpZiAoIU4pIHtcbiAgICByZXR1cm4gW1xuICAgICAgLi4ucHJlZml4Q29tbW9uLm1hcCgodmFsdWUpID0+ICh7IHR5cGU6IFwiY29tbW9uXCIsIHZhbHVlIH0pKSxcbiAgICAgIC4uLkEubWFwKCh2YWx1ZSkgPT4gKHsgdHlwZTogc3dhcHBlZCA/IFwiYWRkZWRcIiA6IFwicmVtb3ZlZFwiLCB2YWx1ZSB9KSksXG4gICAgXSBhcyBEaWZmUmVzdWx0PFQ+W107XG4gIH1cbiAgY29uc3Qgb2Zmc2V0ID0gTjtcbiAgY29uc3QgZGVsdGEgPSBNIC0gTjtcbiAgY29uc3QgbGVuZ3RoID0gTSArIE4gKyAxO1xuICBjb25zdCBmcDogRmFydGhlc3RQb2ludFtdID0gQXJyYXkuZnJvbSh7IGxlbmd0aCB9LCAoKSA9PiAoeyB5OiAtMSwgaWQ6IC0xIH0pKTtcblxuICAvKipcbiAgICogTm90ZTogdGhpcyBidWZmZXIgaXMgdXNlZCB0byBzYXZlIG1lbW9yeSBhbmQgaW1wcm92ZSBwZXJmb3JtYW5jZS4gVGhlIGZpcnN0XG4gICAqIGhhbGYgaXMgdXNlZCB0byBzYXZlIHJvdXRlIGFuZCB0aGUgbGFzdCBoYWxmIGlzIHVzZWQgdG8gc2F2ZSBkaWZmIHR5cGUuXG4gICAqL1xuICBjb25zdCByb3V0ZXMgPSBuZXcgVWludDMyQXJyYXkoKE0gKiBOICsgbGVuZ3RoICsgMSkgKiAyKTtcbiAgY29uc3QgZGlmZlR5cGVzUHRyT2Zmc2V0ID0gcm91dGVzLmxlbmd0aCAvIDI7XG4gIGxldCBwdHIgPSAwO1xuXG4gIGZ1bmN0aW9uIHNuYWtlPFQ+KFxuICAgIGs6IG51bWJlcixcbiAgICBBOiBUW10sXG4gICAgQjogVFtdLFxuICAgIHNsaWRlPzogRmFydGhlc3RQb2ludCxcbiAgICBkb3duPzogRmFydGhlc3RQb2ludCxcbiAgKTogRmFydGhlc3RQb2ludCB7XG4gICAgY29uc3QgTSA9IEEubGVuZ3RoO1xuICAgIGNvbnN0IE4gPSBCLmxlbmd0aDtcbiAgICBjb25zdCBmcCA9IGNyZWF0ZUZwKGssIE0sIHJvdXRlcywgZGlmZlR5cGVzUHRyT2Zmc2V0LCBwdHIsIHNsaWRlLCBkb3duKTtcbiAgICBwdHIgPSBmcC5pZDtcbiAgICB3aGlsZSAoZnAueSArIGsgPCBNICYmIGZwLnkgPCBOICYmIEFbZnAueSArIGtdID09PSBCW2ZwLnldKSB7XG4gICAgICBjb25zdCBwcmV2ID0gZnAuaWQ7XG4gICAgICBwdHIrKztcbiAgICAgIGZwLmlkID0gcHRyO1xuICAgICAgZnAueSArPSAxO1xuICAgICAgcm91dGVzW3B0cl0gPSBwcmV2O1xuICAgICAgcm91dGVzW3B0ciArIGRpZmZUeXBlc1B0ck9mZnNldF0gPSBDT01NT047XG4gICAgfVxuICAgIHJldHVybiBmcDtcbiAgfVxuXG4gIGxldCBjdXJyZW50RnAgPSBmcFtkZWx0YSArIG9mZnNldF07XG4gIGFzc2VydEZwKGN1cnJlbnRGcCk7XG4gIGxldCBwID0gLTE7XG4gIHdoaWxlIChjdXJyZW50RnAueSA8IE4pIHtcbiAgICBwID0gcCArIDE7XG4gICAgZm9yIChsZXQgayA9IC1wOyBrIDwgZGVsdGE7ICsraykge1xuICAgICAgY29uc3QgaW5kZXggPSBrICsgb2Zmc2V0O1xuICAgICAgZnBbaW5kZXhdID0gc25ha2UoaywgQSwgQiwgZnBbaW5kZXggLSAxXSwgZnBbaW5kZXggKyAxXSk7XG4gICAgfVxuICAgIGZvciAobGV0IGsgPSBkZWx0YSArIHA7IGsgPiBkZWx0YTsgLS1rKSB7XG4gICAgICBjb25zdCBpbmRleCA9IGsgKyBvZmZzZXQ7XG4gICAgICBmcFtpbmRleF0gPSBzbmFrZShrLCBBLCBCLCBmcFtpbmRleCAtIDFdLCBmcFtpbmRleCArIDFdKTtcbiAgICB9XG4gICAgY29uc3QgaW5kZXggPSBkZWx0YSArIG9mZnNldDtcbiAgICBmcFtkZWx0YSArIG9mZnNldF0gPSBzbmFrZShkZWx0YSwgQSwgQiwgZnBbaW5kZXggLSAxXSwgZnBbaW5kZXggKyAxXSk7XG4gICAgY3VycmVudEZwID0gZnBbZGVsdGEgKyBvZmZzZXRdO1xuICAgIGFzc2VydEZwKGN1cnJlbnRGcCk7XG4gIH1cbiAgcmV0dXJuIFtcbiAgICAuLi5wcmVmaXhDb21tb24ubWFwKCh2YWx1ZSkgPT4gKHsgdHlwZTogXCJjb21tb25cIiwgdmFsdWUgfSkpLFxuICAgIC4uLmJhY2tUcmFjZShBLCBCLCBjdXJyZW50RnAsIHN3YXBwZWQsIHJvdXRlcywgZGlmZlR5cGVzUHRyT2Zmc2V0KSxcbiAgXSBhcyBEaWZmUmVzdWx0PFQ+W107XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEscURBQXFEO0FBQ3JELHFDQUFxQztBQVlyQyxNQUFNLFVBQVU7QUFDaEIsTUFBTSxTQUFTO0FBQ2YsTUFBTSxRQUFRO0FBRWQ7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBb0JDLEdBQ0QsT0FBTyxTQUFTLGFBQWdCLENBQU0sRUFBRSxDQUFNO0VBQzVDLE1BQU0sU0FBYyxFQUFFO0VBQ3RCLElBQUksRUFBRSxNQUFNLEtBQUssS0FBSyxFQUFFLE1BQU0sS0FBSyxHQUFHLE9BQU8sRUFBRTtFQUMvQyxJQUFLLElBQUksSUFBSSxHQUFHLElBQUksS0FBSyxHQUFHLENBQUMsRUFBRSxNQUFNLEVBQUUsRUFBRSxNQUFNLEdBQUcsS0FBSyxFQUFHO0lB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
// denoCacheMetadata=13745520356003668235,2246007250586072422