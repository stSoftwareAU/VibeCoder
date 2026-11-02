/** Runner-owned local checks for fleet PR repairs. */
import {
  babysitterHostCredentialPaths,
  babysitterProtectedPaths,
} from "./fleet_babysitter_sandbox.ts";
import childProcess from "node:child_process";
import { kill } from "node:process";
import { clampTimeoutToRunTimeline } from "./subprocess_timeout.ts";
import { redactSecrets } from "./secret_redaction.ts";
import { open } from "node:fs/promises";
import { constants } from "node:fs";

const VALIDATION_TIMEOUT_MS = 15 * 60 * 1000;
const OUTPUT_LIMIT = 20_000;
const GATE_SIZE_LIMIT = 64 * 1024;

export interface BabysitterValidationResult {
  kind: "not-applicable" | "passed";
  command: string;
}

export class BabysitterValidationError extends Error {
  constructor(
    message: string,
    readonly kind: "unavailable" | "failed",
  ) {
    super(message);
    this.name = "BabysitterValidationError";
  }
}

/** Retry one failed local gate once, after the agent reports its repair ready. */
export async function validateWithSingleRepair<T>(options: {
  validate: () => Promise<T>;
  repair: (failure: BabysitterValidationError) => Promise<void>;
}): Promise<T> {
  try {
    return await options.validate();
  } catch (error) {
    if (
      !(error instanceof BabysitterValidationError) || error.kind !== "failed"
    ) {
      throw error;
    }
    await options.repair(error);
  }
  return await options.validate();
}

function quoteProfilePath(path: string): string {
  if (path.includes("\0")) throw new Error("Sandbox path contains NUL");
  return JSON.stringify(path);
}

/** Build a macOS sandbox that keeps credentials out while permitting Chromium. */
export function buildBabysitterValidationProfile(
  dir: string,
  scratch: string,
  protectedPaths: readonly string[],
): string {
  if (!dir.startsWith("/") || !scratch.startsWith("/")) {
    throw new Error("Runner validation paths must be absolute");
  }
  for (const protectedPath of protectedPaths) {
    for (const writablePath of [dir, scratch]) {
      if (
        writablePath === protectedPath ||
        writablePath.startsWith(`${protectedPath}/`) ||
        protectedPath.startsWith(`${writablePath}/`)
      ) {
        throw new Error(
          `Runner validation path overlaps protected path ${protectedPath}`,
        );
      }
    }
  }
  const protectedRules = [...new Set(protectedPaths)]
    .map((path) => {
      const quoted = quoteProfilePath(path);
      return `(deny file-read* (subpath ${quoted}))\n(deny file-write* (subpath ${quoted}))`;
    });
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow process-info* (target same-sandbox))",
    "(allow signal (target same-sandbox))",
    ...[
      "hw.memsize",
      "hw.ncpu",
      "hw.logicalcpu",
      "hw.physicalcpu",
      "hw.pagesize",
      "hw.optional.arm64",
      "kern.ostype",
      "kern.osrelease",
      "kern.osversion",
      "kern.version",
    ].map((name) =>
      `(allow sysctl-read (sysctl-name ${JSON.stringify(name)}))`
    ),
    "(allow ipc-posix-sem*)",
    "(allow ipc-posix-shm*)",
    "(allow pseudo-tty)",
    '(allow file-read* file-write* (literal "/dev/ptmx") (regex #"^/dev/ttys[0-9]+$"))',
    '(allow file-read* (subpath "/"))',
    ...protectedRules,
    ...[dir, scratch].map((path) =>
      `(allow file-write* (subpath ${quoteProfilePath(path)}))`
    ),
    '(allow file-write* (literal "/dev/null"))',
    ...[
      "com.apple.system.logger",
      "com.apple.system.notification_center",
      "com.apple.logd",
      "com.apple.FontObjectsServer",
      "com.apple.fonts",
      "com.apple.windowserver.active",
    ].map((name) =>
      `(allow mach-lookup (global-name ${JSON.stringify(name)}))`
    ),
    // Chromium registers its rendezvous server and child processes look it up.
    ...[
      "org.chromium.Chromium.MachPortRendezvousServer.",
      "com.google.Chrome.MachPortRendezvousServer.",
      "com.google.chrome.for.testing.MachPortRendezvousServer.",
      "org.chromium.crashpad.",
    ].flatMap((prefix) => [
      `(allow mach-register (global-name-prefix ${JSON.stringify(prefix)}))`,
      `(allow mach-lookup (global-name-prefix ${JSON.stringify(prefix)}))`,
    ]),
    "(allow network*)",
    `(deny file-write* (subpath ${quoteProfilePath(`${dir}/.git`)}))`,
    '(deny mach-lookup (global-name "com.apple.securityd"))',
  ].join("\n");
}

