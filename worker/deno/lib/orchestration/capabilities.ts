/**
 * Provider capabilities for the external orchestrator (Issue #3642).
 *
 * Every value is derived from the registered provider descriptor rather than
 * kept in a table beside it, so a provider cannot drift from what its CLI is
 * really handed. The probe builds one invocation carrying a sub-agent
 * definition, a settings payload and a denied tool, then reads back what the
 * argv keeps.
 *
 * Enforcement rule (Issue #3641 section 6): a denied tool counts as enforced
 * only when the argv itself carries the denial. A denial folded into the
 * prompt, or dropped, is not enforcement. The role is refused rather than
 * trusted to obey a prompt. Under this rule Codex (prompt-only denial) and
 * Gemini (denial dropped) cannot carry a role that denies any tool.
 *
 * Australian English spelling throughout (behaviour, recognised).
 */

import { type AgentDefinition, agentProviderById } from "../agent_provider.ts";
import { supportsCompaction } from "../stream_compaction.ts";
import type {
  OrchestrationRefusal,
  ProviderCapabilities,
  RoleSelection,
  TargetProvider,
  TargetRole,
} from "./types.ts";

const TARGET_PROVIDERS: readonly TargetProvider[] = [
  "claude",
  "codex",
  "gemini",
  "deepseek",
];

/** A tool name no real provider denies, so the probe cannot collide with one. */
const PROBE_DENIED_TOOL = "VibeOrchestrationProbe";

const PROBE_AGENT: AgentDefinition = {
  description: "capability probe",
  prompt: "capability probe",
};

/**
 * Capabilities a role needs before it may run. A manager session spans the
 * plan and the review of a whole run, so it needs compaction to stay inside
 * its context window. Other roles need nothing beyond tool enforcement.
 */
const ROLE_REQUIRED_CAPABILITIES: Readonly<
  Record<TargetRole, { readonly compaction?: boolean }>
> = {
  manager: { compaction: true },
  executor: {},
  spec_reviewer: {},
  standards_reviewer: {},
  explorer: {},
};

interface ProbedProvider extends ProviderCapabilities {
  readonly enforcesDeniedTools: boolean;
}

const probeCache = new Map<TargetProvider, ProbedProvider>();

/**
 * Builds one probe invocation through the real descriptor and reads back what
 * the argv carries. Cached per provider: the descriptors are static, and a
 * probe can warn (DeepSeek drops `--agents` with a warning), so it runs once.
 */
function probeProvider(provider: TargetProvider): ProbedProvider {
  const cached = probeCache.get(provider);
  if (cached) return cached;
  const descriptor = agentProviderById(provider);
  if (!descriptor) {
    throw new Error(
      `orchestration: no provider descriptor is registered for ${provider}`,
    );
  }
  const argv = descriptor.buildInvocation({
    prompt: "capability probe",
    agents: { probe: PROBE_AGENT },
    settingsJson: "{}",
    disallowedTools: [PROBE_DENIED_TOOL],
  });
  const denialIndex = argv.indexOf("--disallowed-tools");
  const enforcesDeniedTools = denialIndex >= 0 &&
    (argv[denialIndex + 1] ?? "").split(",").includes(PROBE_DENIED_TOOL);
  const probed: ProbedProvider = {
    agents: argv.includes("--agents"),
    settingsHook: argv.includes("--settings"),
    compaction: supportsCompaction(provider),
    promptTransport: descriptor.promptTransport,
    enforcesDeniedTools,
  };
  probeCache.set(provider, probed);
  return probed;
}

/**
 * What one provider can carry of the contract, derived from its descriptor.
 *
 * @param provider - An orchestration target provider.
 * @returns Its capabilities. Throws only if the provider has no descriptor,
 *   which a caller must rule out with `assertRoleSupported` first.
 */
export function providerCapabilities(
  provider: TargetProvider,
): ProviderCapabilities {
  const probed = probeProvider(provider);
  return {
    agents: probed.agents,
    settingsHook: probed.settingsHook,
    compaction: probed.compaction,
    promptTransport: probed.promptTransport,
  };
}

/**
 * Whether a role may run on `selection`, or the refusal that says why not.
 *
 * Checks, in order: the provider is a known target with a descriptor; the
 * role's required capabilities are present; and every tool in `requiredTools`
 * is enforced through the argv. Never throws for an unsupported selection.
 *
 * @param selection - The provider, model and effort the role would run with.
 * @param role - The role the call plays.
 * @param requiredTools - Tools the role must be able to deny.
 * @returns The refusal, or undefined when the role may run.
 */
export function assertRoleSupported(
  selection: RoleSelection,
  role: TargetRole,
  requiredTools: readonly string[],
): OrchestrationRefusal | undefined {
  const provider = selection.provider;
  if (!TARGET_PROVIDERS.includes(provider) || !agentProviderById(provider)) {
    return {
      kind: "unsupported_provider",
      message: `unknown provider ${
        JSON.stringify(provider)
      } is not an orchestration target; supported: ${
        TARGET_PROVIDERS.join(", ")
      }`,
    };
  }
  if (provider === "codex") {
    // These bounded, fresh calls use read-only/workspace-write sandboxes and
    // features.multi_agent=false; generic named tool denials remain unsupported.
    const supported = [
      "Edit",
      "MultiEdit",
      "Write",
      "NotebookEdit",
      "Bash",
      "Task",
      "Agent",
    ];
    if (requiredTools.some((tool) => !supported.includes(tool))) {
      return {
        kind: "missing_tool_support",
        message: `codex cannot enforce requested tools ${
          requiredTools.join(", ")
        }`,
      };
    }
    const argv = agentProviderById(provider)!.buildInvocation({
      prompt: "probe",
      orchestrationRole: role === "executor" ? "executor" : "reviewer",
    });
    if (
      argv.includes("--sandbox") &&
      argv.includes("features.multi_agent=false") &&
      !argv.includes("--dangerously-bypass-approvals-and-sandbox")
    ) return undefined;
    return {
      kind: "missing_tool_support",
      message: "codex CLI role sandbox unavailable",
    };
  }
  const capabilities = providerCapabilities(provider);
  const required = ROLE_REQUIRED_CAPABILITIES[role] ?? {};
  if (required.compaction && !capabilities.compaction) {
    return {
      kind: "unsupported_capability",
      message:
        `${provider} cannot compact its stream, which the ${role} role requires`,
    };
  }
  if (
    requiredTools.length > 0 && !probeProvider(provider).enforcesDeniedTools
  ) {
    return {
      kind: "missing_tool_support",
      message: `${provider} cannot enforce the denied tools ${
        requiredTools.join(", ")
      } through its command line, so it cannot carry the ${role} role`,
    };
  }
  return undefined;
}
