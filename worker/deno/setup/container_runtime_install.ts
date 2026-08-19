/**
 * Auto-install the container runtime during setup (Issues #4136, #4137).
 *
 * Two entry points, one per platform, so a failed `container runtime` check is
 * only ever acted on once:
 *
 * - {@link ensureContainerRuntime} / {@link repairContainerRuntime} — the macOS
 *   flow (Issue #4136). It repairs the report *before* the per-tool driver sees
 *   it, because Apple `container` is macOS's only candidate and needs a service
 *   start the probe insists on.
 * - {@link offerContainerRuntimeInstall} — the Linux flow (Issue #4137), called
 *   *by* that driver. Linux has two candidates, so the offer walks them in
 *   probe order (Docker, then Podman) using the driver's own consent, step and
 *   plan injection points.
 *
 * The container runtime is the one prerequisite whose absence stops the Vibe
 * Coder running at all (Issue #4060: there is no host fallback), and the one
 * with a post-install step — the binary alone never passes the probe, because
 * `detectContainerRuntime` runs `container system status`, which fails until
 * the service is started.
 *
 * Three properties matter:
 *
 * 1. **Two failure modes, two remedies.** A missing binary needs
 *    `brew install container` *and* `container system start`; a binary whose
 *    service is stopped needs only the start. Offering a reinstall for a
 *    stopped service is both slower and wrong, so the probe's own
 *    `binaryPresent` flag decides which is offered.
 * 2. **The probe decides the outcome, never the steps.** After the steps run,
 *    the runtime is re-probed in the same setup run: a step that exits zero
 *    but leaves the runtime unable to answer stays a failure (Issue #3234).
 * 3. **Homebrew or nothing.** With no Homebrew there is no install offer at
 *    all — no `.pkg`, no installer script — just today's manual hint and a
 *    failed check.
 * 4. **Answering is not the same as usable.** On macOS the flow ends in the
 *    kernel phase (Issue #4217): `container system status` reports the API
 *    server and nothing about kernels, so a service already running without a
 *    default kernel passes the probe and then fails every image build. Setup
 *    configures the kernel rather than leaving it to be discovered in
 *    production.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import {
  candidatesForPlatform,
  type ContainerRuntimeCandidate,
  type ContainerRuntimeDescriptor,
  type ContainerRuntimeFailure,
  type ContainerRuntimeProbe,
  type ContainerRuntimeProbeResult,
  ContainerRuntimeUnavailableError,
  defaultContainerRuntimeProbe,
  detectContainerRuntime,
  type HostPlatform,
  normaliseHostPlatform,
} from "../lib/container_runtime.ts";
import {
  type InstallPlan,
  type InstallStep,
  resolveInstallPlan,
} from "./prerequisite_install_plan.ts";
// Type-only, so the cycle with the driver that calls this module is erased.
import type {
  InstallerReporter,
  InstallOutcome,
  InstallOutcomeStatus,
  StepResult,
} from "./prerequisite_installer.ts";
import type {
  AllPrerequisitesResult,
  PrerequisiteResult,
} from "./prerequisites.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** What the operator is being asked to allow. */
export interface ContainerConsentRequest {
  /** Runtime the offer is for, e.g. `Apple container`. */
  displayName: string;
  /** Why the runtime is unavailable, in the probe's own words. */
  reason: string;
  /** The exact steps that will run on consent. */
  steps: readonly InstallStep[];
  /** One-line question naming every command, for a `[y/N]` prompt. */
  question: string;
}

/** Asks the operator to allow the steps. Must default to "no". */
export type ContainerInstallConsent = (
  request: ContainerConsentRequest,
) => Promise<boolean>;

/** Result of running one install step. */
export interface InstallStepResult {
  success: boolean;
  /** Combined output, kept so a failure can be reported not swallowed. */
  output: string;
}

/** Runs one install step. Injectable so tests spawn nothing. */
export type InstallStepRunner = (
  step: InstallStep,
) => Promise<InstallStepResult>;

