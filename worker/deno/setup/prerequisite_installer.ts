/**
 * Interactive prerequisite installer (Issue #4135).
 *
 * The probe in `setup/prerequisites.ts` reports *that* a tool is missing and
 * `setup/prerequisite_install_plan.ts` (Issue #4134) knows *how* it would be
 * installed. This module is the driver that joins them: for each failed check
 * it asks for a plan, asks the operator for consent, runs the plan, and then
 * re-runs the probe so the fresh truth — never "we tried" — decides the
 * outcome (Issue #3234).
 *
 * Three contracts are non-negotiable:
 *
 * 1. **No TTY ⇒ no host change without prior consent.** When stdin is not a
 *    terminal the driver returns the probe untouched — but never silently
 *    (Issue #33): when a failed check had an install plan, the report says
 *    the offer was withheld and why, so a withheld offer is distinguishable
 *    from a host that has no offer at all.
 * 2. **Consent per tool, defaulting to no.** A bare Enter declines, and no
 *    timeout or environment variable ever answers on the operator's behalf.
 *    The one sanctioned pre-consent is the explicit `--auto-install` flag
 *    (Issue #33) — typed by the operator on this very invocation, it approves
 *    every offer, and each approval is reported as it happens.
 * 3. **The re-probe decides.** A declined install, a failed install, or a tool
 *    with no plan leaves that check failed. A successful install flips the
 *    check to `✓` in the same setup run.
 * 4. **The offer follows the run mode** (Issue #4149). It covers the tools the
 *    resolved mode needs on the host, so a native host is offered `jq`,
 *    coreutils and the coding-agent CLI, and is never offered a container
 *    runtime.
 *
 * `VIBE_NO_AUTO_INSTALL=true` keeps the probe but suppresses the offer, for an
 * operator who wants the report and manages packages themselves.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import {
  candidatesForPlatform,
  type HostPlatform,
  normaliseHostPlatform,
} from "../lib/container_runtime.ts";
import { resolveRunMode, type RunMode } from "../lib/run_mode.ts";
import {
  CONTAINER_RUNTIME_TOOL,
  offerContainerRuntimeInstall,
} from "./container_runtime_install.ts";
import {
  type InstallPlan,
  type InstallStep,
  resolveInstallPlan,
} from "./prerequisite_install_plan.ts";
import {
  aggregatePrerequisiteOk,
  type AllPrerequisitesResult,
  type PrerequisiteOptions,
  type PrerequisiteResult,
  recheckPrerequisite,
} from "./prerequisites.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** What happened to one failed prerequisite. */
export type InstallOutcomeStatus =
  | "installed"
  /** Already installed, and started rather than installed (Issue #4137). */
  | "started"
  | "declined"
  | "failed"
  | "no-plan";

/** The driver's record of one failed prerequisite. */
export interface InstallOutcome {
  /** Tool as the probe names it. */
  tool: string;
  /** What the driver did, and what came of it. */
  status: InstallOutcomeStatus;
  /** Operator-facing detail, e.g. the command that exited non-zero. */
  detail?: string;
}

/** Result of running one install step. */
export interface StepResult {
  ok: boolean;
  code: number;
}

/** Where the driver's operator-facing lines go. */
export interface InstallerReporter {
  info(msg: string): void;
  success(msg: string): void;
  error(msg: string): void;
}

