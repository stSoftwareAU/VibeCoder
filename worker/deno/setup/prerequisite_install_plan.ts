/**
 * Per-platform prerequisite install plans (Issue #4134).
 *
 * `setup/prerequisites.ts` knows *that* a tool is missing and carries a
 * free-text `hint` ("Install with: brew install jq") aimed at a human — prose
 * nothing can act on. This module turns that knowledge into data: a tool plus
 * a host platform resolves to a machine-readable {@link InstallPlan}, or to
 * `null` when the tool is not auto-installable there.
 *
 * Three properties matter:
 *
 * 1. **Pure table, no side effects.** The only process this module may spawn
 *    is the injectable package-manager availability check, so the table stays
 *    unit-testable on a host with neither Homebrew nor apt.
 * 2. **A plan implies its package manager is present.** With no Homebrew on
 *    macOS every macOS plan resolves to `null` and the caller falls back to
 *    today's manual hint — never a silent, confusing install failure
 *    (Issue #3234).
 * 3. **No remote scripts.** Every step is a direct argv handed to the package
 *    manager. Where no genuine package exists (`deno` on Debian/Ubuntu), the
 *    answer is `null`, not `curl … | sh`.
 *
 * `git` is auto-installed only where a clean package exists: on macOS it
 * arrives with the Xcode command line tools (a large, separate, interactive
 * download) and on Linux it is a hard bootstrap dependency, so both are
 * `null`; winget's `Git.Git` is neither, so Windows has a plan (Issue #4185).
 *
 * Package names verified 2026-08-15 against the real registries: `brew info`
 * for jq, coreutils, deno, gh and the `claude-code` cask; the Debian source
 * index for jq, coreutils and gh (bookworm/trixie/sid main, and Ubuntu jammy
 * onwards) — `deno` has no Debian or Ubuntu package, hence `null`. The winget
 * ids were verified 2026-08-18 against the `microsoft/winget-pkgs` manifest
 * index (`manifests/j/jqlang/jq`, `g/GitHub/cli`, `d/DenoLand/Deno`,
 * `g/Git/Git`, `d/Docker/DockerDesktop`, `r/RedHat/Podman`).
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import {
  CONTAINER_RUNTIMES,
  type HostPlatform,
} from "../lib/container_runtime.ts";
import { resolveRunMode, type RunMode } from "../lib/run_mode.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One command in an install plan. */
export interface InstallStep {
  /** argv to run, e.g. `["brew", "install", "jq"]`. Never shelled out. */
  command: readonly string[];
  /** Operator-facing description, e.g. "Install jq with Homebrew". */
  description: string;
  /** True when the step may prompt for sudo (Linux apt). */
  mayPromptForSudo?: boolean;
}

/** How a tool is installed on one host platform. */
export interface InstallPlan {
  /** Prerequisite tool the plan installs, as the probe names it. */
  tool: string;
  /** Host platform the plan applies to. */
  platform: HostPlatform;
  /** Ordered steps; a later step only runs when every earlier step succeeded. */
  steps: readonly InstallStep[];
  /** Package manager the plan depends on, e.g. `"brew"` or `"apt-get"`. */
  packageManager: string;
}

/** Options for {@link resolveInstallPlan}. */
export interface ResolveInstallPlanOptions {
  /**
   * Reports whether a package manager is usable on this host. Injectable so
   * the table is testable without Homebrew or apt installed.
   */
  packageManagerAvailable?: (name: string) => Promise<boolean>;
  /**
   * Run mode the plan is resolved for (Issue #4149). Defaults to the mode
   * {@link resolveRunMode} reports. Container is the only mode (Issue #4).
   */
  runMode?: RunMode;
}

// ---------------------------------------------------------------------------
// The plan table
// ---------------------------------------------------------------------------

/** A plan before its package manager has been confirmed present. */
interface PlanEntry {
  packageManager: string;
  steps: readonly InstallStep[];
}