/** How the runtime ended up in the state it is in. */
export type ContainerInstallStatus =
  /** The runtime answered its probe before anything was offered. */
  | "already-available"
  /** Installed and started, and the re-probe passed. */
  | "installed"
  /** Only the service was started, and the re-probe passed. */
  | "started"
  /** A default kernel was configured for a runtime that was already answering. */
  | "kernel-configured"
  /** Nothing could be offered here (no Homebrew, or no plan for the platform). */
  | "no-plan"
  /** The operator declined the offer. */
  | "declined"
  /** A step failed, or the re-probe still says the runtime is unavailable. */
  | "failed";

/** The outcome of one auto-install attempt. */
export interface ContainerInstallOutcome {
  /** True only when the runtime answered a probe at the end of the attempt. */
  ok: boolean;
  status: ContainerInstallStatus;
  /** The resolved runtime — present only when `ok`. */
  descriptor?: ContainerRuntimeDescriptor;
  /** Operator-facing progress and failure lines, in order. */
  messages: string[];
  /** Manual instructions to print when the runtime is still unavailable. */
  hint?: string;
  /** Commands actually executed, in order. */
  commandsRun: string[][];
}

/**
 * Whether Apple `container` has a default kernel for this architecture.
 *
 * `configured` is the answer; `determined` says whether the check could reach
 * one at all. The two are kept apart because they have opposite remedies: an
 * absent kernel is installed, an unanswerable check is a host problem the
 * operator must look at. Neither may be treated as a pass (Issue #4217).
 */
export interface AppleKernelStatus {
  /** True only when a default kernel exists for the host architecture. */
  configured: boolean;
  /** False when the check could not reach an answer either way. */
  determined: boolean;
  /** Why the kernel is missing, or why the check could not answer. */
  reason?: string;
}

/** Reports Apple container's kernel state. Injectable so tests spawn nothing. */
export type AppleKernelStatusCheck = () => Promise<AppleKernelStatus>;

