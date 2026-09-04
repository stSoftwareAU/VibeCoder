/**
 * A fixed environment lookup for tests (Issue #957, parent #944).
 *
 * The routing chain in `lib/phase_routing.ts` takes an {@link EnvLookup}
 * rather than reading `Deno.env` itself, so a test states the variables the
 * chain is allowed to see instead of setting them on the process. That is what
 * makes the model/effort routing tests safe under `deno test --parallel`:
 * process-wide mutation races every other test running at that moment, a map
 * held by one test races nothing.
 *
 * It is also *stricter* than the save/set/restore it replaces. A snapshot
 * helper clears only the variables it was told about, so a `CLAUDE_MODEL_*`
 * exported by the worker container still reached the chain; a lookup built
 * here answers `undefined` for every name it was not given.
 *
 * Australian English throughout (behaviour, colour, organisation).
 */

import type { EnvLookup } from "../../lib/phase_routing.ts";

/**
 * Build an {@link EnvLookup} over a fixed map.
 *
 * @param vars - The variables the code under test may see. Every other name
 *   reads as unset, whatever the process carries.
 * @returns The lookup to inject.
 */
export function envLookup(
  vars: Readonly<Record<string, string | undefined>> = {},
): EnvLookup {
  return (name) => vars[name];
}

/** A lookup over an empty environment — nothing is set. */
export const NO_ENV: EnvLookup = envLookup();
