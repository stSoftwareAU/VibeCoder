/**
 * Environment capabilities a test needs, probed rather than assumed
 * (Issue #891).
 *
 * Two tests failed on **every** branch inside the worker container, so every
 * run's gate reported `deno tests FAILED` for reasons unrelated to the change
 * under test. Both assert behaviour the container cannot exhibit:
 *
 * - one drives the branch taken when a `chmod`-ed-unwritable directory
 *   refuses a write, but the container runs with privileges under which that
 *   directory is still writable, so the branch is never reached;
 * - one asserts `setup.sh` reaches the configuration-writing stage on a
 *   Codex-only host, but the image installs only `claude`, so the
 *   prerequisite probe refuses first.
 *
 * Neither is a defect in the code under test. A gate that fails on the
 * container it happens to run in teaches everyone to ignore it, which costs
 * far more than the two assertions are worth.
 *
 * These probes let such a test **skip explicitly** — `Deno.test({ ignore })`
 * reports "ignored", which is visible in the run output. A silent pass would
 * be worse than the failure: it would claim coverage that did not run.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

/**
 * Whether `chmod` can actually make a directory unwritable here.
 *
 * False under a privileged container user, where mode bits do not restrain
 * the process — the case that broke
 * `service_account_env_test.ts:385`.
 */
export async function canEnforceUnwritableDir(): Promise<boolean> {
  let dir: string | undefined;
  try {
    dir = await Deno.makeTempDir();
    await Deno.chmod(dir, 0o500);
    try {
      await Deno.writeTextFile(`${dir}/probe`, "x");
      // The write succeeded despite mode 0500: the platform is not enforcing
      // it, so a test that depends on refusal cannot run here.
      return false;
    } catch {
      return true;
    }
  } catch {
    // Cannot even set up the probe — treat as unsupported rather than
    // asserting on an environment we failed to characterise.
    return false;
  } finally {
    if (dir !== undefined) {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  }
}