/** Options for {@link ensureContainerRuntime}. */
export interface EnsureContainerRuntimeOptions {
  /** Platform to resolve for. Defaults to `Deno.build.os`. */
  platform?: string;
  /** Probe used to validate the runtime. Defaults to the real one. */
  probe?: ContainerRuntimeProbe;
  /** Consent driver. Defaults to a TTY-gated `[y/N]` prompt. */
  consent?: ContainerInstallConsent;
  /** Step runner. Defaults to spawning the step with streamed output. */
  runStep?: InstallStepRunner;
  /** Package-manager availability check, passed to the install-plan table. */
  packageManagerAvailable?: (name: string) => Promise<boolean>;
  /** Apple kernel check. Defaults to {@link defaultAppleKernelStatus}. */
  kernelStatus?: AppleKernelStatusCheck;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** The tool name `checkContainerPrerequisites` reports the runtime under. */
export const CONTAINER_RUNTIME_TOOL = "container runtime";

/** Render a step's argv for an operator-facing message. */
function renderCommand(step: InstallStep): string {
  return step.command.join(" ");
}

/**
 * Ask the operator, defaulting to no.
 *
 * Declines outright when stdin is not a terminal or `VIBE_NO_AUTO_INSTALL` is
 * set: an unattended run must never block on a prompt, and an operator who
 * manages packages themselves keeps the report without the offer.
 */
export const defaultContainerInstallConsent: ContainerInstallConsent = (
  request,
) => {
  if (Deno.env.get("VIBE_NO_AUTO_INSTALL") === "true") {
    return Promise.resolve(false);
  }
  if (!Deno.stdin.isTerminal()) return Promise.resolve(false);
  return Promise.resolve(confirm(request.question));
};

/**
 * Run one install step, streaming its output so a slow `brew install` or a
 * sudo prompt is visible.
 *
 * The argv is executed directly — never through a shell — so nothing in a
 * package name can be interpreted as a shell metacharacter.
 */
export const defaultInstallStepRunner: InstallStepRunner = async (step) => {
  const [executable, ...args] = step.command;
  try {
    const output = await new Deno.Command(executable!, {
      args,
      stdin: "null",
      stdout: "inherit",
      stderr: "piped",
    }).output();
    const stderr = new TextDecoder().decode(output.stderr).trim();
    if (stderr !== "") console.error(stderr);
    return { success: output.success, output: stderr };
  } catch (error) {
    return {
      success: false,
      output: `\`${renderCommand(step)}\` could not be run: ${
        (error as Error).message
      }`,
    };
  }
};

// ---------------------------------------------------------------------------
// The Apple kernel check (Issue #4217)
// ---------------------------------------------------------------------------

/**
 * The argv that installs the recommended default kernel.
 *
 * Exported so anything else reporting this fault names the same command the
 * operator was offered, rather than inventing a second spelling of it.
 */
export const APPLE_KERNEL_SET_ARGS: readonly string[] = [
  "system",
  "kernel",
  "set",
  "--recommended",
];

/** How long the kernel check waits for `container system status`. */
const KERNEL_STATUS_TIMEOUT_MS = 15_000;

/**
 * Apple container's name for the architecture the host runs.
 *
 * `container system kernel set --arch` takes `arm64` / `amd64`, and the
 * default-kernel file is named for the same value, so Deno's `aarch64` /
 * `x86_64` spellings are translated once here.
 */
function appleKernelArch(arch: string): string | null {
  if (arch === "aarch64") return "arm64";
  if (arch === "x86_64") return "amd64";
  return null;
}

/**
 * Report whether Apple `container` has a default kernel for this host.
 *
 * `container system status` deliberately is not enough: it health-checks the
 * API server and says nothing about kernels, so a service that was started
 * without `--enable-kernel-install` answers it happily and then fails every
 * image build with "default kernel not configured for architecture arm64"
 * (Issue #4217). The CLI has no `kernel get`, so the check reads the
 * default-kernel file under the `appRoot` that `system status --format json`
 * reports — the one machine-readable handle the CLI gives us.
 *
 * A check that cannot reach an answer reports `determined: false` rather than
 * guessing: guessing "configured" is precisely what leaves a host green in
 * setup and dead in production.
 */
export const defaultAppleKernelStatus: AppleKernelStatusCheck = async () => {
  const arch = appleKernelArch(Deno.build.arch);
  if (!arch) {
    return {
      configured: false,
      determined: false,
      reason: `Apple container has no kernel naming for ${Deno.build.arch}`,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KERNEL_STATUS_TIMEOUT_MS);
  let appRoot: string;
  try {
    const output = await new Deno.Command("container", {
      args: ["system", "status", "--format", "json"],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    }).output();
    if (!output.success) {
      return {
        configured: false,
        determined: false,
        reason:
          `\`container system status --format json\` exited ${output.code}`,
      };
    }
    const parsed = JSON.parse(new TextDecoder().decode(output.stdout));
    const root = (parsed as { appRoot?: unknown }).appRoot;
    if (typeof root !== "string" || root === "") {
      return {
        configured: false,
        determined: false,
        reason: "`container system status --format json` reported no appRoot",
      };
    }
    appRoot = root;
  } catch (error) {
    return {
      configured: false,
      determined: false,
      reason: `the Apple container kernel check failed: ${
        (error as Error).message
      }`,
    };
  } finally {
    clearTimeout(timer);
  }

  const kernelPath = `${
    appRoot.replace(/\/+$/, "")
  }/kernels/default.kernel-${arch}`;
  try {
    await Deno.stat(kernelPath);
    return { configured: true, determined: true };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return {
        configured: false,
        determined: true,
        reason: `no default kernel is configured for ${arch}`,
      };
    }
    return {
      configured: false,
      determined: false,
      reason: `reading ${kernelPath} failed: ${(error as Error).message}`,
    };
  }
};

/** The instruction for a host whose kernel setup must be finished by hand. */
function kernelHint(
  candidate: ContainerRuntimeCandidate,
  reason?: string,
): string {
  const detail = reason ? `${reason}. ` : "";
  return `${detail}${candidate.displayName} answers \`system status\`, but ` +
    `without a default kernel every image build fails. Run ` +
    `\`${candidate.executable} ${APPLE_KERNEL_SET_ARGS.join(" ")}\`.`;
}

// ---------------------------------------------------------------------------
// Remedy selection
// ---------------------------------------------------------------------------

/** The steps offered for one failed runtime, and why. */
interface Remedy {
  steps: readonly InstallStep[];
  /** Short description of the remedy, used in the prompt. */
  summary: string;
  status: Extract<ContainerInstallStatus, "installed" | "started">;
}

/**
 * Choose the cheapest remedy for a failed runtime.
 *
 * A present binary needs only its service started; an absent binary needs the
 * install plan, which exists only where the package manager answers.
 */
async function chooseRemedy(
  failure: ContainerRuntimeFailure,
  candidate: ContainerRuntimeCandidate,
  platform: HostPlatform,
  packageManagerAvailable?: (name: string) => Promise<boolean>,
): Promise<Remedy | null> {
  if (failure.binaryPresent && candidate.serviceStartArgs) {
    const step: InstallStep = {
      command: [candidate.executable, ...candidate.serviceStartArgs],
      description: `Start the ${candidate.displayName} service`,
    };
    return {
      steps: [step],
      summary: `${candidate.displayName} is installed but its service is not ` +
        `running`,
      status: "started",
    };
  }

  const plan = await resolveInstallPlan(candidate.kind, platform, {
    ...(packageManagerAvailable ? { packageManagerAvailable } : {}),
  });
  if (!plan) return null;

  return {
    steps: plan.steps,
    summary: `${candidate.displayName} is not installed`,
    status: "installed",
  };
}

/** Everything the kernel phase shares with the install flow around it. */
interface KernelPhaseContext {
  messages: string[];
  commandsRun: string[][];
  kernelStatus: AppleKernelStatusCheck;
  consent: ContainerInstallConsent;
  runStep: InstallStepRunner;
}

/**
 * Finish an answering Apple runtime by making sure it has a default kernel.
 *
 * Runs on both paths into success — the runtime that already answered and the
 * one setup just repaired — because `--enable-kernel-install` only covers a
 * *first* `system start`. A service that was already initialised without a
 * kernel never runs that argv again, which is how a host passes setup and then
 * fails every image build (Issue #4217).
 *
 * As everywhere else in this module, the re-check decides the outcome, never
 * the step's exit status (Issue #3234).
 *
 * @param descriptor - The runtime that just passed its probe
 * @param baseStatus - What to report when the kernel needed no work
 * @param platform - Host platform, used to resolve the candidate
 * @param ctx - Shared message/command sinks and the injectable drivers
 * @returns The outcome, ok only when a kernel is configured
 */
async function ensureAppleKernel(
  descriptor: ContainerRuntimeDescriptor,
  baseStatus: ContainerInstallStatus,
  platform: HostPlatform,
  ctx: KernelPhaseContext,
): Promise<ContainerInstallOutcome> {
  const done = (
    ok: boolean,
    status: ContainerInstallStatus,
    hint?: string,
  ): ContainerInstallOutcome => ({
    ok,
    status,
    ...(ok ? { descriptor } : {}),
    messages: ctx.messages,
    commandsRun: ctx.commandsRun,
    ...(hint ? { hint } : {}),
  });

  const candidate = candidatesForPlatform(platform).find((c) =>
    c.kind === descriptor.kind
  );
  // Only Apple `container` carries a kernel of its own; Docker and Podman
  // bring their own VM, so they finish here unchanged.
  if (!candidate || descriptor.kind !== "apple-container") {
    return done(true, baseStatus);
  }

  const before = await ctx.kernelStatus();
  if (before.configured) return done(true, baseStatus);

  if (!before.determined) {
    ctx.messages.push(
      `Could not confirm ${candidate.displayName}'s default kernel: ` +
        `${before.reason ?? "the check gave no answer"}`,
    );
    return done(false, "failed", kernelHint(candidate, before.reason));
  }

  const step: InstallStep = {
    command: [candidate.executable, ...APPLE_KERNEL_SET_ARGS],
    description:
      `Install the recommended default kernel for ${candidate.displayName}`,
  };
  const question = `${candidate.displayName} is running but has no default ` +
    `kernel, so every image build fails. Run \`${renderCommand(step)}\` now? ` +
    `This downloads the recommended kernel.`;

  if (
    !await ctx.consent({
      displayName: candidate.displayName,
      reason: before.reason ?? "no default kernel is configured",
      steps: [step],
      question,
    })
  ) {
    return done(false, "declined", kernelHint(candidate, before.reason));
  }

  ctx.messages.push(`${step.description}: ${renderCommand(step)}`);
  ctx.commandsRun.push([...step.command]);
  const result = await ctx.runStep(step);
  if (!result.success) {
    ctx.messages.push(
      `\`${renderCommand(step)}\` failed${
        result.output ? `: ${result.output}` : ""
      }`,
    );
    return done(false, "failed", kernelHint(candidate, before.reason));
  }

  const after = await ctx.kernelStatus();
  if (!after.configured) {
    ctx.messages.push(
      `${candidate.displayName} still has no default kernel after ` +
        `\`${renderCommand(step)}\` ran.`,
    );
    return done(false, "failed", kernelHint(candidate, after.reason));
  }

  ctx.messages.push(
    `${candidate.displayName} has a default kernel and can build images`,
  );
  return done(true, "kernel-configured");
}

// ---------------------------------------------------------------------------
// The install flow
// ---------------------------------------------------------------------------

/**
 * Resolve the container runtime, offering to install or start it when it is
 * unavailable and the host has a plan for it.
 *
 * @param options - Platform, probe, consent, runner and package-manager
 *                  overrides (all injectable for tests)
 * @returns What happened, including whether the runtime is now answering
 */
export async function ensureContainerRuntime(
  options: EnsureContainerRuntimeOptions = {},
): Promise<ContainerInstallOutcome> {
  const platform = normaliseHostPlatform(options.platform ?? Deno.build.os);
  const probe = options.probe;
  const messages: string[] = [];
  const commandsRun: string[][] = [];

  // macOS only. Linux and Windows runtimes are repaired inside the per-tool
  // driver by {@link offerContainerRuntimeInstall} (Issue #4137), so the two
  // flows can never both act on the same failed check.
  if (platform !== "darwin") {
    return { ok: false, status: "no-plan", messages, commandsRun };
  }

  const detect = () =>
    detectContainerRuntime({ platform, ...(probe ? { probe } : {}) });

  const kernelContext: KernelPhaseContext = {
    messages,
    commandsRun,
    kernelStatus: options.kernelStatus ?? defaultAppleKernelStatus,
    consent: options.consent ?? defaultContainerInstallConsent,
    runStep: options.runStep ?? defaultInstallStepRunner,
  };

  let unavailable: ContainerRuntimeUnavailableError;
  try {
    const descriptor = await detect();
    // An answering API server is not a usable runtime: the kernel phase has
    // the last word on both paths into success (Issue #4217).
    return await ensureAppleKernel(
      descriptor,
      "already-available",
      platform,
      kernelContext,
    );
  } catch (error) {
    if (!(error instanceof ContainerRuntimeUnavailableError)) throw error;
    unavailable = error;
  }

  // The first failure is the platform's preferred runtime — the only one
  // macOS has, and the one worth repairing on any platform.
  const failure = unavailable.failures[0];
  const candidate = failure
    ? candidatesForPlatform(platform).find((c) => c.kind === failure.kind)
    : undefined;
  const remedy = failure && candidate
    ? await chooseRemedy(
      failure,
      candidate,
      platform,
      options.packageManagerAvailable,
    )
    : null;

  if (!failure || !candidate || !remedy) {
    return {
      ok: false,
      status: "no-plan",
      messages,
      hint: unavailable.message,
      commandsRun,
    };
  }

  const question = `${remedy.summary}. Run ${
    remedy.steps.map((step) => `\`${renderCommand(step)}\``).join(" then ")
  } now?`;
  const consent = options.consent ?? defaultContainerInstallConsent;
  const allowed = await consent({
    displayName: candidate.displayName,
    reason: failure.reason,
    steps: remedy.steps,
    question,
  });

  if (!allowed) {
    return {
      ok: false,
      status: "declined",
      messages,
      hint: unavailable.message,
      commandsRun,
    };
  }

  const runStep = options.runStep ?? defaultInstallStepRunner;
  for (const step of remedy.steps) {
    messages.push(`${step.description}: ${renderCommand(step)}`);
    commandsRun.push([...step.command]);
    const result = await runStep(step);
    if (!result.success) {
      // Fail at the point of the fault, with the runtime's own diagnostic —
      // never continue in a half-installed state (Issue #3234).
      messages.push(
        `\`${renderCommand(step)}\` failed${
          result.output ? `: ${result.output}` : ""
        }`,
      );
      return {
        ok: false,
        status: "failed",
        messages,
        hint: await hintAfterFailedStep(detect, candidate, step),
        commandsRun,
      };
    }
  }

  // The re-probe, not the steps, decides the outcome — and it runs in this
  // same setup invocation so the operator sees a fresh result.
  try {
    const descriptor = await detect();
    messages.push(
      `${descriptor.displayName} is installed and answering (${descriptor.executable})`,
    );
    return await ensureAppleKernel(
      descriptor,
      remedy.status,
      platform,
      kernelContext,
    );
  } catch (error) {
    if (!(error instanceof ContainerRuntimeUnavailableError)) throw error;
    messages.push(
      `${candidate.displayName} still is not answering after the steps ran.`,
    );
    return {
      ok: false,
      status: "failed",
      messages,
      hint: error.message,
      commandsRun,
    };
  }
}

