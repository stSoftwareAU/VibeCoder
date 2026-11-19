/**
 * Which agent provider served a run, for the post-run callback document
 * (Issue #5163).
 *
 * The document's `provider` used to be the host's configured provider, which
 * is wrong whenever a repository `agent_provider` pin, a non-external
 * subscription allocation, a reroute to Claude or an `agent_provider_fallback`
 * switch sent the run to another provider.
 */

/** The per-invocation stats this reads: the provider the runner stamped on each. */
export interface ProviderSource {
  runStats?: { provider?: string };
}

/**
 * The provider that served a run.
 *
 * Each invocation's `runStats.provider` is stamped by `buildRunStats` in
 * `lib/claude_runner.ts` with the id of the provider it spawned (including one
 * switched to by `agent_provider_fallback`).
 *
 * - No invocations: no agent spawned, so the configured provider is the one
 *   that would have served it (undefined when blank or absent).
 * - Exactly one distinct provider named: that id.
 * - None named, or several (for example an external-orchestration run whose
 *   calls ran on different providers): undefined, never the configured one.
 */
export function servedRunProvider(
  invocations: readonly ProviderSource[],
  configuredProvider: string | undefined,
): string | undefined {
  if (invocations.length === 0) {
    return configuredProvider?.trim() || undefined;
  }
  const named = new Set<string>();
  for (const invocation of invocations) {
    const id = invocation.runStats?.provider?.trim();
    if (id) named.add(id);
  }
  return named.size === 1 ? [...named][0] : undefined;
}
