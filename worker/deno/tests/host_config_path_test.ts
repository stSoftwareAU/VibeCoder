/**
 * The host's one configuration path, resolved the same way by every side
 * (Issue #750).
 *
 * Setup read `CONFIG_FILE`; the launcher read `CONFIG_PATH`. A host that
 * relocated its `.config.json` and set only one of them had setup writing one
 * file while `./run.sh` staged another, with nothing reporting the split — and
 * a relative value resolved against the checkout on the Deno side and against
 * the working directory in `setup.sh`.
 *
 * These tests pin the resolution rule and then drive the two shells through the
 * same matrix, asserting they answer exactly what `resolveHostConfigPath`
 * answers. A shell that drifts from the resolver fails here rather than on an
 * operator's host.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { resolveHostConfigPath } from "../lib/host_config_path.ts";
import { resolveContainerLaunchHostPaths } from "../lib/container_launch.ts";

const BASE = "/opt/VibeCoder";
const SETUP_SH = new URL("../../../setup.sh", import.meta.url).pathname;
const SETUP_PS1 = new URL("../../../setup.ps1", import.meta.url).pathname;

/** An environment reader over a plain record. */
function reader(
  env: Record<string, string>,
): (name: string) => string | undefined {
  return (name) => env[name];
}

/**
 * The combinations every side must answer identically.
 *
 * Both halves are functions of the checkout, because two of the cases are only
 * meaningful relative to it — the shells resolve against their own checkout,
 * not against a literal in this file.
 */
interface MatrixCase {
  name: string;
  env: (base: string) => Record<string, string>;
  expected: (base: string) => string;
}

const MATRIX: MatrixCase[] = [
  {
    name: "neither set",
    env: () => ({}),
    expected: (base) => `${base}/.config.json`,
  },
  {
    name: "CONFIG_FILE only, absolute",
    env: () => ({ CONFIG_FILE: "/etc/vibe/config.json" }),
    expected: () => "/etc/vibe/config.json",
  },
  {
    name: "CONFIG_PATH only, absolute",
    env: () => ({ CONFIG_PATH: "/etc/vibe/config.json" }),
    expected: () => "/etc/vibe/config.json",
  },
  {
    name: "CONFIG_FILE only, relative",
    env: () => ({ CONFIG_FILE: "state/config.json" }),
    expected: (base) => `${base}/state/config.json`,
  },
  {
    name: "CONFIG_PATH only, relative with a leading ./",
    env: () => ({ CONFIG_PATH: "./state/config.json" }),
    expected: (base) => `${base}/state/config.json`,
  },
  {
    name: "both set and agreeing",
    env: () => ({
      CONFIG_FILE: "/etc/vibe/config.json",
      CONFIG_PATH: "/etc/vibe/config.json",
    }),
    expected: () => "/etc/vibe/config.json",
  },
  {
    name: "both set, one relative, agreeing once resolved",
    env: (base) => ({
      CONFIG_FILE: "state/config.json",
      CONFIG_PATH: `${base}/state/config.json`,
    }),
    expected: (base) => `${base}/state/config.json`,
  },
];

Deno.test("resolveHostConfigPath - answers every CONFIG_FILE / CONFIG_PATH combination (Issue #750)", () => {
  for (const testCase of MATRIX) {
    assertEquals(
      resolveHostConfigPath({ baseDir: BASE, env: reader(testCase.env(BASE)) }),
      testCase.expected(BASE),
      testCase.name,
    );
  }
});

Deno.test("resolveHostConfigPath - both set and disagreeing fails loud (Issue #750)", () => {
  const error = assertThrows(
    () =>
      resolveHostConfigPath({
        baseDir: BASE,
        env: reader({
          CONFIG_FILE: "/etc/vibe/config.json",
          CONFIG_PATH: "/srv/other/config.json",
        }),
      }),
    Error,
    "CONFIG_FILE",
  );
  const message = (error as Error).message;
  assert(message.includes("CONFIG_PATH"), "names the alias too");
  assert(message.includes("/etc/vibe/config.json"), "names the canonical file");
  assert(message.includes("/srv/other/config.json"), "names the alias's file");
});

Deno.test("resolveHostConfigPath - an empty value is not a setting (Issue #750)", () => {
  assertEquals(
    resolveHostConfigPath({
      baseDir: BASE,
      env: reader({ CONFIG_FILE: "", CONFIG_PATH: "  " }),
    }),
    `${BASE}/.config.json`,
  );
});

Deno.test("resolveHostConfigPath - resolves in the host's own path spelling (Issue #750)", () => {
  assertEquals(
    resolveHostConfigPath({
      baseDir: "C:\\VibeCoder",
      env: reader({ CONFIG_FILE: "state\\config.json" }),
    }),
    "C:\\VibeCoder\\state\\config.json",
  );
  assertEquals(
    resolveHostConfigPath({
      baseDir: "C:\\VibeCoder",
      env: reader({ CONFIG_PATH: "D:\\vibe\\config.json" }),
    }),
    "D:\\vibe\\config.json",
  );
});

Deno.test("the launcher stages the file the resolver names (Issue #750)", () => {
  for (const testCase of MATRIX) {
    const env = reader({ HOME: "/home/vibe", ...testCase.env(BASE) });
    const paths = resolveContainerLaunchHostPaths(BASE, env);
    assertEquals(paths.configFile, testCase.expected(BASE), testCase.name);
  }
});

