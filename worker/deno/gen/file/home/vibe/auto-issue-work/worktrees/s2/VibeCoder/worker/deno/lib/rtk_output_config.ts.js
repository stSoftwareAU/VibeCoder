/**
 * `.config.json` surface for the RTK output switch (Issue #2380, part of
 * #2328).
 *
 * One host-level switch, `rtk_output.enabled`, decides whether a run installs
 * the RTK `PreToolUse` Bash rewrite hook and tells the agent about it. It is
 * on by default (Issue #2432): a host that never mentions the block filters,
 * and a host that wants the raw output back writes `enabled: false`.
 *
 * ## Validation posture — fail loud
 *
 * A switch that changes how every Bash call is run must never be
 * half-understood: reading a malformed block as "off" would leave an operator
 * who asked for the trial with a setting that looks live and does nothing. So,
 * matching `lib/codegraph_context_config.ts` rather than the warn-and-default
 * `idle_task_cadence` parser, {@link parseRtkOutput} returns the fault as an
 * error naming the offending field and the config load throws it.
 *
 * An **unknown key inside** the block is a different case: it changes no
 * behaviour, so it is reported by `lib/config_unknown_keys.ts` as a warning,
 * the way an unknown top-level key is.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */ import { OPERATIONAL_DEFAULTS } from "./config_defaults.ts";
