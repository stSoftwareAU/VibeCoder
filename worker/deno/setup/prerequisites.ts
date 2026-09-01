/**
 * Prerequisite checks for VibeCoder setup.
 *
 * **The split follows the resolved run mode** (Issue #4149, setting #4146).
 * Container mode — the default — keeps the Issue #4117 split:
 *
 * - **Host-fatal** — what setup itself uses (`git`, an authenticated `gh`,
 *   `deno`) plus the container software the worker needs: a working container
 *   runtime and an image that is present or buildable. A gap here fails the
 *   run loudly (Issue #3234).
 * - **Container-owned, informational** — the coding-agent CLI, `jq` and
 *   coreutils `timeout` live in the image. They are still reported when
 *   present on the host, but their absence never fails setup.
 *
 * Native mode inverts exactly those two groups: the worker runs on the host, so
 * the coding-agent CLI, `jq` and `timeout` are host-fatal again, while the
 * container runtime and the worker image are reported informationally — a
 * native host with no runtime at all is correctly provisioned.
 *
 * Cross-platform tool detection uses `Deno.Command` directly — no need for
 * `which` vs `where.exe` since Deno handles PATH resolution everywhere.
 *
 * **The install layer sits on top, never inside** (Issues #4134-#4137). This
 * module only ever reports; `setup/prerequisite_install_plan.ts` knows how a
 * tool would be installed, and `setup/prerequisite_installer.ts` offers it on
 * an interactive run. Two consequences follow:
 *
 * - **Installing never reclassifies a result.** A tool is host-fatal or
 *   informational because of the run mode, not because of whether it can be
 *   installed. Installing an informational tool leaves it informational, and
 *   declining a host-fatal one leaves it fatal.
 * - **The re-probe decides.** {@link recheckPrerequisite} re-runs a single
 *   check after an install, so the aggregate reflects a fresh probe rather
 *   than an install's exit code (Issue #3234).
 *
 * Issue #923: Migrate setup scripts to Deno TypeScript.
 * Issue #993: Replace setup/prerequisites.sh with Deno module.
 * Issue #4117: Host-fatal vs container-owned split.
 * Issue #4135: Single-tool re-probe for the interactive installer.
 * Issue #4149: The split follows the resolved run mode.
 */

import { resolveContainerImageReference } from "../lib/container_image_hash.ts";
import {
  readDeploymentImageSelection,
  resolveDeploymentConfigFile,
} from "../lib/container_image_selection.ts";
import {
  type ContainerRuntimeDescriptor,
  type ContainerRuntimeProbe,
  detectContainerRuntime,
} from "../lib/container_runtime.ts";
import { resolveRunMode, type RunMode } from "../lib/run_mode.ts";

/** Result of a single prerequisite check. */
export interface PrerequisiteResult {
  ok: boolean;
  tool: string;
  message: string;
  /** Installation hint for the user when the check fails. */
  hint?: string;
  /**
   * Reported for information only — the resolved run mode does not need this
   * tool on the host, so a failure here never fails setup (Issues #4117,
   * #4149).
   */
  informational?: boolean;
}

/** Aggregated result of all prerequisite checks. */
export interface AllPrerequisitesResult {
  ok: boolean;
  results: PrerequisiteResult[];
}

/** Result of git identity configuration. */
export interface GitIdentityResult {
  ok: boolean;
  message: string;
}

/** Options controlling which checks run. */
export interface PrerequisiteOptions {
  /** Skip all prerequisite checks. */
  skipPrereqCheck?: boolean;
  /** Skip authentication checks (gh auth, claude). */
  skipAuthCheck?: boolean;
  /** Override for Deno.build.os (testing). */
  os?: string;
  /** Command runner override (testing). */
  runCommand?: (cmd: string[]) => Promise<CommandOutput>;
  /** Custom gh config directory (from .config.json gh_config_dir). */
  ghConfigDir?: string;
  /**
   * Repository root the container definition is resolved against.
   * Defaults to the checkout this module was loaded from.
   */
  repoRoot?: string;
  /**
   * The deployment's `.config.json` (Issue #743). Its selections are part of
   * the image's identity, so the worker-image check reads them to name the
   * tag the launcher builds rather than a selection-free one. Defaults to the
   * launcher's own rule: `CONFIG_PATH`, else `.config.json` beside the
   * checkout.
   */
  configPath?: string;
  /** Container-runtime probe override (testing). */
  containerProbe?: ContainerRuntimeProbe;
  /**
   * Run mode the probe classifies for (Issue #4149). Defaults to the mode
   * {@link resolveRunMode} reports — `VIBE_RUN_MODE`, else `container`. Setup
   * passes the mode it resolved from `.config.json`; tests override it here.
   */
  runMode?: RunMode;
}

