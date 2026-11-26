/**
 * The Deno cache a test's cleared-environment `deno` child should share.
 *
 * A child spawned with `clearEnv: true` that drops `DENO_DIR` and
 * `XDG_CACHE_HOME` falls back to `~/.cache/deno` on Linux, which the container
 * image leaves empty: the image seeds
 * the durable cache `DENO_DIR` names (container/deno-seed, Issue #4392). Any
 * run under the worker config then resolves the lock's whole npm snapshot from
 * the registry, which fails where npm is unreachable ("Failed caching npm
 * package 'mdurl@1.0.1'", GRQ-23 2026-11-19). Spread this into the child's
 * `env` so it reads the cache the run already has.
 * Preserve `XDG_CACHE_HOME` too: on Linux it selects the default cache when
 * `DENO_DIR` is unset, instead of the cache under `HOME` (Issue #5602).
 */
export function denoCacheEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["DENO_DIR", "XDG_CACHE_HOME"]) {
    const value = Deno.env.get(name);
    if (value) env[name] = value;
  }
  return env;
}
