// Ported from js-yaml v3.13.1:
// https://github.com/nodeca/js-yaml/commit/665aadda42349dcae869f12040d9b10ef18d12da
// Copyright 2011-2015 by Vitaly Puzrin. All rights reserved. MIT license.
// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { binary } from "./_type/binary.ts";
import { bool } from "./_type/bool.ts";
import { float } from "./_type/float.ts";
import { int } from "./_type/int.ts";
import { map } from "./_type/map.ts";
import { merge } from "./_type/merge.ts";
import { nil } from "./_type/nil.ts";
import { omap } from "./_type/omap.ts";
import { pairs } from "./_type/pairs.ts";
import { regexp } from "./_type/regexp.ts";
import { seq } from "./_type/seq.ts";
import { set } from "./_type/set.ts";
import { str } from "./_type/str.ts";
import { timestamp } from "./_type/timestamp.ts";
import { undefinedType } from "./_type/undefined.ts";
function createTypeMap(implicitTypes, explicitTypes) {
  const result = {
    fallback: new Map(),
    mapping: new Map(),
    scalar: new Map(),
    sequence: new Map()
  };
  const fallbackMap = result.fallback;
  for (const type of [
    ...implicitTypes,
    ...explicitTypes
  ]){
    const map = result[type.kind];
    map.set(type.tag, type);
    fallbackMap.set(type.tag, type);
  }
  return result;
}
function createSchema({ explicitTypes = [], implicitTypes = [], include }) {
  if (include) {
    implicitTypes.push(...include.implicitTypes);
    explicitTypes.push(...include.explicitTypes);
  }
  const typeMap = createTypeMap(implicitTypes, explicitTypes);
  return {
    implicitTypes,
    explicitTypes,
    typeMap
  };
}
/**
 * Standard YAML's failsafe schema.
 *
 * @see {@link http://www.yaml.org/spec/1.2/spec.html#id2802346}
 */ const FAILSAFE_SCHEMA = createSchema({
  explicitTypes: [
    str,
    seq,
    map
  ]
});
/**
 * Standard YAML's JSON schema.
 *
 * @see {@link http://www.yaml.org/spec/1.2/spec.html#id2803231}
 */ const JSON_SCHEMA = createSchema({
  implicitTypes: [
    nil,
    bool,
    int,
    float
  ],
  include: FAILSAFE_SCHEMA
});
/**
 * Standard YAML's core schema.
 *
 * @see {@link http://www.yaml.org/spec/1.2/spec.html#id2804923}
 */ const CORE_SCHEMA = createSchema({
  include: JSON_SCHEMA
});
/**
 * Default YAML schema. It is not described in the YAML specification.
 */ export const DEFAULT_SCHEMA = createSchema({
  explicitTypes: [
    binary,
    omap,
    pairs,
    set
  ],
  implicitTypes: [
    timestamp,
    merge
  ],
  include: CORE_SCHEMA
});
/***
 * Extends JS-YAML default schema with additional JavaScript types
 * It is not described in the YAML specification.
 * Functions are no longer supported for security reasons.
 *
 * @example
 * ```ts
 * import { parse } from "@std/yaml";
 *
 * const data = parse(
 *   `
 *   regexp:
 *     simple: !!js/regexp foobar
 *     modifiers: !!js/regexp /foobar/mi
 *   undefined: !!js/undefined ~
 * `,
 *   { schema: "extended" },
 * );
 * ```
 */ const EXTENDED_SCHEMA = createSchema({
  explicitTypes: [
    regexp,
    undefinedType
  ],
  include: DEFAULT_SCHEMA
});
export const SCHEMA_MAP = new Map([
  [
    "core",
    CORE_SCHEMA
  ],
  [
    "default",
    DEFAULT_SCHEMA
  ],
  [
    "failsafe",
    FAILSAFE_SCHEMA
  ],
  [
    "json",
    JSON_SCHEMA
  ],
  [
    "extended",
    EXTENDED_SCHEMA
  ]
]);
export function getSchema(schema = "default", types) {
  const schemaObj = SCHEMA_MAP.get(schema);
  if (!types) {
    return schemaObj;
  }
  return createSchema({
    implicitTypes: [
      ...types,
      ...schemaObj.implicitTypes
    ],
    explicitTypes: [
      ...schemaObj.explicitTypes
    ]
  });
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQveWFtbC8xLjAuMTIvX3NjaGVtYS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBQb3J0ZWQgZnJvbSBqcy15YW1sIHYzLjEzLjE6XG4vLyBodHRwczovL2dpdGh1Yi5jb20vbm9kZWNhL2pzLXlhbWwvY29tbWl0LzY2NWFhZGRhNDIzNDlkY2FlODY5ZjEyMDQwZDliMTBlZjE4ZDEyZGFcbi8vIENvcHlyaWdodCAyMDExLTIwMTUgYnkgVml0YWx5IFB1enJpbi4gQWxsIHJpZ2h0cyByZXNlcnZlZC4gTUlUIGxpY2Vuc2UuXG4vLyBDb3B5cmlnaHQgMjAxOC0yMDI2IHRoZSBEZW5vIGF1dGhvcnMuIE1JVCBsaWNlbnNlLlxuLy8gVGhpcyBtb2R1bGUgaXMgYnJvd3NlciBjb21wYXRpYmxlLlxuXG5pbXBvcnQgdHlwZSB7IEtpbmRUeXBlLCBUeXBlIH0gZnJvbSBcIi4vX3R5cGUudHNcIjtcbmltcG9ydCB7IGJpbmFyeSB9IGZyb20gXCIuL190eXBlL2JpbmFyeS50c1wiO1xuaW1wb3J0IHsgYm9vbCB9IGZyb20gXCIuL190eXBlL2Jvb2wudHNcIjtcbmltcG9ydCB7IGZsb2F0IH0gZnJvbSBcIi4vX3R5cGUvZmxvYXQudHNcIjtcbmltcG9ydCB7IGludCB9IGZyb20gXCIuL190eXBlL2ludC50c1wiO1xuaW1wb3J0IHsgbWFwIH0gZnJvbSBcIi4vX3R5cGUvbWFwLnRzXCI7XG5pbXBvcnQgeyBtZXJnZSB9IGZyb20gXCIuL190eXBlL21lcmdlLnRzXCI7XG5pbXBvcnQgeyBuaWwgfSBmcm9tIFwiLi9fdHlwZS9uaWwudHNcIjtcbmltcG9ydCB7IG9tYXAgfSBmcm9tIFwiLi9fdHlwZS9vbWFwLnRzXCI7XG5pbXBvcnQgeyBwYWlycyB9IGZyb20gXCIuL190eXBlL3BhaXJzLnRzXCI7XG5pbXBvcnQgeyByZWdleHAgfSBmcm9tIFwiLi9fdHlwZS9yZWdleHAudHNcIjtcbmltcG9ydCB7IHNlcSB9IGZyb20gXCIuL190eXBlL3NlcS50c1wiO1xuaW1wb3J0IHsgc2V0IH0gZnJvbSBcIi4vX3R5cGUvc2V0LnRzXCI7XG5pbXBvcnQgeyBzdHIgfSBmcm9tIFwiLi9fdHlwZS9zdHIudHNcIjtcbmltcG9ydCB7IHRpbWVzdGFtcCB9IGZyb20gXCIuL190eXBlL3RpbWVzdGFtcC50c1wiO1xuaW1wb3J0IHsgdW5kZWZpbmVkVHlwZSB9IGZyb20gXCIuL190eXBlL3VuZGVmaW5lZC50c1wiO1xuXG4vKipcbiAqIE5hbWUgb2YgdGhlIHNjaGVtYSB0byB1c2UuXG4gKlxuICogPiBbIU5PVEVdXG4gKiA+IEl0IGlzIHJlY29tbWVuZGVkIHRvIHVzZSB0aGUgc2NoZW1hIHRoYXQgaXMgbW9zdCBhcHByb3ByaWF0ZSBmb3IgeW91ciB1c2VcbiAqID4gY2FzZS4gRG9pbmcgc28gd2lsbCBhdm9pZCBhbnkgdW5uZWNlc3NhcnkgcHJvY2Vzc2luZyBhbmQgYmVuZWZpdFxuICogPiBwZXJmb3JtYW5jZS5cbiAqXG4gKiBPcHRpb25zIGluY2x1ZGU6XG4gKiAtIGBmYWlsc2FmZWA6IHN1cHBvcnRzIGdlbmVyaWMgbWFwcGluZ3MsIGdlbmVyaWMgc2VxdWVuY2VzIGFuZCBnZW5lcmljXG4gKiBzdHJpbmdzLlxuICogLSBganNvbmA6IGV4dGVuZHMgYGZhaWxzYWZlYCBzY2hlbWEgYnkgYWxzbyBzdXBwb3J0aW5nIG51bGxzLCBib29sZWFucyxcbiAqIGludGVnZXJzIGFuZCBmbG9hdHMuXG4gKiAtIGBjb3JlYDogZnVuY3Rpb25hbGx5IHRoZSBzYW1lIGFzIGBqc29uYCBzY2hlbWEuXG4gKiAtIGBkZWZhdWx0YDogZXh0ZW5kcyBgY29yZWAgc2NoZW1hIGJ5IGFsc28gc3VwcG9ydGluZyBiaW5hcnksIG9tYXAsIHBhaXJzIGFuZFxuICogc2V0IHR5cGVzLlxuICogLSBgZXh0ZW5kZWRgOiBleHRlbmRzIGBkZWZhdWx0YCBzY2hlbWEgYnkgYWxzbyBzdXBwb3J0aW5nIHJlZ3VsYXJcbiAqIGV4cHJlc3Npb25zIGFuZCB1bmRlZmluZWQgdmFsdWVzLlxuICpcbiAqIFNlZVxuICoge0BsaW5rIGh0dHBzOi8veWFtbC5vcmcvc3BlYy8xLjIuMi8jY2hhcHRlci0xMC1yZWNvbW1lbmRlZC1zY2hlbWFzIHwgWUFNTCAxLjIgc3BlY31cbiAqIGZvciBtb3JlIGRldGFpbHMgb24gdGhlIGBmYWlsc2FmZWAsIGBqc29uYCBhbmQgYGNvcmVgIHNjaGVtYXMuXG4gKi9cbmV4cG9ydCB0eXBlIFNjaGVtYVR5cGUgPSBcImZhaWxzYWZlXCIgfCBcImpzb25cIiB8IFwiY29yZVwiIHwgXCJkZWZhdWx0XCIgfCBcImV4dGVuZGVkXCI7XG5cbi8qKlxuICogQSB0eXBlIHRoYXQgY2FuIGJlIGltcGxpY2l0bHkgcmVzb2x2ZWQgKGkuZS4gd2l0aG91dCB1c2luZyBhIHRhZykgd2hlblxuICogbG9hZGluZyBhIFlBTUwgZG9jdW1lbnQuXG4gKi9cbmV4cG9ydCB0eXBlIEltcGxpY2l0VHlwZSA9IFR5cGU8XCJzY2FsYXJcIj47XG5leHBvcnQgdHlwZSBFeHBsaWNpdFR5cGUgPSBUeXBlPEtpbmRUeXBlPjtcblxuZXhwb3J0IHR5cGUgVHlwZU1hcCA9IFJlY29yZDxcbiAgS2luZFR5cGUgfCBcImZhbGxiYWNrXCIsXG4gIE1hcDxzdHJpbmcsIEV4cGxpY2l0VHlwZT5cbj47XG5cbmZ1bmN0aW9uIGNyZWF0ZVR5cGVNYXAoXG4gIGltcGxpY2l0VHlwZXM6IEltcGxpY2l0VHlwZVtdLFxuICBleHBsaWNpdFR5cGVzOiBFeHBsaWNpdFR5cGVbXSxcbik6IFR5cGVNYXAge1xuICBjb25zdCByZXN1bHQ6IFR5cGVNYXAgPSB7XG4gICAgZmFsbGJhY2s6IG5ldyBNYXAoKSxcbiAgICBtYXBwaW5nOiBuZXcgTWFwKCksXG4gICAgc2NhbGFyOiBuZXcgTWFwKCksXG4gICAgc2VxdWVuY2U6IG5ldyBNYXAoKSxcbiAgfTtcbiAgY29uc3QgZmFsbGJhY2tNYXAgPSByZXN1bHQuZmFsbGJhY2s7XG4gIGZvciAoY29uc3QgdHlwZSBvZiBbLi4uaW1wbGljaXRUeXBlcywgLi4uZXhwbGljaXRUeXBlc10pIHtcbiAgICBjb25zdCBtYXAgPSByZXN1bHRbdHlwZS5raW5kXTtcbiAgICBtYXAuc2V0KHR5cGUudGFnLCB0eXBlKTtcbiAgICBmYWxsYmFja01hcC5zZXQodHlwZS50YWcsIHR5cGUpO1xuICB9XG4gIHJldHVybiByZXN1bHQ7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2NoZW1hIHtcbiAgaW1wbGljaXRUeXBlczogSW1wbGljaXRUeXBlW107XG4gIGV4cGxpY2l0VHlwZXM6IEV4cGxpY2l0VHlwZVtdO1xuICB0eXBlTWFwOiBUeXBlTWFwO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVTY2hlbWEoeyBleHBsaWNpdFR5cGVzID0gW10sIGltcGxpY2l0VHlwZXMgPSBbXSwgaW5jbHVkZSB9OiB7XG4gIGltcGxpY2l0VHlwZXM/OiBJbXBsaWNpdFR5cGVbXTtcbiAgZXhwbGljaXRUeXBlcz86IEV4cGxpY2l0VHlwZVtdO1xuICBpbmNsdWRlPzogU2NoZW1hO1xufSk6IFNjaGVtYSB7XG4gIGlmIChpbmNsdWRlKSB7XG4gICAgaW1wbGljaXRUeXBlcy5wdXNoKC4uLmluY2x1ZGUuaW1wbGljaXRUeXBlcyk7XG4gICAgZXhwbGljaXRUeXBlcy5wdXNoKC4uLmluY2x1ZGUuZXhwbGljaXRUeXBlcyk7XG4gIH1cbiAgY29uc3QgdHlwZU1hcCA9IGNyZWF0ZVR5cGVNYXAoaW1wbGljaXRUeXBlcywgZXhwbGljaXRUeXBlcyk7XG4gIHJldHVybiB7IGltcGxpY2l0VHlwZXMsIGV4cGxpY2l0VHlwZXMsIHR5cGVNYXAgfTtcbn1cblxuLyoqXG4gKiBTdGFuZGFyZCBZQU1MJ3MgZmFpbHNhZmUgc2NoZW1hLlxuICpcbiAqIEBzZWUge0BsaW5rIGh0dHA6Ly93d3cueWFtbC5vcmcvc3BlYy8xLjIvc3BlYy5odG1sI2lkMjgwMjM0Nn1cbiAqL1xuY29uc3QgRkFJTFNBRkVfU0NIRU1BID0gY3JlYXRlU2NoZW1hKHtcbiAgZXhwbGljaXRUeXBlczogW3N0ciwgc2VxLCBtYXBdLFxufSk7XG5cbi8qKlxuICogU3RhbmRhcmQgWUFNTCdzIEpTT04gc2NoZW1hLlxuICpcbiAqIEBzZWUge0BsaW5rIGh0dHA6Ly93d3cueWFtbC5vcmcvc3BlYy8xLjIvc3BlYy5odG1sI2lkMjgwMzIzMX1cbiAqL1xuY29uc3QgSlNPTl9TQ0hFTUEgPSBjcmVhdGVTY2hlbWEoe1xuICBpbXBsaWNpdFR5cGVzOiBbbmlsLCBib29sLCBpbnQsIGZsb2F0XSxcbiAgaW5jbHVkZTogRkFJTFNBRkVfU0NIRU1BLFxufSk7XG5cbi8qKlxuICogU3RhbmRhcmQgWUFNTCdzIGNvcmUgc2NoZW1hLlxuICpcbiAqIEBzZWUge0BsaW5rIGh0dHA6Ly93d3cueWFtbC5vcmcvc3BlYy8xLjIvc3BlYy5odG1sI2lkMjgwNDkyM31cbiAqL1xuY29uc3QgQ09SRV9TQ0hFTUEgPSBjcmVhdGVTY2hlbWEoe1xuICBpbmNsdWRlOiBKU09OX1NDSEVNQSxcbn0pO1xuXG4vKipcbiAqIERlZmF1bHQgWUFNTCBzY2hlbWEuIEl0IGlzIG5vdCBkZXNjcmliZWQgaW4gdGhlIFlBTUwgc3BlY2lmaWNhdGlvbi5cbiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfU0NIRU1BID0gY3JlYXRlU2NoZW1hKHtcbiAgZXhwbGljaXRUeXBlczogW2JpbmFyeSwgb21hcCwgcGFpcnMsIHNldF0sXG4gIGltcGxpY2l0VHlwZXM6IFt0aW1lc3RhbXAsIG1lcmdlXSxcbiAgaW5jbHVkZTogQ09SRV9TQ0hFTUEsXG59KTtcblxuLyoqKlxuICogRXh0ZW5kcyBKUy1ZQU1MIGRlZmF1bHQgc2NoZW1hIHdpdGggYWRkaXRpb25hbCBKYXZhU2NyaXB0IHR5cGVzXG4gKiBJdCBpcyBub3QgZGVzY3JpYmVkIGluIHRoZSBZQU1MIHNwZWNpZmljYXRpb24uXG4gKiBGdW5jdGlvbnMgYXJlIG5vIGxvbmdlciBzdXBwb3J0ZWQgZm9yIHNlY3VyaXR5IHJlYXNvbnMuXG4gKlxuICogQGV4YW1wbGVcbiAqIGBgYHRzXG4gKiBpbXBvcnQgeyBwYXJzZSB9IGZyb20gXCJAc3RkL3lhbWxcIjtcbiAqXG4gKiBjb25zdCBkYXRhID0gcGFyc2UoXG4gKiAgIGBcbiAqICAgcmVnZXhwOlxuICogICAgIHNpbXBsZTogISFqcy9yZWdleHAgZm9vYmFyXG4gKiAgICAgbW9kaWZpZXJzOiAhIWpzL3JlZ2V4cCAvZm9vYmFyL21pXG4gKiAgIHVuZGVmaW5lZDogISFqcy91bmRlZmluZWQgflxuICogYCxcbiAqICAgeyBzY2hlbWE6IFwiZXh0ZW5kZWRcIiB9LFxuICogKTtcbiAqIGBgYFxuICovXG5jb25zdCBFWFRFTkRFRF9TQ0hFTUEgPSBjcmVhdGVTY2hlbWEoe1xuICBleHBsaWNpdFR5cGVzOiBbcmVnZXhwLCB1bmRlZmluZWRUeXBlXSxcbiAgaW5jbHVkZTogREVGQVVMVF9TQ0hFTUEsXG59KTtcblxuZXhwb3J0IGNvbnN0IFNDSEVNQV9NQVAgPSBuZXcgTWFwPFNjaGVtYVR5cGUsIFNjaGVtYT4oW1xuICBbXCJjb3JlXCIsIENPUkVfU0NIRU1BXSxcbiAgW1wiZGVmYXVsdFwiLCBERUZBVUxUX1NDSEVNQV0sXG4gIFtcImZhaWxzYWZlXCIsIEZBSUxTQUZFX1NDSEVNQV0sXG4gIFtcImpzb25cIiwgSlNPTl9TQ0hFTUFdLFxuICBbXCJleHRlbmRlZFwiLCBFWFRFTkRFRF9TQ0hFTUFdLFxuXSk7XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRTY2hlbWEoXG4gIHNjaGVtYTogU2NoZW1hVHlwZSA9IFwiZGVmYXVsdFwiLFxuICB0eXBlcz86IEltcGxpY2l0VHlwZVtdLFxuKTogU2NoZW1hIHtcbiAgY29uc3Qgc2NoZW1hT2JqID0gU0NIRU1BX01BUC5nZXQoc2NoZW1hKSE7XG5cbiAgaWYgKCF0eXBlcykge1xuICAgIHJldHVybiBzY2hlbWFPYmo7XG4gIH1cblxuICByZXR1cm4gY3JlYXRlU2NoZW1hKHtcbiAgICBpbXBsaWNpdFR5cGVzOiBbLi4udHlwZXMsIC4uLnNjaGVtYU9iai5pbXBsaWNpdFR5cGVzXSxcbiAgICBleHBsaWNpdFR5cGVzOiBbLi4uc2NoZW1hT2JqLmV4cGxpY2l0VHlwZXNdLFxu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
// denoCacheMetadata=5564217991337012140,17341461226727435642