/** Options for {@link offerMissingPrerequisites}. */
export interface PrerequisiteInstallerOptions {
  /** Host platform plans are resolved for. Defaults to `Deno.build.os`. */
  platform?: HostPlatform;
  /** Reports whether stdin is a terminal. Injectable for tests. */
  isTerminal?: () => boolean;
  /** Suppress the offer. Defaults to `VIBE_NO_AUTO_INSTALL === "true"`. */
  noAutoInstall?: boolean;
  /**
   * Consent to every offer in advance (Issue #33). Set by the operator's
   * explicit `--auto-install` flag — never by an environment variable — so a
   * scripted setup run installs what it can without a terminal to prompt on.
   * Outranks {@link noAutoInstall} and the TTY gate; every approval is
   * reported as it happens.
   */
  autoInstall?: boolean;
  /** Ask the operator a yes/no question; must default to no. */
  confirm?: (question: string) => Promise<boolean>;
  /** Run one install step, streaming its output. */
  runStep?: (step: InstallStep) => Promise<StepResult>;
  /** Resolve a tool's install plan, or `null` when it has none here. */
  resolvePlan?: (
    tool: string,
    platform: HostPlatform,
  ) => Promise<InstallPlan | null>;
  /** Re-run the probe for one tool; `null` when that tool is not re-probeable. */
  recheck?: (tool: string) => Promise<PrerequisiteResult | null>;
  /** Probe options the default re-probe reuses (gh config dir, repo root, …). */
  probeOptions?: PrerequisiteOptions;
  /**
   * Run mode the offer covers (Issue #4149). Defaults to the probe options'
   * mode, else the host's own. Native mode never offers a container runtime.
   */
  runMode?: RunMode;
  /** Where operator-facing lines go. Defaults to the console. */
  reporter?: InstallerReporter;
}

