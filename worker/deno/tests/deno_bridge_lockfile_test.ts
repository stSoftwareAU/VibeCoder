/**
 * Tests for lockfile-frozen `deno run` invocation (Issue #2896).
 *
 * The worker's Deno entrypoint must fail closed on dependency drift: the
 * committed worker/deno/deno.lock must be enforced with `--frozen` and an
 * explicit `--lock=` path so a stale or missing lockfile is a hard error
 * rather than a silent re-resolve.
 *
 * These are behavioural tests: they source the real `deno_bridge.sh`, invoke
 * the real `deno_run_command` function with a stubbed `deno` binary, and
 * inspect the exact command line the function constructs.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assertEquals } from "@std/assert";

const bridgePath = new URL("../../shared/deno_bridge.sh", import.meta.url)
  .pathname;

/**
 * Source deno_bridge.sh with a stubbed deno binary and capture the arguments
 * deno_run_command passes to it. Returns the captured argv lines.
 */
async function captureBridgeRunArgs(): Promise<string[]> {
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
      source "${bridgePath}"
      _DENO_CMD="${fakeDeno}"
      deno_run_command version >/dev/null 2>&1 || true
    `;

    const cmd = new Deno.Command("bash", {
      args: ["-c", script],
      env: { ARGS_FILE: argsFile },
    });
    const { code } = await cmd.output();
    assertEquals(code, 0, "bash harness should exit cleanly");

    const captured = await Deno.readTextFile(argsFile);
    return captured.split("\n").filter((line) => line.length > 0);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

Deno.test("deno_run_command passes --frozen to deno run", async () => {
  const args = await captureBridgeRunArgs();
  assertEquals(args[0], "run", "first argument must be the run subcommand");
  assertEquals(
    args.includes("--frozen"),
    true,
    `expected --frozen in: ${args.join(" ")}`,
  );
});

Deno.test("deno_run_command pins --lock to worker/deno/deno.lock", async () => {
  const args = await captureBridgeRunArgs();
  const lockArg = args.find((a) => a.startsWith("--lock="));
  assertEquals(
    lockArg !== undefined,
    true,
    `expected an explicit --lock= flag in: ${args.join(" ")}`,
  );
  // The flag points at the worker's committed lock; the path may contain a
  // `shared/../deno` segment because it is derived from the bridge's location.
  const lockPath = (lockArg ?? "").slice("--lock=".length);
  assertEquals(
    lockPath.endsWith("/deno/deno.lock"),
    true,
    `--lock must target deno/deno.lock, got: ${lockPath}`,
  );
  // Resolve the path and confirm it is the real committed lockfile.
  const realLock = new URL("../deno.lock", import.meta.url).pathname;
  assertEquals(await Deno.realPath(lockPath), realLock);
});

Deno.test("deno_run_command still forwards the command name and args", async () => {
  const args = await captureBridgeRunArgs();
  // The module path and the command name must survive the new flags.
  assertEquals(
    args.some((a) => a.endsWith("/mod.ts")),
    true,
    "mod.ts entrypoint must still be present",
  );
  assertEquals(
    args[args.length - 1],
    "version",
    "the command name must be the final argument",
  );
});
