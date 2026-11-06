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
 * Egress (Issue #4769): a plan that enforces egress (docker or podman) gets
 * its internal network and proxy from `startEgressSidecar`. A plan with a
 * proxy and no enforcement (Apple container) gets its run arguments from the
 * Apple helper, `apple_egress_launch_main.ts`. Both start after the preflight
 * and are stopped in a `finally`. A failed start fails the repair instead of
 * falling back to the runtime's open network, and a failed teardown never
 * hides the repair's own result. The Apple helper may run in its advisory
 * mode, where host/LAN isolation is not promised (see `apple_egress_launch.ts`).
 *
 * Not working end to end yet: the in-container `babysitter-repair` command is
 * not in the worker image. #4768 will add it, so a real run today fails
 * inside the container. This module is not wired into `fix()` in
 * `commands/fleet_pr_babysitter.ts`; #4774 will wire it.
 */

import { buildLaunchPlanForCommand } from "../commands/container_launch_plan.ts";
import {
  type ContainerLaunchPlan,
  renderContainerLaunchPlan,
} from "./container_launch.ts";
import {
  runWithTimeout,
  spawnCommandWithTimeout,
} from "./subprocess_timeout.ts";
import {
  canonicalPathIncludingMissingTail,
  normaliseAbsolutePath,
} from "./fleet_babysitter_sandbox.ts";
import { redactSecrets } from "./secret_redaction.ts";
import { startEgressSidecar, stopEgressSidecar } from "./egress_sidecar.ts";

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

/**
 * A started Apple egress helper (Issue #4769): the run arguments it hands
 * back, and the means to stop it.
 */
export interface BabysitterAppleEgress {
  /** The run arguments the helper wrote, ending with the image. */
  runArgs: string[];
  /**
   * Stops the helper and removes its files. Returns the problems, empty when
   * clean. Idempotent; never throws.
   */
  stop: () => Promise<string[]>;
}

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
  /**
   * Starts the Apple egress helper (default: babysitterStartAppleEgress, which
   * reads the host environment through `env`).
   */
  startAppleEgress?: (
    plan: ContainerLaunchPlan,
    options: AppleEgressOptions,
  ) => Promise<BabysitterAppleEgress>;
  /** Starts the docker or podman egress sidecar (default: startEgressSidecar). */
  startSidecar?: (plan: ContainerLaunchPlan) => Promise<unknown>;
  /**
   * Removes the sidecar and returns the problems, empty when clean (default:
   * stopEgressSidecar).
   */
  stopSidecar?: (plan: ContainerLaunchPlan) => Promise<string[]>;
  /**
   * Receives progress and teardown problems (default: console.error, prefixed
   * `[babysitter] `).
   */
  log?: (message: string) => void;
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
/**
 * The Apple helper, as the review-fleet-prs run.sh's `round_egress` runs it
 * (Issue #4769).
 */
const APPLE_HELPER_SCRIPT = "worker/deno/apple_egress_launch_main.ts";
/** How long the helper may wait for its ready file. */
const APPLE_READY_TIMEOUT_MS = 300_000;
/** How often the ready file is looked for. */
const APPLE_POLL_MS = 200;
/** How long a stopped helper may take to exit before it is killed. */
const APPLE_STOP_GRACE_MS = 60_000;
/** Slack over the repair timeout before the helper itself is killed. */
const APPLE_HELPER_GRACE_MS = 15 * 60_000;
/** How long the helper's log pipe may take to drain after it exits. */
const LOG_DRAIN_MS = 5_000;
/** Cap on the helper's failure cause in the error message. */
const CAUSE_CAP = 500;
const ATTEMPT_LINE = /^\[egress\] attempt \d+\/3 failed: /;
/** Stands in for a helper whose exit status could not be read. */
const UNKNOWN_EXIT: Deno.CommandStatus = {
  success: false,
  code: -1,
  signal: null,
};

/** What the Apple helper needs: the checkout and the repair timeout. */
type AppleEgressOptions = { baseDir: string; timeoutMs: number };

/** A running Apple helper process and the state its stop needs. */
interface AppleHelper {
  child: Deno.ChildProcess;
  /** Resolves once the helper has exited; never rejects. */
  exited: Promise<void>;
  /** Set once the helper has exited; undefined while it runs. */
  status?: Deno.CommandStatus;
  /** Resolves once its stderr pipe to the log has finished; never rejects. */
  logged: Promise<void>;
  /** The memoised stop, so a second stop changes nothing. */
  stopping?: Promise<string[]>;
}

/** Tears an egress down, returning the problems (empty when clean). */
type Teardown = () => Promise<string[]>;

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

/** Text with the token replaced and any other secret redacted. */
function redactToken(text: string, token: string): string {
  return redactSecrets(text.split(token).join("***"));
}

/**
 * Stderr for an error message: the token and any other secret redacted, then
 * trimmed and capped at 500 characters. The token is replaced first, so no
 * partial token survives the cap.
 */
function describeStderr(stderr: string, token: string): string {
  const redacted = redactToken(stderr, token).trim();
  if (redacted === "") return "(no stderr)";
  return redacted.length > STDERR_CAP
    ? redacted.slice(0, STDERR_CAP)
    : redacted;
}

/** Resolves after `ms`. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when a file exists at `path`. */
async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Removes a directory tree. Returns the failure message, or undefined. */
async function removeDir(dir: string): Promise<string | undefined> {
  try {
    await Deno.remove(dir, { recursive: true });
    return undefined;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Resolves true when `done` settles within `ms`, false when the time runs
 * out first. The timer is cleared either way, so no timer outlives the wait.
 */
function waitUpTo(done: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  return Promise.race([done.then(() => true), expired]).finally(() =>
    clearTimeout(timer)
  );
}

/** Sends a signal to the helper, ignoring one that has already exited. */
function signalHelper(child: Deno.ChildProcess, signal: Deno.Signal): void {
  try {
    child.kill(signal);
  } catch {
    // The helper already exited.
  }
}

/** The host environment the Apple helper receives (run.sh's round env). */
function appleHelperEnv(env: BabysitterEnvReader): Record<string, string> {
  const out = baseEnvironment(env);
  const mode = env("VIBE_APPLE_EGRESS_MODE");
  if (mode !== undefined) out.VIBE_APPLE_EGRESS_MODE = mode;
  return out;
}

/**
 * Starts the Apple helper with its stdout discarded and its stderr piped to
 * `<dir>/egress.log`. The plan is already written to `<dir>/plan`.
 */
async function spawnAppleHelper(
  dir: string,
  options: AppleEgressOptions,
  env: BabysitterEnvReader,
): Promise<AppleHelper> {
  const logFile = await Deno.open(`${dir}/egress.log`, {
    write: true,
    create: true,
  });
  let child: Deno.ChildProcess;
  try {
    child = spawnCommandWithTimeout(Deno.execPath(), {
      args: [
        "run",
        "--frozen",
        "--lock=worker/deno/deno.lock",
        "--allow-env",
        "--allow-read",
        "--allow-write",
        "--allow-run",
        "--allow-net",
        "--allow-sys",
        APPLE_HELPER_SCRIPT,
        `${dir}/plan`,
        `${dir}/plan.apple-ready`,
        dir,
        String(Deno.pid),
      ],
      cwd: options.baseDir,
      env: appleHelperEnv(env),
      clearEnv: true,
      stdin: "null",
      stdout: "null",
      stderr: "piped",
      timeoutMs: options.timeoutMs + APPLE_HELPER_GRACE_MS,
    });
  } catch (error) {
    logFile.close();
    throw error;
  }
  const logged = child.stderr.pipeTo(logFile.writable).then(
    () => {},
    () => {},
  );
  const helper: AppleHelper = { child, logged, exited: Promise.resolve() };
  helper.exited = child.status.catch(() => UNKNOWN_EXIT).then((status) => {
    helper.status = status;
  });
  return helper;
}

/**
 * Polls for the ready file. Stops waiting as soon as the helper has exited,
 * or when the deadline passes. True only when the file appeared.
 */
async function waitForReady(
  readyFile: string,
  helper: AppleHelper,
  timeoutMs: number,
  pollMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!await fileExists(readyFile)) {
    if (helper.status !== undefined || Date.now() >= deadline) return false;
    await pause(pollMs);
  }
  return true;
}

/**
 * The cause for an egress setup failure: the most recent
 * `[egress] attempt N/3 failed` line, else the last non-blank log line, else
 * a note that the helper printed nothing. Redacted and capped.
 */
async function setupFailureCause(
  logPath: string,
  code: number | undefined,
): Promise<string> {
  const text = await Deno.readTextFile(logPath).catch(() => "");
  const lines = text.split("\n").map((line) => line.trim()).filter((line) =>
    line !== ""
  );
  const attempt = lines.findLast((line) => ATTEMPT_LINE.test(line));
  const cause = attempt ?? lines.at(-1) ??
    `(no output; helper exited with code ${code ?? "unknown"})`;
  return redactSecrets(cause).slice(0, CAUSE_CAP);
}

/**
 * Stops the helper: SIGTERM, then SIGKILL after the grace period. Reports a
 * non-zero exit that was not a signal. Never throws.
 */
async function stopHelperProcess(helper: AppleHelper): Promise<string[]> {
  const problems: string[] = [];
  if (helper.status === undefined) {
    signalHelper(helper.child, "SIGTERM");
    if (!await waitUpTo(helper.exited, APPLE_STOP_GRACE_MS)) {
      signalHelper(helper.child, "SIGKILL");
      await helper.exited;
      problems.push(
        `egress helper did not exit within ${
          APPLE_STOP_GRACE_MS / 1000
        }s; it was killed`,
      );
    }
  }
  // A grandchild can hold the pipe open after a kill, so the drain is bounded.
  await waitUpTo(helper.logged, LOG_DRAIN_MS);
  const status = helper.status;
  if (status && !status.success && status.signal === null) {
    problems.push(`egress helper exited with code ${status.code}`);
  }
  return problems;
}

/** Memoised {@link stopHelperProcess}: a second call returns the first result. */
function stopAppleHelper(helper: AppleHelper): Promise<string[]> {
  helper.stopping ??= stopHelperProcess(helper);
  return helper.stopping;
}

/** Parses the ready file: NUL-separated run arguments, ending with the image. */
function parseRunArgs(text: string): string[] {
  const tokens = text.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  return tokens;
}

/** The handle returned to the caller: its run arguments and a memoised stop. */
function appleHandle(
  helper: AppleHelper,
  dir: string,
  runArgs: string[],
): BabysitterAppleEgress {
  let stopping: Promise<string[]> | undefined;
  const stop = (): Promise<string[]> => {
    stopping ??= finishAppleHelper(helper, dir);
    return stopping;
  };
  return { runArgs, stop };
}

/** Stops the helper, then removes its directory. Reports every problem. */
async function finishAppleHelper(
  helper: AppleHelper,
  dir: string,
): Promise<string[]> {
  const problems = [...await stopAppleHelper(helper)];
  const failure = await removeDir(dir);
  if (failure !== undefined) {
    problems.push(`could not remove ${dir}: ${failure}`);
  }
  return problems;
}

/**
 * The setup error with the cleanup problems appended as `; cleanup: ...`, so a
 * failed teardown is never dropped. The error itself when there are none.
 */
function withCleanup(error: unknown, problems: string[]): unknown {
  if (problems.length === 0) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${message}; cleanup: ${problems.join("; ")}`, {
    cause: error,
  });
}

/**
 * Writes the plan, starts the helper and waits for its ready file. On any
 * failure the helper is stopped first, so the log can be read and no helper
 * outlives the call. The stop is memoised, so the catch gets the same problems
 * the `!ready` branch already awaited.
 */
async function startAppleHelper(
  dir: string,
  plan: ContainerLaunchPlan,
  options: AppleEgressOptions,
  tuning: {
    env?: BabysitterEnvReader;
    readyTimeoutMs?: number;
    pollMs?: number;
  },
): Promise<BabysitterAppleEgress> {
  const env = tuning.env ?? processEnv;
  const readyFile = `${dir}/plan.apple-ready`;
  await Deno.writeTextFile(`${dir}/plan`, renderContainerLaunchPlan(plan), {
    mode: 0o600,
  });
  const helper = await spawnAppleHelper(dir, options, env);
  try {
    const ready = await waitForReady(
      readyFile,
      helper,
      tuning.readyTimeoutMs ?? APPLE_READY_TIMEOUT_MS,
      tuning.pollMs ?? APPLE_POLL_MS,
    );
    if (!ready) {
      await stopAppleHelper(helper);
      const cause = await setupFailureCause(
        `${dir}/egress.log`,
        helper.status?.code,
      );
      throw new Error(`egress setup failed: ${cause}`);
    }
    const runArgs = parseRunArgs(await Deno.readTextFile(readyFile));
    return appleHandle(helper, dir, runArgs);
  } catch (error) {
    throw withCleanup(error, await stopAppleHelper(helper));
  }
}

/**
 * Starts the Apple egress helper for a plan with a proxy and no enforcement
 * (Issue #4769), mirroring `round_egress` in the review-fleet-prs run.sh.
 * Writes the plan to a temp directory, runs the helper, and waits for the run
 * it writes. Throws `egress setup failed: <cause>` when no ready file appears;
 * the directory is removed on every failure. Cleanup problems are appended as
 * `; cleanup: ...`. `tuning` is for tests; the defaults are the real ready
 * timeout and poll interval.
 */
export async function babysitterStartAppleEgress(
  plan: ContainerLaunchPlan,
  options: AppleEgressOptions,
  tuning: {
    env?: BabysitterEnvReader;
    readyTimeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<BabysitterAppleEgress> {
  const dir = await Deno.makeTempDir({ prefix: "vibe-babysitter-egress-" });
  try {
    return await startAppleHelper(dir, plan, options, tuning);
  } catch (error) {
    const failure = await removeDir(dir);
    const problems = failure === undefined
      ? []
      : [redactSecrets(`could not remove ${dir}: ${failure}`)];
    throw withCleanup(error, problems);
  }
}

/** Reports one message through `log`. A failing log never replaces a result. */
function report(log: (message: string) => void, message: string): void {
  try {
    log(message);
  } catch {
    // Reporting is best effort; the repair's own outcome stands.
  }
}

/**
 * Runs a teardown and logs each problem it returns, or the message of a throw.
 * Never throws, so a teardown cannot replace the repair's result or error.
 */
async function runTeardown(
  teardown: Teardown | undefined,
  log: (message: string) => void,
  token: string,
): Promise<void> {
  if (teardown === undefined) return;
  let problems: string[];
  try {
    problems = await teardown();
  } catch (error) {
    problems = [error instanceof Error ? error.message : String(error)];
  }
  for (const problem of problems) {
    report(log, `egress teardown: ${redactToken(problem, token)}`);
  }
}

/** One repair spawn: the arguments, the environment and the timeout. */
interface RepairRun {
  spawn: BabysitterContainerDeps["spawn"];
  runtime: string;
  containerName: string;
  args: string[];
  baseEnv: Record<string, string>;
  token: string;
  timeoutMs: number;
}

/**
 * Runs the repair and throws on a timeout (after killing it by name), or on a
 * non-zero exit. The kill's own failure is named in the error.
 */
async function runRepairProcess(run: RepairRun): Promise<void> {
  const result = await run.spawn(run.runtime, run.args, {
    env: { ...run.baseEnv, GH_TOKEN: run.token },
    timeoutMs: run.timeoutMs,
  });
  if (result.timedOut) {
    const minutes = Math.round(run.timeoutMs / 60_000);
    let killFailure: string | undefined;
    try {
      const kill = await run.spawn(run.runtime, ["kill", run.containerName], {
        env: run.baseEnv,
        timeoutMs: 30_000,
      });
      if (!kill.success) {
        killFailure = `exit code ${kill.code}: ${
          describeStderr(kill.stderr, run.token)
        }`;
      }
    } catch (error) {
      killFailure = error instanceof Error ? error.message : String(error);
    }
    if (killFailure !== undefined) {
      throw new Error(
        `babysitter repair timed out after ${minutes} minutes; container ${run.containerName} not killed; kill failed: ${killFailure}`,
      );
    }
    throw new Error(
      `babysitter repair timed out after ${minutes} minutes; container ${run.containerName} killed`,
    );
  }
  if (!result.success) {
    throw new Error(
      `babysitter repair container ${run.containerName} exited with code ${result.code}: ${
        describeStderr(result.stderr, run.token)
      }`,
    );
  }
}

/**
 * Runs one babysitter repair in a container and returns its name (Issue
 * #4767). Mirrors `round_container` in run.sh, the pattern this copies: the
 * plan is checked, the image is preflighted, and nothing falls back to a host
 * process. Egress starts after the preflight (Issue #4769): an Apple plan (a
 * proxy with no enforcement) through the Apple helper, an enforced plan
 * (docker or podman) through the sidecar. Either is stopped in a `finally`,
 * and a teardown failure is logged, never thrown. A timed-out repair is killed
 * by name. The in-container command is not in the image yet (#4768), so a
 * real run fails inside the container. Reviewer rounds in run.sh still refuse
 * enforced plans; that is out of scope here. Not wired into `fix()` yet
 * (#4774).
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
  const startAppleEgress = deps.startAppleEgress ??
    ((plan: ContainerLaunchPlan, options: AppleEgressOptions) =>
      babysitterStartAppleEgress(plan, options, { env }));
  const startSidecar = deps.startSidecar ??
    ((plan: ContainerLaunchPlan) => startEgressSidecar(plan));
  const stopSidecar = deps.stopSidecar ??
    ((plan: ContainerLaunchPlan) => stopEgressSidecar(plan));
  const log = deps.log ??
    ((message: string) => console.error(`[babysitter] ${message}`));

  const containerName = `vibe-babysitter-${Date.now().toString(36)}-${
    crypto.randomUUID().slice(0, 8)
  }`;
  const plan = await buildPlan(input.baseDir, containerName);

  // Built and key-checked before any egress starts, so a bad plan never
  // starts a proxy.
  const planArgs = buildBabysitterRunArgs(plan, {
    clone: input.clone,
    scratch: input.scratch,
  });
  await assertBabysitterKeyOutOfRunArgs(planArgs, input.privateKeyPath);

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

  const apple = !plan.egressEnforced && plan.proxyName !== "";
  let teardown: Teardown | undefined;
  try {
    let args = planArgs;
    if (apple) {
      const helper = await startAppleEgress(plan, {
        baseDir: input.baseDir,
        timeoutMs,
      });
      teardown = helper.stop;
      args = buildBabysitterRunArgs({ ...plan, runArgs: helper.runArgs }, {
        clone: input.clone,
        scratch: input.scratch,
      });
      await assertBabysitterKeyOutOfRunArgs(args, input.privateKeyPath);
    } else if (plan.egressEnforced) {
      // Set before the start, so a sidecar half-started by a throw is torn down.
      teardown = () => stopSidecar(plan);
      await startSidecar(plan);
    }
    await runRepairProcess({
      spawn,
      runtime: plan.runtime,
      containerName,
      args,
      baseEnv,
      token: input.token,
      timeoutMs,
    });
    return { containerName };
  } finally {
    await runTeardown(teardown, log, input.token);
  }
}
