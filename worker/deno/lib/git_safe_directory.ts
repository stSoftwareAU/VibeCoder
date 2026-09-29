/**
 * `safe.directory` self-repair for clones git refuses as dubious ownership
 * (Issue #2825).
 *
 * The container entrypoint stages `safe.directory = *` into the global config
 * because the work volume can be owned by a different uid from the worker.
 * When that line goes missing, every git call against the clone is refused —
 * and `git config` refuses quietly: `--get-all` exits 1 as though the key were
 * absent and `--add` says only "not in a git directory". Setup then died in
 * the first minute of every cycle. Restoring the staged line lets the call
 * that tripped over it retry; a line already present means the repair cannot
 * help, so the caller's failure stays the loud one.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** Repairs this process will attempt, bounded like the Issue #564 auth one. */
export const MAX_SAFE_DIRECTORY_REPAIRS = 3;

let safeDirectoryRepairs = 0;

/** Reset the repair budget. Tests only. */
export function resetSafeDirectoryRepairs(): void {
  safeDirectoryRepairs = 0;
}

/** True when a finished git call was refused for dubious ownership. */
export function isDubiousOwnershipFailure(
  result: { code: number; stderr: string },
): boolean {
  return result.code !== 0 &&
    result.stderr.toLowerCase().includes("detected dubious ownership");
}

async function gitConfig(
  args: string[],
  env: Record<string, string> | undefined,
): Promise<{ code: number; stdout: string }> {
  const out = await new Deno.Command("git", {
    args: ["config", ...args],
    env,
    stdout: "piped",
    stderr: "null",
  }).output();
  return { code: out.code, stdout: new TextDecoder().decode(out.stdout) };
}

/**
 * Restore `safe.directory = *` in the global config git is reading.
 *
 * Runs with the failed call's `env`, so it writes wherever that call's
 * `GIT_CONFIG_GLOBAL` points.
 *
 * @returns True when the line was written and a retry is worth making.
 */
export async function repairSafeDirectory(
  env?: Record<string, string>,
): Promise<boolean> {
  if (safeDirectoryRepairs >= MAX_SAFE_DIRECTORY_REPAIRS) return false;
  safeDirectoryRepairs++;
  try {
    const existing = await gitConfig(
      ["--global", "--get-all", "safe.directory"],
      env,
    );
    // Already present: another line would change nothing, only duplicate.
    if (existing.stdout.split("\n").some((line) => line.trim() === "*")) {
      return false;
    }
    const added = await gitConfig(
      ["--global", "--add", "safe.directory", "*"],
      env,
    );
    if (added.code !== 0) return false;
  } catch {
    // Best-effort: the caller's own dubious-ownership failure stays loud.
    return false;
  }
  console.error(
    "[SECURITY] git refused a clone as dubious ownership — restored the " +
      "staged safe.directory line (Issue #2825)",
  );
  return true;
}
