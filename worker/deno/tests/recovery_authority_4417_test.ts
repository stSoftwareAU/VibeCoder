/**
 * Recovery never broadens a worker container's authority (Issue #4417).
 *
 * A worker container is launched with a configured authority: the mount set,
 * the credential sub-directories, the environment names, the network, the
 * egress enforcement, the allow-listed hosts and the privilege flags the launch
 * plan carries. A failure, a restart or a successful resumption must never
 * widen that authority. These tests drive the real restart classifier
 * (`nextContainerRestartDecision`) and the real plan builder
 * (`buildContainerLaunchPlan`) through each failure class, then check every
 * retried plan against the ceiling computed from the configured inputs before
 * any failure happened.
 *
 * They also fault-inject widened plans by mutation and assert that the named
 * rule refuses each one, and they exercise the production guards the builder
 * runs on its own argument lists by feeding it inputs that would produce a
 * widened list.
 *
 * Australian English spelling throughout (behaviour, authorised, etc.).
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  AGENT_STATE_VOLUME_NAME,
  APPROVAL_STATE_VOLUME_NAME,
  buildContainerLaunchPlan,
  type ContainerLaunchInputs,
  type ContainerLaunchPlan,
  containerTargetPaths,
  parseContainerLaunchPlanText,
  renderContainerLaunchPlan,
  WORK_VOLUME_NAME,
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
  STATE_FILENAME,
} from "../lib/container_restart_backoff.ts";
import { NETWORK_UNAVAILABLE_MARKER } from "../lib/github_user_resolution.ts";
import {
  appleCapabilities,
  appleLaunch,
  appleMode,
  retryAppleEgress,
} from "../lib/apple_egress_launch.ts";
import { appleControlFailures } from "../lib/apple_egress_controls.ts";

const TEST_FILE_PATH = new URL(import.meta.url).pathname;
const REPO_ROOT = TEST_FILE_PATH.replace(/\/worker\/deno\/tests\/[^/]+$/, "");

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
 * Violations of the configured authority. An empty list means `effective`
 * grants nothing the `ceiling` did not. Each violation names the rule that
 * refused it, so a test can assert the specific rule rather than "something".
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
 * The configured inputs for one deployment. Every test builds from this, so
 * the ceiling and the retries are the same configuration by construction.
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

/** Writes a provider's credential file. The bytes are a token, which refreshes. */
async function writeProviderCredential(
  root: string,
  subdir: string,
  bytes: string,
): Promise<void> {
  await Deno.mkdir(`${root}/credentials/${subdir}`, { recursive: true });
  await Deno.writeTextFile(`${root}/credentials/${subdir}/provider.env`, bytes);
}

/** One launcher outcome through the real classifier. */
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

Deno.test("recovery authority - a denied operation retries within the configured authority (Issue #4417)", async () => {
  await withRoot(async (root) => {
    const config = configured(root);
    const ceiling = authorityOf(buildContainerLaunchPlan(config));
    const networkUnavailable = isNetworkUnavailableLaunch(DENIAL_LOG);
    assertEquals(networkUnavailable, false);

    // Failure class (a): exit 1 from the worker run, a denial in the log.
    let state = emptyContainerRestartState(CLOCK);
    for (let i = 0; i < 3; i++) {
      const decision = step(state, 1, "container_run", networkUnavailable);
      assertEquals(decision.kind, "failure");
      assertEquals(decision.phase, "worker_run");
      state = decision.state;
    }
    assertEquals(state.consecutiveFailures, 3);

    // The retry is rebuilt from the same configured inputs, and must not widen.
    const retry = buildContainerLaunchPlan(config);
    assertLauncherView(retry);
    assertEquals(withinAuthority(ceiling, authorityOf(retry)), []);
    assertEquals(authorityOf(retry), ceiling);

    // Ordinary recovery is not denial-only: the run succeeds and the streak clears.
    const recovered = step(state, 0, null);
    assertEquals(recovered.kind, "success");
    assertEquals(recovered.recovered, true);
    assertEquals(recovered.state.consecutiveFailures, 0);
    assertEquals(retry.runArgs.at(-1), IMAGE);
  });
});

