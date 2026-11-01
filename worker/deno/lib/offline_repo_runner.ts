/** Host-owned, credential-free regression execution against a pinned commit. */
import {
  inspectedDigest,
  OFFLINE_ISOLATION_MARKER,
  OFFLINE_ISOLATION_SUPERVISOR,
  offlineIsolationArgs,
  resolveImage,
  resolveRuntime,
  runBounded,
} from "./capability_security_eval_container.ts";
import { spawnCommandWithTimeout } from "./subprocess_timeout.ts";
import { readTextBounded } from "./bounded_fetch.ts";

export interface OfflineRepoRequest {
  /** Host checkout containing the exact commit object. */
  sourceRepo: string;
  /** Full immutable commit ID; branch names and PR prose are not accepted. */
  head: string;
  /** Repository-relative working directory. */
  cwd: string;
  /** Trusted planner's argv; never interpreted by a shell. */
  argv: string[];
  /** Trusted host checkout used to select the installed worker image. */
  hostRoot: string;
  image?: string;
}

export type OfflineRepoResult =
  | {
    status: "passed" | "failed";
    head: string;
    tree: string;
    cwd: string;
    argv: string[];
    runtime: "apple-container";
    imageDigest: string;
    code: number;
    output: string;
  }
  | { status: "unavailable"; detail: string };

const PROGRAMS = new Set(["deno", "cargo", "rustc", "shellcheck", "bash"]);
// Oversize repositories return unavailable so callers can retry with a capable
// execution profile. These independent host limits bound checkout and tmpfs use.
const MAX_SNAPSHOT_FILES = 20_000;
const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const MAX_GIT_OUTPUT = 1024 * 1024;
const READY = "REPO_SNAPSHOT_READY\n";
const WRAPPER = `#!/bin/sh
set -eu
mkdir -p /tmp/work
cp -R /fixture/repo/. /tmp/work/
target="$(realpath "/tmp/work/$1")"
case "$target" in /tmp/work|/tmp/work/*) ;; *) exit 125 ;; esac
cd "$target"
shift
command -v "$1" >/dev/null 2>&1 || exit 125
printf 'REPO_SNAPSHOT_READY\\n'
exec "$@"
`;

/** Reject unsupported or oversized Git trees before materialising any files. */
export function checkOfflineSnapshotEntries(entries: string): void {
  let bytes = 0;
  const lines = entries ? entries.split("\n") : [];
  if (lines.length > MAX_SNAPSHOT_FILES) {
    throw new Error("Snapshot has too many files");
  }
  for (const line of lines) {
    const match = /^(100644|100755|120000) ([0-9]+)$/.exec(line);
    if (!match) throw new Error("Snapshot contains an unsupported entry");
    bytes += Number(match[2]);
    if (!Number.isSafeInteger(bytes) || bytes > MAX_SNAPSHOT_BYTES) {
      throw new Error("Snapshot exceeds the size limit");
    }
  }
}