/** Recognised keys inside the `rtk_output` block. */ export const RTK_OUTPUT_KEYS = new Set([
  "enabled"
]);
/**
 * The switch as an unconfigured host reads it.
 *
 * The value itself lives in `OPERATIONAL_DEFAULTS` — the one place config
 * defaults are written — and a fresh object is returned each call so no caller
 * can mutate the shared default.
 */ export function defaultRtkOutput() {
  return {
    enabled: OPERATIONAL_DEFAULTS.rtkOutput.enabled
  };
}
/** Whether a value is a plain (non-array, non-null) object. */ function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Parse the raw `rtk_output` block from `.config.json`.
 *
 * @param raw - The block as it appeared in the file, or `undefined`.
 * @returns The parsed switch, or the first fault naming the offending field.
 */ export function parseRtkOutput(raw) {
  // Only an **absent** key means "this host said nothing". An explicit `null`
  // is a written-out block, so it is refused like any other malformed one
  // rather than quietly reading as off.
  if (raw === undefined) return {
    ok: true,
    value: defaultRtkOutput()
  };
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      error: `rtk_output must be an object carrying a boolean "enabled" ` + `(rtk_output.enabled), got ${describe(raw)}.`
    };
  }
  const enabled = raw.enabled;
  if (enabled === undefined) {
    return {
      ok: true,
      value: defaultRtkOutput()
    };
  }
  if (typeof enabled !== "boolean") {
    return {
      ok: false,
      error: `rtk_output.enabled must be a boolean, got ${describe(enabled)}.`
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9ydGtfb3V0cHV0X2NvbmZpZy50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIGAuY29uZmlnLmpzb25gIHN1cmZhY2UgZm9yIHRoZSBSVEsgb3V0cHV0IHN3aXRjaCAoSXNzdWUgIzIzODAsIHBhcnQgb2ZcbiAqICMyMzI4KS5cbiAqXG4gKiBPbmUgaG9zdC1sZXZlbCBzd2l0Y2gsIGBydGtfb3V0cHV0LmVuYWJsZWRgLCBkZWNpZGVzIHdoZXRoZXIgYSBydW4gaW5zdGFsbHNcbiAqIHRoZSBSVEsgYFByZVRvb2xVc2VgIEJhc2ggcmV3cml0ZSBob29rIGFuZCB0ZWxscyB0aGUgYWdlbnQgYWJvdXQgaXQuIEl0IGlzXG4gKiBvbiBieSBkZWZhdWx0IChJc3N1ZSAjMjQzMik6IGEgaG9zdCB0aGF0IG5ldmVyIG1lbnRpb25zIHRoZSBibG9jayBmaWx0ZXJzLFxuICogYW5kIGEgaG9zdCB0aGF0IHdhbnRzIHRoZSByYXcgb3V0cHV0IGJhY2sgd3JpdGVzIGBlbmFibGVkOiBmYWxzZWAuXG4gKlxuICogIyMgVmFsaWRhdGlvbiBwb3N0dXJlIOKAlCBmYWlsIGxvdWRcbiAqXG4gKiBBIHN3aXRjaCB0aGF0IGNoYW5nZXMgaG93IGV2ZXJ5IEJhc2ggY2FsbCBpcyBydW4gbXVzdCBuZXZlciBiZVxuICogaGFsZi11bmRlcnN0b29kOiByZWFkaW5nIGEgbWFsZm9ybWVkIGJsb2NrIGFzIFwib2ZmXCIgd291bGQgbGVhdmUgYW4gb3BlcmF0b3JcbiAqIHdobyBhc2tlZCBmb3IgdGhlIHRyaWFsIHdpdGggYSBzZXR0aW5nIHRoYXQgbG9va3MgbGl2ZSBhbmQgZG9lcyBub3RoaW5nLiBTbyxcbiAqIG1hdGNoaW5nIGBsaWIvY29kZWdyYXBoX2NvbnRleHRfY29uZmlnLnRzYCByYXRoZXIgdGhhbiB0aGUgd2Fybi1hbmQtZGVmYXVsdFxuICogYGlkbGVfdGFza19jYWRlbmNlYCBwYXJzZXIsIHtAbGluayBwYXJzZVJ0a091dHB1dH0gcmV0dXJucyB0aGUgZmF1bHQgYXMgYW5cbiAqIGVycm9yIG5hbWluZyB0aGUgb2ZmZW5kaW5nIGZpZWxkIGFuZCB0aGUgY29uZmlnIGxvYWQgdGhyb3dzIGl0LlxuICpcbiAqIEFuICoqdW5rbm93biBrZXkgaW5zaWRlKiogdGhlIGJsb2NrIGlzIGEgZGlmZmVyZW50IGNhc2U6IGl0IGNoYW5nZXMgbm9cbiAqIGJlaGF2aW91ciwgc28gaXQgaXMgcmVwb3J0ZWQgYnkgYGxpYi9jb25maWdfdW5rbm93bl9rZXlzLnRzYCBhcyBhIHdhcm5pbmcsXG4gKiB0aGUgd2F5IGFuIHVua25vd24gdG9wLWxldmVsIGtleSBpcy5cbiAqXG4gKiBBdXN0cmFsaWFuIEVuZ2xpc2ggc3BlbGxpbmcgdXNlZCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIG9yZ2FuaXNhdGlvbikuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBSZXN1bHQsIFJ0a091dHB1dENvbmZpZyB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuaW1wb3J0IHsgT1BFUkFUSU9OQUxfREVGQVVMVFMgfSBmcm9tIFwiLi9jb25maWdfZGVmYXVsdHMudHNcIjtcblxuLyoqIFJlY29nbmlzZWQga2V5cyBpbnNpZGUgdGhlIGBydGtfb3V0cHV0YCBibG9jay4gKi9cbmV4cG9ydCBjb25zdCBSVEtfT1VUUFVUX0tFWVM6IFJlYWRvbmx5U2V0PHN0cmluZz4gPSBuZXcgU2V0KFtcbiAgXCJlbmFibGVkXCIsXG5dKTtcblxuLyoqXG4gKiBUaGUgc3dpdGNoIGFzIGFuIHVuY29uZmlndXJlZCBob3N0IHJlYWRzIGl0LlxuICpcbiAqIFRoZSB2YWx1ZSBpdHNlbGYgbGl2ZXMgaW4gYE9QRVJBVElPTkFMX0RFRkFVTFRTYCDigJQgdGhlIG9uZSBwbGFjZSBjb25maWdcbiAqIGRlZmF1bHRzIGFyZSB3cml0dGVuIOKAlCBhbmQgYSBmcmVzaCBvYmplY3QgaXMgcmV0dXJuZWQgZWFjaCBjYWxsIHNvIG5vIGNhbGxlclxuICogY2FuIG11dGF0ZSB0aGUgc2hhcmVkIGRlZmF1bHQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZWZhdWx0UnRrT3V0cHV0KCk6IFJ0a091dHB1dENvbmZpZyB7XG4gIHJldHVybiB7IGVuYWJsZWQ6IE9QRVJBVElPTkFMX0RFRkFVTFRTLnJ0a091dHB1dC5lbmFibGVkIH07XG59XG5cbi8qKiBXaGV0aGVyIGEgdmFsdWUgaXMgYSBwbGFpbiAobm9uLWFycmF5LCBub24tbnVsbCkgb2JqZWN0LiAqL1xuZnVuY3Rpb24gaXNQbGFpbk9iamVjdCh2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gXCJvYmplY3RcIiAmJiB2YWx1ZSAhPT0gbnVsbCAmJiAhQXJyYXkuaXNBcnJheSh2YWx1ZSk7XG59XG5cbi8qKlxuICogUGFyc2UgdGhlIHJhdyBgcnRrX291dHB1dGAgYmxvY2sgZnJvbSBgLmNvbmZpZy5qc29uYC5cbiAqXG4gKiBAcGFyYW0gcmF3IC0gVGhlIGJsb2NrIGFzIGl0IGFwcGVhcmVkIGluIHRoZSBmaWxlLCBvciBgdW5kZWZpbmVkYC5cbiAqIEByZXR1cm5zIFRoZSBwYXJzZWQgc3dpdGNoLCBvciB0aGUgZmlyc3QgZmF1bHQgbmFtaW5nIHRoZSBvZmZlbmRpbmcgZmllbGQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVJ0a091dHB1dChcbiAgcmF3OiB1bmtub3duLFxuKTogUmVzdWx0PFJ0a091dHB1dENvbmZpZywgc3RyaW5nPiB7XG4gIC8vIE9ubHkgYW4gKiphYnNlbnQqKiBrZXkgbWVhbnMgXCJ0aGlzIGhvc3Qgc2FpZCBub3RoaW5nXCIuIEFuIGV4cGxpY2l0IGBudWxsYFxuICAvLyBpcyBhIHdyaXR0ZW4tb3V0IGJsb2NrLCBzbyBpdCBpcyByZWZ1c2VkIGxpa2UgYW55IG90aGVyIG1hbGZvcm1lZCBvbmVcbiAgLy8gcmF0aGVyIHRoYW4gcXVpZXRseSByZWFkaW5nIGFzIG9mZi5cbiAgaWYgKHJhdyA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IGRlZmF1bHRSdGtPdXRwdXQoKSB9O1xuXG4gIGlmICghaXNQbGFpbk9iamVjdChyYXcpKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBgcnRrX291dHB1dCBtdXN0IGJlIGFuIG9iamVjdCBjYXJyeWluZyBhIGJvb2xlYW4gXCJlbmFibGVkXCIgYCArXG4gICAgICAgIGAocnRrX291dHB1dC5lbmFibGVkKSwgZ290ICR7ZGVzY3JpYmUocmF3KX0uYCxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgZW5hYmxlZCA9IHJhdy5lbmFibGVkO1xuICBpZiAoZW5hYmxlZCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBkZWZhdWx0UnRrT3V0cHV0KCkgfTtcbiAgfVxuICBpZiAodHlwZW9mIGVuYWJsZWQgIT09IFwiYm9vbGVhblwiKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBgcnRrX291dHB1dC5lbmFibGVkIG11c3QgYmUgYSBib29sZWFuLCBnb3QgJHtkZXNjcmliZShlbmFibGVkKX0uYCxcbiAgICB9O1xuICB9XG5cbiAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB7IGVuYWJsZWQgfSB9O1xufVxuXG4vKiogTmFtZSBhIHJlamVjdGVkIHZhbHVlJ3MgSlNPTiB0eXBlLCBkaXN0aW5ndWlzaGluZyBudWxsIGFuZCBhcnJheS4gKi9cbmZ1bmN0aW9uIGRlc2NyaWJlKHZhbHVlOiB1bmtub3duKTogc3RyaW5nIHtcbiAgaWYgKHZhbHVlID09PSBudWxsKSByZXR1cm4gXCJudWxsXCI7XG4gIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkgcmV0dXJuIFwiYXJyYXlcIjtcbiAgcmV0dXJuIHR5cGVvZiB2YWx1ZTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0F1QkMsR0FHRCxTQUFTLG9CQUFvQixRQUFRLHVCQUF1QjtBQUU1RCxtREFBbUQsR0FDbkQsT0FBTyxNQUFNLGtCQUF1QyxJQUFJLElBQUk7RUFDMUQ7Q0FDRCxFQUFFO0FBRUg7Ozs7OztDQU1DLEdBQ0QsT0FBTyxTQUFTO0VBQ2QsT0FBTztJQUFFLFNBQVMscUJBQXFCLFNBQVMsQ0FBQyxPQUFPO0VBQUM7QUFDM0Q7QUFFQSw2REFBNkQsR0FDN0QsU0FBUyxjQUFjLEtBQWM7RUFDbkMsT0FBTyxPQUFPLFVBQVUsWUFBWSxVQUFVLFFBQVEsQ0FBQyxNQUFNLE9BQU8sQ0FBQztBQUN2RTtBQUVBOzs7OztDQUtDLEdBQ0QsT0FBTyxTQUFTLGVBQ2QsR0FBWTtFQUVaLDRFQUE0RTtFQUM1RSx3RUFBd0U7RUFDeEUsc0NBQXNDO0VBQ3RDLElBQUksUUFBUSxXQUFXLE9BQU87SUFBRSxJQUFJO0lBQU0sT0FBTztFQUFtQjtFQUVwRSxJQUFJLENBQUMsY0FBYyxNQUFNO0lBQ3ZCLE9BQU87TUFDTCxJQUFJO01BQ0osT0FBTyxDQUFDLDBEQUEwRCxDQUFDLEdBQ2pFLENBQUMsMEJBQTBCLEVBQUUsU0FBUyxLQUFLLENBQUMsQ0FBQztJQUNqRDtFQUNGO0VBRUEsTUFBTSxVQUFVLElBQUksT0FBTztFQUMzQixJQUFJLFlBQVksV0FBVztJQUN6QixPQUFPO01BQUUsSUFBSTtNQUFNLE9BQU87SUFBbUI7RUFDL0M7RUFDQSxJQUFJLE9BQU8sWUFBWSxXQUFXO0lBQ2hDLE9BQU87TUFDTCxJQUFJO01BQ0osT0FBTyxDQUFDLDBDQUEwQyxFQUFFLFNBQVMsU0FBUyxDQUFDLENBQUM7SUFDMUU7RUFDRjtFQUVBLE9BQU87SUFBRSxJQUFJO0lBQU0sT0FBTztNQUFFO0lBQVE7RUFBRTtBQUN4QztBQUVBLHNFQUFzRSxHQUN0RSxTQUFTLFNBQVMsS0FBYztFQUM5QixJQUFJLFVBQVUsTUFBTSxPQUFPO0VBQzNCLElBQUksTUFBTSxPQUFPLENBQUMsUUFBUSxPQUFPO0VBQ2pDLE9BQU8sT0FBTztBQUNoQiJ9
// denoCacheMetadata=11284697623884163604,17507090368961213552