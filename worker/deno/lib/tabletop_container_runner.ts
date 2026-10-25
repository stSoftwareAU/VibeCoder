/**
 * The containerised runner for the tabletop harness (Issue #4194).
 *
 * Runs each hostile fixture inside the container the launcher itself builds:
 * the plan comes from `buildContainerLaunchPlan`, so every mount, privilege
 * and network flag under test is the one `run.sh` would pass. Only the
 * *process* is replaced (`--entrypoint bash`), exactly as
 * `container_containment_test.ts` does.
 *
 * The host side of the run is a throwaway fixture under a temporary
 * directory — a synthetic home, its own mount sources, its own volumes — so no
 * operator file is ever read, written or probed. Planted in it are:
 *
 * - the **canary credential**, in the read-only credential mount, shaped like
 *   a real GitHub token;
 * - an **outbox** and a **run log** in the mounted log directory, standing for
 *   the comment/PR and telemetry sinks;
 * - a **host probe path** outside every mount, and a **host secret** a
 *   committed symlink points at, so an escape has something to find;
 * - a **hostile clone** carrying a repository-supplied `pre-commit` hook.
 *
 * Nothing here decides whether a run passed: it reports what happened and
 * `tabletop_harness.ts` judges it. What it does refuse is running at all
 * without a container — no runtime, or no image, is a loud
 * {@link TabletopContainerUnavailableError}, never a host-mode fallback
 * (Issue #3234).
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import {
  buildContainerLaunchPlan,
  type ContainerLaunchPlan,
  containerTargetPaths,
  resolveContainerLaunchHostPaths,
} from "./container_launch.ts";
import {
  type ContainerRuntimeDescriptor,
  detectContainerRuntime,
} from "./container_runtime.ts";
import {
  type ContainerManifest,
  parseContainerManifest,
} from "./container_manifest.ts";
import { resolveContainerImageReference } from "./container_image_hash.ts";
import { readDeploymentImageSelection } from "./container_image_selection.ts";
import { GH_CREDENTIAL_SUBDIR } from "./credential_preflight.ts";
import { enabledAgentProviders } from "./agent_provider.ts";
import { readConfiguredAgentProviderSet } from "./agent_provider_config.ts";
import {
  type RuntimeRunner,
  startEgressSidecar,
  stopEgressSidecar,
} from "./container_egress.ts";
import { resolveEgressAllowlist } from "./egress_allowlist.ts";
import { type EnvLookup, processEnvLookup } from "./env_lookup.ts";
import { resolveHostConfigPath } from "./host_config_path.ts";
import {
  HOSTILE_PRE_COMMIT_HOOK,
  type TabletopFixture,
} from "./tabletop_fixtures.ts";
import type {
  TabletopArtefact,
  TabletopAttemptOutcome,
  TabletopAttemptStatus,
  TabletopRunner,
  TabletopRunOptions,
  TabletopRunOutcome,
} from "./tabletop_harness.ts";

/** Longest one fixture may take inside the container. */
const RUN_TIMEOUT_MS = 120_000;

/** Longest a read-only runtime query may take. */
const QUERY_TIMEOUT_MS = 30_000;

/** Default non-allowlisted host the egress fixture probes (no body sent). */
export const DEFAULT_EGRESS_PROBE_URL = "https://example.com";

/** Thrown when the fixtures cannot be run inside a container. */
export class TabletopContainerUnavailableError extends Error {
  constructor(reason: string) {
    super(
      `The tabletop harness cannot run containerised: ${
        reason.replace(/[.\s]+$/, "")
      }. It refuses ` +
        `to fall back to the host, because a host-mode run proves nothing ` +
        `about containment (Issue #4194).`,
    );
    this.name = "TabletopContainerUnavailableError";
  }
}

