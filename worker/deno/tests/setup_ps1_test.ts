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
import { resolvePowerShell } from "./support/pwsh.ts";

const SETUP_PS1 = new URL("../../../setup.ps1", import.meta.url).pathname;

const PWSH = await resolvePowerShell();

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

/** Whether a path exists, for asserting that a file was *not* written. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
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

// ===========================================================================
// Issue #672 — the Windows launcher gains the same single-repo flags
//
// The operator's correction: "remember to do the windows version not just the
// Mac/Linux version". The first cut of this feature shipped the flags in
// setup.sh alone, which is precisely the drift these tests exist to stop.
// ===========================================================================

Deno.test({
  name: "setup.ps1 - declares the single-repo parameters (Issue #672)",
  ignore: PWSH === null,
  async fn() {
    // Parsed from the file's AST rather than dot-sourced: introspection must
    // not depend on deno being on PATH, which the shared harness deliberately
    // strips.
    const script = `
      $tokens = $null; $errors = $null
      $ast = [System.Management.Automation.Language.Parser]::ParseFile(
        ${JSON.stringify(SETUP_PS1)}, [ref]$tokens, [ref]$errors)
      if ($errors.Count) { $errors | ForEach-Object { $_.Message }; exit 1 }
      ($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath }) -join ","
    `;
    const proc = await new Deno.Command(PWSH!, {
      args: ["-NoProfile", "-NonInteractive", "-Command", script],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const run = {
      code: proc.code,
      output: new TextDecoder().decode(proc.stdout) +
        new TextDecoder().decode(proc.stderr),
    };
    assertEquals(run.code, 0, run.output);
    // Named parameters, the PowerShell idiom — not the bash `--add-repo`.
    assertStringIncludes(run.output, "AddRepo");
    assertStringIncludes(run.output, "RemoveRepo");
    assertStringIncludes(run.output, "ListRepos");
  },
});

Deno.test({
  name:
    "setup.ps1 - -ListRepos prints the repositories rather than swallowing them (Issue #672)",
  ignore: PWSH === null,
  async fn() {
    // The bug this caught: wrapping the call in `if (-not (...))` captures the
    // CLI's output into the condition, so the operator saw NOTHING while the
    // command silently succeeded. For a query, the output is the whole answer.
    const dir = await Deno.makeTempDir({ prefix: "vibe-ps1-repos-" });
    try {
      const configPath = `${dir}/.config.json`;
      await Deno.writeTextFile(
        configPath,
        JSON.stringify({
          allowed_authors: ["nleck"],
          repos: ["owner/alpha", "owner/beta"],
        }),
      );

      const proc = await new Deno.Command(PWSH!, {
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          SETUP_PS1,
          "-ListRepos",
        ],
        env: { ...Deno.env.toObject(), CONFIG_FILE: configPath },
        stdout: "piped",
        stderr: "piped",
      }).output();

      const text = new TextDecoder().decode(proc.stdout) +
        new TextDecoder().decode(proc.stderr);
      assertEquals(proc.code, 0, text);
      assertStringIncludes(text, "owner/alpha");
      assertStringIncludes(text, "owner/beta");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "setup.ps1 - -AddRepo and -RemoveRepo edit the config and set the exit code (Issue #672)",
  ignore: PWSH === null,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "vibe-ps1-repos-" });
    try {
      const configPath = `${dir}/.config.json`;
      await Deno.writeTextFile(
        configPath,
        JSON.stringify({
          allowed_authors: ["nleck"],
          repos: ["owner/keep"],
          repo_config: { "owner/drop": { nice: -10 } },
        }),
      );

      const run = async (...args: string[]) => {
        const proc = await new Deno.Command(PWSH!, {
          args: ["-NoProfile", "-NonInteractive", "-File", SETUP_PS1, ...args],
          env: { ...Deno.env.toObject(), CONFIG_FILE: configPath },
          stdout: "piped",
          stderr: "piped",
        }).output();
        return proc.code;
      };

      assertEquals(await run("-AddRepo", "owner/drop"), 0);
      let config = JSON.parse(await Deno.readTextFile(configPath));
      assert(config.repos.includes("owner/drop"));

      assertEquals(await run("-RemoveRepo", "owner/drop"), 0);
      config = JSON.parse(await Deno.readTextFile(configPath));
      assertEquals(config.repos, ["owner/keep"]);
      // The repo_config entry goes with it, exactly as the bash path does.
      assertEquals(Object.hasOwn(config.repo_config, "owner/drop"), false);

      // A malformed slug must fail loudly so a script can branch on it.
      assertEquals(await run("-AddRepo", "not a repo"), 1);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// ── Provider-gated interactive credentials (Issue #745) ─────────────────
//
// setup.sh runs one credential flow per *configured* provider (Issue #730);
// setup.ps1 ran the Claude flow unconditionally, so a Codex-only Windows host
// was asked for a `CLAUDE_CODE_OAUTH_TOKEN` it would never use. These cases
// drive the real flow with only the terminal replaced — `Read-VibeSecret` is
// the console, and the console is the external service a test may fake.

/** A `claude` on PATH, so "does this host have the CLI?" is not the gate. */
async function stubClaudeCli(dir: string): Promise<void> {
  const stub = `${dir}/claude`;
  await Deno.writeTextFile(stub, "#!/bin/bash\nexit 0\n");
  await Deno.chmod(stub, 0o755);
}