/** Install a Homebrew formula. */
function brewFormula(tool: string, formula: string): PlanEntry {
  return {
    packageManager: "brew",
    steps: [{
      command: ["brew", "install", formula],
      description: `Install ${tool} with Homebrew (${formula})`,
    }],
  };
}

/** Install a Homebrew cask. */
function brewCask(tool: string, cask: string): PlanEntry {
  return {
    packageManager: "brew",
    steps: [{
      command: ["brew", "install", "--cask", cask],
      description: `Install ${tool} with Homebrew (cask ${cask})`,
    }],
  };
}

/**
 * Start the Apple `container` service.
 *
 * The argv comes from the runtime catalogue rather than being spelt out again
 * here, so the probe and the install plan can never disagree about how the
 * service is started (Issue #4136).
 */
export function containerServiceStartStep(): InstallStep {
  const candidate = CONTAINER_RUNTIMES["apple-container"];
  return {
    command: [candidate.executable, ...(candidate.serviceStartArgs ?? [])],
    description: `Start the ${candidate.displayName} service`,
  };
}

/**
 * Install a Windows package with winget (Issue #4185).
 *
 * `--source winget` pins the official community repository: winget otherwise
 * resolves an id against every configured source, so an operator's private
 * source could answer for a well-known id. `--exact` stops a substring match
 * picking a different package, and `--silent` keeps the vendor's installer
 * from opening a wizard nothing is there to click through.
 *
 * There is no sudo on Windows, so `mayPromptForSudo` stays unset — winget
 * elevates through UAC by itself, which the description says plainly rather
 * than the flag promising a password prompt that never appears.
 */
function wingetPackage(tool: string, id: string): PlanEntry {
  return {
    packageManager: "winget",
    steps: [{
      command: [
        "winget",
        "install",
        "--exact",
        "--id",
        id,
        "--source",
        "winget",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "--silent",
      ],
      description:
        `Install ${tool} with winget (${id}) — Windows may ask you to elevate`,
    }],
  };
}

/** Install a Debian/Ubuntu package. */
function aptPackage(tool: string, pkg: string): PlanEntry {
  return {
    packageManager: "apt-get",
    steps: [{
      command: ["sudo", "apt-get", "install", "-y", pkg],
      description: `Install ${tool} with apt (${pkg})`,
      mayPromptForSudo: true,
    }],
  };
}

/**
 * The install table, keyed by tool then platform.
 *
 * `null` means "not auto-installable here" — the caller keeps today's manual
 * hint. Docker and Podman are Linux and Windows only: neither is the
 * containment boundary on macOS (Issue #4060), where the only runtime is Apple
 * `container`.
 */
const INSTALL_TABLE: Readonly<
  Record<string, Readonly<Record<HostPlatform, PlanEntry | null>>>
