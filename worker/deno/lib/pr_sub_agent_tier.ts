/**
 * Read the sub-agent tier that authored a PR from its body marker
 * (Issue #3404).
 *
 * Fleet telemetry attributes PR outcomes (rejections, CI-fix and PR-feedback
 * runs, merges) to the tier that wrote the PR. The tier lives in the hidden
 * marker the issue run embeds in the PR body (Issue #3403).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { IssueSubAgentTier } from "../types.ts";
import { subAgentTierFromBody } from "./pr_body.ts";

/**
 * Fetch a PR's body and resolve its authoring sub-agent tier.
 *
 * A readable body with no marker is a PR created before the marker existed,
 * which ran on the default `sonnet` tier. A body that cannot be read (the
 * `gh` call throws, the output is not JSON, or `body` is not a string) yields
 * `null` and a warning, never `sonnet`: defaulting on failure would
 * misattribute the outcome to the wrong tier.
 *
 * @param repo - `owner/name`
 * @param prNumber - The PR number
 * @param gh - Runs `gh` with the given argv and resolves its stdout
 * @param logger - Receives a warning when the body cannot be read
 * @returns The PR's tier, or `null` when its body could not be read
 */
export async function fetchPrSubAgentTier(
  repo: string,
  prNumber: number,
  gh: (args: string[]) => Promise<string>,
  logger: { warn: (message: string) => void },
): Promise<IssueSubAgentTier | null> {
  const where = `${repo}#${prNumber}`;
  try {
    const raw = await gh([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "body",
    ]);
    const parsed: unknown = JSON.parse(raw);
    const body = typeof parsed === "object" && parsed !== null
      ? (parsed as { body?: unknown }).body
      : undefined;
    if (typeof body !== "string") {
      throw new Error("PR body missing or not a string");
    }
    return subAgentTierFromBody(body) ?? "sonnet";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      `Could not read the sub-agent tier of ${where}: ${message}`,
    );
    return null;
  }
}
