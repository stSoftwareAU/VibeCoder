/**
 * Tests for lockfile-frozen `deno run` in setup.sh (Issue #3653).
 *
 * setup.sh launches the setup CLI with the widest permission set in the repo
 * (`--allow-all`) against a process that reads and writes `.config.json`. It
 * must fail closed on dependency drift exactly like run.sh:
 * `--frozen` plus an explicit `--lock=` so a
 * stale or missing lockfile is a hard error rather than a silent re-resolve
 * that could pull in unreviewed transitive code (Issue #2896).
 *
 * These are behavioural tests: they source the real setup.sh, invoke the real
 * `run_setup_cli` function with a stubbed `deno` binary on PATH, and inspect
 * the exact command line the function constructs.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assertEquals } from "@std/assert";

const setupPath = new URL("../../../setup.sh", import.meta.url).pathname;

/**
 * Source setup.sh with a stubbed deno binary on PATH and capture the arguments
 * run_setup_cli passes to it. Returns the captured argv lines.
 */
async function captureSetupRunArgs(): Promise<string[]> {
  const tmp = await Deno.makeTempDir();
  try {
    const argsFile = `${tmp}/args`;
    const fakeDeno = `${tmp}/deno`;
    // The stub records each argument on its own line, then exits 0.
    await Deno.writeTextFile(
      fakeDeno,
      `#!/bin/bash\nprintf '%s\\n' "$@" > "$ARGS_FILE"\n`,
    );
    await Deno.chmod(fakeDeno, 0o755);

    const script = `
      set -euo pipefail
      export PATH="${tmp}:$PATH"
      source "${setupPath}"
      run_setup_cli hooks >/dev/null 2>&1 || true
    `;

    const cmd = new Deno.Command("bash", {
      args: ["-c", script],
      env: { ARGS_FILE: argsFile, CONFIG_FILE: `${tmp}/.config.json` },
    });
    const { code } = await cmd.output();
    assertEquals(code, 0, "bash harness should exit cleanly");

    const captured = await Deno.readTextFile(argsFile);
    return captured.split("\n").filter((line) => line.length > 0);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

Deno.test("run_setup_cli passes --frozen to deno run", async () => {
  const args = await captureSetupRunArgs();
  assertEquals(args[0], "run", "first argument must be the run subcommand");
  assertEquals(
    args.includes("--frozen"),
    true,
    `expected --frozen in: ${args.join(" ")}`,
  );
});

Deno.test("run_setup_cli pins --lock to worker/deno/deno.lock", async () => {
  const args = await captureSetupRunArgs();
  const lockArg = args.find((a) => a.startsWith("--lock="));
  assertEquals(
    lockArg !== undefined,
    true,
    `expected an explicit --lock= flag in: ${args.join(" ")}`,
  );
  const lockPath = (lockArg ?? "").slice("--lock=".length);
  // Resolve the path and confirm it is the real committed lockfile.
  const realLock = new URL("../deno.lock", import.meta.url).pathname;
  assertEquals(await Deno.realPath(lockPath), realLock);
});

Deno.test("run_setup_cli still forwards the CLI entrypoint and its arguments", async () => {
  const args = await captureSetupRunArgs();
  assertEquals(
    args.some((a) => a.endsWith("/setup/setup_cli.ts")),
    true,
    `setup_cli.ts entrypoint must still be present in: ${args.join(" ")}`,
  );
  assertEquals(
    args.includes("hooks"),
    true,
    "the subcommand must still be forwarded",
  );
  assertEquals(
    args.includes("--script-dir") && args.includes("--config-path"),
    true,
    "--script-dir and --config-path must still be forwarded",
  );
});

Deno.test("deno.json run tasks enforce the lockfile", async () => {
  const configPath = new URL("../deno.json", import.meta.url).pathname;
  const config = JSON.parse(await Deno.readTextFile(configPath)) as {
    tasks: Record<string, string>;
  };
  for (const [name, command] of Object.entries(config.tasks)) {
    if (!command.startsWith("deno run")) continue;
    assertEquals(
      command.includes("--frozen") && command.includes("--lock="),
      true,
      `task "${name}" must fail closed on dependency drift: ${command}`,
    );
  }
});
