// Copyright 2018-2025 the Deno authors. MIT license.
// This module is browser compatible.
import { bgGreen, bgRed, bold, gray, green, red, white } from "./styles.ts";
/**
 * Colors the output of assertion diffs.
 *
 * @param diffType Difference type, either added or removed.
 * @param background If true, colors the background instead of the text.
 *
 * @returns A function that colors the input string.
 *
 * @example Usage
 * ```ts
 * import { createColor } from "@std/internal";
 * import { assertEquals } from "@std/assert";
 * import { bold, green, red, white } from "@std/fmt/colors";
 *
 * assertEquals(createColor("added")("foo"), green(bold("foo")));
 * assertEquals(createColor("removed")("foo"), red(bold("foo")));
 * assertEquals(createColor("common")("foo"), white("foo"));
 * ```
 */ export function createColor(diffType, /**
   * TODO(@littledivy): Remove this when we can detect true color terminals. See
   * https://github.com/denoland/std/issues/2575.
   */ background = false) {
  switch(diffType){
    case "added":
      return (s)=>background ? bgGreen(white(s)) : green(bold(s));
    case "removed":
      return (s)=>background ? bgRed(white(s)) : red(bold(s));
    case "truncation":
      return gray;
    default:
      return white;
  }
}
/**
 * Prefixes `+` or `-` in diff output.
 *
 * @param diffType Difference type, either added or removed
 *
 * @returns A string representing the sign.
 *
 * @example Usage
 * ```ts
 * import { createSign } from "@std/internal";
 * import { assertEquals } from "@std/assert";
 *
 * assertEquals(createSign("added"), "+   ");
 * assertEquals(createSign("removed"), "-   ");
 * assertEquals(createSign("common"), "    ");
 * ```
 */ export function createSign(diffType) {
  switch(diffType){
    case "added":
      return "+   ";
    case "removed":
      return "-   ";
    default:
      return "    ";
  }
}
/**
 * Builds a message based on the provided diff result.
 *
 * @param diffResult The diff result array.
 * @param options Optional parameters for customizing the message.
 * @param truncateDiff Function to truncate the diff (default is no truncation).
 *
 * @returns An array of strings representing the built message.
 *
 * @example Usage
 * ```ts no-assert
 * import { diffStr, buildMessage } from "@std/internal";
 *
 * diffStr("Hello, world!", "Hello, world");
 * // [
 * //   "",
 * //   "",
 * //   "    [Diff] Actual / Expected",
 * //   "",
 * //   "",
 * //   "-   Hello, world!",
 * //   "+   Hello, world",
 * //   "",
 * // ]
 * ```
 */ export function buildMessage(diffResult, options = {}, truncateDiff) {
  if (truncateDiff != null) {
    diffResult = truncateDiff(diffResult, options.stringDiff ?? false);
  }
  const { stringDiff = false } = options;
  const messages = [
    "",
    "",
    `    ${gray(bold("[Diff]"))} ${red(bold("Actual"))} / ${green(bold("Expected"))}`,
    "",
    ""
  ];
  const diffMessages = diffResult.map((result)=>{
    const color = createColor(result.type);
    const line = result.type === "added" || result.type === "removed" ? result.details?.map((detail)=>detail.type !== "common" ? createColor(detail.type, true)(detail.value) : detail.value).join("") ?? result.value : result.value;
    return color(`${createSign(result.type)}${line}`);
  });
  messages.push(...stringDiff ? [
    diffMessages.join("")
  ] : diffMessages, "");
  return messages;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvaW50ZXJuYWwvMS4wLjEyL2J1aWxkX21lc3NhZ2UudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQ29weXJpZ2h0IDIwMTgtMjAyNSB0aGUgRGVubyBhdXRob3JzLiBNSVQgbGljZW5zZS5cbi8vIFRoaXMgbW9kdWxlIGlzIGJyb3dzZXIgY29tcGF0aWJsZS5cblxuaW1wb3J0IHsgYmdHcmVlbiwgYmdSZWQsIGJvbGQsIGdyYXksIGdyZWVuLCByZWQsIHdoaXRlIH0gZnJvbSBcIi4vc3R5bGVzLnRzXCI7XG5pbXBvcnQgdHlwZSB7IERpZmZSZXN1bHQsIERpZmZUeXBlIH0gZnJvbSBcIi4vdHlwZXMudHNcIjtcblxuLyoqXG4gKiBDb2xvcnMgdGhlIG91dHB1dCBvZiBhc3NlcnRpb24gZGlmZnMuXG4gKlxuICogQHBhcmFtIGRpZmZUeXBlIERpZmZlcmVuY2UgdHlwZSwgZWl0aGVyIGFkZGVkIG9yIHJlbW92ZWQuXG4gKiBAcGFyYW0gYmFja2dyb3VuZCBJZiB0cnVlLCBjb2xvcnMgdGhlIGJhY2tncm91bmQgaW5zdGVhZCBvZiB0aGUgdGV4dC5cbiAqXG4gKiBAcmV0dXJucyBBIGZ1bmN0aW9uIHRoYXQgY29sb3JzIHRoZSBpbnB1dCBzdHJpbmcuXG4gKlxuICogQGV4YW1wbGUgVXNhZ2VcbiAqIGBgYHRzXG4gKiBpbXBvcnQgeyBjcmVhdGVDb2xvciB9IGZyb20gXCJAc3RkL2ludGVybmFsXCI7XG4gKiBpbXBvcnQgeyBhc3NlcnRFcXVhbHMgfSBmcm9tIFwiQHN0ZC9hc3NlcnRcIjtcbiAqIGltcG9ydCB7IGJvbGQsIGdyZWVuLCByZWQsIHdoaXRlIH0gZnJvbSBcIkBzdGQvZm10L2NvbG9yc1wiO1xuICpcbiAqIGFzc2VydEVxdWFscyhjcmVhdGVDb2xvcihcImFkZGVkXCIpKFwiZm9vXCIpLCBncmVlbihib2xkKFwiZm9vXCIpKSk7XG4gKiBhc3NlcnRFcXVhbHMoY3JlYXRlQ29sb3IoXCJyZW1vdmVkXCIpKFwiZm9vXCIpLCByZWQoYm9sZChcImZvb1wiKSkpO1xuICogYXNzZXJ0RXF1YWxzKGNyZWF0ZUNvbG9yKFwiY29tbW9uXCIpKFwiZm9vXCIpLCB3aGl0ZShcImZvb1wiKSk7XG4gKiBgYGBcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZUNvbG9yKFxuICBkaWZmVHlwZTogRGlmZlR5cGUsXG4gIC8qKlxuICAgKiBUT0RPKEBsaXR0bGVkaXZ5KTogUmVtb3ZlIHRoaXMgd2hlbiB3ZSBjYW4gZGV0ZWN0IHRydWUgY29sb3IgdGVybWluYWxzLiBTZWVcbiAgICogaHR0cHM6Ly9naXRodWIuY29tL2Rlbm9sYW5kL3N0ZC9pc3N1ZXMvMjU3NS5cbiAgICovXG4gIGJhY2tncm91bmQgPSBmYWxzZSxcbik6IChzOiBzdHJpbmcpID0+IHN0cmluZyB7XG4gIHN3aXRjaCAoZGlmZlR5cGUpIHtcbiAgICBjYXNlIFwiYWRkZWRcIjpcbiAgICAgIHJldHVybiAocykgPT4gYmFja2dyb3VuZCA/IGJnR3JlZW4od2hpdGUocykpIDogZ3JlZW4oYm9sZChzKSk7XG4gICAgY2FzZSBcInJlbW92ZWRcIjpcbiAgICAgIHJldHVybiAocykgPT4gYmFja2dyb3VuZCA/IGJnUmVkKHdoaXRlKHMpKSA6IHJlZChib2xkKHMpKTtcbiAgICBjYXNlIFwidHJ1bmNhdGlvblwiOlxuICAgICAgcmV0dXJuIGdyYXk7XG4gICAgZGVmYXVsdDpcbiAgICAgIHJldHVybiB3aGl0ZTtcbiAgfVxufVxuXG4vKipcbiAqIFByZWZpeGVzIGArYCBvciBgLWAgaW4gZGlmZiBvdXRwdXQuXG4gKlxuICogQHBhcmFtIGRpZmZUeXBlIERpZmZlcmVuY2UgdHlwZSwgZWl0aGVyIGFkZGVkIG9yIHJlbW92ZWRcbiAqXG4gKiBAcmV0dXJucyBBIHN0cmluZyByZXByZXNlbnRpbmcgdGhlIHNpZ24uXG4gKlxuICogQGV4YW1wbGUgVXNhZ2VcbiAqIGBgYHRzXG4gKiBpbXBvcnQgeyBjcmVhdGVTaWduIH0gZnJvbSBcIkBzdGQvaW50ZXJuYWxcIjtcbiAqIGltcG9ydCB7IGFzc2VydEVxdWFscyB9IGZyb20gXCJAc3RkL2Fzc2VydFwiO1xuICpcbiAqIGFzc2VydEVxdWFscyhjcmVhdGVTaWduKFwiYWRkZWRcIiksIFwiKyAgIFwiKTtcbiAqIGFzc2VydEVxdWFscyhjcmVhdGVTaWduKFwicmVtb3ZlZFwiKSwgXCItICAgXCIpO1xuICogYXNzZXJ0RXF1YWxzKGNyZWF0ZVNpZ24oXCJjb21tb25cIiksIFwiICAgIFwiKTtcbiAqIGBgYFxuICovXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlU2lnbihkaWZmVHlwZTogRGlmZlR5cGUpOiBzdHJpbmcge1xuICBzd2l0Y2ggKGRpZmZUeXBlKSB7XG4gICAgY2FzZSBcImFkZGVkXCI6XG4gICAgICByZXR1cm4gXCIrICAgXCI7XG4gICAgY2FzZSBcInJlbW92ZWRcIjpcbiAgICAgIHJldHVybiBcIi0gICBcIjtcbiAgICBkZWZhdWx0OlxuICAgICAgcmV0dXJuIFwiICAgIFwiO1xuICB9XG59XG5cbi8qKiBPcHRpb25zIGZvciB7QGxpbmtjb2RlIGJ1aWxkTWVzc2FnZX0uICovXG5leHBvcnQgaW50ZXJmYWNlIEJ1aWxkTWVzc2FnZU9wdGlvbnMge1xuICAvKipcbiAgICogV2hldGhlciB0byBvdXRwdXQgdGhlIGRpZmYgYXMgYSBzaW5nbGUgc3RyaW5nLlxuICAgKiBAZGVmYXVsdCB7ZmFsc2V9XG4gICAqL1xuICBzdHJpbmdEaWZmPzogYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBCdWlsZHMgYSBtZXNzYWdlIGJhc2VkIG9uIHRoZSBwcm92aWRlZCBkaWZmIHJlc3VsdC5cbiAqXG4gKiBAcGFyYW0gZGlmZlJlc3VsdCBUaGUgZGlmZiByZXN1bHQgYXJyYXkuXG4gKiBAcGFyYW0gb3B0aW9ucyBPcHRpb25hbCBwYXJhbWV0ZXJzIGZvciBjdXN0b21pemluZyB0aGUgbWVzc2FnZS5cbiAqIEBwYXJhbSB0cnVuY2F0ZURpZmYgRnVuY3Rpb24gdG8gdHJ1bmNhdGUgdGhlIGRpZmYgKGRlZmF1bHQgaXMgbm8gdHJ1bmNhdGlvbikuXG4gKlxuICogQHJldHVybnMgQW4gYXJyYXkgb2Ygc3RyaW5ncyByZXByZXNlbnRpbmcgdGhlIGJ1aWx0IG1lc3NhZ2UuXG4gKlxuICogQGV4YW1wbGUgVXNhZ2VcbiAqIGBgYHRzIG5vLWFzc2VydFxuICogaW1wb3J0IHsgZGlmZlN0ciwgYnVpbGRNZXNzYWdlIH0gZnJvbSBcIkBzdGQvaW50ZXJuYWxcIjtcbiAqXG4gKiBkaWZmU3RyKFwiSGVsbG8sIHdvcmxkIVwiLCBcIkhlbGxvLCB3b3JsZFwiKTtcbiAqIC8vIFtcbiAqIC8vICAgXCJcIixcbiAqIC8vICAgXCJcIixcbiAqIC8vICAgXCIgICAgW0RpZmZdIEFjdHVhbCAvIEV4cGVjdGVkXCIsXG4gKiAvLyAgIFwiXCIsXG4gKiAvLyAgIFwiXCIsXG4gKiAvLyAgIFwiLSAgIEhlbGxvLCB3b3JsZCFcIixcbiAqIC8vICAgXCIrICAgSGVsbG8sIHdvcmxkXCIsXG4gKiAvLyAgIFwiXCIsXG4gKiAvLyBdXG4gKiBgYGBcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkTWVzc2FnZShcbiAgZGlmZlJlc3VsdDogUmVhZG9ubHlBcnJheTxEaWZmUmVzdWx0PHN0cmluZz4+LFxuICBvcHRpb25zOiBCdWlsZE1lc3NhZ2VPcHRpb25zID0ge30sXG4gIHRydW5jYXRlRGlmZj86IChcbiAgICBkaWZmUmVzdWx0OiBSZWFkb25seUFycmF5PERpZmZSZXN1bHQ8c3RyaW5nPj4sXG4gICAgc3RyaW5nRGlmZjogYm9vbGVhbixcbiAgICBjb250ZXh0TGVuZ3RoPzogbnVtYmVyIHwgbnVsbCxcbiAgKSA9PiBSZWFkb25seUFycmF5PERpZmZSZXN1bHQ8c3RyaW5nPj4sXG4pOiBzdHJpbmdbXSB7XG4gIGlmICh0cnVuY2F0ZURpZmYgIT0gbnVsbCkge1xuICAgIGRpZmZSZXN1bHQgPSB0cnVuY2F0ZURpZmYoZGlmZlJlc3VsdCwgb3B0aW9ucy5zdHJpbmdEaWZmID8/IGZhbHNlKTtcbiAgfVxuXG4gIGNvbnN0IHsgc3RyaW5nRGlmZiA9IGZhbHNlIH0gPSBvcHRpb25zO1xuICBjb25zdCBtZXNzYWdlcyA9IFtcbiAgICBcIlwiLFxuICAgIFwiXCIsXG4gICAgYCAgICAke2dyYXkoYm9sZChcIltEaWZmXVwiKSl9ICR7cmVkKGJvbGQoXCJBY3R1YWxcIikpfSAvICR7XG4gICAgICBncmVlbihib2xkKFwiRXhwZWN0ZWRcIikpXG4gICAgfWAsXG4gICAgXCJcIixcbiAgICBcIlwiLFxuICBdO1xuICBjb25zdCBkaWZmTWVzc2FnZXMgPSBkaWZmUmVzdWx0Lm1hcCgocmVzdWx0KSA9PiB7XG4gICAgY29uc3QgY29sb3IgPSBjcmVhdGVDb2xvcihyZXN1bHQudHlwZSk7XG5cbiAgICBjb25zdCBsaW5lID0gcmVzdWx0LnR5cGUgPT09IFwiYWRkZWRcIiB8fCByZXN1bHQudHlwZSA9PT0gXCJyZW1vdmVkXCJcbiAgICAgID8gcmVzdWx0LmRldGFpbHM/Lm1hcCgoZGV0YWlsKSA9PlxuICAgICAgICBkZXRhaWwudHlwZSAhPT0gXCJjb21tb25cIlxuICAgICAgICAgID8gY3JlYXRlQ29sb3IoZGV0YWlsLnR5cGUsIHRydWUpKGRldGFpbC52YWx1ZSlcbiAgICAgICAgICA6IGRldGFpbC52YWx1ZVxuICAgICAgKS5qb2luKFwiXCIpID8/IHJlc3VsdC52YWx1ZVxuICAgICAgOiByZXN1bHQudmFsdWU7XG5cbiAgICByZXR1cm4gY29sb3IoYCR7Y3JlYXRlU2lnbihyZXN1bHQudHlwZSl9JHtsaW5lfWApO1xuICB9KTtcbiAgbWVzc2FnZXMucHVzaCguLi4oc3RyaW5nRGlmZiA/IFtkaWZmTWVzc2FnZXMuam9pbihcIlwiKV0gOiBkaWZmTWVzc2FnZXMpLCBcIlwiKTtcbiAgcmV0dXJuIG1lc3NhZ2VzO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLHFEQUFxRDtBQUNyRCxxQ0FBcUM7QUFFckMsU0FBUyxPQUFPLEVBQUUsS0FBSyxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLEdBQUcsRUFBRSxLQUFLLFFBQVEsY0FBYztBQUc1RTs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBa0JDLEdBQ0QsT0FBTyxTQUFTLFlBQ2QsUUFBa0IsRUFDbEI7OztHQUdDLEdBQ0QsYUFBYSxLQUFLO0VBRWxCLE9BQVE7SUFDTixLQUFLO01BQ0gsT0FBTyxDQUFDLElBQU0sYUFBYSxRQUFRLE1BQU0sTUFBTSxNQUFNLEtBQUs7SUFDNUQsS0FBSztNQUNILE9BQU8sQ0FBQyxJQUFNLGFBQWEsTUFBTSxNQUFNLE1BQU0sSUFBSSxLQUFLO0lBQ3hELEtBQUs7TUFDSCxPQUFPO0lBQ1Q7TUFDRSxPQUFPO0VBQ1g7QUFDRjtBQUVBOzs7Ozs7Ozs7Ozs7Ozs7O0NBZ0JDLEdBQ0QsT0FBTyxTQUFTLFdBQVcsUUFBa0I7RUFDM0MsT0FBUTtJQUNOLEtBQUs7TUFDSCxPQUFPO0lBQ1QsS0FBSztNQUNILE9BQU87SUFDVDtNQUNFLE9BQU87RUFDWDtBQUNGO0FBV0E7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0F5QkMsR0FDRCxPQUFPLFNBQVMsYUFDZCxVQUE2QyxFQUM3QyxVQUErQixDQUFDLENBQUMsRUFDakMsWUFJc0M7RUFFdEMsSUFBSSxnQkFBZ0IsTUFBTTtJQUN4QixhQUFhLGFBQWEsWUFBWSxRQUFRLFVBQVUsSUFBSTtFQUM5RDtFQUVBLE1BQU0sRUFBRSxhQUFhLEtBQUssRUFBRSxHQUFHO0VBQy9CLE1BQU0sV0FBVztJQUNmO0lBQ0E7SUFDQSxDQUFDLElBQUksRUFBRSxLQUFLLEtBQUssV0FBVyxDQUFDLEVBQUUsSUFBSSxLQUFLLFdBQVcsR0FBRyxFQUNwRCxNQUFNLEtBQUssY0FDWDtJQUNGO0lBQ0E7R0FDRDtFQUNELE1BQU0sZUFBZSxXQUFXLEdBQUcsQ0FBQyxDQUFDO0lBQ25DLE1BQU0sUUFBUSxZQUFZLE9BQU8sSUFBSTtJQUVyQyxNQUFNLE9BQU8sT0FBTyxJQUFJLEtBQUssV0FBVyxPQUFPLElBQUksS0FBSyxZQUNwRCxPQUFPLE9BQU8sRUFBRSxJQUFJLENBQUMsU0FDckIsT0FBTyxJQUFJLEtBQUssV0FDWixZQUFZLE9BQU8sSUFBSSxFQUFFLE1BQU0sT0FBTyxLQUFLLElBQzNDLE9BQU8sS0FBSyxFQUNoQixLQUFLLE9BQU8sT0FBTyxLQUFLLEdBQ3hCLE9BQU8sS0FBSztJQUVoQixPQUFPLE1BQU0sR0FBRyxXQUFXLE9BQU8sSUFBSSxJQUFJLE1BQU07RUFDbEQ7RUFDQSxTQUFTLElBQUksSUFBSyxhQUFhO0lBQUMsYUFBYSxJQUFJLENBQUM7R0FBSSxHQUFHLGNBQWU7RUFDeEUsT0FBTztBQUNUIn0=
// denoCacheMetadata=15407977441530588842,16705873205686611090