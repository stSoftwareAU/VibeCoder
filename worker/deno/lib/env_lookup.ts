/**
 * The one environment-lookup seam for the worker (Issue #956).
 *
 * A module that reads `Deno.env.get` directly can only be tested by mutating
 * the process environment, and a mutated process environment races every
 * other test running at that moment — which is what keeps the quality gate's
 * `deno test` stage serial and 18x slower than it needs to be (Issue #880,
 * plan in #944). Taking the lookup as a parameter removes the mutation: the
 * test hands the module a fixed map and asserts on what it does with it.
 *
 * Two identical spellings of this type already existed — `EnvLookup` in
 * `credential_preflight.ts` and the `EnvReader` the credential preflight used —
 * so this module holds the canonical one and both re-export from here.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.).
 */

/**
 * Reads one environment variable by name.
 *
 * Returns `undefined` when the variable is absent, exactly as
 * `Deno.env.get` does, so {@link processEnvLookup} is a drop-in default.
 */
export type EnvLookup = (name: string) => string | undefined;

/**
 * The real process environment as an {@link EnvLookup}.
 *
 * This is the default for every injected `env` parameter, so production
 * callers pass nothing and behave exactly as they did when the module read
 * `Deno.env.get` itself.
 */
export const processEnvLookup: EnvLookup = (name) => Deno.env.get(name);
