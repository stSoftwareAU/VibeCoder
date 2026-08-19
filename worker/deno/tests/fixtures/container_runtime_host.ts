/**
 * Shared fake host for the container-runtime install offer (Issues #4137,
 * #4185).
 *
 * Linux and Windows run the same offer through the same driver
 * (`offerMissingPrerequisites`), differing only in the package manager and the
 * candidates' state, so the fake host they are both driven against lives here
 * rather than being restated per platform.
 *
 * The fake host is state, not a script — `runStep` mutates it exactly as the
 * real command would, and the re-probe reads it back through the production
 * `recheckPrerequisite("container runtime")` path. A test therefore fails when
 * the offer order, the absent/stopped split or the re-probe honesty regresses,
 * not merely when a string moves.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { assert } from "@std/assert";
import {
  type InstallOutcome,
  offerMissingPrerequisites,
  type PrerequisiteInstallerResult,
} from "../../setup/prerequisite_installer.ts";
import { resolveInstallPlan } from "../../setup/prerequisite_install_plan.ts";
import type {
  AllPrerequisitesResult,
  PrerequisiteResult,
} from "../../setup/prerequisites.ts";
import type {
  ContainerRuntimeProbe,
  HostPlatform,
} from "../../lib/container_runtime.ts";

/** How one runtime behaves on the fake host. */
export interface RuntimeState {
  /** Binary present on PATH. */
  installed: boolean;
  /** Daemon (or machine) answering its probe. */
  answering: boolean;
  /** Probe failure to report even when the binary is present and running. */
  permissionDenied?: boolean;
}

/** The fake host both platform suites drive. */
export interface FakeHost {
  docker: RuntimeState;
  podman: RuntimeState;
  /**
   * Whether the host's package manager is usable — a non-apt distribution, or
   * a Windows host without winget, sets this false.
   */
  packageManager: boolean;
  /** Every argv the driver actually executed. */
  commands: string[][];
  /** Every consent question the driver actually asked. */
  questions: string[];
  /** Every operator-facing line, tagged by level. */
  lines: string[];
}

/** A runtime that is not installed at all. */
export function absent(): RuntimeState {
  return { installed: false, answering: false };
}

/** Build a fake host, defaulting to one with neither runtime installed. */
export function host(overrides: Partial<FakeHost> = {}): FakeHost {
  return {
    docker: absent(),
    podman: absent(),
    packageManager: true,
    commands: [],
    questions: [],
    lines: [],
    ...overrides,
  };
}

/** Probe reading the fake host, mirroring the real probe's reason shapes. */
export function probeOf(state: FakeHost): ContainerRuntimeProbe {
  return (candidate) => {
    const runtime = state[candidate.kind as "docker" | "podman"];
    if (!runtime || !runtime.installed) {
      return Promise.resolve({
        available: false,
        reason: `\`${candidate.executable}\` was not found on PATH`,
      });
    }
    if (runtime.permissionDenied) {
      // `path` is set: the binary ran, so this is "present but unusable".
      return Promise.resolve({
        available: false,
        path: candidate.executable,
        reason: `\`${candidate.executable} version\` exited 1: permission ` +
          `denied while trying to connect to the Docker daemon socket`,
      });
    }
    if (!runtime.answering) {
      return Promise.resolve({
        available: false,
        path: candidate.executable,
        reason: `\`${candidate.executable} version\` exited 1: cannot connect`,
      });
    }
    return Promise.resolve({ available: true, path: candidate.executable });
  };
}

/**
 * Apply one install/start command to the fake host, as the real one would.
 *
 * A winget install leaves the runtime installed but *not* answering: Docker
 * Desktop and the Podman machine both need a start the installer does not do,
 * which is the honest end state a Windows operator sees.
 */
export function applyCommand(
  state: FakeHost,
  argv: readonly string[],
): boolean {
  const line = argv.join(" ");
  if (line === "sudo apt-get install -y docker.io") {
    state.docker = { ...state.docker, installed: true, answering: true };
    return true;
  }
  if (line === "sudo apt-get install -y podman") {
    state.podman = { ...state.podman, installed: true, answering: true };
    return true;
  }
  if (line === "sudo systemctl start docker") {
    state.docker = { ...state.docker, answering: true };
    return true;
  }
  if (line === "podman machine start") {
    state.podman = { ...state.podman, answering: true };
    return true;
  }
  if (argv[0] === "winget" && argv.includes("Docker.DockerDesktop")) {
    state.docker = { ...state.docker, installed: true };
    return true;
  }
  if (argv[0] === "winget" && argv.includes("RedHat.Podman")) {
    state.podman = { ...state.podman, installed: true };
    return true;
  }
  return false;
}

/** The failed container-runtime check the probe produces on a bare host. */
export function runtimeFailure(
  platform: HostPlatform = "linux",
): PrerequisiteResult {
  return {
    ok: false,
    tool: "container runtime",
    message: `No supported container runtime is available on ${platform}.`,
    hint: "To fix this, install and start one of:\n" +
      "  - Docker: install Docker from https://docs.docker.com/get-docker/",
  };
}

/** Wrap results in the aggregate shape the driver consumes. */
export function probeResult(
  ...results: PrerequisiteResult[]
): AllPrerequisitesResult {
  return { ok: results.every((r) => r.ok), results };
}

/** How one test drives the fake host. */
export interface OfferOptions {
  /** Consent per question; the default declines everything. */
  answer?: (question: string) => boolean;
  /** Platform the offer runs for. Defaults to Linux. */
  platform?: HostPlatform;
  /** Outcome of each command; the default applies it to the fake host. */
  run?: (state: FakeHost, argv: readonly string[]) => { ok: boolean };
}

/** Run the real driver against a fake host. */
export function offer(
  state: FakeHost,
  opts: OfferOptions = {},
): Promise<PrerequisiteInstallerResult> {
  const platform = opts.platform ?? "linux";
  const answer = opts.answer ?? (() => false);
  const run = opts.run ??
    ((target: FakeHost, argv: readonly string[]) => ({
      ok: applyCommand(target, argv),
    }));

  return offerMissingPrerequisites(probeResult(runtimeFailure(platform)), {
    platform,
    isTerminal: () => true,
    noAutoInstall: false,
    confirm: (question) => {
      state.questions.push(question);
      return Promise.resolve(answer(question));
    },
    runStep: (step) => {
      state.commands.push([...step.command]);
      const { ok } = run(state, step.command);
      return Promise.resolve({ ok, code: ok ? 0 : 100 });
    },
    resolvePlan: (tool, target) =>
      resolveInstallPlan(tool, target, {
        packageManagerAvailable: () => Promise.resolve(state.packageManager),
      }),
    // The production re-probe path, reading the fake host through the probe.
    probeOptions: {
      os: platform,
      skipPrereqCheck: false,
      containerProbe: probeOf(state),
    },
    reporter: {
      info: (m) => state.lines.push(`info: ${m}`),
      success: (m) => state.lines.push(`success: ${m}`),
      error: (m) => state.lines.push(`error: ${m}`),
    },
  });
}

/** The container-runtime outcome the driver recorded. */
export function runtimeOutcome(
  outcomes: readonly InstallOutcome[],
): InstallOutcome {
  const found = outcomes.find((o) => o.tool === "container runtime");
  assert(found, "no outcome recorded for the container runtime");
  return found;
}

/** Every command the driver ran, one readable line each. */
export function ran(state: FakeHost): string[] {
  return state.commands.map((argv) => argv.join(" "));
}
