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
            url: ctx.targetUrl && ctx.targetUrl !== ""
              ? ctx.targetUrl
              : `https://github.com/${ctx.repo}/actions/runs`,
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
