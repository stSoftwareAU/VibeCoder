/**
 * The setup contract `setup.sh` and `setup.ps1` must both keep (Issue #4185).
 *
 * Onboarding is where a host gets its credentials, its config, its repository
 * labels and its branch protection. A Windows host must not end up with a
 * quieter, thinner version of that than a macOS one — and the way both scripts
 * stay in agreement is by construction: each delegates every platform-neutral
 * step to `worker/deno/setup/setup_cli.ts`. "By construction" only holds while
 * both actually delegate, so this module reads a setup script's source and
 * reports what it does, exactly as `launcher_contract.ts` does for the two
 * launchers.
 *
 * The parity test then fails the moment one of them drops a setup step, stops
 * freezing the lockfile on the widest-permission `deno run` in the repo, stops
 * validating the credential it just wrote, or forgets a coding-agent provider.
 *
 * **The one intended asymmetry.** Each platform supervises the worker its own
 * way — launchd on macOS, Task Scheduler on Windows — so the supervisor
 * subcommand legitimately differs. That is recorded as a named exception
 * ({@link PLATFORM_SUPERVISOR}) and reported, not silently tolerated, and it
 * lapses the moment a script offers no supervisor at all.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { executableLines, type LauncherDialect } from "./launcher_source.ts";

export type { LauncherDialect };

/**
 * Setup CLI subcommands both scripts must run, in the order setup runs them.
 *
 * The platform supervisor commands are deliberately absent: they are the one
 * intended asymmetry and are listed in {@link SUPERVISOR_SUBCOMMANDS}.
 */
export const SHARED_SETUP_SUBCOMMANDS: readonly string[] = [
  "prerequisites",
  "config",
  "label-sync",
  "workflow-sync",
  "best-practices-sync",
  "gitignore-sync",
  "verify-monitored-collaborator",
  "branch-protection-sync",
  "backfill-idle-task-labels",
  "hooks",
  "screenshot",
];

/** The per-platform supervisor subcommands, one per script. */
export const SUPERVISOR_SUBCOMMANDS: readonly string[] = [
  "launchagent",
  "scheduled-task",
];

/**
 * The subcommand that answers "which coding agents does this host run?".
 *
 * Not a setup *step* — a query, like `scheduled-task --status` — so it is not
 * in `SHARED_SETUP_SUBCOMMANDS`; what matters is that both scripts ask it
 * before prompting for any credential (Issues #730, #745).
 */
const AGENT_PROVIDERS_SUBCOMMAND = "agent-providers";

/** Provisioning variables, one per registered coding-agent provider. */
const PROVIDER_PROVISION_VAR = /VIBE_LAUNCHAGENT_[A-Z]+_API_KEY/g;

