/**
 * Recovery never broadens a worker container's authority (Issue #4417).
 *
 * A worker launch carries a configured authority: the mounts, the credential
 * sub-directories, the environment names, the network, the egress enforcement,
 * the allowed egress hosts and the privilege flags. A failure, a restart or a
 * successful resumption must not widen it. The tests cover three things, and
 * say which is which:
 *
 * - The real recovery path is the `buildLaunchPlanForCommand` group. That is
 *   the function the container-launch-plan command runs on every launch,
 *   including each restart `run.sh` makes. Each failure class injects its real
 *   side effects into the state the launcher leaves behind (the persisted
 *   restart state, a launch log, rewritten credential bytes, a removed
 *   credential directory, an edited configuration file), relaunches, and checks
 *   the new plan against the plan from before the failure. The launcher's shell
 *   side is covered by the run.sh tests in `worker/deno/tests/run_sh_launcher_test.ts`,
 *   not here.
 *
 *   The denial and network-unavailable log and restart state these tests inject
 *   are not read by `buildLaunchPlanForCommand`: the command does not open the
 *   launch log or the restart state. The guarantee the tests make is that the
 *   command's output is unchanged by them. Each relaunch is compared with the
 *   plan from before the failure, so the injected state is a realistic
 *   precondition, not an input the command consumes.
 *
 *   Every environment read the command makes goes through the injected `env`
 *   record, so these tests never mutate the process environment, which the
 *   repository forbids for unit tests.
 * - The pure plan builder (`buildContainerLaunchPlan`) takes no failure input.
 *   That is a structural guarantee of its signature: a failure cannot reach it.
 *   The pure tests here check its output for given configured inputs only.
 * - The authority check (`withinAuthority`) is test-local. Its violation names
 *   are this file's own vocabulary, not production refusals. The production
 *   boundary guards inside `buildContainerLaunchPlan` are exercised only by the
 *   'production guards' test.
 *
 * Repository and operation scope: the plan has no separate repository or
 * operation field. The checkout mount and the egress allow-hosts are the scope
 * the check reads, and the configuration file's bytes are hashed across each
 * failure to show the operator's configured scope did not change.
 *
 * Australian English spelling throughout (behaviour, authorised, etc.).
 */

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { buildLaunchPlanForCommand } from "../commands/container_launch_plan.ts";
import {
  buildContainerLaunchPlan,
  type ContainerLaunchInputs,
  type ContainerLaunchPlan,
  containerTargetPaths,
  parseContainerLaunchPlanText,
  renderContainerLaunchPlan,
} from "../lib/container_launch.ts";
import {
  buildMountArguments,
  CONTAINER_RUNTIMES,
  type ContainerMount,
  type ContainerRuntimeDescriptor,
  type ContainerRuntimeKind,
} from "../lib/container_runtime.ts";
import {
  type ContainerManifest,
  parseContainerManifest,
} from "../lib/container_manifest.ts";
import {
  type AgentProviderDescriptor,
  CLAUDE_PROVIDER_ID,
  CODEX_PROVIDER_ID,
  ENABLED_AGENT_PROVIDERS_ENV,
  resolveAgentProvider,
} from "../lib/agent_provider.ts";
import { GH_CREDENTIAL_SUBDIR } from "../lib/credential_preflight.ts";
import { resolveEgressAllowlist } from "../lib/egress_allowlist.ts";
import { EGRESS_ENFORCED_ENV } from "../lib/egress_selfcheck.ts";
import { HOST_EGRESS_BLOCKED_EXIT_STATUS } from "../lib/container_egress_probe.ts";
import {
  CONTAINER_RESTART_DEFAULTS,
  type ContainerRestartDecision,
  type ContainerRestartState,
  emptyContainerRestartState,
  isNetworkUnavailableLaunch,
  loadContainerRestartState,
  nextContainerRestartDecision,
  persistContainerRestartState,
  resolveContainerRestartConfig,
} from "../lib/container_restart_backoff.ts";
import { NETWORK_UNAVAILABLE_MARKER } from "../lib/github_user_resolution.ts";
import {
  appleCapabilities,
  appleLaunch,
  appleMode,
  retryAppleEgress,
} from "../lib/apple_egress_launch.ts";
import { appleControlFailures } from "../lib/apple_egress_controls.ts";
import { REPO_ROOT } from "./fixtures/launcher_harness.ts";

/** The repository's real manifest — the source of the in-container layout. */
const MANIFEST: ContainerManifest = parseContainerManifest(
  await Deno.readTextFile(`${REPO_ROOT}/container/tools.json`),
);

const HOME = "/home/operator";
const IMAGE = "vibe-coder:0123456789ab";
const CONTAINER = "vibe-coder-4242";
const NETWORK = `${CONTAINER}-net`;
const BUILD_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const NONCE = "0123456789abcdef0123456789abcdef";
const CLOCK = () => 1_000;
const CLOCK_MS = 1_700_000_000_000;
const CONFIG = resolveContainerRestartConfig(CONTAINER_RESTART_DEFAULTS);
const CREDENTIALS_ROOT = containerTargetPaths(MANIFEST).credentials;

/** The configured provider pool: both providers are enabled for this deployment. */
const POOL: readonly AgentProviderDescriptor[] = [
  resolveAgentProvider(CLAUDE_PROVIDER_ID),
  resolveAgentProvider(CODEX_PROVIDER_ID),
];

/** The egress allowlist the configured pool resolves to. Held fixed across retries. */
const HOSTS: readonly string[] = resolveEgressAllowlist({
  enabledProviderIds: POOL.map((provider) => provider.id),
  imgbbConfigured: false,
});

