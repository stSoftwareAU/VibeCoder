/**
 * The setup.sh wiring of `--config-existed` (Issue #4119).
 *
 * `main()` in setup.sh records whether `.config.json` existed before the run
 * started, taken before the prerequisites step, and hands that to the
 * update-mode command as `--config-existed=true|false`. The Deno side is
 * unit-tested in setup_update_mode_test.ts; these tests reach the bash side:
 * they source setup.sh, stub every step that would touch the host, run the
 * real `main()`, and read back the argument the update-mode call received.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";

/** tests/ -> worker/deno/ -> worker/ -> repository root. */
const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);
const SETUP_SH = `${REPO_ROOT}/setup.sh`;

/**
 * Sourced after setup.sh and before main(). Every host-touching step main()
 * reaches before update-mode is replaced with a stub that appends a line to
 * the log, and run_setup_cli records its arguments the same way. Positional
 * arguments are copied to variables first, because sourcing setup.sh must not
 * see or disturb them.
 */
const DRIVER = `
set -u
SETUP_SH_PATH="$1"
CONFIG_PATH_UNDER_TEST="$2"
TRACE_LOG="$3"
source "$SETUP_SH_PATH"
CONFIG_FILE="$CONFIG_PATH_UNDER_TEST"

record() { printf '%s\\n' "$*" >> "$TRACE_LOG"; }

run_setup_cli() {
    record "run_setup_cli $*"
    if [[ "$1" == "prerequisites" && -n "\${CREATE_CONFIG_DURING_PREREQS:-}" ]]; then
        : > "$CONFIG_FILE"
    fi
    return 0
}
provision_vibe_credentials() { record provision_vibe_credentials; }
configured_agent_providers() { echo claude; }
prompt_interactive_credentials() { record prompt_interactive_credentials; }
prompt_interactive_config() { record prompt_interactive_config; }
write_interactive_config() { record write_interactive_config; }
prompt_launchagent_setup() { record prompt_launchagent_setup; }
remind_obsolete_host_work_dirs() { record remind_obsolete_host_work_dirs; }
remove_setup_token_transcripts() { :; }

main
`;

interface Outcome {
  code: number;
  stderr: string;
  /** Every stubbed step main() reached, in order. */
  trace: string[];
}

/**
 * Run the real main() with setup.sh sourced. `configExists` decides whether
 * the config file is on disk before the run starts; `createDuringPrereqs`
 * makes the prerequisites stub create it, to show the flag is taken before
 * that step rather than read afterwards.
 */
async function runMain(
  configExists: boolean,
  createDuringPrereqs = false,
): Promise<Outcome> {
  const dir = await Deno.makeTempDir({ prefix: "vibe-setup-config-existed-" });
  try {
    const configPath = `${dir}/.config.json`;
    const traceLog = `${dir}/trace.log`;
    if (configExists) {
      await Deno.writeTextFile(configPath, "{}\n");
    }
    const env: Record<string, string> = {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      HOME: dir,
    };
    if (createDuringPrereqs) {
      env.CREATE_CONFIG_DURING_PREREQS = "1";
    }
    const { code, stderr } = await new Deno.Command("bash", {
      args: ["-c", DRIVER, "bash", SETUP_SH, configPath, traceLog],
      stdin: "null",
      stdout: "null",
      stderr: "piped",
      clearEnv: true,
      env,
    }).output();
    const trace = (await Deno.readTextFile(traceLog).catch(() => ""))
      .split("\n")
      .filter((line) => line.length > 0);
    return { code, stderr: new TextDecoder().decode(stderr), trace };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** The update-mode lines in a trace: the call must happen exactly once. */
function updateModeCalls(trace: string[]): string[] {
  return trace.filter((line) => line.startsWith("run_setup_cli update-mode"));
}

Deno.test("setup.sh main() - passes --config-existed=true to update-mode when .config.json exists beforehand", async () => {
  const outcome = await runMain(true);
  assertEquals(outcome.code, 0, outcome.stderr);
  // Positive control: the update-mode call happened, so the flag below was
  // read from a real call and not from the absence of one.
  assertEquals(updateModeCalls(outcome.trace), [
    "run_setup_cli update-mode --config-existed=true",
  ]);
  assertStringIncludes(outcome.trace.join("\n"), "run_setup_cli prerequisites");
});

Deno.test("setup.sh main() - passes --config-existed=false to update-mode when .config.json does not exist beforehand", async () => {
  const outcome = await runMain(false);
  assertEquals(outcome.code, 0, outcome.stderr);
  assertEquals(updateModeCalls(outcome.trace), [
    "run_setup_cli update-mode --config-existed=false",
  ]);
  assertStringIncludes(outcome.trace.join("\n"), "run_setup_cli prerequisites");
});

Deno.test("setup.sh main() - takes --config-existed before the prerequisites step, so a file the run creates does not count as existing", async () => {
  const outcome = await runMain(false, true);
  assertEquals(outcome.code, 0, outcome.stderr);
  assertEquals(updateModeCalls(outcome.trace), [
    "run_setup_cli update-mode --config-existed=false",
  ]);
});