Deno.test("recovery authority - a transient authentication failure and credential refresh stay within the pool (Issue #4417)", async () => {
  await withRoot(async (root) => {
    const config = configured(root);
    const ceiling = authorityOf(buildContainerLaunchPlan(config));
    assertEquals(ceiling.credentialDirs, [
      "claude",
      "codex",
      GH_CREDENTIAL_SUBDIR,
    ]);

    // Failure class (b): two HTTP 401 failures on the stale claude token.
    await writeProviderCredential(
      root,
      "claude",
      "ANTHROPIC_API_KEY=stale-token\n",
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
      assertEquals(decision.phase, "worker_run");
      state = decision.state;
    }

    // Refresh: the same directory, different bytes.
    await writeProviderCredential(
      root,
      "claude",
      "ANTHROPIC_API_KEY=fresh-token\n",
    );
    assertEquals(
      await Deno.readTextFile(`${root}/credentials/claude/provider.env`),
      "ANTHROPIC_API_KEY=fresh-token\n",
    );
    const refreshed = buildContainerLaunchPlan(config);
    assertEquals(withinAuthority(ceiling, authorityOf(refreshed)), []);
    assertEquals(authorityOf(refreshed), ceiling);
    assertEquals(step(state, 0, null).kind, "success");

    // Rotation: the next launch runs the codex provider from the configured pool.
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

Deno.test("recovery authority - an egress failure or network-unavailable restart keeps enforcement and the internal network (Issue #4417)", async () => {
  await withRoot(async (root) => {
    const config = configured(root);
    const ceiling = authorityOf(buildContainerLaunchPlan(config));
    assertEquals(ceiling.egressEnforced, true);
    assertEquals(ceiling.network, NETWORK);

    // Failure class (c), first signal: the host egress probe refused the launch.
    const egress = step(
      emptyContainerRestartState(CLOCK),
      HOST_EGRESS_BLOCKED_EXIT_STATUS,
      "container_egress",
    );
    assertEquals(egress.kind, "failure");
    assertEquals(egress.phase, "container_egress");
    assertEquals(egress.escalate, true);

    // Failure class (c), second signal: GitHub unreachable for every attempt.
    assertEquals(isNetworkUnavailableLaunch(NETWORK_LOG), true);
    const unavailable = step(egress.state, 1, "container_run", true);
    assertEquals(unavailable.kind, "network_unavailable");
    assertEquals(unavailable.state.consecutiveFailures, 0);

    // The retry keeps enforcement, the internal network and the proxy.
    const retry = buildContainerLaunchPlan(config);
    assertLauncherView(retry);
    assertEquals(retry.egressEnforced, true);
    assertEquals(retry.networkCreateArgs.includes("--internal"), true);
    assert(retry.proxyRunArgs.length > 0);
    assertEquals(withinAuthority(ceiling, authorityOf(retry)), []);
    assertEquals(authorityOf(retry), ceiling);
    assertEquals(step(unavailable.state, 0, null).kind, "success");
    assertEquals(retry.runArgs.at(-1), IMAGE);
  });
});

Deno.test("recovery authority - an Apple egress failure keeps the explicit choice and claims no enforcement (Issue #4417)", async () => {
  await withRoot(async (root) => {
    const config = configured(root, {
      descriptor: descriptorFor("apple-container"),
    });
    const ceiling = authorityOf(buildContainerLaunchPlan(config));
    assertEquals(ceiling.egressEnforced, false);

    const egress = step(
      emptyContainerRestartState(CLOCK),
      HOST_EGRESS_BLOCKED_EXIT_STATUS,
      "container_egress",
    );
    assertEquals(egress.phase, "container_egress");

    // The retry keeps the Apple choice (#4051): not enforced, and says so.
    const retry = buildContainerLaunchPlan(config);
    assertLauncherView(retry);
    assertEquals(retry.egressEnforced, false);
    assert(retry.runArgs.includes(`${EGRESS_ENFORCED_ENV}=false`));
    assert(!retry.runArgs.includes(`${EGRESS_ENFORCED_ENV}=true`));
    assertEquals(withinAuthority(ceiling, authorityOf(retry)), []);
    assertEquals(authorityOf(retry), ceiling);
    assertEquals(step(egress.state, 0, null).kind, "success");
  });
});

Deno.test("recovery authority - the restart streak and the work volumes survive the failure streak (Issue #4417)", async () => {
  await withRoot(async (root) => {
    const config = configured(root);
    const before = buildContainerLaunchPlan(config);
    const beforeAuthority = authorityOf(before);

    let state = emptyContainerRestartState(CLOCK);
    for (let i = 0; i < 3; i++) {
      state = step(state, 1, "container_run").state;
    }
    const saved = await persistContainerRestartState(root, state);
    assertEquals(saved.ok, true);
    assert((await Deno.stat(`${root}/${STATE_FILENAME}`)).isFile);

    const loaded = await loadContainerRestartState(root);
    assertEquals(loaded.consecutiveFailures, 3);
    assertEquals(loaded.lastPhase, "worker_run");
    assertEquals(loaded.streakStartedAt, state.streakStartedAt);

    const after = buildContainerLaunchPlan(config);
    const durable = [
      WORK_VOLUME_NAME,
      APPROVAL_STATE_VOLUME_NAME,
      AGENT_STATE_VOLUME_NAME,
    ];
    assertEquals(before.volumes, durable);
    assertEquals(after.volumes, durable);
    assertEquals(after.resettableVolumes, [
      WORK_VOLUME_NAME,
      AGENT_STATE_VOLUME_NAME,
    ]);
    assertEquals(withinAuthority(beforeAuthority, authorityOf(after)), []);
  });
});

Deno.test("recovery authority - an explicit authorised change is accepted only against the recomputed ceiling (Issue #4417)", async () => {
  await withRoot(async (root) => {
    // A new allow-listed host, configured deliberately.
    const oldConfig = configured(root);
    const oldCeiling = authorityOf(buildContainerLaunchPlan(oldConfig));
    const newHosts = [...HOSTS, "logs.example.test"];
    const newConfig = configured(root, { egressAllowHosts: newHosts });
    const newPlan = buildContainerLaunchPlan(newConfig);
    assertEquals(withinAuthority(oldCeiling, authorityOf(newPlan)), [
      "allow-host:added logs.example.test",
    ]);
    const newCeiling = authorityOf(buildContainerLaunchPlan(newConfig));
    assertEquals(withinAuthority(newCeiling, authorityOf(newPlan)), []);

    // A second configured provider, with the allow-list held fixed.
    const soloConfig = configured(root, {
      agentProviders: [resolveAgentProvider(CLAUDE_PROVIDER_ID)],
    });
    const soloCeiling = authorityOf(buildContainerLaunchPlan(soloConfig));
    const poolPlan = buildContainerLaunchPlan(configured(root));
    assertEquals(withinAuthority(soloCeiling, authorityOf(poolPlan)), [
      "credential:added codex",
    ]);
    const poolCeiling = authorityOf(buildContainerLaunchPlan(configured(root)));
    assertEquals(withinAuthority(poolCeiling, authorityOf(poolPlan)), []);
  });
});

Deno.test("recovery authority - a same-scope credential refresh yields no violations (Issue #4417)", async () => {
  await withRoot(async (root) => {
    const config = configured(root);
    const ceiling = authorityOf(buildContainerLaunchPlan(config));
    for (
      const bytes of [
        "ANTHROPIC_API_KEY=token-one\n",
        "ANTHROPIC_API_KEY=token-two\n",
      ]
    ) {
      await writeProviderCredential(root, "claude", bytes);
      const plan = buildContainerLaunchPlan(config);
      assertEquals(withinAuthority(ceiling, authorityOf(plan)), []);
      assertEquals(authorityOf(plan), ceiling);
    }
  });
});

Deno.test("recovery authority - an extra writable host mount is refused by the mount rule (Issue #4417)", async () => {
  await withRoot(async (root) => {
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

Deno.test("recovery authority - an extra credential sub-directory is refused by the credential rule (Issue #4417)", async () => {
  await withRoot(async (root) => {
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

Deno.test("recovery authority - host networking and dropped egress enforcement are refused (Issue #4417)", async () => {
  await withRoot(async (root) => {
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

Deno.test("recovery authority - an added privilege flag is refused by the privilege rule (Issue #4417)", async () => {
  await withRoot(async (root) => {
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

Deno.test("recovery authority - a widened allow-host or environment name is refused (Issue #4417)", async () => {
  await withRoot(async (root) => {
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
  await withRoot(async (root) => {
    // The guards are private to the builder, so the builder is driven with
    // inputs that would produce each widened list. The unwidened inputs pass.
    buildContainerLaunchPlan(configured(root));

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
