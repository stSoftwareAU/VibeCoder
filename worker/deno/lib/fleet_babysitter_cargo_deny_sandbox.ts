import { quoteArg } from "./cargo_deny_gate.ts";
import {
  babysitterHostCredentialPaths,
  babysitterProtectedPaths,
  buildBabysitterSandboxArgs,
} from "./fleet_babysitter_sandbox.ts";
import {
  defaultPreFlightRunner,
  type PreFlightCommandResult,
  type PreFlightRunner,
  tokeniseCommand,
} from "./pre_flight_gate.ts";
import { runWithTimeout } from "./subprocess_timeout.ts";

/**
 * The babysitter's cargo-deny check, run under the repair agent's boundary
 * (Issue #4626, C36 in `docs/THREAT-MODEL.md`).
 *
 * `cargo deny` reads configuration from the PR's checkout (`.cargo/config.toml`
 * aliases and compiler overrides, `rust-toolchain.toml`), so it runs code the
 * PR controls. On the babysitter host that code would run as the runner's OS
 * user, which can read the App private key, the credential directory and the
 * `gh` config. So the check runs under `codex sandbox` with the same
 * permissions profile as the Codex repair agent (read everywhere, write only
 * the clone and scratch directory, no write to `.git`, no access at all to the
 * protected paths), never as a bare host process.
 *
 * Which program runs is not left to the checkout either: `cargo-deny` and
 * `cargo` are found on the host `PATH` and the home `.cargo/bin`, never under
 * the clone or scratch directory, and run by absolute path; the rustup
 * toolchain is pinned in the environment, which overrides a
 * `rust-toolchain.toml`; and the compiler wrapper variables are emptied, which
 * override `build.rustc-wrapper` in a cargo config. The sandbox is the
 * boundary; these keep the checkout from choosing the program inside it.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

/** Hand the process runner a failure to start, which the gate treats as infrastructure. */
function notStarted(reason: string): PreFlightCommandResult {
  return { started: false, code: -1, stdout: "", stderr: reason };
}