/**
 * The hint for a remedy that failed part-way through its steps.
 *
 * An earlier step may already have changed the host — `brew install`
 * succeeding before `container system start` fails — so the pre-remedy probe
 * message can name a fault that no longer exists ("`container` was not found
 * on PATH" on the host the install just put it on). Re-probe and report the
 * host as it is now. An answering probe never flips the outcome to ok — the
 * failed step means the runtime cannot be trusted as configured
 * (Issue #3234) — it only changes what the operator is told to do next.
 */
async function hintAfterFailedStep(
  detect: () => Promise<ContainerRuntimeDescriptor>,
  candidate: ContainerRuntimeCandidate,
  step: InstallStep,
): Promise<string> {
  try {
    await detect();
  } catch (error) {
    if (error instanceof ContainerRuntimeUnavailableError) return error.message;
    throw error;
  }
  return `${candidate.displayName} answers its probe, but ` +
    `\`${renderCommand(step)}\` failed — finish the setup by hand: ` +
    `${candidate.installHint}.`;
}

// ---------------------------------------------------------------------------
// Wiring into the prerequisite report
// ---------------------------------------------------------------------------

/**
 * Repair a failed container-runtime check inside an existing report.
 *
 * A report whose runtime check already passes is returned untouched — nothing
 * is probed, nothing is offered. When the check failed, the install flow runs
 * and the report is rebuilt from the *re-probe*: the aggregate `ok` follows
 * the runtime's real state, never "we tried" (Issue #3234).
 *
 * @param report - The aggregate produced by `checkAllPrerequisites`
 * @param options - Install-flow overrides, plus a log sink for progress lines
 * @returns The report, with the runtime result refreshed when it was repaired
 */
