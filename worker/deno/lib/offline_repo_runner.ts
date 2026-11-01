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
# The seed is part of the trusted image; cap the scratch copy independently of
# the snapshot. A missing or oversized seed leaves the cache cold and checks
# requiring uncached dependencies defer.
if [ "$2" = deno ] && [ -d /opt/deno-seed ]; then
  seed_kb="$(du -sk /opt/deno-seed | cut -f1)"
  case "$seed_kb" in ''|*[!0-9]*) exit 125 ;; esac
  if [ "$seed_kb" -le 65536 ]; then
    mkdir -p /tmp/deno
    cp -R /opt/deno-seed/. /tmp/deno/
  fi
fi
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
export function runOfflineRepoCheck(
  request: OfflineRepoRequest,
): Promise<OfflineRepoResult> {
  return runOfflineRepoCheckInternal(request);
}

interface Overlay {
  head: string;
  path: string;
  expectedBlob?: string;
}
type InternalResult = OfflineRepoResult & { overlayBlob?: string };
async function runOfflineRepoCheckInternal(
  request: OfflineRepoRequest,
  overlay?: Overlay,
): Promise<InternalResult> {
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
  let outcome: InternalResult = {
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
    const git = async (args: string[], trim = true) => {
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
      return trim ? stdout.trim() : stdout;
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
    let overlayBlob: string | undefined;
    if (overlay) {
      let directory = `${fixture}/repo`;
      for (const part of request.cwd === "." ? [] : request.cwd.split("/")) {
        directory += `/${part}`;
        if (!(await Deno.lstat(directory)).isDirectory) {
          throw new Error("Project directory is not a regular directory");
        }
      }
      const resolved = await git([
        "-C",
        `${fixture}/meta`,
        "rev-parse",
        "--verify",
        `${overlay.head}^{commit}`,
      ]);
      if (resolved.toLowerCase() !== overlay.head.toLowerCase()) {
        throw new Error("Overlay commit mismatch");
      }
      const entry = await git([
        "-C",
        `${fixture}/meta`,
        "--literal-pathspecs",
        "ls-tree",
        "--format=%(objectmode) %(objecttype) %(objectname)",
        resolved,
        "--",
        overlay.path,
      ]);
      const match = /^(100644|100755) blob ([0-9a-f]{40})$/.exec(entry);
      if (!match) throw new Error("Overlay test is not a tracked regular file");
      overlayBlob = match[2]!;
      if (overlay.expectedBlob && overlayBlob !== overlay.expectedBlob) {
        throw new Error("Overlay blob mismatch");
      }
      let target = `${fixture}/repo`;
      const parts = overlay.path.split("/");
      for (const part of parts.slice(0, -1)) {
        target += `/${part}`;
        if (!(await Deno.lstat(target)).isDirectory) {
          throw new Error("Overlay ancestor is not a directory");
        }
      }
      target += `/${parts.at(-1)}`;
      try {
        if (!(await Deno.lstat(target)).isFile) {
          throw new Error("Overlay target is not a regular file");
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      const content = await git([
        "-C",
        `${fixture}/meta`,
        "cat-file",
        "blob",
        overlayBlob,
      ], false);
      await Deno.writeTextFile(target, content);
      const written = await git([
        "-C",
        `${fixture}/meta`,
        "hash-object",
        target,
      ]);
      if (written !== overlayBlob) {
        throw new Error("Overlay bytes did not match blob");
      }
    }
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
      ...(overlayBlob ? { overlayBlob } : {}),
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

export interface PairedOfflineDenoRequest {
  sourceRepo: string;
  base: string;
  head: string;
  /** Host-planned project directory and repository-relative test path. */
  cwd: string;
  testPath: string;
  hostRoot: string;
  image?: string;
}
export type PairedOfflineDenoResult =
  | {
    status: "observed";
    base: InternalResult;
    head: InternalResult;
    blob: string;
  }
  | {
    status: "unavailable";
    detail: string;
    base?: InternalResult;
    head?: InternalResult;
  };

/** Observe the head test and its exact overlay on base; never infer regression. */
export async function runPairedOfflineDenoTest(
  request: PairedOfflineDenoRequest,
): Promise<PairedOfflineDenoResult> {
  const validPath = (path: string) =>
    path.length > 0 && !path.startsWith("/") &&
    !path.includes("\0") && path.split("/").every((p) =>
      p !== "" && p !== "." && p !== ".."
    );
  if (
    !/^[0-9a-f]{40}$/i.test(request.base) ||
    !/^[0-9a-f]{40}$/i.test(request.head) ||
    !validPath(request.testPath) ||
    !(request.cwd === "." || validPath(request.cwd)) ||
    !(request.testPath.endsWith(".ts") || request.testPath.endsWith(".tsx")) ||
    !(request.cwd === "." || request.testPath.startsWith(request.cwd + "/"))
  ) {
    return { status: "unavailable", detail: "Invalid paired test request" };
  }
  const relative = request.cwd === "."
    ? request.testPath
    : request.testPath.slice(request.cwd.length + 1);
  const common = {
    sourceRepo: request.sourceRepo,
    cwd: request.cwd,
    hostRoot: request.hostRoot,
    image: request.image,
    argv: [
      "deno",
      "test",
      "--cached-only",
      "--no-prompt",
      "--allow-all",
      `./${relative}`,
    ],
  };
  const head = await runOfflineRepoCheckInternal({
    ...common,
    head: request.head,
  }, { head: request.head, path: request.testPath });
  if (head.status !== "passed" || !head.overlayBlob) {
    return {
      status: "unavailable",
      detail:
        "Head check did not pass; offline failures may reflect missing dependencies",
      head,
    };
  }
  const base = await runOfflineRepoCheckInternal({
    ...common,
    head: request.base,
  }, {
    head: request.head,
    path: request.testPath,
    expectedBlob: head.overlayBlob,
  });
  if (base.status !== "passed") {
    return {
      status: "unavailable",
      detail:
        "Base check did not pass; offline failures may reflect missing dependencies",
      head,
      base,
    };
  }
  if (
    base.imageDigest !== head.imageDigest ||
    base.overlayBlob !== head.overlayBlob
  ) {
    return {
      status: "unavailable",
      detail: "Paired execution environment changed",
      head,
      base,
    };
  }
  return { status: "observed", base, head, blob: head.overlayBlob };
}
