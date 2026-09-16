/**
 * The setup.sh child environment survives a host that exports CONFIG_PATH
 * (Issue #2144).
 *
 * The `setup_*` suites hand `setup.sh` a temporary `.config.json` through
 * `Deno.Command`'s `env`, which merges into the parent environment rather than
 * replacing it. Stating only `CONFIG_FILE` therefore left the host's ambient
 * `CONFIG_PATH` in place, and `resolve_config_file` refused the mismatched
 * pair — 40 cases red on every worker host, green everywhere else.
 *
 * These are behavioural tests: they model that merge exactly (an ambient
 * `CONFIG_PATH`, then the case's own variables layered on top by `env`), run
 * the real `resolve_config_file` from the real `setup.sh`, and assert on its
 * exit code and the file it resolved.
 *
 * Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { setupConfigEnv } from "./support/setup_config_env.ts";

const setupPath = new URL("../../../setup.sh", import.meta.url).pathname;

/** A config file no host exports, so an ambient read cannot supply it. */
const HOST_CONFIG_PATH = "/nowhere/host/.vibe-coder/run-config/.config.json";

/**
 * Source setup.sh on a host that exports `CONFIG_PATH`, with `stated` layered
 * on top the way `Deno.Command`'s `env` merge layers a case's own variables.
 *
 * Returns setup.sh's exit code, the `CONFIG_FILE` it resolved, and its output.
 */
async function resolveUnderAmbientConfigPath(
  stated: Record<string, string>,
): Promise<{ code: number; configFile: string; output: string }> {
  // `env NAME=value …` is the merge: the ambient export is already in the
  // environment, and these assignments land on top of it.
  const overrides = Object.entries(stated).map(([name, value]) =>
    `${name}=${value}`
  );
  const { code, stdout, stderr } = await new Deno.Command("env", {
    args: [
      ...overrides,
      "bash",
      "-c",
      // `set -euo pipefail` is what every setup_* harness runs under, so a
      // refused resolution aborts the child rather than limping on.
      `set -euo pipefail
       source "${setupPath}"
       printf 'RESOLVED=%s\\n' "$CONFIG_FILE"`,
    ],
    clearEnv: true,
    env: {
      PATH: "/usr/bin:/bin",
      // The worker host's export — the ambient value the cases inherited.
      CONFIG_PATH: HOST_CONFIG_PATH,
    },
    stdin: "null",
  }).output();
  const output = new TextDecoder().decode(stdout) +
    new TextDecoder().decode(stderr);
  const resolved = output.match(/^RESOLVED=(.*)$/m);
  return { code, configFile: resolved?.[1] ?? "", output };
}

Deno.test("setupConfigEnv - states both spellings of the one config file", () => {
  const configFile = "/tmp/d53b307cfb2e0207/.config.json";
  assertEquals(setupConfigEnv(configFile), {
    CONFIG_FILE: configFile,
    CONFIG_PATH: configFile,
  });
});

Deno.test("setup.sh - stating only CONFIG_FILE trips the guard on a host that exports CONFIG_PATH", async () => {
  // The shape the failing cases had: half the pair stated, half inherited.
  const { code, output } = await resolveUnderAmbientConfigPath({
    CONFIG_FILE: "/tmp/vibe-2144/.config.json",
  });

  assertEquals(code, 1, `the mismatched pair must be refused: ${output}`);
  assertStringIncludes(output, "CONFIG_FILE and CONFIG_PATH are both set");
  assertStringIncludes(output, HOST_CONFIG_PATH);
});

Deno.test("setup.sh - a case that states the whole pair resolves its own config file", async () => {
  const configFile = "/tmp/vibe-2144/.config.json";
  const { code, configFile: resolved, output } =
    await resolveUnderAmbientConfigPath(setupConfigEnv(configFile));

  assertEquals(code, 0, `the stated pair must be accepted: ${output}`);
  assertEquals(
    resolved,
    configFile,
    "setup.sh must read the case's file, not the host's",
  );
});
