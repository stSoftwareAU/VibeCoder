/**
 * The supervisor writes its launch logs where `mod.ts log-dir` says, and
 * nowhere else (Issues #872, #873, #1388).
 *
 * `loop.sh` used to spell the default itself, then honoured `LAUNCH_LOG_DIR`
 * and `LOG_DIR` from its own environment. On the host, `.config.json` is the
 * only configuration, so it now takes the resolver's answer and an exported
 * variable — a shell profile, a crontab line, a unit file — moves nothing.
 * That is what this suite pins: the launch log lands in the resolved directory
 * even when both variables point somewhere else.
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
  // The stub records that `log-dir` was called and answers the way the real
  // command does since Issue #1388: the configured directory, whatever the
  // environment says.
  await Deno.writeTextFile(
    join(binDir, "deno"),
    [
      "#!/bin/bash",
      `case "$*" in`,
      "  *log-dir*)",
      `    printf 'log-dir called\\n' >> "${tmpDir}/log-dir-env.log"`,
      `    printf '%s\\n' "${tmpDir}/resolved"`,
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

/** The launch-*.log names present in a directory, or none when it is absent. */
async function launchLogsIn(dir: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.name.startsWith("launch-")) names.push(entry.name);
    }
  } catch {
    // The directory was never created — which, for an ignored variable, is
    // exactly the point.
  }
  return names;
}

Deno.test({
  name:
    "loop.sh - the launch log lands where the resolver says, not where LAUNCH_LOG_DIR points (Issue #1388)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const tmpDir = await Deno.makeTempDir({ prefix: "vibe_loop_logdir_" });
    try {
      await buildLoopSandbox(tmpDir);
      const stale = join(tmpDir, "operator-export");

      await runLoopBriefly(tmpDir, { LAUNCH_LOG_DIR: stale });

      const seen = await Deno.readTextFile(join(tmpDir, "log-dir-env.log"));
      assertStringIncludes(
        seen,
        "log-dir called",
        "the supervisor asked the resolver",
      );

      const resolved = await launchLogsIn(join(tmpDir, "resolved"));
      assert(
        resolved.length > 0,
        "the launch log must be written in the resolved directory",
      );
      assertEquals(
        await launchLogsIn(stale),
        [],
        "an exported LAUNCH_LOG_DIR must move nothing",
      );
    } finally {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "loop.sh - LOG_DIR is ignored the same way (Issue #1388)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const tmpDir = await Deno.makeTempDir({ prefix: "vibe_loop_logdir_" });
    try {
      await buildLoopSandbox(tmpDir);
      const stale = join(tmpDir, "log-dir-export");

      await runLoopBriefly(tmpDir, { LOG_DIR: stale });

      assert(
        (await launchLogsIn(join(tmpDir, "resolved"))).length > 0,
        "the launch log must be written in the resolved directory",
      );
      assertEquals(
        await launchLogsIn(stale),
        [],
        "an exported LOG_DIR must move nothing",
      );
    } finally {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    }
  },
});