/** What the runner needs to know about the host it is driving. */
export interface TabletopContainerRunnerOptions {
  /** Repository root (the checkout the manifest and image hash come from). */
  readonly repoRoot: string;
  /** Image override; defaults to this checkout's content-derived reference. */
  readonly image?: string;
  /** Host the egress fixture probes. */
  readonly egressProbeUrl?: string;
  /**
   * Environment lookup the deployment's selections are read through
   * (Issue #962). Defaults to the process environment.
   */
  readonly env?: EnvLookup;
  /**
   * The runtime the runner drives. Production leaves it unset and gets the real
   * runtime; a test substitutes one so the order of the runtime calls, and the
   * sidecar's teardown, can be asserted without starting a container (Issue
   * #4047).
   */
  readonly runtime?: TabletopRuntime;
}

/** The two runtime calls the runner makes (Issue #4047). */
export interface TabletopRuntime {
  /** Finds the container runtime this host can drive. */
  detect(): Promise<ContainerRuntimeDescriptor>;
  /** Runs one runtime command with a bounded wait. */
  run(
    executable: string,
    args: string[],
    timeoutMs?: number,
  ): Promise<CommandResult>;
}

/** The outcome of one runtime command. */
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The real runtime, used unless a caller substitutes its own. */
const PRODUCTION_RUNTIME: TabletopRuntime = {
  detect: () => detectContainerRuntime(),
  run: runRuntime,
};

/** Run a runtime command with a bounded wait. */
async function runRuntime(
  executable: string,
  args: string[],
  timeoutMs = RUN_TIMEOUT_MS,
): Promise<CommandResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const output = await new Deno.Command(executable, {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    }).output();
    const decoder = new TextDecoder();
    return {
      code: output.code,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `\`${executable} ${args.join(" ")}\` did not finish within ${
          timeoutMs / 1000
        }s`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Create a directory every user can traverse (the container runs as uid 1000). */
async function makeSharedDir(path: string, mode = 0o755): Promise<void> {
  await Deno.mkdir(path, { recursive: true });
  await Deno.chmod(path, mode);
}

/** The throwaway host layout one tabletop run is driven from. */
interface HostFixture {
  root: string;
  logDir: string;
  outboxPath: string;
  runLogPath: string;
  hostProbePath: string;
  plan: ContainerLaunchPlan;
}

/**
 * Resolve the image digest, or state why it could not be resolved.
 *
 * Never throws: a missing digest is a weaker evidence line, not a reason to
 * abandon a run that otherwise proves containment.
 */
async function resolveImageDigest(
  runtime: TabletopRuntime,
  descriptor: ContainerRuntimeDescriptor,
  image: string,
): Promise<string> {
  try {
    const inspect = await runtime.run(
      descriptor.executable,
      [...descriptor.dialect.imageInspectArgs, image],
      QUERY_TIMEOUT_MS,
    );
    if (inspect.code !== 0) return "unavailable (image inspect failed)";
    const digest = /"(?:Id|Digest|digest)"\s*:\s*"([^"]+)"/.exec(
      inspect.stdout,
    );
    return digest?.[1] ?? "unavailable (no digest in the inspect document)";
  } catch (error) {
    return `unavailable (${(error as Error).message})`;
  }
}

/**
 * Copy a directory tree, skipping the named entries of its top level only.
 *
 * Symbolic links are refused rather than copied silently: a link could point
 * outside the tree the egress sidecar is meant to run from (Issue #4047).
 */
async function copyTree(
  from: string,
  to: string,
  skipTopLevel: readonly string[] = [],
): Promise<void> {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    if (skipTopLevel.includes(entry.name)) continue;
    const source = `${from}/${entry.name}`;
    const target = `${to}/${entry.name}`;
    if (entry.isDirectory) {
      await copyTree(source, target);
    } else if (entry.isFile) {
      await Deno.copyFile(source, target);
    } else {
      throw new Error(
        `${source} is not a plain file or directory, so the worker source ` +
          `copy for the egress sidecar cannot carry it.`,
      );
    }
  }
}

/** Whether a path exists, distinguishing "absent" from "unreadable". */
async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/** What building the host fixture needs beyond the image and the attempts. */
interface HostFixtureSetup {
  /** The runtime every runtime command goes through. */
  runtime: TabletopRuntime;
  /** Repository root the worker's own source is copied from (Issue #4047). */
  repoRoot: string;
  /** The egress allowlist the sidecar enforces. */
  egressAllowlist: readonly string[];
}

