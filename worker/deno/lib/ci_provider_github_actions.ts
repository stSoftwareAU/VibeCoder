/**
 * Built-in GitHub Actions CI log provider (Issues #3580, #3579).
 *
 * Wraps the Actions log fetcher as a {@link CiLogProvider} so the
 * default provider and every external one share a single dispatch path.
 * This is also the fall-back the registry returns when no external
 * provider matches, so every repo gets real job logs with zero
 * configuration.
 *
 * Uses Australian English throughout (behaviour, organisation, colour).
 */

import type { Result } from "../types.ts";
import type {
  CiFailureContext,
  CiLogExcerpt,
  CiLogProvider,
} from "./ci_log_provider.ts";
import {
  fetchGithubActionsLogExcerpt,
  GITHUB_ACTIONS_PROVIDER_ID,
  parseActionsCheckUrl,
} from "./github_actions_log_fetcher.ts";
import { assertNever } from "./assert_never.ts";

export { GITHUB_ACTIONS_PROVIDER_ID };

/**
 * The caller's URL when it is safe to present as this run's source.
 *
 * Safe means: parseable, on a GitHub host, shaped like an Actions run or job
 * URL, and under this repository's path. Anything else returns `undefined`
 * and the caller falls back to a URL it builds itself.
 *
 * @param targetUrl - The caller-supplied URL, from untrusted input.
 * @param repo - `owner/repo` this log was fetched for.
 * @returns The URL to present, or `undefined` when it cannot be trusted.
 */
export function actionsUrlForRepo(
  targetUrl: string | undefined,
  repo: string,
): string | undefined {
  if (!targetUrl) return undefined;
  if (parseActionsCheckUrl(targetUrl).kind === "other") return undefined;
  let path: string;
  try {
    path = new URL(targetUrl).pathname;
  } catch {
    return undefined;
  }
  return path.startsWith(`/${repo}/`) ? targetUrl : undefined;
}

/** The built-in GitHub Actions provider. */
export const githubActionsCiLogProvider: CiLogProvider = {
  id: GITHUB_ACTIONS_PROVIDER_ID,

  matches(ctx: CiFailureContext): boolean {
    const config = ctx.providerConfig;
    if (config && config.provider !== GITHUB_ACTIONS_PROVIDER_ID) return false;
    if (parseActionsCheckUrl(ctx.targetUrl ?? "").kind !== "other") return true;
    // No usable URL: a check run id still lets the fetcher resolve the job.
    return (ctx.checkRunId ?? "") !== "";
  },

  async fetchLog(
    ctx: CiFailureContext,
  ): Promise<Result<CiLogExcerpt, string>> {
    if (!ctx.ghFn) {
      return {
        ok: false,
        error: "github-actions provider requires a gh command runner",
      };
    }

    const fetchExcerpt = ctx.actionsLogFn ?? fetchGithubActionsLogExcerpt;
    const outcome = await fetchExcerpt({
      repo: ctx.repo,
      checkRunId: ctx.checkRunId ?? "",
      checkName: ctx.checkName,
      ...(ctx.targetUrl !== undefined ? { targetUrl: ctx.targetUrl } : {}),
      ghFn: ctx.ghFn,
    });

    switch (outcome.kind) {
      case "excerpt":
        return {
          ok: true,
          value: {
            providerId: GITHUB_ACTIONS_PROVIDER_ID,
            buildId: String(outcome.jobId),
            // Never echo the caller's URL back. `targetUrl` reaches here
            // from untrusted input (an issue body's `Build URL`, a check's
            // `details_url`), and this value is rendered into the CI-fix
            // prompt. It is used only when it is an Actions URL on a GitHub
            // host — enforced by `parseActionsCheckUrl` — AND names this
            // repository, so a valid github.com URL for somebody else's
            // repository cannot be presented as the source of this log.
            url: actionsUrlForRepo(ctx.targetUrl, ctx.repo) ??
              `https://github.com/${ctx.repo}/actions/runs`,
            logText: outcome.excerpt,
          },
        };
      case "not-applicable":
        return { ok: false, error: outcome.reason };
      case "error":
        return { ok: false, error: outcome.error };
      default:
        // Exhaustiveness guard — a new outcome kind must be handled above.
        return assertNever(outcome);
    }
  },
};
