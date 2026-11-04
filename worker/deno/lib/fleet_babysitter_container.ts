/**
 * Runs a fleet PR babysitter repair in a container (Issue #4767).
 *
 * The repair agent must not run on the host: it reads a clone it did not
 * write and must never see the babysitter App's private key. This module
 * takes the worker's own container launch plan (the one `run.sh` executes)
 * and turns it into a repair run. It mirrors `round_container` and
 * `round_args` in `.claude/skills/review-fleet-prs/scripts/run.sh`: the
 * plan's named volumes are left out, the clone and scratch directories are
 * mounted in their place, and the agent's read-only token is passed by name
 * alone (`--env GH_TOKEN`), so its value is never on a command line.
 *
 * Not working end to end yet: the in-container `babysitter-repair` command is
 * not in the worker image. #4768 will add it, so a real run today fails
 * inside the container. This module is not wired into `fix()` in
 * `commands/fleet_pr_babysitter.ts`; #4774 will wire it.
 */

import { buildLaunchPlanForCommand } from "../commands/container_launch_plan.ts";
import type { ContainerLaunchPlan } from "./container_launch.ts";
import { runWithTimeout } from "./subprocess_timeout.ts";
import {
  canonicalPathIncludingMissingTail,
  normaliseAbsolutePath,
} from "./fleet_babysitter_sandbox.ts";
import { redactSecrets } from "./secret_redaction.ts";

/** A repair may run for 90 minutes before it is killed. */
export const BABYSITTER_REPAIR_TIMEOUT_MS = 90 * 60_000;
/** Where the clone is mounted inside the container. */
export const BABYSITTER_CLONE_MOUNT = "/babysitter/clone";
/** Where the scratch directory (the prompt file) is mounted inside it. */
export const BABYSITTER_SCRATCH_MOUNT = "/babysitter/scratch";
/**
 * The fixed command line after the image. `babysitter-repair` is not in the
 * worker image yet (#4768 adds it), so a real run fails inside the container
 * until then.
 */
export const BABYSITTER_REPAIR_COMMAND: readonly string[] = [
  "babysitter-repair",
  "--dir",
  BABYSITTER_CLONE_MOUNT,
  "--prompt-file",
  `${BABYSITTER_SCRATCH_MOUNT}/prompt.md`,
  "--response-file",
  `${BABYSITTER_CLONE_MOUNT}/.babysitter-response`,
];

/** What one runtime process did. */
export interface BabysitterSpawnResult {
  success: boolean;
  code: number;
  stderr: string;
  timedOut: boolean;
}

/** Reads one host environment variable. */
export type BabysitterEnvReader = (name: string) => string | undefined;

/** Seams the tests replace. Each default talks to the real host. */
export interface BabysitterContainerDeps {
  /** Is the runtime executable on PATH (default: babysitterRuntimeOnPath). */
  onPath: (runtime: string) => Promise<boolean>;
  /** Default: buildLaunchPlanForCommand(baseDir, containerName). */
  buildPlan: (
    baseDir: string,
    containerName: string,
  ) => Promise<ContainerLaunchPlan>;
  /** Runs `<runtime> <plan.imageInspectArgs>` (default: babysitterImageExists). */
  imageExists: (
    runtime: string,
    args: string[],
    env: Record<string, string>,
  ) => Promise<boolean>;
  /**
   * The only way a runtime process is started, for the repair and for the
   * kill (default: babysitterSpawn, which starts from an empty environment).
   */
  spawn: (
    runtime: string,
    args: string[],
    options: { env: Record<string, string>; timeoutMs: number },
  ) => Promise<BabysitterSpawnResult>;
  /** Reads the host environment (default: Deno.env.get). Tests inject one. */
  env?: BabysitterEnvReader;
}

/** What a babysitter repair needs from its caller. */
export interface BabysitterContainerInput {
  /** Checkout holding worker/deno, passed to the plan builder. */
  baseDir: string;
  /** Absolute host path, mounted at {@link BABYSITTER_CLONE_MOUNT}. */
  clone: string;
  /** Absolute host path, mounted at {@link BABYSITTER_SCRATCH_MOUNT}. */
  scratch: string;
  /** Absolute path of the babysitter GitHub App private key. */
  privateKeyPath: string;
  /** The agent's read-only GH_TOKEN. Passed in the env only. */
  token: string;
  /** Default {@link BABYSITTER_REPAIR_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** The only host environment variables a repair or kill receives. */
const BASE_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "DOCKER_HOST",
  "XDG_RUNTIME_DIR",
  "CONTAINER_HOST",
];