export async function repairContainerRuntime(
  report: AllPrerequisitesResult,
  options: EnsureContainerRuntimeOptions & {
    /** Sink for operator-facing progress lines. Defaults to `console.log`. */
    log?: (message: string) => void;
  } = {},
): Promise<AllPrerequisitesResult> {
  const failed = report.results.find((result) =>
    result.tool === CONTAINER_RUNTIME_TOOL && !result.ok
  );
  if (!failed) return report;

  const log = options.log ?? ((message: string) => console.log(message));
  const outcome = await ensureContainerRuntime(options);
  for (const message of outcome.messages) log(message);

  const repairedResult: PrerequisiteResult = outcome.ok
    ? {
      ok: true,
      tool: CONTAINER_RUNTIME_TOOL,
      message:
        `${outcome.descriptor?.displayName} is installed and answering (${outcome.descriptor?.executable})`,
    }
    : {
      ...failed,
      ...(outcome.hint ? { hint: summariseHint(outcome.hint) } : {}),
    };

  const results = report.results.map((result) =>
    result === failed ? repairedResult : result
  );
  return {
    ok: results.filter((r) => !r.informational).every((r) => r.ok),
    results,
  };
}

// ---------------------------------------------------------------------------
// The Linux and Windows offer (Issues #4137, #4185)
// ---------------------------------------------------------------------------

