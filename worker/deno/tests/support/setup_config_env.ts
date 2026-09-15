/**
 * The config-file environment a `setup.sh` child must be handed (Issue #2144).
 *
 * `setup.sh` accepts two spellings of the same setting: `CONFIG_FILE` is
 * canonical and `CONFIG_PATH` is the launcher's older alias. Its
 * `resolve_config_file` guard refuses the pair when both are set and name
 * different files, because setup would then read one file while the launcher
 * staged the other.
 *
 * `Deno.Command`'s `env` MERGES into the parent environment unless `clearEnv`
 * is set, so a suite that states only `CONFIG_FILE` inherits whatever
 * `CONFIG_PATH` the host exports — and a worker host exports
 * `~/.vibe-coder/run-config/.config.json`. The guard then fires, correctly, and
 * the case fails for a reason it never stated.
 *
 * Stating the whole pair makes the child's configuration a fact about the test
 * rather than about the host: the alias names the same temporary file as the
 * canonical spelling, so the guard sees a consistent pair whatever is ambient.
 * No `Deno.env.set` — that is process-wide and parallel-unsafe.
 *
 * Australian English throughout (behaviour, colour, organisation).
 */

/**
 * Both spellings of the config file, pinned to `configFile`.
 *
 * Spread into a `Deno.Command` `env` map alongside the rest of the child's
 * environment.
 */
export function setupConfigEnv(
  configFile: string,
): { CONFIG_FILE: string; CONFIG_PATH: string } {
  return { CONFIG_FILE: configFile, CONFIG_PATH: configFile };
}
