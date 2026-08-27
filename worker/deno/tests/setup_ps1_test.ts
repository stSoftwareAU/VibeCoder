/**
 * Behavioural tests for setup.ps1 (Issue #4185).
 *
 * setup.ps1 is the Windows onboarding path, so it is tested the way setup.sh
 * is: each case dot-sources the real script, calls a real function with a
 * temporary HOME, and asserts on what it wrote — file contents, permissions,
 * and whether the result satisfies the worker's own credential preflight.
 *
 * PowerShell is the only requirement. Where no `pwsh` is installed the suite
 * skips rather than silently passing; CI and any developer host with
 * PowerShell installed runs it in full. `$env:VIBE_PWSH` names an interpreter
 * that is not on PATH.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkCredentialPreflight,
  credentialPreflightMessage,
} from "../lib/credential_preflight.ts";
import {
  agentProviderIds,
  resolveAgentProvider,
} from "../lib/agent_provider.ts";

const SETUP_PS1 = new URL("../../../setup.ps1", import.meta.url).pathname;

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

/** What one PowerShell harness run reported. */
interface PwshRun {
  code: number;
  output: string;
}

/**
 * Dot-source setup.ps1 and run `body` against it.
 *
 * `env` is applied to the child process, so a test controls HOME, the
 * credential directory and the config path exactly as the bash suite does.
 */
async function runPwsh(
  body: string,
  env: Record<string, string>,
): Promise<PwshRun> {
  const script = `
    $ErrorActionPreference = "Stop"
    . "${SETUP_PS1}"
${body}
  `;
  const output = await new Deno.Command(PWSH!, {
    args: ["-NoProfile", "-NonInteractive", "-Command", script],
    env: {
      // A PATH without gh or claude keeps the lookups off the network.
      PATH: "/usr/bin:/bin",
      ...env,
    },
    stdin: "null",
    clearEnv: true,
  }).output();
  const decoder = new TextDecoder();
  return {
    code: output.code,
    output: decoder.decode(output.stdout) + decoder.decode(output.stderr),
  };
}

/** Register a test that needs PowerShell, skipping when there is none. */
function pwshTest(name: string, fn: () => Promise<void>): void {
  Deno.test({ name, ignore: PWSH === null, fn });
}

/** POSIX permission bits of a path. */
async function modeOf(path: string): Promise<number> {
  const info = await Deno.stat(path);
  return (info.mode ?? 0) & 0o777;
}

// ── Credential provisioning ─────────────────────────────────────────────

