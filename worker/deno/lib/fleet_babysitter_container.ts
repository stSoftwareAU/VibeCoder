/**
 * Runs a fleet PR babysitter repair in a container (Issue #4767).
 *
 * The repair agent must not run on the host: it reads a clone it did not
 * write and must never see the babysitter App's private key. This module
 * takes the worker's own container launch plan (the one `run.sh` executes)
 * and turns it into a repair run. It mirrors `round_container` and
 * `round_args` in `.claude/skills/review-fleet-prs/scripts/run.sh`, the
 * pattern it copies: the plan's named volumes are left out, the clone and
 * scratch directories are mounted in their place, and the agent's read-only
 * token is passed by name alone (`--env GH_TOKEN`), so its value is never on
 * a command line.
 *
 * Not wired into `fix()` in `commands/fleet_pr_babysitter.ts` yet; nothing
 * calls this module in production.
 */

import { buildLaunchPlanForCommand } from "../commands/container_launch_plan.ts";
import type { ContainerLaunchPlan } from "./container_launch.ts";
import { runWithTimeout } from "./subprocess_timeout.ts";
import {
  canonicalPathIncludingMissingTail,
  normaliseAbsolutePath,
} from "./fleet_babysitter_sandbox.ts";

/** A repair may run for 90 minutes before it is killed. */
export const BABYSITTER_REPAIR_TIMEOUT_MS = 90 * 60_000;
/** Where the clone is mounted inside the container. */
export const BABYSITTER_CLONE_MOUNT = "/babysitter/clone";
/** Where the scratch directory (the prompt file) is mounted inside it. */
export const BABYSITTER_SCRATCH_MOUNT = "/babysitter/scratch";
/** The fixed command line after the image. */
export const BABYSITTER_REPAIR_COMMAND: readonly string[] = [
  "babysitter-repair",
  "--dir",
  "/babysitter/clone",
  "--prompt-file",
  "/babysitter/scratch/prompt.md",
  "--response-file",
  "/babysitter/clone/.babysitter-response",
];

/** What one runtime process did. */
export interface BabysitterSpawnResult {
  success: boolean;
  code: number;
  stderr: string;
  timedOut: boolean;
}

