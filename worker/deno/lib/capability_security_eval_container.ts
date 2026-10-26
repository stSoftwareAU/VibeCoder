/**
 * Disposable execution of generated capability fixtures (Issue #4368).
 * Only copied acceptance files and the supplied source enter the container.
 * The trusted supervisor verifies containment before loading generated code;
 * failed provisioning never falls back to executing on the host.
 */
import {
  type ContainerRuntimeDescriptor,
  defaultContainerRuntimeProbe,
  detectContainerRuntime,
} from "./container_runtime.ts";
import { readDeploymentImageSelection } from "./container_image_selection.ts";
import { resolveContainerImageReference } from "./container_image_hash.ts";
import { readTextBounded } from "./bounded_fetch.ts";
import {
  commandOutputWithTimeout,
  spawnCommandWithTimeout,
} from "./subprocess_timeout.ts";

export const CAPSEC_CONTAINER_TIMEOUT_MS = 60_000;
export const CAPSEC_CONTAINER_MEMORY_MB = 512;
export const CAPSEC_CONTAINER_CPUS = 1;
const OUTPUT_LIMIT = 1024 * 1024;
const MARKER = "CAPSEC_ISOLATION_OK\n";
const PATH = "/usr/local/bin:/usr/bin:/bin";

export interface EvalContainerResult {
  code: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
  isolation: {
    status: "enforced" | "unavailable";
    runtime: string;
    image: string;
    imageDigest: string | null;
    detail: string;
  };
}
interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
export interface EvalContainerOptions {
  root: string;
  language: "typescript" | "rust";
  source: string;
  image?: string;
  runtime?: "apple" | "docker" | "podman";
}
/** Injectable external boundaries; fixture construction and refusal stay real. */
export interface EvalContainerDependencies {
  detect?: (
    runtime?: EvalContainerOptions["runtime"],
  ) => Promise<ContainerRuntimeDescriptor>;
  image?: (root: string) => Promise<string>;
  run?: (
    executable: string,
    args: string[],
    timeoutMs: number,
  ) => Promise<CommandResult>;
}

// Runs as uid/gid 1000 after privilege dropping, in the final network namespace.
// Every check precedes the marker and the first generated-code invocation.
const SUPERVISOR = `#!/bin/sh
set -eu
fail() { printf '%s\\n' "isolation refused: $*" >&2; exit 125; }
[ "$(id -u)" = 1000 ] && [ "$(id -g)" = 1000 ] || fail identity
awk '/^Cap(Eff|Prm|Bnd|Amb):/ { if ($2 !~ /^0+$/) exit 1; n++ } END { if (n != 4) exit 1 }' /proc/self/status || fail capabilities
awk '/^NoNewPrivs:/ { found=1; if ($2 != 1) exit 1 } END { if (!found) exit 1 }' /proc/self/status || fail privilege-restoration
awk 'NR > 2 { if ($1 != "lo:") exit 1; n++ } END { if (n != 1) exit 1 }' /proc/net/dev || fail network-interface
awk 'NR > 1 { exit 1 }' /proc/net/route || fail ipv4-route
awk '$NF != "lo" { exit 1 }' /proc/net/ipv6_route || fail ipv6-route
for mount in / /fixture; do
  awk -v p="$mount" '$5 == p && $6 ~ /(^|,)ro(,|$)/ { found=1 } END { if (!found) exit 1 }' /proc/self/mountinfo || fail readonly-mount
 done
if (printf probe >> /fixture/readonly-probe) 2>/dev/null; then fail writable-inputs; fi
if (printf probe > /root-readonly-probe) 2>/dev/null; then fail writable-root; fi
mkdir -p /tmp/home /tmp/cargo /tmp/target /tmp/deno
printf '${MARKER.replaceAll("\n", "\\n")}'
exec "$@"
`;

async function resolveRuntime(
  requested?: EvalContainerOptions["runtime"],
): Promise<ContainerRuntimeDescriptor> {
  const kind = requested === "apple" ? "apple-container" : requested;
  return await detectContainerRuntime({
    ...(kind
      ? { platform: kind === "apple-container" ? "darwin" : "linux" }
      : {}),
    selfHeal: true,
    probe: (candidate) =>
      kind && candidate.kind !== kind
        ? Promise.resolve({
          available: false,
          reason: "not the requested evaluation runtime",
        })
        : defaultContainerRuntimeProbe(candidate),
  });
}

async function resolveImage(root: string): Promise<string> {
  const selection = await readDeploymentImageSelection({ repoRoot: root });
  return await resolveContainerImageReference(root, selection.options);
}