/** Probe options with the run mode resolved — what the checks work from. */
interface ResolvedPrerequisiteOptions extends PrerequisiteOptions {
  runMode: RunMode;
}

interface CommandOutput {
  success: boolean;
  stdout: string;
  stderr: string;
}

/** Detect operating system. */
export function detectOs(override?: string): "darwin" | "linux" | "windows" {
  const os = override ?? Deno.build.os;
  if (os === "darwin") return "darwin";
  if (os === "windows") return "windows";
  return "linux";
}

/**
 * Check whether a command exists on PATH.
 *
 * Uses `Deno.Command` to run the tool with `--version` — this works
 * cross-platform without needing `which` (Unix) or `where.exe` (Windows)
 * since Deno handles PATH resolution internally.
 */
export async function commandExists(
  name: string,
  runCommand?: (cmd: string[]) => Promise<CommandOutput>,
): Promise<boolean> {
  const runner = runCommand ?? defaultRunCommand;
  try {
    const result = await runner([name, "--version"]);
    return result.success;
  } catch {
    return false;
  }
}

async function defaultRunCommand(cmd: string[]): Promise<CommandOutput> {
  const command = new Deno.Command(cmd[0]!, {
    args: cmd.slice(1),
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  const decoder = new TextDecoder();
  return {
    success: output.success,
    stdout: decoder.decode(output.stdout).trim(),
    stderr: decoder.decode(output.stderr).trim(),
  };
}

/**
 * Resolve effective options by merging environment variables.
 *
 * Honours `VIBE_SKIP_PREREQ_CHECK` and `VIBE_SKIP_AUTH_CHECK` environment
 * variables — explicit option values take precedence over env vars. The run
 * mode resolves the same way: an explicit option wins, else `VIBE_RUN_MODE`,
 * else the `container` default (Issue #4146). An unrecognised `VIBE_RUN_MODE`
 * throws rather than being coerced to a mode the host did not ask for.
 */
function resolveOptions(
  opts: PrerequisiteOptions,
): ResolvedPrerequisiteOptions {
  return {
    ...opts,
    skipPrereqCheck: opts.skipPrereqCheck ??
      (Deno.env.get("VIBE_SKIP_PREREQ_CHECK") === "true"),
    skipAuthCheck: opts.skipAuthCheck ??
      (Deno.env.get("VIBE_SKIP_AUTH_CHECK") === "true"),
    runMode: opts.runMode ?? resolveRunMode(),
  };
}

/** Check that git is installed. */
export async function checkGit(
  opts: PrerequisiteOptions = {},
): Promise<PrerequisiteResult> {
  const resolved = resolveOptions(opts);
  if (resolved.skipPrereqCheck) {
    return {
      ok: true,
      tool: "git",
      message: "Skipped (VIBE_SKIP_PREREQ_CHECK)",
    };
  }
  const exists = await commandExists("git", resolved.runCommand);
  if (!exists) {
    const os = detectOs(resolved.os);
    const hint = os === "darwin"
      ? "Install with: xcode-select --install or brew install git"
      : "Install with: apt install git (Linux)";
    return { ok: false, tool: "git", message: "git is not installed", hint };
  }
  return { ok: true, tool: "git", message: "git is installed" };
}

/** Check that gh CLI is installed and authenticated. */
export async function checkGhAuth(
  opts: PrerequisiteOptions = {},
): Promise<PrerequisiteResult> {
  const resolved = resolveOptions(opts);
  if (resolved.skipAuthCheck || resolved.skipPrereqCheck) {
    return { ok: true, tool: "gh", message: "Skipped" };
  }
  const runner = resolved.runCommand ?? defaultRunCommand;
  const exists = await commandExists("gh", resolved.runCommand);
  if (!exists) {
    const os = detectOs(resolved.os);
    const hint = os === "darwin"
      ? "Install with: brew install gh"
      : "Install from: https://cli.github.com/";
    return { ok: false, tool: "gh", message: "gh CLI is not installed", hint };
  }
  // Check authentication — use custom GH_CONFIG_DIR if configured
  const ghEnv = resolved.ghConfigDir
    ? { GH_CONFIG_DIR: resolved.ghConfigDir }
    : undefined;
  const authRunner = ghEnv
    ? async (cmd: string[]) => {
      const command = new Deno.Command(cmd[0]!, {
        args: cmd.slice(1),
        stdout: "piped",
        stderr: "piped",
        env: { ...Deno.env.toObject(), ...ghEnv },
      });
      const output = await command.output();
      return {
        success: output.code === 0,
        stdout: new TextDecoder().decode(output.stdout).trim(),
        stderr: new TextDecoder().decode(output.stderr).trim(),
      };
    }
    : runner;
  const authResult = await authRunner(["gh", "auth", "status"]);
  if (!authResult.success) {
    const hint = resolved.ghConfigDir
      ? `Run: GH_CONFIG_DIR=${resolved.ghConfigDir} gh auth login`
      : "Run: gh auth login";
    return {
      ok: false,
      tool: "gh",
      message: "gh CLI is not authenticated",
      hint,
    };
  }
  // Try to get the username
  try {
    const userResult = await authRunner([
      "gh",
      "api",
      "user",
      "--jq",
      ".login",
    ]);
    if (userResult.success && userResult.stdout) {
      return {
        ok: true,
        tool: "gh",
        message: `gh CLI authenticated as: ${userResult.stdout}`,
      };
    }
  } catch {
    // Non-fatal — auth is still valid
  }
  return { ok: true, tool: "gh", message: "gh CLI is authenticated" };
}

/** Check that the Claude CLI is installed. */
export async function checkClaudeCli(
  opts: PrerequisiteOptions = {},
): Promise<PrerequisiteResult> {
  const resolved = resolveOptions(opts);
  if (resolved.skipAuthCheck || resolved.skipPrereqCheck) {
    return { ok: true, tool: "claude", message: "Skipped" };
  }
  const exists = await commandExists("claude", resolved.runCommand);
  if (!exists) {
    return {
      ok: false,
      tool: "claude",
      message: "claude CLI is not installed",
      hint: "Required on the host in every run mode: setup mints and " +
        "validates the worker's OAuth token with `claude setup-token` " +
        "(Issue #4161). Install from: " +
        "https://docs.anthropic.com/en/docs/claude-code",
    };
  }
  return { ok: true, tool: "claude", message: "claude CLI is installed" };
}

/** Check that Deno is installed. */
export async function checkDeno(
  opts: PrerequisiteOptions = {},
): Promise<PrerequisiteResult> {
  const resolved = resolveOptions(opts);
  if (resolved.skipPrereqCheck) {
    return { ok: true, tool: "deno", message: "Skipped" };
  }
  const exists = await commandExists("deno", resolved.runCommand);
  if (!exists) {
    const os = detectOs(resolved.os);
    const hint = os === "darwin"
      ? "Install with: brew install deno"
      : "Install from: https://deno.com/";
    return { ok: false, tool: "deno", message: "deno is not installed", hint };
  }
  return { ok: true, tool: "deno", message: "deno is installed" };
}

/** Check that jq is installed. */
export async function checkJq(
  opts: PrerequisiteOptions = {},
): Promise<PrerequisiteResult> {
  const resolved = resolveOptions(opts);
  if (resolved.skipPrereqCheck) {
    return { ok: true, tool: "jq", message: "Skipped" };
  }
  const exists = await commandExists("jq", resolved.runCommand);
  if (!exists) {
    const os = detectOs(resolved.os);
    const hint = os === "darwin"
      ? "Install with: brew install jq"
      : "Install with: apt install jq (Linux)";
    return { ok: false, tool: "jq", message: "jq is not installed", hint };
  }
  return { ok: true, tool: "jq", message: "jq is installed" };
}

/** Check that timeout (or gtimeout on macOS) is installed. */
export async function checkTimeout(
  opts: PrerequisiteOptions = {},
): Promise<PrerequisiteResult> {
  const resolved = resolveOptions(opts);
  if (resolved.skipPrereqCheck) {
    return { ok: true, tool: "timeout", message: "Skipped" };
  }
  const hasTimeout = await commandExists("timeout", resolved.runCommand);
  if (hasTimeout) {
    return { ok: true, tool: "timeout", message: "timeout is installed" };
  }
  const hasGtimeout = await commandExists("gtimeout", resolved.runCommand);
  if (hasGtimeout) {
    return {
      ok: true,
      tool: "timeout",
      message: "gtimeout is installed (macOS)",
    };
  }
  const os = detectOs(resolved.os);
  const hint = os === "darwin"
    ? "Install with: brew install coreutils"
    : "Install with: apt install coreutils (Linux)";
  return {
    ok: false,
    tool: "timeout",
    message: "timeout command is not installed",
    hint,
  };
}

// ── Container software the worker needs (Issue #4117) ───────────────────

/** The checkout this module was loaded from — the default container root. */
function defaultRepoRoot(): string {
  return new URL("../../../", import.meta.url).pathname;
}

/**
 * Check the container software a container-only host needs.
 *
 * Two host-fatal results: the container runtime must be installed *and*
 * answering its probe, and the worker image must be present locally or
 * buildable from the committed container definition. Nothing here falls back
 * to running the worker on the host — that mode no longer exists.
 *
 * @param opts - Skip flags, platform, probe and command-runner overrides
 * @returns One result for the runtime and one for the worker image
 */
/**
 * Probe the container runtime, keeping the descriptor when one was selected.
 *
 * The single source of truth for the `container runtime` result: the full
 * container check needs the descriptor to inspect the image, while
 * {@link checkContainerRuntime} needs only the result.
 */
async function probeContainerRuntime(
  resolved: PrerequisiteOptions,
): Promise<
  { result: PrerequisiteResult; descriptor?: ContainerRuntimeDescriptor }
> {
  try {
    const descriptor = await detectContainerRuntime({
      platform: resolved.os ?? Deno.build.os,
      probe: resolved.containerProbe,
    });
    return {
      descriptor,
      result: {
        ok: true,
        tool: "container runtime",
        message:
          `${descriptor.displayName} is installed and answering (${descriptor.executable})`,
      },
    };
  } catch (error) {
    const [summary, ...rest] = (error as Error).message.split("\n");
    return {
      result: {
        ok: false,
        tool: "container runtime",
        message: summary ?? "No supported container runtime is available",
        hint: rest.join("\n").trim(),
      },
    };
  }
}

/**
 * Check the container runtime on its own (Issue #4137).
 *
 * The interactive installer re-runs exactly this after installing or starting
 * a runtime, so the fresh probe — never the install's exit code — decides
 * whether the check passes in the same setup run.
 *
 * @param opts - The same probe options the original run used
 * @returns The container-runtime result
 */
export async function checkContainerRuntime(
  opts: PrerequisiteOptions = {},
): Promise<PrerequisiteResult> {
  const resolved = resolveOptions(opts);
  if (resolved.skipPrereqCheck) {
    return {
      ok: true,
      tool: "container runtime",
      message: "Skipped (VIBE_SKIP_PREREQ_CHECK)",
    };
  }
  return (await probeContainerRuntime(resolved)).result;
}

export async function checkContainerPrerequisites(
  opts: PrerequisiteOptions = {},
): Promise<PrerequisiteResult[]> {
  const resolved = resolveOptions(opts);
  if (resolved.skipPrereqCheck) {
    return [{
      ok: true,
      tool: "container",
      message: "Skipped (VIBE_SKIP_PREREQ_CHECK)",
    }];
  }

  const { result: runtimeResult, descriptor } = await probeContainerRuntime(
    resolved,
  );
  if (!descriptor) return [runtimeResult];

  const repoRoot = resolved.repoRoot ?? defaultRepoRoot();
  let image: string;
  try {
    // The tag covers this deployment's own selections (Issue #743): resolving
    // it from the checkout alone reported an image the launcher never builds,
    // so a host whose image *was* built read "not built yet".
    const selection = await readDeploymentImageSelection(
      resolveDeploymentConfigFile(
        repoRoot,
        resolved.configPath,
        (name) => Deno.env.get(name),
      ),
    );
    image = await resolveContainerImageReference(repoRoot, selection);
  } catch (error) {
    return [runtimeResult, {
      ok: false,
      tool: "worker image",
      message: `The worker image is not buildable: ${(error as Error).message}`,
      hint:
        `Restore the container definition under ${
          repoRoot.replace(/[/\\]+$/, "")
        }/container/ (Containerfile, entrypoint.sh, tools.json, providers), ` +
        `and fix any container_tools selection the message names — the ` +
        `worker runs only inside the image it builds from them.`,
    }];
  }

  const runner = resolved.runCommand ?? defaultRunCommand;
  let present = false;
  try {
    const inspect = await runner([
      descriptor.executable,
      ...descriptor.dialect.imageInspectArgs,
      image,
    ]);
    present = inspect.success;
  } catch {
    // An inspect that cannot run leaves the image "not built yet" — the
    // launcher builds it on first run, so this is not a host gap.
    present = false;
  }

  return [runtimeResult, {
    ok: true,
    tool: "worker image",
    message: present
      ? `Worker image ${image} is built`
      : `Worker image ${image} is not built yet — the launcher builds it on ` +
        `first run`,
  }];
}

/**
 * Mark a container-owned tool's result as informational.
 *
 * The image owns these tools, so a container host that lacks them is correctly
 * provisioned, not broken — the result is reported and never fatal.
 */
function asContainerOwned(result: PrerequisiteResult): PrerequisiteResult {
  if (result.ok) return { ...result, informational: true };
  return {
    ...result,
    informational: true,
    message: `${result.message} on the host — the container image provides it`,
    hint: "No action needed: container-only is the supported run mode.",
  };
}

/**
 * Tools the container image owns — informational in container mode.
 *
 * `claude` is deliberately NOT here (Issue #4161): the image carries its own
 * copy for the worker, but setup needs the host CLI to mint the worker's
 * OAuth token (`claude setup-token`) and to validate it. A container-mode
 * host without claude cannot finish setup, so the check stays fatal and the
 * auto-install driver offers the Homebrew cask.
 */
const CONTAINER_OWNED_TOOLS: ReadonlySet<string> = new Set([
  "jq",
  "timeout",
]);

/**
 * Apply the mode's classification to one raw result.
 *
 * The single place the classification lives, so no caller can classify a tool
 * one way in the aggregate and another way after an install (Issue #4149).
 * Container is the only mode (Issue #4): the image-owned tools are
 * informational, everything else is host-fatal.
 *
 * @param result - A raw check result, before any classification
 * @param _runMode - The resolved run mode (container)
 * @returns The result, wrapped as informational when the image provides it
 */
function classifyForMode(
  result: PrerequisiteResult,
  _runMode: RunMode,
): PrerequisiteResult {
  return CONTAINER_OWNED_TOOLS.has(result.tool)
    ? asContainerOwned(result)
    : result;
}

/**
 * Report whether one result can fail setup.
 *
 * Belt and braces over the `informational` flag: the classification follows the
 * mode, so a result assembled without the flag still cannot fail on a tool
 * the image provides.
 *
 * @param result - The result to classify
 * @param _runMode - The resolved run mode (container)
 * @returns True when a failure of this result must fail setup
 */
export function isFatalInMode(
  result: PrerequisiteResult,
  _runMode: RunMode,
): boolean {
  if (result.informational) return false;
  return !CONTAINER_OWNED_TOOLS.has(result.tool);
}

/** The single-tool checks {@link recheckPrerequisite} can re-run. */
const SINGLE_TOOL_CHECKS: Readonly<
  Record<string, (opts: PrerequisiteOptions) => Promise<PrerequisiteResult>>
> = {
  git: checkGit,
  gh: checkGhAuth,
  deno: checkDeno,
  claude: checkClaudeCli,
  jq: checkJq,
  timeout: checkTimeout,
  "container runtime": checkContainerRuntime,
};

/**
 * Re-run the probe for a single tool (Issue #4135).
 *
 * The interactive installer calls this after an install so the fresh probe —
 * never "the command exited zero" — decides whether the prerequisite is now
 * satisfied (Issue #3234). The result keeps the classification the resolved
 * mode gives it, exactly as {@link checkAllPrerequisites} reports it.
 *
 * @param tool - Tool name as the probe reports it (`jq`, `gh`, …)
 * @param opts - The same probe options the original run used
 * @returns The fresh result, or `null` when the tool has no single-tool check
 */
export async function recheckPrerequisite(
  tool: string,
  opts: PrerequisiteOptions = {},
): Promise<PrerequisiteResult | null> {
  const check = SINGLE_TOOL_CHECKS[tool.trim().toLowerCase()];
  if (!check) return null;
  const resolved = resolveOptions(opts);
  return classifyForMode(await check(resolved), resolved.runMode);
}

/**
 * Aggregate prerequisite results into a single pass/fail.
 *
 * Only the results the resolved mode needs on the host decide the outcome;
 * everything else is informational and never fails the run (Issues #4117,
 * #4149).
 *
 * @param results - Every prerequisite result from one probe
 * @param runMode - The resolved run mode; defaults to the host's own
 * @returns True when every result fatal in this mode passed
 */
export function aggregatePrerequisiteOk(
  results: readonly PrerequisiteResult[],
  runMode: RunMode = resolveRunMode(),
): boolean {
  return results.filter((r) => isFatalInMode(r, runMode)).every((r) => r.ok);
}

/**
 * Configure git identity (user.name and user.email) from GitHub CLI.
 *
 * Reads the authenticated user's profile via `gh api user` and configures
 * git globally if user.name or user.email are not already set.
 *
 * When the GitHub profile has no public email, falls back to the
 * `<login>@users.noreply.github.com` address.
 */
export async function configureGitIdentity(
  opts: PrerequisiteOptions = {},
): Promise<GitIdentityResult> {
  const resolved = resolveOptions(opts);
  if (resolved.skipPrereqCheck) {
    return { ok: true, message: "Skipped (VIBE_SKIP_PREREQ_CHECK)" };
  }

  const runner = resolved.runCommand ?? defaultRunCommand;

  // Check if git identity is already configured
  const nameResult = await runner([
    "git",
    "config",
    "--global",
    "--get",
    "user.name",
  ]);
  const emailResult = await runner([
    "git",
    "config",
    "--global",
    "--get",
    "user.email",
  ]);

  if (
    nameResult.success && nameResult.stdout && emailResult.success &&
    emailResult.stdout
  ) {
    return {
      ok: true,
      message:
        `Git identity already configured: ${nameResult.stdout} <${emailResult.stdout}>`,
    };
  }

  // Fetch user info from GitHub
  const ghResult = await runner(["gh", "api", "user"]);
  if (!ghResult.success) {
    return {
      ok: false,
      message: "Failed to fetch GitHub user info — ensure gh is authenticated",
    };
  }

  let userInfo: { login?: string; name?: string; email?: string };
  try {
    userInfo = JSON.parse(ghResult.stdout);
  } catch {
    return { ok: false, message: "Failed to parse GitHub user info response" };
  }

  const login = userInfo.login ?? "";
  const userName = userInfo.name || login;
  const userEmail = userInfo.email || `${login}@users.noreply.github.com`;

  // Set git user.name if not already set
  if (!nameResult.success || !nameResult.stdout) {
    const setNameResult = await runner([
      "git",
      "config",
      "--global",
      "user.name",
      userName,
    ]);
    if (!setNameResult.success) {
      return { ok: false, message: "Failed to set git user.name" };
    }
  }

  // Set git user.email if not already set
  if (!emailResult.success || !emailResult.stdout) {
    const setEmailResult = await runner([
      "git",
      "config",
      "--global",
      "user.email",
      userEmail,
    ]);
    if (!setEmailResult.success) {
      return { ok: false, message: "Failed to set git user.email" };
    }
  }

  return {
    ok: true,
    message: `Git identity configured: ${userName} <${userEmail}>`,
  };
}

/**
 * Probe the container software the resolved mode cares about.
 *
 * Container mode needs a working runtime *and* a present-or-buildable image,
 * so both are probed and both are host-fatal. Containment is mandatory
 * (Issue #4): there is no other mode.
 */
async function checkContainerSoftware(
  resolved: ResolvedPrerequisiteOptions,
): Promise<PrerequisiteResult[]> {
  return await checkContainerPrerequisites(resolved);
}

/**
 * Run all prerequisite checks for the resolved run mode.
 *
 * Setup's own tools (`git`, an authenticated `gh`, `deno`) are host-fatal;
 * container mode makes the container runtime and worker image fatal and `jq`
 * and `timeout` informational (Issue #4117) — the image provides them.
 */
export async function checkAllPrerequisites(
  opts: PrerequisiteOptions = {},
): Promise<AllPrerequisitesResult> {
  const resolved = resolveOptions(opts);

  if (resolved.skipPrereqCheck) {
    return {
      ok: true,
      results: [{
        ok: true,
        tool: "all",
        message: "Skipped prerequisite checks",
      }],
    };
  }

  const [setupTools, containerResults, agentTools] = await Promise.all([
    Promise.all([
      checkGit(resolved),
      checkGhAuth(resolved),
      checkDeno(resolved),
    ]),
    checkContainerSoftware(resolved),
    Promise.all([
      checkClaudeCli(resolved),
      checkJq(resolved),
      checkTimeout(resolved),
    ]),
  ]);

  const results = [...setupTools, ...containerResults, ...agentTools]
    .map((result) => classifyForMode(result, resolved.runMode));
  return { ok: aggregatePrerequisiteOk(results, resolved.runMode), results };
}
