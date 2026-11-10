/**
 * `.config.json` surface for the CodeGraph repo-context switch
 * (Issue #2154, part of #2145).
 *
 * One host-level switch, `codegraph_context.enabled`, decides whether a run
 * indexes the repository with CodeGraph and offers that index to the agent. It
 * is off by default, so a host that never mentions the block behaves exactly
 * as it does today.
 *
 * ## Validation posture — fail loud
 *
 * A spend-and-toolchain switch must never be half-understood: reading a
 * malformed block as "off" would leave an operator who asked for the trial
 * with a setting that looks live and does nothing. So, matching
 * `lib/container_extension_config.ts` rather than the warn-and-default
 * `idle_task_cadence` parser, {@link parseCodegraphContext} returns the fault
 * as an error naming the offending field and the config load throws it.
 *
 * An **unknown key inside** the block is a different case: it changes no
 * behaviour, so it is reported by `lib/config_unknown_keys.ts` as a warning,
 * the way an unknown top-level key is.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */ import { OPERATIONAL_DEFAULTS } from "./config_defaults.ts";
/** Recognised keys inside the `codegraph_context` block. */ export const CODEGRAPH_CONTEXT_KEYS = new Set([
  "enabled"
]);
/**
 * The switch as an unconfigured host reads it.
 *
 * The value itself lives in `OPERATIONAL_DEFAULTS` — the one place config
 * defaults are written — and a fresh object is returned each call so no caller
 * can mutate the shared default.
 */ export function defaultCodegraphContext() {
  return {
    enabled: OPERATIONAL_DEFAULTS.codegraphContext.enabled
  };
}
/** Whether a value is a plain (non-array, non-null) object. */ function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Parse the raw `codegraph_context` block from `.config.json`.
 *
 * @param raw - The block as it appeared in the file, or `undefined`.
 * @returns The parsed switch, or the first fault naming the offending field.
 */ export function parseCodegraphContext(raw) {
  // Only an **absent** key means "this host said nothing". An explicit `null`
  // is a written-out block, so it is refused like any other malformed one
  // rather than quietly reading as off.
  if (raw === undefined) return {
    ok: true,
    value: defaultCodegraphContext()
  };
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      error: `codegraph_context must be an object carrying a boolean "enabled" ` + `(codegraph_context.enabled), got ${describe(raw)}.`
    };
  }
  const enabled = raw.enabled;
  if (enabled === undefined) {
    return {
      ok: true,
      value: defaultCodegraphContext()
    };
  }
  if (typeof enabled !== "boolean") {
    return {
      ok: false,
      error: `codegraph_context.enabled must be a boolean, got ${describe(enabled)}.`
    };
  }
  return {
    ok: true,
    value: {
      enabled
    }
  };
}
/** Name a rejected value's JSON type, distinguishing null and array. */ function describe(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9jb2RlZ3JhcGhfY29udGV4dF9jb25maWcudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBgLmNvbmZpZy5qc29uYCBzdXJmYWNlIGZvciB0aGUgQ29kZUdyYXBoIHJlcG8tY29udGV4dCBzd2l0Y2hcbiAqIChJc3N1ZSAjMjE1NCwgcGFydCBvZiAjMjE0NSkuXG4gKlxuICogT25lIGhvc3QtbGV2ZWwgc3dpdGNoLCBgY29kZWdyYXBoX2NvbnRleHQuZW5hYmxlZGAsIGRlY2lkZXMgd2hldGhlciBhIHJ1blxuICogaW5kZXhlcyB0aGUgcmVwb3NpdG9yeSB3aXRoIENvZGVHcmFwaCBhbmQgb2ZmZXJzIHRoYXQgaW5kZXggdG8gdGhlIGFnZW50LiBJdFxuICogaXMgb2ZmIGJ5IGRlZmF1bHQsIHNvIGEgaG9zdCB0aGF0IG5ldmVyIG1lbnRpb25zIHRoZSBibG9jayBiZWhhdmVzIGV4YWN0bHlcbiAqIGFzIGl0IGRvZXMgdG9kYXkuXG4gKlxuICogIyMgVmFsaWRhdGlvbiBwb3N0dXJlIOKAlCBmYWlsIGxvdWRcbiAqXG4gKiBBIHNwZW5kLWFuZC10b29sY2hhaW4gc3dpdGNoIG11c3QgbmV2ZXIgYmUgaGFsZi11bmRlcnN0b29kOiByZWFkaW5nIGFcbiAqIG1hbGZvcm1lZCBibG9jayBhcyBcIm9mZlwiIHdvdWxkIGxlYXZlIGFuIG9wZXJhdG9yIHdobyBhc2tlZCBmb3IgdGhlIHRyaWFsXG4gKiB3aXRoIGEgc2V0dGluZyB0aGF0IGxvb2tzIGxpdmUgYW5kIGRvZXMgbm90aGluZy4gU28sIG1hdGNoaW5nXG4gKiBgbGliL2NvbnRhaW5lcl9leHRlbnNpb25fY29uZmlnLnRzYCByYXRoZXIgdGhhbiB0aGUgd2Fybi1hbmQtZGVmYXVsdFxuICogYGlkbGVfdGFza19jYWRlbmNlYCBwYXJzZXIsIHtAbGluayBwYXJzZUNvZGVncmFwaENvbnRleHR9IHJldHVybnMgdGhlIGZhdWx0XG4gKiBhcyBhbiBlcnJvciBuYW1pbmcgdGhlIG9mZmVuZGluZyBmaWVsZCBhbmQgdGhlIGNvbmZpZyBsb2FkIHRocm93cyBpdC5cbiAqXG4gKiBBbiAqKnVua25vd24ga2V5IGluc2lkZSoqIHRoZSBibG9jayBpcyBhIGRpZmZlcmVudCBjYXNlOiBpdCBjaGFuZ2VzIG5vXG4gKiBiZWhhdmlvdXIsIHNvIGl0IGlzIHJlcG9ydGVkIGJ5IGBsaWIvY29uZmlnX3Vua25vd25fa2V5cy50c2AgYXMgYSB3YXJuaW5nLFxuICogdGhlIHdheSBhbiB1bmtub3duIHRvcC1sZXZlbCBrZXkgaXMuXG4gKlxuICogQXVzdHJhbGlhbiBFbmdsaXNoIHNwZWxsaW5nIHVzZWQgdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBvcmdhbmlzYXRpb24pLlxuICovXG5cbmltcG9ydCB0eXBlIHsgQ29kZWdyYXBoQ29udGV4dENvbmZpZywgUmVzdWx0IH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5pbXBvcnQgeyBPUEVSQVRJT05BTF9ERUZBVUxUUyB9IGZyb20gXCIuL2NvbmZpZ19kZWZhdWx0cy50c1wiO1xuXG4vKiogUmVjb2duaXNlZCBrZXlzIGluc2lkZSB0aGUgYGNvZGVncmFwaF9jb250ZXh0YCBibG9jay4gKi9cbmV4cG9ydCBjb25zdCBDT0RFR1JBUEhfQ09OVEVYVF9LRVlTOiBSZWFkb25seVNldDxzdHJpbmc+ID0gbmV3IFNldChbXG4gIFwiZW5hYmxlZFwiLFxuXSk7XG5cbi8qKlxuICogVGhlIHN3aXRjaCBhcyBhbiB1bmNvbmZpZ3VyZWQgaG9zdCByZWFkcyBpdC5cbiAqXG4gKiBUaGUgdmFsdWUgaXRzZWxmIGxpdmVzIGluIGBPUEVSQVRJT05BTF9ERUZBVUxUU2Ag4oCUIHRoZSBvbmUgcGxhY2UgY29uZmlnXG4gKiBkZWZhdWx0cyBhcmUgd3JpdHRlbiDigJQgYW5kIGEgZnJlc2ggb2JqZWN0IGlzIHJldHVybmVkIGVhY2ggY2FsbCBzbyBubyBjYWxsZXJcbiAqIGNhbiBtdXRhdGUgdGhlIHNoYXJlZCBkZWZhdWx0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gZGVmYXVsdENvZGVncmFwaENvbnRleHQoKTogQ29kZWdyYXBoQ29udGV4dENvbmZpZyB7XG4gIHJldHVybiB7IGVuYWJsZWQ6IE9QRVJBVElPTkFMX0RFRkFVTFRTLmNvZGVncmFwaENvbnRleHQuZW5hYmxlZCB9O1xufVxuXG4vKiogV2hldGhlciBhIHZhbHVlIGlzIGEgcGxhaW4gKG5vbi1hcnJheSwgbm9uLW51bGwpIG9iamVjdC4gKi9cbmZ1bmN0aW9uIGlzUGxhaW5PYmplY3QodmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIHJldHVybiB0eXBlb2YgdmFsdWUgPT09IFwib2JqZWN0XCIgJiYgdmFsdWUgIT09IG51bGwgJiYgIUFycmF5LmlzQXJyYXkodmFsdWUpO1xufVxuXG4vKipcbiAqIFBhcnNlIHRoZSByYXcgYGNvZGVncmFwaF9jb250ZXh0YCBibG9jayBmcm9tIGAuY29uZmlnLmpzb25gLlxuICpcbiAqIEBwYXJhbSByYXcgLSBUaGUgYmxvY2sgYXMgaXQgYXBwZWFyZWQgaW4gdGhlIGZpbGUsIG9yIGB1bmRlZmluZWRgLlxuICogQHJldHVybnMgVGhlIHBhcnNlZCBzd2l0Y2gsIG9yIHRoZSBmaXJzdCBmYXVsdCBuYW1pbmcgdGhlIG9mZmVuZGluZyBmaWVsZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQ29kZWdyYXBoQ29udGV4dChcbiAgcmF3OiB1bmtub3duLFxuKTogUmVzdWx0PENvZGVncmFwaENvbnRleHRDb25maWcsIHN0cmluZz4ge1xuICAvLyBPbmx5IGFuICoqYWJzZW50Kioga2V5IG1lYW5zIFwidGhpcyBob3N0IHNhaWQgbm90aGluZ1wiLiBBbiBleHBsaWNpdCBgbnVsbGBcbiAgLy8gaXMgYSB3cml0dGVuLW91dCBibG9jaywgc28gaXQgaXMgcmVmdXNlZCBsaWtlIGFueSBvdGhlciBtYWxmb3JtZWQgb25lXG4gIC8vIHJhdGhlciB0aGFuIHF1aWV0bHkgcmVhZGluZyBhcyBvZmYuXG4gIGlmIChyYXcgPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBkZWZhdWx0Q29kZWdyYXBoQ29udGV4dCgpIH07XG5cbiAgaWYgKCFpc1BsYWluT2JqZWN0KHJhdykpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6XG4gICAgICAgIGBjb2RlZ3JhcGhfY29udGV4dCBtdXN0IGJlIGFuIG9iamVjdCBjYXJyeWluZyBhIGJvb2xlYW4gXCJlbmFibGVkXCIgYCArXG4gICAgICAgIGAoY29kZWdyYXBoX2NvbnRleHQuZW5hYmxlZCksIGdvdCAke2Rlc2NyaWJlKHJhdyl9LmAsXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IGVuYWJsZWQgPSByYXcuZW5hYmxlZDtcbiAgaWYgKGVuYWJsZWQgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogZGVmYXVsdENvZGVncmFwaENvbnRleHQoKSB9O1xuICB9XG4gIGlmICh0eXBlb2YgZW5hYmxlZCAhPT0gXCJib29sZWFuXCIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IGBjb2RlZ3JhcGhfY29udGV4dC5lbmFibGVkIG11c3QgYmUgYSBib29sZWFuLCBnb3QgJHtcbiAgICAgICAgZGVzY3JpYmUoZW5hYmxlZClcbiAgICAgIH0uYCxcbiAgICB9O1xuICB9XG5cbiAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB7IGVuYWJsZWQgfSB9O1xufVxuXG4vKiogTmFtZSBhIHJlamVjdGVkIHZhbHVlJ3MgSlNPTiB0eXBlLCBkaXN0aW5ndWlzaGluZyBudWxsIGFuZCBhcnJheS4gKi9cbmZ1bmN0aW9uIGRlc2NyaWJlKHZhbHVlOiB1bmtub3duKTogc3RyaW5nIHtcbiAgaWYgKHZhbHVlID09PSBudWxsKSByZXR1cm4gXCJudWxsXCI7XG4gIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkgcmV0dXJuIFwiYXJyYXlcIjtcbiAgcmV0dXJuIHR5cGVvZiB2YWx1ZTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0F1QkMsR0FHRCxTQUFTLG9CQUFvQixRQUFRLHVCQUF1QjtBQUU1RCwwREFBMEQsR0FDMUQsT0FBTyxNQUFNLHlCQUE4QyxJQUFJLElBQUk7RUFDakU7Q0FDRCxFQUFFO0FBRUg7Ozs7OztDQU1DLEdBQ0QsT0FBTyxTQUFTO0VBQ2QsT0FBTztJQUFFLFNBQVMscUJBQXFCLGdCQUFnQixDQUFDLE9BQU87RUFBQztBQUNsRTtBQUVBLDZEQUE2RCxHQUM3RCxTQUFTLGNBQWMsS0FBYztFQUNuQyxPQUFPLE9BQU8sVUFBVSxZQUFZLFVBQVUsUUFBUSxDQUFDLE1BQU0sT0FBTyxDQUFDO0FBQ3ZFO0FBRUE7Ozs7O0NBS0MsR0FDRCxPQUFPLFNBQVMsc0JBQ2QsR0FBWTtFQUVaLDRFQUE0RTtFQUM1RSx3RUFBd0U7RUFDeEUsc0NBQXNDO0VBQ3RDLElBQUksUUFBUSxXQUFXLE9BQU87SUFBRSxJQUFJO0lBQU0sT0FBTztFQUEwQjtFQUUzRSxJQUFJLENBQUMsY0FBYyxNQUFNO0lBQ3ZCLE9BQU87TUFDTCxJQUFJO01BQ0osT0FDRSxDQUFDLGlFQUFpRSxDQUFDLEdBQ25FLENBQUMsaUNBQWlDLEVBQUUsU0FBUyxLQUFLLENBQUMsQ0FBQztJQUN4RDtFQUNGO0VBRUEsTUFBTSxVQUFVLElBQUksT0FBTztFQUMzQixJQUFJLFlBQVksV0FBVztJQUN6QixPQUFPO01BQUUsSUFBSTtNQUFNLE9BQU87SUFBMEI7RUFDdEQ7RUFDQSxJQUFJLE9BQU8sWUFBWSxXQUFXO0lBQ2hDLE9BQU87TUFDTCxJQUFJO01BQ0osT0FBTyxDQUFDLGlEQUFpRCxFQUN2RCxTQUFTLFNBQ1YsQ0FBQyxDQUFDO0lBQ0w7RUFDRjtFQUVBLE9BQU87SUFBRSxJQUFJO0lBQU0sT0FBTztNQUFFO0lBQVE7RUFBRTtBQUN4QztBQUVBLHNFQUFzRSxHQUN0RSxTQUFTLFNBQVMsS0FBYztFQUM5QixJQUFJLFVBQVUsTUFBTSxPQUFPO0VBQzNCLElBQUksTUFBTSxPQUFPLENBQUMsUUFBUSxPQUFPO0VBQ2pDLE9BQU8sT0FBTztBQUNoQiJ9
// denoCacheMetadata=10080648620928114078,17897121234814222883