const STDERR_CAP = 500;
const INSPECT_TIMEOUT_MS = 30_000;

function processEnv(name: string): string | undefined {
  return Deno.env.get(name);
}

function baseEnvironment(env: BabysitterEnvReader): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of BASE_ENV_ALLOWLIST) {
    const value = env(name);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * True when the runtime executable is on PATH: a regular, executable file in
 * one of the PATH directories. No process is spawned. Like `command -v`, a
 * PATH entry that cannot be stat'd is skipped.
 */
export async function babysitterRuntimeOnPath(
  runtime: string,
  env: BabysitterEnvReader = processEnv,
): Promise<boolean> {
  const separator = Deno.build.os === "windows" ? ";" : ":";
  const dirs = (env("PATH") ?? "").split(separator).filter((dir) => dir !== "");
  for (const dir of dirs) {
    try {
      const info = await Deno.stat(`${dir}/${runtime}`);
      if (!info.isFile) continue;
      if (Deno.build.os === "windows" || ((info.mode ?? 0) & 0o111) !== 0) {
        return true;
      }
    } catch {
      // Not usable from this entry; keep looking, as `command -v` does.
    }
  }
  return false;
}

/**
 * The default spawn: runs `runtime` from an empty environment, so only `env`
 * reaches the child (Issue #806). A start failure throws; a timeout or a
 * non-zero exit is returned for the caller to act on.
 */
export async function babysitterSpawn(
  runtime: string,
  args: string[],
  options: { env: Record<string, string>; timeoutMs: number },
): Promise<BabysitterSpawnResult> {
  const result = await runWithTimeout(runtime, args, {
    timeoutMs: options.timeoutMs,
    env: options.env,
    clearEnv: true,
  });
  if (!result.ok) {
    throw new Error(`cannot start ${runtime}: ${result.error.message}`);
  }
  const { success, code, stderr, timedOut } = result.value;
  return { success, code, stderr, timedOut };
}

/**
 * The default image check: true only when the inspect exits 0. A non-zero
 * exit is "not built" (false). A spawn failure or a timeout throws, so it is
 * never mistaken for a missing image.
 */
export async function babysitterImageExists(
  runtime: string,
  args: string[],
  env: Record<string, string>,
): Promise<boolean> {
  const result = await runWithTimeout(runtime, args, {
    timeoutMs: INSPECT_TIMEOUT_MS,
    env,
    clearEnv: true,
  });
  if (!result.ok) {
    throw new Error(
      `cannot inspect the worker image with ${runtime}: ${result.error.message}`,
    );
  }
  if (result.value.timedOut) {
    throw new Error(
      `cannot inspect the worker image with ${runtime}: timed out`,
    );
  }
  return result.value.success;
}

/**
 * The run arguments, without the runtime. They begin with the plan's own
 * `run`. Starts from the plan's run arguments, drops every `--volume` whose
 * source is one of the plan's named volumes (the work and agent-state
 * volumes), then appends the clone and scratch mounts, `--env GH_TOKEN`, the
 * image and the repair command. Refuses any plan flag that could mount a
 * path or load an env file by another spelling, and any plan env spec that
 * sets GH_TOKEN. Pure; exported for tests.
 */
export function buildBabysitterRunArgs(
  plan: ContainerLaunchPlan,
  input: { clone: string; scratch: string },
): string[] {
  const runArgs = plan.runArgs;
  if (runArgs.length === 0 || runArgs[runArgs.length - 1] !== plan.image) {
    throw new Error(
      `the container plan does not end with its image ${plan.image}`,
    );
  }
  const named = new Set([...plan.volumes, ...plan.resettableVolumes]);
  const bodyArgs = runArgs.slice(0, -1);
  const body: string[] = [];
  for (let i = 0; i < bodyArgs.length; i++) {
    const arg = bodyArgs[i] ?? "";
    // Fail closed: only the spaced --volume and --env spellings are allowed.
    // Any other mount or env-file spelling (-v, --mount, --env-file and their
    // attached forms) is refused rather than checked.
    if (
      arg === "-v" || arg.startsWith("-v") || arg === "--mount" ||
      arg.startsWith("--mount=") || arg === "--env-file" ||
      arg.startsWith("--env-file=") || arg.startsWith("--volume=")
    ) {
      throw new Error(
        `refusing plan argument ${arg}: the repair takes mounts only as --volume and env only as --env`,
      );
    }
    if (arg === "--volume" && i + 1 < bodyArgs.length) {
      const value = bodyArgs[i + 1] ?? "";
      const colon = value.indexOf(":");
      const src = colon === -1 ? value : value.slice(0, colon);
      i++;
      if (named.has(src)) continue;
      body.push(arg, value);
      continue;
    }
    body.push(arg);
  }
  for (let i = 0; i < body.length; i++) {
    const arg = body[i] ?? "";
    let spec: string | undefined;
    if (arg === "--env" || arg === "-e") spec = body[i + 1] ?? "";
    else if (arg.startsWith("--env=")) spec = arg.slice("--env=".length);
    else if (arg.startsWith("-e")) spec = arg.slice(2).replace(/^=/, "");
    if (
      spec !== undefined &&
      (spec === "GH_TOKEN" || spec.startsWith("GH_TOKEN="))
    ) {
      throw new Error(
        "the container plan carries GH_TOKEN; the repair receives the token alone",
      );
    }
  }
  return [
    ...body,
    "--volume",
    `${input.clone}:${BABYSITTER_CLONE_MOUNT}`,
    "--volume",
    `${input.scratch}:${BABYSITTER_SCRATCH_MOUNT}`,
    "--env",
    "GH_TOKEN",
    plan.image,
    ...BABYSITTER_REPAIR_COMMAND,
  ];
}

/**
 * The lexical, canonical and normalised-then-canonical forms of a path. A
 * source like `<root>/missing/../link` collapses its `..` textually in the
 * canonical form, so the normalised-then-canonical form is needed to follow
 * a symlink there (as `babysitterProtectedPaths` does).
 */
async function pathForms(path: string): Promise<string[]> {
  const normalised = normaliseAbsolutePath(path);
  return [
    ...new Set([
      normalised,
      await canonicalPathIncludingMissingTail(path),
      await canonicalPathIncludingMissingTail(normalised),
    ]),
  ];
}

/** True when `source` is `key`, or a directory on a path-segment boundary above it. */
function isAtOrAbove(source: string, key: string): boolean {
  return source === "/" || source === key || key.startsWith(`${source}/`);
}

/**
 * Refuses a run whose mounts reach the App private key (Issue #4767). Every
 * `--volume` source must be absolute and must not be the key or an ancestor
 * of it, in each form of {@link pathForms}, so `..` and symlinks cannot reach
 * it. The key path must not appear in any argument. Throws, naming the cause,
 * and never prints the token. Pattern: `round_args` in run.sh.
 */
export async function assertBabysitterKeyOutOfRunArgs(
  args: readonly string[],
  privateKeyPath: string,
): Promise<void> {
  const keyForms = await pathForms(privateKeyPath);
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--volume") continue;
    const value = args[i + 1] ?? "";
    const colon = value.indexOf(":");
    const src = colon === -1 ? value : value.slice(0, colon);
    if (!src.startsWith("/")) {
      throw new Error(
        `refusing to mount ${src}: the source is not an absolute path`,
      );
    }
    for (const source of await pathForms(src)) {
      for (const key of keyForms) {
        if (isAtOrAbove(source, key)) {
          throw new Error(
            `refusing to mount ${src}: it is at or above the babysitter App private key`,
          );
        }
      }
    }
  }
  const keyPaths = [privateKeyPath, ...keyForms];
  for (const arg of args) {
    for (const key of keyPaths) {
      if (arg.includes(key)) {
        throw new Error(
          "refusing to pass the babysitter App private key path in an argument",
        );
      }
    }
  }
}

