/**
 * `provider-feasibility` — the read-only manager–worker smoke test (Issue #3647).
 *
 * An operator runs it on a host to see, before any real issue is dispatched,
 * which provider × model × role combinations of the manager–worker split are
 * go, no-go, or unavailable here. It is a diagnostic, not a router: it runs no
 * model turn, calls no GitHub API, and writes no file. The only process it
 * starts is `<binary> --version` for each selected provider, with a scrubbed
 * environment, and the only file it reads is the provider's credential file
 * plus the Codex budget telemetry.
 *
 * The verdict logic lives in `lib/provider_feasibility.ts`; this module owns
 * the impure probes that feed it and the command surface.
 *
 * ```
 * deno run --allow-read --allow-env --allow-run mod.ts provider-feasibility --providers claude,codex --validated-models codex:gpt-6.1-sol
 * ```
 *
 * The message is passed through {@link redactSecrets} before it is returned,
 * and the probes only ever surface variable NAMES and state labels, so no
 * credential value can reach the output.
 *
 * Australian English spelling throughout (behaviour, organisation, licence).
 */

import {
  agentProviderById,
  agentProviderIds,
  CODEX_PROVIDER_ID,
} from "../lib/agent_provider.ts";
import { resolveCodexHome } from "../lib/codex_auth_mode.ts";
import { CodexBudgetAdapter } from "../lib/codex_budget.ts";
import {
  parseProviderCredentialEntries,
  providerCredentialPath,
  resolveCredentialDir,
} from "../lib/credential_preflight.ts";
import type { EnvLookup } from "../lib/env_lookup.ts";
import {
  buildFeasibilityCombinations,
  DEFAULT_FEASIBILITY_MODELS,
  evaluateFeasibility,
  type FeasibilityModel,
  type FeasibilityRow,
  fleetBaselineModels,
  formatFeasibilityReport,
  modelKey,
  type ProviderHostFacts,
  probeInvocationCapabilities,
} from "../lib/provider_feasibility.ts";
import { classifyProviderBilling } from "../lib/provider_billing.ts";
import { redactSecrets } from "../lib/secret_redaction.ts";
import type { Command, CommandResult, WorkerConfig } from "../types.ts";

/** Default `--providers` value when none is named. */
const DEFAULT_PROVIDERS = "claude,codex";

/** How long one `<binary> --version` may run before it is abandoned. */
const VERSION_TIMEOUT_MS = 15_000;

/** A `provider:model` candidate. Bounded so a hostile spec cannot stall the regex. */
const MODEL_SPEC = /^([a-z][a-z0-9-]{0,30}):([A-Za-z0-9][A-Za-z0-9._-]{0,99})$/;

/** The outcome of one `<binary> --version` probe. */
export interface CliVersionResult {
  readonly ok: boolean;
  readonly version?: string;
  readonly detail: string;
}

/** Whether a host can report its provider's remaining quota. */
export interface QuotaVisibility {
  readonly visible: boolean;
  readonly detail: string;
}

/** The impure seams the probes need; production wires them, tests fake them. */
export interface FeasibilityProbeDeps {
  /** Parent environment snapshot. */
  readonly env: Readonly<Record<string, string>>;
  readonly workDir: string;
  readonly credentialDir: string;
  /** Read a text file; null when absent or unreadable. */
  readonly readTextFile: (path: string) => string | null;
  readonly runVersion: (
    binary: string,
    childEnv: Record<string, string>,
  ) => Promise<CliVersionResult>;
  readonly readCodexQuota: (codexHome: string) => Promise<QuotaVisibility>;
}

/**
 * Run `<binary> --version` under the provider's scrubbed child environment.
 *
 * @param binary - Executable name or path.
 * @param childEnv - The environment the child will receive (cleared first).
 * @returns The first non-blank output line, or why it could not be read.
 */
export async function runCliVersion(
  binary: string,
  childEnv: Record<string, string>,
): Promise<CliVersionResult> {
  try {
    const output = await new Deno.Command(binary, {
      args: ["--version"],
      env: childEnv,
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(VERSION_TIMEOUT_MS),
    }).output();
    if (!output.success) return { ok: false, detail: `exit ${output.code}` };
    const text = new TextDecoder().decode(output.stdout);
    const line = text
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0);
    if (line === undefined) return { ok: false, detail: "no version output" };
    return { ok: true, version: redactSecrets(line), detail: "ok" };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { ok: false, detail: "not on PATH" };
    }
    return {
      ok: false,
      detail: error instanceof Error ? error.name : "unknown-error",
    };
  }
}

