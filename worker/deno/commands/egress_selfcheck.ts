/**
 * `egress-selfcheck` — the start-up egress proof, as a command (Issue #4048).
 *
 * The worker runs the same check from `lib/egress_selfcheck.ts` before it
 * claims anything. This command exposes that check to a caller outside the
 * worker. It is config-optional: it has to be able to run before a config
 * file exists, the same way `toolchain-selfcheck` does.
 *
 * Exit status 0 means the policy was proved, or the runtime does not enforce
 * egress and the warning was printed. {@link EGRESS_SELFCHECK_EXIT_STATUS}
 * means an enforcing runtime did not prove it. Nothing was claimed.
 *
 * Australian English spelling throughout (behaviour).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  checkEgressPolicy,
  type CheckEgressPolicyInput,
  EGRESS_SELFCHECK_EXIT_STATUS,
  type EgressPolicyDecision,
} from "../lib/egress_selfcheck.ts";

export type EgressSelfcheckSeams = Omit<CheckEgressPolicyInput, "env"> & {
  env?: (name: string) => string | undefined;
};

export interface EgressSelfcheckCommand extends Command {
  execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
    seams?: EgressSelfcheckSeams,
  ): Promise<CommandResult<EgressPolicyDecision>>;
}

export const egressSelfcheckCommand: EgressSelfcheckCommand = {
  name: "egress-selfcheck",
  description:
    "Prove the container's network egress policy before anything is claimed (Issue #4048)",
  async execute(
    _args: Record<string, unknown>,
    _config: WorkerConfig,
    seams: EgressSelfcheckSeams = {},
  ): Promise<CommandResult<EgressPolicyDecision>> {
    const decision = await checkEgressPolicy({
      env: seams.env ?? ((name) => Deno.env.get(name)),
      ...(seams.probes ? { probes: seams.probes } : {}),
      ...(seams.probe ? { probe: seams.probe } : {}),
      ...(seams.date ? { date: seams.date } : {}),
      ...(seams.appleObserved ? { appleObserved: seams.appleObserved } : {}),
      ...(seams.appleControl ? { appleControl: seams.appleControl } : {}),
      ...(seams.timeoutMs !== undefined ? { timeoutMs: seams.timeoutMs } : {}),
    });
    if (decision.warning) console.warn(decision.warning);
    for (const line of decision.diagnostics ?? []) console.error(line);
    if (decision.marker) console.error(decision.marker);
    console.log(decision.record);
    if (decision.exitCode === 0) {
      return {
        success: true,
        message: decision.record,
        data: decision,
      };
    }
    return {
      success: false,
      exitCode: decision.exitCode === EGRESS_SELFCHECK_EXIT_STATUS
        ? EGRESS_SELFCHECK_EXIT_STATUS
        : decision.exitCode,
      message: decision.marker ?? decision.record,
      data: decision,
    };
  },
};
