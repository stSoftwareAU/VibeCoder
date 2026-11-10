// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { buildMessage } from "jsr:@std/internal@^1.0.12/build-message";
import { diff } from "jsr:@std/internal@^1.0.12/diff";
import { diffStr } from "jsr:@std/internal@^1.0.12/diff-str";
import { format } from "jsr:@std/internal@^1.0.12/format";
import { red } from "jsr:@std/internal@^1.0.12/styles";
import { AssertionError } from "./assertion_error.ts";
/**
 * Make an assertion that `actual` and `expected` are strictly equal, using
 * {@linkcode Object.is} for equality comparison. If not, then throw.
 *
 * @example Usage
 * ```ts ignore
 * import { assertStrictEquals } from "@std/assert";
 *
 * const a = {};
 * const b = a;
 * assertStrictEquals(a, b); // Doesn't throw
 *
 * const c = {};
 * const d = {};
 * assertStrictEquals(c, d); // Throws
 * ```
 *
 * @typeParam T The type of the expected value.
 * @param actual The actual value to compare.
 * @param expected The expected value to compare.
 * @param msg The optional message to display if the assertion fails.
 */ export function assertStrictEquals(actual, expected, msg) {
  if (Object.is(actual, expected)) {
    return;
  }
  const msgSuffix = msg ? `: ${msg}` : ".";
  let message;
  const actualString = format(actual);
  const expectedString = format(expected);
  if (actualString === expectedString) {
    const withOffset = actualString.split("\n").map((l)=>`    ${l}`).join("\n");
    message = `Values have the same structure but are not reference-equal${msgSuffix}\n\n${red(withOffset)}\n`;
  } else {
    const stringDiff = typeof actual === "string" && typeof expected === "string";
    const diffResult = stringDiff ? diffStr(actual, expected) : diff(actualString.split("\n"), expectedString.split("\n"));
    const diffMsg = buildMessage(diffResult, {
      stringDiff
    }, arguments[3]).join("\n");
    message = `Values are not strictly equal${msgSuffix}\n${diffMsg}`;
  }
  throw new AssertionError(message);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvYXNzZXJ0LzEuMC4xOC9zdHJpY3RfZXF1YWxzLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIENvcHlyaWdodCAyMDE4LTIwMjYgdGhlIERlbm8gYXV0aG9ycy4gTUlUIGxpY2Vuc2UuXG4vLyBUaGlzIG1vZHVsZSBpcyBicm93c2VyIGNvbXBhdGlibGUuXG5pbXBvcnQgeyBidWlsZE1lc3NhZ2UgfSBmcm9tIFwianNyOkBzdGQvaW50ZXJuYWxAXjEuMC4xMi9idWlsZC1tZXNzYWdlXCI7XG5pbXBvcnQgeyBkaWZmIH0gZnJvbSBcImpzcjpAc3RkL2ludGVybmFsQF4xLjAuMTIvZGlmZlwiO1xuaW1wb3J0IHsgZGlmZlN0ciB9IGZyb20gXCJqc3I6QHN0ZC9pbnRlcm5hbEBeMS4wLjEyL2RpZmYtc3RyXCI7XG5pbXBvcnQgeyBmb3JtYXQgfSBmcm9tIFwianNyOkBzdGQvaW50ZXJuYWxAXjEuMC4xMi9mb3JtYXRcIjtcbmltcG9ydCB7IHJlZCB9IGZyb20gXCJqc3I6QHN0ZC9pbnRlcm5hbEBeMS4wLjEyL3N0eWxlc1wiO1xuaW1wb3J0IHsgQXNzZXJ0aW9uRXJyb3IgfSBmcm9tIFwiLi9hc3NlcnRpb25fZXJyb3IudHNcIjtcblxuLyoqXG4gKiBNYWtlIGFuIGFzc2VydGlvbiB0aGF0IGBhY3R1YWxgIGFuZCBgZXhwZWN0ZWRgIGFyZSBzdHJpY3RseSBlcXVhbCwgdXNpbmdcbiAqIHtAbGlua2NvZGUgT2JqZWN0LmlzfSBmb3IgZXF1YWxpdHkgY29tcGFyaXNvbi4gSWYgbm90LCB0aGVuIHRocm93LlxuICpcbiAqIEBleGFtcGxlIFVzYWdlXG4gKiBgYGB0cyBpZ25vcmVcbiAqIGltcG9ydCB7IGFzc2VydFN0cmljdEVxdWFscyB9IGZyb20gXCJAc3RkL2Fzc2VydFwiO1xuICpcbiAqIGNvbnN0IGEgPSB7fTtcbiAqIGNvbnN0IGIgPSBhO1xuICogYXNzZXJ0U3RyaWN0RXF1YWxzKGEsIGIpOyAvLyBEb2Vzbid0IHRocm93XG4gKlxuICogY29uc3QgYyA9IHt9O1xuICogY29uc3QgZCA9IHt9O1xuICogYXNzZXJ0U3RyaWN0RXF1YWxzKGMsIGQpOyAvLyBUaHJvd3NcbiAqIGBgYFxuICpcbiAqIEB0eXBlUGFyYW0gVCBUaGUgdHlwZSBvZiB0aGUgZXhwZWN0ZWQgdmFsdWUuXG4gKiBAcGFyYW0gYWN0dWFsIFRoZSBhY3R1YWwgdmFsdWUgdG8gY29tcGFyZS5cbiAqIEBwYXJhbSBleHBlY3RlZCBUaGUgZXhwZWN0ZWQgdmFsdWUgdG8gY29tcGFyZS5cbiAqIEBwYXJhbSBtc2cgVGhlIG9wdGlvbmFsIG1lc3NhZ2UgdG8gZGlzcGxheSBpZiB0aGUgYXNzZXJ0aW9uIGZhaWxzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYXNzZXJ0U3RyaWN0RXF1YWxzPFQ+KFxuICBhY3R1YWw6IHVua25vd24sXG4gIGV4cGVjdGVkOiBULFxuICBtc2c/OiBzdHJpbmcsXG4pOiBhc3NlcnRzIGFjdHVhbCBpcyBUIHtcbiAgaWYgKE9iamVjdC5pcyhhY3R1YWwsIGV4cGVjdGVkKSkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IG1zZ1N1ZmZpeCA9IG1zZyA/IGA6ICR7bXNnfWAgOiBcIi5cIjtcbiAgbGV0IG1lc3NhZ2U6IHN0cmluZztcblxuICBjb25zdCBhY3R1YWxTdHJpbmcgPSBmb3JtYXQoYWN0dWFsKTtcbiAgY29uc3QgZXhwZWN0ZWRTdHJpbmcgPSBmb3JtYXQoZXhwZWN0ZWQpO1xuXG4gIGlmIChhY3R1YWxTdHJpbmcgPT09IGV4cGVjdGVkU3RyaW5nKSB7XG4gICAgY29uc3Qgd2l0aE9mZnNldCA9IGFjdHVhbFN0cmluZ1xuICAgICAgLnNwbGl0KFwiXFxuXCIpXG4gICAgICAubWFwKChsKSA9PiBgICAgICR7bH1gKVxuICAgICAgLmpvaW4oXCJcXG5cIik7XG4gICAgbWVzc2FnZSA9XG4gICAgICBgVmFsdWVzIGhhdmUgdGhlIHNhbWUgc3RydWN0dXJlIGJ1dCBhcmUgbm90IHJlZmVyZW5jZS1lcXVhbCR7bXNnU3VmZml4fVxcblxcbiR7XG4gICAgICAgIHJlZCh3aXRoT2Zmc2V0KVxuICAgICAgfVxcbmA7XG4gIH0gZWxzZSB7XG4gICAgY29uc3Qgc3RyaW5nRGlmZiA9ICh0eXBlb2YgYWN0dWFsID09PSBcInN0cmluZ1wiKSAmJlxuICAgICAgKHR5cGVvZiBleHBlY3RlZCA9PT0gXCJzdHJpbmdcIik7XG4gICAgY29uc3QgZGlmZlJlc3VsdCA9IHN0cmluZ0RpZmZcbiAgICAgID8gZGlmZlN0cihhY3R1YWwgYXMgc3RyaW5nLCBleHBlY3RlZCBhcyBzdHJpbmcpXG4gICAgICA6IGRpZmYoYWN0dWFsU3RyaW5nLnNwbGl0KFwiXFxuXCIpLCBleHBlY3RlZFN0cmluZy5zcGxpdChcIlxcblwiKSk7XG4gICAgY29uc3QgZGlmZk1zZyA9IGJ1aWxkTWVzc2FnZShkaWZmUmVzdWx0LCB7IHN0cmluZ0RpZmYgfSwgYXJndW1lbnRzWzNdKVxuICAgICAgLmpvaW4oXCJcXG5cIik7XG4gICAgbWVzc2FnZSA9IGBWYWx1ZXMgYXJlIG5vdCBzdHJpY3RseSBlcXVhbCR7bXNnU3VmZml4fVxcbiR7ZGlmZk1zZ31gO1xuICB9XG5cbiAgdGhyb3cgbmV3IEFzc2VydGlvbkVycm9yKG1lc3NhZ2UpO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLHFEQUFxRDtBQUNyRCxxQ0FBcUM7QUFDckMsU0FBUyxZQUFZLFFBQVEsMENBQTBDO0FBQ3ZFLFNBQVMsSUFBSSxRQUFRLGlDQUFpQztBQUN0RCxTQUFTLE9BQU8sUUFBUSxxQ0FBcUM7QUFDN0QsU0FBUyxNQUFNLFFBQVEsbUNBQW1DO0FBQzFELFNBQVMsR0FBRyxRQUFRLG1DQUFtQztBQUN2RCxTQUFTLGNBQWMsUUFBUSx1QkFBdUI7QUFFdEQ7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQXFCQyxHQUNELE9BQU8sU0FBUyxtQkFDZCxNQUFlLEVBQ2YsUUFBVyxFQUNYLEdBQVk7RUFFWixJQUFJLE9BQU8sRUFBRSxDQUFDLFFBQVEsV0FBVztJQUMvQjtFQUNGO0VBRUEsTUFBTSxZQUFZLE1BQU0sQ0FBQyxFQUFFLEVBQUUsS0FBSyxHQUFHO0VBQ3JDLElBQUk7RUFFSixNQUFNLGVBQWUsT0FBTztFQUM1QixNQUFNLGlCQUFpQixPQUFPO0VBRTlCLElBQUksaUJBQWlCLGdCQUFnQjtJQUNuQyxNQUFNLGFBQWEsYUFDaEIsS0FBSyxDQUFDLE1BQ04sR0FBRyxDQUFDLENBQUMsSUFBTSxDQUFDLElBQUksRUFBRSxHQUFHLEVBQ3JCLElBQUksQ0FBQztJQUNSLFVBQ0UsQ0FBQywwREFBMEQsRUFBRSxVQUFVLElBQUksRUFDekUsSUFBSSxZQUNMLEVBQUUsQ0FBQztFQUNSLE9BQU87SUFDTCxNQUFNLGFBQWEsQUFBQyxPQUFPLFdBQVcsWUFDbkMsT0FBTyxhQUFhO0lBQ3ZCLE1BQU0sYUFBYSxhQUNmLFFBQVEsUUFBa0IsWUFDMUIsS0FBSyxhQUFhLEtBQUssQ0FBQyxPQUFPLGVBQWUsS0FBSyxDQUFDO0lBQ3hELE1BQU0sVUFBVSxhQUFhLFlBQVk7TUFBRTtJQUFXLEdBQUcsU0FBUyxDQUFDLEVBQUUsRUFDbEUsSUFBSSxDQUFDO0lBQ1IsVUFBVSxDQUFDLDZCQUE2QixFQUFFLFVBQVUsRUFBRSxFQUFFLFNBQVM7RUFDbkU7RUFFQSxNQUFNLElBQUksZUFBZTtBQUMzQiJ9
// denoCacheMetadata=3594298695193740232,11208690688393710856