/** Build the host fixture and the launch plan that exposes it. */
async function buildHostFixture(
  descriptor: ContainerRuntimeDescriptor,
  manifest: ContainerManifest,
  image: string,
  token: string,
  canary: string,
  fixtures: readonly TabletopFixture[],
  setup: HostFixtureSetup,
): Promise<HostFixture> {
  const root = await Deno.makeTempDir({ prefix: "vibe-tabletop-" });
  await Deno.chmod(root, 0o755);

  const home = `${root}/home`;
  const checkout = `${root}/checkout`;
  await makeSharedDir(home);
  await makeSharedDir(checkout, 0o777);

  // Host material outside every mount: what an escape would be reaching for.
  const hostSecretPath = `${root}/host-secret.txt`;
  await Deno.writeTextFile(hostSecretPath, `host material ${token}\n`);
  const hostProbePath = `${root}/host-probe-${token}.txt`;

  const hostPaths = resolveContainerLaunchHostPaths(
    checkout,
    (name) => (name === "HOME" ? home : undefined),
  );
  await makeSharedDir(hostPaths.workDir, 0o777);
  await makeSharedDir(hostPaths.logDir, 0o777);
  await makeSharedDir(hostPaths.credentialDir);
  await makeSharedDir(`${hostPaths.credentialDir}/${GH_CREDENTIAL_SUBDIR}`);

  // The canary credential, in the read-only credential mount.
  const canaryPath =
    `${hostPaths.credentialDir}/${GH_CREDENTIAL_SUBDIR}/tabletop.canary`;
  await Deno.writeTextFile(canaryPath, canary);
  await Deno.chmod(canaryPath, 0o644);

  // The staged configuration directory the launcher mounts read-only.
  const configFile = `${checkout}/.config.json`;
  await Deno.writeTextFile(configFile, `{"tabletop": "${token}"}\n`);
  await makeSharedDir(hostPaths.configStageDir, 0o777);
  await Deno.copyFile(configFile, `${hostPaths.configStageDir}/.config.json`);

  // The attempts, and the hostile clone with its committed symlink and hook.
  await makeSharedDir(`${checkout}/tabletop`, 0o777);
  for (const fixture of fixtures) {
    const path = `${checkout}/tabletop/${fixture.id}.sh`;
    await Deno.writeTextFile(path, fixture.attempt);
    await Deno.chmod(path, 0o755);
  }
  const clone = `${checkout}/hostile-clone`;
  await makeSharedDir(clone, 0o777);
  await Deno.writeTextFile(
    `${clone}/hostile-pre-commit.sh`,
    HOSTILE_PRE_COMMIT_HOOK,
  );
  await Deno.chmod(`${clone}/hostile-pre-commit.sh`, 0o755);
  await Deno.symlink(hostSecretPath, `${clone}/escape-link`);

  const outboxPath = `${hostPaths.logDir}/tabletop-outbox.tsv`;
  const runLogPath = `${hostPaths.logDir}/tabletop-run.log`;
  await Deno.writeTextFile(outboxPath, "");
  await Deno.writeTextFile(runLogPath, "");
  await Deno.chmod(outboxPath, 0o666);
  await Deno.chmod(runLogPath, 0o666);

  const plan = buildContainerLaunchPlan({
    descriptor,
    manifest,
    image,
    containerName: `vibe-tabletop-${token}`,
    watchdogSeconds: 11_400,
    // The tabletop exercises containment, not the fleet build stamp
    // (Issue #1572): this container runs the harness, not a worker run.
    buildCommit: "unknown",
    hostPaths,
    volumes: {
      work: `vibe-tabletop-work-${token}`,
      approvalState: `vibe-tabletop-approval-${token}`,
      // Issue #1407: this was omitted while `agentState` was optional, so the
      // tabletop — an adversarial exercise — isolated two volumes and then
      // mounted the PRODUCTION `vibe-agent-state` for the third. Every volume
      // this container sees is per-run and thrown away with it.
      agentState: `vibe-tabletop-agent-${token}`,
    },
    egressAllowlist: setup.egressAllowlist,
    // Per-run names (Issue #4047): the tabletop can run on a host that is also
    // running a production worker, and its sidecar must never stop or remove
    // that worker's `vibe-coder-egress*` resources.
    egressNames: {
      network: `vibe-tabletop-egress-${token}`,
      proxy: `vibe-tabletop-egress-proxy-${token}`,
    },
  });

  // The egress sidecar runs the worker's own code from a read-only mount of the
  // checkout (Issue #4046), so the fixture carries a copy of it. The tests are
  // left out: the sidecar never reads them.
  if (plan.egress) {
    await copyTree(
      `${setup.repoRoot}/worker/deno`,
      `${checkout}/worker/deno`,
      ["tests"],
    );
  }

  for (const name of plan.volumes) {
    const created = await setup.runtime.run(
      descriptor.executable,
      ["volume", "create", name],
      QUERY_TIMEOUT_MS,
    );
    if (created.code !== 0) {
      throw new Error(
        `Could not create the throwaway volume ${name}: ${created.stderr}`,
      );
    }
  }
  const initialised = await setup.runtime.run(
    descriptor.executable,
    plan.initArgs,
  );
  if (initialised.code !== 0) {
    throw new Error(
      `The volume-ownership init failed (exit ${initialised.code}):\n` +
        initialised.stderr,
    );
  }

  return {
    root,
    logDir: hostPaths.logDir,
    outboxPath,
    runLogPath,
    hostProbePath,
    plan,
  };
}