/**
 * Stderr for an error message: the token and any other secret redacted, then
 * trimmed and capped at 500 characters. The token is replaced first, so no
 * partial token survives the cap.
 */
function describeStderr(stderr: string, token: string): string {
  const redacted = redactSecrets(stderr.split(token).join("***")).trim();
  if (redacted === "") return "(no stderr)";
  return redacted.length > STDERR_CAP
    ? redacted.slice(0, STDERR_CAP)
    : redacted;
}

/**
 * Runs one babysitter repair in a container and returns its name (Issue
 * #4767). Mirrors `round_container` in run.sh, the pattern this copies: the
 * plan is checked, the image is preflighted, and nothing falls back to a host
 * process. Egress-enforced plans are refused until the egress sub-issue lands.
 * A timed-out repair is killed by name. The in-container command is not in
 * the image yet (#4768), so a real run fails inside the container. Not wired
 * into `fix()` yet (#4774).
 */
export async function runBabysitterRepairContainer(
  input: BabysitterContainerInput,
  deps: Partial<BabysitterContainerDeps> = {},
): Promise<{ containerName: string }> {
  for (
    const [label, path] of [
      ["clone", input.clone],
      ["scratch", input.scratch],
      ["private key", input.privateKeyPath],
    ] as const
  ) {
    if (!path.startsWith("/") || path.includes("\0")) {
      throw new Error(
        `the babysitter ${label} path must be an absolute path with no NUL byte`,
      );
    }
  }
  if (input.token.trim() === "") {
    throw new Error(
      "the babysitter repair needs the agent's GH_TOKEN; it is empty",
    );
  }
  const env = deps.env ?? processEnv;
  const timeoutMs = input.timeoutMs ?? BABYSITTER_REPAIR_TIMEOUT_MS;
  const onPath = deps.onPath ??
    ((runtime: string) => babysitterRuntimeOnPath(runtime, env));
  const buildPlan = deps.buildPlan ??
    ((baseDir: string, containerName: string) =>
      buildLaunchPlanForCommand(baseDir, containerName));
  const imageExists = deps.imageExists ?? babysitterImageExists;
  const spawn = deps.spawn ?? babysitterSpawn;

  const containerName = `vibe-babysitter-${Date.now().toString(36)}-${
    crypto.randomUUID().slice(0, 8)
  }`;
  const plan = await buildPlan(input.baseDir, containerName);

  // The egress sub-issue replaces this refusal; until then nothing starts.
  if (plan.egressEnforced || plan.proxyName !== "") {
    throw new Error(
      "the plan needs the egress proxy, which babysitter repairs do not start yet",
    );
  }

  const args = buildBabysitterRunArgs(plan, {
    clone: input.clone,
    scratch: input.scratch,
  });
  await assertBabysitterKeyOutOfRunArgs(args, input.privateKeyPath);

  if (!await onPath(plan.runtime)) {
    throw new Error(
      `cannot run ${plan.runtime}: the container runtime is not on PATH`,
    );
  }
  const baseEnv = baseEnvironment(env);
  if (!await imageExists(plan.runtime, plan.imageInspectArgs, baseEnv)) {
    throw new Error(
      "the worker image is not built; start the Vibe Coder (./run.sh) once to build it",
    );
  }

  const result = await spawn(plan.runtime, args, {
    env: { ...baseEnv, GH_TOKEN: input.token },
    timeoutMs,
  });

  if (result.timedOut) {
    const minutes = Math.round(timeoutMs / 60_000);
    let killFailure: string | undefined;
    try {
      const kill = await spawn(plan.runtime, ["kill", containerName], {
        env: baseEnv,
        timeoutMs: 30_000,
      });
      if (!kill.success) {
        killFailure = `exit code ${kill.code}: ${
          describeStderr(kill.stderr, input.token)
        }`;
      }
    } catch (error) {
      killFailure = error instanceof Error ? error.message : String(error);
    }
    if (killFailure !== undefined) {
      throw new Error(
        `babysitter repair timed out after ${minutes} minutes; container ${containerName} not killed; kill failed: ${killFailure}`,
      );
    }
    throw new Error(
      `babysitter repair timed out after ${minutes} minutes; container ${containerName} killed`,
    );
  }
  if (!result.success) {
    throw new Error(
      `babysitter repair container ${containerName} exited with code ${result.code}: ${
        describeStderr(result.stderr, input.token)
      }`,
    );
  }
  return { containerName };
}
