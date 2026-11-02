/** Runner-owned local checks for fleet PR repairs. */
import {
  babysitterHostCredentialPaths,
  babysitterProtectedPaths,
} from "./fleet_babysitter_sandbox.ts";
import { spawnCommandWithTimeout } from "./subprocess_timeout.ts";
import { redactSecrets } from "./secret_redaction.ts";

const VALIDATION_TIMEOUT_MS = 15 * 60 * 1000;
const OUTPUT_LIMIT = 20_000;

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
    "(allow process*)",
    "(allow sysctl-read)",
    '(allow file-read* (subpath "/"))',
    ...protectedRules,
    `(deny file-write* (subpath ${quoteProfilePath(`${dir}/.git`)}))`,
    ...[dir, scratch].map((path) =>
      `(allow file-write* (subpath ${quoteProfilePath(path)}))`
    ),
    '(allow file-write* (literal "/dev/null"))',
    '(deny mach-lookup (global-name "com.apple.securityd"))',
    "(allow mach-lookup)",
    // Chromium registers its rendezvous server separately from looking it up.
    '(allow mach-register (global-name-prefix "org.chromium.Chromium.MachPortRendezvousServer."))',
    '(allow mach-register (global-name-prefix "com.google.Chrome.MachPortRendezvousServer."))',
    '(allow mach-register (global-name-prefix "com.google.chrome.for.testing.MachPortRendezvousServer."))',
    '(allow mach-register (global-name-prefix "org.chromium.crashpad."))',
    "(allow network*)",
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

export async function readBoundedOutput(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
    if (output.length > OUTPUT_LIMIT) output = output.slice(-OUTPUT_LIMIT);
  }
  output += decoder.decode();
  return output;
}

async function runIsolatedCommand(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
  },
): Promise<{ success: boolean; code: number; stdout: string; stderr: string }> {
  const child = spawnCommandWithTimeout(executable, {
    args,
    cwd: options.cwd,
    env: options.env,
    clearEnv: true,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    timeoutMs: options.timeoutMs,
  });
  const [stdout, stderr, status] = await Promise.all([
    readBoundedOutput(child.stdout),
    readBoundedOutput(child.stderr),
    child.status,
  ]);
  return { ...status, stdout, stderr };
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
    readFile?: (path: string) => Promise<string>;
    run?: typeof runIsolatedCommand;
    env?: Record<string, string>;
    privateKeyPath?: string;
  } = {},
): Promise<BabysitterValidationResult> {
  const [checkedDir, checkedScratch] = await Promise.all([
    Deno.realPath(dir),
    Deno.realPath(scratch),
  ]);
  const readFile = options.readFile ?? Deno.readTextFile;
  let gate: string;
  try {
    gate = await readFile(`${checkedDir}/quality.sh`);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { kind: "not-applicable", command: "./quality.sh (not present)" };
    }
    throw error;
  }
  if (!gate.trim()) {
    throw new Error("Runner validation found an empty quality.sh");
  }

  const platform = options.platform ?? Deno.build.os;
  if (platform !== "darwin") {
    throw new BabysitterValidationError(
      `Runner validation unavailable: macOS sandbox is required to run quality.sh safely (host: ${platform})`,
      "unavailable",
    );
  }
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
    env.HOME = checkedScratch;
    env.TMPDIR = checkedScratch;
    env.DENO_DIR = `${checkedScratch}/deno`;
    const run = options.run ?? runIsolatedCommand;
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
    return { kind: "passed", command: "./quality.sh" };
  } finally {
    await Deno.remove(profileDir, { recursive: true });
  }
}