/**
 * The plan's run arguments with only the process replaced.
 *
 * @param plan - The launch plan `run.sh` itself would execute.
 * @param containerName - Per-attempt container name.
 * @param env - `KEY=value` pairs the attempt reads its paths from.
 * @param command - The attempt to run inside the container.
 * @returns The runtime arguments for this attempt.
 * @throws When the plan's shape is not the one this runner expects — a
 *   silently mismatched argument list would probe a container nobody launches.
 */
export function attemptRunArgs(
  plan: ContainerLaunchPlan,
  containerName: string,
  env: readonly string[],
  command: readonly string[],
): string[] {
  const args = [...plan.runArgs];
  const image = args.pop();
  if (image !== plan.image) {
    throw new Error(
      `Expected the launch plan's last run argument to be the image ` +
        `${plan.image}, got ${JSON.stringify(image)}.`,
    );
  }
  const nameIndex = args.indexOf("--name");
  if (nameIndex < 0) {
    throw new Error("The launch plan does not name the container.");
  }
  args[nameIndex + 1] = containerName;
  const envFlags = env.flatMap((pair) => ["--env", pair]);
  return [...args, ...envFlags, "--entrypoint", "bash", image, ...command];
}

/**
 * Parse the `outcome` line an attempt reports about itself.
 *
 * @param stdout - Everything the attempt printed.
 * @returns The reported status, or an error when there is no usable line —
 *   silence is never success (Issue #3234).
 */
export function parseAttemptOutcome(
  stdout: string,
): { status: TabletopAttemptStatus; detail: string } {
  for (const line of stdout.split("\n")) {
    const parts = line.split("\t");
    if (parts[0] !== "outcome") continue;
    const status = parts[1];
    if (status === "achieved" || status === "refused" || status === "error") {
      return { status, detail: parts.slice(2).join("\t").trim() };
    }
    return {
      status: "error",
      detail: `unrecognised outcome status ${JSON.stringify(status ?? "")}`,
    };
  }
  return { status: "error", detail: "the attempt reported no outcome line" };
}

/**
 * Turn the outbox file into one artefact per sink.
 *
 * @param contents - Tab-separated `sink<TAB>body` lines.
 * @returns One artefact per sink, bodies joined in order.
 */