/** Keep only non-credential runtime settings needed by common browser gates. */
export function babysitterValidationEnv(
  parent: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (
    const name of [
      "PATH",
      "HOME",
      "TMPDIR",
      "CHROMIUM_PATH",
      "PLAYWRIGHT_BROWSERS_PATH",
      "CYPRESS_CACHE_FOLDER",
      "PUPPETEER_CACHE_DIR",
      "CI",
    ]
  ) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function boundedOutput(value: string): string {
  return value.length <= OUTPUT_LIMIT
    ? value
    : `… output truncated …\n${value.slice(-OUTPUT_LIMIT)}`;
}

export async function runIsolatedCommand(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    spawn?: typeof childProcess.spawn;
    signal?: (pid: number, signal: NodeJS.Signals) => void;
  },
): Promise<{ success: boolean; code: number; stdout: string; stderr: string }> {
  const timeoutMs = clampTimeoutToRunTimeline(options.timeoutMs, executable);
  // A session isolates the gate and all browser descendants from the runner.
  const child = (options.spawn ?? childProcess.spawn)(executable, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk) => {
    stdout = (stdout + chunk.toString()).slice(-OUTPUT_LIMIT);
  });
  child.stderr!.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-OUTPUT_LIMIT);
  });
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      (options.signal ?? kill)(-child.pid!, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let stopped = false;
  const stopGroup = () => {
    if (stopped || child.pid === undefined) return;
    stopped = true;
    signalGroup("SIGKILL");
  };
  const status = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    // Stop descendants before waiting for their inherited pipes to close.
    child.once("exit", () => {
      try {
        stopGroup();
      } catch (error) {
        reject(error);
      }
    });
    // close waits for pipes too, while the deadline below never waits for EOF.
    child.once("close", (code) => resolve(code ?? 1));
  });
  const deadline = new Promise<number>((resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      // A timed-out gate is untrusted: stop its entire group immediately.
      try {
        stopGroup();
      } catch (error) {
        reject(error);
      }
      // Even a descendant that escaped the group cannot retain these pipes.
      child.stdout!.destroy();
      child.stderr!.destroy();
      child.unref();
      resolve(124);
    }, timeoutMs);
  });
  try {
    const code = await Promise.race([status, deadline]);
    return {
      success: !timedOut && code === 0,
      code: timedOut ? 124 : code,
      stdout,
      stderr: timedOut
        ? `${stderr}\nRunner validation timed out after ${timeoutMs}ms`
        : stderr,
    };
  } finally {
    clearTimeout(timer);
    stopGroup();
  }
}

/** Host browser caches the gate reuses: env name, host path, entry depth to link. */
const BROWSER_CACHES = [
  {
    env: "PLAYWRIGHT_BROWSERS_PATH",
    host: (home: string) => `${home}/Library/Caches/ms-playwright`,
    depth: 1,
  },
  {
    env: "CYPRESS_CACHE_FOLDER",
    host: (home: string) => `${home}/Library/Caches/Cypress`,
    depth: 1,
  },
  {
    env: "PUPPETEER_CACHE_DIR",
    host: (home: string) => `${home}/.cache/puppeteer`,
    depth: 2,
  },
] as const;

