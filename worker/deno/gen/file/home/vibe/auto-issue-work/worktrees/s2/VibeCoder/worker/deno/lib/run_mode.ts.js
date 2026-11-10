/**
 * The run-mode setting — container, and only container (Issue #4, parent
 * #4145, milestone #4060).
 *
 * Containment is mandatory: the worker runs inside the Vibe Coder container.
 * The former `native` mode (a host-native run, Issue #4148) and the macOS
 * `seatbelt` mode (native under a `sandbox-exec` profile, Issue #4300) were
 * removed by Issue #4 — a host-mode run sits outside the #4060 boundary this
 * project's risk profile is written against, and the fleet ran the two
 * host-mode branches only long enough to prove the container one.
 *
 * This module is still the single spelling of the setting, so a configuration
 * that names a removed mode fails **loud** in one place — the launchers and
 * `setup.sh` resolve through it (via the `run-mode` Deno subcommand) — rather
 * than being silently coerced to a container run the operator did not know
 * they were getting (Issue #3234).
 *
 * ```mermaid
 * flowchart LR
 *     E["VIBE_RUN_MODE"] -->|wins| R["resolveRunMode()"]
 *     C[".config.json<br/>run_mode"] --> R
 *     D["default: container"] --> R
 *     R --> M{"container"}
 *     M -->|native / seatbelt| X["throw — removed (Issue #4)"]
 *     M -->|anything else| Y["throw — not a run mode"]
 * ```
 *
 * Australian English spelling throughout (behaviour, organisation).
 */ /** Where the worker runs: inside the container. The only member. */ /** Every run mode the worker supports. */ export const RUN_MODES = [
  "container"
];
/** The default — and only — run mode. */ export const DEFAULT_RUN_MODE = "container";
/**
 * Run modes that once existed and were removed (Issue #4). Named so a
 * configuration still carrying one gets the removal explained, not a generic
 * "not a run mode".
 */ export const REMOVED_RUN_MODES = [
  "native",
  "seatbelt"
];
/** `.config.json` key that selects the run mode. */ export const RUN_MODE_CONFIG_KEY = "run_mode";
/** Environment variable that overrides the configuration for one run. */ export const RUN_MODE_ENV = "VIBE_RUN_MODE";
/** Type guard: is `value` a run mode the worker supports? */ export function isRunMode(value) {
  return typeof value === "string" && RUN_MODES.includes(value);
}
/**
 * Parse a run-mode string, failing loud on anything but a supported mode.
 *
 * @param value - The raw setting
 * @param source - Where it came from, for the error message
 * @returns The run mode
 * @throws When the value names a removed mode, or is not a run mode at all
 */ export function parseRunMode(value, source) {
  const wanted = value.trim();
  if (isRunMode(wanted)) return wanted;
  if (REMOVED_RUN_MODES.includes(wanted)) {
    throw new Error(`${source} names the removed run mode ${JSON.stringify(wanted)}: ` + `containment is mandatory (Issue #4) — the worker runs only inside ` + `the container. Remove "${RUN_MODE_CONFIG_KEY}" from .config.json ` + `(or unset ${RUN_MODE_ENV}); ./setup.sh installs the container ` + `runtime.`);
  }
  throw new Error(`${source} is not a run mode: ${JSON.stringify(value)}. ` + `The only run mode is ${DEFAULT_RUN_MODE}; leave it unset.`);
}
/**
 * Resolve the run mode: `VIBE_RUN_MODE`, then `.config.json`, then the
 * default. Every value is parsed through {@link parseRunMode}, so a removed
 * or misspelled mode fails loud wherever it was set.
 */ export function resolveRunMode(selection = {}) {
  const env = selection.env ?? ((name)=>Deno.env.get(name));
  const override = env(RUN_MODE_ENV)?.trim();
  if (override) return parseRunMode(override, RUN_MODE_ENV);
  const configured = selection.configured?.trim();
  if (configured) {
    return parseRunMode(configured, `Configuration key "${RUN_MODE_CONFIG_KEY}"`);
  }
  return DEFAULT_RUN_MODE;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9ydW5fbW9kZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFRoZSBydW4tbW9kZSBzZXR0aW5nIOKAlCBjb250YWluZXIsIGFuZCBvbmx5IGNvbnRhaW5lciAoSXNzdWUgIzQsIHBhcmVudFxuICogIzQxNDUsIG1pbGVzdG9uZSAjNDA2MCkuXG4gKlxuICogQ29udGFpbm1lbnQgaXMgbWFuZGF0b3J5OiB0aGUgd29ya2VyIHJ1bnMgaW5zaWRlIHRoZSBWaWJlIENvZGVyIGNvbnRhaW5lci5cbiAqIFRoZSBmb3JtZXIgYG5hdGl2ZWAgbW9kZSAoYSBob3N0LW5hdGl2ZSBydW4sIElzc3VlICM0MTQ4KSBhbmQgdGhlIG1hY09TXG4gKiBgc2VhdGJlbHRgIG1vZGUgKG5hdGl2ZSB1bmRlciBhIGBzYW5kYm94LWV4ZWNgIHByb2ZpbGUsIElzc3VlICM0MzAwKSB3ZXJlXG4gKiByZW1vdmVkIGJ5IElzc3VlICM0IOKAlCBhIGhvc3QtbW9kZSBydW4gc2l0cyBvdXRzaWRlIHRoZSAjNDA2MCBib3VuZGFyeSB0aGlzXG4gKiBwcm9qZWN0J3MgcmlzayBwcm9maWxlIGlzIHdyaXR0ZW4gYWdhaW5zdCwgYW5kIHRoZSBmbGVldCByYW4gdGhlIHR3b1xuICogaG9zdC1tb2RlIGJyYW5jaGVzIG9ubHkgbG9uZyBlbm91Z2ggdG8gcHJvdmUgdGhlIGNvbnRhaW5lciBvbmUuXG4gKlxuICogVGhpcyBtb2R1bGUgaXMgc3RpbGwgdGhlIHNpbmdsZSBzcGVsbGluZyBvZiB0aGUgc2V0dGluZywgc28gYSBjb25maWd1cmF0aW9uXG4gKiB0aGF0IG5hbWVzIGEgcmVtb3ZlZCBtb2RlIGZhaWxzICoqbG91ZCoqIGluIG9uZSBwbGFjZSDigJQgdGhlIGxhdW5jaGVycyBhbmRcbiAqIGBzZXR1cC5zaGAgcmVzb2x2ZSB0aHJvdWdoIGl0ICh2aWEgdGhlIGBydW4tbW9kZWAgRGVubyBzdWJjb21tYW5kKSDigJQgcmF0aGVyXG4gKiB0aGFuIGJlaW5nIHNpbGVudGx5IGNvZXJjZWQgdG8gYSBjb250YWluZXIgcnVuIHRoZSBvcGVyYXRvciBkaWQgbm90IGtub3dcbiAqIHRoZXkgd2VyZSBnZXR0aW5nIChJc3N1ZSAjMzIzNCkuXG4gKlxuICogYGBgbWVybWFpZFxuICogZmxvd2NoYXJ0IExSXG4gKiAgICAgRVtcIlZJQkVfUlVOX01PREVcIl0gLS0+fHdpbnN8IFJbXCJyZXNvbHZlUnVuTW9kZSgpXCJdXG4gKiAgICAgQ1tcIi5jb25maWcuanNvbjxici8+cnVuX21vZGVcIl0gLS0+IFJcbiAqICAgICBEW1wiZGVmYXVsdDogY29udGFpbmVyXCJdIC0tPiBSXG4gKiAgICAgUiAtLT4gTXtcImNvbnRhaW5lclwifVxuICogICAgIE0gLS0+fG5hdGl2ZSAvIHNlYXRiZWx0fCBYW1widGhyb3cg4oCUIHJlbW92ZWQgKElzc3VlICM0KVwiXVxuICogICAgIE0gLS0+fGFueXRoaW5nIGVsc2V8IFlbXCJ0aHJvdyDigJQgbm90IGEgcnVuIG1vZGVcIl1cbiAqIGBgYFxuICpcbiAqIEF1c3RyYWxpYW4gRW5nbGlzaCBzcGVsbGluZyB0aHJvdWdob3V0IChiZWhhdmlvdXIsIG9yZ2FuaXNhdGlvbikuXG4gKi9cblxuLyoqIFdoZXJlIHRoZSB3b3JrZXIgcnVuczogaW5zaWRlIHRoZSBjb250YWluZXIuIFRoZSBvbmx5IG1lbWJlci4gKi9cbmV4cG9ydCB0eXBlIFJ1bk1vZGUgPSBcImNvbnRhaW5lclwiO1xuXG4vKiogRXZlcnkgcnVuIG1vZGUgdGhlIHdvcmtlciBzdXBwb3J0cy4gKi9cbmV4cG9ydCBjb25zdCBSVU5fTU9ERVM6IHJlYWRvbmx5IFJ1bk1vZGVbXSA9IFtcImNvbnRhaW5lclwiXTtcblxuLyoqIFRoZSBkZWZhdWx0IOKAlCBhbmQgb25seSDigJQgcnVuIG1vZGUuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9SVU5fTU9ERTogUnVuTW9kZSA9IFwiY29udGFpbmVyXCI7XG5cbi8qKlxuICogUnVuIG1vZGVzIHRoYXQgb25jZSBleGlzdGVkIGFuZCB3ZXJlIHJlbW92ZWQgKElzc3VlICM0KS4gTmFtZWQgc28gYVxuICogY29uZmlndXJhdGlvbiBzdGlsbCBjYXJyeWluZyBvbmUgZ2V0cyB0aGUgcmVtb3ZhbCBleHBsYWluZWQsIG5vdCBhIGdlbmVyaWNcbiAqIFwibm90IGEgcnVuIG1vZGVcIi5cbiAqL1xuZXhwb3J0IGNvbnN0IFJFTU9WRURfUlVOX01PREVTOiByZWFkb25seSBzdHJpbmdbXSA9IFtcIm5hdGl2ZVwiLCBcInNlYXRiZWx0XCJdO1xuXG4vKiogYC5jb25maWcuanNvbmAga2V5IHRoYXQgc2VsZWN0cyB0aGUgcnVuIG1vZGUuICovXG5leHBvcnQgY29uc3QgUlVOX01PREVfQ09ORklHX0tFWSA9IFwicnVuX21vZGVcIjtcblxuLyoqIEVudmlyb25tZW50IHZhcmlhYmxlIHRoYXQgb3ZlcnJpZGVzIHRoZSBjb25maWd1cmF0aW9uIGZvciBvbmUgcnVuLiAqL1xuZXhwb3J0IGNvbnN0IFJVTl9NT0RFX0VOViA9IFwiVklCRV9SVU5fTU9ERVwiO1xuXG4vKiogVHlwZSBndWFyZDogaXMgYHZhbHVlYCBhIHJ1biBtb2RlIHRoZSB3b3JrZXIgc3VwcG9ydHM/ICovXG5leHBvcnQgZnVuY3Rpb24gaXNSdW5Nb2RlKHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgUnVuTW9kZSB7XG4gIHJldHVybiB0eXBlb2YgdmFsdWUgPT09IFwic3RyaW5nXCIgJiZcbiAgICAoUlVOX01PREVTIGFzIHJlYWRvbmx5IHN0cmluZ1tdKS5pbmNsdWRlcyh2YWx1ZSk7XG59XG5cbi8qKlxuICogUGFyc2UgYSBydW4tbW9kZSBzdHJpbmcsIGZhaWxpbmcgbG91ZCBvbiBhbnl0aGluZyBidXQgYSBzdXBwb3J0ZWQgbW9kZS5cbiAqXG4gKiBAcGFyYW0gdmFsdWUgLSBUaGUgcmF3IHNldHRpbmdcbiAqIEBwYXJhbSBzb3VyY2UgLSBXaGVyZSBpdCBjYW1lIGZyb20sIGZvciB0aGUgZXJyb3IgbWVzc2FnZVxuICogQHJldHVybnMgVGhlIHJ1biBtb2RlXG4gKiBAdGhyb3dzIFdoZW4gdGhlIHZhbHVlIG5hbWVzIGEgcmVtb3ZlZCBtb2RlLCBvciBpcyBub3QgYSBydW4gbW9kZSBhdCBhbGxcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlUnVuTW9kZSh2YWx1ZTogc3RyaW5nLCBzb3VyY2U6IHN0cmluZyk6IFJ1bk1vZGUge1xuICBjb25zdCB3YW50ZWQgPSB2YWx1ZS50cmltKCk7XG4gIGlmIChpc1J1bk1vZGUod2FudGVkKSkgcmV0dXJuIHdhbnRlZDtcbiAgaWYgKFJFTU9WRURfUlVOX01PREVTLmluY2x1ZGVzKHdhbnRlZCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgJHtzb3VyY2V9IG5hbWVzIHRoZSByZW1vdmVkIHJ1biBtb2RlICR7SlNPTi5zdHJpbmdpZnkod2FudGVkKX06IGAgK1xuICAgICAgICBgY29udGFpbm1lbnQgaXMgbWFuZGF0b3J5IChJc3N1ZSAjNCkg4oCUIHRoZSB3b3JrZXIgcnVucyBvbmx5IGluc2lkZSBgICtcbiAgICAgICAgYHRoZSBjb250YWluZXIuIFJlbW92ZSBcIiR7UlVOX01PREVfQ09ORklHX0tFWX1cIiBmcm9tIC5jb25maWcuanNvbiBgICtcbiAgICAgICAgYChvciB1bnNldCAke1JVTl9NT0RFX0VOVn0pOyAuL3NldHVwLnNoIGluc3RhbGxzIHRoZSBjb250YWluZXIgYCArXG4gICAgICAgIGBydW50aW1lLmAsXG4gICAgKTtcbiAgfVxuICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgYCR7c291cmNlfSBpcyBub3QgYSBydW4gbW9kZTogJHtKU09OLnN0cmluZ2lmeSh2YWx1ZSl9LiBgICtcbiAgICAgIGBUaGUgb25seSBydW4gbW9kZSBpcyAke0RFRkFVTFRfUlVOX01PREV9OyBsZWF2ZSBpdCB1bnNldC5gLFxuICApO1xufVxuXG4vKiogSW5wdXRzIHRvIHtAbGluayByZXNvbHZlUnVuTW9kZX0uICovXG5leHBvcnQgaW50ZXJmYWNlIFJ1bk1vZGVTZWxlY3Rpb24ge1xuICAvKiogVGhlIGAuY29uZmlnLmpzb25gIHtAbGluayBSVU5fTU9ERV9DT05GSUdfS0VZfSB2YWx1ZSwgd2hlbiBzZXQuICovXG4gIGNvbmZpZ3VyZWQ/OiBzdHJpbmc7XG4gIC8qKiBFbnZpcm9ubWVudCBsb29rdXAgKGRlZmF1bHRzIHRvIHRoZSBwcm9jZXNzIGVudmlyb25tZW50KS4gKi9cbiAgZW52PzogKG5hbWU6IHN0cmluZykgPT4gc3RyaW5nIHwgdW5kZWZpbmVkO1xufVxuXG4vKipcbiAqIFJlc29sdmUgdGhlIHJ1biBtb2RlOiBgVklCRV9SVU5fTU9ERWAsIHRoZW4gYC5jb25maWcuanNvbmAsIHRoZW4gdGhlXG4gKiBkZWZhdWx0LiBFdmVyeSB2YWx1ZSBpcyBwYXJzZWQgdGhyb3VnaCB7QGxpbmsgcGFyc2VSdW5Nb2RlfSwgc28gYSByZW1vdmVkXG4gKiBvciBtaXNzcGVsbGVkIG1vZGUgZmFpbHMgbG91ZCB3aGVyZXZlciBpdCB3YXMgc2V0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZVJ1bk1vZGUoc2VsZWN0aW9uOiBSdW5Nb2RlU2VsZWN0aW9uID0ge30pOiBSdW5Nb2RlIHtcbiAgY29uc3QgZW52ID0gc2VsZWN0aW9uLmVudiA/PyAoKG5hbWU6IHN0cmluZykgPT4gRGVuby5lbnYuZ2V0KG5hbWUpKTtcblxuICBjb25zdCBvdmVycmlkZSA9IGVudihSVU5fTU9ERV9FTlYpPy50cmltKCk7XG4gIGlmIChvdmVycmlkZSkgcmV0dXJuIHBhcnNlUnVuTW9kZShvdmVycmlkZSwgUlVOX01PREVfRU5WKTtcblxuICBjb25zdCBjb25maWd1cmVkID0gc2VsZWN0aW9uLmNvbmZpZ3VyZWQ/LnRyaW0oKTtcbiAgaWYgKGNvbmZpZ3VyZWQpIHtcbiAgICByZXR1cm4gcGFyc2VSdW5Nb2RlKFxuICAgICAgY29uZmlndXJlZCxcbiAgICAgIGBDb25maWd1cmF0aW9uIGtleSBcIiR7UlVOX01PREVfQ09ORklHX0tFWX1cImAsXG4gICAgKTtcbiAgfVxuXG4gIHJldHVybiBERUZBVUxUX1JVTl9NT0RFO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBNEJDLEdBRUQsa0VBQWtFLEdBR2xFLHdDQUF3QyxHQUN4QyxPQUFPLE1BQU0sWUFBZ0M7RUFBQztDQUFZLENBQUM7QUFFM0QsdUNBQXVDLEdBQ3ZDLE9BQU8sTUFBTSxtQkFBNEIsWUFBWTtBQUVyRDs7OztDQUlDLEdBQ0QsT0FBTyxNQUFNLG9CQUF1QztFQUFDO0VBQVU7Q0FBVyxDQUFDO0FBRTNFLGtEQUFrRCxHQUNsRCxPQUFPLE1BQU0sc0JBQXNCLFdBQVc7QUFFOUMsdUVBQXVFLEdBQ3ZFLE9BQU8sTUFBTSxlQUFlLGdCQUFnQjtBQUU1QywyREFBMkQsR0FDM0QsT0FBTyxTQUFTLFVBQVUsS0FBYztFQUN0QyxPQUFPLE9BQU8sVUFBVSxZQUN0QixBQUFDLFVBQWdDLFFBQVEsQ0FBQztBQUM5QztBQUVBOzs7Ozs7O0NBT0MsR0FDRCxPQUFPLFNBQVMsYUFBYSxLQUFhLEVBQUUsTUFBYztFQUN4RCxNQUFNLFNBQVMsTUFBTSxJQUFJO0VBQ3pCLElBQUksVUFBVSxTQUFTLE9BQU87RUFDOUIsSUFBSSxrQkFBa0IsUUFBUSxDQUFDLFNBQVM7SUFDdEMsTUFBTSxJQUFJLE1BQ1IsR0FBRyxPQUFPLDRCQUE0QixFQUFFLEtBQUssU0FBUyxDQUFDLFFBQVEsRUFBRSxDQUFDLEdBQ2hFLENBQUMsa0VBQWtFLENBQUMsR0FDcEUsQ0FBQyx1QkFBdUIsRUFBRSxvQkFBb0Isb0JBQW9CLENBQUMsR0FDbkUsQ0FBQyxVQUFVLEVBQUUsYUFBYSxxQ0FBcUMsQ0FBQyxHQUNoRSxDQUFDLFFBQVEsQ0FBQztFQUVoQjtFQUNBLE1BQU0sSUFBSSxNQUNSLEdBQUcsT0FBTyxvQkFBb0IsRUFBRSxLQUFLLFNBQVMsQ0FBQyxPQUFPLEVBQUUsQ0FBQyxHQUN2RCxDQUFDLHFCQUFxQixFQUFFLGlCQUFpQixpQkFBaUIsQ0FBQztBQUVqRTtBQVVBOzs7O0NBSUMsR0FDRCxPQUFPLFNBQVMsZUFBZSxZQUE4QixDQUFDLENBQUM7RUFDN0QsTUFBTSxNQUFNLFVBQVUsR0FBRyxJQUFJLENBQUMsQ0FBQyxPQUFpQixLQUFLLEdBQUcsQ0FBQyxHQUFHLENBQUMsS0FBSztFQUVsRSxNQUFNLFdBQVcsSUFBSSxlQUFlO0VBQ3BDLElBQUksVUFBVSxPQUFPLGFBQWEsVUFBVTtFQUU1QyxNQUFNLGFBQWEsVUFBVSxVQUFVLEVBQUU7RUFDekMsSUFBSSxZQUFZO0lBQ2QsT0FBTyxhQUNMLFlBQ0EsQ0FBQyxtQkFBbUIsRUFBRSxvQkFBb0IsQ0FBQyxDQUFDO0VBRWhEO0VBRUEsT0FBTztBQUNUIn0=
// denoCacheMetadata=8898442871659171123,13729724107098983582