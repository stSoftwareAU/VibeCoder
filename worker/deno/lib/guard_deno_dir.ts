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
 */

import { BASE_DIR_ENV, type GuardEnvLookup } from "./guard_module_path.ts";

/** The image's read-only Deno seed (`container/Containerfile`). */
export const DENO_SEED_DIR_ENV = "VIBE_DENO_SEED_DIR";

/** Where the image bakes the seed when the variable is unset. */
export const DEFAULT_DENO_SEED_DIR = "/opt/deno-seed";

/** What a candidate cache directory is, from this uid's point of view. */
export type GuardDenoDirState = "read-only" | "writable" | "absent";

/** Directory probe seam, so the resolver is testable without a filesystem. */
export type GuardDenoDirProbe = (path: string) => GuardDenoDirState;

/** The cache the wrapper pins, and how it was chosen. */
export interface GuardDenoDir {
  /** Absolute path the wrapper exports as `DENO_DIR`. */
  path: string;
  /** True when this uid cannot write it — the boundary the issue asks for. */
  readOnly: boolean;
  /** Which candidate won. */
  source: "seed-env" | "seed-default" | "per-run";
}

const processEnv: GuardEnvLookup = (name) => {
  try {
    return Deno.env.get(name);
  } catch {
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
 */
export const realGuardDenoDirProbe: GuardDenoDirProbe = (path) => {
  try {
    if (!Deno.statSync(path).isDirectory) return "absent";
  } catch {
    return "absent";
  }
  const probe =
    `${path}/.vibe-guard-cache-probe-${Deno.pid}-${crypto.randomUUID()}`;
  try {
    Deno.openSync(probe, { createNew: true, write: true }).close();
  } catch {
    return "read-only";
  }
  try {
    Deno.removeSync(probe);
  } catch {
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
 */
export function resolveGuardDenoDir(
  perRunFallback: string,
  env: GuardEnvLookup = processEnv,
  probe: GuardDenoDirProbe = realGuardDenoDirProbe,
): GuardDenoDir {
  const fromEnv = env(DENO_SEED_DIR_ENV)?.trim();
  const candidates: Array<[string, GuardDenoDir["source"]]> = [
    ...(fromEnv ? [[fromEnv, "seed-env"] as [string, "seed-env"]] : []),
    [DEFAULT_DENO_SEED_DIR, "seed-default"],
  ];
  for (const [path, source] of candidates) {
    if (probe(path) === "read-only") return { path, readOnly: true, source };
  }
  return { path: perRunFallback, readOnly: false, source: "per-run" };
}

/**
 * Whether a writable guard cache is worth a `[SECURITY]` line: only where a
 * read-only seed was expected — inside the container, which the launcher
 * marks by exporting the checkout root (`VIBE_BASE_DIR`). A developer host
 * has no seed and no containment to lose.
 */
export function expectsReadOnlyGuardCache(
  env: GuardEnvLookup = processEnv,
): boolean {
  return (env(BASE_DIR_ENV)?.trim() ?? "").length > 0;
}