Deno.test("the launcher refuses a host whose two config variables disagree (Issue #750)", () => {
  assertThrows(
    () =>
      resolveContainerLaunchHostPaths(
        BASE,
        reader({
          HOME: "/home/vibe",
          CONFIG_FILE: "/etc/vibe/config.json",
          CONFIG_PATH: "/srv/other/config.json",
        }),
      ),
    Error,
    "CONFIG_PATH",
  );
});

// ---------------------------------------------------------------------------
// The shells must answer what the resolver answers.
//
// Each case runs the real script — `source setup.sh`, `. setup.ps1` — with the
// environment set, and reads back the `CONFIG_FILE` / `$ConfigFile` the script
// resolved. The script reports its own checkout directory in the same run, so
// the expectation is computed from the base the script actually used and no
// path-canonicalisation difference can make the comparison lie.
// ---------------------------------------------------------------------------

/** The environment each matrix case is run under, with a fixed HOME. */
function childEnv(env: Record<string, string>): Record<string, string> {
  return {
    PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
    // A real directory: PowerShell reads its own configuration from HOME and
    // fails to start when it names nothing.
    HOME: Deno.env.get("HOME") ?? "/tmp",
    ...env,
  };
}

/** What one script run reported. */
interface ScriptRun {
  code: number;
  /** The checkout the script resolved itself to. */
  baseDir: string;
  /** The configuration file the script resolved. */
  configFile: string;
  stderr: string;
}

/** Run a shell over the real script and read back what it resolved. */
async function runScript(
  command: string[],
  env: Record<string, string>,
): Promise<ScriptRun> {
  const output = await new Deno.Command(command[0]!, {
    args: command.slice(1),
    env: childEnv(env),
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
    clearEnv: true,
  }).output();
  const decoder = new TextDecoder();
  const lines = decoder.decode(output.stdout).trim().split(/\r?\n/);
  return {
    code: output.code,
    baseDir: lines[0] ?? "",
    configFile: lines[1] ?? "",
    stderr: decoder.decode(output.stderr),
  };
}

/** Source setup.sh and report the checkout and the config file it resolved. */
function bashCommand(): string[] {
  return [
    "bash",
    "-c",
    `source "${SETUP_SH}"\nprintf '%s\\n%s\\n' "$SCRIPT_DIR" "$CONFIG_FILE"`,
  ];
}

Deno.test("setup.sh - resolves the file the resolver names, for every combination (Issue #750)", async () => {
  const checkout = (await runScript(bashCommand(), {})).baseDir;
  for (const testCase of MATRIX) {
    const env = testCase.env(checkout);
    const run = await runScript(bashCommand(), env);
    assertEquals(run.code, 0, `${testCase.name}: ${run.stderr}`);
    assertEquals(run.baseDir, checkout, "the checkout must not move");
    assertEquals(
      run.configFile,
      resolveHostConfigPath({ baseDir: checkout, env: reader(env) }),
      testCase.name,
    );
    assertEquals(run.configFile, testCase.expected(checkout), testCase.name);
  }
});

Deno.test("setup.sh - refuses two config variables that disagree (Issue #750)", async () => {
  const run = await runScript(bashCommand(), {
    CONFIG_FILE: "/etc/vibe/config.json",
    CONFIG_PATH: "/srv/other/config.json",
  });
  assert(run.code !== 0, "the mismatch must fail loud, not pick a side");
  assert(run.stderr.includes("CONFIG_FILE"), run.stderr);
  assert(run.stderr.includes("CONFIG_PATH"), run.stderr);
  assert(run.stderr.includes("/srv/other/config.json"), run.stderr);
});

/** The PowerShell interpreter to drive, or null when there is none. */
async function findPowerShell(): Promise<string | null> {
  for (const candidate of [Deno.env.get("VIBE_PWSH"), "pwsh", "powershell"]) {
    if (!candidate) continue;
    try {
      const output = await new Deno.Command(candidate, {
        args: ["-NoProfile", "-NonInteractive", "-Command", "exit 0"],
        stdout: "null",
        stderr: "null",
      }).output();
      if (output.success) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

const PWSH = await findPowerShell();

/** Dot-source setup.ps1 and report the checkout and the config file. */
function pwshCommand(): string[] {
  return [
    PWSH ?? "pwsh",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `$ErrorActionPreference = "Stop"\n. "${SETUP_PS1}"\n` +
    `Write-Output $ScriptDir\nWrite-Output $ConfigFile`,
  ];
}

Deno.test({
  name:
    "setup.ps1 - resolves the file the resolver names, for every combination (Issue #750)",
  ignore: PWSH === null,
  async fn() {
    const checkout = (await runScript(pwshCommand(), {})).baseDir;
    for (const testCase of MATRIX) {
      const env = testCase.env(checkout);
      const run = await runScript(pwshCommand(), env);
      assertEquals(run.code, 0, `${testCase.name}: ${run.stderr}`);
      assertEquals(
        run.configFile,
        resolveHostConfigPath({ baseDir: checkout, env: reader(env) }),
        testCase.name,
      );
      assertEquals(run.configFile, testCase.expected(checkout), testCase.name);
    }
  },
});

Deno.test({
  name: "setup.ps1 - refuses two config variables that disagree (Issue #750)",
  ignore: PWSH === null,
  async fn() {
    const run = await runScript(pwshCommand(), {
      CONFIG_FILE: "/etc/vibe/config.json",
      CONFIG_PATH: "/srv/other/config.json",
    });
    assert(run.code !== 0, "the mismatch must fail loud, not pick a side");
    assert(run.stderr.includes("CONFIG_PATH"), run.stderr);
  },
});
