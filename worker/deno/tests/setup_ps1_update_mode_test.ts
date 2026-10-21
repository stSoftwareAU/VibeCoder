/**
 * setup.ps1 hands update-mode the config snapshot (Issue #4119).
 *
 * `update-mode` now requires `--config-existed=true|false`: `true` only when
 * `.config.json` existed before the `config` step of this run. A frozen mode
 * is offered only on a fresh config, so getting this flag wrong either hides
 * the frozen option from a new host or offers it to an established one.
 *
 * These cases dot-source the real setup.ps1 and run the real
 * `Invoke-VibeSetupMain`. A stub `deno` on `PATH` records every setup CLI
 * invocation and, like the real config writer, creates `.config.json` on the
 * `config` step when it is absent. That makes the ordering observable: a
 * fresh host must still report `false`, which only holds if the snapshot is
 * taken before `config` runs. Only the credential, prompt and scheduled-task
 * helpers are stubbed, because they touch the host or wait on a terminal.
 *
 * PowerShell is the only requirement. Where no `pwsh` is installed the cases
 * are skipped, with the reason logged, rather than passing silently.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { resolvePowerShell } from "./support/pwsh.ts";

const SETUP_PS1 = new URL("../../../setup.ps1", import.meta.url).pathname;

const PWSH = await resolvePowerShell();

if (PWSH === null) {
  console.warn(
    "setup_ps1_update_mode_test: SKIPPED - no pwsh on PATH and VIBE_PWSH is " +
      "unset or not a working PowerShell, so setup.ps1 cannot be run here.",
  );
}

/**
 * A stub `deno`. It logs `subcommand<TAB>argv` for each setup CLI call and
 * creates the config file on the `config` step when it is absent.
 */
const STUB_DENO = `#!/bin/sh
sub=""
seen=0
for arg in "$@"; do
  if [ "$seen" = 1 ]; then sub="$arg"; break; fi
  case "$arg" in *setup_cli.ts) seen=1 ;; esac
done
printf '%s\\t%s\\n' "$sub" "$*" >> "$VIBE_TEST_LOG"
if [ "$sub" = config ] && [ ! -f "$CONFIG_FILE" ]; then
  printf '{}\\n' > "$CONFIG_FILE"
fi
exit 0
`;

/** One recorded setup CLI invocation. */
interface CliCall {
  subcommand: string;
  args: string[];
}

/** What one `Invoke-VibeSetupMain` run reported. */
interface MainRun {
  code: number;
  output: string;
  calls: CliCall[];
}

/**
 * Run the real `Invoke-VibeSetupMain` against a temporary config.
 *
 * @param preexisting whether `.config.json` exists before the run starts.
 */
async function runSetupMain(preexisting: boolean): Promise<MainRun> {
  const dir = await Deno.makeTempDir({ prefix: "setup-ps1-update-mode-" });
  try {
    const bin = `${dir}/bin`;
    const configPath = `${dir}/.config.json`;
    const logPath = `${dir}/cli-calls.log`;
    await Deno.mkdir(bin);
    await Deno.writeTextFile(`${bin}/deno`, STUB_DENO);
    await Deno.chmod(`${bin}/deno`, 0o755);
    if (preexisting) {
      await Deno.writeTextFile(configPath, '{"repos":["org/repo"]}\n');
    }

    const script = `
      $ErrorActionPreference = "Stop"
      . "${SETUP_PS1}"
      # The helpers below read or write host credentials, scan host
      # directories or wait on a terminal. None is part of the update-mode
      # ordering under test, so each is a no-op here.
      function Invoke-VibeCredentialProvisioning { }
      function Invoke-VibeInteractiveCredentialsPrompt { }
      function Show-VibeObsoleteWorkDirs { }
      function Invoke-VibeScheduledTaskPrompt { }
      Invoke-VibeSetupMain
    `;
    const output = await new Deno.Command(PWSH!, {
      args: ["-NoProfile", "-NonInteractive", "-Command", script],
      // A PATH that holds only the stub deno and the system bin directories
      // keeps the run off the developer's real toolchain.
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: dir,
        CONFIG_FILE: configPath,
        VIBE_TEST_LOG: logPath,
        VIBE_SKIP_SCHTASKS: "true",
      },
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();

    const decoder = new TextDecoder();
    const log = await Deno.readTextFile(logPath).catch(() => "");
    return {
      code: output.code,
      output: decoder.decode(output.stdout) + decoder.decode(output.stderr),
      calls: parseLog(log),
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Parse the stub's `subcommand<TAB>argv` lines, in call order. */
function parseLog(text: string): CliCall[] {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [subcommand = "", argv = ""] = line.split("\t");
      return { subcommand, args: argv.split(" ") };
    });
}

/** Register a case that needs PowerShell, skipping when there is none. */
function pwshTest(name: string, fn: () => Promise<void>): void {
  Deno.test({ name, ignore: PWSH === null, fn });
}

/** Assert the run succeeded and returned the update-mode flag it was given. */
function assertUpdateModeFlag(run: MainRun, expected: string): void {
  assertEquals(
    run.code,
    0,
    `setup.ps1 must run to completion; output:\n${run.output}`,
  );

  const configIndex = run.calls.findIndex((c) => c.subcommand === "config");
  assertEquals(
    run.calls.filter((c) => c.subcommand === "config").length,
    1,
    `the config step must run exactly once; calls: ${
      JSON.stringify(run.calls)
    }`,
  );

  assertEquals(
    run.calls.filter((c) => c.subcommand === "update-mode").length,
    1,
    `update-mode must run exactly once; calls: ${JSON.stringify(run.calls)}`,
  );
  const updateIndex = run.calls.findIndex((c) =>
    c.subcommand === "update-mode"
  );
  const update = run.calls[updateIndex];
  assert(update !== undefined, "update-mode call missing from the log");

  const flags = update.args.filter((a) => a.startsWith("--config-existed="));
  assertEquals(
    flags,
    [`--config-existed=${expected}`],
    `update-mode must receive --config-existed=${expected}`,
  );

  assert(
    updateIndex > configIndex,
    `update-mode must run after config; calls: ${JSON.stringify(run.calls)}`,
  );
}

pwshTest(
  "setup.ps1 - update-mode gets --config-existed=true when .config.json pre-exists (Issue #4119)",
  async () => {
    const run = await runSetupMain(true);
    assertUpdateModeFlag(run, "true");
  },
);

pwshTest(
  "setup.ps1 - update-mode gets --config-existed=false on a fresh host, snapshot taken before config (Issue #4119)",
  async () => {
    const run = await runSetupMain(false);
    assertUpdateModeFlag(run, "false");
  },
);