/** Mirror a host cache as read-only links inside a writable directory. */
async function mirrorBrowserCache(
  host: string,
  target: string,
  depth: number,
): Promise<void> {
  await Deno.mkdir(target, { recursive: true });
  try {
    for await (const entry of Deno.readDir(host)) {
      // Dot entries are the installer's own state (locks, link tables).
      if (entry.name.startsWith(".")) continue;
      if (depth > 1 && entry.isDirectory) {
        await mirrorBrowserCache(
          `${host}/${entry.name}`,
          `${target}/${entry.name}`,
          depth - 1,
        );
      } else {
        await Deno.symlink(`${host}/${entry.name}`, `${target}/${entry.name}`);
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

interface ValidationSandbox {
  sandboxExec: string;
  profilePath: string;
  env: Record<string, string>;
  run: typeof runIsolatedCommand;
}

/**
 * Build the sandbox profile and environment, prove sandbox-exec can apply the
 * profile with a fixed command, then hand the sandbox to `use`.
 */
async function withValidationSandbox<T>(
  checkedDir: string,
  checkedScratch: string,
  configPath: string,
  home: string,
  options: {
    sandboxExec?: string | null;
    run?: typeof runIsolatedCommand;
    env?: Record<string, string>;
    privateKeyPath?: string;
  },
  use: (sandbox: ValidationSandbox) => Promise<T>,
): Promise<T> {
  const sandboxExec = options.sandboxExec === undefined
    ? Deno.env.get("BABYSITTER_SANDBOX_EXEC") ?? "/usr/bin/sandbox-exec"
    : options.sandboxExec;
  if (!sandboxExec) {
    throw new BabysitterValidationError(
      "Runner validation unavailable: sandbox-exec was not found",
      "unavailable",
    );
  }

  const credentialPaths = await babysitterHostCredentialPaths(
    configPath,
    home,
    (name) => Deno.env.get(name),
  );
  const protectedPaths = await babysitterProtectedPaths(
    home,
    options.privateKeyPath ??
      `${home}/.vibe-coder/fleet-pr-babysitter.private-key.pem`,
    [
      configPath,
      ...credentialPaths,
      `${home}/Library/Keychains`,
      `${home}/.ssh`,
      `${home}/.aws`,
      `${home}/.config/gcloud`,
      `${home}/.azure`,
      `${home}/.kube`,
      `${home}/.docker`,
      `${home}/.netrc`,
      `${home}/.npmrc`,
    ],
  );
  // The repair agent and gate can write scratch; neither may edit this policy.
  const profileDir = await Deno.makeTempDir({
    prefix: "fleet-babysitter-validation-",
  });
  try {
    const profile = buildBabysitterValidationProfile(
      checkedDir,
      checkedScratch,
      [...protectedPaths, await Deno.realPath(profileDir)],
    );
    const profilePath = `${profileDir}/runner-validation.sb`;
    await Deno.writeTextFile(profilePath, profile, { mode: 0o600 });
    const env = babysitterValidationEnv(options.env ?? Deno.env.toObject());
    // The profile writes only to the clone and scratch, so an unset browser
    // cache is a fresh scratch directory of read-only links to the host's
    // installed builds: the gate reuses them and can still install into it.
    const cacheRoot = await Deno.makeTempDir({
      dir: checkedScratch,
      prefix: "browser-cache-",
    });
    for (const cache of BROWSER_CACHES) {
      if (env[cache.env] !== undefined) continue;
      const target = `${cacheRoot}/${cache.env}`;
      await mirrorBrowserCache(cache.host(home), target, cache.depth);
      env[cache.env] = target;
    }
    env.HOME = checkedScratch;
    env.TMPDIR = checkedScratch;
    env.DENO_DIR = `${checkedScratch}/deno`;
    const run = options.run ?? runIsolatedCommand;
    try {
      const probe = await run(sandboxExec, [
        "-f",
        profilePath,
        "/usr/bin/true",
      ], { cwd: checkedDir, timeoutMs: 10_000, env });
      if (!probe.success) {
        throw new Error(redactSecrets(boundedOutput(
          [probe.stdout, probe.stderr, `exit ${probe.code}`].filter(Boolean)
            .join("\n"),
        )));
      }
    } catch (error) {
      throw new BabysitterValidationError(
        `Runner validation unavailable: could not start sandbox-exec probe (${error})`,
        "unavailable",
      );
    }
    return await use({ sandboxExec, profilePath, env, run });
  } finally {
    await Deno.remove(profileDir, { recursive: true });
  }
}

/**
 * Report an unavailable runner gate before any agent session starts. It runs
 * the platform check and the sandbox-exec probe that validation itself runs
 * (Issue #4674), so an unusable host never spends a repair session. Throws a
 * BabysitterValidationError of kind "unavailable"; a clone with no quality.sh
 * has nothing to run and passes.
 */
export async function checkBabysitterValidationCapability(
  dir: string,
  scratch: string,
  configPath: string,
  home: string,
  options: {
    platform?: string;
    sandboxExec?: string | null;
    run?: typeof runIsolatedCommand;
    env?: Record<string, string>;
    privateKeyPath?: string;
  } = {},
): Promise<void> {
  const platform = options.platform ?? Deno.build.os;
  if (platform === "linux") return;
  if (platform !== "darwin") {
    throw new BabysitterValidationError(
      `Runner validation unavailable: macOS sandbox is required to run quality.sh safely (host: ${platform})`,
      "unavailable",
    );
  }
  const [checkedDir, checkedScratch] = await Promise.all([
    Deno.realPath(dir),
    Deno.realPath(scratch),
  ]);
  try {
    await Deno.lstat(`${checkedDir}/quality.sh`);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  await withValidationSandbox(
    checkedDir,
    checkedScratch,
    configPath,
    home,
    options,
    () => Promise.resolve(),
  );
}

/** Run the repository's declared local gate before the babysitter commits. */
export async function runBabysitterValidation(
  dir: string,
  scratch: string,
  configPath: string,
  home: string,
  options: {
    platform?: string;
    sandboxExec?: string | null;
    run?: typeof runIsolatedCommand;
    env?: Record<string, string>;
    privateKeyPath?: string;
  } = {},
): Promise<BabysitterValidationResult> {
  const platform = options.platform ?? Deno.build.os;
  if (platform === "linux") {
    return { kind: "not-applicable", command: "agent validation (Linux)" };
  }
  if (platform !== "darwin") {
    throw new BabysitterValidationError(
      `Runner validation unavailable: macOS sandbox is required to run quality.sh safely (host: ${platform})`,
      "unavailable",
    );
  }
  const [checkedDir, checkedScratch] = await Promise.all([
    Deno.realPath(dir),
    Deno.realPath(scratch),
  ]);
  // Reject special files before opening: a FIFO would block before the timeout.
  let gate: Deno.FileInfo;
  try {
    gate = await Deno.lstat(`${checkedDir}/quality.sh`);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { kind: "not-applicable", command: "./quality.sh (not present)" };
    }
    throw error;
  }
  if (!gate.isFile || gate.isSymlink) {
    throw new Error(
      "Runner validation requires a regular quality.sh in the repository root",
    );
  }
  if (gate.size > GATE_SIZE_LIMIT) {
    throw new Error("Runner validation quality.sh exceeds the 64 KiB limit");
  }
  if (gate.size === 0) {
    throw new Error("Runner validation found an empty quality.sh");
  }
  if (
    await Deno.realPath(`${checkedDir}/quality.sh`) !==
      `${checkedDir}/quality.sh`
  ) {
    throw new Error(
      "Runner validation requires quality.sh inside the repository root",
    );
  }
  // The agent may have left a background process: refuse symlink swaps and
  // never block opening a FIFO planted between lstat and open.
  const file = await open(
    `${checkedDir}/quality.sh`,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await file.stat();
    if (!opened.isFile()) {
      throw new Error("Runner validation requires a regular quality.sh");
    }
    if (opened.dev !== gate.dev || opened.ino !== gate.ino) {
      throw new Error("Runner validation quality.sh changed while opening it");
    }
    // Bound the actual read as well as the metadata check, even if it grows.
    const bytes = new Uint8Array(GATE_SIZE_LIMIT + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await file.read(bytes.subarray(used));
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    if (used > GATE_SIZE_LIMIT) {
      throw new Error("Runner validation quality.sh exceeds the 64 KiB limit");
    }
    if (!new TextDecoder().decode(bytes.subarray(0, used)).trim()) {
      throw new Error("Runner validation found an empty quality.sh");
    }
  } finally {
    await file.close();
  }

  return await withValidationSandbox(
    checkedDir,
    checkedScratch,
    configPath,
    home,
    options,
    async ({ sandboxExec, profilePath, env, run }) => {
      let result: Awaited<ReturnType<typeof runIsolatedCommand>>;
      try {
        result = await run(sandboxExec, [
          "-f",
          profilePath,
          "/bin/bash",
          "./quality.sh",
        ], {
          cwd: checkedDir,
          timeoutMs: VALIDATION_TIMEOUT_MS,
          env,
        });
      } catch (error) {
        throw new BabysitterValidationError(
          `Runner validation unavailable: could not start sandbox-exec (${error})`,
          "unavailable",
        );
      }
      if (!result.success) {
        const details = redactSecrets(boundedOutput(
          [result.stdout, result.stderr].filter(Boolean).join("\n"),
        ));
        throw new BabysitterValidationError(
          `Runner validation failed (exit ${result.code}) for ./quality.sh${
            details ? `:\n${details}` : ""
          }`,
          "failed",
        );
      }
      return { kind: "passed", command: "./quality.sh" } as const;
    },
  );
}
