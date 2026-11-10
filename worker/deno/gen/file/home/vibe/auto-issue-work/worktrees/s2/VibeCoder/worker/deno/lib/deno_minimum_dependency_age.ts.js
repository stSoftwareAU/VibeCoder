/**
 * Canonical native-Deno minimum-dependency-age policy (Issue #2539).
 *
 * Deno 2.6+ enforces a supply-chain quarantine on JSR/npm dependencies via
 * the `minimumDependencyAge` setting in `deno.json` (and the matching
 * `--minimum-dependency-age` flag on `deno update` / `deno outdated`). This
 * module is the single source of truth for the *Deno* enforcement
 * mechanism: the 24h external floor and the 0h internal-scope exclusion that
 * sub-issues of #2536 reference.
 *
 * Policy numbers are unchanged from the existing 24h-external / 0h-internal
 * rule (renovate.json `minimumReleaseAge`, `VIBE_BUMP_QUARANTINE_HOURS`).
 * `VIBE_BUMP_QUARANTINE_HOURS` still governs npm/cargo/Actions bumps via
 * `bump-deps.sh`; this module covers Deno deps only and does NOT replace or
 * repurpose it.
 *
 * Canonical config shape (object form, per deno's config-file schema):
 *
 *   "minimumDependencyAge": {
 *     "age": "P1D",
 *     "exclude": ["jsr:@stsoftware/*", "npm:@stsoftware/*"]
 *   }
 *
 *   - `age` accepts integer minutes ("1440"), an ISO-8601 duration ("P1D"
 *     = 24h, "PT24H"), an RFC3339 cutoff date/timestamp, or "0" to disable.
 *   - `exclude` is a list of jsr:/npm: package globs exempted from the
 *     floor (0h quarantine). Each entry must start with `jsr:` or `npm:`
 *     to satisfy deno's exclude schema (`^(?:npm:|jsr:).+`).
 *   - The feature is marked "(Unstable)" in deno's config-file schema but
 *     is accepted by `deno check` / `deno outdated` on Deno v2.x with no
 *     `--unstable-*` flag and no `unstable` array entry required (verified
 *     against Deno 2.8.1).
 *
 * Australian English used throughout (behaviour, organisation, etc.).
 */ /** Canonical external floor as an ISO-8601 duration: 24 hours (one day). */ export const CANONICAL_MINIMUM_DEPENDENCY_AGE = "P1D";
