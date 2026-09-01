/**
 * setup.sh and setup.ps1 must not drift apart (Issue #4185).
 *
 * Onboarding decides what a host ends up with: its credentials, its config,
 * the labels and branch protection on every monitored repository. A Windows
 * host onboarded by setup.ps1 must reach the same end state as a macOS host
 * onboarded by setup.sh, so the contract each keeps is extracted from its
 * source and compared — the same technique the two launchers already use.
 *
 * The extractor itself is tested against synthetic sources whose contents are
 * known, so a passing parity check cannot be an artefact of a parser that
 * finds nothing.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  compareSetupContracts,
  extractSetupContract,
  PLATFORM_SUPERVISOR,
  setupContractFaults,
  SHARED_SETUP_SUBCOMMANDS,
} from "../lib/setup_contract.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);
const SETUP_SH_SOURCE = await Deno.readTextFile(`${REPO_ROOT}/setup.sh`);
const SETUP_PS1_SOURCE = await Deno.readTextFile(`${REPO_ROOT}/setup.ps1`);

const SETUP_SH = extractSetupContract("setup.sh", SETUP_SH_SOURCE, "bash");
const SETUP_PS1 = extractSetupContract(
  "setup.ps1",
  SETUP_PS1_SOURCE,
  "powershell",
);

// ---------------------------------------------------------------------------
// The extractor itself
// ---------------------------------------------------------------------------

Deno.test("extractSetupContract - reads the subcommands a bash script runs", () => {
  const contract = extractSetupContract(
    "sample.sh",
    [
      'deno run --frozen --lock="${LOCK}" --allow-all "${SCRIPT_DIR}/worker/deno/setup/setup_cli.ts"',
      "run_setup_cli prerequisites",
      "run_setup_cli label-sync || print_warning 'non-fatal'",
      "run_setup_cli launchagent",
      'rm -rf "${dir}/.vibe-cache"',
      "# run_setup_cli hooks   <- a comment cannot run anything",
    ].join("\n"),
    "bash",
  );

  assertEquals(contract.delegatesToSetupCli, true);
  assertEquals(contract.freezesLockfile, true);
  assertEquals(contract.sharedSubcommands, ["prerequisites", "label-sync"]);
  assertEquals(contract.supervisorSubcommands, ["launchagent"]);
  assertEquals(contract.removesCacheOnlyWorkDir, true);
});

Deno.test("extractSetupContract - reads the subcommands a PowerShell script runs", () => {
  const contract = extractSetupContract(
    "sample.ps1",
    [
      '& $deno @("run", "--frozen", "--lock=$DenoLock", "--allow-all", $SetupCli)',
      '$SetupCli = Join-Path $ScriptDir "worker/deno/setup/setup_cli.ts"',
      'Invoke-VibeSetupCliOrExit -Arguments @("prerequisites")',
      'if (-not (Invoke-VibeSetupCli -Arguments @("label-sync"))) { }',
      'Invoke-VibeSetupCli -Arguments @("scheduled-task")',
      'Remove-Item -LiteralPath (Join-Path $dir ".vibe-cache") -Recurse -Force',
      '# Invoke-VibeSetupCli -Arguments @("hooks")   <- a comment runs nothing',
    ].join("\n"),
    "powershell",
  );

  assertEquals(contract.delegatesToSetupCli, true);
  assertEquals(contract.freezesLockfile, true);
  assertEquals(contract.sharedSubcommands, ["prerequisites", "label-sync"]);
  assertEquals(contract.supervisorSubcommands, ["scheduled-task"]);
  assertEquals(contract.removesCacheOnlyWorkDir, true);
});

Deno.test("extractSetupContract - names a script that decides for itself", () => {
  const contract = extractSetupContract(
    "rogue.sh",
    [
      "deno run --allow-all worker/deno/mod.ts label-sync",
      "echo 'skipping the setup CLI entirely'",
    ].join("\n"),
    "bash",
  );

  assertEquals(contract.delegatesToSetupCli, false);
  assertEquals(contract.freezesLockfile, false);
  assertEquals(contract.sharedSubcommands, []);
  assertEquals(contract.supervisorSubcommands, []);

  const faults = setupContractFaults(contract);
  // Delegation, lockfile, every shared subcommand, the supervisor, gh
  // provisioning, credential validation, the provider gate (Issue #745) and
  // the cache-only work dir removal.
  assertEquals(faults.length, 8, faults.join("\n"));
});

Deno.test("setupContractFaults - a dropped setup step is named", () => {
  const contract = extractSetupContract(
    "partial.sh",
    [
      'deno run --frozen --lock="${LOCK}" worker/deno/setup/setup_cli.ts',
      ...SHARED_SETUP_SUBCOMMANDS
        .filter((s) => s !== "branch-protection-sync")
        .map((s) => `run_setup_cli ${s}`),
      "run_setup_cli launchagent",
      // Compliant in every other respect, including the provider gate the
      // credential prompts run behind (Issue #745).
      "run_setup_cli agent-providers",
      "write_gh_hosts_file() { : > hosts.yml; }",
      "claude -p 'Say hello'",
      'rm -rf "${dir}/.vibe-cache"',
    ].join("\n"),
    "bash",
  );

  const faults = setupContractFaults(contract);
  assertEquals(faults.length, 1, faults.join("\n"));
  assertStringIncludes(faults[0]!, "branch-protection-sync");
});

Deno.test("compareSetupContracts - reports a script that drops a step", () => {
  const drifted = extractSetupContract(
    "setup.ps1",
    SETUP_PS1_SOURCE.replace(
      /Invoke-VibeSetupCli -Arguments @\("gitignore-sync"\)/,
      'Invoke-VibeSetupCli -Arguments @("noop")',
    ),
    "powershell",
  );

  const { divergences } = compareSetupContracts(SETUP_SH, drifted);
  assertEquals(divergences.length, 1, divergences.join("\n"));
  assertStringIncludes(divergences[0]!, "shared setup subcommands");
});

Deno.test("compareSetupContracts - dropping the cache-only work dir removal is a divergence (Issue #134)", () => {
  const drifted = extractSetupContract(
    "setup.ps1",
    SETUP_PS1_SOURCE.replace(
      /^.*Remove-Item -LiteralPath \(Join-Path \$Dir "\.vibe-cache"\).*$/m,
      "",
    ),
    "powershell",
  );

  assertEquals(drifted.removesCacheOnlyWorkDir, false);
  const { divergences } = compareSetupContracts(SETUP_SH, drifted);
  assert(
    divergences.some((message) =>
      message.includes("cache-only host work dir removal")
    ),
    `a setup.ps1 without the removal must diverge: ${divergences.join("\n")}`,
  );
});

Deno.test("compareSetupContracts - a script with no supervisor is a real divergence", () => {
  const drifted = extractSetupContract(
    "setup.ps1",
    SETUP_PS1_SOURCE.replaceAll(
      '"scheduled-task"',
      '"no-supervisor-at-all"',
    ),
    "powershell",
  );

  assertEquals(drifted.supervisorSubcommands, []);
  const { divergences, excepted } = compareSetupContracts(SETUP_SH, drifted);
  assertEquals(
    excepted,
    [],
    "the exception must not cover a missing supervisor",
  );
  assert(
    divergences.some((message) => message.includes("platform supervisor")),
    `a supervisor-less setup.ps1 must diverge: ${divergences.join("\n")}`,
  );
});

// ---------------------------------------------------------------------------
// The real setup scripts
// ---------------------------------------------------------------------------

Deno.test("setup.sh and setup.ps1 - keep the same setup contract", () => {
  const { divergences } = compareSetupContracts(SETUP_SH, SETUP_PS1);
  assertEquals(divergences, [], divergences.join("\n"));
});

Deno.test("setup.sh and setup.ps1 - the supervisor asymmetry stays a named exception", () => {
  assertEquals(SETUP_SH.supervisorSubcommands, ["launchagent"]);
  assertEquals(SETUP_PS1.supervisorSubcommands, ["scheduled-task"]);

  const { excepted } = compareSetupContracts(SETUP_SH, SETUP_PS1);
  assertEquals(excepted.length, 1, excepted.join("\n"));
  assertStringIncludes(excepted[0]!, `[${PLATFORM_SUPERVISOR.name}]`);
  assertStringIncludes(excepted[0]!, PLATFORM_SUPERVISOR.reason);
});

Deno.test("setup.sh and setup.ps1 - both are sound on their own", () => {
  for (const contract of [SETUP_SH, SETUP_PS1]) {
    const faults = setupContractFaults(contract);
    assertEquals(faults, [], faults.join("\n"));
    assertEquals(contract.sharedSubcommands, [...SHARED_SETUP_SUBCOMMANDS]);
  }
});

Deno.test("setup.sh and setup.ps1 - both mint and prove a claude credential", () => {
  for (const contract of [SETUP_SH, SETUP_PS1]) {
    assertEquals(
      contract.capturesSetupToken,
      true,
      `${contract.name} must be able to run claude setup-token itself`,
    );
    assertEquals(
      contract.validatesClaudeCredential,
      true,
      `${contract.name} must prove the token with a live call`,
    );
  }
});

// ---------------------------------------------------------------------------
// Provider-gated credential prompts (Issues #730, #745)
// ---------------------------------------------------------------------------

Deno.test("both setup scripts ask which providers this host runs before prompting (Issue #745)", () => {
  assertEquals(SETUP_SH.gatesCredentialsByProvider, true, "setup.sh");
  assertEquals(SETUP_PS1.gatesCredentialsByProvider, true, "setup.ps1");
});

Deno.test("a setup script that drops the provider gate is a fault, on either platform (Issue #745)", () => {
  const blindSh = extractSetupContract(
    "setup.sh",
    SETUP_SH_SOURCE.replaceAll("run_setup_cli agent-providers", "true"),
    "bash",
  );
  const blindPs1 = extractSetupContract(
    "setup.ps1",
    SETUP_PS1_SOURCE.replaceAll(
      'Invoke-VibeSetupCliCapture -Arguments @("agent-providers")',
      '""',
    ),
    "powershell",
  );

  for (const contract of [blindSh, blindPs1]) {
    assertEquals(contract.gatesCredentialsByProvider, false, contract.name);
    const fault = setupContractFaults(contract).find((entry) =>
      entry.includes("coding-agent providers this host runs")
    );
    assert(fault, `${contract.name}: no fault raised for the dropped gate`);
    assertStringIncludes(fault, "Codex-only host");
  }

  // And the two are reported as diverging when only one keeps the gate.
  const report = compareSetupContracts(SETUP_SH, blindPs1);
  assert(
    report.divergences.some((entry) =>
      entry.includes("provider-gated credential prompts")
    ),
    report.divergences.join("\n"),
  );
});
