/**
 * The work directory a command operates on (Issue #966).
 *
 * Several housekeeping commands resolve the same three candidates in the
 * same order — `--work-dir`, `config.workDir`, then the `WORK_DIR` the run
 * driver exports — and refuse to run when none of them names a directory.
 * That last candidate used to be read as `Deno.env.get("WORK_DIR")` inside
 * each command, which made "no work directory" untestable without deleting
 * the variable from the process: a mutation that races every other test
 * sharing the process (Issue #880, plan in #944).
 *
 * Here the environment candidate is a plain directory parameter whose
 * default is the environment read, so production behaviour is unchanged and
 * a caller can say "there is no `WORK_DIR`" by passing an empty string.
 * A path is what the value *is*, so it is taken as a path rather than as an
 * environment lookup — the variable name then disappears from the call site
 * entirely.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.).
 */

/**
 * Resolve the work directory for a command invocation.
 *
 * @param args - Parsed command arguments; `--work-dir` wins when non-empty.
 * @param configWorkDir - `config.workDir` from the loaded configuration.
 * @param envWorkDir - Last-resort candidate, defaulting to the exported
 *   `WORK_DIR`. Pass `""` for "the variable is not set".
 * @returns The resolved directory, or `""` when no candidate named one —
 *   which every caller reports as a refusal rather than guessing a path.
 */
export function resolveCommandWorkDir(
  args: Record<string, unknown>,
  configWorkDir: string | undefined,
  envWorkDir: string | undefined = Deno.env.get("WORK_DIR"),
): string {
  const flag = args["work-dir"];
  if (typeof flag === "string" && flag.length > 0) return flag;
  return configWorkDir || envWorkDir || "";
}
