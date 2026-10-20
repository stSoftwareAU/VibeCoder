/** Dry-run-first allocation command (Issue #3646). */
import type { Command, CommandResult } from "../types.ts";
import { evaluateSubscriptionAllocation } from "../lib/subscription_allocation_runtime.ts";

export const subscriptionAllocationCommand: Command = {
  name: "subscription-allocation",
  description:
    "Recommend subscription allocation using mature cohorts; --apply requires explicit auto_routing opt-in",
  async execute(args, config): Promise<CommandResult> {
    if (
      (args.apply !== undefined && args.apply !== true) ||
      (args["reset-state"] !== undefined && args["reset-state"] !== true)
    ) {
      return {
        success: false,
        message: "--apply and --reset-state are boolean flags",
      };
    }
    try {
      const result = await evaluateSubscriptionAllocation(config, {
        apply: args.apply === true,
        reset: args["reset-state"] === true,
      });
      return {
        success: true,
        message: JSON.stringify(
          {
            mode: args.apply === true
              ? "automatic-weights-applied"
              : "dry-run-routing-unchanged",
            metric: "estimated API-equivalent USD only",
            uncertainty:
              "sequential error spending; independent bounded host-day clusters required",
            stateFile: result.stateFile,
            plan: result.plan,
          },
          null,
          2,
        ),
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