pwshTest(
  "setup.ps1 - a Codex flow asks for the Codex credential and never mentions Claude (Issue #745)",
  async () => {
    const tmp = await Deno.makeTempDir();
    try {
      await stubClaudeCli(tmp);
      const run = await runPwsh(
        `
    function Read-VibeSecret { param([string] $Prompt) return "sk-codex-pasted" }
    Invoke-VibeProviderCredentialFlow -Dir (Get-VibeCredentialDir) -Id "codex"
        `,
        {
          HOME: tmp,
          CONFIG_FILE: `${tmp}/.config.json`,
          PATH: `${tmp}:/usr/bin:/bin`,
        },
      );
      assertEquals(run.code, 0, run.output);

      const dir = `${tmp}/.vibe-coder/credentials`;
      assertEquals(
        await Deno.readTextFile(`${dir}/codex/provider.env`),
        "OPENAI_API_KEY=sk-codex-pasted\n",
      );
      assertEquals(await modeOf(`${dir}/codex/provider.env`), 0o600);
      // No Claude prompt, no Claude token, no Claude credential written —
      // even with a `claude` CLI sitting on PATH.
      assert(
        !run.output.includes("CLAUDE_CODE_OAUTH_TOKEN"),
        `a Codex host was asked for a Claude token:\n${run.output}`,
      );
      assert(
        !run.output.includes("setup-token"),
        `a Codex host was offered claude setup-token:\n${run.output}`,
      );
      assertEquals(await exists(`${dir}/claude/provider.env`), false);
      // The prompt names the variable and where to get it.
      assertStringIncludes(run.output, "OPENAI_API_KEY");
      assertStringIncludes(run.output, "platform.openai.com");
      assertStringIncludes(run.output, "VIBE_LAUNCHAGENT_OPENAI_API_KEY");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

pwshTest(
  "setup.ps1 - a Claude flow keeps today's behaviour (Issue #745)",
  async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const run = await runPwsh(
        `
    function Read-VibeSecret { param([string] $Prompt) return "sk-ant-oat01-pasted" }
    Invoke-VibeProviderCredentialFlow -Dir (Get-VibeCredentialDir) -Id "claude"
        `,
        { HOME: tmp, CONFIG_FILE: `${tmp}/.config.json` },
      );
      assertEquals(run.code, 0, run.output);

      const dir = `${tmp}/.vibe-coder/credentials`;
      assertEquals(
        await Deno.readTextFile(`${dir}/claude/provider.env`),
        "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-pasted\n",
      );
      assertEquals(await modeOf(`${dir}/claude/provider.env`), 0o600);
      // The by-hand recipe is still spelled out in full.
      assertStringIncludes(run.output, "claude setup-token");
      assertStringIncludes(run.output, "sk-ant-oat01-");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

pwshTest(
  "setup.ps1 - the provider set comes from the setup CLI, and an unresolved one is empty (Issue #745)",
  async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const stub = `${tmp}/deno`;
      await Deno.writeTextFile(
        stub,
        `#!/bin/bash\nif [[ "$*" == *agent-providers* ]]; then printf 'codex\\ngemini\\n'; exit 0; fi\nexit 0\n`,
      );
      await Deno.chmod(stub, 0o755);

      const run = await runPwsh(
        `    Write-Output "IDS=$((Get-VibeConfiguredAgentProviders) -join ',')"`,
        {
          HOME: tmp,
          CONFIG_FILE: `${tmp}/.config.json`,
          PATH: `${tmp}:/usr/bin:/bin`,
        },
      );
      assertEquals(run.code, 0, run.output);
      assertStringIncludes(run.output, "IDS=codex,gemini");

      // A selection that cannot be resolved yields nothing, so the caller
      // stops rather than falling back to Claude on a Codex host.
      await Deno.writeTextFile(stub, "#!/bin/bash\nexit 1\n");
      await Deno.chmod(stub, 0o755);
      const failed = await runPwsh(
        `    Write-Output "IDS=$((Get-VibeConfiguredAgentProviders) -join ',')"`,
        {
          HOME: tmp,
          CONFIG_FILE: `${tmp}/.config.json`,
          PATH: `${tmp}:/usr/bin:/bin`,
        },
      );
      assertEquals(failed.code, 0, failed.output);
      assertStringIncludes(failed.output, "IDS=");
      assert(
        !failed.output.includes("IDS=claude"),
        `an unresolved selection must not fall back to Claude:\n${failed.output}`,
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

pwshTest(
  "setup.ps1 - every configured provider gets a flow, in order (Issue #745)",
  async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const run = await runPwsh(
        `
    function Read-VibeSecret { param([string] $Prompt) return "sk-$($Prompt.Trim().Split(' ')[0])" }
    Invoke-VibeInteractiveCredentials -GhSource "" -Providers @("codex", "gemini")
        `,
        { HOME: tmp, CONFIG_FILE: `${tmp}/.config.json` },
      );
      assertEquals(run.code, 0, run.output);

      const dir = `${tmp}/.vibe-coder/credentials`;
      assertEquals(
        await Deno.readTextFile(`${dir}/codex/provider.env`),
        "OPENAI_API_KEY=sk-OPENAI_API_KEY\n",
      );
      assertEquals(
        await Deno.readTextFile(`${dir}/gemini/provider.env`),
        "GEMINI_API_KEY=sk-GEMINI_API_KEY\n",
      );
      assertEquals(await exists(`${dir}/claude/provider.env`), false);
      // The run says which flows it will drive before driving them.
      assertStringIncludes(run.output, "codex gemini");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

pwshTest(
  "setup.ps1 - an unregistered provider is reported, not guessed at (Issue #745)",
  async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const run = await runPwsh(
        `    Invoke-VibeProviderCredentialFlow -Dir (Get-VibeCredentialDir) -Id "nosuch"`,
        { HOME: tmp, CONFIG_FILE: `${tmp}/.config.json` },
      );
      assertStringIncludes(run.output, "No credential row");
      assertStringIncludes(run.output, "nosuch");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

// ── The login lookup and gh's exit code (Issue #1146) ───────────────────
//
// The twin of the setup.sh cases in `setup_credential_provisioning_test.ts`.
// `gh api` prints the API's response body to stdout on an HTTP error, so
// `Select-Object -First 1` takes that body's first line — `{` — rather than
// nothing, and a token gh rejects produced a hosts.yml with JSON where the
// username belongs. Both halves of the guard are asserted here: the exit code
// is honoured, and the output must be shaped like a GitHub login.

/** A `gh` that fails the way the real one does: body on stdout, exit 1. */
const PS_GH_REJECTS_TOKEN = `#!/usr/bin/env bash
cat <<'JSON'
{
  "message": "Bad credentials",
  "documentation_url": "https://docs.github.com/rest",
  "status": "401"
}
JSON
echo 'gh: Bad credentials (HTTP 401)' >&2
exit 1
`;

/** A `gh` that resolves the login the way a good token does. */
const PS_GH_RESOLVES_LOGIN = `#!/usr/bin/env bash
echo 'vibe-worker-bot'
`;

/** A `gh` that exits 0 but prints something that is not a login. */
const PS_GH_PRINTS_NON_LOGIN = `#!/usr/bin/env bash
printf 'not a login\\n'
`;

/**
 * Run `fn` with a PATH whose `gh` is `stub`.
 *
 * The stub is a shell script, as the rest of this suite's POSIX assumptions
 * already are (`/usr/bin:/bin`, POSIX permission bits) — pwsh on a POSIX host
 * is what CI and the developer machines run.
 */
async function withGhStub<T>(
  stub: string,
  fn: (path: string) => Promise<T>,
): Promise<T> {
  const bin = await Deno.makeTempDir({ prefix: "vibe_ps1_gh_" });
  try {
    await Deno.writeTextFile(`${bin}/gh`, stub);
    await Deno.chmod(`${bin}/gh`, 0o755);
    return await fn(`${bin}:/usr/bin:/bin`);
  } finally {
    await Deno.remove(bin, { recursive: true });
  }
}

/** Provision a gh credential under `tmp` with `gh` stubbed by `stub`. */
async function provisionWithGhStub(
  tmp: string,
  token: string,
  stub: string,
): Promise<PwshRun> {
  return await withGhStub(stub, (path) =>
    runPwsh(
      `
    Invoke-VibeCredentialProvisioning
      `,
      {
        PATH: path,
        HOME: tmp,
        CONFIG_FILE: `${tmp}/.config.json`,
        VIBE_LAUNCHAGENT_GH_TOKEN: token,
        VIBE_LAUNCHAGENT_ANTHROPIC_API_KEY: "sk-ant-provisioned",
      },
    ));
}

pwshTest(
  "setup.ps1 - a token gh rejects writes a token-only hosts.yml (Issue #1146)",
  async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const run = await provisionWithGhStub(
        tmp,
        "gho_rejected",
        PS_GH_REJECTS_TOKEN,
      );
      // Not fatal: the token alone authenticates.
      assertEquals(run.code, 0, run.output);

      const hosts = await Deno.readTextFile(
        `${tmp}/.vibe-coder/credentials/gh/hosts.yml`,
      );
      assertEquals(
        hosts,
        "github.com:\n    oauth_token: gho_rejected\n    git_protocol: ssh\n",
      );
      assert(
        !hosts.includes("user:"),
        `hosts.yml carries a user key: ${hosts}`,
      );
      assert(!hosts.includes("{"), `hosts.yml carries JSON: ${hosts}`);
      assert(
        !hosts.includes("Bad credentials"),
        `hosts.yml carries gh's error body: ${hosts}`,
      );
      assertStringIncludes(
        run.output,
        "gh could not resolve the token's login",
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

pwshTest(
  "setup.ps1 - a token gh accepts still completes the host entry (Issue #1146)",
  async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const run = await provisionWithGhStub(
        tmp,
        "gho_accepted",
        PS_GH_RESOLVES_LOGIN,
      );
      assertEquals(run.code, 0, run.output);

      const hosts = await Deno.readTextFile(
        `${tmp}/.vibe-coder/credentials/gh/hosts.yml`,
      );
      assertEquals(
        hosts,
        "github.com:\n" +
          "    oauth_token: gho_accepted\n" +
          "    git_protocol: ssh\n" +
          "    user: vibe-worker-bot\n" +
          "    users:\n" +
          "        vibe-worker-bot:\n" +
          "            oauth_token: gho_accepted\n",
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

pwshTest(
  "setup.ps1 - output that is not a login is refused even on exit 0 (Issue #1146)",
  async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const run = await provisionWithGhStub(
        tmp,
        "gho_odd",
        PS_GH_PRINTS_NON_LOGIN,
      );
      assertEquals(run.code, 0, run.output);

      const hosts = await Deno.readTextFile(
        `${tmp}/.vibe-coder/credentials/gh/hosts.yml`,
      );
      assertEquals(
        hosts,
        "github.com:\n    oauth_token: gho_odd\n    git_protocol: ssh\n",
      );
      assertStringIncludes(run.output, "gh returned no usable GitHub login");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);
