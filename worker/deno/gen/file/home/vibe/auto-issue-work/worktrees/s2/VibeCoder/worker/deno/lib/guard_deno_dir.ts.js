/**
 * Which Deno cache the `gh`/`git` guard child may read code back from
 * (Issue #1448).
 *
 * Issue #1444 moved the guard ENTRY POINTS to the read-only checkout, so the
 * module the wrapper names cannot be rewritten by the uid the coding agent
 * runs as. The child does not stand alone, though: `deno run` persists what
 * it derives from those modules — the transpiled emit (`gen/`), the V8 code
 * cache, the dependency-analysis tables — in `DENO_DIR`, and reads it back on
 * the next call. In the container that directory was the durable cache on
 * the work volume, `${HOME}/auto-issue-work/.deno-cache`, and the probe this
 * module's tests document found it owned by `vibe` — the same uid the agent
 * runs as — with the owner write bit on every entry. And because the wrapper
 * inherited the caller's environment, the agent could also simply point
 * `DENO_DIR` at a cache it had prepared. Either way: a control the
 * constrained party can feed, re-read on every call.
 *
 * The fix has two halves, both in the wrapper the worker renders:
 *
 *   1. `DENO_DIR` is **pinned**, like `GH_CONFIG_DIR` (Issue #3866) — the
 *      agent's own environment cannot redirect the guard's cache.
 *   2. It is pinned to a directory the agent's uid **cannot write**: the
 *      image's baked Deno seed (`VIBE_DENO_SEED_DIR`, `/opt/deno-seed`), which
 *      is root-owned and `a+rX` at build time. Deno runs with a read-only
 *      cache exactly as it runs with an empty one — it transpiles in memory
 *      and persists nothing — so nothing the child executes was ever written
 *      by anyone but the image build. Measured in a live container: 220 ms
 *      per guard call against ~15 ms warm; the price of a boundary.
 *
 * Under `--no-config` the guard's graph is local files only (257 modules,
 * zero remote — the 21 JSR modules `deno info` reports WITH the worker's
 * config come from its import map, which the child never loads), so no
 * registry fetch is lost by having no writable cache, and `--no-lock` costs
 * nothing: there is nothing remote for a lockfile to pin.
 *
 * ## Why it falls back rather than insisting
 *
 * The seed exists only in the image. On a developer host or in the test
 * suite the resolver falls back to a directory inside the wrapper's own
 * per-run directory — still pinned, so the agent's environment cannot choose
 * it, but writable by the same uid. That is the pre-#1448 state of affairs,
 * and it is reported as such when the launcher's checkout marker says this
 * IS a container and the seed is nevertheless missing or writable.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */ import { BASE_DIR_ENV } from "./guard_module_path.ts";
