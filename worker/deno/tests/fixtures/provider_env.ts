/**
 * Provider-environment isolation for tests (Issue #729).
 *
 * The suite itself runs inside a worker image, which stamps
 * `VIBE_IMAGE_AGENT_PROVIDERS` and may carry the per-run
 * `VIBE_AGENT_PROVIDER` / `VIBE_AGENT_PROVIDERS` overrides. A test that
 * resolves a *configured* provider set must not be judged against this
 * process's own image, so it clears them for the duration of the call and
 * restores exactly what was there.
 */

/** Environment names that override or constrain a provider selection. */
const PROVIDER_ENV_NAMES = [
  "VIBE_IMAGE_AGENT_PROVIDERS",
  "VIBE_AGENT_PROVIDER",
  "VIBE_AGENT_PROVIDERS",
] as const;

/**
 * Run `fn` with the provider environment overrides cleared.
 *
 * @param fn - The call under test.
 * @returns Whatever `fn` returns.
 */
export async function withoutProviderEnv<T>(
  fn: () => Promise<T>,
): Promise<T> {
  const saved = PROVIDER_ENV_NAMES.map(
    (name) => [name, Deno.env.get(name)] as const,
  );
  for (const [name] of saved) Deno.env.delete(name);
  try {
    return await fn();
  } finally {
    for (const [name, value] of saved) {
      if (value !== undefined) Deno.env.set(name, value);
    }
  }
}
