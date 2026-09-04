/**
 * Object-backed environment lookups for tests (Issue #956).
 *
 * The replacement for `Deno.env.set`: a test that needs a module to see a
 * particular variable hands it one of these instead of writing to the
 * process environment, which races every other test running at that moment
 * and is what keeps the quality gate's `deno test` stage serial (Issue #880).
 *
 * Deliberately *not* backed by `Deno.env`: a name the map does not carry
 * reads as absent, so a production code path that quietly falls back to
 * `Deno.env.get` fails here rather than passing on an ambient value.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.).
 */

import type { EnvLookup } from "../../lib/env_lookup.ts";

/**
 * An {@link EnvLookup} that answers only from `values`.
 *
 * @param values - Variable name to value. Omit for an empty environment.
 * @returns A lookup returning `undefined` for every name not in `values`.
 */
export function envFrom(values: Record<string, string> = {}): EnvLookup {
  return (name) => Object.hasOwn(values, name) ? values[name] : undefined;
}

/** An {@link EnvLookup} in which every variable is absent. */
export const emptyEnv: EnvLookup = envFrom();