/** What a sandboxed runner needs from the repair. */
export interface SandboxedCargoDenyOptions {
  /** The Codex executable, at or above the permissions-profile floor. */
  codex: string;
  /** The clone, the only directory the check may write besides `scratch`. */
  dir: string;
  scratch: string;
  protectedPaths: string[];
  /** The runner's home; its `.cargo/bin` is searched for the tools. */
  home: string;
  /** `Deno.build.os`; only `darwin` and `linux` have a `codex sandbox`. */
  os?: string;
  /** The host `PATH` the tools are found on. */
  pathVariable?: string;
  /** The host's `RUSTUP_TOOLCHAIN`, when set. */
  toolchain?: string;
  /** Finds an executable by absolute path; undefined when it is absent. */
  isExecutable?: (path: string) => Promise<boolean>;
  /** The host's active rustup toolchain read from a neutral directory. */
  activeToolchain?: () => Promise<string | undefined>;
  /** Runs the wrapped command; the pre-flight runner by default. */
  inner?: PreFlightRunner;
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const info = await Deno.stat(path);
    return info.isFile && ((info.mode ?? 0o111) & 0o111) !== 0;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/** The host's active toolchain, read from `cwd`, or undefined without rustup. */
export async function rustupActiveToolchain(
  cwd: string,
): Promise<string | undefined> {
  const result = await runWithTimeout("rustup", ["show", "active-toolchain"], {
    cwd,
    timeoutMs: 30_000,
  });
  if (!result.ok) {
    if (result.error instanceof Deno.errors.NotFound) return undefined;
    throw result.error;
  }
  if (!result.value.success) {
    throw new Error(
      `rustup show active-toolchain failed: ${result.value.stderr.trim()}`,
    );
  }
  const name = result.value.stdout.trim().split(/\s+/)[0] ?? "";
  if (!/^[\w.-]+$/.test(name)) {
    throw new Error("rustup reported no usable active toolchain");
  }
  return name;
}

/**
 * Find `name` on the home `.cargo/bin` and the host `PATH`, skipping any
 * directory that is relative or lies under the clone or scratch directory.
 */
async function findTool(
  name: string,
  options: SandboxedCargoDenyOptions,
): Promise<string | undefined> {
  const isExecutable = options.isExecutable ?? isExecutableFile;
  const candidates = [
    `${options.home}/.cargo/bin`,
    ...(options.pathVariable ?? "").split(":"),
  ];
  for (const directory of candidates) {
    if (!directory.startsWith("/")) continue;
    const inside = [options.dir, options.scratch].some((writable) =>
      directory === writable || directory.startsWith(`${writable}/`)
    );
    if (inside) continue;
    const path = `${
      directory.endsWith("/") ? directory.slice(0, -1) : directory
    }/${name}`;
    if (await isExecutable(path)) return path;
  }
  return undefined;
}

/** The `codex` argv that runs `argv` under the babysitter permissions profile. */
export function buildSandboxedArgv(
  options: Pick<
    SandboxedCargoDenyOptions,
    "codex" | "dir" | "scratch" | "protectedPaths"
  >,
  sandbox: "macos" | "linux",
  argv: readonly string[],
): string[] {
  return [
    options.codex,
    ...buildBabysitterSandboxArgs({
      dir: options.dir,
      scratch: options.scratch,
      protectedPaths: options.protectedPaths,
    }),
    "sandbox",
    sandbox,
    "--",
    ...argv,
  ];
}

/**
 * A pre-flight runner that only runs `cargo deny` and only under
 * `codex sandbox`. Anything else, an unsupported host, a missing tool or an
 * unquotable argument is a failure to start, which the gate reports as
 * infrastructure and never as a pass.
 */
export function sandboxedCargoDenyRunner(
  options: SandboxedCargoDenyOptions,
): PreFlightRunner {
  const inner = options.inner ?? defaultPreFlightRunner;
  return async (command, runOptions) => {
    const tokens = tokeniseCommand(command);
    if (tokens[0] !== "cargo" || tokens[1] !== "deny") {
      return notStarted(
        `refusing to run ${
          JSON.stringify(tokens[0] ?? "")
        } in the babysitter's cargo-deny sandbox: only cargo deny runs there`,
      );
    }
    const os = options.os ?? Deno.build.os;
    const sandbox = os === "darwin" ? "macos" : os === "linux" ? "linux" : null;
    if (sandbox === null) {
      return notStarted(
        `codex sandbox has no support for ${os}, so cargo deny cannot run isolated`,
      );
    }
    const cwd = runOptions.cwd ?? options.dir;
    if (cwd !== options.dir && !cwd.startsWith(`${options.dir}/`)) {
      return notStarted(`cargo deny cwd ${cwd} is outside the clone`);
    }
    const cargoDeny = await findTool("cargo-deny", options);
    const cargo = await findTool("cargo", options);
    if (cargoDeny === undefined || cargo === undefined) {
      return notStarted(
        `${
          cargoDeny === undefined ? "cargo-deny" : "cargo"
        } not found outside the clone on the host PATH or ~/.cargo/bin`,
      );
    }
    let toolchain = options.toolchain;
    try {
      toolchain ??= await (options.activeToolchain ??
        (() => rustupActiveToolchain(options.scratch)))();
    } catch (error) {
      return notStarted(
        `the host rust toolchain could not be pinned: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    // cargo runs an external subcommand as `cargo-deny deny <args>`.
    const argv = buildSandboxedArgv(options, sandbox, [
      cargoDeny,
      "deny",
      ...tokens.slice(2),
    ]);
    const quoted: string[] = [];
    for (const arg of argv) {
      const value = quoteArg(arg);
      if (value === null) {
        return notStarted(
          "a sandbox argument contains both ' and \" and cannot be quoted",
        );
      }
      quoted.push(value);
    }
    return await inner(quoted.join(" "), {
      ...runOptions,
      cwd,
      env: {
        ...runOptions.env,
        CARGO: cargo,
        CARGO_HOME: `${options.scratch}/cargo-home`,
        RUSTC_WRAPPER: "",
        RUSTC_WORKSPACE_WRAPPER: "",
        ...(toolchain === undefined ? {} : { RUSTUP_TOOLCHAIN: toolchain }),
      },
    });
  };
}

/**
 * The production runner. The Codex install, the protected paths and the tool
 * lookup happen on the first run, so a repair with no cargo-deny step in its
 * CI pays nothing and a failure to set the sandbox up is a failure to start.
 */
export function babysitterCargoDenyRunner(context: {
  privateKeyPath: string;
  home: string;
  configPath: string;
  dir: string;
  scratch: string;
  resolveCodex: () => Promise<string>;
  env?: (name: string) => string | undefined;
}): PreFlightRunner {
  let ready: Promise<PreFlightRunner> | undefined;
  const env = context.env ?? ((name) => Deno.env.get(name));
  return async (command, options) => {
    try {
      ready ??= (async () => {
        const credentials = await babysitterHostCredentialPaths(
          context.configPath,
          context.home,
          context.env,
        );
        return sandboxedCargoDenyRunner({
          codex: await context.resolveCodex(),
          dir: context.dir,
          scratch: context.scratch,
          protectedPaths: await babysitterProtectedPaths(
            context.home,
            context.privateKeyPath,
            credentials,
          ),
          home: context.home,
          pathVariable: env("PATH"),
          toolchain: env("RUSTUP_TOOLCHAIN"),
        });
      })();
      return await (await ready)(command, options);
    } catch (error) {
      return notStarted(
        `the cargo-deny sandbox could not be set up: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
}