> = {
  jq: {
    darwin: brewFormula("jq", "jq"),
    linux: aptPackage("jq", "jq"),
    windows: wingetPackage("jq", "jqlang.jq"),
  },
  // GNU coreutils supplies `timeout`; on macOS Homebrew installs it as
  // `gtimeout`, which is exactly what the probe already accepts. winget
  // packages no GNU coreutils, and Windows is container-only (Issue #4145), so
  // `timeout` is container-owned there and never host-fatal.
  timeout: {
    darwin: brewFormula("coreutils timeout (gtimeout)", "coreutils"),
    linux: aptPackage("coreutils timeout", "coreutils"),
    windows: null,
  },
  // No Debian or Ubuntu package exists for deno, and the upstream install path
  // is `curl … | sh` — a remote script this module will not model.
  deno: {
    darwin: brewFormula("deno", "deno"),
    linux: null,
    windows: wingetPackage("deno", "DenoLand.Deno"),
  },
  gh: {
    darwin: brewFormula("gh", "gh"),
    linux: aptPackage("gh", "gh"),
    windows: wingetPackage("gh", "GitHub.cli"),
  },
  // The Claude Code CLI ships as a Homebrew cask; Debian and Ubuntu package
  // nothing equivalent.
  claude: {
    darwin: brewCask("the Claude Code CLI", "claude-code"),
    linux: null,
    windows: null,
  },
  // Apple `container` ships as a Homebrew *formula* (`brew info container`:
  // homebrew-core Formula/c/container.rb, stable 1.2.2), not a cask. The
  // binary alone is not enough — the probe runs `container system status`,
  // which fails until the service is started, so starting it is step two
  // (Issue #4136). Linux and Windows never run Apple container.
  "apple-container": {
    darwin: {
      packageManager: "brew",
      steps: [
        {
          command: ["brew", "install", "container"],
          description: "Install Apple container with Homebrew (container)",
        },
        containerServiceStartStep(),
      ],
    },
    linux: null,
    windows: null,
  },
  // The Linux container runtimes, in the probe's own preference order
  // (Issue #4137). Docker comes from the distribution's own `docker.io`
  // package: adding Docker's apt repository and signing key is a supply-chain
  // change that does not belong behind a consent prompt.
  docker: {
    darwin: null,
    linux: aptPackage("Docker", "docker.io"),
    windows: wingetPackage("Docker Desktop", "Docker.DockerDesktop"),
  },
  podman: {
    darwin: null,
    linux: aptPackage("Podman", "podman"),
    windows: wingetPackage("Podman", "RedHat.Podman"),
  },
  // Auto-installed on Windows only — see the module header.
  git: {
    darwin: null,
    linux: null,
    windows: wingetPackage("git", "Git.Git"),
  },
};

/** Every tool the install table has an answer for, auto-installable or not. */
export const PLAN_TOOLS: readonly string[] = Object.freeze(
  Object.keys(INSTALL_TABLE),
);

// ---------------------------------------------------------------------------
// The default availability check
// ---------------------------------------------------------------------------

/** How long the availability check may take before it counts as absent. */
const AVAILABILITY_TIMEOUT_MS = 15_000;

/**
 * Report whether a package manager is present and answering on this host.
 *
 * The one place this module runs a process. A missing executable, a non-zero
 * exit, or no answer within {@link AVAILABILITY_TIMEOUT_MS} all mean "absent",
 * so a plan is only ever offered when its package manager really works.
 *
 * @param name - Package-manager executable, e.g. `brew` or `apt-get`
 * @returns True only when the executable ran and exited zero
 */
export async function defaultPackageManagerAvailable(
  name: string,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AVAILABILITY_TIMEOUT_MS);
  try {
    const output = await new Deno.Command(name, {
      args: ["--version"],
      stdin: "null",
      stdout: "null",
      stderr: "null",
      signal: controller.signal,
    }).output();
    return output.success;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve how a prerequisite tool is installed on a host platform.
 *
 * @param tool - Tool name as the prerequisite probe reports it (`jq`, `gh`, …)
 * @param platform - Host platform the plan is for
 * @param opts - Package-manager availability check and run-mode overrides
 * @returns The plan, or `null` when this tool is not auto-installable on this
 *          platform — including when its package manager is not installed, or
 *          when the resolved run mode has no use for the tool
 */
export async function resolveInstallPlan(
  tool: string,
  platform: HostPlatform,
  opts: ResolveInstallPlanOptions = {},
): Promise<InstallPlan | null> {
  const key = tool.trim().toLowerCase();
  // Containment is mandatory (Issue #4): container is the only run mode, so
  // every tool in the table — the container runtimes included — is offered.
  // The mode is still resolved so a configuration naming a removed mode
  // fails loud here too rather than at launch.
  opts.runMode ?? resolveRunMode();

  const entry = INSTALL_TABLE[key]?.[platform];
  if (!entry) return null;

  const available = opts.packageManagerAvailable ??
    defaultPackageManagerAvailable;
  if (!await available(entry.packageManager)) return null;

  return {
    tool: key,
    platform,
    steps: entry.steps,
    packageManager: entry.packageManager,
  };
}
