/**
 * Kill a spawned test process together with everything it started
 * (Issue #399).
 *
 * `Deno.ChildProcess.kill()` signals the root only. A supervisor under test —
 * `loop.sh` — has already forked a background control-plane probe and a
 * `run.sh` of its own by the time a test is finished with it, and those
 * survive the root's death: the kernel re-parents them to PID 1, where they
 * sit looping on `sleep 120` for ever. Around twenty such orphans had
 * accumulated on one fleet host, the oldest over two days old.
 *
 * The root is stopped first so it cannot fork a replacement while its current
 * descendants are being collected, then the tree is terminated bottom-up
 * (SIGTERM, escalating to SIGKILL), then the root itself.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { terminateDescendants } from "../../lib/pid_guard.ts";

/** Seconds a descendant gets to honour SIGTERM before SIGKILL. */
const DESCENDANT_GRACE_SECONDS = 2;

/**
 * Kill `child` and every process it started, and drain its pipes.
 *
 * Best-effort and never throws — a test's cleanup path must not mask the
 * assertion failure that sent it there.
 *
 * @param child - The spawned process to terminate, with its descendants
 */
export async function killProcessTree(child: Deno.ChildProcess): Promise<void> {
  // Freeze the root so it cannot fork a fresh descendant behind our back.
  try {
    child.kill("SIGSTOP");
  } catch { /* already dead */ }

  try {
    await terminateDescendants(child.pid, DESCENDANT_GRACE_SECONDS);
  } catch { /* best-effort */ }

  try {
    child.kill("SIGKILL");
  } catch { /* already dead */ }
  try {
    await child.status;
  } catch { /* already reaped */ }

  // Drain the pipes so the test runner does not leak file descriptors.
  try {
    await child.stdout.cancel();
  } catch { /* already closed */ }
  try {
    await child.stderr.cancel();
  } catch { /* already closed */ }
}
