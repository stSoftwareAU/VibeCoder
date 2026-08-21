/**
 * container-launch-plan command (Issue #4065).
 *
 * Emits everything `run.sh` (and, from Issue #4066, `run.ps1`) needs to launch
 * the worker container: the runtime executable, the content-derived image
 * reference, the host directories to create, and the exact argument lists for
 * the image-presence check, the build and the run. The launcher executes the
 * plan and does no deciding of its own, so the containment contract lives in
 * one auditable module instead of two shells.
 *
 * Usage:
 *   deno run --allow-env --allow-read --allow-run --allow-write=/tmp/plan \
 *     mod.ts container-launch-plan --base-dir /repo/root \
 *     --container-name vibe-coder-1234 --out /tmp/plan
 *
 * The plan is written to `--out` as a NUL-delimited `key=value` stream, not
 * printed: stdout passes through the console secret redaction (Issue #3661),
 * which would mangle a mount value that looks like a credential. Stdout
 * carries only a one-line human summary. A missing runtime, a missing
 * configuration file, a missing credential directory or a mount the
 * containment contract forbids all exit non-zero with a named, actionable
 * message — there is no host fallback (Issue #3234).
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import type { Command, CommandResult } from "../types.ts";
import {
  buildContainerLaunchPlan,
  type ContainerLaunchPlan,
  renderContainerLaunchPlan,
  resolveContainerLaunchHostPaths,
  resolveContainerResources,
} from "../lib/container_launch.ts";
import {
  stripContainerfile,
  STRIPPED_CONTAINERFILE_SUFFIX,
} from "../lib/containerfile_strip.ts";
import { detectContainerRuntime } from "../lib/container_runtime.ts";
import { resolveWatchdogSeconds } from "../lib/container_watchdog.ts";
import { formatGb, probeDiskReading } from "../lib/host_disk.ts";
import { DEFAULT_MAX_RUN_SECONDS } from "../lib/run_entrypoint.ts";
import { emitSelfHealEventAuto } from "../lib/self_heal_events.ts";
import { parseContainerManifest } from "../lib/container_manifest.ts";
import { resolveContainerImageReference } from "../lib/container_image_hash.ts";
import {
  AGENT_PROVIDER_CONFIG_KEY,
  ENABLED_AGENT_PROVIDERS_CONFIG_KEY,
  enabledAgentProviders,
} from "../lib/agent_provider.ts";

/** What the command reports alongside the rendered plan. */
export interface ContainerLaunchPlanResult {
  runtime: string;
  image: string;
  containerName: string;
  mounts: { source: string; target: string; readOnly: boolean }[];
  runArgs: string[];
}

/** Assert a host path the container needs is already present. */
async function assertPresent(
  path: string,
  kind: "file" | "directory",
  remedy: string,
): Promise<void> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`Cannot launch: ${path} does not exist. ${remedy}`);
    }
    throw new Error(
      `Cannot launch: ${path} is unreadable (${(error as Error).message}). ` +
        remedy,
    );
  }

  const matches = kind === "file" ? info.isFile : info.isDirectory;
  if (!matches) {
    throw new Error(`Cannot launch: ${path} is not a ${kind}. ${remedy}`);
  }
}

/**
 * Read the provider selection out of `.config.json` (Issue #4108).
 *
 * The launcher runs on the host, before the worker loads its configuration,
 * so the enabled set has to be read here — otherwise the plan would mount the
 * default provider's credentials whatever the deployment enabled.
 *
 * @param configFile - Host path of the worker configuration file.
 * @returns The configured active provider and enabled set, when set.
 * @throws When the file is unparseable or either key has the wrong shape —
 *   a launch must not silently fall back to the default set (Issue #3234).
 */
