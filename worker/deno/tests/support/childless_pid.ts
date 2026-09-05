/**
 * A live PID that really is childless (Issue #1055).
 *
 * Two suites drive a production path whose last step is a **real** descendant
 * sweep: `runSignalCleanup` fires a SIGTERM — then a SIGKILL after a bounded
 * wait — at every descendant of the PID it is given. Both handed it
 * `Deno.pid`, on the stated grounds that the test process is childless. Under
 * `deno test --parallel` it is not: every test file runs inside one process,
 * so the test process's descendants are the subprocesses of whichever files
 * happen to be running alongside, and the sweep killed them. That is what
 * turned the callback suites red with `exit 143` on hooks that had done
 * nothing wrong.
 *
 * PR #1159 fixed the first of the two, in `run_housekeeping_command_test.ts`.
 * This helper is that fix, shared, because `run_entrypoint_test.ts` drives
 * the whole worker and reaches the same sweep through `runWorker`.
 *
 * A `sleep` of our own restores the property the tests were written to rely
 * on: it is alive, it has no descendants of its own, and terminate-descendants
 * is the genuine no-op the assertions assume. It is spawned in this process's
 * own group — never `setsid` — so nothing here can become a group signal.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

/**
 * Seconds the sentinel lives for.
 *
 * Long enough to outlast any sweep a test performs, short enough that an
 * aborted run leaves nothing behind for long.
 */
const SENTINEL_LIFETIME_SECONDS = 30;

/**
 * Run `body` with the PID of a live, childless process of this test's own.
 *
 * The sentinel is always reaped, including when `body` throws, so a failing
 * assertion never leaks a process.
 *
 * @param body - Receives the sentinel's PID.
 */
export async function withChildlessPid(
  body: (pid: number) => Promise<void>,
): Promise<void> {
  const sentinel = new Deno.Command("sleep", {
    args: [String(SENTINEL_LIFETIME_SECONDS)],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
  try {
    await body(sentinel.pid);
  } finally {
    await reap(sentinel);
  }
}

/**
 * SIGKILL a spawned process and wait for it, tolerating one already gone.
 *
 * `Deno.errors.NotFound` — it exited before the kill — is the only failure
 * that means "nothing to do"; anything else is a fault worth seeing rather
 * than a silent leak.
 *
 * @param child - The process to terminate and reap.
 */
export async function reap(child: Deno.ChildProcess): Promise<void> {
  try {
    child.kill("SIGKILL");
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await child.status;
}