/** Hours the canonical external floor maps to. */ export const CANONICAL_MINIMUM_DEPENDENCY_AGE_HOURS = 24;
/**
 * Internal stSoftwareAU Deno deps exempted from the floor (0h quarantine).
 * Mirrors the `stSoftwareAU/*` bypass in `renovate.json`. Each glob carries
 * a `jsr:` or `npm:` prefix to satisfy deno's exclude schema. The repo
 * itself imports only `jsr:@std/*` today, so these entries match nothing
 * yet — they pin the canonical pattern for repos that do have internal
 * Deno deps.
 */ export const INTERNAL_SCOPE_EXCLUDES = [
  "jsr:@stsoftware/*",
  "npm:@stsoftware/*"
];
/** Build the canonical `minimumDependencyAge` config object. */ export function buildMinimumDependencyAgeConfig() {
  return {
    age: CANONICAL_MINIMUM_DEPENDENCY_AGE,
    exclude: [
      ...INTERNAL_SCOPE_EXCLUDES
    ]
  };
}
/** True when `entry` is a valid deno exclude glob (jsr:/npm: prefixed). */ export function isValidExcludeEntry(entry) {
  return /^(?:npm:|jsr:).+/.test(entry);
}
const ISO_8601_DURATION = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;
/**
 * Parse a deno `minimumDependencyAge` "age" value into hours.
 *
 * Accepts the duration-style forms deno understands: integer minutes
 * (`"1440"` or the number `1440`) and ISO-8601 durations built from
 * weeks/days/hours/minutes/seconds (`"P1D"`, `"PT24H"`, `"PT30M"`). Returns
 * `null` for unrecognised input and for absolute RFC3339 cutoff dates,
 * which are points in time rather than fixed durations. Calendar durations
 * with years or months (`"P1Y"`, `"P1M"`) are also rejected because they do
 * not map to a fixed number of hours.
 */ export function parseMinimumDependencyAgeHours(value) {
  if (value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value / 60 : null;
  }
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed === "0") return 0;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) / 60; // minutes
  if (trimmed === "P" || trimmed === "PT") return null; // empty durations
  const match = ISO_8601_DURATION.exec(trimmed);
  if (!match) return null;
  const [, w, d, h, m, s] = match;
  const weeks = w ? Number(w) : 0;
  const days = d ? Number(d) : 0;
  const hours = h ? Number(h) : 0;
  const minutes = m ? Number(m) : 0;
  const seconds = s ? Number(s) : 0;
  return weeks * 168 + days * 24 + hours + minutes / 60 + seconds / 3600;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9kZW5vX21pbmltdW1fZGVwZW5kZW5jeV9hZ2UudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBDYW5vbmljYWwgbmF0aXZlLURlbm8gbWluaW11bS1kZXBlbmRlbmN5LWFnZSBwb2xpY3kgKElzc3VlICMyNTM5KS5cbiAqXG4gKiBEZW5vIDIuNisgZW5mb3JjZXMgYSBzdXBwbHktY2hhaW4gcXVhcmFudGluZSBvbiBKU1IvbnBtIGRlcGVuZGVuY2llcyB2aWFcbiAqIHRoZSBgbWluaW11bURlcGVuZGVuY3lBZ2VgIHNldHRpbmcgaW4gYGRlbm8uanNvbmAgKGFuZCB0aGUgbWF0Y2hpbmdcbiAqIGAtLW1pbmltdW0tZGVwZW5kZW5jeS1hZ2VgIGZsYWcgb24gYGRlbm8gdXBkYXRlYCAvIGBkZW5vIG91dGRhdGVkYCkuIFRoaXNcbiAqIG1vZHVsZSBpcyB0aGUgc2luZ2xlIHNvdXJjZSBvZiB0cnV0aCBmb3IgdGhlICpEZW5vKiBlbmZvcmNlbWVudFxuICogbWVjaGFuaXNtOiB0aGUgMjRoIGV4dGVybmFsIGZsb29yIGFuZCB0aGUgMGggaW50ZXJuYWwtc2NvcGUgZXhjbHVzaW9uIHRoYXRcbiAqIHN1Yi1pc3N1ZXMgb2YgIzI1MzYgcmVmZXJlbmNlLlxuICpcbiAqIFBvbGljeSBudW1iZXJzIGFyZSB1bmNoYW5nZWQgZnJvbSB0aGUgZXhpc3RpbmcgMjRoLWV4dGVybmFsIC8gMGgtaW50ZXJuYWxcbiAqIHJ1bGUgKHJlbm92YXRlLmpzb24gYG1pbmltdW1SZWxlYXNlQWdlYCwgYFZJQkVfQlVNUF9RVUFSQU5USU5FX0hPVVJTYCkuXG4gKiBgVklCRV9CVU1QX1FVQVJBTlRJTkVfSE9VUlNgIHN0aWxsIGdvdmVybnMgbnBtL2NhcmdvL0FjdGlvbnMgYnVtcHMgdmlhXG4gKiBgYnVtcC1kZXBzLnNoYDsgdGhpcyBtb2R1bGUgY292ZXJzIERlbm8gZGVwcyBvbmx5IGFuZCBkb2VzIE5PVCByZXBsYWNlIG9yXG4gKiByZXB1cnBvc2UgaXQuXG4gKlxuICogQ2Fub25pY2FsIGNvbmZpZyBzaGFwZSAob2JqZWN0IGZvcm0sIHBlciBkZW5vJ3MgY29uZmlnLWZpbGUgc2NoZW1hKTpcbiAqXG4gKiAgIFwibWluaW11bURlcGVuZGVuY3lBZ2VcIjoge1xuICogICAgIFwiYWdlXCI6IFwiUDFEXCIsXG4gKiAgICAgXCJleGNsdWRlXCI6IFtcImpzcjpAc3Rzb2Z0d2FyZS8qXCIsIFwibnBtOkBzdHNvZnR3YXJlLypcIl1cbiAqICAgfVxuICpcbiAqICAgLSBgYWdlYCBhY2NlcHRzIGludGVnZXIgbWludXRlcyAoXCIxNDQwXCIpLCBhbiBJU08tODYwMSBkdXJhdGlvbiAoXCJQMURcIlxuICogICAgID0gMjRoLCBcIlBUMjRIXCIpLCBhbiBSRkMzMzM5IGN1dG9mZiBkYXRlL3RpbWVzdGFtcCwgb3IgXCIwXCIgdG8gZGlzYWJsZS5cbiAqICAgLSBgZXhjbHVkZWAgaXMgYSBsaXN0IG9mIGpzcjovbnBtOiBwYWNrYWdlIGdsb2JzIGV4ZW1wdGVkIGZyb20gdGhlXG4gKiAgICAgZmxvb3IgKDBoIHF1YXJhbnRpbmUpLiBFYWNoIGVudHJ5IG11c3Qgc3RhcnQgd2l0aCBganNyOmAgb3IgYG5wbTpgXG4gKiAgICAgdG8gc2F0aXNmeSBkZW5vJ3MgZXhjbHVkZSBzY2hlbWEgKGBeKD86bnBtOnxqc3I6KS4rYCkuXG4gKiAgIC0gVGhlIGZlYXR1cmUgaXMgbWFya2VkIFwiKFVuc3RhYmxlKVwiIGluIGRlbm8ncyBjb25maWctZmlsZSBzY2hlbWEgYnV0XG4gKiAgICAgaXMgYWNjZXB0ZWQgYnkgYGRlbm8gY2hlY2tgIC8gYGRlbm8gb3V0ZGF0ZWRgIG9uIERlbm8gdjIueCB3aXRoIG5vXG4gKiAgICAgYC0tdW5zdGFibGUtKmAgZmxhZyBhbmQgbm8gYHVuc3RhYmxlYCBhcnJheSBlbnRyeSByZXF1aXJlZCAodmVyaWZpZWRcbiAqICAgICBhZ2FpbnN0IERlbm8gMi44LjEpLlxuICpcbiAqIEF1c3RyYWxpYW4gRW5nbGlzaCB1c2VkIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG4vKiogQ2Fub25pY2FsIGV4dGVybmFsIGZsb29yIGFzIGFuIElTTy04NjAxIGR1cmF0aW9uOiAyNCBob3VycyAob25lIGRheSkuICovXG5leHBvcnQgY29uc3QgQ0FOT05JQ0FMX01JTklNVU1fREVQRU5ERU5DWV9BR0UgPSBcIlAxRFwiO1xuXG4vKiogSG91cnMgdGhlIGNhbm9uaWNhbCBleHRlcm5hbCBmbG9vciBtYXBzIHRvLiAqL1xuZXhwb3J0IGNvbnN0IENBTk9OSUNBTF9NSU5JTVVNX0RFUEVOREVOQ1lfQUdFX0hPVVJTID0gMjQ7XG5cbi8qKlxuICogSW50ZXJuYWwgc3RTb2Z0d2FyZUFVIERlbm8gZGVwcyBleGVtcHRlZCBmcm9tIHRoZSBmbG9vciAoMGggcXVhcmFudGluZSkuXG4gKiBNaXJyb3JzIHRoZSBgc3RTb2Z0d2FyZUFVLypgIGJ5cGFzcyBpbiBgcmVub3ZhdGUuanNvbmAuIEVhY2ggZ2xvYiBjYXJyaWVzXG4gKiBhIGBqc3I6YCBvciBgbnBtOmAgcHJlZml4IHRvIHNhdGlzZnkgZGVubydzIGV4Y2x1ZGUgc2NoZW1hLiBUaGUgcmVwb1xuICogaXRzZWxmIGltcG9ydHMgb25seSBganNyOkBzdGQvKmAgdG9kYXksIHNvIHRoZXNlIGVudHJpZXMgbWF0Y2ggbm90aGluZ1xuICogeWV0IOKAlCB0aGV5IHBpbiB0aGUgY2Fub25pY2FsIHBhdHRlcm4gZm9yIHJlcG9zIHRoYXQgZG8gaGF2ZSBpbnRlcm5hbFxuICogRGVubyBkZXBzLlxuICovXG5leHBvcnQgY29uc3QgSU5URVJOQUxfU0NPUEVfRVhDTFVERVMgPSBbXG4gIFwianNyOkBzdHNvZnR3YXJlLypcIixcbiAgXCJucG06QHN0c29mdHdhcmUvKlwiLFxuXSBhcyBjb25zdDtcblxuLyoqIE9iamVjdCBmb3JtIG9mIHRoZSBgbWluaW11bURlcGVuZGVuY3lBZ2VgIHNldHRpbmcgaW4gYGRlbm8uanNvbmAuICovXG5leHBvcnQgaW50ZXJmYWNlIE1pbmltdW1EZXBlbmRlbmN5QWdlQ29uZmlnIHtcbiAgLyoqIEZsb29yIGV4cHJlc3NlZCBhcyBtaW51dGVzLCBJU08tODYwMSBkdXJhdGlvbiwgUkZDMzMzOSBkYXRlLCBvciBcIjBcIi4gKi9cbiAgYWdlOiBzdHJpbmc7XG4gIC8qKiBqc3I6L25wbTogcGFja2FnZSBnbG9icyBleGVtcHRlZCBmcm9tIHRoZSBmbG9vci4gKi9cbiAgZXhjbHVkZTogc3RyaW5nW107XG59XG5cbi8qKiBCdWlsZCB0aGUgY2Fub25pY2FsIGBtaW5pbXVtRGVwZW5kZW5jeUFnZWAgY29uZmlnIG9iamVjdC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZE1pbmltdW1EZXBlbmRlbmN5QWdlQ29uZmlnKCk6IE1pbmltdW1EZXBlbmRlbmN5QWdlQ29uZmlnIHtcbiAgcmV0dXJuIHtcbiAgICBhZ2U6IENBTk9OSUNBTF9NSU5JTVVNX0RFUEVOREVOQ1lfQUdFLFxuICAgIGV4Y2x1ZGU6IFsuLi5JTlRFUk5BTF9TQ09QRV9FWENMVURFU10sXG4gIH07XG59XG5cbi8qKiBUcnVlIHdoZW4gYGVudHJ5YCBpcyBhIHZhbGlkIGRlbm8gZXhjbHVkZSBnbG9iIChqc3I6L25wbTogcHJlZml4ZWQpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzVmFsaWRFeGNsdWRlRW50cnkoZW50cnk6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gL14oPzpucG06fGpzcjopLisvLnRlc3QoZW50cnkpO1xufVxuXG5jb25zdCBJU09fODYwMV9EVVJBVElPTiA9XG4gIC9eUCg/OihcXGQrKVcpPyg/OihcXGQrKUQpPyg/OlQoPzooXFxkKylIKT8oPzooXFxkKylNKT8oPzooXFxkKyg/OlxcLlxcZCspPylTKT8pPyQvO1xuXG4vKipcbiAqIFBhcnNlIGEgZGVubyBgbWluaW11bURlcGVuZGVuY3lBZ2VgIFwiYWdlXCIgdmFsdWUgaW50byBob3Vycy5cbiAqXG4gKiBBY2NlcHRzIHRoZSBkdXJhdGlvbi1zdHlsZSBmb3JtcyBkZW5vIHVuZGVyc3RhbmRzOiBpbnRlZ2VyIG1pbnV0ZXNcbiAqIChgXCIxNDQwXCJgIG9yIHRoZSBudW1iZXIgYDE0NDBgKSBhbmQgSVNPLTg2MDEgZHVyYXRpb25zIGJ1aWx0IGZyb21cbiAqIHdlZWtzL2RheXMvaG91cnMvbWludXRlcy9zZWNvbmRzIChgXCJQMURcImAsIGBcIlBUMjRIXCJgLCBgXCJQVDMwTVwiYCkuIFJldHVybnNcbiAqIGBudWxsYCBmb3IgdW5yZWNvZ25pc2VkIGlucHV0IGFuZCBmb3IgYWJzb2x1dGUgUkZDMzMzOSBjdXRvZmYgZGF0ZXMsXG4gKiB3aGljaCBhcmUgcG9pbnRzIGluIHRpbWUgcmF0aGVyIHRoYW4gZml4ZWQgZHVyYXRpb25zLiBDYWxlbmRhciBkdXJhdGlvbnNcbiAqIHdpdGggeWVhcnMgb3IgbW9udGhzIChgXCJQMVlcImAsIGBcIlAxTVwiYCkgYXJlIGFsc28gcmVqZWN0ZWQgYmVjYXVzZSB0aGV5IGRvXG4gKiBub3QgbWFwIHRvIGEgZml4ZWQgbnVtYmVyIG9mIGhvdXJzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VNaW5pbXVtRGVwZW5kZW5jeUFnZUhvdXJzKFxuICB2YWx1ZTogc3RyaW5nIHwgbnVtYmVyIHwgdW5kZWZpbmVkLFxuKTogbnVtYmVyIHwgbnVsbCB7XG4gIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gbnVsbDtcbiAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gXCJudW1iZXJcIikge1xuICAgIHJldHVybiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpICYmIHZhbHVlID49IDAgPyB2YWx1ZSAvIDYwIDogbnVsbDtcbiAgfVxuICBjb25zdCB0cmltbWVkID0gdmFsdWUudHJpbSgpO1xuICBpZiAodHJpbW1lZCA9PT0gXCJcIikgcmV0dXJuIG51bGw7XG4gIGlmICh0cmltbWVkID09PSBcIjBcIikgcmV0dXJuIDA7XG4gIGlmICgvXlxcZCskLy50ZXN0KHRyaW1tZWQpKSByZXR1cm4gTnVtYmVyKHRyaW1tZWQpIC8gNjA7IC8vIG1pbnV0ZXNcblxuICBpZiAodHJpbW1lZCA9PT0gXCJQXCIgfHwgdHJpbW1lZCA9PT0gXCJQVFwiKSByZXR1cm4gbnVsbDsgLy8gZW1wdHkgZHVyYXRpb25zXG4gIGNvbnN0IG1hdGNoID0gSVNPXzg2MDFfRFVSQVRJT04uZXhlYyh0cmltbWVkKTtcbiAgaWYgKCFtYXRjaCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IFssIHcsIGQsIGgsIG0sIHNdID0gbWF0Y2g7XG4gIGNvbnN0IHdlZWtzID0gdyA/IE51bWJlcih3KSA6IDA7XG4gIGNvbnN0IGRheXMgPSBkID8gTnVtYmVyKGQpIDogMDtcbiAgY29uc3QgaG91cnMgPSBoID8gTnVtYmVyKGgpIDogMDtcbiAgY29uc3QgbWludXRlcyA9IG0gPyBOdW1iZXIobSkgOiAwO1xuICBjb25zdCBzZWNvbmRzID0gcyA/IE51bWJlcihzKSA6IDA7XG4gIHJldHVybiB3ZWVrcyAqIDE2OCArIGRheXMgKiAyNCArIGhvdXJzICsgbWludXRlcyAvIDYwICsgc2Vjb25kcyAvIDM2MDA7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FrQ0MsR0FFRCwwRUFBMEUsR0FDMUUsT0FBTyxNQUFNLG1DQUFtQyxNQUFNO0FBRXRELGdEQUFnRCxHQUNoRCxPQUFPLE1BQU0seUNBQXlDLEdBQUc7QUFFekQ7Ozs7Ozs7Q0FPQyxHQUNELE9BQU8sTUFBTSwwQkFBMEI7RUFDckM7RUFDQTtDQUNELENBQVU7QUFVWCw4REFBOEQsR0FDOUQsT0FBTyxTQUFTO0VBQ2QsT0FBTztJQUNMLEtBQUs7SUFDTCxTQUFTO1NBQUk7S0FBd0I7RUFDdkM7QUFDRjtBQUVBLHlFQUF5RSxHQUN6RSxPQUFPLFNBQVMsb0JBQW9CLEtBQWE7RUFDL0MsT0FBTyxtQkFBbUIsSUFBSSxDQUFDO0FBQ2pDO0FBRUEsTUFBTSxvQkFDSjtBQUVGOzs7Ozs7Ozs7O0NBVUMsR0FDRCxPQUFPLFNBQVMsK0JBQ2QsS0FBa0M7RUFFbEMsSUFBSSxVQUFVLFdBQVcsT0FBTztFQUNoQyxJQUFJLE9BQU8sVUFBVSxVQUFVO0lBQzdCLE9BQU8sT0FBTyxRQUFRLENBQUMsVUFBVSxTQUFTLElBQUksUUFBUSxLQUFLO0VBQzdEO0VBQ0EsTUFBTSxVQUFVLE1BQU0sSUFBSTtFQUMxQixJQUFJLFlBQVksSUFBSSxPQUFPO0VBQzNCLElBQUksWUFBWSxLQUFLLE9BQU87RUFDNUIsSUFBSSxRQUFRLElBQUksQ0FBQyxVQUFVLE9BQU8sT0FBTyxXQUFXLElBQUksVUFBVTtFQUVsRSxJQUFJLFlBQVksT0FBTyxZQUFZLE1BQU0sT0FBTyxNQUFNLGtCQUFrQjtFQUN4RSxNQUFNLFFBQVEsa0JBQWtCLElBQUksQ0FBQztFQUNyQyxJQUFJLENBQUMsT0FBTyxPQUFPO0VBQ25CLE1BQU0sR0FBRyxHQUFHLEdBQUcsR0FBRyxHQUFHLEVBQUUsR0FBRztFQUMxQixNQUFNLFFBQVEsSUFBSSxPQUFPLEtBQUs7RUFDOUIsTUFBTSxPQUFPLElBQUksT0FBTyxLQUFLO0VBQzdCLE1BQU0sUUFBUSxJQUFJLE9BQU8sS0FBSztFQUM5QixNQUFNLFVBQVUsSUFBSSxPQUFPLEtBQUs7RUFDaEMsTUFBTSxVQUFVLElBQUksT0FBTyxLQUFLO0VBQ2hDLE9BQU8sUUFBUSxNQUFNLE9BQU8sS0FBSyxRQUFRLFVBQVUsS0FBSyxVQUFVO0FBQ3BFIn0=
// denoCacheMetadata=4844756239959786899,9878282545370496365