/** The log a launch leaves when a tool is denied by the container's own policy. */
const DENIAL_LOG = [
  "[02:11:01Z] INFO: [run-worker] run mode: container",
  "[02:11:02Z] ERROR: [run-worker] git push refused: permission denied " +
  "(EACCES) on /home/vibe/auto-issue-work/repo/.git/index",
].join("\n");

/** The log a launch leaves when the credential was rejected with HTTP 401. */
const AUTH_LOG = [
  "[02:11:01Z] INFO: [run-worker] run mode: container",
  "[02:11:02Z] ERROR: [run-worker] gh could not resolve the authenticated " +
  "user (fatal, 1 attempt(s)): HTTP 401: Bad credentials",
].join("\n");

/** The log a launch leaves when GitHub was unreachable for every attempt. */
const NETWORK_LOG = [
  "[02:11:01Z] INFO: [run-worker] run mode: container",
  `[02:11:02Z] ERROR: [run-worker] ${NETWORK_UNAVAILABLE_MARKER} — GitHub ` +
  "was unreachable for every attempt; not a host fault",
].join("\n");

/** A mount as the launcher hands it to the runtime. */
interface MountView {
  source: string;
  target: string;
  readOnly: boolean;
}

/**
 * The effective authority of a launch plan: what the container can see, reach,
 * read from its environment and be privileged to do. Names only for the
 * environment, never values.
 */
interface Authority {
  /** Every mount, host and named volume alike, sorted. */
  mounts: MountView[];
  /** Credential sub-directories mounted, sorted. */
  credentialDirs: string[];
  /** Names (not values) of every `--env` the worker and proxy receive, sorted. */
  envNames: string[];
  /** The network the worker joins, or `""` for the runtime default. */
  network: string;
  /** Whether the plan claims egress enforcement. */
  egressEnforced: boolean;
  /** Hosts the egress proxy allows, from `VIBE_EGRESS_ALLOW_HOSTS`, sorted. */
  allowHosts: string[];
  /** Privilege-bearing flags, with their values, sorted. Proxy flags are prefixed. */
  privilegeFlags: string[];
  /** Scratch `--tmpfs` values, sorted. */
  scratch: string[];
}

/** Flags that take a value and that carry privilege. */
const PRIVILEGE_FLAGS = new Set([
  "--privileged",
  "--cap-add",
  "--cap-drop",
  "--security-opt",
  "--device",
  "--publish",
  "-p",
  "--publish-all",
  "-P",
  "--pid",
  "--ipc",
  "--uts",
  "--userns",
  "--user",
  "-u",
  "--read-only",
]);

const PRIVILEGE_VALUE_FLAGS = new Set([
  "--cap-add",
  "--cap-drop",
  "--security-opt",
  "--device",
  "--publish",
  "-p",
  "--pid",
  "--ipc",
  "--uts",
  "--userns",
  "--user",
  "-u",
]);

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/** The values that follow any of the given flags. */
function valuesAfter(
  args: readonly string[],
  flags: readonly string[],
): string[] {
  const values: string[] = [];
  for (const [i, arg] of args.entries()) {
    const value = args[i + 1];
    if (flags.includes(arg) && value !== undefined) values.push(value);
  }
  return values;
}

/** The part of an argument before any `=`. */
function nameOf(token: string): string {
  const cut = token.indexOf("=");
  return cut === -1 ? token : token.slice(0, cut);
}

function mountKey(mount: MountView): string {
  return `${mount.source}\u0000${mount.target}`;
}

function mountLabel(mount: MountView): string {
  return `${mount.source}:${mount.target}${mount.readOnly ? ":ro" : ""}`;
}

function isCredentialMount(mount: MountView): boolean {
  return mount.target.startsWith(`${CREDENTIALS_ROOT}/`);
}

function isHostMount(mount: MountView): boolean {
  return mount.source.startsWith("/");
}

function subdirOf(mount: MountView): string {
  return mount.target.slice(CREDENTIALS_ROOT.length + 1);
}

/** Parses a `--volume` value: `source:target` with an optional `:ro`. */
function parseMountValue(value: string): MountView {
  const readOnly = value.endsWith(":ro");
  const body = readOnly ? value.slice(0, -":ro".length) : value;
  const cut = body.lastIndexOf(":");
  return { source: body.slice(0, cut), target: body.slice(cut + 1), readOnly };
}

function mountsOf(args: readonly string[]): MountView[] {
  const byKey = new Map<string, MountView>();
  for (const value of valuesAfter(args, ["--volume", "-v"])) {
    const mount = parseMountValue(value);
    byKey.set(`${mountKey(mount)}\u0000${mount.readOnly}`, mount);
  }
  return [...byKey.values()].sort((a, b) =>
    mountKey(a) < mountKey(b) ? -1 : mountKey(a) > mountKey(b) ? 1 : 0
  );
}

function envNamesOf(args: readonly string[]): string[] {
  return valuesAfter(args, ["--env", "-e"]).map(nameOf);
}

function allowHostsOf(args: readonly string[]): string[] {
  const prefix = "VIBE_EGRESS_ALLOW_HOSTS=";
  return args
    .filter((arg) => arg.startsWith(prefix))
    .flatMap((arg) => arg.slice(prefix.length).split(","))
    .filter((host) => host !== "");
}

/** The network a run argument list asks for, `""` when it names none. */
function networkOf(args: readonly string[]): string {
  for (const [i, token] of args.entries()) {
    if (token === "--network" || token === "--net") return args[i + 1] ?? "";
    if (token.startsWith("--network=")) {
      return token.slice("--network=".length);
    }
    if (token.startsWith("--net=")) return token.slice("--net=".length);
  }
  return "";
}

