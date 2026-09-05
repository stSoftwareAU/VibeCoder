/**
 * The launchers ask for the log directory, and pass the operator's own
 * override through to it (Issues #872, #873).
 *
 * `loop.sh` used to spell the default itself. It now asks `mod.ts log-dir`,
 * and the one thing that resolution needs from the supervisor is the
 * environment the operator set: an intermediate that blanks `LAUNCH_LOG_DIR`
 * before the child reads it silently loses the override — the launch logs, the
 * run-core log and the container's writable mount all move to the default and
 * nothing says so. That is what this suite pins.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

/** POSIX join — this suite only runs where the shell launchers do. */
const join = (...parts: string[]): string => parts.join("/");

/** tests/ → worker/deno/ → worker/ → repository root. */
const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

/**
 * A sandbox holding a copy of `loop.sh`, a stub launcher and a stub `deno`
 * that answers `log-dir` with whatever the environment says.
 *
 * @param tmpDir - The sandbox directory
 */
async function buildLoopSandbox(tmpDir: string): Promise<void> {
  await Deno.writeTextFile(
    join(tmpDir, "loop.sh"),
    await Deno.readTextFile(join(REPO_ROOT, "loop.sh")),
  );
  await Deno.chmod(join(tmpDir, "loop.sh"), 0o755);

  // A launcher that does nothing and succeeds: this suite is about the
  // supervisor's own log directory, not about launching.
  await Deno.writeTextFile(
    join(tmpDir, "run.sh"),
    '#!/bin/bash\necho "run" >> invocations.log\nexit 0\n',
  );
  await Deno.chmod(join(tmpDir, "run.sh"), 0o755);

  await Deno.mkdir(join(tmpDir, "worker", "deno"), { recursive: true });
  await Deno.writeTextFile(join(tmpDir, "worker", "deno", "mod.ts"), "");
  await Deno.writeTextFile(join(tmpDir, "worker", "deno", "deno.lock"), "");

  const binDir = join(tmpDir, "bin");
  await Deno.mkdir(binDir, { recursive: true });
  // The stub records the environment `log-dir` was called with and answers
  // the way the real command does: the override when there is one.
  await Deno.writeTextFile(
    join(binDir, "deno"),
    [
      "#!/bin/bash",
      `case "$*" in`,
      "  *log-dir*)",
      `    printf 'LAUNCH_LOG_DIR=[%s]\\n' "\${LAUNCH_LOG_DIR-unset}" \\`,
      `      >> "${tmpDir}/log-dir-env.log"`,
      `    printf '%s\\n' "\${LAUNCH_LOG_DIR:-\${LOG_DIR:-${tmpDir}/fallback}}"`,
      "    exit 0 ;;",
      "esac",
      `printf '%s\\n' "$*" >> "${tmpDir}/deno-args.log"`,
      "echo 1",
      "",
    ].join("\n"),
  );
  await Deno.chmod(join(binDir, "deno"), 0o755);
}

/**
 * Run `loop.sh` in the sandbox for long enough to take one cycle.
 *
 * @param tmpDir - The sandbox directory
 * @param env - Environment the supervisor is started with
 */
async function runLoopBriefly(
  tmpDir: string,
  env: Record<string, string>,
): Promise<void> {
  const child = new Deno.Command("bash", {
    args: [join(tmpDir, "loop.sh")],
    cwd: tmpDir,
    env: {
      LOOP_SLEEP_SECONDS: "1",
      PATH: `${join(tmpDir, "bin")}:${Deno.env.get("PATH") ?? ""}`,
      HOME: tmpDir,
      ...env,
    },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  try {
    await new Promise((resolve) => setTimeout(resolve, 2500));
  } finally {
    try {
      child.kill("SIGKILL");
    } catch { /* already dead */ }
    await child.status;
    await child.stdout.cancel().catch(() => {});
    await child.stderr.cancel().catch(() => {});
  }
}

Deno.test({
  name:
    "loop.sh - an operator's LAUNCH_LOG_DIR reaches the resolver and is used (Issues #872, #873)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const tmpDir = await Deno.makeTempDir({ prefix: "vibe_loop_logdir_" });
    try {
      await buildLoopSandbox(tmpDir);
      const chosen = join(tmpDir, "operator-choice");

      await runLoopBriefly(tmpDir, { LAUNCH_LOG_DIR: chosen });

      // The child that resolves the directory must see the operator's value,
      // not an empty string the supervisor blanked on its way past.
      const seen = await Deno.readTextFile(join(tmpDir, "log-dir-env.log"));
      assertStringIncludes(seen, `LAUNCH_LOG_DIR=[${chosen}]`);

      // And the supervisor must actually write its launch log there.
      const entries: string[] = [];
      for await (const entry of Deno.readDir(chosen)) entries.push(entry.name);
      assert(
        entries.some((name) => name.startsWith("launch-")),
        `no launch log in the chosen directory: ${entries.join(", ")}`,
      );
    } finally {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "loop.sh - LOG_DIR alone is honoured the same way (Issues #872, #873)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const tmpDir = await Deno.makeTempDir({ prefix: "vibe_loop_logdir_" });
    try {
      await buildLoopSandbox(tmpDir);
      const chosen = join(tmpDir, "log-dir-choice");

      await runLoopBriefly(tmpDir, { LOG_DIR: chosen });

      const entries: string[] = [];
      for await (const entry of Deno.readDir(chosen)) entries.push(entry.name);
      assert(
        entries.some((name) => name.startsWith("launch-")),
        `no launch log in the chosen directory: ${entries.join(", ")}`,
      );
      // LAUNCH_LOG_DIR was never set, so the resolver must be told so rather
      // than handed an empty string that would read as "set to nothing".
      const seen = await Deno.readTextFile(join(tmpDir, "log-dir-env.log"));
      assertEquals(seen.includes("LAUNCH_LOG_DIR=[]"), false, seen);
    } finally {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    }
  },
});
