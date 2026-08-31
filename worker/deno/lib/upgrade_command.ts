/**
 * The name of the command that moves a host onto the latest release
 * (Issues #690, #691, part of #674).
 *
 * One constant, imported by everything that names the upgrade: the launch-time
 * new-release notice (Issue #690) tells the operator what to run, and the
 * command itself (Issue #691) registers under the same name. Two hard-coded
 * strings would be free to drift, and a notice naming a command that does not
 * exist is worse than no notice at all.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

/** The Deno command name — `deno run … mod.ts upgrade`. */
export const UPGRADE_COMMAND_NAME = "upgrade";

/** How an operator invokes it: the launcher they already run. */
export const UPGRADE_INVOCATION = `./run.sh ${UPGRADE_COMMAND_NAME}`;