/** Seams the tests replace. Each default talks to the real host. */
export interface BabysitterContainerDeps {
  /** Is the runtime executable on PATH (default: scan PATH with Deno.stat). */
  onPath: (runtime: string) => Promise<boolean>;
  /** Default: buildLaunchPlanForCommand(baseDir, containerName). */
  buildPlan: (
    baseDir: string,
    containerName: string,
  ) => Promise<ContainerLaunchPlan>;
  /** Runs `<runtime> <plan.imageInspectArgs>`; true when it exits 0. */
  imageExists: (
    runtime: string,
    args: string[],
    env: Record<string, string>,
  ) => Promise<boolean>;
  /**
   * The only way a runtime process is started, for the repair and for the
   * kill. The default runs with `clearEnv`, so only `env` reaches the child.
   */
  spawn: (
    runtime: string,
    args: string[],
    options: { env: Record<string, string>; timeoutMs: number },
  ) => Promise<BabysitterSpawnResult>;
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

function baseEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of BASE_ENV_ALLOWLIST) {
    const value = Deno.env.get(name);
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * True when the runtime executable is on PATH: a regular, executable file in
 * one of the PATH directories. No process is spawned. Exported as the
 * default for {@link BabysitterContainerDeps.onPath}.
 */
export async function babysitterRuntimeOnPath(
  runtime: string,
): Promise<boolean> {
  const separator = Deno.build.os === "windows" ? ";" : ":";
  const dirs = (Deno.env.get("PATH") ?? "").split(separator).filter((dir) =>
    dir !== ""
  );
  for (const dir of dirs) {
    try {
      const info = await Deno.stat(`${dir}/${runtime}`);
      if (!info.isFile) continue;
      if (Deno.build.os === "windows" || ((info.mode ?? 0) & 0o111) !== 0) {
        return true;
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return false;
}

/**
 * The run arguments, without the runtime; they begin with the plan's own
 * `run`. Drops every `--volume` whose source is one of the plan's named
 * volumes (the work and agent-state volumes), then adds the clone and scratch
 * mounts, `--env GH_TOKEN`, the image and the repair command. Pure; exported
 * for tests.
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
  const body: string[] = [];
  const bodyArgs = runArgs.slice(0, -1);
  for (let i = 0; i < bodyArgs.length; i++) {
    const arg = bodyArgs[i] ?? "";
    if (arg === "--volume" && i + 1 < bodyArgs.length) {
      const value = bodyArgs[i + 1] ?? "";
      const colon = value.indexOf(":");
      const src = colon === -1 ? value : value.slice(0, colon);
      if (named.has(src)) {
        i++;
        continue;
      }
      body.push(arg, value);
      i++;
      continue;
    }
    body.push(arg);
  }
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "--env") continue;
    const spec = body[i + 1] ?? "";
    if (spec === "GH_TOKEN" || spec.startsWith("GH_TOKEN=")) {
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

/** True when `source` is `key`, or a directory on a path-segment boundary above it. */
function isAtOrAbove(source: string, key: string): boolean {
  return source === "/" || source === key || key.startsWith(`${source}/`);
}

/**
 * Refuses a run whose mounts reach the App private key (Issue #4767). Every
 * `--volume` source must be absolute and must not be the key or an ancestor
 * of it, checked lexically and canonically, so `..` and symlinks cannot
 * reach it. The key path must not appear in any argument. Throws, naming the
 * cause, and never prints the token. Pattern: `round_args` in run.sh.
 */
export async function assertBabysitterKeyOutOfRunArgs(
  args: readonly string[],
  privateKeyPath: string,
): Promise<void> {
  const keyForms = [
    normaliseAbsolutePath(privateKeyPath),
    await canonicalPathIncludingMissingTail(privateKeyPath),
  ];
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
    const sourceForms = [
      normaliseAbsolutePath(src),
      await canonicalPathIncludingMissingTail(src),
    ];
    for (const source of sourceForms) {
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

/** Trimmed stderr with the token redacted, capped at 500 characters. */
function describeStderr(stderr: string, token: string): string {
  const redacted = stderr.split(token).join("***").trim();
  if (redacted === "") return "(no stderr)";
  return redacted.length > STDERR_CAP
    ? redacted.slice(0, STDERR_CAP)
    : redacted;
}

/**
 * Runs one babysitter repair in a container and returns its name (Issue
 * #4767). Mirrors `round_container` in run.sh: the plan is checked, the image
 * is preflighted, and nothing falls back to a host process. Egress-enforced
 * plans are refused until the egress sub-issue lands. A timed-out repair is
 * killed by name. Not wired into `fix()` yet.
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
      throw new Error(`the babysitter ${label} path must be absolute`);
    }
  }
  if (input.token.trim() === "") {
    throw new Error(
      "the babysitter repair needs the agent's GH_TOKEN; it is empty",
    );
  }
  const timeoutMs = input.timeoutMs ?? BABYSITTER_REPAIR_TIMEOUT_MS;
  const onPath = deps.onPath ?? babysitterRuntimeOnPath;
  const buildPlan = deps.buildPlan ??
    ((baseDir, containerName) =>
      buildLaunchPlanForCommand(baseDir, containerName));
  const imageExists = deps.imageExists ?? (async (runtime, args, env) => {
    const result = await runWithTimeout(runtime, args, {
      timeoutMs: 30_000,
      env,
      clearEnv: true,
    });
    return result.ok && result.value.success;
  });
  const spawn = deps.spawn ?? (async (runtime, args, options) => {
    const result = await runWithTimeout(runtime, args, {
      timeoutMs: options.timeoutMs,
      env: options.env,
      clearEnv: true,
    });
    if (!result.ok) throw result.error;
    const { success, code, stderr, timedOut } = result.value;
    return { success, code, stderr, timedOut };
  });

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
  const baseEnv = baseEnvironment();
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
