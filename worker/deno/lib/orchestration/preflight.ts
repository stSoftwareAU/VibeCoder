/** Subscription-only, noninteractive capability preflight (Issue #3643). */
import { agentProviderById } from "../agent_provider.ts";
import {
  classifyProviderBilling,
  isFixedPriceSubscription,
} from "../provider_billing.ts";
import { resolveAutomaticProviderStatus } from "../provider_auto_runtime.ts";
import type { RoleSelection } from "./types.ts";

/** Refuse a missing CLI, unproved entitlement, or observed exhausted quota. */
export async function preflightRole(
  selection: RoleSelection,
  workDir: string,
  environment: Record<string, string | undefined>,
): Promise<void> {
  const env = (key: string) => environment[key];
  const billing = classifyProviderBilling(selection.provider, { workDir, env });
  if (!isFixedPriceSubscription(billing)) {
    throw new Error(
      `external orchestration: ${selection.provider} requires a fixed-price subscription (${billing.reason})`,
    );
  }
  const descriptor = agentProviderById(selection.provider)!;
  const parent = Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] =>
      entry[1] !== undefined
    ),
  );
  const child = descriptor.buildChildEnv(parent);
  if (descriptor.billing.meteredEnvVars.some((key) => child[key]?.trim())) {
    throw new Error(
      `external orchestration: ${selection.provider} child has metered credentials`,
    );
  }
  const command = new Deno.Command(descriptor.binary, {
    args: ["--version"],
    env: child,
    clearEnv: true,
    stdin: "null",
    stdout: "null",
    stderr: "null",
  });
  try {
    const result = await command.output();
    if (!result.success) throw new Error(`exit ${result.code}`);
  } catch {
    throw new Error(
      `external orchestration: ${descriptor.binary} CLI is not runnable; provision its subscription login and CLI on this host`,
    );
  }
  const status = await resolveAutomaticProviderStatus(selection.provider, {
    workDir,
    env,
    now: Date.now(),
  });
  if (
    status.availability === "exhausted" || status.availability === "unavailable"
  ) {
    throw new Error(
      `external orchestration: ${selection.provider} unavailable (${status.reason})`,
    );
  }
}