/** Host memory is bounded even when generated code floods either output pipe. */
async function runBounded(
  executable: string,
  args: string[],
  timeoutMs: number,
): Promise<CommandResult> {
  // Only the generated-code invocation needs streaming output caps. Runtime
  // inspection and exact-name cleanup are trusted, short commands.
  if (args[0] !== "run") {
    const output = await commandOutputWithTimeout(executable, {
      args,
      timeoutMs,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    });
    return {
      code: output.code,
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
    };
  }
  const child = spawnCommandWithTimeout(executable, {
    args,
    timeoutMs,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });
  let exited = false;
  const childStatus = child.status.then((value) => {
    exited = true;
    return value;
  });
  const stop = () => {
    if (exited) return;
    try {
      child.kill("SIGKILL");
    } catch (error) {
      if (
        !(error instanceof Deno.errors.NotFound) &&
        !(error instanceof TypeError &&
          error.message === "Child process has already terminated")
      ) throw error;
    }
  };
  const streams = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const result = await readTextBounded(
      new Response(
        stream.pipeThrough(new TransformStream(), { signal: streams.signal }),
      ),
      OUTPUT_LIMIT,
    );
    if (!result.ok) {
      stop();
      throw new Error(result.error);
    }
    return result.value;
  };
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        stop();
        streams.abort();
        reject(new Error(`container timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    const [status, stdout, stderr] = await Promise.race([
      Promise.all([childStatus, collect(child.stdout), collect(child.stderr)]),
      deadline,
    ]);
    return { code: status.code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    stop();
    streams.abort();
    // SIGKILL normally reaps immediately; a stuck runtime must not extend the
    // execution deadline indefinitely. The caller also deletes its container.
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        child.status,
        new Promise<void>((resolve) => {
          reapTimer = setTimeout(resolve, 1_000);
        }),
      ]);
    } finally {
      clearTimeout(reapTimer);
    }
  }
}

async function createFixture(options: EvalContainerOptions): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "vibe-capsec-" });
  try {
    await Deno.chmod(dir, 0o755);
    const write = async (path: string, contents: string) => {
      await Deno.writeTextFile(`${dir}/${path}`, contents);
      await Deno.chmod(`${dir}/${path}`, 0o444);
    };
    await write("supervisor.sh", SUPERVISOR);
    await write("readonly-probe", "authoritative inputs are read-only\n");
    const accept = `${options.root}/evals/capability_security/accept/isolated`;
    await write(
      "accept_test.ts",
      await Deno.readTextFile(`${accept}/accept_test.ts`),
    );
    if (options.language === "typescript") {
      await write(
        "adapter.ts",
        await Deno.readTextFile(`${accept}/adapter.ts`),
      );
      await write("impl.ts", options.source);
    } else {
      await write(
        "adapter.rs",
        await Deno.readTextFile(`${accept}/adapter.rs`),
      );
      await write("lib.rs", options.source);
    }
    return dir;
  } catch (error) {
    await Deno.remove(dir, { recursive: true });
    throw error;
  }
}

function runArgs(
  descriptor: ContainerRuntimeDescriptor,
  image: string,
  dir: string,
  name: string,
  language: EvalContainerOptions["language"],
): string[] {
  const apple = descriptor.kind === "apple-container";
  const args = [
    "run",
    "--rm",
    "--name",
    name,
    "--cpus",
    String(CAPSEC_CONTAINER_CPUS),
    "--memory",
    `${CAPSEC_CONTAINER_MEMORY_MB}M`,
    "--read-only",
    "--volume",
    `${dir}:/fixture:ro`,
    "--tmpfs",
    apple ? "/tmp" : "/tmp:rw,nosuid,nodev,size=256m,mode=1777",
  ];
  if (apple) args.push("--user", "root", "--cap-add", "SYS_ADMIN");
  else {args.push(
      "--user",
      "1000:1000",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pull",
      "never",
    );}
  args.push(
    "--workdir",
    "/fixture",
    "--entrypoint",
    "/usr/bin/env",
    image,
    "-i",
    `PATH=${PATH}`,
    "HOME=/tmp/home",
    "TMPDIR=/tmp",
    "DENO_DIR=/tmp/deno",
    "CARGO_HOME=/tmp/cargo",
    "CARGO_TARGET_DIR=/tmp/target",
    "CARGO_BUILD_JOBS=1",
    `CAPSEC_LANGUAGE=${language}`,
  );
  if (apple) {
    args.push(
      "/usr/bin/unshare",
      "--net",
      "/bin/sh",
      "-c",
      'chmod 1777 /tmp; exec "$@"',
      "capsec-init",
      "/usr/bin/setpriv",
      "--reuid=1000",
      "--regid=1000",
      "--clear-groups",
      "--bounding-set=-all",
      "--no-new-privs",
    );
  }
  args.push("/bin/sh", "/fixture/supervisor.sh");
  const test = [
    "deno",
    "test",
    "--no-config",
    "--no-lock",
    "--no-remote",
    "--deny-net",
    "--allow-read=/fixture",
    "--allow-env=CAPSEC_LANGUAGE",
    language === "typescript"
      ? "--allow-run=/usr/local/bin/deno"
      : "--allow-run=/tmp/build/adapter",
    "--v8-flags=--max-old-space-size=384",
    "/fixture/accept_test.ts",
  ];
  if (language === "typescript") args.push(...test);
  else {args.push(
      "/bin/sh",
      "-c",
      'set -eu; mkdir -p /tmp/build; rustc --edition=2021 --crate-name capsec_fixture --crate-type lib /fixture/lib.rs --out-dir /tmp/build; rustc --edition=2021 /fixture/adapter.rs --extern capsec_fixture=/tmp/build/libcapsec_fixture.rlib -o /tmp/build/adapter; exec "$@"',
      "capsec-rust",
      ...test,
    );}
  return args;
}

function inspectedDigest(
  output: string,
  descriptor: ContainerRuntimeDescriptor,
): string {
  const inspected = JSON.parse(output);
  const metadata = Array.isArray(inspected) ? inspected[0] : inspected;
  const digest = descriptor.kind === "apple-container"
    ? metadata?.configuration?.descriptor?.digest
    : metadata?.Id ?? metadata?.id;
  if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error("image inspection returned no immutable digest");
  }
  return digest;
}

export async function runIsolatedCapabilitySource(
  options: EvalContainerOptions,
  deps: EvalContainerDependencies = {},
): Promise<EvalContainerResult> {
  const start = Date.now();
  const run = deps.run ?? runBounded;
  let descriptor: ContainerRuntimeDescriptor | undefined;
  let image = options.image ?? "unresolved";
  let imageDigest: string | null = null;
  let dir: string | undefined;
  const name = `vibe-capsec-${crypto.randomUUID()}`;
  let launched = false;
  let result: CommandResult = {
    code: null,
    stdout: "",
    stderr: "isolation not provisioned",
  };
  let detail = "";
  try {
    descriptor = await (deps.detect ?? resolveRuntime)(options.runtime);
    image = options.image ?? await (deps.image ?? resolveImage)(options.root);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(image)) {
      throw new Error("invalid evaluation image reference");
    }
    const inspect = await run(descriptor.executable, [
      ...descriptor.dialect.imageInspectArgs,
      image,
    ], 10_000);
    if (inspect.code !== 0) {
      throw new Error(
        `local evaluation image unavailable: ${image}: ${inspect.stderr}`,
      );
    }
    imageDigest = inspectedDigest(inspect.stdout, descriptor);
    // Apple 1.2.x only resolves installed image names, not their reported
    // digests. Recheck its tag after execution; OCI runtimes accept the ID.
    if (descriptor.kind !== "apple-container") image = imageDigest;
    dir = await createFixture(options);
    launched = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      result = await run(
        descriptor.executable,
        runArgs(descriptor, image, dir, name, options.language),
        CAPSEC_CONTAINER_TIMEOUT_MS,
      );
      // Only a runtime failure before the supervisor started may be retried.
      // Acceptance failures and errors printed by generated code never qualify.
      if (
        result.stdout.startsWith(MARKER) || attempt === 1 ||
        !/(?:failed to connect|connection refused|temporarily unavailable)/i
          .test(result.stderr)
      ) break;
      const cleanup = await run(descriptor.executable, [
        descriptor.kind === "apple-container" ? "delete" : "rm",
        "--force",
        name,
      ], 10_000);
      if (
        cleanup.code !== 0 &&
        !/(?:not found|no such container)/i.test(cleanup.stderr)
      ) throw new Error(`evaluation retry cleanup failed: ${cleanup.stderr}`);
    }
    if (!result.stdout.startsWith(MARKER)) {
      throw new Error(
        `supervisor did not verify isolation: ${
          result.stderr || result.stdout
        }`,
      );
    }
    if (descriptor.kind === "apple-container") {
      const after = await run(descriptor.executable, [
        ...descriptor.dialect.imageInspectArgs,
        image,
      ], 10_000);
      if (
        after.code !== 0 ||
        inspectedDigest(after.stdout, descriptor) !== imageDigest
      ) throw new Error("evaluation image reference changed during execution");
    }
    detail =
      "verified readonly root and inputs; uid/gid 1000; no capabilities; no privilege restoration; loopback-only network; CPU 1, memory 512M, time 60s";
  } catch (error) {
    result = {
      code: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (launched && descriptor) {
      try {
        const cleanup = await run(descriptor.executable, [
          descriptor.kind === "apple-container" ? "delete" : "rm",
          "--force",
          name,
        ], 10_000);
        if (
          cleanup.code !== 0 &&
          !/(?:not found|no such container)/i.test(cleanup.stderr)
        ) {
          result = {
            code: null,
            stdout: "",
            stderr: `evaluation container cleanup failed: ${cleanup.stderr}`,
          };
        }
      } catch (error) {
        result = {
          code: null,
          stdout: "",
          stderr: `${result.stderr}\n${
            error instanceof Error ? error.message : error
          }`.trim(),
        };
      }
    }
    if (dir) await Deno.remove(dir, { recursive: true });
  }
  return {
    ...result,
    elapsedMs: Date.now() - start,
    isolation: {
      status: result.code === null ? "unavailable" : "enforced",
      runtime: descriptor?.kind ?? options.runtime ?? "unresolved",
      image,
      imageDigest,
      detail: result.code === null ? result.stderr : detail,
    },
  };
}