/** The privilege-bearing flags an argument list carries, sorted. */
function privilegesOf(args: readonly string[]): string[] {
  const found = new Set<string>();
  for (const [i, token] of args.entries()) {
    const flag = nameOf(token).toLowerCase();
    if (!PRIVILEGE_FLAGS.has(flag)) continue;
    const next = args[i + 1];
    if (token.includes("=")) {
      found.add(token);
    } else if (
      PRIVILEGE_VALUE_FLAGS.has(flag) && next !== undefined &&
      !next.startsWith("-")
    ) {
      found.add(`${token} ${next}`);
    } else {
      found.add(token);
    }
  }
  return [...found].sort();
}

/** The effective authority a launch plan carries. */
function authorityOf(plan: ContainerLaunchPlan): Authority {
  const mounts = mountsOf([...plan.runArgs, ...plan.initArgs]);
  const launchArgs = [...plan.runArgs, ...plan.proxyRunArgs];
  return {
    mounts,
    credentialDirs: sortedUnique(
      mounts.filter(isCredentialMount).map(subdirOf),
    ),
    envNames: sortedUnique(envNamesOf(launchArgs)),
    network: networkOf(plan.runArgs),
    egressEnforced: plan.egressEnforced,
    allowHosts: sortedUnique(allowHostsOf(launchArgs)),
    privilegeFlags: [
      ...privilegesOf(plan.runArgs),
      ...privilegesOf(plan.proxyRunArgs).map((flag) => `proxy ${flag}`),
    ],
    scratch: sortedUnique(valuesAfter(plan.runArgs, ["--tmpfs"])),
  };
}

/**
 * Violations of the configured authority, by this file's own rule names. An
 * empty list means `effective` grants nothing the `ceiling` did not. This is
 * test-local: it is not the production refusal logic.
 *
 * A credential mount is judged by the credential rule and a host mount by the
 * mount rule, so one fault yields one named violation.
 */
function withinAuthority(
  ceiling: Authority,
  effective: Authority,
): string[] {
  const violations: string[] = [];
  const granted = new Map(
    ceiling.mounts.map((mount) => [mountKey(mount), mount]),
  );
  const grantedTargets = new Map(
    ceiling.mounts.map((mount) => [mount.target, mount]),
  );

  for (const mount of effective.mounts) {
    if (isCredentialMount(mount)) {
      const subdir = subdirOf(mount);
      const allowed = grantedTargets.get(mount.target);
      if (!allowed) {
        violations.push(`credential:added ${subdir}`);
      } else if (allowed.source !== mount.source) {
        violations.push(`credential:repointed ${subdir}`);
      } else if (!mount.readOnly && allowed.readOnly) {
        violations.push(`credential:writable ${subdir}`);
      }
    } else if (isHostMount(mount)) {
      const allowed = granted.get(mountKey(mount));
      if (!allowed) {
        violations.push(`mount:added ${mountLabel(mount)}`);
      } else if (!mount.readOnly && allowed.readOnly) {
        violations.push(`mount:writable ${mountLabel(mount)}`);
      }
    } else if (!granted.has(mountKey(mount))) {
      violations.push(`volume:added ${mountLabel(mount)}`);
    }
  }

  for (const name of effective.envNames) {
    if (!ceiling.envNames.includes(name)) violations.push(`env:added ${name}`);
  }

  if (effective.network === "host") {
    violations.push("network:host");
  } else if (effective.network !== ceiling.network) {
    violations.push(
      `network:changed ${ceiling.network || "default"} -> ${
        effective.network || "default"
      }`,
    );
  }
  if (ceiling.egressEnforced && !effective.egressEnforced) {
    violations.push("egress:dropped");
  }
  for (const host of effective.allowHosts) {
    if (!ceiling.allowHosts.includes(host)) {
      violations.push(`allow-host:added ${host}`);
    }
  }
  for (const flag of effective.privilegeFlags) {
    if (!ceiling.privilegeFlags.includes(flag)) {
      violations.push(`privilege:added ${flag}`);
    }
  }
  for (const flag of ceiling.privilegeFlags) {
    if (!effective.privilegeFlags.includes(flag)) {
      violations.push(`privilege:dropped ${flag}`);
    }
  }
  for (const value of effective.scratch) {
    if (!ceiling.scratch.includes(value)) {
      violations.push(`scratch:added ${value}`);
    }
  }
  return violations;
}

function descriptorFor(kind: ContainerRuntimeKind): ContainerRuntimeDescriptor {
  const candidate = CONTAINER_RUNTIMES[kind];
  return {
    platform: kind === "apple-container" ? "darwin" : "linux",
    kind,
    executable: candidate.executable,
    displayName: candidate.displayName,
    dialect: candidate.dialect,
    probed: [kind],
  };
}

/** The host layout, rooted in a throwaway directory the test owns. */
function hostPathsFor(root: string) {
  return {
    homeDir: HOME,
    baseDir: `${root}/checkout`,
    workDir: `${root}/work`,
    logDir: `${root}/logs`,
    configFile: `${root}/checkout/.config.json`,
    configStageDir: `${root}/run-config`,
    credentialDir: `${root}/credentials`,
  };
}

/**
 * The configured inputs for one deployment. The pure tests build from this, so
 * the ceiling and the rebuilt plan are the same configuration by construction.
 */
