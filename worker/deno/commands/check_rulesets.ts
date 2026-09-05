/**
 * `check-rulesets` — reconcile every committed ruleset (Issue #1073).
 *
 * One command for all three payloads under `infra/rulesets/`: `main`, the
 * `Milestone` branch ruleset, and the release tags. Each is compared field by
 * field against the ruleset GitHub applies, and the failure modes stay
 * separate — drift, absent, skipped — so a ruleset that could not be read is
 * never reported as agreeing.
 *
 * Read-only. Applying a payload needs **admin** on the repository, which the
 * fleet's service account does not hold, so the output is the diff plus the
 * `gh` command an operator runs.
 *
 * Usage:
 *   deno run --allow-all mod.ts check-rulesets [--repo owner/repo]
 */

import type { Command, CommandResult } from "../types.ts";
import {
  type CommittedRulesetResult,
  reconcileCommittedRulesets,
} from "../lib/committed_rulesets.ts";
import type { RulesetStatus } from "../lib/ruleset_reconcile.ts";

/** One line per payload, then its message. */
function describe(results: CommittedRulesetResult[]): string {
  return results
    .map(({ ruleset, result }) =>
      `${result.status.toUpperCase()} — ${ruleset.path} (${ruleset.protects})` +
      `\n${result.message}`
    )
    .join("\n\n");
}

export const checkRulesetsCommand: Command = {
  name: "check-rulesets",
  description:
    "Read-only: compare every applied ruleset against its payload under " +
    "infra/rulesets/",

  async execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult<{ statuses: Record<string, RulesetStatus> }>> {
    const repo = typeof args["repo"] === "string" && args["repo"].length > 0
      ? args["repo"]
      : undefined;

    // No root: the library resolves the repository root from its own location.
    const results = await reconcileCommittedRulesets(
      repo === undefined ? {} : { repo },
    );

    const statuses: Record<string, RulesetStatus> = {};
    for (const { ruleset, result } of results) {
      statuses[ruleset.path] = result.status;
    }

    return {
      // A skip is not agreement, but it is not a failure the operator can act
      // on either — going red with no credential is how a check gets disabled.
      success: results.every(({ result }) =>
        result.status === "ok" || result.status === "skipped"
      ),
      message: describe(results),
      data: { statuses },
    };
  },
};
