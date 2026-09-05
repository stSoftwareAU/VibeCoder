/**
 * `check-release-tag-ruleset` — reconcile the release-tag ruleset (Issue
 * #1049).
 *
 * Read-only. Compares the tag ruleset GitHub applies against
 * `infra/rulesets/release-tags.json`, field by field, and prints the `gh`
 * command that applies the file. Skips loudly without a credential holding
 * `administration:read`, so a fork never goes red on it.
 *
 * Usage:
 *   deno run --allow-all mod.ts check-release-tag-ruleset [--repo owner/repo]
 */

import type { Command, CommandResult } from "../types.ts";
import {
  checkReleaseTagRuleset,
  type RulesetStatus,
} from "../lib/release_tag_ruleset_check.ts";
import { RELEASE_TAG_RULESET_REPO } from "../lib/release_tag_ruleset.ts";

export const checkReleaseTagRulesetCommand: Command = {
  name: "check-release-tag-ruleset",
  description: "Read-only: compare the applied tag ruleset against " +
    "infra/rulesets/release-tags.json",

  async execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult<{ status: RulesetStatus }>> {
    const repo = typeof args["repo"] === "string" && args["repo"].length > 0
      ? args["repo"]
      : RELEASE_TAG_RULESET_REPO;

    // No root: the library resolves the repository root from its own location.
    const result = await checkReleaseTagRuleset({ repo });

    return {
      // A skip is not agreement, but it is not a failure the operator can act
      // on either — going red with no credential is how a check gets disabled.
      success: result.status === "ok" || result.status === "skipped",
      message: result.message,
      data: { status: result.status },
    };
  },
};