/**
 * How a runtime whose binary is present but silent is started, per platform.
 *
 * A binary that ran and exited non-zero needs its service started, never a
 * reinstall — the plan table answers "how is it installed", not "how is it
 * started", so the start argv lives here.
 *
 * Windows deliberately has none. Docker Desktop is a GUI application and the
 * Podman machine is per-user state; neither has an argv setup can run on the
 * operator's behalf that is more honest than the probe's own hint, and
 * reinstalling a runtime that is merely stopped would waste a large download
 * without fixing anything.
 */
const START_STEPS: Readonly<
  Record<HostPlatform, Readonly<Record<string, InstallStep>>>
> = {
  darwin: {},
  linux: {
    docker: {
      command: ["sudo", "systemctl", "start", "docker"],
      description: "Start the Docker daemon",
      mayPromptForSudo: true,
    },
    podman: {
      command: ["podman", "machine", "start"],
      description: "Start the Podman machine",
    },
  },
  windows: {},
};

/** Platforms whose failed runtime check this offer acts on. */
const OFFER_PLATFORMS: readonly HostPlatform[] = ["linux", "windows"];

/** Options for {@link offerContainerRuntimeInstall}. */
export interface ContainerRuntimeOfferOptions {
  /** Host platform the offer runs for. */
  platform: HostPlatform;
  /** Ask the operator a yes/no question; must default to no. */
  confirm: (question: string) => Promise<boolean>;
  /** Run one install step, streaming its output. */
  runStep: (step: InstallStep) => Promise<StepResult>;
  /** Resolve a runtime's install plan, or `null` when it has none here. */
  resolvePlan: (
    tool: string,
    platform: HostPlatform,
  ) => Promise<InstallPlan | null>;
  /** Re-run the probe for the `container runtime` check. */
  recheck: (tool: string) => Promise<PrerequisiteResult | null>;
  /** Where operator-facing lines go. */
  reporter: InstallerReporter;
  /** Candidate probe override (testing). Defaults to the real one. */
  probe?: ContainerRuntimeProbe;
}