export async function readAgentProviderSelection(
  configFile: string,
): Promise<{ configured?: string; configuredProviders?: string[] }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Deno.readTextFile(configFile));
  } catch (error) {
    throw new Error(
      `Cannot launch: ${configFile} is not readable JSON ` +
        `(${(error as Error).message}). Fix it, or re-run ./setup.sh.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Cannot launch: ${configFile} does not hold a JSON object.`,
    );
  }

  const record = parsed as Record<string, unknown>;
  const active = record[AGENT_PROVIDER_CONFIG_KEY];
  if (active !== undefined && typeof active !== "string") {
    throw new Error(
      `Cannot launch: ${configFile} key "${AGENT_PROVIDER_CONFIG_KEY}" must ` +
        `be a string.`,
    );
  }
  const enabled = record[ENABLED_AGENT_PROVIDERS_CONFIG_KEY];
  if (
    enabled !== undefined &&
    (!Array.isArray(enabled) || enabled.some((id) => typeof id !== "string"))
  ) {
    throw new Error(
      `Cannot launch: ${configFile} key ` +
        `"${ENABLED_AGENT_PROVIDERS_CONFIG_KEY}" must be an array of ` +
        `provider ids.`,
    );
  }

  return {
    configured: active as string | undefined,
    configuredProviders: enabled as string[] | undefined,
  };
}

/** Build the plan for one launch. Separated so the tests can call it. */
export async function buildLaunchPlanForCommand(
  baseDir: string,
  containerName: string,
  options: {
    /**
     * Where to write the comment-stripped Containerfile the build reads
     * (Issue #4393). When set, the plan's `--file` names it; when absent
     * the plan builds from the committed file.
     */
    strippedContainerfile?: string;
  } = {},
): Promise<ContainerLaunchPlan> {
  const [descriptor, image, manifestText] = await Promise.all([
    // The launch path opts into the service self-heal (Issue #4253): a
    // stopped apiserver kept host-25 dark ~5 h across 21 launcher runs when
    // one bounded `container system start` would have fixed it. Progress
    // lines go to STDERR — stdout carries the JSON plan run.sh consumes.
    detectContainerRuntime({
      selfHeal: true,
      log: (message) => console.error(message),
      emitSelfHealEvent: (event) => emitSelfHealEventAuto(event),
    }),
    resolveContainerImageReference(baseDir),
    Deno.readTextFile(`${baseDir}/container/tools.json`),
  ]);

  const manifest = parseContainerManifest(manifestText);
  const hostPaths = resolveContainerLaunchHostPaths(
    baseDir,
    (name) => Deno.env.get(name),
  );

  // Read before the plan is built: the configuration decides which providers
  // are enabled, and therefore which credential directories are mounted.
  await assertPresent(
    hostPaths.configFile,
    "file",
    "Run ./setup.sh to create it, or set CONFIG_PATH.",
  );
  const selection = await readAgentProviderSelection(hostPaths.configFile);

  // Stage the configuration into its own directory for the read-only mount.
  // Apple container cannot mount a single file (a file mount silently
  // empties the other volumes), so the mount is a directory holding a fresh
  // copy — also snapshot semantics: the running worker reads the config as
  // launched, whatever happens to the original mid-run.
  await Deno.mkdir(hostPaths.configStageDir, { recursive: true });
  const stagedConfig = `${hostPaths.configStageDir}/.config.json`;
  await Deno.copyFile(hostPaths.configFile, stagedConfig);
  if (Deno.build.os !== "windows") {
    await Deno.chmod(hostPaths.configStageDir, 0o700);
    await Deno.chmod(stagedConfig, 0o600);
  }

  // The host's own name, for fleet telemetry inside the container
  // (VIBE_HOST_ID). Best-effort: an unreadable hostname just omits the env
  // and the worker falls back to its own (container) hostname.
  let hostId: string | undefined;
  try {
    hostId = Deno.hostname().split(".")[0] || undefined;
  } catch {
    hostId = undefined;
  }

  // The host filesystem's free space (Issue #226), measured where the
  // container store lives — VIBE_HOST_STORE_PATH, else the home directory,
  // which on macOS shares the Data volume with the store. Best-effort: an
  // unreadable df just omits the env and the worker does not gate.
  let hostDisk: { availableBytes: number; totalBytes: number } | undefined;
  try {
    const storePath = Deno.env.get("VIBE_HOST_STORE_PATH")?.trim() ||
      Deno.env.get("HOME")?.trim() || ".";
    const reading = await probeDiskReading(storePath);
    if (reading) {
      hostDisk = {
        availableBytes: reading.availableBytes,
        totalBytes: reading.totalBytes,
      };
      console.error(
        `container-launch-plan: host disk ${
          formatGb(reading.availableBytes)
        } free of ${formatGb(reading.totalBytes)} at ${storePath}`,
      );
    }
  } catch {
    hostDisk = undefined;
  }

  // Host-aware VM sizing. systemMemoryInfo needs its --allow-sys entry in
  // the launchers; an unreadable value falls back to the floor (with a
  // stderr note), never to the runtime's 1 GiB default.
  let totalMemoryBytes: number | undefined;
  try {
    totalMemoryBytes = Deno.systemMemoryInfo().total;
  } catch (error) {
    console.error(
      `container-launch-plan: could not read host memory (${
        (error as Error).message
      }) — using the 8g floor`,
    );
  }
  const resources = resolveContainerResources({
    env: (name) => Deno.env.get(name),
    ...(totalMemoryBytes !== undefined ? { totalMemoryBytes } : {}),
    cpuCount: navigator.hardwareConcurrency,
  });

  // The launcher's outer deadline (Issue #4173): the worker's own maximum run
  // duration plus a margin, so the host only steps in once the container has
  // demonstrably failed to stop itself.
  const watchdogSeconds = resolveWatchdogSeconds({
    env: (name) => Deno.env.get(name),
    maxRunSeconds: DEFAULT_MAX_RUN_SECONDS,
  });

  // Build from a comment-stripped copy (Issue #4393): Apple container caps
  // a Dockerfile at 16 KB and the committed file is mostly comments. The
  // copy is written beside the plan file (the launchers grant write access
  // to exactly that path) and removed with it.
  let containerfile: string | undefined;
  if (options.strippedContainerfile) {
    const original = await Deno.readTextFile(
      `${baseDir}/container/Containerfile`,
    );
    await Deno.writeTextFile(
      options.strippedContainerfile,
      stripContainerfile(original),
    );
    containerfile = options.strippedContainerfile;
  }

  const plan = buildContainerLaunchPlan({
    descriptor,
    manifest,
    image,
    containerName,
    watchdogSeconds,
    hostPaths,
    agentProviders: enabledAgentProviders(selection),
    ...(hostId ? { hostId } : {}),
    ...(hostDisk ? { hostDisk } : {}),
    resources,
    ...(containerfile ? { containerfile } : {}),
  });

  // Every read-only mount must exist on the host: a runtime asked to bind a
  // missing path invents an empty root-owned directory, which would surface
  // later as a confusing credential failure inside the container. Driven off
  // the plan itself, so the credential sub-directories the enabled providers
  // need are checked without naming any provider here (Issues #4067, #4108).
  for (const mount of plan.mounts) {
    if (!mount.readOnly) continue;
    await assertPresent(
      mount.source,
      "directory",
      "Run ./setup.sh to provision the Vibe credentials (Issue #4064), or " +
        "set VIBE_CREDENTIAL_DIR.",
    );
  }

  return plan;
}

