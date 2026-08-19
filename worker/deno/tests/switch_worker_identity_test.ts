/**
 * Tests for `switch-worker-identity.sh` (Issue #4029).
 *
 * `gh_config_dir` is optional: when it is unset the worker's `gh` calls fall
 * through to the ambient gh config dir, so an identity still exists and is
 * still switchable. The script used to `die` in preflight on such hosts,
 * leaving no supported identity-switch path at all.
 *
 * Each test runs the real script with `gh`, `pgrep`, `launchctl` and `crontab`
 * stubbed onto PATH — no network, no real auth state — and asserts on the exit
 * code, the reported config dir, and the `GH_CONFIG_DIR` every stubbed `gh`
 * call actually received.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const SCRIPT_PATH =
  new URL("../../../switch-worker-identity.sh", import.meta.url).pathname;

const ACTIVE_USER = "stsvcbot";

interface Harness {
  /** Temp root; also acts as HOME for the run. */
  home: string;
  configFile: string;
  ghCallLog: string;
}

/** Build a temp HOME with stubbed binaries and a `.config.json`. */
async function makeHarness(
  config: Record<string, unknown>,
  accounts: string[] = [ACTIVE_USER],
): Promise<Harness> {
  const home = await Deno.makeTempDir({ prefix: "switch_identity_" });
  const stubs = `${home}/stubs`;
  await Deno.mkdir(stubs, { recursive: true });

  const ghCallLog = `${home}/gh-calls.log`;

  // gh stub: records the config dir it was invoked with, then answers the
  // handful of subcommands the script uses.
  await writeStub(
    `${stubs}/gh`,
    `printf '%s | %s\\n' "\${GH_CONFIG_DIR:-<unset>}" "$*" >> "${ghCallLog}"
case "$1 $2" in
  "auth status")
    [ -n "${accounts.join(" ")}" ] || exit 1
    echo "github.com"
    for a in ${accounts.join(" ")}; do
      echo "  ✓ Logged in to github.com account $a (keyring)"
    done
    ;;
  "api user") echo "${ACTIVE_USER}" ;;
  "api repos/"*) echo '{"push":true,"pull":true}' ;;
esac
exit 0`,
  );
  // Never let the tests touch the host's process table, launchd or crontab.
  await writeStub(`${stubs}/pgrep`, "exit 1");
  await writeStub(`${stubs}/launchctl`, "exit 1");
  await writeStub(`${stubs}/crontab`, "exit 1");

  const configFile = `${home}/.config.json`;
  await Deno.writeTextFile(configFile, JSON.stringify(config, null, 2));
  return { home, configFile, ghCallLog };
}

async function writeStub(path: string, body: string): Promise<void> {
  await Deno.writeTextFile(path, `#!/bin/bash\n${body}\n`);
  await Deno.chmod(path, 0o755);
}

interface Run {
  code: number;
  output: string;
}

async function runScript(
  h: Harness,
  args: string[] = ["--user", ACTIVE_USER],
  extraEnv: Record<string, string> = {},
): Promise<Run> {
  const out = await new Deno.Command("bash", {
    args: [SCRIPT_PATH, ...args],
    cwd: h.home,
    clearEnv: true,
    env: {
      PATH: `${h.home}/stubs:${Deno.env.get("PATH") ?? "/usr/bin:/bin"}`,
      HOME: h.home,
      CONFIG_FILE: h.configFile,
      ...extraEnv,
    },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  return {
    code: out.code,
    output: dec.decode(out.stdout) + dec.decode(out.stderr),
  };
}

/** Distinct GH_CONFIG_DIR values the stubbed gh was invoked with. */
async function ghConfigDirsUsed(h: Harness): Promise<string[]> {
  const log = await Deno.readTextFile(h.ghCallLog);
  const dirs = log.split("\n").filter((l) => l.trim() !== "").map((l) =>
    l.split(" | ")[0] ?? ""
  );
  return [...new Set(dirs)];
}

Deno.test("switch-worker-identity: proceeds when gh_config_dir is unset", async () => {
  const h = await makeHarness({ repos: ["stSoftwareAU/VibeCoder"] });
  try {
    const run = await runScript(h);
    assertEquals(run.code, 0, `script failed:\n${run.output}`);
    // It must run the real steps, not die in preflight.
    assertStringIncludes(run.output, "Step 4: verify identity");
    assertStringIncludes(run.output, "gh api user returns: stsvcbot");
    // And it must say plainly which dir it is operating on.
    assertStringIncludes(run.output, `${h.home}/.config/gh`);
  } finally {
    await Deno.remove(h.home, { recursive: true });
  }
});

Deno.test("switch-worker-identity: unset gh_config_dir operates on the ambient dir", async () => {
  const h = await makeHarness({ repos: ["stSoftwareAU/VibeCoder"] });
  try {
    await runScript(h);
    assertEquals(await ghConfigDirsUsed(h), [`${h.home}/.config/gh`]);
  } finally {
    await Deno.remove(h.home, { recursive: true });
  }
});

Deno.test("switch-worker-identity: exported GH_CONFIG_DIR wins over the ~/.config/gh default", async () => {
  const h = await makeHarness({ repos: ["stSoftwareAU/VibeCoder"] });
  const ambient = `${h.home}/exported-gh`;
  try {
    const run = await runScript(h, ["--user", ACTIVE_USER], {
      GH_CONFIG_DIR: ambient,
    });
    assertEquals(run.code, 0, `script failed:\n${run.output}`);
    assertEquals(await ghConfigDirsUsed(h), [ambient]);
  } finally {
    await Deno.remove(h.home, { recursive: true });
  }
});

Deno.test("switch-worker-identity: configured gh_config_dir still wins and behaviour is unchanged", async () => {
  const h = await makeHarness({
    gh_config_dir: "~/.config/gh-vibe",
    repos: ["stSoftwareAU/VibeCoder"],
  });
  try {
    // An exported GH_CONFIG_DIR must not override the configured value.
    const run = await runScript(h, ["--user", ACTIVE_USER], {
      GH_CONFIG_DIR: `${h.home}/exported-gh`,
    });
    assertEquals(run.code, 0, `script failed:\n${run.output}`);
    assertEquals(await ghConfigDirsUsed(h), [`${h.home}/.config/gh-vibe`]);
    assert(
      !run.output.includes("gh_config_dir not set"),
      `unexpected fallback warning:\n${run.output}`,
    );
  } finally {
    await Deno.remove(h.home, { recursive: true });
  }
});

Deno.test("switch-worker-identity: warns when the target dir holds more than one account", async () => {
  const h = await makeHarness({ repos: ["stSoftwareAU/VibeCoder"] }, [
    ACTIVE_USER,
    "VibeCoderBot",
  ]);
  try {
    const run = await runScript(h);
    assertEquals(run.code, 0, `script failed:\n${run.output}`);
    assertStringIncludes(run.output, "2 GitHub accounts are authenticated");
    // Advisory: offer a dedicated per-worker dir so the active account is pinned.
    assertStringIncludes(run.output, "gh-vibe");
  } finally {
    await Deno.remove(h.home, { recursive: true });
  }
});

Deno.test("switch-worker-identity: no multi-account warning for a single account", async () => {
  const h = await makeHarness({ repos: ["stSoftwareAU/VibeCoder"] });
  try {
    const run = await runScript(h);
    assert(
      !run.output.includes("accounts are authenticated"),
      `unexpected multi-account warning:\n${run.output}`,
    );
  } finally {
    await Deno.remove(h.home, { recursive: true });
  }
});