export function parseOutboxArtefacts(contents: string): TabletopArtefact[] {
  const bySink = new Map<string, string[]>();
  for (const line of contents.split("\n")) {
    if (line.trim() === "") continue;
    const tab = line.indexOf("\t");
    const sink = tab > 0 ? line.slice(0, tab) : "outbox";
    const body = tab > 0 ? line.slice(tab + 1) : line;
    bySink.set(sink, [...(bySink.get(sink) ?? []), body]);
  }
  return [...bySink].map(([sink, bodies]) => ({
    sink,
    body: bodies.join("\n"),
  }));
}

/** Read a file, treating absence as empty. */
async function readOrEmpty(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return "";
  }
}

/**
 * Build the production runner.
 *
 * @param options - Repository root and optional image/egress overrides.
 * @returns A runner that executes fixtures inside the real container.
 */
/**
 * The image this tabletop run drives (Issue #743).
 *
 * An explicit `--image` wins; otherwise the reference is derived from the
 * checkout **and the deployment's own selections**, so the runner asks for the
 * image `./run.sh` builds on this host rather than the default-configuration
 * one. Without the selections a host that picks tools or a provider set was
 * told to "build it with ./run.sh" — which builds a different tag.
 *
 * Separate from `run()` so it is testable: `run()` starts a real container and
 * no unit test may, but which image it asks for is exactly what this issue is
 * about.
 *
 * @param options - The runner's options, including the repository root
 * @returns The image reference to inspect and run
 * @throws When the configuration or the container definition cannot be read
 */
export async function resolveTabletopImage(
  options: TabletopContainerRunnerOptions,
): Promise<string> {
  const override = options.image?.trim();
  if (override) return override;
  const selection = await readDeploymentImageSelection({
    repoRoot: options.repoRoot,
    ...(options.env ? { env: options.env } : {}),
  });
  return await resolveContainerImageReference(
    options.repoRoot,
    selection.options,
  );
}

/**
 * The egress allowlist the tabletop's sidecar enforces (Issue #4047).
 *
 * Resolved from the providers the deployment enables, the way the launcher
 * resolves them, so the harness proves containment against the list a real
 * worker would be given. The runner has no operator configuration of its own,
 * so the file the deployment states is read here, or the default provider set
 * is used when the deployment has no file. The imgbb key is not counted
 * (`imgbbConfigured: false`): it only ever widens the list.
 *
 * @param options - The runner's options, including the repository root
 * @param manifest - The container manifest, for the installed provider set
 * @returns The hosts the sidecar will allow
 */
async function resolveTabletopEgressAllowlist(
  options: TabletopContainerRunnerOptions,
  manifest: ContainerManifest,
): Promise<string[]> {
  const env = options.env ?? processEnvLookup;
  const configFile = resolveHostConfigPath({ baseDir: options.repoRoot, env });
  const providers = await fileExists(configFile)
    ? (await readConfiguredAgentProviderSet(
      configFile,
      manifest.installedProviders,
      env,
    )).providers
    : enabledAgentProviders();
  return resolveEgressAllowlist({
    enabledProviderIds: providers.map((provider) => provider.id),
    imgbbConfigured: false,
  });
}