function configured(
  root: string,
  overrides: Partial<ContainerLaunchInputs> = {},
): ContainerLaunchInputs {
  return {
    descriptor: descriptorFor("docker"),
    manifest: MANIFEST,
    image: IMAGE,
    containerName: CONTAINER,
    buildCommit: BUILD_COMMIT,
    watchdogSeconds: 11_400,
    planEpochSeconds: 1_700_000_000,
    hostPaths: hostPathsFor(root),
    agentProviders: POOL,
    egressAllowHosts: HOSTS,
    ...overrides,
  };
}

/** A throwaway deployment root, removed after the run. */
async function withRoot(
  run: (root: string) => void | Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "vibe_recovery_authority_" });
  try {
    await run(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

/** One restart-classifier outcome, with the configured restart policy. */
function step(
  state: ContainerRestartState,
  exitStatus: number,
  marker: string | null,
  networkUnavailable = false,
): ContainerRestartDecision {
  return nextContainerRestartDecision(
    state,
    exitStatus,
    marker,
    CONFIG,
    CLOCK,
    null,
    networkUnavailable,
  );
}

/**
 * The launcher's view of a plan, round-tripped through the NUL-delimited stream
 * `run.sh` reads. The retry is asserted against what the launcher will execute.
 */
function assertLauncherView(plan: ContainerLaunchPlan): void {
  const parsed = parseContainerLaunchPlanText(renderContainerLaunchPlan(plan));
  assertEquals(parsed.run, plan.runArgs);
  assertEquals(parsed.init, plan.initArgs);
  assertEquals(parsed.volume, plan.volumes);
  assertEquals(parsed.egressEnforced, plan.egressEnforced ? "true" : "false");
  assertEquals(parsed.networkCreate, plan.networkCreateArgs);
  assertEquals(parsed.proxyRun, plan.proxyRunArgs);
}

/** Inserts arguments before the image, which must stay last. */
function insertBeforeImage(
  plan: ContainerLaunchPlan,
  args: readonly string[],
): ContainerLaunchPlan {
  const image = plan.runArgs.at(-1) ?? "";
  return { ...plan, runArgs: [...plan.runArgs.slice(0, -1), ...args, image] };
}

// ---------------------------------------------------------------------------
// Real recovery path: `buildLaunchPlanForCommand`, run on every launch.
// ---------------------------------------------------------------------------

/** The host state one deployment's launches read and write, rooted in `root`. */
interface Deployment {
  /** The environment record the launch reads. Mutable, so a test can change it. */
  environment: Record<string, string>;
  /** Environment reader the launch is given. */
  env: (name: string) => string | undefined;
  configFile: string;
  credentialDir: string;
  workDir: string;
  logDir: string;
}

/**
 * The deployment's environment record. It carries no image stamp
 * (`IMAGE_AGENT_PROVIDERS_ENV`): these are host launches, which is the state
 * the stamp's absence describes, so provider selection reads the configuration
 * alone unless a test adds `ENABLED_AGENT_PROVIDERS_ENV` to the record.
 */
function deploymentAt(root: string): Deployment {
  const environment: Record<string, string> = {
    HOME: `${root}/home`,
    VIBE_CREDENTIAL_DIR: `${root}/credentials`,
    CONFIG_PATH: `${root}/config.json`,
    WORK_DIR: `${root}/work`,
  };
  return {
    environment,
    env: (name) => environment[name],
    configFile: `${root}/config.json`,
    credentialDir: `${root}/credentials`,
    workDir: `${root}/work`,
    logDir: `${root}/logs`,
  };
}

/** The configuration an operator has: both providers enabled, no extra hosts. */
function deploymentConfig(
  root: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    agent_provider: CLAUDE_PROVIDER_ID,
    agent_providers: [CLAUDE_PROVIDER_ID, CODEX_PROVIDER_ID],
    log_dir: `${root}/logs`,
    egress_allow_hosts: [],
    ...extra,
  };
}

async function writeConfig(
  d: Deployment,
  config: Record<string, unknown>,
): Promise<void> {
  await Deno.writeTextFile(d.configFile, JSON.stringify(config, null, 2));
}

/** Creates the credential directories, work and log directories, and configuration. */
async function provision(
  d: Deployment,
  config: Record<string, unknown>,
): Promise<void> {
  for (
    const sub of [GH_CREDENTIAL_SUBDIR, CLAUDE_PROVIDER_ID, CODEX_PROVIDER_ID]
  ) {
    await Deno.mkdir(`${d.credentialDir}/${sub}`, { recursive: true });
  }
  await Deno.mkdir(d.workDir, { recursive: true });
  await Deno.mkdir(d.logDir, { recursive: true });
  await writeConfig(d, config);
}

/** A provider's credential file. The bytes are a token, which refreshes. */
async function writeProviderCredential(
  d: Deployment,
  subdir: string,
  bytes: string,
): Promise<void> {
  await Deno.writeTextFile(`${d.credentialDir}/${subdir}/provider.env`, bytes);
}

/** The launch log the launcher leaves in the configured log directory. */
async function writeLaunchLog(d: Deployment, text: string): Promise<void> {
  await Deno.writeTextFile(`${d.logDir}/launch-${CONTAINER}.log`, text);
}

async function readLaunchLog(d: Deployment): Promise<string> {
  return await Deno.readTextFile(`${d.logDir}/launch-${CONTAINER}.log`);
}

/** The restart state the launcher persists into the work directory. */
async function persistRestartState(
  d: Deployment,
  state: ContainerRestartState,
): Promise<void> {
  const saved = await persistContainerRestartState(d.workDir, state);
  assertEquals(saved.ok, true);
}

/** SHA-256 of a file's bytes, so a test can show a file was or was not changed. */
async function digestOf(path: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await Deno.readFile(path),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * One launch, as `run.sh` invokes the command for each attempt. The plan clock
 * is fixed, and every environment read (provider selection and the image
 * stamp included) goes through the deployment's injected `env`.
 */
function launch(d: Deployment): Promise<ContainerLaunchPlan> {
  return buildLaunchPlanForCommand(REPO_ROOT, CONTAINER, {
    env: d.env,
    now: () => CLOCK_MS,
    probe: (candidate) =>
      Promise.resolve({
        available: true,
        path: `/usr/bin/${candidate.executable}`,
      }),
  });
}

Deno.test("recovery authority - a denied operation relaunches within the configured authority (Issue #4417)", async () => {
  await withRoot(async (root) => {
    const d = deploymentAt(root);
    await provision(d, deploymentConfig(root));
    const configBytes = await digestOf(d.configFile);
    const ceiling = authorityOf(await launch(d));

    // The denial: three exit-1 worker runs, each leaving the policy refusal.
    let state = emptyContainerRestartState(CLOCK);
    for (let i = 0; i < 3; i++) {
      const decision = step(state, 1, "container_run");
      assertEquals(decision.kind, "failure");
      state = decision.state;
    }
    await persistRestartState(d, state);
    await writeLaunchLog(d, DENIAL_LOG);
    assertEquals(
      (await loadContainerRestartState(d.workDir)).consecutiveFailures,
      3,
    );
    assertEquals(isNetworkUnavailableLaunch(await readLaunchLog(d)), false);

    const relaunched = await launch(d);
    assertEquals(withinAuthority(ceiling, authorityOf(relaunched)), []);
    assertEquals(authorityOf(relaunched), ceiling);
    assertEquals(await digestOf(d.configFile), configBytes);
  });
});

Deno.test("recovery authority - an authentication failure and a credential refresh keep the configured authority (Issue #4417)", async () => {
  await withRoot(async (root) => {
    const d = deploymentAt(root);
    await provision(d, deploymentConfig(root));
    const configBytes = await digestOf(d.configFile);
    const ceiling = authorityOf(await launch(d));
    assertEquals(ceiling.credentialDirs, [
      CLAUDE_PROVIDER_ID,
      CODEX_PROVIDER_ID,
      GH_CREDENTIAL_SUBDIR,
    ]);

    // Two HTTP 401 failures on the stale claude token.
    await writeProviderCredential(
      d,
      CLAUDE_PROVIDER_ID,
      "ANTHROPIC_API_KEY=stale-token\n",
    );
    const staleDigest = await digestOf(
      `${d.credentialDir}/${CLAUDE_PROVIDER_ID}/provider.env`,
    );
    let state = emptyContainerRestartState(CLOCK);
    for (let i = 0; i < 2; i++) {
      const decision = step(
        state,
        1,
        "container_run",
        isNetworkUnavailableLaunch(AUTH_LOG),
      );
      assertEquals(decision.kind, "failure");
      state = decision.state;
    }
    await persistRestartState(d, state);
    await writeLaunchLog(d, AUTH_LOG);

    // The refresh: the same credential file, rewritten with fresh bytes.
    await writeProviderCredential(
      d,
      CLAUDE_PROVIDER_ID,
      "ANTHROPIC_API_KEY=fresh-token\n",
    );
    assertNotEquals(
      await digestOf(`${d.credentialDir}/${CLAUDE_PROVIDER_ID}/provider.env`),
      staleDigest,
    );

    const relaunched = await launch(d);
    assertEquals(withinAuthority(ceiling, authorityOf(relaunched)), []);
    assertEquals(authorityOf(relaunched), ceiling);
    assertEquals(await digestOf(d.configFile), configBytes);
    assertEquals(step(state, 0, null).kind, "success");
  });
});

Deno.test("recovery authority - an egress refusal and a network-unavailable restart keep enforcement and the internal network (Issue #4417)", async () => {
  await withRoot(async (root) => {
    const d = deploymentAt(root);
    await provision(d, deploymentConfig(root));
    const configBytes = await digestOf(d.configFile);
    const ceiling = authorityOf(await launch(d));
    assertEquals(ceiling.egressEnforced, true);
    assertEquals(ceiling.network, NETWORK);

    // The host egress probe refused the launch.
    const egress = step(
      emptyContainerRestartState(CLOCK),
      HOST_EGRESS_BLOCKED_EXIT_STATUS,
      "container_egress",
    );
    assertEquals(egress.phase, "container_egress");
    await persistRestartState(d, egress.state);

    // Then GitHub was unreachable for every attempt.
    await writeLaunchLog(d, NETWORK_LOG);
    assertEquals(isNetworkUnavailableLaunch(await readLaunchLog(d)), true);
    const unavailable = step(egress.state, 1, "container_run", true);
    assertEquals(unavailable.kind, "network_unavailable");
    assertEquals(unavailable.state.consecutiveFailures, 0);
    await persistRestartState(d, unavailable.state);

    const relaunched = await launch(d);
    assertEquals(withinAuthority(ceiling, authorityOf(relaunched)), []);
    assertEquals(authorityOf(relaunched), ceiling);
    assertEquals(relaunched.egressEnforced, true);
    assert(relaunched.networkCreateArgs.includes("--internal"));
    assert(relaunched.proxyRunArgs.length > 0);
    assertEquals(await digestOf(d.configFile), configBytes);
  });
});

Deno.test("recovery authority - a permitted operation still succeeds after a failure streak (Issue #4417)", async () => {
  await withRoot(async (root) => {
    const d = deploymentAt(root);
    await provision(d, deploymentConfig(root));
    const ceiling = authorityOf(await launch(d));

    let state = emptyContainerRestartState(CLOCK);
    for (let i = 0; i < 2; i++) {
      state = step(state, 1, "container_run").state;
    }
    await persistRestartState(d, state);

    // The relaunch is returned, not thrown, and ends with its image.
    const plan = await launch(d);
    assertEquals(plan.runArgs.at(-1), plan.image);
    assertEquals(withinAuthority(ceiling, authorityOf(plan)), []);

    const recovered = step(state, 0, null);
    assertEquals(recovered.kind, "success");
    assertEquals(recovered.recovered, true);
    assertEquals(recovered.state.consecutiveFailures, 0);
  });
});

Deno.test("recovery authority - an operator's allow-host edit is flagged against the old ceiling and accepted against the recomputed one (Issue #4417)", async () => {
  await withRoot(async (root) => {
    const d = deploymentAt(root);
    await provision(d, deploymentConfig(root));
    const oldCeiling = authorityOf(await launch(d));

    // The operator adds a host to the configuration, deliberately.
    await writeConfig(
      d,
      deploymentConfig(root, { egress_allow_hosts: ["logs.example.test"] }),
    );
    const edited = await launch(d);
    assert(authorityOf(edited).allowHosts.includes("logs.example.test"));
    assertEquals(withinAuthority(oldCeiling, authorityOf(edited)), [
      "allow-host:added logs.example.test",
    ]);

    const recomputed = authorityOf(await launch(d));
    assertEquals(withinAuthority(recomputed, authorityOf(edited)), []);
  });
});

Deno.test("recovery authority - a legitimate provider rotation keeps the mounts within the configured pool (Issue #4417)", async () => {
  await withRoot(async (root) => {
    const d = deploymentAt(root);
    // No `agent_providers` key: the environment selects the enabled set, and
    // the command reads that from the injected environment record.
    await provision(d, {
      agent_provider: CLAUDE_PROVIDER_ID,
      log_dir: `${root}/logs`,
      egress_allow_hosts: [],
    });
    const configBytes = await digestOf(d.configFile);
    const both = `${CLAUDE_PROVIDER_ID},${CODEX_PROVIDER_ID}`;
    d.environment[ENABLED_AGENT_PROVIDERS_ENV] = both;
    const pool = authorityOf(await launch(d));
    assertEquals(pool.credentialDirs, [
      CLAUDE_PROVIDER_ID,
      CODEX_PROVIDER_ID,
      GH_CREDENTIAL_SUBDIR,
    ]);

    // Rotation: codex is disabled for the next launch.
    d.environment[ENABLED_AGENT_PROVIDERS_ENV] = CLAUDE_PROVIDER_ID;
    const rotated = authorityOf(await launch(d));
    assertEquals(rotated.credentialDirs, [
      CLAUDE_PROVIDER_ID,
      GH_CREDENTIAL_SUBDIR,
    ]);
    assertEquals(
      rotated.credentialDirs.filter((sub) =>
        !pool.credentialDirs.includes(sub)
      ),
      [],
    );
    assertEquals(withinAuthority(pool, rotated), []);

    // Enabled again: the authority is the pool's again, unchanged.
    d.environment[ENABLED_AGENT_PROVIDERS_ENV] = both;
    assertEquals(authorityOf(await launch(d)), pool);
    assertEquals(await digestOf(d.configFile), configBytes);
  });
});

Deno.test("recovery authority - a credential directory missing after a failure fails the launch closed (Issue #4417)", async () => {
  await withRoot(async (root) => {
    const d = deploymentAt(root);
    await provision(d, deploymentConfig(root));
    await launch(d);

    let state = emptyContainerRestartState(CLOCK);
    for (let i = 0; i < 2; i++) {
      state = step(state, 1, "container_run").state;
    }
    await persistRestartState(d, state);

    // The codex credential directory disappears between attempts. The launch
    // refuses, naming the path. It does not fall back to a different mount set.
    await Deno.remove(`${d.credentialDir}/${CODEX_PROVIDER_ID}`, {
      recursive: true,
    });
    await assertRejects(
      () => launch(d),
      Error,
      `Cannot launch: ${d.credentialDir}/${CODEX_PROVIDER_ID} does not exist`,
    );
  });
});

// ---------------------------------------------------------------------------
// Pure plan builder: no failure input. These check its output for given inputs.
// ---------------------------------------------------------------------------

Deno.test("recovery authority - a provider rotation to a subset of the configured pool stays within the ceiling (Issue #4417)", async () => {
  await withRoot((root) => {
    const ceiling = authorityOf(buildContainerLaunchPlan(configured(root)));
    assertEquals(ceiling.credentialDirs, [
      CLAUDE_PROVIDER_ID,
      CODEX_PROVIDER_ID,
      GH_CREDENTIAL_SUBDIR,
    ]);

    const rotated = buildContainerLaunchPlan(
      configured(root, {
        agentProviders: [resolveAgentProvider(CODEX_PROVIDER_ID)],
      }),
    );
    assertLauncherView(rotated);
    const rotatedAuthority = authorityOf(rotated);
    assertEquals(rotatedAuthority.credentialDirs, [
      CODEX_PROVIDER_ID,
      GH_CREDENTIAL_SUBDIR,
    ]);
    assertEquals(withinAuthority(ceiling, rotatedAuthority), []);
  });
});

Deno.test("recovery authority - the configured plan keeps egress enforcement, the internal network and the proxy (Issue #4417)", async () => {
  await withRoot((root) => {
    const plan = buildContainerLaunchPlan(configured(root));
    assertEquals(plan.egressEnforced, true);
    assertEquals(authorityOf(plan).network, NETWORK);
    assert(plan.networkCreateArgs.includes("--internal"));
    assert(plan.proxyRunArgs.length > 0);
    assertEquals(plan.runArgs.at(-1), IMAGE);
  });
});

Deno.test("recovery authority - an Apple plan claims no egress enforcement and says so (Issue #4417)", async () => {
  await withRoot((root) => {
    const plan = buildContainerLaunchPlan(
      configured(root, { descriptor: descriptorFor("apple-container") }),
    );
    assertEquals(plan.egressEnforced, false);
    assert(plan.runArgs.includes(`${EGRESS_ENFORCED_ENV}=false`));
    assert(!plan.runArgs.includes(`${EGRESS_ENFORCED_ENV}=true`));
  });
});

Deno.test("recovery authority - an explicit authorised change is flagged against the old ceiling and accepted against the recomputed one (Issue #4417)", async () => {
  await withRoot((root) => {
    // A new allow-listed host, configured deliberately.
    const oldCeiling = authorityOf(buildContainerLaunchPlan(configured(root)));
    const newHosts = [...HOSTS, "logs.example.test"];
    const newPlan = buildContainerLaunchPlan(
      configured(root, { egressAllowHosts: newHosts }),
    );
    assertEquals(withinAuthority(oldCeiling, authorityOf(newPlan)), [
      "allow-host:added logs.example.test",
    ]);
    const recomputed = authorityOf(
      buildContainerLaunchPlan(
        configured(root, { egressAllowHosts: newHosts }),
      ),
    );
    assertEquals(withinAuthority(recomputed, authorityOf(newPlan)), []);
  });
});

// Fault-injected plans: each is a widened copy of a configured plan, run
// through the test-local authority check. The unmodified plan is a control.

Deno.test("recovery authority - the authority check flags an extra writable host mount (Issue #4417)", async () => {
  await withRoot((root) => {
    const plan = buildContainerLaunchPlan(configured(root));
    const ceiling = authorityOf(plan);
    assertEquals(withinAuthority(ceiling, authorityOf(plan)), []);

    // Fault-injected: a read-write host directory the configuration never named.
    const extra: ContainerMount = {
      source: `${root}/projects`,
      target: "/home/vibe/projects",
      readOnly: false,
    };
    const widened = insertBeforeImage(
      plan,
      buildMountArguments(descriptorFor("docker"), extra),
    );
    assertEquals(withinAuthority(ceiling, authorityOf(widened)), [
      `mount:added ${root}/projects:/home/vibe/projects`,
    ]);

    // Fault-injected: the read-only checkout made writable.
    const base = containerTargetPaths(MANIFEST).base;
    const index = widened.runArgs.indexOf(`${root}/checkout:${base}:ro`);
    assert(index >= 0, "the checkout mount is present and read-only");
    const writable = {
      ...plan,
      runArgs: plan.runArgs.map((arg, i) =>
        i === index ? `${root}/checkout:${base}` : arg
      ),
    };
    assertEquals(withinAuthority(ceiling, authorityOf(writable)), [
      `mount:writable ${root}/checkout:${base}`,
    ]);
  });
});

Deno.test("recovery authority - the authority check flags an extra credential sub-directory (Issue #4417)", async () => {
  await withRoot((root) => {
    const plan = buildContainerLaunchPlan(configured(root));
    const ceiling = authorityOf(plan);
    assertEquals(withinAuthority(ceiling, authorityOf(plan)), []);

    // Fault-injected: gemini's credentials, a provider outside the pool.
    const widened = insertBeforeImage(
      plan,
      buildMountArguments(descriptorFor("docker"), {
        source: `${root}/credentials/gemini`,
        target: `${CREDENTIALS_ROOT}/gemini`,
        readOnly: true,
      }),
    );
    assertEquals(withinAuthority(ceiling, authorityOf(widened)), [
      "credential:added gemini",
    ]);
  });
});

Deno.test("recovery authority - the authority check flags host networking and dropped egress enforcement (Issue #4417)", async () => {
  await withRoot((root) => {
    const plan = buildContainerLaunchPlan(configured(root));
    const ceiling = authorityOf(plan);
    assertEquals(withinAuthority(ceiling, authorityOf(plan)), []);

    // Fault-injected: the worker joins the host network.
    const runArgs = [...plan.runArgs];
    runArgs[runArgs.indexOf("--network") + 1] = "host";
    assertEquals(
      withinAuthority(ceiling, authorityOf({ ...plan, runArgs })),
      ["network:host"],
    );

    // Fault-injected: enforcement dropped, the internal network still named.
    assertEquals(
      withinAuthority(ceiling, authorityOf({ ...plan, egressEnforced: false })),
      ["egress:dropped"],
    );

    // Fault-injected: the internal network removed, so the default network is used.
    const index = plan.runArgs.indexOf("--network");
    const unnetworked = {
      ...plan,
      runArgs: plan.runArgs.filter((_, i) => i !== index && i !== index + 1),
    };
    assertEquals(withinAuthority(ceiling, authorityOf(unnetworked)), [
      `network:changed ${NETWORK} -> default`,
    ]);
  });
});

Deno.test("recovery authority - the authority check flags an added privilege flag (Issue #4417)", async () => {
  await withRoot((root) => {
    const plan = buildContainerLaunchPlan(configured(root));
    const ceiling = authorityOf(plan);
    assertEquals(withinAuthority(ceiling, authorityOf(plan)), []);

    assertEquals(
      withinAuthority(
        ceiling,
        authorityOf(insertBeforeImage(plan, ["--cap-add", "SYS_ADMIN"])),
      ),
      ["privilege:added --cap-add SYS_ADMIN"],
    );
    assertEquals(
      withinAuthority(
        ceiling,
        authorityOf(insertBeforeImage(plan, ["--privileged"])),
      ),
      ["privilege:added --privileged"],
    );
  });
});

Deno.test("recovery authority - the authority check flags a widened allow-host or environment name (Issue #4417)", async () => {
  await withRoot((root) => {
    const plan = buildContainerLaunchPlan(configured(root));
    const ceiling = authorityOf(plan);
    assertEquals(withinAuthority(ceiling, authorityOf(plan)), []);

    // Fault-injected: the proxy also allows a host nobody configured.
    const proxyRunArgs = plan.proxyRunArgs.map((arg) =>
      arg.startsWith("VIBE_EGRESS_ALLOW_HOSTS=")
        ? `${arg},evil.example.test`
        : arg
    );
    assertEquals(
      withinAuthority(ceiling, authorityOf({ ...plan, proxyRunArgs })),
      ["allow-host:added evil.example.test"],
    );

    // Fault-injected: a secret passed to the worker by name.
    assertEquals(
      withinAuthority(
        ceiling,
        authorityOf(
          insertBeforeImage(plan, ["--env", "AWS_SECRET_ACCESS_KEY=x"]),
        ),
      ),
      ["env:added AWS_SECRET_ACCESS_KEY"],
    );
  });
});

Deno.test("recovery authority - the production guards refuse widened launch arguments (Issue #4417)", async () => {
  await withRoot((root) => {
    // The guards are private to the builder, so the builder is driven with
    // inputs that would produce each widened list. The unwidened inputs pass.
    assert(buildContainerLaunchPlan(configured(root)).runArgs.length > 0);

    // A host-networked dialect: `--network host` reaches runArgs.
    const hostNetworked: ContainerRuntimeDescriptor = {
      ...descriptorFor("docker"),
      dialect: {
        ...CONTAINER_RUNTIMES.docker.dialect,
        egressEnforced: false,
        networkMode: "host",
      },
    };
    assertThrows(
      () =>
        buildContainerLaunchPlan(
          configured(root, { descriptor: hostNetworked }),
        ),
      Error,
      "host namespace/network access",
    );

    // A privilege-bearing image reference reaches the argument list.
    assertThrows(
      () =>
        buildContainerLaunchPlan(configured(root, { image: "--privileged" })),
      Error,
      "broadens the container",
    );

    // The host home directory is never mounted, even as a log directory.
    assertThrows(
      () =>
        buildContainerLaunchPlan(
          configured(root, {
            hostPaths: { ...hostPathsFor(root), logDir: HOME },
          }),
        ),
      Error,
      "host home directory",
    );

    // A container-runtime control socket is never mounted.
    assertThrows(
      () =>
        buildContainerLaunchPlan(
          configured(root, {
            hostPaths: { ...hostPathsFor(root), logDir: `${root}/docker.sock` },
          }),
        ),
      Error,
      "control socket",
    );
  });
});

Deno.test("recovery authority - Apple retries keep the selected mode and report the advisory gap (Issue #4417)", async () => {
  await withRoot(async (root) => {
    const supported = appleCapabilities(
      "container CLI version 1.2.2",
      "27.0.1",
      "--internal",
      "--network",
    );
    const unsupported = appleCapabilities(
      "container CLI version 0.1.0",
      "15.0.1",
      "",
      "--network",
    );

    // An explicit internal request is never silently weakened.
    assertEquals(appleMode(undefined, supported), "internal");
    assertEquals(appleMode("internal", supported), "internal");
    assertThrows(
      () => appleMode("internal", unsupported),
      Error,
      "Apple internal mode unavailable",
    );
    // An advisory choice stays advisory.
    assertEquals(appleMode("advisory", supported), "advisory");
    assertEquals(appleMode("auto", unsupported), "advisory");

    // A bounded retry after failed setup keeps the mode on every attempt.
    const applePlan = buildContainerLaunchPlan(
      configured(root, { descriptor: descriptorFor("apple-container") }),
    );
    const parsed = parseContainerLaunchPlanText(
      renderContainerLaunchPlan(applePlan),
    );
    const mode = appleMode("internal", supported);
    const modes: string[] = [];
    let failures = 0;
    const ready = await retryAppleEgress(
      () => {
        modes.push(appleLaunch(parsed, mode, 4242, NONCE).mode);
        if (failures++ < 2) return Promise.reject(new Error("proxy not ready"));
        return Promise.resolve("ready");
      },
      {
        cancelled: () => false,
        failed: () => {},
        pause: () => Promise.resolve(),
      },
    );
    assertEquals(ready, "ready");
    assertEquals(modes, ["internal", "internal", "internal"]);

    // Internal keeps the worker on the proxy network; advisory does not claim it.
    const internal = appleLaunch(parsed, "internal", 4242, NONCE);
    assert(internal.run.includes(internal.network));
    const advisory = appleLaunch(parsed, "advisory", 4242, NONCE);
    assert(!advisory.run.includes(advisory.network));

    // The advisory residual gap: direct internet is accepted, internal refuses it.
    const controls = {
      proxyAllowlist: "enforced" as const,
      directInternetV4: "reachable" as const,
      directInternetV6: "reachable" as const,
      directHostname: "reachable" as const,
      hostLan: "blocked" as const,
      dns: "reachable" as const,
    };
    assertEquals(appleControlFailures("advisory", controls), []);
    assert(
      appleControlFailures("internal", controls).includes(
        "directInternetV4=reachable",
      ),
    );
  });
});