/**
 * Read the Codex budget the adapter can see from one `CODEX_HOME`.
 *
 * The adapter reads rollout files and `auth.json`'s shape only, so this
 * consumes no quota.
 *
 * @param codexHome - The Codex home to read.
 * @returns Whether a remaining fraction is visible, and a log-safe detail.
 */
export async function readCodexQuotaVisibility(
  codexHome: string,
): Promise<QuotaVisibility> {
  const home = codexHome.trim();
  if (home.length === 0) return { visible: false, detail: "no CODEX_HOME" };
  const snapshot = await new CodexBudgetAdapter({ codexHome: home }).refresh();
  const budget = snapshot.budget;
  if (budget.known) {
    return {
      visible: true,
      detail: `${(budget.remainingFraction * 100).toFixed(1)}% remaining (${snapshot.source})`,
    };
  }
  return { visible: false, detail: budget.reason };
}

/**
 * Probe one provider's host facts.
 *
 * The provider's credential file is read the way the worker provisions it,
 * so the billing and child-environment checks see what the run would see.
 * Values stay in memory and never reach the returned facts.
 *
 * @param providerId - A registered provider id.
 * @param deps - The probe seams.
 * @returns The facts for the evaluator.
 * @throws When no provider is registered under `providerId`.
 */
export async function gatherProviderHostFacts(
  providerId: string,
  deps: FeasibilityProbeDeps,
): Promise<ProviderHostFacts> {
  const descriptor = agentProviderById(providerId);
  if (!descriptor) {
    throw new Error(`provider "${providerId}" is not registered`);
  }

  const credentialText = deps.readTextFile(
    providerCredentialPath(deps.credentialDir, descriptor),
  );
  const entries = credentialText === null
    ? []
    : parseProviderCredentialEntries(
      credentialText,
      descriptor.credentials.envVars,
    );
  const fileValues: Record<string, string> = {};
  for (const entry of entries) {
    if (!(entry.name in fileValues)) fileValues[entry.name] = entry.value;
  }
  const parentEnv: Record<string, string> = { ...deps.env, ...fileValues };
  const lookup: EnvLookup = (name) => parentEnv[name];

  const billing = classifyProviderBilling(descriptor.id, {
    workDir: deps.workDir,
    env: lookup,
  });
  const childEnv = descriptor.buildChildEnv({ ...parentEnv });
  const meteredVarsInChild = descriptor.billing.meteredEnvVars.filter(
    (name) => (childEnv[name] ?? "").trim().length > 0,
  );

  const version = await deps.runVersion(descriptor.binary, childEnv);

  const quota = descriptor.id === CODEX_PROVIDER_ID
    ? await deps.readCodexQuota(
      (parentEnv.CODEX_HOME ?? "").trim() ||
        resolveCodexHome(deps.workDir, lookup),
    )
    : { visible: false, detail: "no free quota probe for this provider" };

  return {
    provider: descriptor.id,
    cliVersion: version.ok ? (version.version ?? null) : null,
    cliDetail: version.detail,
    billing,
    meteredVarsInChild,
    quotaVisible: quota.visible,
    quotaDetail: quota.detail,
  };
}

/** A caller error: the message names the bad value, and the run stops. */
class FeasibilityArgumentError extends Error {}

/** Split a comma-separated argument into its non-blank, trimmed entries. */
function splitList(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter((entry) =>
    entry.length > 0
  );
}

/** A string argument, or the empty string when absent or not a string. */
function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === "string" ? value.trim() : "";
}

/** Parse a `provider:model` spec, or fail with the bad value named. */
function parseModelSpec(
  spec: string,
  flag: string,
): FeasibilityModel {
  const match = MODEL_SPEC.exec(spec);
  if (!match) {
    throw new FeasibilityArgumentError(
      `--${flag}: "${spec}" is not a provider:model spec`,
    );
  }
  return { provider: match[1] ?? "", model: match[2] ?? "" };
}

/**
 * Run the split's feasibility evaluation over the selected providers.
 *
 * @param args - `providers`, `models`, `validated-models`, `codex-home`.
 * @param deps - The probe seams.
 * @returns The rows, or `success: false` naming the bad argument.
 */
