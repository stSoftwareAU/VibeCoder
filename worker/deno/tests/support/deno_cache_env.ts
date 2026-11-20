/**
 * The Deno cache a test's cleared-environment `deno` child should share.
 *
 * A child spawned with `clearEnv: true` and no `DENO_DIR` falls back to
 * `~/.cache/deno`, which the container image leaves empty: the image seeds
 * the durable cache `DENO_DIR` names (container/deno-seed, Issue #4392). Any
 * run under the worker config then resolves the lock's whole npm snapshot from
 * the registry, which fails where npm is unreachable ("Failed caching npm
 * package 'mdurl@1.0.1'", GRQ-23 2026-11-19). Spread this into the child's
 * `env` so it reads the cache the run already has.
 */
export function denoCacheEnv(): Record<string, string> {
  const dir = Deno.env.get("DENO_DIR");
  return dir ? { DENO_DIR: dir } : {};
}