/** Execute one structured check in an isolated Apple container, or defer. */
export async function runOfflineRepoCheck(
  request: OfflineRepoRequest,
): Promise<OfflineRepoResult> {
  if (!/^[0-9a-f]{40}$/i.test(request.head)) {
    return { status: "unavailable", detail: "A full commit ID is required" };
  }
  if (!request.argv.length || !PROGRAMS.has(request.argv[0]!)) {
    return { status: "unavailable", detail: "Unsupported check executable" };
  }
  if (request.argv.some((arg) => arg.includes("\0"))) {
    return { status: "unavailable", detail: "Invalid command argument" };
  }
  if (
    request.cwd.startsWith("/") ||
    request.cwd.split("/").some((part) => part === "..")
  ) return { status: "unavailable", detail: "Invalid check directory" };
  let fixture: string | undefined;
  let runtime: Awaited<ReturnType<typeof resolveRuntime>> | undefined;
  let name: string | undefined;
  let imageAlias: string | undefined;
  let launched = false;
  let outcome: OfflineRepoResult = {
    status: "unavailable",
    detail: "Check did not start",
  };
  try {
    runtime = await resolveRuntime("apple");
    if (runtime.kind !== "apple-container") {
      throw new Error("Only the Apple offline profile has been verified");
    }
    const image = request.image ?? await resolveImage(request.hostRoot);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(image)) {
      throw new Error("Invalid image reference");
    }
    const inspect = await runBounded(runtime.executable, [
      ...runtime.dialect.imageInspectArgs,
      image,
    ], 10_000);
    if (inspect.code !== 0) {
      throw new Error(`Image unavailable: ${inspect.stderr}`);
    }
    const digest = inspectedDigest(inspect.stdout, runtime);
    // Apple does not resolve installed images by digest. A private, random
    // reference prevents routine concurrent updates of the source tag from
    // changing this run. The host and its container engine remain trusted.
    imageAlias = `vibe-offline-image:${crypto.randomUUID()}`;
    const tagged = await runBounded(runtime.executable, [
      "image",
      "tag",
      image,
      imageAlias,
    ], 10_000);
    if (tagged.code !== 0) {
      throw new Error(`Image pin failed: ${tagged.stderr}`);
    }
    const pin = await runBounded(runtime.executable, [
      ...runtime.dialect.imageInspectArgs,
      imageAlias,
    ], 10_000);
    if (pin.code !== 0 || inspectedDigest(pin.stdout, runtime) !== digest) {
      throw new Error("Image changed while creating the run reference");
    }
    fixture = await Deno.realPath(
      await Deno.makeTempDir({ prefix: "vibe-offline-repo-" }),
    );
    await Deno.chmod(fixture, 0o755);
    const source = await Deno.realPath(request.sourceRepo);
    const env = {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      HOME: fixture,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
    };
    const git = async (args: string[]) => {
      const child = spawnCommandWithTimeout("git", {
        args,
        cwd: fixture,
        timeoutMs: 120_000,
        clearEnv: true,
        env,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      });
      const collect = async (stream: ReadableStream<Uint8Array>) => {
        const result = await readTextBounded(
          new Response(stream),
          MAX_GIT_OUTPUT,
        );
        if (!result.ok) {
          try {
            child.kill("SIGKILL");
          } catch { /* Already exited. */ }
          throw new Error("Snapshot command output exceeded its limit");
        }
        return result.value;
      };
      const [status, stdout, stderr] = await Promise.all([
        child.status,
        collect(child.stdout),
        collect(child.stderr),
      ]);
      if (!status.success) throw new Error(`Snapshot failed: ${stderr}`);
      return stdout.trim();
    };
    const objects = await git([
      "-C",
      source,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "objects",
    ]);
    if (objects.includes("\n") || objects.includes("\r")) {
      throw new Error("Invalid object-directory path");
    }
    await Deno.mkdir(`${fixture}/meta`);
    await Deno.mkdir(`${fixture}/repo`);
    await git(["-C", `${fixture}/meta`, "-c", "init.templateDir=", "init"]);
    await Deno.writeTextFile(
      `${fixture}/meta/.git/objects/info/alternates`,
      `${objects}\n`,
    );
    const actual = await git([
      "-C",
      `${fixture}/meta`,
      "rev-parse",
      "--verify",
      `${request.head}^{commit}`,
    ]);
    if (actual.toLowerCase() !== request.head.toLowerCase()) {
      throw new Error("Snapshot head did not match request");
    }
    const tree = await git([
      "-C",
      `${fixture}/meta`,
      "rev-parse",
      "--verify",
      `${actual}^{tree}`,
    ]);
    const entries = await git([
      "-C",
      `${fixture}/meta`,
      "ls-tree",
      "-r",
      "--format=%(objectmode) %(objectsize)",
      actual,
    ]);
    checkOfflineSnapshotEntries(entries);
    await git([
      "-C",
      `${fixture}/meta`,
      "-c",
      "core.hooksPath=/dev/null",
      "--work-tree",
      `${fixture}/repo`,
      "checkout",
      actual,
      "--",
      ".",
    ]);
    await Deno.remove(`${fixture}/meta`, { recursive: true });
    await Deno.writeTextFile(
      `${fixture}/supervisor.sh`,
      OFFLINE_ISOLATION_SUPERVISOR,
    );
    await Deno.writeTextFile(`${fixture}/readonly-probe`, "read-only input\n");
    await Deno.writeTextFile(`${fixture}/run-repo.sh`, WRAPPER);
    name = `vibe-offline-${crypto.randomUUID()}`;
    launched = true;
    const result = await runBounded(
      runtime.executable,
      offlineIsolationArgs(runtime, imageAlias, fixture, name, [
        "/bin/sh",
        "/fixture/run-repo.sh",
        request.cwd || ".",
        ...request.argv,
      ]),
      60_000,
    );
    if (
      result.code === null ||
      !result.stdout.startsWith(OFFLINE_ISOLATION_MARKER + READY)
    ) {
      throw new Error(
        `Isolation or snapshot setup was not established: ${result.stderr}`,
      );
    }
    const after = await runBounded(runtime.executable, [
      ...runtime.dialect.imageInspectArgs,
      imageAlias,
    ], 10_000);
    if (after.code !== 0 || inspectedDigest(after.stdout, runtime) !== digest) {
      throw new Error("Image changed during execution");
    }
    outcome = {
      status: result.code === 0 ? "passed" : "failed",
      head: actual,
      tree,
      cwd: request.cwd,
      argv: [...request.argv],
      runtime: "apple-container",
      imageDigest: digest,
      code: result.code,
      output: result.stdout.slice((OFFLINE_ISOLATION_MARKER + READY).length) +
        result.stderr,
    };
  } catch (error) {
    outcome = { status: "unavailable", detail: String(error) };
  } finally {
    if (launched && runtime && name) {
      try {
        const cleanup = await runBounded(runtime.executable, [
          "delete",
          "--force",
          name,
        ], 10_000);
        if (
          cleanup.code !== 0 &&
          !/(?:not found|no such container)/i.test(cleanup.stderr)
        ) {
          outcome = {
            status: "unavailable",
            detail: `Offline container cleanup failed: ${cleanup.stderr}`,
          };
        }
      } catch (error) {
        outcome = {
          status: "unavailable",
          detail: `Offline container cleanup failed: ${error}`,
        };
      }
    }
    if (imageAlias && runtime) {
      try {
        const cleanup = await runBounded(runtime.executable, [
          "image",
          "delete",
          "--force",
          imageAlias,
        ], 10_000);
        if (cleanup.code !== 0) {
          outcome = {
            status: "unavailable",
            detail: `Image cleanup failed: ${cleanup.stderr}`,
          };
        }
      } catch (error) {
        outcome = {
          status: "unavailable",
          detail: `Image cleanup failed: ${error}`,
        };
      }
    }
    if (fixture) {
      try {
        await Deno.remove(fixture, { recursive: true });
      } catch (error) {
        outcome = {
          status: "unavailable",
          detail: `Offline snapshot cleanup failed: ${error}`,
        };
      }
    }
  }
  return outcome;
}