/** What the offer did, in the shape every other tool hands the driver back. */
export interface ContainerRuntimeOffer {
  fresh: PrerequisiteResult;
  outcome: InstallOutcome;
}

/** The steps offered for one candidate, and what a success would mean. */
interface CandidateRemedy {
  steps: readonly InstallStep[];
  status: Extract<InstallOutcomeStatus, "installed" | "started">;
  summary: string;
}

/**
 * Choose the cheapest remedy for one failed candidate.
 *
 * A probe result carrying `path` means the binary ran and the daemon (or
 * machine) did not answer, so the remedy is a start — and where the platform
 * has no start argv (Windows), there is no remedy at all: reinstalling a
 * runtime that is merely stopped would not start it (Issue #4185). Otherwise
 * the binary is absent and the install plan applies, when the host has one.
 */
async function candidateRemedy(
  candidate: ContainerRuntimeCandidate,
  probed: ContainerRuntimeProbeResult,
  opts: ContainerRuntimeOfferOptions,
): Promise<CandidateRemedy | null> {
  if (probed.path) {
    const start = START_STEPS[opts.platform]?.[candidate.kind];
    if (!start) return null;
    return {
      steps: [start],
      status: "started",
      summary: `${candidate.displayName} is installed but is not answering`,
    };
  }

  const plan = await opts.resolvePlan(candidate.kind, opts.platform);
  if (!plan) return null;
  return {
    steps: plan.steps,
    status: "installed",
    summary: `${candidate.displayName} is not installed`,
  };
}

/**
 * The consent question: every command spelt out, and sudo named before it runs.
 */
function offerQuestion(remedy: CandidateRemedy): string {
  const commands = remedy.steps
    .map((step) => `\`${renderCommand(step)}\``)
    .join(" then ");
  const needsSudo = remedy.steps.some((step) =>
    step.mayPromptForSudo || step.command[0] === "sudo"
  );
  const sudoNote = needsSudo
    ? " This runs with sudo and may ask for your password."
    : "";
  return `${remedy.summary}. Run ${commands} now?${sudoNote} [y/N]`;
}

