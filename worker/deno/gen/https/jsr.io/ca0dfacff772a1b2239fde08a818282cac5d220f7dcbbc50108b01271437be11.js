// Copyright 2018-2025 the Deno authors. MIT license.
// This module is browser compatible.
/** An inspect function conforming to the shape of `Deno.inspect` and `node:util`'s `inspect` */ /**
 * Converts the input into a string. Objects, Sets and Maps are sorted so as to
 * make tests less flaky.
 *
 * @param v Value to be formatted
 *
 * @returns The formatted string
 *
 * @example Usage
 * ```ts
 * import { format } from "@std/internal/format";
 * import { assertEquals } from "@std/assert";
 *
 * assertEquals(format({ a: 1, b: 2 }), "{\n  a: 1,\n  b: 2,\n}");
 * assertEquals(format(new Set([1, 2])), "Set(2) {\n  1,\n  2,\n}");
 * assertEquals(format(new Map([[1, 2]])), "Map(1) {\n  1 => 2,\n}");
 * ```
 */ export function format(v) {
  // deno-lint-ignore no-explicit-any
  const { Deno, process } = globalThis;
  const inspect = Deno?.inspect ?? process?.getBuiltinModule?.("node:util")?.inspect;
  return typeof inspect === "function" ? inspect(v, {
    depth: Infinity,
    sorted: true,
    trailingComma: true,
    compact: false,
    iterableLimit: Infinity,
    // getters should be true in assertEquals.
    getters: true,
    strAbbreviateSize: Infinity
  }) : basicInspect(v);
}
const formatters = [
  (v)=>{
    if (typeof v === "undefined") return "undefined";
    if (typeof v === "bigint") return `${v}n`;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null || Array.isArray(v) || [
      null,
      Object.prototype
    ].includes(Object.getPrototypeOf(v))) {
      return JSON.stringify(v, null, 2);
    }
  },
  (v)=>String(v),
  (v)=>Object.prototype.toString.call(v)
];
// for environments lacking both `Deno.inspect` and `process.inspect`
function basicInspect(v) {
  for (const fmt of formatters){
    try {
      const result = fmt(v);
      if (typeof result === "string") return result;
    } catch  {}
  }
  return "[[Unable to format value]]";
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvaW50ZXJuYWwvMS4wLjEyL2Zvcm1hdC50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBDb3B5cmlnaHQgMjAxOC0yMDI1IHRoZSBEZW5vIGF1dGhvcnMuIE1JVCBsaWNlbnNlLlxuLy8gVGhpcyBtb2R1bGUgaXMgYnJvd3NlciBjb21wYXRpYmxlLlxuXG4vKiogQW4gaW5zcGVjdCBmdW5jdGlvbiBjb25mb3JtaW5nIHRvIHRoZSBzaGFwZSBvZiBgRGVuby5pbnNwZWN0YCBhbmQgYG5vZGU6dXRpbGAncyBgaW5zcGVjdGAgKi9cbmV4cG9ydCB0eXBlIEluc3BlY3RGbiA9IChcbiAgdjogdW5rbm93bixcbiAgb3B0aW9uczoge1xuICAgIGRlcHRoOiBudW1iZXI7XG4gICAgc29ydGVkOiBib29sZWFuO1xuICAgIHRyYWlsaW5nQ29tbWE6IGJvb2xlYW47XG4gICAgY29tcGFjdDogYm9vbGVhbjtcbiAgICBpdGVyYWJsZUxpbWl0OiBudW1iZXI7XG4gICAgZ2V0dGVyczogYm9vbGVhbjtcbiAgICBzdHJBYmJyZXZpYXRlU2l6ZTogbnVtYmVyO1xuICB9LFxuKSA9PiBzdHJpbmc7XG5cbi8qKlxuICogQ29udmVydHMgdGhlIGlucHV0IGludG8gYSBzdHJpbmcuIE9iamVjdHMsIFNldHMgYW5kIE1hcHMgYXJlIHNvcnRlZCBzbyBhcyB0b1xuICogbWFrZSB0ZXN0cyBsZXNzIGZsYWt5LlxuICpcbiAqIEBwYXJhbSB2IFZhbHVlIHRvIGJlIGZvcm1hdHRlZFxuICpcbiAqIEByZXR1cm5zIFRoZSBmb3JtYXR0ZWQgc3RyaW5nXG4gKlxuICogQGV4YW1wbGUgVXNhZ2VcbiAqIGBgYHRzXG4gKiBpbXBvcnQgeyBmb3JtYXQgfSBmcm9tIFwiQHN0ZC9pbnRlcm5hbC9mb3JtYXRcIjtcbiAqIGltcG9ydCB7IGFzc2VydEVxdWFscyB9IGZyb20gXCJAc3RkL2Fzc2VydFwiO1xuICpcbiAqIGFzc2VydEVxdWFscyhmb3JtYXQoeyBhOiAxLCBiOiAyIH0pLCBcIntcXG4gIGE6IDEsXFxuICBiOiAyLFxcbn1cIik7XG4gKiBhc3NlcnRFcXVhbHMoZm9ybWF0KG5ldyBTZXQoWzEsIDJdKSksIFwiU2V0KDIpIHtcXG4gIDEsXFxuICAyLFxcbn1cIik7XG4gKiBhc3NlcnRFcXVhbHMoZm9ybWF0KG5ldyBNYXAoW1sxLCAyXV0pKSwgXCJNYXAoMSkge1xcbiAgMSA9PiAyLFxcbn1cIik7XG4gKiBgYGBcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdCh2OiB1bmtub3duKTogc3RyaW5nIHtcbiAgLy8gZGVuby1saW50LWlnbm9yZSBuby1leHBsaWNpdC1hbnlcbiAgY29uc3QgeyBEZW5vLCBwcm9jZXNzIH0gPSBnbG9iYWxUaGlzIGFzIGFueTtcblxuICBjb25zdCBpbnNwZWN0OiBJbnNwZWN0Rm4gfCB1bmRlZmluZWQgPSBEZW5vPy5pbnNwZWN0ID8/XG4gICAgcHJvY2Vzcz8uZ2V0QnVpbHRpbk1vZHVsZT8uKFwibm9kZTp1dGlsXCIpPy5pbnNwZWN0O1xuXG4gIHJldHVybiB0eXBlb2YgaW5zcGVjdCA9PT0gXCJmdW5jdGlvblwiXG4gICAgPyBpbnNwZWN0KHYsIHtcbiAgICAgIGRlcHRoOiBJbmZpbml0eSxcbiAgICAgIHNvcnRlZDogdHJ1ZSxcbiAgICAgIHRyYWlsaW5nQ29tbWE6IHRydWUsXG4gICAgICBjb21wYWN0OiBmYWxzZSxcbiAgICAgIGl0ZXJhYmxlTGltaXQ6IEluZmluaXR5LFxuICAgICAgLy8gZ2V0dGVycyBzaG91bGQgYmUgdHJ1ZSBpbiBhc3NlcnRFcXVhbHMuXG4gICAgICBnZXR0ZXJzOiB0cnVlLFxuICAgICAgc3RyQWJicmV2aWF0ZVNpemU6IEluZmluaXR5LFxuICAgIH0pXG4gICAgOiBiYXNpY0luc3BlY3Qodik7XG59XG5cbmNvbnN0IGZvcm1hdHRlcnM6ICgodjogdW5rbm93bikgPT4gc3RyaW5nIHwgdW5kZWZpbmVkKVtdID0gW1xuICAodikgPT4ge1xuICAgIGlmICh0eXBlb2YgdiA9PT0gXCJ1bmRlZmluZWRcIikgcmV0dXJuIFwidW5kZWZpbmVkXCI7XG4gICAgaWYgKHR5cGVvZiB2ID09PSBcImJpZ2ludFwiKSByZXR1cm4gYCR7dn1uYDtcblxuICAgIGlmIChcbiAgICAgIHR5cGVvZiB2ID09PSBcInN0cmluZ1wiIHx8XG4gICAgICB0eXBlb2YgdiA9PT0gXCJudW1iZXJcIiB8fFxuICAgICAgdHlwZW9mIHYgPT09IFwiYm9vbGVhblwiIHx8XG4gICAgICB2ID09PSBudWxsIHx8XG4gICAgICBBcnJheS5pc0FycmF5KHYpIHx8XG4gICAgICBbbnVsbCwgT2JqZWN0LnByb3RvdHlwZV0uaW5jbHVkZXMoT2JqZWN0LmdldFByb3RvdHlwZU9mKHYpKVxuICAgICkge1xuICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHYsIG51bGwsIDIpO1xuICAgIH1cbiAgfSxcbiAgKHYpID0+IFN0cmluZyh2KSxcbiAgKHYpID0+IE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbCh2KSxcbl07XG5cbi8vIGZvciBlbnZpcm9ubWVudHMgbGFja2luZyBib3RoIGBEZW5vLmluc3BlY3RgIGFuZCBgcHJvY2Vzcy5pbnNwZWN0YFxuZnVuY3Rpb24gYmFzaWNJbnNwZWN0KHY6IHVua25vd24pOiBzdHJpbmcge1xuICBmb3IgKGNvbnN0IGZtdCBvZiBmb3JtYXR0ZXJzKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGZtdCh2KTtcbiAgICAgIGlmICh0eXBlb2YgcmVzdWx0ID09PSBcInN0cmluZ1wiKSByZXR1cm4gcmVzdWx0O1xuICAgIH0gY2F0Y2ggeyAvKiB0cnkgdGhlIG5leHQgb25lICovIH1cbiAgfVxuXG4gIHJldHVybiBcIltbVW5hYmxlIHRvIGZvcm1hdCB2YWx1ZV1dXCI7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEscURBQXFEO0FBQ3JELHFDQUFxQztBQUVyQyw4RkFBOEYsR0FjOUY7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBaUJDLEdBQ0QsT0FBTyxTQUFTLE9BQU8sQ0FBVTtFQUMvQixtQ0FBbUM7RUFDbkMsTUFBTSxFQUFFLElBQUksRUFBRSxPQUFPLEVBQUUsR0FBRztFQUUxQixNQUFNLFVBQWlDLE1BQU0sV0FDM0MsU0FBUyxtQkFBbUIsY0FBYztFQUU1QyxPQUFPLE9BQU8sWUFBWSxhQUN0QixRQUFRLEdBQUc7SUFDWCxPQUFPO0lBQ1AsUUFBUTtJQUNSLGVBQWU7SUFDZixTQUFTO0lBQ1QsZUFBZTtJQUNmLDBDQUEwQztJQUMxQyxTQUFTO0lBQ1QsbUJBQW1CO0VBQ3JCLEtBQ0UsYUFBYTtBQUNuQjtBQUVBLE1BQU0sYUFBcUQ7RUFDekQsQ0FBQztJQUNDLElBQUksT0FBTyxNQUFNLGFBQWEsT0FBTztJQUNyQyxJQUFJLE9BQU8sTUFBTSxVQUFVLE9BQU8sR0FBRyxFQUFFLENBQUMsQ0FBQztJQUV6QyxJQUNFLE9BQU8sTUFBTSxZQUNiLE9BQU8sTUFBTSxZQUNiLE9BQU8sTUFBTSxhQUNiLE1BQU0sUUFDTixNQUFNLE9BQU8sQ0FBQyxNQUNkO01BQUM7TUFBTSxPQUFPLFNBQVM7S0FBQyxDQUFDLFFBQVEsQ0FBQyxPQUFPLGNBQWMsQ0FBQyxLQUN4RDtNQUNBLE9BQU8sS0FBSyxTQUFTLENBQUMsR0FBRyxNQUFNO0lBQ2pDO0VBQ0Y7RUFDQSxDQUFDLElBQU0sT0FBTztFQUNkLENBQUMsSUFBTSxPQUFPLFNBQVMsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDO0NBQ3ZDO0FBRUQscUVBQXFFO0FBQ3JFLFNBQVMsYUFBYSxDQUFVO0VBQzlCLEtBQUssTUFBTSxPQUFPLFdBQVk7SUFDNUIsSUFBSTtNQUNGLE1BQU0sU0FBUyxJQUFJO01BQ25CLElBQUksT0FBTyxXQUFXLFVBQVUsT0FBTztJQUN6QyxFQUFFLE9BQU0sQ0FBeUI7RUFDbkM7RUFFQSxPQUFPO0FBQ1QifQ==
// denoCacheMetadata=11797907915715820484,2358609066351081080