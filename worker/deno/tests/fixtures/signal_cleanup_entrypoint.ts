/**
 * Test fixture for the signal-cleanup integration test (Issue #3502).
 *
 * Emulates the worker entrypoint: it writes its own PID file, spawns a
 * long-lived child process (a descendant that must be terminated on cleanup),
 * installs the Deno SIGINT/SIGTERM cleanup handlers via
 * {@link installCleanupHandlers}, signals readiness, and then blocks until a
 * signal arrives. On SIGINT/SIGTERM the handler terminates the child and
 * removes the PID file before exiting.
 *
 * Invoked as:
 *   deno run --allow-all signal_cleanup_entrypoint.ts <pidFile> <childPidFile> <readyFile>
 *
 * Australian English spelling throughout (behaviour, organisation, authorised).
 */

import { installCleanupHandlers } from "../../lib/run_housekeeping.ts";

const [pidFile, childPidFile, readyFile] = Deno.args;

if (!pidFile || !childPidFile || !readyFile) {
  console.error("usage: entrypoint <pidFile> <childPidFile> <readyFile>");
  Deno.exit(2);
}

// Claim the PID file, exactly as run_core.sh does with the worker PID.
await Deno.writeTextFile(pidFile, `${Deno.pid}\n`);

// Spawn a long-lived descendant that must be terminated on cleanup.
const child = new Deno.Command("sleep", { args: ["300"] }).spawn();
await Deno.writeTextFile(childPidFile, `${child.pid}\n`);

// Install the Deno-native cleanup handlers (replaces the bash cleanup_on_exit
// trap): on SIGINT/SIGTERM terminate our descendants and remove the PID file.
installCleanupHandlers({ selfPid: Deno.pid, pidFile, maxWaitSeconds: 3 });

// Signal readiness only after everything is wired.
await Deno.writeTextFile(readyFile, "ready");

// Block forever — the signal handler is the only exit path.
await new Promise(() => {});