pwshTest(
  "setup.ps1 - Invoke-VibeCredentialProvisioning writes owner-only material",
  async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const run = await runPwsh(
        `
    Invoke-VibeCredentialProvisioning
    Write-Output "PROVISIONED_GH_DIR=$($script:VibeProvisionedGhConfigDir)"
        `,
        {
          HOME: tmp,
          CONFIG_FILE: `${tmp}/.config.json`,
          VIBE_LAUNCHAGENT_GH_TOKEN: "gho_provisioned",
          VIBE_LAUNCHAGENT_ANTHROPIC_API_KEY: "sk-ant-provisioned",
        },
      );
      assertEquals(run.code, 0, run.output);

      const dir = `${tmp}/.vibe-coder/credentials`;
      const hosts = await Deno.readTextFile(`${dir}/gh/hosts.yml`);
      assertStringIncludes(hosts, "oauth_token: gho_provisioned");
      assertStringIncludes(hosts, "git_protocol: ssh");
      // The container reads these files on Linux: CRLF and a BOM are defects.
      assert(!hosts.includes("\r"), "hosts.yml must use LF endings");
      assert(!hosts.startsWith("\uFEFF"), "hosts.yml must have no BOM");

      const provider = await Deno.readTextFile(`${dir}/claude/provider.env`);
      assertEquals(provider, "ANTHROPIC_API_KEY=sk-ant-provisioned\n");

      if (Deno.build.os !== "windows") {
        assertEquals(await modeOf(dir), 0o700);
        assertEquals(await modeOf(`${dir}/gh/hosts.yml`), 0o600);
        assertEquals(await modeOf(`${dir}/claude/provider.env`), 0o600);
      }

      assertStringIncludes(run.output, `PROVISIONED_GH_DIR=${dir}/gh`);

      // The worker's own preflight accepts what setup.ps1 provisioned — the
      // same assertion the setup.sh suite makes.
      const result = await checkCredentialPreflight({
        dir,
        env: () => undefined,
      });
      assertEquals(result.ok, true, credentialPreflightMessage(result));
      assertEquals(result.githubSource, "directory");
      assertEquals(result.providerSource, "directory");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

pwshTest(
  "setup.ps1 - honours VIBE_CREDENTIAL_DIR and CLAUDE_CODE_OAUTH_TOKEN",
  async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const dir = `${tmp}/mounted-credentials`;
      const run = await runPwsh("    Invoke-VibeCredentialProvisioning", {
        HOME: tmp,
        CONFIG_FILE: `${tmp}/.config.json`,
        VIBE_CREDENTIAL_DIR: dir,
        GH_TOKEN: "gho_env",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
      });
      assertEquals(run.code, 0, run.output);

      assertEquals(
        await Deno.readTextFile(`${dir}/claude/provider.env`),
        "CLAUDE_CODE_OAUTH_TOKEN=oauth-token\n",
      );
      const result = await checkCredentialPreflight({
        dir,
        env: () => undefined,
      });
      assertEquals(result.ok, true, credentialPreflightMessage(result));
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

pwshTest(
  "setup.ps1 - provisioning one vendor never writes another's file",
  async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const dir = `${tmp}/.vibe-coder/credentials`;
      const run = await runPwsh("    Invoke-VibeCredentialProvisioning", {
        HOME: tmp,
        CONFIG_FILE: `${tmp}/.config.json`,
        VIBE_LAUNCHAGENT_OPENAI_API_KEY: "sk-openai",
      });
      assertEquals(run.code, 0, run.output);

      assertEquals(
        await Deno.readTextFile(`${dir}/codex/provider.env`),
        "OPENAI_API_KEY=sk-openai\n",
      );
      for (const other of ["claude", "gemini"]) {
        assertEquals(
          await Deno.stat(`${dir}/${other}/provider.env`).catch(() => null),
          null,
          `${other} must be left unprovisioned`,
        );
      }
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

pwshTest(
  "setup.ps1 - no credential variables writes nothing and says so",
  async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const run = await runPwsh("    Invoke-VibeCredentialProvisioning", {
        HOME: tmp,
        CONFIG_FILE: `${tmp}/.config.json`,
      });
      assertEquals(run.code, 0, run.output);
      assertStringIncludes(run.output, "VIBE_LAUNCHAGENT_GH_TOKEN");
      assertEquals(
        await Deno.stat(`${tmp}/.vibe-coder/credentials`).catch(() => null),
        null,
        "nothing may be created when there is nothing to provision",
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

pwshTest(
  "setup.ps1 - the provider credential table matches the registered descriptors",
  async () => {
    // The twin of the setup.sh assertion in multi_provider_credentials_test.ts:
    // agent_provider.ts stays the single source of truth for all three.
    const tmp = await Deno.makeTempDir();
    try {
      const run = await runPwsh(
        `
    foreach ($p in Get-VibeProviderCredentialTable) {
        Write-Output "$($p.Subdir)|$($p.ProvisionVar)|$($p.Vars -join ',')"
    }
        `,
        { HOME: tmp, CONFIG_FILE: `${tmp}/.config.json` },
      );
      assertEquals(run.code, 0, run.output);

      const rows = run.output.trim().split("\n").map((line) => line.trim())
        .filter((line) => line.includes("|")).map((line) => line.split("|"));
      const descriptors = agentProviderIds().map((id) =>
        resolveAgentProvider(id)
      );

      // Every registered descriptor must be provisionable on Windows too
      // (Issue #416); a row may precede its descriptor, so the reverse
      // direction is not asserted here.
      const bySubdir = new Map(rows.map((row) => [row[0], row]));
      for (const provider of descriptors) {
        const row = bySubdir.get(provider.credentials.subdir);
        assert(
          row,
          `setup.ps1 offers no credential directory for ${provider.id}`,
        );
        assertEquals(
          row[1],
          provider.credentials.provisionEnvVar,
          `${provider.id} provisions from the descriptor's provisioning variable`,
        );
        assertEquals(
          row[2],
          provider.credentials.envVars.join(","),
          `${provider.id} lists the descriptor's credential variables`,
        );
      }

      // setup.sh and setup.ps1 must offer the same vendors — a row added to
      // one script and forgotten in the other leaves a platform unable to
      // provision that provider at all.
      const setupSh = await Deno.readTextFile(
        new URL("../../../setup.sh", import.meta.url).pathname,
      );
      const shSubdirs = [
        ...setupSh.matchAll(/^([a-z][a-z0-9-]*)\|VIBE_LAUNCHAGENT_/gm),
      ].map((match) => match[1]);
      assertEquals(
        rows.map((row) => row[0]),
        shSubdirs,
        "setup.ps1 lists the same providers, in the same order, as setup.sh",
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

// ── The setup-token capture (no script(1) on Windows) ───────────────────

pwshTest(
  "setup.ps1 - reads the OAuth token back from a transcript",
  async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const run = await runPwsh(
        `
    $transcript = @"
Opening browser...
Paste this code: 1234
Your token: sk-ant-oat01-FIRST_token-value
Rotated to: sk-ant-oat01-SECOND_token-value
"@
    Write-Output "TOKEN=$(Get-VibeSetupTokenFromTranscript -Transcript $transcript)"
    Write-Output "EMPTY=[$(Get-VibeSetupTokenFromTranscript -Transcript 'nothing here')]"
      `,
        { HOME: tmp, CONFIG_FILE: `${tmp}/.config.json` },
      );
      assertEquals(run.code, 0, run.output);

      // The last token wins — a rotated token must not be shadowed by the first.
      assertStringIncludes(run.output, "TOKEN=sk-ant-oat01-SECOND_token-value");
      // A transcript with no token yields nothing, so the caller falls back to
      // the paste prompt rather than writing a bogus credential.
      assertStringIncludes(run.output, "EMPTY=[]");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

// ── The config merge, without jq ────────────────────────────────────────

pwshTest(
  "setup.ps1 - merges interactive answers into .config.json",
  async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const configPath = `${tmp}/.config.json`;
      await Deno.writeTextFile(
        configPath,
        JSON.stringify({ repos: ["old/repo"], poll_interval: 60 }, null, 2),
      );

      const run = await runPwsh(
        `
    $answers = [ordered]@{
        repos           = @("org/one", "org/two")
        allowed_authors = @("someone")
        gh_config_dir   = "C:\\Users\\vibe\\.config\\gh-vibe"
    }
    Write-VibeInteractiveConfig -Answers $answers
      `,
        { HOME: tmp, CONFIG_FILE: configPath },
      );
      assertEquals(run.code, 0, run.output);

      // Parsed by Deno, exactly as the worker will parse it: no BOM, valid JSON.
      const raw = await Deno.readTextFile(configPath);
      assert(!raw.startsWith("\uFEFF"), "the config must not gain a BOM");
      const config = JSON.parse(raw) as Record<string, unknown>;
      assertEquals(config.repos, ["org/one", "org/two"]);
      assertEquals(config.allowed_authors, ["someone"]);
      assertEquals(config.gh_config_dir, "C:\\Users\\vibe\\.config\\gh-vibe");
      // Untouched keys survive the merge.
      assertEquals(config.poll_interval, 60);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

pwshTest(
  "setup.ps1 - an unreadable config fails loudly instead of dropping answers",
  async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const configPath = `${tmp}/.config.json`;
      await Deno.writeTextFile(configPath, "{ this is not json");

      const run = await runPwsh(
        `
    Write-VibeInteractiveConfig -Answers ([ordered]@{ repos = @("org/one") })
        `,
        { HOME: tmp, CONFIG_FILE: configPath },
      );

      assertEquals(run.code, 1, `answers must never be dropped: ${run.output}`);
      // The broken file is left as it was rather than silently overwritten.
      assertEquals(await Deno.readTextFile(configPath), "{ this is not json");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

// ── Delegation to the Deno setup CLI ────────────────────────────────────

pwshTest(
  "setup.ps1 - delegates to setup_cli.ts with a frozen lockfile",
  async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const argsFile = `${tmp}/args`;
      const stub = `${tmp}/deno`;
      await Deno.writeTextFile(
        stub,
        `#!/bin/bash\nprintf '%s\\n' "$@" > "${argsFile}"\n`,
      );
      await Deno.chmod(stub, 0o755);

      const run = await runPwsh(
        `    [void](Invoke-VibeSetupCli -Arguments @("hooks"))`,
        {
          HOME: tmp,
          CONFIG_FILE: `${tmp}/.config.json`,
          PATH: `${tmp}:/usr/bin:/bin`,
        },
      );
      assertEquals(run.code, 0, run.output);

      const args = (await Deno.readTextFile(argsFile)).split("\n").filter((a) =>
        a.length > 0
      );
      assertEquals(args[0], "run");
      // Fail closed on dependency drift, exactly as setup.sh does (Issue #3653).
      assert(args.includes("--frozen"), args.join(" "));
      const lock = args.find((a) => a.startsWith("--lock="));
      assert(lock, `expected an explicit --lock= flag in: ${args.join(" ")}`);
      assertEquals(
        await Deno.realPath(lock.slice("--lock=".length)),
        new URL("../deno.lock", import.meta.url).pathname,
      );
      // The subcommand and the paths still reach the CLI.
      assert(
        args.some((a) => a.endsWith("/setup/setup_cli.ts")),
        args.join(" "),
      );
      assert(args.includes("hooks"), args.join(" "));
      assert(args.includes("--script-dir"), args.join(" "));
      assert(args.includes("--config-path"), args.join(" "));
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

pwshTest(
  "setup.ps1 - a failed setup CLI call is reported, not swallowed",
  async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const stub = `${tmp}/deno`;
      await Deno.writeTextFile(stub, "#!/bin/bash\nexit 3\n");
      await Deno.chmod(stub, 0o755);

      const run = await runPwsh(
        `    Write-Output "OK=$(Invoke-VibeSetupCli -Arguments @('hooks'))"`,
        {
          HOME: tmp,
          CONFIG_FILE: `${tmp}/.config.json`,
          PATH: `${tmp}:/usr/bin:/bin`,
        },
      );
      assertEquals(run.code, 0, run.output);
      assertStringIncludes(run.output, "OK=False");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

// ── Dot-sourcing must not run setup ─────────────────────────────────────

pwshTest("setup.ps1 - dot-sourcing runs no setup step", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const stub = `${tmp}/deno`;
    await Deno.writeTextFile(
      stub,
      `#!/bin/bash\ntouch "${tmp}/deno-was-run"\nexit 0\n`,
    );
    await Deno.chmod(stub, 0o755);

    const run = await runPwsh(`    Write-Output "SOURCED"`, {
      HOME: tmp,
      CONFIG_FILE: `${tmp}/.config.json`,
      PATH: `${tmp}:/usr/bin:/bin`,
    });

    assertEquals(run.code, 0, run.output);
    assertStringIncludes(run.output, "SOURCED");
    assertEquals(
      await Deno.stat(`${tmp}/deno-was-run`).catch(() => null),
      null,
      "dot-sourcing must not start the setup run",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
