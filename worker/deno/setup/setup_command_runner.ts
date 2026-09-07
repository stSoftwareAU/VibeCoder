/**
 * The one subprocess runner every `setup/` module uses (Issue #1259).
 *
 * Seven setup modules had each grown the same `createDefaultRunCommand`, and
 * every one of them spawned `new Deno.Command(cmd[0]!, …)` with `["gh", …]`
 * handed in by its caller — the variable-binary evasion Issue #1227 records,
 * applied to a directory the chokepoint gate had never scanned. A `setup`
 * `gh` call therefore ran outside all three controls `spawnGh` owns: the
 * per-run write-repo allowlist, `redactGhBodyArgs`, and the audit journal.
 *
 * This module is the delegation those callers needed, written once:
 *
 * - `gh` goes to `spawnGh` (`worker/deno/lib/gh_spawn.ts`),
 * - `git` goes to `runGitCommand` (`worker/deno/lib/git_timeout.ts`), which
 *   owns the timeout, the message redaction and the git half of the journal,
 * - any other binary — `brew`, `jq`, `deno`, a `--version` probe — is spawned
 *   directly, because no chokepoint owns it.
 *
 * The quality gate now scans `worker/deno/setup` for both binaries, so a new
 * setup module cannot reintroduce the bypass.
 *
 * ```mermaid
 * flowchart LR
 *     S["setup/* modules"] --> R["createSetupRunCommand"]
 *     R -->|"gh …"| G["spawnGh<br/>(allowlist + redaction + journal)"]
 *     R -->|"git …"| T["runGitCommand<br/>(timeout + journal)"]
 *     R -->|"other"| D["Deno.Command"]
 * ```
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { spawnGh } from "../lib/gh_spawn.ts";
import { runGitCommand } from "../lib/git_timeout.ts";

/** Outcome of one setup subprocess — the shape every setup caller expects. */
export interface SetupCommandOutput {
  /** True only when the process ran and exited zero. */
  success: boolean;
  /** Trimmed stdout. */
  stdout: string;
  /** Trimmed stderr, or the failure reason when no process ran. */
  stderr: string;
}

/** The injectable runner setup modules accept in their options. */
export type SetupRunCommand = (cmd: string[]) => Promise<SetupCommandOutput>;

/** Expand a leading `~` to $HOME so a child reads the right config dir. */
export function expandHome(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return path.replace(/^~/, Deno.env.get("HOME") ?? "~");
}

/**
 * Run one setup command, routing each guarded binary to its chokepoint.
 *
 * Never throws on a non-zero exit — the outcome is reported in
 * {@link SetupCommandOutput.success}, which is what the setup callers branch
 * on. An empty command vector is a programming fault and throws loudly rather
 * than being reported as a failed process.
 *
 * @param cmd - Full command vector, binary first.
 * @param ghConfigDir - `GH_CONFIG_DIR` for the child, from `.config.json`.
 * @returns The process outcome, stdout and stderr trimmed.
 */
export async function runSetupCommand(
  cmd: string[],
  ghConfigDir?: string,
): Promise<SetupCommandOutput> {
  const binary = cmd[0];
  if (binary === undefined) {
    throw new Error("runSetupCommand: empty command vector");
  }
  const args = cmd.slice(1);
  const dir = expandHome(ghConfigDir);
  const env = dir ? { GH_CONFIG_DIR: dir } : undefined;

  if (binary === "gh") {
    const result = await spawnGh(args, env ? { env } : {});
    return {
      success: result.success,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  }

  if (binary === "git") {
    const result = await runGitCommand(args, env ? { env } : {});
    if (!result.ok) {
      return { success: false, stdout: "", stderr: result.error.message };
    }
    return {
      success: result.value.code === 0,
      stdout: result.value.stdout.trim(),
      stderr: result.value.stderr.trim(),
    };
  }

  const output = await new Deno.Command(binary, {
    args,
    stdout: "piped",
    stderr: "piped",
    ...(env ? { env } : {}),
  }).output();
  const decoder = new TextDecoder();
  return {
    success: output.success,
    stdout: decoder.decode(output.stdout).trim(),
    stderr: decoder.decode(output.stderr).trim(),
  };
}

/**
 * Build the default runner for a setup module.
 *
 * @param ghConfigDir - `GH_CONFIG_DIR` for every child this runner spawns.
 * @returns A runner that routes `gh` and `git` through their chokepoints.
 */
export function createSetupRunCommand(ghConfigDir?: string): SetupRunCommand {
  return (cmd: string[]) => runSetupCommand(cmd, ghConfigDir);
}