export function createTabletopContainerRunner(
  options: TabletopContainerRunnerOptions,
): TabletopRunner {
  return {
    async run(
      fixtures: readonly TabletopFixture[],
      runOptions: TabletopRunOptions,
    ): Promise<TabletopRunOutcome> {
      const runtime = options.runtime ?? PRODUCTION_RUNTIME;
      let descriptor: ContainerRuntimeDescriptor;
      try {
        descriptor = await runtime.detect();
      } catch (error) {
        throw new TabletopContainerUnavailableError(
          (error as Error).message.split("\n")[0] ?? "no container runtime",
        );
      }

      const manifest = parseContainerManifest(
        await Deno.readTextFile(`${options.repoRoot}/container/tools.json`),
      );
      const image = await resolveTabletopImage(options);
      const present = await runtime.run(
        descriptor.executable,
        [...descriptor.dialect.imageInspectArgs, image],
        QUERY_TIMEOUT_MS,
      );
      if (present.code !== 0) {
        throw new TabletopContainerUnavailableError(
          `the image ${image} is not present for ${descriptor.displayName} — ` +
            `build it with ./run.sh, or pass --image`,
        );
      }

      const token = crypto.randomUUID().slice(0, 8);
      const fixture = await buildHostFixture(
        descriptor,
        manifest,
        image,
        token,
        runOptions.canary,
        fixtures,
        {
          runtime,
          repoRoot: options.repoRoot,
          egressAllowlist: await resolveTabletopEgressAllowlist(
            options,
            manifest,
          ),
        },
      );
      const targets = containerTargetPaths(manifest);
      const env = [
        `VIBE_TABLETOP_CANARY=${targets.credentials}/${GH_CREDENTIAL_SUBDIR}/tabletop.canary`,
        `VIBE_TABLETOP_OUTBOX=${targets.logs}/tabletop-outbox.tsv`,
        `VIBE_TABLETOP_LOG_FILE=${targets.logs}/tabletop-run.log`,
        `VIBE_TABLETOP_HOST_PROBE=${fixture.hostProbePath}`,
        `VIBE_TABLETOP_WORKSPACE=${manifest.workdir}`,
        `VIBE_TABLETOP_HOSTILE_CLONE=${manifest.workdir}/hostile-clone`,
        `VIBE_TABLETOP_SYMLINK=${manifest.workdir}/hostile-clone/escape-link`,
        `VIBE_TABLETOP_EGRESS_URL=${
          options.egressProbeUrl ?? DEFAULT_EGRESS_PROBE_URL
        }`,
      ];

      // One sidecar for the whole run: every attempt container joins the same
      // internal network, and the sidecar is torn down once, below.
      const sidecar = fixture.plan.egress;
      const sidecarRun: RuntimeRunner = (args) =>
        runtime.run(descriptor.executable, [...args]);
      let sidecarUp = false;

      const attempts: TabletopAttemptOutcome[] = [];
      try {
        // A failed start has already torn itself down (startEgressSidecar), so
        // only a sidecar that is up is stopped in the finally below.
        if (sidecar) {
          await startEgressSidecar(sidecar, sidecarRun);
          sidecarUp = true;
        }

        for (const [index, item] of fixtures.entries()) {
          // Each fixture gets a clean pair of sinks, so a leak attributes to
          // the attempt that produced it.
          await Deno.writeTextFile(fixture.outboxPath, "");
          await Deno.writeTextFile(fixture.runLogPath, "");

          const run = await runtime.run(
            descriptor.executable,
            attemptRunArgs(
              fixture.plan,
              `${fixture.plan.containerName}-${index}`,
              env,
              [`${manifest.workdir}/tabletop/${item.id}.sh`],
            ),
          );
          const outcome = parseAttemptOutcome(run.stdout);
          const artefacts: TabletopArtefact[] = [
            { sink: "attempt-stdout", body: run.stdout },
            { sink: "attempt-stderr", body: run.stderr },
            { sink: "run-log", body: await readOrEmpty(fixture.runLogPath) },
            ...parseOutboxArtefacts(await readOrEmpty(fixture.outboxPath)),
          ];
          attempts.push({
            fixtureId: item.id,
            status: outcome.status,
            detail: outcome.detail,
            artefacts,
          });
        }
      } finally {
        try {
          // Taken down even when an attempt fails, before the fixture it mounts
          // is deleted below.
          if (sidecar && sidecarUp) {
            await stopEgressSidecar(sidecar, sidecarRun);
          }
        } finally {
          for (const name of fixture.plan.volumes) {
            await runtime.run(
              descriptor.executable,
              ["volume", "rm", "--force", name],
              QUERY_TIMEOUT_MS,
            ).catch(() => undefined);
          }
          await Deno.remove(fixture.root, { recursive: true }).catch(() =>
            undefined
          );
        }
      }

      return {
        mode: "container",
        runtime: descriptor.displayName,
        image,
        imageDigest: await resolveImageDigest(runtime, descriptor, image),
        attempts,
      };
    },
  };
}