/** The image's read-only Deno seed (`container/Containerfile`). */ export const DENO_SEED_DIR_ENV = "VIBE_DENO_SEED_DIR";
/** Where the image bakes the seed when the variable is unset. */ export const DEFAULT_DENO_SEED_DIR = "/opt/deno-seed";
const processEnv = (name)=>{
  try {
    return Deno.env.get(name);
  } catch  {
    return undefined;
  }
};
/**
 * Real probe: a directory this process may write is `writable`.
 *
 * Measured, not inferred: it tries to create (and immediately remove) a
 * uniquely named file in the directory. Mode bits would misjudge root, an
 * ACL, or a read-only mount, and the Node-compat `accessSync(W_OK)` was
 * found to report a freshly created, plainly writable directory as
 * unwritable under Deno — a probe that errs that way would bless a writable
 * cache as the boundary. A failed create leaves nothing behind; a
 * successful one is removed before returning.
 */ export const realGuardDenoDirProbe = (path)=>{
  try {
    if (!Deno.statSync(path).isDirectory) return "absent";
  } catch  {
    return "absent";
  }
  const probe = `${path}/.vibe-guard-cache-probe-${Deno.pid}-${crypto.randomUUID()}`;
  try {
    Deno.openSync(probe, {
      createNew: true,
      write: true
    }).close();
  } catch  {
    return "read-only";
  }
  try {
    Deno.removeSync(probe);
  } catch  {
  // Created but not removable: still, demonstrably, writable.
  }
  return "writable";
};
/**
 * Choose the guard child's `DENO_DIR`.
 *
 * @param perRunFallback - Directory inside the wrapper's own per-run
 *   directory, used when no read-only seed is available.
 * @param env - Environment lookup (injectable for tests).
 * @param probe - Directory probe (injectable for tests).
 * @returns The first read-only seed candidate, else the per-run fallback.
 */ export function resolveGuardDenoDir(perRunFallback, env = processEnv, probe = realGuardDenoDirProbe) {
  const fromEnv = env(DENO_SEED_DIR_ENV)?.trim();
  const candidates = [
    ...fromEnv ? [
      [
        fromEnv,
        "seed-env"
      ]
    ] : [],
    [
      DEFAULT_DENO_SEED_DIR,
      "seed-default"
    ]
  ];
  for (const [path, source] of candidates){
    if (probe(path) === "read-only") return {
      path,
      readOnly: true,
      source
    };
  }
  return {
    path: perRunFallback,
    readOnly: false,
    source: "per-run"
  };
}
/**
 * Whether a writable guard cache is worth a `[SECURITY]` line: only where a
 * read-only seed was expected — inside the container, which the launcher
 * marks by exporting the checkout root (`VIBE_BASE_DIR`). A developer host
 * has no seed and no containment to lose.
 */ export function expectsReadOnlyGuardCache(env = processEnv) {
  return (env(BASE_DIR_ENV)?.trim() ?? "").length > 0;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9ndWFyZF9kZW5vX2Rpci50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFdoaWNoIERlbm8gY2FjaGUgdGhlIGBnaGAvYGdpdGAgZ3VhcmQgY2hpbGQgbWF5IHJlYWQgY29kZSBiYWNrIGZyb21cbiAqIChJc3N1ZSAjMTQ0OCkuXG4gKlxuICogSXNzdWUgIzE0NDQgbW92ZWQgdGhlIGd1YXJkIEVOVFJZIFBPSU5UUyB0byB0aGUgcmVhZC1vbmx5IGNoZWNrb3V0LCBzbyB0aGVcbiAqIG1vZHVsZSB0aGUgd3JhcHBlciBuYW1lcyBjYW5ub3QgYmUgcmV3cml0dGVuIGJ5IHRoZSB1aWQgdGhlIGNvZGluZyBhZ2VudFxuICogcnVucyBhcy4gVGhlIGNoaWxkIGRvZXMgbm90IHN0YW5kIGFsb25lLCB0aG91Z2g6IGBkZW5vIHJ1bmAgcGVyc2lzdHMgd2hhdFxuICogaXQgZGVyaXZlcyBmcm9tIHRob3NlIG1vZHVsZXMg4oCUIHRoZSB0cmFuc3BpbGVkIGVtaXQgKGBnZW4vYCksIHRoZSBWOCBjb2RlXG4gKiBjYWNoZSwgdGhlIGRlcGVuZGVuY3ktYW5hbHlzaXMgdGFibGVzIOKAlCBpbiBgREVOT19ESVJgLCBhbmQgcmVhZHMgaXQgYmFjayBvblxuICogdGhlIG5leHQgY2FsbC4gSW4gdGhlIGNvbnRhaW5lciB0aGF0IGRpcmVjdG9yeSB3YXMgdGhlIGR1cmFibGUgY2FjaGUgb25cbiAqIHRoZSB3b3JrIHZvbHVtZSwgYCR7SE9NRX0vYXV0by1pc3N1ZS13b3JrLy5kZW5vLWNhY2hlYCwgYW5kIHRoZSBwcm9iZSB0aGlzXG4gKiBtb2R1bGUncyB0ZXN0cyBkb2N1bWVudCBmb3VuZCBpdCBvd25lZCBieSBgdmliZWAg4oCUIHRoZSBzYW1lIHVpZCB0aGUgYWdlbnRcbiAqIHJ1bnMgYXMg4oCUIHdpdGggdGhlIG93bmVyIHdyaXRlIGJpdCBvbiBldmVyeSBlbnRyeS4gQW5kIGJlY2F1c2UgdGhlIHdyYXBwZXJcbiAqIGluaGVyaXRlZCB0aGUgY2FsbGVyJ3MgZW52aXJvbm1lbnQsIHRoZSBhZ2VudCBjb3VsZCBhbHNvIHNpbXBseSBwb2ludFxuICogYERFTk9fRElSYCBhdCBhIGNhY2hlIGl0IGhhZCBwcmVwYXJlZC4gRWl0aGVyIHdheTogYSBjb250cm9sIHRoZVxuICogY29uc3RyYWluZWQgcGFydHkgY2FuIGZlZWQsIHJlLXJlYWQgb24gZXZlcnkgY2FsbC5cbiAqXG4gKiBUaGUgZml4IGhhcyB0d28gaGFsdmVzLCBib3RoIGluIHRoZSB3cmFwcGVyIHRoZSB3b3JrZXIgcmVuZGVyczpcbiAqXG4gKiAgIDEuIGBERU5PX0RJUmAgaXMgKipwaW5uZWQqKiwgbGlrZSBgR0hfQ09ORklHX0RJUmAgKElzc3VlICMzODY2KSDigJQgdGhlXG4gKiAgICAgIGFnZW50J3Mgb3duIGVudmlyb25tZW50IGNhbm5vdCByZWRpcmVjdCB0aGUgZ3VhcmQncyBjYWNoZS5cbiAqICAgMi4gSXQgaXMgcGlubmVkIHRvIGEgZGlyZWN0b3J5IHRoZSBhZ2VudCdzIHVpZCAqKmNhbm5vdCB3cml0ZSoqOiB0aGVcbiAqICAgICAgaW1hZ2UncyBiYWtlZCBEZW5vIHNlZWQgKGBWSUJFX0RFTk9fU0VFRF9ESVJgLCBgL29wdC9kZW5vLXNlZWRgKSwgd2hpY2hcbiAqICAgICAgaXMgcm9vdC1vd25lZCBhbmQgYGErclhgIGF0IGJ1aWxkIHRpbWUuIERlbm8gcnVucyB3aXRoIGEgcmVhZC1vbmx5XG4gKiAgICAgIGNhY2hlIGV4YWN0bHkgYXMgaXQgcnVucyB3aXRoIGFuIGVtcHR5IG9uZSDigJQgaXQgdHJhbnNwaWxlcyBpbiBtZW1vcnlcbiAqICAgICAgYW5kIHBlcnNpc3RzIG5vdGhpbmcg4oCUIHNvIG5vdGhpbmcgdGhlIGNoaWxkIGV4ZWN1dGVzIHdhcyBldmVyIHdyaXR0ZW5cbiAqICAgICAgYnkgYW55b25lIGJ1dCB0aGUgaW1hZ2UgYnVpbGQuIE1lYXN1cmVkIGluIGEgbGl2ZSBjb250YWluZXI6IDIyMCBtc1xuICogICAgICBwZXIgZ3VhcmQgY2FsbCBhZ2FpbnN0IH4xNSBtcyB3YXJtOyB0aGUgcHJpY2Ugb2YgYSBib3VuZGFyeS5cbiAqXG4gKiBVbmRlciBgLS1uby1jb25maWdgIHRoZSBndWFyZCdzIGdyYXBoIGlzIGxvY2FsIGZpbGVzIG9ubHkgKDI1NyBtb2R1bGVzLFxuICogemVybyByZW1vdGUg4oCUIHRoZSAyMSBKU1IgbW9kdWxlcyBgZGVubyBpbmZvYCByZXBvcnRzIFdJVEggdGhlIHdvcmtlcidzXG4gKiBjb25maWcgY29tZSBmcm9tIGl0cyBpbXBvcnQgbWFwLCB3aGljaCB0aGUgY2hpbGQgbmV2ZXIgbG9hZHMpLCBzbyBub1xuICogcmVnaXN0cnkgZmV0Y2ggaXMgbG9zdCBieSBoYXZpbmcgbm8gd3JpdGFibGUgY2FjaGUsIGFuZCBgLS1uby1sb2NrYCBjb3N0c1xuICogbm90aGluZzogdGhlcmUgaXMgbm90aGluZyByZW1vdGUgZm9yIGEgbG9ja2ZpbGUgdG8gcGluLlxuICpcbiAqICMjIFdoeSBpdCBmYWxscyBiYWNrIHJhdGhlciB0aGFuIGluc2lzdGluZ1xuICpcbiAqIFRoZSBzZWVkIGV4aXN0cyBvbmx5IGluIHRoZSBpbWFnZS4gT24gYSBkZXZlbG9wZXIgaG9zdCBvciBpbiB0aGUgdGVzdFxuICogc3VpdGUgdGhlIHJlc29sdmVyIGZhbGxzIGJhY2sgdG8gYSBkaXJlY3RvcnkgaW5zaWRlIHRoZSB3cmFwcGVyJ3Mgb3duXG4gKiBwZXItcnVuIGRpcmVjdG9yeSDigJQgc3RpbGwgcGlubmVkLCBzbyB0aGUgYWdlbnQncyBlbnZpcm9ubWVudCBjYW5ub3QgY2hvb3NlXG4gKiBpdCwgYnV0IHdyaXRhYmxlIGJ5IHRoZSBzYW1lIHVpZC4gVGhhdCBpcyB0aGUgcHJlLSMxNDQ4IHN0YXRlIG9mIGFmZmFpcnMsXG4gKiBhbmQgaXQgaXMgcmVwb3J0ZWQgYXMgc3VjaCB3aGVuIHRoZSBsYXVuY2hlcidzIGNoZWNrb3V0IG1hcmtlciBzYXlzIHRoaXNcbiAqIElTIGEgY29udGFpbmVyIGFuZCB0aGUgc2VlZCBpcyBuZXZlcnRoZWxlc3MgbWlzc2luZyBvciB3cml0YWJsZS5cbiAqXG4gKiBBdXN0cmFsaWFuIEVuZ2xpc2ggc3BlbGxpbmcgdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbikuXG4gKi9cblxuaW1wb3J0IHsgQkFTRV9ESVJfRU5WLCB0eXBlIEd1YXJkRW52TG9va3VwIH0gZnJvbSBcIi4vZ3VhcmRfbW9kdWxlX3BhdGgudHNcIjtcblxuLyoqIFRoZSBpbWFnZSdzIHJlYWQtb25seSBEZW5vIHNlZWQgKGBjb250YWluZXIvQ29udGFpbmVyZmlsZWApLiAqL1xuZXhwb3J0IGNvbnN0IERFTk9fU0VFRF9ESVJfRU5WID0gXCJWSUJFX0RFTk9fU0VFRF9ESVJcIjtcblxuLyoqIFdoZXJlIHRoZSBpbWFnZSBiYWtlcyB0aGUgc2VlZCB3aGVuIHRoZSB2YXJpYWJsZSBpcyB1bnNldC4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0RFTk9fU0VFRF9ESVIgPSBcIi9vcHQvZGVuby1zZWVkXCI7XG5cbi8qKiBXaGF0IGEgY2FuZGlkYXRlIGNhY2hlIGRpcmVjdG9yeSBpcywgZnJvbSB0aGlzIHVpZCdzIHBvaW50IG9mIHZpZXcuICovXG5leHBvcnQgdHlwZSBHdWFyZERlbm9EaXJTdGF0ZSA9IFwicmVhZC1vbmx5XCIgfCBcIndyaXRhYmxlXCIgfCBcImFic2VudFwiO1xuXG4vKiogRGlyZWN0b3J5IHByb2JlIHNlYW0sIHNvIHRoZSByZXNvbHZlciBpcyB0ZXN0YWJsZSB3aXRob3V0IGEgZmlsZXN5c3RlbS4gKi9cbmV4cG9ydCB0eXBlIEd1YXJkRGVub0RpclByb2JlID0gKHBhdGg6IHN0cmluZykgPT4gR3VhcmREZW5vRGlyU3RhdGU7XG5cbi8qKiBUaGUgY2FjaGUgdGhlIHdyYXBwZXIgcGlucywgYW5kIGhvdyBpdCB3YXMgY2hvc2VuLiAqL1xuZXhwb3J0IGludGVyZmFjZSBHdWFyZERlbm9EaXIge1xuICAvKiogQWJzb2x1dGUgcGF0aCB0aGUgd3JhcHBlciBleHBvcnRzIGFzIGBERU5PX0RJUmAuICovXG4gIHBhdGg6IHN0cmluZztcbiAgLyoqIFRydWUgd2hlbiB0aGlzIHVpZCBjYW5ub3Qgd3JpdGUgaXQg4oCUIHRoZSBib3VuZGFyeSB0aGUgaXNzdWUgYXNrcyBmb3IuICovXG4gIHJlYWRPbmx5OiBib29sZWFuO1xuICAvKiogV2hpY2ggY2FuZGlkYXRlIHdvbi4gKi9cbiAgc291cmNlOiBcInNlZWQtZW52XCIgfCBcInNlZWQtZGVmYXVsdFwiIHwgXCJwZXItcnVuXCI7XG59XG5cbmNvbnN0IHByb2Nlc3NFbnY6IEd1YXJkRW52TG9va3VwID0gKG5hbWUpID0+IHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gRGVuby5lbnYuZ2V0KG5hbWUpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG59O1xuXG4vKipcbiAqIFJlYWwgcHJvYmU6IGEgZGlyZWN0b3J5IHRoaXMgcHJvY2VzcyBtYXkgd3JpdGUgaXMgYHdyaXRhYmxlYC5cbiAqXG4gKiBNZWFzdXJlZCwgbm90IGluZmVycmVkOiBpdCB0cmllcyB0byBjcmVhdGUgKGFuZCBpbW1lZGlhdGVseSByZW1vdmUpIGFcbiAqIHVuaXF1ZWx5IG5hbWVkIGZpbGUgaW4gdGhlIGRpcmVjdG9yeS4gTW9kZSBiaXRzIHdvdWxkIG1pc2p1ZGdlIHJvb3QsIGFuXG4gKiBBQ0wsIG9yIGEgcmVhZC1vbmx5IG1vdW50LCBhbmQgdGhlIE5vZGUtY29tcGF0IGBhY2Nlc3NTeW5jKFdfT0spYCB3YXNcbiAqIGZvdW5kIHRvIHJlcG9ydCBhIGZyZXNobHkgY3JlYXRlZCwgcGxhaW5seSB3cml0YWJsZSBkaXJlY3RvcnkgYXNcbiAqIHVud3JpdGFibGUgdW5kZXIgRGVubyDigJQgYSBwcm9iZSB0aGF0IGVycnMgdGhhdCB3YXkgd291bGQgYmxlc3MgYSB3cml0YWJsZVxuICogY2FjaGUgYXMgdGhlIGJvdW5kYXJ5LiBBIGZhaWxlZCBjcmVhdGUgbGVhdmVzIG5vdGhpbmcgYmVoaW5kOyBhXG4gKiBzdWNjZXNzZnVsIG9uZSBpcyByZW1vdmVkIGJlZm9yZSByZXR1cm5pbmcuXG4gKi9cbmV4cG9ydCBjb25zdCByZWFsR3VhcmREZW5vRGlyUHJvYmU6IEd1YXJkRGVub0RpclByb2JlID0gKHBhdGgpID0+IHtcbiAgdHJ5IHtcbiAgICBpZiAoIURlbm8uc3RhdFN5bmMocGF0aCkuaXNEaXJlY3RvcnkpIHJldHVybiBcImFic2VudFwiO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gXCJhYnNlbnRcIjtcbiAgfVxuICBjb25zdCBwcm9iZSA9XG4gICAgYCR7cGF0aH0vLnZpYmUtZ3VhcmQtY2FjaGUtcHJvYmUtJHtEZW5vLnBpZH0tJHtjcnlwdG8ucmFuZG9tVVVJRCgpfWA7XG4gIHRyeSB7XG4gICAgRGVuby5vcGVuU3luYyhwcm9iZSwgeyBjcmVhdGVOZXc6IHRydWUsIHdyaXRlOiB0cnVlIH0pLmNsb3NlKCk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBcInJlYWQtb25seVwiO1xuICB9XG4gIHRyeSB7XG4gICAgRGVuby5yZW1vdmVTeW5jKHByb2JlKTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gQ3JlYXRlZCBidXQgbm90IHJlbW92YWJsZTogc3RpbGwsIGRlbW9uc3RyYWJseSwgd3JpdGFibGUuXG4gIH1cbiAgcmV0dXJuIFwid3JpdGFibGVcIjtcbn07XG5cbi8qKlxuICogQ2hvb3NlIHRoZSBndWFyZCBjaGlsZCdzIGBERU5PX0RJUmAuXG4gKlxuICogQHBhcmFtIHBlclJ1bkZhbGxiYWNrIC0gRGlyZWN0b3J5IGluc2lkZSB0aGUgd3JhcHBlcidzIG93biBwZXItcnVuXG4gKiAgIGRpcmVjdG9yeSwgdXNlZCB3aGVuIG5vIHJlYWQtb25seSBzZWVkIGlzIGF2YWlsYWJsZS5cbiAqIEBwYXJhbSBlbnYgLSBFbnZpcm9ubWVudCBsb29rdXAgKGluamVjdGFibGUgZm9yIHRlc3RzKS5cbiAqIEBwYXJhbSBwcm9iZSAtIERpcmVjdG9yeSBwcm9iZSAoaW5qZWN0YWJsZSBmb3IgdGVzdHMpLlxuICogQHJldHVybnMgVGhlIGZpcnN0IHJlYWQtb25seSBzZWVkIGNhbmRpZGF0ZSwgZWxzZSB0aGUgcGVyLXJ1biBmYWxsYmFjay5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVHdWFyZERlbm9EaXIoXG4gIHBlclJ1bkZhbGxiYWNrOiBzdHJpbmcsXG4gIGVudjogR3VhcmRFbnZMb29rdXAgPSBwcm9jZXNzRW52LFxuICBwcm9iZTogR3VhcmREZW5vRGlyUHJvYmUgPSByZWFsR3VhcmREZW5vRGlyUHJvYmUsXG4pOiBHdWFyZERlbm9EaXIge1xuICBjb25zdCBmcm9tRW52ID0gZW52KERFTk9fU0VFRF9ESVJfRU5WKT8udHJpbSgpO1xuICBjb25zdCBjYW5kaWRhdGVzOiBBcnJheTxbc3RyaW5nLCBHdWFyZERlbm9EaXJbXCJzb3VyY2VcIl1dPiA9IFtcbiAgICAuLi4oZnJvbUVudiA/IFtbZnJvbUVudiwgXCJzZWVkLWVudlwiXSBhcyBbc3RyaW5nLCBcInNlZWQtZW52XCJdXSA6IFtdKSxcbiAgICBbREVGQVVMVF9ERU5PX1NFRURfRElSLCBcInNlZWQtZGVmYXVsdFwiXSxcbiAgXTtcbiAgZm9yIChjb25zdCBbcGF0aCwgc291cmNlXSBvZiBjYW5kaWRhdGVzKSB7XG4gICAgaWYgKHByb2JlKHBhdGgpID09PSBcInJlYWQtb25seVwiKSByZXR1cm4geyBwYXRoLCByZWFkT25seTogdHJ1ZSwgc291cmNlIH07XG4gIH1cbiAgcmV0dXJuIHsgcGF0aDogcGVyUnVuRmFsbGJhY2ssIHJlYWRPbmx5OiBmYWxzZSwgc291cmNlOiBcInBlci1ydW5cIiB9O1xufVxuXG4vKipcbiAqIFdoZXRoZXIgYSB3cml0YWJsZSBndWFyZCBjYWNoZSBpcyB3b3J0aCBhIGBbU0VDVVJJVFldYCBsaW5lOiBvbmx5IHdoZXJlIGFcbiAqIHJlYWQtb25seSBzZWVkIHdhcyBleHBlY3RlZCDigJQgaW5zaWRlIHRoZSBjb250YWluZXIsIHdoaWNoIHRoZSBsYXVuY2hlclxuICogbWFya3MgYnkgZXhwb3J0aW5nIHRoZSBjaGVja291dCByb290IChgVklCRV9CQVNFX0RJUmApLiBBIGRldmVsb3BlciBob3N0XG4gKiBoYXMgbm8gc2VlZCBhbmQgbm8gY29udGFpbm1lbnQgdG8gbG9zZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGV4cGVjdHNSZWFkT25seUd1YXJkQ2FjaGUoXG4gIGVudjogR3VhcmRFbnZMb29rdXAgPSBwcm9jZXNzRW52LFxuKTogYm9vbGVhbiB7XG4gIHJldHVybiAoZW52KEJBU0VfRElSX0VOVik/LnRyaW0oKSA/PyBcIlwiKS5sZW5ndGggPiAwO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0E2Q0MsR0FFRCxTQUFTLFlBQVksUUFBNkIseUJBQXlCO0FBRTNFLGlFQUFpRSxHQUNqRSxPQUFPLE1BQU0sb0JBQW9CLHFCQUFxQjtBQUV0RCwrREFBK0QsR0FDL0QsT0FBTyxNQUFNLHdCQUF3QixpQkFBaUI7QUFrQnRELE1BQU0sYUFBNkIsQ0FBQztFQUNsQyxJQUFJO0lBQ0YsT0FBTyxLQUFLLEdBQUcsQ0FBQyxHQUFHLENBQUM7RUFDdEIsRUFBRSxPQUFNO0lBQ04sT0FBTztFQUNUO0FBQ0Y7QUFFQTs7Ozs7Ozs7OztDQVVDLEdBQ0QsT0FBTyxNQUFNLHdCQUEyQyxDQUFDO0VBQ3ZELElBQUk7SUFDRixJQUFJLENBQUMsS0FBSyxRQUFRLENBQUMsTUFBTSxXQUFXLEVBQUUsT0FBTztFQUMvQyxFQUFFLE9BQU07SUFDTixPQUFPO0VBQ1Q7RUFDQSxNQUFNLFFBQ0osR0FBRyxLQUFLLHlCQUF5QixFQUFFLEtBQUssR0FBRyxDQUFDLENBQUMsRUFBRSxPQUFPLFVBQVUsSUFBSTtFQUN0RSxJQUFJO0lBQ0YsS0FBSyxRQUFRLENBQUMsT0FBTztNQUFFLFdBQVc7TUFBTSxPQUFPO0lBQUssR0FBRyxLQUFLO0VBQzlELEVBQUUsT0FBTTtJQUNOLE9BQU87RUFDVDtFQUNBLElBQUk7SUFDRixLQUFLLFVBQVUsQ0FBQztFQUNsQixFQUFFLE9BQU07RUFDTiw0REFBNEQ7RUFDOUQ7RUFDQSxPQUFPO0FBQ1QsRUFBRTtBQUVGOzs7Ozs7OztDQVFDLEdBQ0QsT0FBTyxTQUFTLG9CQUNkLGNBQXNCLEVBQ3RCLE1BQXNCLFVBQVUsRUFDaEMsUUFBMkIscUJBQXFCO0VBRWhELE1BQU0sVUFBVSxJQUFJLG9CQUFvQjtFQUN4QyxNQUFNLGFBQXNEO09BQ3RELFVBQVU7TUFBQztRQUFDO1FBQVM7T0FBVztLQUF5QixHQUFHLEVBQUU7SUFDbEU7TUFBQztNQUF1QjtLQUFlO0dBQ3hDO0VBQ0QsS0FBSyxNQUFNLENBQUMsTUFBTSxPQUFPLElBQUksV0FBWTtJQUN2QyxJQUFJLE1BQU0sVUFBVSxhQUFhLE9BQU87TUFBRTtNQUFNLFVBQVU7TUFBTTtJQUFPO0VBQ3pFO0VBQ0EsT0FBTztJQUFFLE1BQU07SUFBZ0IsVUFBVTtJQUFPLFFBQVE7RUFBVTtBQUNwRTtBQUVBOzs7OztDQUtDLEdBQ0QsT0FBTyxTQUFTLDBCQUNkLE1BQXNCLFVBQVU7RUFFaEMsT0FBTyxDQUFDLElBQUksZUFBZSxVQUFVLEVBQUUsRUFBRSxNQUFNLEdBQUc7QUFDcEQifQ==
// denoCacheMetadata=12007112870868872984,5319705634752942883