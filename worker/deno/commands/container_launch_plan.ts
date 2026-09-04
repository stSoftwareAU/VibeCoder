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
  type ContainerExtensionLaunch,
  type ContainerLaunchPlan,
  renderContainerLaunchPlan,
  resolveContainerLaunchHostPaths,
  resolveContainerResources,
} from "../lib/container_launch.ts";
import { joinPath, pathStyleFor } from "../lib/host_path_style.ts";
import {
  stripContainerfile,
  STRIPPED_CONTAINERFILE_SUFFIX,
} from "../lib/containerfile_strip.ts";
import { detectContainerRuntime } from "../lib/container_runtime.ts";
import { resolveWatchdogSeconds } from "../lib/container_watchdog.ts";
import { readRunCapPassthrough } from "../lib/run_hard_cap.ts";
import { formatGb, probeDiskReading } from "../lib/host_disk.ts";
import { DEFAULT_MAX_RUN_SECONDS } from "../lib/run_entrypoint.ts";
import { emitSelfHealEventAuto } from "../lib/self_heal_events.ts";
import { parseContainerManifest } from "../lib/container_manifest.ts";
import { resolveContainerImageReference } from "../lib/container_image_hash.ts";
import { readConfiguredAgentProviderSet } from "../lib/agent_provider_config.ts";
import { readContainerExtensionSelection } from "../lib/container_extension_config.ts";
import { readContainerToolsSelection } from "../lib/container_tools_config.ts";
import { readConfiguredCustomPromptPaths } from "../lib/custom_label_prompts_config.ts";
import { assertCustomPromptSourceResolvable } from "../lib/custom_prompt_mounts.ts";
import {
  readConfiguredDiskFloors,
  resolveDiskFloors,
} from "../lib/host_disk.ts";

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
  const [descriptor, manifestText] = await Promise.all([
    // The launch path opts into the service self-heal (Issue #4253): a
    // stopped apiserver kept host-25 dark ~5 h across 21 launcher runs when
    // one bounded `container system start` would have fixed it. Progress
    // lines go to STDERR — stdout carries the JSON plan run.sh consumes.
    detectContainerRuntime({
      selfHeal: true,
      log: (message) => console.error(message),
      emitSelfHealEvent: (event) => emitSelfHealEventAuto(event),
    }),
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
  // One resolution of the enabled set for the whole launch (Issue #729): the
  // credential mounts, the build argument and the image tag all come from this
  // value, so a `.config.json` selection cannot mean one provider set to the
  // mounts and another to the build — which is exactly the reported defect.
  const { providers, buildValue: agentProviders } =
    await readConfiguredAgentProviderSet(
      hostPaths.configFile,
      manifest.installedProviders,
    );

  // The launcher runs on the host, before the worker loads its configuration,
  // so the tool selection is read here (Issue #72). Validation is fail-loud at
  // plan time (#69): a malformed spec stops the launch rather than reaching the
  // image build. The deployer's own spec is carried verbatim (compact), never a
  // re-serialised normalisation, so install-tools.sh (#70) parses exactly what
  // was written.
  const { tools, specJson: containerToolsSpecJson } =
    await readContainerToolsSelection(hostPaths.configFile);

  // The claiming floor, resolved where the deployment's configuration can be
  // read (Issue #732): `.config.json` wins over the environment override,
  // which wins over the default — the same precedence every other knob keeps
  // (Issue #289). `run.sh` had the environment and nothing else, so a floor
  // stated in the file would have been ignored by the launcher's own disk
  // decisions while the worker honoured it.
  const claimFloors = resolveDiskFloors(
    (name) => Deno.env.get(name),
    await readConfiguredDiskFloors(hostPaths.configFile),
  );

  // The operator's own prompt templates live on the host (Issue #850), so the
  // launcher reads the mappings here — before any worker has loaded a
  // configuration — and the plan mounts each containing directory read-only.
  // A malformed block stops the launch rather than starting a container in
  // which every custom label would fail at dispatch.
  const customPromptPaths = await readConfiguredCustomPromptPaths(
    hostPaths.configFile,
  );
  // The mount-source allowlist compares strings, and a configured prompt path
  // is the only mount source an operator writes by hand — so a `..` segment or
  // a symlink would hand the runtime a directory the allowlist never judged.
  // Refused here, naming where it resolves, rather than mounted.
  for (const promptPath of customPromptPaths) {
    assertCustomPromptSourceResolvable(
      promptPath,
      (path) => Deno.realPathSync(path),
    );
  }

  // The deployment's private extension is baked into the image too (Issue
  // #979): its Containerfile builds `FROM` the standard one, so its contents
  // are part of what the tag names.
  const containerExtension = await readContainerExtensionSelection(
    hostPaths.configFile,
  );

  // The selected tools and providers are baked into the image, so they are part
  // of its identity (Issues #73, #729) — the plan must name the tag the build
  // produces, not one another deployment's cache would satisfy. This is the
  // **standard** image: the extension layers on top of it under its own tag
  // (Issue #980), and both are content-derived.
  const image = await resolveContainerImageReference(baseDir, {
    containerTools: tools,
    ...(agentProviders ? { agentProviders } : {}),
  });

  // The operator's private layer (Issue #980, parent #933): a second,
  // content-derived tag covering the same inputs *plus* the extension digest,
  // and the Containerfile text the plan refuses before any build runs when it
  // does not derive `FROM ${VIBE_BASE_IMAGE}`.
  let extension: ContainerExtensionLaunch | undefined;
  if (containerExtension) {
    const style = pathStyleFor(hostPaths.baseDir);
    const containerfilePath = joinPath(
      containerExtension.path,
      containerExtension.containerfile,
      style,
    );
    let containerfileText: string;
    try {
      containerfileText = await Deno.readTextFile(containerfilePath);
    } catch (error) {
      throw new Error(
        `Cannot launch: the container_extension Containerfile ` +
          `${containerfilePath} is unreadable (${(error as Error).message}). ` +
          `The operator syncs their own extension into ` +
          `${containerExtension.path}.`,
      );
    }
    extension = {
      spec: containerExtension,
      image: await resolveContainerImageReference(baseDir, {
        containerTools: tools,
        ...(agentProviders ? { agentProviders } : {}),
        containerExtension,
      }),
      containerfileText,
    };
  }

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

  // The supervisor's wall-clock cap (Issue #421), forwarded so the worker's
  // progress-extension policy can stop the run before loop.sh's `timeout`
  // does. Absent — run.sh invoked outside loop.sh — means no ceiling inside
  // the container, exactly as before.
  const runCap = readRunCapPassthrough((name) => Deno.env.get(name));

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
    claimFloors,
    descriptor,
    manifest,
    image,
    containerName,
    watchdogSeconds,
    hostPaths,
    agentProviders: providers,
    ...(customPromptPaths.length > 0 ? { customPromptPaths } : {}),
    ...(containerToolsSpecJson ? { containerToolsSpecJson } : {}),
    ...(hostId ? { hostId } : {}),
    ...(hostDisk ? { hostDisk } : {}),
    ...(runCap ? { runCap } : {}),
    resources,
    ...(containerfile ? { containerfile } : {}),
    ...(extension ? { containerExtension: extension } : {}),
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