/** How each dialect spells "run this setup CLI subcommand". */
const SUBCOMMAND_INVOCATION: Record<LauncherDialect, RegExp> = {
  // `run_setup_cli label-sync || print_warning ...`
  bash: /\brun_setup_cli\s+([a-z][a-z-]*)/g,
  // `Invoke-VibeSetupCli -Arguments @("label-sync")`
  // `Capture` included: a query form still names the subcommand the script
  // depends on, and `agent-providers` is only ever read that way (Issue #745).
  powershell:
    /Invoke-VibeSetupCli(?:OrExit|Capture)?\s+-Arguments\s+@\(\s*["']([a-z][a-z-]*)["']/g,
};

/** What one setup script's source says it does. */
export interface SetupContract {
  /** Script file name, used in divergence messages. */
  name: string;
  /** Language the script is written in. */
  dialect: LauncherDialect;
  /** True when the script asks the Deno setup CLI to do the work. */
  delegatesToSetupCli: boolean;
  /** True when the setup CLI is launched with `--frozen` and an explicit lock. */
  freezesLockfile: boolean;
  /** Shared setup subcommands the script runs, in the canonical order. */
  sharedSubcommands: string[];
  /** Supervisor subcommands the script runs. Exactly one is expected. */
  supervisorSubcommands: string[];
  /** Provider provisioning variables the script honours, sorted. */
  providerProvisionVars: string[];
  /** True when the script writes the container-readable gh hosts.yml. */
  provisionsGhCredential: boolean;
  /** True when the script proves a claude credential with a live call. */
  validatesClaudeCredential: boolean;
  /** True when the script can mint a token with `claude setup-token`. */
  capturesSetupToken: boolean;
  /**
   * True when the script asks the setup CLI which coding-agent providers this
   * host runs, and so prompts for those credentials rather than Claude's
   * regardless (Issues #730, #745).
   */
  gatesCredentialsByProvider: boolean;
  /**
   * True when the script removes a host work dir that holds only setup's own
   * `.vibe-cache` (Issue #134). A directory holding worker data still gets a
   * reminder only — this field covers reclaiming setup's own leftovers.
   */
  removesCacheOnlyWorkDir: boolean;
}

/**
 * Every distinct capture of `pattern` in the executable source.
 *
 * Matched against the joined lines rather than line by line, because a long
 * invocation is routinely wrapped across two lines by the formatter and a
 * wrapped call runs exactly like an unwrapped one.
 */
function captures(lines: string[], pattern: RegExp): string[] {
  const found = new Set<string>();
  const code = lines.join("\n");
  // A global regex carries lastIndex between calls; reset it before use.
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) {
    found.add(match[1] ?? match[0]);
  }
  return [...found];
}

/** Does any executable line contain every fragment? */
function runs(lines: string[], ...fragments: string[]): boolean {
  return lines.some((line) =>
    fragments.every((fragment) => line.includes(fragment))
  );
}

/**
 * Read a setup script's source and report the contract it keeps.
 *
 * Only executable lines are considered: a comment naming a subcommand cannot
 * run it, and must not be read as if it could.
 *
 * @param name - Script file name (`setup.sh`, `setup.ps1`)
 * @param source - The script's full source text
 * @param dialect - Language the script is written in
 * @returns What the source says the script does
 */
export function extractSetupContract(
  name: string,
  source: string,
  dialect: LauncherDialect,
): SetupContract {
  const code = executableLines(source, dialect);
  const invoked = captures(code, SUBCOMMAND_INVOCATION[dialect]);

  return {
    name,
    dialect,
    delegatesToSetupCli: runs(code, "setup_cli.ts"),
    freezesLockfile: runs(code, "--frozen") && runs(code, "--lock="),
    sharedSubcommands: SHARED_SETUP_SUBCOMMANDS.filter((subcommand) =>
      invoked.includes(subcommand)
    ),
    supervisorSubcommands: SUPERVISOR_SUBCOMMANDS.filter((subcommand) =>
      invoked.includes(subcommand)
    ),
    providerProvisionVars: captures(code, PROVIDER_PROVISION_VAR).sort(),
    provisionsGhCredential: runs(code, "hosts.yml"),
    validatesClaudeCredential: runs(code, "claude", "-p"),
    capturesSetupToken: runs(code, "claude setup-token"),
    gatesCredentialsByProvider: invoked.includes(AGENT_PROVIDERS_SUBCOMMAND),
    // The removal is detected by its command, not its message: the one line
    // that recursively deletes the `.vibe-cache` subtree (Issue #134).
    removesCacheOnlyWorkDir: dialect === "bash"
      ? runs(code, "rm -rf", ".vibe-cache")
      : runs(code, "Remove-Item", ".vibe-cache"),
  };
}

/** Describe a list for a divergence message. */
function describe(values: string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

/** Contract fields the two setup scripts are compared on. */
export type SetupComparedField =
  | "delegatesToSetupCli"
  | "freezesLockfile"
  | "sharedSubcommands"
  | "supervisorSubcommands"
  | "providerProvisionVars"
  | "provisionsGhCredential"
  | "validatesClaudeCredential"
  | "gatesCredentialsByProvider"
  | "removesCacheOnlyWorkDir";

/** What each compared field is called in a divergence message. */
const COMPARED_FIELDS: Record<SetupComparedField, string> = {
  delegatesToSetupCli: "setup CLI delegation",
  freezesLockfile: "lockfile freezing",
  sharedSubcommands: "shared setup subcommands",
  supervisorSubcommands: "platform supervisor",
  providerProvisionVars: "provider provisioning variables",
  provisionsGhCredential: "gh credential provisioning",
  validatesClaudeCredential: "live credential validation",
  gatesCredentialsByProvider: "provider-gated credential prompts",
  removesCacheOnlyWorkDir: "cache-only host work dir removal",
};

/**
 * A divergence the two setup scripts are allowed to keep, and why.
 */
export interface SetupParityException {
  /** Short name the report quotes. */
  name: string;
  /** Fields the exception covers. */
  fields: readonly SetupComparedField[];
  /** Why the asymmetry is intended. */
  reason: string;
}

/**
 * Each platform supervises the worker its own way (Issue #4185).
 *
 * launchd invokes `run.sh` on macOS and Task Scheduler invokes `run.ps1` on
 * Windows, so the supervisor subcommand differs by design. The exception
 * lapses the moment a script offers no supervisor at all — a host that
 * supervises nothing is a real divergence, not an intended one.
 */
export const PLATFORM_SUPERVISOR: SetupParityException = {
  name: "platform-supervisor",
  fields: ["supervisorSubcommands"],
  reason:
    "each platform supervises the worker its own way (Issue #4185): launchd " +
    "runs run.sh on macOS, Task Scheduler runs run.ps1 on Windows",
};

/** Every intended asymmetry between the two setup scripts. */
export const SETUP_PARITY_EXCEPTIONS: readonly SetupParityException[] = [
  PLATFORM_SUPERVISOR,
];

/** How two setup scripts compare. */
export interface SetupParityReport {
  /** Unintended divergences — empty is the only acceptable result. */
  divergences: string[];
  /** Divergences covered by a named exception, each quoting it. */
  excepted: string[];
}

/** Render one contract value for a divergence message. */
function render(value: boolean | string[]): string {
  return typeof value === "boolean" ? String(value) : describe(value);
}

/**
 * Report every way two setup scripts have drifted apart.
 *
 * @param left - One script's contract
 * @param right - The other script's contract
 * @returns Unintended divergences, and those covered by a named exception
 */
export function compareSetupContracts(
  left: SetupContract,
  right: SetupContract,
): SetupParityReport {
  const report: SetupParityReport = { divergences: [], excepted: [] };

  for (const [field, label] of Object.entries(COMPARED_FIELDS)) {
    const key = field as SetupComparedField;
    const leftValue = left[key];
    const rightValue = right[key];
    if (
      (Array.isArray(leftValue) ? leftValue.join("\0") : leftValue) ===
        (Array.isArray(rightValue) ? rightValue.join("\0") : rightValue)
    ) {
      continue;
    }

    const message = `${label} diverge: ${left.name} has ` +
      `${render(leftValue)}, ${right.name} has ${render(rightValue)}`;
    const exception = SETUP_PARITY_EXCEPTIONS.find((candidate) =>
      candidate.fields.includes(key) &&
      // Granted only while both scripts still supervise the worker somehow.
      left.supervisorSubcommands.length === 1 &&
      right.supervisorSubcommands.length === 1
    );
    if (exception) {
      report.excepted.push(
        `[${exception.name}] intended: ${message} — ${exception.reason}`,
      );
    } else {
      report.divergences.push(message);
    }
  }

  return report;
}

/**
 * Faults in a single setup script, whatever the other one does.
 *
 * Parity alone is not enough: two scripts that both skip branch protection
 * agree with each other and are both wrong.
 *
 * @param contract - The contract read from a setup script's source
 * @returns One message per fault; empty when the script is sound
 */
export function setupContractFaults(contract: SetupContract): string[] {
  const faults: string[] = [];

  if (!contract.delegatesToSetupCli) {
    faults.push(
      `${contract.name} does not delegate to setup_cli.ts, so its setup ` +
        `logic is no longer shared with the other platform`,
    );
  }
  if (!contract.freezesLockfile) {
    faults.push(
      `${contract.name} runs the setup CLI without --frozen and an explicit ` +
        `--lock=, so dependency drift is resolved silently (Issue #3653)`,
    );
  }
  const missing = SHARED_SETUP_SUBCOMMANDS.filter((subcommand) =>
    !contract.sharedSubcommands.includes(subcommand)
  );
  if (missing.length > 0) {
    faults.push(
      `${contract.name} skips setup steps: ${describe(missing)}`,
    );
  }
  if (contract.supervisorSubcommands.length !== 1) {
    faults.push(
      `${contract.name} must offer exactly one platform supervisor, found: ` +
        describe(contract.supervisorSubcommands),
    );
  }
  if (!contract.provisionsGhCredential) {
    faults.push(
      `${contract.name} never writes a container-readable gh credential, so ` +
        `the worker cannot authenticate unattended (Issue #4064)`,
    );
  }
  if (!contract.validatesClaudeCredential) {
    faults.push(
      `${contract.name} stores a credential without proving it works, so an ` +
        `expired token is discovered by the unattended worker instead ` +
        `(Issues #3234, #4161)`,
    );
  }
  if (!contract.gatesCredentialsByProvider) {
    faults.push(
      `${contract.name} prompts for credentials without asking which ` +
        `coding-agent providers this host runs, so a Codex-only host is ` +
        `asked for a Claude token it will never use (Issues #730, #745)`,
    );
  }
  if (!contract.removesCacheOnlyWorkDir) {
    faults.push(
      `${contract.name} never removes a host work dir that holds only ` +
        `setup's own .vibe-cache, so the inert directory survives setup ` +
        `forever (Issue #134)`,
    );
  }

  return faults;
}
