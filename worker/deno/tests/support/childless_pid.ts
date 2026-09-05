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
 * A childless process of our own restores the property the tests were written
 * to rely on: it is alive, it has no descendants of its own, and
 * terminate-descendants is the genuine no-op the assertions assume. It is
 * spawned in this process's own group — never `setsid` — so nothing here can
 * become a group signal.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

/**
 * Why the sentinel is `cat` on a pipe nobody writes to, and not `sleep N`.
 *
 * It used to be `sleep 30`, on the reasoning that thirty seconds outlasts any
 * sweep a test performs. That is a wall-clock budget, and a wall-clock budget
 * is a different test on a busy host: under two concurrent unit suites the
 * body outlived the sentinel, the process the case was written around exited
 * on its own, and the reap then found it already gone — `run_entrypoint_test`
 * red on a change that had nothing to do with it.
 *
 * `cat` reading a pipe this process holds open has no lifetime to outlast: it
 * lives exactly until {@link reap} kills it, however long the body takes.
 * It is childless, and it is spawned in this process's own group — never
 * `setsid` — so nothing here can become a group signal.
 */
const SENTINEL_COMMAND = "cat";

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
  const sentinel = new Deno.Command(SENTINEL_COMMAND, {
    stdin: "piped",
    stdout: "null",
    stderr: "null",
  }).spawn();
  try {
    await body(sentinel.pid);
  } finally {
    // Close the pipe first, so `cat` sees EOF and leaves of its own accord on
    // the ordinary path; the kill below covers every other one.
    await sentinel.stdin.close().catch(() => {});
    await reap(sentinel);
  }
}

/**
 * SIGKILL a spawned process and wait for it, tolerating one already gone.
 *
 * Two failures mean "nothing to do": `Deno.errors.NotFound`, and the
 * `TypeError` the runtime raises for a child it has already reaped — which is
 * what a sentinel that exited on its own produces, and what the `NotFound`
 * arm alone did not cover. Anything else is a fault worth seeing rather than
 * a silent leak.
 *
 * @param child - The process to terminate and reap.
 */
export async function reap(child: Deno.ChildProcess): Promise<void> {
  try {
    child.kill("SIGKILL");
  } catch (error) {
    if (!isAlreadyGone(error)) throw error;
  }
  await child.status;
}

/** Whether `error` says the child was already gone when the kill was sent. */
function isAlreadyGone(error: unknown): boolean {
  if (error instanceof Deno.errors.NotFound) return true;
  return error instanceof TypeError &&
    error.message.includes("already terminated");
}