/** Outcome of the whole offer. */
export interface PrerequisiteInstallerResult {
  /** Aggregate status after the re-probe — informational failures excluded. */
  ok: boolean;
  /** The probe's results, with re-probed entries replaced in place. */
  results: PrerequisiteResult[];
  /** One entry per failed check the driver considered. */
  outcomes: InstallOutcome[];
  /** False when the offer was suppressed (no TTY, or `VIBE_NO_AUTO_INSTALL`). */
  offered: boolean;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Friendly names for the package managers the plan table uses. */
const MANAGER_LABELS: Readonly<Record<string, string>> = {
  brew: "Homebrew",
  "apt-get": "apt",
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Ask on the terminal, defaulting to no — a bare Enter declines. */
async function defaultConfirm(question: string): Promise<boolean> {
  await Deno.stdout.write(encoder.encode(`?  ${question} `));
  const buffer = new Uint8Array(256);
  const read = await Deno.stdin.read(buffer);
  if (read === null) return false;
  const answer = decoder.decode(buffer.subarray(0, read)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

/**
 * Run one install step with inherited stdio.
 *
 * Inheriting all three streams is the point: a slow `brew install` shows its
 * progress and a `sudo` step can ask for the password.
 */
async function defaultRunStep(step: InstallStep): Promise<StepResult> {
  const [executable, ...args] = step.command;
  try {
    const child = new Deno.Command(executable!, {
      args,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    const status = await child.status;
    return { ok: status.success, code: status.code };
  } catch (error) {
    // A step that cannot even start is a failure, never a silent skip.
    throw new Error(
      `Failed to run \`${step.command.join(" ")}\`: ${
        (error as Error).message
      }`,
    );
  }
}

/** Console reporter used when setup does not supply its own printers. */
const consoleReporter: InstallerReporter = {
  info: (msg) => console.log(`ℹ  ${msg}`),
  success: (msg) => console.log(`✓  ${msg}`),
  error: (msg) => console.error(`✗  ${msg}`),
};

/** The host platform, or `null` when it is not one plans are written for. */
function resolvePlatform(override?: HostPlatform): HostPlatform | null {
  if (override) return override;
  try {
    return normaliseHostPlatform(Deno.build.os);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

/** Compose the consent question for one failed check. */
function questionFor(result: PrerequisiteResult, plan: InstallPlan): string {
  const label = MANAGER_LABELS[plan.packageManager] ?? plan.packageManager;
  const message = result.message.replace(/\.\s*$/, "");
  return `${message}. Install it now with ${label}? [y/N]`;
}

/**
 * Install one tool, then re-probe it.
 *
 * The steps run in order and the first failure aborts the rest, but the tool
 * is re-probed either way — the probe, not the exit status, is what says
 * whether the prerequisite is now satisfied.
 */
async function installAndRecheck(
  result: PrerequisiteResult,
  plan: InstallPlan,
  runStep: (step: InstallStep) => Promise<StepResult>,
  recheck: (tool: string) => Promise<PrerequisiteResult | null>,
  reporter: InstallerReporter,
): Promise<{ fresh: PrerequisiteResult; outcome: InstallOutcome }> {
  let stepFailure: string | undefined;

  for (const step of plan.steps) {
    reporter.info(step.description);
    const stepResult = await runStep(step);
    if (!stepResult.ok) {
      stepFailure = `\`${step.command.join(" ")}\` exited ${stepResult.code}`;
      reporter.error(`${stepFailure} — ${result.tool} was not installed`);
      break;
    }
  }

  const reprobed = await recheck(result.tool);
  // A tool with no re-probe stays exactly as the original probe left it.
  const fresh = reprobed
    ? { ...reprobed, informational: result.informational }
    : result;

  if (fresh.ok) {
    reporter.success(`${result.tool} is now installed`);
    return { fresh, outcome: { tool: result.tool, status: "installed" } };
  }

  const detail = stepFailure ??
    `the install finished but ${result.tool} still fails its check`;
  if (!stepFailure) reporter.error(detail);
  return { fresh, outcome: { tool: result.tool, status: "failed", detail } };
}

/** Print what was installed, declined, failed, and left without a plan. */
function reportSummary(
  outcomes: readonly InstallOutcome[],
  reporter: InstallerReporter,
): void {
  const named = (status: InstallOutcomeStatus) =>
    outcomes.filter((o) => o.status === status).map((o) => o.tool);

  const installed = named("installed");
  const started = named("started");
  const declined = named("declined");
  const noPlan = named("no-plan");

  if (installed.length > 0) {
    reporter.success(`Installed: ${installed.join(", ")}`);
  }
  if (started.length > 0) {
    reporter.success(`Started: ${started.join(", ")}`);
  }
  if (declined.length > 0) {
    reporter.info(`Declined: ${declined.join(", ")}`);
  }
  for (const outcome of outcomes.filter((o) => o.status === "failed")) {
    reporter.error(`Failed to install ${outcome.tool}: ${outcome.detail}`);
  }
  if (noPlan.length > 0) {
    reporter.info(
      `Install by hand (no install plan on this host): ${noPlan.join(", ")}`,
    );
  }
}

/**
 * The failed tools a withheld offer could have installed (Issue #33).
 *
 * Plan resolution is the same one the live offer uses, so the notice never
 * names a tool the offer would not actually have covered. The container
 * runtime is judged through its per-platform candidates — and skipped on
 * macOS, where the runtime is repaired (and any withheld offer reported) by
 * its own flow before this driver runs (Issue #4136).
 */
async function installableTools(
  failures: readonly PrerequisiteResult[],
  platform: HostPlatform | null,
  resolvePlan: (
    tool: string,
    platform: HostPlatform,
  ) => Promise<InstallPlan | null>,
): Promise<string[]> {
  if (!platform) return [];
  const named: string[] = [];
  for (const failure of failures) {
    if (failure.tool === CONTAINER_RUNTIME_TOOL) {
      if (platform === "darwin") continue;
      const plans = await Promise.all(
        candidatesForPlatform(platform).map((c) =>
          resolvePlan(c.kind, platform)
        ),
      );
      if (plans.some((plan) => plan !== null)) named.push(failure.tool);
      continue;
    }
    if (await resolvePlan(failure.tool, platform)) named.push(failure.tool);
  }
  return named;
}

/**
 * Offer to install every failed prerequisite, one prompt per tool.
 *
 * @param probe - The result {@link checkAllPrerequisites} just produced
 * @param opts - TTY, prompt, runner, plan and re-probe injection points
 * @returns The refreshed results plus what happened to each failed check
 */
export async function offerMissingPrerequisites(
  probe: AllPrerequisitesResult,
  opts: PrerequisiteInstallerOptions = {},
): Promise<PrerequisiteInstallerResult> {
  const reporter = opts.reporter ?? consoleReporter;
  const isTerminal = opts.isTerminal ?? (() => Deno.stdin.isTerminal());
  const noAutoInstall = opts.noAutoInstall ??
    (Deno.env.get("VIBE_NO_AUTO_INSTALL") === "true");
  const autoInstall = opts.autoInstall === true;

  const untouched: PrerequisiteInstallerResult = {
    ok: probe.ok,
    results: probe.results,
    outcomes: [],
    offered: false,
  };
  const failures = probe.results.filter((r) => !r.ok);
  if (failures.length === 0) return untouched;

  const platform = resolvePlatform(opts.platform);
  const runMode = opts.runMode ?? opts.probeOptions?.runMode ??
    resolveRunMode();
  const resolvePlan = opts.resolvePlan ??
    ((tool: string, target: HostPlatform) =>
      resolveInstallPlan(tool, target, { runMode }));

  // A withheld offer is never silent (Issue #33): the report names what
  // could have been installed and why it was not offered. `--auto-install`
  // outranks both suppression conditions — that is its whole point.
  const suppression = autoInstall
    ? null
    : noAutoInstall
    ? "VIBE_NO_AUTO_INSTALL=true is set"
    : !isTerminal()
    ? "stdin is not a terminal"
    : null;
  if (suppression !== null) {
    const installable = await installableTools(failures, platform, resolvePlan);
    if (installable.length > 0) {
      reporter.info(
        `Auto-install is available for: ${installable.join(", ")} — the ` +
          `offer was withheld because ${suppression}. Re-run setup from an ` +
          `interactive terminal to be asked, or pass --auto-install to ` +
          `consent in advance.`,
      );
    }
    return untouched;
  }

  const confirm = opts.confirm ?? (autoInstall
    ? (question: string) => {
      reporter.info(`--auto-install consented to: ${question}`);
      return Promise.resolve(true);
    }
    : defaultConfirm);
  const runStep = opts.runStep ?? defaultRunStep;
  const recheck = opts.recheck ??
    ((tool: string) =>
      recheckPrerequisite(tool, { ...opts.probeOptions, runMode }));

  const results = [...probe.results];
  const outcomes: InstallOutcome[] = [];

  for (const [index, result] of results.entries()) {
    if (result.ok) continue;

    // The container runtime has two candidates on Linux and an absent/stopped
    // split, so its offer lives in its own module (Issue #4137).
    if (result.tool === CONTAINER_RUNTIME_TOOL) {
      if (!platform) {
        outcomes.push({ tool: result.tool, status: "no-plan" });
        continue;
      }
      const offer = await offerContainerRuntimeInstall(result, {
        platform,
        confirm,
        runStep,
        resolvePlan,
        recheck,
        reporter,
        probe: opts.probeOptions?.containerProbe,
      });
      results[index] = offer.fresh;
      outcomes.push(offer.outcome);
      continue;
    }

    const plan = platform ? await resolvePlan(result.tool, platform) : null;
    if (!plan) {
      outcomes.push({ tool: result.tool, status: "no-plan" });
      continue;
    }

    if (!await confirm(questionFor(result, plan))) {
      outcomes.push({ tool: result.tool, status: "declined" });
      continue;
    }

    const { fresh, outcome } = await installAndRecheck(
      result,
      plan,
      runStep,
      recheck,
      reporter,
    );
    results[index] = fresh;
    outcomes.push(outcome);
  }

  reportSummary(outcomes, reporter);

  return {
    ok: aggregatePrerequisiteOk(results, runMode),
    results,
    outcomes,
    offered: true,
  };
}