export async function runProviderFeasibility(
  args: Record<string, unknown>,
  deps: FeasibilityProbeDeps,
): Promise<CommandResult<{ rows: FeasibilityRow[] }>> {
  try {
    const providersArg = stringArg(args, "providers") || DEFAULT_PROVIDERS;
    const providers = unique(splitList(providersArg));
    if (providers.length === 0) {
      throw new FeasibilityArgumentError("--providers names no provider");
    }
    for (const providerId of providers) {
      if (!agentProviderById(providerId)) {
        throw new FeasibilityArgumentError(
          `--providers: unknown provider "${providerId}" (registered: ${
            agentProviderIds().join(", ")
          })`,
        );
      }
    }

    const extraModels = splitList(stringArg(args, "models")).map((spec) =>
      parseModelSpec(spec, "models")
    );
    for (const extra of extraModels) {
      if (!providers.includes(extra.provider)) {
        throw new FeasibilityArgumentError(
          `--models: "${extra.provider}:${extra.model}" belongs to provider "${extra.provider}", which is not among the selected providers`,
        );
      }
    }
    const candidates: FeasibilityModel[] = [];
    const seenCandidates = new Set<string>();
    for (
      const entry of [
        ...DEFAULT_FEASIBILITY_MODELS.filter((candidate) =>
          providers.includes(candidate.provider)
        ),
        ...extraModels,
      ]
    ) {
      const key = modelKey(entry.provider, entry.model);
      if (seenCandidates.has(key)) continue;
      seenCandidates.add(key);
      candidates.push(entry);
    }

    const validatedEntries = splitList(stringArg(args, "validated-models"))
      .map((spec) => parseModelSpec(spec, "validated-models"));
    for (const entry of validatedEntries) {
      if (!agentProviderById(entry.provider)) {
        throw new FeasibilityArgumentError(
          `--validated-models: unknown provider "${entry.provider}"`,
        );
      }
    }
    const validatedModels = new Set<string>([
      ...fleetBaselineModels(),
      ...validatedEntries.map((entry) => modelKey(entry.provider, entry.model)),
    ]);

    const codexHome = stringArg(args, "codex-home");
    const probeDeps: FeasibilityProbeDeps = codexHome.length > 0
      ? { ...deps, env: { ...deps.env, CODEX_HOME: codexHome } }
      : deps;

    const facts = new Map<string, ProviderHostFacts>();
    for (const providerId of providers) {
      facts.set(
        providerId,
        await gatherProviderHostFacts(providerId, probeDeps),
      );
    }

    const combinations = buildFeasibilityCombinations(candidates);
    const rows = combinations.map((combination) =>
      evaluateFeasibility(combination, {
        facts,
        validatedModels,
        capabilities: probeInvocationCapabilities,
      })
    );

    const binaries = providers.map((providerId) =>
      `\`${agentProviderById(providerId)?.binary ?? providerId} --version\``
    );
    const message = redactSecrets(
      `${formatFeasibilityReport(rows)}\n[feasibility] read-only: ran ${
        binaries.join(", ")
      } per provider; no model turn, no GitHub call, no file written`,
    );
    return { success: true, message, data: { rows } };
  } catch (error) {
    if (error instanceof FeasibilityArgumentError) {
      return { success: false, message: redactSecrets(error.message) };
    }
    throw error;
  }
}

/** Order-preserving deduplication. */
function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** The read-only manager–worker smoke test (Issue #3647). */
export const providerFeasibilityCommand: Command = {
  name: "provider-feasibility",
  description:
    "Report go/no-go per provider/model/role for the manager–worker split " +
    "(read-only; runs no model turn)",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<{ rows: FeasibilityRow[] }>> {
    const credentialArg = args["credential-dir"];
    const credentialDir =
      typeof credentialArg === "string" && credentialArg.trim().length > 0
        ? credentialArg.trim()
        : resolveCredentialDir();
    const deps: FeasibilityProbeDeps = {
      env: Deno.env.toObject(),
      workDir: config.workDir,
      credentialDir,
      readTextFile: (path) => {
        try {
          return Deno.readTextFileSync(path);
        } catch {
          return null;
        }
      },
      runVersion: runCliVersion,
      readCodexQuota: readCodexQuotaVisibility,
    };
    return await runProviderFeasibility(args, deps);
  },
};