/**
 * A `docker.io` install leaves the invoking user outside the `docker` group.
 *
 * Setup never edits group membership — it says exactly what to run instead, so
 * the gap is visible rather than silently worked around (Issue #3234).
 */
function reportPermissionGap(
  candidate: ContainerRuntimeCandidate,
  fresh: PrerequisiteResult,
  reporter: InstallerReporter,
): void {
  const text = `${fresh.message} ${fresh.hint ?? ""}`.toLowerCase();
  if (candidate.kind !== "docker" || !text.includes("permission denied")) {
    return;
  }
  reporter.error(
    `${candidate.displayName} is installed but this user cannot reach its ` +
      'socket. Run `sudo usermod -aG docker "$USER"`, then log out and back ' +
      "in — setup never changes group membership itself.",
  );
}

/** Run one candidate's remedy, then let the re-probe decide the outcome. */
async function runCandidateRemedy(
  result: PrerequisiteResult,
  candidate: ContainerRuntimeCandidate,
  remedy: CandidateRemedy,
  opts: ContainerRuntimeOfferOptions,
): Promise<ContainerRuntimeOffer> {
  let stepFailure: string | undefined;

  for (const step of remedy.steps) {
    opts.reporter.info(step.description);
    const stepResult = await opts.runStep(step);
    if (!stepResult.ok) {
      stepFailure = `\`${renderCommand(step)}\` exited ${stepResult.code}`;
      opts.reporter.error(
        `${stepFailure} — ${candidate.displayName} was not ${remedy.status}`,
      );
      break;
    }
  }

  // The probe, never the exit status, says whether the runtime is now usable.
  const reprobed = await opts.recheck(result.tool);
  const fresh = reprobed
    ? { ...reprobed, informational: result.informational }
    : result;

  if (fresh.ok) {
    opts.reporter.success(`${candidate.displayName} is now answering`);
    return { fresh, outcome: { tool: result.tool, status: remedy.status } };
  }

  reportPermissionGap(candidate, fresh, opts.reporter);
  const detail = stepFailure ??
    `the steps ran but ${candidate.displayName} still fails its check`;
  if (!stepFailure) opts.reporter.error(detail);
  return { fresh, outcome: { tool: result.tool, status: "failed", detail } };
}

/**
 * Offer to install or start a Linux or Windows container runtime, in probe
 * order.
 *
 * Docker is offered first and Podman only when Docker is declined or has no
 * plan on this host — one runtime is ever acted on, never both. macOS keeps
 * today's report: it runs its own flow before the driver (Issue #4136).
 *
 * @param result - The failed `container runtime` check from the probe
 * @param opts - Platform plus the driver's consent, step, plan and re-probe
 *               injection points
 * @returns The refreshed check and what the offer did to it
 */
export async function offerContainerRuntimeInstall(
  result: PrerequisiteResult,
  opts: ContainerRuntimeOfferOptions,
): Promise<ContainerRuntimeOffer> {
  const unchanged = (status: InstallOutcomeStatus): ContainerRuntimeOffer => ({
    fresh: result,
    outcome: { tool: result.tool, status },
  });

  if (!OFFER_PLATFORMS.includes(opts.platform)) return unchanged("no-plan");

  const probe = opts.probe ?? defaultContainerRuntimeProbe;
  let declined = false;

  for (const candidate of candidatesForPlatform(opts.platform)) {
    const probed = await probe(candidate);
    if (probed.available) continue;

    const remedy = await candidateRemedy(candidate, probed, opts);
    // Nothing installable here — fall through to the next candidate rather
    // than asking a question setup cannot act on.
    if (!remedy) continue;

    if (!await opts.confirm(offerQuestion(remedy))) {
      declined = true;
      continue;
    }
    return await runCandidateRemedy(result, candidate, remedy, opts);
  }

  // Declined outranks no-plan: the operator was asked and said no.
  return unchanged(declined ? "declined" : "no-plan");
}

/** Drop the leading summary line so the hint reads as instructions. */
function summariseHint(message: string): string {
  const [, ...rest] = message.split("\n");
  const hint = rest.join("\n").trim();
  return hint === "" ? message : hint;
}