export const containerLaunchPlanCommand: Command = {
  name: "container-launch-plan",
  description:
    "Emit the least-privilege container launch plan for the launchers " +
    "(Issue #4065)",
  async execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult<ContainerLaunchPlanResult>> {
    const baseDir = typeof args["base-dir"] === "string"
      ? (args["base-dir"] as string)
      : Deno.cwd();
    const containerName = typeof args["container-name"] === "string"
      ? (args["container-name"] as string)
      : "vibe-coder";
    const out = typeof args["out"] === "string"
      ? (args["out"] as string)
      : undefined;

    try {
      if (!out) {
        throw new Error(
          "container-launch-plan requires --out <path>: the plan is written " +
            "to a file so the console secret redaction cannot mangle it.",
        );
      }

      const plan = await buildLaunchPlanForCommand(baseDir, containerName, {
        strippedContainerfile: `${out}${STRIPPED_CONTAINERFILE_SUFFIX}`,
      });
      await Deno.writeTextFile(out, renderContainerLaunchPlan(plan));

      return {
        success: true,
        message: `${plan.image} via ${plan.runtime} ` +
          `(${plan.mounts.length} mounts, container ${plan.containerName})`,
        data: {
          runtime: plan.runtime,
          image: plan.image,
          containerName: plan.containerName,
          mounts: plan.mounts.map((mount) => ({
            source: mount.source,
            target: mount.target,
            readOnly: mount.readOnly === true,
          })),
          runArgs: plan.runArgs,
        },
      };
    } catch (error) {
      // Fail loud: the launcher prints this and exits non-zero rather than
      // falling back to running the worker on the host.
      return { success: false, message: (error as Error).message };
    }
  },
};
